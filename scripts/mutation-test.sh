#!/usr/bin/env bash
# 变异测试：往代码里注入已知缺陷，看测试会不会变红。
#
# 存在的理由：「测试通过」证明不了测试有用。两类反例都很常见 ——
# 打桩把上游的**合法**响应当成畸形响应（夹具和断言互相印证同一个错误假设，全绿而代码是
# 错的），以及性质测试跑得很热闹却抓不到任何注入的缺陷。能抓住缺陷才是唯一的证据。
#
# 三条纪律。它们防的都是同一种失效：**检测器自己坏了，却静默地一律输出「通过」**。
#   1. 全程在临时副本里操作，绝不碰工作区 —— 中途一次中断就会把 `if (false && ...)`
#      这样的变异留在 src 里，然后被提交上去。
#   2. 先跑对照组：不做任何变异时必须是绿的。否则「全部变异都被抓到」是假的 —— 例如忘了
#      把 wrangler.jsonc 复制进副本，整个套件会在副本里直接报错，于是每一个变异都被误判
#      成「抓到」。
#   3. 检测器自己也要能被检验。三个具体的坑：数失败行数会被 reporter 把同一行打两遍骗到；
#      把 `node --test | grep -q` 放在 `set -o pipefail` 下时，管道返回的是 node 的退出码
#      （测试失败 = 1）而不是 grep 的（找到 = 0），判断整个反过来；用 `^. tests` 匹配多字节
#      的 `ℹ` 永远匹配不上（grep -E 的 `.` 按字节走）。所以先把输出收进变量再判断，直接读
#      汇总里的计数，并强制区分「跑了且通过」「不变量被违反」「根本没跑起来」三种情况。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# wrangler.jsonc 也要带上：tuning.test.js 会读它来核对 cron 与视野的耦合。少复制一个
# 文件的后果是整个套件在副本里报错，于是每个变异都被误判成「抓到」—— 对照组就是为了
# 拦住这种假绿。
cp -R "$ROOT/src" "$ROOT/test" "$ROOT/package.json" "$ROOT/wrangler.jsonc" "$WORK/"
ln -s "$ROOT/node_modules" "$WORK/node_modules"
cd "$WORK"

export INVARIANT_CASES="${INVARIANT_CASES:-500}"
SURVIVORS=0

# 0 = 变异被抓到；1 = 变异存活；2 = 测试根本没跑起来（检测器不可信，必须中止）
#
# 判据直接读汇总里的 `tests N` / `fail N` 计数，不依赖 reporter 的任何字形 ——
# `ℹ` 和 `✔` 都是多字节字符，而 grep -E 的 `.` 按字节匹配，`^. tests` 这种写法会
# 永远匹配不上，于是每次都被当成「测试没跑起来」。
detect() {
  local out ran failed
  # 跑**整个**套件，不只是性质测试 —— 例子测试和性质测试各自能抓到的缺陷并不重合，
  # 只跑一层等于给另一层的覆盖打了白条。
  out="$(node --test 2>&1)" || true
  ran="$(grep -oE 'tests [0-9]+' <<<"$out" | head -1 | grep -oE '[0-9]+')"
  if [ -z "$ran" ] || [ "$ran" -eq 0 ]; then
    echo "检测器异常：测试没有跑起来" >&2
    tail -n 8 <<<"$out" >&2
    return 2
  fi
  failed="$(grep -oE 'fail [0-9]+' <<<"$out" | head -1 | grep -oE '[0-9]+')"
  [ "${failed:-0}" -gt 0 ]
}

# 变异目标跨两个源文件：默认打 src/index.js，`--in <路径>` 换到 src/tuning.js。
# **每次都从原始 src 整目录恢复**，不要只恢复一个文件 —— 否则打在另一个文件上的变异会
# 残留到下一轮，于是「谁抓到了什么」全部作废。
mutate() {
  local file="src/index.js"
  if [ "$1" = "--in" ]; then file="$2"; shift 2; fi
  cp -R "$ROOT/src/." src/
  # 锚点必须在目标文件里**恰好命中一次**。命中 0 次说明源码改过而锚点没跟着改；命中
  # 多次说明锚点不够独特，替换会波及别处。两种都必须计为存活 —— 一个施加不上去的变异
  # 什么也没验证。把命中次数打出来：不打的话，锚点漂移和锚点不唯一在输出里长得一样。
  local why
  if ! why="$(python3 -c "
import sys, pathlib
p = pathlib.Path(sys.argv[3]); s = p.read_text()
n = s.count(sys.argv[1])
if n != 1:
    sys.stderr.write('锚点命中 %d 次（应为 1 次）' % n)
    raise SystemExit(1)
p.write_text(s.replace(sys.argv[1], sys.argv[2]))" "$1" "$2" "$file" 2>&1 >/dev/null)"; then
    echo "  ?? 变异未应用  $3  —— ${why:-未知原因}"; SURVIVORS=$((SURVIVORS + 1)); return
  fi
  detect; local r=$?
  case "$r" in
    0) echo "  抓到 ✓        $3" ;;
    1) echo "  漏过 ✗        $3"; SURVIVORS=$((SURVIVORS + 1)) ;;
    *) echo "  检测器异常 !!  $3"; SURVIVORS=$((SURVIVORS + 1)) ;;
  esac
}

cp -R "$ROOT/src/." src/
detect; CONTROL=$?
if [ "$CONTROL" -eq 2 ]; then echo "对照组：测试跑不起来，检测器不可信"; exit 1; fi
if [ "$CONTROL" -eq 0 ]; then echo "对照组失败：干净的代码也报红"; exit 1; fi
echo "对照组: 干净代码通过、未被误报 ✓"; echo

mutate "if (usedGib >= limitGib) {" "if (usedGib > limitGib) {" "静态线 >= 改成 >（边界漏停）"
mutate "const bytesPerSecond = rateOf(recentIn) + rateOf(recentOut);" \
       "const bytesPerSecond = (recentIn.bytes + recentOut.bytes) / (Math.max(recentIn.points, recentOut.points) * BURST_PERIOD_SECONDS);" \
       "速率改回共同分母（漏停）"
mutate "      burst = await burstCheck(client, config, range, usedBytes, instanceState);" \
       "      burst = { reason: null, lagSeconds: null, bytesPerSecond: null, secondsToQuota: null, stale: false };" \
       "整个跳过突发闸门"
mutate 'if (state !== null && state !== "running") {' 'if (state !== null && state === "running") {' "反转停机的状态判断"
# 把「自动启动」加回来。这个看门狗只停机、永远不启动实例（IAM 策略里也没有这个权限），
# 而「多做一个动作」这类缺陷变异测试通常抓不到 —— 必须显式注入一次，确认会红。
mutate "    const down = typeof instanceState === \"string\" && instanceState !== \"running\";" \
       "    if (usedBytes === 0 && instanceState === \"stopped\") await lightsail(client, config, \"StartInstance\", { instanceName: config.instanceName });
    const down = typeof instanceState === \"string\" && instanceState !== \"running\";" \
       "把自动启动加回来（额度归零就把实例拉起来）"
mutate "      getInstanceState(client, config).catch((err) => {" \
       '      Promise.resolve("stopped").then((v) => v).catch((err) => {' \
       "状态查询被换成写死的 stopped（越线时会写 DOWN 而不是真的停机）"
mutate "const now = new Date(controller.scheduledTime ?? Date.now());" "const now = new Date(Date.now());" "忽略 scheduledTime 改用墙上时钟"
mutate 'for (const secret of [client.accessKeyId, client.secretAccessKey]) {' \
       'for (const secret of [client.accessKeyId]) {' "只脱敏 access key id，漏掉 secret"
mutate "if (metricData != null && !Array.isArray(metricData)) {" "if (false) {" "去掉畸形 metricData 检查"
mutate 'if (typeof sum !== "number" || !Number.isFinite(sum) || sum < 0) {' "if (false) {" "去掉 sum 的类型检查"
mutate "|| quotaGib > MAX_QUOTA_GIB" "" "去掉 QUOTA_GIB 上界"
mutate "bytes += sum;" "bytes += 0;" "月度用量恒为零"
# 比较符号写反 —— 单点看着正常，只有把两个点排起来（单调性）才露馅
mutate "if (usedGib >= limitGib) {" "if (usedGib <= limitGib) {" "静态线比较符号写反"
mutate "if (secondsToQuota >= REACTION_HORIZON_SECONDS) return { reason: null, ...telemetry };" \
       "if (secondsToQuota <= REACTION_HORIZON_SECONDS) return { reason: null, ...telemetry };" \
       "突发闸门比较符号写反"
# 告警门槛改成「从观察窗口推」：cron 十分钟下它会迟到四分钟
mutate "lagSeconds >= MAX_TOLERABLE_LAG_SECONDS" \
       "lagSeconds >= BURST_WINDOW_SECONDS - 2 * BURST_PERIOD_SECONDS" \
       "延迟告警门槛退回按窗口推导（迟到）"
# 调参常量之间的耦合断裂 —— 代码照样跑、行为照样对，只是防线悄悄变薄
mutate --in src/tuning.js "export const REACTION_HORIZON_SECONDS = 3600;" "export const REACTION_HORIZON_SECONDS = 1800;" \
       "视野调回 30 分钟（与十分钟的 cron 不再匹配）"
mutate --in src/tuning.js "export const MAX_TOLERABLE_LAG_SECONDS = 720;" "export const MAX_TOLERABLE_LAG_SECONDS = 1200;" \
       "延迟容忍退回按窗口推导的旧值"
mutate --in src/tuning.js "export const BURST_WINDOW_SECONDS = 1800;" "export const BURST_WINDOW_SECONDS = 900;" \
       "窗口缩到 15 分钟（容忍延迟下凑不出两个数据点）"
# 静默失明这一类。变异测试本身抓不到「缺失的代码」，
# 但代码补上之后，它能防止这段代码被改回去。
mutate "if (recentIn.points === 0 && recentOut.points === 0) {" "if (false) {" \
       "去掉「窗口零数据点」的失明检测（无数据时会伪造出 0 kbps 读数）"
mutate "const meterShouldSeeTraffic = (state) => state === \"running\" || state === null;" \
       'const meterShouldSeeTraffic = (state) => state === "running";' \
       "状态读不出时不再报失明"
# 月度读数的覆盖范围，以及时间戳的量级
# 判据是三行的多行条件 —— 锚点必须整段照抄，否则会变成
# 「变异未应用」，而那被计为存活：一个施加不上去的变异什么也没验证。
mutate "    if (
      behindSeconds !== null &&
      behindSeconds > MONTH_BEHIND_TOLERANCE_SECONDS &&
      meterShouldSeeTraffic(instanceState)
    ) {" "    if (false) {" \
       "去掉「月度读数落后过久」的检测"
mutate "      behindSeconds > MONTH_BEHIND_TOLERANCE_SECONDS &&" \
       "      Number.isFinite(monthNewest) && monthNewest < Math.floor(range.endTime / 86400) * 86400 &&" \
       "月度新鲜度判据改回「不是今天」（每天 00:00 UTC 误报）"
mutate "      ? Math.min(...withPoints.map((m) => m.newest))" "      ? Math.max(...withPoints.map((m) => m.newest))" \
       "新鲜度取两个指标里最新的那个（一个方向停摆会被掩盖）"
# 月度那一侧是同一个判断，两头方向相反，各自都要有变异守着
mutate "        ? Math.min(...monthWithPoints.map((m) => m.newest))" \
       "        ? Math.max(...monthWithPoints.map((m) => m.newest))" \
       "月度新鲜度取最乐观的一头（一侧管道落后被掩盖，落后告警永不触发）"
mutate "        ? Math.max(...monthWithPoints.map((m) => m.oldest))" \
       "        ? Math.min(...monthWithPoints.map((m) => m.oldest))" \
       "月度覆盖起点取最乐观的一头（一侧缺了月初几天时 covers from 不出现）"
mutate "      Math.abs(point.timestamp - range.endTime) <= MAX_TIMESTAMP_SKEW_SECONDS;" \
       "      true;" \
       "去掉时间戳量级检查（毫秒时间戳可静默绕过新鲜度检测）"
# 实例状态必须来自 API，不能靠推断
mutate "      getInstanceState(client, config).catch((err) => {" \
       "      Promise.resolve(\"running\").then((v) => v).catch((err) => {" \
       "不查状态，直接假定实例在跑"
# 可观测性：稳态必须能被 grep 出来，告警不能被别的分支吞掉
mutate 'const down = typeof instanceState === "string" && instanceState !== "running";' \
       "const down = false;" \
       "OK/DOWN 判据恒为 OK（走正常出口时，已下线的实例被写成 OK）"
mutate '      `${config.label} DOWN | ${formatUsage(config, usedGib)} | ${reason} | instance is "${state}"`,' \
       '      `${config.label} OK | ${formatUsage(config, usedGib)} | ${reason} | instance is "${state}"`,' \
       "stopOverLimit 的幂等分支写成 OK（越线后重复触发时，已下线的实例被写成 OK）"
mutate "    if (
      usedBytes === 0 &&
      monthAgeSeconds > ZERO_READING_GRACE_SECONDS &&
      meterShouldSeeTraffic(instanceState)
    ) {" "    if (false) {" \
       "去掉「月中读数恒为零」告警"
mutate "      monthAgeSeconds > ZERO_READING_GRACE_SECONDS &&
      meterShouldSeeTraffic(instanceState)" \
       "      monthAgeSeconds > ZERO_READING_GRACE_SECONDS" \
       "零读数告警丢掉状态条件（合法停机期每轮误报一次）"
mutate "      usedBytes === 0 &&
      monthAgeSeconds > ZERO_READING_GRACE_SECONDS &&" \
       "      monthAgeSeconds > ZERO_READING_GRACE_SECONDS &&" \
       "零读数告警丢掉「读数为零」这个前提（正常轮次也误报）"
mutate "    if (monthWithPoints.length > 0 && !Number.isFinite(monthNewest)) {" "    if (false) {" \
       "去掉月度读数「没有可用时间戳」告警"
mutate "  if (lagSeconds === null) {" "  if (false) {" \
       "时间戳读不出时不再报失明（同一条静默路径的另一个入口）"
mutate 'detail = detail.replaceAll(secret, "[redacted]");' 'detail = detail.replace(secret, "[redacted]");' \
       "脱敏只替换第一处出现（同一份响应里凭据的第二次出现会进日志）"
mutate '${String(point.sum)}' '${JSON.stringify(point.sum)}' \
       "非有限 sum 的错误消息退回 JSON.stringify（Infinity 会被写成 null，误导排查方向）"
# unit 传错时 AWS 回 200 + 空数组，响应侧分辨不了 —— 请求侧和校验侧两道防线都要能被抓到
mutate "    if (point.unit != null && point.unit !== METRIC_UNIT) {" "    if (false) {" \
       "去掉数据点的单位校验（单位不一致时字节数会错几个数量级，Megabytes 那侧是漏停）"
mutate --in src/tuning.js 'export const METRIC_UNIT = "Bytes";' 'export const METRIC_UNIT = "Bits";' \
       "请求的单位改错（上游静默回空数组，用量恒为零）"
# 速率分母必须跟着实际覆盖的秒数走
mutate "    return metric.bytes / (metric.coveredSeconds ?? metric.points * BURST_PERIOD_SECONDS);" \
       "    return metric.bytes / (metric.points * BURST_PERIOD_SECONDS);" \
       "分母退回「桶数 × 粒度」（窗口未对齐时速率报低）"
# 上游的数据点上限：超限的表现两次实测不一致（08-22 静默空 / 08-30 响亮 400），守卫按
# 「两种形态都可能出现」设计，两侧防线都要能被抓到
mutate "  if (wanted > MAX_DATAPOINTS_PER_QUERY) {" "  if (false) {" \
       "去掉数据点上限检查（超限的调参直接打到上游，不再在本地拦下）"
mutate --in src/tuning.js "export const MAX_DATAPOINTS_PER_QUERY = 1440;" \
       "export const MAX_DATAPOINTS_PER_QUERY = 100000;" \
       "上限放大到失效（等于没有这道检查）"
# 月度读数的覆盖起点
mutate "    if (monthOldest !== null && monthOldest > range.startTime) {" "    if (false) {" \
       "不再说明月度读数是从哪天起算的"
# 模块级缓存 —— 无状态承诺一旦破掉，「失败的触发不需要对账」就不再成立
mutate "export function monthStartMs(now) {" \
       "let _cache = null;\nexport function monthStartMs(now) {\n  if (_cache !== null) return _cache;\n  _cache = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);\n  return _cache;" \
       "给 monthStartMs 加模块级缓存（破坏无状态）"

# 「同一条防线在一处修好、另一处的同类没跟着修」这一族。判据必须只有一个来源
# （meterShouldSeeTraffic），下面几个变异各自把其中一处改回去。
mutate "      behindSeconds > MONTH_BEHIND_TOLERANCE_SECONDS &&
      meterShouldSeeTraffic(instanceState)" \
       "      behindSeconds > MONTH_BEHIND_TOLERANCE_SECONDS" \
       "月度落后告警丢掉状态条件（合法停机期每轮误报，一天约 142 条）"
mutate "      behindSeconds > MONTH_BEHIND_TOLERANCE_SECONDS &&
      meterShouldSeeTraffic(instanceState)" \
       '      behindSeconds > MONTH_BEHIND_TOLERANCE_SECONDS &&
      instanceState === "running"' \
       "月度落后告警把「状态读不出来」这一档吞掉（该宁可多喊一声）"
mutate "  if (dark === null) return;" "  return;" \
       "去掉「一个方向零数据点」的失明检测（只看得见一半流量）"
mutate "  if (!meterShouldSeeTraffic(instanceState)) return;" '  if (instanceState !== "running") return;' \
       "半瞎检测把「状态读不出来」这一档吞掉"
# 两个调用点各自是一条独立的防线，去掉任一个都必须变红
mutate "  warnIfHalfBlind(config, recentIn, recentOut, instanceState, {" \
       "  if (false) warnIfHalfBlind(config, recentIn, recentOut, instanceState, {" \
       "突发窗口不再做半瞎检测"
mutate "    warnIfHalfBlind(config, monthIn, monthOut, instanceState, {" \
       "    if (false) warnIfHalfBlind(config, monthIn, monthOut, instanceState, {" \
       "月度读数不再做半瞎检测（静态线少看一整个方向的用量）"
# 数据点上限守卫：按跨度算而不是按桶相位算。相位数不小于跨度数，按相位数是刻意比上游
# 严一档的保守选择 —— 08-30 实测上游对分歧构造按跨度数（回 200 + 1440 个点），但 08-22
# 的记录是超限静默回空数组。退成按跨度数等于赌上游永远按跨度数，而它在 8 天里变过一次。
mutate "  const gridStart = Math.floor(range.startTime / 60) * 60;
  const wanted = Math.ceil((range.endTime - gridStart) / period);" \
       "  const wanted = Math.ceil((range.endTime - range.startTime) / period);" \
       "上限守卫退化成按窗口跨度数（丢掉覆盖静默空形态的保守余量）"
# stale 告警的措辞必须跟着实际查到的状态走
mutate '        ? "the instance is running, so the meter itself is behind"' \
       '        ? "the meter is lagging, or the instance is not running"' \
       "stale 告警摆出一个已被状态排除的解释"
# 空窗告警是同一个问题：状态读不出来时不得断言「计量表失明」—— 维护期碰上状态查询坏掉
# 时，那句话会把合法停机写成管道故障
mutate '"the instance state is unreadable, so this is either a blind meter or an instance that is not running"' \
       '"instance is of unreadable state, so the meter is blind, not idle"' \
       "空窗告警在状态读不出时退回断言失明（把合法停机写成管道故障）"
mutate "  if (stale && meterShouldSeeTraffic(instanceState)) {" '  if (stale && instanceState === "running") {' \
       "stale 告警把「状态读不出来」这一档吞掉"
mutate "      common.push(\`win \${burst.inPoints},\${burst.outPoints}/\${BURST_WINDOW_SECONDS / BURST_PERIOD_SECONDS}\`);" \
       "      common.push(\`win \${Math.max(burst.inPoints, burst.outPoints)}/\${BURST_WINDOW_SECONDS / BURST_PERIOD_SECONDS}\`);" \
       "win 退回取两个方向的较大值（一侧停摆被显示成健康）"
mutate "    common.push(\`days \${monthIn.points},\${monthOut.points}/\${daysElapsed}\`);" \
       "    common.push(\`days \${Math.max(monthIn.points, monthOut.points)}/\${daysElapsed}\`);" \
       "days 退回取两个方向的较大值"

echo
if [ "$SURVIVORS" -gt 0 ]; then
  echo "$SURVIVORS 个变异存活 —— 测试没有覆盖到它们代表的缺陷"; exit 1
fi
echo "全部变异都被抓到"
