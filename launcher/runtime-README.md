# Launcher runtime bootstrap

`bootstrap.ps1` installs and repairs only project-local runtimes. It never installs
system software, changes machine/user-wide package sources, clones a repository,
or runs `git reset`, `git clean`, or similar source-overwrite operations.

Normal use from a cloned project:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File launcher\bootstrap.ps1 `
  -ProjectRoot C:\DeepFaceLabSN -Mirror auto
```

Repair revalidates each runtime and replaces only a missing or invalid component:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File launcher\bootstrap.ps1 `
  -ProjectRoot C:\DeepFaceLabSN -Mirror china -Repair
```

Before the repository exists, the native host extracts these embedded bootstrap
resources from the single EXE:

- `bootstrap.ps1`
- `runtime-artifacts.ps1`
- `python-wheelhouse.ps1`
- `runtime-manifest.json`
- `python-runtime/runtime-wheel-lock.json`
- `python-runtime/requirements-win-cp37.in`

These embedded resources are also the compatibility fallback for older GitHub
checkouts that contain `_internal` and `webui` but no `launcher` directory yet.
The host uses project-provided bootstrap files only when the complete resource
set is present; it never mixes a partial project copy with embedded resources.

It can then prepare only MinGit without creating a checkout:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File bootstrap\bootstrap.ps1 `
  -GitOnly `
  -ProjectRoot "$env:LOCALAPPDATA\DeepFaceLabSN\Launcher\bootstrap-tools" `
  -Mirror auto
```

This creates `bootstrap-tools\git\cmd\git.exe`.

## Runtime sources

MinGit and Node.js are pinned to immutable upstream archives. CUDA 11.8 is built
from nine individually pinned archives: eight official NVIDIA CUDA redistributable
components plus the zlib x64 package linked by NVIDIA's cuDNN 8.x Windows guide.
cuDNN 8.8 is fetched from NVIDIA's official redistributable service.

Only the exact twelve CUDA DLLs and seven cuDNN DLLs declared in the manifest are
copied into the runtime payload. Archive notices are retained below each runtime's
`_licenses` directory. Multi-archive assembly rejects duplicate target names,
missing selected files, unsafe ZIP entries, and final-validation failures. The
published runtime directory is replaced atomically and the previous directory is
restored if post-publish validation fails.

Python uses the official CPython 3.7.1 embeddable archive plus 98 exact,
SHA-256-pinned PyPI artifacts. China mode tries the Tsinghua PyPI mirror before
the official file host. After all downloads are verified, pip installs offline
with dependency resolution disabled. The staged runtime must pass version,
minimum-size, TensorFlow CUDA-build, and import checks before an atomic
same-volume publish; a previous valid runtime is restored on failure.
Existing validated Python runtimes are preserved.

## Machine-readable output

Standard output is JSON Lines. Every line contains `stage`, `id`, `status`,
`progress`, `downloaded`, `total`, and `message`. Detailed JSONL logs are retained
under `_internal\.launcher\logs` (normal mode) or `bootstrap-tools\logs`
(`-GitOnly`). Exit code `0` means every selected required component is ready;
exit code `1` means at least one component is unavailable or failed validation.

Downloads are pinned by SHA-256, resume through HTTP Range requests, and can fall
back to the Windows Background Intelligent Transfer Service. ZIP entries are
validated against traversal and link attacks before extraction. Installation uses
a same-volume staging directory, directory rename, final validation, and rollback.

## Python wheel-lock checklist

1. Keep every entry in `requirements-win-cp37.in` as an exact version pin.
2. Resolve only CPython 3.7 Windows x64 compatible artifacts.
3. Review upstream hosts, package licenses, filenames, and SHA-256 values.
4. Update `runtime-wheel-lock.json` and its hash in `runtime-manifest.json`.
5. Run parser, schema, Pester, offline clean-install, idempotency, corruption,
   and rollback checks.
6. Run a final GPU enumeration and WebUI smoke test on a clean NVIDIA Windows VM.

Node's version, archive, and SHA-256 intentionally match
`webui/scripts/install-node.ps1`.
