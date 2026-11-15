import type {
  PluginClientContext,
  PluginPopoverProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { AccountPopover, Footer } from "./client/views.js";
import { ControlScreen } from "./client/control.js";
import { subbatonMark } from "./client/icons.js";
export default function contribute(client: PluginClientContext) {
  function Details(props: PluginPopoverProps) {
    return (
      <AccountPopover
        {...props}
        openSettings={() => client.openSettings("subbaton")}
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
  const removeControl = client.addSettingsScreen({
    id: "subbaton",
    title: "SubBaton",
    icon: { svg: subbatonMark },
    Component: ControlScreen,
  });
  return () => {
    removeFooter();
    removeControl();
  };
}
