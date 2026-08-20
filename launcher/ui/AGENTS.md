# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable launcher decisions

- The selected first-run design is `../design/first-run-selected.png`: a four-step rail, component evidence rows, installation terminal, and a compact path/mirror/action footer.
- The selected normal-use design is `../design/ready-selected.png`: the interactive terminal is the main work area and the action rail is secondary. Normal use is the dominant state.
- Match the existing DeepFaceLabSN forest-black and emerald workbench visual system. Use the official `brand-mark.png` and Tabler icons; do not invent substitute marks or glyph icons.
- GitHub update UX means a Git fetch/check followed only by an explicit safe fast-forward update. Never imply that merely checking updates overwrites files.
- Local config, workspace, workspaces, models, project records, runtimes, and local settings are protected user data and must never be presented as update targets.
- Native communication uses `{ id, method, params }`, `{ id, result }` / `{ id, error }`, and event messages `{ event, data }`.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
