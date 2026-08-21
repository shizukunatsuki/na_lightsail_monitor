// 性质测试。前面几轮 review 的方法都是「我想到什么就查什么」，于是每换一个视角就
// 冒出新问题 —— 那说明靠人列举组合是不够的。
//
// 这个文件反过来做：随机生成几千个场景，断言一组**从需求推出来、而不是从实现抄下来**
// 的不变量。它找不到「设计想错了」，但能把「某个组合下行为不对」翻出来。
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const GIB = 1024 ** 3;

/** 定死种子的 LCG：失败可以精确复现，不靠 Math.random。 */
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Lightsail 实例可能出现的全部状态，不只是 running/stopped。 */
const STATES = ["pending", "running", "shutting-down", "terminated", "stopping", "stopped"];

// 分层轮转，而不是纯随机。纯随机下「manualHold 且用量为零且实例 stopped 且没注入故障」
// 这种组合的概率约 0.2%，250 个样本期望命中 0.5 次 —— 变异测试正是在这里漏掉了
// 「去掉 MANUAL_HOLD」。罕见组合要靠分层保证，不能靠加大样本量去赌。
const STRATA = ["restart", "boundary", "burst", "failure", "random"];

function scenario(r, stratum) {
  const quotaGib = [1024, 2048, 3072, 512][Math.floor(r() * 4)];
  const threshold = [0.5, 0.8, 0.95, 1][Math.floor(r() * 4)];
  // 三档用量：恰为零、阈值附近、全域随机。零那一档要足够常见，重启路径才会被走到。
  const pick = stratum === "restart" ? 0 : stratum === "boundary" ? 0.25 : r();
  const usedGib =
    pick < 0.2
      ? 0
      : // 精确落在停机线上。随机浮点数永远命中不了等号，而 `>=` 和 `>` 的差别只在这一点上
        // 显形 —— 边界必须显式生成，不能指望采样撞上。
        pick < 0.3
        ? quotaGib * threshold
        : pick < 0.6
          ? quotaGib * threshold * (0.98 + r() * 0.04)
          : r() * quotaGib * 1.1;
  const OPS = ["GetInstanceMetricData", "GetInstanceState", "StopInstance", "StartInstance"];
  return {
    // 注入 AWS 侧失败与畸形响应。不生成这些，整个错误处理路径就从未被探索过 ——
    // 变异测试正是在这里漏掉了「去掉脱敏」和「去掉畸形 metricData 检查」两个缺陷。
    failOp: stratum === "failure" || r() < 0.15 ? OPS[Math.floor(r() * OPS.length)] : null,
    // 400 / 403 / 500 三档都要生成。Lightsail 的两份文档对 AccessDeniedException 给的
    // 状态码并不一致（按操作那份写 400，Common Errors 那份写 403），而重试只认 5xx 和
    // 429 —— 400 与 403 都是终局失败，500 会被重试三次。此前只生成 400/500，等于把 403
    // 那条路径整个排除在外。
    failStatus: [400, 403, 500][Math.floor(r() * 3)],
    badShape:
      r() < 0.12
        ? ["notArray", "unrelated", "stringSum", "negativeSum"][Math.floor(r() * 4)]
        : null,
    // 大到让字节数溢出安全整数范围的额度：能通过「有限且为正」，却会让停机线变成一个
    // 永远够不到的数。必须在发出任何 AWS 请求之前被拒绝。
    absurdQuota: r() < 0.05,
    quotaGib,
    threshold,
    usedGib,
    // 两个方向独立取量、独立取落库进度 —— 上一轮那个「用共同分母摊平速率」的漏停
    // bug 就活在这一维里，打桩必须能生成它。
    recentInGib: stratum === "burst" ? r() * 2 : r() < 0.3 ? r() * quotaGib : r() * 2,
    recentOutGib: stratum === "burst" || r() < 0.3 ? r() * quotaGib : r() * 2,
    // 突发分层刻意让两个方向的落库进度悬殊，并把流量压在桶少的那一侧 —— 「用共同分母
    // 摊平速率」的漏停 bug 只在这一维显形，纯随机很难稳定撞到。
    inPoints: stratum === "burst" ? 6 : Math.floor(r() * 7),
    outPoints: stratum === "burst" ? 1 + Math.floor(r() * 2) : Math.floor(r() * 7),
    state: STATES[Math.floor(r() * STATES.length)],
    manualHold: r() < 0.15,
    lagSeconds: Math.floor(r() * 2400),
  };
}

function stub(sc) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const op = req.headers.get("X-Amz-Target").split(".")[1];
    const body = await req.json();
    calls.push({ op, body });

    if (sc.failOp === op) {
      // 照着真实的 SigV4 拒绝响应来 —— 它会回显 credential scope，里面嵌着 access key id。
      return new Response(
        `{"__type":"AccessDeniedException","message":"Credential should be scoped: ${ACCESS_KEY_ID}/20260815/ap-northeast-1/lightsail/aws4_request. Secret was ${SECRET}"}`,
        { status: sc.failStatus },
      );
    }

    if (op === "GetInstanceState") return Response.json({ state: { name: sc.state } });
    if (op === "GetInstanceMetricData") {
      if (sc.badShape === "notArray") return Response.json({ metricName: body.metricName, metricData: 7 });
      if (sc.badShape === "unrelated") return Response.json({ ok: true });
      if (sc.badShape === "stringSum")
        return Response.json({ metricName: body.metricName, metricData: [{ sum: "500", timestamp: 1.754e9 }] });
      if (sc.badShape === "negativeSum")
        return Response.json({ metricName: body.metricName, metricData: [{ sum: -1, timestamp: 1.754e9 }] });
      const isIn = body.metricName === "NetworkIn";
      const burst = body.period === 300;
      const total = burst
        ? (isIn ? sc.recentInGib : sc.recentOutGib) * GIB
        : (isIn ? sc.usedGib : 0) * GIB;
      const n = burst ? (isIn ? sc.inPoints : sc.outPoints) : 1;
      const newest = body.endTime - sc.lagSeconds - 300;
      return Response.json({
        metricName: body.metricName,
        metricData: Array.from({ length: n }, (_, i) => ({
          sum: n ? total / n : 0,
          timestamp: newest - (n - 1 - i) * 300,
          unit: "Bytes",
        })),
      });
    }
    return Response.json({ operations: [{ id: "x", status: "Started" }] });
  };
  return calls;
}

const TOKENS = ["OK", "STOPPED", "STARTED", "NOOP", "HOLD"];

async function runScenario(sc, at) {
  const calls = stub(sc);
  const lines = [];
  const { log, error } = console;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  let threw = null;
  try {
    await worker.scheduled(
      { scheduledTime: Date.parse(at), cron: "*/2 * * * *", noRetry() {} },
      {
        AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: SECRET,
        AWS_REGION: "ap-northeast-1",
        INSTANCE_NAME: "example-instance",
        QUOTA_GIB: sc.absurdQuota ? "1e308" : String(sc.quotaGib),
        THRESHOLD: String(sc.threshold),
        ...(sc.manualHold ? { MANUAL_HOLD: "true" } : {}),
      },
    );
  } catch (err) {
    threw = err;
  } finally {
    console.log = log;
    console.error = error;
  }

  // Promise.all 里一个请求失败时，另一个的重试链还挂在 setTimeout 上 —— 它会在下一个
  // 场景装好新桩之后才回调，把调用记到下一个场景头上，于是调用计数完全不可信。
  // 只有注入 5xx 时才会有重试，所以只在那时排空，其余场景不付这个时间。
  if (sc.failOp && sc.failStatus === 500) {
    let seen = -1;
    while (seen !== calls.length) {
      seen = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  return { calls, lines, threw, ops: calls.map((c) => c.op) };
}

test("invariants hold across randomised scenarios", async () => {
  const r = rng(20260821);
  const moments = ["2026-08-15T12:00:00Z", "2026-09-01T00:00:00Z", "2026-09-01T04:00:00Z", "2026-02-28T23:00:00Z"];

  // 变异测试要把整个套件跑很多遍，那时用小样本换速度；CI 与本地默认跑满。
  const CASES = Number(process.env.INVARIANT_CASES ?? 1500);
  for (let i = 0; i < CASES; i++) {
    const sc = scenario(r, STRATA[i % STRATA.length]);
    const at = moments[i % moments.length];
    const { calls, lines, threw, ops } = await runScenario(sc, at);
    const where = `seed case #${i} ${JSON.stringify(sc)} at ${at}`;

    // 0. 会让看门狗静默失效的配置必须在**发出任何 AWS 请求之前**被拒绝。
    if (sc.absurdQuota) {
      assert.ok(threw, `${where}: absurd QUOTA_GIB was accepted`);
      assert.match(threw.message, /QUOTA_GIB/, `${where}: wrong rejection: ${threw.message}`);
      assert.equal(calls.length, 0, `${where}: made ${calls.length} AWS calls despite bad config`);
      continue;
    }

    // 1. 没有注入任何故障时不该抛出；注入了故障就必须响亮地失败或安全地兜住，
    //    绝不能既吞掉错误又继续走下去。
    if (!sc.failOp && !sc.badShape) {
      assert.equal(threw, null, `${where}: unexpected throw ${threw?.message}`);
    }

    // 2. 畸形的指标响应必须抛错，绝不能被折算成 0 字节 —— 那是唯一会让看门狗什么都
    //    不做的读数。而且必须是**有意**的错误：一个 TypeError 说明只是碰巧崩了，
    //    换个运行时或换个畸形形状就可能不崩，那不是防线。
    // HTTP 层先失败时拿到的是 HTTP 错误，形状检查根本没轮到 —— 那不算反例。
    if (sc.badShape && sc.failOp !== "GetInstanceMetricData") {
      assert.ok(threw, `${where}: malformed metric response was swallowed`);
      assert.match(
        threw.message,
        /GetInstanceMetricData returned/,
        `${where}: crashed instead of rejecting: ${threw.constructor.name}: ${threw.message}`,
      );
    }

    // 3. 凭据绝不出现在任何地方 —— 日志行、异常消息，无论走到哪条分支。
    for (const text of [...lines, threw?.message ?? ""]) {
      assert.ok(!text.includes(ACCESS_KEY_ID), `${where}: access key id leaked in: ${text.slice(0, 160)}`);
      assert.ok(!text.includes(SECRET), `${where}: secret leaked in: ${text.slice(0, 160)}`);
    }

    // 3. 调用次数有上界，而且要把「逻辑操作」和「HTTP 请求」分开数 —— 5xx 会被
    //    aws4fetch 重试两次，一个逻辑调用最多变成三次请求。直接给 HTTP 总数定一个
    //    魔数只会写出一个自己都说不清的上界。
    //    逻辑操作最多 6 个：2 月度 + 2 突发 + 1 状态 + 1 动作。
    const key = (c) => (c.body.period ? `${c.op}:${c.body.period}:${c.body.metricName}` : c.op);
    const attempts = new Map();
    for (const c of calls) attempts.set(key(c), (attempts.get(key(c)) ?? 0) + 1);
    assert.ok(attempts.size <= 6, `${where}: ${attempts.size} distinct operations: ${[...attempts.keys()]}`);
    for (const [k, n] of attempts) {
      assert.ok(n <= 3, `${where}: ${k} attempted ${n} times (retries cap at 3)`);
    }

    // 4. 一次触发只能做一件事，绝不同时停机和启动。判断的是**逻辑动作**而不是 HTTP
    //    尝试次数 —— 一次 5xx 重试会让同一个动作出现三次请求，那不是「停了三次」。
    const stopped = attempts.has("StopInstance");
    const started = attempts.has("StartInstance");
    assert.ok(!(stopped && started), `${where}: stopped and started in the same run`);

    // 5. 正常跑完必须恰好留下一行终态。BLIND / DEGRADED 是附加告警，不算终态。
    const terminal = lines.filter((l) => TOKENS.some((t) => l.includes(` ${t} | `)));
    if (!threw) {
      assert.equal(terminal.length, 1, `${where}: ${terminal.length} terminal lines: ${lines.join(" /// ")}`);
    }

    // 6. 启动只允许发生在「月初至今恰为零 + 实例 stopped + 没有 hold」这一种情形。
    if (started) {
      assert.equal(sc.usedGib, 0, `${where}: started with non-zero usage`);
      assert.equal(sc.state, "stopped", `${where}: started from state ${sc.state}`);
      assert.equal(sc.manualHold, false, `${where}: started while held`);
    }

    // 7. 停机只允许发生在实例 running 时，且必须有越线或突发的理由。
    if (stopped && sc.failOp !== "GetInstanceState") {
      assert.equal(sc.state, "running", `${where}: stopped from state ${sc.state}`);
      assert.ok(
        threw || terminal[0].includes("STOPPED"),
        `${where}: stop issued but terminal line is ${terminal[0]}`,
      );
    }

    // 8. 越过静态线且实例在跑 —— 这是账单护栏的核心承诺，任何情况下都不能漏。
    //    注意 MANUAL_HOLD 不豁免停机，它只抑制启动。
    // 指标读不出来就谈不上判断，所以这条只在指标可用时成立；但 GetInstanceState 失败
    // **不**豁免它 —— 停机路径是 fail-closed 的，状态读不到也要照停。
    const metricsUsable = sc.failOp !== "GetInstanceMetricData" && !sc.badShape;
    if (metricsUsable && sc.usedGib >= sc.quotaGib * sc.threshold && sc.state === "running") {
      assert.ok(stopped, `${where}: MISSED STOP — over the line and running`);
    }
    if (metricsUsable && sc.usedGib >= sc.quotaGib * sc.threshold && sc.failOp === "GetInstanceState") {
      assert.ok(stopped, `${where}: state check failed but the stop must still go out`);
    }

    // 9a. 评估的必须是 scheduledTime 所在的那一格，而不是墙上时钟。cron 被延迟或重试时
    //     这条是唯一能保证「算的还是当初被触发的那一格」的东西。
    const monthQueries = calls.filter((c) => c.body.period === 86400);
    if (monthQueries.length > 0) {
      const d = new Date(Date.parse(at));
      assert.equal(
        monthQueries[0].body.startTime,
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000,
        `${where}: month window does not match scheduledTime`,
      );
      assert.ok(
        monthQueries[0].body.endTime <= Math.max(Date.parse(at) / 1000, 0) + 60,
        `${where}: window end runs past the scheduled tick`,
      );
    }

    // 9. 用量为零时绝不可能停机 —— 没有任何理由。
    if (sc.usedGib === 0) assert.ok(!stopped, `${where}: stopped at zero usage`);

    // 10. 突发闸门的承诺，直接按需求复述一遍：按当前速率剩余额度撑不过反应视野、且
    //     实例在跑，就必须停。速率是两个方向各自除以自己的覆盖时长再相加 —— 这条公式
    //     是需求本身，不是从实现里抄的变量。
    const rateOf = (gib, pts) => (pts > 0 ? (gib * GIB) / (pts * 300) : 0);
    const bps = rateOf(sc.recentInGib, sc.inPoints) + rateOf(sc.recentOutGib, sc.outPoints);
    const remaining = (sc.quotaGib - sc.usedGib) * GIB;
    if (metricsUsable && sc.state === "running" && sc.usedGib > 0 && bps > 0 && remaining > 0 && remaining / bps < 1800) {
      assert.ok(stopped, `${where}: MISSED BURST STOP — ${(remaining / bps / 60).toFixed(1)} min to quota`);
    }
  }
});
