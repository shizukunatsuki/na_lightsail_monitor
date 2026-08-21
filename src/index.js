import { AwsClient } from "aws4fetch";

/** Lightsail JSON-RPC 的 target 前缀，操作名形如 `${API_TARGET}.${Operation}`。 */
const API_TARGET = "Lightsail_20161128";

/**
 * 「月初至今」查询的数据点秒数。取一天，可以把这个查询控制在每个指标约 31 个数据点；
 * 若改成按小时，会返回约 744 个，光是解析 JSON 就会撑爆 10ms 的 CPU 预算。
 */
const METRIC_PERIOD_SECONDS = 86400;

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
const BURST_WINDOW_SECONDS = 1800;
const BURST_PERIOD_SECONDS = 300;

/**
 * 反应视野：按当前速率剩余额度撑不过这么久，就立刻停机，不等月度总量越过 THRESHOLD。
 *
 * 这个数必须覆盖一整个检测回路 —— cron 间隔（`wrangler.jsonc` 里是 2 分钟）＋ 指标落库
 * 延迟（几分钟）＋ StopInstance 真正断流的时间（约一分钟）。取 30 分钟，是三者之和的
 * 两倍有余。**改动 cron 间隔时必须回来重新审视这个数。**
 *
 * 它同时是闸门唯一的灵敏度旋钮：跳闸判据等价于 `速率 > 剩余额度 / 视野`，所以调大它
 * 会线性地降低触发所需的速率。空表时需要约 4.9 Gbps 才跳闸，用到 800 GiB 时约 1.1 Gbps
 * —— 对一台个人站实例来说，这两个数都远在正常业务之上，误停的风险很小。想更保守就调大
 * 这个数（代价是可能掐掉一次合法的大流量传输），不要去动 BURST_WINDOW_SECONDS。
 */
const REACTION_HORIZON_SECONDS = 1800;

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

  const quotaGib = Number(env.QUOTA_GIB);
  if (!Number.isFinite(quotaGib) || quotaGib <= 0) {
    throw new Error(`QUOTA_GIB must be a positive number, got ${JSON.stringify(env.QUOTA_GIB)}`);
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
    // SigV4 的拒绝响应会回显 credential scope，其中嵌着 access key id，所以要在这条
    // 消息进入日志之前把它抹掉。先脱敏再截断：反过来的话，key 正好横跨 500 字节边界时
    // 会残留半截。
    const detail = (await res.text()).replaceAll(client.accessKeyId, "[redacted]").slice(0, 500);
    throw new Error(`Lightsail ${operation} failed: HTTP ${res.status} ${detail}`);
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
    throw new Error(`GetInstanceState returned no state name for ${config.instanceName}`);
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

  const { metricData } = await res.json();

  // 严格要求它是个数组。成功响应里 `metricData` 一定存在，没有数据时是空数组；字段缺失
  // 或不是数组意味着这份响应读不懂 —— 把它折算成 0 字节，就等于报告「本月没用流量」，
  // 而那是唯一会让看门狗什么都不做的读数。指标侧一次降级，就能让它一边报平安一边放任
  // 实例烧到超额。读不懂就响亮地失败，与 getInstanceState 保持同一种姿态。
  if (!Array.isArray(metricData)) {
    throw new Error(`GetInstanceMetricData returned no metricData array for ${metricName}`);
  }

  // 数据点既不保证有序也不保证连续，所以要累加而不是按下标取值。求总量与顺序无关；
  // 缺口本身就代表那段时间没有流量。
  let bytes = 0;
  let newest = null;
  for (const point of metricData) {
    bytes += point.sum ?? 0;
    // 时间戳走 Unix 秒。非数字就当没有，绝不让一个读不懂的时间戳污染延迟读数。
    if (typeof point.timestamp === "number" && (newest === null || point.timestamp > newest)) {
      newest = point.timestamp;
    }
  }
  return { bytes, points: metricData.length, newest };
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
    console.error(`${config.instanceName}: instance state unreadable (${err.message}); erring toward the stop`);
    return null;
  });

  if (state !== null && state !== "running") {
    console.log(
      `${config.instanceName}: ${usedGib.toFixed(3)} GiB used, ${reason}, but instance is "${state}"; nothing to do`,
    );
    return;
  }

  await lightsail(client, config, "StopInstance", { instanceName: config.instanceName });
  console.error(`${config.instanceName}: STOPPED at ${usedGib.toFixed(3)} GiB month-to-date, ${reason}`);
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
 * @returns {Promise<{ reason: string | null, lagSeconds: number | null }>}
 *   `reason` 非空表示需要停机；`lagSeconds` 是实测的落库延迟，测不出时为 null
 */
async function burstCheck(client, config, monthRange, usedBytes) {
  const { endTime } = monthRange;
  const startTime = Math.max(monthRange.startTime, endTime - BURST_WINDOW_SECONDS);

  // 跨月后的头几分钟，窗口会短于一个数据点，测不出速率。那时月度用量也必然离额度极远。
  if (endTime - startTime < BURST_PERIOD_SECONDS) return { reason: null, lagSeconds: null };

  const range = { startTime, endTime };
  const [recentIn, recentOut] = await Promise.all([
    sumMetric(client, config, "NetworkIn", range, BURST_PERIOD_SECONDS),
    sumMetric(client, config, "NetworkOut", range, BURST_PERIOD_SECONDS),
  ]);

  // 分母取「实际落库的点数 × 粒度」，理由见 sumMetric 里 points 的说明。
  //
  // 一个点都没有时静默放行，不报警：能走到这里说明月度查询是有字节数的，也就是指标 API
  // 本身在正常工作（真坏了会在 sumMetric 那里抛错，或者月度也读到 0 从而根本不进闸门）。
  // 所以「最近半小时没有数据点」只可能意味着实例本来就没在跑 —— 那是操作者月中自己停的，
  // 每两分钟报一次警只会制造噪音。
  const covered = Math.max(recentIn.points, recentOut.points) * BURST_PERIOD_SECONDS;

  // 实测落库延迟：最新那个桶覆盖 [newest, newest + 300)，它已经能查到，所以延迟就是
  // 「此刻」减去那个桶的结束时刻。桶还开着时会算出负数，钳到 0 —— 那表示数据是新鲜的。
  const newest = Math.max(recentIn.newest ?? -Infinity, recentOut.newest ?? -Infinity);
  const lagSeconds = Number.isFinite(newest)
    ? Math.max(0, endTime - (newest + BURST_PERIOD_SECONDS))
    : null;

  // 延迟吃掉窗口后，闸门可用的数据点就不足两个，速率估计随之失去意义。这不是猜测能
  // 覆盖的事，所以一旦发生就必须响亮地说出来：此刻真正在守账单的只剩静态线。
  if (lagSeconds !== null && lagSeconds >= BURST_WINDOW_SECONDS - 2 * BURST_PERIOD_SECONDS) {
    console.error(
      `${config.instanceName}: metric lag is ${(lagSeconds / 60).toFixed(1)} min, leaving under two usable buckets in the ${BURST_WINDOW_SECONDS / 60} min burst window; the burst gate is losing resolution`,
    );
  }

  const bytesPerSecond = covered > 0 ? (recentIn.bytes + recentOut.bytes) / covered : 0;
  if (bytesPerSecond <= 0) return { reason: null, lagSeconds };

  const remainingBytes = config.quotaGib * BYTES_PER_GIB - usedBytes;
  const secondsToQuota = remainingBytes / bytesPerSecond;
  if (secondsToQuota >= REACTION_HORIZON_SECONDS) return { reason: null, lagSeconds };

  const mbps = (bytesPerSecond * 8) / 1e6;
  return {
    reason:
      `burning ${mbps.toFixed(1)} Mbps with ${(remainingBytes / BYTES_PER_GIB).toFixed(3)} GiB of quota left` +
      ` = ${Math.round(secondsToQuota / 60)} min to overage, inside the ${REACTION_HORIZON_SECONDS / 60} min reaction horizon`,
    lagSeconds,
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
      // 首次尝试之外再重试两次（仅限 5xx 和 429）。下一次触发在两分钟后，这个次数足够了，
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
    let meter = "";
    if (usedBytes > 0) {
      const burst = await burstCheck(client, config, range, usedBytes);
      if (burst.reason) {
        await stopOverLimit(client, config, usedGib, burst.reason);
        return;
      }
      // 把实测的落库延迟写进正常那一行。它是整套余量标定唯一一个来自上游、又没有文档
      // 的输入，所以它必须每次都出现在眼前，而不是留作一个假设。
      if (burst.lagSeconds !== null) meter = `, meter ${(burst.lagSeconds / 60).toFixed(1)} min behind`;
    }

    console.log(
      `${config.instanceName}: ${usedGib.toFixed(3)} GiB used month-to-date, under the ${limitGib.toFixed(3)} GiB stop threshold${meter}`,
    );

    // 重启由用量驱动，而不是由日历驱动。停机只会发生在用量达到或超过阈值时，所以那个月
    // 剩下的时间里用量会一直卡在阈值之上：「重新回到阈值以下」与旧的「1 号」分支想要捕捉
    // 的是同一个事件，却没有它那个仅有 24 小时的窗口。从跨月那一刻起，每一次触发都是
    // 一次新的补救机会。
    //
    // 「恰好零字节」是查询状态的闸门。运行中的实例几分钟内必然产生*某些*流量 —— DNS、
    // NTP、后台扫描 —— 所以月初至今总量为零就意味着它没起来。没有这道闸门，handler 就得
    // 在每个正常日子的每一次触发里都去问一次 GetInstanceState，为了一次重启每月多花
    // 约两万次调用。
    if (usedBytes > 0) return;

    if (config.manualHold) {
      console.log(
        `${config.instanceName}: no transfer recorded this month, but MANUAL_HOLD is set; leaving it alone`,
      );
      return;
    }

    // 这里不接管 getInstanceState 的异常：与停机路径相反，重启路径上的不确定性应该向
    // 「什么都不做」倾斜 —— 少启动一次只是站点晚几分钟回来，误启动一台操作者刻意停下的
    // 实例则会开始烧流量。
    const state = await getInstanceState(client, config);
    if (state !== "stopped") {
      // 通常是新月份的头几分钟：实例一直没下线，只是还没有任何指标数据点落库。
      console.log(`${config.instanceName}: no transfer recorded this month, instance is "${state}"; nothing to do`);
      return;
    }

    await lightsail(client, config, "StartInstance", { instanceName: config.instanceName });
    // 只陈述观察到的事实：handler 知道的是「月初至今为零且实例是 stopped」，它并没有
    // 独立核实过额度重置这件事。
    console.log(`${config.instanceName}: no transfer recorded this month and instance was stopped; started`);
  },
};
