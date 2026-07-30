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
    parser.add_argument("action", choices=("list", "inspect", "save"))
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
