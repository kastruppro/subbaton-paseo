import type { CliExecutor } from "../server/service.js";
import { SubBatonService } from "../server/service.js";

// Mirrors the CLI projection in subbaton-app Sources/SubBatonCore/Settings*.swift (phase-4-auto).
export const accountA = "11111111-1111-4111-8111-111111111111";
export const accountB = "22222222-2222-4222-8222-222222222222";
export const revision = "6f1c2d4e-0000-4000-8000-000000000001";

const events = [
  "automaticSwitch",
  "switchFailed",
  "needsLogin",
  "deviceBlocked",
  "quarantineReleased",
  "deviceBlockReleased",
  "paused",
];
const strategies = [
  "best",
  "next-available",
  "weekly-first",
  "consume-first",
  "priority-consume-first",
];
const threshold = {
  type: "number",
  default: null,
  unit: "percent used",
  nullable: true,
  minimum: 50,
  maximum: 99.9,
  runtime: "persistedOnly",
  title: "Window threshold",
  description: "Used-percent override for this window or model; null inherits.",
};
const dictionary = (path: string, scope: string, knownKeys: string[]) => [
  {
    path: `<provider>.${path}`,
    type: "object",
    default: path === "thresholds.windows" ? { "5h": null, "7d": null } : {},
    unit: "none",
    scope,
    nullable: false,
    runtime: "persistedOnly",
    title: path.endsWith("windows") ? "Window thresholds" : "Model thresholds",
    description:
      "Used-percent overrides by window; null inherits. Replacing this object clears omitted overrides.",
    additionalProperties: {
      type: "number",
      nullable: true,
      minimum: 50,
      maximum: 99.9,
    },
    maxNonNullProperties: 128,
    keyPattern: "^[A-Za-z0-9_:.\\-]{1,100}$",
    knownKeys,
  },
  {
    ...threshold,
    path: `<provider>.${path}.${path.endsWith("windows") ? "<window>" : "<model>"}`,
    scope,
    title: path.endsWith("windows") ? "Window threshold" : "Model threshold",
  },
];
export const fields = (windows: string[], models: string[]) => [
  {
    path: "<provider>.autoEnabled",
    type: "boolean",
    default: false,
    unit: "none",
    scope: "provider",
    nullable: false,
    runtime: "persistedOnly",
    title: "Automatic switching",
    description: "Allow this provider's later automatic policy engine to switch accounts.",
  },
  {
    path: "<provider>.thresholds.global",
    type: "number",
    default: 95,
    unit: "percent used",
    scope: "provider",
    nullable: false,
    minimum: 50,
    maximum: 99.9,
    runtime: "persistedOnly",
    title: "Default threshold",
    description: "Used-percent threshold; account null inherits the provider default.",
  },
  ...dictionary("thresholds.windows", "provider window", windows),
  ...dictionary("thresholds.models", "provider model", models),
  {
    path: "<provider>.cooldownMinutes",
    type: "number",
    default: 5,
    unit: "minutes",
    scope: "provider",
    nullable: false,
    minimum: 0,
    maximum: 1440,
    runtime: "persistedOnly",
    title: "Switch cooldown",
    description: "Minimum minutes between automatic switches.",
  },
  {
    path: "<provider>.improvementMargin",
    type: "number",
    default: 5,
    unit: "percentage points",
    scope: "provider",
    nullable: false,
    minimum: 0,
    maximum: 50,
    runtime: "persistedOnly",
    title: "Improvement margin",
    description: "Minimum improvement in headroom or forecast waste, in percentage points.",
  },
  {
    path: "<provider>.strategy",
    type: "string",
    default: "best",
    unit: "none",
    scope: "provider",
    nullable: false,
    enum: strategies,
    enumDescriptions: Object.fromEntries(
      strategies.map((s) => [s, `CLI description of ${s}.`]),
    ),
    runtime: "persistedOnly",
    title: "Switch strategy",
    description: "Order eligible accounts using this selection rule.",
  },
  {
    path: "<provider>.weeklyResetPriority.enabled",
    type: "boolean",
    default: true,
    unit: "none",
    scope: "provider",
    nullable: false,
    runtime: "persistedOnly",
    title: "Weekly reset priority",
    description: "Prioritize forecast unused weekly quota approaching its reset.",
  },
  {
    path: "<provider>.weeklyResetPriority.horizonDays",
    type: "integer",
    default: 5,
    unit: "days",
    scope: "provider",
    nullable: false,
    minimum: 1,
    maximum: 30,
    runtime: "persistedOnly",
    title: "Weekly reset horizon",
    description: "Consider weekly resets within this many days.",
  },
  {
    path: "<provider>.inactiveIntervalHours",
    type: "number",
    default: 0,
    unit: "hours; 0 disables interval polling",
    scope: "provider",
    nullable: false,
    minimum: 0,
    maximum: 720,
    allowedRanges: [
      [0, 0],
      [1, 720],
    ],
    pollFloorSeconds: 180,
    runtime: "active",
    title: "Inactive polling interval",
    description: "Hours between optional inactive-account reads; zero disables interval polling.",
  },
  {
    path: "<provider>.order",
    type: "array",
    default: [],
    unit: "none",
    scope: "provider accounts",
    nullable: false,
    items: { type: "string", scope: "existing account alias or id" },
    constraint: "Every account exactly once.",
    runtime: "active",
    title: "Account order",
    description: "Saved account sequence; include every account exactly once.",
  },
  {
    path: "<provider>.accounts.<account>.enabled",
    type: "boolean",
    default: true,
    unit: "none",
    scope: "account",
    nullable: false,
    runtime: "active",
    title: "Account enabled",
    description: "Include this account in existing eligibility checks.",
  },
  {
    path: "<provider>.accounts.<account>.priority",
    type: "integer",
    default: 0,
    unit: "none",
    scope: "account",
    nullable: false,
    minimum: 0,
    maximum: 1000,
    runtime: "active",
    title: "Account priority",
    description: "Higher values rank first when the strategy uses priority.",
  },
  {
    path: "<provider>.accounts.<account>.thresholds.global",
    type: "number",
    default: null,
    unit: "percent used",
    scope: "account",
    nullable: true,
    minimum: 50,
    maximum: 99.9,
    runtime: "persistedOnly",
    title: "Default threshold",
    description: "Used-percent threshold; account null inherits the provider default.",
  },
  ...dictionary("accounts.<account>.thresholds.windows", "account window", windows),
  ...dictionary("accounts.<account>.thresholds.models", "account model", models),
  {
    path: "<provider>.notifications.enabled",
    type: "boolean",
    default: true,
    unit: "none",
    scope: "provider",
    nullable: false,
    runtime: "persistedOnly",
    title: "Notifications",
    description: "Allow configured notification events for this provider.",
  },
  ...events.map((e) => ({
    path: `<provider>.notifications.events.${e}`,
    type: "boolean",
    default: true,
    unit: "none",
    scope: "provider event",
    nullable: false,
    runtime: "persistedOnly",
    title: `${e} notification`,
    description: `Notify for ${e}.`,
  })),
];

const account = (alias: string, extra: Record<string, unknown> = {}) => ({
  alias,
  quarantined: false,
  deviceBlocked: false,
  needsLogin: false,
  enabled: true,
  priority: 0,
  thresholds: { global: null, windows: { "5h": null, "7d": null }, models: {} },
  ...extra,
});
export const claudeValues = {
  autoEnabled: false,
  thresholds: {
    global: 95,
    windows: { "5h": null, "7d": 90 },
    models: { "Opus-4.5": 80 },
  },
  cooldownMinutes: 5,
  improvementMargin: 5,
  strategy: "best",
  weeklyResetPriority: { enabled: true, horizonDays: 5 },
  inactiveIntervalHours: 0,
  order: [accountA, accountB],
  notifications: {
    enabled: true,
    events: Object.fromEntries(events.map((e) => [e, true])),
  },
  accounts: {
    [accountA]: account("work"),
    [accountB]: account("home", {
      quarantined: true,
      needsLogin: true,
      priority: 7,
      thresholds: {
        global: 85,
        windows: { "5h": 70, "7d": null },
        models: {},
      },
    }),
  },
};
export const claudeSection = (rev = revision, values: Record<string, unknown> = structuredClone(claudeValues)) => ({
  schemaVersion: 1,
  supportedSchemaVersion: 1,
  exists: true,
  migrationRequired: false,
  readOnly: false,
  revision: rev,
  values,
  defaults: { ...claudeValues, accounts: {}, accountDefaults: {} },
  effective: {
    ...values,
    thresholds: {
      global: 95,
      windows: { "5h": 95, "7d": 90 },
      models: { "Opus-4.5": 80 },
    },
  },
  fields: fields(
    ["5h", "7d", "five_hour", "seven_day", "weekly_scoped:Opus-4.5"],
    ["Opus", "Opus-4.5", "Sonnet"],
  ),
  thresholdResolution: "CLI text.",
  actions: [
    { name: "releaseQuarantine", command: "x", scope: "x", required: ["account", "expectedRevision"], audit: true },
    { name: "resumeAuto", command: "x", scope: "x", required: ["expectedRevision"], audit: false },
  ],
  auto: {
    paused: true,
    pauseReason: "flapping",
    pausedAt: 1000,
    recentAutomaticSwitches: 4,
    flapLimit: 4,
    flapWindowSeconds: 3600,
    lastAutomaticSwitchAt: 990,
  },
  warnings: [],
  privateNote: "secret-token",
});
export const settingsDocument = (claude: unknown = claudeSection()) => ({
  settingsSchemaVersion: 1,
  providers: {
    claude,
    codex: { error: { code: "busy", message: "secret-token raw" } },
    agy: {
      ...claudeSection("legacy", {
        ...claudeValues,
        order: [],
        accounts: {},
      }),
      exists: false,
      readOnly: true,
      actions: [],
      auto: { paused: false, recentAutomaticSwitches: 0, flapLimit: 4, flapWindowSeconds: 3600, lastAutomaticSwitchAt: null },
    },
  },
  runtime: "CLI text",
  poller: { installed: true, lastTickAt: 5000, stale: false },
});
export const ok = (result: unknown, code = 0) => ({
  code,
  stdout: JSON.stringify({ schemaVersion: 1, ok: true, result, warnings: [] }),
});
export const refused = (code: string, exit = 1) => ({
  code: exit,
  stdout: JSON.stringify({
    schemaVersion: 1,
    ok: false,
    error: { code, message: "secret-token raw" },
  }),
});

export type Response = { code: number; stdout: string; notStarted?: boolean };
export class ScriptedCLI implements CliExecutor {
  calls: { binary: string; argv: string[]; timeout: number; input?: string }[] = [];
  routes: [(argv: string[]) => boolean, (argv: string[]) => Response][] = [];
  on(match: string[] | ((argv: string[]) => boolean), respond: Response | ((argv: string[]) => Response)) {
    const test =
      typeof match === "function"
        ? match
        : (argv: string[]) => match.every((part, i) => argv[i] === part);
    this.routes.unshift([test, typeof respond === "function" ? respond : () => respond]);
    return this;
  }
  async run(binary: string, argv: string[], timeout: number, input?: string) {
    this.calls.push({ binary, argv, timeout, ...(input === undefined ? {} : { input }) });
    const route = this.routes.find(([test]) => test(argv));
    if (!route) throw new Error(`unexpected argv ${argv.join(" ")}`);
    return route[1](argv);
  }
}
export const scripted = () => {
  const cli = new ScriptedCLI();
  cli.on(["settings", "get"], ok(settingsDocument()));
  let now = 0;
  const service = new SubBatonService(cli, async () => "/fixture/subbaton", () => now);
  return {
    cli,
    service,
    advance: (ms = 16000) => {
      now += ms;
    },
  };
};

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
