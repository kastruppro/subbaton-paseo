import test from "node:test";
import assert from "node:assert/strict";
import { handoffActions, handoffActive, handoffEffect, handoffLine, handoffTone } from "../client/handoff-model.js";
import type { Handoff } from "../shared/handoff.js";

const base: Handoff = {
  id: "h1", provider: "agy", target: "22222222-2222-4222-8222-222222222222", targetAlias: "home", trigger: "manual",
  restartDaemon: false, phase: "waiting", requestedAt: 1, deadline: 2, updatedAt: 1, waitingFor: 2, code: "turnRunning",
  message: "Waiting for 2 running turns to finish. Nothing is interrupted.", affected: [], reopened: [], failedReopen: [], daemonOutcome: null, switchKey: null, switchedAt: null,
};

test("handoff lines name the phase, target and coordinator message", () => {
  assert.equal(handoffLine(base), "Waiting for idle (to home): Waiting for 2 running turns to finish. Nothing is interrupted.");
  assert.match(handoffLine({ ...base, trigger: "automaticSwitch", target: null, targetAlias: null }), /after verified switch/);
  assert.equal(handoffTone({ ...base, phase: "uncertain" }), "warning");
  assert.equal(handoffTone({ ...base, phase: "done" }), "ok");
});

test("owner actions follow the phase", () => {
  assert.deepEqual(handoffActions(base), { cancel: true, reopen: false, dismiss: false });
  assert.ok(handoffActive(base));
  const stuck = { ...base, phase: "uncertain" as const, affected: ["a1", "a2"], reopened: ["a1"] };
  assert.deepEqual(handoffActions(stuck), { cancel: false, reopen: true, dismiss: true });
  assert.deepEqual(handoffActions({ ...stuck, reopened: ["a1", "a2"] }).reopen, false);
  assert.equal(handoffActive({ ...base, phase: "switching" }), true);
  assert.equal(handoffActive(null), false);
});

test("cancel is offered while waiting and reopening; the confirmation names the effect", () => {
  assert.equal(handoffActions({ ...base, phase: "reopening", affected: ["a1"] }).cancel, true);
  assert.equal(handoffActions({ ...base, phase: "switching" }).cancel, false);
  assert.match(handoffLine({ ...base, trigger: "automaticSwitch" }), /verified switch to home/);
  const agy = handoffEffect("agy", "home", false, 30);
  assert.match(agy, /closes those idle agy agents/);
  assert.match(agy, /never stopped/);
  assert.match(agy, /30 minutes/);
  assert.match(handoffEffect("codex", "work", true, 5), /daemon is restarted/);
  assert.match(handoffEffect("codex", "work", false, 5), /not restarted/);
});
