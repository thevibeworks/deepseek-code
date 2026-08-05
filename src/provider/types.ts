// Provider message model. Internal shape stays close to the Anthropic wire
// format (our default protocol) but carries agent-side fields (stopReason,
// usage, errorMessage) that toWire() strips. Byte-stability rule: message
// objects are immutable once appended; toWire() is a pure function of them.

export type TextBlock = { type: "text"; text: string };

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set when streamed arguments failed to parse; raw text kept for diagnosis. */
  inputInvalid?: string;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: TextBlock[];
  is_error?: boolean;
};

export type AssistantContent = TextBlock | ThinkingBlock | ToolUseBlock;
export type UserContent = TextBlock | ToolResultBlock;

/** "length" = provider max_tokens cutoff. "error"/"aborted" are synthesized
 * by the client (StreamFn never throws). */
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "stop_sequence"
  | "length"
  | "error"
  | "aborted";

/** inputFresh = billed cache-miss input. DeepSeek reports cache reads only
 * (cache_creation is always 0); cost = miss*rate + read*hitRate + out*rate. */
export type Usage = { inputFresh: number; cacheRead: number; output: number };

export type UserMessage = { role: "user"; content: UserContent[] };

export type AssistantMessage = {
  role: "assistant";
  content: AssistantContent[];
  stopReason: StopReason;
  errorMessage?: string;
  usage: Usage;
  apiMs: number;
};

export type Message = UserMessage | AssistantMessage;

export type WireTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export function zeroUsage(): Usage {
  return { inputFresh: 0, cacheRead: 0, output: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputFresh: a.inputFresh + b.inputFresh,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}
