#!/usr/bin/env python3
"""Convert DA3 NPZ frames into browser-friendly depth/confidence/mask arrays."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, default=Path("public/dataset"))
    parser.add_argument("--output", type=Path, default=Path("public/processed"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    frames_dir = args.dataset / "da3" / "results_output"
    frame_paths = sorted(
        frames_dir.glob("frame_*.npz"),
        key=lambda path: int(path.stem.split("_")[1]),
    )
    if not frame_paths:
        raise SystemExit(f"No frame_*.npz files found in {frames_dir}")

    args.output.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict] = {}

    for frame_path in frame_paths:
        frame_id = int(frame_path.stem.split("_")[1])
        with np.load(frame_path) as frame:
            depth = np.asarray(frame["depth"], dtype="<f4")
            confidence = np.asarray(frame["conf"], dtype="<f4")
            mask = np.asarray(frame["person_mask"], dtype=np.uint8)
            intrinsics = np.asarray(frame["intrinsics"], dtype=np.float32)

        if depth.shape != confidence.shape or depth.shape != mask.shape:
            raise ValueError(f"Shape mismatch in {frame_path}")
        if intrinsics.shape != (3, 3):
            raise ValueError(f"Unexpected intrinsics shape in {frame_path}: {intrinsics.shape}")

        depth_name = f"frame_{frame_id}_depth.f32"
        confidence_name = f"frame_{frame_id}_confidence.f32"
        mask_name = f"frame_{frame_id}_mask.u8"
        metadata_name = f"frame_{frame_id}.json"

        depth.tofile(args.output / depth_name)
        confidence.tofile(args.output / confidence_name)
        mask.tofile(args.output / mask_name)

        metadata = {
            "frameId": frame_id,
            "width": int(depth.shape[1]),
            "height": int(depth.shape[0]),
            "intrinsics": intrinsics.tolist(),
            "depthFile": depth_name,
            "confidenceFile": confidence_name,
            "maskFile": mask_name,
        }
        (args.output / metadata_name).write_text(json.dumps(metadata), encoding="utf-8")
        manifest[str(frame_id)] = metadata
        print(f"Processed frame {frame_id}")

    (args.output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    print(f"Written {len(frame_paths)} browser depth frames to {args.output}")


if __name__ == "__main__":
    main()
