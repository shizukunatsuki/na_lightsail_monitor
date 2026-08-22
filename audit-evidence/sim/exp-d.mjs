// 实验 D：有限的合法大传输会不会被误停？这才是「不希望被过早停机」的现实场景。
import { simulate, GIB } from "./harness.mjs";
const MBPS = 1e6 / 8, BASE = 2 * MBPS;
console.log("一次性传输 N GiB，之后回到底噪。× = 被闸门掐断（误停）\n");
const sizes = [10, 25, 50, 100, 200, 400];
const rates = [100, 250, 500, 1000, 2000, 5000];
for (const prior of [0, 400, 700]) {
  console.log(`--- 月初至今 ${prior} GiB ---`);
  process.stdout.write("传输量\\速率 ".padEnd(13));
  for (const m of rates) process.stdout.write(`${m} Mbps`.padStart(11));
  console.log();
  for (const gib of sizes) {
    process.stdout.write(`${gib} GiB`.padEnd(13));
    for (const m of rates) {
      const bps = m * MBPS;
      const r = await simulate({ burstBps: bps, baselineBps: BASE, burstDurationS: (gib * GIB) / bps,
                                priorUsedBytes: prior * GIB, horizonHours: 400 });
      const gate = r.stopped && /burning/.test(r.stopReason);
      const stat = r.stopped && !gate;
      process.stdout.write((gate ? "×误停" : stat ? "静态线" : "放行").padStart(10) + " ");
    }
    console.log();
  }
  console.log();
}
