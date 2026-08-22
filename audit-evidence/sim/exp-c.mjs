// 实验 C：把闸门的收益和代价分开数。
import { simulate, GIB } from "./harness.mjs";
import { simulate as noGate } from "./harness-nogate.mjs";
const MBPS = 1e6 / 8, BASE = 2 * MBPS;
const rates = []; for (let m = 25; m <= 12800; m *= Math.SQRT2) rates.push(Math.round(m));
const priors = [0, 100, 200, 300, 400, 500, 600, 700, 750, 800, 815];

let helped = 0, helpedGib = 0, prematureStop = 0, prematureGib = 0, noEffect = 0, bothOver = 0, total = 0;
const helpRows = [], prematureRows = [];
for (const prior of priors) for (const m of rates) {
  const o = { burstBps: m * MBPS, baselineBps: BASE, priorUsedBytes: prior * GIB, horizonHours: 400 };
  const g = await simulate(o), n = await noGate(o);
  total++;
  const gateFired = g.stopped && /burning/.test(g.stopReason);
  if (!gateFired) { noEffect++; continue; }
  if (n.overshootGib <= 0) {                  // 没有闸门也不会超额 —— 这次停机是多余的
    prematureStop++; prematureGib += n.trueUsedGibAtStop - g.trueUsedGibAtStop;
    prematureRows.push(`${m} Mbps @ ${prior} GiB: 提前 ${(n.trueUsedGibAtStop - g.trueUsedGibAtStop).toFixed(0)} GiB 掐断（无闸门也只到 ${n.trueUsedGibAtStop.toFixed(0)}/1024）`);
  } else if (g.overshootGib <= 0) {           // 闸门把一次真实超额挡下来了
    helped++; helpedGib += n.overshootGib;
    helpRows.push(`${m} Mbps @ ${prior} GiB: 避免 ${n.overshootGib.toFixed(0)} GiB 超额`);
  } else { bothOver++; }
}
console.log(`网格 ${total} 格（${rates.length} 速率 × ${priors.length} 起始用量）`);
console.log(`  闸门没跳（结果与无闸门完全一致）: ${noEffect}`);
console.log(`  闸门跳了，且真的挡下了超额      : ${helped}   共避免 ${helpedGib.toFixed(0)} GiB`);
console.log(`  闸门跳了，但本来就不会超额      : ${prematureStop}   共提前掐断 ${prematureGib.toFixed(0)} GiB 的合法传输`);
console.log(`  闸门跳了，但仍然超额            : ${bothOver}`);
console.log("\n真正挡下超额的格子：");           helpRows.forEach((r) => console.log("   " + r));
console.log("\n多余停机的格子（前 12 条）：");   prematureRows.slice(0, 12).forEach((r) => console.log("   " + r));
