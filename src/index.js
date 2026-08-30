/**
 * Lightsail 流量看门狗。
 *
 * AWS Lightsail 的套餐月流量额度用超之后按量计费且不封顶。这个 Worker 每 10 分钟量一次
 * 用量，在烧穿额度之前把实例停掉。
 *
 * **它只停机，永远不启动实例。** 停机之后实例会一直停着，直到操作者自己去启动 —— 跨月、
 * 额度重置都不会让它自动回来。这是刻意的：让看门狗有启动实例的能力，等于给「读数谎报为
 * 零」这一类故障配上一个会烧钱的动作。而 0 字节恰恰是这套系统里最容易被伪造出来的读数
 * （读不懂的响应、传错的 unit、超限的查询都会落在它上面），换来的只是省一次手动点击。
 * 对应地，它需要的 IAM 权限里**没有** `lightsail:StartInstance` —— 即便这里的判断写错，
 * AWS 那一侧也会拒绝。
 *
 * 两道叠加的防线：
 *   静态线   —— 月初至今的总量越过 `QUOTA_GIB × THRESHOLD` 就停。
 *   突发闸门 —— 按最近半小时的速率，剩余额度撑不过一个反应视野就停，不等静态线。
 *
 * 贯穿全篇的一条原则，读这个文件时请一直带着它：
 *
 *   **每一个不确定性都向「停」倾斜。**
 *
 * 两个方向的代价不对称：漏停是真金白银的账单，多停只是站点短暂下线。由此派生出一条
 * 反复出现的判据 —— **0 字节是唯一会让看门狗什么都不做的读数**，所以任何可能把读数
 * 折算成 0 的路径（读不懂的响应、坏掉的时间戳、超出上限的查询）都必须响亮地抛错或告警，
 * 绝不能安静地放行。
 *
 * 参数的推导、实测数据和取舍分析在 `src/tuning.js` 与 `README.md`；本文件的注释只说
 * 「这里的规则是什么、改成别的会怎样」。
 */

import { AwsClient } from "aws4fetch";

// 全部调参常量集中在 src/tuning.js —— 每个数的推导、实测出处和相互约束都写在那里。
// 本文件只 import，不就地定义，也不内联新的魔数：没有名字的数字既不会被复核，也没法
// 被 test/tuning.test.js 那样的关系检查引用。
import {
  API_TARGET,
  AWS_RETRIES,
  BURST_PERIOD_SECONDS,
  BURST_WINDOW_SECONDS,
  BYTES_PER_GIB,
  DURATION_CEILING_SECONDS,
  DURATION_HOURS_CUTOFF_SECONDS,
  MAX_QUOTA_GIB,
  MAX_DATAPOINTS_PER_QUERY,
  MAX_TIMESTAMP_SKEW_SECONDS,
  MAX_TOLERABLE_LAG_SECONDS,
  METRIC_PERIOD_SECONDS,
  METRIC_UNIT,
  MIN_WINDOW_SECONDS,
  MONTH_BEHIND_TOLERANCE_SECONDS,
  PLACEHOLDER,
  PROJECTION_MIN_ELAPSED,
  REACTION_HORIZON_SECONDS,
  ZERO_READING_GRACE_SECONDS,
} from "./tuning.js";

// ─────────────────────────────────────────────────────────────────────────────
// 一、共享判据
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 这个状态下计量表**应该**看得见流量。
 *
 * 跑着的实例几分钟内必然产生 DNS、NTP、后台扫描之类的字节（实测：整天 288/288 个
 * 300 秒桶，最小值约 77 KB），所以此时读不到数据只可能是量的那一侧出了问题。
 *
 * 状态读不出来（`null`）时**也算**「应该看得见」：宁可多喊一声，不要把一次真的失明
 * 藏进沉默里。
 *
 * **所有「计量表该不该看得见东西」的判断都必须走这个函数，不要就地再写一遍比较。**
 * 它管着六个问题，分布在五个调用点上（`warnIfHalfBlind` 一个调用点服务两个查询窗口）：
 *
 *   突发窗口零数据点 / 突发窗口只有一个方向有数据 / 数据旧过容忍上限
 *   月度读数只有一个方向有数据 / 月度读数没覆盖到今天 / 月度读数恰为零
 *
 * 它们问的是同一个问题，答案必须只有一个来源 —— 就地写 `=== "running"` 会把「状态读不
 * 出来」那一档悄悄吞掉，而那一档恰恰最需要说话。
 *
 * @param {string | null} state
 * @returns {boolean}
 */
const meterShouldSeeTraffic = (state) => state === "running" || state === null;

/**
 * 两个方向里**恰好一个**没有数据点时写一行 BLIND。
 *
 * 计量表半瞎：读到的字节少了一整个方向，而少报是唯一会让看门狗放行的方向。
 *
 * 这件事本身**不改变**任何计算 —— 缺席的那个方向贡献零，判断照常按另一侧进行。那是
 * 刻意的：缺一个方向不该让整道防线失效。要补的只是「说出来」，因为半瞎的计量表和完全
 * 正常的计量表在其余字段上长得一模一样。
 *
 * 两个方向都没有数据点时**不**走这里：那是另一回事（可能只是实例没在跑），各自的调用点
 * 有专门的处理。
 *
 * @param {Config} config
 * @param {{ points: number }} inMetric  NetworkIn 的读数
 * @param {{ points: number }} outMetric NetworkOut 的读数
 * @param {string | null} instanceState
 * @param {{ window: string, consequence: string }} wording 日志措辞：观察窗口，以及后果
 * @returns {void}
 */
function warnIfHalfBlind(config, inMetric, outMetric, instanceState, wording) {
  if (!meterShouldSeeTraffic(instanceState)) return;

  const dark =
    inMetric.points === 0 && outMetric.points > 0
      ? "NetworkIn"
      : outMetric.points === 0 && inMetric.points > 0
        ? "NetworkOut"
        : null;
  if (dark === null) return;

  console.error(
    `${config.label} BLIND | ${dark} has no data points in ${wording.window}` +
      ` while the other direction does | ${wording.consequence}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、配置
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} Config
 * @property {string} region
 * @property {string} instanceName
 * @property {string} label
 * @property {number} quotaGib
 * @property {number} threshold
 */

/**
 * 前置校验配置。任何缺失或无法解析的值都在发出任何 AWS 请求之前抛错。
 *
 * 校验不是洁癖：`Number("1,024")` 是 `NaN`，而与 `NaN` 的任何比较都是 `false`，于是
 * `used < limit` 恒为假、被读作「已超额」，实例会被立刻停掉。数值配置必须在第一次触发
 * 时大声失败，而不是套用某个静默的默认值继续跑。
 *
 * 两个密钥只检查是否存在，其值不离开这个函数。
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Config}
 */
export function readConfig(env) {
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "INSTANCE_NAME"]) {
    if (!env[name]) throw new Error(`Missing required binding ${name}`);
  }

  // 占位符是非空字符串，能骗过上面那道「必填项缺失」的检查，然后每次触发都在 Lightsail
  // 侧以 404 失败 —— 日志里每天几百条干巴巴的错误，很难让人立刻意识到「实例名压根没填」。
  //
  // 精确比较，不做前缀或大小写匹配：真有人的实例叫 `change_me_later`，那是别人正经的
  // 实例名，不能拦。
  for (const name of ["AWS_REGION", "INSTANCE_NAME"]) {
    if (env[name] === PLACEHOLDER) {
      throw new Error(`${name} is still the placeholder "${PLACEHOLDER}"; set it in wrangler.jsonc`);
    }
  }

  // 上界见 tuning.js 里 MAX_QUOTA_GIB 的说明：越过它之后 `quotaGib * BYTES_PER_GIB` 落到
  // Number 安全整数范围之外，字节比较开始丢精度，再大直接溢出成 Infinity —— 停机线变成
  // 一个永远够不到的数，看门狗看起来在跑、实际什么都不做。
  const quotaGib = Number(env.QUOTA_GIB);
  if (!Number.isFinite(quotaGib) || quotaGib <= 0 || quotaGib > MAX_QUOTA_GIB) {
    throw new Error(
      `QUOTA_GIB must be a positive number of at most ${Math.floor(MAX_QUOTA_GIB)}, got ${JSON.stringify(env.QUOTA_GIB)}`,
    );
  }

  // 上界卡在 1，是为了让「按百分比写成 80」在启动时就被拒绝。不拦的话它是 81,920 GiB 的
  // 停机线 —— 同样是一个永远够不到的上限。
  const threshold = Number(env.THRESHOLD);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error(`THRESHOLD must be a fraction in (0, 1], got ${JSON.stringify(env.THRESHOLD)}`);
  }

  return {
    region: env.AWS_REGION,
    instanceName: env.INSTANCE_NAME,
    // 每一行日志的前缀。带上 region 是因为实例名只在单个区域内唯一，而这是个公开仓库 ——
    // 谁复制过去都会得到一份自我说明的日志，不必回头去猜是哪个部署写的。
    label: `${env.INSTANCE_NAME}@${env.AWS_REGION}`,
    quotaGib,
    threshold,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 三、时间窗口与格式化
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `now` 所在 UTC 月份的第一个瞬间，单位为毫秒时间戳。
 *
 * 一律用 UTC：额度在每月 1 日 00:00 UTC 重置，这与任何本地时区的月份边界都不是同一个
 * 时刻。用 `getFullYear`/`getMonth` 推导的话，每个月在跨月前后各有最多一天会查错窗口。
 *
 * @param {Date} now
 * @returns {number}
 */
export function monthStartMs(now) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/**
 * `now` 在其所属 UTC 月份里已经走过的比例，落在 [0, 1]。
 *
 * 用来把「月初至今用了多少」换算成「照这个平均速度整月会用多少」。跨年由
 * `Date.UTC(y, 12, 1)` 自动处理，月份长度也由它算出，不需要闰年表。
 *
 * @param {Date} now
 * @returns {number}
 */
export function monthElapsedFraction(now) {
  const start = monthStartMs(now);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.min(1, Math.max(0, (now.getTime() - start) / (next - start)));
}

/**
 * 供 `GetInstanceMetricData` 使用的「月初至今」查询窗口，单位是 Unix **秒**
 * （Lightsail 这两个字段收的是数字，不是 ISO 字符串）。
 *
 * 结束时间至少比起始时间晚 `MIN_WINDOW_SECONDS`：新月份第一次触发时两者会重合，而宽度
 * 为零的区间会被 API 拒绝。
 *
 * @param {Date} now
 * @returns {{ startTime: number, endTime: number }}
 */
export function usageWindow(now) {
  const startTime = Math.floor(monthStartMs(now) / 1000);
  const endTime = Math.max(Math.floor(now.getTime() / 1000), startTime + MIN_WINDOW_SECONDS);
  return { startTime, endTime };
}

/**
 * 月度读数比「此刻」落后多少秒；读数没有可用时间戳时为 `null`。
 *
 * 最新那个天桶覆盖 [monthNewest, monthNewest + 一天)，而一个已经结束的天桶应当立刻可查，
 * 所以落后时长就是「此刻」减去那个桶的结束时刻。当天的桶还开着时会算出负数，那正表示
 * 读数覆盖到了今天。
 *
 * 不导出：它只有 `scheduled` 一个调用点，而那条路径已经被端到端用例完整覆盖。本仓库的
 * 约定是「导出必须有理由」——`formatDuration` 和 `sumMetric` 各自在文档里写明了为什么。
 *
 * @param {{ endTime: number }} range
 * @param {number} monthNewest 最新天桶的起点（Unix 秒），无可用时间戳时为 `-Infinity`
 * @returns {number | null}
 */
function monthBehindSeconds(range, monthNewest) {
  return Number.isFinite(monthNewest) ? range.endTime - (monthNewest + METRIC_PERIOD_SECONDS) : null;
}

/**
 * 人可读的时长。日志是给人扫的，不是给机器解析的。
 *
 * 导出只为了能直接做单元测试。它唯一的调用点只在 `secondsToQuota >= REACTION_HORIZON_SECONDS`
 * 时才写，所以视野是 60 分钟时「分钟」那个分支从 handler 那头永远走不到 —— 把视野调低时
 * 它又会活过来，**不要因为「当前配置下走不到」就删掉它**。
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "never";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < DURATION_HOURS_CUTOFF_SECONDS) return `${(seconds / 3600).toFixed(1)} h`;
  if (seconds > DURATION_CEILING_SECONDS) return "> 90 d";
  return `${(seconds / 86400).toFixed(1)} d`;
}

/** 人可读的速率。安静的实例在 Mbps 下会显示成 0.0，所以低速切到 kbps。 */
function formatRate(bytesPerSecond) {
  const bits = bytesPerSecond * 8;
  return bits >= 1e6 ? `${(bits / 1e6).toFixed(1)} Mbps` : `${(bits / 1e3).toFixed(0)} kbps`;
}

/** 每条日志里都出现的用量片段，让「137 GiB」这个数字自带参照系。 */
function formatUsage(config, usedGib) {
  const pct = (usedGib / config.quotaGib) * 100;
  return `used ${usedGib.toFixed(3)} GiB (${pct.toFixed(1)}% of ${config.quotaGib})`;
}

/** 日志里描述实例状态的那半句，读不出来时也要有话说。 */
function describeState(instanceState) {
  return instanceState === null ? "of unreadable state" : `"${instanceState}"`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 四、上游调用
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次带签名的 Lightsail JSON-RPC 调用。
 *
 * 任何非 2xx 都抛出，好让失败出现在 Workers 日志里 —— 一个静悄悄失效的看门狗比没有
 * 看门狗更糟。返回原始 Response，让调用方只解析自己真正需要的响应体。
 *
 * @param {AwsClient} client
 * @param {Config} config
 * @param {string} operation
 * @param {object} body
 * @returns {Promise<Response>}
 */
async function lightsail(client, config, operation, body) {
  const res = await client.fetch(`https://lightsail.${config.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      // 与多数 AWS JSON API 不同，Lightsail 的请求字段是小驼峰（`instanceName` 而不是
      // `InstanceName`）。写成大驼峰只会得到一个毫无提示意义的 400。
      "X-Amz-Target": `${API_TARGET}.${operation}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // 响应体会原样进入日志，所以**已知的每一个凭据**都要先抹掉，而不是只抹「我想得到
    // 会泄漏的那一个」。
    //
    // access key id 是必须的：SigV4 的拒绝响应会回显 credential scope，里面就嵌着它。
    // secret 按理不会被任何 AWS 响应回显 —— 但「按理不会」不是把它排除在外的理由。
    //
    // 用 `replaceAll` 而不是 `replace`：一个凭据在同一份响应里可能出现多次。
    // 先脱敏再截断：反过来的话，凭据正好横跨 500 字节边界时会残留半截。
    let detail = await res.text();
    for (const secret of [client.accessKeyId, client.secretAccessKey]) {
      if (secret) detail = detail.replaceAll(secret, "[redacted]");
    }
    throw new Error(`Lightsail ${operation} failed: HTTP ${res.status} ${detail.slice(0, 500)}`);
  }
  return res;
}

/**
 * 实例当前的状态名，例如 `"running"` / `"stopped"`。
 *
 * 响应无法识别时抛错，而不是返回 `undefined`。停机路径把「不是 running」当作无事可做，
 * 所以一个悄悄缺失的状态会被读成「什么都不用做」—— 而那正是漏停的方向。异常由调用方
 * 承接：见 `scheduled` 里那次调用的 `.catch`，它把读不出来记作 `null` 并写一行 DEGRADED，
 * 而 `stopOverLimit` 收到 `null` 时照停不误。
 *
 * @param {AwsClient} client
 * @param {Config} config
 * @returns {Promise<string>}
 */
async function getInstanceState(client, config) {
  const res = await lightsail(client, config, "GetInstanceState", {
    instanceName: config.instanceName,
  });
  const body = await res.json();
  const name = body?.state?.name;
  if (typeof name !== "string") {
    throw new Error(`GetInstanceState returned no state name for ${config.label}`);
  }
  return name;
}

/**
 * 单个指标在给定窗口内的总量，以及这份读数的可信度信息。
 *
 * 返回的每一项都有调用方在用，没有一项是调试信息：
 *
 * - `bytes`          窗口内的字节总量。
 * - `points`         实际落库的数据点个数。速率分母的**兜底**值（`points × period`），
 *                    在 `coveredSeconds` 拿不到时使用；同时也是「这个方向有没有数据」的
 *                    判据。
 * - `newest`         最新一个可用时间戳的桶起点（Unix 秒），用来实测落库延迟。AWS 从不
 *                    公开这个数，只说「随服务而变」，而整套余量标定都建立在它之上。
 * - `oldest`         最旧一个可用时间戳的桶起点，用来判断读数是不是从月初起算。
 * - `coveredSeconds` 窗口内被数据点真正覆盖到的秒数，速率分母的**首选**值；拿不到时为
 *                    `null`（判据见函数末尾）。
 *
 * 导出只为了能直接测那道数据点上限检查：当前两个查询离上限都很远，从 handler 那头根本
 * 走不到它，而它防的恰恰是「以后有人把粒度改小」。同 `formatDuration`。
 *
 * @param {AwsClient} client
 * @param {Config} config
 * @param {"NetworkIn" | "NetworkOut"} metricName
 * @param {{ startTime: number, endTime: number }} range
 * @param {number} period
 * @returns {Promise<{ bytes: number, points: number, newest: number | null,
 *   oldest: number | null, coveredSeconds: number | null }>}
 */
export async function sumMetric(client, config, metricName, range, period) {
  // 上游对单次查询的数据点数有硬上限 1440。超限时它怎么表现，两次实测给出**不同的答案**：
  //
  //   2026-08-22：HTTP 200、`metricName` 正常回显、`metricData` 空数组 —— 静默的 0 字节，
  //     唯一会让看门狗什么都不做的读数（当时 1440 个点拿回 1440 个，1441 / 2880 个拿回
  //     0 个）。
  //   2026-08-30：同样的构造（相位对齐后 1441 / 2880 / 2976 个桶，period 300 与 900 都试
  //     过）一律是 HTTP 400 `InvalidInputException`，错误消息明说 "requested number of
  //     datapoints exceeds the limit of 1,440"；恰好 1440 个的照常 200 + 1440 个点。
  //
  // 两条记录必有一条不反映当时上游的真实行为，而 08-22 已无法复现。守卫按「两种形态都
  // 可能出现」设计：在发请求**之前**就抛错 —— 400 的形态下省一次往返、错误也更清楚；
  // 静默空的形态下这道守卫是唯一防线。
  //
  // 当前两个查询离上限都很远（月度约 31 个点、突发 6 个），这道检查防的是**调参**：
  // 比如把 METRIC_PERIOD_SECONDS 从 86400 改成 900，月度查询就要 2976 个点。
  //
  // 按**桶的相位起点**算，不按窗口跨度算。桶的相位跟着查询走（见下面 coveredSeconds 处的
  // 实测），起点最多比 startTime 早 59 秒，于是相位数不小于跨度数、最多多一个桶。2026-08-30
  // 实测到一个分歧构造：起点 `% 60 = 59`、跨度恰好 1440 × 300 时，相位数是 1441 而上游回
  // 的是 200 + 1440 个点 —— 也就是说它（至少那一天）按跨度数。这里**仍然**按相位数：守卫
  // 最多比上游严一个桶、且只在两种数法分歧的边界上发生（生产两个查询的起点都对齐到分钟，
  // 两种数法在那里完全相等）；宁可这边响亮地多拦一次，也不把「上游按哪种数」当成一个需要
  // 赌对的假设 —— 关于超限行为的两次实测本身就对不上（见上面），没有理由认定这一条更稳。
  const gridStart = Math.floor(range.startTime / 60) * 60;
  const wanted = Math.ceil((range.endTime - gridStart) / period);
  if (wanted > MAX_DATAPOINTS_PER_QUERY) {
    throw new Error(
      `GetInstanceMetricData for ${metricName} would ask for ${wanted} data points,` +
        ` past the ${MAX_DATAPOINTS_PER_QUERY} the API refuses with HTTP 400 InvalidInputException` +
        ` (as measured 2026-08-30; an earlier 2026-08-22 measurement instead recorded a silent` +
        ` HTTP 200 with an empty array — assume either shape can come back)`,
    );
  }

  const res = await lightsail(client, config, "GetInstanceMetricData", {
    instanceName: config.instanceName,
    metricName,
    period,
    startTime: range.startTime,
    endTime: range.endTime,
    unit: METRIC_UNIT,
    statistics: ["Sum"],
  });

  const body = await res.json();
  const metricData = body?.metricData;

  // 读不懂的响应一律抛错，绝不折算成 0：指标侧一次降级就能让看门狗一边报平安、一边放任
  // 实例烧到超额。
  //
  // 但「读不懂」的判据**不能**挂在 `metricData` 存不存在上。AWS 的响应定义里它没有任何
  // 「必然出现」的保证，而各语言 SDK 一律把「字段缺失」正规化成空数组 —— 这恰恰说明
  // 服务端允许在没有数据时把它整个省掉。把合法的缺失当成错误，代价是致命的：一台停机的
  // 实例读到的正是这种空响应，于是每次触发都抛错 —— 整个看门狗在那台实例上彻底失效，
  // 而它本该在实例重新跑起来时继续守着。
  //
  // 判据挂在两个信号上，满足其一就认定这份响应是真的：
  //   - `metricName` 正确回显（有值的标量必然被序列化，不像空集合那样可省）；
  //   - 或者 `metricData` 确实是个数组。
  // 两个都没有，才是真的读不懂。而 `metricData` 存在却不是数组，无论如何都是坏的。
  if (metricData != null && !Array.isArray(metricData)) {
    throw new Error(
      `GetInstanceMetricData returned a non-array metricData for ${metricName}: ${JSON.stringify(metricData).slice(0, 80)}`,
    );
  }
  if (metricData == null && body?.metricName !== metricName) {
    throw new Error(
      `GetInstanceMetricData returned neither a metricData array nor a matching metricName for ${metricName}`,
    );
  }

  const points = metricData ?? [];

  // 累加而不是按下标取值：**数据点不保证有序**（AWS 明说 "Data points are not returned
  // in chronological order"）。求总量与顺序无关，所以累加天然是对的。
  //
  // 顺带澄清一个容易写错的理由：不是「因为可能有缺口」。实测一台跑着的实例 300 秒桶连续
  // 无缺口（整天 288/288），缺口在正常情况下根本不出现。
  let bytes = 0;
  let newest = null;
  let oldest = null;
  let coveredSeconds = 0;
  let timestamped = 0;

  for (const point of points) {
    if (point === null || typeof point !== "object") {
      throw new Error(`GetInstanceMetricData returned a non-object data point for ${metricName}`);
    }

    // `sum` 缺席**或显式为 null** 都按零算。这是一个明确的产品决定，不是隐式行为：
    // CloudWatch 家族的 Datapoint 各统计量字段本就可空，而「这个周期没有这个统计量」与
    // 「这个周期没有流量」在这里同义。折算方向确实偏向漏停，但一个存在的数据点带着 null
    // 的 `Sum`（而请求里明确写了 `statistics: ["Sum"]`）尚未被观察到过。
    //
    // 只要它出现且不是 null，就必须是有限的非负数字。这里不是洁癖：`bytes += "500"` 会走
    // 字符串拼接，两个 500 GiB 的桶会被读成 0.005 GiB —— 少报几个数量级，而少报正是唯一
    // 会让看门狗放行的方向。负数同理。
    const sum = point.sum ?? 0;
    if (typeof sum !== "number" || !Number.isFinite(sum) || sum < 0) {
      throw new Error(
        // 用 String() 而不是 JSON.stringify()：`{"sum": 1e400}` 是合法 JSON，解析出来是
        // Infinity，而 `JSON.stringify(Infinity)` 是 `"null"` —— 日志会写成
        // 「unusable sum: null」，把人引向「字段缺失」这个完全错误的方向。
        `GetInstanceMetricData returned an unusable sum for ${metricName}: ${String(point.sum)}`,
      );
    }

    // 单位必须是请求的那一个。**字段缺席不算错**（同上面那条：合法的缺失不能当成畸形），
    // 但只要它出现且不一致，这个 sum 就不是这段代码以为的那个数 —— 把 Bits 当 Bytes 累加会
    // 少报八倍。实测的数据点形状带这个字段：`{"sum":785943,"timestamp":...,"unit":"Bytes"}`。
    if (point.unit != null && point.unit !== METRIC_UNIT) {
      throw new Error(
        `GetInstanceMetricData returned ${metricName} in ${String(point.unit)}, expected ${METRIC_UNIT}`,
      );
    }

    bytes += sum;

    // 时间戳走 Unix 秒。不是数字、或者量级明显不对（例如毫秒），都当没有。
    //
    // 只检查 `typeof === "number"` 是不够的：毫秒时间戳会让 `endTime − (newest + period)`
    // 变成一个巨大的负数，被下面的 `Math.max(0, …)` 钳到 0 —— **新鲜度检测整体失效，
    // 而日志还宣称数据很新鲜**。绝不能让一个读不懂的时间戳污染新鲜度读数。
    const usable =
      typeof point.timestamp === "number" &&
      Number.isFinite(point.timestamp) &&
      Math.abs(point.timestamp - range.endTime) <= MAX_TIMESTAMP_SKEW_SECONDS;

    if (usable) {
      timestamped += 1;
      if (newest === null || point.timestamp > newest) newest = point.timestamp;
      if (oldest === null || point.timestamp < oldest) oldest = point.timestamp;

      // 这个桶落在查询窗口内的秒数。
      //
      // 桶的相位不是绝对时间轴上的整点，而是**跟着查询的 startTime 走**：实测
      // （2026-08-22，ap-northeast-1）相位 = `floor(startTime / 60) * 60`，之后按 period
      // 步进 —— startTime 对 300 取余 47 / 123 / 250 时，返回的桶起点取余分别是
      // 0 / 120 / 240，四组窗口全部吻合。
      //
      // 于是窗口两端各可能有一个桶只有一部分落在窗口里，而它带回来的是**整桶**的字节。
      // 拿「桶数 × period」当分母会把这段多出来的时间也算进去，速率报低 —— 少报是唯一会
      // 让看门狗放行的方向。按实际覆盖秒数算，无论窗口怎么对齐都不会失守。
      //
      // **不要改成「把 endTime 向下取整到 period 的整数倍」**：那会把最近最多 299 秒的
      // 数据整段扔出窗口，而看门狗最不能丢的就是新鲜度。
      coveredSeconds += Math.max(
        0,
        Math.min(point.timestamp + period, range.endTime) - Math.max(point.timestamp, range.startTime),
      );
    }
  }

  return {
    bytes,
    points: points.length,
    newest,
    oldest,
    // 只有当**每一个**数据点都带着可用时间戳时才交出覆盖秒数。缺几个时间戳就意味着覆盖
    // 被少算，分母偏小、速率偏高 —— 那个方向虽然安全，但会凭空造出误停。宁可退回
    // `points × period` 这个保守分母，也不要拿一份残缺的覆盖去驱动停机决策。
    coveredSeconds: timestamped === points.length && coveredSeconds > 0 ? coveredSeconds : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 五、决策
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 停机。调用它就意味着「已经确认必须停」，所以这里的每一个不确定性都向「停」倾斜。
 *
 * 状态由调用方传入，这个函数**不自己去查** —— 否则同一轮里会出现两个可能不一致的答案。
 * 状态的唯一来源是每轮开头那次 `GetInstanceState`。
 *
 * 状态的作用**只是幂等**：不对一个已经停下（或正在停）的实例重复发停机。它不是停机的
 * 前置条件 —— 读不出来（`null`）时照停不误，因为重复停机的代价是一条错误日志，而漏停的
 * 代价是账单。
 *
 * （状态读不到而实例其实已经停了，这里发出的 `StopInstance` 可能被 Lightsail 拒绝，于是
 * 整轮以异常结束。那是响亮的，而且只会发生在 `GetInstanceState` 本就坏掉的时候，本来
 * 就该有人去看一眼。）
 *
 * @param {AwsClient} client
 * @param {Config} config
 * @param {number} usedGib
 * @param {string} reason 触发停机的原因，会原样进入日志
 * @param {string | null} state 这一轮开头查到的实例状态；`null` 表示读不出来
 * @returns {Promise<void>}
 */
async function stopOverLimit(client, config, usedGib, reason, state) {
  if (state !== null && state !== "running") {
    // 写 `DOWN`，**不要写 `OK`**：这是「看门狗把实例停下了、它现在还停着」的稳态。它会
    // 每个 cron 周期重复，可能连刷数周 —— 但那正是它需要一个专属且可 grep 的词的理由。
    // 写成 `OK` 会让「站点已经下线」在日志过滤器里完全消失。
    console.log(
      `${config.label} DOWN | ${formatUsage(config, usedGib)} | ${reason} | instance is "${state}"`,
    );
    return;
  }

  await lightsail(client, config, "StopInstance", { instanceName: config.instanceName });
  console.error(`${config.label} STOPPED | ${formatUsage(config, usedGib)} | ${reason}`);
}

/**
 * 速率闸门。
 *
 * 月初至今是个滞后的总量，它看不出「最近一小时正在以 2 Gbps 烧」。默认的 20% 余量
 * （1024 GiB × (1 − 0.8) = 204.8 GiB）在 1 Gbps 下只够烧 29 分钟 —— 并不比一个检测回路
 * 长多少。所以除了静态线，还要问一个动态问题：**按现在的速率，剩余额度还能撑多久？
 * 撑不过一个反应视野就现在停。**
 *
 * 比较的目标是**整份额度**而不是 `THRESHOLD` 那条保守的早停线：这道闸门问的是「会不会在
 * 下一次能反应过来之前冲过配额」，而配额才是开始计费的地方。比到阈值会退化成静态线的
 * 一个吵闹的复制品（`remaining → 0` 时任何速率都跳闸）。这也意味着 `THRESHOLD = 1` 时
 * 闸门照常生效。
 *
 * 顺带实测指标的落库延迟 —— 这个数 AWS 不公开，而整套余量标定都建立在它之上。
 *
 * @param {AwsClient} client
 * @param {Config} config
 * @param {{ startTime: number, endTime: number }} monthRange 只取 `endTime`，作为窗口右端
 * @param {number} usedBytes 月初至今总量，字节
 * @param {string | null} instanceState 这一轮开头查到的实例状态；`null` 表示读不出来。
 *   闸门自己不查状态（同一轮里两个可能不一致的答案比没有答案更糟），只用它把「指标看
 *   不见」和「实例本来就没在跑」分开，判据一律走 `meterShouldSeeTraffic`。
 * @returns {Promise<{ reason: string | null, lagSeconds: number | null,
 *   bytesPerSecond: number | null, secondsToQuota: number | null, stale: boolean,
 *   unmeasurable: boolean, inPoints: number, outPoints: number }>}
 *   `reason` 非空表示需要停机。其余各项是这一轮算出来的遥测，**不跳闸时也要带回去** ——
 *   否则闸门在正常运行里完全不可见，没人能确认它还在正常工作。
 *   - `stale`        速率是从旧过容忍上限的数据点算出来的，日志里必须标出来。
 *   - `unmeasurable` 窗口里一个数据点都没有，速率**无从谈起**（与「速率是零」是两回事）。
 *   - `inPoints` / `outPoints` 两个方向各自落库的桶数，**分开带**而不是合成一个数：
 *     取较大值会把「一侧管道停摆」显示成一切正常。
 */
async function burstCheck(client, config, monthRange, usedBytes, instanceState) {
  const { endTime } = monthRange;

  // 窗口**不**钳到月初。速率是个物理量，没有理由尊重月份边界：跨过 00:00 UTC 的那一刻，
  // 实例并没有变慢。钳到月初的代价是每个月头 5 分钟闸门凑不满一个数据桶、完全失明 ——
  // 而那恰恰是额度刚重置、最可能有人开始猛跑的时候。
  //
  // 上个月的流量落进窗口不会造成误停：剩余额度用的是**本月**的 usedBytes，跨月后它接近
  // 满额，再高的速率也撑得过反应视野。
  const range = { startTime: endTime - BURST_WINDOW_SECONDS, endTime };
  const [recentIn, recentOut] = await Promise.all([
    sumMetric(client, config, "NetworkIn", range, BURST_PERIOD_SECONDS),
    sumMetric(client, config, "NetworkOut", range, BURST_PERIOD_SECONDS),
  ]);

  // 窗口里一个数据点都没有 —— 速率**无从谈起**，这和「速率是零」必须分开。
  //
  // 可观测延迟有个天花板：窗口 30 分钟减去粒度 5 分钟 = 25 分钟。延迟越过它之后，任何
  // 已经可查的桶其起点都落在窗口之外，于是 `newest` 为 null、延迟算不出来、下面的失明
  // 检测跟着一起失效。**这一支必须存在**：没有它，这条路径会把「零个数据点」当成
  // 「速率是 0」打进日志，反过来断言「实例没有流量」—— 延迟 25 分钟时报警并停机、
  // 26 分钟时静默放行并写下 `now 0 kbps`。
  //
  // 变异测试结构上抓不到这一类缺陷：缺的是一整段代码，没有哪一行可以被变异成「不报警」。
  // 抓住它的是「看门狗对自己的评价必须随数据变旧而单调不增」这条性质。
  if (recentIn.points === 0 && recentOut.points === 0) {
    // 「指标看不见」和「实例本来就没在跑」在指标上长得一模一样 —— 所以不猜，直接用这一轮
    // 已经查到的真实状态来分辨。
    //
    // **状态读不出来时不许断言成因。** 一口咬定「the meter is blind, not idle」是不对的：
    // 同一份响应形状下「实例被操作者合法停着」完全可能（维护期恰好碰上状态查询也坏了），
    // 那句话会把一次合法停机写成管道故障，每个 cron 周期一条，直到有人修好状态查询为止。
    // 只有实例**确认在跑**时那个成因才被排除掉，断言才成立。下面 stale 告警面对同一个
    // 问题，措辞方式与这里一致。
    if (meterShouldSeeTraffic(instanceState)) {
      const explanation =
        instanceState === "running"
          ? "the instance is running, so the meter is blind, not idle"
          : "the instance state is unreadable, so this is either a blind meter or an instance that is not running";
      console.error(
        `${config.label} BLIND | no metric data points in the last ${BURST_WINDOW_SECONDS / 60} min` +
          ` | ${explanation}` +
          ` | the burst gate cannot measure a rate this run`,
      );
    }
    // 不因此停机：零数据点也可能只是实例没在跑，而误停的代价实打实。静态线照常工作。
    return {
      reason: null,
      lagSeconds: null,
      bytesPerSecond: null,
      secondsToQuota: null,
      stale: false,
      unmeasurable: true,
      inPoints: 0,
      outPoints: 0,
    };
  }

  // 恰好一个方向零数据点 —— 计量表半瞎。实测一台跑着的实例两个方向的桶数完全同步
  // （6/6 与 6/6，落库延迟都是 16 秒），所以这不是正常形态。
  warnIfHalfBlind(config, recentIn, recentOut, instanceState, {
    window: `the last ${BURST_WINDOW_SECONDS / 60} min`,
    consequence: "the burst gate is measuring only half the traffic, which under-reports the rate",
  });

  // 每个方向各自除以自己的覆盖时长，再相加。**不能**把两个方向的字节合起来除以一个共同的
  // 分母：两个指标的落库进度并不保证同步，NetworkIn 落了 6 个桶而 NetworkOut 只落了 2 个
  // 时，用「较长的那个」当分母会把 Out 那 600 秒里的字节摊到 1800 秒上，速率报低三倍 ——
  // 一场 2 Gbps 的突发就这样被放行。用「较短的那个」也不行：某个方向一个点都没有时分母
  // 归零，闸门直接失效。各算各的，两边都不会错。
  const rateOf = (metric) => {
    if (metric.points === 0) return 0;
    // 分母首选实测覆盖秒数（见 sumMetric），拿不到时退回「桶数 × 粒度」。
    return metric.bytes / (metric.coveredSeconds ?? metric.points * BURST_PERIOD_SECONDS);
  };
  const bytesPerSecond = rateOf(recentIn) + rateOf(recentOut);

  // 实测落库延迟：最新那个桶覆盖 [newest, newest + period)，它已经能查到，所以延迟就是
  // 「此刻」减去那个桶的结束时刻。桶还开着时会算出负数，钳到 0 —— 那表示数据是新鲜的。
  //
  // 取两个指标里**最旧**的那一个，不是最新的。速率刻意按每个指标各算各的，理由是「两个
  // 指标的落库进度不保证同步」—— 那么新鲜度也必须按同一个前提判断。取较新的那一个会让
  // 「NetworkOut 的管道变慢、NetworkIn 照常」报告成一切新鲜：不响 BLIND、不标 (stale)、
  // meter 报 0，而速率里有一半是二十多分钟前的数据。半瞎的计量表被读作全新鲜，方向是漏停。
  //
  // 只看有数据点的指标：某个方向零点时它贡献不了新鲜度信息，不该把整体拖成 null
  // （那一档由上面的 warnIfHalfBlind 承接）。
  const withPoints = [recentIn, recentOut].filter((m) => m.points > 0);
  const oldestNewest =
    withPoints.length > 0 && withPoints.every((m) => m.newest !== null)
      ? Math.min(...withPoints.map((m) => m.newest))
      : -Infinity;
  const lagSeconds = Number.isFinite(oldestNewest)
    ? Math.max(0, endTime - (oldestNewest + BURST_PERIOD_SECONDS))
    : null;

  // 有数据点、却一个可用时间戳都没有：速率算得出来（它不碰时间戳），但**数据有多新完全
  // 无从判断**，于是下面的失明检测永久失效。如果 Lightsail 哪天把时间戳改成 ISO 字符串，
  // 症状就是这个：没有告警、没有 meter 字段，而余量标定唯一的实测输入就此消失。
  if (lagSeconds === null) {
    console.error(
      `${config.label} BLIND | ${recentIn.points + recentOut.points} data points but no usable timestamp` +
        ` | cannot tell how stale the rate is; the staleness check is inoperative`,
    );
  }

  // 数据老到超过容忍上限时，突发闸门已经给不出它承诺的那个保证，这一轮真正在守账单的
  // 只剩静态线 —— 必须说出来。
  const stale = lagSeconds !== null && lagSeconds >= MAX_TOLERABLE_LAG_SECONDS;

  if (stale && meterShouldSeeTraffic(instanceState)) {
    // 「最新的桶很旧」有两种成因：指标侧延迟，或者实例根本没在跑（不再产生新桶）。光看
    // 指标分辨不了 —— 但这一轮**已经查过状态**，所以措辞跟着状态走，不去提一个已经被
    // 排除掉的解释。
    const explanation =
      instanceState === "running"
        ? "the instance is running, so the meter itself is behind"
        : "the instance state is unreadable, so this is either a lagging meter or an instance that is not running";
    console.error(
      `${config.label} BLIND | newest metric bucket is ${(lagSeconds / 60).toFixed(1)} min old,` +
        ` past the ${MAX_TOLERABLE_LAG_SECONDS / 60} min tolerance | ${explanation}` +
        ` | the burst gate can no longer outrun a full-rate burst this run`,
    );
  }

  const remainingBytes = config.quotaGib * BYTES_PER_GIB - usedBytes;
  // 速率为零时「还能撑多久」是无穷 —— formatDuration 会把它写成 never，那正是实情。
  const secondsToQuota = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : Infinity;

  const telemetry = {
    lagSeconds,
    bytesPerSecond,
    secondsToQuota,
    stale,
    unmeasurable: false,
    inPoints: recentIn.points,
    outPoints: recentOut.points,
  };

  if (secondsToQuota >= REACTION_HORIZON_SECONDS) return { reason: null, ...telemetry };

  return {
    reason:
      `burning ${formatRate(bytesPerSecond)} with ${(remainingBytes / BYTES_PER_GIB).toFixed(3)} GiB of quota left` +
      ` = ${Math.round(secondsToQuota / 60)} min to overage, inside the ${REACTION_HORIZON_SECONDS / 60} min reaction horizon`,
    ...telemetry,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 六、每一轮
// ─────────────────────────────────────────────────────────────────────────────

export default {
  /**
   * 一轮看门狗：先测量，再由数字决定是停机还是启动。
   *
   * 运行时还会传入第三个参数 `ExecutionContext`，这里没有声明它 —— 没有需要挂到
   * `waitUntil` 上的后台任务，handler 返回时该做的事都已经做完。
   *
   * 任何位置抛出的异常都直接向上抛，由 Workers 把这次调用记为失败。那是唯一的错误信号：
   * 这个 Worker 不主动通知任何人，理由见 README。
   *
   * handler 是**无状态**的 —— 没有 KV、没有模块级缓存。一次失败的触发之后没有任何东西
   * 需要对账，下一次触发会独立地重新得出结论。
   *
   * @param {ScheduledController} controller
   * @param {Record<string, string | undefined>} env
   */
  async scheduled(controller, env) {
    const config = readConfig(env);

    const client = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      service: "lightsail",
      region: config.region,
      retries: AWS_RETRIES,
    });

    // 用调度时间而非墙上时钟：它精确落在 cron 的时间格上，所以即便调用被延迟或重试，
    // 评估的仍然是它当初被触发的那一格。
    const now = new Date(controller.scheduledTime ?? Date.now());
    const range = usageWindow(now);

    // 三次调用并行发出，零额外延迟。
    //
    // **实例状态每一轮都无条件查一次。** 不要改成「按需查」（只在要动手停机或启动时才
    // 问）：那样「实例在不在跑」就只能从「指标里还有没有新数据」**推断**，而指标有落库
    // 延迟 —— 实例停机之后日志会继续写 OK 十几分钟，因为它从来没问过。识别实例状态只有
    // 一个来源，就是 API。每轮多一次调用（正常路径 5 次），而 Lightsail API 不计费也没有
    // 速率配额。
    const [monthIn, monthOut, instanceState] = await Promise.all([
      sumMetric(client, config, "NetworkIn", range, METRIC_PERIOD_SECONDS),
      sumMetric(client, config, "NetworkOut", range, METRIC_PERIOD_SECONDS),
      getInstanceState(client, config).catch((err) => {
        // 读不出来就是读不出来，绝不退回推断。`null` 在停机路径上被当作「照停」
        // （fail-closed），在几条可信度告警里被当作「该说话」—— 见 meterShouldSeeTraffic。
        console.error(`${config.label} DEGRADED | instance state unreadable (${err.message})`);
        return null;
      }),
    ]);

    // ── 用量 ────────────────────────────────────────────────────────────────
    //
    // 虽然只有出向超量才计费，但两个方向都在消耗额度，所以两个都算。
    //
    // 按 2^30 换算，与 Lightsail `GetBundles` 的 `transferPerMonthInGb` 对齐：该字段把
    // 「1 TB」记为 1024，同一响应里的 `ramSizeInGb: 0.5` 也只可能是 512 MiB，两处一致地
    // 指向 GiB。于是 QUOTA_GIB 可以直接填那个数字，不需要任何换算。
    const usedBytes = monthIn.bytes + monthOut.bytes;
    const usedGib = usedBytes / BYTES_PER_GIB;
    const limitGib = config.quotaGib * config.threshold;

    // 月度读数覆盖到哪一段时间，两头都要看。
    //
    // **两头取的方向相反，而且两个方向都是「悲观」的那一侧**，别按对称的直觉去改：
    //
    //   `newest` 取 **min**（两者中更旧的那个）—— 用量是 In + Out 之和，只要有一侧的
    //     数据停在过去，整份读数就已经过期了。取更新鲜的那一头会让「一侧管道落后、另一侧
    //     照常」报告成一切新鲜，落后告警永不触发，方向是漏停。
    //
    //   `oldest` 取 **max**（两者中更晚的那个）—— 总量只有从「两侧都有数据」的那一天起
    //     才是完整的。取更早的那一头会让 `covers from` 在最该出现的时候消失：NetworkIn
    //     从月初就有、NetworkOut 缺了前九天时，min 等于月初，条件 `> range.startTime`
    //     不成立，于是九天的出向用量凭空消失而日志里没有这个字段。
    //
    // `oldest` 那一头**不告警**，只把事实摆进日志：同一个形状至少有三种成因 —— 实例在
    // 本月内才创建（创建之前没有任何指标历史）、那几天实例没在跑、指标真的丢了数据。
    // 光看指标分不出它们，而为前两种误报的代价是让第三种淹没在噪音里。
    const monthWithPoints = [monthIn, monthOut].filter((m) => m.points > 0);
    const monthOldest =
      monthWithPoints.length > 0 && monthWithPoints.every((m) => m.oldest !== null)
        ? Math.max(...monthWithPoints.map((m) => m.oldest))
        : null;
    const monthNewest =
      monthWithPoints.length > 0 && monthWithPoints.every((m) => m.newest !== null)
        ? Math.min(...monthWithPoints.map((m) => m.newest))
        : -Infinity;

    // ── 静态线 ──────────────────────────────────────────────────────────────
    //
    // 用 `>=`：恰好等于停机线时必须停。
    if (usedGib >= limitGib) {
      await stopOverLimit(
        client,
        config,
        usedGib,
        `over the ${limitGib.toFixed(3)} GiB stop threshold (${config.quotaGib} GiB quota x ${config.threshold})`,
        instanceState,
      );
      return;
    }

    // ── 月度读数的可信度 ────────────────────────────────────────────────────
    //
    // 越线时上面已经 return，所以下面这几条只在「还没到线」的轮次里评估 —— 而那正是
    // 静态线的读数需要被信任的时候。

    // 一个方向的月度读数完全没有数据：用量少了一整个方向，静态线看到的总量偏小。
    warnIfHalfBlind(config, monthIn, monthOut, instanceState, {
      window: "the month-to-date reading",
      consequence: "usage is missing a whole direction, which under-reports it against the static line",
    });

    // 有数据点、却一个可用时间戳都没有 —— 下面那条覆盖范围检测会整段静默，而这一轮看
    // 起来完全正常。沉默不是选项。
    if (monthWithPoints.length > 0 && !Number.isFinite(monthNewest)) {
      console.error(
        `${config.label} BLIND | month-to-date has ${monthIn.points + monthOut.points} data points but no usable timestamp` +
          ` | cannot tell whether the reading covers today`,
      );
    }

    // 月度读数落后得超出了它可能合理落后的程度，说明静态线看的是一份过期的用量。
    //
    // 判据是「落后多久」，**不要改成「最新的桶是不是今天」**：后者每天 00:00 UTC 那一格
    // 必定误报一次 —— 那一刻今天才过了 0 秒，今天的桶当然还不存在，最新的必然是昨天，
    // 而算出来的落后时长恰好是 0.0 小时。一边宣布「今天的流量不可见」一边报告落后零
    // 小时，噪音与真实故障同形，是最坏的一种。用落后时长：00:00 那一格算出来是 0，不响。
    //
    // 判据里必须带实例状态。一台合法停着的实例不再产生天桶，最新那个会停在它最后跑过的
    // 那一天，之后每天多落后 24 小时 —— 不带状态条件的话，实例被停下之后从次日 00:20 UTC
    // 起**每个 cron 周期**都会喊一次，一天约 142 条，直到实例重新跑起来或者跨月为止。
    // 而且那句话本身是错的：停机期间今天的流量不是「不可见」，是根本不存在。
    const behindSeconds = monthBehindSeconds(range, monthNewest);
    if (
      behindSeconds !== null &&
      behindSeconds > MONTH_BEHIND_TOLERANCE_SECONDS &&
      meterShouldSeeTraffic(instanceState)
    ) {
      console.error(
        `${config.label} BLIND | month-to-date reading only covers through ${new Date(monthNewest * 1000).toISOString().slice(0, 10)}` +
          ` (${(behindSeconds / 3600).toFixed(1)} h behind)` +
          ` while the instance is ${describeState(instanceState)}` +
          ` | today's traffic is invisible to the static line`,
      );
    }

    // ── 零读数的兜底告警 ────────────────────────────────────────────────────
    //
    // 「月初至今恰为零」有两种成因，光看指标分不开：
    //   实例没在跑 —— 正常，没什么可说的。
    //   量的那一侧坏了 —— 例如请求的 unit 传错。实测传成 Bits / Count / Percent /
    //     Seconds / Megabytes 中任意一个，AWS 都回 HTTP 200、metricName 正确回显、
    //     metricData 空数组，与「没有流量」完全同形，`sumMetric` 的双信号校验对它无感。
    //
    // 有了每轮实测的实例状态就不用猜：跑着的实例读数为零在物理上不成立，只可能是管道
    // 坏了 —— 而 0 字节正是唯一会让看门狗什么都不做的读数，所以这条兜底不能少。
    const monthAgeSeconds = range.endTime - range.startTime;
    if (
      usedBytes === 0 &&
      monthAgeSeconds > ZERO_READING_GRACE_SECONDS &&
      meterShouldSeeTraffic(instanceState)
    ) {
      console.error(
        `${config.label} BLIND | ${(monthAgeSeconds / 3600).toFixed(1)} h into the month, month-to-date reads exactly zero` +
          ` while the instance is ${describeState(instanceState)}` +
          ` | a running instance always moves some bytes, so the metric pipeline is what is broken` +
          ` (a wrong unit returns HTTP 200 with an empty array)`,
      );
    }

    // ── 突发闸门 ────────────────────────────────────────────────────────────
    //
    // 总量恰为零时不可能存在突发，跳过这两次调用 —— 长期停机的实例每轮只花 3 次调用。
    let burst = null;
    if (usedBytes > 0) {
      burst = await burstCheck(client, config, range, usedBytes, instanceState);
      if (burst.reason) {
        await stopOverLimit(client, config, usedGib, burst.reason, instanceState);
        return;
      }
    }

    // ── 这一轮的那一行日志 ──────────────────────────────────────────────────
    //
    // 每次触发只写一行，行首是可 grep 的状态标记（OK / DOWN / STOPPED / BLIND /
    // DEGRADED）。`wrangler tail | grep -v " OK | "` 就只剩下值得看的事件。
    //
    // 字段各回答一个问题，而且全部是这一轮**已经算出来**的东西，没有额外调用。每个字段
    // 的含义见 README 的「读日志」一节。
    const common = [formatUsage(config, usedGib), `stop at ${limitGib.toFixed(3)} GiB`];

    if (burst && burst.unmeasurable) {
      // **绝不写成 `now 0 kbps`** —— 那是在没有数据的情况下断言「没有流量」。
      common.push("now unknown (no data points in window)");
    } else if (burst && burst.bytesPerSecond !== null) {
      // 速率来自过旧的数据点时必须标出来：同一轮里刚写过一行 BLIND 说它不可信，这里就
      // 不能再把同一个数字摆得和正常读数一样。
      const mark = burst.stale ? " (stale)" : "";
      common.push(`now ${formatRate(burst.bytesPerSecond)}${mark}, ${formatDuration(burst.secondsToQuota)} to quota`);
    }

    const elapsed = monthElapsedFraction(now);
    if (elapsed >= PROJECTION_MIN_ELAPSED) {
      common.push(`month ${(elapsed * 100).toFixed(0)}% elapsed, projected ${(usedGib / elapsed).toFixed(0)} GiB`);
    }

    // `win` 与 `days` 都写成 `NetworkIn,NetworkOut/应有`，**两个方向分开**。合成一个数
    // （尤其是取较大值）会把「一侧管道停摆」显示成一切正常，而那正是需要一眼看出来的事。
    if (burst) {
      common.push(`win ${burst.inPoints},${burst.outPoints}/${BURST_WINDOW_SECONDS / BURST_PERIOD_SECONDS}`);
    }

    // 月度读数拿到几个天桶 vs 本月已过几天。差值有正当解释（实例合法停机的日子没有桶），
    // 所以只记录不告警 —— 但月中缺一整天时，至少有人能看见。
    const daysElapsed = Math.ceil((range.endTime - range.startTime) / METRIC_PERIOD_SECONDS);
    common.push(`days ${monthIn.points},${monthOut.points}/${daysElapsed}`);

    // 读数没从月初起算时，把真正的起点写出来。`days 16,16/22` 只说少了六天，不说少的是
    // 哪六天 —— 而「少的是月初连续的六天」和「中间零散缺六天」是完全不同的两件事。
    if (monthOldest !== null && monthOldest > range.startTime) {
      common.push(`covers from ${new Date(monthOldest * 1000).toISOString().slice(0, 10)}`);
    }

    if (burst && burst.lagSeconds !== null) {
      common.push(`meter ${(burst.lagSeconds / 60).toFixed(1)} min behind`);
    }

    // ── 出口：这一轮的终态 ──────────────────────────────────────────────────
    //
    // 只有两个词，因为一轮只可能是两种结果之一：实例还在跑（OK），或者它没在跑（DOWN）。
    //
    // `DOWN` 必须是一个**专属且可 grep 的词**。突发闸门可以在用量还没到静态线时就跳闸，
    // 停机之后用量不再增长，于是此后每一次触发都满足 `used < limit` —— 无脑写 OK 会造成
    // 「站点已经下线，而 `grep -v " OK | "` 里什么都没有」。
    //
    // 判据是这一轮**实际问到的**状态。状态读不出来时写 OK，那一轮另有一行 DEGRADED 说明
    // 情况 —— 不把「不知道」伪装成「已下线」，也不反过来。
    const down = typeof instanceState === "string" && instanceState !== "running";
    const token = down ? "DOWN" : "OK";
    const tail = down ? [...common, `instance is "${instanceState}"`] : common;
    console.log([`${config.label} ${token}`, ...tail].join(" | "));
  },
};
