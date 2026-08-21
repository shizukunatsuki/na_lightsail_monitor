// 调参常量之间的关系检查。
//
// 这些数不是各自独立的：cron 间隔、反应视野、观察窗口、延迟容忍上限彼此约束。改了 cron
// 却忘了视野，或者改了视野却忘了告警门槛，代码照样跑、测试照样绿，只是防线悄悄变薄 ——
// 本项目真的这样错过一次：cron 从两分钟放宽到十分钟后，延迟告警的门槛还挂在观察窗口上，
// 于是它从「提前五分钟报警」变成了「迟到四分钟」。
//
// cron 写在 wrangler.jsonc 里、常量写在 src/index.js 里，跨文件的耦合最容易失修，所以
// 这个文件把两边直接读进来一起验。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BURST_WINDOW_SECONDS,
  BURST_PERIOD_SECONDS,
  REACTION_HORIZON_SECONDS,
  MAX_TOLERABLE_LAG_SECONDS,
  METRIC_PERIOD_SECONDS,
} from "../src/index.js";

/** 设计假设：指标落库延迟按 10 分钟的悲观值取。日志里的 `meter ... behind` 就是用来校准它的。 */
const ASSUMED_LAG_SECONDS = 600;

/** 桶必须先关闭才可能被查到，最坏是一整个粒度。 */
const BUCKET_CLOSE_SECONDS = BURST_PERIOD_SECONDS;

/** StopInstance 发出到真正断流。 */
const STOP_PROPAGATION_SECONDS = 60;

function cronIntervalSeconds() {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const crons = config.match(/"crons"\s*:\s*\[\s*"([^"]+)"/);
  assert.ok(crons, "wrangler.jsonc 里找不到 crons");
  const every = crons[1].match(/^\*\/(\d+) \* \* \* \*$/);
  assert.ok(every, `只支持 "*/N * * * *" 形式的 cron，实际是 ${crons[1]}`);
  return Number(every[1]) * 60;
}

test("the reaction horizon covers the whole detection loop with margin", () => {
  const loop =
    BUCKET_CLOSE_SECONDS + ASSUMED_LAG_SECONDS + cronIntervalSeconds() + STOP_PROPAGATION_SECONDS;
  const margin = REACTION_HORIZON_SECONDS / loop;

  assert.ok(
    margin >= 2,
    `反应视野 ${REACTION_HORIZON_SECONDS / 60} 分钟对 ${loop / 60} 分钟的检测回路只有 ` +
      `${margin.toFixed(2)} 倍余量，不足 2 倍。改了 cron 就要同步调整 REACTION_HORIZON_SECONDS。`,
  );
});

test("the lag alarm fires before the burst gate stops being able to keep up", () => {
  // 告警必须挂在**检测回路**上（及时性），不能挂在观察窗口上（分辨率）—— 两者会在改
  // cron 时朝不同方向走。这里的判据是：延迟容忍上限必须严格小于「视野减去回路里除延迟
  // 之外的部分」，也就是延迟吃光余量之前就得响。
  const fixedLoop = BUCKET_CLOSE_SECONDS + cronIntervalSeconds() + STOP_PROPAGATION_SECONDS;
  const lagBudget = REACTION_HORIZON_SECONDS / 2 - fixedLoop;

  assert.ok(
    MAX_TOLERABLE_LAG_SECONDS <= lagBudget,
    `延迟容忍 ${MAX_TOLERABLE_LAG_SECONDS / 60} 分钟已经超过预算 ${(lagBudget / 60).toFixed(1)} 分钟，` +
      `告警会迟于设计失效。`,
  );
});

test("the alarm also fires before the rate estimate loses resolution", () => {
  // 分辨率那一侧：延迟吃掉窗口后凑不出两个数据点，速率估计失去意义。告警同样要更早。
  const resolutionLimit = BURST_WINDOW_SECONDS - 2 * BURST_PERIOD_SECONDS;
  assert.ok(
    MAX_TOLERABLE_LAG_SECONDS <= resolutionLimit,
    `延迟容忍 ${MAX_TOLERABLE_LAG_SECONDS / 60} 分钟晚于分辨率失效点 ${resolutionLimit / 60} 分钟`,
  );
});

test("the burst window stays wide enough to survive the tolerated lag", () => {
  // 窗口整个落进落库延迟的阴影里就一个数据点都取不到，闸门直接失效。
  const usableBuckets = Math.floor((BURST_WINDOW_SECONDS - MAX_TOLERABLE_LAG_SECONDS) / BURST_PERIOD_SECONDS);
  assert.ok(usableBuckets >= 2, `容忍上限的延迟下只剩 ${usableBuckets} 个数据点，不足两个`);
});

test("both metric queries stay inside what the API accepts", () => {
  // period 必须是 60 的倍数，范围 60–86400。
  for (const period of [METRIC_PERIOD_SECONDS, BURST_PERIOD_SECONDS]) {
    assert.equal(period % 60, 0, `period ${period} 不是 60 的倍数`);
    assert.ok(period >= 60 && period <= 86400, `period ${period} 超出 60–86400`);
  }
  // 300 秒是 Lightsail 的原生上报粒度，突发窗口取得再细也不会有更多信息。
  assert.equal(BURST_PERIOD_SECONDS, 300);
});
