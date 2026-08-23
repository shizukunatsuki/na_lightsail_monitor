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

/**
 * 这个状态下计量表**应该**看得见流量：跑着的实例几分钟内必然产生 DNS、NTP、后台扫描
 * 之类的字节，读不到数据只可能是量的那一侧出了问题。状态读不出来（null）时也按「应该
 * 看得见」处理 —— 宁可多喊一声，不要把一次真的失明藏进沉默里。
 *
 * **五处判断共用它**，它们问的是同一个问题：突发窗口零数据点、突发窗口只有一个方向有
 * 数据、数据旧过容忍上限、月度读数恰为零、月度读数没覆盖到今天。此前这几处各写各的 ——
 * 有的完全没问过状态（月度落后告警，代价是合法停机期每轮误报），有的就地写成
 * `=== "running"` 把「状态读不出来」这一档吞掉（stale 告警）。
 *
 * 所以判据必须**只有一个来源**：任何新的「计量表该不该看得见东西」的判断都走这里，
 * 不要就地再写一遍比较 —— 这个仓库已经因为「同一个问题各写各的」栽过三次。
 */
const meterShouldSeeTraffic = (state) => state === "running" || state === null;

/**
 * @typedef {object} Config
 * @property {string} region
 * @property {string} instanceName
 * @property {string} label
 * @property {number} quotaGib
 * @property {number} threshold
 * @property {boolean} manualHold
 */

/**
 * 前置校验配置，任何缺失或无法解析的值都直接报错退出。若不校验，QUOTA_GIB 写错会让
 * 后续所有比较都变成与 NaN 比较、结果恒为 false，这会被读作「已超额」从而停掉实例。
 *
 * 两个密钥只检查是否存在，其值不会离开此函数。
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Config}
 */
export function readConfig(env) {
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "INSTANCE_NAME"]) {
    if (!env[name]) throw new Error(`Missing required binding ${name}`);
  }

  // 上面那道检查只看非空，所以 fork 本仓库、把这两项换成占位串却忘了真正填写的人能一路
  // 放行，之后每次触发都在 Lightsail 侧失败。留在日志里的就是每天几百条干巴巴的 404，
  // 很难让人立刻意识到「你压根没填实例名」。所以在这里直接把话说清楚。
  //
  // 刻意使用精确比较：真有实例就叫 `change_me_later`，那是别人正经的实例名，不能拦。
  for (const name of ["AWS_REGION", "INSTANCE_NAME"]) {
    if (env[name] === PLACEHOLDER) {
      throw new Error(`${name} is still the placeholder "${PLACEHOLDER}"; set it in wrangler.jsonc`);
    }
  }

  // 上界的推导见 tuning.js 里 MAX_QUOTA_GIB 的说明：越过它之后字节比较开始丢精度，
  // 停机线会变成一个永远够不到的数。
  const quotaGib = Number(env.QUOTA_GIB);
  if (!Number.isFinite(quotaGib) || quotaGib <= 0 || quotaGib > MAX_QUOTA_GIB) {
    throw new Error(
      `QUOTA_GIB must be a positive number of at most ${Math.floor(MAX_QUOTA_GIB)}, got ${JSON.stringify(env.QUOTA_GIB)}`,
    );
  }

  // 上界卡在 1，这样即使把 THRESHOLD 按百分比写成 "80"，也不会悄无声息地让看门狗
  // 变成一个永远不触发的摆设。
  const threshold = Number(env.THRESHOLD);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error(`THRESHOLD must be a fraction in (0, 1], got ${JSON.stringify(env.THRESHOLD)}`);
  }

  return {
    region: env.AWS_REGION,
    instanceName: env.INSTANCE_NAME,
    // 每一行日志的前缀。带上 region 是因为实例名只在单个区域内唯一，而这个仓库是公开的
    // —— 谁复制过去都会得到一份自我说明的日志，不必回头去猜是哪个部署写的。
    label: `${env.INSTANCE_NAME}@${env.AWS_REGION}`,
    quotaGib,
    threshold,
    // 计划内停机的逃生阀。与字符串精确比较，这样打错字（"yes"、"1"、"True"）时
    // 重启逻辑仍然有效，而不是不声不响地把实例摁住一整个月。
    manualHold: env.MANUAL_HOLD === "true",
  };
}

/**
 * `now` 所在 UTC 月份的第一个瞬间，单位为毫秒时间戳。
 *
 * 一律用 UTC：额度是在每月 1 日 00:00 UTC 重置的，这与任何本地时区的月份边界都不是
 * 同一个时刻。若改用 `getFullYear`/`getMonth` 推导，每个月在跨月前后各有最多一天的
 * 时间会查错窗口。
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
 * 人可读的时长。日志是给人扫的，不是给机器解析的。
 *
 * 导出只为了能直接做单元测试：它唯一的调用点是正常那一行，而那一行只在
 * `secondsToQuota >= REACTION_HORIZON_SECONDS` 时才写——视野一旦是 60 分钟，「分钟」
 * 那个分支就再也走不到，从 handler 那头测不出来。把视野调低时它又会活过来，所以不能
 * 因为「当前配置下走不到」就把它删掉。
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

/**
 * 供 GetInstanceMetricData 使用的「月初至今」查询窗口，单位是 Unix *秒*
 * （Lightsail API 这里收的是数字，不是 ISO 字符串）。
 *
 * 结束时间至少比起始时间晚一分钟，这样新月份的第一次触发送出的区间也不是空的；
 * 宽度为零的区间会被 API 拒绝。
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
      // 与多数 AWS JSON API 不同，Lightsail 的请求字段是小驼峰。写成大驼峰只会得到
      // 一个毫无提示意义的 400。
      "X-Amz-Target": `${API_TARGET}.${operation}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // 响应体会原样进入日志，所以两个凭据都要先抹掉。
    //
    // access key id 是必须的：SigV4 的拒绝响应会回显 credential scope，里面就嵌着它。
    // secret 按理不会被任何 AWS 响应回显 —— 但「按理不会」不是把它排除在外的理由。
    // 这里原先只抹了 access key id，也就是只抹了当初想到的那一个；性质测试正是从这个
    // 缺口切进来的。脱敏应当是把**已知的全部凭据**都过一遍，而不是列举我记得的那些。
    //
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
 * 实例当前的状态名，例如 "running" / "stopped"。
 *
 * 响应无法识别时抛错，而不是返回 undefined：重启路径把「不是 stopped」当作无事可做，
 * 而停机路径把「不是 running」当作无事可做 —— 一个悄悄缺失的状态在两边都会被读成
 * 「什么都不用做」。谁来承接这个异常，由调用方按方向决定：见 `stopOverLimit`。
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
 * 单个指标在给定窗口内的总量（字节），以及实际落库的数据点个数。
 *
 * `points` 不是调试信息，突发闸门要用它当速率的分母：指标有几分钟落库延迟，窗口尾部
 * 通常还是空的，拿窗口长度去除会把速率算低 —— 而算低正是不安全的那个方向。
 *
 * `newest` 是最新一个数据点的桶起点（Unix 秒），用来实测那个落库延迟。AWS 从不公开这个
 * 数，只说「随服务而变」，而整套余量标定都依赖它 —— 所以只能自己量。
 *
 * @param {AwsClient} client
 * @param {Config} config
 * @param {"NetworkIn" | "NetworkOut"} metricName
 * @param {{ startTime: number, endTime: number }} range
 * @param {number} period
 * @returns {Promise<{ bytes: number, points: number, newest: number | null,
 *   oldest: number | null, coveredSeconds: number | null }>}
 *   `oldest` 是最旧一个可用时间戳的桶起点，用来判断读数是不是从月初起算；
 *   `coveredSeconds` 是窗口内被数据点真正覆盖到的秒数，速率的分母优先用它，拿不到时
 *   为 `null`（见下面返回处的说明）。
 *
 * 导出只为了能直接测那道数据点上限检查：当前两个查询离 1440 都很远，从 handler 那头
 * 根本走不到它，而它防的恰恰是「有人把粒度改小」这种以后才会发生的事。同 `formatDuration`。
 */
export async function sumMetric(client, config, metricName, range, period) {
  // 上游对单次查询的数据点数有硬上限，而**超限不报错**：HTTP 200、metricName 正常回显、
  // metricData 空数组（实测 1440 → 1440 个点，1441 → 0 个）。落地就是 0 字节，正好是唯一
  // 会让看门狗什么都不做的读数。当前两个查询离上限都很远，这道检查防的是调参把窗口和粒度
  // 改成一个会超限的组合 —— 那种失效在日志里没有任何痕迹。
  const wanted = Math.ceil((range.endTime - range.startTime) / period);
  if (wanted > MAX_DATAPOINTS_PER_QUERY) {
    throw new Error(
      `GetInstanceMetricData for ${metricName} would ask for ${wanted} data points,` +
        ` past the ${MAX_DATAPOINTS_PER_QUERY} the API silently truncates to an empty array`,
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

  // 读不懂的响应一律抛错，绝不折算成 0 —— 0 字节是唯一会让看门狗什么都不做的读数，
  // 指标侧一次降级就能让它一边报平安一边放任实例烧到超额。
  //
  // 但「读不懂」的判据**不能**挂在 `metricData` 存不存在上。AWS 的响应定义里它没有任何
  // 「必然出现」的保证，而各语言 SDK 一律把「字段缺失」正规化成空数组 —— 这恰恰说明
  // 服务端允许在没有数据时把它整个省掉。把缺失当成错误，代价是致命的：一台停机的实例
  // 在新月份读到的就是空响应，于是每次触发都抛错，重启永远发不出去，实例停满一个月。
  //
  // 判据改挂在两个信号上，满足其一就认定这份响应是真的：
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

  // 数据点既不保证有序也不保证连续，所以要累加而不是按下标取值。求总量与顺序无关；
  // 缺口本身就代表那段时间没有流量。
  let bytes = 0;
  let newest = null;
  let oldest = null;
  // 窗口内被数据点真正覆盖到的秒数，用作速率分母。见函数返回值里 coveredSeconds 的说明。
  let coveredSeconds = 0;
  let timestamped = 0;
  for (const point of points) {
    if (point === null || typeof point !== "object") {
      throw new Error(`GetInstanceMetricData returned a non-object data point for ${metricName}`);
    }

    // `sum` 缺席**或显式为 null** 都按零算 —— 这是一个明确的产品决定，不是隐式行为：
    // CloudWatch 家族的 Datapoint 各统计量字段本就可空，而「这个周期没有这个统计量」
    // 与「这个周期没有流量」在我们的用途下同义。折算方向确实是漏停方向，但真实响应里
    // 一个存在的数据点带着 null 的 Sum（我们明确请求了 Sum）尚未被观察到，暂按零处理。
    //
    // 但只要它出现且不是 null，就必须是一个
    // 有限的非负数字。这里不是洁癖：`bytes += "500"` 会走字符串拼接，两个 500 GiB 的桶
    // 会被读成 0.005 GiB —— 少报几个数量级，而少报正是唯一会让看门狗什么都不做的方向。
    // 负数同理。读不懂就抛错，与本函数其余部分保持同一种姿态。
    const sum = point.sum ?? 0;
    if (typeof sum !== "number" || !Number.isFinite(sum) || sum < 0) {
      throw new Error(
        // 不能直接 JSON.stringify：`{"sum": 1e400}` 是合法 JSON，解析出来是 Infinity，
        // 而 JSON.stringify(Infinity) 是 "null" —— 日志会写成「unusable sum: null」，
        // 把人引向「字段缺失」这个完全错误的方向。
        `GetInstanceMetricData returned an unusable sum for ${metricName}: ${String(point.sum)}`,
      );
    }
    // 单位必须是我们请求的那一个。**字段缺席不算错**：这个仓库已经因为「把合法的字段
    // 缺失当成畸形响应」栽过一次（空 metricData 被读成错误，停机中的实例整月发不出重启），
    // 不能在同一个地方栽第二次。但只要它出现且不一致，这个 sum 就不是我们以为的那个数 ——
    // 把 Bits 当 Bytes 累加会少报八倍，而少报是唯一会让看门狗放行的方向。
    if (point.unit != null && point.unit !== METRIC_UNIT) {
      throw new Error(
        `GetInstanceMetricData returned ${metricName} in ${String(point.unit)}, expected ${METRIC_UNIT}`,
      );
    }
    bytes += sum;

    // 时间戳走 Unix 秒。不是数字、或者量级明显不对（毫秒），都当没有 —— 绝不让一个
    // 读不懂的时间戳污染延迟读数，那会让 staleness 检测在「看起来很新鲜」的假象下失效。
    const usable =
      typeof point.timestamp === "number" &&
      Number.isFinite(point.timestamp) &&
      Math.abs(point.timestamp - range.endTime) <= MAX_TIMESTAMP_SKEW_SECONDS;
    if (usable) {
      timestamped += 1;
      if (newest === null || point.timestamp > newest) newest = point.timestamp;
      if (oldest === null || point.timestamp < oldest) oldest = point.timestamp;

      // 这个桶落在查询窗口内的秒数。桶的相位不是绝对时间轴上的整点，而是跟着查询的
      // startTime 走 —— 实测（2026-08-22，ap-northeast-1）相位 = `floor(startTime / 60) * 60`，
      // 之后按 period 步进：startTime 对 300 取余 47 / 123 / 250 时，返回的桶起点取余
      // 分别是 0 / 120 / 240，四组窗口全部吻合。
      //
      // 于是窗口两端各可能有一个桶只有一部分落在窗口里，而它带回来的是**整桶**的字节。
      // 拿桶的个数乘以 period 当分母就会把这段多出来的时间也算进去，速率报低 —— 少报是
      // 唯一会让看门狗放行的方向。按实际覆盖秒数算，无论窗口怎么对齐都不会失守。
      //
      // （独立审计给的修法是把 endTime 向下取整到 period 的整数倍。那个方向是错的：
      // 它会把最近最多 299 秒的数据从窗口里扔掉，而看门狗最不能丢的就是新鲜度。）
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
    // 被少算，分母偏小、速率偏大 —— 那个方向虽然安全，但会凭空造出误停。宁可退回
    // `points * period` 这个保守分母，也不要拿一个残缺的覆盖去驱动停机决策。
    coveredSeconds: timestamped === points.length && coveredSeconds > 0 ? coveredSeconds : null,
  };
}

/**
 * 停机。调用它就意味着「已经确认必须停」，所以这里的每一个不确定性都向「停」倾斜。
 *
 * 先查状态是为了幂等 —— 不对一个已经停下（或正在停）的实例重复发停机。但那次查询本身
 * 会失败，而让它的失败中断整轮，等于让一次已经确认的越线白白漏掉一个 cron 周期。所以
 * 状态读不到时照停不误：重复停机的代价是一条错误日志，漏停的代价是账单。
 *
 * （状态读不到而实例其实已经停了，这里发出的 StopInstance 可能被 Lightsail 拒绝，于是
 * 整轮以异常结束 —— 那是响亮的，而且只会发生在 GetInstanceState 本就坏掉的时候，本来
 * 就该有人去看一眼。）
 *
 * @param {AwsClient} client
 * @param {Config} config
 * @param {number} usedGib
 * @param {string} reason 触发停机的原因，会原样进入日志
 * @param {string | null} state 这一轮开头查到的实例状态；`null` 表示读不出来。
 *   状态只有一个来源（每轮开头那次 `GetInstanceState`），这里不再自己查 —— 否则就会
 *   出现「同一轮里两个可能不一致的答案」。
 */
async function stopOverLimit(client, config, usedGib, reason, state) {

  if (state !== null && state !== "running") {
    // DOWN 而不是 NOOP：这是「看门狗把实例停下了、它现在还停着」的稳态。它会每个 cron
    // 周期重复，可能连刷数周 —— 但那正是需要一个**专属且可 grep 的词**的理由，而不是把它
    // 混进 NOOP，更不是让另一条停机路径写成 OK（那样站点下线时过滤器里什么都没有）。
    console.log(
      `${config.label} DOWN | ${formatUsage(config, usedGib)} | ${reason} | instance is "${state}"`,
    );
    return;
  }

  await lightsail(client, config, "StopInstance", { instanceName: config.instanceName });
  console.error(`${config.label} STOPPED | ${formatUsage(config, usedGib)} | ${reason}`);
}

/**
 * 速率闸门。月初至今是个滞后的总量，它看不出「最近一小时正在以 2 Gbps 烧」。
 *
 * 默认的 20% 余量（1024 GiB × (1 − 0.8) = 204.8 GiB）在 1 Gbps 下只够烧 29 分钟，
 * 2 Gbps 下 15 分钟 —— 并不比一个检测回路长多少。所以除了「总量越线」这条静态线，还要
 * 问一个动态问题：按现在的速率，剩余额度还能撑多久？撑不过一个反应视野就现在停。
 *
 * 比较的目标是**整份额度**而不是 THRESHOLD 那条保守的早停线：这道闸门问的是「会不会在
 * 下一次能反应过来之前冲过配额」，而配额才是开始计费的地方。
 *
 * 同时顺带实测指标的落库延迟 —— 这个数 AWS 不公开，而整套余量标定都建立在它之上。
 *
 * @param {AwsClient} client
 * @param {Config} config
 * @param {{ startTime: number, endTime: number }} monthRange
 * @param {number} usedBytes 月初至今总量，字节
 * @param {string | null} instanceState 这一轮开头查到的实例状态；`null` 表示读不出来。
 *   闸门自己不查状态 —— 同一轮里两个可能不一致的答案比没有答案更糟。它只用来把「指标
 *   看不见」和「实例本来就没在跑」分开，判据一律走 `meterShouldSeeTraffic`。
 * @returns {Promise<{ reason: string | null, lagSeconds: number | null,
 *   bytesPerSecond: number | null, secondsToQuota: number | null, stale: boolean,
 *   unmeasurable: boolean, instanceState: string | null,
 *   inPoints: number, outPoints: number }>}
 *   `reason` 非空表示需要停机。其余几项是这一轮算出来的遥测，**不跳闸时也要带回去** ——
 *   否则闸门在正常运行里完全不可见，没人能确认它是不是还在正常工作。
 *   `stale` 表示这个速率是从过旧的数据点算出来的，日志里必须标出来，不能让它看起来和
 *   正常读数一样可信；`unmeasurable` 表示窗口里一个数据点都没有，速率无从谈起，与
 *   「速率是零」必须分开；`inPoints` / `outPoints` 是两个方向各自落库的桶数，**分开带**
 *   而不是取较大值 —— 合成一个数会把「一侧管道停摆」显示成一切正常。
 */
async function burstCheck(client, config, monthRange, usedBytes, instanceState) {
  const { endTime } = monthRange;

  // 窗口**不**钳到月初。速率是个物理量，没有理由尊重月份边界：跨过 00:00 UTC 的那一刻，
  // 实例并没有变慢。早先这里跟着月度窗口一起钳到了月初，代价是每个月头 5 分钟闸门凑不
  // 满一个数据桶、完全失明 —— 而那恰恰是额度刚重置、最可能有人开始猛跑的时候。
  // 上个月的流量落进窗口不会造成误停：剩余额度用的是**本月**的 usedBytes，跨月后它接近
  // 满额，再高的速率也撑得过反应视野。
  const range = { startTime: endTime - BURST_WINDOW_SECONDS, endTime };
  const [recentIn, recentOut] = await Promise.all([
    sumMetric(client, config, "NetworkIn", range, BURST_PERIOD_SECONDS),
    sumMetric(client, config, "NetworkOut", range, BURST_PERIOD_SECONDS),
  ]);

  // 每个方向各自除以自己的覆盖时长，再相加 —— 不能把两个方向的字节数合起来除以一个
  // 共同的分母。两个指标的落库进度并不同步：NetworkIn 落了 6 个桶而 NetworkOut 只落了
  // 2 个时，用「较长的那个」当分母会把 Out 那 600 秒里的字节摊到 1800 秒上，速率报低
  // 三倍，一场 2 Gbps 的突发就这样被放行。用「较短的那个」也不行 —— 某个方向一个点
  // 都没有时分母归零，闸门直接失效。各算各的，两边都不会错。
  // 窗口里一个数据点都没有 —— 速率**无从谈起**，这和「速率是零」必须分开。
  //
  // 可观测延迟有个天花板：窗口 30 分钟减去粒度 5 分钟 = 25 分钟。延迟越过它之后，任何
  // 已经可查的桶其起点都落在窗口之外，于是 `newest` 为 null、延迟算不出来、下面那个失明
  // 检测跟着一起失效。此前这条路径会把 `rateOf` 返回的 0 当成正常读数打进日志，反过来
  // 断言「实例没有流量」—— 正是本项目明令禁止的那件事（0 是唯一会让看门狗什么都不做的
  // 读数），只不过发生在速率路径而不是用量路径上。独立审计把它复现为：延迟 25 分钟时
  // 报警并停机，26 分钟时静默放行并写下 `now 0 kbps`。
  //
  // 变异测试结构上抓不到这一类缺陷 —— 缺的是一整段代码，没有哪一行可以被变异成「不报警」。
  if (recentIn.points === 0 && recentOut.points === 0) {
    // 「指标看不见」和「实例本来就没在跑」在指标上长得一模一样 —— 所以不猜，直接用这一轮
    // 已经查到的真实状态来分辨。
    if (meterShouldSeeTraffic(instanceState)) {
      console.error(
        `${config.label} BLIND | no metric data points in the last ${BURST_WINDOW_SECONDS / 60} min` +
          ` | instance is ${instanceState === null ? "of unreadable state" : `"${instanceState}"`}, so the meter is blind, not idle` +
          ` | the burst gate cannot measure a rate this run`,
      );
    }
    // 不因此停机：零数据点也可能只是实例没在跑，误停的代价实打实。静态线照常工作。
    return {
      reason: null,
      lagSeconds: null,
      bytesPerSecond: null,
      secondsToQuota: null,
      stale: false,
      unmeasurable: true,
      instanceState,
      inPoints: 0,
      outPoints: 0,
    };
  }

  // 恰好**一个**方向零数据点。速率照常按有数据的那一侧算（缺的那一侧贡献零，见 rateOf）
  // —— 这是刻意的，缺一个方向不该让闸门整个失效，`test/scheduled.test.js` 有一条用例
  // 专门钉住它。但这件事此前**完全不说**，而那是错的：闸门此刻只看得见一半的流量，
  // 少报的方向正是漏停。
  //
  // 两个方向零点会响 BLIND（上面那一段），一个方向零点却一声不吭，没有道理 —— 后者对
  // 速率估计的损害是同一性质的。更糟的是 `win` 字段当时取两个方向的**较大值**，于是
  // NetworkOut 整个管道停摆时日志照写 `win 6/6 | meter 0.0 min behind`，与一切正常那一行
  // 完全同形。字段现在改成两个方向都露出来（`win 6,0/6`），告警补在这里。
  //
  // 实测（2026-08-23，ap-northeast-1）：一台跑着的实例两个方向的桶数完全同步（6/6 与
  // 6/6，lag 都是 16 秒），所以「一个方向有 6 个桶、另一个 0 个」不是正常形态。
  //
  // 判据同样走 meterShouldSeeTraffic：实例确认停着时，窗口正在把停机前的桶排空，两个
  // 方向先后掉到零是正常的，不该为此喊。
  // 只可能有一个方向是暗的：两个都暗在上面那一段就返回了。所以这里不做「收集一个列表」
  // 的写法 —— 那会带一条永远走不到的分支，而措辞（「另一个方向有数据」）在两个都暗时
  // 本来就是自相矛盾的。
  const darkDirection =
    recentIn.points === 0 ? "NetworkIn" : recentOut.points === 0 ? "NetworkOut" : null;
  if (darkDirection !== null && meterShouldSeeTraffic(instanceState)) {
    console.error(
      `${config.label} BLIND | ${darkDirection} has no data points` +
        ` in the last ${BURST_WINDOW_SECONDS / 60} min while the other direction does` +
        ` | the burst gate is measuring only half the traffic, which under-reports the rate`,
    );
  }

  const rateOf = (metric) => {
    if (metric.points === 0) return 0;
    // 分母优先用实测覆盖秒数（见 sumMetric），拿不到时退回「桶数 × 粒度」。
    return metric.bytes / (metric.coveredSeconds ?? metric.points * BURST_PERIOD_SECONDS);
  };
  const bytesPerSecond = rateOf(recentIn) + rateOf(recentOut);

  // 实测落库延迟：最新那个桶覆盖 [newest, newest + 300)，它已经能查到，所以延迟就是
  // 「此刻」减去那个桶的结束时刻。桶还开着时会算出负数，钳到 0 —— 那表示数据是新鲜的。
  // 取**最旧**的那一个，不是最新的。速率刻意按每个指标各算各的，理由就写在上面
  // （「两个指标的落库进度并不保证同步」）—— 那么新鲜度也必须按同一个前提来判断。
  // 取 max 会让「NetworkOut 的管道停摆、NetworkIn 照常」这种情形报告一切新鲜：不响
  // BLIND、不标 (stale)、meter 报 0，而速率里有一半是二十多分钟前的数据。半瞎的计量表
  // 被读作全新鲜，方向是漏停。
  //
  // 只看有数据点的指标：某个方向零点时它贡献不了新鲜度信息，不该把整体拖成 null。
  const withPoints = [recentIn, recentOut].filter((m) => m.points > 0);
  const oldestNewest =
    withPoints.length > 0 && withPoints.every((m) => m.newest !== null)
      ? Math.min(...withPoints.map((m) => m.newest))
      : -Infinity;
  const lagSeconds = Number.isFinite(oldestNewest)
    ? Math.max(0, endTime - (oldestNewest + BURST_PERIOD_SECONDS))
    : null;

  // 有数据点、却一个可用时间戳都没有：速率算得出来（它不碰时间戳），但**数据有多新
  // 完全无从判断**，于是下面的失明检测永久失效。这是 F1 那条静默路径的另一个入口 ——
  // 如果 Lightsail 哪天把时间戳改成 ISO 字符串，症状一模一样：没有告警、没有 meter 字段，
  // 而余量标定唯一的实测输入就此消失。沉默不是选项。
  if (lagSeconds === null) {
    console.error(
      `${config.label} BLIND | ${recentIn.points + recentOut.points} data points but no usable timestamp` +
        ` | cannot tell how stale the rate is; the staleness check is inoperative`,
    );
  }

  // 数据老到超过容忍上限时，突发闸门已经给不出它承诺的那个保证，这一轮真正在守账单的
  // 只剩静态线 —— 必须说出来。
  //
  // 措辞只陈述观察到的事实，不替它选解释：「最新的桶很旧」在指标侧延迟和实例根本没在
  // 跑这两种情况下长得一模一样，光看指标分辨不了（真跑着就会有新桶落下来）。所以两种
  // 读法都写进去。操作者月中自己停机时这条会连报几次直到那个桶滑出窗口，这是可以接受
  // 的代价：漏掉一次真的指标失明要糟糕得多。
  const stale = lagSeconds !== null && lagSeconds >= MAX_TOLERABLE_LAG_SECONDS;

  // 数据变旧最常见的原因不是「指标坏了」，而是**实例已经不在跑了** —— 桶不再产生，最新
  // 的那个就越来越旧。用这一轮查到的真实状态把两件事分开，不靠推断。
  //
  // 判据走 `meterShouldSeeTraffic` 而不是就地写 `=== "running"`。差别只在状态**读不出来**
  // 那一档：此前它会把这条告警整个吞掉，而项目对这一档的既定规则是「宁可多喊一声」——
  // 另外三个调用点都是这么判的，README 的表格里也是这么写的。状态读不出来时数据还很旧，
  // 恰恰是最需要说话的时候，不该因为「不确定它在不在跑」就沉默。
  if (stale && meterShouldSeeTraffic(instanceState)) {
    console.error(
      `${config.label} BLIND | newest metric bucket is ${(lagSeconds / 60).toFixed(1)} min old, past the ${MAX_TOLERABLE_LAG_SECONDS / 60} min tolerance | the burst gate can no longer outrun a full-rate burst this run (meter lagging, or the instance is not running)`,
    );
  }

  const remainingBytes = config.quotaGib * BYTES_PER_GIB - usedBytes;
  // 速率为零时「还能撑多久」是无穷 —— formatDuration 会把它写成 never，那正是实情。
  const secondsToQuota = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : Infinity;
  const telemetry = {
    lagSeconds, bytesPerSecond, secondsToQuota, stale, unmeasurable: false, instanceState,
    // 两个方向分开带回去。此前这里是 `Math.max(...)` —— 一个数字，而它取的恰好是**乐观**
    // 的那一头，于是一侧管道停摆时日志写的仍然是 `win 6/6`。
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

export default {
  /**
   * 一轮看门狗：先测量，再由数字决定是停机还是启动。
   *
   * 运行时还会传入第三个参数 `ExecutionContext`，这里没有声明它 —— 已经没有需要挂到
   * `waitUntil` 上的后台任务了，handler 返回时该做的事都已经做完。
   *
   * 任何位置抛出的异常都直接向上抛，由 Workers 把这次调用记为失败。那是唯一的错误信号。
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

    // 实例状态每一轮都问一次，和两次月度查询并行发出（零额外延迟）。
    //
    // 此前它是**按需**查的：只在要动手停机/启动、或者数据变旧变没的时候才问，正常路径
    // 完全不问 —— 于是「实例在跑」是从「指标里还有新数据」**推断**出来的。代价是实例停机
    // 后的头十二分钟日志照写 OK，而它从来没问过。
    //
    // 现在不猜：识别实例状态只有一个来源，就是 API。每轮多一次调用（正常路径 4 → 5），
    // 速率仍是 0.008 次/秒，而 Lightsail API 不计费也没有速率配额。省下那次调用换来的是
    // 一段「看起来正常、其实站点已经下线」的窗口，这笔交易不划算。
    const [monthIn, monthOut, instanceState] = await Promise.all([
      sumMetric(client, config, "NetworkIn", range, METRIC_PERIOD_SECONDS),
      sumMetric(client, config, "NetworkOut", range, METRIC_PERIOD_SECONDS),
      getInstanceState(client, config).catch((err) => {
        // 读不出来就是读不出来，绝不退回推断。停机路径本来就把 null 当作「照停」。
        console.error(`${config.label} DEGRADED | instance state unreadable (${err.message})`);
        return null;
      }),
    ]);

    // 虽然只有出向超量才计费，但两个方向都在消耗额度。
    //
    // 按 2^30 换算，使单位体系与 Lightsail `GetBundles` 的 `transferPerMonthInGb` 对齐：
    // 该字段把「1 TB」记为 1024，同一响应里的 `ramSizeInGb: 0.5` 也只可能是 512 MiB，
    // 两处一致地指向 GiB。于是 QUOTA_GIB 可以直接填那个数字，不需要任何换算。
    // 安全裕度不再来自单位错配，改由 THRESHOLD 与突发闸门共同提供。
    // 月度读数的覆盖范围。`sumMetric` 一直在算 newest，此前只有突发窗口用它 ——
    // 但月度查询用的是 period: 86400，桶是一整天。跨模型审计指出：那五条管道假设
    // （尤其「桶必须关闭 + 落库延迟后才可查」）从来只被应用在 300 秒窗口上，从没推广到
    // 月度查询。如果 Lightsail 沿用「只返回已完成周期」的语义，月度读数就对**今天**的
    // 流量全盲，盲区最长 24 小时 —— 比处处精心标定的「10 分钟落库延迟」大两个数量级，
    // 而且此前在日志里零痕迹。
    //
    // 这个检查在两种语义下都正确，而且零额外调用：
    //   返回当天部分聚合 -> newest 就是今天的桶起点，永远不触发；
    //   只返回已关闭的天桶 -> newest 停在昨天，从今天 00:00 起越来越旧，必然触发。
    // 也就是说，它既是修复，又是那个「一次 API 调用就能分辨」的实验 —— 只不过实验在
    // 生产环境里自己跑，第一天就有结论。
    // 同样取最旧的那一个，理由见 burstCheck 里 oldestNewest 的说明。
    const monthWithPoints = [monthIn, monthOut].filter((m) => m.points > 0);
    // 覆盖的**起点**。既有的 monthBehindSeconds 只看最新那一头，另一头从来没人看过 ——
    // 而少掉月初几天同样会让静态线看到一个偏小的总量，方向是漏停。
    //
    // 不为此告警：同一个形状至少有三种成因 —— 实例在本月内才创建（创建之前没有任何指标
    // 历史）、那几天实例没在跑（不产生数据点）、指标真的丢了数据。光看指标分不出它们，
    // 而为前两种误报的代价是让第三种淹没在噪音里。所以只把事实摆进日志。
    const monthOldest =
      monthWithPoints.length > 0 && monthWithPoints.every((m) => m.oldest !== null)
        ? Math.min(...monthWithPoints.map((m) => m.oldest))
        : null;
    const monthNewest =
      monthWithPoints.length > 0 && monthWithPoints.every((m) => m.newest !== null)
        ? Math.min(...monthWithPoints.map((m) => m.newest))
        : -Infinity;

    const usedBytes = monthIn.bytes + monthOut.bytes;
    const usedGib = usedBytes / BYTES_PER_GIB;
    const limitGib = config.quotaGib * config.threshold;

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

    // 月度读数落后得超出了它可能合理落后的程度，说明静态线看的是一份过期的用量。
    //
    // 判据是「落后多久」，**不是**「最新的桶是不是今天」。后者曾经是这里的写法，结果每天
    // 00:00 UTC 那一格必定误报一次：那一刻今天才过了 0 秒，今天的桶当然还不存在，最新的
    // 必然是昨天 —— 而它自己算出来的 behindHours 恰好是 0.0，一边宣布「今天的流量不可见」
    // 一边报告落后零小时。噪音与真实故障同形，是最坏的一种。
    //
    // 换成落后时长之后：00:00 那一格算出来是 0，不响；真出问题时是几小时，照响。
    // 有数据点、却一个可用时间戳都没有 —— 覆盖范围检测整段静默，而这一轮看起来完全正常。
    // 突发路径早就有这条告警，月度路径此前没有。
    if (monthWithPoints.length > 0 && !Number.isFinite(monthNewest)) {
      console.error(
        `${config.label} BLIND | month-to-date has ${monthIn.points + monthOut.points} data points but no usable timestamp` +
          ` | cannot tell whether the reading covers today`,
      );
    }

    const monthBehindSeconds = Number.isFinite(monthNewest)
      ? range.endTime - (monthNewest + METRIC_PERIOD_SECONDS)
      : null;
    // 判据里必须带上实例状态，理由和零读数告警那条**完全一样**，只是当时只修了那一条。
    //
    // 前提：一台合法停着的实例，最新那个天桶会停在它最后跑过的那一天，之后每过一天就多
    // 落后 24 小时。**这一步是推断，不是实测**（不能为了验证去停生产实例），支撑它的是：
    //   - 实测（2026-08-23）：实例存在之后的全部 300 秒数据，两个方向各 4739 个桶，
    //     `sum: 0` 一个都没有（最小 744 字节）；唯一一处缺口两个方向同时消失 —— 这个
    //     管道用**缺席**表达「什么都没有」，不用零值桶。
    //   - Lightsail 自己的文档把缺失数据点当一等概念，并明说 "this can happen when a
    //     connection is lost, or a server goes down"；同一族里还有一条明写的
    //     "Bucket metric data is not reported when your bucket is empty"。
    // 曾经拿「回溯 60 天缺了 42 天」当证据，那是错的：那些天实例根本不存在，没有计量表，
    // 与「停机的实例计量表还在」前提不同。README 里记了这次订正。
    //
    // 不带状态条件的代价（探针复现过）：实例被突发闸门停下、或者操作者自己停机做维护，
    // 从次日 00:20 UTC 起**每一个 cron 周期**都会喊一次「today's traffic is invisible」——
    // 一天约 142 条，一直喊到实例被拉起来或者跨月。而且那句话本身是错的：停机期间今天的
    // 流量不是「不可见」，是根本不存在。这正是 README 里为零读数告警记下来的那个教训 ——
    // 真正的管道故障混在这串噪音里根本看不出来。
    //
    // 加上条件之后：实例在跑（或状态读不出来）而读数没覆盖到今天，仍然照响 —— 那才是
    // 静态线真的在看一份过期用量的情形。
    if (
      monthBehindSeconds !== null &&
      monthBehindSeconds > MONTH_BEHIND_TOLERANCE_SECONDS &&
      meterShouldSeeTraffic(instanceState)
    ) {
      console.error(
        `${config.label} BLIND | month-to-date reading only covers through ${new Date(monthNewest * 1000).toISOString().slice(0, 10)}` +
          ` (${(monthBehindSeconds / 3600).toFixed(1)} h behind)` +
          ` while the instance is ${instanceState === null ? "of unreadable state" : `"${instanceState}"`}` +
          ` | today's traffic is invisible to the static line`,
      );
    }

    // 总量恰为零时不可能存在突发，跳过这两次调用。这也让重启路径的调用次数保持不变。
    let burst = null;
    if (usedBytes > 0) {
      burst = await burstCheck(client, config, range, usedBytes, instanceState);
      if (burst.reason) {
        await stopOverLimit(client, config, usedGib, burst.reason, instanceState);
        return;
      }
    }

    // 每次触发只写一行，行首是可 grep 的状态标记（OK / STOPPED / STARTED / NOOP /
    // HOLD / BLIND / DEGRADED）。`wrangler tail | grep -v " OK "` 就只剩下值得看的事件。
    //
    // 字段各回答一个问题，而且全部是这一轮**已经算出来**的东西，没有额外调用：
    //   used / stop at    —— 我在哪、线在哪
    //   now ... to quota  —— 突发闸门这一轮读到了什么。不露出来的话，它在正常运行里
    //                        完全不可见，没人能确认它还在正常工作。
    //   month / projected —— 照这个月的平均速度，整月会用到多少
    //   meter             —— 上游数据有多新。整套余量标定唯一一个没有文档的输入。
    const common = [formatUsage(config, usedGib), `stop at ${limitGib.toFixed(3)} GiB`];

    if (burst && burst.unmeasurable) {
      // 绝不写成 `now 0 kbps` —— 那是在没有数据的情况下断言「没有流量」。
      common.push("now unknown (no data points in window)");
    } else if (burst && burst.bytesPerSecond !== null) {
      // 速率来自过旧的数据点时必须标出来 —— 上面刚写了一行 BLIND 说它不可信，这里就
      // 不能再把同一个数字摆得和正常读数一样。
      const mark = burst.stale ? " (stale)" : "";
      common.push(`now ${formatRate(burst.bytesPerSecond)}${mark}, ${formatDuration(burst.secondsToQuota)} to quota`);
    }

    const elapsed = monthElapsedFraction(now);
    if (elapsed >= PROJECTION_MIN_ELAPSED) {
      common.push(`month ${(elapsed * 100).toFixed(0)}% elapsed, projected ${(usedGib / elapsed).toFixed(0)} GiB`);
    }

    // 突发窗口实际拿到几个桶。这是 `meter` 真正的替代品：`meter` 量化到一整个 300 秒桶，
    // 而生产的 endTime 恰好落在桶边界上，所以它几乎恒为 0；桶数则一掉就掉一格，有分辨率。
    //
    // 格式是 `win in,out/应有`，**两个方向分开写**。此前是一个数、取两者的较大值，于是
    // NetworkOut 整个管道停摆时这里照写 `win 6/6` —— 取的恰好是乐观的那一头，把闸门只
    // 看得见一半流量这件事盖了过去。宁可让正常那一行多一个字符，也不要一个会说谎的字段。
    if (burst) {
      common.push(`win ${burst.inPoints},${burst.outPoints}/${BURST_WINDOW_SECONDS / BURST_PERIOD_SECONDS}`);
    }

    // 月度读数拿到几个天桶 vs 本月已过几天。差值有正当解释（实例合法停机的日子没有桶），
    // 所以只记录不告警 —— 但月中缺一整天时，至少有人能看见。
    // 同样两个方向分开写，理由同 `win`：取较大值会把「一个方向的月度管道缺了几天」显示
    // 成完整。月度查询按天聚合，一侧缺一整天就是一整天的字节没进静态线的总量。
    const daysElapsed = Math.ceil((range.endTime - range.startTime) / METRIC_PERIOD_SECONDS);
    common.push(`days ${monthIn.points},${monthOut.points}/${daysElapsed}`);

    // 读数没从月初起算时，把真正的起点写出来。`days 16/22` 只说少了六天，不说少的是哪
    // 六天 —— 而「少的是月初连续的六天」和「中间零散缺六天」是完全不同的两件事。
    if (monthOldest !== null && monthOldest > range.startTime) {
      common.push(`covers from ${new Date(monthOldest * 1000).toISOString().slice(0, 10)}`);
    }

    if (burst && burst.lagSeconds !== null) {
      common.push(`meter ${(burst.lagSeconds / 60).toFixed(1)} min behind`);
    }

    if (usedBytes > 0) {
      // 突发闸门可以在用量还没到静态线时就跳闸。停机之后用量不再增长，于是此后每一次
      // 触发都满足 `used < limit`，走的正是这一支 —— 如果无脑写 OK，就会出现「站点已经
      // 下线，而 `grep -v " OK | "` 里什么都没有」。
      //
      // 判据是这一轮**实际问到的**状态，不是「突发闸门恰好查过没有」。
      const down = typeof instanceState === "string" && instanceState !== "running";
      const token = down ? "DOWN" : "OK";
      const tail = down ? [...common, `instance is "${instanceState}"`] : common;
      console.log([`${config.label} ${token}`, ...tail].join(" | "));
      return;
    }

    // 到这里说明月初至今恰为零。下面三个出口各写一行，都带着上面那组共同字段 ——
    // 长期停机的实例每次触发只留一行，而不是「一行 OK + 一行结果」。
    //
    // 重启由用量驱动，而不是由日历驱动。停机只会发生在用量达到或超过阈值时，所以那个月
    // 剩下的时间里用量会一直卡在阈值之上：「重新回到阈值以下」与旧的「1 号」分支想要捕捉
    // 的是同一个事件，却没有它那个仅有 24 小时的窗口。从跨月那一刻起，每一次触发都是
    // 一次新的补救机会。
    //
    // 「恰好零字节」是查询状态的闸门。运行中的实例几分钟内必然产生*某些*流量 —— DNS、
    // NTP、后台扫描 —— 所以月初至今总量为零就意味着它没起来。没有这道闸门，handler 就得
    // 在每个正常日子的每一次触发里都去问一次 GetInstanceState，为了一次重启每月多花
    // 约 4300 次调用。
    // 「月初至今恰为零」有两种成因，此前分不开，于是这条告警只能挂在时间上，把两种都喊：
    //
    //   实例没在跑 —— 这正是零字节闸门的前提，重启路径要的就是它。操作者月中自己停机时，
    //     旧写法会从第 2 小时起每一次触发都误报一次，一直报到月末。
    //   量的那一侧坏了 —— 例如 unit 传错。实测（2026-08-22）：unit 传成 Bits / Count /
    //     Percent / Seconds / Megabytes 中任意一个，AWS 都回 HTTP 200、metricName 正确
    //     回显、metricData 是空数组。sumMetric 的双信号校验对它完全无感，用量读成干净的
    //     0 字节 —— 而 0 是唯一会让看门狗什么都不做的读数。
    //
    // 有了每轮实测的实例状态就不用猜了：跑着的实例几分钟内必然产生流量，所以「running
    // 而读数为零」在物理上不成立，只可能是管道坏了。误报没了，真故障反而被喊得更准。
    //
    // 位置仍在 MANUAL_HOLD 之前：维护期设了 hold 又忘记撤销时，这条兜底不能跟着被吞掉。
    const monthAgeSeconds = range.endTime - range.startTime;
    if (monthAgeSeconds > ZERO_READING_GRACE_SECONDS && meterShouldSeeTraffic(instanceState)) {
      console.error(
        `${config.label} BLIND | ${(monthAgeSeconds / 3600).toFixed(1)} h into the month, month-to-date reads exactly zero` +
          ` while the instance is ${instanceState === null ? "of unreadable state" : `"${instanceState}"`}` +
          ` | a running instance always moves some bytes, so the metric pipeline is what is broken` +
          ` (a wrong unit returns HTTP 200 with an empty array)`,
      );
    }

    if (config.manualHold) {
      console.log([`${config.label} HOLD`, ...common, "MANUAL_HOLD is set, leaving the instance alone"].join(" | "));
      return;
    }

    // 这里不接管 getInstanceState 的异常：与停机路径相反，重启路径上的不确定性应该向
    // 「什么都不做」倾斜 —— 少启动一次只是站点晚几分钟回来，误启动一台操作者刻意停下的
    // 实例则会开始烧流量。
    // 复用这一轮开头查到的状态。读不出来时不启动 —— 重启路径上的不确定性向「什么都不做」
    // 倾斜，误启动一台被刻意停下的实例会开始烧流量。
    if (instanceState === null) {
      console.log([`${config.label} NOOP`, ...common, "instance state unreadable, not starting"].join(" | "));
      return;
    }
    if (instanceState !== "stopped") {
      // 通常是新月份的头几分钟：实例一直没下线，只是还没有任何指标数据点落库。
      console.log([`${config.label} NOOP`, ...common, `instance is "${instanceState}", nothing to do`].join(" | "));
      return;
    }

    await lightsail(client, config, "StartInstance", { instanceName: config.instanceName });
    // 只陈述观察到的事实：handler 知道的是「月初至今为零且实例是 stopped」，它并没有
    // 独立核实过额度重置这件事。
    console.log(
      [`${config.label} STARTED`, ...common, "allowance reads empty and the instance was stopped"].join(" | "),
    );
  },
};
