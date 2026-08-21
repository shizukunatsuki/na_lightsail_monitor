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
  INSTANCE_NAME: "example-instance",
  QUOTA_GIB: "1024",
  THRESHOLD: "0.8",
};

const GIB = 1024 ** 3;

/** 默认配置下的停机线：1024 GiB × 0.8。 */
const STOP_LINE_GIB = 819.2;

/** 用来在停机线两侧各取一点的偏移量，1 MiB —— 远大于浮点误差，也远小于任何真实用量。 */
const MIB = 1024 ** 2;

/** 与 src/index.js 里的常量对应：月度查询按天，突发窗口按 5 分钟。 */
const MONTH_PERIOD = 86400;
const BURST_PERIOD = 300;

/**
 * 打桩 `globalThis.fetch`，记录每一次 Lightsail 操作。
 *
 * 指标查询按 `period` 分流：86400 是「月初至今」，300 是突发闸门那一小时的窗口。两者
 * 必须能分别给量，否则「本月用了 800 GiB」会被当成「最近一小时烧了 800 GiB」，突发闸门
 * 在每个测试里都会误触发。
 *
 * `state` 可以传数组，每次 GetInstanceState 调用消费一项，用来模拟状态在两次调用之间
 * 发生变化的实例。
 */
function stubAws({
  state = "running",
  networkIn = 0,
  networkOut = 0,
  recentIn = 0,
  recentOut = 0,
  recentPoints = 6,
  recentInPoints,
  recentOutPoints,
  recentLagSeconds = 300,
  malformedMetrics = false,
  unreadableState = false,
  fail,
} = {}) {
  const calls = [];
  const states = Array.isArray(state) ? [...state] : null;
  const original = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const target = req.headers.get("X-Amz-Target");
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
        if (unreadableState) return Response.json({ state: {} });
        const name = states ? (states.shift() ?? "running") : state;
        return Response.json({ state: { code: name === "running" ? 16 : 80, name } });
      }
      case "GetInstanceMetricData": {
        // 200 但读不懂：`metricData` 整个字段缺席。
        if (malformedMetrics) return Response.json({ metricName: body.metricName });

        if (body.period === BURST_PERIOD) {
          const isIn = body.metricName === "NetworkIn";
          const total = isIn ? recentIn : recentOut;
          // 两个方向的落库进度可以不同 —— 真实 API 不保证它们同步。
          const n = (isIn ? recentInPoints : recentOutPoints) ?? recentPoints;
          // 时间戳锚定到请求的 endTime：最新那个桶覆盖 [newest, newest + 300)，而它比
          // 「此刻」早了 recentLagSeconds —— 这就是被模拟的落库延迟。
          const newest = body.endTime - recentLagSeconds - BURST_PERIOD;
          return Response.json({
            metricName: body.metricName,
            metricData: Array.from({ length: n }, (_, i) => ({
              sum: n ? total / n : 0,
              timestamp: newest - (n - 1 - i) * BURST_PERIOD,
              unit: "Bytes",
            })),
          });
        }

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

/** 在一个固定时刻运行 handler。 */
async function run(iso, env, mock) {
  const controller = { scheduledTime: Date.parse(iso), cron: "*/2 * * * *", noRetry() {} };
  try {
    await worker.scheduled(controller, env);
  } finally {
    if (mock) mock.restore();
  }
}

const opsOf = (calls) => calls.map((c) => c.operation);

/** 只保留指标查询里属于突发窗口的那些。 */
const burstCalls = (calls) =>
  calls.filter((c) => c.operation === "GetInstanceMetricData" && c.body.period === BURST_PERIOD);

/** 收集一次运行里写出的所有日志行（log 与 error 合并），用来断言单位与数值。 */
async function capturingLogs(fn) {
  const lines = [];
  const { log, error } = console;
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines;
}

test("every log line is prefixed with the instance identity, including the region", async () => {
  // 这个仓库是公开的，谁复制过去都会得到一份自我说明的日志。实例名只在单个区域内唯一，
  // 所以光有名字不够 —— 前缀必须能独立回答「这行是哪个部署写的」。
  const mock = stubAws({ networkIn: 900 * GIB, recentIn: GIB });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, /^example-instance@ap-northeast-1: /);

  // 换个区域就是另一个标识，即便实例重名。
  const other = stubAws({ networkIn: 10 * GIB, recentIn: GIB });
  const otherLines = await capturingLogs(() =>
    run("2026-08-15T12:00:00Z", { ...baseEnv, AWS_REGION: "us-east-1" }, other),
  );
  assert.match(otherLines.at(-1), /^example-instance@us-east-1: /);
});

test("bytes are converted on a 2^30 basis", async () => {
  // 恰好 1 GiB 的字节数必须读作 1.000 GiB，而不是 1.074 —— 这是整套单位体系的锚点。
  // 同一行里也确认停机线是 1024 × 0.8 = 819.2 GiB。
  const mock = stubAws({ networkIn: GIB, networkOut: 0 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.deepEqual(lines, [
    "example-instance@ap-northeast-1: 1.000 GiB used month-to-date, under the 819.200 GiB stop threshold, meter 5.0 min behind",
  ]);
});

test("just under the 819.2 GiB stop line the instance is left running", async () => {
  const mock = stubAws({ networkIn: STOP_LINE_GIB * GIB - MIB, networkOut: 0 });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  // 两次月度查询 + 两次突发窗口查询，没有任何状态查询或动作。
  assert.deepEqual(opsOf(mock.calls), new Array(4).fill("GetInstanceMetricData"));
});

test("just over the 819.2 GiB stop line the instance is stopped", async () => {
  const mock = stubAws({ networkIn: STOP_LINE_GIB * GIB + MIB, networkOut: 0 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("StopInstance"));
  assert.match(lines.at(-1), /STOPPED at 819\.201 GiB month-to-date, over the 819\.200 GiB stop threshold \(1024 GiB quota x 0\.8\)/);
});

test("crossing the static line short-circuits the burst check", async () => {
  // 已经确认要停，就没必要再花两次调用去问速率。
  const mock = stubAws({ networkIn: 900 * GIB });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  assert.deepEqual(burstCalls(mock.calls), []);
});

test("under the threshold it checks usage and the recent rate, and nothing else", async () => {
  const mock = stubAws({ networkIn: 100 * GIB, networkOut: 200 * GIB, recentIn: GIB });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  assert.deepEqual(opsOf(mock.calls), new Array(4).fill("GetInstanceMetricData"));
  assert.deepEqual(
    mock.calls.map((c) => c.body.metricName).sort(),
    ["NetworkIn", "NetworkIn", "NetworkOut", "NetworkOut"],
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
  assert.equal(metric.body.instanceName, "example-instance");
  assert.equal(metric.body.period, MONTH_PERIOD);
  assert.equal(metric.body.unit, "Bytes");
  assert.deepEqual(metric.body.statistics, ["Sum"]);
  assert.equal(metric.body.startTime, Date.parse("2026-08-01T00:00:00Z") / 1000);
  assert.equal(metric.body.endTime, Date.parse("2026-08-15T12:00:00Z") / 1000);
});

test("the burst window is the trailing half hour at 300-second granularity", async () => {
  const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  const now = Date.parse("2026-08-15T12:00:00Z") / 1000;
  for (const call of burstCalls(mock.calls)) {
    assert.equal(call.body.period, BURST_PERIOD);
    assert.equal(call.body.endTime, now);
    // 半小时而不是一小时：一小时的平均会把刚开始的突发稀释掉，闸门要等耗尽进度走完
    // 63% 才跳；半小时是 40%。见 src/index.js 里 BURST_WINDOW_SECONDS 的说明。
    assert.equal(call.body.startTime, now - 1800);
  }
  assert.deepEqual(burstCalls(mock.calls).map((c) => c.body.metricName).sort(), ["NetworkIn", "NetworkOut"]);
});

test("both directions count toward the allowance", async () => {
  // 入 500 + 出 400 = 900 GiB，超过 819.2 GiB 的阈值；但单看任何一个方向都没超。
  const mock = stubAws({ networkIn: 500 * GIB, networkOut: 400 * GIB });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  assert.ok(opsOf(mock.calls).includes("StopInstance"));
});

test("over the threshold it stops a running instance exactly once", async () => {
  const mock = stubAws({ networkIn: 400 * GIB, networkOut: 450 * GIB });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  assert.deepEqual(opsOf(mock.calls), [
    "GetInstanceMetricData",
    "GetInstanceMetricData",
    "GetInstanceState",
    "StopInstance",
  ]);
  const stop = mock.calls.at(-1);
  assert.deepEqual(stop.body, { instanceName: "example-instance" });
});

test("the stop path is idempotent when the instance is already stopped", async () => {
  const mock = stubAws({ state: "stopped", networkIn: 900 * GIB, networkOut: 0 });

  // 连续两次触发，用量仍然超额，但绝不能发出停机。
  await run("2026-08-15T12:00:00Z", baseEnv);
  await run("2026-08-15T12:10:00Z", baseEnv, mock);

  assert.ok(!opsOf(mock.calls).includes("StopInstance"));
  assert.equal(opsOf(mock.calls).filter((op) => op === "GetInstanceState").length, 2);
});

test("a stop is not repeated while the instance is still stopping", async () => {
  const mock = stubAws({ state: ["running", "stopping"], networkIn: 900 * GIB });

  await run("2026-08-15T12:00:00Z", baseEnv);
  await run("2026-08-15T12:10:00Z", baseEnv, mock);

  assert.equal(opsOf(mock.calls).filter((op) => op === "StopInstance").length, 1);
});

// --- 突发闸门 -----------------------------------------------------------------

test("a burst that would blow the quota before the next reaction stops the instance", async () => {
  // 月度 700 GiB 远在 819.2 的静态线之下，但最近半小时烧掉了 340 GiB —— 按这个速率，
  // 剩下的 324 GiB 撑不到半小时。静态线在这里毫无用处，因为它要等总量先越线。
  const mock = stubAws({ networkIn: 700 * GIB, recentIn: 340 * GIB });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.deepEqual(opsOf(mock.calls), [
    "GetInstanceMetricData",
    "GetInstanceMetricData",
    "GetInstanceMetricData",
    "GetInstanceMetricData",
    "GetInstanceState",
    "StopInstance",
  ]);
  assert.match(lines.at(-1), /STOPPED at 700\.000 GiB month-to-date, burning 1622\.5 Mbps/);
  assert.match(lines.at(-1), /324\.000 GiB of quota left = 29 min to overage, inside the 30 min reaction horizon/);
});

test("ordinary traffic at the same month-to-date total does not trip the gate", async () => {
  // 同样是 700 GiB 月度用量，但最近半小时只有 5 GiB：按这个速率还能跑一天多。
  const mock = stubAws({ networkIn: 700 * GIB, recentIn: 5 * GIB });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(!opsOf(mock.calls).includes("StopInstance"));
  assert.deepEqual(lines, [
    "example-instance@ap-northeast-1: 700.000 GiB used month-to-date, under the 819.200 GiB stop threshold, meter 5.0 min behind",
  ]);
});

test("the burst rate divides by the data that landed, not by the window length", async () => {
  // 指标有几分钟落库延迟，半小时的窗口里常常只有一部分数据点。150 GiB 落在 3 个点
  // （15 分钟）里，真实速率是拿 900 秒去除；用整个 1800 秒窗口去除会把它算成一半，
  // 于是这次突发就被放过了 —— 而算低速率正是不安全的那个方向。
  const mock = stubAws({ networkIn: 800 * GIB, recentIn: 150 * GIB, recentPoints: 3 });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  assert.ok(opsOf(mock.calls).includes("StopInstance"), "half-covered window must still be read at full rate");
});

test("the metric lag is measured from the newest bucket and reported every run", async () => {
  // AWS 不公开落库延迟，而整套余量标定都建立在它之上 —— 所以只能自己量，并且让它每次
  // 都出现在正常那一行里，而不是留作一个假设。
  const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB, recentLagSeconds: 12 * 60 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.at(-1), /meter 12\.0 min behind$/);
});

test("a lag that leaves under two usable buckets is called out loudly", async () => {
  // 延迟吃掉窗口后，速率估计失去意义，此刻真正在守账单的只剩静态线。这件事必须说出来。
  const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB, recentLagSeconds: 22 * 60, recentPoints: 1 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(
    lines.join("\n"),
    /newest metric bucket is 22\.0 min old, under two usable buckets in the 30 min burst window; the burst gate is blind this run/,
  );
  // 措辞只陈述观察到的事实：光看指标分不出「指标侧延迟」和「实例没在跑」。
  assert.match(lines.join("\n"), /meter lagging, or the instance is not running/);
  assert.ok(!opsOf(mock.calls).includes("StopInstance"), "报警归报警，不能因此停机");
});

test("a still-open newest bucket reads as zero lag rather than a negative one", async () => {
  const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB, recentLagSeconds: -120 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.at(-1), /meter 0\.0 min behind$/);
});

test("each direction's rate is divided by its own coverage, not a shared denominator", async () => {
  // 两个指标的落库进度不保证同步。这里 NetworkIn 落了 6 个桶（1800 秒）而 NetworkOut
  // 只落了 2 个（600 秒），出向那 150 GiB 其实是 2147 Mbps —— 剩余 224 GiB 撑 15 分钟。
  // 把两个方向的字节合起来除以「较长的那个」覆盖时长，会把它报成 716 Mbps 从而放行；
  // 除以「较短的那个」又会在某个方向零数据点时让分母归零、闸门整个失效。各算各的。
  const mock = stubAws({
    networkIn: 800 * GIB,
    recentIn: 0,
    recentOut: 150 * GIB,
    recentInPoints: 6,
    recentOutPoints: 2,
  });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("StopInstance"), "2147 Mbps 必须停机");
  assert.match(lines.at(-1), /burning 2147\.5 Mbps/);
});

test("a direction with no landed points contributes zero instead of blinding the gate", async () => {
  // NetworkIn 一个点都没落，NetworkOut 正常。闸门必须照常按出向的速率判断。
  const mock = stubAws({
    networkIn: 800 * GIB,
    recentOut: 150 * GIB,
    recentInPoints: 0,
    recentOutPoints: 2,
  });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  assert.ok(opsOf(mock.calls).includes("StopInstance"));
});

test("an idle instance with no recent data points is not treated as a burst", async () => {
  // 最近一小时一个数据点都没有：速率无从谈起，绝不能因此停机。
  const mock = stubAws({ networkIn: 800 * GIB, recentPoints: 0 });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  assert.ok(!opsOf(mock.calls).includes("StopInstance"));
});

test("zero month-to-date usage skips the burst check entirely", async () => {
  const mock = stubAws({ state: "running", networkIn: 0, networkOut: 0 });
  await run("2026-09-01T12:00:00Z", baseEnv, mock);

  assert.deepEqual(burstCalls(mock.calls), []);
});

// --- 重启 ---------------------------------------------------------------------

test("a reset allowance starts a stopped instance", async () => {
  // 新的计费月：月初至今归零，而实例还停在上个月那次停机的状态里。
  const mock = stubAws({ state: "stopped", networkIn: 0, networkOut: 0 });
  await run("2026-09-01T00:00:00Z", baseEnv, mock);

  assert.deepEqual(opsOf(mock.calls), [
    "GetInstanceMetricData",
    "GetInstanceMetricData",
    "GetInstanceState",
    "StartInstance",
  ]);
  assert.deepEqual(mock.calls[3].body, { instanceName: "example-instance" });
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
  const mock = stubAws({ state: "stopped", networkIn: 900 * GIB });
  await run("2026-08-02T00:00:00Z", baseEnv, mock);

  assert.ok(!opsOf(mock.calls).includes("StartInstance"));
});

test("a stopped instance with traffic on the meter is left alone", async () => {
  // 低于阈值但不为零 —— 是操作者自己在月中把它停掉的。这里没有任何迹象表明额度重置了。
  const mock = stubAws({ state: "stopped", networkIn: 120 * GIB, networkOut: 80 * GIB });
  await run("2026-08-20T09:00:00Z", baseEnv, mock);

  assert.deepEqual(opsOf(mock.calls), new Array(4).fill("GetInstanceMetricData"));
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
  const stop = stubAws({ state: "running", networkIn: 900 * GIB });
  await run("2026-08-15T12:00:00Z", held, stop);
  assert.ok(opsOf(stop.calls).includes("StopInstance"));

  // 突发闸门同样不受 hold 影响。
  const burst = stubAws({ state: "running", networkIn: 700 * GIB, recentIn: 690 * GIB });
  await run("2026-08-15T12:00:00Z", held, burst);
  assert.ok(opsOf(burst.calls).includes("StopInstance"));
});

// --- 失败方向 -----------------------------------------------------------------

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
  const mock = stubAws({ fail: "StopInstance", networkIn: 900 * GIB });

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", baseEnv, mock),
    /StopInstance failed: HTTP 403/,
  );
});

test("an unreadable metric response throws instead of reading as zero traffic", async () => {
  // 200 但没有 metricData。把它折算成 0 字节就等于报告「本月没用流量」——
  // 那是唯一会让看门狗什么都不做的读数，指标侧一次降级就能让它一边报平安一边放任超额。
  const mock = stubAws({ malformedMetrics: true });

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", baseEnv, mock),
    /GetInstanceMetricData returned no metricData array for Network(In|Out)/,
  );
});

test("an empty metricData array is still a legitimate zero", async () => {
  // 跨月之后本来就没有数据点。严格化不能把这条正常路径一起拦掉，否则每月 1 号
  // 那次重启永远发不出去。
  const mock = stubAws({ state: "stopped" });
  mock.calls.length = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.headers.get("X-Amz-Target")?.endsWith("GetInstanceMetricData")) {
      await inner(input.clone?.() ?? input, init); // 仍然记账
      return Response.json({ metricData: [] });
    }
    return inner(input, init);
  };

  await run("2026-09-01T00:00:00Z", baseEnv, mock);
  assert.ok(opsOf(mock.calls).includes("StartInstance"));
});

test("an unreadable instance state still stops an over-limit instance", async () => {
  // 已经确认越线了。此时 GetInstanceState 读不出状态，旧实现会让整轮抛异常结束 ——
  // 一次已经确认的越线就这样漏掉一个 cron 周期。停机路径上的不确定性必须向「停」倾斜。
  const mock = stubAws({ networkIn: 900 * GIB, unreadableState: true });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("StopInstance"));
  assert.match(lines.join("\n"), /instance state unreadable .*GetInstanceState returned no state name.*erring toward the stop/);
});

test("a failing state check still stops an over-limit instance", async () => {
  // 同一件事，但失败发生在 HTTP 层（凭据被轮换、IAM 策略被改）。
  const mock = stubAws({ networkIn: 900 * GIB, fail: "GetInstanceState" });
  await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("StopInstance"));
});

test("an unreadable instance state on the restart path throws rather than starting", async () => {
  // 与停机路径相反：少启动一次只是站点晚几分钟回来，误启动一台操作者刻意停下的实例
  // 则会开始烧流量。所以这个方向上的异常不接管。
  const mock = stubAws({ networkIn: 0, networkOut: 0, unreadableState: true });

  await assert.rejects(
    () => run("2026-09-01T00:00:00Z", baseEnv, mock),
    /GetInstanceState returned no state name/,
  );
  assert.ok(!opsOf(mock.calls).includes("StartInstance"));
});

test("misconfiguration throws before any AWS call is made", async () => {
  const mock = stubAws();

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", { ...baseEnv, THRESHOLD: "80" }, mock),
    /THRESHOLD/,
  );
  assert.deepEqual(mock.calls, []);
});
