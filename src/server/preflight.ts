import { spawn, type SpawnOptions } from "node:child_process";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { log } from "./log.js";

/**
 * Preflight is the screen that justifies the product existing: NateBot does the
 * OpenClaw setup itself instead of asking anyone to paste a token. Every step
 * reports progress so the UI can show one live log line and then "Connected."
 */

export type PreflightPhase =
  | "checking"
  | "installing"
  | "reading-config"
  | "starting-gateway"
  | "connecting"
  | "done"
  | "failed";

export type PreflightUpdate = {
  phase: PreflightPhase;
  line: string;
  /** Set only on the terminal `failed` phase. */
  detail?: string;
};

export type GatewayConnection = {
  url: string;
  port: number;
  token: string;
  authMode: "token" | "none" | "password";
  configPath: string;
  openclawVersion: string;
};

export type PreflightResult =
  | { ok: true; connection: GatewayConnection }
  | { ok: false; phase: PreflightPhase; line: string; detail: string };

const CONFIG_PATH = path.join(homedir(), ".openclaw", "openclaw.json");
const DEFAULT_PORT = 18789;

type RunResult = { code: number; stdout: string; stderr: string };

function run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * OpenClaw writes its config as JSON5 (comments, trailing commas are legal).
 * We only need a handful of fields, so tolerate the common JSON5 relaxations
 * rather than pulling in a parser dependency.
 */
function parseLooseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped) as Record<string, unknown>;
  }
}

function pick(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * "open" means something is listening. "closed" means the connection was
 * actively refused. "unavailable" means we could not even attempt it, because
 * this machine had no local port to spend — which is emphatically *not* the
 * same as the gateway being down, and must never be treated as such or we
 * start a second gateway on top of a perfectly healthy one.
 */
type PortProbe = "open" | "closed" | "unavailable";

/** Local resource exhaustion, rather than anything about the remote end. */
const LOCAL_EXHAUSTION = new Set(["EADDRNOTAVAIL", "EMFILE", "ENFILE", "EADDRINUSE"]);

function probeHost(host: string, port: number, timeoutMs = 1500): Promise<PortProbe> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (result: PortProbe) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () => finish("closed"));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      finish(LOCAL_EXHAUSTION.has(err.code ?? "") ? "unavailable" : "closed");
    });
  });
}

/** Loopback hosts in preference order. The gateway binds both families. */
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

/**
 * Probes every loopback address family. The two have independent ephemeral
 * port pools, so IPv4 running dry says nothing about whether IPv6 can connect
 * — and a local client has no reason to care which one it gets.
 */
async function probePort(
  port: number,
  timeoutMs = 1500,
): Promise<{ result: PortProbe; host: string }> {
  let sawUnavailable = false;
  for (const host of LOOPBACK_HOSTS) {
    const result = await probeHost(host, port, timeoutMs);
    if (result === "open") return { result, host };
    if (result === "unavailable") sawUnavailable = true;
  }
  return { result: sawUnavailable ? "unavailable" : "closed", host: LOOPBACK_HOSTS[0] };
}

/**
 * Local port exhaustion is usually transient — the kernel frees sockets as
 * TIME_WAIT expires — so a single failed attempt is not evidence of anything.
 * Retry before concluding the machine is genuinely out of ports.
 */
async function probePortWithRetry(
  port: number,
  attempts = 12,
): Promise<{ result: PortProbe; host: string }> {
  let last = { result: "unavailable" as PortProbe, host: LOOPBACK_HOSTS[0] as string };
  for (let i = 0; i < attempts; i++) {
    last = await probePort(port);
    if (last.result !== "unavailable") return last;
    await new Promise((r) => setTimeout(r, 700));
  }
  return last;
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probePort(port)).result === "open") return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export async function runPreflight(
  onUpdate: (update: PreflightUpdate) => void,
): Promise<PreflightResult> {
  const emit = (phase: PreflightPhase, line: string, detail?: string) => {
    log.debug(`preflight ${phase}: ${line}`);
    onUpdate(detail === undefined ? { phase, line } : { phase, line, detail });
  };

  // 1. Is OpenClaw here at all?
  emit("checking", "Looking for OpenClaw…");
  let version = await readOpenclawVersion();

  if (!version) {
    emit("installing", "Installing OpenClaw…");
    const install = await run("npm", ["install", "-g", "openclaw"]);
    if (install.code !== 0) {
      return {
        ok: false,
        phase: "installing",
        line: "Couldn't install OpenClaw.",
        detail: (install.stderr || install.stdout).trim().slice(-1500),
      };
    }
    version = await readOpenclawVersion();
    if (!version) {
      return {
        ok: false,
        phase: "installing",
        line: "OpenClaw installed but isn't on your PATH.",
        detail: "Try opening a new terminal, or run `npm install -g openclaw` yourself.",
      };
    }
  }
  emit("checking", `OpenClaw ${version}`);

  // 2. Pull the gateway token straight out of config. The user never sees it.
  emit("reading-config", "Reading your gateway config…");
  let config: Record<string, unknown>;
  try {
    config = parseLooseJson(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    // No config yet: OpenClaw writes one on first onboard. Run it non-interactively.
    const onboard = await run("openclaw", ["onboard", "--non-interactive"]);
    try {
      config = parseLooseJson(await readFile(CONFIG_PATH, "utf8"));
    } catch {
      return {
        ok: false,
        phase: "reading-config",
        line: "Couldn't read your OpenClaw config.",
        detail:
          `Expected a config at ${CONFIG_PATH}. ` +
          (onboard.stderr || onboard.stdout || "Run `openclaw onboard` once, then reopen NateBot.")
            .trim()
            .slice(-1200),
      };
    }
  }

  const port = Number(pick(config, "gateway", "port") ?? DEFAULT_PORT) || DEFAULT_PORT;
  const authMode = (pick(config, "gateway", "auth", "mode") as string | undefined) ?? "token";
  const token = (pick(config, "gateway", "auth", "token") as string | undefined) ?? "";

  if (authMode === "token" && !token) {
    return {
      ok: false,
      phase: "reading-config",
      line: "Your gateway has token auth on but no token set.",
      detail: `Run \`openclaw configure\` to set a gateway token, then reopen NateBot.`,
    };
  }
  if (authMode === "password") {
    return {
      ok: false,
      phase: "reading-config",
      line: "Password auth isn't supported yet.",
      detail:
        "NateBot connects with a gateway token. Switch to token auth with `openclaw configure`, then reopen NateBot.",
    };
  }

  // 3. Start the gateway if it isn't already listening.
  const probe = await probePortWithRetry(port);
  let host = probe.host;

  if (probe.result === "unavailable") {
    return {
      ok: false,
      phase: "starting-gateway",
      line: "Your Mac has run out of free network ports.",
      detail:
        `NateBot couldn't open a connection to check on the gateway — not because the gateway ` +
        `is down, but because this machine has no local ports left to use. Something is opening ` +
        `a very large number of connections. Restarting usually clears it; if it comes back, ` +
        `find the process responsible before running NateBot again.`,
    };
  }

  if (probe.result === "closed") {
    emit("starting-gateway", "Starting the gateway…");
    const started = await startGateway(port);
    if (!started) {
      return {
        ok: false,
        phase: "starting-gateway",
        line: "Couldn't start the OpenClaw gateway.",
        detail: `Nothing came up on port ${port}. Try \`openclaw gateway run\` in a terminal to see why.`,
      };
    }
    host = (await probePort(port)).host;
  }

  emit("connecting", "Connecting…");
  return {
    ok: true,
    connection: {
      url: `ws://${host.includes(":") ? `[${host}]` : host}:${port}`,
      port,
      token,
      authMode: authMode === "none" ? "none" : "token",
      configPath: CONFIG_PATH,
      openclawVersion: version,
    },
  };
}

async function readOpenclawVersion(): Promise<string | null> {
  const res = await run("openclaw", ["--version"]);
  if (res.code !== 0) return null;
  const line = (res.stdout || res.stderr).trim().split("\n")[0]?.trim() ?? "";
  // `openclaw --version` prints "OpenClaw 2026.7.1-2 (0790d9f)" — keep just the
  // version so callers can render "OpenClaw <version>" without stuttering.
  const match = /(\d[\w.-]*)/.exec(line);
  return match?.[1] ?? (line.length > 0 ? line : null);
}

/**
 * Prefer the managed service (survives NateBot quitting). If no service is
 * installed we fall back to a detached `gateway run` so the user still gets a
 * working app without us installing anything into launchd/systemd behind
 * their back.
 */
async function startGateway(port: number): Promise<boolean> {
  const viaService = await run("openclaw", ["gateway", "start"]);
  if (viaService.code === 0 && (await waitForPort(port, 20_000))) return true;

  log.debug("gateway service start unavailable, falling back to detached run");
  const child = spawn("openclaw", ["gateway", "run"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return waitForPort(port, 30_000);
}
