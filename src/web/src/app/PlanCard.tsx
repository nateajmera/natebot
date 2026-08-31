import { useState } from "react";
import { Avatar } from "../design/Avatar";
import type { Bot, Plan } from "../lib/types";

/**
 * The manager proposes; the app executes. There are no privileged tools behind
 * this card — approving it is what actually creates the bots, which is why
 * nothing can be talked into creating them.
 */
export function PlanCard({
  plan,
  onApprove,
  onChange,
  busy,
  startIndex = 0,
  existing = [],
}: {
  plan: Plan;
  onApprove: () => void;
  onChange: (note: string) => void;
  busy?: boolean;
  startIndex?: number;
  /** Bots that already exist, so an approved plan shows what was really made. */
  existing?: Bot[];
}) {
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState("");

  const match = (name: string) =>
    existing.find((b) => b.kind === "worker" && b.name.toLowerCase() === name.toLowerCase());

  // A plan whose bots all exist has already been approved. Re-approving would
  // silently build the same team a second time, so the card retires instead.
  const approved = plan.bots.every((b) => match(b.name) !== undefined);

  return (
    <div className={`card${approved ? " card--resolved" : ""}`}>
      {plan.summary && <div className="card__title">{plan.summary}</div>}

      {plan.bots.map((bot, i) => {
        const real = match(bot.name);
        return (
        <div className="plan__bot" key={`${bot.name}-${i}`}>
          <Avatar
            kind="worker"
            colorIndex={real ? real.colorIndex : startIndex + i}
            faceIndex={real ? real.faceIndex : startIndex + i}
            size={34}
          />
          <div className="plan__botbody">
            <span className="plan__botname">{bot.name}</span>
            {bot.purpose && <span className="card__meta">{bot.purpose}</span>}
            {bot.tools.length > 0 && (
              <div className="plan__tools">
                {bot.tools.map((t) => (
                  <span className="chip" key={t}>
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="plan__first" style={{ marginTop: 6 }}>
              {bot.firstMessage}
            </div>
          </div>
        </div>
        );
      })}

      {approved ? (
        <p className="card__meta" style={{ margin: 0 }}>
          {plan.bots.length === 1
            ? `${plan.bots[0]!.name} is on your list, with this message ready to send.`
            : "These bots are on your list, with their first messages ready to send."}
        </p>
      ) : !changing ? (
        <div className="card__actions">
          <button className="btn btn--primary" onClick={onApprove} disabled={busy}>
            {busy ? "Setting up…" : "Looks good"}
          </button>
          <button className="btn" onClick={() => setChanging(true)} disabled={busy}>
            Change something
          </button>
        </div>
      ) : (
        <div className="card__other">
          <input
            autoFocus
            value={note}
            placeholder="What should be different?"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && note.trim()) onChange(note.trim());
            }}
          />
          <button className="btn" disabled={!note.trim() || busy} onClick={() => onChange(note.trim())}>
            Send
          </button>
        </div>
      )}

      {!approved && (
        <p className="card__meta" style={{ margin: 0 }}>
          Nothing runs until you say so — approving this creates the bots with their first message
          ready, not sent.
        </p>
      )}
    </div>
  );
}
