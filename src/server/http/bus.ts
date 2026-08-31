import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientEvent } from "../hub.js";
import { log } from "../log.js";

/**
 * One-way fan-out to browser tabs. Commands always travel over REST, so this
 * socket never has to authenticate anything or interpret client input — and
 * the gateway token stays on this side of the wire.
 */
export class Bus {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<WebSocket>();
  /** Replayed to every new tab so a late-opening browser still sees preflight. */
  private readonly backlog: ClientEvent[] = [];

  constructor() {
    this.wss.on("connection", (socket: WebSocket) => {
      this.clients.add(socket);
      for (const event of this.backlog) {
        socket.send(JSON.stringify(event));
      }
      socket.on("close", () => this.clients.delete(socket));
      socket.on("error", () => this.clients.delete(socket));
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  broadcast = (event: ClientEvent): void => {
    if (event.t === "preflight" || event.t === "gateway") {
      this.backlog.push(event);
      if (this.backlog.length > 100) this.backlog.shift();
    }
    const frame = JSON.stringify(event);
    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN) {
        try {
          socket.send(frame);
        } catch (err) {
          log.debug(`bus send failed: ${(err as Error).message}`);
        }
      }
    }
  };

  close(): void {
    for (const socket of this.clients) socket.close();
    this.wss.close();
  }
}
