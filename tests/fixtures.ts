import type { CliExecutor } from "../server/service.js";
import { SubBatonService } from "../server/service.js";
export const accountId="11111111-1111-4111-8111-111111111111";
export const status = {
  cacheOnly: true,
  generatedAt: 20,
  providers: [
    {
      provider: "claude",
      cacheStatus: "available",
      updatedAt: 20,
      accounts: [
        {
          id: accountId,
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
export class FakeCLI implements CliExecutor {
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
export const setup = () => {
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
