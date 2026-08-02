# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Product Decisions

- Preserve the accepted “方案 1” desktop information architecture: left navigation, project/GPU header, horizontal DFL workflow, current pipeline, SAEHD training preview, realtime inspector, and bottom console.
- Use the selected third visual direction as the source of truth: forest-black surfaces, fluorescent emerald primary states, amber pending/warning states, and violet reserved for XSeg.
- Keep the experience Chinese-first, local-workstation oriented, dense but calm, and faithful to real DeepFaceLab BAT workflows.
- Core prototype interactions must include navigation selection, task selection, save/pause/resume, preview refresh, snapshot feedback, safe-stop confirmation, queue clearing, console collapse, and new-task dialog.
- The initial implementation deliberately deferred Impeccable; a later bounded Impeccable polish pass was completed on 2026-07-29 while preserving the accepted information architecture and forest-black/emerald palette.
- Primary-sidebar hover uses a half-brightness emerald treatment derived from the current-pipeline hover surface; hover must remain visibly quieter than the selected state.
- The sole brand source of truth is `public/assets/brand-mark.png`: the high-resolution two-tone pixel face. Generated concepts and historical candidates must never override or redraw it.
- Display the high-resolution brand mark at `32px`; when producing visual references, provide the exact asset separately or composite it deterministically instead of asking an image model to recreate it.
- Treat the Web UI as a loopback-only local workstation manager. Runtime code must never execute or parse BAT files; BAT files are development references only.
- Expose DFL operations through a fixed command registry and a ConPTY-backed terminal. Never add an arbitrary shell or client-supplied executable/argument array.
- SAEHD Web training uses `_internal/DeepFaceLab_old/main.py`, `--no-preview`, and the file-based Trainer control/preview bridge.
- Persist local runtime state under `workspace/.webui`; browser refresh reconnects to live service sessions, while service restart marks unrecoverable process sessions as orphaned.
- Reserve external-window integration behind an adapter interface. Do not capture or embed external windows in the current delivery.
- Ship one root-level WebUI manager BAT for start/open, status, restart, and stop. Its Node supervisor owns ports 4173/4174, production-build freshness, PID/status files, logs, and bounded child-process restarts; it must report unknown port owners instead of terminating them.
- Keep only `启动 WebUI.bat` and `传统命令菜单.bat` at the repository root. The traditional entry launches a whitelist-based interactive CLI router under `legacy-cli`; preserve the Explorer-based menu only as an optional fallback, and keep its initialization BAT limited to local menu visibility without changing global Windows settings.
- Complete the local WebUI in this order: full DFL pipeline commands, parameterized task guidance with terminal takeover, workspace/material/model/output management, GPU and training telemetry, then browser end-to-end coverage.
- Treat the Tool Lab as the Web migration home for DeepFaceLab's remaining Python utilities. Preserve the existing forest-black/emerald workstation shell while replacing legacy desktop widgets with compact, inspectable Web interactions.
- The pose atlas is the reference pattern for utility migration: use real aligned-face metadata, keep quality and coverage metrics inline, expose recoverable actions only, and link a selected sample back to the exact dataset-browser item.
- Keep the Tool Migration Map evidence-based. Distinguish tools already Web-native from original UI candidates and CLI-only visualization plans, and show the actual Python source for every entry.
- Treat every Web migration as an end-to-end capability change, not a frontend wrapper. Refactor the underlying DeepFaceLab Python when that produces cleaner headless APIs, structured progress, cancellation, batching, caching, dry-run output, or safer atomic writes.
- Preserve CLI compatibility and output equivalence when refactoring Python. The Web API and original command path should call the same reusable core functions, with regression tests covering real DFL metadata and representative workspace assets.
- Optimize Python only with an observable reason such as repeated decode work, serial independent analysis, excess filesystem scans, blocking UI loops, or unsafe in-place mutation. Prefer manifests, recoverable staging, bounded worker pools, and deterministic results over UI-only workarounds.
- Tool detail pages are independent utilities, not pipeline stages. Keep the project WorkflowBar out of the Tool Lab while preserving it on actual workflow pages.
- For dataset blur audits, use a valid embedded XSeg mask as the preferred sharpness scope, erode its raster edge before measurement, and retain the full-frame score as an inspectable baseline. Every sample card must state whether an applied XSeg mask exists.
- The accepted dataset-audit body direction is a compact five-column review grid with an always-visible right quality inspector and bottom recovery/action dock. Preserve the established app sidebar and project header rather than cloning those parts of external concepts.
