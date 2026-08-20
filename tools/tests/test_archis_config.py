import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
import uuid
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
ARCHIS_INIT = ROOT / "_internal" / "DeepFaceLab" / "core" / "leras" / "archis" / "__init__.py"


def load_archis():
    package_name = "_archis_config_test_" + uuid.uuid4().hex
    child_names = []

    for child_name, exports in {
        "ArchiBase": {"ARCHI_BASE_STUB": True},
        "DeepFakeArchi_old": {"SELECTED_ARCHI": "old"},
        "DeepFakeArchi_rg": {"SELECTED_ARCHI": "rg"},
    }.items():
        full_name = package_name + "." + child_name
        child_names.append(full_name)
        child = types.ModuleType(full_name)
        child.__all__ = list(exports)
        for name, value in exports.items():
            setattr(child, name, value)
        sys.modules[full_name] = child

    spec = importlib.util.spec_from_file_location(
        package_name,
        str(ARCHIS_INIT),
        submodule_search_locations=[str(ARCHIS_INIT.parent)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[package_name] = module
    try:
        spec.loader.exec_module(module)
        return module
    finally:
        sys.modules.pop(package_name, None)
        for child_name in child_names:
            sys.modules.pop(child_name, None)


class ArchisConfigTests(unittest.TestCase):
    def test_config_second_line_selects_rg_or_old(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "config.txt"
            default = Path(temp_dir) / "config.default.txt"
            default.write_text("2\n2\n", encoding="utf-8")

            for rg_value, expected in (("1", "rg"), ("2", "old")):
                config.write_text("2\n{}\n".format(rg_value), encoding="utf-8")
                with mock.patch.dict(
                    os.environ,
                    {
                        "DFL_CONFIG_FILE": str(config),
                        "DFL_CONFIG_DEFAULT_FILE": str(default),
                    },
                    clear=False,
                ):
                    os.environ.pop("DFL_RG_OPTIMIZATION", None)
                    self.assertEqual(load_archis().SELECTED_ARCHI, expected)

    def test_environment_override_wins(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "config.txt"
            config.write_text("2\n2\n", encoding="utf-8")
            with mock.patch.dict(
                os.environ,
                {
                    "DFL_CONFIG_FILE": str(config),
                    "DFL_RG_OPTIMIZATION": "1",
                },
                clear=False,
            ):
                self.assertEqual(load_archis().SELECTED_ARCHI, "rg")

    def test_missing_local_config_is_copied_once_from_default(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "config.txt"
            default = Path(temp_dir) / "config.default.txt"
            default.write_bytes(b"2\r\n1\r\n")
            with mock.patch.dict(
                os.environ,
                {
                    "DFL_CONFIG_FILE": str(config),
                    "DFL_CONFIG_DEFAULT_FILE": str(default),
                },
                clear=False,
            ):
                os.environ.pop("DFL_RG_OPTIMIZATION", None)
                self.assertEqual(load_archis().SELECTED_ARCHI, "rg")
            self.assertEqual(config.read_bytes(), default.read_bytes())


if __name__ == "__main__":
    unittest.main()
