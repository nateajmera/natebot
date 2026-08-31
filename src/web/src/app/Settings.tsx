import { useState } from "react";
import { Avatar } from "../design/Avatar";
import type { AppState } from "../lib/types";

/**
 * Deliberately thin. Nothing about a *bot* belongs here — that all lives in its
 * details drawer, which is the whole reason this app has no forty-control
 * settings screen. This is only the handful of facts that are about the person
 * and the machine.
 */
export function Settings({
  state,
  onRename,
}: {
  state: AppState;
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(state.userName);
  const [saved, setSaved] = useState(false);

  const workers = state.bots.filter((b) => b.kind === "worker");
  const manager = state.bots.find((b) => b.kind === "manager");

  const commit = () => {
    const value = name.trim();
    if (!value || value === state.userName) return;
    void onRename(value).then(() => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  return (
    <div className="page">
      <div className="page__inner">
        <header className="page__head">
          <h1 className="page__title">Settings</h1>
          <p className="page__sub">The few things that aren't about a particular bot.</p>
        </header>

        <section className="section">
          <span className="section__label">You</span>
          <div className="field">
            <input
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <span className="note">
              {saved ? "Saved." : "Your bots address you by this name."}
            </span>
          </div>
        </section>

        <section className="section">
          <span className="section__label">Your team</span>
          <div className="settings__team">
            {state.bots.map((b) => (
              <span className="settings__bot" key={b.id} title={b.kind === "manager" ? "Manager" : "Bot"}>
                <Avatar kind={b.kind} colorIndex={b.colorIndex} faceIndex={b.faceIndex} size={26} />
                {b.name}
              </span>
            ))}
          </div>
          <p className="note">
            {manager ? `${manager.name} plus ` : ""}
            {workers.length} {workers.length === 1 ? "bot" : "bots"}. New ones start from the
            sidebar, or just ask {manager?.name ?? "your manager"} for one.
          </p>
        </section>

        <section className="section">
          <span className="section__label">AI</span>
          <div className="kv">
            <span>Provider</span>
            <span>{state.provider || "not set"}</span>
          </div>
          <div className="kv">
            <span>Default model</span>
            <span>{state.models[0]?.name ?? "—"}</span>
          </div>
          <p className="note">
            Each bot can use a different model — that's in its details drawer, not here.
          </p>
        </section>

        <section className="section">
          <span className="section__label">Under the hood</span>
          <div className="kv">
            <span>NateBot</span>
            <span>{state.version}</span>
          </div>
          <div className="kv">
            <span>OpenClaw</span>
            <span>{state.gateway.openclawVersion ?? "—"}</span>
          </div>
          <div className="kv">
            <span>Gateway</span>
            <span>
              {state.gateway.connected ? `connected · port ${state.gateway.port ?? "—"}` : "disconnected"}
            </span>
          </div>
        </section>

        <section className="section">
          <p className="note">
            NateBot is powered by{" "}
            <a href="https://github.com/openclaw/openclaw" target="_blank" rel="noreferrer">
              OpenClaw
            </a>
            , which is MIT licensed. Everything your bots do runs on this computer.
          </p>
        </section>
      </div>
    </div>
  );
}
