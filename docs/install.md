# Local installation

Use Paseo **0.15.3 or newer** on both daemon and client, and the signed SubBaton phase-1b CLI. The plugin is trusted, unsandboxed code; install only on the intended daemon. Development did not install it or change the running daemon.

1. Verify the signed CLI and copy it to the default shared location, or set its absolute path later under the plugin's settings:

```sh
/usr/bin/codesign --verify --strict --verbose=2 /path/to/subbaton-app/build/subbaton
mkdir -p /Users/Shared/subbaton
install -m 755 /path/to/subbaton-app/build/subbaton /Users/Shared/subbaton/subbaton
/usr/bin/codesign --verify --strict --verbose=2 /Users/Shared/subbaton/subbaton
```

Expected identifier dk.kastruppro.subbaton, Team 5W98EXLE44, hardened runtime and secure timestamp. Do not re-sign ad hoc. The default shared path falls back to `subbaton` on the daemon's PATH only if unavailable; a custom path never silently falls back.

2. As the account whose subscriptions you intend to manage, bootstrap safe snapshots once. These list commands use the signed CLI's vault; the plugin itself never reads credentials:

```sh
/Users/Shared/subbaton/subbaton list --json
/Users/Shared/subbaton/subbaton codex list --json
/Users/Shared/subbaton/subbaton agy list --json
/Users/Shared/subbaton/subbaton status --json
```

Skip providers you have not configured; their snapshot remains missing. Add/login operations are documented in the app's live-test checklists. A missing snapshot is not proof of no accounts.

3. Verify this exact local plugin checkout, then install it:

```sh
cd /path/to/subbaton-paseo
npm ci --ignore-scripts --legacy-peer-deps
npm test
npm run typecheck
npm run build
paseo plugin install /path/to/subbaton-paseo
paseo plugin ls
paseo plugin logs subbaton
```

For another daemon, add its normal `--host` selector to the plugin commands and install a path on that host. Local source stays at this worktree path; keep it while installed. The host compiles TypeScript entrypoints; build/ bundles are verification artifacts, not copied into Paseo. Runtime React, React Native, SDK, query and Zod libraries are supplied by Paseo; npm dependencies here are development-only.

If plugins are globally disabled, the owner must explicitly enable trusted plugins in **Settings → Plugins → Enable plugins** on that daemon. Backend plugins can access that daemon's files/processes/network; client plugins run inside Paseo. Do not bypass the global trust switch or restart the daemon. Confirm `subbaton` reaches running with no load error.

4. **Disable Paseo's built-in Claude and Codex usage sources** to avoid duplicate polling. Find their exact runtime IDs in `paseo plugin ls` (normally claude-usage-source and codex-usage-source), then:

```sh
paseo plugin disable claude-usage-source
paseo plugin disable codex-usage-source
paseo plugin ls
```

Do not disable providers themselves. Stop other subscription usage monitors too. The SubBaton footer reads cache only; it does not replace the future poll owner. Until phase 4, explicitly press Refresh now or use CLI usage commands for new quota. CLI request floors/backoff still apply.

5. Open **Settings → Plugins → SubBaton**. Save the binary path if different, choose always-visible active-account windows and warning/danger thresholds. Settings are host-scoped in SDK 0.15.3, shared across authorized clients. Extra agy/model windows become selectable after a verified CLI usage reading. In **Settings → Sidebar**, show/reorder SubBaton usage if needed.

Tap the footer for all cached accounts, reset/login-expiry dates and manual actions. Best/next-available currently apply to Claude only; named switches cover all providers. Finish agy sessions before switching; v1 never sends stop/force/restart flags or reopens agents. Exit-2/timeouts show uncertainty and require state/recovery inspection, not repeated clicks.

After source updates, rerun typecheck/tests/build and use `paseo plugin reload subbaton`; check ls/logs. Do not restart the daemon. Disable/remove with `paseo plugin disable subbaton` / `paseo plugin remove subbaton`; local source is retained. See live-tests-plugin.md before daily use. A later coordinated handoff must use **agent.reload()**; agent.refresh() only reads state.
