// Run the whole suite in a zone well offset from UTC. Every assertion below is
// written against an exact epoch value, so it stays correct in any zone — but
// an implementation that reached for local-time helpers would coincidentally
// pass under TZ=UTC. The offset is what makes these tests discriminating.
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

test("the allowance boundary is the UTC rollover, not the local one", () => {
  // The restart no longer keys off a date, but the query window still has to
  // flip at exactly the right instant: it is the window, and nothing else,
  // that makes month-to-date usage drop back under the threshold. These are
  // the two instants where a local-time implementation would disagree.
  //
  // Local time says the 1st here, UTC still says the 31st. Querying March
  // already would report ~0 usage and hand back an instance whose allowance
  // has not actually reset.
  const tokyoFirst = utc("2026-03-31T16:00:00Z");
  assert.equal(tokyoFirst.getUTCDate(), 31, "precondition: UTC is still the 31st");
  assert.equal(monthStartMs(tokyoFirst), epoch("2026-03-01T00:00:00Z"));
  assert.equal(usageWindow(tokyoFirst).startTime, epoch("2026-03-01T00:00:00Z") / 1000);

  // The mirror image: local time says the 28th of February, UTC says the 1st
  // of March. The window must have moved on, or the reset is missed.
  const laLastDay = utc("2026-03-01T00:30:00Z");
  assert.equal(laLastDay.getMonth(), 1, "precondition: local clock still says February");
  assert.equal(monthStartMs(laLastDay), epoch("2026-03-01T00:00:00Z"));
  assert.equal(usageWindow(laLastDay).startTime, epoch("2026-03-01T00:00:00Z") / 1000);
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
  assert.equal(config.manualHold, false);
});

test("readConfig only honours MANUAL_HOLD spelled exactly \"true\"", () => {
  assert.equal(readConfig({ ...validEnv, MANUAL_HOLD: "true" }).manualHold, true);

  // A hold that fails open is recoverable; one that engages on a typo pins the
  // instance down until someone notices the blog is missing.
  for (const MANUAL_HOLD of ["True", "TRUE", "yes", "1", "", " true", undefined]) {
    assert.equal(readConfig({ ...validEnv, MANUAL_HOLD }).manualHold, false, JSON.stringify(MANUAL_HOLD));
  }
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

test("readConfig rejects the shipped placeholder and says where to fix it", () => {
  // "CHANGE_ME" is non-empty, so it clears the missing-binding check and then
  // fails against Lightsail on every run instead — 144 unreadable 404s a day
  // once error alerts are wired up.
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
  // Somebody's instance really is called this. Matching loosely would lock them
  // out of their own watchdog.
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
        // The message names the binding, never its value.
        assert.doesNotMatch(err.message, /EXAMPLE/);
        return true;
      },
    );
  }
});
