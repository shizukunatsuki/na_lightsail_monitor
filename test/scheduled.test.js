// 用一个打桩的全局 fetch 端到端地跑 scheduled handler。请求确实经过 aws4fetch 真实
// 签名；但没有任何东西离开本进程，也不涉及任何真实的 AWS 凭据或端点。
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

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
  recentInLagSeconds,
  recentOutLagSeconds,
  metricShape,
  monthCoversOnlyThrough,
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
      // 两个凭据各回显**两次**。只出现一次的话，`replaceAll` 和 `replace` 行为完全一样，
      // 「必须替换全部出现」这条性质就没有任何测试能区分 —— 独立审计正是这样发现它没被
      // 覆盖的（把 replaceAll 改成 replace，78 个用例全绿）。
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
          // 时间戳锚定到请求的 endTime：最新那个桶覆盖 [newest, newest + 300)，而它比
          // 「此刻」早了 recentLagSeconds —— 这就是被模拟的落库延迟。
          const lagFor = (isIn ? recentInLagSeconds : recentOutLagSeconds) ?? recentLagSeconds;
          const newest = body.endTime - lagFor - BURST_PERIOD;
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
        // 时间戳按天对齐、最新的一个是**今天**的桶。此前这里用的是三个固定的历史时间戳，
        // 等于对月度查询的覆盖范围完全没有建模 —— 跨模型审计正是从这个维度切进来的：
        // period 86400 的桶是一整天，如果 API 只返回已关闭的天桶，月度读数就对今天全盲。
        // 打桩按「返回当天部分聚合」（解释 A）建模；`monthCoversOnlyThrough` 可以切到
        // 另一种语义。
        const today = Math.floor(body.endTime / 86400) * 86400;
        const newestDay = monthCoversOnlyThrough === "yesterday" ? today - 86400 : today;
        // 乱序、稀疏，并且其中一个数据点完全没有 `sum` 字段 —— 这三件事 API 一件都
        // 不保证。
        return Response.json({
          metricName: body.metricName,
          metricData: [
            { sum: total * 0.25, timestamp: newestDay, unit: "Bytes" },
            { timestamp: newestDay - 86400, unit: "Bytes" },
            { sum: total * 0.75, timestamp: newestDay - 2 * 86400, unit: "Bytes" },
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
      " | now 0 kbps, never to quota | month 47% elapsed, projected 2 GiB | meter 5.0 min behind",
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
    /^\S+ OK \| used 700\.000 GiB \(68\.4% of 1024\) \| stop at 819\.200 GiB \| now 23\.9 Mbps, 32\.4 h to quota \| month 47% elapsed, projected 1497 GiB \| meter 5\.0 min behind$/,
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
  const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB, recentLagSeconds: 12 * 60 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.at(-1), /meter 12\.0 min behind$/);
});

test("one metric's pipeline stalling is not masked by the other", async () => {
  // 速率刻意按每个指标各算各的，理由是「两个指标的落库进度并不保证同步」。那么新鲜度
  // 也必须按同一个前提判断。此前这里取的是两者中**更新鲜**的那一个，于是「NetworkOut
  // 管道停摆、NetworkIn 照常」会被报告成一切新鲜：不响 BLIND、不标 (stale)、meter 报 0,
  // 而速率里有一半是二十多分钟前的数据 —— 半瞎的计量表被读作全新鲜，方向是漏停。
  //
  // 既有的「自我评价随延迟单调不减」那条不变量看不见它，因为它的打桩把两个指标的延迟
  // 一起推移。这正是本项目踩过不止一次的「缺失的不变量」形状。
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
  const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB, recentLagSeconds: 22 * 60, recentPoints: 1 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(
    lines.join("\n"),
    /^\S+ BLIND \| newest metric bucket is 22\.0 min old, past the 12 min tolerance \|/m,
  );
  // 措辞只陈述观察到的事实：光看指标分不出「指标侧延迟」和「实例没在跑」。
  assert.match(lines.join("\n"), /meter lagging, or the instance is not running/);
  // 而且刚被宣布不可信的那个速率，在 OK 行里必须带 (stale) 标记，不能装成正常读数。
  assert.match(lines.at(-1), /^\S+ OK \|.*\| now \S+ \S+ \(stale\), /);
  assert.ok(!opsOf(mock.calls).includes("StopInstance"), "报警归报警，不能因此停机");
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
  // 这条守的是一个只在改了 cron 之后才出现的缺陷。告警门槛原先是从**观察窗口**推出来的
  // （凑不出两个数据点 = 20 分钟）；而真正会断的是**检测回路**：cron 每 2 分钟时闸门在
  // 延迟 25 分钟才守不住，20 分钟的告警是提前的；cron 放宽到 10 分钟后临界点降到 16 分钟，
  // 同一个 20 分钟就变成了迟到四分钟 —— 延迟落在 [16, 20) 分钟时设计已经失效而没有任何
  // 提示。门槛必须挂在回路上，且留出提前量。
  for (const minutes of [12, 14, 16, 19]) {
    const mock = stubAws({ networkIn: 10 * GIB, recentIn: GIB, recentLagSeconds: minutes * 60, recentPoints: 3 });
    const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));
    assert.match(lines.join("\n"), /BLIND \|/, `延迟 ${minutes} 分钟必须告警`);
  }

  // 容忍上限之内不该有任何噪音。
  for (const minutes of [5, 8, 11]) {
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
    const mock = stubAws({ networkIn: 100 * GIB, recentIn: GIB, monthCoversOnlyThrough: "yesterday" });
    const lines = await capturingLogs(() => run(at, baseEnv, mock));
    assert.ok(
      !lines.join("\n").includes("month-to-date reading only covers"),
      `${at}：跨日那一格不该告警，实际写了 ${lines.find((l) => l.includes("BLIND"))}`,
    );
  }
});

test("a month-to-date reading that does not cover today is reported", async () => {
  // 跨模型审计的头号发现。月度查询用 period: 86400，桶是一整天。如果 Lightsail 沿用
  // 「只返回已完成周期」的语义，月度读数就只覆盖到昨天 —— 今天的流量对静态线完全不可见，
  // 盲区最长 24 小时，比处处标定的「10 分钟落库延迟」大两个数量级，而此前日志里零痕迹。
  //
  // 这个检查在两种语义下都正确：返回当天部分聚合时永不触发；只返回已关闭天桶时必然触发。
  // 也就是说它既是防线，也是那个「一次 API 调用才能分辨」的实验 —— 上线第一天就有结论。
  const mock = stubAws({ networkIn: 100 * GIB, recentIn: GIB, monthCoversOnlyThrough: "yesterday" });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| month-to-date reading only covers through 2026-08-14/);
  assert.match(lines.join("\n"), /12\.0 h behind/);
  assert.match(lines.join("\n"), /today's traffic is invisible to the static line/);
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
  // 实例还在跑、读数却仍是零 —— 这个前提在此刻不成立，多半说明月度读数没覆盖到今天。
  const mock = stubAws({ state: "running", networkIn: 0, networkOut: 0 });
  const lines = await capturingLogs(() => run("2026-09-01T09:00:00Z", baseEnv, mock));

  assert.match(lines.join("\n"), /BLIND \| 9\.0 h into the month, instance is running, yet month-to-date reads exactly zero/);
  assert.match(lines.join("\n"), /the zero-byte gate's premise does not hold here/);
});

test("the same zero reading in the first minutes of a month is normal", async () => {
  // 对照：跨月头几分钟读数为零是完全正常的，不该告警。
  const mock = stubAws({ state: "running", networkIn: 0, networkOut: 0 });
  const lines = await capturingLogs(() => run("2026-09-01T00:20:00Z", baseEnv, mock));

  assert.ok(!lines.join("\n").includes("into the month"), "月初头几分钟不该告警");
  assert.match(lines.at(-1), /NOOP \|.*instance is "running"/);
});

test("an empty burst window on a running instance is reported, never read as zero traffic", async () => {
  // 独立审计发现的最严重缺陷（F1）。可观测延迟有天花板：窗口 30 分钟 − 粒度 5 分钟
  // = 25 分钟。越过它之后窗口里一个点都落不进来，于是 newest 为 null、延迟算不出来、
  // 失明检测跟着失效，而 rateOf 返回的 0 会被当成正常读数打进日志 —— 看门狗在没有任何
  // 数据的情况下**主动断言实例没有流量**。这正是本项目明令禁止的那件事，只不过发生在
  // 速率路径而不是用量路径上。
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
  // 跨模型审计的 A3。此前唯一的检查是 `typeof === "number"`，于是毫秒时间戳会让
  // endTime − (newest + 300) 变成巨大的负数、被 Math.max(0, …) 钳到 0 —— staleness 检测
  // 整体失效，而日志还宣称「meter 0.0 min behind」数据很新鲜。真实落库延迟 20 分钟
  // （已越过 12 分钟容忍线）时，秒时间戳会正常告警，毫秒时间戳则一声不吭。
  //
  // 讽刺的是 README「编码时的坑」自己就写着「多乘或少乘一个 1000 是这里的经典 bug」,
  // 而当时只防了「不是数字」那一半。
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
  // 819.2 GiB 恰好等于停机线。`>=` 改成 `>` 只在这一点上显形，而例子测试此前只在两侧
  // 各取了一点（±1 MiB），于是这个变异只有性质测试的 boundary 分层能抓 —— 防线只有一层。
  const mock = stubAws({ networkIn: STOP_LINE_GIB * GIB, networkOut: 0 });
  const lines = await capturingLogs(() => run("2026-08-15T12:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("StopInstance"), "恰好落在线上必须停机");
  assert.match(lines.at(-1), /STOPPED \| used 819\.200 GiB \(80\.0% of 1024\)/);
});

test("a non-finite sum throws, and says so readably", async () => {
  // `{"sum": 1e400}` 是完全合法的 JSON，JSON.parse 出来是 Infinity。此前错误消息用
  // JSON.stringify 序列化它，而 JSON.stringify(Infinity) 是 "null" —— 日志会写成
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
  // 在没有数据时把它整个省掉。此前的实现把「字段缺失」当成读不懂并抛错，而一台停机的
  // 实例在新月份读到的恰恰就是这种空响应：每次触发都抛错，重启永远发不出去，实例会
  // 停满一整个月。
  //
  // 更隐蔽的是，当时的打桩正是用 `{ metricName }` 来模拟「畸形响应」的 —— 夹具和测试
  // 一起把同一个错误假设印证了两遍，而 53 个用例全绿。
  const mock = stubAws({ state: "stopped", metricShape: "omitted" });
  const lines = await capturingLogs(() => run("2026-09-01T00:00:00Z", baseEnv, mock));

  assert.ok(opsOf(mock.calls).includes("StartInstance"), "省掉 metricData 必须读作零，而不是抛错");
  assert.match(lines.at(-1), /^\S+ STARTED \| used 0\.000 GiB \(0\.0% of 1024\) \| stop at 819\.200 GiB \| allowance reads empty and the instance was stopped$/);
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
  // 此前这里是一句不透明的 TypeError: Cannot read properties of null。
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
    mock.calls[0].body.startTime,
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000,
    "窗口仍然要落在当前 UTC 月份的月初",
  );
});

test("a 500 is retried, a 400 is not", async () => {
  // README 声称「2 次重试，只针对 5xx 和 429」。此前这条只靠读 aws4fetch 源码来确认，
  // 没有任何行为测试 —— 而它决定了一次 ServiceException 抖动会不会白白丢掉一个 cron
  // 周期的防护。Lightsail 的客户端错误全是 400，重试它们只会浪费时间。
  const retried = stubAws({ networkIn: 10 * GIB, recentIn: GIB, serviceErrors: 2 });
  await run("2026-08-15T12:00:00Z", baseEnv, retried);
  // 两个月度查询是并行发出的，各吃一次 500 各重试一次，然后是两次突发窗口查询：
  // 4 次逻辑调用 + 2 次重试 = 6。
  assert.equal(retried.calls.length, 6, "两次 500 应当各触发一次重试");
  assert.equal(opsOf(retried.calls).filter((o) => o === "GetInstanceMetricData").length, 6);

  const notRetried = stubAws({ fail: "GetInstanceMetricData" });
  await assert.rejects(() => run("2026-08-15T12:00:00Z", baseEnv, notRetried), /HTTP 400/);
  // 400 是终局的：两个指标各试一次就抛，不该出现第三次尝试。
  assert.ok(notRetried.calls.length <= 2, `400 不该重试，实际 ${notRetried.calls.length} 次`);
});

test("misconfiguration throws before any AWS call is made", async () => {
  const mock = stubAws();

  await assert.rejects(
    () => run("2026-08-15T12:00:00Z", { ...baseEnv, THRESHOLD: "80" }, mock),
    /THRESHOLD/,
  );
  assert.deepEqual(mock.calls, []);
});
