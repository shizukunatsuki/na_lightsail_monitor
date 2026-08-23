// 用一个打桩的全局 fetch 端到端地跑 scheduled handler。请求确实经过 aws4fetch 真实
// 签名；但没有任何东西离开本进程，也不涉及任何真实的 AWS 凭据或端点。
import { test } from "node:test";
import assert from "node:assert/strict";

import { AwsClient } from "aws4fetch";

import worker, { sumMetric } from "../src/index.js";

const ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const baseEnv = {
  AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: SECRET,
  AWS_REGION: "ap-northeast-1",
  INSTANCE_NAME: "example-instance",
  QUOTA_GIB: "1024",
  THRESHOLD: "0.8",
};

const GIB = 1024 ** 3;

/**
 * 按真实 API 的行为铺突发窗口里的桶。
 *
 * 实测（2026-08-22，ap-northeast-1）：桶的相位是 `floor(startTime / 60) * 60`，之后按
 * period 步进 —— startTime 对 300 取余 47 / 123 / 250 时，返回的桶起点取余分别是
 * 0 / 120 / 240。而 300 秒桶「在关闭那一刻就已经是终值」，所以落库延迟按「还没完整落库
 * 的桶根本不出现」建模：返回的每个桶都是完整的，延迟表现为**尾部的桶还没出现**。
 *
 * 于是可观测的延迟是被量化到 300 秒一档的（0、300、600 …），而且总是**不小于**真实延迟：
 * 真实延迟 720 秒时，最新一个完整的桶结束在 900 秒之前，日志里读到的就是 900 秒。
 * 这个方向是保守的 —— 告警只会更早，不会更晚。
 * **不要改成「桶已经出现、但内容还不完整」那种建模。** 那会造出两种真实 API 绝不会返回
 * 的东西：起点落在 startTime 之前的桶；以及「6 个点 + 5 分钟延迟」这种组合 —— 30 分钟的
 * 窗口里有 5 分钟延迟时，物理上最多只能有 5 个桶。一个不可能的夹具会让一大批断言在描述
 * 一件根本不会发生的事。
 *
 * 要的点数超过物理上能有的数量时直接抛错，不静默截断：一个悄悄给少了的夹具，会让断言
 * 看起来在描述一件根本没发生的事。
 */
function burstBuckets({ startTime, endTime }, lagSeconds, want) {
  const grid = Math.floor(startTime / 60) * 60;
  const visible = [];
  for (let k = 0; ; k++) {
    const start = grid + k * BURST_PERIOD;
    if (start >= endTime) break;
    if (start + BURST_PERIOD > endTime - lagSeconds) break;
    visible.push(start);
  }
  if (want !== undefined && want > visible.length) {
    throw new Error(
      `夹具要 ${want} 个数据点，但延迟 ${lagSeconds} 秒时窗口里最多只有 ${visible.length} 个`,
    );
  }
  return want === undefined ? visible : visible.slice(visible.length - want);
}

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
  recentPoints,
  recentInPoints,
  recentOutPoints,
  recentLagSeconds = 0,
  recentInLagSeconds,
  recentOutLagSeconds,
  metricShape,
  monthNewestDaysAgo = 0,
  monthOutNewestDaysAgo,
  monthInPoints,
  monthOutPoints,
  monthOutStartsDaysLate = 0,
  monthTimestampsUnusable = false,
  badPoints,
  rawMetricBody,
  emptyBurstWindow = false,
  serviceErrors = 0,
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
      // 状态码用 400：Lightsail 把 AccessDenied / Unauthenticated / NotFound /
      // InvalidInput / OperationFailure 全部归为 HTTP 400，只有 ServiceException 是 500。
      // 这个区分很要紧 —— 签名客户端只对 5xx 和 429 重试，所以 400 是一次性的终局失败。
      // 两个凭据各回显**两次**，这是刻意的。只出现一次的话 `replaceAll` 和 `replace` 行为
      // 完全一样，「必须替换全部出现」这条性质就没有任何测试能区分 —— 把 replaceAll 改成
      // replace 时整个套件会全绿，而一个凭据的第二次出现照样进了日志。
      return new Response(
        `{"__type":"InvalidSignatureException","message":"Credential ${ACCESS_KEY_ID} should be scoped: ` +
          `${ACCESS_KEY_ID}/20260815/ap-northeast-1/lightsail/aws4_request; secret ${SECRET} was echoed twice: ${SECRET}"}`,
        { status: 400 },
      );
    }

    // ServiceException（500）会被重试；前 serviceErrors 次调用返回 500。
    if (serviceErrors > 0) {
      serviceErrors -= 1;
      return new Response('{"__type":"ServiceException","message":"internal"}', { status: 500 });
    }

    switch (operation) {
      case "GetInstanceState": {
        if (unreadableState) return Response.json({ state: {} });
        const name = states ? (states.shift() ?? "running") : state;
        return Response.json({ state: { code: name === "running" ? 16 : 80, name } });
      }
      case "GetInstanceMetricData": {
        // 请求的单位不对时，AWS 不报错 —— 实测（2026-08-22，ap-northeast-1）它回
        // HTTP 200、metricName 正确回显、metricData 空数组，Bits / Count / Percent /
        // Seconds / Megabytes 五种都是这个结果。打桩必须照这个来，否则「把请求单位改错」
        // 这个缺陷在测试里根本不可见。
        if (body.unit !== "Bytes") {
          return Response.json({ metricName: body.metricName, metricData: [] });
        }
        // 指标响应的几种形状。`omitted` 是**合法**的：AWS 允许在没有数据时省掉空集合。
        if (metricShape === "omitted") return Response.json({ metricName: body.metricName });
        if (metricShape === "notArray") return Response.json({ metricName: body.metricName, metricData: "oops" });
        if (metricShape === "unrelated") return Response.json({ ok: true });
        if (metricShape === "wrongMetric") return Response.json({ metricName: "CPUUtilization", metricData: [] });
        if (badPoints) return Response.json({ metricName: body.metricName, metricData: badPoints });
        // 直接发 JSON 文本。Response.json 内部走 JSON.stringify，会把 Infinity 变成 null,
        // 于是根本测不到「非有限的 sum」这条路径 —— 这正是 JSON.stringify(Infinity) 的坑
        // 在夹具这一侧的同一次显形。
        if (rawMetricBody) {
          return new Response(rawMetricBody.replace("METRIC", body.metricName), {
            headers: { "Content-Type": "application/x-amz-json-1.1" },
          });
        }
        // 窗口里一个数据点都没有：落库延迟超过「窗口 − 粒度」之后真实 API 就是这样。
        if (emptyBurstWindow && body.period === BURST_PERIOD) {
          return Response.json({ metricName: body.metricName, metricData: [] });
        }

        if (body.period === BURST_PERIOD) {
          const isIn = body.metricName === "NetworkIn";
          const total = isIn ? recentIn : recentOut;
          // 两个方向的落库进度可以不同 —— 真实 API 不保证它们同步。
          const n = (isIn ? recentInPoints : recentOutPoints) ?? recentPoints;
          const lagFor = (isIn ? recentInLagSeconds : recentOutLagSeconds) ?? recentLagSeconds;
          const stamps = burstBuckets(body, lagFor, n);
          return Response.json({
            metricName: body.metricName,
            metricData: stamps.map((timestamp) => ({
              sum: stamps.length ? total / stamps.length : 0,
              timestamp,
              unit: "Bytes",
            })),
          });
        }

        const total = body.metricName === "NetworkIn" ? networkIn : networkOut;
        // 时间戳按天对齐、最新的一个是**今天**的桶。写死成三个固定的历史时间戳等于对这一维完全没有建模 ——
        // 月度查询的覆盖范围决定了静态线看到的是不是一份过期用量：
        // period 86400 的桶是一整天，如果 API 只返回已关闭的天桶，月度读数就对今天全盲。
        const today = Math.floor(body.endTime / 86400) * 86400;
        // 最新那个天桶落在哪一天。默认是今天（解释 A：API 为未完成的当天返回部分聚合，
        // 2026-08-23 再次实测确认）。
        //
        // **但「今天的桶一定在」不是普遍真理，它只在实例今天跑过的前提下成立。**
        // 实测（2026-08-23，ap-northeast-1）：实例存在之后的全部 300 秒数据，两个方向各
        // 4739 个桶，`sum: 0` 一个都没有（最小 744 字节）；唯一一处缺口两个方向同时消失。
        // 这个管道用**缺席**表达「什么都没有」，不用零值桶。于是一台停着的实例，最新的
        // 天桶会停在它最后跑过的那一天——**这一步是推断**（不能为了验证去停生产实例），
        // 依据和它的界限都记在 README 的「指标历史从实例创建那一刻开始」一节。
        //
        // **写 `state: "stopped"` 的用例时记得一起调这个参数。** 实例停着而月度读数照样
        // 覆盖到今天，是一份物理上不可能的响应 —— 用它做出来的断言什么也没有验证。
        // 两个方向的覆盖**终点**也可以不同：一侧的月度管道落后几天，另一侧照常。
        const daysAgo =
          body.metricName === "NetworkOut" ? (monthOutNewestDaysAgo ?? monthNewestDaysAgo) : monthNewestDaysAgo;
        const newestDay = today - daysAgo * 86400;
        // 一个方向的月度读数整个没有数据点。真实 API 里这是「那个方向的管道停摆」的样子
        // —— 空数组，HTTP 仍然是 200，metricName 照常回显。
        const wantPoints = (body.metricName === "NetworkIn" ? monthInPoints : monthOutPoints) ?? 3;
        if (wantPoints === 0) return Response.json({ metricName: body.metricName, metricData: [] });

        // 两个方向的覆盖**起点**可以不同：一侧的月度管道缺了月初那几天，另一侧完整。
        // 真实 API 里这就是「那几天那个方向没有数据」的样子——那几天根本不返回桶。
        if (monthOutStartsDaysLate > 0) {
          const monthStart = Date.UTC(2026, 7, 1) / 1000;
          const todayBucket = Math.floor(body.endTime / 86400) * 86400;
          const from =
            body.metricName === "NetworkIn" ? monthStart : monthStart + monthOutStartsDaysLate * 86400;
          const pts = [];
          for (let t = from; t <= todayBucket; t += 86400) {
            pts.push({ sum: (total * 86400) / (todayBucket - from + 86400), timestamp: t, unit: "Bytes" });
          }
          return Response.json({ metricName: body.metricName, metricData: pts });
        }

        const stamp = (t) => (monthTimestampsUnusable ? new Date(t * 1000).toISOString() : t);
        // 乱序、稀疏，并且其中一个数据点完全没有 `sum` 字段 —— 这三件事 API 一件都
        // 不保证。
        return Response.json({
          metricName: body.metricName,
          metricData: [
            { sum: total * 0.25, timestamp: stamp(newestDay), unit: "Bytes" },
            { timestamp: stamp(newestDay - 86400), unit: "Bytes" },
            { sum: total * 0.75, timestamp: stamp(newestDay - 2 * 86400), unit: "Bytes" },
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
  const controller = { scheduledTime: Date.parse(iso), cron: "*/10 * * * *", noRetry() {} };
  try {
    await worker.scheduled(controller, env);
  } finally {
    if (mock) mock.restore();
  }
}

const opsOf = (calls) => calls.map((c) => c.operation);

/**
 * 只保留指标查询。三次查询并发发出，落进 calls 的顺序不定，所以任何针对查询窗口的断言
 * 都必须按操作名挑，不能按下标取。
 */
const metricCalls = (calls) => calls.filter((c) => c.operation === "GetInstanceMetricData");

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
  for (const line of lines) assert.match(line, /^example-instance@ap-northeast-1 [A-Z]+ \| /);

  // 换个区域就是另一个标识，即便实例重名。
  const other = stubAws({ networkIn: 10 * GIB, recentIn: GIB });
  const otherLines = await capturingLogs(() =>
    run("2026-08-15T12:00:00Z", { ...baseEnv, AWS_REGION: "us-east-1" }, other),
  );
  assert.match(otherLines.at(-1), /^example-instance@us-east-1 OK \| /);
});

test("bytes are converted on a 2^30 basis", async () => {
  // 恰好 1 GiB 的字节数必须读作 1.000 GiB，而不是 1.074 —— 这是整套单位体系的锚点。
  // 同一行里也确认停机线是 1024 × 0.8 = 819.2 GiB。
  const mock = stubAws({ networkIn: GIB, networkOut: 0 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  // 一次触发只写一行，行首是可 grep 的状态标记，字段全部是这一轮已经算出来的东西。
  assert.deepEqual(lines, [
    "example-instance@ap-northeast-1 OK | used 1.000 GiB (0.1% of 1024) | stop at 819.200 GiB" +
      " | now 0 kbps, never to quota | month 47% elapsed, projected 2 GiB | win 6,6/6 | days 3,3/15 | covers from 2026-08-13 | meter 0.0 min behind",
  ]);
});

test("just under the 819.2 GiB stop line the instance is left running", async () => {
  const mock = stubAws({ networkIn: STOP_LINE_GIB * GIB - MIB, networkOut: 0 });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  // 两次月度查询 + 一次状态查询（每轮无条件）+ 两次突发窗口查询，没有动作。
  assert.deepEqual(opsOf(mock.calls).sort(), [
    "GetInstanceMetricData", "GetInstanceMetricData", "GetInstanceMetricData", "GetInstanceMetricData",
    "GetInstanceState",
  ]);
});

test("just over the 819.2 GiB stop line the instance is stopped", async () => {
  const mock = stubAws({ networkIn: STOP_LINE_GIB * GIB + MIB, networkOut: 0 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("StopInstance"));
  assert.match(lines.at(-1), /^\S+ STOPPED \| used 819\.201 GiB \(80\.0% of 1024\) \| over the 819\.200 GiB stop threshold \(1024 GiB quota x 0\.8\)$/);
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

  assert.equal(opsOf(mock.calls).filter((o) => o === "GetInstanceMetricData").length, 4);
  assert.equal(opsOf(mock.calls).filter((o) => o === "GetInstanceState").length, 1);
  assert.deepEqual(
    mock.calls.filter((c) => c.operation === "GetInstanceMetricData").map((c) => c.body.metricName).sort(),
    ["NetworkIn", "NetworkIn", "NetworkOut", "NetworkOut"],
  );
});

test("metric queries use the documented request shape", async () => {
  const mock = stubAws();
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  // 同样按操作名挑：三次查询并发发出，calls[0] 可能是那次状态查询。
  const [metric] = metricCalls(mock.calls);
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

  assert.deepEqual(opsOf(mock.calls).sort(), [
    "GetInstanceMetricData", "GetInstanceMetricData", "GetInstanceState", "StopInstance",
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

  assert.deepEqual(opsOf(mock.calls).sort(), [
    "GetInstanceMetricData", "GetInstanceMetricData", "GetInstanceMetricData", "GetInstanceMetricData",
    "GetInstanceState", "StopInstance",
  ]);
  assert.match(lines.at(-1), /STOPPED \| used 700\.000 GiB \(68\.4% of 1024\) \| burning 1622\.5 Mbps/);
  assert.match(lines.at(-1), /324\.000 GiB of quota left = 29 min to overage, inside the 60 min reaction horizon/);
});

test("ordinary traffic at the same month-to-date total does not trip the gate", async () => {
  // 同样是 700 GiB 月度用量，但最近半小时只有 5 GiB：按这个速率还能跑一天多。
  const mock = stubAws({ networkIn: 700 * GIB, recentIn: 5 * GIB });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(!opsOf(mock.calls).includes("StopInstance"));
  assert.equal(lines.length, 1, "一次触发只写一行");
  // 速率照常露出来，闸门在正常运行里也是可见的；而 projected 1497 GiB 已经越过 1024 的
  // 额度——这正是这个字段存在的意义：静态线还没碰到，但趋势已经写在脸上了。
  assert.match(
    lines[0],
    /^\S+ OK \| used 700\.000 GiB \(68\.4% of 1024\) \| stop at 819\.200 GiB \| now 23\.9 Mbps, 32\.4 h to quota \| month 47% elapsed, projected 1497 GiB \| win 6,6\/6 \| days 3,3\/15 \| covers from 2026-08-13 \| meter 0\.0 min behind$/,
  );
});

test("the burst rate divides by the data that landed, not by the window length", async () => {
  // 指标有几分钟落库延迟，半小时的窗口里常常只有一部分数据点。80 GiB 落在 3 个点
  // （15 分钟）里 = 763.5 Mbps，剩余 224 GiB 撑 42 分钟，落在 60 分钟视野之内；用整个
  // 1800 秒窗口去除会把它算成 381.8 Mbps、84 分钟，于是这次突发就被放过了 —— 而算低
  // 速率正是不安全的那个方向。（视野从 30 改成 60 分钟时这组数必须重算：原来的 150 GiB
  // 在两种分母下都会跳闸，那条测试会变成一条看着绿、其实什么都没证明的测试。）
  const mock = stubAws({ networkIn: 800 * GIB, recentIn: 80 * GIB, recentPoints: 3 });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  assert.ok(opsOf(mock.calls).includes("StopInstance"), "half-covered window must still be read at full rate");
});

test("the metric lag is measured from the newest bucket and reported every run", async () => {
  // AWS 不公开落库延迟，而整套余量标定都建立在它之上 —— 所以只能自己量，并且让它每次
  // 都出现在正常那一行里，而不是留作一个假设。
  //
  // 读数被量化到一整个桶：桶要完整落库才会出现，所以真实延迟 12 分钟时，最新一个可见的
  // 桶结束在 15 分钟之前，日志读到的就是 15.0 分钟。方向是保守的（读数 >= 真实延迟），
  // 告警只会更早不会更晚。窗口里的桶数同步掉到 3/6 —— 那才是分辨率真正的指示器。
  const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB, recentLagSeconds: 12 * 60 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.at(-1), /win 3,3\/6 \| days \d+,\d+\/\d+ \| covers from [\d-]+ \| meter 15\.0 min behind$/);
});

test("one metric's pipeline stalling is not masked by the other", async () => {
  // 速率刻意按每个指标各算各的，理由是「两个指标的落库进度并不保证同步」。那么新鲜度
  // 也必须按同一个前提判断：取两者中**更旧**的那一个。
  //
  // 取更新鲜的那一个会让「NetworkOut 管道变慢、NetworkIn 照常」报告成一切新鲜 —— 不响
  // BLIND、不标 (stale)、meter 报 0，而速率里有一半是二十多分钟前的数据。半瞎的计量表
  // 被读作全新鲜，方向是漏停。
  //
  // 「自我评价随延迟单调不减」那条不变量**看不见**这个缺陷，因为它的打桩把两个指标的
  // 延迟一起推移。两个方向不同步这一维只有这条用例在守。
  const mock = stubAws({
    networkIn: 300 * GIB,
    recentIn: 5 * GIB,
    recentOut: 5 * GIB,
    recentInLagSeconds: 60,        // 新鲜
    recentOutLagSeconds: 25 * 60,  // 停摆，远超 12 分钟容忍上限
  });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| newest metric bucket is 25\.0 min old/);
  assert.match(lines.at(-1), /\(stale\)/);
  assert.match(lines.at(-1), /meter 25\.0 min behind/);
});

test("a lag past the tolerance is called out loudly", async () => {
  // 延迟超过容忍上限后，突发闸门已经追不上一场满速突发，此刻真正在守账单的只剩静态线。
  const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB, recentLagSeconds: 25 * 60 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(
    lines.join("\n"),
    /^\S+ BLIND \| newest metric bucket is 25\.0 min old, past the 12 min tolerance \|/m,
  );
  // 措辞跟着这一轮**实际查到的**状态走。实例确认在跑时，「实例没在跑」这个解释已经被
  // 排除掉了，就不该再摆出来让人多查一遍。
  assert.match(lines.join("\n"), /the instance is running, so the meter itself is behind/);
  assert.ok(
    !lines.join("\n").includes("or an instance that is not running"),
    "实例确认在跑时不该再提这个已被排除的解释",
  );
  // 而且刚被宣布不可信的那个速率，在 OK 行里必须带 (stale) 标记，不能装成正常读数。
  assert.match(lines.at(-1), /^\S+ OK \|.*\| now \S+ \S+ \(stale\), /);
  assert.ok(!opsOf(mock.calls).includes("StopInstance"), "报警归报警，不能因此停机");
});

test("a lag past the tolerance with an unreadable state is still called out", async () => {
  // 判据必须走 `meterShouldSeeTraffic`，不要就地写 `instanceState === "running"`：那样
  // 状态读不出来时这条告警会被整个吞掉。这一档的既定规则是「宁可多喊一声」，五个调用点
  // 和 README 的表格都是这么定的 —— 状态读不出来而数据还很旧，恰恰是最需要说话的时候。
  //
  // 这一轮还会另写一行 DEGRADED，但那说的是「状态读不出来」，不是「速率不可信」——
  // 两件事，不能互相顶替。
  const mock = stubAws({
    networkIn: 10 * GIB,
    recentIn: GIB,
    recentLagSeconds: 25 * 60,
    unreadableState: true,
  });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(
    lines.join("\n"),
    /^\S+ BLIND \| newest metric bucket is 25\.0 min old, past the 12 min tolerance \|/m,
  );
  // 状态读不出来时两种解释都还活着，措辞必须把两种都摆出来。
  assert.match(lines.join("\n"), /either a lagging meter or an instance that is not running/);
  assert.match(lines.at(-1), /^\S+ OK \|.*\| now \S+ \S+ \(stale\), /);
});

test("a still-open newest bucket reads as zero lag rather than a negative one", async () => {
  const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB, recentLagSeconds: -120 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.at(-1), /meter 0\.0 min behind$/);
});

test("each direction's rate is divided by its own coverage, not a shared denominator", async () => {
  // 两个指标的落库进度不保证同步。这里 NetworkIn 落了 6 个桶（1800 秒）而 NetworkOut
  // 只落了 2 个（600 秒），出向那 75 GiB 其实是 1073.7 Mbps —— 剩余 224 GiB 撑 30 分钟，
  // 落在 60 分钟视野之内。把两个方向的字节合起来除以「较长的那个」覆盖时长，会把它报成
  // 357.9 Mbps、90 分钟从而放行；除以「较短的那个」又会在某个方向零数据点时让分母归零、
  // 闸门整个失效。各算各的。
  const mock = stubAws({
    networkIn: 800 * GIB,
    recentIn: 0,
    recentOut: 75 * GIB,
    recentInPoints: 6,
    recentOutPoints: 2,
  });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("StopInstance"), "1073.7 Mbps 必须停机");
  assert.match(lines.at(-1), /burning 1073\.7 Mbps/);
});

test("a direction with no landed points contributes zero instead of blinding the gate", async () => {
  // NetworkIn 一个点都没落，NetworkOut 正常。闸门必须照常按出向的速率判断。
  const mock = stubAws({
    networkIn: 800 * GIB,
    recentOut: 75 * GIB,
    recentInPoints: 0,
    recentOutPoints: 2,
  });
  await run("2026-08-15T12:00:00Z", baseEnv, mock);

  assert.ok(opsOf(mock.calls).includes("StopInstance"));
});

test("a direction going dark is called out, not silently averaged into the rate", async () => {
  // 「缺一个方向不该让闸门失效」（上面那条用例）和「这件事必须说出来」（这条）是两个
  // 独立的要求，都要满足。闸门此刻只看得见一半的流量，少报的方向正是漏停。
  //
  // 沉默的代价：`win` 字段如果取两个方向的**较大值**，NetworkOut 整个管道停摆时日志会
  // 写成 `win 6/6 | meter 0.0 min behind` —— 与一切正常那一行完全同形。两个方向都零点会
  // 响 BLIND，一个方向零点却一声不吭，没有道理。
  //
  // 实测（2026-08-23，ap-northeast-1）：跑着的实例两个方向的桶数完全同步（6/6 与 6/6，
  // lag 都是 16 秒），所以「一侧 6 个桶、另一侧 0 个」不是正常形态。
  for (const [dark, opts] of [
    ["NetworkOut", { recentInPoints: 6, recentOutPoints: 0, recentIn: GIB }],
    ["NetworkIn", { recentInPoints: 0, recentOutPoints: 6, recentOut: GIB }],
  ]) {
    const mock = stubAws({ networkIn: 5 * GIB, networkOut: 5 * GIB, state: "running", ...opts });
    const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
    const text = lines.join("\n");

    assert.match(text, new RegExp(`BLIND \\| ${dark} has no data points`), `${dark} 停摆必须告警`);
    assert.match(text, /measuring only half the traffic/);
    // 而且那一行不能再把它显示成健康。`win 6,0/6` 一眼看得出是哪一侧没了。
    const expected = dark === "NetworkOut" ? "win 6,0/6" : "win 0,6/6";
    assert.ok(lines.at(-1).includes(expected), `${dark} 停摆时应写 ${expected}，实际 ${lines.at(-1)}`);
  }
});

test("both directions landing normally raises no half-blind alarm", async () => {
  // 对照：正常那一轮一次都不该出现，否则它就是纯噪音。同时钉住正常形态下的字段长相。
  const mock = stubAws({ networkIn: 5 * GIB, networkOut: 5 * GIB, recentIn: GIB, recentOut: GIB });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(!lines.join("\n").includes("has no data points"), "两侧都正常时不该告警");
  assert.ok(lines.at(-1).includes("win 6,6/6"), lines.at(-1));
});

test("a direction going dark with an unreadable state is still called out", async () => {
  // 状态读不出来这一档一律「宁可多喊一声」——「不确定实例在不在跑」不是把话咽回去的
  // 理由，何况这一轮的速率里确实少了一整个方向。判据走 meterShouldSeeTraffic，与另外
  // 四个调用点一致。
  const mock = stubAws({
    networkIn: 5 * GIB,
    networkOut: 5 * GIB,
    unreadableState: true,
    recentInPoints: 6,
    recentOutPoints: 0,
    recentIn: GIB,
  });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| NetworkOut has no data points in the last 30 min/);
  assert.match(lines.at(-1), /win 6,0\/6/);
});

test("a month reading missing one direction with an unreadable state is still called out", async () => {
  // 月度那一侧同理 —— 两个调用点共用同一个判据，两边都要有用例钉住。
  const mock = stubAws({
    networkIn: 400 * GIB,
    networkOut: 400 * GIB,
    monthOutPoints: 0,
    unreadableState: true,
    recentIn: GIB,
  });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| NetworkOut has no data points in the month-to-date reading/);
});

test("a draining window on a stopped instance is not a half-blind alarm", async () => {
  // 实例确认停着时，窗口正在把停机前的桶排空，两个方向先后掉到零是正常的。判据走
  // meterShouldSeeTraffic，与另外三个调用点一致 —— 不为一次合法停机制造噪音。
  const mock = stubAws({
    networkIn: 5 * GIB,
    networkOut: 5 * GIB,
    state: "stopped",
    recentInPoints: 2,
    recentOutPoints: 0,
    recentIn: GIB,
  });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(!lines.join("\n").includes("has no data points"), lines.join("\n"));
  assert.match(lines.at(-1), /^\S+ DOWN \|/);
});

test("just outside the reaction horizon it reports the countdown instead of stopping", async () => {
  // 剩余 324 GiB、速率 620.4 Mbps = 75 分钟到额度。75 > 60，闸门刻意不跳 —— 但那一行
  // 必须把倒计时写出来。这是视野上沿的另一侧：29 分钟会停（见上面那条），75 分钟不停。
  const mock = stubAws({ networkIn: 700 * GIB, recentIn: 130 * GIB });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(!opsOf(mock.calls).includes("StopInstance"), "75 分钟在视野之外，不该停机");
  assert.match(lines.at(-1), /^\S+ OK \|.*\| now 620\.4 Mbps, 1\.2 h to quota \|/);
});

test("a very long runway is capped rather than printed to the day", async () => {
  // 额度每月都会重置，「还能撑 213 天」只是噪音。
  const mock = stubAws({ networkIn: GIB, recentIn: 0.1 * GIB });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.at(-1), /now \d+ kbps, > 90 d to quota/);
});

test("the lag alarm fires before the design stops holding, not after", async () => {
  // 这条守的是一个只在改了 cron 之后才显形的缺陷：门槛挂在**观察窗口**上时
  // （凑不出两个数据点 = 20 分钟）；而真正会断的是**检测回路**：cron 每 2 分钟时闸门在
  // 延迟 25 分钟才守不住，20 分钟的告警是提前的；cron 放宽到 10 分钟后临界点降到 16 分钟，
  // 同一个 20 分钟就变成了迟到四分钟 —— 延迟落在 [16, 20) 分钟时设计已经失效而没有任何
  // 提示。门槛必须挂在回路上，且留出提前量。
  //
  // 边界不是 12 分钟整。延迟只能按**整桶**观测 —— 日志读到的是「最新一个完整的桶结束了
  // 多久」，取值只能落在 0 / 5 / 10 / 15 … 分钟这些档上，而且总是不小于真实延迟。于是
  // 12 分钟的门槛真正的跳变点是「真实延迟超过 10 分钟」（那时读数跳到 15 分钟）。
  // 方向是保守的：告警比设计预算（14 分钟）更早，不会更晚。
  for (const minutes of [11, 12, 14, 16, 19]) {
    const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB, recentLagSeconds: minutes * 60 });
    const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
    assert.match(lines.join("\n"), /BLIND \|/, `延迟 ${minutes} 分钟必须告警`);
  }

  // 容忍上限之内不该有任何噪音。
  for (const minutes of [0, 5, 10]) {
    const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB, recentLagSeconds: minutes * 60 });
    const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
    assert.ok(!lines.join("\n").includes("BLIND"), `延迟 ${minutes} 分钟不该告警`);
    assert.ok(!lines.at(-1).includes("(stale)"), `延迟 ${minutes} 分钟不该标 stale`);
  }
});

test("the daily UTC rollover does not raise a month-staleness alarm", async () => {
  // 判据一度写成「最新的天桶不是今天」。在 00:00 UTC 那一格，今天才过了 0 秒，今天的桶
  // 当然还不存在，最新的必然是昨天 —— 于是每天必定误报一行 error，而它自己算出来的
  // 落后时长恰好是 0.0 小时。噪音与真实故障同形，是最坏的一种。
  //
  // 用真实 API 复现过：连续三天的 00:00 UTC 全部误报。判据必须是「落后多久」。
  for (const at of ["2026-08-22T00:00:00Z", "2026-08-22T00:05:00Z", "2026-09-01T00:00:00Z"]) {
    const mock = stubAws({ networkIn: 100 * GIB, recentIn: GIB, monthNewestDaysAgo: 1 });
    const lines = await capturingLogs(() => run(at, baseEnv, mock));
    assert.ok(
      !lines.join("\n").includes("month-to-date reading only covers"),
      `${at}：跨日那一格不该告警，实际写了 ${lines.find((l) => l.includes("BLIND"))}`,
    );
  }
});

test("a month-to-date reading that does not cover today is reported", async () => {
  // 月度查询用 period: 86400，桶是一整天。如果上游哪天改成
  // 「只返回已完成周期」，月度读数就只覆盖到昨天 —— 今天的流量对静态线完全不可见，
  // 盲区最长 24 小时，比处处精心标定的「10 分钟落库延迟」大两个数量级。这条告警是那种情形唯一的信号。
  //
  // 这个检查在两种语义下都正确：返回当天部分聚合时永不触发；只返回已关闭天桶时必然触发。
  // 也就是说它既是防线，也是那个「一次 API 调用才能分辨」的实验 —— 上线第一天就有结论。
  const mock = stubAws({ networkIn: 100 * GIB, recentIn: GIB, monthNewestDaysAgo: 1 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| month-to-date reading only covers through 2026-08-14/);
  assert.match(lines.join("\n"), /12\.0 h behind/);
  assert.match(lines.join("\n"), /today's traffic is invisible to the static line/);
});

test("a legitimately stopped instance is not accused of a blind month reading", async () => {
  // 实例合法停着（突发闸门停的，或者操作者自己停下来做维护）时，它不再产生天桶，最新
  // 那个就停在它最后跑过的那一天，之后每天多落后 24 小时 —— 实测确认没有流量的日子
  // 根本不返回桶（见 stubAws 里月度分支的注释）。
  //
  // 告警**不问实例状态**的话，从停机次日 00:20 UTC 起每一个 cron 周期都会喊一次，一天
  // 约 142 条，一直喊到实例被拉起来或者跨月。而且那句话本身是错的：停机期间今天的流量
  // 不是「不可见」，是不存在。
  //
  // 这与零读数告警面对的是同一个问题，README 里也写着同一条结论：真正的管道故障会淹没在
  // 这串噪音里。夹具当时让它无法显形 —— `state: "stopped"` 的响应照样覆盖到今天。
  //
  // 用量刻意压在静态线之下：越线会走 675 行那条提前 return，根本到不了这条告警。
  for (const daysAgo of [1, 3, 12]) {
    const mock = stubAws({
      networkIn: 200 * GIB,
      networkOut: 200 * GIB,
      state: "stopped",
      monthNewestDaysAgo: daysAgo,
      emptyBurstWindow: true,
    });
    const lines = await capturingLogs(() => run("2026-08-20T12:00:00Z", baseEnv, mock));
    assert.ok(
      !lines.join("\n").includes("month-to-date reading only covers"),
      `停机 ${daysAgo} 天：不该告警，实际写了 ${lines.find((l) => l.includes("BLIND"))}`,
    );
    // 对照：这一轮**确实**有话要说，只是那句话是 DOWN 而不是 BLIND。断言终态还在，
    // 免得哪天整轮被静音了这条测试还是绿的。
    assert.match(lines.at(-1), /^\S+ DOWN \|/);
  }
});

test("the same stale month reading on a running instance is still reported", async () => {
  // 对照组：带上状态条件之后这一条必须照旧响 —— 否则那个条件就不是「去掉误报」，
  // 而是把整条防线关掉了。实例在跑却读不到今天的桶，才是静态线真的在看一份过期用量。
  const mock = stubAws({ networkIn: 200 * GIB, recentIn: GIB, state: "running", monthNewestDaysAgo: 3 });
  const lines = await capturingLogs(() => run("2026-08-20T12:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| month-to-date reading only covers through 2026-08-17/);
  assert.match(lines.join("\n"), /while the instance is "running"/);
});

test("a stale month reading with an unreadable state is still reported", async () => {
  // 状态读不出来这一档一律「宁可多喊一声」—— 与另外三个调用点、以及 README 的表格一致。
  // 不能因为「不确定它在不在跑」就把话咽回去。
  const mock = stubAws({ networkIn: 200 * GIB, recentIn: GIB, unreadableState: true, monthNewestDaysAgo: 3 });
  const lines = await capturingLogs(() => run("2026-08-20T12:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| month-to-date reading only covers through 2026-08-17/);
  assert.match(lines.join("\n"), /while the instance is of unreadable state/);
});

test("a month reading that covers today raises no alarm", async () => {
  // 对照：正常语义下这条告警一次都不该出现，否则它就是纯噪音。
  for (const at of ["2026-08-15T12:00:00Z", "2026-08-01T00:30:00Z", "2026-08-31T23:50:00Z"]) {
    const mock = stubAws({ networkIn: 100 * GIB, recentIn: GIB });
    const lines = await capturingLogs(() => run(at, baseEnv, mock));
    assert.ok(!lines.join("\n").includes("month-to-date reading only covers"), `${at} 不该告警`);
  }
});

test("a running instance reading exactly zero hours into the month is reported", async () => {
  // 零字节闸门的全部前提是「运行中的实例几分钟内必然产生某些流量」。月份已经走了几小时、
  // 实例还在跑、读数却仍是零 —— 这个前提在此刻不成立，问题一定在量的那一侧。
  //
  // 这也是 unit 传错的唯一可观测形状：实测 AWS 会回 HTTP 200、metricName 正确回显、
  // metricData 空数组，双信号校验完全放行，用量读成干净的 0 字节。
  const mock = stubAws({ state: "running", networkIn: 0, networkOut: 0 });
  const lines = await capturingLogs(() => run("2026-09-01T09:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| 9\.0 h into the month, month-to-date reads exactly zero/);
  assert.match(lines.join("\n"), /while the instance is "running"/);
  assert.match(lines.join("\n"), /the metric pipeline is what is broken/);
});

test("the same zero reading in the first minutes of a month is normal", async () => {
  // 对照：跨月头几分钟读数为零是完全正常的，不该告警。
  const mock = stubAws({ state: "running", networkIn: 0, networkOut: 0 });
  const lines = await capturingLogs(() => run("2026-09-01T00:20:00Z", baseEnv, mock));

  assert.ok(!lines.join("\n").includes("into the month"), "月初头几分钟不该告警");
  assert.match(lines.at(-1), /NOOP \|.*instance is "running"/);
});

test("a stopped instance is reported as DOWN from the very first trigger", async () => {
  // 实例状态每一轮都问 API，所以停机后**第一格 cron** 就知道它停了 —— 不用等数据变旧。
  // 改成「按需查」（正常路径不问，靠「指标里还有没有新数据」推断）的话，指标的落库延迟会让
  // 停机后的头十几分钟日志继续写 OK，而它从来没问过。
  const mock = stubAws({ networkIn: 300 * GIB, recentIn: GIB, state: "stopped" });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("GetInstanceState"), "每一轮都必须实际问一次状态");
  assert.match(lines.at(-1), /^\S+ DOWN \|.*instance is "stopped"$/);
  assert.ok(!opsOf(mock.calls).includes("StartInstance"));
  assert.ok(!opsOf(mock.calls).includes("StopInstance"));
});

test("after the burst gate stops it, the steady state says DOWN, not OK", async () => {
  // 突发闸门可以在用量还没到静态线时就跳闸。停机后用量不再增长，于是此后每一次触发都
  // 满足 used < limit，走的是「正常」那一支 —— 这一支如果无脑写 OK，结果就是**站点已经下线，
  // 而 `grep -v " OK | "` 里什么都没有**。两条停机路径的稳态收敛到同一个可 grep 的词（DOWN）。
  for (const [label, opts] of [
    ["数据变旧", { recentLagSeconds: 25 * 60 }],
    ["数据全没", { emptyBurstWindow: true }],
  ]) {
    const mock = stubAws({ networkIn: 300 * GIB, recentIn: GIB, state: "stopped", ...opts });
    const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
    assert.match(lines.at(-1), /^\S+ DOWN \|/, `${label}：实例已停，稳态必须写 DOWN`);
    assert.match(lines.at(-1), /instance is "stopped"/);
    assert.ok(!lines.at(-1).startsWith("example-instance@ap-northeast-1 OK"), `${label}：不能写 OK`);
  }
});

test("stale data on a running instance is still BLIND, not DOWN", async () => {
  // 对照：实例确实在跑而数据变旧 —— 那才是指标侧的问题，必须是 BLIND。
  const mock = stubAws({ networkIn: 300 * GIB, recentIn: GIB, state: "running", recentLagSeconds: 25 * 60 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
  assert.match(lines.join("\n"), /BLIND \| newest metric bucket is 25\.0 min old/);
  assert.match(lines.at(-1), /^\S+ OK \|/);
});

test("the static-line stop also says DOWN", async () => {
  const mock = stubAws({ networkIn: 900 * GIB, state: "stopped" });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
  assert.match(lines.at(-1), /^\S+ DOWN \|.*over the 819\.200 GiB stop threshold.*instance is "stopped"$/);
});

test("MANUAL_HOLD does not swallow the zero-reading alarm", async () => {
  // HOLD 的定义是「抑制所有 StartInstance」，仅此而已。它在 handler 里必须排在
  // 「月份已过数小时、读数仍恰为零」那条告警**之后**：排在前面会把那条一起吞掉 —— 维护期设了 hold 又忘记撤销，
  // 就同时失去了静默失明的唯一兜底，而 HOLD 那行字面上还在说一切按计划。
  //
  // hold 与实例状态是两件事：hold 只挡启动，它自己并不停机。所以「设了 hold 而实例还在
  // 跑」是常见的维护姿态，也正是这条兜底必须活着的场景。
  const held = stubAws({ state: "running", networkIn: 0, networkOut: 0 });
  const heldLines = await capturingLogs(() =>
    run("2026-09-01T09:00:00Z", { ...baseEnv, MANUAL_HOLD: "true" }, held),
  );
  assert.match(heldLines.join("\n"), /BLIND \| 9\.0 h into the month, month-to-date reads exactly zero/);
  assert.match(heldLines.at(-1), /^\S+ HOLD \|/);
});

test("a legitimately stopped instance reading zero is not alarmed about", async () => {
  // 对照：实例被合法停着（看门狗停的，或操作者自己停的）时，
  // 月度读数当然是零 —— 那正是零字节闸门要的前提，不是故障。判据只看「月份已过几小时」而不看状态的话，
  // 会从当月第 2 小时起每一次触发都报一次 BLIND，一直报到实例被拉起来为止。
  const mock = stubAws({ state: "stopped", networkIn: 0, networkOut: 0 });
  const lines = await capturingLogs(() => run("2026-09-01T09:00:00Z", baseEnv, mock));

  assert.ok(!lines.join("\n").includes("BLIND"), "合法停机的零读数不该告警");
  assert.match(lines.at(-1), /^\S+ STARTED \|/);
});

test("a month reading with no usable timestamp is reported", async () => {
  // 突发路径和月度路径各有一条，两边都要有。少掉任何一条，对应那一侧的覆盖范围检测都会
  // 整段静默，而那一轮看起来完全正常。
  const mock = stubAws({ networkIn: 600 * GIB, recentIn: GIB, monthTimestampsUnusable: true });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| month-to-date has \d+ data points but no usable timestamp/);
  assert.match(lines.join("\n"), /cannot tell whether the reading covers today/);
});

test("an empty burst window on a running instance is reported, never read as zero traffic", async () => {
  // 可观测延迟有天花板：窗口 30 分钟 − 粒度 5 分钟 = 25 分钟。越过它之后窗口里一个点都
  // 落不进来，于是 newest 为 null、延迟算不出来、失明检测跟着失效。
  //
  // 没有专门的一支来接这种情形的话，`rateOf` 返回的 0 会被当成正常读数打进日志 ——
  // 看门狗在没有任何数据的情况下**主动断言实例没有流量**，而 0 正是唯一会让它什么都不做
  // 的读数。症状是延迟 25 分钟时报警并停机、26 分钟时静默放行并写下 `now 0 kbps`。
  const mock = stubAws({ networkIn: 300 * GIB, emptyBurstWindow: true, state: "running" });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| no metric data points in the last 30 min/);
  assert.match(lines.join("\n"), /the meter is blind, not idle/);
  // 绝不能出现「0 kbps」这种在无数据时伪造出来的读数。
  assert.ok(!lines.join("\n").includes("0 kbps"), "无数据时不得打印速率读数");
  assert.match(lines.at(-1), /now unknown \(no data points in window\)/);
  // 按产品决定：报警但不停机 —— 零数据点也可能只是实例没在跑。
  assert.ok(!opsOf(mock.calls).includes("StopInstance"));
});

test("a millisecond timestamp is rejected, not silently trusted as fresh", async () => {
  // 只检查 `typeof === "number"` 是不够的：毫秒时间戳会让 endTime − (newest + 300) 变成
  // 巨大的负数、被 Math.max(0, …) 钳到 0 —— 新鲜度检测整体失效，而日志还宣称
  // 「meter 0.0 min behind」数据很新鲜。
  //
  // 这条用例把两种时间戳摆在同一个场景下对比：真实落库延迟 20 分钟（已越过 12 分钟容忍
  // 线）时，秒时间戳会正常告警，毫秒时间戳则一声不吭。
  const NOW = Date.parse("2026-08-15T12:00:00Z") / 1000;
  const stale = NOW - 20 * 60 - BURST_PERIOD;
  const mock = stubAws({
    networkIn: 10 * GIB,
    badPoints: [{ sum: 0.5 * GIB, timestamp: stale * 1000 }],
  });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| \d+ data points but no usable timestamp/);
  assert.ok(!lines.at(-1).includes("meter 0.0 min behind"), "绝不能在时间戳不可用时宣称数据新鲜");
  assert.ok(!lines.at(-1).includes("meter "), "算不出延迟时不该有 meter 字段");
});

test("data points with no usable timestamp are reported, not silently trusted", async () => {
  // 速率算得出来（它不碰时间戳），但数据有多新无从判断 —— 失明检测就此永久失效。
  // 这是同一条静默路径的另一个入口：Lightsail 哪天把时间戳改成 ISO 字符串就是这个症状。
  const mock = stubAws({
    networkIn: 10 * GIB,
    badPoints: [{ sum: 0.5 * 1024 ** 3, timestamp: "2026-08-15T11:50:00Z" }],
  });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| \d+ data points but no usable timestamp/);
  assert.match(lines.join("\n"), /the staleness check is inoperative/);
  // 速率照常算出来，且不带 meter 字段（因为算不出延迟）。
  assert.match(lines.at(-1), /\| now \S+ \S+, /);
  assert.ok(!lines.at(-1).includes("meter "), "算不出延迟时不该有 meter 字段");
});

test("an empty burst window with an unreadable state still alarms", async () => {
  // 窗口空、而状态又读不出来 —— 分辨不了「指标失明」和「实例没在跑」。这时必须**报警**：
  // 对失明保持沉默的代价（放任一场看不见的突发）远大于多报一次的代价。
  const mock = stubAws({ networkIn: 300 * GIB, emptyBurstWindow: true, fail: "GetInstanceState" });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| no metric data points/);
  assert.match(lines.join("\n"), /instance is of unreadable state/);
  assert.match(lines.at(-1), /now unknown \(no data points in window\)/);
});

test("an empty burst window on a stopped instance is not an alarm", async () => {
  // 「指标失明」和「实例没在跑」在指标上长得一模一样，只能多花一次状态查询分辨。
  // 不分辨的话，操作者月中手动停机后这条告警会每个 cron 周期响一次直到月末。
  for (const state of ["stopped", "stopping"]) {
    const mock = stubAws({ networkIn: 300 * GIB, emptyBurstWindow: true, state });
    const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
    assert.ok(!lines.join("\n").includes("BLIND"), `实例 "${state}" 时不该告警`);
    assert.match(lines.at(-1), /now unknown \(no data points in window\)/);
  }
});

test("exactly on the stop line the instance is stopped", async () => {
  // 819.2 GiB 恰好等于停机线。`>=` 改成 `>` **只在这一个点上**显形 —— 在两侧各取一点
  // （±1 MiB）是抓不到的。边界必须显式生成，随机采样永远撞不上等号。
  const mock = stubAws({ networkIn: STOP_LINE_GIB * GIB, networkOut: 0 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("StopInstance"), "恰好落在线上必须停机");
  assert.match(lines.at(-1), /STOPPED \| used 819\.200 GiB \(80\.0% of 1024\)/);
});

test("a non-finite sum throws, and says so readably", async () => {
  // `{"sum": 1e400}` 是完全合法的 JSON，JSON.parse 出来是 Infinity。错误消息**不能**用
  // JSON.stringify 序列化它：`JSON.stringify(Infinity)` 是 `"null"`，日志会写成
  // 「unusable sum: null」，把人引向「字段缺失」这个完全错误的方向。
  const mock = stubAws({
    rawMetricBody: '{"metricName":"METRIC","metricData":[{"sum":1e400,"timestamp":1754006400,"unit":"Bytes"}]}',
  });

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", baseEnv, mock),
    (err) => {
      assert.match(err.message, /returned an unusable sum for Network(In|Out): Infinity/);
      assert.ok(!err.message.includes("null"), "Infinity 不能被写成 null");
      return true;
    },
  );
});

test("every credential occurrence is scrubbed, not just the first", async () => {
  // 失败夹具现在把两个凭据各回显两次。只回显一次的话 replaceAll 和 replace 无从区分。
  const mock = stubAws({ fail: "GetInstanceMetricData" });

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", baseEnv, mock),
    (err) => {
      assert.ok(!err.message.includes(ACCESS_KEY_ID), "access key id 必须全部抹掉");
      assert.ok(!err.message.includes(SECRET), "secret 必须全部抹掉");
      assert.ok(err.message.split("[redacted]").length - 1 >= 3, "多处出现应当被逐一替换");
      return true;
    },
  );
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

  assert.deepEqual(opsOf(mock.calls).sort(), [
    "GetInstanceMetricData", "GetInstanceMetricData", "GetInstanceState", "StartInstance",
  ]);
  assert.deepEqual(mock.calls.at(-1).body, { instanceName: "example-instance" });
  // 窗口取的是新月份，而不是那个用量导致停机的月份。
  //
  // 按操作名挑，不按下标取：三次查询是并发发出的（两次指标 + 一次状态），谁先落进
  // calls 由微任务调度决定。写死 calls[0] 会得到一个**偶发**失败的测试 —— 上一次改动
  // 把状态查询并进 Promise.all 之后，这里就有大约五分之一的概率读到状态查询的 body、
  // 拿到 undefined 的 startTime，而它整整绿了一轮。
  assert.equal(metricCalls(mock.calls)[0].body.startTime, Date.parse("2026-09-01T00:00:00Z") / 1000);
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

  assert.equal(opsOf(mock.calls).filter((o) => o === "GetInstanceMetricData").length, 4);
  assert.ok(!opsOf(mock.calls).includes("StartInstance"));
  assert.ok(!opsOf(mock.calls).includes("StopInstance"));
});

test("zero usage on a running instance costs one state check and nothing else", async () => {
  // 新月份的头几分钟，还没有任何数据点落库。
  const mock = stubAws({ state: "running", networkIn: 0, networkOut: 0 });
  await run("2026-09-01T00:00:00Z", baseEnv, mock);

  assert.deepEqual(opsOf(mock.calls).sort(), [
    "GetInstanceMetricData", "GetInstanceMetricData", "GetInstanceState",
  ]);
});

test("MANUAL_HOLD suppresses the start without suppressing the stop", async () => {
  const held = { ...baseEnv, MANUAL_HOLD: "true" };

  // 额度已重置、实例处于停机：正常情况下应该启动。加了 hold 之后，它连状态都不去问。
  const start = stubAws({ state: "stopped" });
  await run("2026-09-01T00:00:00Z", held, start);
  // 状态查询现在是每轮无条件的，所以 HOLD 路径也有它 —— 但仍然不发出任何动作。
  assert.deepEqual(opsOf(start.calls).sort(), [
    "GetInstanceMetricData", "GetInstanceMetricData", "GetInstanceState",
  ]);

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
      assert.match(err.message, /GetInstanceMetricData failed: HTTP 400/);
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
    /StopInstance failed: HTTP 400/,
  );
});

test("an omitted metricData field is a legitimate zero, not an error", async () => {
  // 这条守的是一个差点被写进生产的 bug。AWS 的响应定义里 metricData 没有任何「必然
  // 出现」的保证，各语言 SDK 一律把「字段缺失」正规化成空数组 —— 也就是说服务端允许
  // 在没有数据时把它整个省掉。把「字段缺失」当成读不懂并抛错的代价是致命的：一台停机的
  // 实例在新月份读到的恰恰就是这种空响应，于是每次触发都抛错，重启永远发不出去，实例会
  // 停满一整个月。
  //
  // 更隐蔽的是，当时的打桩正是用 `{ metricName }` 来模拟「畸形响应」的 —— 夹具和测试
  // 一起把同一个错误假设印证了两遍，而 53 个用例全绿。
  const mock = stubAws({ state: "stopped", metricShape: "omitted" });
  const lines = await capturingLogs(() => run("2026-09-01T00:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("StartInstance"), "省掉 metricData 必须读作零，而不是抛错");
  assert.match(lines.at(-1), /^\S+ STARTED \| used 0\.000 GiB \(0\.0% of 1024\) \| stop at 819\.200 GiB \|.*\| allowance reads empty and the instance was stopped$/);
});

test("an empty metricData array is also a legitimate zero", async () => {
  const mock = stubAws({ state: "stopped", metricShape: "wrongMetric" });
  // wrongMetric 回显的是 CPUUtilization，但 metricData 确实是个数组 —— 数据可用，放行。
  await run("2026-09-01T00:00:00Z", baseEnv, mock);
  assert.ok(opsOf(mock.calls).includes("StartInstance"));
});

test("a response with neither a metricData array nor a matching metricName throws", async () => {
  // 两个信号都没有，才是真的读不懂。此时绝不能折算成 0 字节 —— 那是唯一会让看门狗
  // 什么都不做的读数，指标侧一次降级就能让它一边报平安一边放任超额。
  const mock = stubAws({ metricShape: "unrelated" });

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", baseEnv, mock),
    /returned neither a metricData array nor a matching metricName for Network(In|Out)/,
  );
});

test("a string sum throws instead of silently concatenating", async () => {
  // `bytes += "500"` 走的是字符串拼接：两个 500 GiB 的桶会被读成 0.005 GiB —— 少报三个
  // 数量级，而少报正是唯一会让看门狗什么都不做的方向。JSON 里 "500" 是完全合法的值。
  const mock = stubAws({ badPoints: [{ sum: "500", timestamp: 1.754e9 }] });

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", baseEnv, mock),
    /returned an unusable sum for Network(In|Out): 500/,
  );
});

test("a negative sum throws", async () => {
  const mock = stubAws({ badPoints: [{ sum: -1, timestamp: 1.754e9 }] });
  await assert.rejects(() => run("2026-08-15T12:00:00Z", baseEnv, mock), /unusable sum/);
});

test("a null data point throws deliberately rather than crashing", async () => {
  // 不显式检查的话，这里会是一句不透明的 TypeError: Cannot read properties of null ——
  // 那只是碰巧崩了，不是一道防线（换个运行时或换个畸形形状就可能不崩）。
  const mock = stubAws({ badPoints: [null] });
  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", baseEnv, mock),
    /returned a non-object data point for Network(In|Out)/,
  );
});

test("a missing sum is still a legitimate zero", async () => {
  // 桶里没有这个统计量是允许的，按零算 —— 严格化不能把这条正常路径一起拦掉。
  const mock = stubAws({ badPoints: [{ timestamp: 1.754e9 }] });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
  assert.match(lines.at(-1), /used 0\.000 GiB/);
});

test("a query that would exceed the API's datapoint cap throws", async () => {
  // 实测（2026-08-22，ap-northeast-1）：单次查询的上限正好是 1440 个数据点，**超限不报错**
  // —— 1440 个拿回 1440 个，1441 个拿回 0 个，HTTP 仍是 200、metricName 照常回显。落地就是
  // 0 字节，唯一会让看门狗什么都不做的读数。
  //
  // 当前两个查询离上限很远（月度 31、突发 6），所以从 handler 那头走不到这里 —— 它防的是
  // 以后有人把 METRIC_PERIOD_SECONDS 从 86400 改成 900：月度查询要 2976 个点，于是每一轮
  // 都读到 0 字节，而日志一片祥和。所以直接测这个函数。
  const mock = stubAws();
  const client = new AwsClient({
    accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET, service: "lightsail", region: "ap-northeast-1",
  });
  const config = { region: "ap-northeast-1", instanceName: "example-instance", label: "x" };
  const range = { startTime: 0, endTime: 1441 * 300 };
  try {
    await assert.rejects(
      () => sumMetric(client, config, "NetworkOut", range, 300),
      /would ask for 1441 data points, past the 1440/,
    );
    // 正好卡在上限上要放行 —— 边界写成 >= 会把一个合法查询挡掉。
    await sumMetric(client, config, "NetworkOut", { startTime: 0, endTime: 1440 * 300 }, 300);
  } finally {
    mock.restore();
  }
});

test("the datapoint cap counts buckets by their phase, not by the window's span", async () => {
  // 桶的相位跟着查询走：起点是 `floor(startTime / 60) * 60`，最多比 startTime 早 59 秒。
  // 于是一个窗口能盖住的桶数可能比「跨度 ÷ 粒度」多一个。
  //
  // 按跨度算的话，守卫恰好在它守的那个边界上放行：startTime 对 60 取余 59、跨度 5 天、
  // 粒度 300 秒时，跨度算出来是 1440（放行），而真实桶数是 1441 —— 上游对超限**不报错**，
  // 它回 HTTP 200 加一个空数组，落地就是 0 字节。守卫失效的方式恰好是它存在的理由。
  const mock = stubAws();
  const client = new AwsClient({
    accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET, service: "lightsail", region: "ap-northeast-1",
  });
  const config = { region: "ap-northeast-1", instanceName: "example-instance", label: "x" };
  try {
    // 起点没对齐到分钟：跨度仍是 1440 × 300，但真实桶数是 1441。
    await assert.rejects(
      () => sumMetric(client, config, "NetworkOut", { startTime: 59, endTime: 59 + 1440 * 300 }, 300),
      /would ask for 1441 data points, past the 1440/,
      "起点未对齐时窗口多盖一个桶，守卫必须按相位算出 1441",
    );
    // 对照：同样的跨度，起点对齐到分钟时真实桶数就是 1440，必须放行。
    await sumMetric(client, config, "NetworkOut", { startTime: 60, endTime: 60 + 1440 * 300 }, 300);
  } finally {
    mock.restore();
  }
});

test("a month reading missing one whole direction is called out", async () => {
  // 月度查询也有「半瞎」这一档，而且后果更直接：静态线的总量少了一整个方向。
  // 打桩让 NetworkOut 的月度读数一个天桶都没有，NetworkIn 正常。
  const mock = stubAws({ networkIn: 400 * GIB, networkOut: 400 * GIB, monthOutPoints: 0, recentIn: GIB });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
  const text = lines.join("\n");

  assert.match(text, /BLIND \| NetworkOut has no data points in the month-to-date reading/);
  assert.match(text, /under-reports it against the static line/);
  // 而且那一行必须让人看出是哪一侧没了。
  assert.match(lines.at(-1), /days 3,0\/15/);
  // 用量确实只读到了一半 —— 断言这一点，免得哪天打桩改了而测试还在自我印证。
  assert.match(lines.at(-1), /used 400\.000 GiB/);
});

test("a month reading with both directions present raises no half-blind alarm", async () => {
  // 对照：正常那一轮一次都不该出现，否则它就是纯噪音。
  const mock = stubAws({ networkIn: 5 * GIB, networkOut: 5 * GIB, recentIn: GIB });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
  assert.ok(!lines.join("\n").includes("in the month-to-date reading"), lines.join("\n"));
});

test("month coverage takes the pessimistic end at BOTH ends, in opposite directions", async () => {
  // 两头取的方向相反，而且都是悲观的那一侧。这条把两个方向一起钉住——它们看起来对称，
  // 很容易被「统一一下」而改坏，而改坏之后两种都是**静默**的。
  //
  // `oldest` 取 max：总量只有从「两侧都有数据」的那一天起才完整。取 min 的话，
  // NetworkIn 从月初就有、NetworkOut 缺了前九天时，min 恰好等于月初，`covers from`
  // 的条件不成立——九天的出向用量凭空消失，而这个字段一声不吭。
  const mock = stubAws({ monthOutStartsDaysLate: 9, networkIn: 200 * GIB, networkOut: 110 * GIB, recentIn: GIB });
  const lines = await capturingLogs(() => run("2026-08-20T12:00:00Z", baseEnv, mock));

  assert.match(lines.at(-1), /covers from 2026-08-10/, `出向缺了月初九天，必须写出真正的起点：${lines.at(-1)}`);
  // 对照：两个方向的天桶数确实不同，缺口是真实存在的。
  assert.match(lines.at(-1), /days 20,11\/20/);
});

test("month staleness takes the older of the two directions", async () => {
  // `newest` 取 min：只要有一侧的数据停在过去，整份读数就已经过期了。取更新鲜的那一头
  // 会让「一侧管道落后、另一侧照常」报告成一切新鲜，落后告警永不触发——方向是漏停。
  //
  // 突发窗口那一侧有同名的用例（`one metric's pipeline stalling is not masked by the other`），
  // 月度这一侧是同一个判断，两边都要有人守。
  const mock = stubAws({
    networkIn: 100 * GIB,
    networkOut: 100 * GIB,
    monthNewestDaysAgo: 0, // NetworkIn 覆盖到今天
    monthOutNewestDaysAgo: 3, // NetworkOut 停在三天前
    recentIn: GIB,
  });
  const lines = await capturingLogs(() => run("2026-08-20T12:00:00Z", baseEnv, mock));

  assert.match(
    lines.join("\n"),
    /BLIND \| month-to-date reading only covers through 2026-08-17/,
    `一侧停在三天前时必须按那一侧判定过期：${lines.join(" // ")}`,
  );
});

test("a month reading that starts after the month does say so", async () => {
  // 打桩的月度数据只有三个天桶，最老的那个远晚于月初 —— 读数没覆盖到月初这件事必须
  // 出现在日志里。`days 16/22` 只说少了六天，不说少的是哪六天，而「月初连续少六天」
  // 和「中间零散少六天」是完全不同的两件事。
  const mock = stubAws({ networkIn: GIB });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
  assert.match(lines.at(-1), /days 3,3\/15 \| covers from 2026-08-13 \|/);
});

test("a data point in the wrong unit throws instead of being summed", async () => {
  // unit 传错时 AWS 回 HTTP 200 + 空数组，响应侧完全分辨不了 —— 那一侧由零读数告警承接。
  // 但如果哪天返回的桶**带着**另一个单位，那就是响应自己说清楚了：把 Bits 当 Bytes 累加
  // 会少报八倍，而少报是唯一会让看门狗放行的方向。这一条必须响亮地失败。
  const mock = stubAws({ badPoints: [{ sum: 8 * GIB, timestamp: 1.754e9, unit: "Bits" }] });

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", baseEnv, mock),
    /returned Network(In|Out) in Bits, expected Bytes/,
  );
});

test("a data point with no unit field is still accepted", async () => {
  // 刻意的不对称。把**合法的字段缺失**当成畸形响应，
  // 会让停机中的实例整月发不出重启。缺席按「没说」处理，出现且不一致才算错。
  const mock = stubAws({ badPoints: [{ sum: GIB, timestamp: 1.754e9 }] });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
  assert.match(lines.at(-1), /used 2\.000 GiB/);
});

test("the rate denominator follows the seconds actually covered, not the bucket count", async () => {
  // 桶的相位跟着 startTime 走（实测：`floor(startTime / 60) * 60`），所以 startTime 不落在
  // 整分钟上时，第一个桶会有一部分露在窗口之外 —— 它带回来的却是整桶的字节。
  // 拿「桶数 × 粒度」当分母就把那段多出来的时间也算了进去，速率报低，而报低是唯一会让
  // 看门狗放行的方向。
  //
  // 生产里 cron 落在整点格上，两个分母完全相等，这条只在时钟没对齐时才分得开 ——
  // 而 `controller.scheduledTime` 缺席退回 Date.now() 时就是这种情况。
  const aligned = stubAws({ networkIn: 10 * GIB, recentIn: GIB });
  const alignedLines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, aligned));

  const skewed = stubAws({ networkIn: 10 * GIB, recentIn: GIB });
  const skewedLines = await capturingLogs(() => run("2026-08-15T12:00:37Z", baseEnv, skewed));

  const rate = (line) => Number(line.match(/now ([\d.]+) Mbps/)[1]);
  assert.ok(
    rate(skewedLines.at(-1)) > rate(alignedLines.at(-1)),
    `未对齐时分母应当更小、速率更高，实际 ${rate(skewedLines.at(-1))} vs ${rate(alignedLines.at(-1))}`,
  );
  // 少覆盖的那 37 秒占 1800 秒的 2%，速率相应抬高约 2%，不该是数量级的跳变。
  const ratio = rate(skewedLines.at(-1)) / rate(alignedLines.at(-1));
  assert.ok(ratio > 1 && ratio < 1.05, `抬高幅度 ${ratio.toFixed(4)} 超出预期`);
});

test("a metricData that is present but not an array always throws", async () => {
  const mock = stubAws({ metricShape: "notArray" });

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", baseEnv, mock),
    /returned a non-array metricData for Network(In|Out)/,
  );
});

test("an unreadable instance state still stops an over-limit instance", async () => {
  // 已经确认越线了。此时 GetInstanceState 读不出状态，旧实现会让整轮抛异常结束 ——
  // 一次已经确认的越线就这样漏掉一个 cron 周期。停机路径上的不确定性必须向「停」倾斜。
  const mock = stubAws({ networkIn: 900 * GIB, unreadableState: true });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("StopInstance"));
  // 状态查询上移到每轮开头之后，读不出来就在那里写一行 DEGRADED；停机路径照旧 fail-closed。
  assert.match(lines.join("\n"), /DEGRADED \| instance state unreadable .*GetInstanceState returned no state name/);
});

test("a failing state check still stops an over-limit instance", async () => {
  // 同一件事，但失败发生在 HTTP 层（凭据被轮换、IAM 策略被改）。
  const mock = stubAws({ networkIn: 900 * GIB, fail: "GetInstanceState" });
  await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("StopInstance"));
});

test("an unreadable instance state on the restart path does not start the instance", async () => {
  // 与停机路径相反：少启动一次只是站点晚几分钟回来，误启动一台操作者刻意停下的实例
  // 则会开始烧流量。所以状态读不出来时绝不启动。
  //
  // 状态查询上移到每轮开头之后，它的失败不再让整轮抛出 —— 那样会连**停机**路径一起
  // 掐掉，而停机路径本来是 fail-closed 的。改为：开头写一行 DEGRADED，两条路径各自按
  // 自己的方向处理 null。
  const mock = stubAws({ networkIn: 0, networkOut: 0, unreadableState: true });
  const lines = await capturingLogs(() => run("2026-09-01T00:00:00Z", baseEnv, mock));

  assert.ok(!opsOf(mock.calls).includes("StartInstance"), "状态读不出来时绝不启动");
  assert.match(lines.join("\n"), /DEGRADED \| instance state unreadable/);
  assert.match(lines.at(-1), /NOOP \|.*instance state unreadable, not starting$/);
});

test("at the exact month rollover the burst window reaches back into the previous month", async () => {
  // 月度窗口在这一刻只有 60 秒宽，但突发窗口**不**跟着钳到月初 —— 速率是个物理量，
  // 跨过 00:00 UTC 那一刻实例并没有变慢。跟着钳的代价是每个月头 5 分钟闸门完全失明，
  // 而那恰恰是额度刚重置、最可能有人开始猛跑的时候。
  const mock = stubAws({ networkIn: 10 * GIB, recentIn: 5 * GIB });
  const lines = await capturingLogs(() => run("2026-09-01T00:00:00Z", baseEnv, mock));

  const rollover = Date.parse("2026-09-01T00:00:00Z") / 1000;
  const burst = burstCalls(mock.calls);
  assert.equal(burst.length, 2, "闸门必须照常工作");
  for (const call of burst) {
    assert.equal(call.body.startTime, rollover + 60 - 1800, "窗口整整 30 分钟，越过月份边界");
    assert.ok(call.body.startTime < rollover, "起点落在上个月");
  }
  // 上个月的流量落进窗口不会误停：剩余额度用的是本月的用量，此刻接近满额。
  assert.ok(!opsOf(mock.calls).includes("StopInstance"));
  assert.match(lines.at(-1), /^\S+ OK \| used 10\.000 GiB \(1\.0% of 1024\) \|.*\| now /);
});

test("a controller without scheduledTime falls back to the wall clock", async () => {
  // Workers 一定会给 scheduledTime，但兜底那条分支不该是没跑过的代码。
  const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB });
  try {
    await worker.scheduled({ cron: "*/10 * * * *", noRetry() {} }, baseEnv);
  } finally {
    mock.restore();
  }

  const now = new Date();
  assert.equal(
    metricCalls(mock.calls)[0].body.startTime,
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000,
    "窗口仍然要落在当前 UTC 月份的月初",
  );
});

test("a 500 is retried, a 400 is not", async () => {
  // README 声称「2 次重试，只针对 5xx 和 429」。这条用例是那句话的行为证据 —— 光读
  // aws4fetch 的源码不算，因为它决定了一次 ServiceException 抖动会不会白白丢掉一个 cron
  // 周期的防护。Lightsail 的客户端错误全是 400，重试它们只会浪费时间。
  const retried = stubAws({ networkIn: 10 * GIB, recentIn: GIB, serviceErrors: 2 });
  await run("2026-08-15T12:00:00Z", baseEnv, retried);
  // 开头三个请求（两个月度查询 + 状态查询）是并行发出的，前两个各吃一次 500 各重试
  // 一次，然后是两次突发窗口查询：5 次逻辑调用 + 2 次重试 = 7。
  assert.equal(retried.calls.length, 7, "两次 500 应当各触发一次重试");

  const notRetried = stubAws({ fail: "GetInstanceMetricData" });
  await assert.rejects(() => run("2026-08-15T12:00:00Z", baseEnv, notRetried), /HTTP 400/);
  // 400 是终局的：开头三个并行请求各试一次，不该出现重试。
  const metricTries = opsOf(notRetried.calls).filter((o) => o === "GetInstanceMetricData").length;
  assert.ok(metricTries <= 2, `400 不该重试，实际 ${metricTries} 次`);
});

test("misconfiguration throws before any AWS call is made", async () => {
  const mock = stubAws();

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", { ...baseEnv, THRESHOLD: "80" }, mock),
    /THRESHOLD/,
  );
  assert.deepEqual(mock.calls, []);
});
