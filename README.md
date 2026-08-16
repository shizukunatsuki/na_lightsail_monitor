# na-lightsail-monitor

A Cloudflare Worker that watches an AWS Lightsail instance's month-to-date
network transfer and **stops the instance** before it eats through its plan's
data transfer allowance. When the allowance resets and usage falls back to zero,
it starts the instance again.

The point is to make a runaway bandwidth bill structurally impossible. Lightsail
bills transfer overage per GB (the rate varies by region), so an instance serving
traffic it shouldn't can turn a $5/month plan into a four-figure invoice before
anyone notices.

The check is stateless — every run recomputes usage from the Lightsail metrics
API, so there is no store to corrupt and nothing to reconcile after a failed run.

---

## How it works

A single cron trigger (`*/10 * * * *`) runs the `scheduled` handler. Every run
starts by measuring, and the measurement decides everything that follows:

1. **Usage** — sum `NetworkIn` + `NetworkOut` for the month to date and divide by
   10⁹. Two API calls, always.
2. **At or over `QUOTA_GB × THRESHOLD`** → check the instance state. `running` →
   stop it, log at error level, POST to `ALERT_WEBHOOK`. Anything else → nothing
   to do; it is already down or on its way. *(4 calls, or 3 if already stopped.)*
3. **Under the threshold with traffic on the meter** → log the number and return.
   This is the normal path, and it is the whole run: two calls, no state lookup.
4. **Under the threshold with exactly zero bytes** → check the instance state.
   `stopped` → start it and POST to `ALERT_WEBHOOK`. *(4 calls.)*

Anything thrown anywhere in that sequence is POSTed as an `error` event and then
rethrown, so the invocation is still recorded as a failure.

### Why the restart keys off usage rather than the date

A stop only ever happens at or above the threshold, so month-to-date usage stays
above it for the rest of that month. "Back under the threshold" therefore cannot
occur until the allowance resets — the same event a *1st of the month* check
would catch, without its single 24-hour window. If credentials expire or AWS is
having a bad day, a date-driven restart gets one day of attempts and then leaves
the instance down until the following month; a usage-driven one retries every ten
minutes for as long as the condition holds.

The zero-bytes gate in step 4 is what keeps the normal path at two API calls. A
running instance transfers *something* within minutes — DNS, NTP, background port
scans — so a month-to-date total of exactly zero means it is not up. Checking
`GetInstanceState` on every under-threshold run instead would cost ~4,300 extra
calls a month to catch one restart.

One consequence worth knowing: an instance **you** stopped mid-month, after it
had already moved some traffic, is not auto-started, because its usage is not
zero. It is picked up at the next month boundary. Use `MANUAL_HOLD` if you want
it left alone past that.

Both directions count toward the check. Only *outbound* overage is billed, but
the allowance itself is consumed by both, so both belong in the comparison.

### What `QUOTA_GB = 1000` and `THRESHOLD = 0.8` actually stop at

Two conservative choices stack here, and the combined effect is not 80%. Read
this before you tune either number.

`QUOTA_GB` is counted in units of 10⁹ bytes, and the Worker divides raw byte
counts by 10⁹. So the defaults stop the instance at **8 × 10¹¹ bytes** of
combined transfer. What fraction of the real allowance that is depends on what
AWS means by "1 TB", which their console does not spell out:

| If Lightsail's 1 TB is… | 8 × 10¹¹ bytes is | Headroom left |
| --- | --- | --- |
| 10¹² bytes (decimal TB) | **80%** of the allowance | 200 GB of headroom |
| 2⁴⁰ bytes (binary TiB) | **≈ 73%** of the allowance | ~300 GB of headroom |

So the true stop point sits somewhere in the **73%–80%** band, not at a known
80%. Tune `THRESHOLD` against the pessimistic end: `0.9` means "stop somewhere
between 82% and 90%", and `1.0` means "stop between 91% and 100%" — which leaves
no margin at all for the metric lag described below. Erring low is the correct
direction for a bill guard, which is why it is built this way, but you should
know you are starting from ~73% and not from 80%.

If you have a plan whose allowance is not 1 TB, set `QUOTA_GB` to the plan figure
in the console and the same reasoning carries over unchanged.

There is deliberately **one** cron trigger: the Workers Free plan allows five per
account, and the restart branches inside the handler rather than claiming a
second one.

`workers_dev` and `preview_urls` are both off. This Worker has no `fetch`
handler, so a public URL would serve nothing but errors and attract traffic to a
thing whose entire job is to keep traffic down.

---

## Setup

### 1. AWS: an IAM user with four actions

Create an IAM user with programmatic access and attach this policy. It grants
nothing beyond what the Worker calls.

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

`"Resource": "*"` is the practical choice here. Lightsail resource ARNs are built
from an instance's generated GUID rather than its name
(`arn:aws:lightsail:REGION:ACCOUNT:Instance/GUID`), so narrowing the policy means
looking that ARN up first with `aws lightsail get-instance --instance-name NAME`
and pasting it in. Worth doing if the account holds instances you never want this
Worker to touch.

Then create an access key for the user and keep the two values to hand.

### 2. Configure the plain vars

Edit `wrangler.jsonc` — `AWS_REGION` and `INSTANCE_NAME` ship as placeholders:

| Var | Example | Notes |
| --- | --- | --- |
| `AWS_REGION` | `ap-northeast-1` | Lightsail region of the instance |
| `INSTANCE_NAME` | `my-blog` | Lightsail instance name, not its ARN or GUID |
| `QUOTA_GB` | `1000` | Plan allowance, counted as 10⁹ bytes |
| `THRESHOLD` | `0.8` | Fraction of the quota at which to stop; must be in (0, 1] |
| `ALERT_WEBHOOK` | `https://…` | POST target for stop / start / error notifications. **Set this** — see below |
| `MANUAL_HOLD` | *(optional)* | `"true"` suppresses every start; anything else, or absent, is off |

`MANUAL_HOLD` is the switch for planned downtime: with it set, the Worker will
never bring the instance back up, but it still stops it if usage goes over the
line. It is compared against the exact string `"true"` — `"True"`, `"yes"` and
`"1"` all read as off, deliberately, since a hold that engages on a typo pins the
instance down until somebody notices the site is missing.

`THRESHOLD` is a fraction, not a percentage — the Worker rejects `80` at startup
rather than quietly setting an 80,000 GB limit it would never reach. Likewise a
`QUOTA_GB` that does not parse as a positive number is a hard error, because a
`NaN` comparison would read as "over quota" and stop the instance.

Find your plan's allowance under *Lightsail → Instances → your instance →
Networking → Monthly data transfer*.

### 3. Alerting is not optional

`ALERT_WEBHOOK` is presented as an optional var. Treat it as required. Without
it:

- **A stop is silent.** The instance goes down, the Worker writes one
  `console.error` line into Workers logs, and that is the entire notification.
  Nobody reads Workers logs unprompted. You find out when you visit your own
  site.
- **A broken watchdog is silent too**, and this is the worse half. A mistyped
  `INSTANCE_NAME`, an expired access key, a deleted IAM user, a bad deploy — each
  makes every run throw. The Worker keeps being invoked every ten minutes, keeps
  failing, and keeps guarding nothing. From the outside it is indistinguishable
  from a healthy watchdog on a quiet month.

Every run that throws now POSTs an `error` event before rethrowing, so a webhook
turns that second case into something you actually receive. Point it at whatever
you read: a Slack or Discord incoming webhook, an ntfy/Pushover topic, an email
relay. It only needs to accept a JSON POST.

If you would rather alert on the Worker's error rate instead, that works too —
but configure *something*. The default configuration tells you nothing.

#### AWS Budgets is the one signal this Worker cannot compromise

Every alert above is emitted **by the Worker itself**, which means every one of
them shares the Worker's failure modes. If the Worker is not running at all —
deleted, its cron trigger disabled, its account suspended, its deploy broken
before the handler is reached — no error alert is ever generated, because
nothing is there to generate it.

So configure an **AWS Budgets** alert as well, in the AWS console, independently
of this repository:

1. *Billing and Cost Management → Budgets → Create budget*.
2. A cost budget slightly above your normal monthly Lightsail spend (a $5
   instance with no overage bills ~$5; set the budget at, say, $10).
3. Alert at 80% and 100% of budgeted amount, to an email address you read.

That alert is generated by AWS, from AWS's own billing data, and arrives whether
or not this Worker exists. It is the backstop for the case where the watchdog is
gone, and it is the only signal in this design that is genuinely independent. It
is slower than the Worker — billing data lags by hours — so it is a safety net,
not a replacement.

### 4. Set the secrets

Never put these in `wrangler.jsonc`:

```sh
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

Each prompts for the value and stores it encrypted on Cloudflare.

### 5. Deploy

```sh
npm install
npx wrangler deploy
```

Confirm the trigger under *Workers & Pages → na-lightsail-monitor → Settings →
Triggers*. Logs are available in the dashboard (`observability` is enabled) or by
tailing:

```sh
npx wrangler tail
```

A healthy run logs one line:

```
my-blog: 137.482 GB used month-to-date, under the 800.000 GB stop threshold
```

---

## Testing

Unit tests — pure logic, no network, no AWS:

```sh
npm test
```

These cover the month-boundary math (the off-by-one that would silently break
everything at the rollover), the seconds-vs-milliseconds conversion, config
validation, and the handler end-to-end against a stubbed `fetch`: request shape,
the idempotent stop path, the usage-driven restart and its `MANUAL_HOLD`
suppression, the two-call cost of a normal run, and that a failed AWS call
alerts, throws, and keeps both credentials out of the message and the payload.

The date tests run under `TZ=America/Los_Angeles` on purpose. Every assertion is
written against an exact epoch value, so it holds in any zone — but an
implementation that reached for local-time helpers would coincidentally pass
under `TZ=UTC`. The offset is what makes those tests worth running.

To fire the real handler locally, put the credentials in `.dev.vars` (gitignored,
never commit it):

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

then:

```sh
npx wrangler dev --test-scheduled
curl http://localhost:8787/__scheduled
```

> **This talks to the real AWS API.** If the instance is genuinely over its
> threshold, a local run will stop it for real. Point it at a test instance, or
> raise `THRESHOLD` in `wrangler.jsonc` while you experiment.

---

## Things worth knowing before you rely on this

- **The billing month is UTC.** The allowance resets at 00:00 UTC on the 1st,
  which is the afternoon of the last day of the month in the Americas. The Worker
  computes everything in UTC; your Lightsail console may not.
- **It only counts one instance; the allowance is per account.** Lightsail pools
  the data transfer allowance across every instance on the account, but this
  Worker queries `GetInstanceMetricData` for `INSTANCE_NAME` alone. With one
  Lightsail instance those are the same number. Add a second instance and the
  Worker's figure is an *undercount* of what the account is actually consuming —
  it will let you sail past the real quota while reporting you are fine. If you
  ever add instances, this needs to become a `GetInstances` call and a sum over
  all of them; until then, the single-instance assumption is load-bearing and
  undocumented anywhere in the AWS console.
- **It will restart an instance you stopped on purpose**, once the month rolls
  over and its usage reads zero. Set `MANUAL_HOLD` to `"true"` for planned
  downtime — it blocks every start while leaving the bill guard active. A
  mid-month manual stop is safe until the boundary regardless, since usage is
  non-zero by then.
- **A stop is not a graceful shutdown of your app.** It is the equivalent of a
  power-off from the instance's perspective. If your workload needs to flush
  state, use `ALERT_WEBHOOK` to get ahead of it, or set `THRESHOLD` low enough to
  leave yourself room.
- **Metrics lag.** Lightsail metric data lands a few minutes behind real traffic,
  so the observed figure trails actual usage. The defaults leave 200–300 GB of
  headroom on a 1 TB plan, which is plenty; raising `THRESHOLD` toward 1.0 eats
  into that margin — see the units table above for what those numbers really
  mean.
- **Failures are loud on purpose.** Any non-2xx from AWS throws. The handler
  catches it at the top, POSTs an `error` event, and rethrows, so the invocation
  is still recorded as a failure in Workers logs *and* reaches you. With no
  webhook configured only the first half of that happens.
- The alert webhook is best-effort and never throws — not on the stop path, where
  the instance is already down and a webhook outage must not make a successful
  stop look like a failed run, and not on the error path, where it must not
  replace the original exception with its own.

## Alert payload

Three events, all POSTed as JSON. Credential values never appear in any of them;
AWS error text is scrubbed of both keys before it is included.

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

An `error` event means the watchdog did not complete its run — the instance was
neither checked nor acted on. One is a blip; a steady stream every ten minutes
means you are unprotected.

## Layout

```
src/index.js    the Worker
test/           unit tests (node:test, no runner dependency)
wrangler.jsonc  trigger, vars, and observability config
```

One runtime dependency, [`aws4fetch`](https://github.com/mhart/aws4fetch), pinned
to `1.0.20` — it does SigV4 signing in about 4 KB. The AWS SDK is far too large
for a Worker. Plain JavaScript with JSDoc types, so there is no build step beyond
what Wrangler does natively and the tests run on bare `node --test`.
