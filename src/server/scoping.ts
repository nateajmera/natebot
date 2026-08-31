import type { GatewayClient } from "./gateway/client.js";
import { log } from "./log.js";

/**
 * What one bot is allowed to reach.
 *
 * The shape of this is a product decision, not a technical one. A bot starts
 * able to do everything and you take things away, because that is the only
 * version where an existing bot keeps working after an upgrade and where a new
 * bot is useful the moment it exists. Scoping is an act of restraint, so the
 * stored form is a deny list and an unscoped bot has no config footprint at all.
 *
 * OpenClaw expresses this as `agents.list[].tools.deny`, which sits underneath
 * the global `tools.profile` (`coding` + `browser`, as NateBot leaves it). Deny
 * wins over every allow, so subtracting is the one operation that behaves the
 * same regardless of what the profile above it happens to include — and it
 * sidesteps the rule that `allow` and `alsoAllow` cannot coexist in one scope.
 */

export type CapabilityId = "files" | "shell" | "web" | "browser" | "memory" | "schedule" | "bots";

export type Capability = {
  id: CapabilityId;
  label: string;
  /** Said in plain words, because this is the sentence someone decides on. */
  blurb: string;
  /** Tool ids or groups denied when this is switched off. */
  denies: string[];
};

/**
 * Deliberately seven rows, not the forty tool ids underneath them. Each maps to
 * a tool group OpenClaw already defines, so nothing here invents a boundary the
 * runtime does not actually enforce.
 */
export const CAPABILITIES: Capability[] = [
  {
    id: "files",
    label: "Files",
    blurb: "Read and change files in its own workspace.",
    denies: ["group:fs"],
  },
  {
    id: "shell",
    label: "Terminal",
    blurb: "Run commands on this computer.",
    denies: ["group:runtime"],
  },
  {
    id: "web",
    label: "The web",
    blurb: "Search the web and read pages.",
    denies: ["group:web"],
  },
  {
    id: "browser",
    label: "Browser",
    blurb: "Drive a real browser — click, fill forms, and take screenshots.",
    denies: ["browser"],
  },
  {
    id: "memory",
    label: "Memory",
    blurb: "Search what it has remembered from earlier.",
    denies: ["group:memory"],
  },
  {
    id: "schedule",
    label: "Schedules",
    blurb: "Set itself to run at a certain time.",
    denies: ["cron"],
  },
  {
    id: "bots",
    label: "Your other bots",
    blurb: "Read and send messages to the rest of your team.",
    denies: ["group:sessions"],
  },
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

/**
 * The manager dispatches every task through `sessions_send`. Taking that away
 * would not scope it down, it would break group work outright — so this one is
 * refused rather than merely hidden in the UI.
 */
export const MANAGER_LOCKED: CapabilityId[] = ["bots"];

/* --------------------------------------------------------------- MCP servers */

/**
 * The tool prefix OpenClaw derives for an MCP server's tools, which is what a
 * `sentry__*` style deny has to match. Lowercased, anything outside
 * `[a-z0-9_-]` becomes `-`, and a name not starting with a letter is prefixed.
 *
 * OpenClaw may additionally truncate or suffix a very long or colliding prefix.
 * NateBot only ever registers its own short preset ids, so that case cannot
 * arise for anything this app created.
 */
export function mcpToolPrefix(serverName: string): string {
  const normalized = serverName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return /^[a-z]/.test(normalized) ? normalized : `mcp-${normalized}`;
}

const mcpGlob = (serverName: string): string => `${mcpToolPrefix(serverName)}__*`;

/* -------------------------------------------------------------- config access */

type Cfg = Record<string, unknown>;

type ConfigSnapshot = { hash: string; config: Cfg };

function readSnapshot(gateway: GatewayClient): Promise<ConfigSnapshot> {
  return gateway.request<ConfigSnapshot>("config.get", {});
}

/** Every MCP server registered with OpenClaw, in config order. */
export function serverNames(config: Cfg): string[] {
  const mcp = (config.mcp ?? {}) as Cfg;
  const servers = (mcp.servers ?? {}) as Cfg;
  return Object.keys(servers);
}

/** The deny list currently stored for one agent, or empty if it has none. */
function denyListFor(config: Cfg, agentId: string): string[] {
  const agents = (config.agents ?? {}) as Cfg;
  const list = Array.isArray(agents.list) ? agents.list : [];
  const entry = list.find(
    (a): a is Cfg => typeof a === "object" && a !== null && (a as Cfg).id === agentId,
  );
  const tools = (entry?.tools ?? {}) as Cfg;
  return Array.isArray(tools.deny) ? tools.deny.filter((d): d is string => typeof d === "string") : [];
}

/* ------------------------------------------------------------------- reading */

export type ScopeRow = { id: string; label: string; blurb: string; enabled: boolean };

export type BotScope = {
  capabilities: (ScopeRow & { locked: boolean })[];
  connections: ScopeRow[];
};

/**
 * A capability counts as off only when everything it denies is already denied.
 * A half-present deny list — someone hand-edited the config — reads as on, so
 * the toggle tells the truth about what the bot can still do.
 */
function isDenied(deny: string[], entries: string[]): boolean {
  const set = new Set(deny.map((d) => d.toLowerCase()));
  return entries.every((e) => set.has(e.toLowerCase()));
}

/** The drawer's view of one deny list. Shared so a read and a write can never
 *  describe the same stored state differently. */
function buildScope(deny: string[], servers: string[], kind: "manager" | "worker"): BotScope {
  return {
    capabilities: CAPABILITIES.map((cap) => ({
      id: cap.id,
      label: cap.label,
      blurb: cap.blurb,
      enabled: !isDenied(deny, cap.denies),
      locked: kind === "manager" && MANAGER_LOCKED.includes(cap.id),
    })),
    connections: servers.map((name) => ({
      id: name,
      label: name,
      blurb: "",
      enabled: !isDenied(deny, [mcpGlob(name)]),
    })),
  };
}

export async function readScope(
  gateway: GatewayClient,
  agentId: string,
  kind: "manager" | "worker",
): Promise<BotScope> {
  const snapshot = await readSnapshot(gateway);
  const config = snapshot.config ?? {};
  return buildScope(denyListFor(config, agentId), serverNames(config), kind);
}

/* ------------------------------------------------------------------- writing */

/**
 * What a single bot should be able to reach.
 *
 * Both maps are `id -> stays on`, and **an id that is absent keeps whatever is
 * already stored**. That matters more than it looks: a keep-list would mean a
 * caller who says nothing about connections is asking for all of them to be
 * revoked, so flipping "Terminal" in a drawer whose connection rows were loaded
 * a moment earlier could quietly cut a bot off from a connector nobody touched.
 * Expressing intent per switch makes each one independent, and makes a stale
 * client harmless.
 */
export type ScopeChoice = {
  agentId: string;
  kind: "manager" | "worker";
  capabilities: Partial<Record<CapabilityId, boolean>>;
  connections?: Record<string, boolean>;
};

/**
 * Turns that intent into the deny list to store, keeping any entry we did not
 * put there. Someone may have denied a specific tool by hand, and a toggle in
 * this app has no business silently dropping it.
 */
function denyFor(choice: ScopeChoice, existing: string[], allServers: string[]): string[] {
  const ours: string[] = [];

  for (const cap of CAPABILITIES) {
    const locked = choice.kind === "manager" && MANAGER_LOCKED.includes(cap.id);
    if (locked) continue;
    const asked = choice.capabilities[cap.id];
    // Absent means "no opinion" — carry the stored answer forward untouched.
    const stays = asked ?? !isDenied(existing, cap.denies);
    if (!stays) ours.push(...cap.denies);
  }

  for (const name of allServers) {
    const glob = mcpGlob(name);
    const asked = choice.connections?.[name];
    const stays = asked ?? !isDenied(existing, [glob]);
    if (!stays) ours.push(glob);
  }

  // Everything this app knows how to write, so we can tell our entries apart
  // from someone else's without guessing.
  const managed = new Set(
    [...CAPABILITIES.flatMap((c) => c.denies), ...allServers.map(mcpGlob)].map((e) =>
      e.toLowerCase(),
    ),
  );
  const foreign = existing.filter((e) => !managed.has(e.toLowerCase()));

  return [...new Set([...foreign, ...ours])];
}

/**
 * Writes scope for one or more bots in a single `config.patch`.
 *
 * Batching is not an optimisation here — control-plane writes are rate-limited
 * to three per minute, so approving a three-bot plan would sit exactly on that
 * limit if each bot were written on its own. `agents.list` merges by `id`, so
 * one patch can carry every agent without resending the others.
 */
export type WriteResult = {
  ok: boolean;
  error?: string;
  /**
   * What each bot can reach now that the write has landed, worked out from the
   * deny list we actually stored. Returned rather than re-read: a patch makes
   * the gateway reload, so reading straight back is the one moment `config.get`
   * is most likely to fail — and reporting failure for a write that succeeded
   * would send someone clicking again into a three-a-minute rate limit.
   */
  scopes?: Record<string, BotScope>;
};

export async function writeScopes(
  gateway: GatewayClient,
  choices: ScopeChoice[],
): Promise<WriteResult> {
  if (choices.length === 0) return { ok: true, scopes: {} };

  // One retry, because the base hash can go stale honestly: NateBot's own
  // browser-tool repair, the OpenClaw Control UI, or a second tab can all write
  // between our read and our patch. Retrying is the correct answer to an
  // optimistic-concurrency miss; the intent maps are absolute, so recomputing
  // against the newer config gives the same result rather than compounding.
  for (let attempt = 0; attempt < 2; attempt++) {
    let snapshot: ConfigSnapshot;
    try {
      snapshot = await readSnapshot(gateway);
    } catch (err) {
      return { ok: false, error: `Couldn't read OpenClaw's config: ${(err as Error).message}` };
    }

    const config = snapshot.config ?? {};
    const allServers = serverNames(config);
    const written: Record<string, string[]> = {};

    for (const choice of choices) {
      written[choice.agentId] = denyFor(
        choice,
        denyListFor(config, choice.agentId),
        allServers,
      );
    }

    const patch = {
      agents: {
        list: choices.map((choice) => ({
          id: choice.agentId,
          tools: { deny: written[choice.agentId] },
        })),
      },
    };

    const settle = (): WriteResult => ({
      ok: true,
      scopes: Object.fromEntries(
        choices.map((c) => [
          c.agentId,
          buildScope(written[c.agentId] ?? [], allServers, c.kind),
        ]),
      ),
    });

    try {
      await gateway.request("config.patch", {
        raw: JSON.stringify(patch),
        baseHash: snapshot.hash,
        // A deny list that shrinks is a destructive array replacement, which the
        // gateway refuses unless the exact path says it was meant. Nested arrays
        // under an array entry use the `[]` form.
        replacePaths: ["agents.list[].tools.deny"],
      });
    } catch (err) {
      const message = (err as Error).message;
      // Changing tool policy makes the gateway reload, which can cut the reply
      // off mid-flight. That is the write succeeding, not failing.
      if (/timed out|closed/i.test(message)) {
        log.debug(`config.patch reply lost to a reload: ${message}`);
        return settle();
      }
      // Somebody else wrote first. Take a fresh hash and go again, once.
      if (attempt === 0 && /hash|stale|conflict|mismatch|CONFIG_CHANGED/i.test(message)) {
        log.debug(`config.patch base hash was stale, retrying: ${message}`);
        continue;
      }
      return { ok: false, error: message };
    }

    log.debug(`scoped ${choices.map((c) => c.agentId).join(", ")}`);
    return settle();
  }

  return { ok: false, error: "OpenClaw's config kept changing underneath us. Try again." };
}

/* ---------------------------------------------------------------- plan tools */

/**
 * The manager proposes `tools: ["bash", "browser"]` in its plan, and the card
 * shows that to the person approving it. This is what makes that list real
 * instead of decorative.
 *
 * Only the four capabilities the manager actually reasons about are considered,
 * and only when it named at least one of them. A plan naming nothing we
 * recognise — `tools: ["gmail"]` — leaves the bot unscoped rather than
 * stripping it down to nothing on the strength of a word we failed to parse.
 */
const PLAN_SCOPEABLE: CapabilityId[] = ["files", "shell", "web", "browser"];

const PLAN_ALIASES: Record<string, CapabilityId> = {
  bash: "shell",
  sh: "shell",
  zsh: "shell",
  shell: "shell",
  exec: "shell",
  terminal: "shell",
  command: "shell",
  process: "shell",
  code_execution: "shell",

  fs: "files",
  file: "files",
  files: "files",
  read: "files",
  write: "files",
  edit: "files",
  apply_patch: "files",
  filesystem: "files",

  web: "web",
  web_search: "web",
  web_fetch: "web",
  search: "web",
  x_search: "web",
  fetch: "web",
  http: "web",

  browser: "browser",
  playwright: "browser",
  chrome: "browser",
  chromium: "browser",
  puppeteer: "browser",
};

/**
 * What a plan's tool list asks for, or `null` when it named nothing we
 * understand — meaning "do not scope this bot at all".
 *
 * Only the four capabilities the manager reasons about appear in the result.
 * The rest are left absent rather than set true, so they keep whatever the bot
 * already had instead of this quietly asserting an opinion about memory or
 * scheduling that no plan ever expressed.
 */
export function capabilitiesFromPlanTools(
  tools: string[],
): Partial<Record<CapabilityId, boolean>> | null {
  const named = new Set<CapabilityId>();
  for (const raw of tools) {
    const key = raw.toLowerCase().trim().replace(/[\s-]+/g, "_");
    const hit = PLAN_ALIASES[key];
    if (hit) named.add(hit);
  }
  if (named.size === 0) return null;

  const out: Partial<Record<CapabilityId, boolean>> = {};
  for (const id of PLAN_SCOPEABLE) out[id] = named.has(id);
  return out;
}

/** Narrows arbitrary input to `capability id -> stays on`, dropping the rest. */
export function parseCapabilityMap(input: unknown): Partial<Record<CapabilityId, boolean>> {
  const out: Partial<Record<CapabilityId, boolean>> = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "boolean" && BY_ID.has(key as CapabilityId)) {
      out[key as CapabilityId] = value;
    }
  }
  return out;
}

/** Narrows arbitrary input to `server name -> stays on`. */
export function parseConnectionMap(input: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "boolean") out[key.slice(0, 120)] = value;
  }
  return out;
}
