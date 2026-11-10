import type {
  PluginClientContext,
  PluginPopoverProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { AccountPopover, Footer } from "./client/views.js";
import { SettingsScreen } from "./client/settings.js";
export default function contribute(client: PluginClientContext) {
  function Details(props: PluginPopoverProps) {
    return (
      <AccountPopover
        {...props}
        openSettings={() => client.openSettings("preferences")}
      />
    );
  }
  function Strip(props: PluginSidebarItemProps) {
    return <Footer {...props} Details={Details} />;
  }
  const removeFooter = client.addSidebarFooterItem({
    id: "usage",
    title: "SubBaton usage",
    Component: Strip,
  });
  const removeSettings = client.addSettingsScreen({
    id: "preferences",
    title: "Usage display",
    icon: "Gauge",
    Component: SettingsScreen,
  });
  return () => {
    removeFooter();
    removeSettings();
  };
}
