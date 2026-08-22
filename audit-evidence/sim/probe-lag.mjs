// 再加一层模拟器自检：被审代码实测出来的落库延迟，必须与我注入的 L 一致。
// 对不上就说明我的指标夹具跟代码对时间戳的理解不同，后面所有结论都不可信。
import { simulate } from "./harness.mjs";
const MBPS = 1e6 / 8;
for (const lag of [0, 120, 300, 600, 900]) {
  const r = await simulate({ burstBps: 0, baselineBps: 5 * MBPS, priorUsedBytes: 100 * (1024 ** 3), lag, horizonHours: 0.5 });
  const line = r.logs.filter((l) => / OK \|/.test(l)).at(-1) ?? r.logs.at(-1);
  const m = /meter ([\d.]+) min behind/.exec(line ?? "");
  const measured = m ? Number(m[1]) * 60 : null;
  // 代码量的是「此刻 − 最新桶结束时刻」，因为桶按 300 对齐，实测值落在 [L, L+300)
  const ok = measured !== null && measured >= lag && measured < lag + 300;
  console.log(`${ok ? "PASS" : "FAIL"}  注入 L=${lag}s -> 代码实测 ${measured}s   期望 [${lag}, ${lag + 300})`);
}
