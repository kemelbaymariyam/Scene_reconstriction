> **Historical note:** this document describes the first approach (DN-Splatter with depth supervision and camera optimisation disabled). It was later rejected; the final model is Splatfacto with shared camera centres and SO3xR3 pose refinement. See [REPORT.md](REPORT.md).

# InfraScan DN-Splatter Reconstruction

This repository converts the supplied InfraScan DA3 output into a
Nerfstudio/DN-Splatter dataset, trains a depth-supervised Gaussian splat,
exports it, and displays the exported splat in a browser.

## What this repository does

1. Reads `dataset/cameras.json` and all `frame_N.npz` files.
2. Copies the RGB training views.
3. Creates inverse person masks: white = train, black = ignore.
4. Converts metric float depth into 16-bit millimetre PNG files.
5. Converts the supplied OpenCV camera-to-world matrices into the
   OpenGL/Blender camera convention used by Nerfstudio.
6. Builds a masked, confidence-filtered, voxel-downsampled coloured PLY
   from the depth maps for Gaussian initialization.
7. Writes a Nerfstudio-compatible `transforms.json`.
8. Provides DN-Splatter training and export scripts.
9. Provides a browser Gaussian-splat viewer.

## Important expectations

- This is a **local photographic reconstruction**, constrained by the 240
  perspective images. It will not photorealistically reconstruct parts of
  the whole-floor PLY that were never visible in those images.
- People are excluded using the supplied masks.
- Person shadows and reflections are not covered by those masks.
- All views have a horizontal pitch, so floor and ceiling geometry may be
  weaker than walls.
- DN-Splatter requires an NVIDIA CUDA-capable GPU for practical training.
- On Windows, use **WSL2 Ubuntu** for training. The browser viewer runs on
  ordinary Windows.

## Repository structure

```text
infrascan-dn-splatter/
├── dataset/                         # copy the supplied dataset here
│   ├── cameras.json
│   ├── pointcloud.ply
│   ├── views/
│   ├── views_mask/
│   └── da3/results_output/
├── prepared/                        # generated; do not edit
│   ├── images/
│   ├── masks/
│   ├── depths/
│   ├── initialization.ply
│   ├── transforms.json
│   └── preparation_report.json
├── scripts/
│   ├── prepare_dataset.py
│   ├── validate_prepared.py
│   ├── find_latest_config.py
│   ├── train_dn_splatter.sh
│   ├── export_splat.sh
│   └── copy_export_to_viewer.py
└── viewer/
    ├── public/scene/scene.ply       # exported Gaussian PLY goes here
    ├── src/main.js
    ├── index.html
    └── package.json
```

## 1. Put the dataset in place

The expected input path is:

```text
dataset/cameras.json
dataset/views/
dataset/views_mask/
dataset/da3/results_output/frame_0.npz
...
dataset/da3/results_output/frame_239.npz
```

Do not commit the dataset to Git.

## 2. Prepare the dataset

This preprocessing step can run in Windows PowerShell or Linux.

### Windows PowerShell

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-preprocess.txt

python scripts\prepare_dataset.py `
  --dataset dataset `
  --output prepared `
  --confidence-quantile 0.20 `
  --stride 2 `
  --voxel-size 0.02 `
  --max-depth 20
```

### Linux / WSL

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-preprocess.txt

python scripts/prepare_dataset.py \
  --dataset dataset \
  --output prepared \
  --confidence-quantile 0.20 \
  --stride 2 \
  --voxel-size 0.02 \
  --max-depth 20
```

Then validate:

```bash
python scripts/validate_prepared.py --data prepared
```

### Preprocessing options

- `--stride 2`: uses every second pixel for initialization.
- `--voxel-size 0.02`: merges initialization points into 2 cm voxels.
- `--confidence-quantile 0.20`: removes the lowest-confidence 20% of valid
  pixels separately in each frame.
- `--max-depth 20`: rejects depth beyond 20 m.
- `--max-init-points 1500000`: caps the initialization PLY size.

Start with these defaults. Use `--stride 4` if preparation consumes too
much memory.

## 3. Install DN-Splatter in WSL2 Ubuntu

Native Windows installation of CUDA extensions is substantially less
reliable. Install WSL2 Ubuntu, an NVIDIA Windows driver with WSL CUDA
support, and Miniconda inside WSL.

Inside WSL:

```bash
nvidia-smi
```

This must show the NVIDIA GPU.

Create an environment:

```bash
conda create -n dnsplat python=3.10 -y
conda activate dnsplat
```

Install a CUDA-compatible PyTorch build appropriate for your system.
Check the official PyTorch selector rather than blindly copying an old
CUDA command.

Clone and install DN-Splatter:

```bash
git clone https://github.com/maturk/dn-splatter.git external/dn-splatter
cd external/dn-splatter
pip install setuptools==69.5.1
pip install -e .
cd ../..
```

The upstream plugin currently pins Nerfstudio and gsplat versions through
its `pyproject.toml`. Do not separately upgrade those packages afterward.

Verify:

```bash
ns-train dn-splatter --help
```

## 4. Train

Run from the repository root in WSL:

```bash
bash scripts/train_dn_splatter.sh prepared
```

The default command uses:

- depth supervision;
- Pearson depth loss, because DA3 depth is monocular estimated depth;
- normal supervision derived from rendered depth;
- normal total-variation regularization;
- the depth-derived initialization PLY;
- camera optimization disabled, because the supplied poses should remain
  aligned with the metric depth maps.

The expanded command is:

```bash
ns-train dn-splatter \
  --experiment-name infrascan \
  --output-dir outputs \
  --max-num-iterations 30000 \
  --pipeline.model.use-depth-loss True \
  --pipeline.model.depth-loss-type PearsonDepth \
  --pipeline.model.depth-lambda 0.2 \
  --pipeline.model.use-normal-loss True \
  --pipeline.model.use-normal-tv-loss True \
  --pipeline.model.normal-supervision depth \
  --pipeline.model.camera-optimizer.mode off \
  normal-nerfstudio \
  --data prepared \
  --orientation-method none \
  --center-method none \
  --auto-scale-poses False \
  --depth-unit-scale-factor 0.001 \
  --eval-mode interval \
  --eval-interval 12
```

If your installed DN-Splatter revision exposes a slightly different CLI,
run:

```bash
ns-train dn-splatter --help
ns-train dn-splatter normal-nerfstudio --help
```

and compare the option names. Research repositories sometimes change
their CLI without preserving backward compatibility.

## 5. Inspect during training

Nerfstudio prints a viewer URL, commonly:

```text
http://localhost:7007
```

Open it in the Windows browser. WSL normally forwards localhost.

Do not judge the result from the first few hundred iterations. First
check:

- camera frustums are oriented correctly;
- walls appear in front of the cameras;
- the reconstruction is not mirrored;
- masked people do not form persistent blobs;
- depth regularization is not collapsing the scene.

## 6. Export the Gaussian splat

Find the latest generated config:

```bash
python scripts/find_latest_config.py --outputs outputs
```

Then export:

```bash
bash scripts/export_splat.sh outputs/infrascan/dn-splatter/<run>/config.yml
```

This calls:

```bash
ns-export gaussian-splat \
  --load-config <config.yml> \
  --output-dir exports/splat
```

The expected file is usually:

```text
exports/splat/splat.ply
```

Copy it into the browser viewer:

```bash
python scripts/copy_export_to_viewer.py \
  --source exports/splat/splat.ply \
  --destination viewer/public/scene/scene.ply
```

## 7. Run the browser viewer

In Windows PowerShell or WSL:

```bash
cd viewer
npm install
npm run dev
```

Open the printed URL.

The viewer loads:

```text
viewer/public/scene/scene.ply
```

That PLY must be the **exported Gaussian splat**, not the original ordinary
point cloud. An ordinary point-cloud PLY does not contain Gaussian scale,
rotation, opacity, and spherical-harmonic fields.

## 8. Suggested first experiments

### Baseline Splatfacto

Before debugging DN-Splatter, confirm that camera conversion works with:

```bash
ns-train splatfacto \
  --experiment-name infrascan-baseline \
  --output-dir outputs \
  --pipeline.model.camera-optimizer.mode off \
  nerfstudio-data \
  --data prepared \
  --orientation-method none \
  --center-method none \
  --auto-scale-poses False \
  --eval-mode interval \
  --eval-interval 12
```

### DN-Splatter without normal loss

If training is unstable:

```bash
ns-train dn-splatter \
  --experiment-name infrascan-depth-only \
  --output-dir outputs \
  --pipeline.model.use-depth-loss True \
  --pipeline.model.depth-loss-type PearsonDepth \
  --pipeline.model.depth-lambda 0.1 \
  --pipeline.model.use-normal-loss False \
  --pipeline.model.camera-optimizer.mode off \
  normal-nerfstudio \
  --data prepared \
  --orientation-method none \
  --center-method none \
  --auto-scale-poses False \
  --depth-unit-scale-factor 0.001
```

### Stronger geometric loss

Only after a stable run, try:

```text
--pipeline.model.depth-lambda 0.3
```

Do not begin with a very large depth weight. DA3 depth is estimated, not
hardware sensor ground truth.

## 9. Troubleshooting

### Scene is mirrored or cameras face backward

The supplied poses use OpenCV camera axes:

```text
+X right, +Y down, +Z forward
```

Nerfstudio uses OpenGL/Blender camera axes:

```text
+X right, +Y up, -Z forward
```

`prepare_dataset.py` converts poses by right-multiplying the camera-to-world
matrix with:

```text
diag(1, -1, -1, 1)
```

Do not apply that conversion a second time.

### Depth appears offset from RGB

The depth and RGB arrays are both 504 × 504 and aligned. Check that the
frame ID, image filename, and NPZ index agree.

### People remain visible

The generated training masks are inverse masks:

```text
white = train this pixel
black = ignore this pixel
```

Inspect `prepared/masks/` manually.

### Viewer shows dots instead of splats

You copied the initialization PLY or original point cloud instead of the
exported Gaussian PLY. Copy `exports/splat/splat.ply`.

### Out of GPU memory

Try:

- `dn-splatter` instead of `dn-splatter-big`;
- lower image resolution through the data parser;
- fewer iterations for a smoke test;
- a larger culling threshold;
- no normal-prediction option;
- training on a smaller subset first.

## 10. Git policy

Committed:

```text
scripts/
viewer/src/
viewer/package.json
README.md
```

Ignored:

```text
dataset/
prepared/
outputs/
exports/
viewer/public/scene/*.ply
external/
```

This keeps the repository reviewable and reproducible.
