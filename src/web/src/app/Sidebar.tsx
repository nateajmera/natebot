import { useMemo, useState } from "react";
import { Avatar, type AvatarState } from "../design/Avatar";
import type { Bot } from "../lib/types";

export function Sidebar({
  bots,
  activeId,
  previews,
  states,
  version,
  onSelect,
  onNewBot,
  view,
  onView,
}: {
  bots: Bot[];
  activeId: string | null;
  previews: Record<string, string>;
  states: Record<string, AvatarState>;
  version: string;
  onSelect: (id: string) => void;
  onNewBot: () => void;
  view: "thread" | "connections" | "skills" | "settings";
  onView: (v: "connections" | "skills" | "settings") => void;
}) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bots;
    return bots.filter(
      (b) =>
        b.name.toLowerCase().includes(q) || (previews[b.id] ?? "").toLowerCase().includes(q),
    );
  }, [bots, query, previews]);


  return (
    <div className="sidebar">
      <div className="sidebar__top">
        <div className="wordmark">
          <Avatar kind="manager" colorIndex={-1} faceIndex={-1} size={20} />
          NateBot
        </div>
        <input
          className="search"
          value={query}
          placeholder="Search"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn" onClick={onNewBot}>
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          New bot
        </button>
      </div>

      <div className="rows">
        {visible.map((bot) => {
          const state = states[bot.id] ?? "idle";
          return (
            <button
              key={bot.id}
              className="row"
              aria-label={bot.name}
              aria-current={bot.id === activeId}
              onClick={() => onSelect(bot.id)}
            >
              <Avatar
                kind={bot.kind}
                colorIndex={bot.colorIndex}
                faceIndex={bot.faceIndex}
                state={state}
              />
              <span className="row__body">
                <span className="row__name">{bot.name}</span>
                <span className="row__sub">{previews[bot.id] ?? "No messages yet"}</span>
              </span>
              {/* Finished work has no dot at all. Only unfinished things spend
                  attention, which is the scarce resource. */}
              {state !== "idle" && <span className={`dot dot--${state}`} />}
            </button>
          );
        })}
        {visible.length === 0 && (
          <p className="note" style={{ padding: "10px 8px" }}>
            Nothing matches “{query}”.
          </p>
        )}
      </div>

      <div className="sidebar__nav">
        <button
          className="navitem"
          aria-current={view === "connections"}
          onClick={() => onView("connections")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 10 3.8 12.2a2.5 2.5 0 0 1-3.5-3.5L2.5 6.5M10 6l2.2-2.2a2.5 2.5 0 0 1 3.5 3.5L13.5 9.5M5.5 10.5l5-5"
              fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Connectors
        </button>
        <button className="navitem" aria-current={view === "skills"} onClick={() => onView("skills")}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 12.5V4a1.5 1.5 0 0 1 1.5-1.5H12a1 1 0 0 1 1 1v9.5M3 12.5A1.5 1.5 0 0 0 4.5 14H13M3 12.5A1.5 1.5 0 0 1 4.5 11H13"
              fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Skills
        </button>
        <button className="navitem" aria-current={view === "settings"} onClick={() => onView("settings")}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8 3.4 3.4"
              fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Settings
        </button>
      </div>

      <div className="sidebar__foot">
        <a
          className="btn"
          href="https://github.com/openclaw/openclaw"
          target="_blank"
          rel="noreferrer"
          style={{ textDecoration: "none", flex: 1 }}
          title={`NateBot ${version}`}
        >
          Powered by OpenClaw
        </a>
      </div>
    </div>
  );
}
