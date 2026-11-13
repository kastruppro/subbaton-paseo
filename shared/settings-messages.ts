// Static plugin wording for typed CLI settings/poller refusals. Raw CLI messages are never shown.
export const settingsMessages: Record<string, string> = {
  duplicate: "That account name is already used by this provider. Choose another name.",
  busy: "Provider settings are busy. Retry shortly.",
  revisionConflict:
    "Settings changed elsewhere (another device, the CLI or an account change). The latest values were reloaded; review them and apply again.",
  invalidSetting:
    "A value is outside the field's type, range or allowed values. Nothing was saved.",
  overlappingChanges:
    "Two changes target the same setting. Nothing was saved.",
  unknownAccount:
    "That account is not in the loaded settings. Reload settings and try again.",
  readOnly:
    "These settings are read-only (no saved vault yet, or a newer settings schema).",
  reloadSettings: "Reload settings before changing them.",
  invalidStoredSettings:
    "Stored settings are invalid. Nothing was changed; inspect them with the SubBaton CLI on the Mac.",
  multipleProviders: "Send one provider's changes at a time.",
  vaultMissing:
    "This provider has no saved accounts yet. Add an account on the Mac first.",
  newerSchema:
    "These settings use a newer schema than this SubBaton CLI supports. Update the CLI before editing.",
  revisionRequired: "Reload settings; the current revision is required.",
  pauseChanged:
    "The pause changed or ended since it was loaded. Review the new reason after the reload, then resume again if needed.",
  releaseRefused:
    "Release was refused: the block no longer matches, or the account needs login, has expired or has pending recovery.",
  recoveryRequired:
    "Recovery is pending for this provider. Resolve it with the SubBaton CLI first.",
  invalidResponse:
    "This provider's settings response was not understood. Update the plugin or the CLI.",
  tickRunning: "A usage poll is running. Retry in a minute.",
  unstableBinary:
    "The poller needs a stable, Developer ID signed SubBaton installation outside build or temporary folders.",
  launchctlFailure:
    "The LaunchAgent operation failed. Check poller status in the Mac's logged-in session before retrying.",
  invalidPollerState:
    "The saved poller definition is invalid. Nothing was changed.",
  storageDenied:
    "LaunchAgents or Logs is not a plain folder on the Mac. Nothing was installed.",
  signingRequired: "Use a stable signed SubBaton binary.",
};
