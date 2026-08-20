import os
from pathlib import Path

from .ArchiBase import *


_RG_ENV_VAR = "DFL_RG_OPTIMIZATION"
_CONFIG_ENV_VAR = "DFL_CONFIG_FILE"
_DEFAULT_CONFIG_ENV_VAR = "DFL_CONFIG_DEFAULT_FILE"


def _internal_dir():
    return Path(__file__).resolve().parents[4]


def _config_paths():
    internal_dir = _internal_dir()
    config_path = Path(os.environ.get(_CONFIG_ENV_VAR, "").strip() or internal_dir / "config.txt")
    default_path = Path(
        os.environ.get(_DEFAULT_CONFIG_ENV_VAR, "").strip()
        or internal_dir / "config.default.txt"
    )
    return config_path, default_path


def _ensure_local_config():
    """Create the ignored local config once without overwriting user choices."""
    config_path, default_path = _config_paths()
    if config_path.exists() or not default_path.is_file():
        return config_path

    try:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        with default_path.open("rb") as source, config_path.open("xb") as destination:
            destination.write(source.read())
    except FileExistsError:
        # Another process won the first-run race.
        pass
    except OSError:
        # Read-only installations can still use config.default.txt below.
        pass

    return config_path


def _parse_rg_value(value, config_style=False):
    normalized = value.strip().lower()
    if normalized in {"true", "yes", "on", "enable", "enabled", "rg"}:
        return True
    if normalized in {"false", "no", "off", "disable", "disabled", "old"}:
        return False
    if config_style:
        if normalized == "1":
            return True
        if normalized == "2":
            return False
    else:
        if normalized == "1":
            return True
        if normalized in {"0", "2"}:
            return False
    return None


def _rg_optimization_enabled():
    env_value = os.environ.get(_RG_ENV_VAR)
    if env_value is not None:
        parsed = _parse_rg_value(env_value)
        if parsed is not None:
            return parsed

    config_path = _ensure_local_config()
    _, default_path = _config_paths()
    source_path = config_path if config_path.is_file() else default_path

    try:
        values = [line.strip() for line in source_path.read_text(encoding="utf-8-sig").splitlines()]
    except OSError:
        return False

    if len(values) < 2:
        return False

    parsed = _parse_rg_value(values[1], config_style=True)
    return parsed if parsed is not None else False


if _rg_optimization_enabled():
    from .DeepFakeArchi_rg import *
else:
    from .DeepFakeArchi_old import *
