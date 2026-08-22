// 离散事件模拟器：把真实的 worker.scheduled 挂到一条模拟的指标管道上。
// v2：流量剖面改为分段常数并解析积分（v1 按秒累加，且把底噪从月初一路积到突发，
// 与 priorUsedBytes 重复计数，导致静态线在突发之前就被触发）。
//
// 管道模型（每一条都是可替换的假设）：
//   1. 底层指标以 300 秒为桶发布；桶 [300k,300(k+1)) 在 300(k+1)+L 时刻可查。
//   2. period=300 返回窗口内已发布的桶；period=86400 把已发布样本按 UTC 日聚合。
//   3. cron 每 CRON 秒落在时间格上；StopInstance 在 STOP_PROP 秒后真正断流。
export const GIB = 1024 ** 3;
const PREROLL = 3600;   // 突发之前先跑一小时底噪，把突发窗口填满数据点

export function makeSimulate(worker) {
 return async function simulate({
  quotaGib = 1024, threshold = 0.8,
  lag = 600, cron = 600, stopProp = 60,
  monthStartIso = "2026-08-01T00:00:00Z",
  burstStartIso = "2026-08-15T12:00:00Z",
  burstBps = 0, baselineBps = 0, burstDurationS = Infinity,
  priorUsedBytes = 0,          // 突发开始时的月初至今用量（含底噪之外的全部历史）
  emitZeroBuckets = true,
  horizonHours = 240,
  direction = "out",
  quietOther = true,           // 另一个方向是否完全没有数据点
 } = {}) {
  const monthStart = Date.parse(monthStartIso) / 1000;
  const burstStart = Date.parse(burstStartIso) / 1000;
  const quotaBytes = quotaGib * GIB;
  let stopAt = null, stopIssuedAt = null, stopReason = null;

  // 分段常数速率，解析积分
  const segs = () => [
    [monthStart, burstStart - PREROLL, 0],
    [burstStart - PREROLL, burstStart, baselineBps],
    [burstStart, Math.min(burstStart + burstDurationS, stopAt ?? Infinity), baselineBps + burstBps],
    [Math.min(burstStart + burstDurationS, stopAt ?? Infinity), stopAt ?? Infinity, baselineBps],
  ];
  const bytesBetween = (a, b) => {
    if (b <= a) return 0;
    let s = 0;
    for (const [s0, s1, r] of segs()) {
      if (r === 0) continue;
      const lo = Math.max(a, s0), hi = Math.min(b, s1);
      if (hi > lo) s += (hi - lo) * r;
    }
    return s;
  };
  const publishedThrough = (now) => Math.floor((now - lag) / 300) * 300;

  const env = {
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    AWS_REGION: "ap-northeast-1", INSTANCE_NAME: "sim",
    QUOTA_GIB: String(quotaGib), THRESHOLD: String(threshold),
  };

  let nowSec = 0;
  const logs = [];
  const origFetch = globalThis.fetch;
  const { log, error } = console;

  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const op = req.headers.get("X-Amz-Target").split(".")[1];
    const body = await req.json();
    if (op === "GetInstanceState")
      return Response.json({ state: { name: stopAt === null || nowSec < stopAt ? "running" : "stopped" } });
    if (op === "StopInstance") {
      if (stopIssuedAt === null) { stopIssuedAt = nowSec; stopAt = nowSec + stopProp; }
      return Response.json({ operations: [{ id: "x", status: "Started" }] });
    }
    if (op === "StartInstance") return Response.json({ operations: [{ id: "x", status: "Started" }] });
    if (op !== "GetInstanceMetricData") throw new Error("unexpected " + op);

    const mine = (body.metricName === "NetworkOut") === (direction === "out");
    if (!mine && quietOther) return Response.json({ metricName: body.metricName, metricData: [] });

    // 底层是 300 秒的样本：样本 k 覆盖 [300k, 300(k+1))，在 300(k+1)+L 时刻发布。
    // 查询把**已发布的完整样本**按 period 归并到 bin 里；没有任何已发布样本的 bin 省略。
    const frontier = publishedThrough(nowSec);   // 最后一个已发布样本的结束时刻
    const period = body.period;
    const points = [];
    for (let bin = body.startTime; bin < body.endTime; bin += period) {
      const binEnd = Math.min(bin + period, body.endTime);
      let sum = 0, n = 0;
      for (let k = Math.ceil(bin / 300); (k + 1) * 300 <= Math.min(binEnd, frontier); k++) {
        sum += mine ? bytesBetween(k * 300, (k + 1) * 300) : 0;
        n++;
      }
      if (period === 86400 && bin === body.startTime && n > 0) sum += mine ? priorUsedBytes : 0;
      if (n === 0) continue;                       // 没有已发布样本 -> 这个 bin 不存在
      if (sum === 0 && !emitZeroBuckets) continue; // 样本值为零时上游是否仍发点：可切换的假设
      points.push({ sum, timestamp: bin, unit: "Bytes" });
    }
    return Response.json({ metricName: body.metricName, metricData: points });
  };
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));

  try {
    for (let T = Math.ceil((burstStart - PREROLL) / cron) * cron; T <= burstStart + horizonHours * 3600; T += cron) {
      nowSec = T;
      if (stopAt !== null && T >= stopAt) break;
      await worker.scheduled({ scheduledTime: T * 1000, cron: "*/10 * * * *", noRetry() {} }, env);
      if (stopIssuedAt !== null) { stopReason = logs.at(-1); break; }
    }
  } finally { globalThis.fetch = origFetch; console.log = log; console.error = error; }

  const cutoff = stopAt ?? (burstStart + horizonHours * 3600);
  const trueUsed = priorUsedBytes + bytesBetween(monthStart, cutoff);
  return {
    stopped: stopIssuedAt !== null, stopIssuedAt, stopAt, stopReason, logs,
    trueUsedGibAtStop: trueUsed / GIB,
    overshootGib: (trueUsed - quotaBytes) / GIB,
    secondsFromBurstToStop: stopAt === null ? null : stopAt - burstStart,
    burnedAfterBurstGib: bytesBetween(burstStart, cutoff) / GIB,
  };
 };
}
import worker from "./index-w1800.js";
export const simulate = makeSimulate(worker);
