// Model catalog with REAL numbers (DESIGN.md: budget math always uses the
// measured 616k usable input, never the advertised 1M).
// Pricing: USD per 1M tokens, from deepseek-docs quick_start/pricing.md.
// Re-verified 2026-08-12 at V4-Pro GA (model version DeepSeek-V4-Pro-0813;
// model ID unchanged): rates, context, and max output are unchanged. A
// broad repricing is announced but undated — do NOT apply it here until
// it lands with an effective date.

export type ModelInfo = {
  id: string;
  /** Usable input budget in tokens (measured), for context math. */
  inputBudget: number;
  advertisedContext: number;
  maxOutput: number;
  pricing: { inputMiss: number; inputHit: number; output: number };
};

export const MODELS: Record<string, ModelInfo> = {
  "deepseek-v4-flash": {
    id: "deepseek-v4-flash",
    inputBudget: 616_000,
    advertisedContext: 1_000_000,
    maxOutput: 384_000,
    pricing: { inputMiss: 0.14, inputHit: 0.0028, output: 0.28 },
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    inputBudget: 616_000,
    advertisedContext: 1_000_000,
    maxOutput: 384_000,
    pricing: { inputMiss: 0.435, inputHit: 0.003625, output: 0.87 },
  },
};

export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";
