import json
import os
import re
import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

from pose_probe_contract import fingerprint_probe_directory


MANIFEST_ID = re.compile(r"^[a-f0-9]{24}$")
MODEL_KEY = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
SAMPLE_ID = re.compile(r"^(src|dst)-p-?\d+-y-?\d+-\d{2}$")
IMAGE_NAME = re.compile(r'^[^<>:"/\\|?*\x00-\x1f]{1,220}\.(?:jpe?g|png)$', re.IGNORECASE)
VARIANTS = {
    "input",
    "reconstruction",
    "swap",
    "target-mask",
    "predicted-mask",
}
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_SAMPLES = 360
MAX_ONLINE_SNAPSHOTS = 12
METRIC_SCHEMA_VERSION = 1


def _within(parent, candidate, label):
    parent = Path(parent).resolve()
    candidate = Path(candidate).resolve()
    if candidate != parent and parent not in candidate.parents:
        raise ValueError(f"{label} exceeds the allowed directory")
    return candidate


def _json_safe(value):
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float) and not np.isfinite(value):
        return None
    return value


def load_evaluation_manifest(manifest_path, evaluation_root, model_key, dataset_directories):
    if not MODEL_KEY.fullmatch(model_key):
        raise ValueError("evaluation model key is invalid")
    root = Path(evaluation_root).resolve()
    manifest_path = _within(root, manifest_path, "evaluation manifest")
    if manifest_path.parent != root / "manifests" or not MANIFEST_ID.fullmatch(manifest_path.stem):
        raise ValueError("evaluation manifest path is not canonical")
    if manifest_path.stat().st_size > MAX_JSON_BYTES:
        raise ValueError("evaluation manifest exceeds 4 MiB")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("manifestId") != manifest_path.stem
        or manifest.get("modelKey") != model_key
        or manifest.get("modelClass") != "SAEHD"
    ):
        raise ValueError("evaluation manifest identity is invalid")

    samples = manifest.get("samples")
    datasets = manifest.get("datasets")
    if not isinstance(samples, list) or len(samples) > MAX_SAMPLES or not isinstance(datasets, dict):
        raise ValueError("evaluation manifest samples are invalid")

    file_digests = {}
    for side in ("src", "dst"):
        directory = Path(dataset_directories[side]).resolve()
        fingerprint, digests = fingerprint_probe_directory(directory)
        dataset = datasets.get(side, {})
        if fingerprint != dataset.get("fingerprint"):
            raise ValueError(f"{side.upper()} dataset changed after the evaluation manifest was created")
        file_digests[side] = digests

    result = {"src": [], "dst": []}
    seen_ids = set()
    for sample in samples:
        side = sample.get("side")
        sample_id = sample.get("id")
        name = sample.get("name")
        digest_prefix = sample.get("sha256Prefix")
        if (
            side not in result
            or not isinstance(sample_id, str)
            or not SAMPLE_ID.fullmatch(sample_id)
            or sample_id in seen_ids
            or not isinstance(name, str)
            or not IMAGE_NAME.fullmatch(name)
            or Path(name).name != name
            or not isinstance(digest_prefix, str)
            or not re.fullmatch(r"[a-f0-9]{16}", digest_prefix)
            or not file_digests[side].get(name, "").startswith(digest_prefix)
        ):
            raise ValueError("evaluation manifest contains an invalid sample")
        seen_ids.add(sample_id)
        result[side].append({**sample, "path": Path(dataset_directories[side]).resolve() / name})

    if any(len(result[side]) != datasets.get(side, {}).get("sampleCount") for side in result):
        raise ValueError("evaluation manifest sample counts do not match")
    if not result["src"] or not result["dst"]:
        raise ValueError("evaluation requires at least one SRC and one DST probe")
    return manifest, result


def _masked_mse(target, prediction, mask):
    mask = np.clip(mask.astype(np.float32), 0.0, 1.0)
    if mask.ndim == 2:
        mask = mask[..., None]
    denominator = float(mask.sum()) * target.shape[-1]
    if denominator <= 1e-6:
        return None
    return float((np.square(target - prediction) * mask).sum() / denominator)


def _mask_dice(target, prediction):
    target = np.clip(target.astype(np.float32), 0.0, 1.0)
    prediction = np.clip(prediction.astype(np.float32), 0.0, 1.0)
    denominator = float(target.sum() + prediction.sum())
    if denominator <= 1e-6:
        return None
    return float((2.0 * (target * prediction).sum() + 1e-6) / (denominator + 1e-6))


def _sharpness(image):
    gray = cv2.cvtColor(np.clip(image * 255.0, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def reconstruction_metrics(target, reconstruction, full_mask, eyes_mouth_mask, predicted_mask=None):
    input_sharpness = _sharpness(target)
    output = {
        "maskedMse": _masked_mse(target, reconstruction, full_mask),
        "eyesMouthMse": _masked_mse(target, reconstruction, eyes_mouth_mask),
        "sharpnessRatio": float(_sharpness(reconstruction) / max(input_sharpness, 1e-6)),
    }
    if predicted_mask is not None:
        output["maskDice"] = _mask_dice(full_mask, predicted_mask)
    return output


def swap_metrics(target, swap, full_mask, predicted_mask):
    return {
        "maskDice": _mask_dice(full_mask, predicted_mask),
        "sharpnessRatio": float(_sharpness(swap) / max(_sharpness(target), 1e-6)),
    }


class AtomicEvaluationSnapshot:
    def __init__(self, evaluation_root, model_key, manifest_id, iteration, model_signature):
        if not MODEL_KEY.fullmatch(model_key) or not MANIFEST_ID.fullmatch(manifest_id):
            raise ValueError("evaluation snapshot identity is invalid")
        if not isinstance(iteration, int) or iteration < 0:
            raise ValueError("evaluation iteration is invalid")
        self.root = Path(evaluation_root).resolve()
        self.snapshots_root = _within(self.root, self.root / "snapshots", "evaluation snapshots")
        self.snapshots_root.mkdir(parents=True, exist_ok=True)
        online_count = sum(
            1
            for entry in self.snapshots_root.iterdir()
            if entry.is_dir() and re.fullmatch(r"iter-\d{8,12}-[a-f0-9]{8,32}", entry.name)
        )
        if online_count >= MAX_ONLINE_SNAPSHOTS:
            raise ValueError("evaluation snapshot limit reached; archive an older snapshot first")
        self.model_key = model_key
        self.manifest_id = manifest_id
        self.iteration = iteration
        self.model_signature = model_signature
        self.snapshot_id = f"iter-{iteration:08d}-{secrets.token_hex(4)}"
        self.pending = _within(
            self.snapshots_root,
            self.snapshots_root / f"_pending-{self.snapshot_id}",
            "pending evaluation snapshot",
        )
        self.final = _within(
            self.snapshots_root,
            self.snapshots_root / self.snapshot_id,
            "evaluation snapshot",
        )
        if self.pending.exists() or self.final.exists():
            raise ValueError("evaluation snapshot ID collision")
        self.pending.mkdir(parents=False)
        self.samples = []

    def _write_image(self, target, image):
        image = np.clip(image, 0.0, 1.0)
        if image.ndim == 2:
            image = image[..., None]
        if image.shape[-1] == 1:
            image = np.repeat(image, 3, axis=-1)
        success, encoded = cv2.imencode(
            ".webp",
            (image * 255.0).round().astype(np.uint8),
            [cv2.IMWRITE_WEBP_QUALITY, 100],
        )
        if not success or encoded.nbytes > MAX_IMAGE_BYTES:
            raise ValueError("evaluation image encoding failed or exceeded 16 MiB")
        temporary = target.with_suffix(target.suffix + ".tmp")
        encoded.tofile(str(temporary))
        os.replace(str(temporary), str(target))

    def add_sample(self, sample, variants, metrics):
        if len(self.samples) >= MAX_SAMPLES or not SAMPLE_ID.fullmatch(sample["id"]):
            raise ValueError("evaluation snapshot has too many or invalid samples")
        unknown_variants = set(variants) - VARIANTS
        if unknown_variants:
            raise ValueError("evaluation snapshot variant is invalid")
        sample_directory = _within(
            self.pending,
            self.pending / "samples" / sample["id"],
            "evaluation sample",
        )
        sample_directory.mkdir(parents=True, exist_ok=False)
        for variant, image in variants.items():
            self._write_image(sample_directory / f"{variant}.webp", image)
        self.samples.append({
            "id": sample["id"],
            "side": sample["side"],
            "cellId": sample["cellId"],
            "yaw": sample["yaw"],
            "pitch": sample["pitch"],
            "metrics": _json_safe(metrics),
            "variants": sorted(variants),
        })

    def publish(self):
        summary = {
            "schemaVersion": 1,
            "snapshotId": self.snapshot_id,
            "modelKey": self.model_key,
            "manifestId": self.manifest_id,
            "iteration": self.iteration,
            "metricSchemaVersion": METRIC_SCHEMA_VERSION,
            "modelSignature": self.model_signature,
            "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "samples": self.samples,
        }
        encoded = (json.dumps(summary, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        if len(encoded) > MAX_JSON_BYTES:
            raise ValueError("evaluation summary exceeds 4 MiB")
        temporary = self.pending / "summary.json.tmp"
        temporary.write_bytes(encoded)
        os.replace(str(temporary), str(self.pending / "summary.json"))
        os.replace(str(self.pending), str(self.final))
        return summary

    def abort(self):
        if self.pending.exists():
            shutil.rmtree(self.pending)
