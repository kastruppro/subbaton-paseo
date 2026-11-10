# SubBaton for Paseo

A compact subscription-usage footer, account popover and manual CLI actions for Claude, Codex and agy. React Native client surfaces support desktop/mobile; the server uses a bounded execFile bridge and a 15-second cache of `subbaton status --json`.

Owner setup: [docs/install.md](docs/install.md). Disposable-user gates: [docs/live-tests-plugin.md](docs/live-tests-plugin.md). Scope and SDK decisions: [docs/decisions.md](docs/decisions.md).

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm test
npm run typecheck
npm run build
```

Tests use a fake CLI. Build checks separate browser-safe client and Node server bundles; Paseo loads the TypeScript entries. No provider HTTP client, credential storage, telemetry or agent reload is implemented here. Future coordinated handoff must call agent.reload(); agent.refresh() is read-only.
