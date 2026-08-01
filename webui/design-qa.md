# Design QA

## Current sources of truth

- Product and interaction decisions: [`AGENTS.md`](./AGENTS.md)
- Implemented interface: [`src/`](./src/)
- Canonical brand asset: [`public/assets/brand-mark.png`](./public/assets/brand-mark.png)
- Local implementation URL: `http://127.0.0.1:4173/`

Generated concept images are not brand authorities. The obsolete terminal concept was removed on 2026-08-02 because its embedded logo no longer matched the canonical asset. Any future mock must receive `brand-mark.png` as a separate exact reference, or have it composited without generative redraw.

## Required visual checks

- Preserve the forest-black workstation shell, emerald active states, amber warnings, and violet XSeg states.
- Verify desktop and `390 × 844` mobile layouts with no document-level horizontal overflow.
- Keep primary navigation, destructive confirmations, terminal controls, and dataset recovery actions keyboard accessible.
- Confirm raster previews have valid natural dimensions and that the browser renders `brand-mark.png`, not a historical candidate or generated approximation.
- Check loading, empty, error, selected, disabled, and destructive states for every newly added workbench.

## Required functional checks

```powershell
pnpm test
pnpm build
```

For rendered UI changes, also inspect the production build in the in-app browser, exercise the affected interactions, check the console for warnings/errors, and capture desktop and mobile evidence outside the repository.

## Last completed audit

The Tool Lab and pose-atlas delivery was reviewed on 2026-08-02 at `1440 × 900` and `390 × 844`. Metric switching, migration-map selection, exact dataset navigation, responsive overflow, framework overlays, and console output passed. The recoverable quarantine action was reviewed through its guarded interaction and API path without moving user data.
