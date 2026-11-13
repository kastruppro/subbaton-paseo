# SubBaton for Paseo

A compact subscription-usage footer, account popover, manual CLI actions and a full SubBaton settings screen (every CLI setting, poller, events and the automatic plan) for Claude, Codex and agy. React Native client surfaces support desktop/mobile; the server uses a bounded execFile bridge and a 15-second cache of `subbaton status --json`.

Owner setup: [docs/install.md](docs/install.md). Disposable-user gates: [docs/live-tests-plugin.md](docs/live-tests-plugin.md). Scope and SDK decisions: [docs/decisions.md](docs/decisions.md).

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm test
npm run typecheck
npm run build
```

Tests use a fake CLI. Build checks separate browser-safe client and Node server bundles; Paseo loads the TypeScript entries. No provider HTTP client, credential storage, telemetry or agent reload is implemented here. Future coordinated handoff must call agent.reload(); agent.refresh() is read-only.


Before every actual CLI run the plugin checks canonical ownership/permissions of the binary and all parents, then its Developer ID/team/identifier. PATH lookup is explicit opt-in, off by default. Abnormal mutations require recovery inspection; status/configuration failures have a short negative cache. Named switches accept known UUIDs only. Unknown schema additions remain visible as unknown/read-only. The footer stays on one measured line; SDK 0.15.3 still requires host-scoped preferences.

Phase 6b settings: the "SubBaton settings" screen renders every field from `subbaton settings get --json` metadata and sends one provider batch per Apply through `settings set --json-input -` (stdin, expected revision required). Release/resume actions, poller install/uninstall, events and `auto plan` use fixed allowlisted argv. See docs/decisions.md.

Phase 6b handoff: "When idle" (Codex/agy) waits until every Paseo agent of that provider is idle, lets the CLI switch (agy with `--stop-agy`), requires a verified result and reopens the affected agents with `agent.reload()`. Codex agents are also reloaded after automatic switches. See docs/decisions.md.



## Extra trusted Codex executable owners (owner decision, 2026-11-13)

The Codex settings tab renders the CLI’s `trustedExecutableOwners` array as a comma-separated local-account field. The default is empty; list at most eight distinct existing local user names (for example a dedicated Homebrew service account). The CLI resolves names and refuses unknown names with `invalidTrustedExecutableOwners`, shown inline while retaining the draft. The host validates shape and bounds before calling the CLI; it never resolves Mac accounts on the phone or relay. This setting is Codex-only and bumps the revision.

Automatic restarts require the executable, any Node interpreter and every parent directory to be owned by the current user, root or one of the listed users, with no group/world write. Group membership never grants trust. Names that no longer resolve grant no UID at runtime. The CLI rechecks ownership immediately before launch; idle/coordinator guards are unchanged.
