import type { GatewayClient } from "./gateway/client.js";
import { log } from "./log.js";

/**
 * The filmstrip needs OpenClaw's browser tool, which is off by default and
 * which the `coding` tool profile does not include. A new user should never
 * have to know that, so NateBot turns it on for them.
 *
 * This is deliberately a one-time repair, not something applied on every
 * launch: enabling it needs a gateway restart, and doing that repeatedly would
 * make the app feel broken. If the user turns it back off, we leave it off.
 */

export type BrowserSetup = { changed: boolean; reason: string };

type Cfg = Record<string, unknown>;

function get(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Cfg)[key];
  }
  return cur;
}

export async function ensureBrowserEnabled(gateway: GatewayClient): Promise<BrowserSetup> {
  let snapshot: { hash: string; config: Cfg };
  try {
    snapshot = await gateway.request<{ hash: string; config: Cfg }>("config.get", {});
  } catch (err) {
    return { changed: false, reason: `could not read config: ${(err as Error).message}` };
  }

  const cfg = snapshot.config ?? {};
  // `browser.enabled` defaults to true, so only an explicit false counts as off.
  const browserOff = get(cfg, "browser", "enabled") === false;
  const pluginOff = get(cfg, "plugins", "entries", "browser", "enabled") === false;

  const profileAllows = (() => {
    const also = get(cfg, "tools", "alsoAllow");
    if (Array.isArray(also) && also.includes("browser")) return true;
    // Profiles other than `coding` may already include it; only `coding` is
    // known to leave it out.
    return get(cfg, "tools", "profile") !== "coding";
  })();

  if (!browserOff && !pluginOff && profileAllows) {
    return { changed: false, reason: "already enabled" };
  }

  const patch: Cfg = {};
  if (browserOff) patch.browser = { enabled: true };
  if (pluginOff) patch.plugins = { entries: { browser: { enabled: true } } };
  if (!profileAllows) {
    const also = get(cfg, "tools", "alsoAllow");
    const next = Array.isArray(also) ? [...new Set([...also, "browser"])] : ["browser"];
    patch.tools = { alsoAllow: next };
  }

  try {
    await gateway.request("config.patch", {
      raw: JSON.stringify(patch),
      baseHash: snapshot.hash,
      replacePaths: ["tools.alsoAllow"],
    });
  } catch (err) {
    // Enabling the browser makes the gateway reload, which can cut the reply
    // off mid-flight. That is success, not failure.
    const message = (err as Error).message;
    if (!/timed out|closed/i.test(message)) {
      return { changed: false, reason: `could not enable the browser tool: ${message}` };
    }
  }

  log.debug("enabled OpenClaw's browser tool");
  return { changed: true, reason: "enabled the browser tool" };
}
