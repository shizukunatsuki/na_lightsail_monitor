import { AwsClient } from "aws4fetch";

/** Lightsail JSON-RPC target prefix; operations are `${API_TARGET}.${Operation}`. */
const API_TARGET = "Lightsail_20161128";

/**
 * Seconds per metric datapoint. One day keeps a month-to-date query to ~31
 * datapoints per metric; an hourly period would return ~744 and blow the
 * 10 ms CPU budget on JSON parsing alone.
 */
const METRIC_PERIOD_SECONDS = 86400;

/**
 * @typedef {object} Config
 * @property {string} region
 * @property {string} instanceName
 * @property {number} quotaGb
 * @property {number} threshold
 * @property {string} [alertWebhook]
 * @property {boolean} manualHold
 */

/**
 * Validate configuration up front and fail loud on anything missing or
 * unparseable. Left unchecked, a typo in QUOTA_GB makes every comparison
 * against NaN false, which reads as "over quota" and stops the instance.
 *
 * Only the presence of the two secrets is checked; their values never leave
 * this function.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Config}
 */
export function readConfig(env) {
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "INSTANCE_NAME"]) {
    if (!env[name]) throw new Error(`Missing required binding ${name}`);
  }

  const quotaGb = Number(env.QUOTA_GB);
  if (!Number.isFinite(quotaGb) || quotaGb <= 0) {
    throw new Error(`QUOTA_GB must be a positive number, got ${JSON.stringify(env.QUOTA_GB)}`);
  }

  // Bounded above by 1 so a THRESHOLD written as a percentage ("80") cannot
  // silently turn the watchdog into a no-op.
  const threshold = Number(env.THRESHOLD);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error(`THRESHOLD must be a fraction in (0, 1], got ${JSON.stringify(env.THRESHOLD)}`);
  }

  return {
    region: env.AWS_REGION,
    instanceName: env.INSTANCE_NAME,
    quotaGb,
    threshold,
    alertWebhook: env.ALERT_WEBHOOK,
    // Escape hatch for planned downtime. Compared against the exact string so
    // that a typo ("yes", "1", "True") leaves the restart path enabled rather
    // than silently pinning the instance down for a month.
    manualHold: env.MANUAL_HOLD === "true",
  };
}

/**
 * First instant of the UTC month containing `now`, in milliseconds since epoch.
 *
 * Always UTC: the allowance resets at 00:00 UTC on the 1st, which is a
 * different moment from any local month boundary. Deriving this from
 * `getFullYear`/`getMonth` would query the wrong window for up to a day either
 * side of the rollover, every month.
 *
 * @param {Date} now
 * @returns {number}
 */
export function monthStartMs(now) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/**
 * Month-to-date query window for GetInstanceMetricData, in Unix *seconds*
 * (the Lightsail API takes numbers here, not ISO strings).
 *
 * The end is nudged a minute past the start so the first invocation of a new
 * month still sends a non-empty range; a zero-width range is rejected.
 *
 * @param {Date} now
 * @returns {{ startTime: number, endTime: number }}
 */
export function usageWindow(now) {
  const startTime = Math.floor(monthStartMs(now) / 1000);
  const endTime = Math.max(Math.floor(now.getTime() / 1000), startTime + 60);
  return { startTime, endTime };
}

/**
 * One signed Lightsail JSON-RPC call.
 *
 * Throws on any non-2xx so failures surface in Workers logs — a watchdog that
 * fails quietly is worse than no watchdog. Returns the raw response so callers
 * parse only the bodies they actually need.
 *
 * @param {AwsClient} client
 * @param {Config} config
 * @param {string} operation
 * @param {object} body
 * @returns {Promise<Response>}
 */
async function lightsail(client, config, operation, body) {
  const res = await client.fetch(`https://lightsail.${config.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      // Request members are lowerCamelCase for Lightsail, unlike most AWS JSON
      // APIs. PascalCase yields an unhelpful 400.
      "X-Amz-Target": `${API_TARGET}.${operation}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // SigV4 rejections echo the credential scope, which embeds the access key
    // id, so scrub it before the message reaches the logs.
    const detail = (await res.text()).slice(0, 500).replaceAll(client.accessKeyId, "[redacted]");
    throw new Error(`Lightsail ${operation} failed: HTTP ${res.status} ${detail}`);
  }
  return res;
}

/**
 * Current instance state name, e.g. "running" / "stopped".
 *
 * Throws rather than returning undefined on an unrecognised response: the stop
 * path treats "not running" as nothing-to-do, so a silently absent state would
 * leave the instance running over quota on every subsequent run.
 *
 * @param {AwsClient} client
 * @param {Config} config
 * @returns {Promise<string>}
 */
async function getInstanceState(client, config) {
  const res = await lightsail(client, config, "GetInstanceState", {
    instanceName: config.instanceName,
  });
  const body = await res.json();
  const name = body?.state?.name;
  if (typeof name !== "string") {
    throw new Error(`GetInstanceState returned no state name for ${config.instanceName}`);
  }
  return name;
}

/**
 * Month-to-date total for one metric, in bytes.
 * @param {AwsClient} client
 * @param {Config} config
 * @param {"NetworkIn" | "NetworkOut"} metricName
 * @param {{ startTime: number, endTime: number }} range
 * @returns {Promise<number>}
 */
async function sumMetric(client, config, metricName, range) {
  const res = await lightsail(client, config, "GetInstanceMetricData", {
    instanceName: config.instanceName,
    metricName,
    period: METRIC_PERIOD_SECONDS,
    startTime: range.startTime,
    endTime: range.endTime,
    unit: "Bytes",
    statistics: ["Sum"],
  });

  const { metricData } = await res.json();

  // Datapoints are neither sorted nor dense, so sum them rather than indexing
  // into positions. Order is irrelevant to a total; gaps are just zero traffic.
  let total = 0;
  for (const point of metricData ?? []) total += point.sum ?? 0;
  return total;
}

/**
 * Strip credential values out of a message before it leaves the Worker.
 *
 * `lightsail()` already scrubs the access key id out of AWS error bodies. This
 * is the backstop for every other throw site, because the handler's catch-all
 * forwards arbitrary error text to an off-site webhook.
 *
 * @param {string} text
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function redactSecrets(text, env) {
  let out = text;
  for (const secret of [env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY]) {
    if (secret) out = out.replaceAll(secret, "[redacted]");
  }
  return out;
}

/**
 * Best-effort operator notification.
 *
 * Deliberately does not throw: by the time this runs the instance action has
 * already succeeded, and a webhook outage must not make a successful stop look
 * like a failed run. The error path relies on the same property — a dead
 * webhook must not replace the original exception with its own.
 *
 * @param {{ alertWebhook?: string }} config
 * @param {object} payload
 */
async function notify(config, payload) {
  if (!config.alertWebhook) return;
  try {
    const res = await fetch(config.alertWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error(`ALERT_WEBHOOK returned HTTP ${res.status}`);
  } catch (err) {
    console.error(`ALERT_WEBHOOK POST failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * One watchdog pass: measure first, then stop or start as the numbers dictate.
 *
 * Kept separate from `scheduled` so the handler can wrap the whole thing in one
 * try/catch without indenting the logic behind it.
 *
 * @param {ScheduledController} controller
 * @param {Record<string, string | undefined>} env
 * @param {ExecutionContext} ctx
 */
async function runWatchdog(controller, env, ctx) {
  const config = readConfig(env);

  const client = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    service: "lightsail",
    region: config.region,
    // Two retries past the first attempt (5xx and 429 only) is plenty when
    // the next run is ten minutes out, and surfaces outages promptly.
    retries: 2,
  });

  // The scheduled time, not the wall clock: it lands exactly on the cron slot,
  // so a delayed or retried invocation still evaluates the slot it was fired for.
  const now = new Date(controller.scheduledTime ?? Date.now());

  const range = usageWindow(now);
  const [inBytes, outBytes] = await Promise.all([
    sumMetric(client, config, "NetworkIn", range),
    sumMetric(client, config, "NetworkOut", range),
  ]);

  // Both directions consume the allowance even though only outbound overage
  // is billed. 10^9 rather than 2^30: over-counting stops the instance
  // slightly early, which is the correct direction to be wrong in.
  const usedGb = (inBytes + outBytes) / 1e9;
  const limitGb = config.quotaGb * config.threshold;

  if (usedGb >= limitGb) {
    // Over the line. Check state first so a second run never issues a second
    // stop against an already-stopped instance.
    const state = await getInstanceState(client, config);
    if (state !== "running") {
      console.log(
        `${config.instanceName}: ${usedGb.toFixed(3)} GB used, over threshold but instance is "${state}"; nothing to do`,
      );
      return;
    }

    await lightsail(client, config, "StopInstance", { instanceName: config.instanceName });
    console.error(
      `${config.instanceName}: STOPPED at ${usedGb.toFixed(3)} GB month-to-date, over the ${limitGb.toFixed(3)} GB stop threshold (${config.quotaGb} GB quota x ${config.threshold})`,
    );
    ctx.waitUntil(
      notify(config, {
        event: "stopped",
        instanceName: config.instanceName,
        usedGb: Number(usedGb.toFixed(3)),
        thresholdGb: Number(limitGb.toFixed(3)),
        quotaGb: config.quotaGb,
        timestamp: now.toISOString(),
      }),
    );
    return;
  }

  console.log(
    `${config.instanceName}: ${usedGb.toFixed(3)} GB used month-to-date, under the ${limitGb.toFixed(3)} GB stop threshold`,
  );

  // Restart is driven by usage, not by the calendar. A stop only ever happens
  // at or above the threshold, so month-to-date usage stays above it for the
  // rest of that month: "back under the threshold" is the same event the old
  // 1st-of-month branch was reaching for, minus its single 24-hour window.
  // Every run from the rollover onward is another chance to recover.
  //
  // Exactly zero bytes is the gate on the state lookup. A running instance
  // transfers *something* within minutes — DNS, NTP, background scans — so a
  // month-to-date total of zero means it is not up. Without this gate the
  // handler would have to ask GetInstanceState on every run of every normal
  // day, ~4300 extra calls a month for one restart.
  if (inBytes + outBytes > 0) return;

  if (config.manualHold) {
    console.log(
      `${config.instanceName}: no transfer recorded this month, but MANUAL_HOLD is set; leaving it alone`,
    );
    return;
  }

  const state = await getInstanceState(client, config);
  if (state !== "stopped") {
    // Usually the first minutes of a new month, before any metric datapoint has
    // landed for an instance that never went down.
    console.log(`${config.instanceName}: no transfer recorded this month, instance is "${state}"; nothing to do`);
    return;
  }

  await lightsail(client, config, "StartInstance", { instanceName: config.instanceName });
  console.log(`${config.instanceName}: transfer allowance has reset, instance started`);
  ctx.waitUntil(
    notify(config, {
      event: "started",
      instanceName: config.instanceName,
      reason: "Month-to-date transfer is back under the threshold; the allowance has reset.",
      timestamp: now.toISOString(),
    }),
  );
}

export default {
  /**
   * @param {ScheduledController} controller
   * @param {Record<string, string | undefined>} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(controller, env, ctx) {
    try {
      await runWatchdog(controller, env, ctx);
    } catch (err) {
      // Without this the only trace of a broken watchdog — expired credentials,
      // a mistyped INSTANCE_NAME, an AWS outage — is a failed invocation in a
      // dashboard nobody is watching. Awaited rather than handed to waitUntil
      // so the alert is already on the wire before the throw unwinds.
      await notify(
        { alertWebhook: env.ALERT_WEBHOOK },
        {
          event: "error",
          instanceName: env.INSTANCE_NAME,
          message: redactSecrets(err instanceof Error ? err.message : String(err), env),
          timestamp: new Date(controller.scheduledTime ?? Date.now()).toISOString(),
        },
      );
      // Rethrown so the invocation still counts as a failure in Workers logs.
      // The webhook adds to that signal; it does not replace it.
      throw err;
    }
  },
};
