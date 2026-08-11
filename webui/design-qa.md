# Quality diagnostics design QA

Status: **PASS** — no open P0, P1, or P2 findings for the 1440 × 815 desktop target.

## Target and evidence

- Canonical diagnostics overview: [`../docs/images/product-diagnostics.png`](../docs/images/product-diagnostics.png)
- Pose atlas implementation: [`../docs/images/product-pose-atlas.png`](../docs/images/product-pose-atlas.png)

The source was normalized to the implementation viewport before the side-by-side comparison. The user-requested information-architecture correction is treated as authoritative: diagnostics is a new stage 7 between training and merge, producing a nine-stage workflow. The implementation also keeps the complete 9 × 13 Pitch/Yaw map instead of the source image's abbreviated five Pitch rows.

## Comparison passes

### Pass 1

- **P2 · Layout / core evidence clipped.** At 1440 × 815, the initial 665 px minimum diagnostic stack pushed the lower half of the evidence inspector below the visible workspace. This weakened the map-to-evidence workflow.
- **Fix.** Reduced the fixed toolbar/timeline footprint, changed the map workspace floor from 338 px to 285 px, reduced the coverage row, and compacted the inspector to 160 px with matching internal row heights. The full 117-cell map, metric table, three real evidence images, confidence warning, and data-cause action now appear together.

### Pass 2

- **P2 · Layout / stray timeline scrollbar.** The compact timeline allowed a small vertical scrollbar at its right edge.
- **Fix.** Kept horizontal overflow for long snapshot histories and explicitly hid vertical overflow.

### Final visual review

- **Typography:** uses the existing product type scale and compact monospace numeric treatment; no clipped or broken labels in the desktop target.
- **Spacing and hierarchy:** title/selectors, snapshot timeline, map, comparison gates, evidence, and terminal remain visually distinct without adding a competing card language.
- **Color and state:** green/improved, red/regressed, amber/stable, and neutral/empty states remain distinct. Confidence is amber and is not encoded as regression severity.
- **Images:** evidence uses real aligned-face images from the evaluation API; no CSS, SVG, or placeholder-image substitutes were added to the product.
- **Icons:** visible actions use the project's Tabler icon family and matching stroke weight.
- **Intentional source deviations:** nine workflow stages and nine Pitch rows are required functional corrections, not fidelity defects.

## Interaction and state checks

- The separate sidebar and stage-7 entries open quality diagnostics while the training preview remains on the training page.
- Metric selection updates the pressed state and map classification.
- Selecting a pose cell updates the exact `yaw` / `pitch` inspector and evidence.
- Switching to an output mode with no samples yields a bounded empty state without fabricating evidence.
- “查看数据原因” navigates to the Pose Atlas and passes the same `cellId`; an empty target cell is now retained as a valid diagnostic focus.
- Baseline/current selectors, comparison-gate state, disabled controls, and low-confidence copy expose their real states semantically.

## Accessibility and viewport resilience

- Primary controls are semantic buttons/selects with labels, pressed states, disabled states, and visible focus styling inherited from the app shell.
- The desktop target has no overlap, clipping, or hidden core action after the two fixes.
- Existing `1180px` and `780px` breakpoints preserve access through explicit horizontal scrolling and stacked panels. Alternate-width browser capture was blocked by the in-app browser URL policy during this QA pass; this is recorded as a non-blocking P3 verification gap, not as a desktop-target defect.

## Verification

- Production build: pass.
- JavaScript tests: 33 passed, 0 failed.
- Python syntax compilation for the evaluation and SAEHD integration paths: pass.
- `git diff --check`: pass (line-ending notices only).

---

# Audit summary reference pass

## Target and state

- Canonical audit implementation: [`../docs/images/product-quality-audit.png`](../docs/images/product-quality-audit.png)
- Full diagnostics context: [`../docs/images/product-diagnostics.png`](../docs/images/product-diagnostics.png)
- Source pixels: 1123 × 765. Implementation pixels/CSS viewport: 1294 × 720 at device density 1.
- State: Tool Lab → Data Audit → SRC aligned → audit ready.
- Normalization: the full source was resized proportionally to 720 px high beside the 1294 × 720 implementation. The selected KPI regions were cropped from the actual source and implementation, contained without distortion in two 1100 × 150 panels, and stacked in one comparison image.

## Comparison history

### Pass 1

- **P2 · Typography and hierarchy.** The implementation compressed each KPI into an inline label/value row with 8 px labels and 7 px context text. The reference uses vertically stacked label, large number, and colored context, so the original implementation was difficult to scan at the desktop scale.
- **Fix.** Changed the four KPI cells to separate vertical cards, raised label/value/context to 12.5/30/10.5 px, and used tabular numeric rendering with stronger optical weight.

- **P2 · Color semantics.** The original strip stayed nearly monochrome when issue counts were zero, making category responsibility hard to distinguish.
- **Fix.** Added persistent neutral/green/amber/red category accents and matched number/context color to usable, issue, and high-risk semantics while retaining the existing forest-black product palette.

### Post-fix comparison

- **Fonts and typography:** label, value, and context now match the reference hierarchy and remain unclipped at the 1294 px desktop width.
- **Spacing and layout:** four cards use the available horizontal space with 10 px gaps and 90 px minimum height; the filter bar and sample grid remain visible without collision.
- **Colors and tokens:** uses existing product `--green`, `--amber`, and danger tokens instead of introducing a competing palette.
- **Image quality:** the change does not replace or alter face imagery; existing real aligned-face assets preserve their crop and sharpness.
- **Copy and content:** all existing metric names and live values remain unchanged.
- **Icons and interaction:** no new icon substitute was introduced. SRC/DST switching was exercised after the change and both states returned to audit-ready with the summary visible.
- **Responsiveness:** the existing ≤780 px two-column breakpoint remains intact; this scoped desktop annotation did not change the overall workstation shell.

## Verification

- Production build: pass.
- Browser page identity, meaningful content, framework-overlay check, and console health: pass; 0 warnings/errors.
- Primary interaction: SRC → DST → SRC dataset switching returned an audit-ready summary each time.
- JavaScript tests: 36 passed, 0 failed.

## User correction pass — continuous horizontal summary

- Current implementation: [`../docs/images/product-quality-audit.png`](../docs/images/product-quality-audit.png)
- **P2 · Container language.** The four individually bordered cards and colored top rules from the first pass did not match the product's continuous operational panels.
- **Fix.** Replaced the cards with one neutral bordered panel and 1 px internal separators matching the training and audit surfaces. Semantic meaning now lives in text color instead of decorative borders.
- **P2 · Density.** The 90 px vertical stacks left too much empty space for four short metrics.
- **Fix.** Each metric now fills a single horizontal label/value/context row. The strip height is 64 px, values remain prominent at 26 px, and supporting text occupies the far edge.
- At the existing 780 px breakpoint the summary reflows to 2 × 2 with explicit neutral row and column separators.
- Browser interaction was repeated through SRC → DST → SRC. Both datasets returned an audit-ready summary; the DST state exposed the amber issue count and the console remained at 0 warnings/errors.

final result: passed
