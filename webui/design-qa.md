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

The full Tool Workbench was reviewed on 2026-08-02 at `1440 × 900` and `390 × 844` against real workspace media and DFL metadata.

- All nine entries were reachable: audit, extraction review, merge review, video timeline, metadata/packing, export preflight, pose atlas, coverage map, and command catalog.
- The extraction view rendered a real source frame with `source_rect` and landmarks; the merge view rendered real DST, merged, and mask material from fixed slots.
- The final audit rendered 90 interactive samples, reported 100% metadata coverage and mean quality `0.440`; the official brand image loaded at its native `1254 × 1254` dimensions.
- Desktop and mobile had zero document-level horizontal overflow. Mobile kept three sample columns and an intentionally scrollable tool-tab rail.
- Browser console warnings/errors: `0`. Mechanical craft detector findings: `0`. Automated tests: `24/24`; browser E2E: `2/2` non-mutating subtests passed and `1` mutating GPU subtest was intentionally skipped. Production build: passed.
- Post-review pagination QA reached merge batch `61–90 / 90` and frame `00061.png`; desktop/mobile remained at zero document-level horizontal overflow.
- First review found a repeated “mask missing” badge on every sample when the entire dataset had no XSeg masks. The Python audit now emits that per-item issue only for a partially masked dataset; aggregate coverage remains visible.

## Concept-to-implementation mismatch ledger

1. The concept's placeholder mark was not implemented; production uses the exact canonical `brand-mark.png`.
2. The concept's extra wide secondary sidebar was omitted to preserve the established workstation shell and content width.
3. Marketing-scale placeholder metrics were replaced with real counts, coverage, quality, and file evidence.
4. Generated portrait placeholders were replaced with actual workspace aligned images and DFL metadata.
5. The concept's action hierarchy was retained but compacted around the existing bottom terminal monitor.
6. Tool tabs become a deliberate horizontal rail on narrow screens instead of shrinking labels below readable size.
