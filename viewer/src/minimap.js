export class Minimap {
  constructor(container, onSelect) {
    this.points = [];
    this.minX = 0;
    this.maxX = 1;
    this.minY = 0;
    this.maxY = 1;
    this.backgroundBounds = null;

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', '0 0 300 220');
    this.svg.classList.add('minimap-svg');

    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('x', '0');
    background.setAttribute('y', '0');
    background.setAttribute('width', '300');
    background.setAttribute('height', '220');
    background.setAttribute('rx', '12');
    background.setAttribute('class', 'minimap-bg');
    this.svg.appendChild(background);

    this.backgroundImage = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    this.backgroundImage.setAttribute('x', '0');
    this.backgroundImage.setAttribute('y', '0');
    this.backgroundImage.setAttribute('width', '300');
    this.backgroundImage.setAttribute('height', '220');
    this.backgroundImage.setAttribute('preserveAspectRatio', 'none');
    this.backgroundImage.setAttribute('class', 'minimap-floorplan');
    this.backgroundImage.setAttribute('visibility', 'hidden');
    this.svg.appendChild(this.backgroundImage);

    this.markerLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.svg.appendChild(this.markerLayer);

    this.headingLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    this.headingLine.setAttribute('class', 'minimap-heading');
    this.svg.appendChild(this.headingLine);

    this.currentMarker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    this.currentMarker.setAttribute('r', '5');
    this.currentMarker.setAttribute('class', 'minimap-current');
    this.svg.appendChild(this.currentMarker);

    container.appendChild(this.svg);

    this.svg.addEventListener('click', (event) => {
      const scanKey = event.target.dataset?.scanKey;
      const scan = this.points.find((item) => item.key === scanKey);
      if (scan) onSelect(scan);
    });
  }

  async loadBackground(metadataUrl = '/minimap/floorplan.json', imageUrl = '/minimap/floorplan.png') {
    try {
      const response = await fetch(metadataUrl);
      if (!response.ok) return false;
      const metadata = await response.json();
      const bounds = metadata.bounds;
      if (![bounds?.minX, bounds?.maxX, bounds?.minY, bounds?.maxY].every(Number.isFinite)) {
        return false;
      }

      this.backgroundBounds = bounds;
      this.backgroundImage.setAttribute('href', imageUrl);
      this.backgroundImage.setAttribute('visibility', 'visible');
      this.applyBounds();
      if (this.points.length > 0) this.renderPoints();
      return true;
    } catch (error) {
      console.warn('Minimap floor-plan background is unavailable:', error);
      return false;
    }
  }

  setPoints(points) {
    this.points = points;
    this.applyBounds();
    this.renderPoints();
  }

  applyBounds() {
    if (this.backgroundBounds) {
      this.minX = this.backgroundBounds.minX;
      this.maxX = this.backgroundBounds.maxX;
      this.minY = this.backgroundBounds.minY;
      this.maxY = this.backgroundBounds.maxY;
      return;
    }

    if (this.points.length === 0) return;
    const xs = this.points.map((point) => point.xy[0]);
    const ys = this.points.map((point) => point.xy[1]);
    this.minX = Math.min(...xs);
    this.maxX = Math.max(...xs);
    this.minY = Math.min(...ys);
    this.maxY = Math.max(...ys);
  }

  renderPoints() {
    this.markerLayer.replaceChildren();
    if (this.points.length === 0) return;

    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', this.points.map((point) => this.map(point.xy).join(',')).join(' '));
    polyline.setAttribute('class', 'minimap-path');
    this.markerLayer.appendChild(polyline);

    for (const point of this.points) {
      const [x, y] = this.map(point.xy);
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.dataset.scanKey = point.key;
      group.setAttribute('class', 'minimap-scan-group');

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', String(x));
      circle.setAttribute('cy', String(y));
      circle.setAttribute('r', '4.5');
      circle.setAttribute('class', 'minimap-scan');
      circle.dataset.scanKey = point.key;
      group.appendChild(circle);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(x));
      label.setAttribute('y', String(y - 8));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'minimap-label');
      label.textContent = String(point.index);
      label.dataset.scanKey = point.key;
      group.appendChild(label);

      this.markerLayer.appendChild(group);
    }
  }

  update(position, heading) {
    const [x, y] = this.map(position);
    this.currentMarker.setAttribute('cx', String(x));
    this.currentMarker.setAttribute('cy', String(y));

    const length = 22;
    const magnitude = Math.hypot(heading[0], heading[1]) || 1;
    const dx = (heading[0] / magnitude) * length;
    const dy = -(heading[1] / magnitude) * length;
    this.headingLine.setAttribute('x1', String(x));
    this.headingLine.setAttribute('y1', String(y));
    this.headingLine.setAttribute('x2', String(x + dx));
    this.headingLine.setAttribute('y2', String(y + dy));
  }

  map(xy) {
    const padding = 12;
    const width = 300 - padding * 2;
    const height = 220 - padding * 2;
    const rangeX = Math.max(this.maxX - this.minX, 0.001);
    const rangeY = Math.max(this.maxY - this.minY, 0.001);
    return [
      padding + ((xy[0] - this.minX) / rangeX) * width,
      220 - padding - ((xy[1] - this.minY) / rangeY) * height,
    ];
  }
}
