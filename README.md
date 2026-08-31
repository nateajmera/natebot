# NateBot

Manage your AI agents from a clean, simple desktop app.

Set it up in under a minute. No config files, no terminal.

```bash
npm install -g natebot
```

Then run:

```bash
natebot
```

NateBot starts a local server, opens in your browser, and does the setup for
you — it finds OpenClaw (installing it if you don't have it), reads your
gateway token straight out of your config, and starts the gateway. You never
see a token or edit a file.

Everything is local. Your bots, their threads, and their history live on your
own machine in `~/.natebot`, and the app only ever listens on `127.0.0.1`.

## What you get

- **A manager bot.** Tell it what you want done and it proposes a team. It
  can't create anything itself — it hands you a plan, and nothing runs until
  you approve it.
- **Bots as people.** Harry, John, Sam — each with its own workspace, model,
  tools, and thread.
- **The work, not just the answer.** An agent turn is a dozen tool calls, so
  each one collapses to `6 steps · 2m` and expands into what actually ran.
- **Approvals in the thread.** When a bot needs you, the question appears
  where it happened and stays in history after you answer.
- **Every bot scoped on its own.** Files, terminal, the web, browser, memory,
  schedules, your other bots, and each connection you've added — switched on or
  off per bot, from that bot's own card. The bot reading your email doesn't need
  a terminal. Nothing here configures globally, which is why there's no settings
  screen with forty controls.

## Requirements

- Node 24 or newer
- macOS, Linux, or Windows
- An account with one of Claude, OpenAI, xAI, or Google — NateBot detects what
  you already have and defaults to it

## Development

```bash
npm install
npm run build
npm start
```

`npm run typecheck` covers both the server and the web app, and `npm test`
runs the suite.

The server lives in `src/server` (Node, no framework, `node:sqlite` for
storage) and the web app in `src/web` (React + Vite). The server holds the
single WebSocket connection to the OpenClaw gateway and fans events out to the
browser, so the gateway token never leaves the Node process.

A bot's scope is stored as an OpenClaw deny list (`agents.list[].tools.deny`),
never an allow list. A bot starts able to do everything and you take things
away, so a bot nobody has scoped has no config footprint at all and keeps
working untouched across upgrades. Scope changes are written as
`id -> stays on` intent, where anything absent keeps whatever was already
stored — a switch you didn't touch is never changed by one you did.

## Powered by OpenClaw

NateBot is a client. The agents, tools, gateway, and scheduling are all
[OpenClaw](https://github.com/openclaw/openclaw), which is MIT licensed —
copyright (c) OpenClaw contributors. NateBot is not affiliated with or
endorsed by the OpenClaw project.

## License

MIT
