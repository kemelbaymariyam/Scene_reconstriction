# Viewer assets

The scene data used by this project (photos, depth maps, scanner point cloud and
the trained splat) was supplied by the dataset provider and is **not
redistributed** here. Everything under `viewer/public/` except this layout is
git-ignored.

To run the viewer, place the assets like this:

```text
viewer/public/
├── scene/
│   └── scene-c2.ply              # exported Gaussian splat (final C2 model, ~130 MB)
├── dataset/
│   ├── cameras-c2.json           # 240 camera records: id, frame (scan index), yaw, pos, R, pano
│   └── views/                    # 240 source photos, e.g. 000016_pz000_y120_normal.jpg
├── processed/                    # per-frame browser depth data (from preprocess_depth.py)
│   ├── frame_N.json              #   width, height, intrinsics, file names
│   ├── frame_N_depth.f32         #   float32 metric depth
│   ├── frame_N_confidence.f32    #   float32 depth confidence
│   └── frame_N_mask.u8           #   uint8 person mask (non-zero = person)
└── minimap/
    ├── floorplan.png             # top-down raster of the scanner cloud (from generate_minimap.py)
    └── floorplan.json            # world bounds of that raster
```

Then check everything is in place:

```bash
node verify_assets.mjs        # ends with "Verification passed."
```

## Regenerating the derived assets

Both helper scripts run from `viewer/` (`pip install -r viewer/requirements.txt`):

| Output | Command | Inputs |
|---|---|---|
| `public/processed/` | `python scripts/preprocess_depth.py` | `public/dataset/da3/results_output/frame_*.npz` |
| `public/minimap/` | `python scripts/generate_minimap.py` | `public/dataset/cameras.json`, `public/dataset/pointcloud.ply` |
| `public/scene/scene-c2.ply` | `ns-export gaussian-splat` (see `pipeline/scripts/export_splat.sh`) | trained Splatfacto checkpoint |

## Using your own scene

The viewer is not tied to this dataset. Any Splatfacto export plus a camera
file in the same format will work if the captures are grouped into scan
positions with several yaw views each. `frame` is the scan index and `pos`
should be the shared centre of that group. The model path is set in
`viewer/src/main.js` and the camera path in `viewer/src/data.js`.
