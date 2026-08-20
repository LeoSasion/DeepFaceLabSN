# DeepFaceLabSN Python runtime

The active clean-machine installer is a reproducible CPython 3.7 wheelhouse. It
does not download one opaque project-owned Python ZIP and it does not resolve
floating dependencies at first launch.

The launcher installs:

- the official CPython 3.7.1 Windows x64 embeddable archive;
- 97 exact wheels from PyPI-compatible HTTPS endpoints;
- one verified source distribution, `future==0.18.3`, built locally into a
  wheel without network access;
- `tensorflow-gpu==2.10.1` for CPython 3.7 / Windows x64.

Every archive name, version, URL, and SHA-256 is recorded in
`runtime-wheel-lock.json`. The launcher verifies that lock against
`launcher/runtime-manifest.json` before using it.

## Installation behavior

`launcher/bootstrap.ps1` downloads into
`_internal/installers/python-wheelhouse-<version>`. China mode tries the
Tsinghua PyPI mirror first and then the official PyPI file host. The CPython
base always comes from python.org. A cached file is reused only after its
pinned SHA-256 passes.

Installation itself is offline: pip is run with `--no-index --no-deps`, user
site packages and global pip configuration are disabled, and temporary paths
are private to the current operation. Wheel and source archive paths are
validated before extraction. The installer also rejects project locations too
deep for the legacy Windows path limit and asks the user to move the project
to a short path such as `D:\DeepFaceLabSN`.

The runtime is built in a short same-volume staging directory. It must pass all
of these checks before publication:

- CPython reports exactly 3.7.1;
- the installed distribution is `tensorflow-gpu==2.10.1`;
- TensorFlow reports a CUDA-enabled build;
- TensorFlow, OpenCV, NumPy, SciPy, PyQt5, ONNX, tf2onnx, pywin32, and future
  import successfully;
- all manifest file and minimum-size rules pass.

The staged directory is then renamed into `_internal/python_common`. If final
validation fails, the previous runtime is restored. A valid existing runtime
is preserved and later runs only validate it.

## Refreshing the lock

1. Edit `requirements-win-cp37.in`; every line must remain an exact
   `name==version` pin.
2. Run `launcher/resolve-python-wheels.ps1` on a trusted Windows machine.
3. Review the selected filenames, hosts, sizes, licenses, and hashes.
4. Update `runtime-wheel-lock.json`, then update its SHA-256 in
   `launcher/runtime-manifest.json`.
5. Run the Windows PowerShell tests and a real `-NoNetwork` clean-install
   fixture after the cache has been populated.
6. On a clean NVIDIA Windows VM, verify
   `tf.config.list_physical_devices('GPU')`, start WebUI, and run one legacy
   CLI command.

Python 3.7 is retained only because the existing DeepFaceLab stack requires its
ABI. Do not loosen the pins or substitute current packages without a separate
runtime migration.

## Legacy prefix archive tool

`build-python-runtime.ps1` and `runtime-lock.json` remain available to
inventory or archive a known-good private prefix. They are not the active
first-run distribution path and no owner-hosted Python archive is required by
the current launcher.
