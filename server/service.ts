import { BinaryTrustError } from "./binary.js";
import { settingsMessages } from "../shared/settings-messages.js";
import { z } from "zod";
import type { AgyProcessInfo, HandoffCli, SwitchOptions, SwitchOutcome } from "./handoff.js";
import type { HandoffProvider } from "../shared/handoff.js";
import {
  normalizeDocument,
  normalizeSection,
  validateChanges,
  settingsError,
} from "./settings.js";
import {
  settingsGetInput,
  settingsSetInput,
  settingsActionInput,
  pollerLifecycleInput,
  pollerStatusSchema,
  eventsInput,
  eventSchema,
  autoPlanInput,
  autoPlanSchema,
  type SettingsResult,
  type SettingsSection,
  type MutationResult,
  type PollerStatus,
  type SubBatonEvent,
  type AutoPlan,
} from "../shared/settings.js";
import {
  statusSchema,
  switchInput,
  strategyInput,
  strategyPreviewInput,
  type StrategyPreview,
  type Status,
  type ActionResult,
  type Provider,
  type StatusResult,
  type Account,
} from "../shared/contracts.js";
export interface CliExecutor {
  run(
    binary: string,
    argv: string[],
    timeout: number,
    input?: string,
  ): Promise<{ code: number; stdout: string; notStarted?: boolean }>;
}
const envelope = z.object({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      cause: z.string().optional(),
      stoppedProcesses: z.array(z.unknown()).max(1024).optional(),
      stopAttempted: z.boolean().optional(),
    })
    .optional(),
});
const failure = (code: string, message: string): ActionResult => ({
  outcome: "error",
  code,
  message,
});
const messages: Record<string, string> = {
  busy: "SubBaton is busy; retry later.",
  stopFailed: "Some agy sessions did not stop safely. Inspect holders before retrying recovery.",
  stopRefused: "agy sessions were not stopped (a desktop, unknown or changed session). Nothing was stopped or switched.",
  ambiguousStores: "Native stores disagree. Inspect the retained copies with the CLI.",
  identityHintMismatch: "The selected recovery identity does not match. Confirm its owner with the CLI.",
  processesRunning: "agy is running. Finish those sessions before switching.",
  processesNotAllowed: "An agy session outside Paseo is running. Nothing was stopped or switched.",
  needsLogin: "This account needs an official login or must be enabled.",
  recoveryRequired: "Recovery is pending. Resolve it with the CLI first.",
  signingRequired: "Use a stable signed SubBaton binary.",
  unsupportedStorageMode: "The provider storage mode is unsupported.",
  authOverride: "An environment override prevents subscription switching.",
  conflict: "Login ownership is conflicting. Review it with the CLI.",
  deviceBlocked: "The issuer blocked this device/account.",
};
type CallKind = "credential" | "settings" | "poller" | "read";
interface CallOptions {
  kind?: CallKind;
  input?: string;
  unavailable?: [string, string];
}
const uncertainMessages: Record<Exclude<CallKind, "credential">, string> = {
  read: "The result is unknown; nothing was changed. Retry shortly.",
  settings:
    "The settings result is unknown. Reload settings and check the current values before retrying; nothing was retried.",
  poller:
    "The poller change is unknown. Read poller status before retrying; nothing was retried.",
};
const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pidValue = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 2 ** 31 ? v : null);
/** The CLI accepts 1 to 64 positive PIDs for --only-pids; launchd and the kernel are never listed. */
const validPidList = (pids: number[]) => pids.length <= 64 && pids.every((p) => Number.isInteger(p) && p > 1 && p < 2 ** 31) && new Set(pids).size === pids.length;
export class SubBatonService {
  private cached: { value: StatusResult; at: number } | null = null;
  private pending: Promise<StatusResult> | null = null;
  private knownStatus: Status | null = null;
  private generation = 0;
  private mutating = false;
  constructor(
    private cli: CliExecutor,
    private binary: () => Promise<string>,
    private now: () => number = Date.now,
  ) {}
  private settingsCache: { value: SettingsResult; at: number } | null = null;
  private settingsPending: Promise<SettingsResult> | null = null;
  private knownSettings = new Map<Provider, SettingsSection>();
  private invalidate() {
    this.cached = null;
    this.generation++;
    this.pending = null;
    this.settingsCache = null;
    this.settingsPending = null;
  }
  private async call(
    command: string[] | ((binary: string) => string[]),
    timeout = 120000,
    mutation = false,
    options: CallOptions = {},
  ) {
    const kind = options.kind ?? "credential";
    const uncertain = (cause?: string): ActionResult =>
      kind === "credential"
        ? {
            outcome: "uncertain",
            code: "uncertain",
            ...(cause && messages[cause] ? { cause } : {}),
            message: (cause && messages[cause] ? messages[cause] + " " : "") +
              "Result uncertain. Run recovery with the SubBaton CLI and inspect current state before retrying. Agents were not reopened.",
          }
        : { outcome: "uncertain", code: "uncertain", message: uncertainMessages[kind] };
    const abnormal = (code: string, message: string) =>
      mutation
        ? uncertain()
        : options.unavailable
          ? failure(...options.unavailable)
          : failure(code, message);
    let binary: string;
    try {
      binary = await this.binary();
    } catch (error) {
      return {
        error: failure(
          "configuration",
          error instanceof BinaryTrustError
            ? error.message
            : "SubBaton binary configuration or trust verification failed. Check its owner, permissions and signature.",
        ),
      } as const;
    }
    const argv = typeof command === "function" ? command(binary) : command;
    try {
      const result = await this.cli.run(
        binary,
        [...argv, "--json"],
        timeout,
        ...(options.input === undefined ? [] : [options.input]),
      );
      if (result.notStarted)
        return {
          error: failure(
            "executionFailed",
            "SubBaton did not start. Check the verified binary path and executable permissions.",
          ),
        } as const;
      if (result.code === -2 || result.code === 2 && !mutation)
        return {
          error: abnormal(
            "statusUnavailable",
            "SubBaton status could not be read. Retry the cache-only status request later.",
          ),
        } as const;
      if (Buffer.byteLength(result.stdout) > 1024 * 1024)
        return {
          error: abnormal(
            "invalidResponse",
            "SubBaton returned an oversized response.",
          ),
        } as const;
      const parsed = envelope.safeParse(JSON.parse(result.stdout));
      if (!parsed.success)
        return {
          error: abnormal(
            "invalidResponse",
            "Unsupported SubBaton JSON. Update the configured CLI.",
          ),
        } as const;
      const value = parsed.data;
      if (mutation && (result.code === 2 || ["uncertain", "usageRecoveryUncertain", "lockLost"].includes(value.error?.code ?? "")))
        return { error: uncertain(value.error?.cause ?? value.error?.code) } as const;
      if (result.code === 1 && !value.ok && kind !== "credential") {
        const code = value.error?.code ?? "";
        const message = settingsMessages[code] ?? messages[code];
        return {
          error: failure(
            message ? code : "cliError",
            message ?? "SubBaton refused the operation. Inspect the CLI safely.",
          ),
        } as const;
      }
      if (result.code === 1 && !value.ok) {
        const code = value.error?.code ?? "";
        return {
          error: failure(
            messages[code] ? code : "cliError",
            messages[code] ??
              "SubBaton refused the operation. Inspect the CLI safely.",
          ),
          // agy: holders may already have been stopped when the switch then failed.
          // stopRefused/stopAttempted:false: refused before any signal, so nothing was closed.
          stopped: value.error?.stopAttempted === true || (value.error?.stopAttempted !== false && code === "stopFailed") || (value.error?.stoppedProcesses?.length ?? 0) > 0,
        } as const;
      }
      if (
        result.code !== 0 ||
        !value.ok ||
        !value.result ||
        typeof value.result !== "object"
      )
        return {
          error: abnormal(
            "invalidResponse",
            "SubBaton returned inconsistent exit/JSON status.",
          ),
        } as const;
      if (
        mutation &&
        kind === "credential" &&
        !argv.includes("usage") &&
        !argv.includes("auto") &&
        !argv.includes("daemon") &&
        !["switched", "unchanged", "alreadyActive", "no-candidate"].includes(
          (value.result as { outcome: string }).outcome,
        )
      )
        return { error: uncertain() } as const;
      return { result: value.result } as const;
    } catch {
      return {
        error: abnormal(
          "executionFailed",
          "Unable to read SubBaton status. Check the CLI configuration.",
        ),
      } as const;
    }
  }
  configurationChanged() {
    this.knownStatus = null;
    this.knownSettings.clear();
    this.invalidate();
  }
  private async fetchStatus(generation: number): Promise<StatusResult> {
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
    if (generation === this.generation) this.knownStatus = parsed.data;
    return { ok: true, data: parsed.data, error: null };
  }
  async status(): Promise<StatusResult> {
    if (this.cached && this.now() - this.cached.at < 15000)
      return this.cached.value;
    if (this.pending) return this.pending;
    const generation = this.generation;
    const promise = this.fetchStatus(generation).then((value) => {
      if (generation === this.generation)
        this.cached = { value, at: this.now() };
      return value;
    });
    this.pending = promise;
    try {
      return await promise;
    } finally {
      if (this.pending === promise) this.pending = null;
    }
  }
  private async mutation(argv: string[]): Promise<ActionResult> {
    if (this.mutating)
      return failure("busy", "Another SubBaton action is still running.");
    this.mutating = true;
    this.invalidate();
    try {
      const response = await this.call(argv, 120000, true);
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
      if (outcome === "alreadyActive")
        return {
          outcome: "unchanged",
          code: "alreadyActive",
          message: "This account is already active. No switch was needed.",
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
    if (
      !this.knownStatus?.providers
        .find((p) => p.provider === provider)
        ?.accounts.some((a) => a.id === target)
    )
      return failure(
        "unknownAccount",
        "Reload cached status and choose a known saved account UUID for this provider.",
      );
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
  /**
   * "Switch to best account" for Codex and agy: `<provider> best --dry-run` on an explicit click.
   * It may read usage under the CLI's own floors and backoff, so it is never called for display
   * polling. It only names a target; the switch itself goes through the named switch or handoff.
   */
  async strategyPreview(input: unknown): Promise<StrategyPreview> {
    const parsed = strategyPreviewInput.safeParse(input);
    if (!parsed.success)
      return { outcome: "error", message: "Choose Codex or agy." };
    if (this.mutating)
      return { outcome: "error", message: "Another SubBaton action is still running." };
    this.mutating = true;
    try {
      const { provider } = parsed.data;
      const response = await this.call([provider, "best", "--dry-run"], 120000);
      if (response.error) return { outcome: "error", message: response.error.message };
      const result = response.result as { outcome?: unknown; target?: unknown };
      if (result.outcome === "no-candidate")
        return { outcome: "none", message: "No eligible account right now." };
      const account = this.knownStatus?.providers
        .find((p) => p.provider === provider)
        ?.accounts.find((a) => a.id === result.target);
      if (result.outcome === "unchanged" || (result.outcome === "dryRun" && account?.active))
        return { outcome: "unchanged", message: "The active account is the best.", ...(account ? { alias: account.alias } : {}) };
      if (result.outcome !== "dryRun" || !account)
        return { outcome: "error", message: "SubBaton named a target this host does not know. Refresh and try again." };
      return { outcome: "target", message: "Best account found.", target: account.id, alias: account.alias };
    } finally {
      this.invalidate();
      this.mutating = false;
    }
  }
  /** The active saved account of a provider, from a fresh cache-only status read; null when unknown. */
  async activeAccount(provider: Provider): Promise<string | null> {
    this.invalidate();
    const status = await this.status();
    return status.data?.providers.find((p) => p.provider === provider)?.accounts.find((a) => a.active)?.id ?? null;
  }
  /** One saved account from the (cached, cache-only) status; null when the status is unreadable or the account unknown. */
  async accountUsage(provider: Provider, id: string): Promise<Account | null> {
    const status = await this.status();
    return status.data?.providers.find((p) => p.provider === provider)?.accounts.find((a) => a.id === id) ?? null;
  }
  async refresh(): Promise<
    { provider: Provider | null; result: ActionResult }[]
  > {
    if (this.mutating)
      return [
        {
          provider: null,
          result: failure("busy", "Another SubBaton action is running."),
        },
      ];
    const current = await this.status();
    if (!current.ok || !current.data)
      return [{ provider: null, result: current.error! }];
    const results: { provider: Provider | null; result: ActionResult }[] = [];
    for (const provider of current.data.providers) {
      if (
        provider.provider === "unknown" ||
        !provider.accounts.some((a) => a.active)
      )
        continue;
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

  // ---- Phase 6b: settings, poller, events and auto plan (all through the trusted CLI) ----

  private async fetchSettings(generation: number): Promise<SettingsResult> {
    const response = await this.call(["settings", "get"], 20000, false, {
      kind: "settings",
      unavailable: [
        "settingsUnavailable",
        "SubBaton settings could not be read. Retry shortly.",
      ],
    });
    if (response.error) return { ok: false, data: null, error: response.error };
    const data = normalizeDocument(response.result);
    if (!data)
      return {
        ok: false,
        data: null,
        error: failure("invalidResponse", "SubBaton settings schema is unsupported."),
      };
    if (generation === this.generation)
      for (const section of data.providers)
        if (section.ok) this.knownSettings.set(section.provider, section);
        else this.knownSettings.delete(section.provider);
    return { ok: true, data, error: null };
  }
  async settings(input: unknown): Promise<SettingsResult> {
    const parsed = settingsGetInput.safeParse(input ?? {});
    if (!parsed.success)
      return { ok: false, data: null, error: failure("invalidInput", "Invalid settings request.") };
    if (parsed.data.fresh) {
      this.settingsCache = null;
      this.settingsPending = null;
    }
    if (this.settingsCache && this.now() - this.settingsCache.at < 15000)
      return this.settingsCache.value;
    if (this.settingsPending) return this.settingsPending;
    const generation = this.generation;
    const promise = this.fetchSettings(generation).then((value) => {
      if (generation === this.generation)
        this.settingsCache = { value, at: this.now() };
      return value;
    });
    this.settingsPending = promise;
    try {
      return await promise;
    } finally {
      if (this.settingsPending === promise) this.settingsPending = null;
    }
  }
  private async settingsMutation(
    provider: Provider,
    argv: string[],
    outcomes: Record<string, ActionResult>,
    input?: string,
  ): Promise<MutationResult> {
    if (this.mutating)
      return { result: failure("busy", "Another SubBaton action is still running."), section: null };
    this.mutating = true;
    this.invalidate();
    try {
      const response = await this.call(argv, 30000, true, {
        kind: "settings",
        ...(input === undefined ? {} : { input }),
      });
      if (response.error) {
        if (response.error.code === "revisionConflict") this.knownSettings.delete(provider);
        return { result: response.error, section: null };
      }
      const value = response.result as { outcome?: unknown; settings?: unknown };
      const result = typeof value.outcome === "string" ? outcomes[value.outcome] : undefined;
      if (!result) return { result: uncertainSettings(), section: null };
      if (value.settings === undefined) return { result, section: null };
      try {
        const section = normalizeSection(provider, value.settings);
        this.knownSettings.set(provider, section);
        return { result, section };
      } catch {
        return { result: uncertainSettings(), section: null };
      }
    } finally {
      this.invalidate();
      this.mutating = false;
    }
  }
  async settingsSet(input: unknown): Promise<MutationResult> {
    const parsed = settingsSetInput.safeParse(input);
    if (!parsed.success)
      return { result: settingsError("invalidSetting"), section: null };
    const { provider, expectedRevision, changes } = parsed.data;
    const section = this.knownSettings.get(provider);
    if (!section) return { result: settingsError("reloadSettings"), section: null };
    // The draft's base revision must still be the newest one this host has seen (review L1/M1).
    if (expectedRevision !== section.revision) return { result: settingsError("revisionConflict"), section: null };
    const validation = validateChanges(section, changes);
    if (!validation.ok) return { result: settingsError(validation.code), section: null };
    const body = JSON.stringify({
      changes: validation.changes,
      expectedRevision: { [provider]: expectedRevision },
    });
    if (Buffer.byteLength(body) > 128 * 1024)
      return { result: settingsError("invalidSetting"), section: null };
    return this.settingsMutation(
      provider,
      ["settings", "set", "--json-input", "-"],
      { updated: { outcome: "success", code: "updated", message: "Settings saved." } },
      body,
    );
  }
  async settingsAction(input: unknown): Promise<MutationResult> {
    const parsed = settingsActionInput.safeParse(input);
    if (!parsed.success)
      return { result: failure("invalidInput", "Choose a supported action with the current revision."), section: null };
    const action = parsed.data;
    const section = this.knownSettings.get(action.provider);
    if (!section) return { result: settingsError("reloadSettings"), section: null };
    if (action.expectedRevision !== section.revision) return { result: settingsError("revisionConflict"), section: null };
    if (action.action === "renameAccount") {
      if (!section.accounts.some((a) => a.id === action.account)) return { result: settingsError("unknownAccount"), section: null };
      if (section.readOnly) return { result: settingsError("readOnly"), section: null };
      return this.settingsMutation(action.provider,
        [action.provider, "alias", action.account, action.alias, "--expected-revision", action.expectedRevision],
        { updated: { outcome: "success", code: "updated", message: "Account renamed." } });
    }
    if (!section.actions.includes(action.action))
      return { result: failure("unsupportedAction", "The CLI does not offer this action for this provider."), section: null };
    if (action.action === "resumeAuto") {
      if (!section.auto.paused || action.pauseId !== section.auto.pauseId)
        return { result: settingsError("pauseChanged"), section: null };
      return this.settingsMutation(
        action.provider,
        ["settings", "resume-auto", action.provider, "--pause-id", action.pauseId, "--expected-revision", action.expectedRevision],
        {
          resumed: { outcome: "success", code: "resumed", message: "Automatic switching resumed." },
          notPaused: { outcome: "unchanged", code: "notPaused", message: "Automatic switching was not paused." },
        },
      );
    }
    if (!section.accounts.some((a) => a.id === action.account))
      return { result: settingsError("unknownAccount"), section: null };
    const release = action.action === "releaseQuarantine";
    return this.settingsMutation(
      action.provider,
      [
        "settings",
        release ? "release-quarantine" : "release-device-block",
        action.provider,
        action.account,
        "--expected-revision",
        action.expectedRevision,
      ],
      release
        ? {
            quarantineReleased: {
              outcome: "success",
              code: "quarantineReleased",
              message:
                "Quarantine released. This does not validate or renew the login; the official CLI may still require a fresh login on the Mac.",
            },
          }
        : {
            deviceBlockReleased: {
              outcome: "success",
              code: "deviceBlockReleased",
              message:
                "Local device block released. The issuer may still refuse this account; no login or retry was performed.",
            },
          },
    );
  }
  async pollerStatus(_input?: unknown): Promise<{ ok: boolean; data: PollerStatus | null; error: ActionResult | null }> {
    const response = await this.call(["poller", "status"], 20000, false, {
      kind: "poller",
      unavailable: ["pollerUnavailable", "Poller status could not be read. Retry shortly."],
    });
    if (response.error) return { ok: false, data: null, error: response.error };
    const parsed = pollerStatusSchema.safeParse(response.result);
    if (!parsed.success)
      return { ok: false, data: null, error: failure("invalidResponse", "Poller status schema is unsupported.") };
    return { ok: true, data: parsed.data, error: null };
  }
  async pollerLifecycle(input: unknown): Promise<{ result: ActionResult; status: PollerStatus | null }> {
    const parsed = pollerLifecycleInput.safeParse(input);
    if (!parsed.success)
      return { result: failure("invalidInput", "Choose install or uninstall."), status: null };
    if (this.mutating)
      return { result: failure("busy", "Another SubBaton action is still running."), status: null };
    this.mutating = true;
    this.invalidate();
    const install = parsed.data.action === "install";
    try {
      // Install pins the same canonical binary that just passed the plugin's trust checks.
      const response = await this.call(
        (binary) =>
          install
            ? ["poller", "install", "--binary", binary, ...(parsed.data.environment === "keep" ? [] : ["--environment", parsed.data.environment])]
            : ["poller", "uninstall"],
        120000,
        true,
        { kind: "poller" },
      );
      if (response.error) return { result: response.error, status: null };
      const value = response.result as { outcome?: unknown };
      if (value.outcome !== (install ? "installed" : "uninstalled"))
        return { result: { outcome: "uncertain", code: "uncertain", message: uncertainMessages.poller }, status: null };
      const status = pollerStatusSchema.safeParse(response.result);
      return {
        result: {
          outcome: "success",
          code: install ? "installed" : "uninstalled",
          message: install
            ? "Poller installed for the Mac's logged-in user."
            : "Poller uninstalled. Saved accounts, caches and logs are kept.",
        },
        status: status.success ? status.data : null,
      };
    } finally {
      this.invalidate();
      this.mutating = false;
    }
  }
  async events(input: unknown): Promise<{ ok: boolean; data: { events: SubBatonEvent[] } | null; error: ActionResult | null }> {
    const parsed = eventsInput.safeParse(input ?? {});
    if (!parsed.success || (parsed.data.since ?? 0) > 1e11)
      return { ok: false, data: null, error: failure("invalidInput", "Invalid event time.") };
    const since = parsed.data.since;
    const response = await this.call(
      since === undefined ? ["events"] : ["events", "--since", String(Math.floor(since))],
      10000,
      false,
      { kind: "read", unavailable: ["eventsUnavailable", "Events could not be read. Retry shortly."] },
    );
    if (response.error) return { ok: false, data: null, error: response.error };
    const events = (response.result as { events?: unknown }).events;
    if (!Array.isArray(events))
      return { ok: false, data: null, error: failure("invalidResponse", "Event schema is unsupported.") };
    const parsedEvents = events.slice(-500).flatMap((event) => {
      const row = eventSchema.safeParse(event);
      return row.success ? [row.data] : [];
    });
    return { ok: true, data: { events: parsedEvents }, error: null };
  }
  async autoPlan(input: unknown): Promise<{ ok: boolean; data: AutoPlan | null; error: ActionResult | null }> {
    const parsed = autoPlanInput.safeParse(input);
    if (!parsed.success)
      return { ok: false, data: null, error: failure("invalidInput", "Choose a provider.") };
    const provider = parsed.data.provider;
    const response = await this.call(
      [...(provider === "claude" ? [] : [provider]), "auto", "plan"],
      15000,
      false,
      { kind: "read", unavailable: ["planUnavailable", "The automatic plan could not be read. Retry shortly."] },
    );
    if (response.error) return { ok: false, data: null, error: response.error };
    const plan = autoPlanSchema.safeParse(response.result);
    if (!plan.success)
      return { ok: false, data: null, error: failure("invalidResponse", "Automatic plan schema is unsupported.") };
    return { ok: true, data: plan.data, error: null };
  }

  // ---- Phase 6b part 2: CLI side of the coordinated handoff ----

  knownAccount(provider: Provider, target: string): { alias: string } | null {
    const account = this.knownStatus?.providers
      .find((p) => p.provider === provider)
      ?.accounts.find((a) => a.id === target);
    return account ? { alias: account.alias } : null;
  }
  /**
   * agy process inventory. Ancestry (review H1) comes from the CLI's per-process `ancestors`
   * ([{pid, executable}], parent first up to launchd, at most 32) and `ancestorsComplete`; a
   * process without ancestry is unattributable.
   */
  async agyProcesses(): Promise<{ ok: true; processes: AgyProcessInfo[] } | { ok: false }> {
    const response = await this.call(["agy", "processes"], 15000, false, { kind: "read" });
    const processes = (response.result as { processes?: unknown } | undefined)?.processes;
    if (response.error || !Array.isArray(processes) || processes.length > 1024) return { ok: false };
    const parsed: AgyProcessInfo[] = [];
    for (const raw of processes) {
      const row = (raw ?? {}) as { pid?: unknown; kind?: unknown; ancestors?: unknown; ancestorsComplete?: unknown };
      const own = pidValue(row.pid);
      if (own === null) return { ok: false };
      let ancestors: AgyProcessInfo["ancestors"] = null;
      if (Array.isArray(row.ancestors) && row.ancestors.length <= 64) {
        const chain = row.ancestors.map((a) => {
          const entry = (a ?? {}) as { pid?: unknown; executable?: unknown };
          const id = pidValue(entry.pid);
          const executable = typeof entry.executable === "string" && entry.executable.length > 0 && entry.executable.length <= 255 ? entry.executable : null;
          return id === null ? null : { pid: id, executable };
        });
        if (chain.every((v) => v !== null)) ancestors = chain as NonNullable<AgyProcessInfo["ancestors"]>;
      }
      parsed.push({
        pid: own,
        kind: typeof row.kind === "string" ? row.kind.slice(0, 32) : "unknown",
        ancestors,
        complete: ancestors !== null && row.ancestorsComplete === true,
      });
    }
    return { ok: true, processes: parsed };
  }
  /** Runs a handoff switch: fixed argv, verified outcome required, stop detection on refusal. */
  async handoffSwitch(provider: HandoffProvider, target: string, options: SwitchOptions): Promise<SwitchOutcome> {
    const pids = options.onlyPids ?? [];
    const validPids = validPidList(pids);
    const wrongScope = provider === "agy" ? options.restartDaemon === true : pids.length > 0;
    if (!/^[0-9a-f-]{36}$/i.test(target) || !validPids || wrongScope || !this.knownAccount(provider, target))
      return { kind: "refused", code: "invalidInput", message: "The handoff target is not a known saved account." };
    // agy: stop exactly the Paseo-attributed PIDs; the CLI refuses if any other agy process runs.
    const flags =
      provider === "agy"
        ? pids.length ? ["--stop-agy", "--only-pids", pids.join(",")] : []
        : options.restartDaemon ? ["--restart-daemon"] : [];
    if (this.mutating) return { kind: "busy", code: "busy", message: "Another SubBaton action is still running." };
    this.mutating = true;
    this.invalidate();
    try {
      const response = await this.call([provider, "switch", target, ...flags], 120000, true);
      if (response.error) {
        const stopped = "stopped" in response && response.stopped === true;
        if (response.error.outcome === "uncertain")
          return { kind: "uncertain", code: "uncertain", message: "The switch result is uncertain." };
        if (response.error.code === "processesNotAllowed")
          return { kind: "notAllowed", code: "processesNotAllowed", message: response.error.message };
        return {
          kind: stopped ? "stoppedFailed" : "refused",
          code: response.error.code,
          message: response.error.message,
        };
      }
      const result = response.result as { transaction?: unknown; outcome?: unknown; postSwitchVerification?: unknown; daemonOutcome?: unknown };
      const daemonOutcome = typeof result.daemonOutcome === "string" ? result.daemonOutcome.slice(0, 64) : null;
      if (result.outcome === "alreadyActive" || result.outcome === "unchanged")
        return { kind: "unchanged", code: "alreadyActive", message: "That account was already active.", daemonOutcome };
      const verified = provider === "agy" ? ["verified", "reapplied"] : ["verified"];
      if (result.outcome === "switched" && verified.includes(String(result.postSwitchVerification)))
        return { kind: "switched", code: "switched", message: "Switch verified.", daemonOutcome, transaction: typeof result.transaction === "string" && result.transaction.length <= 256 ? result.transaction : undefined };
      return { kind: "uncertain", code: "uncertain", message: "The switch could not be verified.", daemonOutcome };
    } finally {
      this.invalidate();
      this.mutating = false;
    }
  }
  /** The coordinator's view of this service. */
  /** agy auto plan, read-only: is running agy the only thing blocking an automatic switch? */
  async agyAutoPlan(): Promise<{ ok: true; blockedOnlyByProcesses: boolean; target: string | null } | { ok: false }> {
    const response = await this.call(["agy", "auto", "plan"], 15000, false, { kind: "read" });
    if (response.error) return { ok: false };
    const plan = response.result as { blockedOnlyByProcesses?: unknown; targetIfProcessesStopped?: unknown; executionEnabled?: unknown };
    if (typeof plan.blockedOnlyByProcesses !== "boolean") return { ok: false };
    const target = typeof plan.targetIfProcessesStopped === "string" && uuidLike.test(plan.targetIfProcessesStopped) ? plan.targetIfProcessesStopped : null;
    // A paused or disabled provider never executes, so it is never "blocked only by processes" for us.
    const blocked = plan.blockedOnlyByProcesses && plan.executionEnabled === true && target !== null;
    return { ok: true, blockedOnlyByProcesses: blocked, target: blocked ? target : null };
  }
  /** agy auto run-once --stop-agy --only-pids: the automatic switch, stopping only Paseo's sessions. */
  async agyAutoRunOnce(pids: number[]): Promise<SwitchOutcome> {
    if (pids.length === 0 || !validPidList(pids))
      return { kind: "refused", code: "invalidInput", message: "No Paseo agy sessions to stop." };
    if (this.mutating) return { kind: "busy", code: "busy", message: "Another SubBaton action is still running." };
    this.mutating = true;
    this.invalidate();
    try {
      const response = await this.call(["agy", "auto", "run-once", "--stop-agy", "--only-pids", pids.join(",")], 120000, true);
      if (response.error) {
        if (response.error.outcome === "uncertain") return { kind: "uncertain", code: "uncertain", message: "The automatic switch result is uncertain." };
        const stopped = "stopped" in response && response.stopped === true;
        return { kind: stopped ? "stoppedFailed" : "refused", code: response.error.code, message: response.error.message };
      }
      const result = response.result as {
        outcome?: unknown;
        reason?: unknown;
        failure?: unknown;
        stopProcesses?: unknown;
        stopAttempted?: unknown;
        retryAt?: unknown;
        stoppedProcesses?: unknown;
        processes?: unknown;
        switch?: { postSwitchVerification?: unknown; stoppedProcesses?: unknown };
      };
      const reason = typeof result.reason === "string" ? result.reason.slice(0, 64) : "";
      const stoppedAny = (Array.isArray(result.stoppedProcesses) && result.stoppedProcesses.length > 0) || (Array.isArray(result.switch?.stoppedProcesses) && result.switch.stoppedProcesses.length > 0);
      switch (result.outcome) {
        case "switched":
          return ["verified", "reapplied"].includes(String(result.switch?.postSwitchVerification))
            ? { kind: "switched", code: "switched", message: "Automatic switch verified." }
            : { kind: "uncertain", code: "uncertain", message: "The automatic switch could not be verified." };
        case "deferred":
          if (reason === "processNotAllowed")
            return { kind: "notAllowed", code: "processesNotAllowed", message: messages.processesNotAllowed! };
          if (reason === "processStopFailed" && result.stopAttempted !== false)
            return {
              kind: "stoppedFailed",
              code: "stopFailed",
              message: "Some agy sessions did not stop. Nothing was switched.",
              ...(typeof result.retryAt === "number" && Number.isFinite(result.retryAt) ? { retryAt: result.retryAt } : {}),
            };
          // processStopRefused (stopAttempted false), busy, processBusy...: nothing was signalled.
          return { kind: "notRun", code: reason || "deferred", message: "The automatic switch did not run. Nothing was stopped." };
        case "failed": {
          const code = typeof result.failure === "string" ? result.failure.slice(0, 64) : "switchFailed";
          return stoppedAny
            ? { kind: "stoppedFailed", code, message: "The automatic switch failed after agy sessions were stopped." }
            : { kind: "refused", code, message: "The automatic switch failed. Nothing was stopped." };
        }
        case "uncertain":
          return { kind: "uncertain", code: "uncertain", message: "The automatic switch result is uncertain." };
        default:
          // off, paused, held, stay, blocked, revalidated: the policy changed its mind; nothing ran.
          if (result.stopProcesses === true && stoppedAny)
            return { kind: "uncertain", code: "uncertain", message: "Unexpected automatic switch result after stopping agy sessions." };
          return { kind: "notRun", code: typeof result.outcome === "string" ? result.outcome.slice(0, 64) : "unknown", message: "The automatic switch no longer applies. Nothing was stopped." };
      }
    } finally {
      this.invalidate();
      this.mutating = false;
    }
  }
  /** codex processes: is a daemon restart still pending after an automatic switch? null = unknown. */
  async codexDaemonPending(): Promise<boolean | null> {
    const response = await this.call(["codex", "processes"], 15000, false, { kind: "read" });
    if (response.error) return null;
    const pending = (response.result as { daemonRestartPending?: unknown }).daemonRestartPending;
    return typeof pending === "boolean" ? pending : null;
  }
  /** codex daemon restart: restarted, failed or pending (timeout); anything else is unknown. */
  async codexDaemonRestart(): Promise<string> {
    if (this.mutating) return "busy";
    this.mutating = true;
    try {
      const response = await this.call(["codex", "daemon", "restart", "--if-pending"], 60000, true);
      if (response.error) return response.error.outcome === "uncertain" ? "unknown" : "failed";
      const outcome = (response.result as { daemonOutcome?: unknown; outcome?: unknown });
      const value = typeof outcome.daemonOutcome === "string" ? outcome.daemonOutcome : outcome.outcome;
      return ["restarted", "failed", "pending", "notPending"].includes(String(value)) ? String(value) : "unknown";
    } finally {
      this.mutating = false;
    }
  }
  handoffCli(): HandoffCli {
    return {
      agyProcesses: () => this.agyProcesses(),
      switchAccount: (provider, target, options) => this.handoffSwitch(provider, target, options),
      agyAutoPlan: () => this.agyAutoPlan(),
      agyAutoRunOnce: (pids) => this.agyAutoRunOnce(pids),
      codexDaemonPending: () => this.codexDaemonPending(),
      codexDaemonRestart: () => this.codexDaemonRestart(),
      events: async (since) => {
        const read = await this.events(since === null ? {} : { since: Math.floor(since) });
        return read.ok && read.data ? { ok: true, events: read.data.events } : { ok: false };
      },
      knownAccount: (provider, target) => this.knownAccount(provider, target),
    };
  }
}
const uncertainSettings = (): ActionResult => ({
  outcome: "uncertain",
  code: "uncertain",
  message: uncertainMessages.settings,
});
