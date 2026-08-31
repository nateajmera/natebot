import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { GatewayClient } from "./gateway/client.js";
import type { ModelRecord } from "./gateway/types.js";
import { log } from "./log.js";

/**
 * Onboarding asks for one provider, not four. To make that a real choice
 * rather than a quiz, we detect what is already on this machine and default to
 * it — and we say up front which options can only ever show token counts.
 */

export type ProviderId = "anthropic" | "openai" | "xai" | "google";

export type ProviderCard = {
  id: ProviderId;
  label: string;
  /** Plain language, no jargon — this is the whole text on the card. */
  requirement: string;
  cost: string;
  /**
   * Subscription/OAuth auth reports tokens only; the provider never returns a
   * price. Saying so on the card stops it reading as a bug later.
   */
  tokensOnly: boolean;
  detected: boolean;
  detail: string;
  /** Exact command the user runs if they pick a provider with no credentials. */
  setupCommand: string;
  modelId: string | null;
};

async function onPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(process.platform === "win32" ? "where" : "which", [bin], {
      stdio: "ignore",
    });
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function detectProviders(gateway: GatewayClient): Promise<ProviderCard[]> {
  let models: ModelRecord[] = [];
  try {
    const res = await gateway.request<{ models: ModelRecord[] }>("models.list", {});
    models = res.models ?? [];
  } catch (err) {
    log.debug(`models.list failed: ${(err as Error).message}`);
  }

  const modelFor = (prefixes: string[]): string | null => {
    const hit = models.find((m) => prefixes.some((p) => m.provider === p));
    return hit ? `${hit.provider}/${hit.id}` : null;
  };

  const [hasClaude, hasCodex, claudeCreds] = await Promise.all([
    onPath("claude"),
    onPath("codex"),
    fileExists(path.join(homedir(), ".claude")),
  ]);

  const env = process.env;

  const cards: ProviderCard[] = [
    {
      id: "anthropic",
      label: "Claude",
      requirement: hasClaude
        ? "Uses the Claude Code credentials already on this Mac."
        : "Needs a Claude subscription or an Anthropic API key.",
      cost: hasClaude ? "Included in your Claude plan." : "Pay per use, or included in a Claude plan.",
      tokensOnly: hasClaude,
      detected: hasClaude || claudeCreds || Boolean(env.ANTHROPIC_API_KEY),
      detail: hasClaude ? "Claude Code found" : claudeCreds ? "Claude credentials found" : "",
      setupCommand: "openclaw models auth login --provider anthropic",
      modelId: modelFor(["claude-cli", "anthropic"]),
    },
    {
      id: "openai",
      label: "OpenAI",
      requirement: hasCodex
        ? "Signs in with your ChatGPT plan through Codex."
        : "Needs a ChatGPT plan or an OpenAI API key.",
      cost: hasCodex ? "Included in your ChatGPT plan." : "Pay per use, or included in a ChatGPT plan.",
      tokensOnly: hasCodex,
      detected: hasCodex || Boolean(env.OPENAI_API_KEY),
      detail: hasCodex ? "Codex found" : env.OPENAI_API_KEY ? "API key found" : "",
      setupCommand: "openclaw models auth login --provider openai",
      modelId: modelFor(["codex", "openai"]),
    },
    {
      id: "xai",
      label: "xAI",
      requirement: "Needs a SuperGrok subscription or an xAI API key.",
      cost: "Included in SuperGrok, or pay per use with a key.",
      // Only the subscription path is tokens-only; with a key you get costs.
      tokensOnly: false,
      detected: Boolean(env.XAI_API_KEY),
      detail: env.XAI_API_KEY ? "API key found" : "",
      setupCommand: "openclaw models auth login --provider xai",
      modelId: modelFor(["xai", "grok"]),
    },
    {
      id: "google",
      label: "Google",
      // Google's terms don't allow driving a consumer subscription this way,
      // so this one is API key only and the card should not imply otherwise.
      requirement: "Needs a Google AI Studio or Vertex AI API key.",
      cost: "Pay per use.",
      tokensOnly: false,
      detected: Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
      detail: env.GEMINI_API_KEY || env.GOOGLE_API_KEY ? "API key found" : "",
      setupCommand: "openclaw models auth login --provider google",
      modelId: modelFor(["google", "gemini"]),
    },
  ];

  return cards;
}

/**
 * Rough cost tiers by model family. The manager speaks at both ends of every
 * task — decompose, then checkpoint — so putting it on the same model as the
 * workers it dispatches roughly doubles the cost of coordination for no
 * visible benefit.
 */
const TIERS: { pattern: RegExp; tier: number }[] = [
  { pattern: /haiku|mini|flash|lite|small/i, tier: 1 },
  { pattern: /sonnet|gpt-5\b|grok-[0-9]+-fast/i, tier: 2 },
  { pattern: /opus|ultra|pro\b/i, tier: 3 },
];

function tierOf(modelId: string): number {
  for (const { pattern, tier } of TIERS) {
    if (pattern.test(modelId)) return tier;
  }
  return 2;
}

/**
 * Picks the manager's default model: the cheapest tier that is still a
 * general-purpose reasoning model, preferring the same provider as the workers
 * so the user is not silently pulled onto a second account. Returns null when
 * nothing cheaper exists, in which case the manager simply inherits the
 * default — correct, just not thrifty.
 */
export async function pickManagerModel(
  gateway: GatewayClient,
  workerModel: string | null,
): Promise<string | null> {
  let models: ModelRecord[] = [];
  try {
    const res = await gateway.request<{ models: ModelRecord[] }>("models.list", {});
    models = res.models ?? [];
  } catch (err) {
    log.debug(`models.list failed while choosing a manager model: ${(err as Error).message}`);
    return null;
  }
  if (models.length === 0) return null;

  const workerProvider = workerModel?.includes("/") ? workerModel.split("/")[0] : null;
  const workerTier = workerModel ? tierOf(workerModel) : 3;

  const candidates = models
    .map((m) => ({ id: `${m.provider}/${m.id}`, provider: m.provider, tier: tierOf(m.id) }))
    .filter((m) => m.tier < workerTier)
    .sort((a, b) => {
      // Prefer the worker's own provider, then the cheapest tier that is not
      // so small it cannot plan (tier 2 before tier 1).
      const sameA = a.provider === workerProvider ? 0 : 1;
      const sameB = b.provider === workerProvider ? 0 : 1;
      if (sameA !== sameB) return sameA - sameB;
      return b.tier - a.tier;
    });

  return candidates[0]?.id ?? null;
}

/**
 * Points the default agent model at the chosen provider by patching config.
 * `config.patch` needs the hash from a fresh `config.get`, and merges object
 * arrays by id — so this touches nothing else in the user's config.
 */
export async function applyProviderChoice(gateway: GatewayClient, modelId: string): Promise<void> {
  const snapshot = await gateway.request<{ hash: string }>("config.get", {});
  await gateway.request("config.patch", {
    raw: JSON.stringify({ agents: { defaults: { model: { primary: modelId } } } }),
    baseHash: snapshot.hash,
  });
}
