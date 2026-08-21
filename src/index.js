import { AwsClient } from "aws4fetch";

/** Lightsail JSON-RPC 的 target 前缀，操作名形如 `${API_TARGET}.${Operation}`。 */
const API_TARGET = "Lightsail_20161128";

/**
 * 「月初至今」查询的数据点秒数。取一天，可以把这个查询控制在每个指标约 31 个数据点；
 * 若改成按小时，会返回约 744 个，光是解析 JSON 就会撑爆 10ms 的 CPU 预算。
 */
export const METRIC_PERIOD_SECONDS = 86400;

/**
 * 突发闸门的观察窗口与粒度：最近半小时，300 秒一个点。300 秒是 Lightsail 的原生上报
 * 粒度，取得再细也不会有更多信息。
 *
 * 窗口长度是被**稀释**和**落库延迟**两头夹出来的，不是随手取的整数：
 *
 * - 太长会稀释。速率是窗口内的平均值，所以一场刚开始 5 分钟的突发，在一小时的窗口里
 *   只显出真实速率的十二分之一。可以证明闸门会在「距离额度耗尽还剩 H/(H+W−L)」处跳闸
 *   （W 窗口、H 视野、L 落库延迟），与速率无关：W=60 分钟时要等耗尽进度走完 63% 才跳，
 *   5 Gbps 下只剩 7 分钟余量；W=30 分钟时 40% 就跳，余量 11.6 分钟。
 * - 太短会瞎。窗口整个落在落库延迟的阴影里就一个数据点都没有，闸门直接失效。W=20 分钟
 *   在延迟 20 分钟时归零；W=30 分钟即便延迟到 20 分钟仍有 2 个点。
 *
 * 30 分钟是这两条曲线的交点。**它只影响反应快慢，不影响灵敏度**——跳闸判据
 * `速率 > 剩余额度 / 视野` 里没有 W，所以缩短窗口不会让闸门更容易误报。
 */
export const BURST_WINDOW_SECONDS = 1800;
export const BURST_PERIOD_SECONDS = 300;

/**
 * 反应视野：按当前速率剩余额度撑不过这么久，就立刻停机，不等月度总量越过 THRESHOLD。
 *
 * 这个数必须覆盖一整个检测回路 —— 桶必须先关闭（≤ 300 秒）＋ 指标落库延迟 ＋ cron 间隔
 * （`wrangler.jsonc` 里是 10 分钟）＋ StopInstance 真正断流的时间（约一分钟）。按落库延迟
 * 10 分钟算，回路是 26 分钟，取 60 分钟得到 2.3 倍余量。
 *
 * **改动 cron 间隔时必须回来重新审视这个数。** cron 是回路里最大的一项：两分钟一次时
 * 回路只有 18 分钟，30 分钟的视野就够了；改成十分钟一次之后回路变成 26 分钟，同样的
 * 30 分钟只剩 1.15 倍余量，而落库延迟一旦到 15 分钟就直接跌破 1.0 —— 额度会在闸门能
 * 动手之前烧完。（cron 表达式不写在这里：`*` 加 `/` 会把这段块注释提前闭合。）
 *
 * 它同时是闸门唯一的灵敏度旋钮：跳闸判据等价于 `速率 > 剩余额度 / 视野`，所以调大它
 * 会线性地降低触发所需的速率。60 分钟意味着空表时要约 2.4 Gbps、用到 800 GiB 时约
 * 534 Mbps 才跳闸 —— 对一台个人站实例，这两个数仍然远在正常业务之上。想更保守就继续
 * 调大这个数（代价是可能掐掉一次合法的大流量传输），不要去动 BURST_WINDOW_SECONDS。
 */
export const REACTION_HORIZON_SECONDS = 3600;

/**
 * 指标落库延迟的容忍上限。超过它就报警 —— 此时突发闸门已经追不上一场满速突发了。
 *
 * **这个数是从检测回路推出来的，不是从观察窗口推出来的。** 两者管的是不同的事：窗口管
 * 分辨率（够不够几个数据点算速率），回路管及时性（跳闸时还剩多少额度）。
 *
 * 推导用的是和视野同一条规则 —— 回路必须留在视野的一半以内（即 2 倍余量）：回路里除
 * 延迟之外的固定部分是 桶关闭 300 + cron 600 + 停机生效 60 = 960 秒，于是延迟上限是
 * 3600/2 − 960 = 840 秒。取 12 分钟，比这个上限再早一点，也比「5 Gbps 下真的守不住」
 * 的经验临界点（16 分钟）早四分钟。`test/tuning.test.js` 会把这条关系钉住。
 *
 * 早先这个门槛写成 `BURST_WINDOW_SECONDS - 2 * BURST_PERIOD_SECONDS`（20 分钟）。cron 是
 * 两分钟一次时临界点在 25 分钟，20 分钟的告警是**提前**的，没问题；cron 放宽到十分钟
 * 之后临界点降到 16 分钟，同一个 20 分钟就变成了**迟到四分钟**的告警 —— 延迟落在
 * [16, 20) 分钟这一段时，设计已经失效而没有任何提示。所以它必须跟着 cron 和视野一起
 * 复核，而不能挂在窗口上。
 */
export const MAX_TOLERABLE_LAG_SECONDS = 720;

/** `wrangler.jsonc` 中需要操作者自行填写的变量所使用的占位值。 */
const PLACEHOLDER = "CHANGE_ME";

/**
 * 一个 GiB 的字节数（2^30）。整套单位体系都以它为基准，与 Lightsail `GetBundles` 返回的
 * `transferPerMonthInGb` 对齐 —— 详见下面 `scheduled` 里的换算注释。
 */
const BYTES_PER_GIB = 1024 ** 3;

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

  // 上界不是随手定的：超过它之后 `quotaGib * BYTES_PER_GIB` 就落到 Number 的安全整数
  // 范围之外，字节比较开始丢精度；再大一点直接溢出成 Infinity，于是停机线变成一个永远
  // 够不到的数 —— 一个看起来在跑、实际上什么都不做的看门狗。这正是 THRESHOLD 那条上界
  // 要防的东西，QUOTA_GIB 此前却没有对应的防护。
  //
  // 8 PiB/月大约是 Lightsail 最大套餐的四千倍，不会误伤任何真实配置。
  const MAX_QUOTA_GIB = Number.MAX_SAFE_INTEGER / BYTES_PER_GIB;
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
 * 月初的头几个小时里，「月初至今」的样本太短，外推出来的整月用量会剧烈跳动。
 * 走过这个比例（约 15 小时）之前不给预测，宁可少一个字段也不给一个会误导人的数。
 */
const PROJECTION_MIN_ELAPSED = 0.02;

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
  if (seconds < 48 * 3600) return `${(seconds / 3600).toFixed(1)} h`;
  // 超过 90 天就没有区分意义了 —— 额度每月都会重置，「还能撑 5317 天」只是噪音。
  if (seconds > 90 * 86400) return "> 90 d";
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
  const endTime = Math.max(Math.floor(now.getTime() / 1000), startTime + 60);
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
 * @returns {Promise<{ bytes: number, points: number, newest: number | null }>}
 */
async function sumMetric(client, config, metricName, range, period) {
  const res = await lightsail(client, config, "GetInstanceMetricData", {
    instanceName: config.instanceName,
    metricName,
    period,
    startTime: range.startTime,
    endTime: range.endTime,
    unit: "Bytes",
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
  for (const point of points) {
    if (point === null || typeof point !== "object") {
      throw new Error(`GetInstanceMetricData returned a non-object data point for ${metricName}`);
    }

    // `sum` 缺席是允许的（那个桶没有这个统计量，按零算）；但只要它出现，就必须是一个
    // 有限的非负数字。这里不是洁癖：`bytes += "500"` 会走字符串拼接，两个 500 GiB 的桶
    // 会被读成 0.005 GiB —— 少报几个数量级，而少报正是唯一会让看门狗什么都不做的方向。
    // 负数同理。读不懂就抛错，与本函数其余部分保持同一种姿态。
    const sum = point.sum ?? 0;
    if (typeof sum !== "number" || !Number.isFinite(sum) || sum < 0) {
      throw new Error(
        `GetInstanceMetricData returned an unusable sum for ${metricName}: ${JSON.stringify(point.sum)}`,
      );
    }
    bytes += sum;

    // 时间戳走 Unix 秒。非数字就当没有，绝不让一个读不懂的时间戳污染延迟读数。
    if (typeof point.timestamp === "number" && (newest === null || point.timestamp > newest)) {
      newest = point.timestamp;
    }
  }
  return { bytes, points: points.length, newest };
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
 */
async function stopOverLimit(client, config, usedGib, reason) {
  const state = await getInstanceState(client, config).catch((err) => {
    console.error(`${config.label} DEGRADED | instance state unreadable (${err.message}) | erring toward the stop`);
    return null;
  });

  if (state !== null && state !== "running") {
    console.log(
      `${config.label} NOOP | ${formatUsage(config, usedGib)} | ${reason} | instance is "${state}", nothing to do`,
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
 * @param {AwsClient} client
 * @param {Config} config
 * 同时顺带实测指标的落库延迟 —— 这个数 AWS 不公开，而整套余量标定都建立在它之上。
 *
 * @param {{ startTime: number, endTime: number }} monthRange
 * @param {number} usedBytes 月初至今总量，字节
 * @returns {Promise<{ reason: string | null, lagSeconds: number | null,
 *   bytesPerSecond: number | null, secondsToQuota: number | null }>}
 *   `reason` 非空表示需要停机。其余几项是这一轮算出来的遥测，**不跳闸时也要带回去** ——
 *   否则闸门在正常运行里完全不可见，没人能确认它是不是还在正常工作。`stale` 表示这个
 *   速率是从过旧的数据点算出来的，日志里必须标出来，不能让它看起来和正常读数一样可信。
 */
async function burstCheck(client, config, monthRange, usedBytes) {
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
  const rateOf = (metric) =>
    metric.points > 0 ? metric.bytes / (metric.points * BURST_PERIOD_SECONDS) : 0;
  const bytesPerSecond = rateOf(recentIn) + rateOf(recentOut);

  // 实测落库延迟：最新那个桶覆盖 [newest, newest + 300)，它已经能查到，所以延迟就是
  // 「此刻」减去那个桶的结束时刻。桶还开着时会算出负数，钳到 0 —— 那表示数据是新鲜的。
  const newest = Math.max(recentIn.newest ?? -Infinity, recentOut.newest ?? -Infinity);
  const lagSeconds = Number.isFinite(newest)
    ? Math.max(0, endTime - (newest + BURST_PERIOD_SECONDS))
    : null;

  // 数据老到超过容忍上限时，突发闸门已经给不出它承诺的那个保证，这一轮真正在守账单的
  // 只剩静态线 —— 必须说出来。
  //
  // 措辞只陈述观察到的事实，不替它选解释：「最新的桶很旧」在指标侧延迟和实例根本没在
  // 跑这两种情况下长得一模一样，光看指标分辨不了（真跑着就会有新桶落下来）。所以两种
  // 读法都写进去。操作者月中自己停机时这条会连报几次直到那个桶滑出窗口，这是可以接受
  // 的代价：漏掉一次真的指标失明要糟糕得多。
  const stale = lagSeconds !== null && lagSeconds >= MAX_TOLERABLE_LAG_SECONDS;
  if (stale) {
    console.error(
      `${config.label} BLIND | newest metric bucket is ${(lagSeconds / 60).toFixed(1)} min old, past the ${MAX_TOLERABLE_LAG_SECONDS / 60} min tolerance | the burst gate can no longer outrun a full-rate burst this run (meter lagging, or the instance is not running)`,
    );
  }

  const remainingBytes = config.quotaGib * BYTES_PER_GIB - usedBytes;
  // 速率为零时「还能撑多久」是无穷 —— formatDuration 会把它写成 never，那正是实情。
  const secondsToQuota = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : Infinity;
  const telemetry = { lagSeconds, bytesPerSecond, secondsToQuota, stale };

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
      // 首次尝试之外再重试两次（仅限 5xx 和 429）。下一次触发在十分钟后，这个次数足够了，
      // 同时也能让故障及时暴露出来。
      retries: 2,
    });

    // 用调度时间而非墙上时钟：它精确落在 cron 的时间格上，所以即便调用被延迟或重试，
    // 评估的仍然是它当初被触发的那一格。
    const now = new Date(controller.scheduledTime ?? Date.now());

    const range = usageWindow(now);
    const [monthIn, monthOut] = await Promise.all([
      sumMetric(client, config, "NetworkIn", range, METRIC_PERIOD_SECONDS),
      sumMetric(client, config, "NetworkOut", range, METRIC_PERIOD_SECONDS),
    ]);

    // 虽然只有出向超量才计费，但两个方向都在消耗额度。
    //
    // 按 2^30 换算，使单位体系与 Lightsail `GetBundles` 的 `transferPerMonthInGb` 对齐：
    // 该字段把「1 TB」记为 1024，同一响应里的 `ramSizeInGb: 0.5` 也只可能是 512 MiB，
    // 两处一致地指向 GiB。于是 QUOTA_GIB 可以直接填那个数字，不需要任何换算。
    // 安全裕度不再来自单位错配，改由 THRESHOLD 与突发闸门共同提供。
    const usedBytes = monthIn.bytes + monthOut.bytes;
    const usedGib = usedBytes / BYTES_PER_GIB;
    const limitGib = config.quotaGib * config.threshold;

    if (usedGib >= limitGib) {
      await stopOverLimit(
        client,
        config,
        usedGib,
        `over the ${limitGib.toFixed(3)} GiB stop threshold (${config.quotaGib} GiB quota x ${config.threshold})`,
      );
      return;
    }

    // 总量恰为零时不可能存在突发，跳过这两次调用。这也让重启路径的调用次数保持不变。
    let burst = null;
    if (usedBytes > 0) {
      burst = await burstCheck(client, config, range, usedBytes);
      if (burst.reason) {
        await stopOverLimit(client, config, usedGib, burst.reason);
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

    if (burst && burst.bytesPerSecond !== null) {
      // 速率来自过旧的数据点时必须标出来 —— 上面刚写了一行 BLIND 说它不可信，这里就
      // 不能再把同一个数字摆得和正常读数一样。
      const mark = burst.stale ? " (stale)" : "";
      common.push(`now ${formatRate(burst.bytesPerSecond)}${mark}, ${formatDuration(burst.secondsToQuota)} to quota`);
    }

    const elapsed = monthElapsedFraction(now);
    if (elapsed >= PROJECTION_MIN_ELAPSED) {
      common.push(`month ${(elapsed * 100).toFixed(0)}% elapsed, projected ${(usedGib / elapsed).toFixed(0)} GiB`);
    }

    if (burst && burst.lagSeconds !== null) {
      common.push(`meter ${(burst.lagSeconds / 60).toFixed(1)} min behind`);
    }

    if (usedBytes > 0) {
      console.log([`${config.label} OK`, ...common].join(" | "));
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
    if (config.manualHold) {
      console.log([`${config.label} HOLD`, ...common, "MANUAL_HOLD is set, leaving the instance alone"].join(" | "));
      return;
    }

    // 这里不接管 getInstanceState 的异常：与停机路径相反，重启路径上的不确定性应该向
    // 「什么都不做」倾斜 —— 少启动一次只是站点晚几分钟回来，误启动一台操作者刻意停下的
    // 实例则会开始烧流量。
    const state = await getInstanceState(client, config);
    if (state !== "stopped") {
      // 通常是新月份的头几分钟：实例一直没下线，只是还没有任何指标数据点落库。
      console.log([`${config.label} NOOP`, ...common, `instance is "${state}", nothing to do`].join(" | "));
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
