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

test("on the 1st a stopped instance is started and usage is not queried", async () => {
  const mock = stubAws({ state: "stopped", networkIn: 900 * GB });
  const env = { ...baseEnv, ALERT_WEBHOOK: "https://example.com/hooks/lightsail" };
  await run("2026-09-01T00:00:00Z", env, mock);

  assert.deepEqual(opsOf(mock.calls), ["GetInstanceState", "StartInstance", "webhook"]);
  assert.deepEqual(mock.calls[1].body, { instanceName: "my-blog" });
  assert.equal(mock.calls[2].body.event, "started");
});

test("on the 1st a running instance falls through to the usage check", async () => {
  const mock = stubAws({ state: "running", networkIn: 1 * GB });
  await run("2026-09-01T06:00:00Z", baseEnv, mock);

  assert.deepEqual(opsOf(mock.calls), [
    "GetInstanceState",
    "GetInstanceMetricData",
    "GetInstanceMetricData",
  ]);
  // Fresh month: the window starts at the new month, not the old one.
  assert.equal(mock.calls[1].body.startTime, Date.parse("2026-09-01T00:00:00Z") / 1000);
});

test("the instance is never started outside the 1st", async () => {
  const mock = stubAws({ state: "stopped", networkIn: 900 * GB });
  await run("2026-08-02T00:00:00Z", baseEnv, mock);

  assert.ok(!opsOf(mock.calls).includes("StartInstance"));
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
