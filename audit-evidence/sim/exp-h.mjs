// 实验 H：核对 README「上游 API → 精度与延迟」那张暴露量表，以及「1 Gbps 越线后最坏再烧约 164 GiB」。
import { simulate, GIB } from "./harness.mjs";
import { simulate as noGate } from "./harness-nogate.mjs";
const GBPS = 1e9 / 8, MBPS = 1e6 / 8;

console.log("README 表：从空表开始的 5 Gbps 突发，额度 1024 GiB，视野 60 分钟");
console.log("（README 的「烧掉」= 断流时的总用量）\n");
console.log("  L      README只静态线  实测只静态线   README加闸门   实测加闸门    README桶数  实测桶数");
const readme = { 5: [1465, 809, 5], 10: [1640, 902, 4], 15: [1815, 1008, 3],
                 20: [1989, 1129, 2], 25: [2164, 1269, 1], 30: [2338, 2338, 0] };
for (const min of [5, 10, 15, 20, 25, 30]) {
  const o = { burstBps: 5 * GBPS, baselineBps: 2 * MBPS, priorUsedBytes: 0, lag: min * 60, horizonHours: 400 };
  const g = await simulate(o), n = await noGate(o);
  const pts = /now /.test(g.logs.join("")) ? Math.max(0, Math.floor((1800 - min * 60) / 300)) : 0;
  const [rn, rg, rp] = readme[min];
  const f = (a, b) => `${b.toFixed(0)}`.padStart(9) + (Math.abs(a - b) / Math.max(a, 1) > 0.08 ? " ××" : "   ");
  console.log(`${String(min).padStart(3)}min ${String(rn).padStart(11)}${f(rn, n.trueUsedGibAtStop)}` +
              `${String(rg).padStart(12)}${f(rg, g.trueUsedGibAtStop)}${String(rp).padStart(9)}${String(pts).padStart(10)}`);
}

console.log("\n\nREADME:「1 Gbps 时越线后最坏再烧约 164 GiB，204.8 GiB 的余量吃得下」");
for (const m of [1000]) {
  for (const prior of [700, 750, 800, 815]) {
    const r = await noGate({ burstBps: m * MBPS, baselineBps: 2 * MBPS, priorUsedBytes: prior * GIB, horizonHours: 400 });
    console.log(`  1 Gbps 从 ${prior} GiB 起：断流于 ${r.trueUsedGibAtStop.toFixed(1)} GiB，` +
                `越过静态线之后又烧了 ${(r.trueUsedGibAtStop - 819.2).toFixed(1)} GiB`);
  }
}
console.log("\n临界延迟：5 Gbps 从空表开始，L 到多少时闸门就守不住配额了？");
for (const min of [10, 12, 14, 16, 18, 20]) {
  const g = await simulate({ burstBps: 5 * GBPS, baselineBps: 2 * MBPS, priorUsedBytes: 0, lag: min * 60, horizonHours: 400 });
  console.log(`  L=${String(min).padStart(2)} min -> 断流于 ${g.trueUsedGibAtStop.toFixed(0)} GiB  ${g.trueUsedGibAtStop > 1024 ? "×× 已超额" : "未超额"}`);
}
