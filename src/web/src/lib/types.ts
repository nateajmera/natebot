export type BotKind = "manager" | "worker";

export type Bot = {
  id: string;
  agentId: string;
  name: string;
  kind: BotKind;
  colorIndex: number;
  faceIndex: number;
  sessionKey: string;
  model: string | null;
  createdAt: number;
  /** Resolved by the gateway: what this bot actually runs on right now. */
  effectiveModel?: string | null;
  effectiveModelLabel?: string | null;
  /** Thinking levels this bot's model actually supports. */
  thinkingOptions?: string[];
  thinkingDefault?: string;
};

export type Attachment = { name: string; path: string; bytes: number };

/** One switch in the bot's "Can do" list — a capability or a connection. */
export type ScopeRow = { id: string; label: string; blurb: string; enabled: boolean };

/**
 * What one bot is allowed to reach. Every bot starts able to do everything, so
 * an untouched bot comes back with all of these on.
 */
export type BotScope = {
  capabilities: (ScopeRow & { locked: boolean })[];
  connections: ScopeRow[];
};

/** The gateway's own decision vocabulary; anything else is rejected. */
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export type ModelRecord = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  available?: boolean;
};

export type ProviderCard = {
  id: string;
  label: string;
  requirement: string;
  cost: string;
  tokensOnly: boolean;
  detected: boolean;
  detail: string;
  setupCommand: string;
  modelId: string | null;
};

export type Skill = {
  name: string;
  label: string;
  description: string;
  emoji: string;
  requiresBins: string[];
  missingBins: string[];
  ready: boolean;
  install: { command: string; label: string } | null;
  bundled: boolean;
};

export type SetupStep = { label: string; command: string; optional?: boolean };

export type McpPreset = {
  id: string;
  label: string;
  blurb: string;
  gives: string;
  emoji: string;
  official: boolean;
  kind: "remote" | "local";
  caution?: string;
  setup: SetupStep[];
  requiresBins: string[];
  missingBins: string[];
  installed: boolean;
  ready: boolean;
};

export type Connection = {
  name: string;
  label: string;
  description: string;
  emoji: string;
  requiresBins: string[];
  missingBins: string[];
  ready: boolean;
  install: { id: string; kind: string; formula?: string; label?: string } | null;
  firstParty: true;
};

export type HubSkill = {
  reference: string;
  displayName: string;
  description: string;
  downloads: number;
  publisher: string;
  publisherImage: string | null;
  suspicious: boolean;
  official: boolean;
  scanned: boolean;
  verdict: string | null;
  categories: string[];
  updatedAt: number | null;
  url: string;
};

export type PreflightState = { phase: string; line: string; detail?: string };

export type AppState = {
  version: string;
  onboarded: boolean;
  userName: string;
  provider: string;
  bots: Bot[];
  models: ModelRecord[];
  gateway: { connected: boolean; openclawVersion: string | null; port: number | null };
  preflight: PreflightState;
};

export type Step = {
  toolCallId: string;
  name: string;
  /** Object for live steps and for replayed ones alike. */
  args: unknown;
  result: string | null;
  isError: boolean;
  startedAt: number;
  endedAt: number | null;
  /** Screenshot this step produced; rendered from disk, never re-sent to a model. */
  shotPath?: string | null;
};

export type Run = {
  runId: string;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "done" | "failed";
  steps: Step[];
};

export type ThreadItem =
  | { kind: "message"; id: string; role: "user" | "assistant"; text: string; ts: number }
  | { kind: "run"; id: string; run: Run; ts: number }
  | { kind: "approval"; id: string; ts: number; payload: Record<string, unknown>; resolved: boolean };

export type PlanBot = {
  name: string;
  purpose: string;
  tools: string[];
  firstMessage: string;
};

export type Plan = { summary: string; bots: PlanBot[] };

/** Server -> browser events. Commands always go the other way, over REST. */
export type ClientEvent =
  | { t: "gateway"; connected: boolean }
  | { t: "preflight"; phase: string; line: string; detail?: string }
  | { t: "bots.changed" }
  | { t: "run.start"; sessionKey: string; runId: string; startedAt: number }
  | { t: "run.end"; sessionKey: string; runId: string; endedAt: number; status: "done" | "failed" }
  | {
      t: "step.start";
      sessionKey: string;
      runId: string;
      toolCallId: string;
      name: string;
      args: unknown;
      ts: number;
    }
  | {
      t: "step.result";
      sessionKey: string;
      runId: string;
      toolCallId: string;
      isError: boolean;
      result: string;
      shotPath: string | null;
      ts: number;
    }
  | { t: "assistant"; sessionKey: string; runId: string; text: string }
  | { t: "message"; sessionKey: string; role: "user" | "assistant"; text: string; ts: number }
  | { t: "approval.requested"; sessionKey: string | null; id: string; payload: Record<string, unknown> }
  | { t: "approval.resolved"; id: string; payload: Record<string, unknown> };
