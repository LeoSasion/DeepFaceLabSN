# Design QA

## Current sources of truth

- Product and interaction decisions: [`AGENTS.md`](./AGENTS.md)
- Implemented interface: [`src/`](./src/)
- Canonical brand asset: [`public/assets/brand-mark.png`](./public/assets/brand-mark.png)
- Accepted direction study: [`design/tool-workbench-concept.png`](./design/tool-workbench-concept.png)
- Final desktop evidence: [`design/final-tool-workbench-desktop.png`](./design/final-tool-workbench-desktop.png)
- Final mobile evidence: [`design/final-tool-workbench-mobile.png`](./design/final-tool-workbench-mobile.png)
- Local implementation URL: `http://127.0.0.1:4173/`

Generated concept images are not brand authorities. The obsolete terminal concept was removed on 2026-08-02 because its embedded logo no longer matched the canonical asset. The current direction study deliberately uses an “OFFICIAL MARK SLOT” placeholder; production continues to render the checked-in `brand-mark.png` directly.

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

For rendered UI changes, also inspect the production build in the in-app browser, exercise the affected interactions, check the console for warnings/errors, and capture reviewed desktop and mobile evidence.

## Last completed audit

The dataset audit was reviewed on 2026-08-02 at `1600 × 968` and `390 × 844` against the supplied visual direction, real workspace faces, and DFL metadata.

- Tool detail pages render without the project WorkflowBar; workflow pages retain it.
- The desktop audit renders 90 real samples in a five-column internally scrollable grid, a visible right inspector, and a bottom action dock above the collapsed console.
- Every card identifies `XSEG` or `无遮罩`. The inspector explains whether blur used the eroded XSeg region or the full-frame fallback and preserves the full-frame baseline for comparison.
- Search, issue/mask filters, sorting, sample-to-inspector selection, and the empty XSeg-filter state were exercised in the in-app browser.
- Desktop and mobile had zero document-level horizontal overflow. Mobile uses three sample columns and the existing horizontally scrollable tool rail.
- Visible real images loaded at `256 × 256`; browser warnings/errors: `0`; mechanical craft detector findings: `0`.
- Automated tests: `25/25`, including a synthetic sharp-outside/soft-inside XSeg scope regression. Production and Sites-compatible builds passed.
- Evidence is stored outside the repository under `C:\Users\Administrator\.codex\visualizations\2026\08\01\019fbe98-ca16-7242-a78d-f37e1f18395d\data-audit-qa`.

## Concept-to-implementation mismatch ledger

1. The supplied reference's sidebar and top chrome were explicitly excluded; production keeps the official `brand-mark.png`, established sidebar, and project header.
2. Reference KPI values and portraits were replaced with real workspace counts, aligned faces, filenames, frame links, and audit scores.
3. The reference's body hierarchy was retained: tool rail, ready state, four KPIs, filter bar, five-column grid, right inspector, and bottom action area.
4. The inspector uses DeepFaceLab-specific XSeg scope, pose, source-frame, and recoverable quarantine evidence rather than generic person metadata.
5. The bottom action area stays visible above the existing collapsed terminal; the sample grid owns vertical scrolling.
6. Mobile retains a three-column image grid and horizontal tool rail instead of shrinking labels or introducing page-level horizontal overflow.

## Final result

passed
