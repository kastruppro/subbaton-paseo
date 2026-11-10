import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
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
} from "./display.js";
import { useStatus } from "./use-status.js";
function Meter({
  theme,
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
  const level = severity(value, old, warning, danger),
    color =
      level === "danger"
        ? theme.colors.statusDanger
        : level === "warning"
          ? theme.colors.statusWarning
          : level === "unknown"
            ? theme.colors.foregroundMuted
            : theme.colors.accent;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {showBar && (
        <View
          style={{
            width: 24,
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.colors.border,
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
      <Text numberOfLines={1} style={{ fontSize: 11, color, maxWidth: 34 }}>
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
      style={{ alignSelf: "stretch", minWidth: 0 }}
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
              gap: 8,
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
                    size={12}
                    color={props.theme.colors.foregroundMuted}
                  />
                  <Text
                    numberOfLines={1}
                    style={{
                      fontSize: 10,
                      color: props.theme.colors.foregroundMuted,
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
  theme,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  theme: PluginTheme;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 44,
        minWidth: 44,
        justifyContent: "center",
        paddingHorizontal: 10,
        paddingVertical: 9,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
        {label}
      </Text>
    </Pressable>
  );
}
export function AccountPopover(
  props: PluginPopoverProps & { openSettings: () => void },
) {
  const query = useStatus(props.host.id),
    switchAccount = useRpc(switchRpc),
    strategy = useRpc(strategyRpc),
    refresh = useRpc(refreshRpc);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<{ text: string; uncertain: boolean } | null>(
      null,
    );
  const display = useSettings(displaySettings);
  const warning = display.status === "ready" ? display.values.warning : 75,
    danger = display.status === "ready" ? display.values.danger : 90;
  const data = query.data?.ok ? query.data.data : null,
    c = props.theme.colors;
  async function act(action: () => Promise<ActionResult | ActionResult[]>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const value = await action(),
        results = Array.isArray(value) ? value : [value];
      setNotice({
        text: results.length
          ? results.map((r) => r.message).join("\n")
          : "No active accounts in snapshots. Bootstrap provider lists first.",
        uncertain: results.some(
          (r) => r.outcome === "uncertain" || r.outcome === "error",
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
    <ScrollView
      style={{
        maxHeight: props.layout.compact ? 560 : 640,
        width: "100%",
        maxWidth: 480,
      }}
      contentContainerStyle={{ padding: 12, gap: 12 }}
    >
      <Text style={{ fontSize: 17, fontWeight: "600", color: c.foreground }}>
        SubBaton · {props.host.label}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          label={busy ? "Working…" : "Refresh now"}
          theme={props.theme}
          disabled={busy}
          onPress={() =>
            void act(async () =>
              (await refresh({})).map((v) => ({
                ...v.result,
                message: `${v.provider ? providerLabel[v.provider] : "SubBaton"}: ${v.result.message}`,
              })),
            )
          }
        />
        <Button
          label="Settings"
          theme={props.theme}
          onPress={props.openSettings}
        />
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        Cached readings. Existing agents are not reopened after a switch. Finish
        running agy sessions first.
      </Text>
      {notice && (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: notice.uncertain ? c.statusWarning : c.foreground }}
        >
          {notice.text}
        </Text>
      )}
      {(query.isError || query.data?.ok === false) && (
        <Text style={{ color: c.statusWarning }}>
          {query.data?.error?.message ?? "Status unavailable on this host."}
        </Text>
      )}
      {!data && query.isPending && (
        <Text style={{ color: c.foregroundMuted }}>Loading cached status…</Text>
      )}
      {data?.providers.map((provider) => (
        <View key={provider.provider} style={{ gap: 8 }}>
          <Text style={{ color: c.foreground, fontWeight: "600" }}>
            {providerLabel[provider.provider]}
          </Text>
          <Text style={{ fontSize: 11, color: c.foregroundMuted }}>
            Snapshot {provider.cacheStatus} ·{" "}
            {timestamp(provider.updatedAt ?? null)}
          </Text>
          {provider.cacheStatus !== "available" && (
            <Text style={{ color: c.statusWarning }}>
              {provider.provider === "unknown"
                ? "A newer CLI provider is not supported by this plugin yet."
                : "Run this provider's list command once with the signed CLI to populate its snapshot."}
            </Text>
          )}
          {provider.cacheStatus === "available" &&
            provider.accounts.length === 0 && (
              <Text style={{ color: c.foregroundMuted }}>
                No saved accounts.
              </Text>
            )}
          {provider.accounts.map((account) => (
            <View
              key={account.id}
              style={{
                padding: 10,
                gap: 6,
                borderWidth: 1,
                borderRadius: 7,
                borderColor: c.border,
                backgroundColor: c.surface1,
              }}
            >
              <Text
                selectable
                style={{ color: c.foreground, fontWeight: "600" }}
              >
                {account.active ? "● " : ""}
                {account.alias}
                {account.active ? " · active" : ""}
                {!account.enabled ? " · disabled" : ""}
              </Text>
              <Text
                selectable
                style={{ color: c.foregroundMuted, fontSize: 12 }}
              >
                {account.email ?? "Email unknown"} ·{" "}
                {account.plan ?? "Plan unknown"}
              </Text>
              <Text
                style={{
                  color:
                    account.health === "ok"
                      ? c.foregroundMuted
                      : c.statusWarning,
                  fontSize: 12,
                }}
              >
                {account.health} · usage: {account.usageStatus}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
                Login expires: {timestamp(account.loginExpiresAt)}
              </Text>
              {account.windows.length === 0 && (
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                  Usage unknown. No quota is assumed.
                </Text>
              )}
              {account.windows.map((window) => (
                <View key={window.id} style={{ gap: 2 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <Text
                      style={{
                        color: c.foreground,
                        fontSize: 12,
                        flexShrink: 1,
                      }}
                    >
                      {window.label}
                      {stale(window, query.isError) ? " · stale" : ""}
                    </Text>
                    <Meter
                      theme={props.theme}
                      window={window}
                      warning={warning}
                      danger={danger}
                      offline={query.isError}
                    />
                  </View>
                  <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
                    Resets: {timestamp(window.resetsAt)} · fetched{" "}
                    {timestamp(window.fetchedAt)}
                  </Text>
                </View>
              ))}
              {provider.provider !== "unknown" && !account.active && (
                <Button
                  label={`Switch to ${account.alias}`}
                  theme={props.theme}
                  disabled={
                    busy ||
                    !account.enabled ||
                    ["quarantined", "deviceBlocked", "needsLogin"].includes(
                      account.health,
                    )
                  }
                  onPress={() => {
                    const selectedProvider = provider.provider;
                    if (selectedProvider !== "unknown")
                      void act(() =>
                        switchAccount({
                          provider: selectedProvider,
                          target: account.id,
                        }),
                      );
                  }}
                />
              )}
            </View>
          ))}
          {provider.provider === "claude" ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button
                label="Next available"
                theme={props.theme}
                disabled={busy}
                onPress={() =>
                  void act(() =>
                    strategy({
                      provider: "claude",
                      strategy: "next-available",
                    }),
                  )
                }
              />
              <Button
                label="Best quota"
                theme={props.theme}
                disabled={busy}
                onPress={() =>
                  void act(() =>
                    strategy({ provider: "claude", strategy: "best" }),
                  )
                }
              />
            </View>
          ) : (
            <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
              {provider.provider === "unknown"
                ? "Actions for unknown providers are disabled."
                : "Quota strategies are currently available for Claude. Named switching is available here."}
            </Text>
          )}
        </View>
      ))}
    </ScrollView>
  );
}
