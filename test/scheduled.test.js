// 用一个打桩的全局 fetch 端到端地跑 scheduled handler。请求确实经过 aws4fetch 真实
// 签名；但没有任何东西离开本进程，也不涉及任何真实的 AWS 凭据或端点。
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
 * 打桩 `globalThis.fetch`，记录每一次 Lightsail 操作和 webhook POST。
 * `state` 可以传数组，每次 GetInstanceState 调用消费一项，用来模拟状态在两次调用之间
 * 发生变化的实例。
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
      // 形状照着真实的 SigV4 拒绝响应来，它会回显 credential scope。
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
        // 乱序、稀疏，并且其中一个数据点完全没有 `sum` 字段 —— 这三件事 API 一件都
        // 不保证。
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

/** 在一个固定时刻运行 handler，并等待所有交给 waitUntil 的任务完成。 */
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

  // 小驼峰字段名、按天的 period，以及 Unix 秒级时间戳。
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
  // 入 500 + 出 400 = 900 GB，超过 800 GB 的阈值；但单看任何一个方向都没超。
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

  // 连续两次触发，用量仍然超额，但绝不能发出停机。
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
 * 在 AWS 打桩之外再包一层，把 webhook 的 POST —— 唯一一个用裸 URL 而不是已签名
 * Request 发出的 fetch —— 转交给 `onWebhook` 处理。
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

  // 一个接受连接却从不回应的 webhook 会把整次调用挂住；而错误路径是 await 完告警才
  // rethrow 的，于是一个坏掉的端点就变成了一个坏掉的看门狗。
  assert.ok(signal instanceof AbortSignal, "the webhook POST must carry an abort signal");
  assert.equal(signal.aborted, false, "and it must still be live at send time");
});

test("a webhook that times out does not mask a successful stop", async () => {
  const mock = stubAws({ networkIn: 900 * GB });
  interceptWebhook(() => {
    // 端点没了动静之后，AbortSignal.timeout 抛出的正是这个。
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
  // 新的计费月：月初至今归零，而实例还停在上个月那次停机的状态里。
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
  // 窗口取的是新月份，而不是那个用量导致停机的月份。
  assert.equal(mock.calls[0].body.startTime, Date.parse("2026-09-01T00:00:00Z") / 1000);
});

test("the restart is retried on every later run, not just at the rollover", async () => {
  // 这条替换掉的那个缺陷：旧的按日期测试里，只要 1 号那天每一次触发都失败，实例就会
  // 一直停一个月，而测试照样是绿的。这里的触发条件是用量数字，它会一直成立到启动成功
  // 为止。
  for (const at of ["2026-09-01T00:10:00Z", "2026-09-02T13:20:00Z", "2026-09-27T08:00:00Z"]) {
    const mock = stubAws({ state: "stopped" });
    await run(at, baseEnv, mock);
    assert.ok(opsOf(mock.calls).includes("StartInstance"), `expected a start at ${at}`);
  }
});

test("a stopped instance is not started while the month's usage is still spent", async () => {
  // 与停机同一个月：额度没有重置，实例也就不该重启。正是这一点让用量触发等价于旧的
  // 「1 号」触发，而不是变成一个反复重启的死循环。
  const mock = stubAws({ state: "stopped", networkIn: 900 * GB });
  await run("2026-08-02T00:00:00Z", baseEnv, mock);

  assert.ok(!opsOf(mock.calls).includes("StartInstance"));
});

test("a stopped instance with traffic on the meter is left alone", async () => {
  // 低于阈值但不为零 —— 是操作者自己在月中把它停掉的。这里没有任何迹象表明额度重置了。
  const mock = stubAws({ state: "stopped", networkIn: 120 * GB, networkOut: 80 * GB });
  await run("2026-08-20T09:00:00Z", baseEnv, mock);

  assert.deepEqual(opsOf(mock.calls), ["GetInstanceMetricData", "GetInstanceMetricData"]);
});

test("zero usage on a running instance costs one state check and nothing else", async () => {
  // 新月份的头几分钟，还没有任何数据点落库。
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

  // 额度已重置、实例处于停机：正常情况下应该启动。加了 hold 之后，它连状态都不去问。
  const start = stubAws({ state: "stopped" });
  await run("2026-09-01T00:00:00Z", held, start);
  assert.deepEqual(opsOf(start.calls), ["GetInstanceMetricData", "GetInstanceMetricData"]);

  // 账单护栏照常生效 —— hold 的含义是「不要把我拉起来」，不是「允许我超额跑着」。
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
  // 最难缠的情形：INSTANCE_NAME 填错了，或者某个绑定压根没配，于是 readConfig 在
  // 还没有 Config 可供读取 webhook 地址之前就抛了异常。
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
