import * as THREE from 'three';

const EPSILON = 1e-8;

// cameras.json uses OpenCV camera axes: +X right, +Y down, +Z forward.
// R is camera-to-world, so columns 1 and 2 are world-space down/forward.
export function forwardDirection(entry) {
  return new THREE.Vector3(entry.R[0][2], entry.R[1][2], entry.R[2][2]).normalize();
}

function cameraDownDirection(entry) {
  return new THREE.Vector3(entry.R[0][1], entry.R[1][1], entry.R[2][1]).normalize();
}

function fallbackPerpendicular(up) {
  const candidate = Math.abs(up.y) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  return candidate.addScaledVector(up, -candidate.dot(up)).normalize();
}

function farthestHorizontalDirection(scans, origin, up) {
  let best = null;
  let bestLengthSq = 0;

  for (let first = 0; first < scans.length; first += 1) {
    const a = new THREE.Vector3(...scans[first].pos).sub(origin);
    for (let second = first + 1; second < scans.length; second += 1) {
      const difference = new THREE.Vector3(...scans[second].pos).sub(origin).sub(a);
      difference.addScaledVector(up, -difference.dot(up));
      const lengthSq = difference.lengthSq();
      if (lengthSq > bestLengthSq) {
        bestLengthSq = lengthSq;
        best = difference.clone();
      }
    }
  }

  return best && best.lengthSq() > EPSILON ? best.normalize() : fallbackPerpendicular(up);
}

export function deriveSceneFrame(cameras, scans) {
  const averageDown = new THREE.Vector3();
  for (const camera of cameras) averageDown.add(cameraDownDirection(camera));

  const up = averageDown.lengthSq() > EPSILON
    ? averageDown.normalize().multiplyScalar(-1)
    : new THREE.Vector3(0, -1, 0);

  const origin = new THREE.Vector3();
  for (const scan of scans) origin.add(new THREE.Vector3(...scan.pos));
  if (scans.length > 0) origin.multiplyScalar(1 / scans.length);

  const axisU = farthestHorizontalDirection(scans, origin, up);
  const axisV = new THREE.Vector3().crossVectors(up, axisU).normalize();

  return { up, down: up.clone().multiplyScalar(-1), origin, axisU, axisV };
}

export function projectPointToFloor(position, frame) {
  const relative = new THREE.Vector3(...position).sub(frame.origin);
  return [relative.dot(frame.axisU), relative.dot(frame.axisV)];
}

export function projectDirectionToFloor(direction, frame) {
  return [direction.dot(frame.axisU), direction.dot(frame.axisV)];
}

export function horizontalDirection(direction, up) {
  const horizontal = direction.clone().addScaledVector(up, -direction.dot(up));
  if (horizontal.lengthSq() <= EPSILON) return fallbackPerpendicular(up);
  return horizontal.normalize();
}

export function pixelToWorld(u, v, depth, intrinsics, rotation, position) {
  const fx = Number(intrinsics[0][0]);
  const fy = Number(intrinsics[1][1]);
  const cx = Number(intrinsics[0][2]);
  const cy = Number(intrinsics[1][2]);

  if (![fx, fy, cx, cy, depth].every(Number.isFinite) || fx === 0 || fy === 0 || depth <= 0) {
    throw new Error('Invalid depth or camera intrinsics at the selected pixel.');
  }

  const cameraPoint = new THREE.Vector3(
    ((u - cx) * depth) / fx,
    ((v - cy) * depth) / fy,
    depth,
  );

  const world = new THREE.Vector3(
    rotation[0][0] * cameraPoint.x + rotation[0][1] * cameraPoint.y + rotation[0][2] * cameraPoint.z,
    rotation[1][0] * cameraPoint.x + rotation[1][1] * cameraPoint.y + rotation[1][2] * cameraPoint.z,
    rotation[2][0] * cameraPoint.x + rotation[2][1] * cameraPoint.y + rotation[2][2] * cameraPoint.z,
  );

  return world.add(new THREE.Vector3(...position));
}
