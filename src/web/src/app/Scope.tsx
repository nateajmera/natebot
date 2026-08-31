import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Bot, BotScope } from "../lib/types";

/**
 * What this bot is allowed to reach.
 *
 * Every bot starts able to do everything and you take things away, so an
 * untouched bot shows every switch on and the section reads as information
 * rather than a form waiting to be filled in.
 *
 * Writes are batched. OpenClaw rate-limits control-plane writes to three a
 * minute, so a burst of clicks has to collapse into one save — hence the short
 * settle before anything is sent, and the plain-language message when it still
 * lands on the limit.
 */

const SETTLE_MS = 1000;

type Status = "idle" | "saving" | "error";

export function Scope({ bot }: { bot: Bot }) {
  const [scope, setScope] = useState<BotScope | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The latest intent, so a save in flight never writes a stale set. */
  const wanted = useRef<BotScope | null>(null);

  useEffect(() => {
    let live = true;
    setScope(null);
    setStatus("idle");
    setError(null);
    void api
      .scope(bot.id)
      .then((s) => {
        if (live) setScope(s);
      })
      .catch(() => {
        if (live) setError("Couldn't read what this bot can reach.");
      });
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [bot.id]);

  const flush = useCallback(async () => {
    const next = wanted.current;
    if (!next) return;
    setStatus("saving");
    setError(null);
    try {
      // Sent as `id -> stays on`, never as a list of what to keep: a list would
      // mean any row this drawer has not heard of is being asked for silently,
      // and a connection added since the drawer loaded would be revoked by a
      // click on an unrelated switch.
      const stored = await api.setScope(bot.id, {
        capabilities: Object.fromEntries(next.capabilities.map((c) => [c.id, c.enabled])),
        connections: Object.fromEntries(next.connections.map((c) => [c.id, c.enabled])),
      });
      // Trust what came back, not what we sent: the manager keeps the tools it
      // is not allowed to give up.
      setScope(stored);
      wanted.current = null;
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      const message = (err as Error).message;
      setError(
        /rate|limit|429|too many/i.test(message)
          ? "That's a lot of changes at once. Give it a minute and try again."
          : message,
      );
    }
  }, [bot.id]);

  const toggle = (group: "capabilities" | "connections", id: string) => {
    // Build from the pending intent when there is one, so clicks landing in the
    // same frame stack up instead of each overwriting the last.
    const base = wanted.current ?? scope;
    if (!base) return;
    const next: BotScope = {
      ...base,
      [group]: base[group].map((row) => (row.id === id ? { ...row, enabled: !row.enabled } : row)),
    } as BotScope;

    wanted.current = next;
    setScope(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SETTLE_MS);
  };

  if (!scope) {
    return (
      <div className="section">
        <span className="section__label">Can do</span>
        <p className="note">{error ?? "Checking…"}</p>
      </div>
    );
  }

  const off = scope.capabilities.filter((c) => !c.enabled).length;

  return (
    <div className="section">
      <span className="section__label">Can do</span>

      <div className="scope">
        {scope.capabilities.map((row) => (
          <Switch
            key={row.id}
            label={row.label}
            blurb={row.blurb}
            enabled={row.enabled}
            locked={row.locked}
            onToggle={() => toggle("capabilities", row.id)}
          />
        ))}
      </div>

      {scope.connections.length > 0 && (
        <>
          <span className="section__label" style={{ marginTop: 6 }}>
            Connections
          </span>
          <div className="scope">
            {scope.connections.map((row) => (
              <Switch
                key={row.id}
                label={row.label}
                blurb=""
                enabled={row.enabled}
                locked={false}
                onToggle={() => toggle("connections", row.id)}
              />
            ))}
          </div>
        </>
      )}

      {status === "error" && error ? (
        <p className="note" style={{ color: "var(--failed)" }}>
          {error}
        </p>
      ) : (
        <p className="note">
          {status === "saving"
            ? "Saving…"
            : off === 0
              ? `${bot.name} can reach everything. Switch off whatever it has no business touching.`
              : `${off} turned off for ${bot.name}. Your other bots are unaffected.`}
        </p>
      )}
    </div>
  );
}

function Switch({
  label,
  blurb,
  enabled,
  locked,
  onToggle,
}: {
  label: string;
  blurb: string;
  enabled: boolean;
  locked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="scope__row"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      disabled={locked}
      title={locked ? "Your manager needs this to hand work to your other bots." : blurb}
      onClick={onToggle}
    >
      <span className="scope__text">
        <span className="scope__label">{label}</span>
        {blurb && <span className="scope__blurb">{blurb}</span>}
      </span>
      <span className="scope__switch" aria-hidden="true">
        <span className="scope__knob" />
      </span>
    </button>
  );
}
