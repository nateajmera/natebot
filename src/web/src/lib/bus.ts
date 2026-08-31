import type { ClientEvent } from "./types";

type Listener = (event: ClientEvent) => void;

/**
 * Read-only event feed from NateBot's own server. It reconnects quietly: a
 * dropped socket is a transport detail, not something worth telling the user
 * about unless the gateway itself is down.
 */
export function connectBus(onEvent: Listener): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let delay = 400;
  let timer: number | undefined;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${proto}//${location.host}/events`);

    socket.onopen = () => {
      delay = 400;
    };
    socket.onmessage = (evt) => {
      try {
        onEvent(JSON.parse(evt.data as string) as ClientEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      if (closed) return;
      timer = window.setTimeout(open, delay);
      delay = Math.min(delay * 2, 8000);
    };
    socket.onerror = () => socket?.close();
  };

  open();

  return () => {
    closed = true;
    if (timer) window.clearTimeout(timer);
    socket?.close();
  };
}
