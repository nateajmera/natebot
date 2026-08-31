import { openDb, getState } from "./db.js";
import { Bus } from "./http/bus.js";
import { startHttpServer } from "./http/server.js";
import { GatewayClient } from "./gateway/client.js";
import { Hub } from "./hub.js";
import { runPreflight, type GatewayConnection } from "./preflight.js";
import { ensureBrowserEnabled } from "./browser-setup.js";
import type { ApiContext } from "./api.js";
import { log } from "./log.js";

const DEFAULT_PORT = Number(process.env.NATEBOT_PORT ?? 4319);

export type RunningServer = {
  url: string;
  port: number;
  /** Resolves once preflight + gateway connection have settled. */
  ready: Promise<void>;
  shutdown: () => void;
};

/**
 * Boots the local server and returns as soon as it is serving, so a shell can
 * put a window on screen immediately and let preflight stream into it.
 */
export async function startServer(
  version: string,
  opts: { onApproval?: (info: { title: string; body: string }) => void } = {},
): Promise<RunningServer> {
  openDb();

  const bus = new Bus();
  const ctx: ApiContext = {
    gateway: null,
    hub: null,
    broadcast: bus.broadcast,
    connection: null,
    preflight: { phase: "checking", line: "Starting up…" },
    version,
  };

  const { port, close } = await startHttpServer({ bus, ctx, port: DEFAULT_PORT });
  const url = `http://localhost:${port}`;

  let gateway: GatewayClient | null = null;

  const ready = (async () => {
    const result = await runPreflight((update) => {
      ctx.preflight = update;
      bus.broadcast({ t: "preflight", ...update });
    });

    if (!result.ok) {
      ctx.preflight = { phase: "failed", line: result.line, detail: result.detail };
      bus.broadcast({ t: "preflight", phase: "failed", line: result.line, detail: result.detail });
      log.error(result.line);
      log.info(result.detail);
      return;
    }

    ctx.connection = result.connection;
    gateway = new GatewayClient({
      url: result.connection.url,
      token: result.connection.token,
      version,
    });
    ctx.gateway = gateway;

    const hub = new Hub(gateway, bus.broadcast, opts.onApproval ?? null);
    ctx.hub = hub;
    hub.start();

    try {
      const hello = await gateway.connect();

      // Browsing bots — and the filmstrip that makes their work reviewable —
      // need a tool that ships disabled. Fix that once, silently.
      const browser = await ensureBrowserEnabled(gateway);
      if (browser.changed) log.info("Turned on OpenClaw's browser tool for your bots.");

      ctx.preflight = { phase: "done", line: "Connected." };
      bus.broadcast({ t: "preflight", phase: "done", line: "Connected." });
      log.info(`Connected to OpenClaw ${hello.server.version}.`);
    } catch (err) {
      const message = (err as Error).message;
      ctx.preflight = { phase: "failed", line: "Couldn't connect to the gateway.", detail: message };
      bus.broadcast({
        t: "preflight",
        phase: "failed",
        line: "Couldn't connect to the gateway.",
        detail: message,
      });
      log.error(`gateway connect failed: ${message}`);
    }
  })();

  return {
    url,
    port,
    ready,
    shutdown: () => {
      gateway?.close();
      bus.close();
      close();
    },
  };
}

/**
 * Server-only mode. The desktop shell lives in the Electron main process, so
 * this deliberately opens nothing — it serves, prints where it is, and stays
 * up until it is stopped.
 */
export async function main(version: string): Promise<void> {
  const server = await startServer(version);

  process.stdout.write(`\n  NateBot is running.\n  ${server.url}\n\n`);

  await server.ready;
  if (getState("onboarded") !== "1") log.info("Open that address to finish setup.");

  const shutdown = () => {
    server.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The HTTP server holds the event loop open; nothing further to do here.
}
