# Design QA

## Comparison target

- Source visual truth: [`design/terminal-runtime-concept.png`](./design/terminal-runtime-concept.png)
- Implementation URL: `http://127.0.0.1:4173/`
- Implementation screenshot: local QA artifact (not committed)
- Full-view comparison: local QA artifact (not committed)
- Focused core-workbench comparison: local QA artifact (not committed)
- Responsive screenshot: local QA artifact (not committed)
- Interaction screenshots:
  - Paused state: local QA artifact (not committed)
  - New-task dialog: local QA artifact (not committed)

## Normalization

- Source pixels: `1487 × 1058`
- Implementation pixels: `1487 × 1058`
- CSS viewport: `1487 × 1058`
- `deviceScaleFactor`: `1`
- Density normalization: none required; both full-view images use identical pixel dimensions.
- State: desktop dark theme, overview navigation selected, SAEHD training running, console expanded.
- Browser classification: Browser plugin was available but its Node REPL runtime failed with `failed to write kernel assets: 系统找不到指定的路径。 (os error 3)`. The user explicitly allowed Playwright fallback.
- Render engine: Playwright `1.61.1` using the locally installed Microsoft Edge executable.

## Full-view comparison evidence

The final side-by-side comparison confirms the same desktop frame, sidebar width, project/GPU header, eight-stage workflow, three-column workbench, training chart and face-preview hierarchy, status inspector, action row, and expanded bottom console. The forest-black, emerald, amber, violet, and danger tokens preserve the selected visual direction. No persistent control is clipped or hidden at the target viewport.

## Focused region comparison evidence

The focused workbench comparison was required because chart labels, face crops, action buttons, task states, borders, and dense UI typography were too small to judge reliably in the full-view image. The final focused comparison confirms:

- log-scaled, noisy SAEHD loss curves with a visible `428,160` reference;
- distinct SRC, DST, reconstruction, and swap-preview groups with complete raster assets;
- the same task/status hierarchy and semantic green, amber, violet, and danger states;
- aligned action-row height and a fully visible safe-stop control.

## Required fidelity surfaces

- Fonts and typography: Chinese-first system font stack with Inter preference; hierarchy, weights, line heights, wrapping, and monospace console copy remain readable at the target density. No clipped labels remain.
- Spacing and layout rhythm: the workbench is `1281 × 618` CSS pixels; console height and core panel proportions now match the source composition closely. Borders, radii, padding, and section gaps are consistent.
- Colors and visual tokens: fluorescent emerald is reserved for active/success, amber for waiting/warning, violet for XSeg, and red-orange for destructive stop. Contrast is legible throughout the tested states.
- Image quality and asset fidelity: all four visible preview groups use raster assets with valid natural dimensions. The source brand mark is used as a raster asset rather than approximated with CSS or an unrelated icon.
- Copy and content: all visible app copy is coherent Chinese DFL terminology, with correct SRC/DST direction labels and realistic local workspace, queue, checkpoint, GPU, and console data.

## Comparison history

### Pass 1 — blocked

- `[P2]` The console was too short and the central workbench too tall, changing the source composition.
  - Fix: increased the expanded console from `182px` to `226px`, increased its top row, and reduced the workbench to `618px` at the normalized viewport.
- `[P2]` The loss chart used a smooth linear scale instead of the source's noisy logarithmic plot.
  - Fix: changed to a `0.001–1` log scale, added deterministic training noise/spikes, and restored dense iteration ticks.
- `[P2]` Initial navigation and the brand mark did not match the selected source state.
  - Fix: selected Overview by default and replaced the unrelated icon with the source raster brand mark.
- `[P2]` Browser health contained Recharts size warnings and a missing-favicon request.
  - Fix: supplied an initial chart dimension, set the Chinese page title/language, and removed the favicon request.

### Pass 2 — blocked

- `[P2]` The leftmost log-axis label and the chart reference label were clipped.
  - Fix: removed the negative chart margin, added explicit iteration ticks, and moved the reference label inside the plot.

### Pass 3 — passed

- Post-fix full-view evidence: local QA artifact (not committed)
- Post-fix focused evidence: local QA artifact (not committed)
- No actionable P0, P1, or P2 findings remain.

## Functional and responsive checks

- Page identity: `DeepFaceLab 管理台` at `http://127.0.0.1:4173/`
- Meaningful first screen: passed.
- Framework error overlay: absent.
- Console warnings/errors: none.
- Pause → status changed to `已暂停`, action changed to `继续`, warning toast appeared.
- Resume → status changed to `训练中`, action changed to `暂停`.
- New task → dialog opened with valid defaults and workspace path; joining the queue closed the dialog and added a queue row.
- Mobile viewport: `390 × 844`, document width equals viewport width (`390px`), no horizontal page overflow, primary action remains reachable.

## Follow-up polish

- `[P3]` The generated face identities and exact poses differ from the concept image while preserving the same DFL preview structure and dark studio art direction.
- `[P3]` Exact font rasterization varies with locally installed Chinese fonts.
- A later bounded Impeccable polish pass refined hierarchy, interaction feedback, keyboard dialog behavior, and mobile overflow without changing the accepted layout or palette; old/new screenshot evidence is kept outside the repository.

final result: passed
