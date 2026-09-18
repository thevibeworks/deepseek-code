// The rate cards are dated, so a cost is computed on the card and period
// in force at the instant asked about. Each case pins one boundary the
// schedule actually crossed.

import { describe, expect, test } from "bun:test";
import { CARDS, cardAt, CURRENT_MODELS, DEFAULT_MODEL, isPeak, MODELS, ratesAt } from "../src/provider/catalog";
import { costUsd } from "../src/ui/render";

const at = (iso: string) => new Date(iso);
const MILLION = { inputFresh: 1_000_000, cacheRead: 0, output: 0 };

describe("model names", () => {
  test("the default is V4.1 Flash, and pro is still offered", () => {
    expect(DEFAULT_MODEL).toBe("deepseek-flash");
    expect(CURRENT_MODELS).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  test("retired names are accepted, bill as flash, and are never offered", () => {
    for (const name of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
      expect(MODELS[name].tier).toBe("flash");
      expect(MODELS[name].retired).toBe(true);
      expect(CURRENT_MODELS).not.toContain(name);
    }
  });
});

describe("dated cards", () => {
  test("cards are in time order", () => {
    for (let i = 1; i < CARDS.length; i++) expect(CARDS[i].since > CARDS[i - 1].since).toBe(true);
  });

  test("before the V4 repricing: flat card, no peak", () => {
    const t = at("2026-08-12T02:00:00Z"); // a weekday, inside a later peak window
    expect(cardAt(t).label).toBe("flat");
    expect(isPeak(t)).toBe(false);
    expect(ratesAt("deepseek-v4-flash", t)?.inputMiss).toBe(0.14);
  });

  test("V4 card: peak ran daily until the weekend rule", () => {
    expect(isPeak(at("2026-08-22T02:00:00Z"))).toBe(true); // Saturday, before 16:00 UTC
    expect(isPeak(at("2026-08-29T02:00:00Z"))).toBe(false); // Saturday, after
    expect(ratesAt("deepseek-v4-flash", at("2026-09-09T02:00:00Z"))?.inputMiss).toBe(0.44); // Wed peak
  });

  test("V4.1 Flash card from 2026-09-10 04:00 UTC; pro unchanged across it", () => {
    // 03:59 is inside the 01-04 peak window, 04:00 is outside it, so this
    // also proves the card and the tariff switch independently.
    const before = at("2026-09-10T03:59:00Z");
    const after = at("2026-09-10T04:00:00Z");
    expect(ratesAt("deepseek-flash", before)).toEqual({ inputHit: 0.014, inputMiss: 0.44, output: 1.32 });
    expect(ratesAt("deepseek-v4-pro", before)).toEqual({ inputHit: 0.044, inputMiss: 1.32, output: 3.96 });
    expect(ratesAt("deepseek-flash", after)).toEqual({ inputHit: 0.003, inputMiss: 0.15, output: 0.6 });
    expect(ratesAt("deepseek-v4-pro", after)).toEqual({ inputHit: 0.022, inputMiss: 0.66, output: 1.98 });
  });

  test("peak doubles every item, weekdays only, boundaries end-exclusive", () => {
    expect(ratesAt("deepseek-flash", at("2026-09-14T01:00:00Z"))).toEqual({ inputHit: 0.006, inputMiss: 0.3, output: 1.2 });
    expect(isPeak(at("2026-09-14T00:59:00Z"))).toBe(false);
    expect(isPeak(at("2026-09-14T04:00:00Z"))).toBe(false);
    expect(isPeak(at("2026-09-14T06:00:00Z"))).toBe(true);
    expect(isPeak(at("2026-09-14T10:00:00Z"))).toBe(false);
    expect(isPeak(at("2026-09-13T02:00:00Z"))).toBe(false); // Sunday
  });

  test("a retired name costs exactly what deepseek-flash costs", () => {
    const t = at("2026-09-15T12:00:00Z");
    expect(costUsd(MILLION, "deepseek-v4-flash-vision-exp", t)).toBe(costUsd(MILLION, "deepseek-flash", t));
    expect(costUsd(MILLION, "deepseek-flash", t)).toBeCloseTo(0.15, 10);
  });

  test("an unknown model costs nothing rather than a guess", () => {
    expect(costUsd(MILLION, "deepseek-v9", at("2026-09-15T12:00:00Z"))).toBe(0);
  });
});
