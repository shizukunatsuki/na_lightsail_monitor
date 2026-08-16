// Exercises the scheduled handler end-to-end against a stubbed global fetch.
// Requests are really signed by aws4fetch; nothing leaves the process and no
// real AWS credentials or endpoints are involved.
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";

const baseEnv = {
  AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  AWS_REGION: "ap-northeast-1",
  INSTANCE_NAME: "my-blog",
  QUOTA_GB: "1000",
  THRESHOLD: "0.8",
};

const GB = 1e9;

/**
 * Stub `globalThis.fetch`, recording every Lightsail operation and webhook POST.
 * `state` may be a list, consumed one entry per GetInstanceState call, to model
 * an instance whose state changes between calls.
 */
function stubAws({ state = "running", networkIn = 0, networkOut = 0, fail } = {}) {
  const calls = [];
  const states = Array.isArray(state) ? [...state] : null;
  const original = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const target = req.headers.get("X-Amz-Target");

    if (!target) {
      calls.push({ operation: "webhook", url: req.url, body: await req.json() });
      return new Response("ok");
    }

    const operation = target.split(".")[1];
    const body = await req.json();
    calls.push({ operation, body, url: req.url, headers: req.headers });

    if (fail === operation) {
      // Shaped like a real SigV4 rejection, which echoes the credential scope.
      return new Response(
        `{"__type":"InvalidSignatureException","message":"Credential should be scoped: ${ACCESS_KEY_ID}/20260815/ap-northeast-1/lightsail/aws4_request"}`,
        { status: 403 },
      );
    }

    switch (operation) {
      case "GetInstanceState": {
        const name = states ? (states.shift() ?? "running") : state;
        return Response.json({ state: { code: name === "running" ? 16 : 80, name } });
      }
      case "GetInstanceMetricData": {
        const total = body.metricName === "NetworkIn" ? networkIn : networkOut;
        // Unsorted, sparse, and with one datapoint missing `sum` entirely —
        // the API guarantees none of those things.
        return Response.json({
          metricName: body.metricName,
          metricData: [
            { sum: total * 0.25, timestamp: 1.7540064e9, unit: "Bytes" },
            { timestamp: 1.7531424e9, unit: "Bytes" },
            { sum: total * 0.75, timestamp: 1.7522784e9, unit: "Bytes" },
          ],
        });
      }
      case "StopInstance":
      case "StartInstance":
        return Response.json({ operations: [{ id: "b1a2", status: "Started" }] });
      default:
        return new Response(`unexpected operation ${operation}`, { status: 400 });
    }
  };

  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Run the handler at a fixed instant, awaiting anything handed to waitUntil. */
async function run(iso, env, mock) {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const controller = { scheduledTime: Date.parse(iso), cron: "*/10 * * * *", noRetry() {} };
  try {
    await worker.scheduled(controller, env, ctx);
    await Promise.all(pending);
  } finally {
    if (mock) mock.restore();
  }
}

const opsOf = (calls) => calls.map((c) => c.operation);

test("under the threshold it checks usage and does nothing else", async () => {
  const mock = stubAws({ networkIn: 100 * GB, networkOut: 200 * GB });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  assert.deepEqual(opsOf(mock.calls), ["GetInstanceMetricData", "GetInstanceMetricData"]);
  assert.deepEqual(
    mock.calls.map((c) => c.body.metricName).sort(),
    ["NetworkIn", "NetworkOut"],
  );
});

test("metric queries use the documented request shape", async () => {
  const mock = stubAws();
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  const [metric] = mock.calls;
  assert.equal(metric.url, "https://lightsail.ap-northeast-1.amazonaws.com/");
  assert.equal(metric.headers.get("Content-Type"), "application/x-amz-json-1.1");
  assert.match(metric.headers.get("X-Amz-Target"), /^Lightsail_20161128\.GetInstanceMetricData$/);

  // lowerCamelCase members, a daily period, and Unix-second timestamps.
  assert.deepEqual(Object.keys(metric.body).sort(), [
    "endTime", "instanceName", "metricName", "period", "startTime", "statistics", "unit",
  ]);
  assert.equal(metric.body.instanceName, "my-blog");
  assert.equal(metric.body.period, 86400);
  assert.equal(metric.body.unit, "Bytes");
  assert.deepEqual(metric.body.statistics, ["Sum"]);
  assert.equal(metric.body.startTime, Date.parse("2026-08-01T00:00:00Z") / 1000);
  assert.equal(metric.body.endTime, Date.parse("2026-08-15T12:00:00Z") / 1000);
});

test("both directions count toward the allowance", async () => {
  // 500 in + 400 out = 900 GB, over the 800 GB threshold; neither alone is.
  const mock = stubAws({ networkIn: 500 * GB, networkOut: 400 * GB });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  assert.ok(opsOf(mock.calls).includes("StopInstance"));
});

test("over the threshold it stops a running instance exactly once", async () => {
  const mock = stubAws({ networkIn: 400 * GB, networkOut: 450 * GB });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  assert.deepEqual(opsOf(mock.calls), [
    "GetInstanceMetricData",
    "GetInstanceMetricData",
    "GetInstanceState",
    "StopInstance",
  ]);
  const stop = mock.calls.at(-1);
  assert.deepEqual(stop.body, { instanceName: "my-blog" });
});

test("the stop path is idempotent when the instance is already stopped", async () => {
  const mock = stubAws({ state: "stopped", networkIn: 900 * GB, networkOut: 0 });

  // Two consecutive runs, still over quota, must never issue a stop.
  await run("2026-08-15T12:00:00Z", baseEnv);
  await run("2026-08-15T12:10:00Z", baseEnv, mock);

  assert.ok(!opsOf(mock.calls).includes("StopInstance"));
  assert.equal(opsOf(mock.calls).filter((op) => op === "GetInstanceState").length, 2);
});

test("a stop is not repeated while the instance is still stopping", async () => {
  const mock = stubAws({ state: ["running", "stopping"], networkIn: 900 * GB });

  await run("2026-08-15T12:00:00Z", baseEnv);
  await run("2026-08-15T12:10:00Z", baseEnv, mock);

  assert.equal(opsOf(mock.calls).filter((op) => op === "StopInstance").length, 1);
});

test("stopping posts an alert when a webhook is configured", async () => {
  const mock = stubAws({ networkIn: 900 * GB });
  const env = { ...baseEnv, ALERT_WEBHOOK: "https://example.com/hooks/lightsail" };
  await run("2026-08-15T12:00:00Z", env, mock);

  const alert = mock.calls.find((c) => c.operation === "webhook");
  assert.ok(alert, "expected a webhook POST");
  assert.equal(alert.url, "https://example.com/hooks/lightsail");
  assert.equal(alert.body.event, "stopped");
  assert.equal(alert.body.instanceName, "my-blog");
  assert.equal(alert.body.usedGb, 900);
  assert.equal(alert.body.thresholdGb, 800);
});

test("a failing webhook does not mask a successful stop", async () => {
  const mock = stubAws({ networkIn: 900 * GB });
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (!req.headers.get("X-Amz-Target")) throw new Error("webhook unreachable");
    return inner(input, init);
  };

  const env = { ...baseEnv, ALERT_WEBHOOK: "https://example.com/hooks/lightsail" };
  await run("2026-08-15T12:00:00Z", env, mock);

  assert.ok(opsOf(mock.calls).includes("StopInstance"));
});

/**
 * Wrap the AWS stub so webhook POSTs — the only fetch made with a bare URL
 * rather than a signed Request — go through `onWebhook` instead.
 */
function interceptWebhook(onWebhook) {
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (input instanceof Request) return inner(input, init);
    return onWebhook(init);
  };
}

test("the alert POST is bounded by a timeout", async () => {
  const mock = stubAws({ networkIn: 900 * GB });
  let signal;
  interceptWebhook((init) => {
    signal = init?.signal;
    return new Response("ok");
  });

  const env = { ...baseEnv, ALERT_WEBHOOK: "https://example.com/hooks/lightsail" };
  await run("2026-08-15T12:00:00Z", env, mock);

  // A webhook that accepts the connection and never answers would otherwise
  // hang the invocation; on the error path, which awaits the alert before
  // rethrowing, that turns a broken endpoint into a broken watchdog.
  assert.ok(signal instanceof AbortSignal, "the webhook POST must carry an abort signal");
  assert.equal(signal.aborted, false, "and it must still be live at send time");
});

test("a webhook that times out does not mask a successful stop", async () => {
  const mock = stubAws({ networkIn: 900 * GB });
  interceptWebhook(() => {
    // What AbortSignal.timeout produces once the endpoint has gone quiet.
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });

  const env = { ...baseEnv, ALERT_WEBHOOK: "https://example.com/hooks/lightsail" };
  await run("2026-08-15T12:00:00Z", env, mock);

  assert.ok(opsOf(mock.calls).includes("StopInstance"), "the stop already succeeded");
});

test("a webhook that times out does not replace the original exception", async () => {
  const mock = stubAws({ fail: "GetInstanceMetricData" });
  interceptWebhook(() => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });

  const env = { ...baseEnv, ALERT_WEBHOOK: "https://example.com/hooks/lightsail" };
  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", env, mock),
    /GetInstanceMetricData failed: HTTP 403/,
  );
});

test("a reset allowance starts a stopped instance", async () => {
  // New billing month: month-to-date is back to zero and the instance is still
  // down from last month's stop.
  const mock = stubAws({ state: "stopped", networkIn: 0, networkOut: 0 });
  const env = { ...baseEnv, ALERT_WEBHOOK: "https://example.com/hooks/lightsail" };
  await run("2026-09-01T00:00:00Z", env, mock);

  assert.deepEqual(opsOf(mock.calls), [
    "GetInstanceMetricData",
    "GetInstanceMetricData",
    "GetInstanceState",
    "StartInstance",
    "webhook",
  ]);
  assert.deepEqual(mock.calls[3].body, { instanceName: "my-blog" });
  assert.equal(mock.calls[4].body.event, "started");
  // The window is the new month, not the one whose usage caused the stop.
  assert.equal(mock.calls[0].body.startTime, Date.parse("2026-09-01T00:00:00Z") / 1000);
});

test("the restart is retried on every later run, not just at the rollover", async () => {
  // The bug this replaces: the old date test would have passed while the
  // instance stayed down for a month if every run on the 1st failed. Here the
  // trigger is the usage figure, which stays true until the start succeeds.
  for (const at of ["2026-09-01T00:10:00Z", "2026-09-02T13:20:00Z", "2026-09-27T08:00:00Z"]) {
    const mock = stubAws({ state: "stopped" });
    await run(at, baseEnv, mock);
    assert.ok(opsOf(mock.calls).includes("StartInstance"), `expected a start at ${at}`);
  }
});

test("a stopped instance is not started while the month's usage is still spent", async () => {
  // Same month as the stop: the allowance has not reset, so neither does the
  // instance. This is what makes the usage trigger equivalent to the old
  // 1st-of-month one rather than a restart loop.
  const mock = stubAws({ state: "stopped", networkIn: 900 * GB });
  await run("2026-08-02T00:00:00Z", baseEnv, mock);

  assert.ok(!opsOf(mock.calls).includes("StartInstance"));
});

test("a stopped instance with traffic on the meter is left alone", async () => {
  // Under the threshold but not at zero — the operator stopped it themselves
  // partway through the month. Nothing here says the allowance reset.
  const mock = stubAws({ state: "stopped", networkIn: 120 * GB, networkOut: 80 * GB });
  await run("2026-08-20T09:00:00Z", baseEnv, mock);

  assert.deepEqual(opsOf(mock.calls), ["GetInstanceMetricData", "GetInstanceMetricData"]);
});

test("zero usage on a running instance costs one state check and nothing else", async () => {
  // The first minutes of a month, before any datapoint has landed.
  const mock = stubAws({ state: "running", networkIn: 0, networkOut: 0 });
  await run("2026-09-01T00:00:00Z", baseEnv, mock);

  assert.deepEqual(opsOf(mock.calls), [
    "GetInstanceMetricData",
    "GetInstanceMetricData",
    "GetInstanceState",
  ]);
});

test("MANUAL_HOLD suppresses the start without suppressing the stop", async () => {
  const held = { ...baseEnv, MANUAL_HOLD: "true" };

  // Allowance reset, instance down: normally a start. Held, it does not even
  // ask for the state.
  const start = stubAws({ state: "stopped" });
  await run("2026-09-01T00:00:00Z", held, start);
  assert.deepEqual(opsOf(start.calls), ["GetInstanceMetricData", "GetInstanceMetricData"]);

  // The bill guard still fires — a hold is about not being restarted, not
  // about being allowed to run over quota.
  const stop = stubAws({ state: "running", networkIn: 900 * GB });
  await run("2026-08-15T12:00:00Z", held, stop);
  assert.ok(opsOf(stop.calls).includes("StopInstance"));
});

test("an AWS failure throws, with the access key id scrubbed", async () => {
  const mock = stubAws({ fail: "GetInstanceMetricData" });

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", baseEnv, mock),
    (err) => {
      assert.match(err.message, /GetInstanceMetricData failed: HTTP 403/);
      assert.match(err.message, /\[redacted\]/);
      assert.ok(!err.message.includes(ACCESS_KEY_ID), "access key id must not reach the logs");
      return true;
    },
  );
});

test("a failure on the stop call itself is not swallowed", async () => {
  const mock = stubAws({ fail: "StopInstance", networkIn: 900 * GB });

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", baseEnv, mock),
    /StopInstance failed: HTTP 403/,
  );
});

test("an unreadable instance state throws rather than skipping the stop", async () => {
  const mock = stubAws({ networkIn: 900 * GB });
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.headers.get("X-Amz-Target")?.endsWith("GetInstanceState")) {
      return Response.json({ state: {} });
    }
    return inner(input, init);
  };

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", baseEnv, mock),
    /GetInstanceState returned no state name/,
  );
});

test("misconfiguration throws before any AWS call is made", async () => {
  const mock = stubAws();

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", { ...baseEnv, THRESHOLD: "80" }, mock),
    /THRESHOLD/,
  );
  assert.deepEqual(mock.calls, []);
});

test("a failing run alerts and still throws", async () => {
  const mock = stubAws({ fail: "GetInstanceMetricData" });
  const env = { ...baseEnv, ALERT_WEBHOOK: "https://example.com/hooks/lightsail" };

  await assert.rejects(() => run("2026-08-15T12:00:00Z", env, mock), /HTTP 403/);

  const alert = mock.calls.find((c) => c.operation === "webhook");
  assert.ok(alert, "a watchdog that breaks silently is the failure mode this guards");
  assert.equal(alert.body.event, "error");
  assert.equal(alert.body.instanceName, "my-blog");
  assert.match(alert.body.message, /GetInstanceMetricData failed: HTTP 403/);
  assert.equal(alert.body.timestamp, "2026-08-15T12:00:00.000Z");
});

test("the error alert carries no credential material", async () => {
  const mock = stubAws({ fail: "GetInstanceMetricData" });
  const env = { ...baseEnv, ALERT_WEBHOOK: "https://example.com/hooks/lightsail" };

  await assert.rejects(() => run("2026-08-15T12:00:00Z", env, mock));

  const alert = mock.calls.find((c) => c.operation === "webhook");
  const serialised = JSON.stringify(alert.body);
  assert.match(serialised, /\[redacted\]/);
  assert.ok(!serialised.includes(ACCESS_KEY_ID), "access key id must not reach the webhook");
  assert.ok(!serialised.includes(baseEnv.AWS_SECRET_ACCESS_KEY), "secret key must not reach the webhook");
});

test("a misconfigured watchdog alerts even though no config was parsed", async () => {
  // The nastiest case: INSTANCE_NAME is wrong or a binding is missing, so
  // readConfig throws before there is a Config to read the webhook out of.
  const mock = stubAws();
  const env = {
    ...baseEnv,
    INSTANCE_NAME: undefined,
    ALERT_WEBHOOK: "https://example.com/hooks/lightsail",
  };

  await assert.rejects(() => run("2026-08-15T12:00:00Z", env, mock), /INSTANCE_NAME/);

  const alert = mock.calls.find((c) => c.operation === "webhook");
  assert.ok(alert, "expected an error alert");
  assert.equal(alert.body.event, "error");
  assert.match(alert.body.message, /Missing required binding INSTANCE_NAME/);
});

test("an unreachable webhook does not replace the original exception", async () => {
  const mock = stubAws({ fail: "GetInstanceMetricData" });
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (!req.headers.get("X-Amz-Target")) throw new Error("webhook unreachable");
    return inner(input, init);
  };

  const env = { ...baseEnv, ALERT_WEBHOOK: "https://example.com/hooks/lightsail" };
  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", env, mock),
    /GetInstanceMetricData failed: HTTP 403/,
  );
});
