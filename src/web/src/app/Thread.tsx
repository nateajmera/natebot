import { useEffect, useRef } from "react";
import { Avatar, type AvatarState } from "../design/Avatar";
import { Composer } from "./Composer";
import { StepRow } from "./StepRow";
import { ApprovalCard } from "./ApprovalCard";
import { PlanCard } from "./PlanCard";
import { TakeoverCard } from "./TakeoverCard";
import { extractPlan, extractSignIn, stripPlan, stripSignIn, visibleProse } from "../lib/plan";
import { Markdown } from "../lib/markdown";
import type { ApprovalDecision, Bot, ModelRecord, Plan, ThreadItem } from "../lib/types";

export type ThreadState = {
  items: ThreadItem[];
  streaming: { runId: string; text: string } | null;
  loaded: boolean;
};

export function Thread({
  bot,
  bots,
  thread,
  models,
  state,
  prefill,
  detailsOpen,
  onToggleDetails,
  onSend,
  onStop,
  onResolveApproval,
  onApprovePlan,
  onOpenSignIn,
}: {
  bot: Bot;
  bots: Bot[];
  thread: ThreadState;
  models: ModelRecord[];
  state: AvatarState;
  prefill?: string;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onSend: (text: string, opts: { model?: string; thinking?: string }) => void;
  onStop: () => void;
  onResolveApproval: (id: string, decision: ApprovalDecision, note?: string) => void;
  onApprovePlan: (plan: Plan) => Promise<void>;
  onOpenSignIn: (url: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const running = state === "working";

  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [thread.items, thread.streaming]);


  const statusLabel =
    state === "working"
      ? "Working"
      : state === "attention"
        ? "Needs you"
        : state === "failed"
          ? "Something failed"
          : "";

  return (
    <div className="thread">
      <div className="thread__head">
        <button className="thread__title" onClick={onToggleDetails} aria-expanded={detailsOpen}>
          <Avatar
            kind={bot.kind}
            colorIndex={bot.colorIndex}
            faceIndex={bot.faceIndex}
            state={state}
            size={26}
          />
          <span className="thread__name">{bot.name}</span>
          {statusLabel && <span className="thread__status">{statusLabel}</span>}
        </button>
        <span className="thread__spacer" />
      </div>

      <div
        className="scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        <div className="stream">
          {thread.items.length === 0 && !thread.streaming && (
            <p className="note" style={{ textAlign: "center", padding: "40px 0" }}>
              {bot.kind === "manager"
                ? `Ask ${bot.name} for anything — a new bot, a status check, a schedule change.`
                : `Say something to ${bot.name}.`}
            </p>
          )}

          {thread.items.map((item) => {
            if (item.kind === "run") return <StepRow key={item.id} run={item.run} />;

            if (item.kind === "approval") {
              return (
                <ApprovalCard
                  key={item.id}
                  payload={item.payload}
                  resolved={item.resolved}
                  onResolve={(decision, note) => onResolveApproval(item.id, decision, note)}
                />
              );
            }

            if (item.role === "user") {
              return (
                <div className="msg msg--user" key={item.id}>
                  <div className="msg__body">{item.text}</div>
                </div>
              );
            }

            // A manager reply may carry a plan; a worker may be blocked on a
            // login wall. Either way: the prose, then the card, never the fence.
            const plan = bot.kind === "manager" ? extractPlan(item.text) : null;
            const signIn = bot.kind === "worker" ? extractSignIn(item.text) : null;
            const prose = plan
              ? stripPlan(item.text)
              : signIn
                ? stripSignIn(item.text)
                : item.text;
            return (
              <div className="msg msg--assistant" key={item.id}>
                {prose && (
                  <div className="msg__body msg__body--md">
                    <Markdown text={prose} />
                  </div>
                )}
                {signIn && (
                  <div style={{ marginTop: prose ? 12 : 0 }}>
                    <TakeoverCard
                      request={signIn}
                      botName={bot.name}
                      onOpen={() => onOpenSignIn(signIn.url)}
                      onContinue={() =>
                        onSend(
                          `I've signed in to ${signIn.site}. Carry on from where you stopped.`,
                          {},
                        )
                      }
                    />
                  </div>
                )}
                {plan && (
                  <div style={{ marginTop: prose ? 12 : 0 }}>
                    <PlanCard
                      plan={plan}
                      startIndex={bots.filter((b) => b.kind === "worker").length}
                      existing={bots}
                      onApprove={() => void onApprovePlan(plan)}
                      onChange={(note) => onSend(note, {})}
                    />
                  </div>
                )}
              </div>
            );
          })}

          {thread.streaming && (
            <div className="msg msg--assistant">
              <div className="msg__body msg__body--md">
                <Markdown text={visibleProse(thread.streaming.text)} />
                <span className="msg__cursor" />
              </div>
            </div>
          )}
        </div>
      </div>

      <Composer
        bot={bot}
        models={models}
        running={running}
        prefill={prefill}
        onSend={onSend}
        onStop={onStop}
      />
    </div>
  );
}
