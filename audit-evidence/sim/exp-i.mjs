// 实验 I：突发起点相对 cron 时间格的相位会显著改变结果（5 Gbps 下一格 = 349 GiB）。
// 扫相位，给出区间而不是单点，否则任何单点结论都是运气。
import { simulate, GIB } from "./harness.mjs";
import { simulate as noGate } from "./harness-nogate.mjs";
const GBPS = 1e9 / 8, MBPS = 1e6 / 8;
const PHASES = [];
for (let s = 0; s < 600; s += 60) PHASES.push(s);
const iso = (s) => new Date(Date.parse("2026-08-15T12:00:00Z") + s * 1000).toISOString();

async function span(sim, opts) {
  const v = [];
  for (const p of PHASES) v.push((await sim({ ...opts, burstStartIso: iso(p) })).trueUsedGibAtStop);
  return { min: Math.min(...v), max: Math.max(...v) };
}

console.log("5 Gbps 从空表开始，额度 1024 GiB —— 扫 cron 相位后的区间（README 给的是单点）\n");
console.log("  L        README只静态线   实测区间          README加闸门   实测区间           闸门是否守住配额");
const readme = { 5: [1465, 809], 10: [1640, 902], 15: [1815, 1008], 20: [1989, 1129], 25: [2164, 1269], 30: [2338, 2338] };
for (const min of [5, 10, 15, 20, 25, 30]) {
  const o = { burstBps: 5 * GBPS, baselineBps: 2 * MBPS, priorUsedBytes: 0, lag: min * 60, horizonHours: 400 };
  const g = await span(simulate, o), n = await span(noGate, o);
  const [rn, rg] = readme[min];
  console.log(`${String(min).padStart(3)}min ${String(rn).padStart(12)}   ${`${n.min.toFixed(0)}–${n.max.toFixed(0)}`.padEnd(16)}` +
    `${String(rg).padStart(10)}   ${`${g.min.toFixed(0)}–${g.max.toFixed(0)}`.padEnd(17)}${g.max <= 1024 ? "守住" : g.min <= 1024 ? "看相位" : "×× 守不住"}`);
}

console.log("\n\n1 Gbps 越过静态线之后最坏还能再烧多少？（README 声称约 164 GiB，余量 204.8 GiB）");
let worst = 0, at = "";
for (const prior of [700, 750, 780, 800, 810, 815, 818]) {
  for (const p of PHASES) {
    const r = await noGate({ burstBps: 1 * GBPS, baselineBps: 2 * MBPS, priorUsedBytes: prior * GIB,
                             burstStartIso: iso(p), horizonHours: 400 });
    const extra = r.trueUsedGibAtStop - 819.2;
    if (extra > worst) { worst = extra; at = `起点 ${prior} GiB, 相位 +${p}s`; }
  }
}
console.log(`  实测最坏：越线后再烧 ${worst.toFixed(1)} GiB (${at})`);
console.log(`  解析上界：速率 × (延迟600 + 桶余量≤300 + cron≤600 + 停机60) = ${(1 * GBPS * 1560 / GIB).toFixed(1)} GiB`);
console.log(`  余量 204.8 GiB —— ${worst < 204.8 ? "吃得下（结论成立）" : "吃不下"}`);
