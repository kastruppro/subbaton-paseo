import { useState } from "react";
import { Text, View } from "react-native";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { handoffControlRpc, handoffProviders, handoffSettings, type HandoffProvider } from "../shared/handoff.js";
import type { ActionResult } from "../shared/contracts.js";
import { handoffActions, handoffLine, handoffTone } from "./handoff-model.js";
import { SubSection } from "./page-section.js";
import { useHandoff } from "./use-handoff.js";
import { providerLabel, relativeAge } from "./display.js";

type Colors = PluginSurfaceProps["theme"]["colors"];

export function HandoffSection({ hostId, colors }: { hostId: string; colors: Colors }) {
  const status = useHandoff(hostId);
  const control = useRpc(handoffControlRpc);
  const prefs = useSettings(handoffSettings);
  const [notice, setNotice] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState<HandoffProvider | null>(null);
  const [wait, setWait] = useState<string | null>(null);
  const run = async (provider: HandoffProvider, action: "cancel" | "reopen" | "dismiss") => {
    setBusy(true);
    try {
      setNotice((await control({ provider, action })).result);
    } catch {
      setNotice({ outcome: "error", code: "transport", message: "The request did not reach the host." });
    } finally {
      setBusy(false);
      void status.refetch();
    }
  };
  const data = status.data;
  return (
    <SubSection title="Coordinated handoff" color={colors.foreground}>
      <SettingsCard>
        {data?.notice && (
          <SettingsAction
            label="Handoff state was reset"
            hint={data.notice.message}
            actionLabel="Dismiss"
            disabled={busy}
            onPress={() => void run("codex", "dismiss")}
          />
        )}
        {data && !data.agentApi && (
          <SettingsRow
            label="Agent API not seen yet"
            hint="The host reaches Paseo agents through an open client or a finished turn. Waiting handoffs continue then."
          />
        )}
        {handoffProviders.map((provider) => {
          const h = data?.handoffs[provider] ?? null;
          if (!h) return <SettingsRow key={provider} label={providerLabel[provider]} hint="No handoff. Use When idle in the account popover." />;
          const actions = handoffActions(h);
          return (
            <View key={provider}>
              <SettingsRow label={providerLabel[provider]} hint={`${handoffLine(h)} Updated ${relativeAge(h.updatedAt)}.${h.daemonOutcome && h.daemonOutcome !== "not-requested" ? ` Daemon restart: ${h.daemonOutcome}.` : ""}`}>
                <Text
                  accessibilityLiveRegion="polite"
                  style={{ fontSize: 12, color: handoffTone(h) === "warning" ? colors.statusWarning : handoffTone(h) === "ok" ? colors.statusSuccess : colors.foregroundMuted }}
                >
                  {h.phase}
                </Text>
              </SettingsRow>
              {actions.cancel && (
                <SettingsAction
                  label={h.phase === "reopening" ? "Stop reopening" : "Cancel the waiting handoff"}
                  hint={h.phase === "reopening" && provider === "agy" ? "Closed agy agents stay closed; Reopen agents stays available." : undefined}
                  actionLabel="Cancel"
                  disabled={busy}
                  onPress={() => void run(provider, "cancel")}
                />
              )}
              {actions.reopen && (
                <SettingsAction
                  label="Closed agents"
                  hint="Reopen only after checking the active login and recovery state on the Mac."
                  actionLabel="Reopen agents"
                  disabled={busy}
                  onPress={() => setConfirmReopen(provider)}
                />
              )}
              {actions.dismiss && <SettingsAction label="Clear this result" actionLabel="Dismiss" disabled={busy} onPress={() => void run(provider, "dismiss")} />}
            </View>
          );
        })}
      </SettingsCard>
      {notice && (
        <Text accessibilityRole="alert" style={{ fontSize: 13, color: notice.outcome === "success" ? colors.statusSuccess : colors.statusWarning }}>
          {notice.message}
        </Text>
      )}
      {prefs.status === "ready" && (
        <SettingsCard>
          <SettingsSwitch
            label="Reload Codex agents after every verified switch"
            hint="After a verified Codex switch from the app, terminal or poller, reload idle Paseo Codex agents so they use the new login. Running turns are never interrupted."
            value={prefs.values.reloadCodexAfterAutomaticSwitch}
            disabled={prefs.saving}
            onValueChange={(value) => void prefs.save({ ...prefs.values, reloadCodexAfterAutomaticSwitch: value }, prefs.revision)}
          />
          <SettingsSwitch
            label="Restart the shared Codex daemon at the idle boundary"
            hint="Off by default. Once every Paseo Codex agent is idle: --restart-daemon on When idle, and codex daemon restart while a restart is pending after a switch. Terminal Codex sessions attached to the daemon may need codex resume."
            value={prefs.values.restartCodexDaemon}
            disabled={prefs.saving}
            onValueChange={(value) => void prefs.save({ ...prefs.values, restartCodexDaemon: value }, prefs.revision)}
          />
          <SettingsSwitch
            label="Continue Codex agents that hit a usage limit"
            hint="On by default, for every workspace on this host. After a verified Codex switch and a successful daemon restart, Paseo Codex agents whose latest turn ended in a usage limit get one message: continue the previous task. It never turns the daemon restart on by itself; with the restart off nothing is continued."
            value={prefs.values.resumeLimitedCodexAgents}
            disabled={prefs.saving}
            onValueChange={(value) => void prefs.save({ ...prefs.values, resumeLimitedCodexAgents: value }, prefs.revision)}
          />
          <SettingsSwitch
            label="Let automatic agy switches close idle Paseo agy agents"
            hint="When running agy sessions are the only thing blocking an automatic agy switch, close Paseo's own idle agy agents, switch and reopen them. Terminal and desktop agy sessions are never stopped."
            value={prefs.values.closeAgyForAutomaticSwitch}
            disabled={prefs.saving}
            onValueChange={(value) => void prefs.save({ ...prefs.values, closeAgyForAutomaticSwitch: value }, prefs.revision)}
          />
          <SettingsInput
            key={prefs.revision}
            label="Wait for idle (minutes)"
            hint="1 to 240. A handoff still waiting after this expires without changing anything."
            initialValue={String(prefs.values.idleWaitMinutes)}
            error={wait !== null && !/^\d{1,3}$/.test(wait) ? "Enter a whole number from 1 to 240." : wait !== null && (Number(wait) < 1 || Number(wait) > 240) ? "Enter a whole number from 1 to 240." : null}
            onChangeText={setWait}
          />
          <SettingsAction
            label="Idle wait"
            actionLabel="Save"
            disabled={prefs.saving || wait === null || !/^\d{1,3}$/.test(wait) || Number(wait) < 1 || Number(wait) > 240}
            onPress={() => void prefs.save({ ...prefs.values, idleWaitMinutes: Number(wait) }, prefs.revision).then(() => setWait(null))}
          />
        </SettingsCard>
      )}
      <Modal title="Reopen closed agents?" open={confirmReopen !== null} onOpenChange={(open) => !open && setConfirmReopen(null)}>
        <Modal.Content>
          <Text style={{ color: colors.foreground }}>
            The switch did not finish cleanly. Reopened agents use whatever login is active on the Mac now. Check it with the SubBaton CLI first.
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <SettingsAction
              label="Reopen with their saved conversations"
              actionLabel="Reopen"
              disabled={busy}
              onPress={() => {
                const provider = confirmReopen;
                setConfirmReopen(null);
                if (provider) void run(provider, "reopen");
              }}
            />
            <SettingsAction label="Keep them closed" actionLabel="Cancel" onPress={() => setConfirmReopen(null)} />
          </View>
        </Modal.Content>
      </Modal>
    </SubSection>
  );
}
