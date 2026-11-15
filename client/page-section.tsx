import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { SettingsSection } from "@getpaseo/plugin/client/ui";
import { settingsSections, type SectionId } from "./settings-sections.js";

/** One headed section of the single settings page, with the one sentence that says what it controls. */
export function PageSection({ id, muted, children }: { id: SectionId; muted: string; children: ReactNode }) {
  const section = settingsSections.find((s) => s.id === id)!;
  return (
    <SettingsSection title={section.title}>
      <Text style={{ color: muted, fontSize: 12 }}>{section.summary}</Text>
      <View style={{ gap: 12 }}>{children}</View>
    </SettingsSection>
  );
}

/**
 * Level-2 heading of the settings page: every sub-group inside a PageSection (level 1) uses this one
 * style, with a header role, so the hierarchy is the same everywhere.
 */
export function SubSection({ title, color, children }: { title: string; color: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text accessibilityRole="header" aria-level={2} style={{ color, fontSize: 14, fontWeight: "600" }}>
        {title}
      </Text>
      {children}
    </View>
  );
}
