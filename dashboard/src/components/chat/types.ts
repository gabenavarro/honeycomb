/** TypeScript mirror of hub/models/chat_events.py (M33).
 *
 * Shapes match what the hub broadcasts on chat:<session_id>. The
 * hub uses Pydantic discriminated unions; here we use TS unions
 * with `type` discriminators.
 */

// ─── Anthropic API SSE inner shapes ──────────────────────────────────────────

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant" | "user";
  content: ContentBlock[] | string;
  stop_reason?: string | null;
  usage?: Record<string, unknown>;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

export interface TextDelta {
  type: "text_delta";
  text: string;
}
export interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}
export interface ThinkingDelta {
  type: "thinking_delta";
  thinking: string;
}
export type ContentBlockDeltaInner = TextDelta | InputJsonDelta | ThinkingDelta;

// ─── stream_event.event variants ─────────────────────────────────────────────

export interface MessageStartEvent {
  type: "message_start";
  message: AnthropicMessage;
}
export interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: ContentBlock;
}
export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: ContentBlockDeltaInner;
}
export interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}
export interface MessageDeltaEvent {
  type: "message_delta";
  delta: Record<string, unknown>;
  usage?: Record<string, unknown>;
}
export interface MessageStopEvent {
  type: "message_stop";
}
export type StreamEventInner =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;

// ─── CLI envelope ────────────────────────────────────────────────────────────

export interface SystemEvent {
  type: "system";
  subtype: "init" | "status"; // hook subtypes are filtered server-side
  session_id: string;
  uuid: string;
  cwd?: string;
  tools?: string[];
  model?: string;
  permissionMode?: string;
  status?: string;
}

export interface StreamEvent {
  type: "stream_event";
  event: StreamEventInner;
  session_id: string;
  uuid: string;
  parent_tool_use_id?: string | null;
}

export interface UserEventEnv {
  type: "user";
  message: AnthropicMessage;
  session_id: string;
  uuid: string;
}

export interface AssistantEventEnv {
  type: "assistant";
  message: AnthropicMessage;
  session_id: string;
  uuid: string;
  parent_tool_use_id?: string | null;
}

export interface RateLimitEventEnv {
  type: "rate_limit_event";
  rate_limit_info: Record<string, unknown>;
  session_id: string;
  uuid: string;
}

export interface ResultEventEnv {
  type: "result";
  subtype: string;
  is_error: boolean;
  session_id: string;
  uuid: string;
  duration_ms: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string | null;
  stop_reason?: string | null;
  total_cost_usd?: number | null;
  usage?: Record<string, unknown>;
}

export type ChatCliEvent =
  | SystemEvent
  | StreamEvent
  | UserEventEnv
  | AssistantEventEnv
  | RateLimitEventEnv
  | ResultEventEnv;

// ─── Reduced "turn" shape — what useChatStream's reducer produces ────────────

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  id: string; // user msg → "user-<uuid>"; assistant msg → message_id
  role: ChatRole;
  blocks: ChatBlock[]; // accumulated content blocks
  streaming: boolean; // true until message_stop fires
  startedAt: string; // ISO 8601
  stoppedAt?: string;
  /** For user messages, the original text (mirror of blocks[0].text). */
  text?: string;
  /** Result event metadata when present (cost, duration, stop_reason). */
  result?: {
    duration_ms: number;
    total_cost_usd: number | null;
    stop_reason: string | null;
  };
}

export type ChatBlock =
  | { kind: "text"; text: string }
  | {
      kind: "tool_use";
      tool: string;
      id: string;
      input: Record<string, unknown>;
      partialJson: string;
      complete: boolean;
    }
  | { kind: "thinking"; thinking: string };
