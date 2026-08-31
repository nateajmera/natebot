import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { GatewayClient } from "./gateway/client.js";
import {
  WORKSPACES_DIR,
  botCount,
  deleteBot,
  getBot,
  insertBot,
  listBots,
  updateBot,
  type Bot,
  type BotKind,
} from "./db.js";
import { log } from "./log.js";
import { managerBootstrap, workerBootstrap } from "./persona.js";

/**
 * A NateBot "bot" is an OpenClaw agent plus the presentation state OpenClaw
 * has no opinion about (colour, face, which thread it owns). Agent creation is
 * the source of truth; our row is the skin.
 */

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "bot";
}

async function uniqueAgentId(gateway: GatewayClient, desired: string): Promise<string> {
  const existing = await gateway.request<{ agents: { id: string }[] }>("agents.list", {});
  const taken = new Set(existing.agents.map((a) => a.id));
  if (!taken.has(desired)) return desired;
  for (let i = 2; i < 500; i++) {
    const candidate = `${desired}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${desired}-${randomUUID().slice(0, 6)}`;
}

export type CreateBotInput = {
  name: string;
  kind: BotKind;
  model?: string | null;
  /** Plain-language description of what this bot is for; seeds its persona file. */
  purpose?: string;
  ownerName?: string;
};

export async function createBot(gateway: GatewayClient, input: CreateBotInput): Promise<Bot> {
  const desiredId = input.kind === "manager" ? "commander" : slugify(input.name);
  const agentId = await uniqueAgentId(gateway, desiredId);
  const workspace = path.join(WORKSPACES_DIR, agentId);
  mkdirSync(workspace, { recursive: true });

  const created = await gateway.request<{ ok: boolean; agentId: string; workspace: string }>(
    "agents.create",
    { name: input.name, workspace },
  );
  // The gateway derives the id from the name; trust what it returns.
  const realAgentId = created.agentId ?? agentId;

  if (input.model) {
    await gateway.request("agents.update", { agentId: realAgentId, model: input.model });
  }

  // Persona lives in the agent's bootstrap files, which OpenClaw injects into
  // the system prompt. This is how "Commander" becomes a real role rather than
  // a label in our database.
  const bootstrap =
    input.kind === "manager"
      ? managerBootstrap({ botName: input.name, ownerName: input.ownerName ?? "the user" })
      : workerBootstrap({
          botName: input.name,
          purpose: input.purpose ?? "",
          ownerName: input.ownerName ?? "the user",
        });

  for (const [name, content] of Object.entries(bootstrap)) {
    try {
      await gateway.request("agents.files.set", { agentId: realAgentId, name, content });
    } catch (err) {
      log.debug(`could not write ${name} for ${realAgentId}: ${(err as Error).message}`);
    }
  }

  const isManager = input.kind === "manager";
  const bot: Bot = {
    id: randomUUID(),
    agentId: realAgentId,
    name: input.name,
    kind: input.kind,
    // The manager sits outside the worker colour sequence entirely.
    colorIndex: isManager ? -1 : botCount(),
    faceIndex: isManager ? -1 : botCount(),
    sessionKey: `agent:${realAgentId}:natebot`,
    model: input.model ?? null,
    createdAt: Date.now(),
  };
  insertBot(bot);
  log.debug(`created bot ${bot.name} (${bot.agentId})`);
  return bot;
}

export async function renameBot(gateway: GatewayClient, botId: string, name: string): Promise<Bot | null> {
  const bot = getBot(botId);
  if (!bot) return null;
  await gateway.request("agents.update", { agentId: bot.agentId, name });
  updateBot(botId, { name });
  return getBot(botId);
}

export async function setBotModel(gateway: GatewayClient, botId: string, model: string): Promise<Bot | null> {
  const bot = getBot(botId);
  if (!bot) return null;
  await gateway.request("agents.update", { agentId: bot.agentId, model });
  updateBot(botId, { model });
  return getBot(botId);
}

/**
 * The manager is structural — deleting it breaks cold-start and dispatch — so
 * removal is refused here rather than merely hidden in the UI.
 */
export async function removeBot(gateway: GatewayClient, botId: string): Promise<{ ok: boolean; reason?: string }> {
  const bot = getBot(botId);
  if (!bot) return { ok: false, reason: "No such bot." };
  if (bot.kind === "manager") {
    return { ok: false, reason: "Your manager can be renamed, but not deleted — it runs cold-start and dispatch." };
  }
  try {
    await gateway.request("agents.delete", { agentId: bot.agentId });
  } catch (err) {
    log.debug(`agents.delete failed for ${bot.agentId}: ${(err as Error).message}`);
  }
  deleteBot(botId);
  return { ok: true };
}

export function allBots(): Bot[] {
  return listBots();
}

export function manager(): Bot | null {
  return listBots().find((b) => b.kind === "manager") ?? null;
}
