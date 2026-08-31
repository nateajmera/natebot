import type { GatewayClient } from "./gateway/client.js";
import type {
  AgentEvent,
  ChatEvent,
  SessionMessageEvent,
  SessionsChangedEvent,
} from "./gateway/types.js";
import {
  finishRun,
  getBotBySessionKey,
  listBots,
  recordStepResult,
  recordStepStart,
  upsertRunStart,
} from "./db.js";
import { log } from "./log.js";

/** Everything the browser is told about, in one closed set. */
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
      /** Screenshot this step produced, rendered by us at no model cost. */
      shotPath: string | null;
      ts: number;
    }
  | { t: "assistant"; sessionKey: string; runId: string; text: string }
  | { t: "message"; sessionKey: string; role: string; text: string; ts: number }
  | { t: "approval.requested"; sessionKey: string | null; id: string; payload: unknown }
  | { t: "approval.resolved"; id: string; payload: unknown };

export type Broadcast = (event: ClientEvent) => void;

/** Told when something needs the person, so a shell can raise a notification. */
export type ApprovalNotifier = (info: { title: string; body: string }) => void;

/**
 * OpenClaw marks attached media inline as `MEDIA:/absolute/path`. That is a
 * transport detail: the filmstrip already shows the picture, so the raw path
 * has no business being read by a person.
 */
const MEDIA_LINE = /^\s*MEDIA:\s*\S+\s*$/gim;

export function stripMediaMarkers(text: string): string {
  return text.replace(MEDIA_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** OpenClaw message content is either a string or an array of typed blocks. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return stripMediaMarkers(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return stripMediaMarkers(parts.join(""));
}

/** Where OpenClaw writes browser screenshots. Nothing outside this is served. */
const SHOT_PATH = /Screenshot saved to "([^"]+\.(?:jpg|jpeg|png))"/i;

/**
 * Noise OpenClaw writes into browser tool results that is wrong or redundant
 * once we have the filmstrip.
 *
 * The "vision failed" line is the important one: it refers to OpenClaw's
 * optional auto-captioning pass (`mediaUnderstanding`), NOT to whether the
 * model can see. Verified by having a bot describe a photograph whose content
 * appears nowhere in its URL — it saw it perfectly, while this line was still
 * present. Showing it to a user states the opposite of the truth.
 */
const RESULT_NOISE: RegExp[] = [
  /^\s*\[browser screenshot vision failed:[^\]]*\]\s*$/gim,
  /^\s*\[Screenshot saved to "[^"]+"\.[^\]]*\]\s*$/gim,
];

function stripResultNoise(text: string): string {
  let out = text;
  for (const pattern of RESULT_NOISE) out = out.replace(pattern, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Tool results from the browser carry the whole screenshot inline as base64,
 * which is useless to us — we render the file from disk instead. This keeps
 * the readable text, lifts out the path, and throws the blob away rather than
 * writing tens of kilobytes of it into SQLite on every step.
 */
export function condenseToolResult(result: unknown): { text: string; shotPath: string | null } {
  let blocks: unknown = result;
  if (typeof result === "string") {
    try {
      blocks = JSON.parse(result);
    } catch {
      const direct = SHOT_PATH.exec(result);
      return { text: result, shotPath: direct?.[1] ?? null };
    }
  }

  if (!Array.isArray(blocks)) {
    const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
    return { text, shotPath: SHOT_PATH.exec(text)?.[1] ?? null };
  }

  const parts: string[] = [];
  let images = 0;
  for (const block of blocks) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "image") {
      images += 1;
      continue;
    }
    if (typeof b.text === "string") parts.push(b.text);
  }
  const joined = parts.join("\n");
  // Pull the path out before the noise filter removes the line carrying it.
  const shotPath = SHOT_PATH.exec(joined)?.[1] ?? null;
  const text =
    stripResultNoise(joined) +
    (images > 0 ? `\n[${images} screenshot${images === 1 ? "" : "s"} — shown above]` : "");
  return { text: text.trim(), shotPath };
}

function resultToText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Wires the gateway's event stream to two places at once: SQLite (so a reload
 * replays the same step rows) and the browser (so they appear live).
 */
export class Hub {
  private readonly subscribed = new Set<string>();

  constructor(
    private readonly gateway: GatewayClient,
    private readonly broadcast: Broadcast,
    private readonly notify: ApprovalNotifier | null = null,
  ) {}

  start(): void {
    this.gateway.on("ready", () => {
      this.broadcast({ t: "gateway", connected: true });
      this.subscribed.clear();
      void this.resubscribeAll();
    });
    this.gateway.on("disconnected", () => {
      this.broadcast({ t: "gateway", connected: false });
    });

    this.gateway.on("event:agent", (payload: unknown) => this.onAgentEvent(payload as AgentEvent));
    this.gateway.on("event:chat", (payload: unknown) => this.onChatEvent(payload as ChatEvent));
    this.gateway.on("event:session.message", (payload: unknown) =>
      this.onSessionMessage(payload as SessionMessageEvent),
    );
    this.gateway.on("event:sessions.changed", (payload: unknown) =>
      this.onSessionsChanged(payload as SessionsChangedEvent),
    );
    this.gateway.on("event:exec.approval.requested", (payload: unknown) =>
      this.onApprovalRequested(payload),
    );
    this.gateway.on("event:plugin.approval.requested", (payload: unknown) =>
      this.onApprovalRequested(payload),
    );
    this.gateway.on("event:exec.approval.resolved", (payload: unknown) =>
      this.onApprovalResolved(payload),
    );
    this.gateway.on("event:plugin.approval.resolved", (payload: unknown) =>
      this.onApprovalResolved(payload),
    );
  }

  /** Session-scoped transcript events only arrive for keys we've subscribed to. */
  async subscribeSession(sessionKey: string): Promise<void> {
    if (this.subscribed.has(sessionKey)) return;
    try {
      await this.gateway.request("sessions.messages.subscribe", { key: sessionKey });
      this.subscribed.add(sessionKey);
      log.debug(`subscribed to ${sessionKey}`);
    } catch (err) {
      log.debug(`subscribe failed for ${sessionKey}: ${(err as Error).message}`);
    }
  }

  async resubscribeAll(): Promise<void> {
    try {
      await this.gateway.request("sessions.subscribe", {});
    } catch (err) {
      log.debug(`sessions.subscribe failed: ${(err as Error).message}`);
    }
    for (const bot of listBots()) {
      await this.subscribeSession(bot.sessionKey);
    }
  }

  private onAgentEvent(evt: AgentEvent): void {
    if (!evt?.sessionKey || evt.isHeartbeat) return;
    const bot = getBotBySessionKey(evt.sessionKey);
    if (!bot) return;

    if (evt.stream === "lifecycle") {
      const data = evt.data as { phase: string; startedAt?: number; endedAt?: number; error?: unknown };
      if (data.phase === "start") {
        const startedAt = data.startedAt ?? evt.ts ?? Date.now();
        upsertRunStart({
          runId: evt.runId,
          botId: bot.id,
          sessionKey: evt.sessionKey,
          startedAt,
        });
        this.broadcast({ t: "run.start", sessionKey: evt.sessionKey, runId: evt.runId, startedAt });
        return;
      }
      if (data.phase === "end") {
        const endedAt = data.endedAt ?? evt.ts ?? Date.now();
        const status = data.error ? "failed" : "done";
        finishRun(evt.runId, endedAt, status);
        this.broadcast({ t: "run.end", sessionKey: evt.sessionKey, runId: evt.runId, endedAt, status });
      }
      return;
    }

    if (evt.stream === "tool") {
      const data = evt.data as {
        phase: string;
        name: string;
        toolCallId: string;
        args?: Record<string, unknown>;
        result?: unknown;
        isError?: boolean;
      };
      const ts = evt.ts ?? Date.now();
      if (data.phase === "start") {
        recordStepStart({
          runId: evt.runId,
          toolCallId: data.toolCallId,
          name: data.name,
          args: data.args,
          startedAt: ts,
        });
        this.broadcast({
          t: "step.start",
          sessionKey: evt.sessionKey,
          runId: evt.runId,
          toolCallId: data.toolCallId,
          name: data.name,
          args: data.args ?? null,
          ts,
        });
        return;
      }
      if (data.phase === "result") {
        const { text, shotPath } = condenseToolResult(data.result);
        recordStepResult({
          runId: evt.runId,
          toolCallId: data.toolCallId,
          result: text,
          isError: data.isError === true,
          endedAt: ts,
          shotPath,
        });
        this.broadcast({
          t: "step.result",
          sessionKey: evt.sessionKey,
          runId: evt.runId,
          toolCallId: data.toolCallId,
          isError: data.isError === true,
          result: text.slice(0, 4000),
          shotPath,
          ts,
        });
      }
      return;
    }

    if (evt.stream === "assistant") {
      const data = evt.data as { text?: string };
      if (typeof data.text !== "string") return;
      // `text` is cumulative, so we forward it whole and skip delta reassembly.
      this.broadcast({
        t: "assistant",
        sessionKey: evt.sessionKey,
        runId: evt.runId,
        text: data.text,
      });
    }
  }

  private onChatEvent(evt: ChatEvent): void {
    if (!evt?.sessionKey || evt.state !== "final" || !evt.message) return;
    const text = contentToText(evt.message.content);
    if (!text) return;
    this.broadcast({
      t: "message",
      sessionKey: evt.sessionKey,
      role: "assistant",
      text,
      ts: evt.message.timestamp ?? Date.now(),
    });
  }

  private onSessionMessage(evt: SessionMessageEvent): void {
    if (!evt?.sessionKey || !evt.message) return;
    // Assistant rows already arrive via the `chat` final frame; forwarding both
    // would double every reply in the thread.
    if (evt.message.role !== "user") return;
    const text = contentToText(evt.message.content);
    if (!text) return;
    this.broadcast({
      t: "message",
      sessionKey: evt.sessionKey,
      role: "user",
      text,
      ts: evt.message.timestamp ?? Date.now(),
    });
  }

  private onSessionsChanged(_evt: SessionsChangedEvent): void {
    // Sidebar state is derived from run.start/run.end, which are strictly more
    // precise. Nothing to do here yet; kept as an explicit no-op so the
    // subscription's purpose stays visible.
  }

  private onApprovalRequested(payload: unknown): void {
    const p = (payload ?? {}) as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : typeof p.requestId === "string" ? p.requestId : "";
    if (!id) return;
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : null;
    this.broadcast({ t: "approval.requested", sessionKey, id, payload: p });

    // An approval blocks a bot mid-run, and the window is often not in front
    // when it happens — that is the whole point of agents working unattended.
    const request = (p.request ?? p) as Record<string, unknown>;
    const bot = sessionKey ? (getBotBySessionKey(sessionKey)?.name ?? null) : null;
    const title =
      typeof request.title === "string" && request.title
        ? request.title
        : `${bot ?? "A bot"} needs your approval`;
    const body =
      typeof request.description === "string" && request.description
        ? request.description
        : typeof request.command === "string"
          ? request.command
          : "Open NateBot to answer.";
    try {
      this.notify?.({ title: title.slice(0, 120), body: body.slice(0, 240) });
    } catch (err) {
      log.debug(`notifier failed: ${(err as Error).message}`);
    }
  }

  private onApprovalResolved(payload: unknown): void {
    const p = (payload ?? {}) as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : typeof p.requestId === "string" ? p.requestId : "";
    if (!id) return;
    this.broadcast({ t: "approval.resolved", id, payload: p });
  }
}
