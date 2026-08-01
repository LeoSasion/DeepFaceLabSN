import argparse
import hashlib
import json
import math
import os
import pickletools
import struct
import sys
import zipfile
from collections import Counter
from pathlib import Path

import cv2

DFL_ROOT = Path(
    os.environ.get(
        "DFL_ROOT",
        Path(__file__).resolve().parents[2] / "_internal" / "DeepFaceLab",
    )
)
sys.path.insert(0, str(DFL_ROOT))

from core.imagelib import SegIEPolyType, SegIEPolys
from DFLIMG import DFLIMG
from facelib import LandmarksProcessor


YAW_TICKS = tuple(range(-90, 91, 15))
PITCH_TICKS = tuple(range(60, -61, -15))
LOW_QUALITY_THRESHOLD = 0.24
QUALITY_BANDS = (0.2, 0.4, 0.6, 0.8)
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}
AUDIT_SCHEMA_VERSION = 1
MAX_AUDIT_ITEMS = 500
MAX_PACK_CONFIG_BYTES = 64 * 1024 * 1024
MAX_PICKLE_OPS = 2_000_000
PICKLE_MARK = object()


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


def nearest_tick(value, ticks):
    return min(ticks, key=lambda tick: abs(tick - value))


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
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
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


def bounded_image_metrics(image):
    """Calculate review metrics on a bounded preview without changing DFL pixels."""
    height, width = image.shape[:2]
    longest = max(height, width)
    if longest > 320:
        scale = 320.0 / longest
        image = cv2.resize(
            image,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    laplacian_variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    sharpness = min(max(laplacian_variance / (laplacian_variance + 500.0), 0.0), 1.0)
    brightness = float(gray.mean() / 255.0)
    dark_ratio = float((gray <= 8).mean())
    bright_ratio = float((gray >= 247).mean())
    exposure_score = max(0.0, 1.0 - abs(brightness - 0.5) / 0.5)
    quality_score = 0.72 * sharpness + 0.28 * exposure_score
    return {
        "sharpness": sharpness,
        "brightness": brightness,
        "darkRatio": dark_ratio,
        "brightRatio": bright_ratio,
        "qualityScore": quality_score,
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
            "hasAppliedMask": bool(dfl_image.has_xseg_mask()),
            "polygonCount": len(polygons),
        })
    except Exception:
        item["issues"].append("missing_dfl_metadata")

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


def list_images(directory, offset, limit):
    files = iter_images(directory)
    items = []
    for image_path in files[offset : offset + limit]:
        try:
            dfl_image = load_dfl_image(image_path)
            polygons = serialize_polygons(dfl_image)
            items.append(
                {
                    "name": image_path.name,
                    "hasDflMetadata": True,
                    "polygonCount": len(polygons),
                    "pointCount": sum(len(poly["points"]) for poly in polygons),
                    "hasAppliedMask": bool(dfl_image.has_xseg_mask()),
                    "sourceFilename": dfl_image.get_source_filename(),
                }
            )
        except Exception:
            items.append(
                {
                    "name": image_path.name,
                    "hasDflMetadata": False,
                    "polygonCount": 0,
                    "pointCount": 0,
                    "hasAppliedMask": False,
                    "sourceFilename": None,
                }
            )
    return {"total": len(files), "offset": offset, "limit": limit, "items": items}


def inspect_image(image_path):
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("无法读取 aligned 图片")
    dfl_image = load_dfl_image(image_path)
    return {
        "name": image_path.name,
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "polygons": serialize_polygons(dfl_image),
        "hasAppliedMask": bool(dfl_image.has_xseg_mask()),
        "sourceFilename": dfl_image.get_source_filename(),
    }


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
            "inspect",
            "save",
            "atlas",
            "audit",
            "pack-inspect",
            "coverage",
        ),
    )
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--frames", type=Path)
    parser.add_argument("--file", type=Path)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=60)
    args = parser.parse_args()

    if args.action == "list":
        if args.directory is None or not args.directory.is_dir():
            raise ValueError("aligned 目录不存在")
        emit(list_images(args.directory, max(args.offset, 0), min(max(args.limit, 1), 200)))
        return

    if args.action == "atlas":
        if args.directory is None or not args.directory.is_dir():
            raise ValueError("aligned 目录不存在")
        emit(build_pose_atlas(args.directory))
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

    if args.file is None or not args.file.is_file():
        raise ValueError("aligned 图片不存在")
    if args.action == "inspect":
        emit(inspect_image(args.file))
    else:
        emit(save_annotation(args.file))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(str(error))
        sys.exit(2)
