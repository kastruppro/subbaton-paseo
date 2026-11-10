import { z } from "zod";
import {
  statusSchema,
  switchInput,
  strategyInput,
  type Status,
  type ActionResult,
  type Provider,
} from "../shared/contracts.js";
export interface CliExecutor {
  run(
    binary: string,
    argv: string[],
    timeout: number,
  ): Promise<{ code: number; stdout: string; notStarted?:boolean }>;
}
const envelope = z.object({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string() }).optional(),
});
const failure = (code: string, message: string): ActionResult => ({
  outcome: "error",
  code,
  message,
});
const messages: Record<string, string> = {
  busy: "SubBaton is busy; retry later.",
  processesRunning: "agy is running. Finish those sessions before switching.",
  needsLogin: "This account needs an official login or must be enabled.",
  recoveryRequired: "Recovery is pending. Resolve it with the CLI first.",
  signingRequired: "Use a stable signed SubBaton binary.",
  unsupportedStorageMode: "The provider storage mode is unsupported.",
  authOverride: "An environment override prevents subscription switching.",
  conflict: "Login ownership is conflicting. Review it with the CLI.",
  deviceBlocked: "The issuer blocked this device/account.",
};
export class SubBatonService {
  private cached: { data: Status; at: number; binary: string } | null = null;
  private pending: {
    binary: string;
    promise: ReturnType<SubBatonService["fetchStatus"]>;
  } | null = null;
  private generation = 0;
  private mutating = false;
  constructor(
    private cli: CliExecutor,
    private binary: () => Promise<string>,
    private now: () => number = Date.now,
  ) {}
  private invalidate() {
    this.cached = null;
    this.generation++;
    this.pending = null;
  }
  private async call(argv: string[], timeout = 120000, mutation=false) {
    const uncertain=():ActionResult=>({outcome:"uncertain",code:"uncertain",message:"Result uncertain. Run recovery with the SubBaton CLI and inspect current state before retrying. Agents were not reopened."});
    const abnormal=(code:string,message:string)=>mutation?uncertain():failure(code,message);
    let binary:string;
    try { binary=await this.binary(); }
    catch { return {error:failure("configuration","SubBaton binary configuration or trust verification failed. Check its owner, permissions and signature.")} as const; }
    try {
      const result=await this.cli.run(binary,[...argv,"--json"],timeout);
      if(result.notStarted)return {error:failure("executionFailed","SubBaton did not start. Check the verified binary path and executable permissions.")} as const;
      if(result.code===2||result.code===-2)return {error:uncertain()} as const;
      if(Buffer.byteLength(result.stdout)>1024*1024)return {error:abnormal("invalidResponse","SubBaton returned an oversized response.")} as const;
      const parsed=envelope.safeParse(JSON.parse(result.stdout));
      if(!parsed.success)return {error:abnormal("invalidResponse","Unsupported SubBaton JSON. Update the configured CLI.")} as const;
      const value=parsed.data;
      if(result.code===1&&!value.ok){const code=value.error?.code??"";return {error:failure(messages[code]?code:"cliError",messages[code]??"SubBaton refused the operation. Inspect the CLI safely.")} as const;}
      if(result.code!==0||!value.ok||!value.result||typeof value.result!=="object")return {error:abnormal("invalidResponse","SubBaton returned inconsistent exit/JSON status.")} as const;
      if(mutation&&!argv.includes("usage")&&!["switched","unchanged","no-candidate"].includes((value.result as {outcome:string}).outcome))return {error:uncertain()} as const;
      return {result:value.result} as const;
    }catch{return {error:abnormal("executionFailed","Unable to read SubBaton status. Check the CLI configuration.")} as const;}
  }
  private async fetchStatus(binary: string, generation: number) {
    const response = await this.call(["status"], 8000);
    if (response.error) return { ok: false, data: null, error: response.error };
    const parsed = statusSchema.safeParse(response.result);
    if (!parsed.success)
      return {
        ok: false,
        data: null,
        error: failure(
          "invalidResponse",
          "SubBaton status schema is unsupported.",
        ),
      };
    if (generation === this.generation)
      this.cached = { data: parsed.data, at: this.now(), binary };
    return { ok: true, data: parsed.data, error: null };
  }
  async status() {
    try {
      const binary = await this.binary();
      if (this.cached?.binary === binary && this.now() - this.cached.at < 15000)
        return { ok: true, data: this.cached.data, error: null };
      if (this.pending?.binary === binary) return this.pending.promise;
      const promise = this.fetchStatus(binary, this.generation);
      const pending = { binary, promise };
      this.pending = pending;
      try {
        return await promise;
      } finally {
        if (this.pending === pending) this.pending = null;
      }
    } catch {
      return {
        ok: false,
        data: null,
        error: failure("configuration", "Check the SubBaton binary setting."),
      };
    }
  }
  private async mutation(argv: string[]): Promise<ActionResult> {
    if (this.mutating)
      return failure("busy", "Another SubBaton action is still running.");
    this.mutating = true;
    this.invalidate();
    try {
      const response = await this.call(argv,120000,true);
      if (response.error) return response.error;
      if (argv.includes("usage")) {
        const status = (response.result as { status?: unknown } | null)?.status;
        if (status === "rate-limited")
          return {
            outcome: "unchanged",
            code: "rateLimited",
            message:
              "Usage is rate limited. SubBaton is respecting Retry-After; no retry was started.",
          };
        if (
          status === "usage-unknown-until-active" ||
          status === "access-token-expired"
        )
          return {
            outcome: "unchanged",
            code: "accessExpired",
            message:
              "Usage is unknown until the official CLI refreshes the active login.",
          };
        if (status === "unverified-isolation" || status === "identity-mismatch")
          return {
            outcome: "unchanged",
            code: "unverifiedUsage",
            message:
              "The usage reading could not be attributed safely. It was not trusted.",
          };
        if (status !== "ok")
          return {
            outcome: "unchanged",
            code: "usageUnavailable",
            message:
              "Fresh usage is unavailable. Inspect cached status and the CLI; no retry was started.",
          };
        return {
          outcome: "success",
          code: "usageRead",
          message:
            "Usage read completed; the CLI may have used its shared cache.",
        };
      }
      const outcome = (response.result as { outcome?: unknown } | null)
        ?.outcome;
      if (outcome === "no-candidate")
        return {
          outcome: "unchanged",
          code: "noCandidate",
          message:
            "No eligible quota target. Refresh unknown or stale usage through the CLI.",
        };
      if (outcome === "unchanged")
        return {
          outcome: "unchanged",
          code: "unchanged",
          message: "The active account remains selected.",
        };
      return {
        outcome: "success",
        code: "completed",
        message:
          "Command completed. Existing agents were not reopened; inspect the active marker before resuming.",
      };
    } finally {
      this.invalidate();
      this.mutating = false;
    }
  }
  async switch(input: z.infer<typeof switchInput>): Promise<ActionResult> {
    const parsed = switchInput.safeParse(input);
    if (!parsed.success)
      return failure("invalidInput", "Choose a valid saved account.");
    const { provider, target } = parsed.data;
    return this.mutation([
      ...(provider === "claude" ? [] : [provider]),
      "switch",
      target,
    ]);
  }
  async strategy(input: z.infer<typeof strategyInput>): Promise<ActionResult> {
    const parsed = strategyInput.safeParse(input);
    if (!parsed.success)
      return failure("invalidInput", "Choose a supported strategy.");
    if (parsed.data.provider !== "claude")
      return failure(
        "unsupportedStrategy",
        "Quota strategies currently belong to the Claude CLI. Use a named switch for this provider.",
      );
    return this.mutation([parsed.data.strategy]);
  }
  async refresh(): Promise<{ provider: Provider; result: ActionResult }[]> {
    if (this.mutating)
      return [
        {
          provider: "claude",
          result: failure("busy", "Another SubBaton action is running."),
        },
      ];
    const current = await this.status();
    if (!current.ok || !current.data)
      return [{ provider: "claude", result: current.error! }];
    const results: { provider: Provider; result: ActionResult }[] = [];
    for (const provider of current.data.providers.filter((p) =>
      p.accounts.some((a) => a.active),
    )) {
      results.push({
        provider: provider.provider,
        result: await this.mutation([
          ...(provider.provider === "claude" ? [] : [provider.provider]),
          "usage",
          "--refresh",
        ]),
      });
    }
    this.invalidate();
    return results;
  }
}
