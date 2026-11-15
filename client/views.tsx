import { createContext, useContext, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import {
  useRpc,
  useSettings,
  type PluginPopoverProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import {
  displaySettings,
  switchRpc,
  strategyRpc,
  strategyPreviewRpc,
  refreshRpc,
  type ActionResult,
  type Window,
  type Account,
  type Provider,
  type ProviderStatus,
} from "../shared/contracts.js";
import {
  chooseItems,
  providerIcon,
  providerLabel,
  timestamp,
  windowPresentation,
  relativeAge,
  lastRead,
  popoverBodyHeight,
  themePalette,
  keyboardFocus,
  providerNotices,
  shortWarning,
} from "./display.js";
import {
  footerCell,
  footerGrid,
  footerSummary,
  narrowFooterWidth,
  type FooterCell,
} from "./footer-model.js";
import {
  accountBadge,
  autoLines,
  canSwitch,
  handoffRow,
  idleExplanation,
  miniWindows,
  otherAccountSummary,
  providerLine,
  rowGlyph,
  bestPreviewLine,
  expandedSections,
  switchChoices,
  windowLabel,
  type RowLine,
  type Tone,
} from "./popover-model.js";
import { attentionLine, paidUsageLines } from "./paid-model.js";
import { useStatus } from "./use-status.js";
import { useHandoff } from "./use-handoff.js";
import { handoffLine } from "./handoff-model.js";
import {
  handoffControlRpc,
  handoffRequestRpc,
  handoffSettings,
} from "../shared/handoff.js";
type Palette = ReturnType<typeof themePalette>;
const PaletteContext = createContext<Palette | null>(null);
function usePalette() {
  return useContext(PaletteContext)!;
}
const toneColor = (tone: string, palette: Palette) =>
  tone === "danger"
    ? palette.danger
    : tone === "warning"
      ? palette.warning
      : tone === "normal"
        ? palette.fill
        : palette.faint;
const providerTitle = (provider: Provider) =>
  provider === "claude" ? "Claude Code" : providerLabel[provider];
const lineColor = (tone: RowLine["tone"], palette: Palette) =>
  tone === "danger" ? palette.danger : tone === "warning" ? palette.warning : palette.muted;
/** Track with a hairline edge so the empty part stays visible on light sidebars. */
function MiniMeter({
  fill,
  tone,
  dim = false,
  width,
}: {
  fill: number;
  tone: string;
  dim?: boolean;
  width?: number;
}) {
  const palette = usePalette();
  return (
    <View
      importantForAccessibility="no"
      style={{
        flex: width ? undefined : 1,
        width,
        minWidth: 9,
        height: 4,
        borderRadius: 2,
        backgroundColor: palette.track,
        borderWidth: 0.5,
        borderColor: palette.trackEdge,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: `${Math.max(fill > 0 ? 3 : 0, Math.min(100, fill))}%`,
          height: "100%",
          backgroundColor: tone === "normal" || tone === "unknown" ? palette.fill : toneColor(tone, palette),
          opacity: dim ? 0.4 : 1,
        }}
      />
    </View>
  );
}
function FooterCellView({
  provider,
  cell,
}: {
  provider: Provider;
  cell: FooterCell;
}) {
  const palette = usePalette();
  // Same token as Paseo's CPU box values; stale and unknown stay readable (clock glyph and ~ mark them).
  const color = cell.textTone === "danger" ? palette.danger : cell.textTone === "warning" ? palette.warning : palette.text;
  return (
    <View
      style={{
        flex: 1,
        flexBasis: 0,
        minWidth: 0,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        overflow: "hidden",
      }}
    >
      <Icon name={providerIcon[provider]} size={13} color={palette.muted} />
      <Text numberOfLines={1} style={{ fontSize: 12, color: palette.text, flexShrink: 0 }}>
        {cell.label}
      </Text>
      {!cell.meter ? (
        <View style={{ flex: 1, minWidth: 0 }} />
      ) : cell.kind === "blocked" ? (
        <View style={{ flex: 1, minWidth: 9, alignItems: "center" }}>
          <Text style={{ fontSize: 10, color: palette.danger }}>▲</Text>
        </View>
      ) : cell.kind === "stale" ? (
        <View style={{ flex: 1, minWidth: 9, alignItems: "center" }}>
          <Icon name="Clock" size={11} color={palette.muted} />
        </View>
      ) : (
        <MiniMeter fill={cell.fill} tone={cell.tone} />
      )}
      {!cell.meter && cell.clock && <Icon name="Clock" size={11} color={palette.muted} />}
      {!(cell.kind === "blocked" && cell.percent === "—") && (
        <Text
          numberOfLines={1}
          style={{
            fontSize: 12,
            color,
            flexShrink: 0,
            fontVariant: ["tabular-nums"],
          }}
        >
          {cell.percent}
        </Text>
      )}
    </View>
  );
}
export function Footer(
  props: PluginSidebarItemProps & {
    Details: React.ComponentType<PluginPopoverProps>;
  },
) {
  return (
    <PaletteContext.Provider value={themePalette(props.theme)}>
      <FooterContent {...props} />
    </PaletteContext.Provider>
  );
}
function FooterContent({
  Details,
  ...props
}: PluginSidebarItemProps & {
  Details: React.ComponentType<PluginPopoverProps>;
}) {
  const palette = usePalette();
  const [width, setWidth] = useState(0),
    [hovered, setHovered] = useState(false),
    [focused, setFocused] = useState(false);
  const query = useStatus(props.host.id),
    settings = useSettings(displaySettings);
  const data = query.data?.ok ? query.data.data : null;
  const ready = settings.status === "ready";
  const warning = ready ? settings.values.warning : 80,
    danger = ready ? settings.values.danger : 100;
  const grid = footerGrid(ready ? settings.values.items.length : 0);
  const items = ready
    ? chooseItems(data, settings.values.items).slice(0, grid.count)
    : [];
  const offline = query.isError || query.data?.ok === false;
  const mode = footerSummary({
    settingsReady: ready,
    itemCount: items.length,
    offline: offline && !data,
  });
  const narrow = width > 0 && width <= narrowFooterWidth;
  const cells = items.map((item) => ({
    item,
    cell: footerCell(item, { warning, danger, offline, narrow }),
  }));
  const rows = Array.from({ length: grid.rows }, (_, r) =>
    cells.slice(r * 3, r * 3 + 3),
  );
  const label =
    mode === "grid"
      ? "SubBaton. " +
        cells
          .map(
            ({ item, cell }) =>
              `${providerLabel[item.provider]} ${cell.label}: ${cell.kind === "blocked" ? "unavailable" : cell.percent}`,
          )
          .join(". ") +
        ". Open account details."
      : "SubBaton. Open account details.";
  const message = (icon: string, text: string, color: string) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 18 }}>
      <Icon name={icon} size={13} color={color} />
      <Text numberOfLines={1} style={{ fontSize: 12, color, flex: 1 }}>
        {text}
      </Text>
    </View>
  );
  return (
    <View
      style={{
        alignSelf: "stretch",
        minWidth: 0,
        backgroundColor: hovered ? palette.hover : "transparent",
        borderTopWidth: 1,
        borderTopColor: palette.line,
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onFocus={(event) => setFocused(keyboardFocus(event.currentTarget))}
        onBlur={() => setFocused(false)}
        onPressIn={(event) => setFocused(keyboardFocus(event.currentTarget))}
        onPress={() => props.openPopover(Details)}
        style={{
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderWidth: 1,
          borderColor: focused ? palette.focus : "transparent",
          borderRadius: 6,
          gap: 9,
        }}
      >
        {mode === "loading" ? (
          message("Gauge", `SubBaton settings ${settings.status}`, palette.muted)
        ) : mode === "unavailable" ? (
          message("TriangleAlert", "SubBaton unavailable", palette.warning)
        ) : mode === "none" ? (
          message("Gauge", "Choose usage items…", palette.accent)
        ) : (
          rows.map((row, r) => (
            <View key={r} style={{ flexDirection: "row", gap: 10 }}>
              {row.map(({ item, cell }) => (
                <FooterCellView
                  key={`${item.provider}:${item.windowId}`}
                  provider={item.provider}
                  cell={cell}
                />
              ))}
              {Array.from({ length: 3 - row.length }, (_, i) => (
                <View key={`pad${i}`} style={{ flex: 1, flexBasis: 0 }} />
              ))}
            </View>
          ))
        )}
      </Pressable>
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
  primary = false,
  iconLabel = false,
  a11yLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  compact?: boolean;
  icon?: string;
  small?: boolean;
  primary?: boolean;
  iconLabel?: boolean;
  a11yLabel?: string;
}) {
  const palette = usePalette();
  const [focused, setFocused] = useState(false),
    [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11yLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onFocus={(event) => setFocused(keyboardFocus(event.currentTarget))}
      onBlur={() => setFocused(false)}
      onPressIn={(event) => setFocused(keyboardFocus(event.currentTarget))}
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
        paddingHorizontal: icon && !iconLabel ? 4 : 9,
        paddingVertical: compact ? 6 : 3,
        borderWidth: 1,
        borderColor: focused
          ? palette.focus
          : icon && !iconLabel
            ? "transparent"
            : palette.line,
        borderRadius: 7,
        backgroundColor: hovered && !primary
          ? palette.hover
          : icon && !iconLabel
            ? "transparent"
            : primary
              ? palette.accent
              : palette.row,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon && iconLabel ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name={icon} size={13} color={palette.text} />
          <Text style={{ color: palette.text, fontSize: 12, fontWeight: "500" }}>{label}</Text>
        </View>
      ) : icon ? (
        <Icon name={icon} size={14} color={palette.muted} />
      ) : (
        <Text style={{ color: primary ? palette.onAccent : palette.text, fontSize: 12, fontWeight: "500" }}>
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
  const palette = usePalette();
  const view = windowPresentation(provider, window, warning, danger, offline);
  const label = windowLabel(provider, window),
    value = window.usedPercent;
  return (
    <View style={{ marginTop: 6, gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text
          numberOfLines={1}
          style={{
            width: 62,
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
            value === null || view.percent === "—"
              ? { text: view.reset }
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
              width: `${Math.max(0, Math.min(100, view.fillPercent))}%`,
              borderRadius: 3,
              backgroundColor: toneColor(view.tone, palette),
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
          marginLeft: 72,
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
function Badge({ text, tone }: { text: string; tone: Tone }) {
  const palette = usePalette();
  const color =
    tone === "danger" ? palette.danger : tone === "warning" ? palette.warning : tone === "normal" ? palette.ok : palette.muted;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: color,
        borderRadius: 5,
        paddingHorizontal: 5,
      }}
    >
      <Text numberOfLines={1} style={{ fontSize: 11, color, lineHeight: 16 }}>
        {text}
      </Text>
    </View>
  );
}
function Glyph({ kind }: { kind: "ok" | "warn" | "crit" | "mute" }) {
  const palette = usePalette();
  if (kind === "warn" || kind === "crit")
    return (
      <Text style={{ width: 8, fontSize: 10, textAlign: "center", color: kind === "crit" ? palette.danger : palette.warning }}>
        ▲
      </Text>
    );
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: kind === "ok" ? palette.ok : palette.faint,
      }}
    />
  );
}
function MiniWindow({
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
  const palette = usePalette();
  const view = windowPresentation(provider, window, warning, danger, offline);
  return (
    <View
      accessible
      accessibilityLabel={view.accessibility}
      style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
    >
      <Text numberOfLines={1} style={{ fontSize: 12, color: palette.muted }}>
        {windowLabel(provider, window)}
      </Text>
      <MiniMeter fill={view.fillPercent} tone={view.tone} dim={view.clock} width={46} />
      <Text
        style={{
          fontSize: 12,
          color: view.clock ? palette.muted : view.tone === "danger" ? palette.danger : view.tone === "warning" ? palette.warning : palette.text,
          fontVariant: ["tabular-nums"],
        }}
      >
        {view.percent}
      </Text>
    </View>
  );
}
function Line({
  line,
  onAction,
  compact,
  disabled,
}: {
  line: RowLine;
  onAction?: (action: NonNullable<RowLine["action"]>) => void;
  compact: boolean;
  disabled?: boolean;
}) {
  const palette = usePalette();
  const color = lineColor(line.tone, palette);
  const icon =
    line.kind === "loading"
      ? "Loader"
      : line.kind === "error" || line.tone === "danger"
        ? "TriangleAlert"
        : line.text.startsWith("Restart")
          ? "RefreshCw"
          : line.text.startsWith("Automatic")
            ? "Pause"
            : line.action === "cancel"
              ? "Clock"
              : "Info";
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingLeft: 31, paddingTop: 5 }}
    >
      <Icon name={icon} size={12} color={color} />
      <Text style={{ fontSize: 12, color, flex: 1 }}>{line.text}</Text>
      {line.action && onAction && (
        <Button
          small
          compact={compact}
          disabled={disabled}
          label={line.action === "cancel" ? "Cancel" : line.action === "details" ? "Details" : "Retry"}
          onPress={() => onAction(line.action!)}
        />
      )}
    </View>
  );
}
function ProviderRow({
  provider,
  status,
  data,
  error,
  pending,
  compact,
  warning,
  danger,
  offline,
  busy,
  open,
  onToggle,
  notice,
  act,
  onRetry,
  handoffs,
  restartCodexDaemon,
}: {
  provider: Provider;
  status: ProviderStatus | undefined;
  data: boolean;
  error: string | null;
  pending: boolean;
  compact: boolean;
  warning: number;
  danger: number;
  offline: boolean;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  notice?: string;
  act: (provider: Provider, action: () => Promise<ActionResult | { provider: Provider | null; result: ActionResult }[]>) => Promise<void>;
  onRetry: () => void;
  handoffs: ReturnType<typeof useHandoff>;
  restartCodexDaemon: boolean;
}) {
  const palette = usePalette();
  const switchAccount = useRpc(switchRpc),
    strategy = useRpc(strategyRpc),
    previewBest = useRpc(strategyPreviewRpc),
    requestHandoff = useRpc(handoffRequestRpc),
    controlHandoff = useRpc(handoffControlRpc);
  const [choice, setChoice] = useState<string | null>(null),
    [details, setDetails] = useState(false),
    [bestNote, setBestNote] = useState<RowLine | null>(null),
    [previewing, setPreviewing] = useState(false),
    [focused, setFocused] = useState(false);
  const accounts = status?.accounts ?? [];
  async function switchToBest() {
    if (provider === "claude")
      return void act(provider, () => strategy({ provider: "claude", strategy: "best" }));
    setBestNote(null);
    setChoice(null);
    setPreviewing(true);
    try {
      const r = await previewBest({ provider, strategy: "best" });
      if (r.outcome === "target" && r.target) setChoice(r.target);
      else setBestNote(bestPreviewLine(r));
    } catch {
      setBestNote({ kind: "error", tone: "danger", text: "Connection lost; try again." });
    } finally {
      setPreviewing(false);
    }
  }
  const current = accounts.find((a) => a.active);
  const base = providerLine({ queryError: error, pending, hasData: data, provider: status });
  const handoff = provider === "claude" ? null : (handoffs.data?.handoffs[provider] ?? null);
  const handoffLineRow = handoffRow(handoff);
  const lines = [
    ...(base ? [base] : []),
    ...(base?.disableSwitching ? [] : autoLines(provider, status)),
  ];
  const locked = busy || !!base?.disableSwitching;
  const mini = current ? miniWindows(provider, current.windows) : [];
  const sections = expandedSections(provider, accounts, !!base?.disableSwitching);
  const others = sections.others;
  const chosen = others.find((a) => a.id === choice);
  const read = current ? lastRead(current) : null;
  const windowsAll = current?.windows ?? [];
  const login =
    current?.loginExpiresAt != null
      ? `login valid until ${new Date(current.loginExpiresAt * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
      : provider === "codex"
        ? "login has no fixed end date"
        : provider === "agy"
          ? "login renewed by agy"
          : "login expiry unknown";
  const badge = current ? accountBadge(current, warning, danger) : undefined;
  const warnLine = current ? shortWarning(provider, current.summaryStatus, current.warnings) : null;
  return (
    <View
      style={{
        paddingVertical: 7,
        paddingLeft: 10,
        paddingRight: 12,
        borderTopWidth: 1,
        borderTopColor: palette.line,
        backgroundColor: open ? palette.sidebar : "transparent",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${open ? "Collapse" : "Expand"} ${providerTitle(provider)}${current ? ` ${current.alias}` : ""}`}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        onFocus={(event) => setFocused(keyboardFocus(event.currentTarget))}
        onBlur={() => setFocused(false)}
        onPressIn={(event) => setFocused(keyboardFocus(event.currentTarget))}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          minHeight: compact ? 44 : 24,
          borderWidth: 1,
          borderColor: focused ? palette.focus : "transparent",
          borderRadius: 6,
        }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={palette.muted} />
        <Glyph kind={rowGlyph(current, warning, danger)} />
        <Text style={{ fontWeight: "600", fontSize: 13, color: palette.text }}>
          {providerTitle(provider)}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 13, color: palette.muted, flexShrink: 1 }}>
          {current?.alias ?? ""}
        </Text>
      </Pressable>
      {!open && mini.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 2, paddingLeft: 31, paddingTop: 5 }}>
          {mini.map((w) => (
            <MiniWindow key={w.id} {...{ provider, window: w, warning, danger, offline }} />
          ))}
        </View>
      )}
      {lines.map((line) => (
        <Line key={line.text} line={line} compact={compact} disabled={busy} onAction={() => onRetry()} />
      ))}
      {notice && (
        <Line line={{ kind: "warning", tone: "warning", text: notice }} compact={compact} />
      )}
      {handoffLineRow && (
        <Line
          line={handoffLineRow}
          compact={compact}
          disabled={busy}
          onAction={(action) => {
            if (action === "details") setDetails((v) => !v);
            else if (action === "cancel" && provider !== "claude")
              void act(provider, async () => (await controlHandoff({ provider, action: "cancel" })).result);
          }}
        />
      )}
      {details && handoff && (
        <Text selectable style={{ fontSize: 11, color: palette.muted, paddingLeft: 31, paddingTop: 3 }}>
          {handoffLine(handoff)}
        </Text>
      )}
      {open && sections.noActiveNote && (
        <Text style={{ fontSize: 12, color: palette.muted, paddingLeft: 31, paddingTop: 5 }}>
          {sections.noActiveNote}
        </Text>
      )}
      {open && (current || others.length > 0) && !base?.disableSwitching && (
        <View style={{ paddingLeft: 31, paddingTop: 4 }}>
          {current && (<>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <Text selectable numberOfLines={1} style={{ fontSize: 12, color: palette.muted, flexShrink: 1 }}>
              {[current.email ?? "Email unknown", current.plan ?? "Plan unknown"].join(" · ")}
            </Text>
            {badge && <Badge {...badge} />}
          </View>
          {windowsAll.map((w) => (
            <PaceBar key={w.id} {...{ provider, window: w, warning, danger, offline }} />
          ))}
          {windowsAll.length === 0 && (
            <Text style={{ color: palette.muted, fontSize: 12 }}>Usage unknown. No quota is assumed.</Text>
          )}
          {warnLine && (
            <View style={{ flexDirection: "row", gap: 4, alignItems: "center", marginTop: 4 }} accessibilityLabel={(current.warnings ?? []).join(". ")}>
              <Icon name="TriangleAlert" size={12} color={palette.warning} />
              <Text style={{ color: palette.warning, fontSize: 11, flex: 1 }}>{warnLine}</Text>
            </View>
          )}
          <Text style={{ fontSize: 11.5, color: palette.muted, marginTop: 4 }} accessibilityLabel={`Last read ${relativeAge(read)} (${timestamp(read)}). Login ${timestamp(current.loginExpiresAt)}`}>
            Read {relativeAge(read)} · {login}
          </Text>
          {attentionLine(current)?.text && (
            <Text style={{ fontSize: 11.5, color: palette.warning, marginTop: 2 }}>{attentionLine(current)!.text}</Text>
          )}
          {paidUsageLines(provider, current).map((line) => (
            <View key={line.label} style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 }}>
              {line.stale && <Icon name="Clock" size={11} color={palette.muted} />}
              <Text selectable style={{ fontSize: 11.5, color: line.stale ? palette.muted : palette.text, flex: 1 }}>{line.text}</Text>
            </View>
          ))}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3, marginBottom: 8 }}>
            <View style={{ width: 1.5, height: 10, backgroundColor: palette.tick, opacity: 0.75 }} />
            <Text style={{ fontSize: 11, color: palette.faint }}>pace: where usage would be if spread evenly until the reset</Text>
          </View>
          </>)}
          {others.length > 0 && (
            <Text style={{ fontSize: 11, letterSpacing: 0.4, color: palette.faint, marginBottom: 4 }}>
              OTHER ACCOUNTS
            </Text>
          )}
          {others.map((account) => {
            const b = accountBadge(account, warning, danger);
            return (
              <View key={account.id}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 5, borderTopWidth: 1, borderTopColor: palette.line }}>
                  <Glyph kind={rowGlyph(account, warning, danger)} />
                  <Text numberOfLines={1} style={{ fontSize: 12.5, color: palette.text, flexShrink: 1 }}>{account.alias}</Text>
                  <Text numberOfLines={1} style={{ fontSize: 12, color: palette.muted, flexShrink: 1, fontVariant: ["tabular-nums"] }}>
                    {otherAccountSummary(provider, account, { offline })}
                  </Text>
                  {b && <Badge {...b} />}
                  <View style={{ flex: 1 }} />
                  <Button
                    small
                    compact={compact}
                    label="Switch…"
                    a11yLabel={`Switch ${providerLabel[provider]} to ${account.alias}`}
                    disabled={locked || !canSwitch(account)}
                    onPress={() => setChoice(choice === account.id ? null : account.id)}
                  />
                </View>
                {chosen?.id === account.id && (
                  <View
                    accessibilityRole="alert"
                    style={{ borderWidth: 1, borderColor: palette.line, backgroundColor: palette.hover, borderRadius: 9, padding: 10, marginVertical: 4 }}
                  >
                    <Text style={{ fontSize: 12.5, fontWeight: "600", color: palette.text, marginBottom: 7 }}>
                      Switch {providerLabel[provider]} to {account.alias}
                    </Text>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      {switchChoices(provider).map((kind) => (
                        <Button
                          key={kind}
                          primary={kind === "now"}
                          compact={compact}
                          disabled={locked || (kind === "idle" && handoffActive(handoff))}
                          label={kind === "now" ? "Switch now" : "Switch when idle"}
                          a11yLabel={
                            kind === "now"
                              ? `Switch ${providerLabel[provider]} to ${account.alias} now`
                              : `Switch ${providerLabel[provider]} to ${account.alias} when every Paseo ${providerLabel[provider]} agent is idle, then reopen them`
                          }
                          onPress={() => {
                            setChoice(null);
                            if (kind === "now")
                              void act(provider, () => switchAccount({ provider, target: account.id }));
                            else if (provider !== "claude")
                              void act(provider, async () => {
                                const response = await requestHandoff({ provider, target: account.id });
                                void handoffs.refetch();
                                return response.result;
                              });
                          }}
                        />
                      ))}
                    </View>
                    {provider !== "claude" && (
                      <Text style={{ fontSize: 11.5, color: palette.text, marginTop: 7 }}>
                        {idleExplanation(provider, restartCodexDaemon)}
                      </Text>
                    )}
                  </View>
                )}
              </View>
            );
          })}
          {sections.best && (
            <View style={{ marginTop: 8, marginBottom: 4, gap: 4 }}>
              <View style={{ alignSelf: "flex-start" }}>
                <Button
                  label={previewing ? "Checking…" : "Switch to best account"}
                  compact={compact}
                  disabled={locked || previewing}
                  onPress={() => void switchToBest()}
                />
              </View>
              {bestNote && <Text accessibilityLiveRegion="polite" style={{ fontSize: 12, color: lineColor(bestNote.tone, palette) }}>{bestNote.text}</Text>}
            </View>
          )}
        </View>
      )}
    </View>
  );
}
const handoffActive = (h: { phase: string } | null) =>
  !!h && ["waiting", "switching", "reopening"].includes(h.phase);
export function AccountPopover(
  props: PluginPopoverProps & { openSettings: () => void },
) {
  return (
    <PaletteContext.Provider value={themePalette(props.theme)}>
      <PopoverContent {...props} />
    </PaletteContext.Provider>
  );
}
function PopoverContent(
  props: PluginPopoverProps & { openSettings: () => void },
) {
  const palette = usePalette();
  const { height } = useWindowDimensions();
  const query = useStatus(props.host.id),
    refresh = useRpc(refreshRpc),
    handoffs = useHandoff(props.host.id);
  const [busy, setBusy] = useState(false),
    [notices, setNotices] = useState<Partial<Record<Provider, string>>>({}),
    [open, setOpen] = useState<Partial<Record<Provider, boolean>>>({});
  const display = useSettings(displaySettings);
  const handoffPrefs = useSettings(handoffSettings);
  const warning = display.status === "ready" ? display.values.warning : 80,
    danger = display.status === "ready" ? display.values.danger : 100;
  const data = query.data?.ok ? query.data.data : null;
  const error =
    query.isError || query.data?.ok === false
      ? (query.data?.error?.message ?? "Status unavailable on this host.")
      : null;
  const offline = error !== null;
  const updatedAt = Math.max(0, ...(data?.providers.map((p) => p.updatedAt ?? 0) ?? []));
  async function act(
    requested: Provider | null,
    action: () => Promise<ActionResult | { provider: Provider | null; result: ActionResult }[]>,
  ) {
    if (busy) return;
    setBusy(true);
    if (requested) setNotices((previous) => ({ ...previous, [requested]: undefined }));
    try {
      const value = await action();
      const rows = Array.isArray(value) ? value : [{ provider: requested, result: value }];
      setNotices((previous) => providerNotices(previous, rows, requested ?? "claude"));
    } catch {
      if (requested)
        setNotices((previous) => ({
          ...previous,
          [requested]: "Connection lost; inspect SubBaton state/recovery before retrying.",
        }));
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
          paddingTop: 11,
          paddingBottom: 9,
          paddingLeft: 14,
          paddingRight: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text style={{ fontWeight: "600", fontSize: 13, color: palette.text, flex: 1 }}>SubBaton</Text>
        <Text
          accessibilityLabel={`Updated ${relativeAge(updatedAt || null)}`}
          numberOfLines={1}
          style={{
            color: palette.muted,
            fontSize: 12,
          }}
        >
          updated {relativeAge(updatedAt || null)}
        </Text>
        <Button
          label={busy ? "Working…" : "Refresh usage"}
          icon="RefreshCw"
          compact={props.layout.compact}
          disabled={busy}
          onPress={() => void act(null, async () => await refresh({}))}
        />
      </View>
      <ScrollView
        style={{ maxHeight: popoverBodyHeight(props.layout.compact, height) }}
        contentContainerStyle={{ paddingBottom: 4 }}
      >
        {data?.providers.some((value) => value.provider === "unknown") && (
          <Text style={{ color: palette.muted, fontSize: 11, paddingHorizontal: 14 }}>
            A newer provider is unknown; its actions are disabled.
          </Text>
        )}
        {(["claude", "codex", "agy"] as const).map((id) => (
          <ProviderRow
            key={id}
            provider={id}
            status={data?.providers.find((p) => p.provider === id) as ProviderStatus | undefined}
            data={!!data}
            error={error}
            pending={query.isPending}
            compact={props.layout.compact}
            {...{ warning, danger, offline, busy }}
            open={!!open[id]}
            onToggle={() => setOpen((v) => ({ ...v, [id]: !v[id] }))}
            notice={notices[id]}
            act={act}
            onRetry={() => void query.refetch()}
            handoffs={handoffs}
            restartCodexDaemon={handoffPrefs.status === "ready" && handoffPrefs.values.restartCodexDaemon}
          />
        ))}
      </ScrollView>
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: palette.line,
          paddingVertical: 8,
          paddingHorizontal: 12,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <Button label="Settings…" icon="Settings" iconLabel compact={props.layout.compact} onPress={props.openSettings} />
      </View>
    </View>
  );
}
