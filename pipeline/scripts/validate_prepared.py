from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path("prepared"))
    return parser.parse_args()


def inspect_ply_vertex_count(path: Path) -> int:
    with path.open("rb") as handle:
        for raw_line in handle:
            line = raw_line.decode("ascii").strip()
            if line.startswith("element vertex "):
                return int(line.split()[-1])
            if line == "end_header":
                break
    raise ValueError(f"No vertex declaration found in {path}")


def main() -> None:
    args = parse_args()
    transforms_path = args.data / "transforms.json"
    transforms = json.loads(transforms_path.read_text(encoding="utf-8"))
    frames = transforms.get("frames", [])

    if not frames:
        raise ValueError("No frames in transforms.json")

    seen = set()
    positions = []
    forward_vectors = []

    for index, frame in enumerate(frames):
        for key in (
            "file_path",
            "mask_path",
            "depth_file_path",
            "transform_matrix",
            "fl_x",
            "fl_y",
            "cx",
            "cy",
            "w",
            "h",
        ):
            if key not in frame:
                raise ValueError(f"Frame {index} lacks {key}")

        image_path = args.data / frame["file_path"]
        mask_path = args.data / frame["mask_path"]
        depth_path = args.data / frame["depth_file_path"]

        for path in (image_path, mask_path, depth_path):
            if not path.exists():
                raise FileNotFoundError(path)

        image = np.asarray(Image.open(image_path))
        mask = np.asarray(Image.open(mask_path))
        depth = np.asarray(Image.open(depth_path))

        expected_shape = (int(frame["h"]), int(frame["w"]))
        if image.shape[:2] != expected_shape:
            raise ValueError(f"RGB size mismatch: {image_path}")
        if mask.shape != expected_shape:
            raise ValueError(f"Mask size mismatch: {mask_path}")
        if depth.shape != expected_shape:
            raise ValueError(f"Depth size mismatch: {depth_path}")

        matrix = np.asarray(frame["transform_matrix"], dtype=np.float64)
        if matrix.shape != (4, 4):
            raise ValueError(f"Bad transform shape in frame {index}")
        if not np.allclose(matrix[3], [0, 0, 0, 1], atol=1e-7):
            raise ValueError(f"Bad homogeneous row in frame {index}")
        if not np.allclose(matrix[:3, :3].T @ matrix[:3, :3], np.eye(3), atol=1e-3):
            raise ValueError(f"Rotation not orthonormal in frame {index}")

        # In Nerfstudio/OpenGL convention, camera forward is -Z.
        forward = -matrix[:3, 2]
        forward_vectors.append(forward)
        positions.append(matrix[:3, 3])

        key = frame["file_path"]
        if key in seen:
            raise ValueError(f"Duplicate image path {key}")
        seen.add(key)

    positions = np.asarray(positions)
    forward_vectors = np.asarray(forward_vectors)

    position_span = np.ptp(positions, axis=0)
    norm_error = np.max(np.abs(np.linalg.norm(forward_vectors, axis=1) - 1.0))

    print(f"Frames: {len(frames)}")
    print(f"Camera position span: {position_span.tolist()}")
    print(f"Maximum forward-vector norm error: {norm_error:.3g}")

    ply_rel = transforms.get("ply_file_path")
    if ply_rel:
        ply_path = args.data / ply_rel
        if not ply_path.exists():
            raise FileNotFoundError(ply_path)
        print(f"Initialization PLY vertices: {inspect_ply_vertex_count(ply_path):,}")

    masks = [np.asarray(Image.open(args.data / f["mask_path"])) for f in frames[:12]]
    masked_fraction = np.mean([np.mean(mask == 0) for mask in masks])
    print(f"Mean ignored fraction in first 12 masks: {masked_fraction:.3%}")

    print("Prepared dataset validation passed.")


if __name__ == "__main__":
    main()
