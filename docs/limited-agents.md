# Limited Codex agent continuation: compatibility gate (0.9.0)

Setting: `resumeLimitedCodexAgents` (host-scoped, default on, all workspaces on this host). It works with the daemon restart opt-in off. Code: `server/limited-agents.ts`, wired in `server/handoff-host.ts`; adoption comes from `server/handoff.ts`. Nothing here was run against a real Paseo agent, account or the owner's home.

## What was verified (2026-11-15)

Sources: `@getpaseo/plugin` 0.15.3 and `@getpaseo/client` type definitions in `node_modules` (the contract the plugin is built against) and the checked-in Paseo docs (`research/paseo/docs/hooks.md`, `sdk-agents.md`). Installed app: `/Applications/Paseo.app` is 0.15.4 (`Info.plist`).

| Question | Evidence |
|---|---|
| Hook names | `agent.turn.before` `{agent, turnId}`, `agent.turn.after` `{agent, turnId, outcome}`, `agent.archive.after` `{agent, archivedAt}` (`dist/server/lifecycle.d.ts`). The old `server.on("agent.turn_ended")` names are deprecated aliases, removed after 2027-04-30; the plugin uses `addHook`. Hooks do not wait (`waits: false`). |
| Latest-turn error shape | The hook's `outcome` is `completed`, `failed` with `error: {message, code?}`, or `canceled` with `reason`. The `timeline` field on the event is deprecated and always empty. Timeline items (`type: "error"`) carry no turn ID, so the plugin does not read the timeline at all: it uses the failed outcome of the hook itself, which names exactly one turn. |
| Cancellation ordering | One turn has exactly one outcome, so a limited turn cannot also be `canceled`. A later stop or message is a new turn (`agent.turn.before`) or a `canceled` outcome, and both clear the candidate. |
| Reload / send | `agents.ref(id).reload({requestId})` reopens the session and interrupts a running turn (existing handoff already relies on it). `agents.ref(id).send(text)` sends one message without replaying attachments or tool calls. Both are on the `PaseoApi` the hook context provides; the plugin manifest has no separate permission list. |
| Archive | `agent.archive.after` clears the candidate; the agent list is read with `includeArchived: false`. |

## Positive evidence used

Only Codex agents (`provider === "codex"`), only a `failed` outcome, and only when `error.code` is `usage_limit_reached` or the message **starts with** "You've hit your usage limit" (the real text Codex wrote in `lastError` of a persisted agent, see research/paseo/limited-agents.md). Quotes, prompts, output or a later mention never match. A missing turn ID is ambiguous and ineligible.

## Not verifiable here (fail closed)

1. **The real structured error code.** `usage_limit_reached` is Codex's own name for the condition but was not seen in a live hook payload. The anchored message is the working evidence; if Codex words it differently, no continuation happens.
2. **The installed 0.15.4 bundle itself.** Reading `app.asar` needed a download tool that was denied, so only the SDK types and docs were checked. Behaviour of the 0.15.4 daemon (for example whether an errored agent reports status `error` or `idle`) is unverified. The plugin therefore accepts `idle` or `error` before the reload and requires `idle` and no active turn after it.
3. **Whether `send` after `reload` is allowed for a plugin from a hook on a remote client's session.** The server-side hook context is used, so it does not depend on a desktop or phone being open.

All three are covered by the disposable-agent live gate (testuser, not the owner's accounts): a positively limited turn, a switch with daemon restart, exactly one continuation across two workspaces; a cancelled agent and a second limited account must not loop.

## Algorithm (as implemented)

- **Candidate:** agent ID + turn ID, in memory only, recorded when the limit failure ends a turn and the setting is on. A new turn, cancellation, archive, completion or a user message clears it. Plugin restart loses candidates; history is never scanned.
- **Adoption:** a verified Codex switch with a known identity. Manual switches are keyed by the CLI transaction (`txn:…`), automatic ones by the switch event they follow (and its time). Evidence (research/reviews/codex-switch-incident-2026-11-14.md, 16:55): reloading a Paseo Codex agent starts new app-server processes that re-read `auth.json`, so a Paseo agent adopts the new login by being reloaded; the shared daemon restart matters for terminal TUIs, not for a Paseo agent. The 0.8.1 reload-only handoff relies on the same behaviour. So the plugin's own reload of the limited agent is the adoption step, and **no daemon restart is required** (route 1). A successful daemon restart of the same handoff is not a separate condition any more, it only means the switch was verified (route 2 is the same adoption, reached through the idle-boundary restart). The setting never turns the daemon restart on. A handoff with no switch identity (for example a restart that is merely pending from an unknown switch) is never adopted. A newer adoption supersedes a pending one. Candidates whose limit ended at or after the switch time (a second limited account on the new login) are ineligible, also when adoption happens later (automatic switches adopt at the idle boundary but keep the event time).
- **Same login:** the active Codex account (fresh, cache-only status) must be the switch target at adoption (manual switch) and still the same account right before and right after each reload; if it changed, nothing is reloaded or sent.
- **Per candidate:** recheck latest turn, not busy, `idle`/`error`, still listed (not archived), setting on, login current. The attempt is consumed (persisted) before the reload, so a failed reload or send is never retried for that switch. Reload, recheck (now `idle`), then one message: "Continue the previous task from where it stopped because of the usage limit." At most one attempt per candidate turn and switch. Candidates whose limit ended after the adoption (a second limited account) are ineligible.
- **No loops:** a continuation we sent is tracked (`lineage`, persisted). If its turn ends in a limit again the agent is suppressed until a turn we did not send (user activity) starts. A completed continuation ends the lineage.
- **State file:** `~/Library/Application Support/SubBaton Paseo/limited-agents-v1.json` (owner-only, atomic, bounded): consumed attempt keys, suppressed agent IDs, lineage. No messages, tokens or prompts. An unreadable file means nothing is recorded or sent.
- Daemon reload of other idle agents (existing handoff) never grants continuation permission.
