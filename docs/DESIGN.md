# Design decisions

## Why a depth-derived initialization cloud?

The provided whole-floor PLY covers regions not observed by the 240 RGB
training views. Gaussian training cannot learn photographic appearance in
those regions. The preparation script therefore builds a local cloud from
the same RGB-D views that supervise training.

## Why Pearson depth loss?

The supplied DA3 depth is monocular estimated depth, not a direct hardware
sensor measurement. DN-Splatter recommends Pearson-style relative depth
supervision for monocular depth and EdgeAwareLogL1 for sensor depth.

## Why disable camera optimization?

The RGB images, depth maps, and camera matrices form one aligned package.
Unconstrained camera optimization could improve photometric loss while
breaking alignment with the metric depth maps and downstream image-click
backprojection.

## Why preserve world coordinates?

The script converts only camera axes from OpenCV to OpenGL. It does not
rotate, center, or scale the world. This makes it easier to relate trained
results to `cameras.json`, the minimap, and future 3D annotations.

## Known risk

DN-Splatter is a research repository pinned to specific Nerfstudio and
gsplat versions. Its CLI may change. The README includes help commands and
a baseline Splatfacto run to isolate data-conversion problems from
DN-Splatter-specific problems.
