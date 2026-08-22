// 复现：落库延迟越过 25 分钟之后，BLIND 告警不再触发，而 OK 行会断言 "now 0 kbps"。
// 用的是项目自己的打桩风格，不依赖模拟器。
import worker from "./index.js";
const env = {
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  AWS_REGION: "ap-northeast-1", INSTANCE_NAME: "example-instance",
  QUOTA_GIB: "1024", THRESHOLD: "0.8",
};
const GIB = 1024 ** 3;

// 打桩：月度用量 300 GiB；突发窗口里的数据点全部比「此刻」旧 lagSeconds。
// 数据点落在窗口之外时就不返回 —— 真实 API 只会返回落在 [startTime, endTime) 里的桶。
function stub(lagSeconds) {
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const op = req.headers.get("X-Amz-Target").split(".")[1];
    const b = await req.json();
    if (op === "GetInstanceState") return Response.json({ state: { name: "running" } });
    if (op !== "GetInstanceMetricData") return Response.json({ operations: [] });
    if (b.period === 86400)
      return Response.json({ metricName: b.metricName,
        metricData: [{ sum: b.metricName === "NetworkOut" ? 300 * GIB : 0, timestamp: b.startTime }] });
    // 突发窗口：桶起点 = endTime − lag − 300，落在窗口外就没有任何数据点
    const ts = b.endTime - lagSeconds - 300;
    const inWindow = ts >= b.startTime && ts < b.endTime;
    return Response.json({ metricName: b.metricName,
      metricData: inWindow ? [{ sum: b.metricName === "NetworkOut" ? 200 * GIB : 0, timestamp: ts }] : [] });
  };
}

console.log("同一场 2 Gbps 级别的突发（每个 5 分钟桶 200 GiB），只改落库延迟：\n");
console.log("延迟    BLIND?   停机?   日志");
for (const min of [11, 12, 20, 25, 26, 30, 45]) {
  stub(min * 60);
  const lines = [];
  const { log, error } = console;
  console.log = (...a) => lines.push(a.join(" ")); console.error = (...a) => lines.push(a.join(" "));
  let stopped = false;
  const f = globalThis.fetch;
  globalThis.fetch = async (i, n) => {
    const r = i instanceof Request ? i : new Request(i, n);
    if (r.headers.get("X-Amz-Target").endsWith("StopInstance")) stopped = true;
    return f(i, n);
  };
  await worker.scheduled({ scheduledTime: Date.parse("2026-08-15T12:00:00Z"), cron: "*/10 * * * *", noRetry() {} }, env);
  console.log = log; console.error = error;
  const blind = lines.some((l) => l.includes(" BLIND "));
  console.log(`${String(min).padStart(3)} min  ${(blind ? "是" : "否 ←").padEnd(8)} ${(stopped ? "是" : "否 ←").padEnd(7)} ${lines.at(-1)}`);
}
