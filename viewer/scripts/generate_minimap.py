#!/usr/bin/env python3
"""Generate a browser-ready local floor-plan image from the supplied scanner PLY.

The projection uses the same camera-derived floor frame as the JavaScript viewer,
so scan markers align with the raster background exactly.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from plyfile import PlyData

EPSILON = 1e-8


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, default=Path("public/dataset"))
    parser.add_argument("--output", type=Path, default=Path("public/minimap"))
    parser.add_argument("--width", type=int, default=1200)
    parser.add_argument("--height", type=int, default=880)
    parser.add_argument("--margin", type=float, default=0.65)
    parser.add_argument("--height-min", type=float, default=-0.85)
    parser.add_argument("--height-max", type=float, default=0.85)
    parser.add_argument("--max-points", type=int, default=2_000_000)
    return parser.parse_args()


def normalize(vector: np.ndarray) -> np.ndarray:
    length = float(np.linalg.norm(vector))
    if length <= EPSILON:
        raise ValueError("Cannot normalize a zero-length vector")
    return vector / length


def median(values: list[float]) -> float:
    return float(np.median(np.asarray(values, dtype=np.float64)))


def grouped_scan_centres(cameras: list[dict]) -> list[np.ndarray]:
    groups: dict[object, list[dict]] = defaultdict(list)
    for camera in cameras:
        groups[camera["frame"]].append(camera)

    centres: list[np.ndarray] = []
    for key in sorted(groups, key=lambda value: int(value)):
        group = groups[key]
        centre = np.asarray(
            [median([float(entry["pos"][axis]) for entry in group]) for axis in range(3)],
            dtype=np.float64,
        )
        centres.append(centre)
    return centres


def derive_scene_frame(cameras: list[dict], centres: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    average_down = np.zeros(3, dtype=np.float64)
    for camera in cameras:
        rotation = np.asarray(camera["R"], dtype=np.float64)
        average_down += rotation[:, 1]

    if float(np.dot(average_down, average_down)) > EPSILON:
        up = -normalize(average_down)
    else:
        up = np.asarray([0.0, -1.0, 0.0], dtype=np.float64)

    origin = np.mean(np.stack(centres), axis=0)

    best = None
    best_length_sq = 0.0
    for first in range(len(centres)):
        for second in range(first + 1, len(centres)):
            difference = centres[second] - centres[first]
            difference = difference - up * float(np.dot(difference, up))
            length_sq = float(np.dot(difference, difference))
            if length_sq > best_length_sq:
                best_length_sq = length_sq
                best = difference.copy()

    if best is None or best_length_sq <= EPSILON:
        candidate = np.asarray([0.0, 1.0, 0.0], dtype=np.float64)
        if abs(float(np.dot(candidate, up))) > 0.9:
            candidate = np.asarray([1.0, 0.0, 0.0], dtype=np.float64)
        best = candidate - up * float(np.dot(candidate, up))

    axis_u = normalize(best)
    axis_v = normalize(np.cross(up, axis_u))
    return up, origin, axis_u, axis_v


def project(points: np.ndarray, origin: np.ndarray, axis_u: np.ndarray, axis_v: np.ndarray) -> np.ndarray:
    relative = points - origin[None, :]
    return np.column_stack((relative @ axis_u, relative @ axis_v))


def aspect_adjusted_bounds(
    minimum: np.ndarray,
    maximum: np.ndarray,
    width: int,
    height: int,
) -> tuple[float, float, float, float]:
    centre = (minimum + maximum) * 0.5
    size = np.maximum(maximum - minimum, 1e-3)
    target_aspect = width / height
    current_aspect = float(size[0] / size[1])

    if current_aspect < target_aspect:
        size[0] = size[1] * target_aspect
    else:
        size[1] = size[0] / target_aspect

    return (
        float(centre[0] - size[0] * 0.5),
        float(centre[0] + size[0] * 0.5),
        float(centre[1] - size[1] * 0.5),
        float(centre[1] + size[1] * 0.5),
    )


def main() -> None:
    args = parse_args()
    cameras_path = args.dataset / "cameras.json"
    cloud_path = args.dataset / "pointcloud.ply"

    if not cameras_path.exists():
        raise SystemExit(f"Missing {cameras_path}")
    if not cloud_path.exists():
        raise SystemExit(f"Missing {cloud_path}")

    cameras = json.loads(cameras_path.read_text(encoding="utf-8"))
    centres = grouped_scan_centres(cameras)
    up, origin, axis_u, axis_v = derive_scene_frame(cameras, centres)

    scan_xy = project(np.stack(centres), origin, axis_u, axis_v)
    minimum = scan_xy.min(axis=0) - args.margin
    maximum = scan_xy.max(axis=0) + args.margin
    min_x, max_x, min_y, max_y = aspect_adjusted_bounds(minimum, maximum, args.width, args.height)

    ply = PlyData.read(str(cloud_path))
    vertex = ply["vertex"]
    names = set(vertex.data.dtype.names or [])
    xyz = np.column_stack((vertex["x"], vertex["y"], vertex["z"])).astype(np.float64)

    finite = np.isfinite(xyz).all(axis=1)
    relative = xyz - origin[None, :]
    heights = relative @ up
    xy = np.column_stack((relative @ axis_u, relative @ axis_v))
    inside = (
        finite
        & (heights >= args.height_min)
        & (heights <= args.height_max)
        & (xy[:, 0] >= min_x)
        & (xy[:, 0] <= max_x)
        & (xy[:, 1] >= min_y)
        & (xy[:, 1] <= max_y)
    )

    xyz = xyz[inside]
    xy = xy[inside]
    if len(xy) == 0:
        raise SystemExit("The local floor-plan crop contains zero scanner points")

    if len(xy) > args.max_points:
        rng = np.random.default_rng(42)
        keep = rng.choice(len(xy), args.max_points, replace=False)
        xy = xy[keep]
        source_indices = np.flatnonzero(inside)[keep]
    else:
        source_indices = np.flatnonzero(inside)

    has_rgb = {"red", "green", "blue"}.issubset(names)
    if has_rgb:
        rgb = np.column_stack(
            (
                np.asarray(vertex["red"])[source_indices],
                np.asarray(vertex["green"])[source_indices],
                np.asarray(vertex["blue"])[source_indices],
            )
        ).astype(np.float64)
    else:
        rgb = np.full((len(xy), 3), 180.0, dtype=np.float64)

    width = args.width
    height = args.height
    px = np.clip(((xy[:, 0] - min_x) / (max_x - min_x) * (width - 1)).astype(np.int64), 0, width - 1)
    py = np.clip(((max_y - xy[:, 1]) / (max_y - min_y) * (height - 1)).astype(np.int64), 0, height - 1)
    flat = py * width + px

    counts = np.bincount(flat, minlength=width * height).astype(np.float64)
    sums = np.zeros((width * height, 3), dtype=np.float64)
    for channel in range(3):
        sums[:, channel] = np.bincount(flat, weights=rgb[:, channel], minlength=width * height)

    occupied = counts > 0
    average = np.zeros_like(sums)
    average[occupied] = sums[occupied] / counts[occupied, None]

    density = np.log1p(counts)
    positive_density = density[occupied]
    scale = float(np.percentile(positive_density, 97)) if len(positive_density) else 1.0
    density = np.clip(density / max(scale, 1e-6), 0.0, 1.0)

    background = np.asarray([8.0, 15.0, 24.0], dtype=np.float64)
    tint = np.asarray([56.0, 83.0, 105.0], dtype=np.float64)
    toned = average * 0.62 + tint[None, :] * 0.38
    alpha = np.where(occupied, 0.22 + 0.78 * np.sqrt(density), 0.0)
    image = background[None, :] * (1.0 - alpha[:, None]) + toned * alpha[:, None]
    image = np.clip(image.reshape(height, width, 3), 0, 255).astype(np.uint8)

    pil_image = Image.fromarray(image, mode="RGB")
    # A tiny blur removes isolated scanner speckle without erasing room structure.
    pil_image = pil_image.filter(ImageFilter.GaussianBlur(radius=0.45))

    draw = ImageDraw.Draw(pil_image, "RGBA")
    grid_spacing = 100
    for x in range(0, width, grid_spacing):
        draw.line([(x, 0), (x, height)], fill=(130, 165, 190, 20), width=1)
    for y in range(0, height, grid_spacing):
        draw.line([(0, y), (width, y)], fill=(130, 165, 190, 20), width=1)

    args.output.mkdir(parents=True, exist_ok=True)
    image_path = args.output / "floorplan.png"
    metadata_path = args.output / "floorplan.json"
    pil_image.save(image_path, optimize=True)

    metadata = {
        "image": image_path.name,
        "width": width,
        "height": height,
        "bounds": {
            "minX": min_x,
            "maxX": max_x,
            "minY": min_y,
            "maxY": max_y,
        },
        "slice": {
            "heightMin": args.height_min,
            "heightMax": args.height_max,
        },
        "source": "dataset/pointcloud.ply",
    }
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print(f"Scanner vertices in minimap slice: {len(xy):,}")
    print(f"Written: {image_path}")
    print(f"Written: {metadata_path}")


if __name__ == "__main__":
    main()
