// Two-tier token accounting (DESIGN.md context engine #6): the provider's
// per-call usage is ground truth for everything already sent; only the
// trailing delta (content appended since the last call) is estimated at
// len/4. No tokenizer dependency, error bounded by one turn's appends.

import type { Usage } from "../provider/types";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ContextMeter {
  private anchor = 0;
  private deltaChars = 0;

  /** Re-anchor on provider-reported usage: input covers the whole request
   * context, output is the reply that will be replayed next turn. */
  onAssistantUsage(u: Usage): void {
    this.anchor = u.inputFresh + u.cacheRead + u.output;
    this.deltaChars = 0;
  }

  /** Account content appended after the last provider call (tool results). */
  onAppended(text: string): void {
    this.deltaChars += text.length;
  }

  /** Estimated tokens the next request's context will occupy. */
  estimate(): number {
    return this.anchor + Math.ceil(this.deltaChars / 4);
  }

  /** Drop the provider anchor (the context it measured no longer exists —
   * e.g. after compaction) and restart from a char estimate. */
  reset(chars: number): void {
    this.anchor = 0;
    this.deltaChars = chars;
  }
}
