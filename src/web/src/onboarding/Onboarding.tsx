import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "../design/Avatar";
import { api } from "../lib/api";
import type { AppState, Bot, Plan, PreflightState, ProviderCard } from "../lib/types";
import { PlanCard } from "../app/PlanCard";
import { extractPlan, visibleProse } from "../lib/plan";

type Step = "name" | "preflight" | "what" | "provider" | "manager" | "task" | "done";

type Props = {
  state: AppState;
  preflight: PreflightState;
  /** Live assistant text for the manager's first reply, streamed from the bus. */
  streaming: string;
  onSendFirstTask: (bot: Bot, text: string) => Promise<void>;
  onFinished: () => Promise<void>;
};

export function Onboarding({ state, preflight, streaming, onSendFirstTask, onFinished }: Props) {
  // Reloading mid-setup should never send anyone back to screen one.
  const [step, setStep] = useState<Step>(() => {
    if (state.bots.some((b) => b.kind === "manager")) return "task";
    if (state.provider) return "manager";
    if (state.userName) return "preflight";
    return "name";
  });
  const [name, setName] = useState(state.userName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [providers, setProviders] = useState<ProviderCard[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  const [managerName, setManagerName] = useState("Commander");
  const [manager, setManager] = useState<Bot | null>(
    state.bots.find((b) => b.kind === "manager") ?? null,
  );

  const [task, setTask] = useState("");
  const [taskSent, setTaskSent] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [prose, setProse] = useState("");

  const connected = preflight.phase === "done";
  const failed = preflight.phase === "failed";

  /* Preflight runs while they type their name, so this screen is usually
     already finished by the time anyone reaches it. */
  useEffect(() => {
    if (step === "preflight" && connected) {
      const t = setTimeout(() => setStep("what"), 700);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [step, connected]);

  useEffect(() => {
    if (step !== "provider" || providers) return;
    void api
      .providers()
      .then((r) => {
        setProviders(r.providers);
        // Default-select whatever already has credentials on this machine.
        setChosen(r.providers.find((p) => p.detected)?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, [step, providers]);

  /* The manager's reply carries the plan block; pull it out as it lands. */
  useEffect(() => {
    if (!taskSent || !streaming) return;
    setProse(visibleProse(streaming));
    const found = extractPlan(streaming);
    if (found) setPlan(found);
  }, [taskSent, streaming]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const chosenCard = useMemo(
    () => providers?.find((p) => p.id === chosen) ?? null,
    [providers, chosen],
  );

  return (
    <div className="ob">
      <div className="ob__stage">
        {step === "name" && (
          <NameScreen
            value={name}
            onChange={setName}
            busy={busy}
            onNext={() =>
              guard(async () => {
                await api.setName(name.trim());
                setStep("preflight");
              })
            }
          />
        )}

        {step === "preflight" && <PreflightScreen preflight={preflight} name={name} />}

        {step === "what" && (
          <div className="ob__card">
            <h1 className="ob__h">NateBot runs AI agents on your computer.</h1>
            <p className="ob__p">
              They can read your email, fix your code, and work while you sleep. Everything stays
              local.
            </p>
            <div className="ob__actions">
              <button className="btn btn--primary" onClick={() => setStep("provider")}>
                Get started
              </button>
            </div>
          </div>
        )}

        {step === "provider" && (
          <div className="ob__card ob__card--wide">
            <h1 className="ob__h">Which AI should your bots use?</h1>
            <p className="ob__p">You can change this later, and per bot.</p>
            {!providers && <p className="ob__p">Checking what's already set up…</p>}
            {providers && (
              <div className="providers">
                {providers.map((p) => (
                  <button
                    key={p.id}
                    className="provider"
                    aria-label={p.label}
                    aria-pressed={chosen === p.id}
                    onClick={() => setChosen(p.id)}
                  >
                    <span>
                      <span className="provider__name">{p.label}</span>
                      <span className="provider__req">{p.requirement}</span>
                      <span className="provider__cost">{p.cost}</span>
                      {p.tokensOnly && (
                        <span className="provider__tokens">
                          You'll see token counts, not dollar amounts.
                        </span>
                      )}
                    </span>
                    {p.detected && <span className="provider__found">{p.detail || "Ready"}</span>}
                  </button>
                ))}
              </div>
            )}
            {chosenCard && !chosenCard.detected && (
              <>
                <p className="ob__p">
                  You'll need to sign in once. Run this in a terminal, then carry on:
                </p>
                <div className="ob__setup">{chosenCard.setupCommand}</div>
              </>
            )}
            <div className="ob__actions">
              <button
                className="btn btn--primary"
                disabled={!chosen || busy}
                onClick={() =>
                  guard(async () => {
                    if (!chosenCard) return;
                    await api.setProvider(chosenCard.id, chosenCard.modelId);
                    setStep("manager");
                  })
                }
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === "manager" && (
          <div className="ob__card">
            <div style={{ display: "flex", justifyContent: "center", paddingBottom: 4 }}>
              <Avatar kind="manager" colorIndex={-1} faceIndex={-1} size={64} />
            </div>
            <h1 className="ob__h">Meet your manager.</h1>
            <p className="ob__p">
              This one runs the others — you tell it what you want done and it works out who should
              do it. Give it a name.
            </p>
            <input
              className="ob__input"
              value={managerName}
              maxLength={40}
              autoFocus
              onChange={(e) => setManagerName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && managerName.trim()) {
                  void guard(async () => {
                    const r = await api.createManager(managerName.trim());
                    setManager(r.bot);
                    setStep("task");
                  });
                }
              }}
            />
            <div className="ob__actions">
              <button
                className="btn btn--primary"
                disabled={!managerName.trim() || busy}
                onClick={() =>
                  guard(async () => {
                    const r = await api.createManager(managerName.trim());
                    setManager(r.bot);
                    setStep("task");
                  })
                }
              >
                {busy ? "Setting up…" : "That's the one"}
              </button>
            </div>
          </div>
        )}

        {step === "task" && manager && (
          <div className="ob__card ob__card--wide">
            <h1 className="ob__h">What's the first thing you want done?</h1>
            {!taskSent && (
              <>
                <p className="ob__p">
                  Anything real works — “check my email every morning”, “watch my repo for failing
                  tests”. {manager.name} will work out who should do it.
                </p>
                <input
                  className="ob__input"
                  value={task}
                  autoFocus
                  placeholder="Keep an eye on my inbox and flag anything urgent"
                  onChange={(e) => setTask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && task.trim()) {
                      void guard(async () => {
                        setTaskSent(true);
                        await onSendFirstTask(manager, task.trim());
                      });
                    }
                  }}
                />
                <div className="ob__actions">
                  <button
                    className="btn btn--primary"
                    disabled={!task.trim() || busy}
                    onClick={() =>
                      guard(async () => {
                        setTaskSent(true);
                        await onSendFirstTask(manager, task.trim());
                      })
                    }
                  >
                    Ask {manager.name}
                  </button>
                  <button className="btn btn--ghost" onClick={() => void onFinished()}>
                    Skip for now
                  </button>
                </div>
              </>
            )}

            {taskSent && (
              <>
                {prose && <p className="ob__p">{prose}</p>}
                {!plan && (
                  <div className="ob__thinking">
                    <span className="pf__spinner" />
                    {manager.name} is working out who should do this…
                  </div>
                )}
                {plan && (
                  <PlanCard
                    plan={plan}
                    onApprove={() =>
                      guard(async () => {
                        await api.approvePlan(plan);
                        await onFinished();
                      })
                    }
                    onChange={(note) =>
                      guard(async () => {
                        setPlan(null);
                        setProse("");
                        await onSendFirstTask(manager, note);
                      })
                    }
                    busy={busy}
                  />
                )}
              </>
            )}
          </div>
        )}

        {error && (
          <p className="ob__p" style={{ color: "var(--failed)", maxWidth: 460, marginTop: 16 }}>
            {error}
          </p>
        )}
      </div>

      <div className="ob__foot">
        Powered by{" "}
        <a href="https://github.com/openclaw/openclaw" target="_blank" rel="noreferrer">
          OpenClaw
        </a>
        {state.gateway.openclawVersion ? ` · ${state.gateway.openclawVersion}` : ""}
      </div>
    </div>
  );
}

function NameScreen({
  value,
  onChange,
  onNext,
  busy,
}: {
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="ob__card">
      <h1 className="ob__h">What should we call you?</h1>
      <input
        ref={ref}
        className="ob__input"
        value={value}
        maxLength={60}
        placeholder="Your name"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onNext();
        }}
      />
      <div className="ob__actions">
        <button className="btn btn--primary" disabled={!value.trim() || busy} onClick={onNext}>
          Continue
        </button>
      </div>
    </div>
  );
}

/**
 * NateBot does the OpenClaw setup itself — finds it, installs it if missing,
 * reads the gateway token straight out of config, starts the gateway. The user
 * never sees a token, because they never have to.
 */
function PreflightScreen({ preflight, name }: { preflight: PreflightState; name: string }) {
  const done = preflight.phase === "done";
  const failed = preflight.phase === "failed";
  return (
    <div className="ob__card">
      <h1 className="ob__h">
        {failed ? "Something's in the way." : done ? "Connected." : `Hi ${name || "there"}.`}
      </h1>
      {!failed && (
        <p className="ob__p">
          {done ? "Everything's set up. Nothing for you to configure." : "Setting things up…"}
        </p>
      )}
      <div className="pf">
        <div className="pf__line" data-done={done || failed}>
          {done || failed ? (
            <span className="pf__tick">{failed ? "✗" : "✓"}</span>
          ) : (
            <span className="pf__spinner" />
          )}
          {preflight.line}
        </div>
        {failed && preflight.detail && <div className="pf__detail">{preflight.detail}</div>}
      </div>
    </div>
  );
}
