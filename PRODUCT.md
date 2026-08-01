<!-- impeccable:product-schema 1 -->

# DeepFaceLabSN product context

## Product summary

DeepFaceLabSN is a local-first Windows workbench for operating a DeepFaceLab pipeline without losing the original Python toolchain. It combines a Chinese Web interface, fixed and reviewable command definitions, persistent terminal sessions, and direct inspection of the real `workspace` data.

The product is not a cloud service and must not turn DeepFaceLab into an arbitrary remote shell. The Web layer should make high-frequency visual decisions native while preserving a controlled handoff to original interactive tools when GPU-heavy or window-bound behavior cannot yet be reproduced safely.

## Intended users

- Primary: an experienced solo DeepFaceLab operator or small creator team working on a local NVIDIA Windows workstation.
- Secondary: a returning operator who understands pipeline stages but needs stronger status, preflight, recovery, and dataset-quality guidance.
- Assumption: Chinese is the primary operating language; English identifiers remain where they map directly to DeepFaceLab concepts or files.

## Core jobs to be done

- Understand whether SRC, DST, models, masks, merged frames, and final outputs are ready.
- Inspect and curate face datasets visually before spending GPU time.
- Start, monitor, control, recover, and audit long-running DeepFaceLab jobs.
- Compare source, mask, merged, and output artifacts before committing to the next stage.
- Diagnose blockers with actionable evidence instead of discovering them deep inside a terminal session.
- Preserve access to the original DeepFaceLab behavior and output layout.

## Product principles

1. Real workspace data over decorative demos. Empty, partial, loading, and failure states must remain honest.
2. Visual decisions belong in the Web workbench; long-running execution belongs in fixed backend commands and persistent jobs.
3. Python owns DeepFaceLab-domain parsing, scoring, and preflight logic. The server owns path safety, bounded execution, caching, and streaming. React owns presentation and interaction.
4. Destructive dataset actions must be explicit and recoverable. Prefer quarantine and manifests over silent rename or delete operations.
5. Every bridge to a legacy window or CLI must explain why it is needed and what state will be carried across.
6. CLI compatibility and DeepFaceLab output equivalence are acceptance requirements, not optional polish.
7. Optimize measured bottlenecks only; do not trade model correctness or deterministic outputs for cosmetic speed.

## Brand commitments

- The only product mark is the checked-in official asset at `webui/public/assets/brand-mark.png`.
- Generated concepts and QA captures may not invent, redraw, or substitute the product mark.
- The established Web shell is the visual source of truth: quiet dark workspace, high-information panels, restrained accent use, and compact operational copy.
- Dense tools should feel like a professional editing console, not a marketing dashboard or a generic admin template.

## Interaction and accessibility commitments

- Keyboard access is required for primary controls, dialogs, tabs, lists, frame stepping, and dataset selection.
- Focus indicators, semantic labels, and status text may not rely on color alone.
- Heavy visual review is desktop-first; core monitoring, status, and task control must remain usable on a narrow viewport.
- Motion must communicate state changes and respect reduced-motion preferences.
- Long lists must use pagination, virtualization, or bounded rendering.

## Technical constraints

- The runtime listens on loopback only and requires the local session for writes.
- Commands, paths, profiles, and launch modes come from fixed registries; the browser never sends an arbitrary shell command.
- All workspace paths are resolved inside the configured workspace root.
- Python helpers must return bounded machine-readable output and must not mutate datasets during an inspection call.
- Existing DeepFaceLab Python entry points and batch/CLI workflows remain supported.

## Success evidence

- Every original tool category has a discoverable Web surface, an honest support state, and a next action.
- Dataset, metadata, pack, video, merger, and export decisions can be made from real workspace evidence.
- Preflights block or explain invalid runs before GPU work starts.
- Automated API and UI tests pass, production builds succeed, and desktop/mobile screenshots complete a visual review loop.
- No obsolete concept art, duplicate logo, temporary QA output, or unreachable implementation remains in the repository.
