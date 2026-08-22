import worker from "./index.js";
const GIB = 1024 ** 3;
const KEY = "AKIAIOSFODNN7EXAMPLE", SEC = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const env = { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SEC, AWS_REGION: "ap-northeast-1",
              INSTANCE_NAME: "example-instance", QUOTA_GIB: "1024", THRESHOLD: "0.8" };

console.log("1) JSON 里 1e400 会解析成什么？", JSON.parse('{"sum":1e400}').sum,
            " typeof:", typeof JSON.parse('{"sum":1e400}').sum,
            " isFinite:", Number.isFinite(JSON.parse('{"sum":1e400}').sum));

async function run(fetchImpl, at = "2026-08-15T12:00:00Z") {
  globalThis.fetch = fetchImpl;
  const lines = []; const { log, error } = console;
  console.log = (...a) => lines.push(a.join(" ")); console.error = (...a) => lines.push(a.join(" "));
  let threw = null;
  try { await worker.scheduled({ scheduledTime: Date.parse(at), cron: "*/10 * * * *", noRetry() {} }, env); }
  catch (e) { threw = e; } finally { console.log = log; console.error = error; }
  return { lines, threw };
}
const metric = (make) => async (i, n) => {
  const r = i instanceof Request ? i : new Request(i, n);
  const op = r.headers.get("X-Amz-Target").split(".")[1];
  const b = await r.json();
  if (op === "GetInstanceState") return Response.json({ state: { name: "running" } });
  if (op !== "GetInstanceMetricData") return Response.json({ operations: [] });
  return make(b);
};

// 2) sum = 1e400（合法 JSON，解析成 Infinity）
const inf = await run(metric((b) => new Response(
  `{"metricName":"${b.metricName}","metricData":[{"sum":1e400,"timestamp":1.754e9}]}`,
  { headers: { "content-type": "application/json" } })));
console.log("2) sum=1e400 现状：", inf.threw ? `抛错 -> ${inf.threw.message.slice(0, 70)}` : `未抛错 -> ${inf.lines.at(-1)}`);

// 3) 脱敏：凭据在响应体里出现两次时会怎样
const twice = await run(metric(() => new Response(
  `{"__type":"AccessDeniedException","message":"Credential should be scoped: ${KEY}/20260815/ap-northeast-1/lightsail/aws4_request; supplied key ${KEY} is not authorized. secret=${SEC} secret2=${SEC}"}`,
  { status: 400 })));
const msg = twice.threw?.message ?? "";
console.log(`3) 凭据出现两次：access key 残留 ${(msg.match(/AKIAIOSFODNN7EXAMPLE/g) ?? []).length} 处，` +
            `secret 残留 ${(msg.match(/wJalrXUtnFEMI/g) ?? []).length} 处  ` +
            `(replaceAll 下应为 0/0)`);

// 4) lagSeconds 下钳那一行的真实源码文本
const src = (await import("node:fs")).readFileSync("./index.js", "utf8");
const line = src.split("\n").find((l) => l.includes("Math.max(0, endTime"));
console.log("4) 下钳那一行的原文：", JSON.stringify(line));
