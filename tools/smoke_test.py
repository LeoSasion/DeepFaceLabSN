#!/usr/bin/env python3
"""Read-only smoke tests for the packaged DeepFaceLabSN workspace."""

import ast
import json
import os
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DFL_ROOT = ROOT / "_internal" / "DeepFaceLab"
LEGACY_DIR = ROOT / "legacy-cli"
SNAPSHOT = ROOT / "docs" / "baseline" / "requirements-bundled-2026-07-29.txt"

failures = []


def passed(message):
    print("[PASS] " + message)


def failed(message):
    failures.append(message)
    print("[FAIL] " + message)


def read_legacy_text(path):
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "gbk", "cp1252"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("unknown", raw, 0, 1, "unsupported source encoding")


def normalize_package_name(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def check_required_paths():
    required = [
        ROOT / "_internal" / "python_common" / "python.exe",
        ROOT / "_internal" / "setenv.bat",
        DFL_ROOT / "main.py",
        DFL_ROOT / "models" / "Model_ME" / "Model.py",
        DFL_ROOT / "models" / "Model_Q384" / "Model.py",
        DFL_ROOT / "models" / "Model_Q512" / "Model.py",
        DFL_ROOT / "models" / "Model_XSeg" / "Model.py",
        ROOT / "启动 WebUI.bat",
        ROOT / "传统命令菜单.bat",
        LEGACY_DIR,
        LEGACY_DIR / "menu.bat",
        ROOT / "workspace" / "data_src",
        ROOT / "workspace" / "data_dst",
        ROOT / "workspace" / "model",
    ]
    missing = [str(path.relative_to(ROOT)) for path in required if not path.exists()]
    if missing:
        failed("Required paths missing: " + ", ".join(missing))
    else:
        passed("Required runtime, model, and workspace paths exist")


def check_python_sources():
    python_files = sorted(DFL_ROOT.rglob("*.py"))
    errors = []
    for path in python_files:
        try:
            compile(path.read_bytes(), str(path), "exec", ast.PyCF_ONLY_AST)
        except Exception as exc:
            errors.append("{}: {}: {}".format(path.relative_to(ROOT), type(exc).__name__, exc))
    if errors:
        failed("{} Python source files failed to compile".format(len(errors)))
        for error in errors:
            print("       " + error)
    else:
        passed("{} Python source files compile".format(len(python_files)))


def check_menu_references():
    reference_pattern = re.compile(
        r'^\s*attrib\s+[+-]h\s+"([^"]+\.bat)"',
        flags=re.IGNORECASE | re.MULTILINE,
    )
    missing = []
    for menu_path in sorted(LEGACY_DIR.glob("*.bat")):
        text = read_legacy_text(menu_path)
        for reference in reference_pattern.findall(text):
            if not (LEGACY_DIR / reference).is_file():
                missing.append("{} -> {}".format(menu_path.name, reference))
    if missing:
        failed("{} menu references point to missing batch files".format(len(missing)))
        for reference in missing:
            print("       " + reference)
    else:
        passed("All batch-menu references resolve to existing files")


def check_legacy_layout():
    root_batches = sorted(path.name for path in ROOT.glob("*.bat"))
    expected_root_batches = ["传统命令菜单.bat", "启动 WebUI.bat"]
    if root_batches != expected_root_batches:
        failed(
            "Root BAT launchers differ from the expected pair: "
            + ", ".join(root_batches)
        )
    else:
        passed("Root contains only the WebUI and legacy-menu BAT launchers")

    legacy_batches = sorted(LEGACY_DIR.glob("*.bat"))
    if not legacy_batches:
        failed("Legacy BAT directory is empty")
        return

    stale_calls = []
    expected_call = re.compile(
        r'^\s*call\s+"%~dp0\.\.\\_internal\\setenv(?:_old)?\.bat"\s*$',
        flags=re.IGNORECASE | re.MULTILINE,
    )
    raw_call = re.compile(
        r"^\s*call\s+.*setenv(?:_old)?\.bat.*$",
        flags=re.IGNORECASE | re.MULTILINE,
    )
    for path in legacy_batches:
        text = read_legacy_text(path)
        for call in raw_call.findall(text):
            if expected_call.fullmatch(call):
                continue
            stale_calls.append("{} -> {}".format(path.name, call.strip()))

    if stale_calls:
        failed("{} legacy BAT environment calls use stale paths".format(len(stale_calls)))
        for call in stale_calls:
            print("       " + call)
    else:
        passed("Legacy BAT environment calls are location-independent")

    router_text = read_legacy_text(LEGACY_DIR / "menu.bat").lower()
    required_router_tokens = [
        token
        for token in (
            "choice /c",
            'call "%target_path%"',
            "dir /b /a:-d",
            "--check",
        )
        if token not in router_text
    ]
    if required_router_tokens or "set /p" in router_text:
        failed(
            "Legacy CLI router is missing safe-routing primitives: "
            + ", ".join(required_router_tokens or ["unexpected set /p"])
        )
    else:
        passed("Legacy CLI router uses enumerated single-key command routing")

    init_batches = [path for path in legacy_batches if "初始化" in path.name]
    if len(init_batches) != 1:
        failed("Expected one legacy menu initialization BAT")
    else:
        init_text = read_legacy_text(init_batches[0]).lower()
        forbidden_side_effects = [
            token
            for token in ("reg add", "taskkill", "explorer.exe", "hkey_")
            if token in init_text
        ]
        if forbidden_side_effects:
            failed(
                "Legacy menu initialization still changes global Windows state: "
                + ", ".join(forbidden_side_effects)
            )
        else:
            passed("Legacy menu initialization only manages local menu visibility")


def check_legacy_launcher():
    launcher = ROOT / "传统命令菜单.bat"

    dry_env = os.environ.copy()
    dry_env["DFL_LEGACY_MENU_DRY_RUN"] = "1"
    dry_result = subprocess.run(
        [dry_env.get("COMSPEC", "cmd.exe"), "/d", "/c", str(launcher)],
        cwd=str(ROOT),
        env=dry_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    dry_output = dry_result.stdout.decode("utf-8", errors="replace")
    if dry_result.returncode == 0 and "[OK]" in dry_output:
        passed("Legacy-menu launcher resolves its relocated directory")
    else:
        failed(
            "Legacy-menu launcher dry run failed: "
            + dry_output.strip().replace("\n", " ")
        )

    check_env = os.environ.copy()
    check_env.pop("DFL_LEGACY_MENU_DRY_RUN", None)
    check_result = subprocess.run(
        [
            check_env.get("COMSPEC", "cmd.exe"),
            "/d",
            "/c",
            str(launcher),
            "--check",
        ],
        cwd=str(ROOT),
        env=check_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    check_output = check_result.stdout.decode("utf-8", errors="replace")
    if (
        check_result.returncode == 0
        and "CLI 路由器" in check_output
        and "8 个分类" in check_output
    ):
        passed("Legacy CLI router enumerates all command categories")
    else:
        failed(
            "Legacy CLI router self-check failed: "
            + check_output.strip().replace("\n", " ")
        )


def check_saehd_paths():
    candidates = [
        path
        for path in LEGACY_DIR.glob("*.bat")
        if "train SAEHD.bat" in path.name and "Recent" not in path.name
    ]
    if len(candidates) != 1:
        failed("Expected one standard SAEHD training batch file, found {}".format(len(candidates)))
        return
    text = read_legacy_text(candidates[0])
    expected_src = '--training-data-src-dir "%WORKSPACE%\\data_src\\aligned"'
    expected_dst = '--training-data-dst-dir "%WORKSPACE%\\data_dst\\aligned"'
    if expected_src in text and expected_dst in text:
        passed("SAEHD uses data_src for SRC and data_dst for DST")
    else:
        failed("SAEHD SRC/DST training paths are not the expected pair")


def read_snapshot():
    packages = {}
    for raw_line in SNAPSHOT.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "==" not in line:
            failed("Unsupported dependency snapshot line: " + line)
            continue
        name, version = line.split("==", 1)
        packages[normalize_package_name(name)] = version
    return packages


def check_dependency_snapshot():
    if not SNAPSHOT.is_file():
        failed("Dependency snapshot is missing")
        return
    command = [sys.executable, "-m", "pip", "list", "--format=json"]
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        universal_newlines=True,
    )
    if result.returncode != 0:
        failed("Unable to inspect bundled packages: " + result.stdout.strip())
        return
    installed = {
        normalize_package_name(item["name"]): item["version"]
        for item in json.loads(result.stdout)
    }
    expected = read_snapshot()
    missing = sorted(set(expected) - set(installed))
    extra = sorted(set(installed) - set(expected))
    changed = sorted(
        name for name in set(expected) & set(installed) if expected[name] != installed[name]
    )
    if missing or extra or changed:
        failed(
            "Dependency snapshot drift: {} missing, {} extra, {} version changes".format(
                len(missing), len(extra), len(changed)
            )
        )
        for name in missing:
            print("       missing: {}=={}".format(name, expected[name]))
        for name in extra:
            print("       extra: {}=={}".format(name, installed[name]))
        for name in changed:
            print(
                "       changed: {} expected {}, installed {}".format(
                    name, expected[name], installed[name]
                )
            )
    else:
        passed("{} installed package versions match the snapshot".format(len(expected)))


def check_pip_health():
    result = subprocess.run(
        [sys.executable, "-m", "pip", "check"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        universal_newlines=True,
    )
    if result.returncode == 0:
        passed("pip reports no broken requirements")
    else:
        failed("pip check failed: " + result.stdout.strip())


def main():
    print("DeepFaceLabSN smoke test")
    print("Repository: " + str(ROOT))
    print("Python: " + sys.version.replace("\n", " "))
    print()

    check_required_paths()
    check_python_sources()
    check_legacy_layout()
    check_legacy_launcher()
    check_menu_references()
    check_saehd_paths()
    check_dependency_snapshot()
    check_pip_health()

    print()
    if failures:
        print("RESULT: FAIL ({} checks failed)".format(len(failures)))
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
