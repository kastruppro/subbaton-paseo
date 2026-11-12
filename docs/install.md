# Local installation

Use Paseo **0.15.3 or newer** on both daemon and client, and the signed SubBaton phase-1b CLI. The plugin is trusted, unsandboxed code; install only on the intended daemon. Development did not install it or change the running daemon.

1. Verify the signed CLI and copy it to the default shared location, or set its absolute path later under the plugin's settings. Inspect any pre-existing /Users/Shared/subbaton directory first: it must belong to root or your current user and must not be group/world-writable. Do not reuse a folder planted by another local user; have the owner repair/remove it through normal administrative controls. The plugin refuses untrusted custody before executing anything:

```sh
/usr/bin/codesign --verify --strict --verbose=2 /path/to/subbaton-app/build/subbaton
install -d -m 755 /Users/Shared/subbaton
install -m 755 /path/to/subbaton-app/build/subbaton /Users/Shared/subbaton/subbaton
/usr/bin/codesign --verify --strict --verbose=2 /Users/Shared/subbaton/subbaton
```

Expected identifier dk.kastruppro.subbaton, Team 5W98EXLE44, hardened runtime and secure timestamp. Do not re-sign ad hoc. PATH lookup is **off by default**. Enable “Allow verified PATH lookup” explicitly in the host settings before using `subbaton` on PATH or permitting fallback from a missing default. A missing custom absolute path never falls back. Every actual execution verifies the canonical file and all parents: root/current-user ownership, no group/world write, plus Developer ID/team/identifier through codesign. Root-owned sticky /Users/Shared is the only writable ancestor exception and cannot be the direct parent.

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

5. Open **Settings → Plugins → SubBaton**. Save the binary path if different; leave verified PATH lookup disabled unless you intend to use it. Choose always-visible active-account windows and warning/danger thresholds. Settings are host-scoped in SDK 0.15.3, shared across authorized clients. The one-line strip drops detail then shows +N on narrow layouts; all pins remain in the popover. Extra agy/model windows become selectable after a verified CLI usage reading. In **Settings → Sidebar**, show/reorder SubBaton usage if needed.

Tap the footer for all cached accounts, reset/login-expiry dates and manual actions. Best/next-available currently apply to Claude only; named switches cover all providers. Finish agy sessions before switching; v1 never sends stop/force/restart flags or reopens agents. Every abnormal mutation result (kill/crash/overflow/partial output/inconsistent envelope/exit 2) shows uncertainty and require state/recovery inspection, not repeated clicks.

Named switch RPCs accept only known account UUIDs from the last status. Strategies have separate explicit actions. Unknown additive health/providers show unknown without hiding supported accounts. Failed status/configuration checks back off for 15 seconds; saving settings clears that backoff. Global refresh errors are not assigned to a provider. Inferred reset quota has an ≈ marker even when labels shrink.

Avoid reload/stop during an action. Teardown does not deliberately cancel a transaction child; transport loss still requires state/recovery inspection. After source updates, rerun typecheck/tests/build and use `paseo plugin reload subbaton`; check ls/logs. Do not restart the daemon. Disable/remove with `paseo plugin disable subbaton` / `paseo plugin remove subbaton`; local source is retained. See live-tests-plugin.md before daily use. A later coordinated handoff must use **agent.reload()**; agent.refresh() only reads state.

## Update the shared testuser installation

The owner-approved popover redesign uses the same plugin ID, runtime requirements and binary trust checks. Do not install/reload while an action is running.

After tests/typecheck/build are green, run this from a **root shell**. This updates the existing root-controlled shared checkout; it does not run the CLI or provider processes:

```sh
rsync -a --delete --exclude='.git' --exclude='node_modules' --exclude='build' /path/to/subbaton-paseo/ /Users/Shared/subbaton/paseo-plugin/
chown -R root:wheel /Users/Shared/subbaton/paseo-plugin
chmod -R go-w /Users/Shared/subbaton/paseo-plugin
```

Then, in **testuser's shell**, reload the already installed shared-path plugin:

```sh
paseo plugin reload subbaton
paseo plugin ls
paseo plugin logs subbaton
```

No daemon restart is needed. Keep the CLI path and saved pins/settings as they are. The host compiles the shared source; build/ and node_modules are not deployed. Validate desktop/mobile appearance, Enter/Space row expansion, visible keyboard focus, actions/uncertainty messages, and disabled built-in usage sources using live-tests-plugin.md.
