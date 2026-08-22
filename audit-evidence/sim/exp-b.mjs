// 实验 B：在整个（速率 × 月初至今）空间上找最坏超额，比较三种配置。
import { simulate, GIB } from "./harness.mjs";
import { simulate as noGate } from "./harness-nogate.mjs";
const MBPS = 1e6 / 8;
const BASE = 2 * MBPS;
const rates = [];
for (let mbps = 25; mbps <= 12800; mbps *= Math.SQRT2) rates.push(Math.round(mbps));
const priors = [0, 100, 200, 300, 400, 500, 600, 700, 750, 800, 815];

async function worst(sim, threshold) {
  let worstOver = -Infinity, at = null;
  const trips = [];
  for (const prior of priors) {
    if (prior >= 1024 * threshold) continue;         // 已经越线，不是突发场景
    for (const mbps of rates) {
      const r = await sim({ burstBps: mbps * MBPS, baselineBps: BASE, priorUsedBytes: prior * GIB,
                            threshold, horizonHours: 400 });
      if (r.overshootGib > worstOver) { worstOver = r.overshootGib; at = `${mbps} Mbps @ ${prior} GiB`; }
      if (r.stopped && /burning/.test(r.stopReason)) trips.push(`${mbps}@${prior}`);
    }
  }
  return { worstOver, at, trips };
}

const a = await worst(simulate, 0.8);
console.log(`THRESHOLD=0.8 + 突发闸门 :  最坏超额 ${a.worstOver.toFixed(1)} GiB  (${a.at})   闸门跳闸 ${a.trips.length} 次`);
const b = await noGate(undefined) ?? null;
const c = await worst(noGate, 0.8);
console.log(`THRESHOLD=0.8 无闸门     :  最坏超额 ${c.worstOver.toFixed(1)} GiB  (${c.at})`);
for (const t of [0.6, 0.5, 0.4]) {
  const d = await worst(noGate, t);
  console.log(`THRESHOLD=${t} 无闸门     :  最坏超额 ${d.worstOver.toFixed(1)} GiB  (${d.at})`);
}
