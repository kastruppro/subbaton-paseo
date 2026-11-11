import test from "node:test";
import assert from "node:assert/strict";
import { SubBatonService, type CliExecutor } from "../server/service.js";
test("M1 abnormal mutation outcomes always require recovery", async () => {
  for (const response of [
    { code: -1, stdout: '{"schemaVersion":1' },
    { code: 0, stdout: "half-written" },
    { code: 0, stdout: "x".repeat(1024 * 1024 + 1) },
    { code: 2, stdout: "" },
    {
      code: 2,
      stdout: JSON.stringify({
        schemaVersion: 1,
        ok: false,
        error: { code: "other" },
      }),
    },
    {
      code: 137,
      stdout: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        result: { outcome: "switched" },
      }),
    },
    { code: 0, stdout: JSON.stringify({ schemaVersion: 1, ok: true }) },
  ]) {
    let calls = 0;
    const cli: CliExecutor = {
      async run() {
        calls++;
        return response;
      },
    };
    const service = new SubBatonService(cli, async () => "/fixture/subbaton");
    const result = await service.strategy({
      provider: "claude",
      strategy: "best",
    });
    assert.equal(result.outcome, "uncertain");
    assert.match(result.message, /recovery/i);
    assert.equal(calls, 1);
  }
});
test("M1 parsed refusal remains an error but a thrown crash is uncertain", async () => {
  for (const crash of [false, true]) {
    const service = new SubBatonService(
      {
        async run() {
          if (crash) throw new Error("secret crash");
          return {
            code: 1,
            stdout: JSON.stringify({
              schemaVersion: 1,
              ok: false,
              error: { code: "busy" },
            }),
          };
        },
      },
      async () => "/fixture/subbaton",
    );
    const result = await service.strategy({
      provider: "claude",
      strategy: "best",
    });
    assert.equal(result.outcome, crash ? "uncertain" : "error");
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
});
test("M1 definite pre-spawn failure stays a configuration error", async () => {
  const service = new SubBatonService(
    {
      async run() {
        return { code: -1, notStarted: true, stdout: "" };
      },
    },
    async () => "/fixture/subbaton",
  );
  assert.equal(
    (await service.strategy({ provider: "claude", strategy: "best" })).outcome,
    "error",
  );
});

import { setup, status, accountId } from "./fixtures.js";
test("L1 named targets must be UUIDs in the last status for that provider", async () => {
  const { cli, service } = setup();
  assert.equal(
    (await service.switch({ provider: "claude", target: accountId })).outcome,
    "error",
  );
  assert.equal(cli.calls.length, 0);
  await service.status();
  for (const target of [
    "best",
    "next",
    "next-available",
    "-h",
    "22222222-2222-4222-8222-222222222222",
  ])
    assert.equal(
      (await service.switch({ provider: "claude", target })).outcome,
      "error",
    );
  assert.equal(
    (await service.switch({ provider: "codex", target: accountId })).outcome,
    "error",
  );
  assert.equal(cli.calls.length, 1);
});
test("L2 unknown health and provider additions do not discard known status", async () => {
  const { cli, service } = setup();
  cli.response = {
    code: 0,
    stdout: JSON.stringify({
      schemaVersion: 1,
      ok: true,
      result: {
        ...status,
        providers: [
          {
            ...status.providers[0],
            accounts: [
              { ...status.providers[0]!.accounts[0], health: "future-health" },
            ],
          },
          { provider: "future", accounts: [{ secret: "ignored" }] },
          { provider: "future2" },
          { provider: "future3" },
        ],
      },
    }),
  };
  const result = await service.status();
  assert.equal(result.ok, true);
  assert.equal(result.data?.providers[0]?.accounts[0]?.health, "unknown");
  assert.ok(result.data?.providers.some((p) => p.provider === "unknown"));
  assert.ok(!JSON.stringify(result).includes("ignored"));
});
test("L3 failed status and failed binary resolution are cached for a bounded backoff", async () => {
  const { cli, service, advance } = setup();
  cli.response = {
    code: 1,
    stdout: JSON.stringify({
      schemaVersion: 1,
      ok: false,
      error: { code: "busy" },
    }),
  };
  await service.status();
  await service.status();
  assert.equal(cli.calls.length, 1);
  advance();
  await service.status();
  assert.equal(cli.calls.length, 2);
  let resolves = 0;
  const bad = new SubBatonService(cli, async () => {
    resolves++;
    throw new Error("secret path");
  });
  await bad.status();
  await bad.status();
  assert.equal(resolves, 1);
});
test("L5 global refresh errors have no fabricated provider label", async () => {
  const { cli, service } = setup();
  cli.response = {
    code: 1,
    stdout: JSON.stringify({
      schemaVersion: 1,
      ok: false,
      error: { code: "busy" },
    }),
  };
  assert.equal((await service.refresh())[0]?.provider, null);
});
test("L3 settings changes clear negative cache and forget old account authorization", async () => {
  const { cli, service } = setup();
  await service.status();
  service.configurationChanged();
  assert.equal(
    (await service.switch({ provider: "claude", target: accountId })).outcome,
    "error",
  );
  assert.equal(cli.calls.length, 1);
  await service.status();
  assert.equal(cli.calls.length, 2);
});

test("D1 alreadyActive exit zero is an unchanged named switch, not recovery", async () => {
  const { cli, service } = setup();
  await service.status();
  cli.response = {
    code: 0,
    stdout: JSON.stringify({
      schemaVersion: 1,
      ok: true,
      result: { outcome: "alreadyActive" },
    }),
  };
  const result = await service.switch({
    provider: "claude",
    target: accountId,
  });
  assert.equal(result.outcome, "unchanged");
  assert.equal(result.code, "alreadyActive");
  assert.match(result.message, /already active/i);
  assert.doesNotMatch(result.message, /recovery/i);
});
test("D3 read-only status timeout or abnormal exit never asks for switch recovery", async () => {
  for (const code of [-2, 2]) {
    const { cli, service } = setup();
    cli.response = { code, stdout: "" };
    const result = await service.status();
    assert.equal(result.ok, false);
    assert.equal(result.error?.outcome, "error");
    assert.doesNotMatch(result.error?.message ?? "", /recovery|uncertain/i);
    await service.status();
    assert.equal(cli.calls.length, 1);
  }
});
test("explicit uncertainty survives a legacy exit-one envelope", async () => {
  for (const code of ["uncertain", "usageRecoveryUncertain", "lockLost"]) {
    const service = new SubBatonService({ async run() { return { code: 1, stdout: JSON.stringify({schemaVersion:1,ok:false,error:{code}}) }; } }, async () => "/fixture/subbaton");
    const result = await service.strategy({provider:"claude",strategy:"best"});
    assert.equal(result.outcome,"uncertain");
    assert.match(result.message,/recovery/i);
  }
});
test("F1 uncertain recovery retains an allowlisted actionable cause", async () => {
  for (const code of [1,2]) {
    const service = new SubBatonService({async run() {return {code,stdout:JSON.stringify({schemaVersion:1,ok:false,error:{code:"uncertain",cause:"processesRunning",causeMessage:"NEVER DISPLAY RAW CONTENT"}})};}},async()=>"/fixture/subbaton");
    const result = await service.strategy({provider:"claude",strategy:"best"});
    assert.equal(result.outcome,"uncertain");
    assert.equal(result.cause,"processesRunning");
    assert.match(result.message,/agy is running/i);
    assert.match(result.message,/recovery/i);
    assert.doesNotMatch(result.message,/NEVER DISPLAY/);
  }
});
