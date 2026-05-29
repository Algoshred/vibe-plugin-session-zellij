# @vibecontrols/vibe-plugin-session-zellij

<!-- VIBECONTROLS_OSS_BODY_START -->

> Zellij + ttyd session provider — terminal workspace with floating panes.

## Install

```bash
vibe plugin install @vibecontrols/vibe-plugin-session-zellij
```

Or install the npm package directly into an existing project that hosts the VibeControls agent:

```bash
bun add @vibecontrols/vibe-plugin-session-zellij
# or
npm install @vibecontrols/vibe-plugin-session-zellij
```

## How it works

Session **providers** implement the persistent-terminal contract from `@vibecontrols/vibe-plugin-session-manager` (meta). The meta plugin handles capability discovery, feature negotiation and per-session routing.

This package is a **provider** registered against the `@vibecontrols/vibe-plugin-session-manager` meta plugin. Install the meta plugin first; this provider plugs into it.

## Upstream

- **Zellij** — <https://github.com/zellij-org/zellij>

## More

- npm: <https://www.npmjs.com/package/@vibecontrols/vibe-plugin-session-zellij>
- Source: <https://github.com/algoshred/vibe-plugin-session-zellij>
- Plugin contract / SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- Plugin catalogue: <https://vibecontrols.com/plugins/session-zellij>

<!-- VIBECONTROLS_OSS_BODY_END -->

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## Credits

This plugin builds on the following upstream open-source projects. All trademarks and copyrights remain with their respective owners.

- **Zellij** — <https://github.com/zellij-org/zellij>

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

**Note**: this plugin is open source under MIT. The `@vibecontrols/agent` runtime that loads and orchestrates plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
