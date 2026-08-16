import { AwsClient } from "aws4fetch";

/** Lightsail JSON-RPC 的 target 前缀，操作名形如 `${API_TARGET}.${Operation}`。 */
const API_TARGET = "Lightsail_20161128";

/**
 * 每个指标数据点的秒数。取一天，可以把「月初至今」的查询控制在每个指标约 31 个
 * 数据点；若改成按小时，会返回约 744 个，光是解析 JSON 就会撑爆 10ms 的 CPU 预算。
 */
const METRIC_PERIOD_SECONDS = 86400;

/** `wrangler.jsonc` 中需要操作者自行填写的变量所使用的占位值。 */
const PLACEHOLDER = "CHANGE_ME";

/**
 * @typedef {object} Config
 * @property {string} region
 * @property {string} instanceName
 * @property {number} quotaGb
 * @property {number} threshold
 * @property {boolean} manualHold
 */

/**
 * 前置校验配置，任何缺失或无法解析的值都直接报错退出。若不校验，QUOTA_GB 写错会让
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

  // 仓库自带的占位值是非空的，所以上面那道检查会放行它，之后每次触发都会在
  // Lightsail 侧失败。留在日志里的就是每天 144 条干巴巴的 404，很难让人立刻意识到
  //「你压根没填实例名」。所以在这里直接把话说清楚。
  //
  // 刻意使用精确比较：真有实例就叫 `change_me_later`，那是别人正经的实例名，不能拦。
  for (const name of ["AWS_REGION", "INSTANCE_NAME"]) {
    if (env[name] === PLACEHOLDER) {
      throw new Error(`${name} is still the placeholder "${PLACEHOLDER}"; set it in wrangler.jsonc`);
    }
  }

  const quotaGb = Number(env.QUOTA_GB);
  if (!Number.isFinite(quotaGb) || quotaGb <= 0) {
    throw new Error(`QUOTA_GB must be a positive number, got ${JSON.stringify(env.QUOTA_GB)}`);
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
    quotaGb,
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
    // 消息进入日志之前把它抹掉。
    const detail = (await res.text()).slice(0, 500).replaceAll(client.accessKeyId, "[redacted]");
    throw new Error(`Lightsail ${operation} failed: HTTP ${res.status} ${detail}`);
  }
  return res;
}

/**
 * 实例当前的状态名，例如 "running" / "stopped"。
 *
 * 响应无法识别时抛错，而不是返回 undefined：停机路径把「不是 running」当作无事可做，
 * 所以一个悄悄缺失的状态会导致此后每一次触发都放任实例超额运行下去。
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
 * 单个指标的月初至今总量，单位字节。
 * @param {AwsClient} client
 * @param {Config} config
 * @param {"NetworkIn" | "NetworkOut"} metricName
 * @param {{ startTime: number, endTime: number }} range
 * @returns {Promise<number>}
 */
async function sumMetric(client, config, metricName, range) {
  const res = await lightsail(client, config, "GetInstanceMetricData", {
    instanceName: config.instanceName,
    metricName,
    period: METRIC_PERIOD_SECONDS,
    startTime: range.startTime,
    endTime: range.endTime,
    unit: "Bytes",
    statistics: ["Sum"],
  });

  const { metricData } = await res.json();

  // 数据点既不保证有序也不保证连续，所以要累加而不是按下标取值。求总量与顺序无关；
  // 缺口本身就代表那段时间没有流量。
  let total = 0;
  for (const point of metricData ?? []) total += point.sum ?? 0;
  return total;
}

/**
 * 一轮看门狗：先测量，再由数字决定是停机还是启动。
 *
 * @param {ScheduledController} controller
 * @param {Record<string, string | undefined>} env
 * @param {ExecutionContext} ctx
 */
async function runWatchdog(controller, env, ctx) {
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
  const [inBytes, outBytes] = await Promise.all([
    sumMetric(client, config, "NetworkIn", range),
    sumMetric(client, config, "NetworkOut", range),
  ]);

  // 虽然只有出向超量才计费，但两个方向都在消耗额度。除以 10^9 而不是 2^30：多算一点
  // 会让实例稍微提前停机，对一个账单护栏来说，这正是应该犯错的方向。
  const usedGb = (inBytes + outBytes) / 1e9;
  const limitGb = config.quotaGb * config.threshold;

  if (usedGb >= limitGb) {
    // 越线了。先查状态，这样第二次触发绝不会对一个已停机的实例再发一次停机。
    const state = await getInstanceState(client, config);
    if (state !== "running") {
      console.log(
        `${config.instanceName}: ${usedGb.toFixed(3)} GB used, over threshold but instance is "${state}"; nothing to do`,
      );
      return;
    }

    await lightsail(client, config, "StopInstance", { instanceName: config.instanceName });
    console.error(
      `${config.instanceName}: STOPPED at ${usedGb.toFixed(3)} GB month-to-date, over the ${limitGb.toFixed(3)} GB stop threshold (${config.quotaGb} GB quota x ${config.threshold})`,
    );
    return;
  }

  console.log(
    `${config.instanceName}: ${usedGb.toFixed(3)} GB used month-to-date, under the ${limitGb.toFixed(3)} GB stop threshold`,
  );

  // 重启由用量驱动，而不是由日历驱动。停机只会发生在用量达到或超过阈值时，所以那个月
  // 剩下的时间里用量会一直卡在阈值之上：「重新回到阈值以下」与旧的「1 号」分支想要捕捉
  // 的是同一个事件，却没有它那个仅有 24 小时的窗口。从跨月那一刻起，每一次触发都是
  // 一次新的补救机会。
  //
  // 「恰好零字节」是查询状态的闸门。运行中的实例几分钟内必然产生*某些*流量 —— DNS、
  // NTP、后台扫描 —— 所以月初至今总量为零就意味着它没起来。没有这道闸门，handler 就得
  // 在每个正常日子的每一次触发里都去问一次 GetInstanceState，为了一次重启每月多花
  // 约 4300 次调用。
  if (inBytes + outBytes > 0) return;

  if (config.manualHold) {
    console.log(
      `${config.instanceName}: no transfer recorded this month, but MANUAL_HOLD is set; leaving it alone`,
    );
    return;
  }

  const state = await getInstanceState(client, config);
  if (state !== "stopped") {
    // 通常是新月份的头几分钟：实例一直没下线，只是还没有任何指标数据点落库。
    console.log(`${config.instanceName}: no transfer recorded this month, instance is "${state}"; nothing to do`);
    return;
  }

  await lightsail(client, config, "StartInstance", { instanceName: config.instanceName });
  console.log(`${config.instanceName}: transfer allowance has reset, instance started`);
}

export default {
  /**
   * @param {ScheduledController} controller
   * @param {Record<string, string | undefined>} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(controller, env, ctx) {
    await runWatchdog(controller, env, ctx);
  },
};
