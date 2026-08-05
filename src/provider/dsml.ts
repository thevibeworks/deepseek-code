// DSML healing. DeepSeek v4 emits tool calls as an Anthropic-shaped
// invoke/parameter envelope ("DSML"); hosts — including DeepSeek's own
// endpoints — can leak it into visible text content instead of returning
// structured tool_use blocks. We parse leaked envelopes back into tool
// calls and strip them from user-visible text.
//
// Wire spec: reference/oh-my-pi/docs/toolconv/deepseek.md "DSML envelope".
// Both the fullwidth-pipe form (<｜DSML｜…>, U+FF5C) and the ASCII-pipe
// variant (<|DSML|…>) occur on the wire; match both. parameter has
// string="true" by default (raw string value); string="false" means the
// value is JSON.

export type HealedCall = { name: string; input: Record<string, unknown> };

const P = "[｜|]"; // fullwidth or ASCII pipe
const WRAPPER = new RegExp(
  `<${P}DSML${P}tool_calls>([\\s\\S]*?)</${P}DSML${P}tool_calls>`,
  "g",
);
const INVOKE = new RegExp(
  `<${P}DSML${P}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)</${P}DSML${P}invoke>`,
  "g",
);
const PARAM = new RegExp(
  `<${P}DSML${P}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>` +
    `([\\s\\S]*?)</${P}DSML${P}parameter>`,
  "g",
);

export function healDsml(text: string): { text: string; calls: HealedCall[] } {
  if (!text.includes("DSML")) return { text, calls: [] };
  const calls: HealedCall[] = [];
  const cleaned = text.replace(WRAPPER, (_m, body: string) => {
    for (const inv of body.matchAll(INVOKE)) {
      const input: Record<string, unknown> = {};
      for (const p of inv[2].matchAll(PARAM)) {
        const [, name, stringFlag, raw] = p;
        if (stringFlag === "false") {
          try {
            input[name] = JSON.parse(raw);
          } catch {
            input[name] = raw; // malformed JSON: keep raw, tool validation reports it
          }
        } else {
          input[name] = raw;
        }
      }
      calls.push({ name: inv[1], input });
    }
    return "";
  });
  return { text: cleaned, calls };
}
