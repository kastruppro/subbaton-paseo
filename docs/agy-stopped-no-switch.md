# agy: stopped sessions without a switch (0.9.6)

`agy auto run-once --stop-agy` may stop the permitted sessions, renew stale candidate accounts and then choose not to switch. The CLI returns `outcome: "stoppedNoSwitch"` with `stoppedProcesses`, `resumeCommands`, `manualResumeRequired` and `candidateRenewal`.

The plugin classifies it as `stoppedNoSwitch` (neither a failure nor a switch). The handoff reopens the affected Paseo agy agents with `agent.reload()`, exactly as after a switch (the saved conversation is the resume; `agy --conversation` is for sessions outside Paseo), and ends with "no switch was needed". No adoption happens. A `stoppedNoSwitch` that names no stopped session, and any `uncertain` outcome, stay uncertain. The plugin's manual agy handoff uses `agy switch`, which does not renew, so it never receives this outcome.

## Classification rules

- Any `agy auto run-once` result that lists stopped sessions (`stoppedProcesses`) and is not a verified switch, a failure or `uncertain` is `stoppedNoSwitch` when it carries resume metadata (`resumeCommands`, `manualResumeRequired`), whatever its `outcome` says (`stay`, `blocked`, `revalidated`, `deferred`, `held`, and also `off` or `paused` when the setting changed during the renewal minute). Without the metadata it is uncertain. It is never "nothing was stopped": the stopped agents are always reopened.
- `manualResumeRequired: true` (a stopped session had no conversation ID) is added to the handoff message, so the owner can see why an agent may start without its thread.
- `agy auto plan` with `blockedOnlyByProcesses: true` and `stopReason: "renewCandidates"` triggers the same `run-once --stop-agy --only-pids` even when `targetIfProcessesStopped` is null (renewal decides the target). The owner settings and the idle rules are unchanged.
- Accepted: the "no switch was needed" and no-saved-conversation wording is kept in memory only; after a plugin restart during the reopening the final message reads like a normal reopen.

## Timeout

`agy auto run-once --stop-agy` runs with `agyRunOnceTimeoutMs` (600 000 ms) because the core may spend up to 360 s on sequential isolated renewals, plus cleanup and the final read. A timeout is classified `uncertain` (the agents stay as they are until the owner checks), never as "nothing was stopped". The manual `agy switch --stop-agy` does not renew and keeps 120 s. While the run lasts the handoff stays in the `switching` phase: it has no deadline of its own, owner actions answer "busy" after two seconds instead of waiting, and the popover shows "Renewing agy accounts and switching…" for an automatic agy handoff.
