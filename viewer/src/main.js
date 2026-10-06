import './style.css';
import * as THREE from 'three';
import { deriveSceneFrame, pixelToWorld, projectPointToFloor } from './coordinates.js';
import { loadCameras, groupScanPoints } from './data.js';
import { loadFrameData } from './depth.js';
import { Minimap } from './minimap.js';
import { SplatViewer } from './viewer.js';

const HARD_MIN_DEPTH_CONFIDENCE = 0.10;
const LOW_CONFIDENCE_WARNING = 0.50;

const app = document.querySelector('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div>
        <h1>InfraScan Gaussian Walkthrough</h1>
        <p>Photographic 3D reconstruction · 20 scan positions · depth-linked annotations</p>
      </div>
      <div class="tour-controls" aria-label="Guided walkthrough controls">
        <span class="lock-badge">Scan-path navigation</span>
        <button id="start-tour" class="tour-button" type="button" disabled>Start walkthrough</button>
        <button id="stop-tour" class="tour-button secondary" type="button" disabled>Stop</button>
        <span id="tour-progress" class="tour-progress">Loading…</span>
      </div>
    </header>
    <main class="workspace">
      <section id="viewer" class="viewer">
        <div class="look-help">Drag to look around at any time · wheel/pinch changes zoom · select a white scan marker to move</div>
      </section>
      <aside class="sidebar">
        <section class="panel">
          <div class="panel-heading">
            <h2>Floor-plan minimap</h2>
            <span id="scan-label">No scan selected</span>
          </div>
          <div id="minimap"></div>
          <p class="hint">Scanner geometry is shown from above. Click a numbered point to move while preserving your heading.</p>
        </section>
        <section class="panel">
          <div class="panel-heading">
            <h2>Captured directions</h2>
            <span>12 yaw views</span>
          </div>
          <div id="view-list" class="view-list"></div>
          <p class="hint">Selecting a yaw rotates the 3D camera and opens its source perspective.</p>
        </section>
        <section class="panel image-panel">
          <div class="panel-heading">
            <h2>Perspective → 3D</h2>
            <button id="clear-markers" class="small-button" type="button">Clear markers</button>
          </div>
          <label class="marker-label-field" for="marker-label">
            <span>Marker label (optional)</span>
            <input id="marker-label" type="text" maxlength="42" placeholder="e.g. window, sofa, exit" />
          </label>
          <div class="image-wrap">
            <img id="perspective-image" alt="Selected perspective view" />
            <div id="image-crosshair" class="crosshair" hidden></div>
          </div>
          <p id="annotation-status" class="status">Select any scan and yaw, then click a valid image pixel.</p>
          <div id="annotation-list" class="annotation-list" aria-live="polite"></div>
        </section>
        <section class="panel">
          <h2>Status</h2>
          <p id="status" class="status">Loading trained Gaussian splat…</p>
        </section>
        <section class="panel caveat-panel">
          <h2>Coverage note</h2>
          <p>The splat is most reliable near the photographed scan points. Person pixels are rejected for annotations; moving shadows and reflections may remain.</p>
        </section>
      </aside>
    </main>
  </div>
`;

const viewerElement = document.querySelector('#viewer');
const minimapElement = document.querySelector('#minimap');
const viewList = document.querySelector('#view-list');
const scanLabel = document.querySelector('#scan-label');
const status = document.querySelector('#status');
const annotationStatus = document.querySelector('#annotation-status');
const perspectiveImage = document.querySelector('#perspective-image');
const crosshair = document.querySelector('#image-crosshair');
const clearMarkersButton = document.querySelector('#clear-markers');
const markerLabelInput = document.querySelector('#marker-label');
const annotationList = document.querySelector('#annotation-list');
const startTourButton = document.querySelector('#start-tour');
const stopTourButton = document.querySelector('#stop-tour');
const tourProgress = document.querySelector('#tour-progress');

let viewer;
let minimap;
let allScans = [];
let currentScan = null;
let selectedView = null;
let walkthroughRun = 0;
let walkthroughRunning = false;
let annotationCount = 0;
const annotations = [];

function annotationById(markerId) {
  return annotations.find((entry) => entry.markerId === markerId);
}

function renameAnnotation(markerId, nextLabel) {
  const annotation = annotationById(markerId);
  if (!annotation) return;
  const cleaned = String(nextLabel).trim() || `Marker ${markerId}`;
  annotation.label = cleaned;
  viewer?.setWorldMarkerLabel(markerId, cleaned);
  renderAnnotations();
  annotationStatus.textContent = `${cleaned} updated.`;
}

function removeAnnotation(markerId) {
  const index = annotations.findIndex((entry) => entry.markerId === markerId);
  if (index < 0) return;
  const [annotation] = annotations.splice(index, 1);
  viewer?.removeWorldMarker(markerId);
  renderAnnotations();
  annotationStatus.textContent = `${annotation.label} removed.`;
}

function renderAnnotations() {
  annotationList.replaceChildren();
  if (annotations.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'annotation-empty';
    empty.textContent = 'No markers yet. You can add markers from any of the 240 perspective images.';
    annotationList.appendChild(empty);
    return;
  }

  for (const annotation of annotations) {
    const item = document.createElement('div');
    item.className = 'annotation-item';

    const copy = document.createElement('div');
    copy.className = 'annotation-copy';

    const title = document.createElement('strong');
    title.textContent = annotation.label;
    const details = document.createElement('span');
    details.textContent = `Scan ${annotation.scanIndex} · yaw ${annotation.yaw}° · ${annotation.depth.toFixed(2)} m · conf ${annotation.confidence.toFixed(2)}`;
    copy.append(title, details);

    const actions = document.createElement('div');
    actions.className = 'annotation-actions';

    const lookButton = document.createElement('button');
    lookButton.type = 'button';
    lookButton.className = 'annotation-button';
    lookButton.textContent = 'Look';
    lookButton.addEventListener('click', () => viewer?.orientToPoint(annotation.world));

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'annotation-button';
    editButton.textContent = 'Edit';
    editButton.addEventListener('click', () => {
      const nextLabel = window.prompt('Edit annotation label', annotation.label);
      if (nextLabel !== null) renameAnnotation(annotation.markerId, nextLabel);
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'annotation-button danger';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => removeAnnotation(annotation.markerId));

    actions.append(lookButton, editButton, removeButton);
    item.append(copy, actions);
    annotationList.appendChild(item);
  }
}

function datasetUrl(relativePath) {
  return `/dataset/${String(relativePath).replace(/^\/?dataset\//, '').replace(/^\//, '')}`;
}

function setActiveViewButton(view) {
  [...viewList.children].forEach((child) => {
    child.classList.toggle('active', child.dataset.viewId === String(view.id));
  });
}

function showView(view, message = true) {
  selectedView = view;
  perspectiveImage.src = datasetUrl(view.pano);
  crosshair.hidden = true;
  setActiveViewButton(view);
  if (message) {
    annotationStatus.textContent = `Frame ${view.id}, yaw ${view.yaw}°. Click a static, well-defined pixel to place a marker.`;
  }
}

function selectScan(scan, duration = 1400, fromWalkthrough = false) {
  if (!fromWalkthrough) stopWalkthrough(false);
  currentScan = scan;
  scanLabel.textContent = `Scan ${scan.index}`;
  viewer.navigateTo(scan, duration);
  renderViewButtons(scan);
  if (scan.views[0]) showView(scan.views[0], false);
  status.textContent = `Moving to scan ${scan.index}. You can keep looking around during the transition.`;
  annotationStatus.textContent = `Source frame ${scan.views[0]?.id ?? '—'} selected. Click a yaw button to match a captured direction.`;
}

function renderViewButtons(scan) {
  viewList.replaceChildren();
  for (const view of scan.views) {
    const button = document.createElement('button');
    button.className = 'view-button';
    button.textContent = `${view.yaw}°`;
    button.dataset.viewId = String(view.id);
    button.addEventListener('click', () => {
      stopWalkthrough(false);
      viewer.orientToView(scan, view);
      showView(view);
      status.textContent = `Scan ${scan.index}, captured yaw ${view.yaw}°. Drag to continue looking around in place.`;
    });
    viewList.appendChild(button);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function setWalkthroughUi(running) {
  walkthroughRunning = running;
  startTourButton.disabled = running || allScans.length === 0;
  stopTourButton.disabled = !running;
  startTourButton.textContent = running ? 'Walking…' : 'Start walkthrough';
}

function stopWalkthrough(updateLabel = true) {
  walkthroughRun += 1;
  setWalkthroughUi(false);
  if (updateLabel && allScans.length > 0) tourProgress.textContent = 'Tour stopped';
}

async function startWalkthrough() {
  if (walkthroughRunning || allScans.length === 0) return;
  const run = ++walkthroughRun;
  setWalkthroughUi(true);

  const startIndex = currentScan
    ? Math.max(allScans.findIndex((scan) => scan.key === currentScan.key), 0)
    : 0;

  for (let offset = 0; offset < allScans.length; offset += 1) {
    if (run !== walkthroughRun) return;
    const index = (startIndex + offset) % allScans.length;
    const scan = allScans[index];

    tourProgress.textContent = `Scan ${offset + 1} of ${allScans.length}`;
    selectScan(scan, 1650, true);
    await delay(2100);
  }

  if (run === walkthroughRun) {
    setWalkthroughUi(false);
    tourProgress.textContent = 'Walkthrough complete';
  }
}

function imagePixelFromEvent(event) {
  const rect = perspectiveImage.getBoundingClientRect();
  const naturalWidth = perspectiveImage.naturalWidth;
  const naturalHeight = perspectiveImage.naturalHeight;
  if (!naturalWidth || !naturalHeight || rect.width <= 0 || rect.height <= 0) return null;

  // The image uses object-fit: contain, so it may have letterbox bars. Map the
  // click only inside the actually displayed image, not across the empty bars.
  const imageAspect = naturalWidth / naturalHeight;
  const boxAspect = rect.width / rect.height;
  let displayWidth;
  let displayHeight;
  let offsetX;
  let offsetY;

  if (imageAspect > boxAspect) {
    displayWidth = rect.width;
    displayHeight = displayWidth / imageAspect;
    offsetX = 0;
    offsetY = (rect.height - displayHeight) * 0.5;
  } else {
    displayHeight = rect.height;
    displayWidth = displayHeight * imageAspect;
    offsetX = (rect.width - displayWidth) * 0.5;
    offsetY = 0;
  }

  const localX = event.clientX - rect.left - offsetX;
  const localY = event.clientY - rect.top - offsetY;
  if (localX < 0 || localY < 0 || localX >= displayWidth || localY >= displayHeight) {
    return { outsideImage: true };
  }

  const normalizedX = THREE.MathUtils.clamp(localX / displayWidth, 0, 0.999999);
  const normalizedY = THREE.MathUtils.clamp(localY / displayHeight, 0, 0.999999);
  return {
    normalizedX,
    normalizedY,
    crosshairX: (offsetX + localX) / rect.width,
    crosshairY: (offsetY + localY) / rect.height,
  };
}

perspectiveImage.addEventListener('click', async (event) => {
  if (!selectedView || !currentScan) return;
  const pixel = imagePixelFromEvent(event);
  if (!pixel) return;
  if (pixel.outsideImage) {
    annotationStatus.textContent = 'Click inside the visible photograph, not the dark letterbox area.';
    return;
  }

  crosshair.hidden = false;
  crosshair.style.left = `${pixel.crosshairX * 100}%`;
  crosshair.style.top = `${pixel.crosshairY * 100}%`;

  try {
    annotationStatus.textContent = 'Loading depth, confidence and person mask…';
    const frame = await loadFrameData(selectedView.id);
    const u = Math.min(frame.meta.width - 1, Math.floor(pixel.normalizedX * frame.meta.width));
    const v = Math.min(frame.meta.height - 1, Math.floor(pixel.normalizedY * frame.meta.height));
    const index = v * frame.meta.width + u;
    const depth = frame.depth[index];
    const confidence = frame.confidence[index];
    const mask = frame.mask[index];

    if (!Number.isFinite(depth) || depth <= 0) throw new Error('No valid depth at this pixel.');
    if (mask !== 0) throw new Error('This pixel is inside a person-masked region.');
    if (!Number.isFinite(confidence) || confidence < HARD_MIN_DEPTH_CONFIDENCE) {
      throw new Error(`Depth confidence is unusably low (${Number(confidence).toFixed(3)}). Try a textured surface.`);
    }

    // The trained viewer uses one shared centre per 12-view scan group.
    // Keep that same centre here while retaining the selected view rotation.
    const world = pixelToWorld(
      u,
      v,
      depth,
      frame.meta.intrinsics,
      selectedView.R,
      selectedView.pos,
    );
    annotationCount += 1;
    const label = markerLabelInput.value.trim() || `Marker ${annotationCount}`;

    // Pull the visual annotation a few centimetres toward the source camera.
    // The raw backprojected point is preserved below, but the display point is
    // kept just in front of the surface so it does not visually sink into a wall.
    const sourceCentre = new THREE.Vector3(...selectedView.pos);
    const towardCamera = sourceCentre.clone().sub(world);
    const displayWorld = world.clone();
    if (towardCamera.lengthSq() > 1e-8) {
      displayWorld.addScaledVector(
        towardCamera.normalize(),
        Math.min(0.07, Math.max(0.025, depth * 0.025)),
      );
    }

    const markerId = viewer.addWorldMarker(displayWorld, label);
    annotations.push({
      markerId,
      label,
      world: displayWorld.clone(),
      rawWorld: world.clone(),
      scanIndex: currentScan.index,
      yaw: selectedView.yaw,
      frameId: selectedView.id,
      depth,
      confidence,
    });
    markerLabelInput.value = '';
    renderAnnotations();
    const confidenceNote = confidence < LOW_CONFIDENCE_WARNING
      ? 'low-confidence estimate—verify visually'
      : 'confidence accepted';
    annotationStatus.textContent = [
      label,
      `pixel (${u}, ${v})`,
      `depth ${depth.toFixed(2)} m`,
      `confidence ${confidence.toFixed(3)} (${confidenceNote})`,
      `world (${world.x.toFixed(2)}, ${world.y.toFixed(2)}, ${world.z.toFixed(2)})`,
    ].join(' · ');
  } catch (error) {
    annotationStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

clearMarkersButton.addEventListener('click', () => {
  viewer?.clearWorldMarkers();
  annotationCount = 0;
  annotations.length = 0;
  renderAnnotations();
  crosshair.hidden = true;
  annotationStatus.textContent = 'All 3D annotation markers cleared.';
});

startTourButton.addEventListener('click', () => void startWalkthrough());
stopTourButton.addEventListener('click', () => stopWalkthrough());

async function start() {
  try {
    status.textContent = 'Loading camera metadata…';
    const cameras = await loadCameras();
    const scans = groupScanPoints(cameras);
    const sceneFrame = deriveSceneFrame(cameras, scans);
    for (const scan of scans) scan.xy = projectPointToFloor(scan.pos, sceneFrame);

    allScans = scans;
    viewer = new SplatViewer(viewerElement, sceneFrame);
    minimap = new Minimap(minimapElement, (scan) => selectScan(scan));
    viewer.addScanPoints(scans);
    viewer.onScanSelected = (scan) => selectScan(scan);
    viewer.onAnnotationRename = (markerId, label) => renameAnnotation(markerId, label);
    viewer.onAnnotationRemove = (markerId) => removeAnnotation(markerId);

    const hasFloorplan = await minimap.loadBackground();
    minimap.setPoints(scans);
    if (!hasFloorplan) {
      console.info('Using fallback minimap. Run python scripts/generate_minimap.py for scanner background.');
    }

    status.textContent = 'Loading trained Gaussian splat…';
    await viewer.loadSplat('/scene/scene-c2.ply');

    setWalkthroughUi(false);
    tourProgress.textContent = `${scans.length} scan points ready`;
    if (scans[0]) {
      currentScan = scans[0];
      viewer.jumpTo(scans[0], scans[0].views[0]);
      renderViewButtons(scans[0]);
      showView(scans[0].views[0]);
      scanLabel.textContent = `Scan ${scans[0].index}`;
    }
    status.textContent = hasFloorplan
      ? 'Ready. Minimap background, locked walkthrough and depth annotations are active.'
      : 'Ready. Generate the floor-plan image to replace the fallback minimap background.';

    const updateMinimap = () => {
      const state = viewer.getGroundPositionAndHeading();
      minimap.update(state.position, state.heading);
      requestAnimationFrame(updateMinimap);
    };
    updateMinimap();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    console.error(error);
  }
}

renderAnnotations();
void start();
