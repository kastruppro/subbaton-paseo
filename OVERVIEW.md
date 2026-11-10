# Subscription accounts in the sidebar

SubBaton shows selected active-account quota windows in Paseo's sidebar footer. Tap it for all cached Claude, Codex and agy accounts, reset times, login expiry and manual switching. Settings choose visible windows, threshold colours and the local CLI path.

Requires Paseo 0.15.3 or newer and a stable-signed SubBaton CLI with aggregate status support. Disable duplicate built-in Claude/Codex usage sources. Display preferences are shared by clients connected to this host.

The plugin reads safe cached metadata through the CLI. Refresh now asks the CLI for active-account usage within its request limits; no credentials are stored here. Named switching supports all providers; quota strategies currently apply to Claude. Running agy sessions must finish first. Existing agents are not reopened, and an uncertain switch requires recovery inspection before retrying.
