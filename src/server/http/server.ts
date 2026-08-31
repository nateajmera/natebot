import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi, type ApiContext } from "../api.js";
import type { Bus } from "./bus.js";
import { log } from "../log.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dist/server/http -> dist/web */
const WEB_ROOT = path.resolve(HERE, "..", "..", "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(WEB_ROOT, rel);

  // Never serve outside the bundled web root, whatever the request looks like.
  if (!resolved.startsWith(WEB_ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  let target = resolved;
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = path.join(target, "index.html");
  } catch {
    // Single-page app: unknown paths fall through to the shell.
    target = path.join(WEB_ROOT, "index.html");
  }

  try {
    await stat(target);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end(
      "NateBot's web assets are missing. Run `npm run build` in the natebot folder.",
    );
    return;
  }

  const type = MIME[path.extname(target)] ?? "application/octet-stream";
  const immutable = target.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "content-type": type,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(target).pipe(res);
}

/** Both loopback families. They have independent ephemeral port pools, so a
 *  machine that has exhausted one can still reach us on the other — and either
 *  way this never leaves the local machine. */
const BIND_HOSTS = ["127.0.0.1", "::1"] as const;

export function startHttpServer(opts: { bus: Bus; ctx: ApiContext; port: number }) {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname.startsWith("/api/")) {
      void handleApi(req, res, url, opts.ctx).catch((err: Error) => {
        log.debug(`unhandled api error: ${err.message}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
      return;
    }
    void serveStatic(res, url.pathname);
  };

  const makeServer = () => {
    const server = createServer(handler);
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/events") {
        opts.bus.handleUpgrade(req, socket, head as Buffer);
        return;
      }
      socket.destroy();
    });
    return server;
  };

  /** Resolves once this server is listening, or rejects with the bind error. */
  const listenOn = (server: ReturnType<typeof makeServer>, host: string, port: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });

  return new Promise<{ port: number; close: () => void }>((resolve, reject) => {
    const attempt = async (port: number, attemptsLeft: number): Promise<void> => {
      const servers = BIND_HOSTS.map(makeServer);
      try {
        // Every family must take the same port, or the URL we hand out would
        // only work for some of them.
        await Promise.all(servers.map((s, i) => listenOn(s, BIND_HOSTS[i]!, port)));
        resolve({
          port,
          close: () => {
            for (const s of servers) s.close();
          },
        });
      } catch (err) {
        for (const s of servers) s.close();
        const code = (err as NodeJS.ErrnoException).code;
        // A host family that simply is not configured on this machine is fine
        // to lose, as long as at least one bound.
        if (code === "EADDRINUSE" && attemptsLeft > 0) {
          await attempt(port + 1, attemptsLeft - 1);
          return;
        }
        reject(err as Error);
      }
    };
    void attempt(opts.port, 20).catch(reject);
  });
}
