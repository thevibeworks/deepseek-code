// One parser validates at add time and fires in the daemon, so these
// tests are the contract for both sides at once.

import { describe, expect, test } from "bun:test";
import { cronMatches, cronNext, parseCron } from "../src/scheduler/cron";

// local-time helper: y, m (1-12), d, hh, mm
const at = (y: number, m: number, d: number, hh: number, mm: number) =>
  new Date(y, m - 1, d, hh, mm);

describe("parseCron", () => {
  test("accepts the plain shapes", () => {
    expect(() => parseCron("* * * * *")).not.toThrow();
    expect(() => parseCron("0 3 * * *")).not.toThrow();
    expect(() => parseCron("*/15 * * * *")).not.toThrow();
    expect(() => parseCron("0 9-17 * * 1-5")).not.toThrow();
    expect(() => parseCron("0,30 */2 1,15 * *")).not.toThrow();
    expect(() => parseCron("5 0 * 1-6/2 7")).not.toThrow();
  });

  test("rejects malformed expressions with actionable messages", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* 24 * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * 0 * *")).toThrow(/out of range/);
    expect(() => parseCron("* * * 13 *")).toThrow(/out of range/);
    expect(() => parseCron("* * * * 8")).toThrow(/out of range/);
    expect(() => parseCron("5-1 * * * *")).toThrow(/reversed/);
    expect(() => parseCron("1/5 * * * *")).toThrow(/step needs a range/);
    expect(() => parseCron("a * * * *")).toThrow(/not a number/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step must be/);
    expect(() => parseCron(",5 * * * *")).toThrow(/empty element/);
    expect(() => parseCron("*/5/2 * * * *")).toThrow(/too many/);
  });

  test("sunday is 0 and 7", () => {
    const s7 = parseCron("0 0 * * 7");
    const s0 = parseCron("0 0 * * 0");
    const sunday = at(2026, 8, 9, 0, 0); // 2026-08-09 is a Sunday
    expect(sunday.getDay()).toBe(0);
    expect(cronMatches(s7, sunday)).toBe(true);
    expect(cronMatches(s0, sunday)).toBe(true);
  });
});

describe("cronMatches", () => {
  test("minute steps", () => {
    const s = parseCron("*/15 * * * *");
    expect(cronMatches(s, at(2026, 8, 5, 10, 0))).toBe(true);
    expect(cronMatches(s, at(2026, 8, 5, 10, 15))).toBe(true);
    expect(cronMatches(s, at(2026, 8, 5, 10, 20))).toBe(false);
  });

  test("weekday business hours", () => {
    const s = parseCron("0 9-17 * * 1-5");
    expect(cronMatches(s, at(2026, 8, 5, 9, 0))).toBe(true); // Wednesday
    expect(cronMatches(s, at(2026, 8, 5, 18, 0))).toBe(false);
    expect(cronMatches(s, at(2026, 8, 8, 9, 0))).toBe(false); // Saturday
  });

  test("vixie OR rule: both dom and dow restricted fires on either", () => {
    const s = parseCron("0 0 13 * 5"); // 13th OR Friday
    expect(cronMatches(s, at(2026, 8, 13, 0, 0))).toBe(true); // a Thursday, matches dom
    expect(cronMatches(s, at(2026, 8, 14, 0, 0))).toBe(true); // a Friday, matches dow
    expect(cronMatches(s, at(2026, 8, 12, 0, 0))).toBe(false); // neither
  });

  test("dom restricted with dow free is AND semantics", () => {
    const s = parseCron("0 0 13 * *");
    expect(cronMatches(s, at(2026, 8, 13, 0, 0))).toBe(true);
    expect(cronMatches(s, at(2026, 8, 14, 0, 0))).toBe(false);
  });
});

describe("cronNext", () => {
  test("finds the next boundary strictly after from", () => {
    const s = parseCron("*/30 * * * *");
    const n = cronNext(s, at(2026, 8, 5, 10, 0));
    expect(n).toEqual(at(2026, 8, 5, 10, 30));
  });

  test("crosses day boundaries", () => {
    const s = parseCron("0 3 * * *");
    const n = cronNext(s, at(2026, 8, 5, 4, 0));
    expect(n).toEqual(at(2026, 8, 6, 3, 0));
  });

  test("impossible dates return null instead of looping", () => {
    const s = parseCron("0 0 30 2 *");
    expect(cronNext(s, at(2026, 8, 5, 0, 0))).toBeNull();
  });
});
