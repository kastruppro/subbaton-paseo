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
  cli.on(["codex", "switch"], ok({ outcome: "switched", postSwitchVerification: "verified", daemonOutcome: "restarted" }));
  const out = await service.handoffSwitch("codex", target, { restartDaemon: true });
  assert.equal(out.kind, "switched");
  assert.equal(out.daemonOutcome, "restarted");
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

