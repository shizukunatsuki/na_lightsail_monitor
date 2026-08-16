# na-lightsail-monitor

一个 Cloudflare Worker，每 10 分钟查一次指定 AWS Lightsail 实例本月已用的流量，达到套餐额度的设定比例（默认 80%）就把实例停掉；下个月额度重置后再自动启回来。它防的是 Lightsail 的流量超额账单——那种没有上限、按 GB 计费、要到月底账单上才现身的东西。

不到 300 行 JavaScript，唯一的运行时依赖是 4 KB 的 `aws4fetch`。它不提供任何网页界面，也不会主动通知任何人；关于后一点为什么是刻意的、以及你该拿什么来补，见 [AWS Budgets](#5-配置-aws-budgets必做) 一节。

---

## 一、先搞清楚 Lightsail 的额度规则

这些规则决定了代码里每一个数字的含义，写错一条，看门狗守的就是错的东西。

- **进出双向都消耗额度，但只有出向超量才计费**，入向超量免费。所以 Worker 把 `NetworkIn + NetworkOut` 相加来判断，而不是只看出向：额度是被两个方向一起吃掉的。
- **额度在同一区域、同一 `bundleId` 的实例之间汇总。** 同规格的 IPv4 实例与 IPv6 实例计入同一份额度。
- **删掉实例再新建不会重置额度**，已经产生的超额费用也不会消失。
- **部分区域的套餐额度只有其它区域的一半**：孟买、悉尼、雅加达、马来西亚、香港、圣保罗。东京（`ap-northeast-1`）是完整额度。
- **超额费率随区域不同**，东京约为每 GB 0.14 美元。

额度在每月 1 日 **00:00 UTC** 重置。Worker 全程用 UTC 计算月份边界，不碰本地时区——两者不是同一个时刻，用错会让每个月有最多一天的时间查错窗口。

---

## 二、工作原理

一个 cron trigger，`*/10 * * * *`，每天 144 次。每次触发做的事情是固定的：先量，再让数字决定动作。

**它是无状态的。** 没有 KV、没有 D1、没有 Durable Object，每次触发都从 Lightsail 指标 API 重新算一遍用量。所以没有会损坏的存储，一次失败的触发之后也没有任何东西需要对账——下一次触发会独立地把结论重新得出来。

**测量。** 用 `GetInstanceMetricData` 分别拉 `NetworkIn` 和 `NetworkOut` 从**本月 1 日 00:00 UTC 到此刻**的数据，`statistics: ["Sum"]`，把所有数据点的 `sum` 累加。数据点既不保证有序也不保证连续，所以是累加而不是按下标取值——求总量与顺序无关，缺口本身就代表那段时间没有流量。

时间基准取的是 `controller.scheduledTime` 而不是墙上时钟：它精确落在 cron 的时间格上，即便这次调用被延迟或重试，评估的仍然是它当初被触发的那一格。

**判断。** 令 `used = (NetworkIn + NetworkOut) / 2^30`，`limit = QUOTA_GIB × THRESHOLD`：

| 情形 | 动作 | AWS 调用次数 |
| --- | --- | --- |
| `used >= limit`，实例 `running` | **停机** `StopInstance`，日志写 `console.error` | **4** |
| `used >= limit`，实例已非 `running` | 什么都不做（含 `stopping` 中途） | **3** |
| `used < limit`，且总字节 **> 0** | 什么都不做 | **2** |
| 总字节 **恰为 0**，实例 `stopped` | **启动** `StartInstance` | **4** |
| 总字节恰为 0，实例是别的状态 | 什么都不做 | 3 |
| 总字节恰为 0，但 `MANUAL_HOLD="true"` | 什么都不做，连状态都不查 | 2 |

每次触发的基线是 2 次调用（两个指标各一次）；第 3 次是 `GetInstanceState`，第 4 次才是真正的动作。

**这张表里最值得注意的是「恰好零字节」那一行。** 它是查询实例状态的闸门：一台运行中的实例几分钟内必然产生*某些*流量——DNS、NTP、互联网上的后台扫描——所以「月初至今总量为零」等价于「它没起来」。没有这道闸门，handler 就得在每个正常日子的每一次触发里都多问一次 `GetInstanceState`，为了每月一次的重启多付约 4300 次 API 调用。

**停机与重启是幂等的。** 停机前先查状态，所以第二次触发不会对一个已经停下（或正在停）的实例再发一次停机。重启只在总量恰为零且状态为 `stopped` 时发出。

**由此有一个值得知道的后果：你自己在月中停掉的实例不会被它拉起来。** 那时计量表上已经有流量，总量不为零，重启分支根本不会进。它要等到跨月、读数归零之后才会接手这台实例——如果那时你仍然不希望它被启动，就设 `MANUAL_HOLD`。

**错误处理。** 任何非 2xx 的 Lightsail 响应都抛出异常，向上冒到 Workers，把这次调用记为失败；异常消息里会把 access key id 抹成 `[redacted]`，因为 SigV4 的拒绝响应会回显包含它的 credential scope。`GetInstanceState` 读不出状态名也抛错，而不是返回 `undefined`——停机路径把「不是 running」当作无事可做，一个悄悄缺失的状态会让实例此后一直超额跑下去。签名客户端配了 2 次重试，只针对 5xx 和 429；下一次触发在十分钟后，再多重试没有意义。

---

## 三、单位：为什么全都是 GiB

`QUOTA_GIB` 填的是 **GiB（2^30 字节）**，直接照抄 `GetBundles` 返回的 `transferPerMonthInGb`：1 TB 套餐填 `1024`，2 TB 填 `2048`，不需要任何换算。

这个结论来自字段命名的一致性推断，而不是 AWS 的明文定义——**AWS 从未说明 `InGb` 这类字段的字节含义。** 推断的依据有两条：

1. `GetBundles` 把宣称的「1 TB」记为 `transferPerMonthInGb: 1024`，2 TB 记为 `2048`，3 TB 记为 `3072`。前缀是按二进制缩放的。
2. 同一份响应里还有 `ramSizeInGb: 0.5`，而 0.5 GB 的内存只可能是 512 MiB（2^29 字节）。

**即便这个推断是错的，默认配置依然安全。** 默认停机线是 `1024 × 0.8 = 819.2 GiB ≈ 879.6 × 10^9 字节`：

- 若 1 TB 指 2^40 字节，停机线占额度的 **80%**；
- 若 1 TB 指 1024 × 10^9 字节，停机线占 **约 85.9%**。

两种解释下都没有超额。这就是这套换算的安全性论证——它不依赖推断成立。

| 套餐 | 宣称额度 | `transferPerMonthInGb` | 填进 `QUOTA_GIB` |
| --- | --- | --- | --- |
| `nano_3_0` | 1 TB | 1024 | `1024` |
| `micro_3_0` | 2 TB | 2048 | `2048` |
| `small_3_0` | 3 TB | 3072 | `3072` |

配置时以 `aws lightsail get-bundles` 在**你的目标区域**返回的实际值为准，不要照抄上表——[部分区域的额度只有一半](#一先搞清楚-lightsail-的额度规则)。

```bash
aws lightsail get-bundles --region ap-northeast-1
```

控制台里也能查到同一个数字：*Lightsail → 实例 → 你的实例 → 网络 → 每月数据传输*。

---

## 四、配置

两个 secret 用 `wrangler secret put` 设置，其余变量写在 [`wrangler.jsonc`](wrangler.jsonc) 的 `vars` 里。以下是每个变量的权威说明，文档其它地方只做引用。

### Secret（绝不写进 `wrangler.jsonc`）

| 名称 | 说明 |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | IAM 用户的 access key id。 |
| `AWS_SECRET_ACCESS_KEY` | 对应的 secret access key。 |

两者都只做「存在性」检查，值不会离开签名函数，也不会出现在任何日志或异常消息里。

### 变量

| 名称 | 必填 | 说明 |
| --- | --- | --- |
| `AWS_REGION` | 是 | 实例所在的 Lightsail 区域，例如 `ap-northeast-1`。它同时决定 API endpoint 与签名 region。 |
| `INSTANCE_NAME` | 是 | 要监控的实例名（Lightsail 控制台里显示的那个名字，不是 ARN、不是主机名）。 |
| `QUOTA_GIB` | 是 | 套餐的月度流量额度，单位 GiB。必须是正数。取值与含义见[单位](#三单位为什么全都是-gib)一节。 |
| `THRESHOLD` | 是 | 用到额度的这个比例就停机。必须是 **(0, 1] 区间的小数**，`0.8` 表示 80%。写成 `80` 会在启动时被拒绝。设为 `1` 表示当月不再停机。 |
| `MANUAL_HOLD` | 否 | 设为字符串 `"true"` 时抑制所有 `StartInstance`，用于你自己把实例停下来做维护、不希望它被拉起来的场景。**只认精确的 `"true"`**，`"True"`、`"yes"`、`"1"`、前后带空格的都视为未设置。停机行为不受它影响。 |

`AWS_REGION` 与 `INSTANCE_NAME` 还额外拒绝字面值 `CHANGE_ME`——占位符是非空字符串，能骗过「必填项缺失」那道检查，然后每天在 Lightsail 侧失败 144 次，留下一堆读不懂的 404。这个检查是精确比较：真有人的实例叫 `change_me_later`，那是别人正经的实例名，不能拦。

任何一项校验失败都是硬错误，在发出**任何** AWS 请求之前抛出。原因见[设计取舍](#配置解析失败即硬错误)。

---

## 五、部署

按下面的顺序做。

### 1. 建 IAM 用户与策略

创建一个只给这个 Worker 用的 IAM 用户，附上下面这份策略，然后生成 access key。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LightsailBandwidthWatchdog",
      "Effect": "Allow",
      "Action": [
        "lightsail:GetInstanceMetricData",
        "lightsail:GetInstanceState",
        "lightsail:StopInstance",
        "lightsail:StartInstance"
      ],
      "Resource": "*"
    }
  ]
}
```

这四个动作正好是 [工作原理](#二工作原理) 那张表里会出现的全部调用，没有多余的。

`"Resource": "*"` 是务实选择而非偷懒：Lightsail 的资源 ARN 由自动生成的 GUID 拼成（`arn:aws:lightsail:REGION:ACCOUNT:Instance/GUID`）而不是实例名，要收窄权限就得先用 `aws lightsail get-instance` 查出 ARN 再填回策略。**如果这个 AWS 账号里有绝不希望被这套东西碰到的实例，这一步值得做。**

```bash
aws lightsail get-instance --instance-name your-instance --region ap-northeast-1
```

### 2. 填变量

编辑 [`wrangler.jsonc`](wrangler.jsonc) 的 `vars`，按[配置](#四配置)一节填好 `AWS_REGION`、`INSTANCE_NAME`、`QUOTA_GIB`、`THRESHOLD`。

### 3. 写入 secret

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
```

```bash
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

### 4. 部署

仓库已经通过 **Cloudflare Workers Builds** 连接，watch `main` 分支，用本项目专属的 build token，deploy command 是 `npx wrangler deploy`。**push 到 `main` 就会自动构建部署**，包括改 `wrangler.jsonc` 里的变量——调 `THRESHOLD` 走的就是「改文件 → push → 自动部署」这条路。

本地部署仍然可用，适合首次部署或紧急发布：

```bash
npm install
```

```bash
npx wrangler deploy
```

到 *Workers & Pages → na-lightsail-monitor → Settings → Triggers* 确认 cron trigger 已生效。日志在控制台可看（`observability` 已开启），也可以直接 tail：

```bash
npx wrangler tail
```

一次健康的触发只写一行：

```
my-blog: 137.482 GiB used month-to-date, under the 819.200 GiB stop threshold
```

这条通道是单向的：日志只会待在那里等你去看，不会来找你。下一步就是补上那个会主动来找你的东西。

### 5. 配置 AWS Budgets（必做）

**这个 Worker 不会主动通知任何人，这是刻意的。** 停机时它写一行 `console.error`，任何失败以异常向上抛出、由 Workers 记为失败——两者都只留在日志里，而日志是需要你主动去拉的次要信号。

真正需要讲清楚的不是「停机了我怎么知道」，而是**看门狗自身失效时你怎么知道**：

- AWS 凭据过期或被轮换
- IAM 用户被删、策略被改
- 部署损坏、`wrangler.jsonc` 改错
- cron trigger 被禁用
- Worker 被整个删掉

每一种情形都让实例继续运行、继续消耗流量，而**从外部看，它与「本月流量很平静」完全无法区分**。Worker 说不出这件事，因为它自己就是坏掉的那一方。任何由这个 Worker 自己发出的告警都覆盖不了这一类故障。

**AWS Budgets 是唯一覆盖这一情形的信号，必须配置。** 它由 AWS 依据自己的账单数据触发，与这个 Worker 是否存活完全无关。

> 账单与成本管理 → 预算 → 创建预算 → 成本预算

金额设成略高于正常月度支出（一台 5 美元实例在没有超量时约 5 美元，预算可以设 10 美元），在 **80% 和 100%** 两个点告警到**一个你真的会看的邮箱**。

代价是慢：AWS 的账单数据有数小时延迟，等它响的时候钱已经花了一部分。所以它是安全网，不是替代品——Worker 负责在超额之前就把闸拉下来，Budgets 负责在 Worker 没能做到这件事时告诉你。

---

## 六、设计取舍

这一节解释的是「为什么不那样做」。

### 重启由用量驱动，而不是按日期

停机只发生在用量越线时，所以当月剩下的时间里用量会一直卡在阈值之上。「用量回落到阈值以下」与「每月 1 号」捕捉的是同一个事件，但前者没有那个仅 24 小时的窗口。

按日期驱动的版本有个安静的失效模式：如果 1 号那天恰好凭据过期、或者 AWS 抽风，重启就错过了，实例一直停到下个月。用量驱动下，跨月之后**每一次触发**都是一次新的补救机会。

### 「恰好零字节」作为查询状态的闸门

见[工作原理](#二工作原理)。一句话：它把正常路径每次触发的调用从 3 次压到 2 次，每月省下约 4300 次 API 调用，代价是一个在物理上不可能误判的假设——运行中的实例产生零字节流量。

### `MANUAL_HOLD` 与 `"true"` 精确比较

打错字时（`"True"`、`"yes"`、`"1"`）重启逻辑仍然有效。方向是刻意选的：一个失效时默认放行的锁是可以补救的；而一个因为笔误就生效的锁，会把实例摁在那里，直到有人发现站点不见了。

### `THRESHOLD` 必须是 (0, 1] 的小数

上界卡在 1，是为了让「按百分比写成 `80`」在启动时就被拒绝。不校验的话它会变成 81,920 GiB 的停机线——一个永远够不到的上限，也就是一个看起来在跑、实际上什么都不做的看门狗。

### 配置解析失败即硬错误

`Number("1,024")` 是 `NaN`，而**与 `NaN` 的任何比较都是 false**。`used < limit` 为 false 会被后续逻辑读作「已超额」，于是这台实例会被立刻停掉。所以每一个数值变量都必须在第一次触发时大声失败，而不是套用某个静默的默认值继续跑。

### 没有运行时的「关闭保护」开关

**一旦越线，就没有任何办法让实例照常跑下去**，这是刻意的。`MANUAL_HOLD` 抑制的是启动而不是停机，所以它救不了场；手动去控制台把实例启动起来，也只能换来十分钟——下一次触发会把它按回去。

如果你确实决定「宁可认了这笔超额费用，也不能让站点下线」，唯一受支持的做法是把 `THRESHOLD` 调高（设 `1` 即当月不再停机）后重新部署，事后再改回来。

运行时开关会友好得多。但**一个能关掉保护的开关，就是一个会被忘记打开回来的开关**；而一个从三月起就被悄悄禁用、无人看管的账单护栏，恰恰是这个 Worker 存在所要防止的场景。

改文件再部署确实麻烦，而这正是重点——它难以被随手做掉，它会留在 `git log` 里，那个 diff 会一直显得不对劲，直到有人把它改回来。

### 停机不是应用层的优雅关闭

`StopInstance` 从实例角度看等同于断电。如果工作负载需要把状态刷到磁盘，就把 `THRESHOLD` 设低一些，给自己留出反应余地。

### 安全裕度只由 `THRESHOLD` 提供

想要更大的余量就调低 `THRESHOLD`，**不要靠单位换算制造缓冲**。藏在换算里的缓冲既写不进配置，也读不出来——半年后没人能说清那个数字是怎么来的。

### 指标是有延迟的

Lightsail 的指标比真实流量晚几分钟落库，所以观察到的用量总是落后于实际用量。默认配置在 1 TB 套餐上留了 204.8 GiB 的余量，对这点延迟来说非常充裕；把 `THRESHOLD` 往 1.0 调会侵蚀它。

---

## 七、Workers 免费版的硬约束

代码里有三处形状是被运行环境直接决定的，改之前先知道原因。

- **只有一个 cron trigger。** 免费版每账号只允许 5 个，这个账号已经有 3 个用于其它项目。所以重启逻辑是在同一个 handler 内部分支处理的，而不是再占一个 trigger。
- **`period` 取 86400（一天）而不是 3600（一小时）。** 免费版每次调用的 CPU 时间是 10 ms。按天粒度，「月初至今」每个指标返回约 31 个数据点；按小时会返回约 744 个，光解析那份 JSON 就会撑爆 CPU 预算。
- **`workers_dev` 与 `preview_urls` 都关掉。** 这个 Worker 没有 `fetch` handler，公开 URL 只会返回错误——还会给一个专门用来压低流量的东西招来流量。

---

## 八、已知限制：单实例假设

**这个 Worker 只统计 `INSTANCE_NAME` 这一个实例的流量，而额度是按区域 + `bundleId` 汇总的。** 这个假设是承重的，而且在 AWS 控制台里任何地方都没有写明，所以在这里说清楚：

- 该区域该规格**只有这一台**实例时，两个数字是一回事，读数准确。
- 再开一台**不同规格**的实例 → 各有各的额度，读数依然准确。
- 再开一台**同规格**的实例 → 两台共享同一份额度，**本 Worker 的读数是低估**。它会一边报告一切正常，一边放任你冲过配额。

真到那一天，改法是把 `GetInstanceMetricData` 换成先 `GetInstances`、再对同区域同 `bundleId` 的实例逐个求和。在那之前，请让这个账号在该区域该规格下只有一台实例。

---

## 九、Lightsail API 的坑

改代码之前值得知道的几件事，每一件都曾经或可能悄悄地把事情弄错：

- **请求字段是小驼峰**（`instanceName` 而不是 `InstanceName`），与多数 AWS JSON API 相反。写错只会得到一个毫无提示意义的 400。
- **时间戳走 Unix 秒**，不是 ISO 字符串。多乘或少乘一个 1000 是这里的经典 bug——秒级时间戳是 10 位，毫秒级是 13 位。
- 协议是 **JSON 1.1**，靠 `X-Amz-Target: Lightsail_20161128.{Operation}` 分发操作，不是靠 URL path。
- **`NetworkIn` / `NetworkOut` 的单位是字节**，按 5 分钟间隔上报，最有用的统计量是 `Sum`。
- **数据点保留期随粒度变化**：60 秒粒度 15 天，300 秒粒度 63 天，3600 秒粒度 455 天。
- **`period` 必须是 60 的倍数**，范围 60–86400。本项目取上限 86400，原因见[上一节](#七workers-免费版的硬约束)。

---

## 十、测试

```bash
npm test
```

跑在裸 `node --test` 上，纯逻辑，不联网，不碰 AWS。`test/scheduled.test.js` 打桩 `globalThis.fetch` 端到端地跑整个 handler——请求确实经过 `aws4fetch` 真实签名，但没有任何东西离开本进程。

`test/month.test.js` 刻意把时区设成 `America/Los_Angeles`。每条断言都是针对精确的 epoch 值写的，所以它们在任何时区下都成立；但**一个改用本地时间辅助函数的实现，在 `TZ=UTC` 下会碰巧通过**。正是这个时差让这些测试具备鉴别力。

### 在本地触发真实的 handler

把凭据写进 `.dev.vars`（已 gitignore，**绝不提交**）：

```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

然后起本地 dev server：

```bash
npx wrangler dev --test-scheduled
```

在另一个终端手动触发一次：

```bash
curl http://localhost:8787/__scheduled
```

**这会真的调用 AWS API。** 如果目标实例已经超过阈值，它会被真的停掉。请指向一台测试实例，或者临时把 `THRESHOLD` 调高。

---

## 十一、目录结构与依赖

```
src/index.js    Worker 本体
test/           单元测试（node:test，不依赖测试运行器）
wrangler.jsonc  cron trigger、vars、observability
```

唯一的运行时依赖是 [`aws4fetch`](https://github.com/mhart/aws4fetch)，版本钉死在 `1.0.20`，约 4 KB，负责完成 SigV4 签名。AWS SDK 对一个 Worker 来说太大了。

纯 JavaScript 加 JSDoc 类型标注，除 Wrangler 原生处理之外没有任何构建步骤。

代码里的日志文本与错误消息保留英文——它们会和 Workers 控制台、AWS 返回的英文报错混在一起，保持一致更便于检索。测试用例名同理。文档正文用中文。
