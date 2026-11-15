import { useState } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsCard,
  SettingsInput,
  SettingsAction,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  displaySettings,
  hostSettings,
  type DisplaySettings,
} from "../shared/contracts.js";
import { providerLabel, windowTitle } from "./display.js";
import { maxFooterItems } from "../shared/contracts.js";
import { useStatus } from "./use-status.js";
import { PageSection, SubSection } from "./page-section.js";
import { displayNote } from "./settings-sections.js";
function BinaryForm({
  initial,
  initialAllowPath,
  save,
  busy,
}: {
  initial: string;
  initialAllowPath: boolean;
  save: (value: string, allowPath: boolean) => Promise<boolean>;
  busy: boolean;
}) {
  const [path, setPath] = useState(initial);
  const [allowPath, setAllowPath] = useState(initialAllowPath);
  return (
    <SettingsCard>
      <SettingsInput
        label="SubBaton binary"
        hint="Default: $HOME/Library/Application Support/SubBaton/bin/subbaton, using the daemon user’s home. Install via the app’s Settings > Background > Install; the app keeps it updated. Saved custom paths remain unchanged. Canonical ownership, permissions and Developer ID are verified before execution."
        initialValue={initial}
        onChangeText={setPath}
      />
      <SettingsSwitch
        label="Allow verified PATH lookup"
        hint="Off by default. PATH candidates must pass the same ownership, directory and Developer ID checks."
        value={allowPath}
        onValueChange={setAllowPath}
        disabled={busy}
      />
      <SettingsAction
        label="Binary path"
        actionLabel="Save"
        disabled={busy || !path.trim()}
        onPress={() => void save(path.trim(), allowPath)}
      />
    </SettingsCard>
  );
}
function ThresholdForm({
  initial,
  save,
  busy,
}: {
  initial: DisplaySettings;
  save: (warning: number, danger: number) => Promise<boolean>;
  busy: boolean;
}) {
  const [warning, setWarning] = useState(String(initial.warning)),
    [danger, setDanger] = useState(String(initial.danger));
  const valid =
    Number.isFinite(Number(warning)) &&
    Number.isFinite(Number(danger)) &&
    Number(warning) >= 1 &&
    Number(danger) <= 100 &&
    Number(warning) < Number(danger);
  return (
    <SettingsCard>
      <SettingsInput
        label="Warning at used %"
        initialValue={warning}
        onChangeText={setWarning}
      />
      <SettingsInput
        label="Danger at used %"
        initialValue={danger}
        onChangeText={setDanger}
      />
      <SettingsAction
        label="Colours"
        actionLabel="Save thresholds"
        disabled={busy || !valid}
        onPress={() => void save(Number(warning), Number(danger))}
      />
    </SettingsCard>
  );
}
/** Section 1 of the settings page: which usage items the footer shows, and the colour thresholds. */
export function DisplaySection(props: PluginSurfaceProps) {
  const display = useSettings(displaySettings),
    query = useStatus(props.host.id),
    c = props.theme.colors;
  const options: DisplaySettings["items"] = [
    { provider: "claude", windowId: "five_hour" },
    { provider: "claude", windowId: "seven_day" },
    { provider: "claude", windowId: "seven_day_opus" },
    { provider: "claude", windowId: "seven_day_sonnet" },
    { provider: "claude", windowId: "weekly_scoped:Fable" },
    { provider: "codex", windowId: "codex:primary_window" },
    { provider: "codex", windowId: "codex:secondary_window" },
    { provider: "claude", windowId: "paid" },
    { provider: "codex", windowId: "paid" },
  ];
  const labels = new Map<string, string>([
    ["claude:paid", "Extra usage"],
    ["codex:paid", "Credits"],
  ]);
  if (query.data?.ok)
    for (const p of query.data.data?.providers ?? [])
      if (p.provider !== "unknown")
        for (const a of p.accounts)
          for (const w of a.windows) {
            options.push({ provider: p.provider, windowId: w.id });
            labels.set(`${p.provider}:${w.id}`, w.label);
          }
  if (display.status === "ready") options.push(...display.values.items);
  const unique = Array.from(
    new Map(options.map((v) => [`${v.provider}:${v.windowId}`, v])).values(),
  );
  return (
    <PageSection id="display" muted={c.foregroundMuted}>
      <Text style={{ color: c.foregroundMuted }}>
        Preferences apply to this host on every connected device. All footer items follow the active account. Usage stays inside SubBaton.
      </Text>
      <SubSection title="Always visible items" color={c.foreground}>
        {display.status === "ready" ? (
          <SettingsCard>
            {unique.map((item) => {
              const checked = display.values.items.some(
                (v) =>
                  v.provider === item.provider && v.windowId === item.windowId,
              );
              return (
                <SettingsSwitch
                  key={`${item.provider}:${item.windowId}`}
                  label={`${providerLabel[item.provider]} · ${labels.get(`${item.provider}:${item.windowId}`) ?? windowTitle(item.windowId)}`}
                  value={checked}
                  disabled={
                    display.saving ||
                    (!checked && display.values.items.length >= maxFooterItems)
                  }
                  onValueChange={(value) =>
                    void display.save(
                      {
                        ...display.values,
                        items: value
                          ? [...display.values.items, item]
                          : display.values.items.filter(
                              (v) =>
                                v.provider !== item.provider ||
                                v.windowId !== item.windowId,
                            ),
                      },
                      display.revision,
                    )
                  }
                />
              );
            })}
          </SettingsCard>
        ) : (
          <Text style={{ color: c.statusWarning }}>
            Display settings {display.status}
          </Text>
        )}
        <Text style={{ fontSize: 12, color: c.foregroundMuted }}>
          Up to {maxFooterItems} items: 1–3 fill one row of the footer box, 4–6
          two rows. agy and additional model windows appear after a verified CLI usage
          reading. Missing or stale values show unknown or ~, never a fresh
          zero.
        </Text>
      </SubSection>
      <SubSection title="Threshold colours" color={c.foreground}>
        {display.status === "ready" && (
          <ThresholdForm
            key={String(display.revision)}
            initial={display.values}
            busy={display.saving}
            save={(warning, danger) =>
              display.save(
                { ...display.values, warning, danger },
                display.revision,
              )
            }
          />
        )}
      </SubSection>
      {display.saveError && (
        <Text style={{ color: c.statusWarning }}>
          Save failed or conflicted. Reload before editing again.
        </Text>
      )}
      <SettingsAction label="Reload display preferences" actionLabel="Reload" onPress={() => void display.reload()} />
      {display.status === "invalid" && (
        <SettingsAction label="Invalid saved display preferences" actionLabel="Reset to defaults" onPress={() => void display.reset()} />
      )}
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {displayNote()}
      </Text>
    </PageSection>
  );
}

/** Last section of the settings page: the verified SubBaton executable this host runs. */
export function CliSection(props: PluginSurfaceProps) {
  const binary = useSettings(hostSettings),
    c = props.theme.colors;
  return (
    <PageSection id="cli" muted={c.foregroundMuted}>
      {binary.status === "ready" ? (
        <BinaryForm
          key={String(binary.revision)}
          initial={binary.values.binaryPath}
          initialAllowPath={binary.values.allowPathLookup}
          busy={binary.saving}
          save={(path, allowPathLookup) =>
            binary.save({ binaryPath: path, allowPathLookup }, binary.revision)
          }
        />
      ) : (
        <Text style={{ color: c.statusWarning }}>Binary settings {binary.status}</Text>
      )}
      {binary.saveError && (
        <Text style={{ color: c.statusWarning }}>Could not save. Reload settings and try again.</Text>
      )}
      <SettingsAction label="Reload CLI settings" actionLabel="Reload" onPress={() => void binary.reload()} />
      {binary.status === "invalid" && (
        <SettingsAction label="Invalid saved CLI settings" actionLabel="Reset to defaults" onPress={() => void binary.reset()} />
      )}
    </PageSection>
  );
}
