# na-lightsail-monitor

A Cloudflare Worker that watches an AWS Lightsail instance's month-to-date
network transfer and **stops the instance** before it eats through its plan's
data transfer allowance. On the 1st of the next billing month it starts the
instance back up.

The point is to make a runaway bandwidth bill structurally impossible. Lightsail
bills transfer overage per GB (the rate varies by region), so an instance serving
traffic it shouldn't can turn a $5/month plan into a four-figure invoice before
anyone notices.

The check is stateless — every run recomputes usage from the Lightsail metrics
API, so there is no store to corrupt and nothing to reconcile after a failed run.

---

## How it works

A single cron trigger (`*/10 * * * *`) runs the `scheduled` handler:

1. **On the 1st of the month (UTC)** — if the instance is `stopped`, start it and
   return. The allowance has reset. If it is already running, fall through.
2. **Usage check** — sum `NetworkIn` + `NetworkOut` for the month to date and
   divide by 10⁹.
3. Under `QUOTA_GB × THRESHOLD`? Log the number and return.
4. Otherwise check the instance state. Not `running` → return; it is already
   stopped and there is nothing to do.
5. Stop the instance, log at error level, and POST to `ALERT_WEBHOOK` if set.

Both directions count toward the check. Only *outbound* overage is billed, but
the allowance itself is consumed by both, so both belong in the comparison.

Usage is divided by 10⁹, not 2³⁰. That over-counts by ~7%, which trips the stop
slightly early — the correct direction to be wrong in for a bill guard.

There is deliberately **one** cron trigger: the Workers Free plan allows five per
account, and the monthly restart branches inside the handler rather than
claiming a second one.

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
| `ALERT_WEBHOOK` | *(optional)* | POST target for a JSON notification on stop/start |

`THRESHOLD` is a fraction, not a percentage — the Worker rejects `80` at startup
rather than quietly setting an 80,000 GB limit it would never reach. Likewise a
`QUOTA_GB` that does not parse as a positive number is a hard error, because a
`NaN` comparison would read as "over quota" and stop the instance.

Find your plan's allowance under *Lightsail → Instances → your instance →
Networking → Monthly data transfer*.

### 3. Set the secrets

Never put these in `wrangler.jsonc`:

```sh
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

Each prompts for the value and stores it encrypted on Cloudflare.

### 4. Deploy

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
everything on the 1st), the seconds-vs-milliseconds conversion, config
validation, and the handler end-to-end against a stubbed `fetch`: request shape,
the idempotent stop path, the restart branch, and that a failed AWS call throws
with the access key id scrubbed out of the message.

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
- **The 1st-of-month branch will restart an instance you stopped on purpose.** If
  you take the instance down for your own reasons and leave it down over a month
  boundary, this brings it back. Disable the trigger first.
- **A stop is not a graceful shutdown of your app.** It is the equivalent of a
  power-off from the instance's perspective. If your workload needs to flush
  state, use `ALERT_WEBHOOK` to get ahead of it, or set `THRESHOLD` low enough to
  leave yourself room.
- **Metrics lag.** Lightsail metric data lands a few minutes behind real traffic,
  so the observed figure trails actual usage. The default 0.8 threshold leaves
  200 GB of headroom on a 1 TB plan, which is plenty; if you raise the threshold
  toward 1.0 you are eating into that margin.
- **Failures are loud on purpose.** Any non-2xx from AWS throws, which surfaces
  the invocation as an error in Workers logs. A watchdog that fails quietly is
  worse than no watchdog — if you want to be told, set up an alert on the
  Worker's error rate.
- The alert webhook is best-effort and never throws: the instance has already
  been stopped by the time it fires, and a webhook outage must not make a
  successful stop look like a failed run.

## Alert payload

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

The restart sends `{"event": "started", "instanceName": ..., "reason": ..., "timestamp": ...}`.

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
