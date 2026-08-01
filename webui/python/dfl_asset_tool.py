import argparse
import json
import math
import os
import sys
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
    files = sorted(
        path
        for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() == ".jpg"
    )
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
    files = sorted(
        path
        for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() == ".jpg"
    )
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
    parser.add_argument("action", choices=("list", "inspect", "save", "atlas"))
    parser.add_argument("--directory", type=Path)
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
