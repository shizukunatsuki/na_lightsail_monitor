// 实验 E：核对代码注释里的闭式解。
//   声称：跳闸时剩余 runway = t_exh × H/(H+W−L)，「与速率无关」
//   另一式：runway = (t_exh − L) × H/(H+W−L)
import { GIB } from "./harness.mjs";
const MBPS = 1e6 / 8, H = 3600, L = 600;
const THRESH = 1;              // 关掉静态线，只让突发闸门说话（THRESHOLD=1 => 线 = 配额）
for (const W of [1800, 3600]) {
  const { simulate } = await import(`./harness-w${W}.mjs`);
  console.log(`\n=== W=${W / 60} 分钟, H=${H / 60} 分钟, L=${L / 60} 分钟, THRESHOLD=1 (静态线让位) ===`);
  console.log("速率        t_exh      实测跳闸    实测余量   进度%   预测A t*H/(H+W-L)  预测B (t-L)*H/(H+W-L)");
  for (const m of [500, 1000, 2000, 3000, 5000, 8000]) {
    const R = m * MBPS;
    const r = await simulate({ burstBps: R, baselineBps: 2 * MBPS, priorUsedBytes: 0,
                              threshold: THRESH, horizonHours: 400 });
    if (!r.stopped || !/burning/.test(r.stopReason)) { console.log(`${m} Mbps: 闸门未跳（${r.stopReason?.slice(0, 60)}）`); continue; }
    const tExh = (1024 * GIB) / R;
    const trip = r.stopIssuedAt - Date.parse("2026-08-15T12:00:00Z") / 1000;
    const runway = tExh - trip;
    const A = tExh * H / (H + W - L), B = (tExh - L) * H / (H + W - L);
    console.log(
      `${(m + " Mbps").padEnd(11)}${tExh.toFixed(0).padStart(7)}s${trip.toFixed(0).padStart(11)}s` +
      `${runway.toFixed(0).padStart(11)}s${(100 * trip / tExh).toFixed(0).padStart(7)}%` +
      `${A.toFixed(0).padStart(15)}s${B.toFixed(0).padStart(19)}s`);
  }
}
