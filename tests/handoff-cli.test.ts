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
  assert.equal((await service.handoffSwitch("agy", target, ["--stop-agy"])).kind, "switched");
  assert.deepEqual(cli.calls.at(-1)?.argv, ["agy", "switch", target, "--stop-agy", "--json"]);
  cli.on(["agy", "switch"], ok({ outcome: "switched", postSwitchVerification: "reapplied" }));
  assert.equal((await service.handoffSwitch("agy", target, [])).kind, "switched");
  cli.on(["agy", "switch"], ok({ outcome: "switched" }));
  assert.equal((await service.handoffSwitch("agy", target, [])).kind, "uncertain");
  cli.on(["agy", "switch"], ok({ outcome: "alreadyActive" }));
  assert.equal((await service.handoffSwitch("agy", target, [])).kind, "unchanged");
});

test("Codex handoff passes --restart-daemon only when asked and reports the daemon outcome", async () => {
  const { cli, service } = await withStatus("codex");
  cli.on(["codex", "switch"], ok({ outcome: "switched", postSwitchVerification: "verified", daemonOutcome: "restarted" }));
  const out = await service.handoffSwitch("codex", target, ["--restart-daemon"]);
  assert.equal(out.kind, "switched");
  assert.equal(out.daemonOutcome, "restarted");
  assert.deepEqual(cli.calls.at(-1)?.argv, ["codex", "switch", target, "--restart-daemon", "--json"]);
});

test("refusals distinguish stopped agy sessions; abnormal results are uncertain", async () => {
  const { cli, service } = await withStatus("agy");
  cli.on(["agy", "switch"], refused("needsLogin"));
  assert.equal((await service.handoffSwitch("agy", target, ["--stop-agy"])).kind, "refused");
  cli.on(["agy", "switch"], { code: 1, stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "conflict", stoppedProcesses: [{ pid: 4 }] } }) });
  assert.equal((await service.handoffSwitch("agy", target, ["--stop-agy"])).kind, "stoppedFailed");
  cli.on(["agy", "switch"], refused("stopFailed"));
  assert.equal((await service.handoffSwitch("agy", target, ["--stop-agy"])).kind, "stoppedFailed");
  for (const response of [{ code: -2, stdout: "" }, refused("uncertain", 2), { code: 0, stdout: "{" }]) {
    cli.on(["agy", "switch"], response);
    assert.equal((await service.handoffSwitch("agy", target, ["--stop-agy"])).kind, "uncertain");
  }
});

test("handoff switch refuses unknown targets, foreign flags and concurrent mutations without spawning", async () => {
  const { cli, service } = await withStatus("agy");
  const before = cli.calls.length;
  assert.equal((await service.handoffSwitch("agy", "22222222-2222-4222-8222-222222222222", [])).kind, "refused");
  assert.equal((await service.handoffSwitch("agy", target, ["--force"])).kind, "refused");
  assert.equal((await service.handoffSwitch("agy", target, ["--restart-daemon"])).kind, "refused");
  assert.equal((await service.handoffSwitch("codex", target, [])).kind, "refused");
  assert.equal(cli.calls.length, before);
});

test("agy process inventory is read-only and fails closed", async () => {
  const { cli, service } = scripted();
  cli.on(["agy", "processes"], ok({ processes: [{ pid: 1, kind: "cli", conversationID: "x" }, { pid: 2 }], scope: "x" }));
  assert.deepEqual(await service.agyProcesses(), { ok: true, processes: [{ kind: "cli" }, { kind: "unknown" }] });
  assert.deepEqual(cli.calls.at(-1)?.argv, ["agy", "processes", "--json"]);
  cli.on(["agy", "processes"], refused("storageFailure"));
  assert.deepEqual(await service.agyProcesses(), { ok: false });
  cli.on(["agy", "processes"], ok({ processes: "nope" }));
  assert.deepEqual(await service.agyProcesses(), { ok: false });
});
