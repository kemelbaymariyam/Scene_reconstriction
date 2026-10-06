export async function loadCameras() {
  const response = await fetch('/dataset/cameras-c2.json');
  if (!response.ok) throw new Error(`Failed to load cameras-c2.json: ${response.status}`);
  return response.json();
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

export function groupScanPoints(cameras) {
  const groups = new Map();

  for (const camera of cameras) {
    const key = `scan-${camera.frame}`;
    const entries = groups.get(key) ?? [];
    entries.push(camera);
    groups.set(key, entries);
  }

  return [...groups.entries()]
    .map(([key, views], fallbackIndex) => {
      views.sort((a, b) => a.yaw - b.yaw);
      const pos = [0, 1, 2].map((axis) => mean(views.map((view) => view.pos[axis])));
      const parsedIndex = Number(key.replace('scan-', ''));

      return {
        key,
        index: Number.isFinite(parsedIndex) ? parsedIndex : fallbackIndex,
        pos,
        views,
      };
    })
    .sort((a, b) => a.index - b.index);
}
