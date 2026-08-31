import { useEffect, useState } from "react";
import { Avatar } from "../design/Avatar";
import { Scope } from "./Scope";
import { AGENT_COLORS, colorForIndex } from "../design/identity";
import type { Bot, ModelRecord } from "../lib/types";

/**
 * The contact card. Everything here is scoped to the bot you're looking at —
 * nothing configures globally, which is why there is no settings screen with
 * forty controls anywhere in this app.
 */
export function Details({
  bot,
  models,
  allBots,
  onClose,
  onPatch,
  onDelete,
}: {
  bot: Bot;
  models: ModelRecord[];
  allBots: Bot[];
  onClose: () => void;
  onPatch: (patch: {
    name?: string;
    model?: string;
    colorIndex?: number;
    faceIndex?: number;
  }) => Promise<void>;
  onDelete: () => Promise<string | null>;
}) {
  const [name, setName] = useState(bot.name);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(bot.name);
    setError(null);
  }, [bot.id, bot.name]);

  const commitName = () => {
    const value = name.trim();
    if (!value || value === bot.name) return;
    void onPatch({ name: value });
  };

  return (
    <div className="details">
      <div className="details__head">
        <Avatar
          kind={bot.kind}
          colorIndex={bot.colorIndex}
          faceIndex={bot.faceIndex}
          size={72}
        />
        <span className="details__name">{bot.name}</span>
        <span className="note">{bot.kind === "manager" ? "Your manager" : "Bot"}</span>
      </div>

      <div className="section">
        <span className="section__label">Name</span>
        <div className="field">
          <input
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </div>
      </div>

      <div className="section">
        <span className="section__label">Model</span>
        <div className="field">
          <select
            value={bot.model ?? ""}
            onChange={(e) => void onPatch({ model: e.target.value })}
          >
            <option value="">Use the default</option>
            {models.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        {bot.kind === "manager" && (
          <p className="note">
            Your manager speaks at both ends of every task, so a cheaper model here costs a lot
            less than it looks.
          </p>
        )}
      </div>

      <Scope bot={bot} />

      <div className="section">
        <span className="section__label">Appearance</span>
        {bot.kind === "manager" ? (
          <p className="note">
            Your manager keeps its own look so it never gets mistaken for one of the others.
          </p>
        ) : (
          <>
            <div className="swatches">
              {AGENT_COLORS.map((color, i) => (
                <button
                  key={color}
                  className="swatch"
                  style={{ background: color }}
                  aria-pressed={bot.colorIndex === i}
                  aria-label={`Colour ${i + 1}`}
                  title={color}
                  onClick={() => void onPatch({ colorIndex: i })}
                />
              ))}
            </div>
            <div className="faces">
              {Array.from({ length: 10 }, (_, i) => (
                <button
                  key={i}
                  className="facebtn"
                  aria-pressed={bot.faceIndex === i}
                  aria-label={`Face ${i + 1}`}
                  onClick={() => void onPatch({ faceIndex: i })}
                >
                  <Avatar kind="worker" colorIndex={bot.colorIndex} faceIndex={i} size={26} />
                </button>
              ))}
            </div>
          </>
        )}
        <p className="note">Currently {colorForIndex(bot.colorIndex)}.</p>
      </div>

      <div className="section">
        <span className="section__label">Under the hood</span>
        <div className="kv">
          <span>Agent</span>
          <span title={bot.agentId}>{bot.agentId}</span>
        </div>
        <div className="kv">
          <span>Thread</span>
          <span title={bot.sessionKey}>{bot.sessionKey}</span>
        </div>
      </div>

      <div className="section">
        {bot.kind === "manager" ? (
          <p className="note">
            Your manager can be renamed and remodelled, but not deleted — it runs cold-start and
            dispatch for everything else.
          </p>
        ) : (
          <button
            className="btn"
            onClick={() =>
              void onDelete().then((reason) => {
                if (reason) setError(reason);
              })
            }
          >
            Delete {bot.name}
          </button>
        )}
        {error && <p className="note" style={{ color: "var(--failed)" }}>{error}</p>}
      </div>

      <button className="btn btn--ghost" onClick={onClose} style={{ alignSelf: "flex-start" }}>
        Close
      </button>
    </div>
  );
}
