/**
 * Types for the Cursor hook payloads and transcript rows this plugin consumes.
 *
 * Source of truth: https://cursor.com/docs/hooks (reference section). Fields
 * that Cursor ships but has not documented yet (the per-turn token counts on
 * `stop`) are marked as such. Everything is optional and open-ended so an
 * unknown Cursor version never crashes the hook.
 */

export type ModelParam = { id: string; value: string };

/** Fields every Cursor agent hook receives. */
export type HookBase = {
  hook_event_name: string;
  conversation_id?: string;
  generation_id?: string;
  /** Legacy model slug of the composer, e.g. `claude-opus-4-7-thinking-max`. */
  model?: string;
  /** Structured model id, e.g. `claude-opus-4-7`. */
  model_id?: string;
  model_params?: ModelParam[];
  cursor_version?: string;
  workspace_roots?: string[];
  user_email?: string | null;
  /** Main conversation transcript; `null` when transcripts are disabled or in CLI mode. */
  transcript_path?: string | null;
  [key: string]: unknown;
};

export type Attachment = { type?: string; file_path?: string; [key: string]: unknown };

export type BeforeSubmitPromptPayload = HookBase & {
  prompt?: string;
  attachments?: Attachment[];
};

export type PreToolUsePayload = HookBase & {
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  cwd?: string;
  agent_message?: string;
};

export type PostToolUsePayload = PreToolUsePayload & {
  /** JSON-stringified result payload (not raw terminal text). */
  tool_output?: string;
  /** Milliseconds. */
  duration?: number;
};

export type PostToolUseFailurePayload = PreToolUsePayload & {
  error_message?: string;
  failure_type?: "error" | "timeout" | "permission_denied" | string;
  duration?: number;
  is_interrupt?: boolean;
};

export type ShellPayload = HookBase & {
  command?: string;
  cwd?: string;
  sandbox?: boolean;
  /** afterShellExecution only. */
  output?: string;
  duration?: number;
};

export type McpPayload = HookBase & {
  tool_name?: string;
  /** JSON params string. */
  tool_input?: unknown;
  mcp_server_name?: string;
  mcp_server_url?: string;
  url?: string;
  command?: string;
  /** afterMCPExecution only: JSON string of the tool response. */
  result_json?: string;
  duration?: number;
};

export type FileEdit = { old_string?: string; new_string?: string; [key: string]: unknown };

export type AfterFileEditPayload = HookBase & {
  file_path?: string;
  edits?: FileEdit[];
};

export type BeforeReadFilePayload = HookBase & {
  file_path?: string;
  content?: string;
  attachments?: Attachment[];
};

export type AgentResponsePayload = HookBase & { text?: string };

export type AgentThoughtPayload = HookBase & { text?: string; duration_ms?: number };

export type SubagentStartPayload = HookBase & {
  subagent_id?: string;
  subagent_type?: string;
  task?: string;
  parent_conversation_id?: string;
  tool_call_id?: string;
  subagent_model?: string;
  is_parallel_worker?: boolean;
  git_branch?: string;
};

export type SubagentStopPayload = HookBase & {
  subagent_id?: string;
  subagent_type?: string;
  status?: "completed" | "error" | "aborted" | string;
  task?: string;
  description?: string;
  summary?: string;
  duration_ms?: number;
  message_count?: number;
  tool_call_count?: number;
  loop_count?: number;
  modified_files?: string[];
  agent_transcript_path?: string | null;
};

export type PreCompactPayload = HookBase & {
  trigger?: "auto" | "manual" | string;
  context_usage_percent?: number;
  context_tokens?: number;
  context_window_size?: number;
  message_count?: number;
  messages_to_compact?: number;
  is_first_compaction?: boolean;
};

export type StopPayload = HookBase & {
  status?: "completed" | "aborted" | "error" | string;
  loop_count?: number;
  /**
   * Per-turn token counts. Recent Cursor builds ship these on `stop`; the
   * public docs do not list them yet. `input_tokens` is the total input
   * including the cache portions.
   */
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};

export type SessionStartPayload = HookBase & {
  session_id?: string;
  is_background_agent?: boolean;
  composer_mode?: "agent" | "ask" | "edit" | string;
};

export type SessionEndPayload = HookBase & {
  session_id?: string;
  reason?: string;
  duration_ms?: number;
  is_background_agent?: boolean;
  final_status?: string;
  error_message?: string;
};

export type LoggedEvent = {
  /** Wall-clock ms when the hook process observed the event. */
  ts: number;
  event: string;
  /** Payload with large strings clipped to `max_chars`. */
  payload: HookBase;
};

export type TranscriptTextBlock = { type: "text"; text?: string };
export type TranscriptToolUseBlock = {
  type: "tool_use";
  name?: string;
  input?: unknown;
  id?: string;
};
export type TranscriptOtherBlock = { type: string; [key: string]: unknown };
export type TranscriptBlock = TranscriptTextBlock | TranscriptToolUseBlock | TranscriptOtherBlock;

/** Raw transcript row shapes we accept. Cursor writes `role` rows plus `turn_ended` markers. */
export type TranscriptRow =
  | { role: "user" | "assistant" | string; message?: { content?: TranscriptBlock[] | string } }
  | { type: "turn_ended"; status?: string }
  | { type: string; text?: string; [key: string]: unknown };

/** A tool call as recorded in the transcript (no id, no output). */
export type TranscriptToolUse = { name: string; input: unknown; id?: string };

export type TranscriptAssistantRow = {
  text: string;
  toolUses: TranscriptToolUse[];
  otherBlocks: TranscriptOtherBlock[];
};

export type TranscriptTurn = {
  /** Prompt text with Cursor's `<timestamp>` and `<user_query>` wrappers removed. */
  userText: string;
  /** The `<timestamp>` Cursor prepends to the prompt, when present. */
  userTimestamp?: string;
  assistantRows: TranscriptAssistantRow[];
  endedStatus?: string;
};

export type ToolFailure = {
  message?: string;
  failureType?: string;
  isInterrupt?: boolean;
};

export type SubagentRun = {
  subagentId?: string;
  type?: string;
  model?: string;
  task?: string;
  description?: string;
  summary?: string;
  status?: string;
  toolCallId?: string;
  isParallelWorker?: boolean;
  gitBranch?: string;
  durationMs?: number;
  messageCount?: number;
  toolCallCount?: number;
  modifiedFiles?: string[];
  transcriptPath?: string;
  startTime: number;
  endTime: number;
  /** True when only `subagentStart` was seen (Cursor skips `subagentStop` for background subagents). */
  missingStop: boolean;
};

export type ToolCall = {
  toolUseId?: string;
  name: string;
  input: unknown;
  output?: unknown;
  failure?: ToolFailure;
  startTime: number;
  endTime: number;
  durationMs?: number;
  cwd?: string;
  sandbox?: boolean;
  mcpServer?: string;
  /** `afterFileEdit` diff hunks for Write/StrReplace calls. */
  edits?: FileEdit[];
  /** Which hooks contributed to this call, for debugging coverage. */
  sources: string[];
  subagents: SubagentRun[];
};

export type Thought = { text: string; durationMs?: number; ts: number };

export type Generation = {
  startTime: number;
  endTime: number;
  text?: string;
  thoughts: Thought[];
  toolCalls: ToolCall[];
  otherBlocks: TranscriptOtherBlock[];
  source: "transcript" | "events";
};

export type Compaction = {
  ts: number;
  trigger?: string;
  contextUsagePercent?: number;
  contextTokens?: number;
  contextWindowSize?: number;
  messageCount?: number;
  messagesToCompact?: number;
  isFirstCompaction?: boolean;
};

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  is_error?: true;
};

export type Turn = {
  conversationId: string;
  generationId?: string;
  turnNumber: number;
  startTime: number;
  endTime: number;
  prompt?: string;
  attachments?: Attachment[];
  finalText?: string;
  status: "completed" | "aborted" | "error" | "interrupted" | "unknown";
  closedBy: "stop" | "sessionEnd" | "beforeSubmitPrompt" | "unknown";
  loopCount?: number;
  model?: string;
  modelId?: string;
  modelParams?: Record<string, string>;
  generations: Generation[];
  /** Subagents that could not be attached to a Task tool call. */
  orphanSubagents: SubagentRun[];
  compactions: Compaction[];
  usage?: TurnUsage;
  history: ChatMessage[];
  cursorVersion?: string;
  workspaceRoots?: string[];
  userEmail?: string;
  transcriptPath?: string;
  transcriptUsed: boolean;
  composerMode?: string;
  isBackgroundAgent?: boolean;
  eventCounts: Record<string, number>;
};
