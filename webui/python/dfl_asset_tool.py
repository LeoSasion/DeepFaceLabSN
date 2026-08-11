import argparse
import base64
import hashlib
import json
import math
import os
import pickletools
import re
import shutil
import struct
import sys
import tempfile
import zipfile
from collections import Counter
from pathlib import Path
from statistics import median

import cv2
import numpy as np

DFL_ROOT = Path(
    os.environ.get(
        "DFL_ROOT",
        Path(__file__).resolve().parents[2] / "_internal" / "DeepFaceLab",
    )
)
sys.path.insert(0, str(DFL_ROOT))

from core.imagelib import SegIEPolyType, SegIEPolys
from DFLIMG import DFLIMG
from facelib import FaceType, LandmarksProcessor
from pose_bins import PITCH_TICKS, YAW_TICKS, nearest_tick, pose_cell_id
from pose_probe_contract import fingerprint_probe_directory


LOW_QUALITY_THRESHOLD = 0.24
QUALITY_BANDS = (0.2, 0.4, 0.6, 0.8)
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}
AUDIT_SCHEMA_VERSION = 2
MAX_AUDIT_ITEMS = 500
MIN_XSEG_AUDIT_PIXELS = 64
MAX_PACK_CONFIG_BYTES = 64 * 1024 * 1024
MAX_PICKLE_OPS = 2_000_000
PICKLE_MARK = object()
PROBE_SCHEMA_VERSION = 1
MAX_PROBE_SAMPLES_PER_SIDE = 180
MAX_PROBE_SAMPLES_PER_CELL = 3
MAX_SIMILARITY_ITEMS = 500
QUARANTINE_TOKEN_PATTERN = re.compile(r"^\d{14}-[a-f0-9]{10}$")


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False))


def load_dfl_image(image_path):
    dfl_image = DFLIMG.load(image_path)
    if dfl_image is None or not dfl_image.has_data():
        raise ValueError("文件不是有效的 DFL aligned JPG")
    return dfl_image


def serialize_polygons(dfl_image):
    return [
        {
            "type": "include" if int(poly.get_type()) == int(SegIEPolyType.INCLUDE) else "exclude",
            "points": [[float(x), float(y)] for x, y in poly.get_pts()],
        }
        for poly in dfl_image.get_seg_ie_polys().get_polys()
    ]


def serialize_finite_points(points, expected_length=None):
    """Return finite 2D points without letting one malformed metadata field break inspection."""
    try:
        values = np.asarray(points, dtype=np.float32)
    except (TypeError, ValueError):
        return []
    if values.ndim != 2 or values.shape[1] != 2:
        return []
    if expected_length is not None and values.shape[0] != expected_length:
        return []
    if not np.isfinite(values).all():
        return []
    return [[float(x), float(y)] for x, y in values]


def inspect_dfl_geometry(dfl_image):
    try:
        raw_landmarks = dfl_image.get_landmarks()
    except (AttributeError, KeyError, TypeError, ValueError):
        raw_landmarks = None
    landmarks = serialize_finite_points(raw_landmarks, expected_length=68)
    source_rect = None
    source_rect_aligned = None
    try:
        rect = np.asarray(dfl_image.get_source_rect(), dtype=np.float32).reshape(-1)
        if rect.shape == (4,) and np.isfinite(rect).all():
            source_rect = [float(value) for value in rect]
            matrix = np.asarray(dfl_image.get_image_to_face_mat(), dtype=np.float32)
            if matrix.shape == (2, 3) and np.isfinite(matrix).all():
                x0, y0, x1, y1 = rect
                corners = np.asarray(
                    [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                    dtype=np.float32,
                )
                source_rect_aligned = serialize_finite_points(
                    cv2.transform(corners[None, ...], matrix)[0],
                    expected_length=4,
                ) or None
    except (AttributeError, KeyError, TypeError, ValueError, cv2.error):
        source_rect = None
        source_rect_aligned = None
    try:
        face_type = dfl_image.get_face_type()
    except (AttributeError, KeyError, TypeError, ValueError):
        face_type = None
    return {
        "faceType": str(face_type) if face_type is not None else None,
        "landmarks": landmarks,
        "sourceRect": source_rect,
        "sourceRectAligned": source_rect_aligned,
    }


def image_quality(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    laplacian_variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    sharpness = laplacian_variance / (laplacian_variance + 500.0)
    return min(max(sharpness, 0.0), 1.0), float(gray.mean() / 255.0)


def quality_band(score):
    for index, upper in enumerate(QUALITY_BANDS):
        if score < upper:
            return index
    return len(QUALITY_BANDS)


def iter_images(directory):
    return sorted(
        path
        for path in directory.iterdir()
        if (
            not path.is_symlink()
            and path.is_file()
            and path.suffix.lower() in IMAGE_EXTENSIONS
        )
    )


def file_digest_prefix(target, length=16):
    digest = hashlib.sha256()
    with target.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()[:length]


def safe_pickle_list_length(data):
    """Count a protocol-4 top-level list without executing pickle callables."""
    if len(data) > MAX_PACK_CONFIG_BYTES:
        raise ValueError("metadata_too_large")
    stack = []
    memo = {}
    result = None

    def pop_mark():
        values = []
        while stack and stack[-1] is not PICKLE_MARK:
            values.append(stack.pop())
        if not stack:
            raise ValueError("pickle_mark_missing")
        stack.pop()
        values.reverse()
        return values

    atomic_ops = {
        "INT", "BININT", "BININT1", "BININT2", "LONG", "LONG1", "LONG4",
        "FLOAT", "BINFLOAT", "STRING", "BINSTRING", "SHORT_BINSTRING",
        "BINBYTES", "SHORT_BINBYTES", "BINBYTES8", "BYTEARRAY8", "NONE",
        "NEWTRUE", "NEWFALSE", "UNICODE", "BINUNICODE", "SHORT_BINUNICODE",
        "BINUNICODE8",
    }
    no_op_ops = {"PROTO", "FRAME"}
    global_ops = {"GLOBAL", "EXT1", "EXT2", "EXT4"}

    for index, (opcode, argument, _position) in enumerate(pickletools.genops(data)):
        if index >= MAX_PICKLE_OPS:
            raise ValueError("pickle_operation_limit")
        name = opcode.name
        if name in no_op_ops:
            continue
        if name in atomic_ops or name in global_ops or name == "PERSID":
            stack.append(None)
        elif name == "MARK":
            stack.append(PICKLE_MARK)
        elif name == "EMPTY_LIST":
            stack.append({"kind": "list", "length": 0})
        elif name == "EMPTY_DICT":
            stack.append({"kind": "dict"})
        elif name == "EMPTY_SET":
            stack.append({"kind": "set"})
        elif name == "EMPTY_TUPLE":
            stack.append({"kind": "tuple"})
        elif name == "APPEND":
            if len(stack) < 2 or stack[-2].get("kind") != "list":
                raise ValueError("pickle_list_invalid")
            stack.pop()
            stack[-1]["length"] += 1
        elif name == "APPENDS":
            values = pop_mark()
            if not stack or stack[-1].get("kind") != "list":
                raise ValueError("pickle_list_invalid")
            stack[-1]["length"] += len(values)
        elif name == "SETITEM":
            if len(stack) < 3 or stack[-3].get("kind") != "dict":
                raise ValueError("pickle_dict_invalid")
            stack.pop()
            stack.pop()
        elif name == "SETITEMS":
            values = pop_mark()
            if len(values) % 2 or not stack or stack[-1].get("kind") != "dict":
                raise ValueError("pickle_dict_invalid")
        elif name == "ADDITEMS":
            pop_mark()
            if not stack or stack[-1].get("kind") != "set":
                raise ValueError("pickle_set_invalid")
        elif name in {"LIST", "DICT", "TUPLE", "FROZENSET"}:
            values = pop_mark()
            if name == "LIST":
                stack.append({"kind": "list", "length": len(values)})
            elif name == "DICT":
                if len(values) % 2:
                    raise ValueError("pickle_dict_invalid")
                stack.append({"kind": "dict"})
            elif name == "FROZENSET":
                stack.append({"kind": "set"})
            else:
                stack.append({"kind": "tuple"})
        elif name in {"TUPLE1", "TUPLE2", "TUPLE3"}:
            count = int(name[-1])
            if len(stack) < count:
                raise ValueError("pickle_tuple_invalid")
            del stack[-count:]
            stack.append({"kind": "tuple"})
        elif name == "MEMOIZE":
            if not stack:
                raise ValueError("pickle_memo_invalid")
            memo[len(memo)] = stack[-1]
        elif name in {"PUT", "BINPUT", "LONG_BINPUT"}:
            if not stack:
                raise ValueError("pickle_memo_invalid")
            memo[int(argument)] = stack[-1]
        elif name in {"GET", "BINGET", "LONG_BINGET"}:
            key = int(argument)
            if key not in memo:
                raise ValueError("pickle_memo_missing")
            stack.append(memo[key])
        elif name == "DUP":
            if not stack:
                raise ValueError("pickle_stack_empty")
            stack.append(stack[-1])
        elif name == "POP":
            if not stack:
                raise ValueError("pickle_stack_empty")
            stack.pop()
        elif name == "POP_MARK":
            pop_mark()
        elif name == "STACK_GLOBAL":
            if len(stack) < 2:
                raise ValueError("pickle_global_invalid")
            stack.pop()
            stack.pop()
            stack.append(None)
        elif name == "REDUCE":
            if len(stack) < 2:
                raise ValueError("pickle_reduce_invalid")
            stack.pop()
            stack.pop()
            stack.append(None)
        elif name in {"NEWOBJ", "OBJ"}:
            if name == "OBJ":
                pop_mark()
            elif len(stack) >= 2:
                stack.pop()
                stack.pop()
            else:
                raise ValueError("pickle_object_invalid")
            stack.append(None)
        elif name == "NEWOBJ_EX":
            if len(stack) < 3:
                raise ValueError("pickle_object_invalid")
            del stack[-3:]
            stack.append(None)
        elif name == "INST":
            pop_mark()
            stack.append(None)
        elif name == "BUILD":
            if len(stack) < 2:
                raise ValueError("pickle_build_invalid")
            stack.pop()
        elif name == "BINPERSID":
            if not stack:
                raise ValueError("pickle_persistent_id_invalid")
            stack.pop()
            stack.append(None)
        elif name == "STOP":
            if not stack:
                raise ValueError("pickle_result_missing")
            result = stack[-1]
            break
        else:
            raise ValueError(f"unsupported_pickle_opcode:{name}")

        if len(stack) > 1_000_000:
            raise ValueError("pickle_stack_limit")

    if not isinstance(result, dict) or result.get("kind") != "list":
        raise ValueError("config_root_not_list")
    return result["length"]


def bounded_image_metrics(image, xseg_mask=None):
    """Calculate bounded review metrics, preferring a valid XSeg face region for blur."""
    height, width = image.shape[:2]
    longest = max(height, width)
    preview_width = width
    preview_height = height
    if longest > 320:
        scale = 320.0 / longest
        preview_width = max(1, round(width * scale))
        preview_height = max(1, round(height * scale))
        image = cv2.resize(
            image,
            (preview_width, preview_height),
            interpolation=cv2.INTER_AREA,
        )
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    laplacian = cv2.Laplacian(gray, cv2.CV_64F)
    full_laplacian_variance = float(laplacian.var())
    full_sharpness = min(
        max(full_laplacian_variance / (full_laplacian_variance + 500.0), 0.0),
        1.0,
    )

    sharpness = full_sharpness
    sharpness_scope = "full"
    mask_coverage = 0.0
    mask_sample_pixels = 0
    mask_valid = False
    if xseg_mask is not None:
        mask = xseg_mask
        if len(mask.shape) == 3:
            mask = mask[..., 0]
        if mask.shape[:2] != (preview_height, preview_width):
            mask = cv2.resize(
                mask,
                (preview_width, preview_height),
                interpolation=cv2.INTER_NEAREST,
            )
        binary_mask = (mask >= 0.5).astype("uint8")
        mask_coverage = float(binary_mask.mean())
        if binary_mask.any():
            # Ignore the rasterized mask boundary: it is a segmentation edge, not face detail.
            eroded_mask = cv2.erode(binary_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
            if int(eroded_mask.sum()) >= MIN_XSEG_AUDIT_PIXELS:
                binary_mask = eroded_mask
        mask_sample_pixels = int(binary_mask.sum())
        if mask_sample_pixels >= MIN_XSEG_AUDIT_PIXELS:
            masked_laplacian_variance = float(laplacian[binary_mask.astype(bool)].var())
            sharpness = min(
                max(masked_laplacian_variance / (masked_laplacian_variance + 500.0), 0.0),
                1.0,
            )
            sharpness_scope = "xseg"
            mask_valid = True

    brightness = float(gray.mean() / 255.0)
    dark_ratio = float((gray <= 8).mean())
    bright_ratio = float((gray >= 247).mean())
    exposure_score = max(0.0, 1.0 - abs(brightness - 0.5) / 0.5)
    quality_score = 0.72 * sharpness + 0.28 * exposure_score
    full_quality_score = 0.72 * full_sharpness + 0.28 * exposure_score
    return {
        "sharpness": sharpness,
        "fullSharpness": full_sharpness,
        "sharpnessScope": sharpness_scope,
        "maskCoverage": mask_coverage,
        "maskSamplePixels": mask_sample_pixels,
        "maskValid": mask_valid,
        "brightness": brightness,
        "darkRatio": dark_ratio,
        "brightRatio": bright_ratio,
        "qualityScore": quality_score,
        "fullQualityScore": full_quality_score,
    }


def audit_sample(image_path):
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        return {
            "name": image_path.name,
            "bytes": image_path.stat().st_size,
            "hasDflMetadata": False,
            "sourceFilename": None,
            "issues": ["unreadable_image"],
        }

    metrics = bounded_image_metrics(image)
    item = {
        "name": image_path.name,
        "bytes": image_path.stat().st_size,
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "hasDflMetadata": False,
        "sourceFilename": None,
        "faceType": None,
        "pitch": None,
        "yaw": None,
        "roll": None,
        "hasAppliedMask": False,
        "polygonCount": 0,
        **metrics,
        "issues": [],
    }
    try:
        dfl_image = load_dfl_image(image_path)
        polygons = serialize_polygons(dfl_image)
        has_applied_mask = bool(dfl_image.has_xseg_mask())
        if has_applied_mask:
            metrics = bounded_image_metrics(image, dfl_image.get_xseg_mask())
            item.update(metrics)
        pitch, yaw, roll = LandmarksProcessor.estimate_pitch_yaw_roll(
            dfl_image.get_landmarks(),
            size=dfl_image.get_shape()[1],
        )
        item.update({
            "hasDflMetadata": True,
            "sourceFilename": dfl_image.get_source_filename(),
            "faceType": dfl_image.get_face_type(),
            "pitch": float(math.degrees(pitch)),
            "yaw": float(math.degrees(-yaw)),
            "roll": float(math.degrees(roll)),
            "hasAppliedMask": has_applied_mask,
            "polygonCount": len(polygons),
        })
    except Exception:
        item["issues"].append("missing_dfl_metadata")

    if item["hasAppliedMask"] and not item["maskValid"]:
        item["issues"].append("mask_invalid")
    if item["sharpness"] < LOW_QUALITY_THRESHOLD:
        item["issues"].append("low_sharpness")
    if item["brightness"] < 0.16:
        item["issues"].append("underexposed")
    elif item["brightness"] > 0.86:
        item["issues"].append("overexposed")
    if item["darkRatio"] + item["brightRatio"] > 0.35:
        item["issues"].append("clipped_tones")
    return item


def audit_directory(directory, offset=0, limit=120):
    files = iter_images(directory)
    safe_offset = max(offset, 0)
    safe_limit = min(max(limit, 1), MAX_AUDIT_ITEMS)
    page_files = files[safe_offset:safe_offset + safe_limit]
    items = [audit_sample(image_path) for image_path in page_files]
    source_counts = Counter(
        item["sourceFilename"]
        for item in items
        if item.get("sourceFilename")
    )
    duplicate_sources = {name for name, count in source_counts.items() if count > 1}
    for item in items:
        if item.get("sourceFilename") in duplicate_sources:
            item["issues"].append("duplicate_source")

    valid_items = [item for item in items if item.get("hasDflMetadata")]
    masked_count = sum(1 for item in valid_items if item["hasAppliedMask"])
    if 0 < masked_count < len(valid_items):
        for item in valid_items:
            if not item["hasAppliedMask"]:
                item["issues"].append("mask_missing")
    issue_counts = Counter(issue for item in items for issue in item["issues"])
    metric_items = [item for item in items if "qualityScore" in item]
    usable_count = sum(
        1
        for item in metric_items
        if item.get("hasDflMetadata") and item["qualityScore"] >= LOW_QUALITY_THRESHOLD
    )
    issue_item_count = sum(1 for item in items if item["issues"])
    severe_issue_count = sum(
        1
        for item in items
        if "unreadable_image" in item["issues"]
        or "missing_dfl_metadata" in item["issues"]
        or item.get("qualityScore", 1.0) < 0.12
    )
    xseg_sharpness_count = sum(
        1 for item in metric_items if item.get("sharpnessScope") == "xseg"
    )
    source_covered = len({item["sourceFilename"] for item in valid_items if item["sourceFilename"]})
    sorted_items = sorted(
        items,
        key=lambda item: (item.get("qualityScore", -1.0), item["name"]),
    )
    return {
        "schemaVersion": AUDIT_SCHEMA_VERSION,
        "total": len(files),
        "offset": safe_offset,
        "limit": safe_limit,
        "analyzedCount": len(items),
        "truncated": safe_offset + len(items) < len(files),
        "validMetadataCount": len(valid_items),
        "invalidMetadataCount": len(items) - len(valid_items),
        "maskedCount": masked_count,
        "xsegSharpnessCount": xseg_sharpness_count,
        "usableCount": usable_count,
        "issueItemCount": issue_item_count,
        "severeIssueCount": severe_issue_count,
        "uniqueSourceCount": source_covered,
        "duplicateSourceGroupCount": len(duplicate_sources),
        "meanQualityScore": (
            sum(item["qualityScore"] for item in metric_items) / len(metric_items)
            if metric_items else 0.0
        ),
        "meanSharpness": (
            sum(item["sharpness"] for item in metric_items) / len(metric_items)
            if metric_items else 0.0
        ),
        "meanFullSharpness": (
            sum(item["fullSharpness"] for item in metric_items) / len(metric_items)
            if metric_items else 0.0
        ),
        "issueCounts": dict(sorted(issue_counts.items())),
        "items": sorted_items,
    }


def inspect_packed_faceset(directory):
    pak_path = directory / "faceset.pak"
    zip_path = directory / "faceset.zip"
    target = pak_path if pak_path.is_file() else zip_path if zip_path.is_file() else None
    if target is None:
        return {
            "present": False,
            "format": None,
            "name": None,
            "bytes": 0,
            "sampleCount": 0,
            "status": "not_packed",
            "warnings": [],
        }

    result = {
        "present": True,
        "format": target.suffix.lower().lstrip("."),
        "name": target.name,
        "bytes": target.stat().st_size,
        "sampleCount": 0,
        "status": "ready",
        "warnings": [],
        "sha256Prefix": file_digest_prefix(target),
    }
    try:
        if target.suffix.lower() == ".pak":
            with target.open("rb") as stream:
                header = stream.read(16)
                if len(header) != 16:
                    raise ValueError("header_too_short")
                version, metadata_bytes = struct.unpack("QQ", header)
                if metadata_bytes > MAX_PACK_CONFIG_BYTES:
                    raise ValueError("metadata_too_large")
                metadata = stream.read(metadata_bytes)
                if len(metadata) != metadata_bytes:
                    raise ValueError("metadata_truncated")
                result.update({
                    "version": version,
                    "metadataBytes": metadata_bytes,
                    "sampleCount": safe_pickle_list_length(metadata),
                })
                if version != 1:
                    result["warnings"].append("unsupported_version")
        else:
            with zipfile.ZipFile(target, "r") as archive:
                names = archive.namelist()
                if "config.pak" not in names:
                    raise ValueError("config_missing")
                config_info = archive.getinfo("config.pak")
                if config_info.file_size > MAX_PACK_CONFIG_BYTES:
                    raise ValueError("metadata_too_large")
                metadata = archive.read("config.pak")
                result.update({
                    "version": 1,
                    "metadataBytes": config_info.file_size,
                    "sampleCount": safe_pickle_list_length(metadata),
                    "entryCount": len(names),
                    "checksumValid": archive.comment == hashlib.md5(str(names).encode()).digest(),
                })
                if not result["checksumValid"]:
                    result["warnings"].append("zip_index_checksum_mismatch")
    except Exception as error:
        result["status"] = "invalid"
        result["warnings"].append(str(error) or error.__class__.__name__)
    return result


def build_extraction_coverage(frames_directory, aligned_directory, offset=0, limit=120):
    frame_paths = iter_images(frames_directory)
    safe_offset = max(offset, 0)
    safe_limit = min(max(limit, 1), MAX_AUDIT_ITEMS)
    page_paths = frame_paths[safe_offset:safe_offset + safe_limit]
    frame_names = {path.name for path in frame_paths}
    page_names = {path.name for path in page_paths}
    face_counts = Counter()
    faces_by_frame = {name: [] for name in page_names}
    orphan_alignment_count = 0

    for aligned_path in iter_images(aligned_directory):
        try:
            dfl_image = load_dfl_image(aligned_path)
            source_name = Path(dfl_image.get_source_filename() or "").name
            if source_name not in frame_names:
                orphan_alignment_count += 1
                continue
            face_counts[source_name] += 1
            if source_name not in page_names:
                continue
            source_rect = dfl_image.get_source_rect()
            source_landmarks = dfl_image.get_source_landmarks()
            faces_by_frame[source_name].append({
                "alignedName": aligned_path.name,
                "rect": [float(value) for value in source_rect] if source_rect is not None else None,
                "landmarks": (
                    [[float(x), float(y)] for x, y in source_landmarks]
                    if source_landmarks is not None and source_landmarks.ndim == 2
                    else []
                ),
            })
        except Exception:
            orphan_alignment_count += 1

    items = []
    for frame_path in page_paths:
        image = cv2.imread(str(frame_path), cv2.IMREAD_COLOR)
        faces = faces_by_frame.get(frame_path.name, [])
        items.append({
            "name": frame_path.name,
            "width": int(image.shape[1]) if image is not None else None,
            "height": int(image.shape[0]) if image is not None else None,
            "readable": image is not None,
            "faceCount": len(faces),
            "faces": faces,
        })

    return {
        "schemaVersion": AUDIT_SCHEMA_VERSION,
        "total": len(frame_paths),
        "offset": safe_offset,
        "limit": safe_limit,
        "analyzedCount": len(items),
        "truncated": safe_offset + len(items) < len(frame_paths),
        "coveredCount": sum(1 for name in frame_names if face_counts[name] > 0),
        "uncoveredCount": sum(1 for name in frame_names if face_counts[name] == 0),
        "multiFaceCount": sum(1 for name in frame_names if face_counts[name] > 1),
        "orphanAlignmentCount": orphan_alignment_count,
        "items": items,
    }


def analyze_pose(image_path):
    dfl_image = load_dfl_image(image_path)
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("无法读取 aligned 图片")

    pitch, yaw, roll = LandmarksProcessor.estimate_pitch_yaw_roll(
        dfl_image.get_landmarks(),
        size=dfl_image.get_shape()[1],
    )
    sharpness, brightness = image_quality(image)
    return {
        "name": image_path.name,
        "sourceFilename": dfl_image.get_source_filename(),
        "pitch": float(math.degrees(pitch)),
        "yaw": float(math.degrees(-yaw)),
        "roll": float(math.degrees(roll)),
        "sharpness": sharpness,
        "brightness": brightness,
        "hasAppliedMask": bool(dfl_image.has_xseg_mask()),
    }


def build_pose_atlas(directory):
    files = iter_images(directory)
    cells = {
        (pitch, yaw): {
            "id": f"p{pitch}-y{yaw}",
            "pitch": pitch,
            "yaw": yaw,
            "count": 0,
            "lowQualityCount": 0,
            "sharpnessTotal": 0.0,
            "brightnessTotal": 0.0,
            "qualityBands": [0, 0, 0, 0, 0],
            "samples": [],
        }
        for pitch in PITCH_TICKS
        for yaw in YAW_TICKS
    }
    invalid_count = 0
    sharpness_total = 0.0
    low_quality_count = 0

    for image_path in files:
        try:
            sample = analyze_pose(image_path)
        except Exception:
            invalid_count += 1
            continue

        pitch_tick = nearest_tick(sample["pitch"], PITCH_TICKS)
        yaw_tick = nearest_tick(sample["yaw"], YAW_TICKS)
        cell = cells[(pitch_tick, yaw_tick)]
        cell["count"] += 1
        cell["sharpnessTotal"] += sample["sharpness"]
        cell["brightnessTotal"] += sample["brightness"]
        cell["qualityBands"][quality_band(sample["sharpness"])] += 1
        sharpness_total += sample["sharpness"]

        if sample["sharpness"] < LOW_QUALITY_THRESHOLD:
            cell["lowQualityCount"] += 1
            low_quality_count += 1

        candidates = cell["samples"]
        candidates.append(sample)
        candidates.sort(key=lambda item: item["sharpness"])
        del candidates[8:]

    valid_count = len(files) - invalid_count
    occupied_count = sum(1 for cell in cells.values() if cell["count"])
    result_cells = []
    for pitch in PITCH_TICKS:
        for yaw in YAW_TICKS:
            cell = cells[(pitch, yaw)]
            count = cell.pop("count")
            sharpness_sum = cell.pop("sharpnessTotal")
            brightness_sum = cell.pop("brightnessTotal")
            result_cells.append({
                **cell,
                "count": count,
                "meanSharpness": sharpness_sum / count if count else 0.0,
                "meanBrightness": brightness_sum / count if count else 0.0,
            })

    return {
        "total": len(files),
        "validCount": valid_count,
        "invalidCount": invalid_count,
        "lowQualityCount": low_quality_count,
        "meanSharpness": sharpness_total / valid_count if valid_count else 0.0,
        "coverage": occupied_count / len(cells) if cells else 0.0,
        "occupiedCells": occupied_count,
        "cellCount": len(cells),
        "lowQualityThreshold": LOW_QUALITY_THRESHOLD,
        "yawTicks": list(YAW_TICKS),
        "pitchTicks": list(PITCH_TICKS),
        "cells": result_cells,
    }


def build_pose_probe_manifest(directory, side):
    if side not in ("src", "dst"):
        raise ValueError("probe side must be src or dst")

    files = iter_images(directory)
    dataset_fingerprint, file_digests = fingerprint_probe_directory(directory)
    records = []
    invalid_count = 0

    for image_path in files:
        try:
            digest = file_digests[image_path.name]
            sample = analyze_pose(image_path)
        except Exception:
            invalid_count += 1
            continue

        pitch_tick = nearest_tick(sample["pitch"], PITCH_TICKS)
        yaw_tick = nearest_tick(sample["yaw"], YAW_TICKS)
        records.append({
            **sample,
            "sha256Prefix": digest[:16],
            "cellId": pose_cell_id(pitch_tick, yaw_tick),
            "pitchTick": pitch_tick,
            "yawTick": yaw_tick,
        })

    grouped = {
        (pitch, yaw): []
        for pitch in PITCH_TICKS
        for yaw in YAW_TICKS
    }
    for record in records:
        grouped[(record["pitchTick"], record["yawTick"])].append(record)

    ranked = {}
    for key, candidates in grouped.items():
        if not candidates:
            ranked[key] = []
            continue
        median_sharpness = median(item["sharpness"] for item in candidates)
        ordered = sorted(
            candidates,
            key=lambda item: (
                abs(item["sharpness"] - median_sharpness),
                item["name"].casefold(),
            ),
        )
        distinct = []
        seen_sources = set()
        for item in ordered:
            source_key = (item.get("sourceFilename") or item["name"]).casefold()
            if source_key in seen_sources:
                continue
            seen_sources.add(source_key)
            distinct.append(item)
        ranked[key] = distinct

    canonical_keys = [
        (pitch, yaw)
        for pitch in PITCH_TICKS
        for yaw in YAW_TICKS
    ]
    canonical_order = {key: index for index, key in enumerate(canonical_keys)}
    selected_by_cell = {key: [] for key in canonical_keys}
    selected_count = 0
    for round_index in range(MAX_PROBE_SAMPLES_PER_CELL):
        if selected_count >= MAX_PROBE_SAMPLES_PER_SIDE:
            break
        keys = canonical_keys if round_index == 0 else sorted(
            canonical_keys,
            key=lambda key: (-len(grouped[key]), canonical_order[key]),
        )
        for key in keys:
            if selected_count >= MAX_PROBE_SAMPLES_PER_SIDE:
                break
            candidates = ranked[key]
            if round_index >= len(candidates):
                continue
            selected_by_cell[key].append(candidates[round_index])
            selected_count += 1

    samples = []
    cells = []
    for pitch, yaw in canonical_keys:
        cell_samples = selected_by_cell[(pitch, yaw)]
        cells.append({
            "id": pose_cell_id(pitch, yaw),
            "pitch": pitch,
            "yaw": yaw,
            "count": len(grouped[(pitch, yaw)]),
            "selectedCount": len(cell_samples),
        })
        for ordinal, sample in enumerate(cell_samples, start=1):
            samples.append({
                "id": f"{side}-{pose_cell_id(pitch, yaw)}-{ordinal:02d}",
                "side": side,
                "name": sample["name"],
                "sha256Prefix": sample["sha256Prefix"],
                "sourceFilename": sample.get("sourceFilename"),
                "cellId": pose_cell_id(pitch, yaw),
                "yaw": sample["yaw"],
                "pitch": sample["pitch"],
                "yawTick": yaw,
                "pitchTick": pitch,
                "sharpness": sample["sharpness"],
                "brightness": sample["brightness"],
                "hasAppliedMask": sample["hasAppliedMask"],
            })

    return {
        "schemaVersion": PROBE_SCHEMA_VERSION,
        "side": side,
        "datasetFingerprint": dataset_fingerprint,
        "totalCount": len(files),
        "validCount": len(records),
        "invalidCount": invalid_count,
        "sampleCount": len(samples),
        "maxSamples": MAX_PROBE_SAMPLES_PER_SIDE,
        "maxSamplesPerCell": MAX_PROBE_SAMPLES_PER_CELL,
        "yawTicks": list(YAW_TICKS),
        "pitchTicks": list(PITCH_TICKS),
        "cells": cells,
        "samples": samples,
    }


def describe_list_image(image_path):
    try:
        dfl_image = load_dfl_image(image_path)
        polygons = serialize_polygons(dfl_image)
        return {
            "name": image_path.name,
            "hasDflMetadata": True,
            "polygonCount": len(polygons),
            "pointCount": sum(len(poly["points"]) for poly in polygons),
            "hasAppliedMask": bool(dfl_image.has_xseg_mask()),
            "sourceFilename": dfl_image.get_source_filename(),
        }
    except Exception:
        return {
            "name": image_path.name,
            "hasDflMetadata": False,
            "polygonCount": 0,
            "pointCount": 0,
            "hasAppliedMask": False,
            "sourceFilename": None,
        }


def list_images(directory, offset, limit):
    files = iter_images(directory)
    items = [describe_list_image(image_path) for image_path in files[offset : offset + limit]]
    return {"total": len(files), "offset": offset, "limit": limit, "items": items}


def list_quarantined_images(directory, offset, limit):
    records = []
    token_directories = sorted(
        (
            entry
            for entry in directory.iterdir()
            if (
                not entry.is_symlink()
                and entry.is_dir()
                and QUARANTINE_TOKEN_PATTERN.fullmatch(entry.name)
            )
        ),
        key=lambda entry: entry.name,
        reverse=True,
    )
    for token_directory in token_directories:
        for image_path in iter_images(token_directory):
            if image_path.is_symlink():
                continue
            records.append((token_directory.name, image_path))
    page = records[offset : offset + limit]
    return {
        "total": len(records),
        "offset": offset,
        "limit": limit,
        "items": [
            {**describe_list_image(image_path), "token": token}
            for token, image_path in page
        ],
    }


def summarize_xseg_labels(directory):
    files = iter_images(directory)
    polygon_count = 0
    applied_mask_count = 0
    invalid_count = 0
    for image_path in files:
        try:
            dfl_image = load_dfl_image(image_path)
            if dfl_image.get_seg_ie_polys().has_polys():
                polygon_count += 1
            elif dfl_image.has_xseg_mask():
                applied_mask_count += 1
        except Exception:
            invalid_count += 1
    return {
        "total": len(files),
        "polygonCount": polygon_count,
        "appliedMaskCount": applied_mask_count,
        "usableLabelCount": polygon_count + applied_mask_count,
        "invalidCount": invalid_count,
    }


def similarity_descriptor(image):
    resized = cv2.resize(image, (96, 96), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    gray = cv2.equalizeHist(np.uint8(gray * 255)).astype(np.float32) / 255.0
    dct = cv2.dct(gray)[:12, :12].reshape(-1)[1:]
    dct /= np.linalg.norm(dct) + 1e-8
    hsv = cv2.cvtColor(resized, cv2.COLOR_BGR2HSV)
    histogram = cv2.calcHist([hsv], [0, 1], None, [12, 8], [0, 180, 0, 256]).reshape(-1)
    histogram /= np.linalg.norm(histogram) + 1e-8
    edges = cv2.resize(cv2.Canny(np.uint8(gray * 255), 80, 160), (24, 24), interpolation=cv2.INTER_AREA)
    edges = edges.astype(np.float32).reshape(-1) / 255.0
    edges /= np.linalg.norm(edges) + 1e-8
    descriptor = np.concatenate((dct * 0.58, histogram * 0.22, edges * 0.20))
    return descriptor / (np.linalg.norm(descriptor) + 1e-8)


def group_similar_images(directory, threshold=0.86, limit=MAX_SIMILARITY_ITEMS):
    safe_threshold = min(max(float(threshold), 0.72), 0.98)
    safe_limit = min(max(int(limit), 2), MAX_SIMILARITY_ITEMS)
    all_files = iter_images(directory)
    files = all_files[:safe_limit]
    records = []
    invalid_count = 0
    for image_path in files:
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            invalid_count += 1
            continue
        try:
            records.append({
                "name": image_path.name,
                "descriptor": similarity_descriptor(image),
            })
        except Exception:
            invalid_count += 1

    count = len(records)
    parents = list(range(count))

    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left, right):
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    similarities = np.eye(count, dtype=np.float32)
    for left in range(count):
        for right in range(left + 1, count):
            score = float(np.dot(records[left]["descriptor"], records[right]["descriptor"]))
            similarities[left, right] = similarities[right, left] = score
            if score >= safe_threshold:
                union(left, right)

    grouped = {}
    for index in range(count):
        grouped.setdefault(find(index), []).append(index)
    groups = []
    for indexes in grouped.values():
        if len(indexes) < 2:
            continue
        representative = max(
            indexes,
            key=lambda index: float(np.mean([similarities[index, other] for other in indexes])),
        )
        members = sorted(
            ({
                "name": records[index]["name"],
                "score": round(float(similarities[representative, index]), 4),
                "representative": index == representative,
            } for index in indexes),
            key=lambda item: (-item["score"], item["name"].casefold()),
        )
        pair_scores = [
            float(similarities[left, right])
            for position, left in enumerate(indexes)
            for right in indexes[position + 1:]
        ]
        groups.append({
            "id": f"similar-{len(groups) + 1:03d}",
            "representativeName": records[representative]["name"],
            "memberCount": len(members),
            "minimumScore": round(min(pair_scores), 4) if pair_scores else 1.0,
            "meanScore": round(float(np.mean(pair_scores)), 4) if pair_scores else 1.0,
            "members": members,
        })
    groups.sort(key=lambda item: (-item["memberCount"], -item["meanScore"], item["id"]))
    grouped_count = sum(group["memberCount"] for group in groups)
    return {
        "schemaVersion": 1,
        "threshold": safe_threshold,
        "total": len(all_files),
        "analyzedCount": count,
        "invalidCount": invalid_count,
        "truncated": len(all_files) > safe_limit,
        "groupCount": len(groups),
        "groupedCount": grouped_count,
        "ungroupedCount": max(count - grouped_count, 0),
        "method": "dct-hsv-edge-v1",
        "groups": groups,
    }


def encode_mask_data_url(mask):
    image = np.clip(mask * 255.0, 0, 255).astype(np.uint8)
    ok, buffer = cv2.imencode(".png", image)
    if not ok:
        return None
    return "data:image/png;base64," + base64.b64encode(buffer).decode("ascii")


def mask_suggested_polygons(mask, width, height):
    binary = np.uint8(np.squeeze(mask) >= 0.5) * 255
    if binary.shape[:2] != (height, width):
        binary = cv2.resize(binary, (width, height), interpolation=cv2.INTER_NEAREST)
    contours, _hierarchy = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    suggested = []
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:8]:
        if cv2.contourArea(contour) < max(width * height * 0.001, 16):
            continue
        epsilon = max(1.0, cv2.arcLength(contour, True) * 0.008)
        points = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
        if 3 <= len(points) <= 160:
            suggested.append({
                "type": "include",
                "points": [[float(x), float(y)] for x, y in points],
            })
    return suggested


def inspect_image(image_path):
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("无法读取 aligned 图片")
    dfl_image = load_dfl_image(image_path)
    mask = dfl_image.get_xseg_mask() if dfl_image.has_xseg_mask() else None
    if mask is not None and mask.shape[:2] != image.shape[:2]:
        mask = cv2.resize(mask, (image.shape[1], image.shape[0]), interpolation=cv2.INTER_LINEAR)
    return {
        "name": image_path.name,
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        **inspect_dfl_geometry(dfl_image),
        "polygons": serialize_polygons(dfl_image),
        "hasAppliedMask": bool(dfl_image.has_xseg_mask()),
        "appliedMaskDataUrl": encode_mask_data_url(mask) if mask is not None else None,
        "suggestedPolygons": (
            mask_suggested_polygons(mask, image.shape[1], image.shape[0]) if mask is not None else []
        ),
        "sourceFilename": dfl_image.get_source_filename(),
    }


def validate_source_landmarks(payload, source_image):
    points = payload.get("landmarks") if isinstance(payload, dict) else None
    if not isinstance(points, list) or len(points) != 68:
        raise ValueError("对齐修复需要完整的 68 个源帧 landmarks")
    height, width = source_image.shape[:2]
    values = np.asarray(points, dtype=np.float32)
    if values.shape != (68, 2) or not np.isfinite(values).all():
        raise ValueError("landmarks 格式无效")
    if (
        values[:, 0].min() < 0 or values[:, 1].min() < 0
        or values[:, 0].max() >= width or values[:, 1].max() >= height
    ):
        raise ValueError("landmarks 超出源帧范围")
    return values


def resolve_source_frame(dfl_image, frames_directory):
    source_name = Path(dfl_image.get_source_filename() or "").name
    if not source_name:
        raise ValueError("aligned 图片缺少 source_filename")
    source_path = frames_directory / source_name
    if not source_path.is_file() or source_path.suffix.lower() not in IMAGE_EXTENSIONS:
        raise ValueError("对应源帧不存在")
    source_image = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
    if source_image is None:
        raise ValueError("无法读取对应源帧")
    return source_path, source_image


def alignment_result(image_path, frames_directory, payload, apply=False, backup_directory=None):
    original = load_dfl_image(image_path)
    _source_path, source_image = resolve_source_frame(original, frames_directory)
    source_landmarks = validate_source_landmarks(payload, source_image)
    aligned_image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if aligned_image is None or aligned_image.shape[0] != aligned_image.shape[1]:
        raise ValueError("aligned 图片必须为可读取的正方形")
    image_size = int(aligned_image.shape[1])
    face_type = FaceType.fromString(original.get_face_type())
    if face_type == FaceType.MARK_ONLY:
        raise ValueError("mark_only 图片不支持对齐重裁")
    new_matrix = LandmarksProcessor.get_transform_mat(source_landmarks, image_size, face_type)
    preview = cv2.warpAffine(
        source_image,
        new_matrix,
        (image_size, image_size),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
    )
    aligned_landmarks = LandmarksProcessor.transform_points(source_landmarks, new_matrix)
    ok, encoded = cv2.imencode(".jpg", preview, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    if not ok:
        raise ValueError("无法生成对齐预览")
    response = {
        "name": image_path.name,
        "previewDataUrl": "data:image/jpeg;base64," + base64.b64encode(encoded).decode("ascii"),
        "landmarks": [[float(x), float(y)] for x, y in aligned_landmarks],
        "sourceLandmarks": [[float(x), float(y)] for x, y in source_landmarks],
        "applied": False,
    }
    if not apply:
        return response
    if backup_directory is None:
        raise ValueError("对齐应用缺少恢复目录")
    backup_directory.mkdir(parents=True, exist_ok=True)
    backup_target = backup_directory / image_path.name
    if backup_target.exists():
        raise ValueError("本次对齐备份已存在")
    shutil.copy2(image_path, backup_target)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{image_path.stem}-", suffix=image_path.suffix, dir=image_path.parent, delete=False
        ) as stream:
            temporary = Path(stream.name)
        if not cv2.imwrite(str(temporary), preview, [int(cv2.IMWRITE_JPEG_QUALITY), 95]):
            raise ValueError("无法写入对齐临时文件")
        repaired = DFLIMG.load(temporary)
        if repaired is None:
            raise ValueError("无法初始化新的 DFL aligned 容器")
        repaired.set_dict(dict(original.get_dict()))
        repaired.set_landmarks(aligned_landmarks.tolist())
        repaired.set_source_landmarks(source_landmarks.tolist())
        repaired.set_image_to_face_mat(new_matrix)
        margin = max(float(np.ptp(source_landmarks[:, 0])), float(np.ptp(source_landmarks[:, 1]))) * 0.18
        height, width = source_image.shape[:2]
        repaired.set_source_rect([
            float(max(source_landmarks[:, 0].min() - margin, 0)),
            float(max(source_landmarks[:, 1].min() - margin, 0)),
            float(min(source_landmarks[:, 0].max() + margin, width - 1)),
            float(min(source_landmarks[:, 1].max() + margin, height - 1)),
        ])
        old_matrix = original.get_image_to_face_mat()
        original_polygons = original.get_seg_ie_polys().get_polys()
        if old_matrix is None:
            old_source_landmarks = np.asarray(original.get_source_landmarks(), dtype=np.float32)
            if old_source_landmarks.shape == (68, 2) and np.isfinite(old_source_landmarks).all():
                old_matrix = LandmarksProcessor.get_transform_mat(
                    old_source_landmarks,
                    image_size,
                    face_type,
                )
        if old_matrix is None and (original_polygons or original.has_xseg_mask()):
            raise ValueError("原 aligned 缺少可用变换矩阵，不能安全迁移 SegIEPolys/XSeg")
        if old_matrix is not None:
            old_h = np.vstack([old_matrix, [0, 0, 1]])
            new_h = np.vstack([new_matrix, [0, 0, 1]])
            old_to_new = (new_h @ np.linalg.inv(old_h))[:2].astype(np.float32)
            transformed = SegIEPolys()
            for polygon in original_polygons:
                target = transformed.add_poly(polygon.get_type())
                points = LandmarksProcessor.transform_points(polygon.get_pts(), old_to_new)
                for x, y in points:
                    target.add_pt(
                        float(np.clip(x, 0, image_size - 1)),
                        float(np.clip(y, 0, image_size - 1)),
                    )
            repaired.set_seg_ie_polys(transformed)
            if original.has_xseg_mask():
                mask = original.get_xseg_mask()
                repaired.set_xseg_mask(cv2.warpAffine(
                    mask,
                    old_to_new,
                    (image_size, image_size),
                    flags=cv2.INTER_LINEAR,
                    borderMode=cv2.BORDER_CONSTANT,
                ))
        repaired.save()
        os.replace(temporary, image_path)
        temporary = None
    except Exception:
        if temporary is not None and temporary.exists():
            temporary.unlink()
        if backup_target.exists():
            shutil.copy2(backup_target, image_path)
        raise
    return {**response, "applied": True, "backupName": backup_target.name}


def save_annotation(image_path):
    payload = json.load(sys.stdin)
    polygons = payload.get("polygons")
    if not isinstance(polygons, list) or len(polygons) > 64:
        raise ValueError("多边形列表无效或数量超过 64")

    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("无法读取 aligned 图片")
    height, width = image.shape[:2]
    result = SegIEPolys()
    total_points = 0

    for polygon in polygons:
        if not isinstance(polygon, dict):
            raise ValueError("多边形格式无效")
        polygon_type = polygon.get("type")
        points = polygon.get("points")
        if polygon_type not in ("include", "exclude"):
            raise ValueError("多边形类型必须是 include 或 exclude")
        if not isinstance(points, list) or not 3 <= len(points) <= 512:
            raise ValueError("每个多边形需要 3–512 个点")
        total_points += len(points)
        if total_points > 4096:
            raise ValueError("标注点总数超过 4096")

        target = result.add_poly(
            SegIEPolyType.INCLUDE if polygon_type == "include" else SegIEPolyType.EXCLUDE
        )
        for point in points:
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError("标注点格式无效")
            x, y = point
            if (
                not isinstance(x, (int, float))
                or not isinstance(y, (int, float))
                or not math.isfinite(x)
                or not math.isfinite(y)
                or x < 0
                or y < 0
                or x > width
                or y > height
            ):
                raise ValueError("标注点超出图片范围")
            target.add_pt(x, y)

    dfl_image = load_dfl_image(image_path)
    dfl_image.set_seg_ie_polys(result)
    dfl_image.save()
    return {"saved": True, "polygonCount": len(polygons), "pointCount": total_points}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=(
            "list",
            "quarantine-list",
            "xseg-label-summary",
            "inspect",
            "save",
            "atlas",
            "audit",
            "pack-inspect",
            "coverage",
            "probe-manifest",
            "similarity",
            "alignment-preview",
            "alignment-apply",
        ),
    )
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--frames", type=Path)
    parser.add_argument("--file", type=Path)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=60)
    parser.add_argument("--side", choices=("src", "dst"))
    parser.add_argument("--threshold", type=float, default=0.86)
    parser.add_argument("--backup-directory", type=Path)
    args = parser.parse_args()

    if args.action == "list":
        if args.directory is None or not args.directory.is_dir():
            raise ValueError("aligned 目录不存在")
        emit(list_images(args.directory, max(args.offset, 0), min(max(args.limit, 1), 200)))
        return

    if args.action == "quarantine-list":
        if (
            args.directory is None
            or args.directory.is_symlink()
            or not args.directory.is_dir()
        ):
            raise ValueError("隔离目录不存在或不安全")
        emit(list_quarantined_images(
            args.directory,
            max(args.offset, 0),
            min(max(args.limit, 1), 200),
        ))
        return

    if args.action == "xseg-label-summary":
        if args.directory is None or not args.directory.is_dir():
            raise ValueError("aligned 目录不存在")
        emit(summarize_xseg_labels(args.directory))
        return

    if args.action == "atlas":
        if args.directory is None or not args.directory.is_dir():
            raise ValueError("aligned 目录不存在")
        emit(build_pose_atlas(args.directory))
        return

    if args.action == "probe-manifest":
        if args.directory is None or not args.directory.is_dir():
            raise ValueError("aligned directory does not exist")
        if args.side is None:
            raise ValueError("probe side is required")
        emit(build_pose_probe_manifest(args.directory, args.side))
        return

    if args.action in ("audit", "pack-inspect"):
        if args.directory is None or not args.directory.is_dir():
            raise ValueError("aligned directory does not exist")
        emit(
            audit_directory(args.directory, args.offset, args.limit)
            if args.action == "audit"
            else inspect_packed_faceset(args.directory)
        )
        return

    if args.action == "coverage":
        if args.directory is None or not args.directory.is_dir():
            raise ValueError("aligned directory does not exist")
        if args.frames is None or not args.frames.is_dir():
            raise ValueError("frames directory does not exist")
        emit(build_extraction_coverage(args.frames, args.directory, args.offset, args.limit))
        return

    if args.action == "similarity":
        if args.directory is None or not args.directory.is_dir():
            raise ValueError("aligned directory does not exist")
        emit(group_similar_images(args.directory, args.threshold, args.limit))
        return

    if args.file is None or not args.file.is_file():
        raise ValueError("aligned 图片不存在")
    if args.action == "inspect":
        emit(inspect_image(args.file))
    elif args.action in ("alignment-preview", "alignment-apply"):
        if args.frames is None or not args.frames.is_dir():
            raise ValueError("frames directory does not exist")
        emit(alignment_result(
            args.file,
            args.frames,
            json.load(sys.stdin),
            apply=args.action == "alignment-apply",
            backup_directory=args.backup_directory,
        ))
    else:
        emit(save_annotation(args.file))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(str(error))
        sys.exit(2)
