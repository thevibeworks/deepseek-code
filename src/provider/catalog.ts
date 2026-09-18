// Model catalog with REAL numbers (DESIGN.md: budget math always uses the
// measured 616k usable input, never the advertised 1M).
// Pricing: USD per 1M tokens, from deepseek-docs quick_start/pricing.md,
// re-verified 2026-09-18 against the pricing page, the 2026-09-10
// changelog, and GET /models (which lists exactly deepseek-flash and
// deepseek-v4-pro).

export type Tier = "flash" | "pro";

export type ModelInfo = {
  id: string;
  /** Which rate-card row this name bills on. */
  tier: Tier;
  /** Usable input budget in tokens (measured), for context math. */
  inputBudget: number;
  advertisedContext: number;
  maxOutput: number;
  /** A name the API still accepts for a model it has retired. Accepted so
   * existing jobs and scripts keep working; never listed as a choice. */
  retired?: boolean;
};

const LIMITS = { inputBudget: 616_000, advertisedContext: 1_000_000, maxOutput: 384_000 };

export const MODELS: Record<string, ModelInfo> = {
  // DeepSeek-V4.1-Flash, released 2026-09-10. A floating alias: DeepSeek
  // can move it to a newer Flash without a new name.
  "deepseek-flash": { id: "deepseek-flash", tier: "flash", ...LIMITS },
  // DeepSeek-V4-Pro-0813. Continues after 2026-09-14 with billing
  // unchanged (changelog 2026-09-10).
  "deepseek-v4-pro": { id: "deepseek-v4-pro", tier: "pro", ...LIMITS },
  // Retired 2026-09-10: served by V4.1 Flash and billed at the Flash price.
  "deepseek-v4-flash": { id: "deepseek-v4-flash", tier: "flash", retired: true, ...LIMITS },
  "deepseek-v4-flash-vision-exp": { id: "deepseek-v4-flash-vision-exp", tier: "flash", retired: true, ...LIMITS },
};

/** The names to offer a user, in the order the rate card lists them. */
export const CURRENT_MODELS = Object.keys(MODELS).filter((m) => MODELS[m].retired !== true);

export const DEFAULT_MODEL = "deepseek-flash";
export const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";

export type Rates = { inputMiss: number; inputHit: number; output: number };

/** One rate card: what each tier cost from `since` until the next card.
 * With `timeOfUse`, the rates are OFF-PEAK and peak costs PEAK_MULTIPLIER
 * times them. Superseded cards stay so a cost is always computed on the
 * card in force when the call was made. */
export type Card = { label: string; since: Date; timeOfUse: boolean; rates: Record<Tier, Rates> };

const V4_PRO: Rates = { inputHit: 0.022, inputMiss: 0.66, output: 1.98 };

export const CARDS: Card[] = [
  {
    // Published 2026-08-02; flat, no peak.
    label: "flat",
    since: new Date(0),
    timeOfUse: false,
    rates: {
      flash: { inputHit: 0.0028, inputMiss: 0.14, output: 0.28 },
      pro: { inputHit: 0.003625, inputMiss: 0.435, output: 0.87 },
    },
  },
  {
    // V4 GA repricing, effective 16:00 UTC 2026-08-16 (changelog 2026-08-13).
    label: "V4",
    since: new Date("2026-08-16T16:00:00Z"),
    timeOfUse: true,
    rates: { flash: { inputHit: 0.007, inputMiss: 0.22, output: 0.66 }, pro: V4_PRO },
  },
  {
    // V4.1 Flash, 2026-09-10: Flash cut on every item, Pro unchanged.
    // "New pricing takes effect at 04:00 UTC on Sept 10, 2026" -- DeepSeek's
    // release note (news260910; 12:00 Beijing in the Chinese one). The
    // pricing page itself still showed the old card at 04:50 UTC, so a date
    // read off the page lags the bill.
    label: "V4.1",
    since: new Date("2026-09-10T04:00:00Z"),
    timeOfUse: true,
    rates: { flash: { inputHit: 0.003, inputMiss: 0.15, output: 0.6 }, pro: V4_PRO },
  },
];

export const PEAK_MULTIPLIER = 2;

/** Peak hours, UTC: 01:00-04:00 and 06:00-10:00 (09-12 and 14-18 Beijing). */
const PEAK_HOURS_UTC: Array<[number, number]> = [
  [1, 4],
  [6, 10],
];

/** From 16:00 UTC 2026-08-22 (00:00 Beijing, Sunday) weekends bill
 * off-peak all day. Every peak hour falls on the same calendar day in UTC
 * and Beijing, so the UTC weekday decides. Before it, peak ran daily. */
const WEEKDAYS_ONLY_SINCE = new Date("2026-08-22T16:00:00Z");

export function cardAt(at: Date): Card {
  let card = CARDS[0];
  for (const c of CARDS) if (at >= c.since) card = c;
  return card;
}

export function isPeak(at: Date): boolean {
  if (!cardAt(at).timeOfUse) return false;
  const day = at.getUTCDay();
  if (at >= WEEKDAYS_ONLY_SINCE && (day === 0 || day === 6)) return false;
  const h = at.getUTCHours();
  return PEAK_HOURS_UTC.some(([start, end]) => h >= start && h < end);
}

/** Per-1M rates for a model at an instant, peak applied. Undefined for a
 * name the catalog does not know. */
export function ratesAt(model: string, at: Date): Rates | undefined {
  const info = MODELS[model];
  if (info === undefined) return undefined;
  const base = cardAt(at).rates[info.tier];
  const k = isPeak(at) ? PEAK_MULTIPLIER : 1;
  return { inputMiss: base.inputMiss * k, inputHit: base.inputHit * k, output: base.output * k };
}
