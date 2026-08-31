import type {
  AppState,
  ApprovalDecision,
  Attachment,
  Bot,
  BotScope,
  HubSkill,
  McpPreset,
  Skill,
  Plan,
  ProviderCard,
  Run,
} from "./types";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  call<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const api = {
  state: () => call<AppState>("/state"),
  providers: () => call<{ providers: ProviderCard[] }>("/providers"),

  setName: (name: string) => post<{ ok: boolean }>("/onboarding/name", { name }),
  setProvider: (provider: string, modelId: string | null) =>
    post<{ ok: boolean }>("/onboarding/provider", { provider, modelId }),
  createManager: (name: string, model?: string | null) =>
    post<{ bot: Bot }>("/onboarding/manager", { name, model }),
  completeOnboarding: () => post<{ ok: boolean }>("/onboarding/complete"),

  bots: () => call<{ bots: Bot[] }>("/bots"),
  previews: () =>
    call<{ previews: Record<string, { role: string; text: string }> }>("/previews"),
  createBot: (input: { name: string; purpose?: string; model?: string | null }) =>
    post<{ bot: Bot }>("/bots", input),
  updateBot: (
    id: string,
    patch: { name?: string; model?: string; colorIndex?: number; faceIndex?: number },
  ) =>
    call<{ bot: Bot }>(`/bots/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteBot: (id: string) =>
    call<{ ok: boolean; reason?: string }>(`/bots/${encodeURIComponent(id)}`, { method: "DELETE" }),

  scope: (id: string) => call<BotScope>(`/bots/${encodeURIComponent(id)}/scope`),
  /**
   * Sends `id -> stays on` for each switch; anything absent is left as it is.
   * Returns the stored scope, which is not always what was asked for — the
   * manager keeps the tools it cannot give up.
   */
  setScope: (
    id: string,
    intent: { capabilities: Record<string, boolean>; connections: Record<string, boolean> },
  ) =>
    call<BotScope>(`/bots/${encodeURIComponent(id)}/scope`, {
      method: "PUT",
      body: JSON.stringify(intent),
    }),

  thread: (botId: string) =>
    call<{
      bot: Bot;
      messages: { role: "user" | "assistant"; text: string; ts: number }[];
      runs: (Run & { botId: string; sessionKey: string; stepCount: number })[];
    }>(`/threads/${encodeURIComponent(botId)}`),
  send: (
    botId: string,
    text: string,
    opts?: { model?: string; thinking?: string; attachments?: Attachment[] },
  ) => post<{ runId: string }>(`/threads/${encodeURIComponent(botId)}/send`, { text, ...opts }),
  attach: (botId: string, name: string, dataBase64: string) =>
    post<Attachment>(`/threads/${encodeURIComponent(botId)}/attach`, { name, dataBase64 }),
  openSignIn: (botId: string, url: string) =>
    post<{ ok: boolean; error?: string }>(`/threads/${encodeURIComponent(botId)}/signin`, { url }),
  abort: (botId: string) => post<{ ok: boolean }>(`/threads/${encodeURIComponent(botId)}/abort`),

  approvePlan: (plan: Plan) =>
    post<{ created: { botId: string; name: string; firstMessage: string }[] }>("/plans/approve", {
      plan,
    }),
  pendingFirstMessages: () => call<{ pending: Record<string, string> }>("/plans/pending"),
  clearPending: (botId: string) => post<{ ok: boolean }>("/plans/pending/clear", { botId }),

  pendingApprovals: () =>
    call<{ pending: { id: string; payload: Record<string, unknown> }[] }>("/approvals"),
  connections: () => call<{ presets: McpPreset[] }>("/connections"),
  connectPreset: (id: string) =>
    post<{ ok: boolean; output: string }>("/connections/connect", { id }),
  runSetupStep: (id: string, index: number) =>
    post<{ ok: boolean; output: string; label: string }>("/connections/setup", { id, index }),
  addCustomConnection: (name: string, url: string) =>
    post<{ ok: boolean; output: string }>("/connections/custom", { name, url }),
  removeConnection: (name: string) =>
    post<{ ok: boolean; output: string }>("/connections/remove", { name }),
  skills: () => call<{ skills: Skill[] }>("/skills"),
  installSkill: (name: string) =>
    post<{ ok: boolean; output: string }>("/skills/install", { name }),
  searchHub: (q: string) =>
    call<{ results: HubSkill[] }>(`/clawhub/search?q=${encodeURIComponent(q)}`),
  installHubSkill: (reference: string) =>
    post<{ ok: boolean; error?: string }>("/clawhub/install", { reference }),

  resolveApproval: (id: string, decision: ApprovalDecision, note?: string) =>
    post<{ ok: boolean }>(`/approvals/${encodeURIComponent(id)}/resolve`, { decision, note }),
};
