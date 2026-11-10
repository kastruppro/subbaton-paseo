import test from "node:test";
import assert from "node:assert/strict";
import { SubBatonService, type CliExecutor } from "../server/service.js";
const status = {
  cacheOnly: true,
  generatedAt: 20,
  providers: [
    {
      provider: "claude",
      cacheStatus: "available",
      updatedAt: 20,
      accounts: [
        {
          id: "account-a",
          alias: "A",
          email: "a@example.test",
          active: true,
          enabled: true,
          health: "ok",
          plan: null,
          loginExpiresAt: null,
          usageStatus: "ok",
          windows: [],
        },
      ],
    },
  ],
};
class FakeCLI implements CliExecutor {
  calls: { binary: string; argv: string[] }[] = [];
  response = {
    code: 0,
    stdout: JSON.stringify({ schemaVersion: 1, ok: true, result: status }),
  };
  async run(binary: string, argv: string[]) {
    this.calls.push({ binary, argv });
    return this.response;
  }
}
const setup = () => {
  const cli = new FakeCLI();
  let now = 0;
  return {
    cli,
    service: new SubBatonService(
      cli,
      async () => "/fixture/subbaton",
      () => now,
    ),
    advance: () => {
      now += 16000;
    },
  };
};
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
        result: { outcome: "switched" },
      }),
    };
    const result = await service.switch({
      provider,
      target: "account;$(not-a-shell)",
    });
    assert.equal(result.outcome, "success");
    assert.deepEqual(cli.calls[0]?.argv, [
      ...(provider === "claude" ? [] : [provider]),
      "switch",
      "account;$(not-a-shell)",
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
  const result = await service.switch({ provider: "claude", target: "a" });
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
  assert.deepEqual(cli.calls[1]?.argv, ["usage", "--refresh", "--json"]);
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
    (await service.switch({ provider: "agy", target: "a" })).outcome,
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
