// 整个套件都跑在一个与 UTC 有明显时差的时区里。下面每一条断言都是针对精确的 epoch
// 值写的，所以它在任何时区下都成立 —— 但一个改用本地时间辅助函数的实现，在 TZ=UTC
// 下会碰巧通过。正是这个时差让这些测试具备鉴别力。
// 注意：运行时设置 process.env.TZ 只在 POSIX 上生效。Windows 的 Node 会忽略它，本文件
// 在那里等于跑在 UTC 下 —— 断言本身设计成时区无关所以仍然全绿，但下面说的那种鉴别力
// 会静默失去。CI 跑在 Linux 上，不受影响。
process.env.TZ = "America/Los_Angeles";

import { test } from "node:test";
import assert from "node:assert/strict";

import { monthStartMs, usageWindow, readConfig, monthElapsedFraction, formatDuration } from "../src/index.js";

const utc = (iso) => new Date(iso);
const epoch = (iso) => Date.parse(iso);

test("monthStartMs snaps to the first instant of the UTC month", () => {
  assert.equal(monthStartMs(utc("2026-08-15T12:34:56Z")), epoch("2026-08-01T00:00:00Z"));
  assert.equal(monthStartMs(utc("2026-08-01T00:00:00Z")), epoch("2026-08-01T00:00:00Z"));
  assert.equal(monthStartMs(utc("2026-08-31T23:59:59.999Z")), epoch("2026-08-01T00:00:00Z"));
});

test("monthStartMs uses UTC, not the local month", () => {
  // 1 号 00:30 UTC 在洛杉矶还是 28 号的 16:30。按本地时间取月初会得到二月，
  // 于是多查进整整一个月的用量。
  const justAfterRollover = utc("2026-03-01T00:30:00Z");
  assert.equal(justAfterRollover.getMonth(), 1, "precondition: local clock still says February");
  assert.equal(monthStartMs(justAfterRollover), epoch("2026-03-01T00:00:00Z"));

  // 镜像情形：31 号 23:30 UTC 在东京已经是 1 号了，但额度还没有重置。
  const justBeforeRollover = utc("2026-03-31T23:30:00Z");
  assert.equal(monthStartMs(justBeforeRollover), epoch("2026-03-01T00:00:00Z"));
});

test("monthStartMs rolls the year over in December", () => {
  assert.equal(monthStartMs(utc("2026-12-31T23:59:59Z")), epoch("2026-12-01T00:00:00Z"));
  assert.equal(monthStartMs(utc("2027-01-01T00:00:00Z")), epoch("2027-01-01T00:00:00Z"));
});

test("monthStartMs handles February in a leap year", () => {
  assert.equal(monthStartMs(utc("2028-02-29T18:00:00Z")), epoch("2028-02-01T00:00:00Z"));
});

test("the allowance boundary is the UTC rollover, not the local one", () => {
  // 重启已经不再看日期了，但查询窗口仍然必须在精确的那一刻翻页：让月初至今的用量
  // 掉回阈值以下的，正是这个窗口，除此之外没有别的东西。下面这两个时刻，就是一个
  // 按本地时间实现的版本会给出不同答案的地方。
  //
  // 此刻本地时间已是 1 号，UTC 还停在 31 号。这时若已经开始查三月，会报出约 0 的
  // 用量，从而把一台额度根本没重置的实例交还回去。
  const tokyoFirst = utc("2026-03-31T16:00:00Z");
  assert.equal(tokyoFirst.getUTCDate(), 31, "precondition: UTC is still the 31st");
  assert.equal(monthStartMs(tokyoFirst), epoch("2026-03-01T00:00:00Z"));
  assert.equal(usageWindow(tokyoFirst).startTime, epoch("2026-03-01T00:00:00Z") / 1000);

  // 镜像情形：本地时间是 2 月 28 日，UTC 已经是 3 月 1 日。窗口必须已经翻过去了，
  // 否则就会错过这次重置。
  const laLastDay = utc("2026-03-01T00:30:00Z");
  assert.equal(laLastDay.getMonth(), 1, "precondition: local clock still says February");
  assert.equal(monthStartMs(laLastDay), epoch("2026-03-01T00:00:00Z"));
  assert.equal(usageWindow(laLastDay).startTime, epoch("2026-03-01T00:00:00Z") / 1000);
});

test("usageWindow returns Unix seconds, not milliseconds", () => {
  const { startTime, endTime } = usageWindow(utc("2026-08-15T12:00:00Z"));
  assert.equal(startTime, epoch("2026-08-01T00:00:00Z") / 1000);
  assert.equal(endTime, epoch("2026-08-15T12:00:00Z") / 1000);

  // 多乘或少乘一个 1000 是这里另一个经典 bug：任何可信日期的秒级时间戳都是 10 位，
  // 毫秒级则是 13 位。
  assert.ok(String(startTime).length === 10 && String(endTime).length === 10);
});

test("usageWindow keeps a non-empty range at the exact month rollover", () => {
  // 否则 1 号 00:00 那一格 cron 会送出 startTime === endTime，而 API 会拒绝它 ——
  // 每月一次，永远如此。
  const { startTime, endTime } = usageWindow(utc("2026-09-01T00:00:00Z"));
  assert.equal(startTime, epoch("2026-09-01T00:00:00Z") / 1000);
  assert.ok(endTime > startTime, "range must be non-empty");
});

test("usageWindow truncates sub-second precision without going backwards", () => {
  const { startTime, endTime } = usageWindow(utc("2026-08-15T12:00:00.750Z"));
  assert.equal(endTime, epoch("2026-08-15T12:00:00Z") / 1000);
  assert.ok(endTime > startTime);
});

test("monthElapsedFraction spans exactly the UTC month, leap years included", () => {
  // 日志里的「照这个月的平均速度整月会用到多少」就靠它。月份长度必须由日历算出来，
  // 不能拿 30 天当近似 —— 二月会把预测抬高约 7%，而这个数是用来判断趋势的。
  assert.equal(monthElapsedFraction(utc("2026-08-01T00:00:00Z")), 0);
  assert.equal(monthElapsedFraction(utc("2026-08-16T12:00:00Z")), 0.5, "八月 31 天，中点是 16 日 12:00");
  assert.equal(monthElapsedFraction(utc("2026-09-16T00:00:00Z")), 0.5, "九月 30 天，中点是 16 日 00:00");
  assert.equal(monthElapsedFraction(utc("2028-02-15T12:00:00Z")), 0.5, "闰年二月 29 天");
  assert.equal(monthElapsedFraction(utc("2026-02-15T00:00:00Z")), 0.5, "平年二月 28 天");

  // 跨年由 Date.UTC(y, 12, 1) 自己处理。
  assert.equal(monthElapsedFraction(utc("2026-12-16T12:00:00Z")), 0.5, "十二月 31 天，中点是 16 日 12:00");
  assert.ok(monthElapsedFraction(utc("2026-12-31T23:59:59Z")) < 1);
});

test("formatDuration covers each range it is meant to distinguish", () => {
  // 速率为零时「还能撑多久」是无穷 —— 那正是实情，不能显示成一个很大的数字。
  assert.equal(formatDuration(Infinity), "never");
  assert.equal(formatDuration(NaN), "never");

  // 不到一小时按分钟。视野是 60 分钟时这一档从 handler 那头走不到（正常那一行只在
  // 「撑得过视野」时才写），但把视野调低它就会活过来 —— 所以在这里直接测。
  assert.equal(formatDuration(0), "0 min");
  assert.equal(formatDuration(1740), "29 min");
  assert.equal(formatDuration(3599), "60 min");

  assert.equal(formatDuration(3600), "1.0 h");
  assert.equal(formatDuration(47 * 3600), "47.0 h");

  // 48 小时以上按天，超过 90 天封顶 —— 额度每月都会重置，再精确也没有意义。
  assert.equal(formatDuration(48 * 3600), "2.0 d");
  assert.equal(formatDuration(90 * 86400), "90.0 d");
  assert.equal(formatDuration(91 * 86400), "> 90 d");
});

const validEnv = {
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  AWS_REGION: "ap-northeast-1",
  INSTANCE_NAME: "example-instance",
  QUOTA_GIB: "1024",
  THRESHOLD: "0.8",
};

test("readConfig parses the plain vars into numbers", () => {
  const config = readConfig(validEnv);
  assert.equal(config.region, "ap-northeast-1");
  assert.equal(config.instanceName, "example-instance");
  assert.equal(config.quotaGib, 1024);
  assert.equal(config.threshold, 0.8);
  assert.equal(config.manualHold, false);
});

test("readConfig derives the log identity from the name and the region", () => {
  // 每行日志的前缀。实例名只在单个区域内唯一，所以两者都要有 —— 这个仓库是公开的，
  // 谁复制过去都会得到一份自我说明的日志。
  assert.equal(readConfig(validEnv).label, "example-instance@ap-northeast-1");
  assert.equal(
    readConfig({ ...validEnv, INSTANCE_NAME: "blog", AWS_REGION: "us-east-1" }).label,
    "blog@us-east-1",
  );
});

test("readConfig only honours MANUAL_HOLD spelled exactly \"true\"", () => {
  assert.equal(readConfig({ ...validEnv, MANUAL_HOLD: "true" }).manualHold, true);

  // 一个「失效时默认放行」的锁是可以补救的；而一个因为打错字就生效的锁，会把实例
  // 摁在那里，直到有人发现博客不见了。
  for (const MANUAL_HOLD of ["True", "TRUE", "yes", "1", "", " true", undefined]) {
    assert.equal(readConfig({ ...validEnv, MANUAL_HOLD }).manualHold, false, JSON.stringify(MANUAL_HOLD));
  }
});

test("readConfig rejects a QUOTA_GIB that would compare as NaN", () => {
  // `usedGib < NaN` 恒为 false，这会被读作「已超额」并停掉实例。所以必须在这里大声
  // 报错。缺失（`undefined`）也在其中：旧部署里残留的 QUOTA_GB 不会被读取，此时
  // 就该在第一次触发时响亮地失败，而不是套用某个静默的默认值继续跑。
  for (const QUOTA_GIB of ["1,024", "1024 GiB", "", undefined, "0", "-5"]) {
    assert.throws(() => readConfig({ ...validEnv, QUOTA_GIB }), /QUOTA_GIB/);
  }
});

test("readConfig rejects a QUOTA_GIB large enough to disable the watchdog", () => {
  // 1e308 能通过「有限且为正」那道检查，但 1e308 × 2^30 溢出成 Infinity，停机线于是变成
  // 一个永远够不到的数 —— 一个看起来在跑、实际什么都不做的看门狗。这正是 THRESHOLD
  // 上界要防的是同一件事，两个变量都需要。
  for (const QUOTA_GIB of ["1e308", "1e30", String(Number.MAX_SAFE_INTEGER)]) {
    assert.throws(() => readConfig({ ...validEnv, QUOTA_GIB }), /QUOTA_GIB must be a positive number of at most/);
  }
  // 上界正好卡在「字节数仍是安全整数」那一点上（8388607.99… GiB ≈ 8 PiB/月），
  // 不会误伤任何真实配置。
  assert.equal(readConfig({ ...validEnv, QUOTA_GIB: "8388607" }).quotaGib, 8388607);
  assert.equal(readConfig({ ...validEnv, QUOTA_GIB: "7168" }).quotaGib, 7168);
});

test("readConfig ignores a stale QUOTA_GB binding entirely", () => {
  // 没有向后兼容：只有 QUOTA_GB 的环境必须抛错，不能悄悄按 1000 跑下去。
  const { QUOTA_GIB, ...withoutQuota } = validEnv;
  assert.throws(() => readConfig({ ...withoutQuota, QUOTA_GB: "1000" }), /QUOTA_GIB/);
});

test("readConfig rejects a THRESHOLD written as a percentage", () => {
  // 把 "80" 当成 80% 来写，得到的是 81,920 GiB 的上限 —— 一个永远不会触发的看门狗。
  for (const THRESHOLD of ["80", "1.5", "0", "-0.5", "eighty", undefined]) {
    assert.throws(() => readConfig({ ...validEnv, THRESHOLD }), /THRESHOLD/);
  }
  assert.equal(readConfig({ ...validEnv, THRESHOLD: "1" }).threshold, 1);
});

test("readConfig rejects the shipped placeholder and says where to fix it", () => {
  // "CHANGE_ME" 是非空的，所以它能通过「必填项缺失」那道检查，然后改为每次触发都在
  // Lightsail 侧失败 —— 配上错误告警就是每天几百条读不懂的 400。
  for (const name of ["INSTANCE_NAME", "AWS_REGION"]) {
    assert.throws(
      () => readConfig({ ...validEnv, [name]: "CHANGE_ME" }),
      (err) => {
        assert.match(err.message, new RegExp(`^${name} is still the placeholder`));
        assert.match(err.message, /wrangler\.jsonc/, "the message has to say where to fix it");
        return true;
      },
    );
  }
});

test("readConfig only rejects the placeholder on an exact match", () => {
  // 真有人的实例就叫这些名字。做模糊匹配会把他们锁在自己的看门狗之外。
  for (const instanceName of ["change_me_later", "CHANGE_ME_LATER", "change_me", "my-CHANGE_ME"]) {
    assert.equal(readConfig({ ...validEnv, INSTANCE_NAME: instanceName }).instanceName, instanceName);
  }
});

test("readConfig requires the credentials and instance identity", () => {
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "INSTANCE_NAME"]) {
    assert.throws(
      () => readConfig({ ...validEnv, [name]: undefined }),
      (err) => {
        assert.match(err.message, new RegExp(name));
        // 报错信息只点出绑定名，绝不带上它的值。
        assert.doesNotMatch(err.message, /EXAMPLE/);
        return true;
      },
    );
  }
});
