import { useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  useSettings,
  type PluginPopoverProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import {
  displaySettings,
  switchRpc,
  strategyRpc,
  refreshRpc,
  type ActionResult,
  type Window,
  type Account,
  type Provider,
} from "../shared/contracts.js";
import {
  chooseItems,
  percentText,
  providerIcon,
  providerLabel,
  severity,
  stale,
  timestamp,
  windowTitle,
  stripLayout,
  shortWindowTitle,
  windowPresentation,
  splitWindows,
  accountTone,
  compactWindowLabel,
  relativeAge,
  lastRead,
  popoverBodyHeight,
} from "./display.js";
import { useStatus } from "./use-status.js";
const palette = {
  sidebar: "#161618",
  pop: "#1e1e21",
  row: "#252529",
  hover: "#2b2b30",
  line: "#313137",
  text: "#ececef",
  muted: "#8d8d96",
  faint: "#5c5c64",
  ok: "#52b788",
  warning: "#e3a33b",
  danger: "#e4604e",
  track: "#34343b",
  focus: "#6d9eff",
  tick: "#c9c9d1",
};
const toneColor = (tone: string) =>
  tone === "danger"
    ? palette.danger
    : tone === "warning"
      ? palette.warning
      : tone === "normal"
        ? palette.ok
        : palette.faint;
const providerColor = { claude: "#d9a06b", codex: "#9aa7b8", agy: "#7fb0ff" };
function Meter({
  window,
  warning = 75,
  danger = 90,
  offline = false,
  showBar = true,
}: {
  theme: PluginTheme;
  window: Window | null;
  warning?: number;
  danger?: number;
  offline?: boolean;
  showBar?: boolean;
}) {
  const old = window ? stale(window, offline) : true,
    value = window?.usedPercent ?? null;
  const color = toneColor(severity(value, false, warning, danger));
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {showBar && (
        <View
          style={{
            width: 24,
            height: 4,
            borderRadius: 2,
            backgroundColor: palette.track,
          }}
        >
          <View
            style={{
              width: `${value ?? 0}%`,
              height: 4,
              borderRadius: 2,
              backgroundColor: color,
              opacity: old ? 0.4 : 1,
            }}
          />
        </View>
      )}
      <Text
        numberOfLines={1}
        style={{
          fontSize: 12,
          color: old ? palette.muted : palette.text,
          maxWidth: 42,
        }}
      >
        {percentText(value, old, window?.inferred)}
      </Text>
    </View>
  );
}
export function Footer({
  Details,
  ...props
}: PluginSidebarItemProps & {
  Details: React.ComponentType<PluginPopoverProps>;
}) {
  const [width, setWidth] = useState(0);
  const query = useStatus(props.host.id),
    settings = useSettings(displaySettings);
  const data = query.data?.ok ? query.data.data : null;
  const items =
    settings.status === "ready" ? chooseItems(data, settings.values.items) : [];
  const offline = query.isError || query.data?.ok === false;
  const line = stripLayout(
    Math.max(0, width - 56 - (offline ? 70 : 0)),
    items.length,
  );
  return (
    <View
      style={{
        alignSelf: "stretch",
        minWidth: 0,
        backgroundColor: palette.sidebar,
        borderTopWidth: 1,
        borderTopColor: "#232327",
      }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <SidebarRow
        icon="Gauge"
        label=""
        onPress={() => props.openPopover(Details)}
        trailing={
          <View
            accessible
            accessibilityLabel={
              "SubBaton. " +
              items
                .map(
                  (item) =>
                    `${providerLabel[item.provider]} ${windowTitle(item.windowId, item.window?.label)}: ${percentText(item.window?.usedPercent ?? null, item.window ? stale(item.window, query.isError) : true, item.window?.inferred)}`,
                )
                .join(". ") +
              ". Open account details."
            }
            style={{
              flexDirection: "row",
              flexWrap: "nowrap",
              width: Math.max(0, width - 56),
              overflow: "hidden",
              alignItems: "center",
              gap: 14,
              paddingVertical: 4,
              flexShrink: 1,
            }}
          >
            {settings.status !== "ready" ? (
              <Text
                numberOfLines={1}
                style={{ color: props.theme.colors.foregroundMuted }}
              >
                SubBaton settings {settings.status}
              </Text>
            ) : items.length === 0 ? (
              <Text
                numberOfLines={1}
                style={{ color: props.theme.colors.foregroundMuted }}
              >
                SubBaton · choose items in settings
              </Text>
            ) : (
              items.slice(0, line.count).map((item) => (
                <View
                  key={`${item.provider}:${item.windowId}`}
                  style={{ flexDirection: "row", alignItems: "center", gap: 3 }}
                  accessibilityLabel={`${providerLabel[item.provider]} ${windowTitle(item.windowId, item.window?.label)} ${item.account?.health ?? "unknown"}`}
                >
                  <Icon
                    name={providerIcon[item.provider]}
                    size={13}
                    color={providerColor[item.provider]}
                  />
                  <Text
                    numberOfLines={1}
                    style={{
                      fontSize: 12,
                      color: palette.muted,
                      maxWidth: line.labels ? 58 : 20,
                    }}
                  >
                    {line.labels
                      ? windowTitle(item.windowId, item.window?.label)
                      : shortWindowTitle(item.windowId, item.window?.label)}
                  </Text>
                  <Meter
                    theme={props.theme}
                    window={item.window}
                    showBar={line.meters}
                    warning={
                      settings.status === "ready" ? settings.values.warning : 75
                    }
                    danger={
                      settings.status === "ready" ? settings.values.danger : 90
                    }
                    offline={query.isError || query.data?.ok === false}
                  />
                  {item.account?.health !== "ok" && item.account && (
                    <Text
                      numberOfLines={1}
                      style={{ color: props.theme.colors.statusWarning }}
                    >
                      !
                    </Text>
                  )}
                </View>
              ))
            )}
            {line.hidden > 0 && (
              <Text
                numberOfLines={1}
                style={{
                  color: props.theme.colors.foregroundMuted,
                  fontSize: 10,
                  maxWidth: 24,
                }}
              >
                +{line.hidden}
              </Text>
            )}
            {(query.isError || query.data?.ok === false) && (
              <Text
                numberOfLines={1}
                style={{ color: props.theme.colors.statusWarning }}
              >
                unavailable
              </Text>
            )}
          </View>
        }
      />
    </View>
  );
}
function Button({
  label,
  onPress,
  disabled = false,
  compact = false,
  icon,
  small = false,
  a11yLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  compact?: boolean;
  icon?: string;
  small?: boolean;
  a11yLabel?: string;
}) {
  const [focused, setFocused] = useState(false),
    [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11yLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={(event) => {
        event.stopPropagation();
        onPress();
      }}
      style={{
        minHeight: compact ? 44 : small ? 24 : 28,
        minWidth: compact ? 44 : icon ? 26 : 44,
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: icon ? 4 : 9,
        paddingVertical: compact ? 6 : 3,
        borderWidth: 1,
        borderColor: focused
          ? palette.focus
          : icon
            ? "transparent"
            : palette.line,
        borderRadius: 7,
        backgroundColor: hovered
          ? palette.hover
          : icon
            ? "transparent"
            : palette.row,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon ? (
        <Icon name={icon} size={14} color={palette.muted} />
      ) : (
        <Text style={{ color: palette.text, fontSize: 12, fontWeight: "500" }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}
function PaceBar({
  provider,
  window,
  warning,
  danger,
  offline,
}: {
  provider: Provider;
  window: Window;
  warning: number;
  danger: number;
  offline: boolean;
}) {
  const view = windowPresentation(provider, window, warning, danger, offline);
  const label = compactWindowLabel(provider, window),
    value = window.usedPercent;
  return (
    <View style={{ marginTop: 6, gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text
          numberOfLines={1}
          style={{
            width: provider === "agy" ? 66 : 52,
            color: palette.muted,
            fontSize: 12,
          }}
        >
          {label}
        </Text>
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={view.accessibility}
          accessibilityValue={
            value === null
              ? { text: "unknown" }
              : { min: 0, max: 100, now: value }
          }
          style={{
            flex: 1,
            height: 6,
            borderRadius: 3,
            backgroundColor: palette.track,
          }}
        >
          <View
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${Math.max(0, Math.min(100, value ?? 0))}%`,
              borderRadius: 3,
              backgroundColor: toneColor(view.tone),
              opacity: view.opacity,
            }}
          />
          {view.tick !== null && (
            <View
              importantForAccessibility="no"
              style={{
                position: "absolute",
                left: `${view.tick * 100}%`,
                marginLeft: -1,
                top: -3,
                width: 2,
                height: 12,
                borderRadius: 1,
                backgroundColor: palette.tick,
                opacity: 0.75,
              }}
            />
          )}
        </View>
        <Text
          style={{
            width: 42,
            textAlign: "right",
            fontSize: 13,
            fontWeight: "500",
            color: view.clock ? palette.muted : palette.text,
            fontVariant: ["tabular-nums"],
          }}
        >
          {view.percent}
        </Text>
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 3,
          marginLeft: provider === "agy" ? 76 : 62,
        }}
      >
        {view.clock && <Icon name="Clock" size={11} color={palette.muted} />}
        <Text
          accessibilityLabel={`${view.reset}. Absolute reset ${timestamp(window.resetsAt)}`}
          style={{ fontSize: 11, color: palette.muted }}
        >
          {view.reset}
        </Text>
      </View>
    </View>
  );
}
function AccountRow({
  account,
  provider,
  compact,
  warning,
  danger,
  offline,
  busy,
  onSwitch,
}: {
  account: Account;
  provider: Provider;
  compact: boolean;
  warning: number;
  danger: number;
  offline: boolean;
  busy: boolean;
  onSwitch: () => void;
}) {
  const [open, setOpen] = useState(false),
    [focused, setFocused] = useState(false),
    [hovered, setHovered] = useState(false);
  const windows = splitWindows(provider, account.windows),
    read = lastRead(account);
  const dot =
    account.active || account.health !== "ok"
      ? toneColor(accountTone(account, warning, danger))
      : palette.faint;
  const details = [
    ["Account", account.email ?? "Email unknown"],
    ["Plan", account.plan ?? "Plan unknown"],
    [
      "Login",
      account.loginExpiresAt !== null
        ? new Date(account.loginExpiresAt * 1000).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })
        : provider === "codex"
          ? "No fixed end date"
          : provider === "agy"
            ? "Renewed by agy"
            : "Unknown",
    ],
    ["Last read", relativeAge(read)],
  ];
  const toggle = () => setOpen((value) => !value);
  return (
    <Pressable
      accessible={false}
      focusable={false}
      onPress={toggle}
      style={{
        padding: 10,
        paddingHorizontal: 12,
        marginBottom: 6,
        borderWidth: 1,
        borderColor: focused
          ? palette.focus
          : account.active
            ? "#33473d"
            : "transparent",
        borderRadius: 8,
        backgroundColor: hovered ? palette.hover : palette.row,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginBottom: 2,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${open ? "Collapse" : "Expand"} ${account.alias} account details. ${account.active ? "In use." : ""} Health ${account.health}.`}
          accessibilityState={{ expanded: open }}
          onPress={(event) => {
            event.stopPropagation();
            toggle();
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: compact ? 44 : 24,
            flexDirection: "row",
            gap: 8,
            alignItems: "center",
          }}
        >
          <View
            style={{
              width: 13,
              height: 13,
              borderRadius: 7,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: account.active
                ? "rgba(82,183,136,0.15)"
                : "transparent",
              borderWidth: account.active ? 1 : 0,
              borderColor: palette.ok,
            }}
          >
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 4,
                backgroundColor: dot,
              }}
            />
          </View>
          <Text
            numberOfLines={1}
            style={{
              color: palette.text,
              fontWeight: "600",
              fontSize: 13,
              flexShrink: 1,
            }}
          >
            {account.alias}
          </Text>
          {account.active && (
            <Text
              numberOfLines={1}
              style={{ color: palette.muted, fontSize: 12 }}
            >
              In use
            </Text>
          )}
        </Pressable>
        {!account.active && (
          <Button
            label="Switch"
            a11yLabel={`Switch to ${account.alias}`}
            compact={compact}
            small
            disabled={
              busy ||
              !account.enabled ||
              ["quarantined", "deviceBlocked", "needsLogin"].includes(
                account.health,
              )
            }
            onPress={onSwitch}
          />
        )}
      </View>
      {(!account.enabled ||
        account.health !== "ok" ||
        account.usageStatus !== "ok") && (
        <Text style={{ color: palette.warning, fontSize: 11 }}>
          {!account.enabled ? "Disabled · " : ""}
          {account.health !== "ok" ? account.health + " · " : ""}usage:{" "}
          {account.usageStatus}
        </Text>
      )}
      {account.warnings?.map((warning, index) => (
        <Text key={index} style={{ color: palette.warning, fontSize: 11 }}>
          {warning}
        </Text>
      ))}
      <View>
        {windows.main.map((window) => (
          <PaceBar
            key={window.id}
            {...{ provider, window, warning, danger, offline }}
          />
        ))}
        {account.windows.length === 0 && (
          <Text style={{ color: palette.muted, fontSize: 12, marginTop: 6 }}>
            Usage unknown. No quota is assumed.
          </Text>
        )}
      </View>
      {open && (
        <View
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTopWidth: 1,
            borderTopColor: palette.line,
            gap: 5,
          }}
        >
          {details.map(([label, value]) => (
            <View key={label} style={{ flexDirection: "row", gap: 10 }}>
              <Text style={{ width: 86, color: palette.muted, fontSize: 12 }}>
                {label}
              </Text>
              <Text
                selectable
                accessibilityLabel={
                  label === "Login"
                    ? `${value}. ${timestamp(account.loginExpiresAt)}`
                    : label === "Last read"
                      ? `${value}. ${timestamp(read)}`
                      : value
                }
                style={{ color: palette.text, fontSize: 12, flex: 1 }}
              >
                {value}
              </Text>
            </View>
          ))}
          <View style={{ marginTop: windows.extra.length ? 3 : 0 }}>
            {windows.extra.map((window) => (
              <PaceBar
                key={window.id}
                {...{ provider, window, warning, danger, offline }}
              />
            ))}
          </View>
        </View>
      )}
    </Pressable>
  );
}
export function AccountPopover(
  props: PluginPopoverProps & { openSettings: () => void },
) {
  const { height } = useWindowDimensions();
  const query = useStatus(props.host.id),
    switchAccount = useRpc(switchRpc),
    strategy = useRpc(strategyRpc),
    refresh = useRpc(refreshRpc);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<{ text: string; uncertain: boolean } | null>(
      null,
    ),
    [selected, setSelected] = useState<Provider>("claude");
  const display = useSettings(displaySettings);
  const warning = display.status === "ready" ? display.values.warning : 75,
    danger = display.status === "ready" ? display.values.danger : 90;
  const data = query.data?.ok ? query.data.data : null,
    provider = data?.providers.find((value) => value.provider === selected);
  async function act(action: () => Promise<ActionResult | ActionResult[]>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const value = await action(),
        results = Array.isArray(value) ? value : [value];
      setNotice({
        text: results.length
          ? results.map((result) => result.message).join("\n")
          : "No active accounts in snapshots. Bootstrap provider lists first.",
        uncertain: results.some(
          (result) =>
            result.outcome === "uncertain" || result.outcome === "error",
        ),
      });
    } catch {
      setNotice({
        text: "The connection failed. Inspect SubBaton state before retrying a switch.",
        uncertain: true,
      });
    } finally {
      setBusy(false);
      await query.refetch();
    }
  }
  return (
    <View
      accessibilityLabel={`SubBaton subscriptions on ${props.host.label}`}
      style={{
        width: "100%",
        maxWidth: props.layout.compact ? undefined : 384,
        backgroundColor: palette.pop,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: palette.line,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          paddingTop: 12,
          paddingBottom: 8,
          paddingHorizontal: 14,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <View
          accessibilityRole="tablist"
          style={{
            flexDirection: "row",
            gap: 2,
            backgroundColor: "#18181b",
            padding: 3,
            borderRadius: 8,
          }}
        >
          {(["claude", "codex", "agy"] as const).map((id) => (
            <ProviderTab
              key={id}
              id={id}
              compact={props.layout.compact}
              selected={selected === id}
              tone={accountTone(
                data?.providers
                  .find((value) => value.provider === id)
                  ?.accounts.find((account) => account.active),
                warning,
                danger,
              )}
              onPress={() => setSelected(id)}
            />
          ))}
        </View>
        <View
          style={{
            flexDirection: "row",
            gap: 3,
            alignItems: "center",
            flex: 1,
            minWidth: 0,
            justifyContent: "flex-end",
          }}
        >
          <Text
            accessibilityLabel={`Updated ${relativeAge(provider?.updatedAt ?? null)}`}
            numberOfLines={2}
            style={{ color: palette.muted, fontSize: 11, flexShrink: 1 }}
          >
            updated {relativeAge(provider?.updatedAt ?? null)}
          </Text>
          <Button
            label={busy ? "Working…" : "Refresh now"}
            icon="RefreshCw"
            compact={props.layout.compact}
            disabled={busy}
            onPress={() =>
              void act(async () =>
                (await refresh({})).map((value) => ({
                  ...value.result,
                  message: `${value.provider ? providerLabel[value.provider] : "SubBaton"}: ${value.result.message}`,
                })),
              )
            }
          />
        </View>
      </View>
      <ScrollView
        style={{ maxHeight: popoverBodyHeight(props.layout.compact, height) }}
        contentContainerStyle={{
          paddingTop: 2,
          paddingHorizontal: 10,
          paddingBottom: 10,
        }}
      >
        {notice && (
          <Text
            accessibilityLiveRegion="polite"
            style={{
              color: notice.uncertain ? palette.warning : palette.text,
              fontSize: 12,
              padding: 4,
            }}
          >
            {notice.text}
          </Text>
        )}
        {(query.isError || query.data?.ok === false) && (
          <Text style={{ color: palette.warning, fontSize: 12, padding: 4 }}>
            {query.data?.error?.message ?? "Status unavailable on this host."}
          </Text>
        )}
        {data?.providers.some((value) => value.provider === "unknown") && (
          <Text style={{ color: palette.muted, fontSize: 11 }}>
            A newer provider is unknown; its actions are disabled.
          </Text>
        )}
        {!data && query.isPending && (
          <Text style={{ color: palette.muted }}>Loading cached status…</Text>
        )}
        {selected === "claude" && (
          <View
            style={{
              flexDirection: "row",
              gap: 8,
              paddingHorizontal: 4,
              paddingTop: 4,
              paddingBottom: 10,
            }}
          >
            <Button
              label="Switch to best"
              compact={props.layout.compact}
              disabled={busy}
              onPress={() =>
                void act(() =>
                  strategy({ provider: "claude", strategy: "best" }),
                )
              }
            />
            <Button
              label="Next available"
              compact={props.layout.compact}
              disabled={busy}
              onPress={() =>
                void act(() =>
                  strategy({ provider: "claude", strategy: "next-available" }),
                )
              }
            />
          </View>
        )}
        {provider?.cacheStatus !== "available" && (
          <Text style={{ color: palette.warning, fontSize: 12, padding: 4 }}>
            Snapshot {provider?.cacheStatus ?? "missing"}. Run this provider's
            list command once with the signed CLI to populate its snapshot.
          </Text>
        )}
        {provider?.cacheStatus === "available" &&
          provider.accounts.length === 0 && (
            <Text style={{ color: palette.muted, padding: 4 }}>
              No saved accounts.
            </Text>
          )}
        {provider?.accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            provider={selected}
            compact={props.layout.compact}
            warning={warning}
            danger={danger}
            offline={query.isError || query.data?.ok === false}
            busy={busy}
            onSwitch={() =>
              void act(() =>
                switchAccount({ provider: selected, target: account.id }),
              )
            }
          />
        ))}
        {selected === "codex" && (
          <Text style={{ color: palette.muted, fontSize: 12, padding: 6 }}>
            Open Codex terminals keep their account until restarted.
          </Text>
        )}
        {selected === "agy" && (
          <Text style={{ color: palette.muted, fontSize: 12, padding: 6 }}>
            Stop agy before switching. Conversations resume with agy -c.
          </Text>
        )}
        <View style={{ alignSelf: "flex-start", marginTop: 4 }}>
          <Button
            label="Settings"
            onPress={props.openSettings}
            compact={props.layout.compact}
          />
        </View>
      </ScrollView>
    </View>
  );
}
function ProviderTab({
  id,
  compact,
  selected,
  tone,
  onPress,
}: {
  id: Provider;
  compact: boolean;
  selected: boolean;
  tone: string;
  onPress: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`${providerLabel[id]}, status ${tone}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
        minHeight: compact ? 44 : 28,
        borderRadius: 6,
        backgroundColor: selected ? palette.hover : "transparent",
        borderWidth: 1,
        borderColor: focused ? palette.focus : "transparent",
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: toneColor(tone),
        }}
      />
      <Text
        style={{
          fontSize: 12,
          fontWeight: "500",
          color: selected ? palette.text : palette.muted,
        }}
      >
        {providerLabel[id]}
      </Text>
    </Pressable>
  );
}
