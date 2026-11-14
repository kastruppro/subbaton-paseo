# SubBaton for Paseo

> [!WARNING]
> **Early alpha.** This plugin is experimental and changes often. Settings, commands and the JSON contract with the SubBaton CLI may break between versions. It switches the logins of your coding-agent subscriptions, so read [docs/install.md](docs/install.md) before you use it, and don't rely on it for anything important yet.

A [Paseo](https://paseo.sh) plugin for the SubBaton account switcher. It shows subscription usage for Claude Code, Codex and Antigravity (agy) in Paseo's sidebar, and lets you switch accounts and manage SubBaton's settings from any Paseo client.

## What it does

- **Usage footer:** selected quota windows of the active accounts, with warning and danger colours. Tap it for all saved accounts, reset times and login expiry.
- **Switching:** named switches for Claude, Codex and agy; best/next-available strategies for Claude.
- **"When idle" handoff:** for Codex and agy, waits until every Paseo agent of that provider is idle, lets the CLI switch, and reopens the agents with `agent.reload()` so they continue under the new login.
- **Reload after every verified Codex switch:** also when you switch in the SubBaton menu bar app, in a terminal, or when the background poller switches automatically. Only idle agents are reloaded; terminal Codex sessions are never killed.
- **Settings screen:** every SubBaton CLI setting, the background poller, events and the automatic plan.

## Requirements

- macOS with the **SubBaton app**, which installs and updates the signed `subbaton` CLI. The app is not publicly released yet.
- Paseo 0.15.3 or newer on the daemon and clients.

## How it works

The plugin holds no credentials and makes no network calls to model providers. It runs the local `subbaton` CLI with fixed argument lists and reads its JSON output. Status is cached for 15 seconds.

Before every run it checks the CLI binary:

- the canonical path, and that the file and every parent directory are owned by root or the current user, with no group or world write;
- the Developer ID team and code signing identifier.

PATH lookup is off by default. Switches accept only account IDs from the last status. An uncertain or failed mutation is shown as such and must be inspected before you retry.

The default CLI path is `$HOME/Library/Application Support/SubBaton/bin/subbaton`, resolved from the daemon user's account, not from `HOME`.

## Install and update

See [docs/install.md](docs/install.md). In short:

```sh
paseo plugin install https://github.com/kastruppro/subbaton-paseo.git --id subbaton
paseo plugin update subbaton
```

## Development

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm test
npm run typecheck
npm run build
```

Tests use a fake CLI. Paseo compiles the TypeScript entries itself; `npm run build` only checks that the browser-safe client and the Node server bundles build.
