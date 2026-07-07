# InfraScan Reconstruction Pipeline

This repository preserves the reusable code, configurations, and documentation
from the InfraScan 3D Gaussian Splatting reconstruction project.

Large datasets, checkpoints, point clouds, exported splats, videos, and training
outputs are intentionally excluded from Git.

## Reference pipeline

The selected InfraScan C2 reconstruction used:

- Nerfstudio Splatfacto
- Scanner point-cloud initialization
- Full-resolution images
- Inverse person masks
- Shared arithmetic-mean camera centres for stationary multi-view groups
- Original camera rotations preserved
- SO3xR3 camera-pose refinement
- Approximately 1,800 selected training steps

The shared-centre correction should only be used when multiple views were
captured by rotating from one stationary physical location.

## Repository structure

- `configs/reference/` — recovered Nerfstudio experiment configurations
- `configs/templates/` — reusable configuration templates for new scenes
- `scripts/legacy-current/` — scripts recovered from the local project
- `scripts/legacy-backup/` — scripts recovered from the experiment backup
- `scripts/pipeline/` — cleaned reusable pipeline scripts
- `environment/` — package and environment records
- `docs/` — experiment notes and design documentation
- `examples/` — small metadata examples
- `viewer/` — browser viewer source code

## Data not stored in Git

Raw images, masks, point clouds, checkpoints, exported splats, training outputs,
videos, archives, and private scene data must be stored separately.
