import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { HubSkill, Skill } from "../lib/types";

/**
 * Skills are the half of this that nobody can define on first encounter, so
 * the page leads with the distinction rather than assuming it.
 *
 * A connector gives a bot *access* to a service. A skill gives it *know-how*
 * for something already on this machine — the 1Password skill connects to
 * nothing, it teaches a bot to drive the `op` command that's already there.
 */
export function Skills() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ title: string; ok: boolean; body: string } | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HubSkill[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [hubBusy, setHubBusy] = useState<string | null>(null);
  const [hubNote, setHubNote] = useState<string | null>(null);

  const load = () => void api.skills().then((r) => setSkills(r.skills)).catch(() => setSkills([]));
  useEffect(load, []);

  const search = () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setHubNote(null);
    void api
      .searchHub(q)
      .then((r) => setResults(r.results))
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  };

  const nameCounts = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of results ?? []) {
      const key = r.displayName.trim().toLowerCase();
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return seen;
  }, [results]);

  return (
    <div className="page">
      <div className="page__inner">
        <header className="page__head">
          <h1 className="page__title">Skills</h1>
          <p className="page__sub">
            A skill teaches your bots how to use something that's already on this computer. It's
            know-how, not access — the 1Password skill doesn't connect to anything, it teaches a bot
            to drive the <code>op</code> command already installed. For access to a service like your
            email, you want <strong>Connectors</strong> instead.
          </p>
        </header>

        <div className="hub__search">
          <input
            className="search"
            value={query}
            placeholder="Search every skill"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search();
            }}
          />
          <button className="btn" onClick={search} disabled={!query.trim() || searching}>
            {searching ? "Searching…" : "Search"}
          </button>
          {results && (
            <button className="btn btn--ghost" onClick={() => { setResults(null); setQuery(""); }}>
              Clear
            </button>
          )}
        </div>

        {!results && (
          <section className="section">
            <span className="section__label">Ready to use</span>
            <p className="note">
              These come with NateBot. Most need their command-line tool installed once — after that
              every bot can use them.
            </p>

            {!skills && <p className="note">Checking…</p>}
            <div className="conn__grid">
              {(skills ?? []).map((s) => (
                <div className="conn" key={s.name}>
                  <span className="conn__emoji" aria-hidden="true">{s.emoji || "📄"}</span>
                  <div className="conn__body">
                    <span className="conn__name">{s.label}</span>
                    <span className="conn__desc">{s.description}</span>
                    {!s.ready && (
                      <span className="conn__needs">
                        needs <code>{s.missingBins.join(", ")}</code>
                      </span>
                    )}
                  </div>
                  {s.ready ? (
                    <span className="conn__ready">Ready</span>
                  ) : s.install ? (
                    <button
                      className="btn"
                      disabled={busy !== null}
                      onClick={() => {
                        setBusy(s.name);
                        setOutput(null);
                        void api
                          .installSkill(s.name)
                          .then((r) => {
                            setOutput({ title: s.label, ok: r.ok, body: r.output });
                            load();
                          })
                          .finally(() => setBusy(null));
                      }}
                    >
                      {busy === s.name ? "Installing…" : "Install"}
                    </button>
                  ) : (
                    <span className="conn__manual">Manual</span>
                  )}
                </div>
              ))}
            </div>

            {output && (
              <div className={output.ok ? "card" : "card card--attention"}>
                <div className="card__title">
                  {output.ok ? `${output.title} is ready` : `Couldn't install ${output.title}`}
                </div>
                <div className="card__pre">{output.body.slice(-1500) || "(no output)"}</div>
              </div>
            )}
          </section>
        )}

        {results && (
          <section className="section">
            <span className="section__label">From ClawHub</span>
            <p className="note">
              Anyone can publish here, and nothing is scanned. A security audit found 341 of
              ClawHub's 2,857 skills were malware — so "not scanned" means nobody has checked it,
              not that it's safe. Judge by the publisher and the install count, and treat two skills
              sharing a name as a reason to look closer.
            </p>

            {hubNote && <p className="note">{hubNote}</p>}
            {results.length === 0 && <p className="note">Nothing matched that.</p>}

            <div className="hub__list">
              {results.map((r) => {
                const dupe = (nameCounts.get(r.displayName.trim().toLowerCase()) ?? 0) > 1;
                return (
                  <div className="hub" key={r.reference}>
                    <div className="hub__main">
                      <span className="hub__name">
                        {r.displayName}
                        {r.official && <span className="hub__official">official</span>}
                        {r.suspicious && <span className="hub__flag">flagged</span>}
                        {dupe && !r.suspicious && (
                          <span className="hub__dupe" title="More than one skill here uses this name">
                            name reused
                          </span>
                        )}
                        {!r.scanned && !r.suspicious && !r.official && (
                          <span className="hub__unscanned" title="Nobody has checked this skill.">
                            not scanned
                          </span>
                        )}
                      </span>
                      <span className="hub__desc">{r.description.slice(0, 180)}</span>
                      <span className="hub__meta">
                        {r.publisherImage && <img src={r.publisherImage} alt="" className="hub__avatar" />}
                        <a href={r.url} target="_blank" rel="noreferrer">{r.publisher}</a>
                        <span>·</span>
                        <span>{r.downloads.toLocaleString()} installs</span>
                      </span>
                    </div>
                    <button
                      className="btn"
                      disabled={hubBusy !== null || r.suspicious}
                      title={r.suspicious ? "ClawHub has flagged this as suspicious" : undefined}
                      onClick={() => {
                        setHubBusy(r.reference);
                        setHubNote(null);
                        void api
                          .installHubSkill(r.reference)
                          .then((res) =>
                            setHubNote(
                              res.ok
                                ? `Added ${r.displayName} by ${r.publisher}. Your bots can use it now.`
                                : `Couldn't add it: ${res.error ?? "unknown error"}`,
                            ),
                          )
                          .finally(() => setHubBusy(null));
                      }}
                    >
                      {r.suspicious ? "Flagged" : hubBusy === r.reference ? "Adding…" : "Add"}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
