# na-lightsail-monitor

一个 Cloudflare Worker，监视 AWS Lightsail 实例月初至今的网络传输量，赶在它把套餐自带的
数据传输额度耗尽之前**把实例停掉**。等到额度重置、用量回落到零，再把实例启动回来。

它存在的意义是让「带宽账单失控」这件事在结构上不可能发生。Lightsail 的传输超量是按 GB
计费的（费率随区域不同），所以一台在跑不该跑的流量的实例，能在任何人察觉之前，把一个
每月 5 美元的套餐变成一张四位数的账单。

这套检查是无状态的 —— 每次运行都从 Lightsail 指标 API 重新计算用量，因此没有会损坏的
存储，一次失败的运行之后也没有什么需要对账。

---

## 工作原理

一个 cron trigger（`*/10 * * * *`）驱动 `scheduled` handler。每次运行都从测量开始，
之后的一切都由测量结果决定：

1. **用量** —— 把月初至今的 `NetworkIn` + `NetworkOut` 求和，再除以 10⁹。固定两次 API
   调用。
2. **达到或超过 `QUOTA_GB × THRESHOLD`** → 查询实例状态。`running` → 停机、按 error
   级别记日志、POST 到 `ALERT_WEBHOOK`。其它状态 → 无事可做，它要么已经停了、要么正在
   停。*（4 次调用；若已停机则为 3 次。）*
3. **低于阈值且计量表上有流量** → 记下这个数字然后返回。这是正常路径，整次运行就到此
   为止：两次调用，不查状态。
4. **低于阈值且恰好为零字节** → 查询实例状态。`stopped` → 启动它并 POST 到
   `ALERT_WEBHOOK`。*（4 次调用。）*

上述流程中任何位置抛出的异常，都会先以 `error` 事件 POST 出去，再重新抛出，因此这次调用
在日志里仍然记为失败。

### 为什么重启看用量而不是看日期

停机只会发生在用量达到或超过阈值时，所以那个月剩下的时间里，月初至今的用量会一直卡在
阈值之上。也就是说，「重新回到阈值以下」在额度重置之前根本不可能发生 —— 它和「每月 1 号」
那种检查捕捉的是同一个事件，却没有那个仅有 24 小时的窗口。如果凭据过期，或者 AWS 那天
状态不好，按日期驱动的重启只有一天的尝试机会，之后实例就一直停到下个月；而按用量驱动的
版本，只要条件仍然成立，就每十分钟重试一次。

第 4 步里那道「零字节」闸门，是正常路径能维持在两次 API 调用的原因。运行中的实例几分钟内
必然产生*某些*流量 —— DNS、NTP、后台端口扫描 —— 所以月初至今总量恰好为零，就意味着它
没有起来。若改成在每一次「低于阈值」的运行里都查 `GetInstanceState`，为了捕捉一次重启，
每月要多花约 4300 次调用。

有一个后果值得知道：如果是**你自己**在月中把实例停掉的，而它当时已经跑过一些流量，那么
它不会被自动启动，因为用量不为零。它会等到下一个月份边界才被接手。如果你希望过了那个
边界也别动它，就用 `MANUAL_HOLD`。

两个方向都计入这项检查。虽然只有*出向*超量才计费，但额度本身是被两个方向共同消耗的，
所以两者都该进入比较。

### `QUOTA_GB = 1000` 加 `THRESHOLD = 0.8` 究竟停在哪里

这里叠了两层保守选择，合起来的效果并不是 80%。调整这两个数字之前请先读这一节。

`QUOTA_GB` 是以 10⁹ 字节为单位计的，而 Worker 也是把原始字节数除以 10⁹。所以默认配置会在
双向合计 **8 × 10¹¹ 字节**时停机。这占真实额度的多少，取决于 AWS 所说的「1 TB」到底是什么
意思 —— 而他们的控制台并没有讲清楚：

| 若 Lightsail 的 1 TB 是… | 8 × 10¹¹ 字节相当于 | 剩余余量 |
| --- | --- | --- |
| 10¹² 字节（十进制 TB） | 额度的 **80%** | 200 GB |
| 2⁴⁰ 字节（二进制 TiB） | 额度的 **约 73%** | 约 300 GB |

所以真实的停机点落在 **73%–80%** 这个区间里，而不是一个已知的 80%。调 `THRESHOLD` 时请
按悲观的那一端来估：`0.9` 意味着「停在 82% 到 90% 之间的某处」，`1.0` 意味着「停在 91% 到
100% 之间」—— 后者对下文提到的指标延迟已经不留任何余地了。往低了算对账单护栏来说是正确的
方向，这也正是它被这样设计的原因，但你应当知道你的起点是约 73%，而不是 80%。

如果你的套餐额度不是 1 TB，把 `QUOTA_GB` 设成控制台里显示的那个数字即可，上面的推理原样
适用。

这里刻意**只用一个** cron trigger：Workers 免费版每账号允许五个，而重启逻辑是在 handler
内部分支处理的，没有再占一个。

`workers_dev` 和 `preview_urls` 都是关闭的。这个 Worker 没有 `fetch` handler，公开 URL
除了返回错误什么也做不了，还会给一个「全部工作就是压低流量」的东西招来流量。

---

## 部署步骤

### 1. AWS：一个只有四项权限的 IAM 用户

创建一个具备编程访问权限的 IAM 用户，附加下面这份策略。它授予的权限不多于 Worker 实际
调用的那些。

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

这里用 `"Resource": "*"` 是务实的选择。Lightsail 的资源 ARN 是用实例自动生成的 GUID
拼出来的，而不是实例名（`arn:aws:lightsail:REGION:ACCOUNT:Instance/GUID`），所以要收窄
这份策略，就得先用 `aws lightsail get-instance --instance-name NAME` 把那个 ARN 查出来
再粘进去。如果账号里还有你绝不希望这个 Worker 碰到的实例，那这一步值得做。

然后为该用户创建访问密钥，把两个值留在手边。

### 2. 配置明文变量

编辑 `wrangler.jsonc` —— `AWS_REGION` 和 `INSTANCE_NAME` 出厂时是占位值：

| 变量 | 示例 | 说明 |
| --- | --- | --- |
| `AWS_REGION` | `ap-northeast-1` | 实例所在的 Lightsail 区域 |
| `INSTANCE_NAME` | `my-blog` | Lightsail 实例名，不是 ARN 也不是 GUID |
| `QUOTA_GB` | `1000` | 套餐额度，按 10⁹ 字节计 |
| `THRESHOLD` | `0.8` | 达到配额的这个比例时停机；必须落在 (0, 1] 内 |
| `ALERT_WEBHOOK` | `https://…` | 停机 / 启动 / 错误通知的 POST 目标。**务必配置** —— 见下文 |
| `MANUAL_HOLD` | *（可选）* | `"true"` 抑制所有启动；其它任何值或不设置都表示关闭 |

`MANUAL_HOLD` 是计划内停机时用的开关：设上之后 Worker 永远不会把实例拉起来，但用量越线时
它照样会停机。它与字符串 `"true"` 精确比较 —— `"True"`、`"yes"`、`"1"` 都被视为关闭，
这是刻意的：一个因为打错字就生效的锁，会把实例摁在那里，直到有人发现站点不见了。

`THRESHOLD` 是小数不是百分比 —— Worker 会在启动时拒绝 `80`，而不是不声不响地设成一个
永远够不到的 80,000 GB 上限。同理，`QUOTA_GB` 若不能解析为正数就是硬错误，因为与 `NaN`
的比较会被读作「已超额」并停掉实例。

你的套餐额度可以在 *Lightsail → 实例 → 你的实例 → 网络 → 每月数据传输* 里找到。

### 3. 告警是必需项，不是可选项

`ALERT_WEBHOOK` 在表里写的是可选变量。请把它当成必填。不配它的话：

- **停机是无声的。** 实例下线，Worker 往 Workers 日志里写一行 `console.error`，通知就到此
  为止。没有人会主动去翻 Workers 日志。你会在自己打开站点时才发现。
- **看门狗自己坏掉同样无声**，而这是更糟的那一半。打错的 `INSTANCE_NAME`、过期的访问
  密钥、被删掉的 IAM 用户、一次坏掉的部署 —— 每一种都会让每次运行都抛异常。Worker 仍然
  每十分钟被调用一次，仍然每次都失败，也仍然什么都没在守护。从外面看，它和一个安然度过
  淡季的健康看门狗毫无区别。

现在每一次抛异常的运行都会先 POST 一条 `error` 事件再重新抛出，所以一个 webhook 能把
第二种情况变成你真的收得到的东西。把它指向任何你会看的地方：Slack 或 Discord 的
incoming webhook、ntfy/Pushover 的主题、一个邮件中继。它只需要能接受 JSON POST。

如果你更愿意改为对 Worker 的错误率告警，那也行 —— 但请务必配*某样东西*。默认配置什么都
不会告诉你。

**在把 webhook 指向任何你会看的地方之前，先把 `INSTANCE_NAME` 填好。** 一个还带着出厂
`CHANGE_ME` 的看门狗会每次运行都失败，而每次运行都会告警 —— 一天 144 条。现在 Worker 会
直接拒绝在占位值下运行，并在报错里说明原因，所以你拿到的是一条读得懂的理由，而不是一整天
的 404；但先把变量填对，显然要省事得多。

#### AWS Budgets 是唯一一个不会被这个 Worker 拖累的信号

上面所有告警都是**由 Worker 自己**发出的，这意味着它们全都共享 Worker 的故障模式。如果
Worker 压根没在运行 —— 被删掉了、cron trigger 被禁用了、账号被停了、部署在还没走到
handler 之前就坏了 —— 那么任何错误告警都不会产生，因为没有东西在那里产生它。

所以请在 AWS 控制台里，独立于本仓库，另外配一个 **AWS Budgets** 告警：

1. *账单与成本管理 → 预算 → 创建预算*。
2. 设一个略高于你 Lightsail 正常月度支出的成本预算（一台 5 美元的实例在没有超量时约
   5 美元；那预算就设成比如 10 美元）。
3. 在预算金额的 80% 和 100% 处告警，发到一个你真的会看的邮箱。

那条告警由 AWS 生成、取自 AWS 自己的账单数据，无论这个 Worker 是否存在都会送达。它是
「看门狗已经没了」这种情况下的兜底，也是本设计中唯一一个真正独立的信号。它比 Worker 慢
—— 账单数据有数小时的延迟 —— 所以它是安全网，不是替代品。

### 4. 设置密钥

这两个值永远不要写进 `wrangler.jsonc`：

```sh
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

每条命令都会提示你输入值，并把它加密存储在 Cloudflare 上。

### 5. 部署

```sh
npm install
npx wrangler deploy
```

到 *Workers & Pages → na-lightsail-monitor → Settings → Triggers* 确认 trigger 已生效。
日志可以在控制台查看（`observability` 已开启），也可以直接 tail：

```sh
npx wrangler tail
```

一次健康的运行只记一行日志：

```
my-blog: 137.482 GB used month-to-date, under the 800.000 GB stop threshold
```

---

## 测试

单元测试 —— 纯逻辑，不联网，不碰 AWS：

```sh
npm test
```

覆盖范围包括：月份边界的计算（那个会在跨月时悄无声息地毁掉一切的差一错误）、秒与毫秒的
换算、配置校验，以及针对打桩 `fetch` 的 handler 端到端测试 —— 请求结构、幂等的停机路径、
由用量驱动的重启及其 `MANUAL_HOLD` 抑制、正常运行只花两次调用，还有 AWS 调用失败时会告警、
会抛出，且两个密钥都不会出现在报错信息和通知载荷里。

日期相关的测试刻意跑在 `TZ=America/Los_Angeles` 下。每一条断言都是针对精确的 epoch 值写的，
所以它在任何时区下都成立 —— 但一个改用本地时间辅助函数的实现，在 `TZ=UTC` 下会碰巧通过。
正是这个时差让那些测试有跑的价值。

要在本地触发真实的 handler，把凭据放进 `.dev.vars`（已在 gitignore 中，绝不要提交）：

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

然后：

```sh
npx wrangler dev --test-scheduled
curl http://localhost:8787/__scheduled
```

> **这会真的调用 AWS API。** 如果实例确实已经超过阈值，本地运行会真的把它停掉。请指向一台
> 测试实例，或者在你折腾期间先把 `wrangler.jsonc` 里的 `THRESHOLD` 调高。

---

## 依赖它之前值得知道的几件事

- **计费月按 UTC 计。** 额度在每月 1 日 00:00 UTC 重置，那个时刻在美洲还是上个月最后一天
  的下午。Worker 一切都按 UTC 计算；你的 Lightsail 控制台未必如此。
- **它只统计一个实例，而额度是按账号算的。** Lightsail 把数据传输额度在账号下的所有实例
  之间汇总，而这个 Worker 只对 `INSTANCE_NAME` 一个实例调用 `GetInstanceMetricData`。
  账号里只有一台 Lightsail 实例时，这两个数字是一回事。一旦加了第二台，Worker 报出的数字
  就是对账号实际消耗的*低估* —— 它会一边告诉你一切正常，一边放任你冲过真正的配额。日后
  若要加实例，这里就得改成调 `GetInstances` 再对所有实例求和；在那之前，「只有单个实例」
  这个假设是承重的，而且在 AWS 控制台里任何地方都没有写明。
- **它会把你故意停掉的实例重新启动**，只要跨过月份边界、用量读数为零。计划内停机请把
  `MANUAL_HOLD` 设为 `"true"` —— 它拦住所有启动，同时保留账单护栏。而月中的手动停机在
  跨月之前本来就是安全的，因为那时用量不为零。
- **一旦越线，就没有任何办法让实例继续跑**，这是刻意的。`MANUAL_HOLD` 抑制的是启动而不是
  停机，所以如果你在月中决定「宁可认了这笔超额费用，也不能让站点下线」，手动启动实例只能
  换来十分钟，下一次运行就会把它按回去。要做这个决定，受支持的做法是把 `wrangler.jsonc`
  里的 `THRESHOLD` 调高 —— 设成 `1` 就等于当月不再停机 —— 然后重新部署。事后记得改回来。

  一个运行时开关会友好得多，而它被刻意省掉了。一个能关掉保护的开关，就是一个会被人忘记
  打开回来的开关；而一个从三月起就被悄悄禁用、无人看管的账单护栏，正是这整个 Worker 存在
  所要防止的场景。改文件再重新部署是有点麻烦，而这正是重点：它很难被随手做掉，它会留在
  `git log` 里，而且那个 diff 会一直杵在那儿显得不对劲，直到有人把它改回来。
- **停机不是应用层的优雅关闭。** 从实例的角度看，它等同于断电。如果你的工作负载需要把状态
  刷盘，就用 `ALERT_WEBHOOK` 抢在前面处理，或者把 `THRESHOLD` 设得足够低给自己留出余地。
- **指标有延迟。** Lightsail 的指标数据比真实流量晚几分钟落库，所以观察到的数字总是落后于
  实际用量。默认配置在 1 TB 套餐上留了 200–300 GB 的余量，这很充裕；把 `THRESHOLD` 往 1.0
  调会侵蚀这块余量 —— 这些数字的真实含义见上文的单位换算表。
- **失败是刻意大声的。** AWS 返回的任何非 2xx 都会抛异常。handler 在最外层捕获它、POST 一条
  `error` 事件，然后重新抛出，所以这次调用*既*在 Workers 日志里记为失败，*也*能送达到你。
  没配 webhook 的话，就只剩前半句。
- 告警 webhook 是尽力而为且永不抛异常的 —— 在停机路径上，实例此时已经停了，webhook 故障
  不该让一次成功的停机看起来像失败的运行；在错误路径上，它也不能用自己的异常顶替掉原始
  异常。此外它带 5 秒超时，这样一个接受连接却不回应的端点无法把整次调用挂死。

## 告警载荷

三种事件，都以 JSON POST 发出。任何一种里都不会出现凭据内容；AWS 的错误文本在被写入之前
已经把两个密钥都抹掉了。

```json
{
  "event": "stopped",
  "instanceName": "my-blog",
  "usedGb": 902.145,
  "thresholdGb": 800,
  "quotaGb": 1000,
  "timestamp": "2026-08-27T14:20:00.000Z"
}
```

```json
{
  "event": "started",
  "instanceName": "my-blog",
  "reason": "Month-to-date transfer is back under the threshold; the allowance has reset.",
  "timestamp": "2026-09-01T00:10:00.000Z"
}
```

```json
{
  "event": "error",
  "instanceName": "my-blog",
  "message": "Lightsail GetInstanceMetricData failed: HTTP 403 {\"__type\":\"InvalidSignatureException\", … [redacted] … }",
  "timestamp": "2026-09-14T08:30:00.000Z"
}
```

收到 `error` 事件意味着这次看门狗没有跑完 —— 实例既没被检查，也没被处理。偶尔一条是抖动；
每十分钟稳定来一条，说明你现在毫无防护。

## 目录结构

```
src/index.js    Worker 本体
test/           单元测试（node:test，不依赖测试运行器）
wrangler.jsonc  trigger、vars 和 observability 配置
```

只有一个运行时依赖 [`aws4fetch`](https://github.com/mhart/aws4fetch)，版本钉死在 `1.0.20`
—— 它用大约 4 KB 完成 SigV4 签名。AWS SDK 对 Worker 来说实在太大了。代码是带 JSDoc 类型
标注的纯 JavaScript，所以除了 Wrangler 原生做的那一步之外没有任何构建步骤，测试直接跑在
裸的 `node --test` 上。

> 说明：代码里的日志文本、错误信息和告警载荷字段刻意保留英文 —— 它们会和 Workers 控制台、
> AWS 的英文报错混在一起显示，保持一致更便于检索。测试用例名同理。
