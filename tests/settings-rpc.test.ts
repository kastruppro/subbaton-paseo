import test from "node:test";
import assert from "node:assert/strict";
import { SubBatonService } from "../server/service.js";
import {
  scripted,
  ok,
  refused,
  accountA,
  accountB,
  revision,
  claudeSection,
  settingsDocument,
} from "./settings-fixtures.js";
import { status } from "./fixtures.js";

const loaded = async () => {
  const ctx = scripted();
  const result = await ctx.service.settings({});
  assert.equal(result.ok, true);
  return ctx;
};
const updated = (rev = "6f1c2d4e-0000-4000-8000-000000000002") =>
  ok({ outcome: "updated", provider: "claude", settings: claudeSection(rev) });

test("settings get runs one allowlisted argv and projects only metadata-described fields", async () => {
  const { cli, service } = scripted();
  const result = await service.settings({});
  assert.deepEqual(cli.calls[0]?.argv, ["settings", "get", "--json"]);
  assert.equal(cli.calls[0]?.input, undefined);
  assert.ok(result.ok && result.data);
  const [claude, codex, agy] = result.data.providers;
  assert.ok(claude?.ok);
  assert.equal(claude.provider, "claude");
  assert.equal(claude.revision, revision);
  assert.equal(claude.values["thresholds.global"], 95);
  assert.deepEqual(claude.values["thresholds.windows"], { "5h": null, "7d": 90 });
  assert.equal(claude.effective["thresholds.windows"] && (claude.effective["thresholds.windows"] as Record<string, number>)["5h"], 95);
  assert.deepEqual(
    claude.accounts.map((a) => [a.id, a.alias, a.quarantined, a.needsLogin]),
    [
      [accountA, "work", false, false],
      [accountB, "home", true, true],
    ],
  );
  assert.equal(claude.accounts[1]?.values["thresholds.global"], 85);
  assert.equal(claude.accounts[1]?.values["priority"], 7);
  assert.ok(claude.fields.some((f) => f.path === "accounts.<account>.thresholds.windows" && f.knownKeys?.includes("weekly_scoped:Opus-4.5")));
  assert.ok(claude.fields.every((f) => !f.path.startsWith("<provider>")));
  assert.deepEqual(claude.actions, ["releaseQuarantine", "resumeAuto"]);
  assert.equal(claude.auto.paused, true);
  assert.equal(claude.auto.pauseReason, "flapping");
  assert.equal(codex?.ok, false);
  assert.equal(codex?.ok === false && codex.error.code, "busy");
  assert.ok(agy?.ok && agy.readOnly && !agy.exists);
  assert.deepEqual(result.data.poller, { installed: true, lastTickAt: 5000, stale: false, unavailable: false });
  assert.ok(!JSON.stringify(result).includes("secret-token"));
});

test("settings get is cached and coalesced; fresh bypasses the cache", async () => {
  const { cli, service, advance } = scripted();
  await Promise.all([service.settings({}), service.settings({})]);
  assert.equal(cli.calls.length, 1);
  await service.settings({});
  assert.equal(cli.calls.length, 1);
  await service.settings({ fresh: true });
  assert.equal(cli.calls.length, 2);
  advance();
  await service.settings({});
  assert.equal(cli.calls.length, 3);
});

test("a malformed provider section becomes that section's error, others still render", async () => {
  const { cli, service } = scripted();
  const broken = claudeSection();
  (broken.values as Record<string, unknown>).cooldownMinutes = "ten";
  cli.on(["settings", "get"], ok(settingsDocument(broken)));
  const result = await service.settings({});
  assert.ok(result.ok && result.data);
  assert.equal(result.data.providers[0]?.ok, false);
  assert.ok(result.data.providers[2]?.ok);
});

test("settings get access failures are static and redacted", async () => {
  for (const response of [refused("storageFailure"), { code: -2, stdout: "" }, { code: 0, stdout: "secret-token" }]) {
    const { cli, service } = scripted();
    cli.on(["settings", "get"], response);
    const result = await service.settings({});
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes("secret-token"));
  }
  const cli = scripted().cli;
  const untrusted = new SubBatonService(cli, async () => {
    throw new Error("/Users/x/secret-token");
  });
  const result = await untrusted.settings({});
  assert.equal(result.error?.code, "configuration");
  assert.ok(!JSON.stringify(result).includes("secret-token"));
  assert.equal(cli.calls.length, 0);
});

test("batch set sends one provider through stdin with the expected revision, never argv values", async () => {
  const { cli, service } = await loaded();
  cli.on(["settings", "set"], updated());
  const result = await service.settingsSet({
    provider: "claude",
    expectedRevision: revision,
    changes: [
      { path: ["autoEnabled"], value: true },
      { path: ["thresholds", "models", "gemini-2.5"], value: 92 },
      { path: ["accounts", accountB, "thresholds", "global"], value: null },
      { path: ["order"], value: [accountB, accountA] },
      { path: ["strategy"], value: "consume-first" },
    ],
  });
  assert.equal(result.result.outcome, "success");
  const call = cli.calls.at(-1)!;
  assert.deepEqual(call.argv, ["settings", "set", "--json-input", "-", "--json"]);
  assert.deepEqual(JSON.parse(call.input!), {
    changes: {
      "/claude/autoEnabled": true,
      "/claude/thresholds/models/gemini-2.5": 92,
      [`/claude/accounts/${accountB}/thresholds/global`]: null,
      "/claude/order": [accountB, accountA],
      "/claude/strategy": "consume-first",
    },
    expectedRevision: { claude: revision },
  });
  assert.equal(result.section?.revision, "6f1c2d4e-0000-4000-8000-000000000002");
});

test("set invalidates status and settings caches", async () => {
  const { cli, service } = await loaded();
  cli.on(["status"], ok(status));
  await service.status();
  cli.on(["settings", "set"], updated());
  const before = cli.calls.length;
  await service.settingsSet({ provider: "claude", expectedRevision: revision, changes: [{ path: ["cooldownMinutes"], value: 10 }] });
  await service.status();
  await service.settings({});
  assert.deepEqual(
    cli.calls.slice(before).map((c) => c.argv[0] + " " + c.argv[1]),
    ["settings set", "status --json", "settings get"],
  );
});

test("invalid set input is refused before any spawn", async () => {
  const { cli, service } = await loaded();
  const spawned = cli.calls.length;
  const cases: [string, unknown, unknown?][] = [
    ["unknownField", { path: ["nope"], value: 1 }],
    ["above maximum", { path: ["thresholds", "global"], value: 100 }],
    ["below minimum", { path: ["cooldownMinutes"], value: -1 }],
    ["wrong type", { path: ["autoEnabled"], value: "true" }],
    ["null on non-nullable", { path: ["thresholds", "global"], value: null }],
    ["not an integer", { path: ["weeklyResetPriority", "horizonDays"], value: 2.5 }],
    ["gap in allowed ranges", { path: ["inactiveIntervalHours"], value: 0.5 }],
    ["enum", { path: ["strategy"], value: "random" }],
    ["unknown account", { path: ["accounts", "33333333-3333-4333-8333-333333333333", "enabled"], value: false }],
    ["alias instead of id", { path: ["accounts", "work", "enabled"], value: false }],
    ["dictionary key", { path: ["thresholds", "models", "bad key"], value: 90 }],
    ["dictionary value", { path: ["thresholds", "windows", "5h"], value: 40 }],
    ["dictionary object", { path: ["thresholds", "windows"], value: { "5h": 101 } }],
    ["order not a permutation", { path: ["order"], value: [accountA] }],
    ["order duplicate", { path: ["order"], value: [accountA, accountA] }],
    ["account readonly flag", { path: ["accounts", accountA, "quarantined"], value: false }],
    ["flag injection", { path: ["--dry-run"], value: true }],
    ["empty segment", { path: [""], value: true }],
  ];
  for (const [name, change] of cases) {
    const result = await service.settingsSet({ provider: "claude", expectedRevision: revision, changes: [change as never] });
    assert.equal(result.result.outcome, "error", name);
  }
  for (const input of [
    { provider: "claude", expectedRevision: "", changes: [{ path: ["autoEnabled"], value: true }] },
    { provider: "claude", expectedRevision: "rev\n--x", changes: [{ path: ["autoEnabled"], value: true }] },
    { provider: "claude", expectedRevision: revision, changes: [] },
    { provider: "other", expectedRevision: revision, changes: [{ path: ["autoEnabled"], value: true }] },
    { provider: "claude", expectedRevision: revision, changes: [{ path: ["autoEnabled"], value: true }, { path: ["autoEnabled"], value: false }] },
    { provider: "claude", expectedRevision: revision, changes: [{ path: ["thresholds", "windows"], value: {} }, { path: ["thresholds", "windows", "5h"], value: 80 }] },
    { provider: "agy", expectedRevision: "legacy", changes: [{ path: ["autoEnabled"], value: true }] },
    { provider: "codex", expectedRevision: revision, changes: [{ path: ["autoEnabled"], value: true }] },
  ])
    assert.equal((await service.settingsSet(input as never)).result.outcome, "error", JSON.stringify(input));
  assert.equal(cli.calls.length, spawned);
});

test("set requires a successful settings read for that provider", async () => {
  const { cli, service } = scripted();
  const result = await service.settingsSet({ provider: "claude", expectedRevision: revision, changes: [{ path: ["autoEnabled"], value: true }] });
  assert.equal(result.result.code, "reloadSettings");
  assert.equal(cli.calls.length, 0);
});

test("revision conflict reports a typed code and drops the cached settings", async () => {
  const { cli, service } = await loaded();
  cli.on(["settings", "set"], refused("revisionConflict"));
  const result = await service.settingsSet({ provider: "claude", expectedRevision: revision, changes: [{ path: ["autoEnabled"], value: true }] });
  assert.equal(result.result.outcome, "error");
  assert.equal(result.result.code, "revisionConflict");
  assert.ok(!JSON.stringify(result).includes("secret-token"));
  const count = cli.calls.length;
  await service.settings({});
  assert.equal(cli.calls.length, count + 1);
});

test("typed CLI refusals map to static messages", async () => {
  for (const code of ["invalidSetting", "vaultMissing", "newerSchema", "revisionRequired", "multipleProviders", "invalidStoredSettings", "recoveryRequired", "somethingNew"]) {
    const { cli, service } = await loaded();
    cli.on(["settings", "set"], refused(code));
    const result = await service.settingsSet({ provider: "claude", expectedRevision: revision, changes: [{ path: ["autoEnabled"], value: true }] });
    assert.equal(result.result.outcome, "error");
    assert.equal(result.result.code, code === "somethingNew" ? "cliError" : code);
    assert.ok(!result.result.message.includes("secret"));
  }
});

test("abnormal set results are uncertain, never retried, and point at reloading settings", async () => {
  for (const response of [
    { code: -2, stdout: "" },
    { code: 2, stdout: "" },
    { code: 0, stdout: "{" },
    ok({ outcome: "somethingElse" }),
    ok({ outcome: "updated", provider: "claude", settings: { revision: 5 } }),
  ]) {
    const { cli, service } = await loaded();
    cli.on(["settings", "set"], response);
    const result = await service.settingsSet({ provider: "claude", expectedRevision: revision, changes: [{ path: ["autoEnabled"], value: true }] });
    assert.equal(result.result.outcome, "uncertain", JSON.stringify(response));
    assert.match(result.result.message, /Reload settings/);
    assert.doesNotMatch(result.result.message, /recovery/i);
    assert.equal(cli.calls.filter((c) => c.argv[1] === "set").length, 1);
  }
});

test("only one mutation runs at a time", async () => {
  const { cli, service } = await loaded();
  let release!: () => void;
  cli.run = async (binary, argv, timeout, input) => {
    cli.calls.push({ binary, argv, timeout, input });
    await new Promise<void>((r) => (release = r));
    return updated();
  };
  const first = service.settingsSet({ provider: "claude", expectedRevision: revision, changes: [{ path: ["autoEnabled"], value: true }] });
  const second = await service.settingsAction({ action: "resumeAuto", provider: "claude", expectedRevision: revision });
  assert.equal(second.result.code, "busy");
  release();
  assert.equal((await first).result.outcome, "success");
});

test("release and resume actions use fixed argv with the revision and known account IDs", async () => {
  const { cli, service } = await loaded();
  cli.on(["settings", "release-quarantine"], ok({ outcome: "quarantineReleased", provider: "claude", account: accountB, settings: claudeSection("r2"), warnings: ["x"] }));
  cli.on(["settings", "resume-auto"], ok({ outcome: "resumed", provider: "claude", previousReason: "flapping", settings: claudeSection("r3") }));
  const released = await service.settingsAction({ action: "releaseQuarantine", provider: "claude", account: accountB, expectedRevision: revision });
  assert.equal(released.result.outcome, "success");
  assert.match(released.result.message, /does not validate or renew/);
  assert.deepEqual(cli.calls.at(-1)?.argv, ["settings", "release-quarantine", "claude", accountB, "--expected-revision", revision, "--json"]);
  const resumed = await service.settingsAction({ action: "resumeAuto", provider: "claude", expectedRevision: "r2" });
  assert.equal(resumed.result.outcome, "success");
  assert.deepEqual(cli.calls.at(-1)?.argv, ["settings", "resume-auto", "claude", "--expected-revision", "r2", "--json"]);
  assert.equal(resumed.section?.revision, "r3");
  cli.on(["settings", "resume-auto"], ok({ outcome: "notPaused", provider: "claude", auto: {} }));
  assert.equal((await service.settingsAction({ action: "resumeAuto", provider: "claude", expectedRevision: "r3" })).result.outcome, "unchanged");
});

test("release actions refuse unknown accounts, wrong providers and missing revisions without spawning", async () => {
  const { cli, service } = await loaded();
  const spawned = cli.calls.length;
  for (const input of [
    { action: "releaseQuarantine", provider: "claude", account: "33333333-3333-4333-8333-333333333333", expectedRevision: revision },
    { action: "releaseQuarantine", provider: "claude", account: "--dry-run", expectedRevision: revision },
    { action: "releaseQuarantine", provider: "claude", account: accountA },
    { action: "releaseDeviceBlock", provider: "claude", account: accountA, expectedRevision: revision },
    { action: "releaseDeviceBlock", provider: "codex", account: accountA, expectedRevision: revision },
    { action: "resumeAuto", provider: "claude", expectedRevision: "" },
    { action: "deleteEverything", provider: "claude", expectedRevision: revision },
  ])
    assert.equal((await service.settingsAction(input as never)).result.outcome, "error", JSON.stringify(input));
  assert.equal(cli.calls.length, spawned);
});

test("Codex device-block release uses its own command", async () => {
  const { cli, service } = scripted();
  const codex = { ...claudeSection("c1"), actions: [{ name: "releaseDeviceBlock" }] };
  cli.on(["settings", "get"], ok({ ...settingsDocument(), providers: { ...settingsDocument().providers, codex } }));
  await service.settings({});
  cli.on(["settings", "release-device-block"], ok({ outcome: "deviceBlockReleased", provider: "codex", account: accountA, settings: codex, warnings: [] }));
  const result = await service.settingsAction({ action: "releaseDeviceBlock", provider: "codex", account: accountA, expectedRevision: "c1" });
  assert.equal(
    (await service.settingsAction({ action: "resumeAuto", provider: "codex", expectedRevision: "c1" })).result.code,
    "unsupportedAction",
  );
  assert.equal(result.result.outcome, "success");
  assert.deepEqual(cli.calls.at(-1)?.argv, ["settings", "release-device-block", "codex", accountA, "--expected-revision", "c1", "--json"]);
});

test("release refusal and conflict stay typed", async () => {
  const { cli, service } = await loaded();
  cli.on(["settings", "release-quarantine"], refused("releaseRefused"));
  const result = await service.settingsAction({ action: "releaseQuarantine", provider: "claude", account: accountB, expectedRevision: revision });
  assert.equal(result.result.code, "releaseRefused");
});

test("poller status, install and uninstall use fixed argv and the verified binary", async () => {
  const { cli, service } = scripted();
  const pollerStatus = { installed: true, loaded: true, lastTickAt: 50, stale: false, binary: "/fixture/subbaton", label: "dk.kastruppro.subbaton.poller", tickSeconds: 60, providers: { claude: { outcome: "read", checked: 2, cached: 1, skipped: 0, failed: 0, lastTickAt: 50, auto: "off" }, codex: { outcome: "failed", error: "busy" } } };
  cli.on(["poller", "status"], ok(pollerStatus));
  const read = await service.pollerStatus({});
  assert.ok(read.ok && read.data);
  assert.equal(read.data.loaded, true);
  assert.equal(read.data.providers.claude?.auto, "off");
  assert.deepEqual(cli.calls.at(-1)?.argv, ["poller", "status", "--json"]);
  cli.on(["poller", "install"], ok({ ...pollerStatus, outcome: "installed" }));
  cli.on(["status"], ok(status));
  await service.status();
  const installed = await service.pollerLifecycle({ action: "install" });
  assert.equal(installed.result.outcome, "success");
  assert.deepEqual(cli.calls.at(-1)?.argv, ["poller", "install", "--binary", "/fixture/subbaton", "--json"]);
  assert.equal(installed.status?.installed, true);
  await service.status();
  assert.deepEqual(cli.calls.at(-1)?.argv, ["status", "--json"]);
  cli.on(["poller", "uninstall"], ok({ ...pollerStatus, installed: false, loaded: false, outcome: "uninstalled" }));
  assert.equal((await service.pollerLifecycle({ action: "uninstall" })).result.outcome, "success");
  assert.deepEqual(cli.calls.at(-1)?.argv, ["poller", "uninstall", "--json"]);
  cli.on(["poller", "install"], refused("unstableBinary"));
  assert.equal((await service.pollerLifecycle({ action: "install" })).result.code, "unstableBinary");
  cli.on(["poller", "install"], { code: -2, stdout: "" });
  const timeout = await service.pollerLifecycle({ action: "install" });
  assert.equal(timeout.result.outcome, "uncertain");
  assert.match(timeout.result.message, /poller status/);
  assert.equal((await service.pollerLifecycle({ action: "remove" } as never)).result.outcome, "error");
});

test("events validate since and return only known event fields", async () => {
  const { cli, service } = scripted();
  cli.on(["events"], ok({ events: [{ id: "e1", at: 10, provider: "claude", kind: "automaticSwitch", account: accountA, alias: "work", target: accountB, targetAlias: "home", reason: "thresholdReached", transaction: "t1", token: "secret-token" }, { id: "e2", at: 11, provider: "codex", kind: "futureKind" }], limit: 200 }));
  const result = await service.events({ since: 5 });
  assert.deepEqual(cli.calls.at(-1)?.argv, ["events", "--since", "5", "--json"]);
  assert.ok(result.ok && result.data);
  assert.equal(result.data.events.length, 2);
  assert.equal(result.data.events[1]?.kind, "unknown");
  assert.ok(!JSON.stringify(result).includes("secret-token"));
  await service.events({});
  assert.deepEqual(cli.calls.at(-1)?.argv, ["events", "--json"]);
  const spawned = cli.calls.length;
  for (const since of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5" as never])
    assert.equal((await service.events({ since })).ok, false);
  assert.equal(cli.calls.length, spawned);
});

export const plan = {
  provider: "codex",
  dryRun: true,
  executionEnabled: false,
  evaluatedAt: 100,
  cacheOnly: true,
  processState: "idle",
  autoEnabled: true,
  decision: { action: "switch", target: accountB, reason: "thresholdReached" },
  why: {
    candidates: [
      { id: accountA, alias: "work", eligible: false, reasons: ["thresholdReached"], windows: [{ id: "codex:primary_window", kind: "5h", usedPercent: 97, threshold: { value: 95, source: "providerGlobal" }, fetchedAt: 90, resetsAt: 200, state: "fresh", inferred: false }], headroom: 0, accessTokenExpired: false, forecast: { priority: false } },
      { id: accountB, alias: "home", eligible: true, reasons: [], windows: [], headroom: 60, accessTokenExpired: false, forecast: { window: "codex:secondary_window", remainingQuota: 40, predictedUnused: 10, resetAt: 300, priority: true } },
    ],
    rate: { confidence: "unknown", sampleCount: 0 },
    effectiveStrategy: "best",
    sequences: [{ order: [accountB, accountA], expiredQuota: 10.1 }],
    sequenceBound: 4,
    sequenceAccounts: [accountB],
    weeklyPriorityAccounts: [accountB],
    proposedTarget: accountB,
    cooldown: { remainingSeconds: 0, overridden: false, passed: true },
    margin: { required: 5, headroomImprovement: 60, passed: true },
    finalReason: "thresholdReached",
  },
  auto: { paused: false, recentAutomaticSwitches: 0, flapLimit: 4, flapWindowSeconds: 3600, lastAutomaticSwitchAt: null },
  sampleCount: 0,
  limitations: ["CLI text"],
  secret: "secret-token",
};

test("auto plan is read-only, provider-scoped and bounded", async () => {
  const { cli, service } = scripted();
  cli.on((argv) => argv.includes("auto"), ok(plan));
  const result = await service.autoPlan({ provider: "codex" });
  assert.deepEqual(cli.calls.at(-1)?.argv, ["codex", "auto", "plan", "--json"]);
  assert.ok(result.ok && result.data);
  assert.equal(result.data.decision.action, "switch");
  assert.equal(result.data.why.candidates[1]?.forecast.predictedUnused, 10);
  assert.ok(!JSON.stringify(result).includes("secret-token"));
  await service.autoPlan({ provider: "claude" });
  assert.deepEqual(cli.calls.at(-1)?.argv, ["auto", "plan", "--json"]);
  const spawned = cli.calls.length;
  assert.equal((await service.autoPlan({ provider: "--x" } as never)).ok, false);
  assert.equal(cli.calls.length, spawned);
});
