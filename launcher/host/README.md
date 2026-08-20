# Native launcher host

This directory contains the C# 5 / .NET Framework 4.8 WPF host for the
DeepFaceLabSN single-file launcher. It embeds the production launcher UI,
`bootstrap.ps1`, `runtime-artifacts.ps1`, `python-wheelhouse.ps1`, the
runtime manifest, pinned Python lock and requirements, WebView2 managed
assemblies, the x64 `WebView2Loader.dll`, and the official brand icon into the
generated EXE.

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
the built-in `https://gitee.com/LeoSasion/DeepFaceLabSN.git` fallback. A
user-configured trusted HTTPS mirror can replace that fallback. Clone traffic
uses a shallow single-branch checkout and a low-speed timeout so a dead route
does not block the rest of the installer indefinitely.

Git proxy settings are launcher-local. Automatic mode reads environment and
Windows proxy settings; direct and manual modes are also available. Manual
proxy URLs may not contain credentials. The launcher does not modify system
proxy, DNS, hosts, TLS validation, or global Git configuration, and it never
selects an untrusted public accelerator by default.
