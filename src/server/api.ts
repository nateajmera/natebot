import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayClient } from "./gateway/client.js";
import type { Hub } from "./hub.js";
import { contentToText } from "./hub.js";
import {
  getJsonState,
  getBot,
  listRunsForSession,
  setJsonState,
  setState,
  getState,
  updateBot,
} from "./db.js";
import { allBots, createBot, manager, removeBot, renameBot, setBotModel } from "./bots.js";
import { validatePlan } from "./persona.js";
import {
  capabilitiesFromPlanTools,
  parseCapabilityMap,
  parseConnectionMap,
  readScope,
  writeScopes,
  type ScopeChoice,
} from "./scoping.js";
import { applyProviderChoice, detectProviders, pickManagerModel } from "./providers.js";
import {
  addCustomServer,
  connectPreset,
  installHubSkill,
  listMcpPresets,
  removeServer,
  installSkillTool,
  listSkills,
  runSetupStep,
  searchHub,
} from "./connections.js";
import type { GatewayConnection } from "./preflight.js";
import { spawn } from "node:child_process";
import { mkdir, writeFile, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { WORKSPACES_DIR } from "./db.js";
import type { Broadcast } from "./hub.js";
import type { ModelRecord } from "./gateway/types.js";
import { log } from "./log.js";

export type ApiContext = {
  gateway: GatewayClient | null;
  hub: Hub | null;
  /** Lets mutations tell every open tab to re-read state immediately. */
  broadcast: Broadcast;
  connection: GatewayConnection | null;
  preflight: { phase: string; line: string; detail?: string };
  version: string;
};

type Json = Record<string, unknown> | unknown[] | null;

/**
 * The gateway has no per-message model parameter — `chat.send` rejects one
 * outright. A model override is therefore applied to the session immediately
 * before the send, and cleared again the moment a message goes out without
 * one. That is what makes it a genuine one-off that snaps back next message.
 */
const appliedModelOverride = new Map<string, string | null>();

async function applyModelOverride(
  gateway: GatewayClient,
  sessionKey: string,
  model: string | null,
): Promise<void> {
  const current = appliedModelOverride.get(sessionKey) ?? null;
  if (current === model) return;
  try {
    await gateway.request("sessions.patch", { key: sessionKey, model });
    appliedModelOverride.set(sessionKey, model);
  } catch (err) {
    log.debug(`sessions.patch model failed: ${(err as Error).message}`);
  }
}

/**
 * Screenshots live outside the web root, so they are served through here
 * rather than statically. Only OpenClaw's own media directories are readable,
 * resolved through realpath so a symlink cannot point somewhere else.
 */
const SHOT_ROOTS = [
  path.join(homedir(), ".openclaw", "media"),
  path.join(WORKSPACES_DIR),
];

const SHOT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

async function serveShot(res: ServerResponse, raw: string): Promise<void> {
  const ext = path.extname(raw).toLowerCase();
  const type = SHOT_TYPES[ext];
  if (!type) {
    send(res, 400, { error: "Not an image." });
    return;
  }
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(raw));
  } catch {
    send(res, 404, { error: "No such image." });
    return;
  }
  const roots = await Promise.all(
    SHOT_ROOTS.map(async (r) => {
      try {
        return await realpath(r);
      } catch {
        return r;
      }
    }),
  );
  if (!roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    send(res, 403, { error: "Outside the media directory." });
    return;
  }
  try {
    const info = await stat(resolved);
    res.writeHead(200, {
      "content-type": type,
      "content-length": String(info.size),
      "cache-control": "private, max-age=86400, immutable",
    });
    createReadStream(resolved).pipe(res);
  } catch {
    send(res, 404, { error: "No such image." });
  }
}

/**
 * Brings the agent's browser to the page the bot is stuck on. The `openclaw`
 * profile is a real, visible Chrome window, so once the tab is open the person
 * can simply sign in — which is the only way this should ever happen.
 */
async function openInAgentBrowser(url: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn("openclaw", ["browser", "open", url], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ ok: false, error: String(err) }));
    child.on("close", (code) =>
      code === 0
        ? resolve({ ok: true })
        : resolve({ ok: false, error: stderr.trim().slice(-400) || `exited ${code}` }),
    );
  });
}

/** Filenames arrive from the browser, so never let one escape the folder. */
function safeFileName(raw: string): string {
  const base = path.basename(raw).replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  return base.length > 0 ? base : "attachment";
}

function send(res: ServerResponse, status: number, body: Json): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function str(value: unknown, max = 8000): string {
  return typeof value === "string" ? value.slice(0, max).trim() : "";
}

/** Normalises whatever shape `chat.history` hands back into thread rows. */
function normalizeHistory(payload: unknown): { role: string; text: string; ts: number }[] {
  const raw = payload as Record<string, unknown> | undefined;
  const candidates =
    (Array.isArray(raw?.messages) && raw.messages) ||
    (Array.isArray(raw?.history) && raw.history) ||
    (Array.isArray(payload) && payload) ||
    [];
  const out: { role: string; text: string; ts: number }[] = [];
  for (const entry of candidates as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const role = typeof e.role === "string" ? e.role : "assistant";
    if (role !== "user" && role !== "assistant") continue;
    const text = contentToText(e.content ?? e.text);
    if (!text.trim()) continue;
    const ts =
      typeof e.timestamp === "number" ? e.timestamp : typeof e.ts === "number" ? e.ts : Date.now();
    out.push({ role, text, ts });
  }
  return out;
}

/**
 * The gateway exposes every thinking level a model technically accepts, which
 * for Anthropic is eight — including `minimal`, `adaptive` and `xhigh`. That is
 * a spec sheet, not a choice. People already understand a low/medium/high
 * ladder, so Anthropic gets the familiar four plus off.
 *
 * Curated lists are always filtered against what the gateway actually reported,
 * so this can only ever narrow the real options, never invent one.
 */
const CURATED_THINKING: { match: (model: string) => boolean; levels: string[] }[] = [
  {
    match: (model) => /claude|anthropic/i.test(model),
    levels: ["off", "low", "medium", "high", "max"],
  },
];

function curateThinking(model: string | null, options: string[]): string[] {
  if (!model || options.length === 0) return options;
  const rule = CURATED_THINKING.find((r) => r.match(model));
  if (!rule) return options;
  const curated = rule.levels.filter((level) => options.includes(level));
  // If a future model drops these names entirely, show what it does support
  // rather than an empty menu.
  return curated.length > 0 ? curated : options;
}

/**
 * Per-agent model and thinking options, read from the gateway rather than
 * hard-coded. Thinking levels differ by model, so the only correct source is
 * whatever the gateway reports for that agent right now.
 */
async function agentInfo(
  gateway: GatewayClient | null,
): Promise<Map<string, { model: string | null; thinkingOptions: string[]; thinkingDefault: string }>> {
  const out = new Map<string, { model: string | null; thinkingOptions: string[]; thinkingDefault: string }>();
  if (!gateway?.connected) return out;
  try {
    const res = await gateway.request<{
      agents: {
        id: string;
        model?: { primary?: string } | string;
        thinkingOptions?: string[];
        thinkingDefault?: string;
      }[];
    }>("agents.list", {});
    for (const a of res.agents ?? []) {
      const model =
        typeof a.model === "string" ? a.model : (a.model?.primary ?? null);
      const reported = Array.isArray(a.thinkingOptions) ? a.thinkingOptions : [];
      out.set(a.id, {
        model,
        thinkingOptions: curateThinking(model, reported),
        thinkingDefault: typeof a.thinkingDefault === "string" ? a.thinkingDefault : "off",
      });
    }
  } catch (err) {
    log.debug(`agents.list failed: ${(err as Error).message}`);
  }
  return out;
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<boolean> {
  const route = url.pathname.replace(/^\/api/, "") || "/";
  const method = req.method ?? "GET";
  const gateway = ctx.gateway;

  const needGateway = (): GatewayClient | null => {
    if (!gateway || !gateway.connected) {
      send(res, 503, { error: "Not connected to the OpenClaw gateway yet." });
      return null;
    }
    return gateway;
  };

  try {
    /* ------------------------------------------------------------- state */
    if (route === "/state" && method === "GET") {
      let models: ModelRecord[] = [];
      if (gateway?.connected) {
        try {
          const r = await gateway.request<{ models: ModelRecord[] }>("models.list", {});
          models = r.models ?? [];
        } catch {
          models = [];
        }
      }
      const info = await agentInfo(gateway);
      const labelFor = (id: string | null): string | null => {
        if (!id) return null;
        const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
        const hit = models.find((m) => m.id === bare || `${m.provider}/${m.id}` === id);
        return hit?.name ?? bare;
      };
      send(res, 200, {
        version: ctx.version,
        onboarded: getState("onboarded") === "1",
        userName: getState("userName") ?? "",
        provider: getState("provider") ?? "",
        bots: allBots().map((b) => {
          const extra = info.get(b.agentId);
          return {
            ...b,
            effectiveModel: b.model ?? extra?.model ?? null,
            effectiveModelLabel: labelFor(b.model ?? extra?.model ?? null),
            thinkingOptions: extra?.thinkingOptions ?? [],
            thinkingDefault: extra?.thinkingDefault ?? "off",
          };
        }),
        models,
        gateway: {
          connected: gateway?.connected ?? false,
          openclawVersion: ctx.connection?.openclawVersion ?? null,
          port: ctx.connection?.port ?? null,
        },
        preflight: ctx.preflight,
      });
      return true;
    }

    /* -------------------------------------------------------- onboarding */
    if (route === "/onboarding/name" && method === "POST") {
      const body = await readJson(req);
      const name = str(body.name, 60);
      if (!name) return send(res, 400, { error: "Name is required." }), true;
      setState("userName", name);
      send(res, 200, { ok: true, userName: name });
      return true;
    }

    if (route === "/providers" && method === "GET") {
      const g = needGateway();
      if (!g) return true;
      send(res, 200, { providers: await detectProviders(g) });
      return true;
    }

    if (route === "/onboarding/provider" && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      const body = await readJson(req);
      const provider = str(body.provider, 40);
      const modelId = str(body.modelId, 200);
      if (!provider) return send(res, 400, { error: "Pick a provider." }), true;
      if (modelId) {
        try {
          await applyProviderChoice(g, modelId);
        } catch (err) {
          log.warn(`could not set default model: ${(err as Error).message}`);
        }
      }
      setState("provider", provider);
      send(res, 200, { ok: true });
      return true;
    }

    if (route === "/onboarding/manager" && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      if (manager()) return send(res, 200, { ok: true, bot: manager() }), true;
      const body = await readJson(req);
      const name = str(body.name, 40) || "Commander";
      // The manager speaks at both ends of every task, so it defaults to a
      // cheaper model than the workers it dispatches. An explicit choice wins.
      let managerModel = str(body.model, 200) || null;
      if (!managerModel) {
        const info = await agentInfo(g);
        const workerModel = info.get("main")?.model ?? null;
        managerModel = await pickManagerModel(g, workerModel);
      }
      const bot = await createBot(g, {
        name,
        kind: "manager",
        ownerName: getState("userName") ?? "the user",
        model: managerModel,
      });
      await ctx.hub?.subscribeSession(bot.sessionKey);
      ctx.broadcast({ t: "bots.changed" });
      send(res, 200, { ok: true, bot });
      return true;
    }

    if (route === "/onboarding/complete" && method === "POST") {
      setState("onboarded", "1");
      send(res, 200, { ok: true });
      return true;
    }

    /* --------------------------------------------------------------- bots */
    if (route === "/bots" && method === "GET") {
      send(res, 200, { bots: allBots() });
      return true;
    }

    if (route === "/bots" && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      const body = await readJson(req);
      const name = str(body.name, 40);
      if (!name) return send(res, 400, { error: "Give your bot a name." }), true;
      const bot = await createBot(g, {
        name,
        kind: "worker",
        purpose: str(body.purpose, 400),
        model: str(body.model, 200) || null,
        ownerName: getState("userName") ?? "the user",
      });
      await ctx.hub?.subscribeSession(bot.sessionKey);
      ctx.broadcast({ t: "bots.changed" });
      send(res, 200, { ok: true, bot });
      return true;
    }

    const botMatch = /^\/bots\/([^/]+)$/.exec(route);
    if (botMatch?.[1]) {
      const g = needGateway();
      if (!g) return true;
      const botId = decodeURIComponent(botMatch[1]);
      if (method === "PATCH") {
        const body = await readJson(req);
        let bot = getBot(botId);
        if (!bot) return send(res, 404, { error: "No such bot." }), true;
        const name = str(body.name, 40);
        if (name && name !== bot.name) bot = (await renameBot(g, botId, name)) ?? bot;
        const model = str(body.model, 200);
        if (model && model !== bot.model) bot = (await setBotModel(g, botId, model)) ?? bot;

        // Appearance is ours alone — OpenClaw has no opinion about it, so this
        // never touches the gateway.
        const appearance: { colorIndex?: number; faceIndex?: number } = {};
        if (typeof body.colorIndex === "number" && Number.isInteger(body.colorIndex)) {
          appearance.colorIndex = Math.max(0, Math.min(999, body.colorIndex));
        }
        if (typeof body.faceIndex === "number" && Number.isInteger(body.faceIndex)) {
          appearance.faceIndex = Math.max(0, Math.min(999, body.faceIndex));
        }
        if (Object.keys(appearance).length > 0) {
          updateBot(botId, appearance);
          bot = getBot(botId) ?? bot;
        }

        ctx.broadcast({ t: "bots.changed" });
        send(res, 200, { ok: true, bot });
        return true;
      }
      if (method === "DELETE") {
        const result = await removeBot(g, botId);
        if (result.ok) ctx.broadcast({ t: "bots.changed" });
        send(res, result.ok ? 200 : 409, result);
        return true;
      }
    }

    /* What this bot is allowed to reach. Scoped to the one bot in the drawer —
       there is no global version of this screen anywhere in the app. */
    const scopeMatch = /^\/bots\/([^/]+)\/scope$/.exec(route);
    if (scopeMatch?.[1]) {
      const g = needGateway();
      if (!g) return true;
      const bot = getBot(decodeURIComponent(scopeMatch[1]));
      if (!bot) return send(res, 404, { error: "No such bot." }), true;

      if (method === "GET") {
        send(res, 200, await readScope(g, bot.agentId, bot.kind));
        return true;
      }
      if (method === "PUT") {
        const body = await readJson(req);
        const result = await writeScopes(g, [
          {
            agentId: bot.agentId,
            kind: bot.kind,
            capabilities: parseCapabilityMap(body.capabilities),
            connections: parseConnectionMap(body.connections),
          },
        ]);
        if (!result.ok) return send(res, 500, { error: result.error }), true;
        // What was stored, not what was asked for — the manager keeps the tools
        // it is not allowed to give up. This comes back from the write itself
        // rather than a second read, which would be racing the reload the write
        // just triggered.
        const stored = result.scopes?.[bot.agentId] ?? (await readScope(g, bot.agentId, bot.kind));
        send(res, 200, { ok: true, ...stored });
        return true;
      }
    }

    if (route === "/shot" && method === "GET") {
      const target = url.searchParams.get("p") ?? "";
      if (!target) return send(res, 400, { error: "No image given." }), true;
      await serveShot(res, target);
      return true;
    }

    /* ------------------------------------------------------------ threads */
    const threadMatch = /^\/threads\/([^/]+)$/.exec(route);
    if (threadMatch?.[1] && method === "GET") {
      const bot = getBot(decodeURIComponent(threadMatch[1]));
      if (!bot) return send(res, 404, { error: "No such bot." }), true;
      let messages: { role: string; text: string; ts: number }[] = [];
      if (gateway?.connected) {
        try {
          messages = normalizeHistory(
            await gateway.request("chat.history", { sessionKey: bot.sessionKey }),
          );
        } catch (err) {
          log.debug(`chat.history failed: ${(err as Error).message}`);
        }
      }
      send(res, 200, { bot, messages, runs: listRunsForSession(bot.sessionKey) });
      return true;
    }

    const sendMatch = /^\/threads\/([^/]+)\/send$/.exec(route);
    if (sendMatch?.[1] && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      const bot = getBot(decodeURIComponent(sendMatch[1]));
      if (!bot) return send(res, 404, { error: "No such bot." }), true;
      const body = await readJson(req);
      const text = str(body.text, 24_000);
      if (!text) return send(res, 400, { error: "Nothing to send." }), true;

      await ctx.hub?.subscribeSession(bot.sessionKey);

      // Attachments live in the bot's own workspace, and the message points at
      // them. Bots run locally with file tools, so this is how a file actually
      // becomes readable to one — the gateway's `attachments` field is accepted
      // but never reaches the model.
      let message = text;
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      const attached: string[] = [];
      for (const entry of attachments.slice(0, 10)) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        const name = safeFileName(str(e.name, 200));
        const filePath = str(e.path, 800);
        if (!name || !filePath) continue;
        attached.push(`${name} — ${filePath}`);
      }
      if (attached.length > 0) {
        message +=
          `\n\n[Attached ${attached.length === 1 ? "file" : "files"}, read from disk:]\n` +
          attached.map((a) => `- ${a}`).join("\n");
      }

      const params: Record<string, unknown> = { sessionKey: bot.sessionKey, message };

      // Thinking is a real one-turn parameter; the model override is not, so it
      // goes through the session instead.
      const thinking = str(body.thinking, 20);
      if (thinking) params.thinking = thinking;
      await applyModelOverride(g, bot.sessionKey, str(body.model, 200) || null);

      const result = await g.request<{ runId: string; status: string }>("chat.send", params);
      send(res, 200, { ok: true, ...result });
      return true;
    }

    /* Opens the agent's own browser at a page the bot is blocked on, so the
       person can sign in by hand. We never touch their everyday browser and we
       never handle a credential. */
    const signinMatch = /^\/threads\/([^/]+)\/signin$/.exec(route);
    if (signinMatch?.[1] && method === "POST") {
      const bot = getBot(decodeURIComponent(signinMatch[1]));
      if (!bot) return send(res, 404, { error: "No such bot." }), true;
      const body = await readJson(req);
      const target = str(body.url, 2000);
      if (!/^https?:\/\//i.test(target)) {
        return send(res, 400, { error: "That isn't a web address." }), true;
      }
      const opened = await openInAgentBrowser(target);
      send(res, opened.ok ? 200 : 502, opened);
      return true;
    }

    const attachMatch = /^\/threads\/([^/]+)\/attach$/.exec(route);
    if (attachMatch?.[1] && method === "POST") {
      const bot = getBot(decodeURIComponent(attachMatch[1]));
      if (!bot) return send(res, 404, { error: "No such bot." }), true;
      const body = await readJson(req);
      const name = safeFileName(str(body.name, 200));
      const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
      if (!name || !dataBase64) return send(res, 400, { error: "Nothing to attach." }), true;

      const buffer = Buffer.from(dataBase64, "base64");
      if (buffer.length > 25_000_000) {
        return send(res, 413, { error: "That file is too big (25MB max)." }), true;
      }
      const dir = path.join(WORKSPACES_DIR, bot.agentId, "attachments");
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, `${Date.now()}-${name}`);
      await writeFile(target, buffer);
      send(res, 200, { ok: true, name, path: target, bytes: buffer.length });
      return true;
    }

    const abortMatch = /^\/threads\/([^/]+)\/abort$/.exec(route);
    if (abortMatch?.[1] && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      const bot = getBot(decodeURIComponent(abortMatch[1]));
      if (!bot) return send(res, 404, { error: "No such bot." }), true;
      try {
        await g.request("chat.abort", { sessionKey: bot.sessionKey });
      } catch (err) {
        log.debug(`chat.abort failed: ${(err as Error).message}`);
      }
      send(res, 200, { ok: true });
      return true;
    }

    /* ----------------------------------------------------------- previews */
    if (route === "/previews" && method === "GET") {
      const bots = allBots();
      const previews: Record<string, { role: string; text: string }> = {};
      if (gateway?.connected && bots.length > 0) {
        try {
          const res = await gateway.request<{
            previews: { key: string; status: string; items?: { role: string; text: string }[] }[];
          }>("sessions.preview", { keys: bots.map((b) => b.sessionKey) });
          const byKey = new Map((res.previews ?? []).map((p) => [p.key, p]));
          for (const bot of bots) {
            const last = byKey.get(bot.sessionKey)?.items?.at(-1);
            if (last) previews[bot.id] = { role: last.role, text: last.text };
          }
        } catch (err) {
          log.debug(`sessions.preview failed: ${(err as Error).message}`);
        }
      }
      send(res, 200, { previews });
      return true;
    }

    /* -------------------------------------------------------------- plans */
    if (route === "/plans/approve" && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      const body = await readJson(req);
      // Re-validated here rather than trusted: the browser decides what to
      // *draw*, this decides what may actually be created.
      const plan = validatePlan(body.plan);
      if (!plan) {
        return send(res, 400, { error: "That plan has no bots in it." }), true;
      }
      const created: { botId: string; name: string; firstMessage: string }[] = [];
      const scopes: ScopeChoice[] = [];
      for (const spec of plan.bots) {
        const bot = await createBot(g, {
          name: spec.name,
          kind: "worker",
          purpose: spec.purpose,
          ownerName: getState("userName") ?? "the user",
        });
        await ctx.hub?.subscribeSession(bot.sessionKey);

        // The plan card told the user this bot would get these tools, so it
        // gets these tools. A list naming nothing we recognise leaves the bot
        // unscoped rather than stripping it on a word we failed to parse.
        const capabilities = capabilitiesFromPlanTools(spec.tools);
        if (capabilities) {
          scopes.push({ agentId: bot.agentId, kind: "worker", capabilities });
        }

        // Pre-filled, deliberately not sent — approving a plan creates the team,
        // it does not start work behind the user's back.
        created.push({ botId: bot.id, name: bot.name, firstMessage: spec.firstMessage });
      }

      // One write for the whole team: control-plane writes are capped at three
      // a minute, and a three-bot plan would sit exactly on that limit.
      if (scopes.length > 0) {
        const scoped = await writeScopes(g, scopes);
        if (!scoped.ok) log.warn(`created the bots but couldn't scope them: ${scoped.error}`);
      }
      setJsonState("pendingFirstMessages", {
        ...getJsonState<Record<string, string>>("pendingFirstMessages", {}),
        ...Object.fromEntries(created.map((c) => [c.botId, c.firstMessage])),
      });
      ctx.broadcast({ t: "bots.changed" });
      send(res, 200, { ok: true, created });
      return true;
    }

    if (route === "/plans/pending" && method === "GET") {
      send(res, 200, { pending: getJsonState<Record<string, string>>("pendingFirstMessages", {}) });
      return true;
    }

    if (route === "/plans/pending/clear" && method === "POST") {
      const body = await readJson(req);
      const botId = str(body.botId, 80);
      const pending = getJsonState<Record<string, string>>("pendingFirstMessages", {});
      delete pending[botId];
      setJsonState("pendingFirstMessages", pending);
      send(res, 200, { ok: true });
      return true;
    }

    /* -------------------------------------------------------- connections */
    if (route === "/connections" && method === "GET") {
      const g = needGateway();
      if (!g) return true;
      send(res, 200, { presets: await listMcpPresets(g) });
      return true;
    }

    if (route === "/connections/connect" && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      const body = await readJson(req);
      const result = await connectPreset(g, str(body.id, 60));
      send(res, result.ok ? 200 : 500, result);
      return true;
    }

    /* Setup steps install software, so each runs only from its own click and
       its output is returned verbatim rather than summarised. */
    if (route === "/connections/setup" && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      const body = await readJson(req);
      const index = typeof body.index === "number" ? body.index : -1;
      if (index < 0) return send(res, 400, { error: "Which step?" }), true;
      const result = await runSetupStep(str(body.id, 60), index);
      send(res, result.ok ? 200 : 500, result);
      return true;
    }

    if (route === "/connections/custom" && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      const body = await readJson(req);
      const result = await addCustomServer({
        name: str(body.name, 60),
        url: str(body.url, 500) || undefined,
        command: str(body.command, 300) || undefined,
        args: Array.isArray(body.args)
          ? body.args.filter((a: unknown): a is string => typeof a === "string").slice(0, 12)
          : [],
      });
      send(res, result.ok ? 200 : 500, result);
      return true;
    }

    if (route === "/connections/remove" && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      const body = await readJson(req);
      const result = await removeServer(str(body.name, 60));
      send(res, result.ok ? 200 : 500, result);
      return true;
    }

    /* Skills are know-how, not access — a separate surface from connectors. */
    if (route === "/skills" && method === "GET") {
      const g = needGateway();
      if (!g) return true;
      const all = url.searchParams.get("all") === "1";
      send(res, 200, { skills: await listSkills(g, all) });
      return true;
    }

    if (route === "/skills/install" && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      const body = await readJson(req);
      const result = await installSkillTool(g, str(body.name, 80));
      send(res, result.ok ? 200 : 500, result);
      return true;
    }

    if (route === "/clawhub/search" && method === "GET") {
      const g = needGateway();
      if (!g) return true;
      const query = (url.searchParams.get("q") ?? "").slice(0, 120).trim();
      if (!query) return send(res, 200, { results: [] }), true;
      send(res, 200, { results: await searchHub(g, query) });
      return true;
    }

    if (route === "/clawhub/install" && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      const body = await readJson(req);
      const reference = str(body.reference, 200);
      if (!reference) return send(res, 400, { error: "Nothing to install." }), true;
      const result = await installHubSkill(g, reference);
      send(res, result.ok ? 200 : 500, result);
      return true;
    }

    /* ---------------------------------------------------------- approvals */
    if (route === "/approvals" && method === "GET") {
      const g = needGateway();
      if (!g) return true;
      // Approvals block an agent mid-run, so one raised while the window was
      // closed must still be waiting when it opens. Live events alone would
      // lose it.
      let pending: { id: string; payload: unknown }[] = [];
      try {
        const raw = await g.request<unknown>("exec.approval.list", {});
        const arr = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as Record<string, unknown>)?.approvals)
            ? ((raw as Record<string, unknown>).approvals as unknown[])
            : [];
        pending = arr.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) return [];
          const e = entry as Record<string, unknown>;
          const id = typeof e.id === "string" ? e.id : typeof e.requestId === "string" ? e.requestId : "";
          return id ? [{ id, payload: e }] : [];
        });
      } catch (err) {
        log.debug(`exec.approval.list failed: ${(err as Error).message}`);
      }
      send(res, 200, { pending });
      return true;
    }

    const approvalMatch = /^\/approvals\/([^/]+)\/resolve$/.exec(route);
    if (approvalMatch?.[1] && method === "POST") {
      const g = needGateway();
      if (!g) return true;
      const body = await readJson(req);
      const requested = str(body.decision, 20);
      // Only the gateway's own vocabulary; anything else is refused rather
      // than forwarded and rejected downstream.
      const VALID = new Set(["allow-once", "allow-always", "deny"]);
      const decision = VALID.has(requested) ? requested : "deny";
      const note = str(body.note, 2000);
      const params: Record<string, unknown> = {
        id: decodeURIComponent(approvalMatch[1]),
        decision,
      };
      if (note) params.note = note;
      try {
        await g.request("exec.approval.resolve", params);
      } catch {
        await g.request("plugin.approval.resolve", params);
      }
      send(res, 200, { ok: true });
      return true;
    }

    send(res, 404, { error: "Unknown endpoint." });
    return true;
  } catch (err) {
    log.debug(`api error on ${route}: ${(err as Error).message}`);
    send(res, 500, { error: (err as Error).message });
    return true;
  }
}
