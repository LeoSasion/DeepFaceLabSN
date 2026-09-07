# Native launcher host

This directory contains the C# 5 / .NET Framework 4.8 WPF host for the
DeepFaceLab-WEBUI single-file launcher. It embeds the production launcher UI,
`bootstrap.ps1`, `runtime-artifacts.ps1`, `python-wheelhouse.ps1`, the
runtime manifest, pinned Python lock and requirements, WebView2 managed
assemblies, the x64 `WebView2Loader.dll`, and the official brand icon into the
generated EXE.

Folder selection resolves the final destination once: empty folders are used
directly, while drive roots and non-empty folders use a `DFL-WEBUI` child.
Existing projects are reused. Occupied non-project targets are rejected without
overwriting files or adding another nested directory. The UI shows the full
destination, and installation validates that same path again before starting.

The canonical GitHub repository is `LeoSasion/DeepFaceLab-WEBUI`. The legacy
`LeoSasion/DeepFaceLabSN` GitHub remote remains accepted for existing checkouts.
Internal namespaces, local settings locations and executable asset filenames
retain their legacy names for compatibility. Both GitHub and Gitee repositories
now use `DeepFaceLab-WEBUI`; embedded manifest URLs and clone fallbacks use that name.

First-install state now lives under `<project>/.launcher-install`: `runtime`
holds prepared dependencies, `cloning-<id>` holds private clones, and `logs`
holds a full UTF-8 session log plus an errors-only log. A workspace marker allows
retries before `.git` exists. Clone publication preflights collisions, moves
`.git` last and rolls back moved entries if publication throws. Unrelated
destination files prevent publication. Logs are appended on every entry; the
UI buffer limit does not truncate disk logs. Before a project is selected,
logs use the legacy local application data directory and are copied on attach.

After successful bootstrap, `LauncherInstallation` copies the current executable
to `<project>/DeepFaceLab-WEBUI.exe`, verifies SHA-256, and starts it with a
one-time named-event handshake. Only after the installed host loads its UI does
the original host exit. The new process checks both hashes again before deleting
the exact original executable. Conflicts, failed startup, or changed files keep
the original. The release download asset still uses the legacy filename.

WebUI dependency validation loads `node-pty` through Node's module resolver and
resolves `esbuild` from Vite's package scope using `createRequire`. With pnpm,
esbuild is a transitive dependency and need not exist at the top level. Do not
gate installation on a fixed `@esbuild` or `node-pty/prebuilds` path. The probe
executes an esbuild transform and reports each failing module's full exception.

Dependency setup never assumes that the freshly cloned GitHub checkout already
contains launcher source files. A complete project bootstrap is preferred when
present; otherwise the host runs the integrity-checked bootstrap, manifest,
Python wheel lock, and helper scripts embedded in the EXE. Partially copied
project bootstrap files are never mixed with embedded files.

Build from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File launcher\build-host.ps1
```

The only release artifact is `launcher\bin\DeepFaceLabSN.Launcher.exe`. On
startup, the host verifies and atomically extracts its versioned payload under
`%LocalAppData%\DeepFaceLabSN\Launcher\payload-<build-id>`. A completion marker
and per-file SHA-256 checks prevent a partial or corrupted payload from being
used. No DLL, UI, or bootstrap sidecar is required next to the EXE.

Launcher binaries are Release assets and are intentionally excluded from the
repository root. Before WebView2 or the embedded UI starts, the native host
checks the small `launcher/update-channel.json` file from GitHub and Gitee in
parallel. A newer EXE may only come from trusted HTTPS hosts, must match both
the declared size and SHA-256, and is copied into place by the downloaded new
EXE after the old process exits. The previous EXE is kept until the replacement
has been verified and restarted; a failed replacement is rolled back. Project
source updates remain the separate, user-confirmed `git fetch` plus
`merge --ff-only` flow.

For a release, update `AssemblyInfo.cs`, build the EXE, then generate the pinned
channel metadata before committing and publishing the matching tag:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File launcher\new-update-channel.ps1 -Version 0.2.1 -GitHubOnly
```

Use `-GitHubOnly` when publishing only to GitHub; omit it only when the matching
asset will also be published on Gitee. Upload `launcher\bin\DeepFaceLabSN.Launcher.exe`
with the unchanged filename. The generated channel uses deterministic
`releases/download/<tag>/<asset>` URLs. Set `DFLSN_LAUNCHER_SKIP_UPDATE=1` only
for offline diagnostics; the one-shot replacement restart skips the check
automatically to prevent an update loop.

WebView2 is also bootstrapped without a sidecar. Before loading any WebView2
type, the EXE checks the official runtime registration. A missing runtime opens
a native WPF progress window, downloads only through Microsoft HTTPS hosts,
validates WinVerifyTrust and the Microsoft code-signing identity, runs the
Evergreen installer silently, confirms the installed version, and then
continues to verified payload extraction and WebView2 startup.

The host intentionally never runs `git reset`, `git clean`, or `git stash`.
Updates validate the fixed `origin` URL and `main` branch, fetch that branch,
and use `merge --ff-only`. During the migration that removes
`_internal/config.txt` from Git tracking, the local file is privately backed up
and restored whether the merge succeeds or fails. Terminal bridge tokens exist
only in memory and are never written to launcher settings.
The updater also rejects a fetched remote tree containing protected user-data
or project-local runtime paths before it attempts the fast-forward merge.

During first setup, project cloning and runtime installation run concurrently.
The Git worker performs one clone at a time, retries every 60 seconds while the
runtime bootstrap is active, and publishes only a fully verified private
staging clone. Attempts interleave GitHub's default/HTTP/1.1 transports with
the built-in `https://gitee.com/LeoSasion/DeepFaceLab-WEBUI.git` fallback. A
user-configured trusted HTTPS mirror can replace that fallback. Clone traffic
uses a shallow single-branch checkout and a low-speed timeout so a dead route
does not block the rest of the installer indefinitely.

Git proxy settings are launcher-local. Automatic mode reads environment and
Windows proxy settings; direct and manual modes are also available. Manual
proxy URLs may not contain credentials. The launcher does not modify system
proxy, DNS, hosts, TLS validation, or global Git configuration, and it never
selects an untrusted public accelerator by default.
