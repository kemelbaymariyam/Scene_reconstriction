from __future__ import annotations

import argparse
import json
import math
import shutil
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image


@dataclass
class FrameResult:
    frame_id: int
    image_path: str
    mask_path: str
    depth_path: str
    valid_pixels: int
    confidence_threshold: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert InfraScan DA3 outputs to Nerfstudio/DN-Splatter format."
    )
    parser.add_argument("--dataset", type=Path, default=Path("dataset"))
    parser.add_argument("--output", type=Path, default=Path("prepared"))
    parser.add_argument("--stride", type=int, default=2)
    parser.add_argument("--voxel-size", type=float, default=0.02)
    parser.add_argument("--confidence-quantile", type=float, default=0.20)
    parser.add_argument("--min-depth", type=float, default=0.10)
    parser.add_argument("--max-depth", type=float, default=20.0)
    parser.add_argument("--max-init-points", type=int, default=1_500_000)
    parser.add_argument(
        "--skip-initialization-cloud",
        action="store_true",
        help="Write images/depth/masks/transforms but not initialization.ply.",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.stride < 1:
        raise ValueError("--stride must be at least 1")
    if args.voxel_size <= 0:
        raise ValueError("--voxel-size must be positive")
    if not 0 <= args.confidence_quantile < 1:
        raise ValueError("--confidence-quantile must be in [0, 1)")
    if args.min_depth <= 0 or args.max_depth <= args.min_depth:
        raise ValueError("Invalid depth range")


def opencv_c2w_to_nerfstudio(c2w_cv: np.ndarray) -> np.ndarray:
    """Convert OpenCV camera axes to OpenGL/Blender camera axes.

    Input camera axes: +X right, +Y down, +Z forward.
    Output axes:       +X right, +Y up,   -Z forward.

    World coordinates are deliberately left unchanged.
    """
    axis_conversion = np.diag([1.0, -1.0, -1.0, 1.0])
    return c2w_cv @ axis_conversion


def camera_matrix(camera: dict) -> np.ndarray:
    result = np.eye(4, dtype=np.float64)
    result[:3, :3] = np.asarray(camera["R"], dtype=np.float64)
    result[:3, 3] = np.asarray(camera["pos"], dtype=np.float64)
    return result


def write_binary_ply(path: Path, points: np.ndarray, colors: np.ndarray) -> None:
    if len(points) != len(colors):
        raise ValueError("Point and color arrays differ in length")

    path.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        f"element vertex {len(points)}\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "property uchar red\n"
        "property uchar green\n"
        "property uchar blue\n"
        "end_header\n"
    ).encode("ascii")

    vertices = np.empty(
        len(points),
        dtype=[
            ("x", "<f4"),
            ("y", "<f4"),
            ("z", "<f4"),
            ("red", "u1"),
            ("green", "u1"),
            ("blue", "u1"),
        ],
    )
    vertices["x"] = points[:, 0]
    vertices["y"] = points[:, 1]
    vertices["z"] = points[:, 2]
    vertices["red"] = colors[:, 0]
    vertices["green"] = colors[:, 1]
    vertices["blue"] = colors[:, 2]

    with path.open("wb") as handle:
        handle.write(header)
        vertices.tofile(handle)


def voxel_downsample(
    points: np.ndarray, colors: np.ndarray, voxel_size: float
) -> tuple[np.ndarray, np.ndarray]:
    """Average positions and colors per voxel using a vectorized sort."""
    if len(points) == 0:
        return points, colors

    voxel_keys = np.floor(points / voxel_size).astype(np.int64)
    order = np.lexsort((voxel_keys[:, 2], voxel_keys[:, 1], voxel_keys[:, 0]))
    keys = voxel_keys[order]
    pts = points[order]
    cols = colors[order].astype(np.float64)

    starts = np.empty(len(keys), dtype=bool)
    starts[0] = True
    starts[1:] = np.any(keys[1:] != keys[:-1], axis=1)
    group_starts = np.flatnonzero(starts)
    counts = np.diff(np.append(group_starts, len(keys)))

    point_sums = np.add.reduceat(pts, group_starts, axis=0)
    color_sums = np.add.reduceat(cols, group_starts, axis=0)

    out_points = point_sums / counts[:, None]
    out_colors = np.clip(
        np.rint(color_sums / counts[:, None]), 0, 255
    ).astype(np.uint8)
    return out_points.astype(np.float32), out_colors


def reservoir_cap(
    points: np.ndarray,
    colors: np.ndarray,
    maximum: int,
    seed: int = 7,
) -> tuple[np.ndarray, np.ndarray]:
    if len(points) <= maximum:
        return points, colors
    rng = np.random.default_rng(seed)
    selected = rng.choice(len(points), size=maximum, replace=False)
    return points[selected], colors[selected]


def create_directories(output: Path) -> None:
    for name in ("images", "masks", "depths"):
        (output / name).mkdir(parents=True, exist_ok=True)


def save_uint16_depth_mm(depth_m: np.ndarray, valid: np.ndarray, path: Path) -> None:
    depth_mm = np.zeros(depth_m.shape, dtype=np.uint16)
    safe_mm = np.clip(np.rint(depth_m[valid] * 1000.0), 1, 65535)
    depth_mm[valid] = safe_mm.astype(np.uint16)
    Image.fromarray(depth_mm, mode="I;16").save(path)


def prepare_frame(
    camera: dict,
    dataset: Path,
    output: Path,
    args: argparse.Namespace,
) -> tuple[dict, FrameResult, np.ndarray, np.ndarray]:
    frame_id = int(camera["id"])
    npz_path = dataset / "da3" / "results_output" / f"frame_{frame_id}.npz"
    if not npz_path.exists():
        raise FileNotFoundError(npz_path)

    with np.load(npz_path) as frame:
        image = np.asarray(frame["image"], dtype=np.uint8)
        depth = np.asarray(frame["depth"], dtype=np.float32)
        confidence = np.asarray(frame["conf"], dtype=np.float32)
        person_mask = np.asarray(frame["person_mask"], dtype=np.uint8)
        intrinsics = np.asarray(frame["intrinsics"], dtype=np.float64)

    if image.shape[:2] != depth.shape:
        raise ValueError(f"RGB/depth shape mismatch in frame {frame_id}")
    if confidence.shape != depth.shape or person_mask.shape != depth.shape:
        raise ValueError(f"Auxiliary map shape mismatch in frame {frame_id}")

    finite_conf = confidence[np.isfinite(confidence)]
    confidence_threshold = (
        float(np.quantile(finite_conf, args.confidence_quantile))
        if finite_conf.size
        else -math.inf
    )

    valid = (
        np.isfinite(depth)
        & np.isfinite(confidence)
        & (depth >= args.min_depth)
        & (depth <= args.max_depth)
        & (confidence >= confidence_threshold)
        & (person_mask == 0)
    )

    stem = f"frame_{frame_id:04d}"
    image_rel = Path("images") / f"{stem}.png"
    mask_rel = Path("masks") / f"{stem}.png"
    depth_rel = Path("depths") / f"{stem}.png"

    Image.fromarray(image, mode="RGB").save(output / image_rel)

    # Nerfstudio semantics: white pixels are included, black pixels ignored.
    training_mask = np.where(person_mask == 0, 255, 0).astype(np.uint8)
    Image.fromarray(training_mask, mode="L").save(output / mask_rel)

    # Zero depth is unknown. Save millimetres as expected by Nerfstudio.
    save_uint16_depth_mm(depth, valid, output / depth_rel)

    c2w_cv = camera_matrix(camera)
    c2w_ns = opencv_c2w_to_nerfstudio(c2w_cv)

    h, w = depth.shape
    frame_json = {
        "file_path": image_rel.as_posix(),
        "mask_path": mask_rel.as_posix(),
        "depth_file_path": depth_rel.as_posix(),
        "transform_matrix": c2w_ns.tolist(),
        "fl_x": float(intrinsics[0, 0]),
        "fl_y": float(intrinsics[1, 1]),
        "cx": float(intrinsics[0, 2]),
        "cy": float(intrinsics[1, 2]),
        "w": int(w),
        "h": int(h),
    }

    sampled = valid[:: args.stride, :: args.stride]
    if not np.any(sampled):
        points_world = np.empty((0, 3), dtype=np.float32)
        colors = np.empty((0, 3), dtype=np.uint8)
    else:
        vv, uu = np.meshgrid(
            np.arange(0, h, args.stride, dtype=np.float32),
            np.arange(0, w, args.stride, dtype=np.float32),
            indexing="ij",
        )
        sampled_depth = depth[:: args.stride, :: args.stride]
        z = sampled_depth[sampled]
        x = (uu[sampled] - intrinsics[0, 2]) * z / intrinsics[0, 0]
        y = (vv[sampled] - intrinsics[1, 2]) * z / intrinsics[1, 1]
        points_camera = np.stack((x, y, z), axis=1)

        # Build the initialization PLY in the original dataset world frame.
        # p_world = R @ p_camera + position.
        rotation = c2w_cv[:3, :3]
        position = c2w_cv[:3, 3]
        points_world = points_camera @ rotation.T + position[None, :]
        colors = image[:: args.stride, :: args.stride][sampled]

    result = FrameResult(
        frame_id=frame_id,
        image_path=image_rel.as_posix(),
        mask_path=mask_rel.as_posix(),
        depth_path=depth_rel.as_posix(),
        valid_pixels=int(valid.sum()),
        confidence_threshold=confidence_threshold,
    )
    return frame_json, result, points_world.astype(np.float32), colors


def main() -> None:
    args = parse_args()
    validate_args(args)

    cameras_path = args.dataset / "cameras.json"
    if not cameras_path.exists():
        raise FileNotFoundError(cameras_path)

    cameras = json.loads(cameras_path.read_text(encoding="utf-8"))
    if not isinstance(cameras, list) or not cameras:
        raise ValueError("cameras.json must contain a non-empty array")

    ids = [int(camera["id"]) for camera in cameras]
    if len(ids) != len(set(ids)):
        raise ValueError("Camera IDs are not unique")

    cameras.sort(key=lambda item: int(item["id"]))
    args.output.mkdir(parents=True, exist_ok=True)
    create_directories(args.output)

    frames_json: list[dict] = []
    reports: list[FrameResult] = []
    point_batches: list[np.ndarray] = []
    color_batches: list[np.ndarray] = []

    for index, camera in enumerate(cameras):
        frame_json, report, points, colors = prepare_frame(
            camera, args.dataset, args.output, args
        )
        frames_json.append(frame_json)
        reports.append(report)

        if not args.skip_initialization_cloud and len(points):
            point_batches.append(points)
            color_batches.append(colors)

        print(
            f"[{index + 1:03d}/{len(cameras):03d}] frame {report.frame_id}: "
            f"{report.valid_pixels} valid pixels, "
            f"confidence >= {report.confidence_threshold:.5g}"
        )

    transforms = {
        "camera_model": "OPENCV",
        "ply_file_path": "initialization.ply"
        if not args.skip_initialization_cloud
        else None,
        "frames": frames_json,
    }
    if transforms["ply_file_path"] is None:
        del transforms["ply_file_path"]

    (args.output / "transforms.json").write_text(
        json.dumps(transforms, indent=2), encoding="utf-8"
    )

    initialization_count = 0
    if not args.skip_initialization_cloud:
        if not point_batches:
            raise RuntimeError("No valid initialization points were generated")

        points = np.concatenate(point_batches, axis=0)
        colors = np.concatenate(color_batches, axis=0)
        print(f"Accumulated {len(points):,} sampled depth points")

        points, colors = voxel_downsample(points, colors, args.voxel_size)
        print(f"Voxel-downsampled to {len(points):,} points")

        points, colors = reservoir_cap(
            points, colors, maximum=args.max_init_points
        )
        print(f"Initialization cloud contains {len(points):,} points")

        write_binary_ply(args.output / "initialization.ply", points, colors)
        initialization_count = len(points)

    report_json = {
        "dataset": str(args.dataset),
        "frame_count": len(frames_json),
        "initialization_points": initialization_count,
        "stride": args.stride,
        "voxel_size_m": args.voxel_size,
        "confidence_quantile": args.confidence_quantile,
        "depth_range_m": [args.min_depth, args.max_depth],
        "frames": [
            {
                "frame_id": item.frame_id,
                "image_path": item.image_path,
                "mask_path": item.mask_path,
                "depth_path": item.depth_path,
                "valid_pixels": item.valid_pixels,
                "confidence_threshold": item.confidence_threshold,
            }
            for item in reports
        ],
    }
    (args.output / "preparation_report.json").write_text(
        json.dumps(report_json, indent=2), encoding="utf-8"
    )

    print(f"Prepared dataset written to: {args.output.resolve()}")


if __name__ == "__main__":
    main()
