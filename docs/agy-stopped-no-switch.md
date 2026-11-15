# agy: stopped sessions without a switch (0.9.6)

`agy auto run-once --stop-agy` may stop the permitted sessions, renew stale candidate accounts and then choose not to switch. The CLI returns `outcome: "stoppedNoSwitch"` with `stoppedProcesses`, `resumeCommands`, `manualResumeRequired` and `candidateRenewal`.

The plugin classifies it as `stoppedNoSwitch` (neither a failure nor a switch). The handoff reopens the affected Paseo agy agents with `agent.reload()`, exactly as after a switch (the saved conversation is the resume; `agy --conversation` is for sessions outside Paseo), and ends with "no switch was needed". No adoption happens. A `stoppedNoSwitch` that names no stopped session, and any `uncertain` outcome, stay uncertain. The plugin's manual agy handoff uses `agy switch`, which does not renew, so it never receives this outcome.
