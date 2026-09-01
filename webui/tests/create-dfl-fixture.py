"""Create a tiny deterministic DFL workspace for isolated WebUI tests.

The fixture deliberately contains generated geometric faces only.  It must never
read from or write to a user's real ``workspace`` directory.
"""

import argparse
import math
import os
import sys
from pathlib import Path

import cv2
import numpy as np


def _landmarks(size, offset_x=0.0, offset_y=0.0, scale=1.0):
    points = []

    # Jaw, eyebrows, nose, eyes and mouth in the canonical 68-point order.
    for index in range(17):
        angle = math.pi * index / 16.0
        points.append((
            34.0 + (188.0 * index / 16.0),
            88.0 + 132.0 * math.sin(angle),
        ))
    points.extend([(58, 81), (72, 73), (88, 72), (102, 77), (112, 84)])
    points.extend([(144, 84), (154, 77), (168, 72), (184, 73), (198, 81)])
    points.extend([(128, 91), (128, 108), (128, 126), (128, 143)])
    points.extend([(105, 151), (116, 157), (128, 160), (140, 157), (151, 151)])
    points.extend([(73, 105), (84, 98), (96, 99), (105, 108), (96, 114), (84, 113)])
    points.extend([(151, 108), (160, 99), (172, 98), (183, 105), (172, 113), (160, 114)])
    points.extend([
        (87, 177), (101, 169), (116, 166), (128, 169), (140, 166), (155, 169),
        (169, 177), (155, 190), (140, 196), (128, 197), (116, 196), (101, 190),
        (94, 179), (116, 177), (128, 179), (140, 177), (162, 179), (140, 187),
        (128, 189), (116, 187),
    ])
    if len(points) != 68:
        raise RuntimeError("fixture landmark template must contain 68 points")
    return [
        [float(x * scale + offset_x), float(y * scale + offset_y)]
        for x, y in points
    ]


def _draw_face(size, seed, source=False):
    rng = np.random.RandomState(seed)
    image = np.zeros((size, size, 3), dtype=np.uint8)
    image[:] = (28 + seed * 5, 38 + seed * 3, 54 + seed * 2)
    center = (size // 2, int(size * 0.52))
    axes = (int(size * 0.31), int(size * 0.39))
    skin = (132 + seed * 3, 174 + seed * 2, 204 + seed * 2)
    cv2.ellipse(image, center, axes, 0, 0, 360, skin, -1, cv2.LINE_AA)
    eye_y = int(size * 0.43)
    eye_dx = int(size * 0.12)
    eye_r = max(2, int(size * 0.018))
    cv2.circle(image, (center[0] - eye_dx, eye_y), eye_r, (25, 35, 45), -1, cv2.LINE_AA)
    cv2.circle(image, (center[0] + eye_dx, eye_y), eye_r, (25, 35, 45), -1, cv2.LINE_AA)
    cv2.ellipse(
        image,
        (center[0], int(size * 0.68)),
        (int(size * 0.10), int(size * 0.035)),
        0,
        0,
        180,
        (45, 55, 105),
        max(1, int(size * 0.012)),
        cv2.LINE_AA,
    )
    noise = rng.normal(0.0, 2.0 if source else 1.0, image.shape).astype(np.int16)
    return np.clip(image.astype(np.int16) + noise, 0, 255).astype(np.uint8)


def _write_image(path, image):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), image):
        raise RuntimeError("failed to write fixture image: {}".format(path))


def _write_aligned(path, frame_name, seed, dfl_jpg):
    aligned = _draw_face(256, seed)
    _write_image(path, aligned)
    metadata = dfl_jpg.load(str(path))
    if metadata is None:
        raise RuntimeError("failed to load generated JPEG: {}".format(path))
    metadata.set_dict({})
    metadata.set_face_type("whole_face")
    metadata.set_landmarks(_landmarks(256))
    metadata.set_source_filename(frame_name)
    source_landmarks = _landmarks(512, offset_x=64.0, offset_y=48.0, scale=1.5)
    metadata.set_source_landmarks(source_landmarks)
    metadata.set_source_rect([64.0, 48.0, 448.0, 448.0])
    metadata.set_image_to_face_mat([
        [2.0 / 3.0, 0.0, -128.0 / 3.0],
        [0.0, 2.0 / 3.0, -32.0],
    ])
    if seed % 2 == 0:
        mask = np.zeros((256, 256, 1), dtype=np.float32)
        cv2.ellipse(mask, (128, 132), (80, 102), 0, 0, 360, (1.0,), -1)
        metadata.set_xseg_mask(mask)
    metadata.save()


def create_fixture(workspace, dfl_root):
    sys.path.insert(0, str(dfl_root))
    from DFLIMG import DFLJPG  # pylint: disable=import-outside-toplevel

    workspace.mkdir(parents=True, exist_ok=True)
    for relative in [
        "data_src/aligned",
        "data_dst/aligned",
        "data_dst/merged",
        "data_dst/merged_mask",
        "model",
        "xseg_model",
        ".webui",
    ]:
        (workspace / relative).mkdir(parents=True, exist_ok=True)

    # Command construction only needs an allowlisted material name; no test
    # decodes these placeholders as video.
    (workspace / "data_src.mp4").write_bytes(b"DFLSN_TEST_VIDEO_SRC".ljust(64, b"\0"))
    (workspace / "data_dst.mp4").write_bytes(b"DFLSN_TEST_VIDEO_DST".ljust(64, b"\0"))

    for side, base_seed in (("src", 1), ("dst", 11)):
        frame_root = workspace / ("data_" + side)
        for index in range(3):
            frame_name = "{:06d}.png".format(index)
            frame = _draw_face(512, base_seed + index, source=True)
            _write_image(frame_root / frame_name, frame)
            _write_aligned(
                frame_root / "aligned" / "{:06d}_0.jpg".format(index),
                frame_name,
                base_seed + index,
                DFLJPG,
            )
            if side == "dst":
                _write_image(frame_root / "merged" / frame_name, frame)
                mask = np.zeros((512, 512, 3), dtype=np.uint8)
                cv2.circle(mask, (256, 256), 170, (255, 255, 255), -1, cv2.LINE_AA)
                _write_image(frame_root / "merged_mask" / frame_name, mask)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--fixture-root", required=True, type=Path)
    parser.add_argument("--dfl-root", required=True, type=Path)
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    fixture_root = args.fixture_root.resolve()
    dfl_root = args.dfl_root.resolve()
    if not any(
        parent.name.startswith("dflsn-webui-tests-")
        for parent in (fixture_root,) + tuple(fixture_root.parents)
    ):
        raise RuntimeError("fixture root is not a generated DFL test directory")
    try:
        within_fixture = os.path.commonpath((str(workspace), str(fixture_root))) == str(fixture_root)
    except ValueError:
        within_fixture = False
    if not within_fixture or workspace == fixture_root:
        raise RuntimeError("refusing to create a workspace outside the isolated fixture root")
    create_fixture(workspace, dfl_root)
    print("created deterministic DFL fixture at {}".format(workspace))


if __name__ == "__main__":
    main()
