import sys
from pathlib import Path
import tempfile
import unittest
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from role_grouping import cluster_embeddings, group_directory


class RoleGroupingContract(unittest.TestCase):
    def test_same_person_and_unrelated_person(self):
        self.assertEqual(cluster_embeddings([[1, 0], [9, 1], [0, 1]],
                                            ["a", "b", "c"]), [[0, 1], [2]])

    def test_cooccurring_faces_cannot_merge(self):
        groups = cluster_embeddings([[1, 0], [1, 0], [1, 0]], ["same", "same", "later"])
        self.assertTrue(all(not {0, 1}.issubset(group) for group in groups))
        self.assertEqual(sorted(sum(groups, [])), [0, 1, 2])

    def test_weak_bridge_does_not_merge_two_people(self):
        angles = np.deg2rad([0, 45, 90])
        vectors = np.stack([np.cos(angles), np.sin(angles)], axis=1)
        groups = cluster_embeddings(vectors, [None] * 3)
        self.assertEqual(len(groups), 2)
        self.assertTrue(all(not {0, 2}.issubset(group) for group in groups))

    def test_stricter_threshold_splits_candidates(self):
        vectors = [[1, 0], [0.7, 0.7]]
        self.assertEqual(len(cluster_embeddings(vectors, ["a", "b"], 0.5)), 1)
        self.assertEqual(len(cluster_embeddings(vectors, ["a", "b"], 0.85)), 2)

    def test_invalid_descriptors_and_thresholds(self):
        for vectors, frames, threshold in [([[0, 0]], [None], .5),
                                            ([[np.nan, 0]], [None], .5),
                                            ([[1, 0]], [], .5),
                                            ([[1, 0]], [None], float("nan")),
                                            ([[1, 0]], [None], 1)]:
            with self.assertRaises(ValueError):
                cluster_embeddings(vectors, frames, threshold)

    def test_empty_directory_needs_no_model(self):
        with tempfile.TemporaryDirectory() as temp:
            result = group_directory(temp, Path(temp) / "missing.onnx", None, None)
            self.assertEqual(result["groups"], [])
            self.assertEqual(result["invalidCount"], 0)
            self.assertFalse(result["truncated"])

    def test_missing_or_corrupt_model_fails_before_images_are_read(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "sample.jpg").write_bytes(b"unchanged")
            model = root / "model.onnx"
            with self.assertRaisesRegex(ValueError, "模型缺失"):
                group_directory(root, model, None, None)
            model.write_bytes(b"not a model")
            with self.assertRaisesRegex(ValueError, "校验失败"):
                group_directory(root, model, None, None)
            self.assertEqual((root / "sample.jpg").read_bytes(), b"unchanged")


if __name__ == "__main__":
    unittest.main()
