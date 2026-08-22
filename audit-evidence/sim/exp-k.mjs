// 实验 K：把速率上限收到文档允许的 5 Gbps（2023-06-29 之后创建的实例），重算最坏超额。
import { simulate, GIB } from "./harness.mjs";
import { simulate as noGate } from "./harness-nogate.mjs";
const MBPS = 1e6 / 8, BASE = 2 * MBPS;
const rates = []; for (let m = 25; m <= 5000; m *= Math.SQRT2) rates.push(Math.round(m));
rates.push(5000);
const priors = [0, 100, 200, 300, 400, 500, 600, 700, 750, 800, 815];
const PH = [0, 150, 300, 450];
const iso = (s) => new Date(Date.parse("2026-08-15T12:00:00Z") + s * 1000).toISOString();
async function worst(sim, threshold) {
  let w = -Infinity, at = "";
  for (const prior of priors) { if (prior >= 1024 * threshold) continue;
    for (const m of rates) for (const p of PH) {
      const r = await sim({ burstBps: m * MBPS, baselineBps: BASE, priorUsedBytes: prior * GIB,
                            threshold, burstStartIso: iso(p), horizonHours: 400 });
      if (r.overshootGib > w) { w = r.overshootGib; at = `${m} Mbps @ ${prior} GiB, 相位 +${p}s`; }
    } }
  return { w, at };
}
const a = await worst(simulate, 0.8), b = await worst(noGate, 0.8);
console.log(`速率上限 5 Gbps，扫 cron 相位：`);
console.log(`  THRESHOLD=0.8 + 闸门 : 最坏超额 ${a.w.toFixed(1)} GiB   (${a.at})`);
console.log(`  THRESHOLD=0.8 无闸门 : 最坏超额 ${b.w.toFixed(1)} GiB   (${b.at})`);
for (const t of [0.7, 0.6, 0.5]) {
  const c = await worst(noGate, t);
  console.log(`  THRESHOLD=${t} 无闸门 : 最坏超额 ${c.w.toFixed(1)} GiB   (${c.at})`);
  const d = await worst(simulate, t);
  console.log(`  THRESHOLD=${t} + 闸门 : 最坏超额 ${d.w.toFixed(1)} GiB   (${d.at})`);
}
