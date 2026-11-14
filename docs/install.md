# Install and update

> **Early alpha.** Expect breaking changes. The plugin is trusted, unsandboxed code that runs on your Paseo daemon; install it only on a daemon you control.

## Requirements

- Paseo **0.15.3 or newer** on the daemon and clients.
- The SubBaton macOS app, with its CLI installed: open the app and choose **Settings > Background > Install**. This puts the signed CLI at `$HOME/Library/Application Support/SubBaton/bin/subbaton`, and the app keeps it updated.

## 1. Check the CLI

Run these once, as the account whose subscriptions you want to manage. They only read SubBaton's own state; the plugin itself never reads credentials.

```sh
"$HOME/Library/Application Support/SubBaton/bin/subbaton" status --json
"$HOME/Library/Application Support/SubBaton/bin/subbaton" list --json
```

## 2. Install the plugin

```sh
paseo plugin install https://github.com/kastruppro/subbaton-paseo.git --id subbaton
paseo plugin ls
paseo plugin logs subbaton
```

`subbaton` should be `running` with no error. If plugins are disabled, enable them under **Settings → Plugins → Enable plugins** on that daemon. For another daemon, add its `--host` selector.

To install a specific release instead of the default branch, add `--ref <tag>`.

## 3. Disable duplicate usage sources

Paseo's built-in Claude and Codex usage sources poll the same endpoints. Disable them (not the providers themselves):

```sh
paseo plugin disable claude-usage-source
paseo plugin disable codex-usage-source
```

## 4. Configure

Open **Settings → Plugins → SubBaton**:

- **CLI path:** leave the default unless your CLI is elsewhere. PATH lookup is off by default; turn on "Allow verified PATH lookup" only if you want it. A custom path never falls back to another location.
- **Footer:** choose which windows of the active accounts are always visible, and the warning and danger thresholds.
- **Codex:** "Reload Codex agents after every verified switch" reloads idle Paseo Codex agents after every verified Codex switch. "Restart the shared Codex daemon at the idle boundary" is off by default.

Settings are stored per daemon and shared by all clients connected to it.

## Update

```sh
paseo plugin update subbaton --check
paseo plugin update subbaton
```

Updates keep the plugin's settings. Don't update while a switch is running.

## Remove

```sh
paseo plugin remove subbaton
```

Removing deletes the plugin's settings. Native logins and SubBaton's own data are not touched.

## Binary trust checks

Before every CLI run the plugin verifies:

- the canonical path, and that the file and every parent directory are owned by root or the current user, with no group or world write (a root-owned sticky `/Users/Shared` is allowed as an ancestor for older custom installs, never as the direct parent);
- the code signature: Developer ID, team `5W98EXLE44`, identifier `dk.kastruppro.subbaton`.

An abnormal result (crash, timeout, partial output, exit code 2) is shown as uncertain. Inspect the state before you retry.
