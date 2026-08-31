import { useState } from "react";
import type { SignInRequest } from "../lib/plan";

/**
 * The handoff. A bot that hits a login wall stops and asks for the browser
 * rather than attempting the login itself — automated sign-ins get accounts
 * locked, and the person's credentials are never the bot's to handle.
 *
 * NateBot only opens the page. The typing is the human's, always.
 */
export function TakeoverCard({
  request,
  botName,
  onOpen,
  onContinue,
}: {
  request: SignInRequest;
  botName: string;
  onOpen: () => Promise<{ ok: boolean; error?: string }>;
  onContinue: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const host = (() => {
    try {
      return new URL(request.url).host;
    } catch {
      return request.url;
    }
  })();

  return (
    <div className="card card--attention">
      <div className="card__title">{botName} needs you to sign in to {request.site}</div>
      {request.why && <div className="card__meta">{request.why}</div>}
      <div className="card__pre">{host}</div>

      <p className="card__meta" style={{ margin: 0 }}>
        This opens {botName}'s own browser — a separate profile from your everyday one, so it
        starts out signed into nothing. Type the password yourself; {botName} never sees it.
      </p>

      <div className="card__actions">
        {!opened ? (
          <button
            className="btn btn--primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onOpen()
                .then((r) => {
                  if (r.ok) setOpened(true);
                  else setError(r.error ?? "Couldn't open the browser.");
                })
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Opening…" : "Open the browser"}
          </button>
        ) : (
          <button className="btn btn--primary" onClick={onContinue}>
            I'm signed in — carry on
          </button>
        )}
        {opened && (
          <span className="card__meta">
            Look for the orange-tinted Chrome window.
          </span>
        )}
      </div>
      {error && <div className="card__warn">{error}</div>}
    </div>
  );
}
