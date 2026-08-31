import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { McpPreset } from "../lib/types";

/**
 * Connectors give a bot *access* to a service. Skills, on the other side of
 * the sidebar, give it know-how for something already installed. Keeping the
 * two apart is the only way either word means anything.
 *
 * The list is deliberately short. Promoting a connection is a claim that it
 * works, and one that dead-ends in a cloud console is worse than no card.
 */
export function Connections({ botCount }: { botCount: number }) {
  const [presets, setPresets] = useState<McpPreset[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ title: string; ok: boolean; body: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [custom, setCustom] = useState({ name: "", url: "" });

  const load = () =>
    void api.connections().then((r) => setPresets(r.presets)).catch(() => setPresets([]));
  useEffect(load, []);

  const runStep = (id: string, index: number) => {
    setBusy(`${id}:${index}`);
    setOutput(null);
    void api
      .runSetupStep(id, index)
      .then((r) => {
        setOutput({ title: r.label, ok: r.ok, body: r.output });
        load();
      })
      .catch((e: Error) => setOutput({ title: "Setup", ok: false, body: e.message }))
      .finally(() => setBusy(null));
  };

  return (
    <div className="page">
      <div className="page__inner">
        <header className="page__head">
          <h1 className="page__title">Connectors</h1>
          <p className="page__sub">
            A connector gives your bots access to a service — your mail, your code, your files. It's
            a live link you sign into once. To teach a bot how to use something already on this
            computer, see <strong>Skills</strong>. Anything here is available to{" "}
            {botCount === 1 ? "your bot" : `all ${botCount} of your bots`}.
          </p>
        </header>

        {!presets && <p className="note">Checking what's connected…</p>}

        <div className="mcp__list">
          {(presets ?? []).map((p) => {
            const open = expanded === p.id;
            const needsSetup = p.setup.length > 0 && p.missingBins.length > 0;
            return (
              <div className="mcp" key={p.id}>
                <div className="mcp__row">
                  <span className="mcp__emoji" aria-hidden="true">{p.emoji}</span>
                  <div className="mcp__body">
                    <span className="mcp__name">
                      {p.label}
                      <span className="mcp__tag">
                        {p.kind === "local" ? "on this computer" : "hosted"}
                      </span>
                    </span>
                    <span className="mcp__gives">{p.gives}</span>
                  </div>
                  {p.installed ? (
                    <button
                      className="btn btn--ghost"
                      disabled={busy !== null}
                      onClick={() => {
                        setBusy(p.id);
                        void api.removeConnection(p.id).then(() => load()).finally(() => setBusy(null));
                      }}
                    >
                      Disconnect
                    </button>
                  ) : needsSetup ? (
                    <button className="btn" onClick={() => setExpanded(open ? null : p.id)}>
                      {open ? "Hide steps" : "Set up"}
                    </button>
                  ) : (
                    <button
                      className="btn btn--primary"
                      disabled={busy !== null}
                      onClick={() => {
                        setBusy(p.id);
                        setOutput(null);
                        void api
                          .connectPreset(p.id)
                          .then((r) => {
                            setOutput({ title: p.label, ok: r.ok, body: r.output });
                            load();
                          })
                          .finally(() => setBusy(null));
                      }}
                    >
                      {busy === p.id ? "Connecting…" : "Connect"}
                    </button>
                  )}
                </div>

                <p className="mcp__blurb">{p.blurb}</p>
                {/* Consequence, stated on the card rather than discovered later. */}
                {p.caution && <p className="mcp__caution">{p.caution}</p>}

                {open && (
                  <ol className="steps__setup">
                    {p.setup.map((step, i) => (
                      <li key={step.command}>
                        <div className="steps__setuprow">
                          <span>{step.label}</span>
                          <button className="btn" disabled={busy !== null} onClick={() => runStep(p.id, i)}>
                            {busy === `${p.id}:${i}` ? "Running…" : "Run"}
                          </button>
                        </div>
                        {/* Shown in full: this runs on your machine. */}
                        <code className="steps__cmd">{step.command}</code>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            );
          })}
        </div>

        {output && (
          <div className={output.ok ? "card" : "card card--attention"}>
            <div className="card__title">
              {output.ok ? `${output.title} — done` : `${output.title} — didn't work`}
            </div>
            <div className="card__pre">{output.body.slice(-2000) || "(no output)"}</div>
          </div>
        )}

        <section className="section">
          <span className="section__label">Add your own</span>
          <p className="note">Any MCP server, by its address.</p>
          <div className="custom__row">
            <input
              className="search"
              placeholder="Name"
              value={custom.name}
              onChange={(e) => setCustom({ ...custom, name: e.target.value })}
            />
            <input
              className="search"
              placeholder="https://…"
              value={custom.url}
              onChange={(e) => setCustom({ ...custom, url: e.target.value })}
            />
            <button
              className="btn"
              disabled={!custom.name.trim() || !custom.url.trim() || busy !== null}
              onClick={() => {
                setBusy("custom");
                void api
                  .addCustomConnection(custom.name.trim(), custom.url.trim())
                  .then((r) => {
                    setOutput({ title: custom.name.trim(), ok: r.ok, body: r.output });
                    if (r.ok) setCustom({ name: "", url: "" });
                    load();
                  })
                  .finally(() => setBusy(null));
              }}
            >
              Add
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
