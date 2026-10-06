import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { forwardDirection, horizontalDirection, projectDirectionToFloor, projectPointToFloor } from './coordinates.js';

const FLOOR_DROP_METRES = 1.45;
const FLOOR_LIFT_METRES = 0.035;
const LOOK_SENSITIVITY = 0.0032;
const MAX_PITCH = THREE.MathUtils.degToRad(82);
const ANNOTATION_EDGE_PADDING = 18;
const BLOCKED_MOVEMENT_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'Space', 'ShiftLeft', 'ShiftRight',
]);

function smootherStep(value) {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function interpolateDirection(from, to, amount) {
  const first = from.clone().normalize();
  const second = to.clone().normalize();
  const dot = THREE.MathUtils.clamp(first.dot(second), -1, 1);

  if (dot > 0.9995) return first.lerp(second, amount).normalize();
  if (dot < -0.9995) {
    const axis = Math.abs(first.x) < 0.8
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
    axis.cross(first).normalize();
    return first.applyAxisAngle(axis, Math.PI * amount).normalize();
  }

  const theta = Math.acos(dot);
  const relative = second.clone().addScaledVector(first, -dot).normalize();
  return first.multiplyScalar(Math.cos(theta * amount))
    .addScaledVector(relative, Math.sin(theta * amount))
    .normalize();
}

export class SplatViewer {
  constructor(container, sceneFrame) {
    this.container = container;
    this.frame = sceneFrame;
    this.threeScene = new THREE.Scene();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.scanMarkers = [];
    this.clickableMarkerMeshes = [];
    this.markerByKey = new Map();
    this.scanScreenByKey = new Map();
    this.scansByKey = new Map();
    this.floorPositionByKey = new Map();
    this.selectedArrow = null;
    this.routeLine = null;
    this.positionAnimation = null;
    this.lookAnimation = null;
    this.onScanSelected = undefined;
    this.onAnnotationRename = undefined;
    this.onAnnotationRemove = undefined;
    this.selectedScan = null;
    this.loaded = false;
    this.markerOuterRadius = 0.04;
    this.annotationMarkers = [];
    this.nextAnnotationId = 1;

    this.horizontalHeading = sceneFrame.axisV.clone();
    this.pitch = 0;
    this.dragging = false;
    this.dragStart = null;
    this.lastPointer = null;
    this.pendingMarker = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x080c12, 1);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(64, 1, 0.03, 500);
    this.camera.up.copy(sceneFrame.up);
    this.camera.position.copy(sceneFrame.origin).addScaledVector(sceneFrame.axisV, -1.5);
    this.applyLookDirection();

    this.viewer = new GaussianSplats3D.Viewer({
      rootElement: this.container,
      threeScene: this.threeScene,
      renderer: this.renderer,
      camera: this.camera,
      selfDrivenMode: false,
      useBuiltInControls: false,
      sharedMemoryForWorkers: false,
      gpuAcceleratedSort: false,
      integerBasedSort: false,
      dynamicScene: false,
      renderMode: GaussianSplats3D.RenderMode.Always,
      sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
      antialiased: false,
      focalAdjustment: 1.0,
      sphericalHarmonicsDegree: 2,
      logLevel: GaussianSplats3D.LogLevel.Info,
    });

    // Screen-space scan-point layer. Fixed-size HTML markers remain crisp and
    // readable instead of blending into the Gaussian floor at oblique angles.
    this.scanOverlay = document.createElement('div');
    this.scanOverlay.className = 'scan-overlay';
    this.scanOverlay.setAttribute('aria-label', 'Scan position controls');
    this.container.appendChild(this.scanOverlay);

    // Screen-space annotation layer. This is deliberately rendered as HTML
    // above the Gaussian canvas so labels never disappear inside the splat.
    this.annotationOverlay = document.createElement('div');
    this.annotationOverlay.className = 'annotation-overlay';
    this.annotationOverlay.setAttribute('aria-label', '3D annotation controls');
    this.container.appendChild(this.annotationOverlay);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.handlePointerDown, true);
    canvas.addEventListener('pointermove', this.handlePointerMove, true);
    canvas.addEventListener('pointerup', this.handlePointerUp, true);
    canvas.addEventListener('pointercancel', this.handlePointerUp, true);
    canvas.addEventListener('wheel', this.handleWheel, { capture: true, passive: false });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('keydown', this.handleKeyDown, true);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    requestAnimationFrame(this.animate);
  }

  resize() {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  async loadSplat(url = '/scene/scene.ply') {
    await this.viewer.addSplatScene(url, {
      splatAlphaRemovalThreshold: 5,
      showLoadingUI: true,
      progressiveLoad: false,
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    this.loaded = true;
  }

  floorPosition(scan) {
    return new THREE.Vector3(...scan.pos)
      .addScaledVector(this.frame.up, -FLOOR_DROP_METRES)
      .addScaledVector(this.frame.up, FLOOR_LIFT_METRES);
  }

  createFloorSign(scan, floorPosition) {
    const group = new THREE.Group();
    group.position.copy(floorPosition);
    group.userData.scanKey = scan.key;

    // Build the waypoint in the local XY plane, then align it to the floor.
    group.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      this.frame.up,
    );

    const outerRadius = this.markerOuterRadius;
    const plateRadius = outerRadius * 0.78;

    // Soft halo separates the standpoint from the Gaussian floor.
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc62e,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.22,
    });
    const glow = new THREE.Mesh(
      new THREE.RingGeometry(outerRadius * 1.02, outerRadius * 1.52, 40),
      glowMaterial,
    );
    glow.position.z = -0.002;
    glow.userData.scanKey = scan.key;
    glow.renderOrder = 28;
    group.add(glow);

    // White outer plate gives each point a crisp Street-View-like silhouette.
    const rimMaterial = new THREE.MeshBasicMaterial({
      color: 0xf7fbff,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.98,
    });
    const rim = new THREE.Mesh(
      new THREE.CircleGeometry(outerRadius, 40),
      rimMaterial,
    );
    rim.userData.scanKey = scan.key;
    rim.renderOrder = 30;
    group.add(rim);

    // Coloured inset plate communicates that this is a destination.
    const plateMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc62e,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.98,
    });
    const plate = new THREE.Mesh(
      new THREE.CircleGeometry(plateRadius, 40),
      plateMaterial,
    );
    plate.position.z = 0.0015;
    plate.userData.scanKey = scan.key;
    plate.renderOrder = 31;
    group.add(plate);

    // Dark chevron/arrow makes the pad read as a navigable standpoint.
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, outerRadius * 0.54);
    arrowShape.lineTo(-outerRadius * 0.38, -outerRadius * 0.10);
    arrowShape.lineTo(-outerRadius * 0.15, -outerRadius * 0.10);
    arrowShape.lineTo(-outerRadius * 0.15, -outerRadius * 0.48);
    arrowShape.lineTo(outerRadius * 0.15, -outerRadius * 0.48);
    arrowShape.lineTo(outerRadius * 0.15, -outerRadius * 0.10);
    arrowShape.lineTo(outerRadius * 0.38, -outerRadius * 0.10);
    arrowShape.closePath();

    const arrowMaterial = new THREE.MeshBasicMaterial({
      color: 0x172331,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.98,
    });
    const arrow = new THREE.Mesh(
      new THREE.ShapeGeometry(arrowShape),
      arrowMaterial,
    );
    arrow.position.z = 0.003;
    arrow.userData.scanKey = scan.key;
    arrow.renderOrder = 32;
    group.add(arrow);

    // Small central locator dot remains readable when the pad is far away.
    const dotMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 1,
    });
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(outerRadius * 0.105, 20),
      dotMaterial,
    );
    dot.position.z = 0.0045;
    dot.userData.scanKey = scan.key;
    dot.renderOrder = 33;
    group.add(dot);

    // Keep the visual footprint controlled while making selection forgiving.
    const hitMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0,
    });
    const hitTarget = new THREE.Mesh(
      new THREE.CircleGeometry(outerRadius * 1.85, 32),
      hitMaterial,
    );
    hitTarget.position.z = 0.006;
    hitTarget.userData.scanKey = scan.key;
    hitTarget.renderOrder = 34;
    group.add(hitTarget);

    group.userData.rim = rim;
    group.userData.plate = plate;
    group.userData.arrow = arrow;
    group.userData.dot = dot;
    group.userData.glow = glow;
    this.clickableMarkerMeshes.push(rim, plate, arrow, dot, hitTarget);
    return group;
  }

  computeMarkerRadius(scans) {
    if (scans.length < 2) return 0.045;

    const nearestDistances = scans.map((scan, index) => {
      const point = new THREE.Vector3(...scan.pos);
      let nearest = Infinity;
      for (let otherIndex = 0; otherIndex < scans.length; otherIndex += 1) {
        if (otherIndex === index) continue;
        const other = new THREE.Vector3(...scans[otherIndex].pos);
        const offset = other.sub(point);
        offset.addScaledVector(this.frame.up, -offset.dot(this.frame.up));
        nearest = Math.min(nearest, offset.length());
      }
      return nearest;
    }).filter(Number.isFinite).sort((a, b) => a - b);

    const middle = Math.floor(nearestDistances.length / 2);
    const median = nearestDistances.length % 2 === 0
      ? (nearestDistances[middle - 1] + nearestDistances[middle]) / 2
      : nearestDistances[middle];

    // Deliberately more visible than the earlier tiny rings, while still
    // adapting to the dense spacing of the 20 scan positions.
    return THREE.MathUtils.clamp(median * 0.20, 0.022, 0.052);
  }

  updateMarkerVisibility() {
    // The final navigation markers are rendered in screen space so they remain
    // sharp over the splat. Hide the older world-space discs to prevent a soft
    // double image where they intersect the Gaussian floor.
    for (const marker of this.scanMarkers) marker.visible = false;
  }

  createScanOverlay(scan) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scan-screen-marker';
    button.dataset.scanKey = scan.key;
    button.setAttribute('aria-label', `Move to scan position ${scan.index}`);
    button.title = `Move to scan ${scan.index}`;
    button.innerHTML = `
      <span class="scan-screen-core" aria-hidden="true"></span>
      <span class="scan-screen-number">${scan.index}</span>
    `;

    const stopPointer = (event) => event.stopPropagation();
    button.addEventListener('pointerdown', stopPointer);
    button.addEventListener('pointermove', stopPointer);
    button.addEventListener('pointerup', stopPointer);
    button.addEventListener('wheel', stopPointer, { passive: true });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onScanSelected?.(scan);
    });

    this.scanOverlay.appendChild(button);
    return button;
  }

  updateScanOverlays() {
    if (!this.scanOverlay || this.scanScreenByKey.size === 0) return;

    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();

    for (const [key, element] of this.scanScreenByKey) {
      const floor = this.floorPositionByKey.get(key);
      if (!floor) {
        element.hidden = true;
        continue;
      }

      const anchor = floor.clone().addScaledVector(this.frame.up, 0.045);
      const cameraSpace = anchor.clone().applyMatrix4(this.camera.matrixWorldInverse);
      const projected = anchor.clone().project(this.camera);
      const inFront = cameraSpace.z < -this.camera.near;
      const insideDepth = projected.z >= -1 && projected.z <= 1;
      const insideScreen = Math.abs(projected.x) <= 1.05 && Math.abs(projected.y) <= 1.05;
      const visible = inFront && insideDepth && insideScreen;

      element.hidden = !visible;
      if (!visible) continue;

      const x = THREE.MathUtils.clamp(
        (projected.x * 0.5 + 0.5) * width,
        18,
        width - 18,
      );
      const y = THREE.MathUtils.clamp(
        (-projected.y * 0.5 + 0.5) * height,
        18,
        height - 18,
      );

      const distance = anchor.distanceTo(this.camera.position);
      const distanceScale = THREE.MathUtils.clamp(1.08 - distance * 0.035, 0.72, 1);
      const selected = this.selectedScan?.key === key;
      const scale = distanceScale * (selected ? 1.16 : 1);
      element.classList.toggle('selected', selected);
      element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${scale})`;
      element.style.zIndex = String(selected ? 4 : Math.max(1, 3 - Math.round(distance / 8)));
    }
  }

  addScanPoints(scans) {
    for (const marker of this.scanMarkers) this.threeScene.remove(marker);
    if (this.routeLine) this.threeScene.remove(this.routeLine);
    this.scanMarkers.length = 0;
    this.clickableMarkerMeshes.length = 0;
    this.markerByKey.clear();
    this.scansByKey.clear();
    this.floorPositionByKey.clear();
    this.scanScreenByKey.clear();
    this.scanOverlay.replaceChildren();

    this.markerOuterRadius = this.computeMarkerRadius(scans);

    for (const scan of scans) {
      this.scansByKey.set(scan.key, scan);
      const floorPosition = this.floorPosition(scan);
      this.floorPositionByKey.set(scan.key, floorPosition);
      const marker = this.createFloorSign(scan, floorPosition);
      this.threeScene.add(marker);
      this.scanMarkers.push(marker);
      this.markerByKey.set(scan.key, marker);
      this.scanScreenByKey.set(scan.key, this.createScanOverlay(scan));
    }

    this.updateMarkerVisibility();
    this.updateScanOverlays();
  }

  createAnnotationOverlay(id, label) {
    const marker = document.createElement('div');
    marker.className = 'annotation-screen-marker';
    marker.dataset.annotationId = String(id);
    marker.innerHTML = `
      <button class="annotation-screen-button" type="button" aria-label="Edit annotation ${label}">
        <span class="annotation-screen-target" aria-hidden="true"></span>
        <span class="annotation-screen-label"></span>
      </button>
      <form class="annotation-screen-editor" hidden>
        <label>
          <span>Annotation label</span>
          <input type="text" maxlength="42" />
        </label>
        <div class="annotation-screen-actions">
          <button type="submit">Save</button>
          <button type="button" data-action="look">Look</button>
          <button type="button" data-action="delete" class="danger">Delete</button>
        </div>
      </form>
    `;

    const button = marker.querySelector('.annotation-screen-button');
    const labelElement = marker.querySelector('.annotation-screen-label');
    const editor = marker.querySelector('.annotation-screen-editor');
    const input = editor.querySelector('input');
    const lookButton = editor.querySelector('[data-action="look"]');
    const deleteButton = editor.querySelector('[data-action="delete"]');

    labelElement.textContent = label;
    input.value = label;

    const stopPointer = (event) => event.stopPropagation();
    marker.addEventListener('pointerdown', stopPointer);
    marker.addEventListener('pointermove', stopPointer);
    marker.addEventListener('pointerup', stopPointer);
    marker.addEventListener('wheel', stopPointer, { passive: true });

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      for (const other of this.annotationOverlay.querySelectorAll('.annotation-screen-editor')) {
        if (other !== editor) other.hidden = true;
      }
      editor.hidden = !editor.hidden;
      if (!editor.hidden) {
        input.value = labelElement.textContent;
        input.focus();
        input.select();
      }
    });

    editor.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nextLabel = input.value.trim() || `Marker ${id}`;
      labelElement.textContent = nextLabel;
      button.setAttribute('aria-label', `Edit annotation ${nextLabel}`);
      editor.hidden = true;
      const entry = this.annotationMarkers.find((item) => item.id === id);
      if (entry) entry.label = nextLabel;
      this.onAnnotationRename?.(id, nextLabel);
    });

    lookButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const entry = this.annotationMarkers.find((item) => item.id === id);
      if (entry) this.orientToPoint(entry.position);
      editor.hidden = true;
    });

    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.onAnnotationRemove) this.onAnnotationRemove(id);
      else this.removeWorldMarker(id);
    });

    this.annotationOverlay.appendChild(marker);
    return marker;
  }

  addWorldMarker(position, label = 'Marker') {
    const id = this.nextAnnotationId++;
    const element = this.createAnnotationOverlay(id, label);
    this.annotationMarkers.push({
      id,
      position: position.clone(),
      label,
      element,
    });
    this.updateAnnotationOverlays();
    return id;
  }

  setWorldMarkerLabel(id, label) {
    const marker = this.annotationMarkers.find((entry) => entry.id === id);
    if (!marker) return;
    marker.label = label;
    marker.element.querySelector('.annotation-screen-label').textContent = label;
    marker.element.querySelector('input').value = label;
    marker.element.querySelector('.annotation-screen-button')
      .setAttribute('aria-label', `Edit annotation ${label}`);
  }

  removeWorldMarker(id) {
    const index = this.annotationMarkers.findIndex((marker) => marker.id === id);
    if (index < 0) return;
    const [marker] = this.annotationMarkers.splice(index, 1);
    marker.element.remove();
  }

  clearWorldMarkers() {
    for (const marker of this.annotationMarkers) marker.element.remove();
    this.annotationMarkers.length = 0;
  }

  updateAnnotationOverlays() {
    if (!this.annotationOverlay || this.annotationMarkers.length === 0) return;
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();

    for (const marker of this.annotationMarkers) {
      const cameraSpace = marker.position.clone().applyMatrix4(this.camera.matrixWorldInverse);
      const projected = marker.position.clone().project(this.camera);
      const inFront = cameraSpace.z < -this.camera.near;
      const insideDepth = projected.z >= -1 && projected.z <= 1;
      const insideScreen = Math.abs(projected.x) <= 1.08 && Math.abs(projected.y) <= 1.08;
      const visible = inFront && insideDepth && insideScreen;

      marker.element.hidden = !visible;
      if (!visible) continue;

      const x = THREE.MathUtils.clamp(
        (projected.x * 0.5 + 0.5) * width,
        ANNOTATION_EDGE_PADDING,
        width - ANNOTATION_EDGE_PADDING,
      );
      const y = THREE.MathUtils.clamp(
        (-projected.y * 0.5 + 0.5) * height,
        ANNOTATION_EDGE_PADDING,
        height - ANNOTATION_EDGE_PADDING,
      );
      marker.element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
    }
  }

  orientToPoint(position, duration = 550) {
    const direction = position.clone().sub(this.camera.position);
    if (direction.lengthSq() < 1e-8) return;
    this.lookAnimation = {
      startedAt: performance.now(),
      duration,
      fromDirection: this.getLookDirection(),
      toDirection: direction.normalize(),
    };
  }


  setFovFromView(view) {
    const fy = Number(view?.intrinsics?.[1]?.[1]);
    const height = Number(view?.height ?? 504);
    if (!Number.isFinite(fy) || fy <= 0 || !Number.isFinite(height) || height <= 0) return;

    const verticalFov = THREE.MathUtils.radToDeg(2 * Math.atan(height / (2 * fy)));
    this.camera.fov = THREE.MathUtils.clamp(verticalFov, 20, 120);
    this.camera.updateProjectionMatrix();
  }


  getLookDirection() {
    return this.horizontalHeading.clone().multiplyScalar(Math.cos(this.pitch))
      .addScaledVector(this.frame.up, Math.sin(this.pitch))
      .normalize();
  }

  setLookFromDirection(direction, apply = true) {
    const normalized = direction.clone().normalize();
    const vertical = THREE.MathUtils.clamp(normalized.dot(this.frame.up), -1, 1);
    this.pitch = THREE.MathUtils.clamp(Math.asin(vertical), -MAX_PITCH, MAX_PITCH);
    this.horizontalHeading.copy(horizontalDirection(normalized, this.frame.up));
    if (apply) this.applyLookDirection();
  }

  applyLookDirection() {
    const direction = this.getLookDirection();
    this.camera.up.copy(this.frame.up);
    this.camera.lookAt(this.camera.position.clone().add(direction));
  }

  jumpTo(scan, view) {
    this.positionAnimation = null;
    this.lookAnimation = null;
    this.camera.position.set(...(view?.pos ?? scan.pos));
    this.setFovFromView(view);
    this.setLookFromDirection(forwardDirection(view));
    this.showSelectedScan(scan, this.getLookDirection());
  }

  navigateTo(scan, duration = 1400) {
    this.positionAnimation = {
      startedAt: performance.now(),
      duration,
      fromPosition: this.camera.position.clone(),
      toPosition: new THREE.Vector3(...scan.pos),
    };
    this.showSelectedScan(scan, this.getLookDirection());
  }

  orientToView(scan, view, duration = 600) {
    const fromDirection = this.getLookDirection();
    const toDirection = forwardDirection(view);
    const targetPosition = new THREE.Vector3(...(view?.pos ?? scan.pos));

    this.positionAnimation = {
      startedAt: performance.now(),
      duration: Math.min(duration, 420),
      fromPosition: this.camera.position.clone(),
      toPosition: targetPosition,
    };
    this.lookAnimation = {
      startedAt: performance.now(),
      duration,
      fromDirection,
      toDirection,
    };
    this.setFovFromView(view);
    this.showSelectedScan(scan, toDirection);
  }

  getGroundPositionAndHeading() {
    return {
      position: projectPointToFloor(this.camera.position.toArray(), this.frame),
      heading: projectDirectionToFloor(this.getLookDirection(), this.frame),
    };
  }

  showSelectedScan(scan, direction = this.getLookDirection()) {
    this.selectedScan = scan;
    for (const [key, marker] of this.markerByKey) {
      const selected = key === scan.key;
      marker.userData.rim.material.color.setHex(0xf7fbff);
      marker.userData.plate.material.color.setHex(selected ? 0x35d4ff : 0xffc62e);
      marker.userData.arrow.material.color.setHex(selected ? 0x07303d : 0x172331);
      marker.userData.dot.material.color.setHex(selected ? 0xe6fbff : 0xffffff);
      marker.userData.glow.material.color.setHex(selected ? 0x35d4ff : 0xffc62e);
      marker.userData.glow.material.opacity = selected ? 0.42 : 0.22;
      marker.scale.setScalar(selected ? 1.14 : 1);
    }

    if (this.selectedArrow) this.threeScene.remove(this.selectedArrow);
    const floorOrigin = (this.floorPositionByKey.get(scan.key) ?? this.floorPosition(scan)).clone();
    floorOrigin.addScaledVector(this.frame.up, 0.028);
    const floorDirection = horizontalDirection(direction, this.frame.up);
    this.selectedArrow = new THREE.ArrowHelper(
      floorDirection,
      floorOrigin,
      0.52,
      0x35d4ff,
      0.13,
      0.08,
    );
    this.selectedArrow.line.material.depthTest = false;
    this.selectedArrow.cone.material.depthTest = false;
    this.selectedArrow.renderOrder = 30;
    this.threeScene.add(this.selectedArrow);
    for (const [key, element] of this.scanScreenByKey) {
      element.classList.toggle('selected', key === scan.key);
    }
    this.updateMarkerVisibility();
    this.updateScanOverlays();
  }

  markerAtPointer(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(this.clickableMarkerMeshes, false)[0] ?? null;
  }

  handlePointerDown = (event) => {
    if (event.button !== 0) return;
    this.lookAnimation = null;
    event.preventDefault();
    event.stopImmediatePropagation();

    this.dragging = true;
    this.dragStart = { x: event.clientX, y: event.clientY };
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.pendingMarker = this.markerAtPointer(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  handlePointerMove = (event) => {
    if (!this.dragging) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    this.lastPointer = { x: event.clientX, y: event.clientY };

    // Drag right -> look right. Drag up -> look up.
    this.horizontalHeading.applyAxisAngle(this.frame.up, -dx * LOOK_SENSITIVITY).normalize();
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - dy * LOOK_SENSITIVITY,
      -MAX_PITCH,
      MAX_PITCH,
    );
    this.applyLookDirection();
    if (this.selectedScan) this.showSelectedScan(this.selectedScan, this.getLookDirection());
  };

  handlePointerUp = (event) => {
    if (!this.dragging) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const distance = this.dragStart
      ? Math.hypot(event.clientX - this.dragStart.x, event.clientY - this.dragStart.y)
      : Infinity;

    if (distance < 6 && this.pendingMarker) {
      const scan = this.scansByKey.get(this.pendingMarker.object.userData.scanKey);
      if (scan) this.onScanSelected?.(scan);
    }

    this.dragging = false;
    this.dragStart = null;
    this.lastPointer = null;
    this.pendingMarker = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  handleWheel = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    this.camera.fov = THREE.MathUtils.clamp(
      this.camera.fov + Math.sign(event.deltaY) * 3,
      34,
      92,
    );
    this.camera.updateProjectionMatrix();
  };

  handleKeyDown = (event) => {
    const target = event.target;
    const isTyping = target instanceof Element && Boolean(
      target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'),
    );

    // Movement shortcuts are disabled only while the 3D viewer has focus.
    // Text fields and annotation editors must receive normal W/A/S/D, arrow,
    // space and shift input.
    if (isTyping || !BLOCKED_MOVEMENT_KEYS.has(event.code)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  updatePositionAnimation(now) {
    if (!this.positionAnimation) return;

    const elapsed = now - this.positionAnimation.startedAt;
    const raw = Math.min(elapsed / Math.max(this.positionAnimation.duration, 1), 1);
    const amount = smootherStep(raw);

    this.camera.position.lerpVectors(
      this.positionAnimation.fromPosition,
      this.positionAnimation.toPosition,
      amount,
    );
    // The user may freely change heading and pitch during the translation.
    this.applyLookDirection();
    this.updateMarkerVisibility();

    if (raw >= 1) {
      this.camera.position.copy(this.positionAnimation.toPosition);
      this.applyLookDirection();
      this.positionAnimation = null;
      this.updateMarkerVisibility();
    }
  }

  updateLookAnimation(now) {
    if (!this.lookAnimation) return;

    const elapsed = now - this.lookAnimation.startedAt;
    const raw = Math.min(elapsed / Math.max(this.lookAnimation.duration, 1), 1);
    const amount = smootherStep(raw);
    const direction = interpolateDirection(
      this.lookAnimation.fromDirection,
      this.lookAnimation.toDirection,
      amount,
    );
    this.setLookFromDirection(direction);

    if (raw >= 1) {
      this.setLookFromDirection(this.lookAnimation.toDirection);
      this.lookAnimation = null;
    }
  }

  animate = (now) => {
    requestAnimationFrame(this.animate);
    this.updatePositionAnimation(now);
    this.updateLookAnimation(now);
    this.updateScanOverlays();
    this.updateAnnotationOverlays();
    if (!this.loaded) return;
    this.viewer.update();
    this.viewer.render();
  };
}
