import test from "node:test";
import assert from "node:assert/strict";
import { scripted, ok, refused } from "./settings-fixtures.js";
import { status } from "./fixtures.js";

const target = "11111111-1111-4111-8111-111111111111";
const withStatus = async (provider: "codex" | "agy") => {
  const ctx = scripted();
  ctx.cli.on(["status"], ok({ ...status, providers: [{ ...status.providers[0], provider }] }));
  await ctx.service.status();
  return ctx;
};

test("handoff switch uses fixed argv and requires post-switch verification", async () => {
  const { cli, service } = await withStatus("agy");
  cli.on(["agy", "switch"], ok({ outcome: "switched", postSwitchVerification: "verified", stoppedProcesses: [{ pid: 1 }] }));
  assert.equal((await service.handoffSwitch("agy", target, { onlyPids: [12, 11] })).kind, "switched");
  assert.deepEqual(cli.calls.at(-1)?.argv, ["agy", "switch", target, "--stop-agy", "--only-pids", "12,11", "--json"]);
  cli.on(["agy", "switch"], ok({ outcome: "switched", postSwitchVerification: "reapplied" }));
  assert.equal((await service.handoffSwitch("agy", target, {})).kind, "switched");
  cli.on(["agy", "switch"], ok({ outcome: "switched" }));
  assert.equal((await service.handoffSwitch("agy", target, {})).kind, "uncertain");
  cli.on(["agy", "switch"], ok({ outcome: "alreadyActive" }));
  assert.equal((await service.handoffSwitch("agy", target, {})).kind, "unchanged");
});

test("Codex handoff passes --restart-daemon only when asked and reports the daemon outcome", async () => {
  const { cli, service } = await withStatus("codex");
  cli.on(["codex", "switch"], ok({ outcome: "switched", postSwitchVerification: "verified", daemonOutcome: "restarted", transaction:"own-txn" }));
  const out = await service.handoffSwitch("codex", target, { restartDaemon: true });
  assert.equal(out.kind, "switched");
  assert.equal(out.daemonOutcome, "restarted");
  assert.equal(out.transaction,"own-txn");
  assert.deepEqual(cli.calls.at(-1)?.argv, ["codex", "switch", target, "--restart-daemon", "--json"]);
});

test("refusals distinguish stopped agy sessions; abnormal results are uncertain", async () => {
  const { cli, service } = await withStatus("agy");
  cli.on(["agy", "switch"], refused("needsLogin"));
  assert.equal((await service.handoffSwitch("agy", target, { onlyPids: [11] })).kind, "refused");
  cli.on(["agy", "switch"], { code: 1, stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "conflict", stoppedProcesses: [{ pid: 4 }] } }) });
  assert.equal((await service.handoffSwitch("agy", target, { onlyPids: [11] })).kind, "stoppedFailed");
  cli.on(["agy", "switch"], refused("stopFailed"));
  assert.equal((await service.handoffSwitch("agy", target, { onlyPids: [11] })).kind, "stoppedFailed");
  for (const response of [{ code: -2, stdout: "" }, refused("uncertain", 2), { code: 0, stdout: "{" }]) {
    cli.on(["agy", "switch"], response);
    assert.equal((await service.handoffSwitch("agy", target, { onlyPids: [11] })).kind, "uncertain");
  }
});

test("handoff switch refuses unknown targets, foreign flags and concurrent mutations without spawning", async () => {
  const { cli, service } = await withStatus("agy");
  const before = cli.calls.length;
  assert.equal((await service.handoffSwitch("agy", "22222222-2222-4222-8222-222222222222", {})).kind, "refused");
  assert.equal((await service.handoffSwitch("agy", target, { restartDaemon: true })).kind, "refused");
  assert.equal((await service.handoffSwitch("agy", target, { onlyPids: [1] })).kind, "refused");
  assert.equal((await service.handoffSwitch("agy", target, { onlyPids: [5, 5] })).kind, "refused");
  assert.equal((await service.handoffSwitch("agy", target, { onlyPids: Array.from({ length: 65 }, (_, i) => i + 2) })).kind, "refused");
  assert.equal((await service.handoffSwitch("codex", target, {})).kind, "refused");
  assert.equal((await service.agyAutoRunOnce([])).kind, "refused");
  assert.equal(cli.calls.length, before);
});

test("agy process inventory is read-only and fails closed", async () => {
  const { cli, service } = scripted();
  cli.on(["agy", "processes"], ok({
    processes: [
      { pid: 11, kind: "cli", parentPID: 500, ancestors: [{ pid: 500, executable: "node" }, { pid: 1, executable: "launchd" }], ancestorsComplete: true },
      { pid: 12, ancestors: [{ pid: 900, executable: "zsh" }], ancestorsComplete: false },
      { pid: 13, kind: "desktop" },
    ],
  }));
  assert.deepEqual(await service.agyProcesses(), {
    ok: true,
    processes: [
      { pid: 11, kind: "cli", ancestors: [{ pid: 500, executable: "node" }, { pid: 1, executable: "launchd" }], complete: true },
      { pid: 12, kind: "unknown", ancestors: [{ pid: 900, executable: "zsh" }], complete: false },
      { pid: 13, kind: "desktop", ancestors: null, complete: false },
    ],
  });
  assert.deepEqual(cli.calls.at(-1)?.argv, ["agy", "processes", "--json"]);
  cli.on(["agy", "processes"], refused("storageFailure"));
  assert.deepEqual(await service.agyProcesses(), { ok: false });
  cli.on(["agy", "processes"], ok({ processes: [{ kind: "cli" }] }));
  assert.deepEqual(await service.agyProcesses(), { ok: false });
  cli.on(["agy", "processes"], ok({ processes: "nope" }));
  assert.deepEqual(await service.agyProcesses(), { ok: false });
});

const fail = (code: string, extra: Record<string, unknown> = {}) => ({ code: 1, stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message: "x", ...extra } }) });

test("agy switch: processesNotAllowed waits, stopRefused closed nothing, stopFailed may have", async () => {
  const { cli, service } = await withStatus("agy");
  cli.on(["agy", "switch"], fail("processesNotAllowed", { processes: [{ pid: 9 }] }));
  assert.equal((await service.handoffSwitch("agy", target, { onlyPids: [11] })).kind, "notAllowed");
  cli.on(["agy", "switch"], fail("stopRefused", { stopAttempted: false }));
  const refusedStop = await service.handoffSwitch("agy", target, { onlyPids: [11] });
  assert.equal(refusedStop.kind, "refused");
  assert.equal(refusedStop.code, "stopRefused");
  cli.on(["agy", "switch"], fail("stopFailed", { stopAttempted: true }));
  assert.equal((await service.handoffSwitch("agy", target, { onlyPids: [11] })).kind, "stoppedFailed");
});

test("agy auto plan and run-once: fixed argv and every outcome mapped", async () => {
  const { cli, service } = await withStatus("agy");
  cli.on(["agy", "auto", "plan"], ok({ blockedOnlyByProcesses: true, targetIfProcessesStopped: target, executionEnabled: true }));
  assert.deepEqual(await service.agyAutoPlan(), { ok: true, blockedOnlyByProcesses: true, target });
  assert.deepEqual(cli.calls.at(-1)?.argv, ["agy", "auto", "plan", "--json"]);
  cli.on(["agy", "auto", "plan"], ok({ blockedOnlyByProcesses: true, targetIfProcessesStopped: target, executionEnabled: false }));
  assert.deepEqual(await service.agyAutoPlan(), { ok: true, blockedOnlyByProcesses: false, target: null });
  // N-M2: renewal needs the sessions stopped, even though no target is known yet
  cli.on(["agy", "auto", "plan"], ok({ blockedOnlyByProcesses: true, stopReason: "renewCandidates", targetIfProcessesStopped: null, executionEnabled: true }));
  assert.deepEqual(await service.agyAutoPlan(), { ok: true, blockedOnlyByProcesses: true, target: null });
  cli.on(["agy", "auto", "plan"], ok({ blockedOnlyByProcesses: true, stopReason: "renewCandidates", targetIfProcessesStopped: null, executionEnabled: false }));
  assert.deepEqual(await service.agyAutoPlan(), { ok: true, blockedOnlyByProcesses: false, target: null }, "same owner settings as today");
  cli.on(["agy", "auto", "plan"], ok({ blockedOnlyByProcesses: true, targetIfProcessesStopped: null, executionEnabled: true }));
  assert.deepEqual(await service.agyAutoPlan(), { ok: true, blockedOnlyByProcesses: false, target: null }, "no target and no renewal reason: nothing to do");
  cli.on(["agy", "auto", "plan"], ok({ outcome: "x" }));
  assert.deepEqual(await service.agyAutoPlan(), { ok: false });

  const run = async (response: unknown) => {
    cli.on(["agy", "auto", "run-once"], response as never);
    return service.agyAutoRunOnce([11, 12]);
  };
  const out = await run(ok({ outcome: "switched", switch: { postSwitchVerification: "verified", stoppedProcesses: [{ pid: 11 }] } }));
  assert.equal(out.kind, "switched");
  assert.deepEqual(cli.calls.at(-1)?.argv, ["agy", "auto", "run-once", "--stop-agy", "--only-pids", "11,12", "--json"]);
  assert.equal((await run(ok({ outcome: "switched", switch: {} }))).kind, "uncertain");
  assert.equal((await run(ok({ outcome: "deferred", reason: "processNotAllowed" }))).kind, "notAllowed");
  assert.equal((await run(ok({ outcome: "deferred", reason: "processStopRefused", stopAttempted: false }))).kind, "notRun");
  const failedStop = await run(ok({ outcome: "deferred", reason: "processStopFailed", stopAttempted: true, retryAt: 5000 }));
  assert.equal(failedStop.kind, "stoppedFailed");
  assert.equal(failedStop.retryAt, 5000);
  assert.equal((await run(ok({ outcome: "failed", failure: "needsLogin" }))).kind, "refused");
  assert.equal((await run(ok({ outcome: "failed", failure: "conflict", stoppedProcesses: [{ pid: 11 }] }))).kind, "stoppedFailed");
  assert.equal((await run(ok({ outcome: "revalidated", reason: "targetUnreadable" }))).kind, "notRun");
  assert.equal((await run(refused("uncertain", 2))).kind, "uncertain");
  // 0.9.6: sessions stopped to renew candidates, then the final policy chose not to switch (real core shape).
  const stoppedNoSwitch = {
    outcome: "stoppedNoSwitch",
    provider: "agy",
    candidateRenewal: { renewed: 1, skipped: 0, failed: 1 },
    stoppedProcesses: [{ pid: 11, conversationID: "160ad118-bc9f-450b-8564-1ebb0a19f07b", identity: "fixture", resumeCommand: "agy --conversation 160ad118-bc9f-450b-8564-1ebb0a19f07b" }],
    resumeCommands: ["agy --conversation 160ad118-bc9f-450b-8564-1ebb0a19f07b"],
    manualResumeRequired: false,
  };
  const noSwitch = await run(ok(stoppedNoSwitch));
  assert.equal(noSwitch.kind, "stoppedNoSwitch");
  assert.equal(noSwitch.code, "stoppedNoSwitch");
  assert.notEqual(noSwitch.kind, "stoppedFailed");
  assert.equal((await run(ok({ ...stoppedNoSwitch, manualResumeRequired: true }))).kind, "stoppedNoSwitch", "manual resume is the owner's, the Paseo agents are still reopened");
  // no stopped session reported: nothing to resume and the outcome is not trusted
  assert.equal((await run(ok({ ...stoppedNoSwitch, stoppedProcesses: [], resumeCommands: [] }))).kind, "uncertain");
  // N-M1: sessions were stopped, then the nested run found auto off or paused (the core does not rewrite those): still reopened.
  for (const outcome of ["paused", "off", "held", "stay", "revalidated"])
    assert.equal((await run(ok({ ...stoppedNoSwitch, outcome }))).kind, "stoppedNoSwitch", outcome);
  assert.equal((await run(ok({ ...stoppedNoSwitch, outcome: "deferred", reason: "busy" }))).kind, "stoppedNoSwitch", "never notRun when sessions were stopped");
  const noMeta = { ...stoppedNoSwitch, outcome: "paused" } as Record<string, unknown>;
  delete noMeta.resumeCommands; delete noMeta.manualResumeRequired;
  assert.equal((await run(ok(noMeta))).kind, "uncertain", "stopped sessions without resume metadata are not trusted");
  assert.equal((await run(ok({ outcome: "paused" }))).kind, "notRun", "nothing stopped: still notRun");
  assert.equal((await run(ok({ ...stoppedNoSwitch, manualResumeRequired: true }))).manualResumeRequired, true);
  assert.equal((await run(ok({ outcome: "uncertain", reason: "replanFailed", stoppedProcesses: stoppedNoSwitch.stoppedProcesses }))).kind, "uncertain");
});

test("agy run-once with --stop-agy gets the long renewal timeout; a timeout is uncertain, never 'nothing stopped'", async () => {
  const { agyRunOnceTimeoutMs } = await import("../server/service.js");
  assert.equal(agyRunOnceTimeoutMs, 600_000);
  const { cli, service } = await withStatus("agy");
  cli.on(["agy", "auto", "run-once"], ok({ outcome: "stay" }));
  await service.agyAutoRunOnce([11]);
  assert.equal(cli.calls.at(-1)?.timeout, 600_000);
  // the manual handoff switch does not renew and keeps the normal timeout
  cli.on(["agy", "switch"], ok({ outcome: "switched", postSwitchVerification: "verified" }));
  await service.handoffSwitch("agy", target, { onlyPids: [11] });
  assert.equal(cli.calls.at(-1)?.timeout, 120_000);
  cli.on(["agy", "auto", "run-once"], { code: -2, stdout: "" } as never);
  const out = await service.agyAutoRunOnce([11]);
  assert.equal(out.kind, "uncertain");
  assert.doesNotMatch(out.message, /Nothing was stopped/);
});

test("codex daemon pending and restart: fixed argv, fail closed", async () => {
  const { cli, service } = await withStatus("codex");
  cli.on(["codex", "processes"], ok({ daemonRestartPending: true }));
  assert.equal(await service.codexDaemonPending(), true);
  assert.deepEqual(cli.calls.at(-1)?.argv, ["codex", "processes", "--json"]);
  cli.on(["codex", "processes"], ok({ daemonRestartPending: null }));
  assert.equal(await service.codexDaemonPending(), null);
  cli.on(["codex", "daemon", "restart"], ok({ outcome: "restarted", daemonOutcome: "restarted" }));
  assert.equal(await service.codexDaemonRestart(), "restarted");
  assert.deepEqual(cli.calls.at(-1)?.argv, ["codex", "daemon", "restart", "--if-pending", "--json"]);
  cli.on(["codex", "daemon", "restart"], ok({ outcome: "notPending", daemonOutcome: "notPending" }));
  assert.equal(await service.codexDaemonRestart(), "notPending");
  cli.on(["codex", "daemon", "restart"], ok({ outcome: "pending", daemonOutcome: "pending" }));
  assert.equal(await service.codexDaemonRestart(), "pending");
  cli.on(["codex", "daemon", "restart"], ok({ outcome: "weird" }));
  assert.equal(await service.codexDaemonRestart(), "unknown");
  cli.on(["codex", "daemon", "restart"], { code: -2, stdout: "" });
  assert.equal(await service.codexDaemonRestart(), "unknown");
});

