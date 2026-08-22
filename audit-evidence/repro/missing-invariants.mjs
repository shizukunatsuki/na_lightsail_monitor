// 我自己从「需求」列出来的不变量，再拿去和 test/invariants.test.js 比。
// 下面两条是差集 —— 现有套件没有断言过它们。
import worker from "./index.js";
const GIB = 1024 ** 3;
const env = { AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
              AWS_REGION: "ap-northeast-1", INSTANCE_NAME: "example-instance", QUOTA_GIB: "1024", THRESHOLD: "0.8" };

// 打桩：月度 300 GiB；突发窗口里的点比此刻旧 lag 秒，落到窗口外就一个点都没有（真实 API 行为）。
function stub(lag, burstGibPerBucket) {
  globalThis.fetch = async (i, n) => {
    const r = i instanceof Request ? i : new Request(i, n);
    const op = r.headers.get("X-Amz-Target").split(".")[1];
    const b = await r.json();
    if (op === "GetInstanceState") return Response.json({ state: { name: "running" } });
    if (op !== "GetInstanceMetricData") return Response.json({ operations: [] });
    if (b.period === 86400)
      return Response.json({ metricName: b.metricName, metricData: [{ sum: b.metricName === "NetworkOut" ? 300 * GIB : 0, timestamp: b.startTime }] });
    const pts = [];
    for (let ts = b.endTime - lag - 300; ts >= b.startTime; ts -= 300)
      pts.push({ sum: b.metricName === "NetworkOut" ? burstGibPerBucket * GIB : 0, timestamp: ts });
    return Response.json({ metricName: b.metricName, metricData: pts });
  };
}
async function run() {
  const lines = []; const { log, error } = console;
  console.log = (...a) => lines.push(a.join(" ")); console.error = (...a) => lines.push(a.join(" "));
  try { await worker.scheduled({ scheduledTime: Date.parse("2026-08-15T12:00:00Z"), cron: "*/10 * * * *", noRetry() {} }, env); }
  finally { console.log = log; console.error = error; }
  return lines;
}

let fails = 0;
const report = (ok, name, detail) => { console.log(`${ok ? "  通过" : "  失败 ××"}  ${name}${detail ? "\n            " + detail : ""}`); if (!ok) fails++; };

console.log("不变量 A：数据越旧，看门狗的自我评价不得越乐观。");
console.log("  （「告警是否触发」必须随落库延迟单调不减 —— 否则延迟越大反而越安静）");
{
  const seen = [];
  for (let lag = 0; lag <= 3000; lag += 300) { stub(lag, 200); seen.push([lag, (await run()).some((l) => l.includes(" BLIND "))]); }
  let mono = true, first = null;
  for (let i = 1; i < seen.length; i++) if (seen[i - 1][1] && !seen[i][1]) { mono = false; first ??= seen[i][0]; }
  report(mono, "告警随延迟单调", mono ? "" :
    `延迟 ${first - 300}s 会告警，但更旧的 ${first}s 反而不告警。\n            ` +
    `实测：${seen.map(([l, b]) => `${l / 60}min=${b ? "告警" : "静默"}`).join("  ")}`);
}

console.log("\n不变量 B：闸门没有任何数据支撑时，不得输出一个看起来正常的速率读数。");
{
  stub(2400, 200);                       // 延迟 40 分钟：窗口里一个点都没有
  const lines = await run();
  const ok = lines.at(-1).includes("BLIND") || !/now \S+ \S+, /.test(lines.at(-1)) || /stale|unknown|no data/.test(lines.at(-1));
  report(ok, "无数据时不报出正常速率", ok ? "" : `实际日志：${lines.at(-1)}`);
}

console.log("\n不变量 C（对照）：延迟在可观测区间内时应当告警 —— 确认这个探针不是恒失败。");
{
  stub(900, 200);
  const lines = await run();
  report(lines.some((l) => l.includes(" BLIND ")), "延迟 15 分钟触发告警", "");
}
console.log(fails ? `\n${fails} 条不变量被违反` : "\n全部通过");
