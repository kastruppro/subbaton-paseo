import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  Modal,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { hostSettings, type ActionResult, type Provider } from "../shared/contracts.js";
import {
  autoPlanRpc,
  eventsRpc,
  pollerLifecycleRpc,
  pollerStatusRpc,
  settingsActionRpc,
  settingsGetRpc,
  settingsSetRpc,
  type Leaf,
  type SettingsAccount,
  type SettingsSection as Section,
  type SettingsActionInput,
} from "../shared/settings.js";
import {
  accountBadges,
  accountFields,
  draftChanges,
  eventSummary,
  formatLeaf,
  humanize,
  move,
  orderView,
  parseNumber,
  planSummary,
  providerGroups,
  rangeHint,
  setDraft,
  storedValue,
  validKey,
  rebaseOrder,
  changedSince,
  autoEnabledChanges,
  aliasMap,
  type Draft,
  type FieldView,
} from "./settings-model.js";
import { keyboardFocus, providerLabel, relativeAge, timestamp } from "./display.js";
import { HandoffSection } from "./handoff-section.js";
import { handoffRequestRpc, handoffSettings } from "../shared/handoff.js";
import { handoffEffect } from "./handoff-model.js";

type Colors = PluginSurfaceProps["theme"]["colors"];
const providers: Provider[] = ["claude", "codex", "agy"];
const loginSteps: Record<Provider, { signIn: string; add: string }> = {
  claude: { signIn: "Sign in with official Claude Code (run claude, then /login).", add: "add ALIAS" },
  codex: { signIn: "Sign in with official Codex (codex login).", add: "codex add ALIAS" },
  agy: { signIn: "Sign in with official agy, then exit every agy session.", add: "agy add ALIAS" },
};

function Button({
  label,
  onPress,
  colors,
  disabled,
  a11y,
  tone,
}: {
  label: string;
  onPress: () => void;
  colors: Colors;
  disabled?: boolean;
  a11y?: string;
  tone?: "primary" | "danger";
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onFocus={(e) => setFocused(keyboardFocus(e.currentTarget))}
      onBlur={() => setFocused(false)}
      style={{
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: 12,
        justifyContent: "center",
        alignItems: "center",
        borderRadius: 7,
        borderWidth: 1,
        borderColor: focused ? colors.accent : colors.border,
        backgroundColor: tone === "primary" ? colors.accent : colors.surface1,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: "500",
          color:
            tone === "primary" ? colors.accentForeground : tone === "danger" ? colors.statusDanger : colors.foreground,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Notice({ result, colors }: { result: ActionResult | null; colors: Colors }) {
  if (!result) return null;
  const color =
    result.outcome === "success" ? colors.statusSuccess : result.outcome === "unchanged" ? colors.foregroundMuted : colors.statusWarning;
  return (
    <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ color, fontSize: 13 }}>
      {result.message}
    </Text>
  );
}

function Badge({ text, colors, tone }: { text: string; colors: Colors; tone?: "warning" | "muted" }) {
  return (
    <Text
      style={{
        fontSize: 11,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: tone === "warning" ? colors.statusWarning : colors.border,
        color: tone === "warning" ? colors.statusWarning : colors.foregroundMuted,
      }}
    >
      {text}
    </Text>
  );
}

// Fields report invalid text so Apply never sends a value other than what is on screen.
// Invalid text also drops that field's draft entry, so nothing hidden or stale is ever sent (review L2).
const InvalidContext = createContext<{ report: (key: string, invalid: boolean) => void; revert: (path: string[]) => void }>({
  report: () => {},
  revert: () => {},
});

const hintFor = (view: FieldView, extra = "") =>
  [
    view.changedElsewhere ? "Changed elsewhere since you started editing; review the stored value before applying again." : "",
    view.field.description,
    extra,
    view.runtime + ".",
    view.field.runtimeDetail ?? "",
    view.pending ? "Pending change." : "",
  ]
    .filter(Boolean)
    .join(" ");

function NumberField({
  view,
  disabled,
  onChange,
  label,
  revisionKey,
}: {
  view: FieldView;
  disabled: boolean;
  onChange: (value: number | null) => void;
  label?: string;
  revisionKey: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const { report, revert } = useContext(InvalidContext);
  useEffect(() => () => report(view.key, false), [view.key]);
  const effective =
    view.field.nullable && view.effective !== undefined && view.effective !== null
      ? `Effective ${formatLeaf(view.effective, view.field)}.`
      : "";
  return (
    <SettingsInput
      key={revisionKey}
      label={label ?? view.field.title}
      hint={hintFor(view, `${rangeHint(view.field)} ${effective}`)}
      error={error}
      disabled={disabled}
      placeholder={view.field.nullable ? "inherit" : undefined}
      initialValue={typeof view.value === "number" ? String(view.value) : ""}
      onChangeText={(text) => {
        const parsed = parseNumber(text, view.field);
        report(view.key, "error" in parsed);
        if ("error" in parsed) {
          setError(parsed.error);
          revert(view.path);
        } else {
          setError(null);
          onChange(parsed.value);
        }
      }}
    />
  );
}

function DictionaryField({
  view,
  disabled,
  colors,
  update,
  revisionKey,
}: {
  view: FieldView;
  disabled: boolean;
  colors: Colors;
  update: (path: string[], value: Leaf) => void;
  revisionKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [extra, setExtra] = useState<string[]>([]);
  if (view.control.kind !== "dictionary" || !view.control.child) return null;
  const child = view.control.child;
  const current = view.value && typeof view.value === "object" && !Array.isArray(view.value) ? view.value : {};
  const effective = view.effective && typeof view.effective === "object" && !Array.isArray(view.effective) ? view.effective : {};
  const keys = Array.from(new Set([...view.control.keys, ...extra]));
  const set = Object.values(current).filter((v) => v !== null).length;
  return (
    <View>
      <SettingsRow label={view.field.title} hint={hintFor(view, `${set} override${set === 1 ? "" : "s"} set. Suggested keys come from the CLI.`)}>
        <Button
          label={open ? "Hide" : `Edit ${keys.length}`}
          a11y={`${open ? "Hide" : "Edit"} ${view.field.title}`}
          colors={colors}
          onPress={() => setOpen(!open)}
        />
      </SettingsRow>
      {open && (
        <View style={{ paddingLeft: 12, gap: 4 }}>
          {keys.map((key) => (
            <NumberField
              key={key}
              revisionKey={`${revisionKey}:${key}`}
              label={key}
              disabled={disabled}
              view={{
                ...view,
                field: child,
                path: [...view.path, key],
                value: current[key] ?? null,
                effective: effective[key] ?? undefined,
                inherits: (current[key] ?? null) === null,
              }}
              onChange={(value) => update([...view.path, key], value)}
            />
          ))}
          <SettingsInput
            label="Other key"
            hint="Letters, digits, _ : . - (up to 100). Use an exact window or model ID."
            initialValue=""
            disabled={disabled}
            error={newKey && !validKey(newKey) ? "Use only letters, digits, _ : . or -." : null}
            onChangeText={setNewKey}
          />
          <SettingsAction
            label="Add key"
            actionLabel="Add"
            disabled={disabled || !validKey(newKey) || keys.includes(newKey)}
            onPress={() => {
              setExtra([...extra, newKey]);
              setNewKey("");
            }}
          />
        </View>
      )}
    </View>
  );
}

function FieldControl({
  view,
  disabled,
  colors,
  update,
  revisionKey,
}: {
  view: FieldView;
  disabled: boolean;
  colors: Colors;
  update: (path: string[], value: Leaf) => void;
  revisionKey: string;
}) {
  const control = view.control;
  switch (control.kind) {
    case "switch":
      return (
        <SettingsSwitch
          label={view.field.title}
          hint={hintFor(view)}
          value={view.value === true}
          disabled={disabled}
          onValueChange={(value) => update(view.path, value)}
        />
      );
    case "select": {
      const selected = control.options.find((o) => o.value === view.value);
      return (
        <SettingsSelect
          label={view.field.title}
          hint={hintFor(view, selected?.description ?? "")}
          value={typeof view.value === "string" ? view.value : ""}
          options={control.options.map((o) => ({ label: o.label, value: o.value }))}
          disabled={disabled}
          onValueChange={(value) => update(view.path, value)}
        />
      );
    }
    case "number":
      return (
        <NumberField
          view={view}
          disabled={disabled}
          revisionKey={revisionKey + view.key}
          onChange={(value) => update(view.path, value)}
        />
      );
    case "dictionary":
      return <DictionaryField view={view} disabled={disabled} colors={colors} update={update} revisionKey={revisionKey + view.key} />;
    default:
      return (
        <SettingsRow
          label={view.field.title}
          hint={`${view.field.description} This field type is newer than the plugin and is shown read-only. Current value: ${formatLeaf(view.value, view.field)}.`}
        />
      );
  }
}

interface Confirm {
  title: string;
  body: string;
  confirm: string;
  run: () => Promise<void>;
  /** Further explicit choices, for example the poller's environment pins. */
  alternatives?: { label: string; run: () => Promise<void> }[];
  /** Where a transport failure is reported. */
  notice?: string;
}

function AccountCard({
  section,
  account,
  draft,
  disabled,
  colors,
  update,
  revisionKey,
  action,
  changed,
}: {
  section: Section;
  account: SettingsAccount;
  draft: Draft;
  changed: ReadonlySet<string>;
  disabled: boolean;
  colors: Colors;
  update: (path: string[], value: Leaf) => void;
  revisionKey: string;
  action: (input: SettingsActionInput, title: string, body: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const fields = accountFields(section, account, draft, changed);
  const primary = fields.filter((f) => f.field.type === "boolean" || f.field.type === "integer");
  const overrides = fields.filter((f) => !primary.includes(f));
  const badges = accountBadges(account);
  return (
    <SettingsCard>
      <View
        accessible
        accessibilityLabel={`Account ${account.alias}${badges.length ? ". " + badges.join(", ") : ""}`}
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center", paddingHorizontal: 12, paddingTop: 10 }}
      >
        <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 14 }}>{account.alias}</Text>
        {badges.map((b) => (
          <Badge key={b} text={b} colors={colors} tone="warning" />
        ))}
      </View>
      {primary.map((view) => (
        <FieldControl key={view.key} view={view} disabled={disabled} colors={colors} update={update} revisionKey={revisionKey} />
      ))}
      <SettingsRow label="Threshold overrides" hint="Account-specific thresholds; empty values inherit.">
        <Button
          label={open ? "Hide" : "Show"}
          a11y={`${open ? "Hide" : "Show"} threshold overrides for ${account.alias}`}
          colors={colors}
          onPress={() => setOpen(!open)}
        />
      </SettingsRow>
      {open &&
        overrides.map((view) => (
          <FieldControl key={view.key} view={view} disabled={disabled} colors={colors} update={update} revisionKey={revisionKey} />
        ))}
      {account.quarantined && section.actions.includes("releaseQuarantine") && (
        <SettingsAction
          label="Quarantine"
          hint="Release only after checking the login on the Mac."
          actionLabel="Release quarantine"
          disabled={disabled}
          onPress={() =>
            action(
              { action: "releaseQuarantine", provider: section.provider, account: account.id, expectedRevision: section.revision },
              `Release quarantine for ${account.alias}?`,
              "This does not validate or renew the login. The official CLI may still require a fresh login on the Mac.",
            )
          }
        />
      )}
      {account.deviceBlocked && section.provider === "codex" && section.actions.includes("releaseDeviceBlock") && (
        <SettingsAction
          label="Device block"
          hint="Clears only the local block; the issuer may still refuse this account."
          actionLabel="Release device block"
          disabled={disabled}
          onPress={() =>
            action(
              { action: "releaseDeviceBlock", provider: "codex", account: account.id, expectedRevision: section.revision },
              `Release the Codex device block for ${account.alias}?`,
              "Only the local block is cleared. No login or retry happens, and the issuer may still refuse this account.",
            )
          }
        />
      )}
    </SettingsCard>
  );
}

function PlanViewer({ provider, colors }: { provider: Provider; colors: Colors }) {
  const read = useRpc(autoPlanRpc);
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const requestHandoff = useRpc(handoffRequestRpc);
  const handoffPrefs = useSettings(handoffSettings);
  const [confirmIdle, setConfirmIdle] = useState(false);
  const plan = useQuery({
    queryKey: ["subbaton-plan", provider],
    queryFn: () => read({ provider }),
    enabled: open,
    retry: false,
  });
  const data = plan.data?.ok ? plan.data.data : null;
  const summary = data ? planSummary(data) : null;
  return (
    <SettingsSection title="Automatic plan (read only)">
      <SettingsCard>
        <SettingsRow label="Why-log" hint="The CLI's current cache-only plan. It never switches anything.">
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Button label={open ? "Hide" : "Show plan"} colors={colors} onPress={() => setOpen(!open)} />
            {open && <Button label="Reload" colors={colors} onPress={() => void plan.refetch()} />}
          </View>
        </SettingsRow>
        {open && (
          <View style={{ paddingHorizontal: 12, paddingBottom: 10, gap: 4 }}>
            {plan.isLoading && <Text style={{ color: colors.foregroundMuted }}>Loading plan…</Text>}
            {plan.data && !plan.data.ok && <Notice result={plan.data.error} colors={colors} />}
            {summary && data && (
              <>
                <Text style={{ color: colors.foreground, fontWeight: "600" }}>{summary.headline}</Text>
                {data.pauseMessage && <Text style={{ color: colors.statusWarning }}>{data.pauseMessage}</Text>}
                {provider === "agy" && data.decision.reason === "processBusy" && data.why.proposedTarget && (
                  <View style={{ gap: 4 }}>
                    <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
                      agy sessions block this plan. The CLI cannot tell from here whether a switch is due; you can hand off explicitly.
                    </Text>
                    <Button
                      label={`Switch to ${data.why.candidates.find((c) => c.id === data.why.proposedTarget)?.alias ?? "proposed account"} when idle`}
                      colors={colors}
                      onPress={() => setConfirmIdle(true)}
                    />
                    {confirmIdle && (
                      <View accessibilityRole="alert" style={{ gap: 6 }}>
                        <Text style={{ color: colors.foreground, fontSize: 13 }}>
                          {handoffEffect(
                            "agy",
                            data.why.candidates.find((c) => c.id === data.why.proposedTarget)?.alias ?? "the proposed account",
                            false,
                            handoffPrefs.status === "ready" ? handoffPrefs.values.idleWaitMinutes : 30,
                          )}
                        </Text>
                        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                          <Button
                            label="Switch when idle"
                            colors={colors}
                            onPress={() => {
                              setConfirmIdle(false);
                              void requestHandoff({ provider: "agy", target: data.why.proposedTarget! })
                                .then((r) => setHint(r.result.message))
                                .catch(() => setHint("The request did not reach the host."));
                            }}
                          />
                          <Button label="Cancel" colors={colors} onPress={() => setConfirmIdle(false)} />
                        </View>
                      </View>
                    )}
                    {hint && <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 12 }}>{hint}</Text>}
                  </View>
                )}
                {summary.lines.map((line) => (
                  <Text key={line} style={{ color: colors.foregroundMuted, fontSize: 13 }}>
                    {line}
                  </Text>
                ))}
                <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Evaluated {relativeAge(data.evaluatedAt)}</Text>
                <Button
                  label={details ? "Hide details" : "Show details"}
                  colors={colors}
                  onPress={() => setDetails(!details)}
                />
                {details && (
                  <View style={{ gap: 8, marginTop: 6 }}>
                    {summary.candidates.map((c) => (
                      <View key={c.id} accessible style={{ gap: 2 }}>
                        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "500" }}>{c.title}</Text>
                        {c.reasons.length > 0 && (
                          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Reasons: {c.reasons.join(", ")}</Text>
                        )}
                        {c.windows.map((w) => (
                          <Text key={w} style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                            {w}
                          </Text>
                        ))}
                        {c.forecast && <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{c.forecast}</Text>}
                      </View>
                    ))}
                    {summary.sequences.length > 0 && (
                      <View style={{ gap: 2 }}>
                        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "500" }}>Compared sequences</Text>
                        {summary.sequences.map((s) => (
                          <Text key={s} style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                            {s}
                          </Text>
                        ))}
                      </View>
                    )}
                  </View>
                )}
              </>
            )}
          </View>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

export function ControlScreen(props: PluginSurfaceProps) {
  const colors = props.theme.colors;
  const hostId = props.host.id;
  const client = useQueryClient();
  const getSettings = useRpc(settingsGetRpc);
  const setSettings = useRpc(settingsSetRpc);
  const runAction = useRpc(settingsActionRpc);
  const readPoller = useRpc(pollerStatusRpc);
  const changePoller = useRpc(pollerLifecycleRpc);
  const readEvents = useRpc(eventsRpc);
  const binary = useSettings(hostSettings);
  const key = ["subbaton-settings", hostId];
  const settings = useQuery({ queryKey: key, queryFn: () => getSettings({}), refetchInterval: 30000, retry: false });
  const poller = useQuery({ queryKey: ["subbaton-poller", hostId], queryFn: () => readPoller({}), refetchInterval: 60000, retry: false });
  const events = useQuery({ queryKey: ["subbaton-events", hostId], queryFn: () => readEvents({}), refetchInterval: 60000, retry: false });
  const [selected, setSelected] = useState<Provider>("claude");
  const [drafts, setDrafts] = useState<Record<Provider, Draft>>({ claude: {}, codex: {}, agy: {} });
  const [notices, setNotices] = useState<Record<string, ActionResult | null>>({});
  const [busy, setBusy] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [invalid, setInvalid] = useState<Record<string, true>>({});
  // M1: each provider's draft remembers the section it started from and sends that revision.
  const [bases, setBases] = useState<Partial<Record<Provider, Section>>>({});
  const [changed, setChanged] = useState<Partial<Record<Provider, Set<string>>>>({});
  const [orderNotice, setOrderNotice] = useState<Partial<Record<Provider, string>>>({});
  const report = (field: string, bad: boolean) =>
    setInvalid((all) => {
      const id = `${selected}:${field}`;
      if (bad === !!all[id]) return all;
      const next = { ...all };
      if (bad) next[id] = true;
      else delete next[id];
      return next;
    });
  const invalidCount = Object.keys(invalid).filter((id) => id.startsWith(selected + ":")).length;

  const reload = async () => {
    const fresh = await getSettings({ fresh: true });
    client.setQueryData(key, fresh);
    void client.invalidateQueries({ queryKey: ["subbaton-status", hostId] });
    void client.invalidateQueries({ queryKey: ["subbaton-plan"] });
    setEpoch((n) => n + 1);
    return fresh;
  };
  const clearDraft = (p: Provider) => {
    setDrafts((all) => ({ ...all, [p]: {} }));
    setBases((all) => ({ ...all, [p]: undefined }));
    setChanged((all) => ({ ...all, [p]: undefined }));
    setOrderNotice((all) => ({ ...all, [p]: undefined }));
    setInvalid((all) => Object.fromEntries(Object.entries(all).filter(([id]) => !id.startsWith(p + ":"))));
  };
  const data = settings.data?.ok ? settings.data.data : null;
  const section = data?.providers.find((p) => p.provider === selected) ?? null;
  const draft = drafts[selected];
  const changes = draftChanges(draft);
  const editable = !!section?.ok && !section.readOnly && !busy;
  const revisionKey = `${section?.ok ? section.revision : "none"}:${epoch}:`;

  // Values are compared with the draft's base section, so a background refetch never rebases it.
  const baseSection = (section?.ok ? (bases[selected] ?? section) : null) as Section | null;
  const update = (path: string[], value: Leaf) => {
    if (!baseSection) return;
    if (!bases[selected]) setBases((all) => ({ ...all, [selected]: baseSection }));
    setDrafts((all) => ({ ...all, [selected]: setDraft(all[selected], baseSection, path, value, storedValue(baseSection, path)) }));
  };
  const revert = (path: string[]) => {
    const key = path.join("/");
    setDrafts((all) => {
      if (!Object.hasOwn(all[selected], key)) return all;
      const next = { ...all[selected] };
      delete next[key];
      return { ...all, [selected]: next };
    });
  };
  // L3: when the account set changes under an order draft, rebase it and say so.
  const accountKey = section?.ok ? section.accounts.map((a) => a.id).join(",") : "";
  const lastAccounts = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!section?.ok) return;
    const previous = lastAccounts.current[selected];
    lastAccounts.current[selected] = accountKey;
    const drafted = drafts[selected]["order"]?.value;
    if (previous === undefined || previous === accountKey || !Array.isArray(drafted)) return;
    const rebased = rebaseOrder(drafted, section.accounts.map((a) => a.id));
    if (!rebased.changed) return;
    setDrafts((all) => ({ ...all, [selected]: { ...all[selected], order: { path: ["order"], value: rebased.ids } } }));
    setOrderNotice((all) => ({ ...all, [selected]: "Accounts were added or removed since you reordered. The draft order was rebased; review it before applying." }));
  }, [accountKey, selected]);
  const submit = async () => {
    if (!section?.ok || !baseSection || changes.length === 0) return;
    const provider = selected;
    const base = baseSection;
    setBusy(true);
    try {
      const response = await setSettings({ provider, expectedRevision: base.revision, changes });
      setNotices((n) => ({ ...n, [provider]: response.result }));
      if (response.result.outcome === "success") clearDraft(provider);
      const fresh = await reload();
      if (response.result.code === "revisionConflict") {
        // Keep the draft, show which drafted fields changed elsewhere, and rebase on the reloaded values.
        const latest = fresh.ok ? fresh.data?.providers.find((p) => p.provider === provider) : null;
        if (latest?.ok) {
          setChanged((all) => ({ ...all, [provider]: changedSince(base, latest, drafts[provider]) }));
          setBases((all) => ({ ...all, [provider]: latest }));
        }
      }
    } catch {
      setNotices((n) => ({ ...n, [selected]: { outcome: "error", code: "transport", message: "The request did not reach the host. Reload settings before retrying." } }));
    } finally {
      setBusy(false);
    }
  };
  const apply = () => {
    const auto = autoEnabledChanges(draft);
    if (auto.length === 0) return void submit();
    setConfirm({
      title: `${auto[0] ? "Turn on" : "Turn off"} automatic switching for ${providerLabel[selected]}?`,
      body: auto[0]
        ? "The poller will switch this provider's accounts on its own when the CLI's rules say so. The other pending changes are applied in the same batch."
        : "The poller stops switching this provider's accounts automatically. The other pending changes are applied in the same batch.",
      confirm: "Apply",
      run: submit,
    });
  };
  const action = (input: SettingsActionInput, title: string, body: string) =>
    setConfirm({
      title,
      body,
      confirm: "Confirm",
      run: async () => {
        const response = await runAction(input);
        setNotices((n) => ({ ...n, [input.provider]: response.result }));
        await reload();
      },
    });
  // poller status: {} = nothing pinned, null = not installed or the plist could not be read.
  const pinnedText = (pins: Record<string, string> | null | undefined, installed: boolean | null | undefined) =>
    pins && Object.keys(pins).length
      ? Object.entries(pins).map(([k, v]) => `${k}=${v}`).join(", ")
      : pins || installed === false
        ? "none (default provider homes)"
        : "unknown (the installed job could not be read)";
  const lifecycle = (install: boolean) => {
    const run = (environment: "keep" | "current" | "none") => async () => {
      setNotices((n) => ({ ...n, poller: null }));
      const response = await changePoller(install ? { action: "install", environment } : { action: "uninstall" });
      setNotices((n) => ({ ...n, poller: response.result }));
      await poller.refetch();
      await reload();
    };
    const pins = poller.data?.ok ? poller.data.data?.pinnedEnvironment : null;
    const installed = poller.data?.ok ? poller.data.data?.installed : null;
    setConfirm({
      title: install ? "Install the usage poller?" : "Uninstall the usage poller?",
      body: install
        ? `Installs the per-user LaunchAgent on the Mac with the SubBaton binary this plugin verified. Pinned provider homes now: ${pinnedText(pins, installed)}. Install keeps them. Re-pinning uses the Paseo daemon's environment, which can differ from your shell; only do that if you know it is right.`
        : "Removes the per-user LaunchAgent on the Mac. Saved accounts, caches and logs are kept.",
      confirm: install ? "Install (keep pinned homes)" : "Uninstall",
      notice: "poller",
      run: run("keep"),
      alternatives: install
        ? [
            { label: "Re-pin from Paseo's environment", run: run("current") },
            { label: "Remove pinned homes", run: run("none") },
          ]
        : [],
    });
  };

  const tabs = (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {providers.map((p) => {
        const row = data?.providers.find((s) => s.provider === p);
        const pending = Object.keys(drafts[p]).length;
        return (
          <Pressable
            key={p}
            accessibilityRole="tab"
            accessibilityState={{ selected: p === selected }}
            accessibilityLabel={`${providerLabel[p]} settings${row && !row.ok ? ", unavailable" : ""}${pending ? `, ${pending} pending changes` : ""}`}
            onPress={() => setSelected(p)}
            style={{
              minHeight: 44,
              paddingHorizontal: 14,
              justifyContent: "center",
              borderRadius: 7,
              borderWidth: 1,
              borderColor: p === selected ? colors.accent : colors.border,
              backgroundColor: p === selected ? colors.surface2 : colors.surface1,
            }}
          >
            <Text style={{ color: row && !row.ok ? colors.statusWarning : colors.foreground, fontWeight: p === selected ? "600" : "400" }}>
              {providerLabel[p]}
              {pending ? ` • ${pending}` : ""}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  let body: ReactNode = null;
  if (settings.isLoading) body = <Text style={{ color: colors.foregroundMuted }}>Loading settings…</Text>;
  else if (settings.isError) body = <Text style={{ color: colors.statusWarning }}>The host did not answer. Check the Paseo connection and reload.</Text>;
  else if (settings.data && !settings.data.ok) body = <Notice result={settings.data.error} colors={colors} />;
  else if (section && !section.ok) body = <Notice result={section.error} colors={colors} />;
  else if (section?.ok) {
    const marks = changed[selected];
    const groups = providerGroups(section, draft, marks);
    const order = orderView(section, draft, marks);
    body = (
      <View style={{ gap: 16 }}>
        {!section.exists && (
          <Text style={{ color: colors.foregroundMuted }}>
            No {providerLabel[section.provider]} accounts are saved yet. Defaults are shown read-only; add an account on the Mac first.
          </Text>
        )}
        {section.newerSchema && (
          <Text style={{ color: colors.statusWarning }}>These settings use a newer schema than this CLI supports. They are read-only until the CLI is updated.</Text>
        )}
        {section.auto.paused && (
          <SettingsCard>
            <SettingsAction
              label="Automatic switching paused"
              hint={`Reason: ${humanize(section.auto.pauseReason ?? "unknown")}${section.auto.pausedAt ? `, ${relativeAge(section.auto.pausedAt)}` : ""}.`}
              actionLabel="Resume"
              disabled={busy || !section.actions.includes("resumeAuto") || !section.auto.pauseId || changes.length > 0}
              onPress={() =>
                action(
                  { action: "resumeAuto", provider: section.provider, pauseId: section.auto.pauseId ?? "", expectedRevision: section.revision },
                  `Resume automatic switching for ${providerLabel[section.provider]}?`,
                  "Resume only after checking why it paused. Open the automatic plan below for details.",
                )
              }
            />
          </SettingsCard>
        )}
        {groups.map((group) => (
          <SettingsSection key={group.title} title={group.title}>
            <SettingsCard>
              {group.fields.map((view) => (
                <FieldControl key={view.key} view={view} disabled={!editable} colors={colors} update={update} revisionKey={revisionKey} />
              ))}
            </SettingsCard>
          </SettingsSection>
        ))}
        <SettingsSection title="Accounts">
          {order && order.accounts.length > 1 && (
            <SettingsCard>
              <SettingsRow label={order.field.title} hint={hintFor(order)} error={orderNotice[selected] ?? null} />
              {order.accounts.map((account, index) => {
                const ids = order.accounts.map((a) => a.id);
                return (
                  <SettingsRow key={account.id} label={`${index + 1}. ${account.alias}`}>
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      <Button
                        label="Up"
                        a11y={`Move ${account.alias} up`}
                        colors={colors}
                        disabled={!editable || index === 0}
                        onPress={() => update(["order"], move(ids, index, -1))}
                      />
                      <Button
                        label="Down"
                        a11y={`Move ${account.alias} down`}
                        colors={colors}
                        disabled={!editable || index === ids.length - 1}
                        onPress={() => update(["order"], move(ids, index, 1))}
                      />
                    </View>
                  </SettingsRow>
                );
              })}
            </SettingsCard>
          )}
          {section.accounts.map((account) => (
            <AccountCard
              key={account.id}
              section={section}
              account={account}
              draft={draft}
              disabled={!editable}
              colors={colors}
              update={update}
              revisionKey={revisionKey}
              action={action}
              changed={marks ?? new Set()}
            />
          ))}
          {section.accounts.length === 0 && <Text style={{ color: colors.foregroundMuted }}>No saved accounts.</Text>}
        </SettingsSection>
        <PlanViewer provider={section.provider} colors={colors} />
      </View>
    );
  }

  const pollerData = poller.data?.ok ? poller.data.data : null;
  const aliases = aliasMap((data?.providers ?? []).map((p) => (p.ok ? p : { ok: false })));
  const recent = events.data?.ok && events.data.data ? [...events.data.data.events].reverse().slice(0, 25) : [];
  const bin = binary.status === "ready" ? binary.values.binaryPath : "subbaton";

  return (
    <InvalidContext.Provider value={{ report, revert }}>
    <View style={{ gap: 16 }}>
      <Text style={{ color: colors.foregroundMuted }}>
        Every value, rule and description below comes from the SubBaton CLI on this host. Changes are sent as one batch per provider with the
        revision you loaded; if something changed elsewhere you will be asked to review and apply again.
      </Text>
      {tabs}
      <Notice result={notices[selected] ?? null} colors={colors} />
      {(changes.length > 0 || invalidCount > 0) && (
        <View
          accessibilityLabel={`${changes.length} pending ${providerLabel[selected]} changes`}
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}
        >
          <Text style={{ color: colors.foreground }}>
            {changes.length} pending change{changes.length === 1 ? "" : "s"}
          </Text>
          <Button label="Apply" tone="primary" colors={colors} disabled={!editable || invalidCount > 0} onPress={() => void apply()} />
          {invalidCount > 0 && <Text style={{ color: colors.statusWarning }}>Fix {invalidCount} invalid value{invalidCount === 1 ? "" : "s"} first.</Text>}
          <Button
            label="Discard"
            colors={colors}
            disabled={busy}
            onPress={() => {
              clearDraft(selected);
              setEpoch((n) => n + 1);
            }}
          />
        </View>
      )}
      {body}
      <SettingsSection title="Usage poller">
        <SettingsCard>
          {pollerData ? (
            <>
              <SettingsRow
                label={pollerData.installed ? "Installed" : "Not installed"}
                hint={[
                  pollerData.loaded === null ? "Loaded state unknown." : pollerData.loaded ? "Loaded." : "Not loaded.",
                  `Last tick ${relativeAge(pollerData.lastTickAt)}${pollerData.lastTickAt ? ` (${timestamp(pollerData.lastTickAt)})` : ""}.`,
                  pollerData.stale ? "Stale: no recent tick." : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {pollerData.stale && pollerData.installed && <Badge text="Stale" colors={colors} tone="warning" />}
              </SettingsRow>
              <SettingsRow label="Pinned provider homes" hint={pinnedText(pollerData.pinnedEnvironment, pollerData.installed)} />
              {providers.map((p) => {
                const row = pollerData.providers[p];
                return row ? (
                  <SettingsRow
                    key={p}
                    label={providerLabel[p]}
                    hint={[
                      row.outcome ? `Usage ${humanize(row.outcome)}` : "",
                      row.auto ? `automatic ${humanize(row.auto)}` : "",
                      row.error ? `error ${humanize(row.error)}` : "",
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  />
                ) : null;
              })}
            </>
          ) : (
            <SettingsRow label="Poller status" hint={poller.isLoading ? "Loading…" : (poller.data?.error?.message ?? "Unavailable.")} />
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12 }}>
            <Button label={pollerData?.installed ? "Reinstall" : "Install"} colors={colors} disabled={busy} onPress={() => lifecycle(true)} />
            <Button label="Uninstall" tone="danger" colors={colors} disabled={busy || pollerData?.installed === false} onPress={() => lifecycle(false)} />
            <Button label="Refresh" colors={colors} onPress={() => void poller.refetch()} />
          </View>
        </SettingsCard>
        <Notice result={notices.poller ?? null} colors={colors} />
      </SettingsSection>
      <HandoffSection hostId={hostId} colors={colors} />
      <SettingsSection title="Recent events">
        <SettingsCard>
          {recent.length === 0 && (
            <SettingsRow
              label={events.data && !events.data.ok ? "Events unavailable" : "No events yet"}
              hint={events.data && !events.data.ok ? events.data.error?.message : "Automatic switches, failures, pauses and login problems appear here."}
            />
          )}
          {recent.map((event) => (
            <SettingsRow
              key={event.id}
              label={eventSummary(event, aliases)}
              hint={`${event.provider === "unknown" ? "Unknown provider" : providerLabel[event.provider]}, ${relativeAge(event.at)} (${timestamp(event.at)})`}
            />
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Add an account">
        <SettingsCard>
          <SettingsRow
            label="Logins happen on the Mac"
            hint="Paseo never handles sign-in credentials. Use a terminal on the Mac that runs this host, signed in as the same user."
          />
          {providers.map((p) => (
            <SettingsRow
              key={p}
              label={providerLabel[p]}
              hint={`1. ${loginSteps[p].signIn} 2. Run: ${bin} ${loginSteps[p].add}`}
            />
          ))}
        </SettingsCard>
      </SettingsSection>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button label="Reload settings" colors={colors} disabled={busy} onPress={() => void reload()} />
      </View>
      <Modal title={confirm?.title ?? ""} open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <Modal.Content>
          <Text style={{ color: colors.foreground }}>{confirm?.body}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {[{ label: confirm?.confirm ?? "Confirm", run: confirm?.run }, ...(confirm?.alternatives ?? [])].map((choice, index) => (
              <Button
                key={choice.label}
                label={choice.label}
                tone={index === 0 ? "primary" : undefined}
                colors={colors}
                disabled={busy}
                onPress={() => {
                  const current = confirm;
                  if (!current || !choice.run) return;
                  const where = current.notice ?? selected;
                  setBusy(true);
                  void choice
                    .run()
                    .catch(() =>
                      setNotices((n) => ({ ...n, [where]: { outcome: "error", code: "transport", message: "The request did not reach the host. Reload before retrying." } })),
                    )
                    .finally(() => {
                      setBusy(false);
                      setConfirm(null);
                    });
                }}
              />
            ))}
            <Button label="Cancel" colors={colors} disabled={busy} onPress={() => setConfirm(null)} />
          </View>
        </Modal.Content>
      </Modal>
    </View>
    </InvalidContext.Provider>
  );
}
