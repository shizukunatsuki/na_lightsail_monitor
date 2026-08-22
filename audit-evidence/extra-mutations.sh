#!/usr/bin/env bash
# 追加变异：上一个 session 的 19 个之外，专挑「代码照样跑、行为看着对、防线悄悄变薄」这一类。
# 纪律：全程在 mktemp 副本里做，绝不碰工作区。
set -uo pipefail
ROOT="${1:?repo root}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cp -R "$ROOT/src" "$ROOT/test" "$ROOT/package.json" "$ROOT/wrangler.jsonc" "$WORK/"
ln -s "$ROOT/node_modules" "$WORK/node_modules"; cd "$WORK"
export INVARIANT_CASES="${INVARIANT_CASES:-500}"
SURVIVORS=0; CAUGHT=0

detect() {
  local out ran failed
  out="$(node --test 2>&1)" || true
  ran="$(grep -oE 'tests [0-9]+' <<<"$out" | head -1 | grep -oE '[0-9]+')"
  [ -z "$ran" ] || [ "$ran" -eq 0 ] && { echo "检测器异常" >&2; return 2; }
  failed="$(grep -oE 'fail [0-9]+' <<<"$out" | head -1 | grep -oE '[0-9]+')"
  [ "${failed:-0}" -gt 0 ]
}

mutate() {
  cp "$ROOT/src/index.js" src/index.js
  if ! python3 -c "
import sys, pathlib
p = pathlib.Path('src/index.js'); s = p.read_text()
n = s.count(sys.argv[1])
assert n == 1, 'matched %d times' % n
p.write_text(s.replace(sys.argv[1], sys.argv[2]))" "$1" "$2" 2>/dev/null; then
    echo "  ?? 变异未应用  $3"; SURVIVORS=$((SURVIVORS+1)); return
  fi
  detect; local r=$?
  case "$r" in
    0) echo "  抓到 ✓        $3"; CAUGHT=$((CAUGHT+1)) ;;
    1) echo "  漏过 ✗        $3"; SURVIVORS=$((SURVIVORS+1)) ;;
    *) echo "  检测器异常 !!  $3"; SURVIVORS=$((SURVIVORS+1)) ;;
  esac
}

cp "$ROOT/src/index.js" src/index.js
detect; C=$?
[ "$C" -eq 2 ] && { echo "对照组跑不起来"; exit 1; }
[ "$C" -eq 0 ] && { echo "对照组失败：干净代码也报红"; exit 1; }
echo "对照组: 干净代码通过 ✓"; echo

# --- 指标方向对调 ---------------------------------------------------------
mutate '      sumMetric(client, config, "NetworkIn", range, METRIC_PERIOD_SECONDS),
      sumMetric(client, config, "NetworkOut", range, METRIC_PERIOD_SECONDS),' \
       '      sumMetric(client, config, "NetworkOut", range, METRIC_PERIOD_SECONDS),
      sumMetric(client, config, "NetworkIn", range, METRIC_PERIOD_SECONDS),' \
       "月度查询两个方向对调"
mutate '    sumMetric(client, config, "NetworkIn", range, BURST_PERIOD_SECONDS),
    sumMetric(client, config, "NetworkOut", range, BURST_PERIOD_SECONDS),' \
       '    sumMetric(client, config, "NetworkOut", range, BURST_PERIOD_SECONDS),
    sumMetric(client, config, "NetworkIn", range, BURST_PERIOD_SECONDS),' \
       "突发查询两个方向对调"

# --- 去掉 await / 并发改串行 ---------------------------------------------
mutate "      if (burst.reason) {
        await stopOverLimit(client, config, usedGib, burst.reason);" \
       "      if (burst.reason) {
        stopOverLimit(client, config, usedGib, burst.reason);" \
       "突发停机去掉 await（fire-and-forget）"
mutate "    const [monthIn, monthOut] = await Promise.all([" \
       "    const [monthIn, monthOut] = await Promise.allSettled([" \
       "月度查询 Promise.all 改 allSettled（失败被吞）"

# --- 边界与比较 -----------------------------------------------------------
mutate "const stale = lagSeconds !== null && lagSeconds >= MAX_TOLERABLE_LAG_SECONDS;" \
       "const stale = lagSeconds !== null && lagSeconds > MAX_TOLERABLE_LAG_SECONDS;" \
       "BLIND 门槛 >= 改成 >（边界）"
mutate "    metric.points > 0 ? metric.bytes / (metric.points * BURST_PERIOD_SECONDS) : 0;" \
       "    metric.points >= 0 ? metric.bytes / (metric.points * BURST_PERIOD_SECONDS) : 0;" \
       "rateOf 的零点数保护改成 >=0（除零）"
mutate "  const secondsToQuota = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : Infinity;" \
       "  const secondsToQuota = bytesPerSecond >= 0 ? remainingBytes / bytesPerSecond : Infinity;" \
       "secondsToQuota 的零速率保护改成 >=0"
mutate "    Math.max(0, endTime - (newest + BURST_PERIOD_SECONDS))" \
       "    endTime - (newest + BURST_PERIOD_SECONDS)" \
       "去掉 lagSeconds 的下钳（负延迟）"

# --- 防线悄悄变薄：改常量，但仍然通过所有 tuning 关系检查 ------------------
mutate "export const MAX_TOLERABLE_LAG_SECONDS = 720;" "export const MAX_TOLERABLE_LAG_SECONDS = 1500;" \
       "延迟容忍抬到 1500s（= 可观测上限，BLIND 几乎永不触发）"
mutate "export const REACTION_HORIZON_SECONDS = 3600;" "export const REACTION_HORIZON_SECONDS = 7200;" \
       "视野翻倍到 120 分钟（灵敏度翻倍，误停风险翻倍）"

# --- 闸门比较目标从配额换成阈值线（README 明说这会退化） -------------------
mutate "  const remainingBytes = config.quotaGib * BYTES_PER_GIB - usedBytes;" \
       "  const remainingBytes = config.quotaGib * config.threshold * BYTES_PER_GIB - usedBytes;" \
       "闸门改成比到 THRESHOLD 线而不是整份配额"

# --- fail-closed 被悄悄改成 fail-open -------------------------------------
mutate 'if (state !== null && state !== "running") {' 'if (state !== "running") {' \
       "停机路径 fail-closed 改成 fail-open（状态读不到就不停）"

# --- 数值污染 -------------------------------------------------------------
mutate 'if (typeof sum !== "number" || !Number.isFinite(sum) || sum < 0) {' \
       'if (typeof sum !== "number" || sum < 0) {' \
       "只去掉 sum 的有限性检查（NaN 污染总量）"
mutate "      if (secret) detail = detail.replaceAll(secret, \"[redacted]\");" \
       "      if (secret) detail = detail.replace(secret, \"[redacted]\");" \
       "脱敏只替换第一处出现"

# --- 重试与配置 -----------------------------------------------------------
mutate "      retries: 2," "      retries: 0," "关掉 5xx 重试"
mutate "if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {" \
       "if (!Number.isFinite(threshold) || threshold <= 0) {" \
       "去掉 THRESHOLD 上界（写成 80 就永不触发）"

echo
echo "抓到 $CAUGHT，存活 $SURVIVORS"
[ "$SURVIVORS" -gt 0 ] && exit 1 || exit 0
