// Agent event vocabulary — the narrow waist (Round 3 delta #1). The loop,
// frontends, and the future durable event log all speak this. Shapes must
// project cleanly onto ACP session/update notifications:
//   text_delta      -> agent_message_chunk
//   thinking_delta  -> thought_chunk
//   tool_execution_start -> tool_call
//   tool_execution_end   -> tool_call_update
// Do NOT add event types that cannot be projected or replayed.

import type { AssistantMessage, Usage } from "../provider/types";

export type AgentEvent =
  | { type: "agent_start"; model: string }
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "message_end"; message: AssistantMessage }
  | { type: "tool_execution_start"; id: string; name: string; input: unknown }
  | { type: "tool_execution_end"; id: string; output: string; isError: boolean }
  | { type: "turn_end"; turn: number; usage: Usage; contextTokens?: number }
  | { type: "compaction"; llm: boolean; contextTokensBefore: number; contextTokensAfter: number }
  | { type: "agent_end"; reason: "completed" | "error" | "aborted" | "max_turns" };

export type EventSink = (e: AgentEvent) => void;
