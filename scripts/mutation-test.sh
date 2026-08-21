#!/usr/bin/env bash
# 变异测试：往代码里注入已知缺陷，看测试会不会变红。
#
# 存在的理由：「测试通过」证明不了测试有用。这个仓库里出现过两次真实的反例 ——
# 一次是打桩把 AWS 的合法空响应当成畸形响应（夹具和断言互相印证同一个错误假设），
# 一次是性质测试跑得很热闹却抓不到任何注入的缺陷。能抓住缺陷才是唯一的证据。
#
# 三条纪律，都是踩过坑之后加的：
#   1. 全程在临时副本里操作，绝不碰工作区 —— 曾经有一次中断把 `if (false && manualHold)`
#      留在了 src 里，差点提交上去。
#   2. 先跑对照组：不做任何变异时必须是绿的，否则说明检测器本身在瞎报。
#   3. 检测器自己也要能被检验。这里踩过两个坑：数行数会被 reporter 打两遍的失败行骗到；
#      而把 `node --test | grep -q` 放在 `set -o pipefail` 下，管道会返回 node 的退出码
#      （测试失败 = 1）而不是 grep 的（找到 = 0），整个检测逻辑被反了过来 —— 于是所有
#      变异都被报成「漏过」，而对照组碰巧还是绿的。现在先把输出收进变量再判断，并且
#      强制区分「跑了且通过」「不变量被违反」「根本没跑起来」三种情况。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp -R "$ROOT/src" "$ROOT/test" "$ROOT/package.json" "$WORK/"
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
  out="$(node --test test/invariants.test.js 2>&1)" || true
  ran="$(grep -oE 'tests [0-9]+' <<<"$out" | head -1 | grep -oE '[0-9]+')"
  if [ -z "$ran" ] || [ "$ran" -eq 0 ]; then
    echo "检测器异常：测试没有跑起来" >&2
    tail -n 8 <<<"$out" >&2
    return 2
  fi
  failed="$(grep -oE 'fail [0-9]+' <<<"$out" | head -1 | grep -oE '[0-9]+')"
  [ "${failed:-0}" -gt 0 ]
}

mutate() {
  cp "$ROOT/src/index.js" src/index.js
  if ! python3 -c "
import sys, pathlib
p = pathlib.Path('src/index.js'); s = p.read_text()
n = s.count(sys.argv[1])
assert n == 1, 'mutation site matched %d times' % n
p.write_text(s.replace(sys.argv[1], sys.argv[2]))" "$1" "$2" 2>/dev/null; then
    echo "  ?? 变异未应用  $3"; SURVIVORS=$((SURVIVORS + 1)); return
  fi
  detect; local r=$?
  case "$r" in
    0) echo "  抓到 ✓        $3" ;;
    1) echo "  漏过 ✗        $3"; SURVIVORS=$((SURVIVORS + 1)) ;;
    *) echo "  检测器异常 !!  $3"; SURVIVORS=$((SURVIVORS + 1)) ;;
  esac
}

cp "$ROOT/src/index.js" src/index.js
detect; CONTROL=$?
if [ "$CONTROL" -eq 2 ]; then echo "对照组：测试跑不起来，检测器不可信"; exit 1; fi
if [ "$CONTROL" -eq 0 ]; then echo "对照组失败：干净的代码也报红"; exit 1; fi
echo "对照组: 干净代码通过、未被误报 ✓"; echo

mutate "if (usedGib >= limitGib) {" "if (usedGib > limitGib) {" "静态线 >= 改成 >（边界漏停）"
mutate "const bytesPerSecond = rateOf(recentIn) + rateOf(recentOut);" \
       "const bytesPerSecond = (recentIn.bytes + recentOut.bytes) / (Math.max(recentIn.points, recentOut.points) * BURST_PERIOD_SECONDS);" \
       "速率改回共同分母（漏停）"
mutate "      burst = await burstCheck(client, config, range, usedBytes);" \
       "      burst = { reason: null, lagSeconds: null, bytesPerSecond: null, secondsToQuota: null, stale: false };" \
       "整个跳过突发闸门"
mutate 'if (state !== null && state !== "running") {' 'if (state !== null && state === "running") {' "反转停机的状态判断"
mutate "if (config.manualHold) {" "if (false && config.manualHold) {" "去掉 MANUAL_HOLD 对启动的抑制"
mutate "const state = await getInstanceState(client, config);" 'const state = "stopped";' "重启路径跳过状态查询"
mutate "const now = new Date(controller.scheduledTime ?? Date.now());" "const now = new Date(Date.now());" "忽略 scheduledTime 改用墙上时钟"
mutate 'for (const secret of [client.accessKeyId, client.secretAccessKey]) {' \
       'for (const secret of [client.accessKeyId]) {' "只脱敏 access key id，漏掉 secret"
mutate "if (metricData != null && !Array.isArray(metricData)) {" "if (false) {" "去掉畸形 metricData 检查"
mutate 'if (typeof sum !== "number" || !Number.isFinite(sum) || sum < 0) {' "if (false) {" "去掉 sum 的类型检查"
mutate "|| quotaGib > MAX_QUOTA_GIB" "" "去掉 QUOTA_GIB 上界"
mutate "bytes += sum;" "bytes += 0;" "月度用量恒为零"

echo
if [ "$SURVIVORS" -gt 0 ]; then
  echo "$SURVIVORS 个变异存活 —— 测试没有覆盖到它们代表的缺陷"; exit 1
fi
echo "全部变异都被抓到"
