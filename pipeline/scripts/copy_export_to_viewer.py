from __future__ import annotations

import argparse
import shutil
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument(
        "--destination",
        type=Path,
        default=Path("viewer/public/scene/scene.ply"),
    )
    args = parser.parse_args()

    if not args.source.exists():
        raise FileNotFoundError(args.source)

    args.destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(args.source, args.destination)
    print(f"Copied {args.source} -> {args.destination}")


if __name__ == "__main__":
    main()
