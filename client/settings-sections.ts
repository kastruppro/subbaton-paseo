import { groupFor, type FieldView, type GroupTitle } from "./settings-model.js";

// One settings page. Section order and wording live here so they can be tested; the page itself
// (control.tsx) renders each section from the CLI field metadata, unchanged.
export type SectionId = "display" | "accounts" | "auto" | "handoff" | "poller" | "events" | "cli";

export const settingsSections: { id: SectionId; title: string; summary: string }[] = [
  { id: "display", title: "Footer & display", summary: "Chooses which usage items the sidebar footer shows and the colours they turn at." },
  { id: "accounts", title: "Accounts", summary: "Lists each provider's saved accounts with their order, names and per-account options." },
  { id: "auto", title: "Automatic switching", summary: "Controls whether and how SubBaton switches this provider's account on its own, including thresholds and Credits fallback." },
  { id: "handoff", title: "Codex & agy handoff", summary: "Controls how Paseo agents pick up a new login after a switch and when limited Codex agents continue." },
  { id: "poller", title: "Background poller", summary: "Shows and controls the Mac job that reads usage in the background." },
  { id: "events", title: "Notifications & events", summary: "Chooses which events notify you and lists what automatic switching has done." },
  { id: "cli", title: "SubBaton CLI", summary: "Sets which verified SubBaton command-line program this host runs." },
];

/** Where each provider field group lands; unknown CLI fields fall under "Other settings" and stay in Automatic switching. */
export const sectionOfGroup: Record<GroupTitle, SectionId> = {
  Codex: "handoff",
  "Automatic switching": "auto",
  Thresholds: "auto",
  "Weekly reset priority": "auto",
  "Inactive polling": "poller",
  Notifications: "events",
  "Other settings": "auto",
};
export const sectionOfField = (path: string): SectionId => sectionOfGroup[groupFor(path)];

export function providerFieldsBySection(groups: { title: GroupTitle; fields: FieldView[] }[]) {
  const result: Record<SectionId, { title: GroupTitle; fields: FieldView[] }[]> = {
    display: [], accounts: [], auto: [], handoff: [], poller: [], events: [], cli: [],
  };
  for (const group of groups) result[sectionOfGroup[group.title]].push(group);
  return result;
}

/** What each section contains on the page. */
export const pageManifest: Record<SectionId, string[]> = {
  display: ["display-items", "display-thresholds", "display-reload", "display-reset-invalid"],
  accounts: ["account-order", "account-cards", "add-account"],
  auto: ["auto-fields", "auto-paused-resume", "auto-plan"],
  handoff: ["handoff-section", "codex-fields"],
  poller: ["poller-status", "poller-lifecycle", "inactive-polling-fields"],
  events: ["notification-fields", "recent-events"],
  cli: ["cli-binary", "cli-allow-path"],
};

/** Everything that was reachable on the two earlier screens (usage display settings and the CLI page). */
export const legacyReachable = [
  "cli-binary", "cli-allow-path", "display-items", "display-thresholds", "display-reload", "display-reset-invalid",
  "account-order", "account-cards", "add-account", "auto-fields", "auto-paused-resume", "auto-plan",
  "handoff-section", "codex-fields", "poller-status", "poller-lifecycle", "inactive-polling-fields",
  "notification-fields", "recent-events",
];

/** Footer note: true next to the handoff section, which does reload agents. */
export const displayNote = () =>
  `Disable Paseo's built-in Claude/Codex usage sources to avoid duplicate polling. These display settings never reload agents; reloads are controlled under ${settingsSections.find((s) => s.id === "handoff")!.title}.`;
