#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const [major] = process.versions.node.split(".").map(Number);
if (major < 24) {
  process.stderr.write(
    `\n  NateBot needs Node 24 or newer (you have ${process.versions.node}).\n` +
      `  https://nodejs.org\n\n`,
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    `\n  NateBot — manage your AI agents from a clean, simple desktop app.\n\n` +
      `  natebot              Open the NateBot app\n` +
      `  natebot --headless   Run the server only, and print its address\n` +
      `  natebot --version    Print the version\n\n`,
  );
  process.exit(0);
}

/** Server-only mode, for anyone who would rather stay in the terminal. */
if (argv.includes("--headless") || process.env.NATEBOT_HEADLESS === "1") {
  const { main } = await import(path.join(root, "dist", "server", "index.js"));
  await main(pkg.version);
} else {
  // Electron ships its own Node, so the desktop shell has to be re-executed
  // under that binary rather than started in this process.
  let electronPath;
  try {
    ({ default: electronPath } = await import("electron"));
  } catch {
    electronPath = null;
  }

  if (!electronPath) {
    process.stderr.write(
      `\n  NateBot's app shell isn't installed.\n` +
        `  Reinstall with \`npm i -g natebot\`, or run \`natebot --headless\`\n` +
        `  to use it in your browser instead.\n\n`,
    );
    process.exit(1);
  }

  // Run from a bundle that carries NateBot's own name and icon, so the Dock,
  // taskbar and window manager don't announce it as Electron.
  let execPath = electronPath;
  try {
    const { brandedExecutable } = await import(path.join(root, "dist", "server", "bundle.js"));
    ({ execPath } = brandedExecutable(electronPath, root, pkg.version));
  } catch {
    // Branding is cosmetic; never let it stop the app from opening.
  }

  const child = spawn(execPath, [path.join(root, "dist", "server", "desktop.js"), ...argv], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_NO_ATTACH_CONSOLE: "1" },
  });
  child.on("close", (code) => process.exit(code ?? 0));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
}
