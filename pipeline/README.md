# Reconstruction pipeline

Training-side code and records. Training runs on Linux/WSL2 with an NVIDIA GPU
and Nerfstudio; the browser viewer does not need any of this.

| Path | Contents |
|---|---|
| `scripts/prepare_dataset.py` | Converts the DA3 output (`cameras.json`, `frame_N.npz`) into a Nerfstudio dataset: RGB views, inverse person masks, 16-bit mm depth PNGs, OpenCV→OpenGL camera conversion, `transforms.json`, optional confidence-filtered initialisation cloud |
| `scripts/validate_prepared.py` | Sanity checks for the prepared dataset |
| `scripts/train_dn_splatter.sh` | Early DN-Splatter training command (depth-supervised pilot, later rejected) |
| `scripts/find_latest_config.py`, `export_splat.sh`, `copy_export_to_viewer.py` | Locate a run, export the Gaussian splat `.ply`, copy it into the viewer |
| `configs/reference/` | Nerfstudio `config.yml` files recorded from the experiment runs (Splatfacto and DN-Splatter) |
| `environment/` | Python requirements for preprocessing |

## Final model (C2)

```text
ns-train splatfacto
  · initialisation: coloured scanner point cloud
  · cameras: one arithmetic-mean centre per 12-view scan group, per-view rotations kept
  · inverse person masks, full-resolution images
  · camera optimiser: SO3xR3
  · 1,800 steps
```

The shared-centre correction only applies when several views were captured by
rotating in place at one physical spot. See [../docs/REPORT.md](../docs/REPORT.md)
for the experiments behind each choice.
