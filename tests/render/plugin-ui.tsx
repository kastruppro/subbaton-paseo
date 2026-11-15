import React from "react";
/** Test stand-ins for @getpaseo/plugin/client/ui: plain elements that expose every label, heading level and control. */
const h = React.createElement;
export const Icon = () => null;
// Level-1 headings are the page sections; level-2 headings come from the page's own SubSection.
export const SettingsSection = ({ title, children }: any) => h("section", { "data-kind": "section" }, h("div", { role: "heading", "aria-level": 1, "data-heading": title }, title), children);
export const SettingsCard = ({ children }: any) => h("div", null, children);
export const SettingsRow = ({ label, hint, children }: any) => h("div", { "data-control": "row", "data-label": label }, label, hint, children);
export const SettingsSwitch = ({ label, hint }: any) => h("div", { "data-control": "switch", "data-label": label }, label, hint);
export const SettingsInput = ({ label, hint }: any) => h("div", { "data-control": "input", "data-label": label }, label, hint);
export const SettingsSelect = ({ label, hint }: any) => h("div", { "data-control": "select", "data-label": label }, label, hint);
export const SettingsAction = ({ label, hint, actionLabel }: any) => h("div", { "data-control": "action", "data-label": label }, label, hint, actionLabel);
export const Modal: any = () => null;
Modal.Content = () => null;
