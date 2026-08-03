import argparse
import copy
import faulthandler
import hashlib
import json
import multiprocessing
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository-root", type=Path, required=True)
    parser.add_argument("--gpu-index", type=int, default=0)
    return parser.parse_args()


def build_probe(helper, directory, side, cwd):
    result = subprocess.run(
        [
            sys.executable,
            str(helper),
            "probe-manifest",
            "--directory",
            str(directory),
            "--side",
            side,
        ],
        cwd=str(cwd),
        env=os.environ.copy(),
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return json.loads(result.stdout)


def hash_weights(model):
    digest = hashlib.sha256()
    seen = set()
    for saveable, _ in model.get_model_filename_list():
        for weight, value in zip(saveable.get_weights(), saveable.get_weights_np()):
            if weight.name in seen:
                continue
            seen.add(weight.name)
            value = np.ascontiguousarray(value)
            digest.update(weight.name.encode("utf-8"))
            digest.update(str(value.dtype).encode("ascii"))
            digest.update(str(value.shape).encode("ascii"))
            digest.update(value.tobytes())
    return digest.hexdigest(), len(seen)


def hash_files(directory):
    result = {}
    for target in sorted(path for path in directory.rglob("*") if path.is_file()):
        result[str(target.relative_to(directory))] = hashlib.sha256(target.read_bytes()).hexdigest()
    return result


def main():
    faulthandler.enable()
    faulthandler.dump_traceback_later(120, repeat=True)
    args = parse_args()
    repository_root = args.repository_root.resolve()
    workspace = repository_root / "workspace"
    internal_root = repository_root / "_internal"
    legacy_root = repository_root / "_internal" / "DeepFaceLab_old"
    helper = repository_root / "webui" / "python" / "dfl_asset_tool.py"
    src_directory = workspace / "data_src" / "aligned"
    dst_directory = workspace / "data_dst" / "aligned"
    model_name = "codex-eval-smoke-64"
    model_key = "codex-eval-smoke-64-saehd-4f726a2f1234"

    local_profile = internal_root / "_e" / "u"
    local_app_data = local_profile / "AppData" / "Local"
    roaming_app_data = local_profile / "AppData" / "Roaming"
    temporary_data = internal_root / "_e" / "t"
    for directory in (local_app_data, roaming_app_data, temporary_data):
        directory.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "TMP": str(temporary_data),
        "TEMP": str(temporary_data),
        "USERPROFILE": str(local_profile),
        "HOMEPATH": str(local_profile),
        "LOCALAPPDATA": str(local_app_data),
        "APPDATA": str(roaming_app_data),
        "WORKSPACE": str(workspace),
    })
    runtime_paths = [
        internal_root / "python_common",
        internal_root / "python_common" / "Scripts",
        internal_root / "CUDA",
        internal_root / "CUDNN",
        internal_root / "CUDNN" / "Win6.x",
    ]
    os.environ["PATH"] = os.pathsep.join(
        [str(path) for path in runtime_paths] + [os.environ.get("PATH", "")]
    )

    with tempfile.TemporaryDirectory(prefix="dfl-saehd-evaluation-") as temporary:
        temporary_root = Path(temporary)
        model_directory = temporary_root / "model"
        evaluation_root = temporary_root / "evaluation" / model_key
        manifests_directory = evaluation_root / "manifests"
        model_directory.mkdir(parents=True)
        manifests_directory.mkdir(parents=True)

        print("[smoke] building deterministic probes", flush=True)
        src_probe = build_probe(helper, src_directory, "src", repository_root / "_internal" / "DeepFaceLab")
        dst_probe = build_probe(helper, dst_directory, "dst", repository_root / "_internal" / "DeepFaceLab")
        manifest_content = {
            "schemaVersion": 1,
            "modelKey": model_key,
            "modelName": model_name,
            "modelClass": "SAEHD",
            "poseBins": {"yaw": src_probe["yawTicks"], "pitch": src_probe["pitchTicks"]},
            "datasets": {
                "src": {
                    "fingerprint": src_probe["datasetFingerprint"],
                    "sampleCount": src_probe["sampleCount"],
                },
                "dst": {
                    "fingerprint": dst_probe["datasetFingerprint"],
                    "sampleCount": dst_probe["sampleCount"],
                },
            },
            "samples": src_probe["samples"] + dst_probe["samples"],
        }
        manifest_id = hashlib.sha256(
            json.dumps(manifest_content, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()[:24]
        manifest = {
            **manifest_content,
            "manifestId": manifest_id,
            "createdAt": "2026-08-03T00:00:00.000Z",
        }
        manifest_path = manifests_directory / f"{manifest_id}.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        os.environ["DFL_WEB_EVAL_MANIFEST"] = str(manifest_path)
        os.environ["DFL_WEB_EVAL_ROOT"] = str(evaluation_root)
        os.environ["DFL_WEB_EVAL_MODEL_KEY"] = model_key
        sys.path.insert(0, str(legacy_root))

        from core.interact import interact as io
        from core.leras import nn
        import models

        print("[smoke] initializing DFL GPU environment", flush=True)
        nn.initialize_main_env()

        def input_int(prompt, default_value, *_args, **_kwargs):
            values = {
                "分辨率 resolution": 64,
                "自动编码器大小 AutoEncoder dimensions": 32,
                "编码器大小 Encoder dimensions": 16,
                "解码器大小 Decoder dimensions": 16,
                "遮罩解码器大小 Decoder mask dimensions": 6,
                "批量大小": 1,
                "目标迭代次数": 0,
            }
            return values.get(prompt, default_value)

        def input_str(prompt, default_value=None, *_args, **_kwargs):
            if "face_type" in prompt:
                return "wf"
            if "AE architecture" in prompt:
                return "df-d"
            if "learning rate dropout" in prompt:
                return "n"
            if "Color transfer" in prompt:
                return "none"
            return default_value

        io.input_int = input_int
        io.input_str = input_str
        io.input_bool = lambda _prompt, default_value, *_args, **_kwargs: False
        io.input_number = lambda _prompt, default_value, *_args, **_kwargs: default_value
        io.input_in_time = lambda *_args, **_kwargs: False
        io.input_skip_pending = lambda: None
        multiprocessing.cpu_count = lambda: 2

        model = None
        try:
            print("[smoke] initializing 64px SAEHD", flush=True)
            model = models.import_model("SAEHD")(
                is_training=True,
                saved_models_path=model_directory,
                training_data_src_path=src_directory,
                training_data_dst_path=dst_directory,
                pretraining_data_path=workspace / "pretrain_faces",
                pretrained_model_path=None,
                no_preview=True,
                force_model_name=model_name,
                force_gpu_idxs=[args.gpu_index],
                cpu_only=False,
                silent_start=True,
                debug=False,
            )
            print("[smoke] running one training iteration", flush=True)
            trained_iteration, _ = model.train_one_iter()
            model.save()

            iteration_before = model.get_iter()
            losses_before = copy.deepcopy(model.get_loss_history())
            weight_hash_before, weight_count = hash_weights(model)
            model_files_before = hash_files(model_directory)
            datasets_before = {
                "src": hash_files(src_directory),
                "dst": hash_files(dst_directory),
            }

            print("[smoke] running read-only evaluation", flush=True)
            summary = model.evaluate_pose_probes()

            weight_hash_after, _ = hash_weights(model)
            result = {
                "resolution": int(model.resolution),
                "batchSize": int(model.get_batch_size()),
                "trainedIteration": int(trained_iteration),
                "snapshotId": summary["snapshotId"],
                "snapshotSamples": int(len(summary["samples"])),
                "weightCount": int(weight_count),
                "weightsUnchanged": weight_hash_before == weight_hash_after,
                "iterationUnchanged": iteration_before == model.get_iter(),
                "lossHistoryUnchanged": all(
                    np.array_equal(before, after)
                    for before, after in zip(losses_before, model.get_loss_history())
                ) and len(losses_before) == len(model.get_loss_history()),
                "modelFilesUnchanged": model_files_before == hash_files(model_directory),
                "datasetsUnchanged": datasets_before == {
                    "src": hash_files(src_directory),
                    "dst": hash_files(dst_directory),
                },
                "snapshotPublished": (
                    evaluation_root / "snapshots" / summary["snapshotId"] / "summary.json"
                ).is_file(),
                "pendingVisible": any(
                    path.name.startswith("_pending-")
                    for path in (evaluation_root / "snapshots").iterdir()
                ),
            }
            print("DFL_EVALUATION_SMOKE_RESULT=" + json.dumps(result, sort_keys=True))
            if not all([
                result["weightsUnchanged"],
                result["iterationUnchanged"],
                result["lossHistoryUnchanged"],
                result["modelFilesUnchanged"],
                result["datasetsUnchanged"],
                result["snapshotPublished"],
                not result["pendingVisible"],
            ]):
                raise AssertionError("SAEHD evaluation smoke invariants failed")
        finally:
            if model is not None:
                model.finalize()
            elif getattr(nn, "tf_sess", None) is not None:
                nn.close_session()


if __name__ == "__main__":
    main()
