// Tool output bounding (pi-mono truncate.ts limits, MIT): two independent
// limits — lines and bytes — whichever trips first; never emit partial
// lines. Notices are actionable, not just "truncated".

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50_000;
export const MAX_LINE_LENGTH = 2000;

export type TruncateResult = { text: string; truncated: boolean; notice: string };

/** Keep the head (for file reads: offset/limit continuation makes sense). */
export function truncateHead(
  text: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
): TruncateResult {
  const lines = text.split("\n");
  let kept = clipLines(lines.slice(0, maxLines));
  let out = kept.join("\n");
  while (Buffer.byteLength(out, "utf8") > maxBytes && kept.length > 1) {
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.8)));
    out = kept.join("\n");
  }
  const truncated = kept.length < lines.length;
  return {
    text: out,
    truncated,
    notice: truncated
      ? `[Output truncated: showing first ${kept.length} of ${lines.length} lines.]`
      : "",
  };
}

/** Keep the tail (for bash: the end of the output is usually the signal). */
export function truncateTail(
  text: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
): TruncateResult {
  const lines = text.split("\n");
  let kept = clipLines(lines.slice(-maxLines));
  let out = kept.join("\n");
  while (Buffer.byteLength(out, "utf8") > maxBytes && kept.length > 1) {
    kept = kept.slice(-Math.max(1, Math.floor(kept.length * 0.8)));
    out = kept.join("\n");
  }
  const truncated = kept.length < lines.length;
  return {
    text: out,
    truncated,
    notice: truncated
      ? `[Output truncated: showing last ${kept.length} of ${lines.length} lines.]`
      : "",
  };
}

export const SPILL_BYTES = 100_000;

function clipLines(lines: string[]): string[] {
  return lines.map((l) =>
    l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + " [line clipped]" : l,
  );
}
