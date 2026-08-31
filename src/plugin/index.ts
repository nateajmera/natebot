import { classify, describe } from "./actions.js";

/**
 * NateBot's guardrail, running inside OpenClaw.
 *
 * OpenClaw's own approvals cover shell commands; nothing gates MCP tool calls.
 * So anything a connector can do — send a Slack message, issue a Stripe refund
 * — would otherwise happen silently. This hook stops those and asks first.
 *
 * Reads pass straight through. A denial blocks the call, and so does a
 * timeout: if nobody is at the keyboard, the action does not happen.
 */
type ToolEvent = {
  toolName: string;
  params: Record<string, unknown>;
  agentId?: string;
};

type PluginApi = {
  on: (event: string, handler: (event: ToolEvent) => unknown) => void;
};

function register(api: PluginApi): void {
  api.on("before_tool_call", (event: ToolEvent) => {
    const verdict = classify(event.toolName);
    if (!verdict.needsApproval) return;

    const who = event.agentId ? event.agentId : "A bot";
    const detail = describe(event.toolName, event.params ?? {});

    return {
      requireApproval: {
        // The gateway caps these at 80 and 256 characters.
        title: `${who} wants to ${verdict.verb}`.slice(0, 80),
        description: (
          detail
            ? `${detail}. This acts in your name and cannot be undone by NateBot.`
            : `This acts in your name and cannot be undone by NateBot.`
        ).slice(0, 256),
        severity: verdict.severity,
        // Nothing that spends or destroys gets a standing yes.
        allowedDecisions:
          verdict.severity === "critical"
            ? ["allow-once", "deny"]
            : ["allow-once", "allow-always", "deny"],
        timeoutMs: 120_000,
        // Silence is not consent.
        timeoutBehavior: "deny",
      },
    };
  });
}

/**
 * Exported as a plain entry object rather than through the SDK's
 * `definePluginEntry` helper: that helper is a typing convenience, and
 * importing it would make NateBot depend on the whole OpenClaw package for
 * nothing. OpenClaw loads this at runtime, where the SDK already exists.
 */
export default {
  id: "natebot-guardrail",
  name: "NateBot Guardrail",
  register,
};
