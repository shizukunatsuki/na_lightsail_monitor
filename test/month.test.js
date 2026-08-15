// Run the whole suite in a zone well offset from UTC. Every assertion below is
// written against an exact epoch value, so it stays correct in any zone — but
// an implementation that reached for local-time helpers would coincidentally
// pass under TZ=UTC. The offset is what makes these tests discriminating.
process.env.TZ = "America/Los_Angeles";

import { test } from "node:test";
import assert from "node:assert/strict";

import { monthStartMs, isFirstOfMonth, usageWindow, readConfig } from "../src/index.js";

const utc = (iso) => new Date(iso);
const epoch = (iso) => Date.parse(iso);

test("monthStartMs snaps to the first instant of the UTC month", () => {
  assert.equal(monthStartMs(utc("2026-08-15T12:34:56Z")), epoch("2026-08-01T00:00:00Z"));
  assert.equal(monthStartMs(utc("2026-08-01T00:00:00Z")), epoch("2026-08-01T00:00:00Z"));
  assert.equal(monthStartMs(utc("2026-08-31T23:59:59.999Z")), epoch("2026-08-01T00:00:00Z"));
});

test("monthStartMs uses UTC, not the local month", () => {
  // 00:30 UTC on the 1st is still 16:30 on the 28th in Los Angeles. A local
  // -time month start would report February and query a month of extra usage.
  const justAfterRollover = utc("2026-03-01T00:30:00Z");
  assert.equal(justAfterRollover.getMonth(), 1, "precondition: local clock still says February");
  assert.equal(monthStartMs(justAfterRollover), epoch("2026-03-01T00:00:00Z"));

  // And the mirror image: 23:30 UTC on the 31st is already the 1st in Tokyo,
  // but the allowance has not reset yet.
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

test("isFirstOfMonth follows the UTC date", () => {
  assert.equal(isFirstOfMonth(utc("2026-03-01T00:00:00Z")), true);
  assert.equal(isFirstOfMonth(utc("2026-03-01T23:59:59Z")), true);
  assert.equal(isFirstOfMonth(utc("2026-03-02T00:00:00Z")), false);
  assert.equal(isFirstOfMonth(utc("2026-02-28T12:00:00Z")), false);

  // Local time says the 1st here, UTC still says the 31st: restarting now
  // would hand back an instance whose allowance has not actually reset.
  const tokyoFirst = utc("2026-03-31T16:00:00Z");
  assert.equal(isFirstOfMonth(tokyoFirst), false);

  // Local time says the 28th, UTC says the 1st: the restart must still fire.
  const laLastDay = utc("2026-03-01T00:30:00Z");
  assert.equal(isFirstOfMonth(laLastDay), true);
});

test("usageWindow returns Unix seconds, not milliseconds", () => {
  const { startTime, endTime } = usageWindow(utc("2026-08-15T12:00:00Z"));
  assert.equal(startTime, epoch("2026-08-01T00:00:00Z") / 1000);
  assert.equal(endTime, epoch("2026-08-15T12:00:00Z") / 1000);

  // A stray factor of 1000 is the other classic bug here: seconds-since-epoch
  // for any plausible date is 10 digits, milliseconds are 13.
  assert.ok(String(startTime).length === 10 && String(endTime).length === 10);
});

test("usageWindow keeps a non-empty range at the exact month rollover", () => {
  // The 00:00 cron slot on the 1st would otherwise send startTime === endTime,
  // which the API rejects — once a month, forever.
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
  assert.equal(config.alertWebhook, undefined);
});

test("readConfig rejects a QUOTA_GB that would compare as NaN", () => {
  // `usedGb < NaN` is false, which reads as "over quota" and stops the
  // instance. This has to fail loudly instead.
  for (const QUOTA_GB of ["1,000", "1000 GB", "", undefined, "0", "-5"]) {
    assert.throws(() => readConfig({ ...validEnv, QUOTA_GB }), /QUOTA_GB/);
  }
});

test("readConfig rejects a THRESHOLD written as a percentage", () => {
  // "80" meaning 80% yields an 80,000 GB limit — a watchdog that never fires.
  for (const THRESHOLD of ["80", "1.5", "0", "-0.5", "eighty", undefined]) {
    assert.throws(() => readConfig({ ...validEnv, THRESHOLD }), /THRESHOLD/);
  }
  assert.equal(readConfig({ ...validEnv, THRESHOLD: "1" }).threshold, 1);
});

test("readConfig requires the credentials and instance identity", () => {
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "INSTANCE_NAME"]) {
    assert.throws(
      () => readConfig({ ...validEnv, [name]: undefined }),
      (err) => {
        assert.match(err.message, new RegExp(name));
        // The message names the binding, never its value.
        assert.doesNotMatch(err.message, /EXAMPLE/);
        return true;
      },
    );
  }
});
