import {
  destinationPoint,
  earthWorld,
  latLngToSphere,
  UNITS_PER_DEG,
  type EarthJunction,
  type EarthLandmark,
  type EarthRegionZone,
  type GlobeNetworkData,
  type GlobeWaterwayPolyline,
  type WeatherParams,
} from '../earth';
import type { RouteMode } from '../types';

export interface MiniEarthGlobeOptions {
  initialTrackId?: string;
  initialRouteMode?: RouteMode;
  onSelectTrack?: (trackId: string) => void;
}

export interface LiveGlobePosition {
  lat: number;
  lng: number;
  waterwayId?: string;
}

interface ProjectedPin {
  zone: EarthRegionZone;
  screenX: number;
  screenY: number;
  z: number;
  visible: boolean;
  isSelected: boolean;
  isConnectedOutgoing: boolean;
  isVisited: boolean;
}

const PARTICLE_SHAPE_ICONS: Record<string, string> = {
  pollen: '☀️',
  petal: '🌸',
  rain: '⛈️',
  dust: '🌅',
  snow: '❄️',
  ember: '🔥',
  mist: '🌫️',
};

/**
 * Return the data-driven icon for any `EarthRegionZone` (zero hardcoded region maps!).
 */
export function getZoneIcon(zoneOrId?: string | EarthRegionZone | null): string {
  if (!zoneOrId) return '🌍';
  const zone =
    typeof zoneOrId === 'string'
      ? earthWorld.findZoneById(zoneOrId)
      : zoneOrId;
  if (!zone) return '🌊';
  return zone.icon ?? zone.weather.icon ?? PARTICLE_SHAPE_ICONS[zone.weather.particleShape] ?? '🌊';
}

/**
 * Backward-compatible alias for `getZoneIcon`.
 */
export function getTrackIcon(trackOrId?: string | EarthRegionZone | null): string {
  return getZoneIcon(trackOrId);
}

/**
 * Return the data-driven weather icon for a `WeatherParams` object or weather shape/id string.
 */
export function getWeatherIcon(weatherOrShape?: WeatherParams | string | null): string {
  if (!weatherOrShape) return '🌤️';
  if (typeof weatherOrShape === 'object') {
    return (
      weatherOrShape.icon ??
      PARTICLE_SHAPE_ICONS[weatherOrShape.particleShape] ??
      '🌤️'
    );
  }
  return PARTICLE_SHAPE_ICONS[weatherOrShape] ?? '🌤️';
}

/**
 * Format difficulty (1..3) as stars and human label.
 */
export function formatTrackDifficulty(difficulty: 1 | 2 | 3): {
  stars: string;
  label: string;
} {
  if (difficulty === 1) return { stars: '★☆☆', label: 'Scenic' };
  if (difficulty === 2) return { stars: '★★☆', label: 'Technical' };
  return { stars: '★★★', label: 'Extreme' };
}

/**
 * Format geographic coordinates as a crisp GPS string (e.g. "35.0°N · 135.7°E").
 */
export function formatLatLng(lat: number, lng: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}°${ns} · ${Math.abs(lng).toFixed(1)}°${ew}`;
}

/**
 * Resolve the list of distinct outgoing destination `EarthRegionZone`s physically connected
 * from a given zone's waterways in `earthWorld`.
 */
export function getConnectedZonesForRegion(regionId: string): EarthRegionZone[] {
  const primary = earthWorld.getPrimaryWaterwayForRegion(regionId);
  const visitedIds = new Set<string>([regionId]);
  const results: EarthRegionZone[] = [];

  const inspectJunction = (junctionId: string): void => {
    const outgoing = earthWorld.getOutgoingWaterways(junctionId);
    for (const ww of outgoing) {
      const target = earthWorld.resolveTargetRegionForWaterway(ww);
      if (target && !visitedIds.has(target.id)) {
        visitedIds.add(target.id);
        results.push(target);
      }
    }
  };

  if (primary) {
    inspectJunction(primary.toJunctionId);
  }

  // Also check any other waterways originating in this region
  for (const ww of earthWorld.getAllWaterways()) {
    if (ww.regionId !== regionId) continue;
    const target = earthWorld.resolveTargetRegionForWaterway(ww);
    if (target && !visitedIds.has(target.id)) {
      visitedIds.add(target.id);
      results.push(target);
    }
  }

  return results;
}

/**
 * Stylized low-poly continent outlines in [lat, lng] degrees for the 3D Mini-Earth Globe.
 */
const CONTINENT_POLYGONS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // North America
  [
    [70, -162],
    [71, -128],
    [66, -96],
    [60, -64],
    [47, -53],
    [41, -70],
    [30, -81],
    [25, -80],
    [29, -95],
    [19, -96],
    [15, -84],
    [9, -79],
    [16, -99],
    [23, -106],
    [32, -117],
    [48, -125],
    [60, -141],
    [61, -165],
  ],
  // South America
  [
    [11, -75],
    [10, -62],
    [4, -51],
    [-6, -35],
    [-23, -42],
    [-35, -54],
    [-54, -68],
    [-50, -75],
    [-18, -71],
    [-5, -81],
    [5, -77],
  ],
  // Greenland & Iceland
  [
    [60, -44],
    [69, -24],
    [81, -18],
    [82, -55],
    [72, -56],
  ],
  [
    [63, -24],
    [66, -14],
    [64, -14],
    [63, -21],
  ],
  // Europe
  [
    [36, -9],
    [44, -8],
    [48, -4],
    [54, 9],
    [62, 5],
    [71, 26],
    [67, 41],
    [58, 38],
    [46, 30],
    [41, 28],
    [38, 22],
    [40, 15],
    [44, 8],
    [37, -2],
  ],
  // Africa
  [
    [36, -6],
    [37, 10],
    [32, 32],
    [12, 51],
    [-2, 41],
    [-26, 33],
    [-35, 20],
    [-16, 12],
    [4, 9],
    [5, -8],
    [15, -17],
    [28, -13],
  ],
  // Asia
  [
    [42, 29],
    [67, 42],
    [73, 85],
    [72, 138],
    [65, 176],
    [52, 158],
    [42, 132],
    [31, 121],
    [22, 114],
    [10, 105],
    [2, 103],
    [16, 97],
    [22, 88],
    [8, 78],
    [24, 67],
    [26, 56],
    [13, 44],
    [29, 34],
  ],
  // Japan Archipelago
  [
    [31, 130],
    [35, 136],
    [40, 140],
    [44, 145],
    [42, 141],
    [36, 136],
    [33, 131],
  ],
  // Australia
  [
    [-12, 131],
    [-12, 142],
    [-25, 153],
    [-38, 146],
    [-34, 135],
    [-34, 115],
    [-22, 114],
    [-15, 124],
  ],
];

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function wrapAngleRad(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '').trim();
  const num = parseInt(
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean,
    16,
  );
  if (Number.isNaN(num)) return `rgba(56, 242, 216, ${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Interactive 3D Shared-Planet Mini-Earth Globe rendered on a crisp high-DPI `<canvas>`.
 *
 * Renders 100% live data directly from `earthWorld.getGlobeNetworkData()`:
 * - Spatial `EarthRegionZone` footprints
 * - Actual physically connected `EarthWaterway` polylines curving across continents & oceans
 * - Real `EarthJunction` confluence & 2-way fork nodes
 * - Persistent `EarthLandmark` markers
 * - Pulsing golden live GPS position of the player's duck (`setLivePosition(lat, lng, waterwayId?)`)
 * - Pointer drag spinning + smooth spring centering + tap/click hit-testing on region pins
 */
export class MiniEarthGlobe {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly onSelectTrack?: (trackId: string) => void;

  private selectedTrackId: string;
  private routeMode: RouteMode;
  private visitedTrackIds = new Set<string>();
  private hoveredTrackId: string | null = null;
  private livePos: LiveGlobePosition | null = null;

  // Cached planetary network data from earthWorld (refreshed on demand)
  private networkData: GlobeNetworkData;
  private zoneFootprintCache = new Map<string, Array<{ lat: number; lng: number }>>();

  // 3D rotation angles in radians: rotY = longitude yaw, rotX = latitude pitch
  private rotY = 0;
  private rotX = 0.35;
  private targetRotY = 0;
  private targetRotX = 0.35;
  private velY = 0;
  private velX = 0;
  private springCentering = true;

  // Pointer drag state
  private isDragging = false;
  private dragPointerId: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private dragDistanceSq = 0;

  // Animation loop & sizing
  private active = false;
  private disposed = false;
  private rafId: number | null = null;
  private lastTimeMs = 0;
  private animTime = 0;
  private cssWidth = 300;
  private cssHeight = 300;
  private dpr = 1;
  private resizeObserver: ResizeObserver | null = null;

  // Cached projected pins for hit-testing
  private projectedPins: ProjectedPin[] = [];
  private cleanups: Array<() => void> = [];

  constructor(
    containerOrCanvas: HTMLElement | HTMLCanvasElement,
    options?: MiniEarthGlobeOptions,
  ) {
    if (containerOrCanvas instanceof HTMLCanvasElement) {
      this.canvas = containerOrCanvas;
    } else {
      const canvas = document.createElement('canvas');
      canvas.className = 'rd-globe-canvas';
      canvas.setAttribute('aria-label', 'Interactive 3D Shared Mini-Earth Globe');
      containerOrCanvas.appendChild(canvas);
      this.canvas = canvas;
    }

    this.ctx = this.canvas.getContext('2d');
    this.onSelectTrack = options?.onSelectTrack;
    this.routeMode = options?.initialRouteMode ?? 'world_tour';
    this.selectedTrackId = earthWorld.getZoneById(options?.initialTrackId).id;
    this.visitedTrackIds.add(this.selectedTrackId);

    this.networkData = earthWorld.getGlobeNetworkData();
    this.rebuildZoneFootprints();

    this.centerOnTrack(this.selectedTrackId, true);
    this.bindEvents();
    this.resize();
    this.render(0);
  }

  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  public getSelectedTrackId(): string {
    return this.selectedTrackId;
  }

  public setSelectedTrack(trackId: string, animateCenter = true): void {
    const zone = earthWorld.getZoneById(trackId);
    this.selectedTrackId = zone.id;
    this.visitedTrackIds.add(zone.id);
    if (animateCenter) {
      this.centerOnTrack(zone.id, false);
    }
    this.render(0);
  }

  public getRouteMode(): RouteMode {
    return this.routeMode;
  }

  public setRouteMode(mode: RouteMode): void {
    if (this.routeMode !== mode) {
      this.routeMode = mode;
      this.render(0);
    }
  }

  public setVisitedTracks(trackIds: readonly string[]): void {
    this.visitedTrackIds.clear();
    for (const id of trackIds) {
      this.visitedTrackIds.add(id);
    }
    this.visitedTrackIds.add(this.selectedTrackId);
    if (this.active) this.render(0);
  }

  /**
   * Update the duck's live planetary GPS coordinates on the 3D Mini-Earth Globe.
   */
  public setLivePosition(lat: number, lng: number, waterwayId?: string | null): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    this.livePos = {
      lat,
      lng,
      waterwayId: waterwayId ?? undefined,
    };
    if (this.active) {
      this.render(0);
    }
  }

  public clearLivePosition(): void {
    this.livePos = null;
    if (this.active) this.render(0);
  }

  public getLivePosition(): LiveGlobePosition | null {
    return this.livePos ? { ...this.livePos } : null;
  }

  /**
   * Refresh cached planetary data from `earthWorld.getGlobeNetworkData()`
   * (e.g. after a contributor pack is registered dynamically at runtime).
   */
  public refreshNetworkData(): void {
    this.networkData = earthWorld.getGlobeNetworkData();
    this.rebuildZoneFootprints();
    this.render(0);
  }

  public getNetworkData(): GlobeNetworkData {
    return this.networkData;
  }

  /**
   * Rotate the 3D globe so any `(lat, lng)` point is centered in front (+Z).
   */
  public centerOnLatLng(lat: number, lng: number, immediate = false): void {
    const latRad = (lat * Math.PI) / 180;
    const lngRad = (lng * Math.PI) / 180;

    const desiredY = -lngRad;
    const desiredX = clamp(latRad * 0.85, -1.1, 1.1);

    if (immediate) {
      this.rotY = desiredY;
      this.rotX = desiredX;
      this.targetRotY = desiredY;
      this.targetRotX = desiredX;
      this.velX = 0;
      this.velY = 0;
      this.springCentering = false;
    } else {
      const deltaY = wrapAngleRad(desiredY - this.rotY);
      this.targetRotY = this.rotY + deltaY;
      this.targetRotX = desiredX;
      this.velX = 0;
      this.velY = 0;
      this.springCentering = true;
    }
  }

  /**
   * Rotate the 3D globe so the target region zone's center `(lat, lng)` is in front (+Z).
   */
  public centerOnTrack(trackId: string, immediate = false): void {
    const zone = earthWorld.getZoneById(trackId);
    this.centerOnLatLng(zone.centerLat, zone.centerLng, immediate);
  }

  public setActive(active: boolean): void {
    if (this.disposed) return;
    if (this.active === active) {
      if (active) {
        this.resize();
        this.render(0);
      }
      return;
    }
    this.active = active;
    if (active) {
      this.networkData = earthWorld.getGlobeNetworkData();
      this.rebuildZoneFootprints();
      this.resize();
      this.lastTimeMs = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
    } else if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  public resize(): void {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    const parentRect = this.canvas.parentElement?.getBoundingClientRect();
    const w = Math.max(180, Math.round(rect.width || parentRect?.width || 280));
    const h = Math.max(180, Math.round(rect.height || parentRect?.height || 260));
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);

    if (w !== this.cssWidth || h !== this.cssHeight || dpr !== this.dpr) {
      this.cssWidth = w;
      this.cssHeight = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.setActive(false);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    for (const fn of this.cleanups) {
      fn();
    }
    this.cleanups = [];
  }

  private rebuildZoneFootprints(): void {
    this.zoneFootprintCache.clear();
    const steps = 22;
    for (const zone of this.networkData.zones) {
      const distU = Math.max(8, Math.min(28, zone.radiusDeg * 0.72)) * UNITS_PER_DEG;
      const ring: Array<{ lat: number; lng: number }> = [];
      for (let i = 0; i < steps; i++) {
        const brg = (i / steps) * 360;
        ring.push(destinationPoint(zone.centerLat, zone.centerLng, brg, distU));
      }
      this.zoneFootprintCache.set(zone.id, ring);
    }
  }

  private readonly tick = (nowMs: number): void => {
    if (!this.active || this.disposed) return;
    this.rafId = requestAnimationFrame(this.tick);
    const dt = clamp((nowMs - this.lastTimeMs) / 1000, 0.001, 0.08);
    this.lastTimeMs = nowMs;
    this.render(dt);
  };

  /**
   * Advance rotation physics and render the live Shared Mini-Earth Globe frame.
   */
  public render(dt = 0.016): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    if (!ctx) return;

    this.animTime += dt;
    this.stepRotationPhysics(dt);

    const w = this.cssWidth;
    const h = this.cssHeight;
    const cx = w * 0.5;
    const cy = h * 0.515;
    const radius = Math.max(60, Math.min(w, h) * 0.355);

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, w, h);

    // 1. Atmospheric outer corona & orbital ring
    this.drawAtmosphereBackdrop(ctx, cx, cy, radius);

    // 2. Clipped 3D Ocean Sphere Base + Continents + Graticule + Spatial Zone Footprints
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    const oceanGrad = ctx.createRadialGradient(
      cx - radius * 0.32,
      cy - radius * 0.34,
      radius * 0.08,
      cx,
      cy,
      radius * 1.04,
    );
    oceanGrad.addColorStop(0, '#16698a');
    oceanGrad.addColorStop(0.45, '#0b3d59');
    oceanGrad.addColorStop(0.82, '#062235');
    oceanGrad.addColorStop(1, '#031320');
    ctx.fillStyle = oceanGrad;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

    // Back-hemisphere faint graticule
    this.drawGraticule(ctx, cx, cy, radius, false);

    // Stylized 3D continents
    this.drawContinents(ctx, cx, cy, radius);

    // Spatial EarthRegionZone biome footprints
    this.drawZoneFootprints(ctx, cx, cy, radius);

    // Front-hemisphere lat/lng graticule
    this.drawGraticule(ctx, cx, cy, radius, true);

    // Inner atmospheric limb shading
    const rimGrad = ctx.createRadialGradient(cx, cy, radius * 0.68, cx, cy, radius);
    rimGrad.addColorStop(0, 'rgba(56, 242, 216, 0)');
    rimGrad.addColorStop(0.76, 'rgba(56, 242, 216, 0.06)');
    rimGrad.addColorStop(1, 'rgba(84, 245, 255, 0.32)');
    ctx.fillStyle = rimGrad;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();

    // Crisp outer globe rim border
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(130, 245, 255, 0.44)';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // 3. Actual 17 Physically Connected EarthWaterway Polylines
    this.drawWaterwayPolylines(ctx, cx, cy, radius, this.networkData.waterways);

    // 4. 18 Persistent EarthLandmark Markers
    this.drawLandmarks(ctx, cx, cy, radius, this.networkData.landmarks);

    // 5. 11 Real EarthJunction Confluence & Fork Nodes
    this.drawJunctionNodes(ctx, cx, cy, radius, this.networkData.junctions);

    // 6. Pulsing Interactive Region Zone Pins
    this.drawZonePins(ctx, cx, cy, radius, this.networkData.zones);

    // 7. Duck's Live (lat, lng) Pulsing Golden GPS Indicator
    if (this.livePos) {
      this.drawLiveGpsBeacon(ctx, cx, cy, radius, this.livePos);
    }

    ctx.restore();
  }

  private stepRotationPhysics(dt: number): void {
    if (this.isDragging) return;

    if (this.springCentering) {
      const diffY = this.targetRotY - this.rotY;
      const diffX = this.targetRotX - this.rotX;
      const k = 1 - Math.exp(-9.5 * dt);
      this.rotY += diffY * k;
      this.rotX += diffX * k;
      if (Math.abs(diffY) < 0.002 && Math.abs(diffX) < 0.002) {
        this.rotY = wrapAngleRad(this.targetRotY);
        this.targetRotY = this.rotY;
        this.rotX = this.targetRotX;
        this.springCentering = false;
      }
      return;
    }

    this.rotY = wrapAngleRad(this.rotY + this.velY * dt);
    this.rotX = clamp(this.rotX + this.velX * dt, -1.18, 1.18);

    const damping = Math.exp(-5.5 * dt);
    this.velY *= damping;
    this.velX *= damping;

    if (Math.abs(this.velY) < 0.01 && Math.abs(this.velX) < 0.01) {
      this.rotY = wrapAngleRad(this.rotY + Math.sin(this.animTime * 0.55) * 0.032 * dt);
    }
  }

  private projectVec3(
    v: { x: number; y: number; z: number },
    cx: number,
    cy: number,
    radius: number,
  ): { x: number; y: number; z: number } {
    const cosY = Math.cos(this.rotY);
    const sinY = Math.sin(this.rotY);
    const x1 = v.x * cosY + v.z * sinY;
    const z1 = -v.x * sinY + v.z * cosY;
    const y1 = v.y;

    const cosX = Math.cos(this.rotX);
    const sinX = Math.sin(this.rotX);
    const y2 = y1 * cosX - z1 * sinX;
    const z2 = y1 * sinX + z1 * cosX;

    return {
      x: cx + x1 * radius,
      y: cy - y2 * radius,
      z: z2,
    };
  }

  private projectLatLng(
    lat: number,
    lng: number,
    altitudeScale: number,
    cx: number,
    cy: number,
    radius: number,
  ): { x: number; y: number; z: number } {
    const v = latLngToSphere(lat, lng, altitudeScale);
    return this.projectVec3(v, cx, cy, radius);
  }

  private drawAtmosphereBackdrop(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
  ): void {
    const selected = earthWorld.getZoneById(this.selectedTrackId);
    const haloGrad = ctx.createRadialGradient(cx, cy, radius * 0.86, cx, cy, radius * 1.32);
    haloGrad.addColorStop(0, hexToRgba(selected.globeColor, 0.28));
    haloGrad.addColorStop(0.48, 'rgba(56, 242, 216, 0.12)');
    haloGrad.addColorStop(1, 'rgba(7, 30, 40, 0)');

    ctx.fillStyle = haloGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.32, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.strokeStyle = 'rgba(165, 245, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawGraticule(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    frontHemisphere: boolean,
  ): void {
    ctx.strokeStyle = frontHemisphere
      ? 'rgba(145, 238, 255, 0.13)'
      : 'rgba(90, 185, 215, 0.05)';
    ctx.lineWidth = frontHemisphere ? 0.85 : 0.6;

    for (let lat = -60; lat <= 60; lat += 30) {
      ctx.beginPath();
      let penDown = false;
      for (let lng = -180; lng <= 180; lng += 8) {
        const p = this.projectLatLng(lat, lng, 1.0, cx, cy, radius);
        if ((p.z >= 0) === frontHemisphere) {
          if (!penDown) {
            ctx.moveTo(p.x, p.y);
            penDown = true;
          } else {
            ctx.lineTo(p.x, p.y);
          }
        } else {
          penDown = false;
        }
      }
      ctx.stroke();
    }

    for (let lng = -180; lng < 180; lng += 30) {
      ctx.beginPath();
      let penDown = false;
      for (let lat = -80; lat <= 80; lat += 8) {
        const p = this.projectLatLng(lat, lng, 1.0, cx, cy, radius);
        if ((p.z >= 0) === frontHemisphere) {
          if (!penDown) {
            ctx.moveTo(p.x, p.y);
            penDown = true;
          } else {
            ctx.lineTo(p.x, p.y);
          }
        } else {
          penDown = false;
        }
      }
      ctx.stroke();
    }
  }

  private drawContinents(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
  ): void {
    ctx.fillStyle = 'rgba(46, 178, 152, 0.22)';
    ctx.strokeStyle = 'rgba(110, 248, 218, 0.36)';
    ctx.lineWidth = 1.05;

    for (const poly of CONTINENT_POLYGONS) {
      let visibleVertices = 0;
      const pts: Array<{ x: number; y: number; z: number }> = [];
      for (let i = 0; i < poly.length; i++) {
        const [lat, lng] = poly[i];
        const p = this.projectLatLng(lat, lng, 1.0, cx, cy, radius);
        if (p.z > -0.15) visibleVertices++;
        pts.push(p);
      }
      if (visibleVertices < 3) continue;

      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i];
        let px = pt.x;
        let py = pt.y;
        if (pt.z < 0) {
          const dx = px - cx;
          const dy = py - cy;
          const d = Math.hypot(dx, dy) || 1;
          px = cx + (dx / d) * radius;
          py = cy + (dy / d) * radius;
        }
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  /**
   * Render spatial `EarthRegionZone` biome footprints directly on the globe surface.
   */
  private drawZoneFootprints(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
  ): void {
    for (const zone of this.networkData.zones) {
      const ring = this.zoneFootprintCache.get(zone.id);
      if (!ring || ring.length < 3) continue;

      const isSelected = zone.id === this.selectedTrackId;
      let frontPts = 0;
      const pts: Array<{ x: number; y: number; z: number }> = [];
      for (let i = 0; i < ring.length; i++) {
        const p = this.projectLatLng(ring[i].lat, ring[i].lng, 1.0, cx, cy, radius);
        if (p.z > -0.1) frontPts++;
        pts.push(p);
      }
      if (frontPts < 3) continue;

      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i];
        let px = pt.x;
        let py = pt.y;
        if (pt.z < 0) {
          const dx = px - cx;
          const dy = py - cy;
          const d = Math.hypot(dx, dy) || 1;
          px = cx + (dx / d) * radius;
          py = cy + (dy / d) * radius;
        }
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = hexToRgba(zone.globeColor, isSelected ? 0.23 : 0.1);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(zone.accentColor, isSelected ? 0.52 : 0.22);
      ctx.lineWidth = isSelected ? 1.3 : 0.85;
      ctx.setLineDash(isSelected ? [] : [3, 4]);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Render the ACTUAL physically connected `EarthWaterway` polylines curving across Mini-Earth!
   */
  private drawWaterwayPolylines(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    waterways: readonly GlobeWaterwayPolyline[],
  ): void {
    const selectedZone = earthWorld.getZoneById(this.selectedTrackId);
    const selectedPrimary = earthWorld.getPrimaryWaterwayForRegion(selectedZone.id);
    const outgoingFromPrimary = new Set(
      selectedPrimary
        ? earthWorld.getOutgoingWaterways(selectedPrimary.toJunctionId).map((w) => w.id)
        : [],
    );

    const isLockedSingle = this.routeMode === 'single_track';
    const liveWaterwayId = this.livePos?.waterwayId;

    for (const ww of waterways) {
      if (ww.points.length < 2) continue;

      const isLiveWw = Boolean(liveWaterwayId && ww.id === liveWaterwayId);
      const isSelectedRegionWw = ww.regionId === selectedZone.id && !ww.isConnector;
      const isOutgoingActive = !isLockedSingle && outgoingFromPrimary.has(ww.id);
      const isEmphasized = isLiveWw || isSelectedRegionWw || isOutgoingActive;

      const pts: Array<{ x: number; y: number; z: number }> = [];
      let frontCount = 0;
      const n = ww.points.length;

      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const pt = ww.points[i];
        // Slight graceful elevation above ocean sphere for intercontinental currents
        const archLift = ww.isConnector
          ? 1.008 + Math.sin(Math.PI * t) * 0.048
          : 1.006;
        const proj = this.projectLatLng(pt.lat, pt.lng, archLift, cx, cy, radius);
        if (proj.z > -0.1) frontCount++;
        pts.push(proj);
      }

      if (frontCount < 2) continue;

      ctx.save();
      ctx.beginPath();
      let penDown = false;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p.z > -0.12) {
          if (!penDown) {
            ctx.moveTo(p.x, p.y);
            penDown = true;
          } else {
            ctx.lineTo(p.x, p.y);
          }
        } else {
          penDown = false;
        }
      }

      if (isLiveWw) {
        ctx.strokeStyle = '#ffe45e';
        ctx.lineWidth = 3.2;
        ctx.shadowColor = '#ffe45e';
        ctx.shadowBlur = 10;
        ctx.stroke();
      } else if (isSelectedRegionWw) {
        ctx.strokeStyle = hexToRgba(ww.accentColor, 0.96);
        ctx.lineWidth = 3.0;
        ctx.shadowColor = ww.accentColor;
        ctx.shadowBlur = 9;
        ctx.stroke();
      } else if (isOutgoingActive) {
        ctx.strokeStyle = hexToRgba(ww.accentColor, 0.86);
        ctx.lineWidth = 2.35;
        ctx.shadowColor = ww.accentColor;
        ctx.shadowBlur = 7;
        ctx.stroke();
      } else if (ww.isConnector) {
        ctx.strokeStyle = hexToRgba(
          ww.accentColor,
          isLockedSingle ? 0.14 : 0.36,
        );
        ctx.lineWidth = 1.3;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
      } else {
        ctx.strokeStyle = hexToRgba(
          ww.accentColor,
          isLockedSingle ? 0.25 : 0.62,
        );
        ctx.lineWidth = 2.0;
        ctx.stroke();
      }

      // Animated directional water-current flow bead on active / outgoing waterways
      if (isEmphasized || (!isLockedSingle && ww.isConnector)) {
        const speed = ww.isConnector ? 0.34 : 0.5;
        const phaseOffset = ((ww.id.charCodeAt(3) || 1) % 7) * 0.15;
        const pulseT = (this.animTime * speed + phaseOffset) % 1;
        const pulseIdx = Math.min(n - 1, Math.floor(pulseT * (n - 1)));
        const pulsePt = pts[pulseIdx];
        if (pulsePt && pulsePt.z > -0.02) {
          ctx.shadowBlur = 6;
          ctx.shadowColor = isLiveWw ? '#ffe45e' : '#ffffff';
          ctx.fillStyle = isLiveWw ? '#fff8c4' : '#ffffff';
          ctx.beginPath();
          ctx.arc(pulsePt.x, pulsePt.y, isEmphasized ? 2.9 : 2.0, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
    }
  }

  /**
   * Render subtle sparkling diamond pips for all persistent `EarthLandmark` anchors.
   */
  private drawLandmarks(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    landmarks: readonly EarthLandmark[],
  ): void {
    for (const lm of landmarks) {
      const p = this.projectLatLng(lm.lat, lm.lng, 1.012, cx, cy, radius);
      if (p.z < 0.05) continue;

      const twinkle = 0.55 + 0.45 * Math.sin(this.animTime * 2.8 + lm.lat + lm.lng);
      const r = 2.2 + twinkle * 0.8;

      ctx.save();
      ctx.globalAlpha = clamp(p.z * 1.4, 0.2, 0.9);
      ctx.fillStyle = '#ffe98a';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - r);
      ctx.lineTo(p.x + r, p.y);
      ctx.lineTo(p.x, p.y + r);
      ctx.lineTo(p.x - r, p.y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Render real `EarthJunction` confluence & 2-way fork nodes across the planet.
   */
  private drawJunctionNodes(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    junctions: readonly EarthJunction[],
  ): void {
    for (const junc of junctions) {
      const p = this.projectLatLng(junc.lat, junc.lng, 1.014, cx, cy, radius);
      if (p.z < -0.08) continue;

      const outgoingCount = earthWorld.getOutgoingWaterways(junc.id).length;
      const isFork = junc.kind === 'fork' || outgoingCount >= 2;

      ctx.save();
      ctx.globalAlpha = p.z < 0 ? 0.35 : 0.95;

      if (isFork) {
        // Glowing 2-way river fork diamond node
        const r = 4.6;
        ctx.fillStyle = '#38f2d8';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.25;
        ctx.shadowColor = '#38f2d8';
        ctx.shadowBlur = 7;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r, p.y);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r, p.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(218, 252, 255, 0.85)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  /**
   * Render interactive 3D pins for every auto-discovered `EarthRegionZone`.
   */
  private drawZonePins(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    zones: readonly EarthRegionZone[],
  ): void {
    const selectedZone = earthWorld.getZoneById(this.selectedTrackId);
    const connectedZones = getConnectedZonesForRegion(selectedZone.id);
    const connectedIds = new Set(connectedZones.map((z) => z.id));
    const isLockedSingle = this.routeMode === 'single_track';

    const pins: ProjectedPin[] = zones.map((zone) => {
      const p = this.projectLatLng(zone.centerLat, zone.centerLng, 1.022, cx, cy, radius);
      return {
        zone,
        screenX: p.x,
        screenY: p.y,
        z: p.z,
        visible: p.z > -0.22,
        isSelected: zone.id === selectedZone.id,
        isConnectedOutgoing: !isLockedSingle && connectedIds.has(zone.id),
        isVisited: this.visitedTrackIds.has(zone.id),
      };
    });

    pins.sort((a, b) => a.z - b.z);
    this.projectedPins = pins;

    for (const pin of pins) {
      const { zone, screenX, screenY, z, isSelected, isConnectedOutgoing } = pin;
      const isHovered = this.hoveredTrackId === zone.id;
      const frontAlpha = z < 0 ? clamp((z + 0.35) * 1.4, 0.18, 0.52) : 1.0;

      ctx.save();
      ctx.globalAlpha = frontAlpha;

      // Pulsing sonar ring on selected or directly connected destination zone
      if (isSelected || isConnectedOutgoing || isHovered) {
        const pulse = (Math.sin(this.animTime * 3.8 + (isSelected ? 0 : 1.5)) + 1) * 0.5;
        const ringR = (isSelected ? 15.5 : 11.5) + pulse * (isSelected ? 8 : 5);
        ctx.beginPath();
        ctx.arc(screenX, screenY, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = hexToRgba(
          zone.globeColor,
          isSelected ? 0.86 - pulse * 0.45 : 0.55 - pulse * 0.3,
        );
        ctx.lineWidth = isSelected ? 2.4 : 1.55;
        ctx.stroke();
      }

      // Pin disc
      const pinRadius = isSelected ? 12.5 : isHovered || isConnectedOutgoing ? 10 : 8.5;
      ctx.beginPath();
      ctx.arc(screenX, screenY, pinRadius, 0, Math.PI * 2);
      ctx.fillStyle = zone.globeColor;
      ctx.shadowColor = zone.globeColor;
      ctx.shadowBlur = isSelected ? 14 : 6;
      ctx.fill();

      ctx.lineWidth = isSelected ? 2.4 : 1.5;
      ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.82)';
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Region emoji icon read directly from EarthRegionZone
      if (z > -0.1) {
        ctx.font = `${isSelected ? 12 : 10}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(getZoneIcon(zone), screenX, screenY + 0.5);
      }

      // Crisp floating label pill for front-facing pins
      if (z > 0.1 || isSelected || isHovered) {
        const label = isSelected
          ? `${zone.name} (${zone.country})`
          : isConnectedOutgoing
            ? `→ ${zone.country}`
            : zone.country;

        ctx.font = `${isSelected ? '800 10.5px' : '700 9.5px'} system-ui, -apple-system, sans-serif`;
        const textWidth = ctx.measureText(label).width;
        const padX = 7;
        const pillW = textWidth + padX * 2;
        const pillH = isSelected ? 19 : 16;
        const safeTop = 34;
        const safeBottom = this.cssHeight - pillH - 26;

        let pillX: number;
        let pillY: number;
        if (isSelected) {
          // Place selected region label cleanly below the pin so it never collides with 🦆 LIVE above
          pillX = clamp(screenX - pillW * 0.5, 8, this.cssWidth - pillW - 8);
          pillY = clamp(screenY + pinRadius + 9, safeTop, Math.max(safeTop, safeBottom));
        } else {
          const offsetRight = screenX <= cx ? -pillW - pinRadius - 6 : pinRadius + 6;
          pillX = clamp(screenX + offsetRight, 8, this.cssWidth - pillW - 8);
          pillY = clamp(screenY - pillH * 0.5, safeTop, Math.max(safeTop, safeBottom));
        }

        ctx.fillStyle = isSelected
          ? 'rgba(7, 26, 36, 0.92)'
          : 'rgba(7, 26, 36, 0.74)';
        ctx.strokeStyle = isSelected
          ? zone.accentColor
          : isConnectedOutgoing
            ? hexToRgba(zone.accentColor, 0.65)
            : 'rgba(212, 248, 255, 0.28)';
        ctx.lineWidth = isSelected ? 1.5 : 1;

        this.roundRect(ctx, pillX, pillY, pillW, pillH, 999);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = isSelected ? '#fff9d6' : '#e8fbff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, pillX + padX, pillY + pillH * 0.5 + 0.5);
      }

      ctx.restore();
    }
  }

  /**
   * Render the duck's live pulsing golden `(lat, lng)` GPS indicator on the 3D globe!
   */
  private drawLiveGpsBeacon(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    pos: LiveGlobePosition,
  ): void {
    const p = this.projectLatLng(pos.lat, pos.lng, 1.032, cx, cy, radius);
    const isBack = p.z < -0.08;

    ctx.save();
    ctx.globalAlpha = isBack ? 0.32 : 1.0;

    // Expanding golden sonar pulse rings
    const pulseA = (this.animTime * 1.45) % 1;
    const pulseB = (this.animTime * 1.45 + 0.5) % 1;

    for (const pulse of [pulseA, pulseB]) {
      const r = 6 + pulse * 16;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 228, 94, ${(1 - pulse) * 0.85})`;
      ctx.lineWidth = 2.0;
      ctx.stroke();
    }

    // Core golden GPS duck marker
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6.2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd93b';
    ctx.shadowColor = '#ffb319';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.lineWidth = 2.0;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Subtle "LIVE" tag cleanly positioned above the golden beacon
    if (!isBack) {
      const tag = '🦆 LIVE';
      ctx.font = '800 9px system-ui, -apple-system, sans-serif';
      const tw = ctx.measureText(tag).width;
      const pw = tw + 10;
      const ph = 15;
      const safeTop = 34;
      const safeBottom = this.cssHeight - ph - 26;
      const px = clamp(p.x - pw * 0.5, 8, this.cssWidth - pw - 8);
      const py = clamp(p.y - ph - 14, safeTop, Math.max(safeTop, safeBottom));

      ctx.fillStyle = 'rgba(38, 22, 0, 0.9)';
      ctx.strokeStyle = '#ffe45e';
      ctx.lineWidth = 1.2;
      this.roundRect(ctx, px, py, pw, ph, 999);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#fff5b8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tag, px + pw * 0.5, py + ph * 0.5 + 0.5);
    }

    ctx.restore();
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const radius = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  private hitTestPin(localX: number, localY: number): EarthRegionZone | null {
    let bestPin: ProjectedPin | null = null;
    let bestDist = 28;

    for (let i = this.projectedPins.length - 1; i >= 0; i--) {
      const pin = this.projectedPins[i];
      if (pin.z < -0.25) continue;
      const d = Math.hypot(localX - pin.screenX, localY - pin.screenY);
      if (d <= bestDist) {
        bestDist = d;
        bestPin = pin;
      }
    }
    return bestPin ? bestPin.zone : null;
  }

  private getLocalCoords(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  private bindEvents(): void {
    const onPointerDown = (e: PointerEvent): void => {
      if (this.dragPointerId !== null) return;
      e.stopPropagation();
      this.dragPointerId = e.pointerId;
      this.isDragging = true;
      this.springCentering = false;
      const pt = this.getLocalCoords(e);
      this.dragStartX = pt.x;
      this.dragStartY = pt.y;
      this.lastPointerX = pt.x;
      this.lastPointerY = pt.y;
      this.dragDistanceSq = 0;
      this.velX = 0;
      this.velY = 0;

      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Ignore synthetic event pointer capture failure
      }
    };

    const onPointerMove = (e: PointerEvent): void => {
      const pt = this.getLocalCoords(e);

      if (!this.isDragging || e.pointerId !== this.dragPointerId) {
        const hit = this.hitTestPin(pt.x, pt.y);
        const nextHover = hit ? hit.id : null;
        if (nextHover !== this.hoveredTrackId) {
          this.hoveredTrackId = nextHover;
          this.canvas.style.cursor = nextHover ? 'pointer' : 'grab';
          if (!this.active) this.render(0);
        }
        return;
      }

      e.stopPropagation();
      const dx = pt.x - this.lastPointerX;
      const dy = pt.y - this.lastPointerY;
      this.lastPointerX = pt.x;
      this.lastPointerY = pt.y;

      const totalDx = pt.x - this.dragStartX;
      const totalDy = pt.y - this.dragStartY;
      this.dragDistanceSq = totalDx * totalDx + totalDy * totalDy;

      const sensitivity = 0.0085;
      this.rotY = wrapAngleRad(this.rotY - dx * sensitivity);
      this.rotX = clamp(this.rotX + dy * sensitivity, -1.15, 1.15);
      this.velY = clamp(-dx * 0.25, -4, 4);
      this.velX = clamp(dy * 0.2, -3, 3);

      this.canvas.style.cursor = 'grabbing';
      if (!this.active) this.render(0);
    };

    const onPointerUp = (e: PointerEvent): void => {
      if (e.pointerId !== this.dragPointerId) return;
      e.stopPropagation();
      this.isDragging = false;
      this.dragPointerId = null;
      this.canvas.style.cursor = 'grab';

      try {
        if (this.canvas.hasPointerCapture?.(e.pointerId)) {
          this.canvas.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore
      }

      if (this.dragDistanceSq < 64) {
        const pt = this.getLocalCoords(e);
        const hit = this.hitTestPin(pt.x, pt.y);
        if (hit) {
          this.setSelectedTrack(hit.id, true);
          this.onSelectTrack?.(hit.id);
        }
      }
    };

    this.canvas.addEventListener('pointerdown', onPointerDown);
    this.canvas.addEventListener('pointermove', onPointerMove);
    this.canvas.addEventListener('pointerup', onPointerUp);
    this.canvas.addEventListener('pointercancel', onPointerUp);

    this.cleanups.push(() => {
      this.canvas.removeEventListener('pointerdown', onPointerDown);
      this.canvas.removeEventListener('pointermove', onPointerMove);
      this.canvas.removeEventListener('pointerup', onPointerUp);
      this.canvas.removeEventListener('pointercancel', onPointerUp);
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resize();
        if (!this.active) this.render(0);
      });
      this.resizeObserver.observe(this.canvas);
    }
  }
}
