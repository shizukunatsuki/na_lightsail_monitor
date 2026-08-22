// 实验 G：落库延迟扫描。BLIND 告警到底在哪一段有效？延迟大到什么程度闸门会静默失效？
import { simulate, GIB } from "./harness.mjs";
const MBPS = 1e6 / 8, GBPS = 1e9 / 8;
console.log("突发 2 Gbps，月初至今 300 GiB（离静态线 519 GiB），扫描落库延迟 L\n");
console.log("L(min)  BLIND告警?  日志里的 meter 字段     闸门跳?  断流真实用量  超配额   OK 行速率字段");
for (const min of [5, 10, 12, 15, 20, 24, 25, 26, 30, 40, 60]) {
  const r = await simulate({ burstBps: 2 * GBPS, baselineBps: 2 * MBPS, priorUsedBytes: 300 * GIB,
                             lag: min * 60, horizonHours: 400 });
  const blind = r.logs.some((l) => / BLIND \|/.test(l));
  const meterLine = r.logs.filter((l) => /meter /.test(l)).at(-1);
  const meter = meterLine ? (/meter ([\d.]+) min behind/.exec(meterLine)?.[1] ?? "-") + " min" : "（无该字段）";
  const rateField = /now ([^,|]+),/.exec(r.logs.filter((l) => / OK \|/.test(l)).at(-1) ?? "")?.[1] ?? "-";
  const gate = r.stopped && /burning/.test(r.stopReason);
  console.log(
    `${String(min).padStart(4)}   ${(blind ? "是" : "否 ←").padEnd(9)} ${meter.padEnd(22)}` +
    `${(gate ? "是" : "否").padEnd(8)}${r.trueUsedGibAtStop.toFixed(0).padStart(9)} GiB${r.overshootGib.toFixed(0).padStart(8)}   ${rateField}`);
}
