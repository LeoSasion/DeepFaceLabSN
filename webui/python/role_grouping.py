"""Project-local anonymous face grouping; never modifies aligned files.

SFace embeddings use the OpenCV reference five-point alignment and RGB input.
Complete linkage prevents a chain of weak matches from joining different roles.
Co-occurring faces remain separate. All groups are review candidates.
"""
import hashlib
from pathlib import Path

import cv2
import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import squareform

MODEL_NAME = "face_recognition_sface_2021dec.onnx"
MODEL_SHA256 = "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"
MAX_ITEMS = 2000
REFERENCE_POINTS = np.float32([
    [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
    [41.5493, 92.3655], [70.7299, 92.2041],
])


def cluster_embeddings(embeddings, source_frames, threshold=0.5):
    vectors = np.asarray(embeddings, dtype=np.float32)
    if not len(vectors):
        return []
    if vectors.ndim != 2 or not np.isfinite(vectors).all():
        raise ValueError("Invalid face descriptors")
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    if np.any(norms < 1e-8) or len(source_frames) != len(vectors):
        raise ValueError("Invalid face descriptors or frame references")
    if not np.isfinite(threshold) or not 0.3 <= threshold <= 0.85:
        raise ValueError("Role threshold must be between 0.30 and 0.85")
    if len(vectors) == 1:
        return [[0]]
    vectors = vectors / norms
    distances = np.clip(1.0 - vectors.dot(vectors.T), 0.0, 2.0)
    # Different detections in one source frame cannot silently become one role.
    for index, frame in enumerate(source_frames):
        if frame:
            for other in range(index):
                if frame == source_frames[other]:
                    distances[index, other] = distances[other, index] = 2.0
    np.fill_diagonal(distances, 0)
    labels = fcluster(linkage(squareform(distances, checks=False), method="complete"),
                      t=1.0 - threshold, criterion="distance")
    groups = {}
    for index, label in enumerate(labels):
        groups.setdefault(int(label), []).append(index)
    return sorted(groups.values(), key=lambda group: (-len(group), group[0]))


def aligned_face_input(image, landmarks):
    from core.mathlib import umeyama
    points = np.asarray(landmarks, dtype=np.float32)
    if points.shape != (68, 2) or not np.isfinite(points).all():
        raise ValueError("Missing finite 68-point aligned landmarks")
    five = np.float32([points[36:42].mean(axis=0), points[42:48].mean(axis=0),
                      points[30], points[48], points[54]])
    if np.linalg.norm(five[0] - five[1]) < 2:
        raise ValueError("Degenerate face landmarks")
    transform = umeyama(five, REFERENCE_POINTS, True)[:2]
    if not np.isfinite(transform).all():
        raise ValueError("Invalid face transform")
    return cv2.warpAffine(image, transform, (112, 112), flags=cv2.INTER_LINEAR)


def group_directory(directory, model_path, load_dfl, report, threshold=0.5, limit=MAX_ITEMS):
    directory, model_path = Path(directory), Path(model_path)
    if not np.isfinite(threshold) or not 0.3 <= threshold <= 0.85:
        raise ValueError("角色相似阈值需要在 0.30–0.85 之间")
    paths = sorted(p for p in directory.iterdir()
                   if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    limit = min(max(int(limit), 1), MAX_ITEMS)
    result = dict(method="sface-2021dec-complete-linkage", threshold=threshold,
                  total=len(paths), analyzedCount=0, invalid=[], groups=[],
                  invalidCount=0, groupCount=0,
                  truncated=len(paths) > limit, maxItems=MAX_ITEMS)
    if not paths:
        return result
    if not model_path.is_file():
        raise ValueError("角色分组模型缺失，请点击“准备视觉依赖”后重试")
    if hashlib.sha256(model_path.read_bytes()).hexdigest() != MODEL_SHA256:
        raise ValueError("角色分组模型校验失败，请重新准备视觉依赖")
    cv2.setNumThreads(2)
    net = cv2.dnn.readNetFromONNX(str(model_path))
    net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
    net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
    records, vectors = [], []
    for index, image_path in enumerate(paths[:limit]):
        try:
            if image_path.is_symlink() or not image_path.is_file():
                raise ValueError("不是普通本地图片")
            dfl = load_dfl(image_path)
            image = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError("图片无法解码")
            face = aligned_face_input(image, dfl.get_landmarks())
            net.setInput(cv2.dnn.blobFromImage(face, 1, (112, 112), (0, 0, 0), True, False))
            vector = net.forward().reshape(-1)
            norm = np.linalg.norm(vector)
            if not np.isfinite(vector).all() or norm < 1e-8:
                raise ValueError("人脸特征不可用")
            rect = dfl.get_source_rect()
            valid_rect = rect is not None and np.asarray(rect).shape == (4,) and np.isfinite(rect).all()
            records.append(dict(name=image_path.name, sourceFilename=dfl.get_source_filename(),
                                sourceRect=[float(v) for v in rect] if valid_rect else None))
            vectors.append(vector / norm)
        except Exception as error:
            result["invalid"].append(dict(name=image_path.name, reason=str(error)))
        if index % 10 == 0 or index + 1 == min(len(paths), limit):
            report("role-features", index + 1, min(len(paths), limit), image_path.name)
    report("role-clusters", 0, 1, "按人脸特征整理角色候选")
    groups = cluster_embeddings(vectors, [item["sourceFilename"] for item in records], threshold)
    for indexes in groups:
        features = np.asarray([vectors[index] for index in indexes])
        similarities = features.dot(features.T)
        representative = int(np.argmax(similarities.mean(axis=1)))
        members = []
        for position, index in enumerate(indexes):
            members.append(dict(records[index], representative=position == representative,
                                score=round(float(similarities[position, representative]), 4)))
        names = "\n".join(item["name"] for item in members)
        result["groups"].append(dict(
            id="role-" + hashlib.sha256(names.encode("utf-8")).hexdigest()[:12],
            memberCount=len(members), representative=members[representative]["name"],
            minimumScore=round(float(similarities.min()), 4), members=members,
        ))
    result["analyzedCount"] = len(records)
    result["invalidCount"] = len(result["invalid"])
    result["groupCount"] = len(groups)
    report("role-clusters", 1, 1, "角色候选已生成，请复核")
    return result
