// 实验 F：推一个新的闭式解，然后用模拟器检验它 —— 不检验就只是换一个没人核过的公式。
//
// 模型：可见窗口 = [T−W, T−λ]（长 V = W−λ）；λ = 有效可见延迟。
//   rate_est = R·min(T−λ, V)/V ；可见剩余 = Q−U₀−R(T−λ)
//   跳闸条件 remaining < H·rate_est
//   情形 1（T ≥ W，速率不再被稀释）: 跳闸 T = t_exh + λ − H  =>  余量 = H − λ   （与 R、W 无关）
//   情形 2（T < W，仍在稀释区）    : 跳闸 T = λ + (W−λ)·t_exh/(H+W−λ)
// 再对 cron 向上取整。
import { GIB } from "./harness.mjs";
const MBPS = 1e6 / 8;
const H = 3600, LAG = 600, CRON = 600, Q = 1024 * GIB;

function predictTrip(R, W, U0 = 0) {
  const tExh = (Q - U0) / R;
  const lam = LAG;                       // cron 格与 300 对齐时有效延迟正好是 LAG
  const V = W - lam;
  let T = lam + V * tExh / (H + V);      // 情形 2
  if (T >= W) T = tExh + lam - H;        // 情形 1
  return Math.max(0, Math.ceil(T / CRON) * CRON);
}

let bad = 0;
for (const W of [1800, 3600]) {
  const { simulate } = await import(`./harness-w${W}.mjs`);
  console.log(`\nW=${W / 60}min   速率      实测跳闸   预测跳闸   实测余量   新式预测余量   旧注释预测余量`);
  for (const m of [500, 750, 1000, 1500, 2000, 3000, 5000, 8000]) {
    const R = m * MBPS;
    const r = await simulate({ burstBps: R, baselineBps: 2 * MBPS, priorUsedBytes: 0, threshold: 1, horizonHours: 400 });
    if (!r.stopped || !/burning/.test(r.stopReason)) { console.log(`  ${m} Mbps: 闸门未跳`); continue; }
    const tExh = Q / R;
    const trip = r.stopIssuedAt - Date.parse("2026-08-15T12:00:00Z") / 1000;
    const pred = predictTrip(R, W);
    const old = (tExh - LAG) * H / (H + W - LAG);
    const ok = Math.abs(pred - trip) <= CRON / 2;
    if (!ok) bad++;
    console.log(`  ${ok ? "OK " : "×× "}${(m + " Mbps").padEnd(10)}${trip.toFixed(0).padStart(8)}s` +
      `${pred.toFixed(0).padStart(10)}s${(tExh - trip).toFixed(0).padStart(11)}s` +
      `${(tExh - pred).toFixed(0).padStart(14)}s${old.toFixed(0).padStart(16)}s`);
  }
}
console.log(bad === 0 ? "\n新闭式解与模拟完全一致（误差 < 半个 cron 格）" : `\n新闭式解有 ${bad} 处对不上`);
