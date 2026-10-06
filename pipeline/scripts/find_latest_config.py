from __future__ import annotations

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--outputs", type=Path, default=Path("outputs"))
    args = parser.parse_args()

    configs = list(args.outputs.rglob("config.yml"))
    if not configs:
        raise SystemExit(f"No config.yml found below {args.outputs}")

    latest = max(configs, key=lambda path: path.stat().st_mtime)
    print(latest)


if __name__ == "__main__":
    main()
