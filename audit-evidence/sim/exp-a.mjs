// 实验 A：突发闸门到底改变了什么？同一场突发，跑「有闸门」和「无闸门」两遍。
import { simulate, GIB } from "./harness.mjs";
import { simulate as simulateNoGate } from "./harness-nogate.mjs";
const MBPS = 1e6 / 8, GBPS = 1e9 / 8;
const BASE = 2 * MBPS;               // 个人站底噪，保证每个 5 分钟桶都有数据点

const rates = [
  ["50 Mbps", 50 * MBPS], ["100 Mbps", 100 * MBPS], ["250 Mbps", 250 * MBPS],
  ["500 Mbps", 500 * MBPS], ["1 Gbps", 1 * GBPS], ["2 Gbps", 2 * GBPS],
  ["5 Gbps", 5 * GBPS], ["10 Gbps", 10 * GBPS],
];
for (const prior of [0, 400, 700, 800]) {
  console.log(`\n=== 突发开始时月初至今 ${prior} GiB（配额 1024，静态线 819.2）  延迟 L=10 min ===`);
  console.log("速率        闸门跳?  停机理由        断流时真实用量   超配额     无闸门时用量   闸门省下");
  for (const [name, R] of rates) {
    const opts = { burstBps: R, baselineBps: BASE, priorUsedBytes: prior * GIB, horizonHours: 240 };
    const g = await simulate(opts);
    const n = await simulateNoGate(opts);
    const why = !g.stopped ? "未停机" : /burning/.test(g.stopReason) ? "突发闸门" : "静态线";
    const saved = n.trueUsedGibAtStop - g.trueUsedGibAtStop;
    console.log(
      `${name.padEnd(11)} ${(why === "突发闸门" ? "是" : "否").padEnd(7)} ${why.padEnd(15)}` +
      `${g.trueUsedGibAtStop.toFixed(1).padStart(9)} GiB ${g.overshootGib.toFixed(1).padStart(9)}` +
      `${n.trueUsedGibAtStop.toFixed(1).padStart(14)} GiB ${saved.toFixed(1).padStart(9)} GiB`,
    );
  }
}
