/**
 * Wire types for the OpenClaw Gateway WebSocket protocol (v4).
 *
 * Verified against OpenClaw 2026.7.1-2 by handshaking a live gateway; see
 * docs/gateway/protocol.md in the openclaw package for the normative spec.
 */

export type ReqFrame = {
  type: "req";
  id: string;
  method: string;
  params: unknown;
};

export type ResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: GatewayError;
};

export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: number;
};

export type Frame = ReqFrame | ResFrame | EventFrame;

export type GatewayError = {
  type?: string;
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

export type HelloOk = {
  type: "hello-ok";
  protocol: number;
  server: { version: string; connId: string };
  features: { methods: string[]; events: string[] };
  snapshot: Record<string, unknown>;
  auth: { role: string; scopes: string[]; deviceToken?: string };
  policy: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
  };
};

/**
 * The `agent` event is the spine of the thread UI: lifecycle brackets a run,
 * `tool` frames become the collapsed step row, `assistant` frames stream text.
 */
export type AgentEvent = {
  runId: string;
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  seq: number;
  ts: number;
  isHeartbeat?: boolean;
} & (
  | { stream: "lifecycle"; data: { phase: "start" | "end"; startedAt?: number; endedAt?: number; error?: unknown } }
  | {
      stream: "tool";
      data: {
        phase: "start" | "result";
        name: string;
        toolCallId: string;
        args?: Record<string, unknown>;
        result?: unknown;
        isError?: boolean;
      };
    }
  | { stream: "assistant"; data: { text: string; delta?: string } }
  | { stream: string; data: Record<string, unknown> }
);

export type ChatEvent = {
  runId: string;
  sessionKey: string;
  agentId: string;
  seq: number;
  state: "delta" | "final" | string;
  deltaText?: string;
  replace?: boolean;
  message?: { role: string; content: unknown; timestamp?: number };
};

export type SessionMessageEvent = {
  sessionKey: string;
  agentId: string;
  senderIsOwner?: boolean;
  message: {
    role: string;
    content: unknown;
    timestamp?: number;
    idempotencyKey?: string;
  };
};

export type SessionsChangedEvent = {
  sessionKey: string;
  agentId: string;
  phase?: "start" | "end" | string;
  runId?: string;
  ts: number;
  session?: Record<string, unknown>;
};

export type AgentRecord = {
  id: string;
  workspace: string;
  workspaceGit?: boolean;
  model?: { primary?: string } | string;
  thinkingOptions?: string[];
  thinkingDefault?: string;
  thinkingLevels?: { id: string; label: string }[];
};

export type ModelRecord = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
  available?: boolean;
};
