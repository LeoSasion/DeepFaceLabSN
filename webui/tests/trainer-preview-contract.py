"""Exercise the real file bridge without importing the training runtime."""
import ast
import json
import os
import tempfile
from pathlib import Path

import cv2
import numpy as np


source_path = Path(__file__).resolve().parents[2] / '_internal/DeepFaceLab_old/mainscripts/Trainer.py'
module = ast.parse(source_path.read_text(encoding='utf-8'))
bridge_class = next(node for node in module.body if isinstance(node, ast.ClassDef) and node.name == 'WebTrainerBridge')
module.body = [bridge_class]
scope = {'os': os, 'Path': Path, 'json': json, 'np': np, 'cv2': cv2}
exec(compile(module, str(source_path), 'exec'), scope)

with tempfile.TemporaryDirectory() as directory:
    target = Path(directory) / 'nested/preview.png'
    bridge = scope['WebTrainerBridge']()
    bridge.preview_path = target
    # BGR red, green, blue, plus values requiring clipping.
    sample = np.array([[[0, 0, 1], [0, 1, 0], [1, 0, 0], [-1, 2, 0.5]]], dtype=np.float32)
    bridge.write_preview([('SAEHD', sample)])
    decoded = cv2.imread(str(target))
    np.testing.assert_array_equal(decoded, [[[0, 0, 255], [0, 255, 0], [255, 0, 0], [0, 255, 127]]])
    assert not target.with_suffix('.png.tmp').exists()
    bridge.write_preview([('SAEHD', np.zeros_like(sample))])
    assert not cv2.imread(str(target)).any(), 'A refreshed preview must replace the previous PNG'
    bridge.write_preview([])
    assert target.exists(), 'An empty preview must preserve the last saved frame'

print('Trainer preview preserves BGR colors, clipping, and atomic refresh')
