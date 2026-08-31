import { useEffect, useRef, useState } from "react";
import type { AppState, ModelRecord } from "../lib/types";

/**
 * Deliberately two fields. A bot is a person on your team, not a config
 * object — anything else it needs, you tell it in the thread.
 */
export function NewBotDialog({
  models,
  onClose,
  onCreate,
}: {
  models: ModelRecord[];
  onClose: () => void;
  onCreate: (input: { name: string; purpose: string; model: string | null }) => Promise<AppState>;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => ref.current?.focus(), []);

  const create = () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    void onCreate({ name: name.trim(), purpose: purpose.trim(), model: model || null })
      .catch((e: Error) => {
        setError(e.message);
        setBusy(false);
      });
  };

  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 400, gap: 14 }}>
        <div className="card__title">New bot</div>

        <div className="field">
          <span className="section__label">Name</span>
          <input
            ref={ref}
            value={name}
            maxLength={40}
            placeholder="Harry"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
          <span className="note">People's names work better than job titles.</span>
        </div>

        <div className="field">
          <span className="section__label">What's it for</span>
          <input
            value={purpose}
            maxLength={200}
            placeholder="Keeps an eye on my inbox"
            onChange={(e) => setPurpose(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
        </div>

        {models.length > 0 && (
          <div className="field">
            <span className="section__label">Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Use the default</option>
              {models.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <p className="note" style={{ color: "var(--failed)" }}>{error}</p>}

        <div className="card__actions">
          <button className="btn btn--primary" disabled={!name.trim() || busy} onClick={create}>
            {busy ? "Creating…" : "Create"}
          </button>
          <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
