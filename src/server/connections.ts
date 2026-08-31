import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayClient } from "./gateway/client.js";
import { log } from "./log.js";

/**
 * Connections are the things a bot can reach beyond its own workspace.
 *
 * Two genuinely different systems sit behind this, despite what the spec
 * assumed. Bundled skills ship with OpenClaw and are already available to every
 * agent — what they usually lack is the command-line tool they drive, so
 * "connect" means installing that once. ClawHub is a public marketplace, which
 * is a different proposition entirely: 341 of its 2,857 skills were found
 * malicious, so nothing from there is offered without its publisher, install
 * count, and suspicion flag shown alongside.
 */

export type SetupStep = {
  label: string;
  /** Shown verbatim so nobody is surprised by what ran on their machine. */
  command: string;
  optional?: boolean;
};

export type McpPreset = {
  id: string;
  label: string;
  blurb: string;
  /** What it lets a bot do, in plain words. */
  gives: string;
  emoji: string;
  official: boolean;
  /** "remote" needs nothing installed; "local" runs on this machine. */
  kind: "remote" | "local";
  transport: { url?: string; command?: string; args?: string[] };
  /** Said plainly on the card when a connector can do consequential things. */
  caution?: string;
  /** Commands that must succeed before the server can run. */
  setup: SetupStep[];
  requiresBins: string[];
  missingBins: string[];
  installed: boolean;
  ready: boolean;
};

/**
 * The servers we put our name to. Kept deliberately short: this list is a claim
 * that something works, and a promoted connection that dead-ends in a cloud
 * console is worse than no card at all.
 */
const PRESETS: Omit<McpPreset, "missingBins" | "installed" | "ready">[] = [
  {
    id: "clawvisor",
    label: "Google",
    blurb:
      "One sign-in covers Gmail, Calendar, Drive and Contacts. It runs on this computer — your tokens are encrypted here and never leave it, and your bots never see them. Each new kind of request asks you first.",
    gives: "Lets your bots read and act on your mail, calendar, files and contacts.",
    emoji: "🔑",
    official: true,
    kind: "local",
    transport: { command: "clawvisor", args: ["mcp"] },
    setup: [
      { label: "Install Clawvisor", command: "curl -fsSL https://clawvisor.com/install.sh | sh" },
      { label: "Set it up", command: "clawvisor setup" },
      { label: "Connect your Google account", command: "clawvisor connect google" },
    ],
    requiresBins: ["clawvisor"],
  },
  {
    id: "gbrain",
    label: "GBrain",
    blurb:
      "A knowledge layer your bots can search, kept in a single file on this machine. Its cold-start import pulls in your mail, calendar and contacts so your bots know your world rather than asking about it.",
    gives: "Lets your bots remember and search everything you've given them.",
    emoji: "🧠",
    official: true,
    kind: "local",
    transport: { command: "gbrain", args: ["serve"] },
    setup: [
      { label: "Install Bun", command: "brew install oven-sh/bun/bun" },
      {
        label: "Build GBrain",
        command:
          "git clone https://github.com/garrytan/gbrain.git ~/.natebot/gbrain && cd ~/.natebot/gbrain && bun install && bun link",
      },
      { label: "Create your brain", command: "gbrain init" },
    ],
    requiresBins: ["gbrain"],
  },
  {
    id: "solum",
    label: "Solum",
    blurb:
      "Your context vault. Sign in with Solum the first time a bot uses it. Everything you've told Claude, ChatGPT or anything else becomes searchable by your bots — so they start knowing your work instead of asking about it.",
    gives: "Lets your bots search everything you've told your other AIs, and remember what they do.",
    emoji: "🗄️",
    official: true,
    kind: "remote",
    transport: { url: "https://usesolum.co/api/mcp" },
    setup: [],
    requiresBins: [],
  },
  {
    id: "sentry",
    label: "Sentry",
    blurb:
      "Sentry's own hosted server. Sign in with Sentry the first time a bot uses it. This is the one that makes a bot useful overnight — it can find out what broke while you were asleep and tell you which change caused it.",
    gives: "Lets your bots read errors, find what caused them, and tell you what broke.",
    emoji: "🚨",
    official: true,
    kind: "remote",
    transport: { url: "https://mcp.sentry.dev/mcp" },
    setup: [],
    requiresBins: [],
  },
  {
    id: "linear",
    label: "Linear",
    blurb:
      "Linear's own hosted server. Sign in with Linear the first time a bot uses it.",
    gives: "Lets your bots read and update issues, projects and cycles.",
    emoji: "📐",
    official: true,
    kind: "remote",
    transport: { url: "https://mcp.linear.app/mcp" },
    setup: [],
    requiresBins: [],
  },
  {
    id: "slack",
    label: "Slack",
    blurb:
      "Slack's own hosted server. Sign in with Slack the first time a bot uses it.",
    gives: "Lets your bots read channels and messages, and post on your behalf.",
    emoji: "💬",
    official: true,
    kind: "remote",
    caution:
      "A bot with Slack can post as you. Be careful giving it to the same bot that reads web pages — anything it reads could try to talk it into sending a message.",
    transport: { url: "https://mcp.slack.com/mcp" },
    setup: [],
    requiresBins: [],
  },
  {
    id: "stripe",
    label: "Stripe",
    blurb:
      "Stripe's own hosted server. Sign in with Stripe the first time a bot uses it. Good for a morning number, failed payments, and disputes that need answering.",
    gives: "Lets your bots read payments, invoices and disputes — and change them.",
    emoji: "💳",
    official: true,
    kind: "remote",
    caution:
      "This one can move money: it can issue refunds and cancel subscriptions, not just read. Stripe recommend approving each action, and keeping it away from bots that read the open web.",
    transport: { url: "https://mcp.stripe.com" },
    setup: [],
    requiresBins: [],
  },
  {
    id: "github",
    label: "GitHub",
    blurb:
      "GitHub's own hosted server. Nothing to install — you sign in with GitHub the first time a bot uses it.",
    gives: "Lets your bots read and act on issues, pull requests and CI.",
    emoji: "🐙",
    official: true,
    kind: "remote",
    transport: { url: "https://api.githubcopilot.com/mcp/" },
    setup: [],
    requiresBins: [],
  },
];

/* ------------------------------------------------------------------ ClawHub */

export type HubSkill = {
  reference: string;
  displayName: string;
  description: string;
  downloads: number;
  publisher: string;
  publisherImage: string | null;
  suspicious: boolean;
  /** True only for first-party skills, not merely popular ones. */
  official: boolean;
  /**
   * Whether anyone has actually examined this skill. ClawHub does no automated
   * scanning by default, so for almost everything this is false — and an
   * absent suspicion flag means "nobody looked", not "found to be safe". The
   * UI must say which of those it is.
   */
  scanned: boolean;
  verdict: string | null;
  categories: string[];
  updatedAt: number | null;
  url: string;
};

export async function searchHub(gateway: GatewayClient, query: string): Promise<HubSkill[]> {
  try {
    const res = await gateway.request<{ results: Record<string, unknown>[] }>("skills.search", { query });
    return (res.results ?? []).slice(0, 30).map((r) => {
      const native = (r.native ?? {}) as Record<string, unknown>;
      const owner = (native.owner ?? {}) as Record<string, unknown>;
      const skill = (native.skill ?? {}) as Record<string, unknown>;
      const install = (r.install ?? {}) as Record<string, unknown>;
      const trust = (r.trust ?? {}) as Record<string, unknown>;
      const verdict = typeof trust.clawHubVerdict === "string" ? trust.clawHubVerdict : null;
      const scanners = trust.upstreamScanners;
      return {
        reference: typeof install.reference === "string" ? install.reference : "",
        displayName: typeof r.displayName === "string" ? r.displayName : "",
        description:
          typeof skill.summary === "string"
            ? skill.summary
            : typeof r.summary === "string"
              ? r.summary
              : "",
        downloads: typeof r.downloads === "number" ? r.downloads : 0,
        publisher: typeof owner.handle === "string" ? owner.handle : "unknown",
        publisherImage: typeof owner.image === "string" ? owner.image : null,
        suspicious: skill.isSuspicious === true,
        official: r.official === true,
        scanned: verdict !== null || (scanners !== null && scanners !== undefined),
        verdict,
        categories: Array.isArray(skill.categories) ? (skill.categories as string[]) : [],
        updatedAt:
          typeof (r.metrics as Record<string, unknown>)?.updatedAt === "number"
            ? ((r.metrics as Record<string, unknown>).updatedAt as number)
            : null,
        url: typeof r.canonicalUrl === "string" ? `https://clawhub.ai${r.canonicalUrl}` : "",
      };
    }).filter((s) => s.reference);
  } catch (err) {
    log.debug(`skills.search failed: ${(err as Error).message}`);
    return [];
  }
}

export async function installHubSkill(
  gateway: GatewayClient,
  reference: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await gateway.request("skills.install", { name: reference, source: "clawhub" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* ------------------------------------------------------- MCP server presets */

/** Is this command-line tool on the machine? */
function hasBin(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  });
}

function runCommand(cmd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (err) => resolve({ ok: false, output: String(err) }));
    child.on("close", (code) => resolve({ ok: code === 0, output: out.trim().slice(-4000) }));
  });
}

/** Servers already registered with OpenClaw, read straight from its config. */
async function configuredServers(gateway: GatewayClient): Promise<Set<string>> {
  try {
    const snapshot = await gateway.request<{ config: Record<string, unknown> }>("config.get", {});
    const mcp = (snapshot.config?.mcp ?? {}) as Record<string, unknown>;
    const servers = (mcp.servers ?? {}) as Record<string, unknown>;
    return new Set(Object.keys(servers));
  } catch (err) {
    log.debug(`could not read mcp.servers: ${(err as Error).message}`);
    return new Set();
  }
}

export async function listMcpPresets(gateway: GatewayClient): Promise<McpPreset[]> {
  const configured = await configuredServers(gateway);
  const out: McpPreset[] = [];
  for (const preset of PRESETS) {
    const missing: string[] = [];
    for (const bin of preset.requiresBins) {
      if (!(await hasBin(bin))) missing.push(bin);
    }
    const installed = configured.has(preset.id);
    out.push({
      ...preset,
      missingBins: missing,
      installed,
      // A remote server needs nothing local; a local one needs its binary.
      ready: installed && missing.length === 0,
    });
  }
  return out;
}

/** Registers a preset with OpenClaw. Local presets must already have their binary. */
export async function connectPreset(
  gateway: GatewayClient,
  id: string,
): Promise<{ ok: boolean; output: string }> {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return { ok: false, output: "No such connection." };

  const args = ["mcp", "add", preset.id];
  if (preset.transport.url) {
    args.push("--url", preset.transport.url, "--auth", "oauth");
    // The OAuth dance happens on first use, so don't block registration on it.
    args.push("--no-probe");
  } else if (preset.transport.command) {
    args.push("--command", preset.transport.command);
    for (const a of preset.transport.args ?? []) args.push("--arg", a);
  } else {
    return { ok: false, output: "That connection has no transport configured." };
  }

  const result = await runCommand("openclaw", args);
  if (result.ok) {
    // New servers only reach agents after the runtime cache is dropped.
    await runCommand("openclaw", ["mcp", "reload"]);
  }
  return result;
}

export async function removeServer(name: string): Promise<{ ok: boolean; output: string }> {
  const result = await runCommand("openclaw", ["mcp", "unset", name]);
  if (result.ok) await runCommand("openclaw", ["mcp", "reload"]);
  return result;
}

/** The escape hatch: any MCP server the user knows about, by URL or command. */
export async function addCustomServer(input: {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
}): Promise<{ ok: boolean; output: string }> {
  const name = input.name.replace(/[^\w-]/g, "").slice(0, 60);
  if (!name) return { ok: false, output: "Give the connection a name." };

  const args = ["mcp", "add", name];
  if (input.url) {
    if (!/^https?:\/\//i.test(input.url)) return { ok: false, output: "That isn't a web address." };
    args.push("--url", input.url, "--no-probe");
  } else if (input.command) {
    args.push("--command", input.command);
    for (const a of input.args ?? []) args.push("--arg", a);
  } else {
    return { ok: false, output: "Give either a URL or a command." };
  }

  const result = await runCommand("openclaw", args);
  if (result.ok) await runCommand("openclaw", ["mcp", "reload"]);
  return result;
}

/**
 * Runs one setup step for a local preset. Each is surfaced and run separately
 * rather than as one opaque script, so the user sees exactly what happened and
 * where it stopped.
 */
export async function runSetupStep(
  id: string,
  index: number,
): Promise<{ ok: boolean; output: string; label: string }> {
  const preset = PRESETS.find((p) => p.id === id);
  const step = preset?.setup[index];
  if (!preset || !step) return { ok: false, output: "No such setup step.", label: "" };
  const result = await runCommand("/bin/sh", ["-lc", step.command]);
  return { ...result, label: step.label };
}

/* --------------------------------------------------------------- skills */

export type Skill = {
  name: string;
  label: string;
  description: string;
  emoji: string;
  /** Command-line tools the skill drives; without them it can't do anything. */
  requiresBins: string[];
  missingBins: string[];
  ready: boolean;
  install: { command: string; label: string } | null;
  bundled: boolean;
};

type SkillRow = {
  name: string;
  description?: string;
  bundled?: boolean;
  baseDir?: string;
  emoji?: string;
};

/** The ones worth putting in front of someone before they search. */
const FEATURED = [
  "summarize",
  "apple-notes",
  "apple-reminders",
  "weather",
  "things-mac",
  "gog",
  "github",
  "obsidian",
  "notion",
  "trello",
  "spotify-player",
  "1password",
];

const SKILL_LABELS: Record<string, string> = {
  gog: "Google Workspace CLI",
  github: "GitHub CLI",
  "apple-notes": "Apple Notes",
  "apple-reminders": "Apple Reminders",
  "things-mac": "Things",
  "spotify-player": "Spotify",
  "1password": "1Password",
};

/** Reads `requires.bins` and the brew recipe out of a skill's frontmatter. */
async function readSkillMeta(
  baseDir: string,
): Promise<{ bins: string[]; install: { command: string; label: string } | null; emoji: string }> {
  try {
    const raw = await readFile(path.join(baseDir, "SKILL.md"), "utf8");
    const bins = [
      ...new Set(
        (/"bins"\s*:\s*\[([^\]]*)\]/.exec(raw)?.[1] ?? "")
          .split(",")
          .map((b) => b.replace(/["'\s]/g, ""))
          .filter(Boolean),
      ),
    ];
    const emoji = /"emoji"\s*:\s*"([^"]+)"/.exec(raw)?.[1] ?? "";
    const formula = /"kind"\s*:\s*"brew"[^}]*?"formula"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
    const label = /"kind"\s*:\s*"brew"[^}]*?"label"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
    return {
      bins,
      emoji,
      install: formula ? { command: `brew install ${formula}`, label: label ?? `Install ${formula}` } : null,
    };
  } catch {
    return { bins: [], install: null, emoji: "" };
  }
}

export async function listSkills(gateway: GatewayClient, all = false): Promise<Skill[]> {
  let rows: SkillRow[] = [];
  try {
    const res = await gateway.request<{ skills: SkillRow[] }>("skills.status", {});
    rows = res.skills ?? [];
  } catch (err) {
    log.debug(`skills.status failed: ${(err as Error).message}`);
    return [];
  }

  const byName = new Map(rows.map((r) => [r.name, r]));
  const wanted = all ? rows.map((r) => r.name) : FEATURED;
  const out: Skill[] = [];

  for (const name of wanted) {
    const row = byName.get(name);
    if (!row?.baseDir) continue;
    const meta = await readSkillMeta(row.baseDir);
    const missing: string[] = [];
    for (const bin of meta.bins) {
      if (!(await hasBin(bin))) missing.push(bin);
    }
    out.push({
      name,
      label:
        SKILL_LABELS[name] ??
        name.replace(/(^|-)(\w)/g, (_, d: string, c: string) => (d ? " " : "") + c.toUpperCase()),
      description: row.description ?? "",
      emoji: meta.emoji || row.emoji || "",
      requiresBins: meta.bins,
      missingBins: missing,
      // No required tools at all means it works the moment a bot needs it.
      ready: missing.length === 0,
      install: meta.install,
      bundled: row.bundled === true,
    });
  }
  return out;
}

/** Installs the command-line tool a skill drives. */
export async function installSkillTool(
  gateway: GatewayClient,
  name: string,
): Promise<{ ok: boolean; output: string }> {
  const skills = await listSkills(gateway, true);
  const skill = skills.find((s) => s.name === name);
  if (!skill) return { ok: false, output: "No such skill." };
  if (!skill.install) {
    return {
      ok: false,
      output: `${skill.label} needs ${skill.missingBins.join(", ")}, which has no automatic installer. Install it yourself and this will turn green.`,
    };
  }
  return runCommand("/bin/sh", ["-lc", skill.install.command]);
}
