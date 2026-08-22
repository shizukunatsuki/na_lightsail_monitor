// 实验 J：真正的「临界落库延迟」在哪？扫 cron 相位，统计守不住配额的比例。
import { simulate, GIB } from "./harness.mjs";
const GBPS = 1e9 / 8, MBPS = 1e6 / 8;
const PH = []; for (let s = 0; s < 600; s += 50) PH.push(s);
const iso = (s) => new Date(Date.parse("2026-08-15T12:00:00Z") + s * 1000).toISOString();
console.log("5 Gbps 从空表开始（README 用的就是这个算例），额度 1024 GiB\n");
console.log("  L(min)   守不住配额的相位比例   最好情形   最坏情形   BLIND 会响?");
for (let min = 6; min <= 22; min += 2) {
  const v = []; let blind = false;
  for (const p of PH) {
    const r = await simulate({ burstBps: 5 * GBPS, baselineBps: 2 * MBPS, priorUsedBytes: 0,
                               lag: min * 60, burstStartIso: iso(p), horizonHours: 400 });
    v.push(r.trueUsedGibAtStop);
    if (r.logs.some((l) => / BLIND \|/.test(l))) blind = true;
  }
  const over = v.filter((x) => x > 1024).length / v.length;
  console.log(`   ${String(min).padStart(2)}      ${(over * 100).toFixed(0).padStart(3)}%` +
    `${Math.min(...v).toFixed(0).padStart(18)} GiB${Math.max(...v).toFixed(0).padStart(11)} GiB      ${blind ? "是" : "否 ←"}`);
}
