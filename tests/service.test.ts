import test from "node:test";
import assert from "node:assert/strict";
import { SubBatonService, type CliExecutor } from "../server/service.js";
import { status, setup, accountId } from "./fixtures.js";
test("status cache coalesces requests and expires without provider calls", async () => {
  const { cli, service, advance } = setup();
  await Promise.all([service.status(), service.status()]);
  assert.equal(cli.calls.length, 1);
  await service.status();
  assert.equal(cli.calls.length, 1);
  advance();
  await service.status();
  assert.equal(cli.calls.length, 2);
  assert.deepEqual(cli.calls[0], {
    binary: "/fixture/subbaton",
    argv: ["status", "--json"],
  });
});
test("named switches use argv only; Claude prefix is omitted and agy never stops/reopens", async () => {
  for (const provider of ["claude", "codex", "agy"] as const) {
    const { cli, service } = setup();
    cli.response = {
      code: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        result: {
          ...status,
          providers: [{ ...status.providers[0], provider }],
        },
      }),
    };
    await service.status();
    cli.response = {
      code: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        result: { outcome: "switched" },
      }),
    };
    const result = await service.switch({
      provider,
      target: accountId,
    });
    assert.equal(result.outcome, "success");
    assert.deepEqual(cli.calls[1]?.argv, [
      ...(provider === "claude" ? [] : [provider]),
      "switch",
      accountId,
      "--json",
    ]);
  }
});
test("exit 2 is uncertain and never retried", async () => {
  const { cli, service } = setup();
  cli.response = {
    code: 2,
    stdout: JSON.stringify({
      schemaVersion: 1,
      ok: false,
      error: { code: "uncertain", message: "secret-should-not-leak" },
      result: { outcome: "uncertain" },
    }),
  };
  const result = await service.strategy({
    provider: "claude",
    strategy: "best",
  });
  assert.equal(result.outcome, "uncertain");
  assert.equal(cli.calls.length, 1);
  assert.ok(!JSON.stringify(result).includes("secret"));
});
test("malformed/unsupported envelopes and process errors are redacted", async () => {
  for (const stdout of [
    "secret-token",
    JSON.stringify({ schemaVersion: 2, ok: true, result: status }),
    JSON.stringify({
      schemaVersion: 1,
      ok: true,
      result: { ...status, accessToken: "secret-token" },
    }),
  ]) {
    const { cli, service } = setup();
    cli.response = { code: 0, stdout };
    const result = await service.status();
    assert.ok(!JSON.stringify(result).includes("secret-token"));
  }
});
test("refresh acts only on active providers and invalidates status cache", async () => {
  const { cli, service } = setup();
  await service.status();
  const result = await service.refresh();
  assert.equal(result.length, 1);
  assert.deepEqual(cli.calls[1]?.argv, ["usage", accountId, "--refresh", "--json"]);
  await service.status();
  assert.deepEqual(cli.calls.at(-1)?.argv, ["status", "--json"]);
});
test("quota strategies belong to Claude; no unsupported command is spawned", async () => {
  const { cli, service } = setup();
  assert.equal(
    (await service.strategy({ provider: "codex", strategy: "best" })).outcome,
    "error",
  );
  assert.equal(cli.calls.length, 0);
});
test("a timed-out child is uncertain, not silently retried", async () => {
  const { cli, service } = setup();
  cli.response = { code: -2, stdout: "" };
  assert.equal(
    (await service.strategy({ provider: "claude", strategy: "best" })).outcome,
    "uncertain",
  );
  assert.equal(cli.calls.length, 1);
});
test("refresh reports throttling instead of implying fresh quota", async () => {
  const { cli, service } = setup();
  await service.status();
  cli.response = {
    code: 0,
    stdout: JSON.stringify({
      schemaVersion: 1,
      ok: true,
      result: { status: "rate-limited" },
    }),
  };
  const results = await service.refresh();
  assert.equal(results[0]?.result.outcome, "unchanged");
  assert.equal(results[0]?.result.code, "rateLimited");
});
test("switch rejects flag/control injection without spawning", async () => {
  const { cli, service } = setup();
  for (const target of ["--stop-agy", "bad\nvalue"])
    assert.equal(
      (await service.switch({ provider: "agy", target })).outcome,
      "error",
    );
  assert.equal(cli.calls.length, 0);
});

// Switch to best account for Codex and agy: an explicit dry run names the target (UI v2).
const codexA = "22222222-2222-4222-8222-222222222222";
const codexB = "33333333-3333-4333-8333-333333333333";
const codexStatus = {
  cacheOnly: true,
  generatedAt: 20,
  providers: [
    {
      provider: "codex",
      cacheStatus: "available",
      updatedAt: 20,
      accounts: [codexA, codexB].map((id, i) => ({
        id, alias: i ? "Solo" : "Team", email: null, active: i === 0, enabled: true, health: "ok",
        plan: null, loginExpiresAt: null, usageStatus: "ok", windows: [],
      })),
    },
  ],
};
const reply = (result: unknown, code = 0) => ({
  code,
  stdout: JSON.stringify({ schemaVersion: 1, ok: code === 0, result }),
});
async function previewSetup(result: unknown, code = 0) {
  const ctx = setup();
  ctx.cli.response = reply(codexStatus);
  await ctx.service.status();
  ctx.cli.response = reply(result, code);
  return ctx;
}
test("best preview runs '<provider> best --dry-run --json' and names a different known target", async () => {
  const { cli, service } = await previewSetup({ outcome: "dryRun", target: codexB, alias: "ignored" });
  const r = await service.strategyPreview({ provider: "codex", strategy: "best" });
  assert.deepEqual(cli.calls.at(-1)?.argv, ["codex", "best", "--dry-run", "--json"]);
  assert.equal(r.outcome, "target");
  assert.equal(r.target, codexB);
  assert.equal(r.alias, "Solo");
});
test("best preview reports the active account kept, or no candidate, in one line", async () => {
  let ctx = await previewSetup({ outcome: "unchanged", target: codexA });
  let r = await ctx.service.strategyPreview({ provider: "codex", strategy: "best" });
  assert.equal(r.outcome, "unchanged");
  ctx = await previewSetup({ outcome: "no-candidate" });
  r = await ctx.service.strategyPreview({ provider: "codex", strategy: "best" });
  assert.equal(r.outcome, "none");
  ctx = await previewSetup({ outcome: "dryRun", target: codexA });
  r = await ctx.service.strategyPreview({ provider: "codex", strategy: "best" });
  assert.equal(r.outcome, "unchanged");
});
test("best preview never trusts an unknown target and never runs for Claude or bad input", async () => {
  const { cli, service } = await previewSetup({ outcome: "dryRun", target: "44444444-4444-4444-8444-444444444444" });
  const r = await service.strategyPreview({ provider: "codex", strategy: "best" });
  assert.equal(r.outcome, "error");
  assert.equal(r.target, undefined);
  const before = cli.calls.length;
  assert.equal((await service.strategyPreview({ provider: "claude", strategy: "best" } as never)).outcome, "error");
  assert.equal((await service.strategyPreview({ provider: "agy", strategy: "rotate" } as never)).outcome, "error");
  assert.equal(cli.calls.length, before);
});
test("best preview surfaces CLI refusals and does not switch", async () => {
  const ctx = setup();
  ctx.cli.response = reply(codexStatus);
  await ctx.service.status();
  ctx.cli.response = { code: 1, stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "recoveryRequired", message: "x" } }) };
  const r = await ctx.service.strategyPreview({ provider: "codex", strategy: "best" });
  assert.equal(r.outcome, "error");
  assert.ok(ctx.cli.calls.every((c) => !c.argv.includes("switch")));
});
test("best preview works for agy when the status knows the account", async () => {
  const ctx = setup();
  const agy = structuredClone(codexStatus) as any;
  agy.providers[0].provider = "agy";
  ctx.cli.response = reply(agy);
  await ctx.service.status();
  ctx.cli.response = reply({ outcome: "dryRun", target: codexB, canSwitch: false, wouldStop: false });
  const r = await ctx.service.strategyPreview({ provider: "agy", strategy: "best" });
  assert.deepEqual(ctx.cli.calls.at(-1)?.argv, ["agy", "best", "--dry-run", "--json"]);
  assert.equal(r.outcome, "target");
});

// 0.9.6: refresh reads every enabled account, the active one first, one CLI call each.
import { scripted, ok as okReply } from "./settings-fixtures.js";
const acc = (id: string, alias: string, patch: Record<string, unknown> = {}) => ({ ...status.providers[0]!.accounts[0]!, id, alias, active: false, enabled: true, ...patch });
const idA = "11111111-1111-4111-8111-111111111111", idB = "22222222-2222-4222-8222-222222222222", idC = "33333333-3333-4333-8333-333333333333", idD = "44444444-4444-4444-8444-444444444444";
const multi = {
  ...status,
  providers: [
    { ...status.providers[0], provider: "claude", accounts: [acc(idA, "c1", { active: true })] },
    { ...status.providers[0], provider: "codex", accounts: [acc(idB, "x-other"), acc(idC, "x-active", { active: true }), acc(idD, "x-off", { enabled: false })] },
  ],
};
const usageCalls = (cli: { calls: { argv: string[] }[] }) => cli.calls.map((c) => c.argv).filter((a) => a.includes("usage"));
test("refresh-all issues one call per enabled account, the active one first, and skips disabled accounts", async () => {
  const { cli, service } = scripted();
  cli.on(["status"], okReply(multi));
  cli.on((argv) => argv.includes("usage"), okReply({ status: "ok" }));
  const results = await service.refresh();
  assert.deepEqual(usageCalls(cli), [
    ["usage", idA, "--refresh", "--json"],
    ["codex", "usage", idC, "--refresh", "--json"],
    ["codex", "usage", idB, "--refresh", "--json"],
  ]);
  assert.deepEqual(results.map((r) => [r.provider, r.result.outcome]), [["claude", "success"], ["codex", "success"]]);
});
test("a failure for one account does not stop the others and is reported briefly per provider", async () => {
  const { cli, service } = scripted();
  cli.on(["status"], okReply(multi));
  cli.on((argv) => argv.includes("usage"), (argv) => okReply({ status: argv.includes(idC) ? "rate-limited" : "ok" }));
  const results = await service.refresh();
  assert.equal(usageCalls(cli).length, 3, "the other account is still read");
  const codex = results.find((r) => r.provider === "codex")!;
  assert.equal(codex.result.outcome, "unchanged");
  assert.match(codex.result.message, /x-active/);
  assert.match(codex.result.message, /1 of 2/);
  assert.equal(results.find((r) => r.provider === "claude")!.result.outcome, "success");
});
test("the per-account refresh sends the right argv and refuses unknown, disabled or malformed accounts", async () => {
  const { cli, service } = scripted();
  cli.on(["status"], okReply(multi));
  cli.on((argv) => argv.includes("usage"), okReply({ status: "ok" }));
  assert.equal((await service.refreshAccount({ provider: "codex", account: idB })).outcome, "success");
  assert.deepEqual(usageCalls(cli), [["codex", "usage", idB, "--refresh", "--json"]]);
  assert.equal((await service.refreshAccount({ provider: "claude", account: idA })).outcome, "success");
  assert.deepEqual(usageCalls(cli).at(-1), ["usage", idA, "--refresh", "--json"]);
  const before = usageCalls(cli).length;
  for (const input of [{ provider: "codex", account: idD }, { provider: "codex", account: "55555555-5555-4555-8555-555555555555" }, { provider: "codex", account: "--refresh" }, { provider: "claude", account: idB }])
    assert.equal((await service.refreshAccount(input)).outcome, "error", JSON.stringify(input));
  assert.equal(usageCalls(cli).length, before, "nothing was spawned");
});
