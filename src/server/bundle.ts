import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NATEBOT_DIR } from "./db.js";
import { log } from "./log.js";

/**
 * Gives NateBot its own application identity.
 *
 * Electron's own binary announces itself as "Electron" — in the macOS Dock, in
 * the Windows taskbar, in a Linux window manager. That name comes from the
 * bundle or the executable, not from anything the app can set at runtime, so
 * the only real fix is to run from a bundle of our own.
 *
 * On macOS that means cloning Electron.app, rewriting its Info.plist and
 * re-signing it. APFS clones are copy-on-write, so this costs no meaningful
 * disk. Elsewhere it means running from a correctly-named copy of the binary.
 */

const APP_NAME = "NateBot";
const BUNDLE_ID = "com.nateajmera.natebot";

function run(cmd: string, args: string[]): boolean {
  const res = spawnSync(cmd, args, { stdio: "ignore" });
  return res.status === 0;
}

/**
 * Marker so the bundle is rebuilt when Electron is upgraded. It deliberately
 * lives *beside* the bundle rather than inside it: any extra file in the
 * bundle root breaks the code signature seal.
 */
function stampPath(dir: string): string {
  return `${dir}.build`;
}

function upToDate(dir: string, stamp: string): boolean {
  try {
    return existsSync(dir) && readFileSync(stampPath(dir), "utf8").trim() === stamp;
  } catch {
    return false;
  }
}

export type BrandedApp = { execPath: string; branded: boolean };

/**
 * Returns the executable NateBot should actually launch. Falls back to the
 * plain Electron binary whenever anything here fails — a wrong name in the
 * Dock is a blemish, not a reason to refuse to start.
 */
export function brandedExecutable(electronPath: string, packageRoot: string, version: string): BrandedApp {
  const fallback: BrandedApp = { execPath: electronPath, branded: false };
  try {
    if (process.platform === "darwin") return macBundle(electronPath, packageRoot, version) ?? fallback;
    return renamedBinary(electronPath, version) ?? fallback;
  } catch (err) {
    log.debug(`branding skipped: ${(err as Error).message}`);
    return fallback;
  }
}

function macBundle(electronPath: string, packageRoot: string, version: string): BrandedApp | null {
  // …/Electron.app/Contents/MacOS/Electron -> …/Electron.app
  const sourceApp = path.resolve(path.dirname(electronPath), "..", "..");
  if (path.extname(sourceApp) !== ".app") return null;

  const targetApp = path.join(NATEBOT_DIR, `${APP_NAME}.app`);
  const stamp = `${version}:${sourceApp}`;
  const execTarget = path.join(targetApp, "Contents", "MacOS", APP_NAME);

  if (upToDate(targetApp, stamp) && existsSync(execTarget)) {
    return { execPath: execTarget, branded: true };
  }

  mkdirSync(NATEBOT_DIR, { recursive: true });
  rmSync(targetApp, { recursive: true, force: true });

  // -c asks APFS for a clone: instant, and it shares storage with the original.
  if (!run("cp", ["-Rc", sourceApp, targetApp]) && !run("cp", ["-R", sourceApp, targetApp])) {
    return null;
  }

  const contents = path.join(targetApp, "Contents");
  const oldExec = path.join(contents, "MacOS", "Electron");
  if (existsSync(oldExec)) {
    if (!run("mv", [oldExec, execTarget])) return null;
  }
  if (!existsSync(execTarget)) return null;

  const icns = path.join(packageRoot, "assets", "icon.icns");
  if (existsSync(icns)) {
    copyFileSync(icns, path.join(contents, "Resources", `${APP_NAME}.icns`));
  }

  const plist = path.join(contents, "Info.plist");
  const set = (key: string, value: string) =>
    run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]) ||
    run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist]);

  set("CFBundleName", APP_NAME);
  set("CFBundleDisplayName", APP_NAME);
  set("CFBundleExecutable", APP_NAME);
  set("CFBundleIdentifier", BUNDLE_ID);
  set("CFBundleIconFile", `${APP_NAME}.icns`);
  set("CFBundleShortVersionString", version);
  set("CFBundleVersion", version);

  // Rewriting Info.plist invalidates Electron's signature, and macOS will kill
  // a signed bundle whose contents no longer match. An ad-hoc signature makes
  // it valid again for local use.
  run("codesign", ["--force", "--deep", "--sign", "-", targetApp]);

  writeFileSync(stampPath(targetApp), stamp);
  log.debug(`built ${targetApp}`);
  return { execPath: execTarget, branded: true };
}

/**
 * Windows and Linux take the name from the executable itself, so a copy under
 * the right name — beside the original, where its resources still resolve — is
 * enough to fix the taskbar entry and the window class.
 */
function renamedBinary(electronPath: string, version: string): BrandedApp | null {
  const dir = path.dirname(electronPath);
  const ext = process.platform === "win32" ? ".exe" : "";
  const target = path.join(dir, `${process.platform === "win32" ? APP_NAME : "natebot"}${ext}`);
  const stampFile = `${target}.natebot-build`;

  try {
    if (existsSync(target) && readFileSync(stampFile, "utf8").trim() === version) {
      return { execPath: target, branded: true };
    }
    copyFileSync(electronPath, target);
    if (process.platform !== "win32") run("chmod", ["+x", target]);
    writeFileSync(stampFile, version);
    return { execPath: target, branded: true };
  } catch (err) {
    log.debug(`could not create branded binary: ${(err as Error).message}`);
    return null;
  }
}
