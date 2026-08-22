// 模拟器自检：先证明这个模拟器本身不瞎报、也不漏报，再拿它去测被审代码。
import { simulate, GIB } from "./harness.mjs";
const MBPS = 1e6 / 8, GBPS = 1e9 / 8;
let bad = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) bad++;
};

// 对照组 1：完全没有流量 —— 绝不能停机。
{
  const r = await simulate({ burstBps: 0, baselineBps: 0, priorUsedBytes: 0, horizonHours: 6 });
  check("对照组：零流量不停机", !r.stopped, r.stopReason ?? "");
}
// 对照组 2：温和流量、用量远低于线 —— 绝不能停机。
{
  const r = await simulate({ burstBps: 5 * MBPS, baselineBps: 1 * MBPS, priorUsedBytes: 100 * GIB, horizonHours: 12 });
  check("对照组：5 Mbps + 100 GiB 已用，不停机", !r.stopped, r.stopReason ?? "");
}
// 反向用例 1：用量已经越过静态线 —— 第一格就必须停。
{
  const r = await simulate({ burstBps: 1 * MBPS, priorUsedBytes: 900 * GIB, horizonHours: 2 });
  check("反向：900 GiB 已越静态线，必须停", r.stopped && /over the .* stop threshold/.test(r.stopReason ?? ""),
        r.stopReason ?? "");
}
// 反向用例 2：明确的高速突发 —— 必须停，且停在配额之前。
{
  const r = await simulate({ burstBps: 1 * GBPS, priorUsedBytes: 700 * GIB, horizonHours: 6 });
  check("反向：1 Gbps 突发必须停", r.stopped, r.stopReason ?? "");
  check("反向：1 Gbps 突发停在配额之前", r.overshootGib < 0, `实际用到 ${r.trueUsedGibAtStop.toFixed(1)} GiB`);
}
// 自检 3：把延迟/cron/传播都归零，静态线的超冲应当趋近于零。
{
  const r = await simulate({ burstBps: 10 * MBPS, priorUsedBytes: 800 * GIB, lag: 0, cron: 60, stopProp: 0, horizonHours: 6 });
  const expectStopGib = 1024 * 0.8;
  check("自检：无延迟时静态线几乎不超冲",
        r.trueUsedGibAtStop >= expectStopGib && r.trueUsedGibAtStop < expectStopGib + 1,
        `停在 ${r.trueUsedGibAtStop.toFixed(3)} GiB（线在 ${expectStopGib}）`);
}
// 自检 4：静态线的超冲量应当 ≈ 速率 ×（延迟 + 桶关闭 + cron + 传播），量级对得上即可。
{
  const R = 20 * MBPS;
  const r = await simulate({ burstBps: R, priorUsedBytes: 800 * GIB, lag: 600, cron: 600, stopProp: 60, horizonHours: 6 });
  const detected = (r.trueUsedGibAtStop - 1024 * 0.8) * GIB / R; // 越线到断流的秒数
  check("自检：静态线检测滞后落在 [660, 1560] 秒（延迟+桶余量+cron+传播）",
        detected >= 660 && detected <= 1560, `实测 ${detected.toFixed(0)} 秒`);
}
console.log(bad === 0 ? "\n模拟器自检全部通过" : `\n模拟器自检有 ${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
