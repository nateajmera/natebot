import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "./app/Sidebar";
import { Thread, type ThreadState } from "./app/Thread";
import { Details } from "./app/Details";
import { Onboarding } from "./onboarding/Onboarding";
import { NewBotDialog } from "./app/NewBotDialog";
import { Connections } from "./app/Connections";
import { Skills } from "./app/Skills";
import { Settings } from "./app/Settings";
import { api } from "./lib/api";
import { connectBus } from "./lib/bus";
import { visibleProse } from "./lib/plan";
import type { AvatarState } from "./design/Avatar";
import type { AppState, Bot, ClientEvent, Plan, PreflightState, ThreadItem } from "./lib/types";

type Threads = Record<string, ThreadState>;

/** Which surface the centre pane is showing. */
type View = "thread" | "connections" | "skills" | "settings";

const EMPTY_THREAD: ThreadState = { items: [], streaming: null, loaded: false };

let itemSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++itemSeq}`;

/**
 * Appends an item in timestamp order. Events do not arrive in display order —
 * a run's `lifecycle:start` beats the user message that caused it — so a plain
 * push would show the step row above the message that triggered it.
 */
function insertByTs(items: ThreadItem[], item: ThreadItem): ThreadItem[] {
  let i = items.length;
  while (i > 0 && items[i - 1]!.ts > item.ts) i--;
  if (i === items.length) return [...items, item];
  return [...items.slice(0, i), item, ...items.slice(i)];
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [preflight, setPreflight] = useState<PreflightState>({
    phase: "checking",
    line: "Starting up…",
  });
  const [threads, setThreads] = useState<Threads>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pane, setPane] = useState<"left" | "right" | "none">("left");
  const [view, setView] = useState<View>("thread");
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, AvatarState>>({});
  const [pending, setPending] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  /* Session key -> bot id, kept in a ref so the bus handler never goes stale. */
  const botsRef = useRef<Bot[]>([]);
  const bots = state?.bots ?? [];
  if (bots.length > 0) botsRef.current = bots;

  const botForSession = useCallback(
    (sessionKey: string) => botsRef.current.find((b) => b.sessionKey === sessionKey) ?? null,
    [],
  );

  const refreshState = useCallback(async () => {
    const next = await api.state();
    // Update the lookup ref before React re-renders: bus events for a
    // just-created bot can arrive in the same tick, and a stale ref would
    // silently drop every one of them.
    botsRef.current = next.bots;
    setState(next);
    setPreflight(next.preflight);
    return next;
  }, []);

  useEffect(() => {
    void refreshState().then((next) => {
      if (!activeId && next.bots.length > 0) setActiveId(next.bots[0]!.id);
    });
    void api.pendingFirstMessages().then((r) => setPending(r.pending));
    void loadPendingApprovals();
    // One call fills every sidebar subtitle, instead of loading each thread.
    void api.previews().then((r) => {
      setPreviews(
        Object.fromEntries(
          Object.entries(r.previews).map(([botId, p]) => [botId, formatPreview(p.role, p.text)]),
        ),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Approvals already waiting when the app opens. Without this, anything
   * raised while the window was shut would never be answerable — and the agent
   * behind it would stay blocked forever.
   */
  const loadPendingApprovals = useCallback(async () => {
    try {
      const { pending: waiting } = await api.pendingApprovals();
      if (waiting.length === 0) return;
      const bots = botsRef.current;
      for (const entry of waiting) {
        const request = (entry.payload.request ?? entry.payload) as Record<string, unknown>;
        const sessionKey = typeof request.sessionKey === "string" ? request.sessionKey : null;
        const agentId = typeof request.agentId === "string" ? request.agentId : null;
        const target =
          (sessionKey ? bots.find((b) => b.sessionKey === sessionKey) : null) ??
          (agentId ? bots.find((b) => b.agentId === agentId) : null) ??
          bots.find((b) => b.kind === "manager") ??
          bots[0];
        if (!target) continue;
        setStates((s) => ({ ...s, [target.id]: "attention" }));
        setThreads((prev) => {
          const thread = prev[target.id] ?? EMPTY_THREAD;
          if (thread.items.some((i) => i.kind === "approval" && i.id === entry.id)) return prev;
          return {
            ...prev,
            [target.id]: {
              ...thread,
              items: [
                ...thread.items,
                { kind: "approval", id: entry.id, ts: Date.now(), payload: entry.payload, resolved: false },
              ],
            },
          };
        });
      }
    } catch {
      // A missing approval list is not a reason to fail the whole app.
    }
  }, []);

  const patchThread = useCallback(
    (botId: string, fn: (prev: ThreadState) => ThreadState) => {
      setThreads((prev) => ({ ...prev, [botId]: fn(prev[botId] ?? EMPTY_THREAD) }));
    },
    [],
  );

  /* ----------------------------------------------------------------- bus */

  useEffect(() => {
    return connectBus((event: ClientEvent) => {
      switch (event.t) {
        case "preflight": {
          const next: PreflightState = { phase: event.phase, line: event.line };
          if (event.detail) next.detail = event.detail;
          setPreflight(next);
          if (event.phase === "done") void refreshState();
          break;
        }

        case "gateway": {
          setState((s) => (s ? { ...s, gateway: { ...s.gateway, connected: event.connected } } : s));
          if (event.connected) void loadPendingApprovals();
          break;
        }

        case "bots.changed": {
          void refreshState();
          break;
        }

        case "run.start": {
          const bot = botForSession(event.sessionKey);
          if (!bot) break;
          setStates((s) => ({ ...s, [bot.id]: "working" }));
          patchThread(bot.id, (prev) => ({
            ...prev,
            items: insertByTs(prev.items, {
              kind: "run",
              id: event.runId,
              ts: event.startedAt,
              run: {
                runId: event.runId,
                startedAt: event.startedAt,
                endedAt: null,
                status: "running",
                steps: [],
              },
            }),
          }));
          break;
        }

        case "run.end": {
          const bot = botForSession(event.sessionKey);
          if (!bot) break;
          setStates((s) => ({
            ...s,
            // Finished work goes back to plain grey. Only failure keeps colour.
            [bot.id]: event.status === "failed" ? "failed" : "idle",
          }));
          patchThread(bot.id, (prev) => ({
            ...prev,
            streaming: prev.streaming?.runId === event.runId ? null : prev.streaming,
            items: prev.items.map((item) =>
              item.kind === "run" && item.run.runId === event.runId
                ? { ...item, run: { ...item.run, endedAt: event.endedAt, status: event.status } }
                : item,
            ),
          }));
          break;
        }

        case "step.start": {
          const bot = botForSession(event.sessionKey);
          if (!bot) break;
          patchThread(bot.id, (prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.kind === "run" && item.run.runId === event.runId
                ? {
                    ...item,
                    run: {
                      ...item.run,
                      steps: [
                        ...item.run.steps,
                        {
                          toolCallId: event.toolCallId,
                          name: event.name,
                          args: event.args,
                          result: null,
                          isError: false,
                          startedAt: event.ts,
                          endedAt: null,
                        },
                      ],
                    },
                  }
                : item,
            ),
          }));
          break;
        }

        case "step.result": {
          const bot = botForSession(event.sessionKey);
          if (!bot) break;
          patchThread(bot.id, (prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.kind === "run" && item.run.runId === event.runId
                ? {
                    ...item,
                    run: {
                      ...item.run,
                      steps: item.run.steps.map((s) =>
                        s.toolCallId === event.toolCallId
                          ? {
                              ...s,
                              result: event.result,
                              isError: event.isError,
                              endedAt: event.ts,
                              shotPath: event.shotPath,
                            }
                          : s,
                      ),
                    },
                  }
                : item,
            ),
          }));
          break;
        }

        case "assistant": {
          const bot = botForSession(event.sessionKey);
          if (!bot) break;
          patchThread(bot.id, (prev) => ({
            ...prev,
            streaming: { runId: event.runId, text: event.text },
          }));
          break;
        }

        case "message": {
          const bot = botForSession(event.sessionKey);
          if (!bot) break;
          setPreviews((p) => ({ ...p, [bot.id]: formatPreview(event.role, event.text) }));
          patchThread(bot.id, (prev) => ({
            ...prev,
            streaming: event.role === "assistant" ? null : prev.streaming,
            items: insertByTs(prev.items, {
              kind: "message",
              id: nextId("m"),
              role: event.role,
              text: event.text,
              ts: event.ts,
            }),
          }));
          break;
        }

        case "approval.requested": {
          const bot = event.sessionKey ? botForSession(event.sessionKey) : null;
          const target = bot ?? botsRef.current.find((b) => b.kind === "manager") ?? null;
          if (!target) break;
          setStates((s) => ({ ...s, [target.id]: "attention" }));
          patchThread(target.id, (prev) => ({
            ...prev,
            items: insertByTs(prev.items, {
              kind: "approval",
              id: event.id,
              ts: Date.now(),
              payload: event.payload,
              resolved: false,
            }),
          }));
          break;
        }

        case "approval.resolved": {
          setThreads((prev) => {
            const next: Threads = { ...prev };
            for (const [botId, thread] of Object.entries(prev)) {
              if (!thread.items.some((i) => i.kind === "approval" && i.id === event.id)) continue;
              next[botId] = {
                ...thread,
                items: thread.items.map((i) =>
                  i.kind === "approval" && i.id === event.id ? { ...i, resolved: true } : i,
                ),
              };
              setStates((s) => (s[botId] === "attention" ? { ...s, [botId]: "idle" } : s));
            }
            return next;
          });
          break;
        }
      }
    });
  }, [botForSession, patchThread, refreshState, loadPendingApprovals]);

  /* --------------------------------------------------------------- thread */

  const loadThread = useCallback(
    async (botId: string) => {
      const data = await api.thread(botId);
      const items: ThreadItem[] = [
        ...data.messages.map((m) => ({
          kind: "message" as const,
          id: nextId("h"),
          role: m.role,
          text: m.text,
          ts: m.ts,
        })),
        ...data.runs
          .filter((r) => r.steps.length > 0)
          .map((r) => ({
            kind: "run" as const,
            id: r.runId,
            ts: r.startedAt,
            run: {
              runId: r.runId,
              startedAt: r.startedAt,
              endedAt: r.endedAt,
              status: r.status,
              steps: r.steps,
            },
          })),
      ].sort((a, b) => a.ts - b.ts);

      setThreads((prev) => {
        // Approvals are not part of the transcript, so a history load would
        // otherwise wipe any that are still waiting for an answer.
        const carried = (prev[botId]?.items ?? []).filter((i) => i.kind === "approval");
        const known = new Set(items.map((i) => i.id));
        return {
          ...prev,
          [botId]: {
            items: [...items, ...carried.filter((c) => !known.has(c.id))],
            streaming: prev[botId]?.streaming ?? null,
            loaded: true,
          },
        };
      });

      const last = data.messages.at(-1);
      if (last) setPreviews((p) => ({ ...p, [botId]: formatPreview(last.role, last.text) }));
    },
    [],
  );

  useEffect(() => {
    if (!activeId) return;
    if (threads[activeId]?.loaded) return;
    void loadThread(activeId).catch(() => undefined);
  }, [activeId, threads, loadThread]);

  const activeBot = useMemo(
    () => bots.find((b) => b.id === activeId) ?? null,
    [bots, activeId],
  );

  const send = useCallback(
    async (botId: string, text: string, opts: { model?: string; thinking?: string }) => {
      if (pending[botId]) {
        void api.clearPending(botId);
        setPending((p) => {
          const next = { ...p };
          delete next[botId];
          return next;
        });
      }
      await api.send(botId, text, opts);
    },
    [pending],
  );

  /* ----------------------------------------------------------------- ui */

  if (!state) {
    return (
      <div className="center">
        <div className="empty">Starting NateBot…</div>
      </div>
    );
  }

  if (!state.onboarded) {
    const managerBot = state.bots.find((b) => b.kind === "manager") ?? null;
    const managerThread = managerBot ? threads[managerBot.id] : undefined;
    return (
      <Onboarding
        state={state}
        preflight={preflight}
        streaming={managerThread?.streaming?.text ?? lastAssistantText(managerThread)}
        onSendFirstTask={async (bot, text) => {
          setActiveId(bot.id);
          await api.send(bot.id, text);
        }}
        onFinished={async () => {
          await api.completeOnboarding();
          const next = await refreshState();
          const first = next.bots.find((b) => b.kind === "worker") ?? next.bots[0] ?? null;
          if (first) setActiveId(first.id);
          const p = await api.pendingFirstMessages();
          setPending(p.pending);
        }}
      />
    );
  }

  return (
    <div className="shell" data-pane={pane}>
      <div className="pane pane--left">
        <Sidebar
          bots={bots}
          activeId={activeId}
          previews={previews}
          states={states}
          version={state.version}
          onSelect={(id) => {
            setActiveId(id);
            setView("thread");
            if (pane === "right") setPane("left");
          }}
          onNewBot={() => setCreating(true)}
          view={view}
          onView={(v) => {
            setView(v);
            setPane("left");
          }}
        />
      </div>

      <div className="pane">
        {!state.gateway.connected && (
          <div className="banner">
            <span className="dot dot--failed" />
            Lost the connection to OpenClaw. Reconnecting…
          </div>
        )}
        {view === "connections" ? (
          <Connections botCount={bots.length} />
        ) : view === "skills" ? (
          <Skills />
        ) : view === "settings" ? (
          <Settings
            state={state}
            onRename={async (name) => {
              await api.setName(name);
              await refreshState();
            }}
          />
        ) : activeBot ? (
          <Thread
            key={activeBot.id}
            bot={activeBot}
            bots={bots}
            thread={threads[activeBot.id] ?? EMPTY_THREAD}
            models={state.models}
            state={states[activeBot.id] ?? "idle"}
            prefill={pending[activeBot.id]}
            detailsOpen={pane === "right"}
            onToggleDetails={() => setPane((p) => (p === "right" ? "left" : "right"))}
            onSend={(text, opts) => void send(activeBot.id, text, opts)}
            onStop={() => void api.abort(activeBot.id)}
            onResolveApproval={(id, decision, note) =>
              void api.resolveApproval(id, decision, note)
            }
            onOpenSignIn={(url) => api.openSignIn(activeBot.id, url)}
            onApprovePlan={async (plan: Plan) => {
              await api.approvePlan(plan);
              await refreshState();
              const p = await api.pendingFirstMessages();
              setPending(p.pending);
            }}
          />
        ) : (
          <div className="center">
            <div className="empty">
              <p>No bots yet.</p>
              <button className="btn btn--primary" onClick={() => setCreating(true)}>
                New bot
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="pane pane--right">
        {activeBot && pane === "right" && (
          <Details
            bot={activeBot}
            models={state.models}
            allBots={bots}
            onClose={() => setPane("left")}
            onPatch={async (patch) => {
              await api.updateBot(activeBot.id, patch);
              await refreshState();
            }}
            onDelete={async () => {
              const result = await api.deleteBot(activeBot.id);
              if (!result.ok) return result.reason ?? "Couldn't delete that bot.";
              const next = await refreshState();
              setActiveId(next.bots[0]?.id ?? null);
              setPane("left");
              return null;
            }}
          />
        )}
      </div>

      {creating && (
        <NewBotDialog
          models={state.models}
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            const r = await api.createBot(input);
            const next = await refreshState();
            setActiveId(r.bot.id);
            setCreating(false);
            return next;
          }}
        />
      )}
    </div>
  );
}

/** Sidebar subtitle: who spoke last, with any plan block kept out of it. */
function formatPreview(role: string, text: string): string {
  const body = visibleProse(text).replace(/\s+/g, " ").trim();
  if (!body) return role === "user" ? "You sent a message" : "Sent a plan";
  return `${role === "user" ? "You: " : ""}${body.slice(0, 90)}`;
}

function lastAssistantText(thread: ThreadState | undefined): string {
  if (!thread) return "";
  for (let i = thread.items.length - 1; i >= 0; i--) {
    const item = thread.items[i]!;
    if (item.kind === "message" && item.role === "assistant") return item.text;
  }
  return "";
}
