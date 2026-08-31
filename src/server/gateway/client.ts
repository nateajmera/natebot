import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { EventFrame, Frame, GatewayError, HelloOk, ResFrame } from "./types.js";
import { log } from "../log.js";

/**
 * `client.id` is a closed enum on the gateway side (GATEWAY_CLIENT_IDS).
 * `webchat-ui` is rejected from a non-browser process by the Control UI origin
 * check, so a local Node process identifies as `cli` — which is what NateBot
 * actually is: a local operator client driving the gateway on the user's behalf.
 */
const CLIENT_ID = "cli";
const CLIENT_MODE = "cli";

/** Methods that mutate state require an idempotency key or the gateway rejects them. */
const IDEMPOTENT_METHODS = new Set([
  "chat.send",
  "sessions.send",
  "sessions.steer",
  "sessions.create",
  "agent",
  "send",
  "wake",
]);

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;

export class GatewayRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(method: string, error: GatewayError) {
    super(`${method}: ${error.message}`);
    this.name = "GatewayRequestError";
    this.code = error.code;
    this.retryable = error.retryable ?? false;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
};

export type GatewayClientOptions = {
  url: string;
  token: string;
  version: string;
};

/**
 * A single long-lived operator connection to the OpenClaw gateway.
 *
 * NateBot's server owns exactly one of these. Browser clients never see the
 * gateway token — they talk to our own bus and we fan events out to them.
 */
export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private helloOk: HelloOk | null = null;
  private connecting: Promise<HelloOk> | null = null;

  constructor(private readonly opts: GatewayClientOptions) {
    super();
    this.setMaxListeners(0);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.helloOk !== null;
  }

  get hello(): HelloOk | null {
    return this.helloOk;
  }

  /** Connects and resolves once the handshake completes. Safe to call repeatedly. */
  async connect(): Promise<HelloOk> {
    if (this.helloOk && this.connected) return this.helloOk;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<HelloOk>((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        reject(err);
      };

      ws.on("message", (raw: WebSocket.RawData) => {
        let frame: Frame;
        try {
          frame = JSON.parse(raw.toString()) as Frame;
        } catch {
          return;
        }

        if (frame.type === "res") {
          this.handleResponse(frame);
          return;
        }
        if (frame.type !== "event") return;

        if (frame.event === "connect.challenge") {
          this.performHandshake()
            .then((hello) => {
              this.helloOk = hello;
              this.reconnectDelay = RECONNECT_MIN_MS;
              settled = true;
              this.connecting = null;
              this.emit("ready", hello);
              resolve(hello);
            })
            .catch((err: Error) => {
              log.error(`gateway handshake failed: ${err.message}`);
              fail(err);
              ws.close();
            });
          return;
        }

        this.handleEvent(frame);
      });

      ws.on("error", (err: NodeJS.ErrnoException) => {
        log.debug(`gateway socket error: ${err.message}`);
        // Running out of local ports is a condition of this machine, not of the
        // gateway; back off and try again rather than reporting it as down.
        if (err.code === "EADDRNOTAVAIL" || err.code === "EMFILE") {
          this.reconnectDelay = Math.max(this.reconnectDelay, 1500);
        }
        fail(err);
      });

      ws.on("close", () => {
        this.helloOk = null;
        this.rejectAllPending(new Error("gateway connection closed"));
        this.emit("disconnected");
        fail(new Error("gateway connection closed before handshake"));
        this.scheduleReconnect();
      });
    });

    return this.connecting;
  }

  private async performHandshake(): Promise<HelloOk> {
    const payload = await this.request<HelloOk>("connect", {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: CLIENT_ID,
        version: this.opts.version,
        platform: process.platform === "darwin" ? "macos" : process.platform,
        mode: CLIENT_MODE,
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin", "operator.approvals"],
      // tool-events opts us into the per-tool-call frames the step row is built from.
      caps: ["tool-events"],
      commands: [],
      permissions: {},
      auth: { token: this.opts.token },
      locale: "en-US",
      userAgent: `natebot/${this.opts.version}`,
    });
    return payload;
  }

  private handleResponse(frame: ResFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      const err = frame.error ?? { code: "UNKNOWN", message: "unknown gateway error" };
      pending.reject(new GatewayRequestError(pending.method, err));
    }
  }

  private handleEvent(frame: EventFrame): void {
    this.emit("event", frame);
    this.emit(`event:${frame.event}`, frame.payload, frame);
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connecting = null;
      void this.connect().catch(() => {
        /* the close handler schedules the next attempt */
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Issues an RPC. Side-effecting methods get an idempotency key automatically. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`gateway not connected (${method})`));
    }

    const id = `nb-${++this.seq}`;
    const body: Record<string, unknown> = { ...params };
    if (IDEMPOTENT_METHODS.has(method) && body.idempotencyKey === undefined) {
      body.idempotencyKey = randomUUID();
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      });
      ws.send(JSON.stringify({ type: "req", id, method, params: body }));
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rejectAllPending(new Error("client closed"));
    this.ws?.close();
  }
}
