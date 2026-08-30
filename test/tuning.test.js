// 调参常量之间的关系检查。
//
// 这些数不是各自独立的：cron 间隔、反应视野、观察窗口、延迟容忍上限彼此约束。**改了
// 其中一个而忘了其余，代码照样跑、行为照样对、测试照样绿 —— 只是防线悄悄变薄，而且不会
// 有任何提示。** 典型形态：cron 从两分钟放宽到十分钟，而延迟告警的门槛仍挂在观察窗口上，
// 于是它从「提前五分钟报警」变成「迟到四分钟」。这个文件把这些关系钉成硬失败，就是为了
// 让那种改动过不了闸门。
//
// cron 写在 wrangler.jsonc 里、常量写在 src/tuning.js 里，跨文件的耦合最容易失修，所以
// 这个文件把两边直接读进来一起验。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ASSUMED_LAG_SECONDS,
  BUCKET_CLOSE_SECONDS,
  BURST_PERIOD_SECONDS,
  BURST_WINDOW_SECONDS,
  CRON_INTERVAL_SECONDS,
  DETECTION_LOOP_SECONDS,
  MAX_DATAPOINTS_PER_QUERY,
  MAX_TOLERABLE_LAG_SECONDS,
  METRIC_PERIOD_SECONDS,
  METRIC_UNIT,
  REACTION_HORIZON_SECONDS,
  STOP_PROPAGATION_SECONDS,
} from "../src/tuning.js";

function cronIntervalSeconds() {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const crons = config.match(/"crons"\s*:\s*\[\s*"([^"]+)"/);
  assert.ok(crons, "wrangler.jsonc 里找不到 crons");
  const every = crons[1].match(/^\*\/(\d+) \* \* \* \*$/);
  assert.ok(every, `只支持 "*/N * * * *" 形式的 cron，实际是 ${crons[1]}`);
  return Number(every[1]) * 60;
}

test("wrangler.jsonc is syntactically valid, and vars are the four we read", () => {
  // 这条守的是一个容易被漏掉的缺口：`wrangler.jsonc` 少一个逗号变成非法 JSON 时，如果
  // 没有这条用例，整套测试仍然全绿 —— 因为下面那个 cron 检查只用正则抓字符串，从不解析。
  // 那种配置会让 `wrangler deploy` 自己报错（响亮，不危险），但它意味着「部署前的测试
  // 闸门」不覆盖配置文件本身的合法性。既然部署是靠 `npm test` 挡下来的，这一层就得补上。
  //
  // JSONC 允许注释和尾逗号，JSON.parse 不允许，所以先剥掉再解析。剥法很朴素，够用即可：
  // 这个文件里没有内含 `//` 的字符串字面量（URL 都在注释里）。
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const stripped = raw.replace(/^\s*\/\/[^\n]*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  let config;
  assert.doesNotThrow(() => {
    config = JSON.parse(stripped);
  }, "wrangler.jsonc 不是合法 JSON —— 这样的配置会让 wrangler deploy 直接失败");

  // 部署侧变量必须与 readConfig 真正读取的那几项一一对应。多出来的键是死配置：设了不会
  // 有任何作用，却会让人以为自己打开了某个开关（例如已经删掉的「抑制启动」）。
  assert.deepEqual(
    Object.keys(config.vars).sort(),
    ["AWS_REGION", "INSTANCE_NAME", "QUOTA_GIB", "THRESHOLD"],
  );

  // 这个 Worker 只停机、不启动，公开路由也全部关掉。
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});

test("the declared cron interval matches wrangler.jsonc", () => {
  // CRON_INTERVAL_SECONDS 住在 src/tuning.js 里，只是一份**声明** —— 真身是
  // wrangler.jsonc 的 triggers.crons。所有视野和门槛都从那份声明推导，所以两边一旦
  // 走散，推导出来的每一个余量都是假的。这条把它们钉在一起。
  assert.equal(CRON_INTERVAL_SECONDS, cronIntervalSeconds());
});

test("the reaction horizon covers the whole detection loop with margin", () => {
  const loop = DETECTION_LOOP_SECONDS;
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
  const fixedLoop = BUCKET_CLOSE_SECONDS + CRON_INTERVAL_SECONDS + STOP_PROPAGATION_SECONDS;
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

test("the lag alarm's real trip point survives bucket quantisation", () => {
  // 延迟只能按整桶观测：日志读到的是「最新一个完整的桶结束了多久」，取值只能是
  // 0、300、600 … 而且总不小于真实延迟。所以门槛真正的跳变点，是它下面最近的那一档 ——
  // 门槛 720 秒意味着「真实延迟超过 600 秒就告警」，而不是超过 720。
  //
  // 这条差别必须朝安全的方向：真正跳变的那个真实延迟，仍要落在预算之内。
  const step = BURST_PERIOD_SECONDS;
  const trip = Math.floor((MAX_TOLERABLE_LAG_SECONDS - 1) / step) * step;
  const budget =
    REACTION_HORIZON_SECONDS / 2 - (BUCKET_CLOSE_SECONDS + CRON_INTERVAL_SECONDS + STOP_PROPAGATION_SECONDS);
  assert.ok(
    trip <= budget,
    `量化之后，真实延迟要到 ${trip / 60} 分钟才告警，已经超过 ${(budget / 60).toFixed(1)} 分钟的预算`,
  );
});

test("the burst window is a whole number of buckets", () => {
  // 不是整数倍时，窗口尾部会出现一个只覆盖了一部分 period 的桶，而它带回来的是整桶的
  // 字节。速率分母已经改成按实际覆盖秒数算，所以即便破坏这条也不会失守 —— 但没有理由
  // 先把它破坏掉，而且 `win N/M` 那个分母也只有在整数倍时才读得通。
  assert.equal(BURST_WINDOW_SECONDS % BURST_PERIOD_SECONDS, 0);
});

test("the requested metric unit is the one the byte maths assumes", () => {
  // unit 传错时 AWS 回 HTTP 200 + metricName 正确回显 + 空数组（2026-08-22 实测，
  // Bits / Count / Percent / Seconds / Megabytes 五种都是这个结果），响应侧完全无从分辨。
  // 整套换算都按字节做，所以这个值只能是 Bytes。
  assert.equal(METRIC_UNIT, "Bytes");
});

test("ASSUMED_LAG_SECONDS stays observable at the burst granularity", () => {
  // 设计假设的延迟必须大于一个桶：延迟只能按整桶观测，小于一个桶的假设值连一次观测都
  // 撑不满，日志里根本反映不出来。（真要在生产上看延迟的变化，读 `win` 而不是 `meter`
  // —— 理由见 src/tuning.js 里 ASSUMED_LAG_SECONDS 的说明。）
  assert.ok(ASSUMED_LAG_SECONDS >= BURST_PERIOD_SECONDS);
  assert.equal(DETECTION_LOOP_SECONDS,
    BUCKET_CLOSE_SECONDS + ASSUMED_LAG_SECONDS + CRON_INTERVAL_SECONDS + STOP_PROPAGATION_SECONDS);
});

test("both configured queries stay under the API's datapoint cap", () => {
  // 上限两次实测都是 1440。超限的表现两次实测不一致：2026-08-22 记录为 HTTP 200 + 空数组
  // （静默的 0 字节），2026-08-30 复测为 HTTP 400 InvalidInputException（响亮失败）。所以
  // 这条不是性能优化，是防止整个看门狗在「静默空」那种形态下无声失效 —— 见 src/tuning.js
  // 里 MAX_DATAPOINTS_PER_QUERY 的完整记录。
  //
  // 月度查询按最长的月份（31 天）算最坏情况。
  const monthWorstCase = Math.ceil((31 * 86400) / METRIC_PERIOD_SECONDS);
  assert.ok(
    monthWorstCase <= MAX_DATAPOINTS_PER_QUERY,
    `月度查询最坏要 ${monthWorstCase} 个数据点，超过上限 ${MAX_DATAPOINTS_PER_QUERY}，会静默读到 0 字节`,
  );
  const burstPoints = Math.ceil(BURST_WINDOW_SECONDS / BURST_PERIOD_SECONDS);
  assert.ok(burstPoints <= MAX_DATAPOINTS_PER_QUERY, `突发查询要 ${burstPoints} 个数据点，超过上限`);
});
