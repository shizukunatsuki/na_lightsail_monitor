// 整个套件都跑在一个与 UTC 有明显时差的时区里。下面每一条断言都是针对精确的 epoch
// 值写的，所以它在任何时区下都成立 —— 但一个改用本地时间辅助函数的实现，在 TZ=UTC
// 下会碰巧通过。正是这个时差让这些测试具备鉴别力。
process.env.TZ = "America/Los_Angeles";

import { test } from "node:test";
import assert from "node:assert/strict";

import { monthStartMs, usageWindow, readConfig } from "../src/index.js";

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

const validEnv = {
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  AWS_REGION: "ap-northeast-1",
  INSTANCE_NAME: "my-blog",
  QUOTA_GB: "1000",
  THRESHOLD: "0.8",
};

test("readConfig parses the plain vars into numbers", () => {
  const config = readConfig(validEnv);
  assert.equal(config.region, "ap-northeast-1");
  assert.equal(config.instanceName, "my-blog");
  assert.equal(config.quotaGb, 1000);
  assert.equal(config.threshold, 0.8);
  assert.equal(config.manualHold, false);
});

test("readConfig only honours MANUAL_HOLD spelled exactly \"true\"", () => {
  assert.equal(readConfig({ ...validEnv, MANUAL_HOLD: "true" }).manualHold, true);

  // 一个「失效时默认放行」的锁是可以补救的；而一个因为打错字就生效的锁，会把实例
  // 摁在那里，直到有人发现博客不见了。
  for (const MANUAL_HOLD of ["True", "TRUE", "yes", "1", "", " true", undefined]) {
    assert.equal(readConfig({ ...validEnv, MANUAL_HOLD }).manualHold, false, JSON.stringify(MANUAL_HOLD));
  }
});

test("readConfig rejects a QUOTA_GB that would compare as NaN", () => {
  // `usedGb < NaN` 恒为 false，这会被读作「已超额」并停掉实例。所以必须在这里大声
  // 报错。
  for (const QUOTA_GB of ["1,000", "1000 GB", "", undefined, "0", "-5"]) {
    assert.throws(() => readConfig({ ...validEnv, QUOTA_GB }), /QUOTA_GB/);
  }
});

test("readConfig rejects a THRESHOLD written as a percentage", () => {
  // 把 "80" 当成 80% 来写，得到的是 80,000 GB 的上限 —— 一个永远不会触发的看门狗。
  for (const THRESHOLD of ["80", "1.5", "0", "-0.5", "eighty", undefined]) {
    assert.throws(() => readConfig({ ...validEnv, THRESHOLD }), /THRESHOLD/);
  }
  assert.equal(readConfig({ ...validEnv, THRESHOLD: "1" }).threshold, 1);
});

test("readConfig rejects the shipped placeholder and says where to fix it", () => {
  // "CHANGE_ME" 是非空的，所以它能通过「必填项缺失」那道检查，然后改为每次触发都在
  // Lightsail 侧失败 —— 配上错误告警就是每天 144 条读不懂的 404。
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
