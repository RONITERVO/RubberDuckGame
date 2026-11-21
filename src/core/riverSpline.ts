import { DUCK_CONFIG, MINI_EARTH_CONFIG, RIVER_CONFIG } from '../config';
import {
  createLocalTangentFrame,
  DEG_TO_RAD,
  destinationPoint,
  earthToLocal,
  latLngToSphere,
  localToEarth,
  MINI_EARTH_RADIUS,
  sphereToLatLng,
  type LocalTangentFrame,
} from '../earth/coords';
import { DEFAULT_REGION_ID, earthWorld } from '../earth/earthWorld';
import {
  blendEarthRegionZones,
  hexToCss,
  type BlendedEarthRegion,
  type CaveVisualParams,
  type EarthWaterway,
  type UpcomingForkInfo,
} from '../earth/schema';
import {
  worldRoute,
  type BlendedWorldTrackState,
  type WorldRouteController,
} from '../tracks/worldGraph';
import type {
  CaveBranchInfo,
  CaveStyle,
  HydroObstacle,
  RiverCoords,
  RiverForkHint,
  RiverProvider,
  RiverSample,
  RouteMode,
  Vec3,
  WaterSurfaceQuery,
} from '../types';

/**
 * Shared wave equation parameters matching `src/render/waterShader.ts` GLSL vertex
 * displacement in lockstep so duck buoyancy tracks visible waves identically.
 *
 * Wave height displacement (world units) at river coordinates `(s, u, time)`:
 *   edgeNorm = clamp(|u| / max(1.0, halfWidth), 0.0, 1.0)
 *   bankDamp = 1.0 - 0.55 * edgeNorm * edgeNorm
 *   wfDamp   = waterfallPhase > 0.001 ? (0.35 + 0.65 * |2 * waterfallPhase - 1|) : 1.0
 *   amp      = (0.08 + 0.16 * rapidsIntensity) * bankDamp * wfDamp
 *   p0 = 0.34 * s + 0.16 * u - 3.6 * time
 *   p1 = 0.62 * s - 0.48 * u - 5.1 * time
 *   p2 = 1.15 * s + 0.82 * u - 7.8 * time
 *   waveY = amp * (0.52 * sin(p0) + 0.30 * sin(p1) + 0.18 * sin(p2))
 */
export const WATER_WAVE_PARAMS = {
  baseAmp: 0.08,
  rapidsAmp: 0.16,
  bankDampStrength: 0.55,
  waves: [
    { ks: 0.34, ku: 0.16, omega: 3.6, weight: 0.52 },
    { ks: 0.62, ku: -0.48, omega: 5.1, weight: 0.3 },
    { ks: 1.15, ku: 0.82, omega: 7.8, weight: 0.18 },
  ],
} as const;

export interface WaterfallInfo {
  id: string;
  /** Arc-length where the steep waterfall lip begins. */
  startS: number;
  /** Arc-length where the cascade meets the plunge pool. */
  endS: number;
  /** Horizontal span of the drop (endS - startS). */
  lengthS: number;
  /** Total vertical drop in world units (positive value, e.g. 9.0..15.5). */
  dropHeight: number;
  /** World Y at the top lip (startS) in the active LocalTangentFrame. */
  topY: number;
  /** World Y at the plunge pool entry (endS) in the active LocalTangentFrame. */
  bottomY: number;
  /** End arc-length of the wide churning plunge pool basin downstream. */
  plungePoolEndS: number;
}

export interface ExtendedCaveBranchInfo extends CaveBranchInfo {
  /** True when the cave exit bursts dramatically out of a waterfall cliff face. */
  exitsIntoWaterfall: boolean;
  /** Waterfall ID if `exitsIntoWaterfall` is true. */
  linkedWaterfallId?: string;
  /** Legacy regional cave style string for backwards compatibility. */
  caveStyle: CaveStyle;
  /** 100% data-driven regional cave interior visual parameters from `earthWorld`. */
  caveVisual: CaveVisualParams;
}

/**
 * One real physical `EarthWaterway` leg in the active streaming planetary chain.
 */
export interface WaterwayChainLeg {
  index: number;
  waterwayId: string;
  waterwayName: string;
  regionId: string;
  fromJunctionId: string;
  toJunctionId: string;
  /** Cumulative run arc-length `s` where this leg starts. */
  startS: number;
  /** Cumulative run arc-length `s` where this leg ends. */
  endS: number;
  /** Physical arc-length of this leg on Mini-Earth (world units). */
  lengthU: number;
  /** True real-planet arc-length before Jet-Stream connector compression. */
  realLengthU?: number;
  /** Destination junction's region ID (for fast scenic connector transitions). */
  toRegionId?: string;
  /** True when this leg is an intercontinental connector ocean strait. */
  isConnector: boolean;
  /** True when this leg is a smooth single-track regional return arc back to headwaters. */
  isReturnLoop: boolean;
  /** True once the duck has passed the fork commit window leading into this leg. */
  locked: boolean;
  /** Continuous vertical elevation offset (0 on connected Earth waterways). */
  elevOffset: number;
  /** Local ENU frame anchored at this leg's start point for exact rigid planetary geometry. */
  geoOriginFrame?: LocalTangentFrame;
  /** Local 3D world position where this leg attaches flush to the previous leg. */
  worldAnchorPos?: Vec3;
  /** Rigid 2D yaw rotation (radians) aligning this leg's ENU tangent to previous leg exit. */
  yawAlignRad?: number;
  /** Running heading (radians, atan2(dx, dz)) during compressed jet-stream connector steps. */
  connectorHeading?: number;
  /** Precomputed loop spline LUT (only populated when `isReturnLoop === true`). */
  returnLut?: ReturnLoopPoint[];
}

/** Playable 3D length (world units, ~3.8s at jet-stream speed) for intercontinental connector straits. */
const CONNECTOR_PLAYABLE_LEN = 92.0;

/**
 * Local 3D spline preview for the alternate unchosen branch at an upcoming physical
 * Y-fork confluence so `WaterMesh` can draw both diverging river channels simultaneously!
 */
export interface ForkBranchPreview {
  junctionId: string;
  junctionName: string;
  /** Run arc-length `s` of the fork junction on the main chain. */
  junctionS: number;
  /** Downstream distance from `playerS` to the fork junction (`junctionS - playerS`). */
  distanceU: number;
  /** Which side (`'left' | 'right'`) this alternate unchosen branch diverges toward. */
  branchSide: 'left' | 'right';
  /** Which side (`'left' | 'right'`) the main spline is currently following. */
  chosenSide: 'left' | 'right';
  /** Physical `EarthWaterway` ID of this alternate branch. */
  waterwayId: string;
  /** Human-readable name of this alternate branch. */
  waterwayName: string;
  /** Target destination region zone ID. */
  targetRegionId: string;
  /** Target destination region display name. */
  targetRegionName: string;
  /** Local 3D spline samples starting smoothly from the junction along the alternate branch. */
  samples: ExtendedRiverSample[];
}

export type OriginRecenterListener = (
  prevFrame: LocalTangentFrame,
  nextFrame: LocalTangentFrame,
  revision: number,
  anchorOldPos: Vec3,
  anchorNewPos: Vec3,
) => void;

/**
 * Extended `RiverSample` returned by `RiverSpline.sampleAt(s)`.
 * Fully backwards-compatible with `RiverSample` while exposing real planetary
 * `(lat, lng, elevation)`, physical `waterwayId`, spatial biome blending,
 * physical 2-way `upcomingFork` hints, and hydrodynamic metadata.
 */
export interface ExtendedRiverSample extends RiverSample {
  /** Normalized progress through an active waterfall drop in [0, 1] (0 outside waterfall). */
  waterfallPhase: number;
  /** Local whitewater rapids intensity in [0, 1]. */
  rapidsIntensity: number;
  /** Normalized proximity to the plunge pool turbulence basin [0, 1]. */
  plungePoolIntensity: number;
  /** Active waterfall descriptor when inside a waterfall drop, else null. */
  waterfall: WaterfallInfo | null;
  /** Nearby cave branch whose entrance/channel overlaps this s, else null. */
  caveBranch: ExtendedCaveBranchInfo | null;
  /** Real Mini-Earth latitude in degrees (-90..+90). */
  lat: number;
  /** Real Mini-Earth longitude in degrees (-180..+180). */
  lng: number;
  /** Real Mini-Earth elevation above planetary sea level (world units). */
  elevation: number;
  /** Active physical `EarthWaterway` ID on the shared Mini-Earth globe. */
  waterwayId: string;
  /** Primary spatial `EarthRegionZone` ID at `(lat, lng)`. */
  regionId: string;
  /** Secondary blended spatial `EarthRegionZone` ID at `(lat, lng)`. */
  secondaryRegionId: string;
  /** Spatial biome blend weight [0, 1] toward `secondaryRegionId`. */
  regionBlend: number;
  /** Physical 2-way fork approaching downstream if within warning distance. */
  upcomingFork: RiverForkHint | null;
  /** Active Mini-Earth track/region ID alias (= `regionId`). */
  trackId: string;
  /** Secondary/upcoming Mini-Earth track/region ID alias (= `secondaryRegionId`). */
  nextTrackId: string;
  /** Smooth 0..1 blend factor toward `nextTrackId` (= `regionBlend`). */
  trackBlend: number;
  /** 0..1 morph factor from sloped riverbanks (0) to steep canyon/fjord walls (1). */
  canyonWallFactor: number;
  /** Legacy regional cave style string. */
  caveStyle: CaveStyle;
  /** Data-driven cave visual parameters at this sample. */
  caveVisual: CaveVisualParams;
  /** Waterway hydrodynamic current boost (1.0 normal river, >1.0 ocean jet-stream). */
  speedBoost: number;
}

interface ReturnLoopPoint {
  s: number;
  ux: number;
  uy: number;
  uz: number;
  lat: number;
  lng: number;
  elevation: number;
  width: number;
  depth: number;
  rapids: number;
}

interface SplineNode {
  index: number;
  /** Cumulative horizontal centerline arc-length at this node. */
  s: number;
  /** Horizontal world X in active `LocalTangentFrame`. */
  x: number;
  /** Horizontal world Z in active `LocalTangentFrame`. */
  z: number;
  /** Base world Y in active `LocalTangentFrame` (before subtracting waterfall drops). */
  baseY: number;
  /** Unit-sphere Cartesian direction for antimeridian-safe geographic interpolation. */
  ux: number;
  uy: number;
  uz: number;
  /** Exact latitude (degrees). */
  lat: number;
  /** Exact longitude (degrees). */
  lng: number;
  /** Raw planetary elevation (world units) before subtracting waterfall drops. */
  rawElev: number;
  /** Smoothed channel width at this node. */
  width: number;
  /** Smoothed channel depth at this node. */
  depth: number;
  /** Baseline rapids intensity [0, 1] before waterfall/chute boosts. */
  rapids: number;
  /** Waterway ID hosting this node. */
  waterwayId: string;
  /** Leg index in `chain` hosting this node (-1 for pre-start ghost nodes). */
  legIndex: number;
  /** Local arc-length inside the leg. */
  legLocalS: number;
  /** Local waterway speed boost multiplier. */
  speedBoost: number;
  /** Segment arc-length lookup table (16 subdivisions) for segment [node, nextNode]. */
  segLutS: Float32Array;
  /** Total horizontal arc-length of segment [node, nextNode]. */
  segLength: number;
}

const NODE_STEP = 10.0;
const SEG_SUBDIVS = 16;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function smootherstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function smootherstepDeriv01(t: number): number {
  const x = clamp(t, 0, 1);
  const omx = 1 - x;
  return 30 * x * x * omx * omx;
}

/** Deterministic fast PRNG (Mulberry32). */
class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  public range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

/**
 * Derive a legacy `CaveStyle` tag purely from open data-driven `CaveVisualParams`
 * (zero hardcoded region ID checks!).
 */
function inferLegacyCaveStyle(visual: CaveVisualParams): CaveStyle {
  const r = (visual.glowColor >> 16) & 0xff;
  const g = (visual.glowColor >> 8) & 0xff;
  const b = visual.glowColor & 0xff;

  if (visual.roughness < 0.35 && b > 190) return 'glacier_ice';
  if (r > 210 && g < 130 && b < 80) return 'lava_tube';
  if (r > 210 && g >= 130 && b < 130) return 'canyon_slot';
  if (r > 200 && b > 160) return 'bamboo_grotto';
  if (g > 200 && r < 140 && b < 180) return 'jungle_cenote';
  return 'limestone';
}

/**
 * Evaluate exact wave height displacement (world units) matching `WATER_WAVE_PARAMS`
 * and `src/render/waterShader.ts` GLSL in lockstep.
 */
export function computeWaterWaveHeight(
  s: number,
  u: number,
  time: number,
  halfWidth: number,
  rapidsIntensity: number,
  waterfallPhase: number = 0,
): number {
  const edgeNorm = clamp(Math.abs(u) / Math.max(1.0, halfWidth), 0, 1);
  const bankDamp = 1.0 - WATER_WAVE_PARAMS.bankDampStrength * edgeNorm * edgeNorm;
  const wfDamp =
    waterfallPhase > 0.001
      ? 0.35 + 0.65 * Math.abs(2 * waterfallPhase - 1)
      : 1.0;
  const amp =
    (WATER_WAVE_PARAMS.baseAmp + WATER_WAVE_PARAMS.rapidsAmp * rapidsIntensity) *
    bankDamp *
    wfDamp;

  const w0 = WATER_WAVE_PARAMS.waves[0];
  const w1 = WATER_WAVE_PARAMS.waves[1];
  const w2 = WATER_WAVE_PARAMS.waves[2];

  const p0 = w0.ks * s + w0.ku * u - w0.omega * time;
  const p1 = w1.ks * s + w1.ku * u - w1.omega * time;
  const p2 = w2.ks * s + w2.ku * u - w2.omega * time;

  return (
    amp * (w0.weight * Math.sin(p0) + w1.weight * Math.sin(p1) + w2.weight * Math.sin(p2))
  );
}

/**
 * Analytical wave displacement and partial derivatives `(dh/ds, dh/du)` matching
 * `WATER_WAVE_PARAMS` and `src/render/waterShader.ts` GLSL in lockstep.
 */
export function computeWaterWaveState(
  s: number,
  u: number,
  time: number,
  halfWidth: number,
  rapidsIntensity: number,
  waterfallPhase: number = 0,
): { height: number; dhds: number; dhdu: number } {
  const safeHalf = Math.max(1.0, halfWidth);
  const edgeNorm = clamp(Math.abs(u) / safeHalf, 0, 1);
  const bankDamp = 1.0 - WATER_WAVE_PARAMS.bankDampStrength * edgeNorm * edgeNorm;
  const wfDamp =
    waterfallPhase > 0.001
      ? 0.35 + 0.65 * Math.abs(2 * waterfallPhase - 1)
      : 1.0;
  const baseAmp =
    (WATER_WAVE_PARAMS.baseAmp + WATER_WAVE_PARAMS.rapidsAmp * rapidsIntensity) * wfDamp;
  const amp = baseAmp * bankDamp;

  const w0 = WATER_WAVE_PARAMS.waves[0];
  const w1 = WATER_WAVE_PARAMS.waves[1];
  const w2 = WATER_WAVE_PARAMS.waves[2];

  const p0 = w0.ks * s + w0.ku * u - w0.omega * time;
  const p1 = w1.ks * s + w1.ku * u - w1.omega * time;
  const p2 = w2.ks * s + w2.ku * u - w2.omega * time;

  const sumSin =
    w0.weight * Math.sin(p0) + w1.weight * Math.sin(p1) + w2.weight * Math.sin(p2);
  const c0 = Math.cos(p0);
  const c1 = Math.cos(p1);
  const c2 = Math.cos(p2);

  const height = amp * sumSin;
  const dhds =
    amp * (w0.weight * w0.ks * c0 + w1.weight * w1.ks * c1 + w2.weight * w2.ks * c2);
  const dBankDu =
    Math.abs(u) < safeHalf
      ? (-2 * WATER_WAVE_PARAMS.bankDampStrength * u) / (safeHalf * safeHalf)
      : 0;
  const dhdu =
    amp * (w0.weight * w0.ku * c0 + w1.weight * w1.ku * c1 + w2.weight * w2.ku * c2) +
    baseAmp * dBankDu * sumSin;

  return { height, dhds, dhdu };
}

/** Uniform cubic Catmull-Rom position interpolation. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** First derivative of cubic Catmull-Rom w.r.t. t. */
function catmullRomDeriv(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t;
  return (
    0.5 *
    (-p0 +
      p2 +
      2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t +
      3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t2)
  );
}

/** Second derivative of cubic Catmull-Rom w.r.t. t. */
function catmullRomSecondDeriv(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  return 0.5 * (2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) + 6 * (-p0 + 3 * p1 - 3 * p2 + p3) * t);
}

/**
 * Shared Physical Mini-Earth River Spline implementing `RiverProvider`.
 *
 * Streams real connected `EarthWaterway` chains from `earthWorld` projected into
 * float32-clean local 3D ENU space (`createLocalTangentFrame` + `earthToLocal`):
 * - Real physical 2-way River Forks (`upcomingFork`, `setForkChoice`, `getForkBranchPreview`)
 * - C1-continuous transitions across shared planetary `EarthJunction`s (zero snaps/teleports)
 * - Floating-Origin ENU recentering for endless planetary voyages without precision drift
 * - True O(1) spatial biome blending (`earthWorld.getBlendedRegionAt(lat, lng)`)
 * - Exact lockstep analytical wave equations (`computeWaterWaveHeight`, `computeWaterWaveState`)
 */
export class RiverSpline implements RiverProvider {
  private seed: number;
  private route: WorldRouteController;
  private routeMode: RouteMode = 'world_tour';
  private startWaterwayId: string;
  private startRegionId: string = DEFAULT_REGION_ID;
  private explicitWaterwayId: string | null = null;
  private syncedRouteTrackId: string = DEFAULT_REGION_ID;
  private syncedRouteMode: RouteMode = 'world_tour';

  private featureRng!: SeededRng;

  private chain: WaterwayChainLeg[] = [];
  private nodes: SplineNode[] = [];
  private waterfalls: WaterfallInfo[] = [];
  private caves: ExtendedCaveBranchInfo[] = [];

  private nextNodeIndex = 0;
  private nextSampleS = 0;
  private waterfallCounter = 0;
  private caveCounter = 0;
  private nextCaveS = 260;
  private lastCaveSide: -1 | 1 = 1;
  private scheduledWaterfallsUpToLeg = -1;

  /** Steering / QA fork preference (`'left' | 'right' | null`) for the next unlocked 2-way fork. */
  private pendingForkChoice: 'left' | 'right' | null = null;
  /** Most recent player arc-length passed to `updateWindow`. */
  private lastPlayerS = 0;

  /** Accumulated total waterfall drop from pruned waterfalls (keeps global Y continuous). */
  private prunedWaterfallDropSum = 0;
  /** Waterfall drop sum at the moment `localFrame` was anchored (keeps local Y near 0 on recenter). */
  private dropBaselineOffset = 0;
  private isEnsuringAhead = false;

  /** Active Floating-Origin Local Tangent Plane (ENU) frame on Mini-Earth. */
  private localFrame: LocalTangentFrame;
  private frameRevision = 0;
  private originListeners = new Set<OriginRecenterListener>();

  private obstacleQueryFn:
    | ((sStart: number, sEnd: number) => readonly HydroObstacle[])
    | null = null;

  constructor(seed: number = 42071, route: WorldRouteController = worldRoute) {
    this.seed = seed;
    this.route = route;
    this.routeMode = route.getRouteMode();
    this.startRegionId = route.getStartTrackId() || DEFAULT_REGION_ID;
    this.syncedRouteTrackId = this.startRegionId;
    this.syncedRouteMode = this.routeMode;

    const primaryWw = earthWorld.getPrimaryWaterwayForRegion(this.startRegionId);
    this.startWaterwayId = primaryWw?.id ?? 'ww-pnw-creek';
    const startSample = earthWorld.sampleWaterway(this.startWaterwayId, 0);
    this.localFrame = createLocalTangentFrame(
      startSample.lat,
      startSample.lng,
      startSample.elevation,
    );

    this.reset(seed);
  }

  /** Attach or switch the compatibility `WorldRouteController` and regenerate from `s = 0`. */
  public setRouteController(route: WorldRouteController): void {
    this.route = route;
    this.explicitWaterwayId = null;
    this.syncFromCompatRoute(true);
    this.reset(this.seed);
  }

  /** Return the compatibility `WorldRouteController`. */
  public getRouteController(): WorldRouteController {
    return this.route;
  }

  /**
   * Start on any physical `EarthWaterway` ID OR `EarthRegionZone` ID on Mini-Earth,
   * optionally switching route mode (`'world_tour' | 'free_earth' | 'single_track'`).
   */
  public setStartWaterway(
    waterwayOrRegionId: string,
    routeMode?: RouteMode,
  ): void {
    const directWw = earthWorld.getWaterwayById(waterwayOrRegionId);
    const resolvedWw =
      directWw ?? earthWorld.getPrimaryWaterwayForRegion(waterwayOrRegionId);

    this.startWaterwayId = resolvedWw.id;
    this.startRegionId = resolvedWw.regionId;
    this.explicitWaterwayId = directWw ? directWw.id : null;

    if (routeMode) {
      this.routeMode = routeMode;
    }

    // Keep legacy worldRoute synchronized for backward-compatible callers
    this.route.configureRoute(this.routeMode, this.startRegionId, this.seed);
    this.syncedRouteTrackId = this.route.getStartTrackId();
    this.syncedRouteMode = this.route.getRouteMode();

    this.reset(this.seed);
  }

  public getRouteMode(): RouteMode {
    return this.routeMode;
  }

  public setRouteMode(mode: RouteMode): void {
    this.routeMode = mode;
    this.route.configureRoute(mode, this.startRegionId, this.seed);
    this.syncedRouteMode = mode;
    this.reset(this.seed);
  }

  /**
   * Set the desired left/right branch choice for the next upcoming physical river fork.
   * Called continuously by `DuckController` as the player steers left or right approaching
   * a 2-way confluence (before the commit window), and callable directly by QA scripts!
   */
  public setForkChoice(side: 'left' | 'right' | null): void {
    if (this.pendingForkChoice === side) return;
    this.pendingForkChoice = side;
    if (this.routeMode === 'single_track' || side === null) return;
    this.applyForkChoiceAhead(this.lastPlayerS, side);
  }

  public getForkChoice(): 'left' | 'right' | null {
    return this.pendingForkChoice;
  }

  /** Return the active Floating-Origin ENU `LocalTangentFrame` used by `earthToLocal`. */
  public getLocalTangentFrame(): LocalTangentFrame {
    return this.localFrame;
  }

  /** Monotonic revision counter incremented whenever the Floating-Origin ENU frame recenters. */
  public getFrameRevision(): number {
    return this.frameRevision;
  }

  /** Subscribe to Floating-Origin ENU recenter events (returns unsubscribe function). */
  public onOriginRecenter(listener: OriginRecenterListener): () => void {
    this.originListeners.add(listener);
    return () => {
      this.originListeners.delete(listener);
    };
  }

  /**
   * Transform a local 3D point from a previous `LocalTangentFrame` (captured before a
   * floating-origin recenter) into the exact isometric equivalent point in the current frame
   * anchored around `(anchorOldPos -> anchorNewPos)` so camera & FX have 0.000u jump!
   */
  public transformPointFromFrame(
    localPos: Vec3,
    prevFrame: LocalTangentFrame,
    anchorOldPos?: Vec3,
    anchorNewPos?: Vec3,
  ): Vec3 {
    if (anchorOldPos && anchorNewPos) {
      return {
        x: localPos.x + (anchorNewPos.x - anchorOldPos.x),
        y: localPos.y + (anchorNewPos.y - anchorOldPos.y),
        z: localPos.z + (anchorNewPos.z - anchorOldPos.z),
      };
    }

    const geo = localToEarth(localPos, prevFrame);
    return earthToLocal(geo.lat, geo.lng, geo.elevation, this.localFrame);
  }

  /**
   * Project a true planetary `(lat, lng, elev)` coordinate into the active local 3D space,
   * respecting per-leg rigid ENU alignment across fast intercontinental Jet-Stream transitions.
   */
  public projectEarthPoint(
    lat: number,
    lng: number,
    elev: number,
    hintS?: number,
  ): Vec3 {
    const leg = this.findLegAtS(hintS ?? this.lastPlayerS);
    if (leg && !leg.isConnector && leg.geoOriginFrame && leg.worldAnchorPos) {
      return this.projectGeoToLegSpace(leg, lat, lng, elev);
    }
    return earthToLocal(lat, lng, elev, this.localFrame);
  }

  private projectGeoToLegSpace(
    leg: WaterwayChainLeg,
    lat: number,
    lng: number,
    elev: number,
  ): Vec3 {
    if (leg.geoOriginFrame && leg.worldAnchorPos) {
      const p = earthToLocal(lat, lng, elev, leg.geoOriginFrame);
      const yaw = leg.yawAlignRad ?? 0;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      return {
        x: leg.worldAnchorPos.x + p.x * c + p.z * s,
        y: leg.worldAnchorPos.y + p.y,
        z: leg.worldAnchorPos.z - p.x * s + p.z * c,
      };
    }
    return earthToLocal(lat, lng, elev, this.localFrame);
  }

  /**
   * Re-anchor the Floating-Origin ENU `LocalTangentFrame` at arc-length `s` using an
   * exact rigid translation so local 3D coordinates stay float32-clean across long
   * multi-continent voyages and Jet-Stream connectors with 0.000u distortion!
   */
  public recenterOriginAt(s: number): boolean {
    const safeS = Math.max(0, s);
    this.ensureAhead(safeS + 90);
    if (this.nodes.length < 2) return false;

    const sampleBefore = this.sampleAt(safeS);
    const anchorOldPos: Vec3 = { ...sampleBefore.position };
    const { idx: anchorIdx } = this.locateSegment(safeS);
    const anchorSBefore = this.nodes[anchorIdx]?.s ?? safeS;
    const prevFrame = this.localFrame;
    const prevBaseline = this.dropBaselineOffset;

    const currentDropSum = this.computeWaterfallDropSumAt(safeS);
    const rawElevAtS = sampleBefore.elevation + (currentDropSum - prevBaseline);

    // Ensure leg 0 captures its original ENU frame before localFrame moves
    if (this.chain.length > 0 && !this.chain[0].geoOriginFrame) {
      this.chain[0].geoOriginFrame = prevFrame;
      this.chain[0].worldAnchorPos = { x: 0, y: 0, z: 0 };
      this.chain[0].yawAlignRad = 0;
    }

    const dx = -anchorOldPos.x;
    const dy = -anchorOldPos.y;
    const dz = -anchorOldPos.z;

    this.dropBaselineOffset = currentDropSum;
    this.localFrame = createLocalTangentFrame(
      sampleBefore.lat,
      sampleBefore.lng,
      rawElevAtS,
    );
    this.frameRevision += 1;

    // Exact rigid translation of all buffered spline nodes & leg anchors (0.000u stretch!)
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      n.x += dx;
      n.z += dz;
      n.baseY += dy;
    }
    for (let i = 0; i < this.chain.length; i++) {
      const anchor = this.chain[i].worldAnchorPos;
      if (anchor) {
        anchor.x += dx;
        anchor.y += dy;
        anchor.z += dz;
      }
    }

    this.recomputeArcLengthsAnchored(anchorIdx, anchorSBefore);
    for (let i = 0; i < this.waterfalls.length; i++) {
      this.waterfalls[i].topY = Number.NaN;
      this.waterfalls[i].bottomY = Number.NaN;
    }
    this.syncWaterfallElevations();

    const anchorNewPos: Vec3 = { ...this.sampleAt(safeS).position };
    for (const listener of this.originListeners) {
      listener(
        prevFrame,
        this.localFrame,
        this.frameRevision,
        anchorOldPos,
        anchorNewPos,
      );
    }
    return true;
  }

  /** Query the true O(1) spatially blended `EarthRegionZone` state at arc-length `s`. */
  public getBlendedRegionAtS(s: number): BlendedEarthRegion {
    const sample = this.sampleAt(s);
    const leg = this.findLegAtS(s);
    const localS = leg ? clamp(s - leg.startS, 0, leg.lengthU) : 0;
    return this.resolveLegAwareBlendedRegion(sample.lat, sample.lng, leg, localS);
  }

  /**
   * Resolve spatial `BlendedEarthRegion` at `(lat, lng)`:
   * - On Jet-Stream intercontinental connector legs (`leg.isConnector`), smoothly morph
   *   `fromZone` -> `toZone` right across the fast 4-second connector so the destination
   *   biome, weather, flora, and water optics pour in immediately!
   * - On regional rivers, keep the waterway's own home region pure.
   */
  private resolveLegAwareBlendedRegion(
    lat: number,
    lng: number,
    leg: WaterwayChainLeg | null,
    legLocalS?: number,
  ): BlendedEarthRegion {
    if (leg && leg.isConnector) {
      const fromZone = earthWorld.getZoneById(leg.regionId);
      const toZone = earthWorld.getZoneById(leg.toRegionId ?? leg.regionId);
      if (fromZone.id !== toZone.id) {
        const tNorm = clamp(
          (legLocalS ?? 0) / Math.max(1, leg.lengthU),
          0,
          1,
        );
        const morph = smoothstep01(clamp((tNorm - 0.1) / 0.74, 0, 1));
        if (morph < 0.5) {
          return blendEarthRegionZones(fromZone, toZone, morph);
        }
        return blendEarthRegionZones(toZone, fromZone, 1.0 - morph);
      }
      return blendEarthRegionZones(toZone, toZone, 0);
    }

    const raw = earthWorld.getBlendedRegionAt(lat, lng);
    if (!leg) return raw;

    if (raw.primaryZone.id === leg.regionId) {
      if (raw.blend > 0 && raw.secondaryZone.id !== leg.regionId) {
        return blendEarthRegionZones(raw.primaryZone, raw.primaryZone, 0);
      }
      return raw;
    }

    if (raw.secondaryZone.id === leg.regionId) {
      return blendEarthRegionZones(raw.secondaryZone, raw.secondaryZone, 0);
    }

    return raw;
  }

  /** Backward-compatible helper delegating to `worldRoute.getBlendedStateAt(s)`. */
  public getBlendedTrackStateAt(s: number): BlendedWorldTrackState {
    return this.route.getBlendedStateAt(s);
  }

  public getActiveWaterwayChain(): readonly WaterwayChainLeg[] {
    return this.chain;
  }

  public getLegAtS(s: number): WaterwayChainLeg | null {
    const safeS = Math.max(0, s);
    this.ensureChainUpToS(safeS + 120);
    return this.findLegAtS(safeS);
  }

  /** Return unique region IDs visited by the duck along the real planetary chain up to `playerS`. */
  public getVisitedRegionIds(playerS: number = this.lastPlayerS): string[] {
    const safeS = Math.max(0, playerS);
    const visited: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < this.chain.length; i++) {
      const leg = this.chain[i];
      if (leg.startS <= safeS + 1e-3) {
        if (!seen.has(leg.regionId)) {
          seen.add(leg.regionId);
          visited.push(leg.regionId);
        }
      } else {
        break;
      }
    }
    if (visited.length === 0) {
      visited.push(this.startRegionId);
    }
    return visited;
  }

  /** Reset the river spline deterministically to `s = 0` on the active Mini-Earth waterway. */
  public reset(seed: number = this.seed): void {
    this.syncFromCompatRoute(false);

    this.seed = seed;
    this.featureRng = new SeededRng(seed ^ 0x51a7c3d1);

    this.chain = [];
    this.nodes = [];
    this.waterfalls = [];
    this.caves = [];

    this.nextNodeIndex = 0;
    this.nextSampleS = 0;
    this.waterfallCounter = 0;
    this.caveCounter = 0;
    this.scheduledWaterfallsUpToLeg = -1;
    this.pendingForkChoice = null;
    this.lastPlayerS = 0;
    this.lastCaveSide = this.featureRng.next() < 0.5 ? -1 : 1;
    this.prunedWaterfallDropSum = 0;
    this.dropBaselineOffset = 0;

    // Seed initial physical waterway leg at s = 0
    const startWw =
      earthWorld.getWaterwayById(this.startWaterwayId) ??
      earthWorld.getPrimaryWaterwayForRegion(this.startRegionId);
    this.startWaterwayId = startWw.id;
    this.startRegionId = startWw.regionId;

    const startLen = Math.max(80, earthWorld.getWaterwayLength(startWw.id));
    this.chain.push({
      index: 0,
      waterwayId: startWw.id,
      waterwayName: startWw.name,
      regionId: startWw.regionId,
      fromJunctionId: startWw.fromJunctionId,
      toJunctionId: startWw.toJunctionId,
      startS: 0,
      endS: startLen,
      lengthU: startLen,
      isConnector: Boolean(startWw.isConnector),
      isReturnLoop: false,
      locked: true,
      elevOffset: 0,
    });

    // Anchor Floating-Origin ENU frame cleanly at the waterway's real geographic start
    const geo0 = earthWorld.sampleWaterway(startWw.id, 0);
    const startRegion = earthWorld.getBlendedRegionAt(geo0.lat, geo0.lng);
    this.localFrame = createLocalTangentFrame(geo0.lat, geo0.lng, geo0.elevation);
    this.frameRevision += 1;

    const caveSpacing0 = clamp(startRegion.riverProfile.caveSpacing, 180, 340);
    this.nextCaveS = this.featureRng.range(
      Math.max(150, caveSpacing0 * 0.72),
      Math.max(210, caveSpacing0 * 1.05),
    );

    // Build smooth negative-s ghost lead-in nodes and initial forward window
    this.seedInitialNodes();
    this.ensureAhead(RIVER_CONFIG.aheadDistance + 180);
  }

  /**
   * Optionally wire an external obstacle query (e.g., from ObstacleSpawner)
   * so `RiverProvider.getObstaclesInRange` works seamlessly for `water-fx`.
   */
  public setObstacleProvider(
    fn: ((sStart: number, sEnd: number) => readonly HydroObstacle[]) | null,
  ): void {
    this.obstacleQueryFn = fn;
  }

  /**
   * Stream spline nodes, waterway legs, waterfalls, and caves ahead of `playerS`,
   * lock in imminent fork junctions once past the commit threshold, recenter the
   * Floating-Origin ENU frame on long planetary travel, and prune far behind.
   */
  public updateWindow(playerS: number): void {
    const safeS = Math.max(0, playerS);
    this.lastPlayerS = safeS;

    // Lock in the next leg once the duck enters the fork commit window (~10u before junction)
    const curLeg = this.findLegAtS(safeS);
    if (curLeg) {
      const nextLeg = this.chain[curLeg.index + 1];
      const distToEnd = curLeg.endS - safeS;
      if (
        nextLeg &&
        !nextLeg.locked &&
        distToEnd <= MINI_EARTH_CONFIG.forkCommitDistanceU
      ) {
        nextLeg.locked = true;
        this.pendingForkChoice = null;
      }
    }

    const targetAhead = safeS + RIVER_CONFIG.aheadDistance + 160;
    this.ensureAhead(targetAhead);

    // Floating-Origin ENU recentering if player drifted past `floatingOriginRecenterDistanceU`
    if (this.nodes.length >= 2) {
      const p = this.sampleHorizontalPosition(safeS);
      const distFromOrigin = Math.hypot(p.x, p.z);
      if (distFromOrigin > MINI_EARTH_CONFIG.floatingOriginRecenterDistanceU) {
        this.recenterOriginAt(safeS);
      }
    }

    const pruneBefore = safeS - RIVER_CONFIG.behindDistance - 110;
    if (pruneBefore > 80) {
      this.pruneBehind(pruneBefore);
    }
  }

  /**
   * Return upcoming physical 2-way fork metadata at `s` if within `warningDistanceU`
   * of a real branching `EarthJunction` (returns `null` in `'single_track'` mode).
   */
  public getUpcomingForkAt(
    s: number,
    warningDistanceU: number = MINI_EARTH_CONFIG.forkWarningDistanceU,
  ): RiverForkHint | null {
    if (this.routeMode === 'single_track') return null;

    const safeS = Math.max(0, s);
    this.ensureChainUpToS(safeS + warningDistanceU + 60);
    const leg = this.findLegAtS(safeS);
    if (!leg || leg.isReturnLoop) return null;

    const localS = clamp(safeS - leg.startS, 0, leg.lengthU);
    return this.getUpcomingForkForLeg(leg, localS, warningDistanceU);
  }

  private getUpcomingForkForLeg(
    leg: WaterwayChainLeg,
    localS: number,
    warningDistanceU: number,
  ): RiverForkHint | null {
    if (this.routeMode === 'single_track' || leg.isReturnLoop) return null;

    const clampedLocalS = clamp(localS, 0, leg.lengthU);
    const fork = earthWorld.getUpcomingFork(
      leg.waterwayId,
      clampedLocalS,
      warningDistanceU,
    );
    if (!fork) return null;

    const nextLeg = this.chain[leg.index + 1];
    let selectedSide: 'left' | 'right' =
      fork.defaultBranch.waterwayId === fork.leftBranch.waterwayId ? 'left' : 'right';

    if (nextLeg) {
      if (nextLeg.waterwayId === fork.leftBranch.waterwayId) {
        selectedSide = 'left';
      } else if (nextLeg.waterwayId === fork.rightBranch.waterwayId) {
        selectedSide = 'right';
      }
    } else if (this.pendingForkChoice) {
      selectedSide = this.pendingForkChoice;
    }

    return {
      junctionId: fork.junction.id,
      junctionName: fork.junction.name,
      distanceU: Math.max(0, leg.lengthU - clampedLocalS),
      leftBranchId: fork.leftBranch.waterwayId,
      leftBranchName: fork.leftBranch.waterwayName,
      leftRegionName: fork.leftBranch.targetRegionName,
      rightBranchId: fork.rightBranch.waterwayId,
      rightBranchName: fork.rightBranch.waterwayName,
      rightRegionName: fork.rightBranch.targetRegionName,
      defaultBranchId: fork.defaultBranch.waterwayId,
      selectedSide,
    };
  }

  /**
   * Build local 3D spline samples along the *alternate* unchosen branch diverging from
   * an upcoming 2-way fork junction (within `lookaheadU`, default 115u ahead of `playerS`)
   * so `WaterMesh` can visibly render the real physical Y-fork water split!
   */
  public getForkBranchPreview(
    playerS: number,
    lookaheadU: number = 115,
  ): ForkBranchPreview | null {
    if (this.routeMode === 'single_track') return null;

    const safeS = Math.max(0, playerS);
    this.ensureAhead(safeS + lookaheadU + 60);

    // Search the current leg (and immediately following leg if within lookahead) for a 2-way fork
    const startLeg = this.findLegAtS(safeS);
    if (!startLeg) return null;

    let forkLeg: WaterwayChainLeg | null = null;
    let forkInfo: UpcomingForkInfo | null = null;

    for (
      let li = startLeg.index;
      li < Math.min(this.chain.length, startLeg.index + 2);
      li++
    ) {
      const candidate = this.chain[li];
      if (candidate.isReturnLoop) continue;
      const distToJunc = candidate.endS - safeS;
      if (distToJunc < -22 || distToJunc > lookaheadU) continue;

      const localQueryS = clamp(safeS - candidate.startS, 0, candidate.lengthU);
      const info = earthWorld.getUpcomingFork(
        candidate.waterwayId,
        localQueryS,
        Math.max(lookaheadU + 20, candidate.lengthU + 10),
      );
      if (info) {
        forkLeg = candidate;
        forkInfo = info;
        break;
      }
    }

    if (!forkLeg || !forkInfo) return null;

    const nextLeg = this.chain[forkLeg.index + 1];
    const mainNextWwId = nextLeg?.waterwayId ?? forkInfo.defaultBranch.waterwayId;
    const chosenSide: 'left' | 'right' =
      mainNextWwId === forkInfo.leftBranch.waterwayId ? 'left' : 'right';
    const altSide: 'left' | 'right' = chosenSide === 'left' ? 'right' : 'left';
    const altBranch =
      altSide === 'left' ? forkInfo.leftBranch : forkInfo.rightBranch;

    const junctionS = this.findJunctionSplineS(forkLeg);
    const juncMainSample = this.sampleAt(junctionS);
    const juncDropNet =
      this.computeWaterfallDropSumAt(junctionS) - this.dropBaselineOffset;

    const altTotalLen = earthWorld.getWaterwayLength(altBranch.waterwayId);
    const previewSpan = Math.min(95, Math.max(36, altTotalLen));
    const sampleStep = 2.5;
    const numSteps = Math.max(12, Math.floor(previewSpan / sampleStep));

    // Pre-sample raw 3D positions along the alternate real physical EarthWaterway
    // starting smoothly from the junction's exact world position & tangent!
    const rawPts: Array<{
      s: number;
      pos: Vec3;
      lat: number;
      lng: number;
      elev: number;
      width: number;
      depth: number;
      rapids: number;
      speedBoost: number;
    }> = [];

    // Lead-in overlap (-4u to 0u) locks flush into the main water ribbon with zero seam
    const leadOffsets = [-4.0, -2.0];
    for (let i = 0; i < leadOffsets.length; i++) {
      const ls = Math.max(0, junctionS + leadOffsets[i]);
      const ms = this.sampleAt(ls);
      rawPts.push({
        s: ls,
        pos: { ...ms.position },
        lat: ms.lat,
        lng: ms.lng,
        elev: ms.elevation,
        width: ms.width,
        depth: ms.depth,
        rapids: ms.rapidsIntensity,
        speedBoost: ms.speedBoost,
      });
    }

    // Smooth C1 Hermite/blend transition over first 18u out of junction so the diverging
    // branch splits organically like a real river confluence!
    for (let k = 0; k <= numSteps; k++) {
      const localD = Math.min(previewSpan, k * sampleStep);
      const wwSample = earthWorld.sampleWaterway(altBranch.waterwayId, localD);
      const effElev = wwSample.elevation + forkLeg.elevOffset - juncDropNet;
      const earthPos = this.projectGeoToLegSpace(
        forkLeg,
        wwSample.lat,
        wwSample.lng,
        effElev,
      );

      let pos = earthPos;
      if (localD < 16.0) {
        // Blend smoothly from incoming tangent extension into the diverging Earth curve
        const tBlend = smoothstep01(localD / 16.0);
        const tangentExt: Vec3 = {
          x: juncMainSample.position.x + juncMainSample.tangent.x * localD,
          y: juncMainSample.position.y + juncMainSample.tangent.y * localD,
          z: juncMainSample.position.z + juncMainSample.tangent.z * localD,
        };
        pos = {
          x: lerp(tangentExt.x, earthPos.x, tBlend),
          y: lerp(tangentExt.y, earthPos.y, tBlend),
          z: lerp(tangentExt.z, earthPos.z, tBlend),
        };
      }

      rawPts.push({
        s: junctionS + localD,
        pos,
        lat: wwSample.lat,
        lng: wwSample.lng,
        elev: effElev,
        width: lerp(juncMainSample.width, wwSample.width, smoothstep01(localD / 22)),
        depth: wwSample.depth,
        rapids: wwSample.rapids,
        speedBoost: wwSample.speedBoost,
      });
    }

    // Convert raw points into full `ExtendedRiverSample`s with orthonormal frames
    const samples: ExtendedRiverSample[] = [];
    for (let i = 0; i < rawPts.length; i++) {
      const prev = rawPts[Math.max(0, i - 1)];
      const curr = rawPts[i];
      const next = rawPts[Math.min(rawPts.length - 1, i + 1)];

      const dx = next.pos.x - prev.pos.x;
      const dy = next.pos.y - prev.pos.y;
      const dz = next.pos.z - prev.pos.z;
      const horizLen = Math.hypot(dx, dz) || 1.0;
      const txXZ = dx / horizLen;
      const tzXZ = dz / horizLen;
      const slope = dy / horizLen;
      const invTan = 1.0 / Math.hypot(1.0, slope);

      const tangent: Vec3 = {
        x: txXZ * invTan,
        y: slope * invTan,
        z: tzXZ * invTan,
      };
      const right: Vec3 = {
        x: -tzXZ,
        y: 0,
        z: txXZ,
      };
      const up: Vec3 = {
        x: -right.z * tangent.y,
        y: right.z * tangent.x - right.x * tangent.z,
        z: right.x * tangent.y,
      };

      const region = earthWorld.getBlendedRegionAt(curr.lat, curr.lng);
      const regionId = region.primaryZone.id;
      const secondaryRegionId = region.secondaryZone.id;
      const caveStyle = inferLegacyCaveStyle(region.caveStyle);

      samples.push({
        s: curr.s,
        position: curr.pos,
        tangent,
        right,
        up,
        width: curr.width,
        depth: curr.depth,
        slope,
        curvature: 0,
        isWaterfall: false,
        waterfallDrop: 0,
        waterfallPhase: 0,
        hasCaveEntrance: false,
        caveOffset: 0,
        biomeIndex: earthWorld.getZoneIndex(regionId),
        biomeBlend: region.blend,
        flowSpeedMultiplier: clamp(
          region.waterStyle.flowSpeedMult * lerp(1.0, curr.speedBoost, 0.45),
          0.78,
          1.95,
        ),
        rapidsIntensity: clamp(
          Math.max(curr.rapids, region.riverProfile.rapidsBase * 0.72),
          0,
          1,
        ),
        plungePoolIntensity: 0,
        waterfall: null,
        caveBranch: null,
        lat: curr.lat,
        lng: curr.lng,
        elevation: curr.elev,
        waterwayId: altBranch.waterwayId,
        regionId,
        secondaryRegionId,
        regionBlend: region.blend,
        upcomingFork: null,
        trackId: regionId,
        nextTrackId: secondaryRegionId,
        trackBlend: region.blend,
        canyonWallFactor: region.riverProfile.canyonWallFactor,
        caveStyle,
        caveVisual: region.caveStyle,
        speedBoost: curr.speedBoost,
      });
    }

    return {
      junctionId: forkInfo.junction.id,
      junctionName: forkInfo.junction.name,
      junctionS,
      distanceU: junctionS - safeS,
      branchSide: altSide,
      chosenSide,
      waterwayId: altBranch.waterwayId,
      waterwayName: altBranch.waterwayName,
      targetRegionId: altBranch.targetRegionId,
      targetRegionName: altBranch.targetRegionName,
      samples,
    };
  }

  /** Alias matching the coordinator brief (`getSampleAt`). */
  public getSampleAt(s: number): ExtendedRiverSample {
    return this.sampleAt(s);
  }

  /** Sample the river spline geometry, real planetary coordinates, and hydrodynamic attributes at `s`. */
  public sampleAt(s: number): ExtendedRiverSample {
    const safeS = Math.max(0, s);
    this.ensureAhead(safeS + 90);

    const { idx, t } = this.locateSegment(safeS);
    const n0 = this.nodes[Math.max(0, idx - 1)];
    const n1 = this.nodes[idx];
    const n2 = this.nodes[Math.min(this.nodes.length - 1, idx + 1)];
    const n3 = this.nodes[Math.min(this.nodes.length - 1, idx + 2)];

    const x = catmullRom(n0.x, n1.x, n2.x, n3.x, t);
    const z = catmullRom(n0.z, n1.z, n2.z, n3.z, t);

    const dxDt = catmullRomDeriv(n0.x, n1.x, n2.x, n3.x, t);
    const dzDt = catmullRomDeriv(n0.z, n1.z, n2.z, n3.z, t);
    const d2xDt2 = catmullRomSecondDeriv(n0.x, n1.x, n2.x, n3.x, t);
    const d2zDt2 = catmullRomSecondDeriv(n0.z, n1.z, n2.z, n3.z, t);

    const speedXZ = Math.hypot(dxDt, dzDt) || 1.0;
    const txXZ = dxDt / speedXZ;
    const tzXZ = dzDt / speedXZ;

    // Signed horizontal curvature in rad/unit: + curving RIGHT, - curving LEFT.
    // Right vector in XZ is (-tzXZ, txXZ) since cross((tx,0,tz),(0,1,0)) = (-tz, 0, tx).
    const rightX = -tzXZ;
    const rightZ = txXZ;
    const accelRight = d2xDt2 * rightX + d2zDt2 * rightZ;
    const curvature = clamp(accelRight / (speedXZ * speedXZ), -0.06, 0.06);

    // Antimeridian-safe unit-sphere interpolation for exact `(lat, lng)`
    const rx = catmullRom(n0.ux, n1.ux, n2.ux, n3.ux, t);
    const ry = catmullRom(n0.uy, n1.uy, n2.uy, n3.uy, t);
    const rz = catmullRom(n0.uz, n1.uz, n2.uz, n3.uz, t);
    const invU = 1.0 / (Math.hypot(rx, ry, rz) || 1.0);
    const geo = sphereToLatLng({ x: rx * invU, y: ry * invU, z: rz * invU });

    // Check upcoming physical 2-way fork on the active leg (locked to spline node's exact legLocalS)
    const activeLeg =
      n1.legIndex >= 0 && n1.legIndex < this.chain.length
        ? this.chain[n1.legIndex]
        : this.findLegAtS(safeS);
    const waterwayId = activeLeg?.waterwayId ?? n1.waterwayId;
    const nodeLocalS =
      activeLeg !== null
        ? lerp(
            n1.legLocalS,
            n2.legIndex === n1.legIndex ? n2.legLocalS : activeLeg.lengthU,
            t,
          )
        : 0;

    // Query true O(1) spatial Earth biome blending at exact `(lat, lng)`!
    const blendedRegion = this.resolveLegAwareBlendedRegion(
      geo.lat,
      geo.lng,
      activeLeg,
      nodeLocalS,
    );
    const profile = blendedRegion.riverProfile;
    const waterStyle = blendedRegion.waterStyle;
    const trackMinW = Math.min(RIVER_CONFIG.minWidth, profile.widthMin);
    const trackMaxW = Math.max(RIVER_CONFIG.maxWidth + 3.0, profile.widthMax + 2.5);
    const trackMinD = Math.min(RIVER_CONFIG.minDepth, profile.depthMin);
    const trackMaxD = Math.max(RIVER_CONFIG.maxDepth, profile.depthMax);

    // Smoothly interpolate channel width, depth, baseline rapids, and baseline elevation
    let width = catmullRom(n0.width, n1.width, n2.width, n3.width, t);
    let depth = catmullRom(n0.depth, n1.depth, n2.depth, n3.depth, t);
    let rapidsIntensity = clamp(
      catmullRom(n0.rapids, n1.rapids, n2.rapids, n3.rapids, t),
      0,
      1,
    );
    const baseY = lerp(n1.baseY, n2.baseY, t);
    const rawElev = lerp(n1.rawElev, n2.rawElev, t);
    const baseSlope = (n2.baseY - n1.baseY) / Math.max(0.001, n1.segLength);
    const speedBoost = lerp(n1.speedBoost, n2.speedBoost, t);

    const upcomingFork =
      activeLeg !== null
        ? this.getUpcomingForkForLeg(
            activeLeg,
            nodeLocalS,
            MINI_EARTH_CONFIG.forkWarningDistanceU,
          )
        : this.getUpcomingForkAt(safeS, MINI_EARTH_CONFIG.forkWarningDistanceU);

    // Gently widen the confluence basin right before a 2-way fork so both channels read cleanly
    if (upcomingFork && upcomingFork.distanceU < 34) {
      const flare = smoothstep01(1.0 - upcomingFork.distanceU / 34);
      width = lerp(width, Math.min(trackMaxW, width + 3.0), flare * 0.65);
    }

    // Evaluate waterfalls (vertical drop + slope + lip narrowing + plunge pool widening)
    let waterfallDropSum = this.prunedWaterfallDropSum;
    let extraSlope = 0;
    let isWaterfall = false;
    let waterfallDrop = 0;
    let waterfallPhase = 0;
    let activeWaterfall: WaterfallInfo | null = null;
    let plungePoolIntensity = 0;

    for (let i = 0; i < this.waterfalls.length; i++) {
      const wf = this.waterfalls[i];
      if (safeS >= wf.endS) {
        waterfallDropSum += wf.dropHeight;
        // Wide, deep foaming plunge pool downstream of waterfall
        if (safeS <= wf.plungePoolEndS) {
          const poolT = (safeS - wf.endS) / Math.max(1, wf.plungePoolEndS - wf.endS);
          const poolBell = Math.sin(poolT * Math.PI);
          plungePoolIntensity = Math.max(plungePoolIntensity, 1.0 - smoothstep01(poolT));
          width = Math.max(width, lerp(width, profile.widthMax, 0.72 * poolBell));
          depth = Math.max(depth, lerp(depth, profile.depthMax, 0.85 * poolBell));
          rapidsIntensity = Math.max(rapidsIntensity, 0.78 * (1.0 - poolT * 0.75));
        }
      } else if (safeS >= wf.startS) {
        const phase = clamp((safeS - wf.startS) / wf.lengthS, 0, 1);
        const dropFrac = smootherstep01(phase);
        const dropDeriv = smootherstepDeriv01(phase) / wf.lengthS;
        waterfallDropSum += wf.dropHeight * dropFrac;
        extraSlope -= wf.dropHeight * dropDeriv;
        isWaterfall = true;
        waterfallDrop = wf.dropHeight;
        waterfallPhase = phase;
        activeWaterfall = wf;
        const lipNarrow = Math.sin(phase * Math.PI);
        width = lerp(
          width,
          Math.max(profile.widthMin + 0.6, width * 0.86),
          lipNarrow * 0.55,
        );
        rapidsIntensity = Math.max(rapidsIntensity, 0.85 + 0.15 * lipNarrow);
      } else {
        // Accelerating shallow approach lip right before waterfall crest
        const distToLip = wf.startS - safeS;
        if (distToLip < 16) {
          const approach = smoothstep01(1.0 - distToLip / 16);
          width = lerp(
            width,
            Math.max(profile.widthMin + 0.8, width * 0.88),
            approach * 0.5,
          );
          depth = lerp(depth, Math.max(profile.depthMin, depth * 0.82), approach * 0.45);
          rapidsIntensity = Math.max(rapidsIntensity, 0.55 + 0.35 * approach);
        }
      }
    }

    width = clamp(width, trackMinW, trackMaxW);
    depth = clamp(depth, trackMinD, trackMaxD);

    const netDrop = waterfallDropSum - this.dropBaselineOffset;
    const y = baseY - netDrop;
    const elevation = rawElev - netDrop;
    const slope = baseSlope + extraSlope;

    // Build orthonormal 3D frame: tangent (unit), right (horizontal unit), up = cross(right, tangent)
    const invTanLen = 1.0 / Math.hypot(1.0, slope);
    const tangent: Vec3 = {
      x: txXZ * invTanLen,
      y: slope * invTanLen,
      z: tzXZ * invTanLen,
    };
    const right: Vec3 = {
      x: rightX,
      y: 0,
      z: rightZ,
    };
    // cross(right, tangent) = (ry*tz - rz*ty, rz*tx - rx*tz, rx*ty - ry*tx)
    const up: Vec3 = {
      x: -rightZ * tangent.y,
      y: rightZ * tangent.x - rightX * tangent.z,
      z: rightX * tangent.y,
    };

    const regionId = blendedRegion.primaryZone.id;
    const secondaryRegionId = blendedRegion.secondaryZone.id;
    const regionBlend = blendedRegion.blend;
    const biomeIndex = earthWorld.getZoneIndex(regionId);
    const canyonWallFactor = profile.canyonWallFactor;

    // Narrow chutes, steeper slopes & regional rapidsBase drive local rapids & current speed
    const midTrackWidth = 0.5 * (profile.widthMin + profile.widthMax);
    const narrowness = clamp(
      (midTrackWidth - width) / Math.max(1.0, midTrackWidth - profile.widthMin),
      0,
      1,
    );
    const slopeBoost = clamp((-slope - 0.044) * 4.5, 0, 1);
    rapidsIntensity = clamp(
      Math.max(
        rapidsIntensity,
        profile.rapidsBase * 0.72 + narrowness * 0.48 + slopeBoost * 0.45,
      ),
      0,
      1,
    );

    const jetStreamScale = clamp(lerp(1.0, speedBoost, 0.45), 0.9, 1.45);
    const flowSpeedMultiplier = clamp(
      waterStyle.flowSpeedMult *
        jetStreamScale *
        Math.pow(midTrackWidth / Math.max(4.0, width), 0.52) *
        (1.0 + Math.max(0, -slope - 0.04) * 1.4),
      0.78,
      2.05,
    );

    // Cave entrance / branch metadata
    let hasCaveEntrance = false;
    let caveOffset = 0;
    let caveBranch: ExtendedCaveBranchInfo | null = null;

    for (let i = 0; i < this.caves.length; i++) {
      const cave = this.caves[i];
      if (safeS >= cave.startS - 14 && safeS <= cave.endS + 8) {
        caveBranch = cave;
        if (safeS >= cave.startS - 10 && safeS <= cave.startS + 14) {
          hasCaveEntrance = true;
          caveOffset = cave.side * (width * 0.5 + 0.8);
        }
        break;
      }
    }

    const caveVisual = caveBranch?.caveVisual ?? blendedRegion.caveStyle;
    const caveStyle = caveBranch?.caveStyle ?? inferLegacyCaveStyle(caveVisual);

    return {
      s: safeS,
      position: { x, y, z },
      tangent,
      right,
      up,
      width,
      depth,
      slope,
      curvature,
      isWaterfall,
      waterfallDrop,
      waterfallPhase,
      hasCaveEntrance,
      caveOffset,
      biomeIndex,
      biomeBlend: regionBlend,
      flowSpeedMultiplier,
      rapidsIntensity,
      plungePoolIntensity,
      waterfall: activeWaterfall,
      caveBranch,
      lat: geo.lat,
      lng: geo.lng,
      elevation,
      waterwayId,
      regionId,
      secondaryRegionId,
      regionBlend,
      upcomingFork,
      trackId: regionId,
      nextTrackId: secondaryRegionId,
      trackBlend: regionBlend,
      canyonWallFactor,
      caveStyle,
      caveVisual,
      speedBoost,
    };
  }

  public sampleRange(sStart: number, sEnd: number, step: number): ExtendedRiverSample[] {
    const safeStep = Math.max(0.25, step);
    const start = Math.max(0, sStart);
    const end = Math.max(start, sEnd);
    const out: ExtendedRiverSample[] = [];
    for (let s = start; s <= end + 1e-4; s += safeStep) {
      out.push(this.sampleAt(Math.min(s, end)));
    }
    return out;
  }

  /**
   * Convert river-space coordinates `(s, u, y)` into world space.
   * `u` shifts horizontally along `sample.right`; `y` shifts vertically along world `+Y`
   * relative to the resting water surface `sample.position.y`.
   */
  public riverToWorld(s: number, u: number, y: number = 0): Vec3 {
    const sample = this.sampleAt(s);
    return {
      x: sample.position.x + sample.right.x * u,
      y: sample.position.y + y,
      z: sample.position.z + sample.right.z * u,
    };
  }

  /**
   * Project an arbitrary world-space position back into `(s, u, y)` river coordinates.
   * Pass `hintS` when tracking a moving object for microsecond-fast local refinement.
   */
  public worldToRiver(worldPos: Vec3, hintS?: number): RiverCoords {
    let bestS = 0;
    let bestDistSq = Infinity;

    if (hintS !== undefined && Number.isFinite(hintS)) {
      const minS = Math.max(0, hintS - 28);
      const maxS = Math.max(minS + 4, hintS + 28);
      for (let s = minS; s <= maxS; s += 2.0) {
        const p = this.sampleHorizontalPosition(s);
        const dx = worldPos.x - p.x;
        const dz = worldPos.z - p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          bestS = s;
        }
      }
      bestS = this.refineClosestS(worldPos, Math.max(0, bestS - 2.2), bestS + 2.2);
    } else {
      let closestIdx = 0;
      for (let i = 0; i < this.nodes.length; i++) {
        const n = this.nodes[i];
        if (n.s < 0) continue;
        const dx = worldPos.x - n.x;
        const dz = worldPos.z - n.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          closestIdx = i;
        }
      }
      const prevNode = this.nodes[Math.max(0, closestIdx - 1)];
      const nextNode = this.nodes[Math.min(this.nodes.length - 1, closestIdx + 1)];
      const minS = Math.max(0, prevNode.s);
      const maxS = Math.max(minS + 2, nextNode.s);
      bestS = this.refineClosestS(worldPos, minS, maxS);
    }

    const sample = this.sampleAt(bestS);
    const dx = worldPos.x - sample.position.x;
    const dz = worldPos.z - sample.position.z;
    const u = dx * sample.right.x + dz * sample.right.z;
    const y = worldPos.y - sample.position.y;

    return { s: bestS, u, y };
  }

  /**
   * Fast query returning water surface height, analytical wave normal, flow velocity,
   * foam intensity, and local depth directly from river coordinates `(s, u, time)`.
   */
  public getWaterSurfaceAtRiver(
    s: number,
    u: number,
    time: number = 0,
  ): WaterSurfaceQuery {
    const sample = this.sampleAt(s);
    const halfWidth = sample.width * 0.5;

    // Inside a cave branch, use the cave's local lateral offset & calmer waves
    const activeCave = this.isInsideCave(s, u);
    const effectiveHalfW = activeCave ? activeCave.width * 0.5 : halfWidth;
    const effectiveU = activeCave ? u - this.getCaveCenterU(activeCave, s) : u;
    const effectiveRapids = activeCave
      ? sample.rapidsIntensity * 0.45
      : sample.rapidsIntensity;

    const wave = computeWaterWaveState(
      s,
      effectiveU,
      time,
      effectiveHalfW,
      effectiveRapids,
      activeCave ? 0 : sample.waterfallPhase,
    );

    const height = sample.position.y + wave.height;

    const horizLen = Math.hypot(sample.tangent.x, sample.tangent.z) || 1.0;
    const tx = sample.tangent.x / horizLen;
    const tz = sample.tangent.z / horizLen;
    const rx = sample.right.x;
    const rz = sample.right.z;

    const tsY = sample.slope + wave.dhds;
    const tuY = wave.dhdu;
    const nx = tuY * tz - rz * tsY;
    const ny = rz * tx - rx * tz;
    const nz = rx * tsY - tuY * tx;
    const invN = 1.0 / (Math.hypot(nx, ny, nz) || 1.0);

    const normal: Vec3 = {
      x: nx * invN,
      y: ny * invN,
      z: nz * invN,
    };

    const edgeNorm = clamp(Math.abs(effectiveU) / Math.max(1.0, effectiveHalfW), 0, 1);
    const channelProfile = 1.0 - 0.32 * edgeNorm * edgeNorm;
    const flowMag =
      DUCK_CONFIG.baseSpeed * (sample.flowSpeedMultiplier ?? 1.0) * channelProfile;

    const flowVelocity: Vec3 = {
      x: sample.tangent.x * flowMag,
      y: sample.tangent.y * flowMag,
      z: sample.tangent.z * flowMag,
    };

    const bankFoam = smoothstep01((edgeNorm - 0.78) / 0.22) * 0.55;
    const waterfallFoam = sample.isWaterfall
      ? 0.65 + 0.35 * Math.sin(sample.waterfallPhase * Math.PI)
      : sample.plungePoolIntensity * 0.85;
    const foam = clamp(
      Math.max(bankFoam, waterfallFoam, effectiveRapids * 0.52),
      0,
      1,
    );

    const baseDepth = activeCave ? activeCave.depth : sample.depth;
    const depthProfile = Math.max(0, 1.0 - Math.pow(edgeNorm, 2.4));
    const depth = baseDepth * (0.18 + 0.82 * depthProfile);

    return {
      height,
      normal,
      flowVelocity,
      foam,
      depth,
    };
  }

  public getWaterSurface(
    worldX: number,
    worldZ: number,
    time: number = 0,
    hintS?: number,
  ): WaterSurfaceQuery {
    const coords = this.worldToRiver({ x: worldX, y: 0, z: worldZ }, hintS);
    return this.getWaterSurfaceAtRiver(coords.s, coords.u, time);
  }

  public getWaterHeightAtRiver(s: number, u: number, time: number = 0): number {
    const sample = this.sampleAt(s);
    const activeCave = this.isInsideCave(s, u);
    const effectiveHalfW = activeCave ? activeCave.width * 0.5 : sample.width * 0.5;
    const effectiveU = activeCave ? u - this.getCaveCenterU(activeCave, s) : u;
    const effectiveRapids = activeCave
      ? sample.rapidsIntensity * 0.45
      : sample.rapidsIntensity;

    const waveY = computeWaterWaveHeight(
      s,
      effectiveU,
      time,
      effectiveHalfW,
      effectiveRapids,
      activeCave ? 0 : sample.waterfallPhase,
    );
    return sample.position.y + waveY;
  }

  public getCaveBranches(sStart: number, sEnd: number): readonly ExtendedCaveBranchInfo[] {
    this.ensureAhead(sEnd + 100);
    const result: ExtendedCaveBranchInfo[] = [];
    for (let i = 0; i < this.caves.length; i++) {
      const c = this.caves[i];
      if (c.endS >= sStart && c.startS <= sEnd) {
        result.push(c);
      }
    }
    return result;
  }

  /**
   * Smooth lateral centerline offset `u` inside a curving Submerged Cave Shortcut.
   * Matches `src/render/waterMesh.ts` and `src/render/environment.ts` identically:
   *   `side * (width * 0.36 + (maxOffset - width * 0.36) * sin(t * PI))`
   */
  public getCaveCenterU(branch: CaveBranchInfo, s: number): number {
    const t = clamp((s - branch.startS) / Math.max(1, branch.endS - branch.startS), 0, 1);
    const sample = this.sampleAt(s);
    const startU = sample.width * 0.36;
    const swing = Math.sin(t * Math.PI);
    return branch.side * (startU + (branch.maxOffset - startU) * swing);
  }

  /**
   * Vaulted cave ceiling height above local water surface along `branch`,
   * matching the sculpted arch geometry in `environment.ts`.
   */
  public getCaveCeilingY(branch: CaveBranchInfo, s: number): number {
    const t = clamp((s - branch.startS) / Math.max(1, branch.endS - branch.startS), 0, 1);
    const portalFlare =
      1.0 + 0.22 * (Math.exp(-t * 14.0) + Math.exp(-(1.0 - t) * 14.0));
    return branch.ceilingHeight * 0.85 * portalFlare;
  }

  /**
   * Returns the cave branch containing `(s, u)` if inside its lateral tunnel corridor,
   * or `null` if on the open river.
   */
  public isInsideCave(s: number, u: number): ExtendedCaveBranchInfo | null {
    for (let i = 0; i < this.caves.length; i++) {
      const cave = this.caves[i];
      if (s < cave.startS || s > cave.endS) continue;
      if (u * cave.side < 2.0) continue;
      const centerU = this.getCaveCenterU(cave, s);
      const halfW = cave.width * 0.5 + 0.9;
      if (Math.abs(u - centerU) <= halfW) {
        const t = (s - cave.startS) / Math.max(1, cave.endS - cave.startS);
        const mainHalfW = this.getApproxWidthAt(s) * 0.5;
        if (t > 0.08 && t < 0.92) {
          return cave;
        }
        if (Math.abs(u) >= mainHalfW - 0.8) {
          return cave;
        }
      }
    }
    return null;
  }

  /** Return all waterfalls overlapping `[sStart, sEnd]`. */
  public getWaterfallsInRange(sStart: number, sEnd: number): readonly WaterfallInfo[] {
    this.ensureAhead(sEnd + 100);
    const out: WaterfallInfo[] = [];
    for (let i = 0; i < this.waterfalls.length; i++) {
      const wf = this.waterfalls[i];
      if (wf.plungePoolEndS >= sStart && wf.startS - 20 <= sEnd) {
        out.push(wf);
      }
    }
    return out;
  }

  /** Return the nearest upcoming waterfall whose drop ends at or after `s`. */
  public getNextWaterfall(s: number): WaterfallInfo | null {
    this.ensureAhead(s + 450);
    for (let i = 0; i < this.waterfalls.length; i++) {
      const wf = this.waterfalls[i];
      if (wf.endS >= s) return wf;
    }
    return null;
  }

  /** Return the nearest upcoming cave branch whose exit is ahead of `s`. */
  public getNextCave(s: number): ExtendedCaveBranchInfo | null {
    this.ensureAhead(s + 550);
    for (let i = 0; i < this.caves.length; i++) {
      const cave = this.caves[i];
      if (cave.endS >= s) return cave;
    }
    return null;
  }

  public getObstaclesInRange(sStart: number, sEnd: number): readonly HydroObstacle[] {
    return this.obstacleQueryFn ? this.obstacleQueryFn(sStart, sEnd) : [];
  }

  /** Total generated downstream arc-length currently buffered. */
  public getMaxGeneratedS(): number {
    return this.nodes.length > 0 ? this.nodes[this.nodes.length - 1].s : 0;
  }

  // ---------------------------------------------------------------------------
  // Internal Earth Waterway Chaining, Fork Switching & Streaming Spline Nodes
  // ---------------------------------------------------------------------------

  private syncFromCompatRoute(force: boolean): void {
    const compatTrackId = this.route.getStartTrackId() || DEFAULT_REGION_ID;
    const compatMode = this.route.getRouteMode();

    if (
      force ||
      compatTrackId !== this.syncedRouteTrackId ||
      compatMode !== this.syncedRouteMode
    ) {
      this.routeMode = compatMode;
      if (compatTrackId !== this.syncedRouteTrackId || !this.explicitWaterwayId) {
        this.startRegionId = compatTrackId;
        this.startWaterwayId =
          earthWorld.getPrimaryWaterwayForRegion(compatTrackId).id;
        this.explicitWaterwayId = null;
      }
      this.syncedRouteTrackId = compatTrackId;
      this.syncedRouteMode = compatMode;
    }
  }

  private ensureChainUpToS(targetS: number): void {
    while (
      this.chain.length === 0 ||
      this.chain[this.chain.length - 1].endS <= targetS
    ) {
      this.appendNextWaterwayLeg();
    }
  }

  private appendNextWaterwayLeg(preferredSide?: 'left' | 'right' | null): void {
    if (this.chain.length === 0) return;

    const prevLeg = this.chain[this.chain.length - 1];
    const nextIndex = prevLeg.index + 1;
    const startS = prevLeg.endS;

    // In `single_track` mode, alternate smoothly between the locked primary waterway
    // and a scenic real-geography C1 return loop inside the same region zone!
    if (this.routeMode === 'single_track') {
      const primaryWw =
        earthWorld.getWaterwayById(this.startWaterwayId) ??
        earthWorld.getPrimaryWaterwayForRegion(this.startRegionId);

      if (!prevLeg.isReturnLoop) {
        const prevEndSample = this.sampleChainLegRaw(prevLeg, prevLeg.lengthU);
        const returnLut = this.buildSingleTrackReturnLoop(
          primaryWw,
          prevEndSample.elevation,
        );
        const loopLen =
          returnLut.length > 0 ? returnLut[returnLut.length - 1].s : 260;

        this.chain.push({
          index: nextIndex,
          waterwayId: `${primaryWw.id}__return`,
          waterwayName: `${primaryWw.name} Valley Loop`,
          regionId: primaryWw.regionId,
          fromJunctionId: primaryWw.toJunctionId,
          toJunctionId: primaryWw.fromJunctionId,
          startS,
          endS: startS + loopLen,
          lengthU: loopLen,
          isConnector: false,
          isReturnLoop: true,
          locked: true,
          elevOffset: 0,
          returnLut,
        });
      } else {
        const prevEndSample = this.sampleChainLegRaw(prevLeg, prevLeg.lengthU);
        const headSample = earthWorld.sampleWaterway(primaryWw.id, 0);
        const len = Math.max(80, earthWorld.getWaterwayLength(primaryWw.id));

        this.chain.push({
          index: nextIndex,
          waterwayId: primaryWw.id,
          waterwayName: primaryWw.name,
          regionId: primaryWw.regionId,
          fromJunctionId: primaryWw.fromJunctionId,
          toJunctionId: primaryWw.toJunctionId,
          startS,
          endS: startS + len,
          lengthU: len,
          isConnector: Boolean(primaryWw.isConnector),
          isReturnLoop: false,
          locked: true,
          elevOffset: prevEndSample.elevation - headSample.elevation,
        });
      }
      return;
    }

    // Connected planetary traversal (`'world_tour'` | `'free_earth'`):
    // Follow actual physical outgoing `EarthWaterway`s out of `prevLeg.toJunctionId`!
    const nextWw = this.selectNextOutgoingWaterway(
      prevLeg,
      preferredSide ?? null,
    );
    const realLen = Math.max(80, earthWorld.getWaterwayLength(nextWw.id));
    const isConnector = Boolean(nextWw.isConnector);
    const toJunc = earthWorld.getJunctionById(nextWw.toJunctionId);
    const toRegionId = toJunc?.regionId ?? nextWw.regionId;
    // Compress long intercontinental ocean/canyon connectors into an exciting ~4s Jet-Stream
    // transition while still sweeping the duck's real GPS across the entire Earth waterway!
    const len =
      isConnector && realLen > CONNECTOR_PLAYABLE_LEN
        ? CONNECTOR_PLAYABLE_LEN
        : realLen;

    this.chain.push({
      index: nextIndex,
      waterwayId: nextWw.id,
      waterwayName: nextWw.name,
      regionId: nextWw.regionId,
      toRegionId,
      fromJunctionId: nextWw.fromJunctionId,
      toJunctionId: nextWw.toJunctionId,
      startS,
      endS: startS + len,
      lengthU: len,
      realLengthU: realLen,
      isConnector,
      isReturnLoop: false,
      locked: false,
      elevOffset: prevLeg.elevOffset,
    });
  }

  private selectNextOutgoingWaterway(
    prevLeg: WaterwayChainLeg,
    preferredSide: 'left' | 'right' | null,
  ): EarthWaterway {
    const outgoing = earthWorld.getOutgoingWaterways(prevLeg.toJunctionId);
    if (outgoing.length === 0) {
      return (
        earthWorld.getWaterwayById(prevLeg.waterwayId) ??
        earthWorld.getPrimaryWaterwayForRegion(DEFAULT_REGION_ID)
      );
    }
    if (outgoing.length === 1) {
      return outgoing[0];
    }

    // 2+ outgoing branches -> real physical Y-fork!
    const fork = earthWorld.getUpcomingFork(
      prevLeg.waterwayId,
      prevLeg.lengthU,
      Math.max(20, prevLeg.lengthU),
    );
    if (fork && preferredSide) {
      const pickedId =
        preferredSide === 'left'
          ? fork.leftBranch.waterwayId
          : fork.rightBranch.waterwayId;
      const found = outgoing.find((w) => w.id === pickedId);
      if (found) return found;
    }

    // Default World Tour preference: explore unvisited regions first, else use fork's defaultBranch
    const visitedRegions = new Set(this.chain.map((l) => l.regionId));
    for (let i = 0; i < outgoing.length; i++) {
      const cand = outgoing[i];
      const destZone = earthWorld.resolveTargetRegionForWaterway(cand);
      if (!visitedRegions.has(destZone.id)) {
        return cand;
      }
    }

    if (fork) {
      const def = outgoing.find((w) => w.id === fork.defaultBranch.waterwayId);
      if (def) return def;
    }

    return outgoing[(prevLeg.index + this.seed) % outgoing.length];
  }

  /**
   * Live fork branch switching before the commit window:
   * Swaps the tentative unlocked leg(s) after the upcoming fork junction and smoothly
   * rebuilds downstream nodes past that junction without disturbing anything under or
   * behind the duck!
   */
  private applyForkChoiceAhead(
    playerS: number,
    side: 'left' | 'right',
  ): void {
    const curLeg = this.findLegAtS(playerS);
    if (!curLeg || curLeg.isReturnLoop) return;

    const distToJunc = curLeg.endS - playerS;
    if (distToJunc <= MINI_EARTH_CONFIG.forkCommitDistanceU) {
      // Already committed into the fork turn — do not snap!
      return;
    }

    const fork = earthWorld.getUpcomingFork(
      curLeg.waterwayId,
      clamp(playerS - curLeg.startS, 0, curLeg.lengthU),
      Math.max(MINI_EARTH_CONFIG.forkWarningDistanceU + 40, curLeg.lengthU),
    );
    if (!fork) return;

    const desiredWwId =
      side === 'left' ? fork.leftBranch.waterwayId : fork.rightBranch.waterwayId;
    const nextIdx = curLeg.index + 1;
    const existingNext = this.chain[nextIdx];

    if (existingNext && existingNext.locked) return;
    if (existingNext && existingNext.waterwayId === desiredWwId) return;

    // Truncate tentative chain legs past `curLeg` and append the chosen branch!
    this.chain.length = nextIdx;
    this.appendNextWaterwayLeg(side);

    // Truncate spline nodes strictly AFTER the junction (preserving all geometry up to junction!)
    const junctionS = curLeg.endS;
    let keepCount = this.nodes.length;
    while (
      keepCount > 4 &&
      (this.nodes[keepCount - 1].legIndex > curLeg.index ||
        this.nodes[keepCount - 1].s > junctionS - NODE_STEP * 0.25)
    ) {
      keepCount--;
    }
    if (keepCount < this.nodes.length) {
      this.nodes.length = keepCount;
      const lastKept = this.nodes[this.nodes.length - 1];
      this.nextNodeIndex = lastKept.index + 1;
      const lastLogicalS =
        lastKept.legIndex >= 0 && lastKept.legIndex < this.chain.length
          ? this.chain[lastKept.legIndex].startS + lastKept.legLocalS
          : lastKept.s;
      this.nextSampleS = lastLogicalS + NODE_STEP;
    }

    // Drop any tentative future waterfalls & caves strictly past the junction
    this.waterfalls = this.waterfalls.filter((wf) => wf.startS < junctionS - 4);
    this.caves = this.caves.filter((c) => c.startS < junctionS - 10);
    this.scheduledWaterfallsUpToLeg = Math.min(
      this.scheduledWaterfallsUpToLeg,
      curLeg.index,
    );
    if (this.nextCaveS > junctionS) {
      this.nextCaveS = junctionS + 55;
    }

    // Regenerate smooth lookahead along the newly chosen branch immediately!
    const targetAhead = Math.max(
      playerS + RIVER_CONFIG.aheadDistance + 160,
      junctionS + 160,
    );
    this.ensureAhead(targetAhead);
  }

  /**
   * Build a smooth C1-continuous geographic return loop inside the same region zone
   * connecting `ww.toJunctionId` back to `ww.fromJunctionId` for endless `'single_track'` play!
   */
  private buildSingleTrackReturnLoop(
    ww: EarthWaterway,
    startElev: number,
  ): ReturnLoopPoint[] {
    const wwLen = Math.max(80, earthWorld.getWaterwayLength(ww.id));
    const head = earthWorld.sampleWaterway(ww.id, 0);
    const mid = earthWorld.sampleWaterway(ww.id, wwLen * 0.5);
    const tail = earthWorld.sampleWaterway(ww.id, wwLen);
    const zone = earthWorld.getZoneById(ww.regionId);

    const frameB = createLocalTangentFrame(tail.lat, tail.lng, tail.elevation);
    const posA = earthToLocal(head.lat, head.lng, head.elevation, frameB, false);
    const posMid = earthToLocal(mid.lat, mid.lng, mid.elevation, frameB, false);
    const distAB = Math.max(60, Math.hypot(posA.x, posA.z));

    const outRad = tail.bearingDeg * DEG_TO_RAD;
    const inRad = head.bearingDeg * DEG_TO_RAD;

    // Bearing in ENU: 0° = North (-Z), 90° = East (+X)
    const tBx = Math.sin(outRad);
    const tBz = -Math.cos(outRad);
    const rBx = -tBz;
    const rBz = tBx;

    const tAx = Math.sin(inRad);
    const tAz = -Math.cos(inRad);
    const rAx = -tAz;
    const rAz = tAx;

    // Bow around the opposite side of the valley from the river's midpoint bends
    const midSideDot =
      (posMid.x - posA.x * 0.5) * rBx + (posMid.z - posA.z * 0.5) * rBz;
    const side = midSideDot >= 0 ? -1 : 1;

    const handle = clamp(distAB * 0.36, 48, 76);
    const bow = clamp(distAB * 0.44, 68, 112);

    const avgRxRaw = rBx + rAx;
    const avgRzRaw = rBz + rAz;
    const avgRLen = Math.hypot(avgRxRaw, avgRzRaw) || 1.0;
    const avgRx = avgRLen > 0.25 ? avgRxRaw / avgRLen : rBx;
    const avgRz = avgRLen > 0.25 ? avgRzRaw / avgRLen : rBz;

    const ctrlXZ: Array<{ x: number; z: number }> = [
      { x: 0, z: 0 },
      { x: tBx * handle, z: tBz * handle },
      {
        x: tBx * (handle * 1.45) + rBx * (side * bow),
        z: tBz * (handle * 1.45) + rBz * (side * bow),
      },
      {
        x: posA.x * 0.5 + avgRx * (side * bow * 1.1),
        z: posA.z * 0.5 + avgRz * (side * bow * 1.1),
      },
      {
        x: posA.x - tAx * (handle * 1.45) + rAx * (side * bow),
        z: posA.z - tAz * (handle * 1.45) + rAz * (side * bow),
      },
      { x: posA.x - tAx * handle, z: posA.z - tAz * handle },
      { x: posA.x, z: posA.z },
    ];

    const lut: ReturnLoopPoint[] = [];
    let accumS = 0;
    const segCount = ctrlXZ.length - 1;
    const nominalW = lerp(zone.riverProfile.widthMin, zone.riverProfile.widthMax, 0.52);
    const nominalD = lerp(zone.riverProfile.depthMin, zone.riverProfile.depthMax, 0.5);
    const slopeRate = zone.riverProfile.slopeBase * 0.55;

    for (let seg = 0; seg < segCount; seg++) {
      const p0 = ctrlXZ[Math.max(0, seg - 1)];
      const p1 = ctrlXZ[seg];
      const p2 = ctrlXZ[seg + 1];
      const p3 = ctrlXZ[Math.min(ctrlXZ.length - 1, seg + 2)];

      const steps = 12;
      const startStep = seg === 0 ? 0 : 1;
      for (let k = startStep; k <= steps; k++) {
        const t = k / steps;
        const cx = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
        const cz = catmullRom(p0.z, p1.z, p2.z, p3.z, t);

        const geo = localToEarth({ x: cx, y: 0, z: cz }, frameB, false);
        const u = latLngToSphere(geo.lat, geo.lng, 1.0);

        if (lut.length > 0) {
          const prev = lut[lut.length - 1];
          const d = clamp(prev.ux * u.x + prev.uy * u.y + prev.uz * u.z, -1, 1);
          accumS += Math.acos(d) * MINI_EARTH_RADIUS;
        }

        const wOsc = 0.5 + 0.35 * Math.sin(accumS * 0.025 + 0.6);
        const width = lerp(
          zone.riverProfile.widthMin,
          zone.riverProfile.widthMax,
          wOsc,
        );
        const depth = lerp(zone.riverProfile.depthMin, zone.riverProfile.depthMax, wOsc);
        const rapids = clamp(
          zone.riverProfile.rapidsBase + (1 - wOsc) * 0.25,
          0.1,
          0.85,
        );

        lut.push({
          s: accumS,
          ux: u.x,
          uy: u.y,
          uz: u.z,
          lat: geo.lat,
          lng: geo.lng,
          elevation: startElev + accumS * slopeRate,
          width: seg === 0 && k === 0 ? tail.width : seg === segCount - 1 && k === steps ? head.width : lerp(nominalW, width, 0.7),
          depth: seg === 0 && k === 0 ? tail.depth : seg === segCount - 1 && k === steps ? head.depth : lerp(nominalD, depth, 0.7),
          rapids,
        });
      }
    }

    // Guarantee exact start/end geographic match with junctions
    if (lut.length >= 2) {
      const uStart = latLngToSphere(tail.lat, tail.lng, 1.0);
      lut[0].lat = tail.lat;
      lut[0].lng = tail.lng;
      lut[0].ux = uStart.x;
      lut[0].uy = uStart.y;
      lut[0].uz = uStart.z;

      const last = lut[lut.length - 1];
      const uEnd = latLngToSphere(head.lat, head.lng, 1.0);
      last.lat = head.lat;
      last.lng = head.lng;
      last.ux = uEnd.x;
      last.uy = uEnd.y;
      last.uz = uEnd.z;
    }

    return lut;
  }

  private sampleChainLegRaw(
    leg: WaterwayChainLeg,
    localS: number,
  ): {
    lat: number;
    lng: number;
    elevation: number;
    width: number;
    depth: number;
    rapids: number;
    speedBoost: number;
  } {
    const safeLocalS = clamp(localS, 0, leg.lengthU);

    if (leg.isReturnLoop && leg.returnLut && leg.returnLut.length >= 2) {
      const lut = leg.returnLut;
      let lo = 0;
      let hi = lut.length - 2;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (safeLocalS < lut[mid].s) {
          hi = mid - 1;
        } else if (safeLocalS > lut[mid + 1].s) {
          lo = mid + 1;
        } else {
          lo = mid;
          break;
        }
      }
      const idx = clamp(lo, 0, lut.length - 2);
      const a = lut[idx];
      const b = lut[idx + 1];
      const t = clamp((safeLocalS - a.s) / Math.max(1e-5, b.s - a.s), 0, 1);

      const ux = a.ux + (b.ux - a.ux) * t;
      const uy = a.uy + (b.uy - a.uy) * t;
      const uz = a.uz + (b.uz - a.uz) * t;
      const invL = 1.0 / (Math.hypot(ux, uy, uz) || 1.0);
      const geo = sphereToLatLng({ x: ux * invL, y: uy * invL, z: uz * invL });

      return {
        lat: geo.lat,
        lng: geo.lng,
        elevation: lerp(a.elevation, b.elevation, t) + leg.elevOffset,
        width: lerp(a.width, b.width, t),
        depth: lerp(a.depth, b.depth, t),
        rapids: lerp(a.rapids, b.rapids, t),
        speedBoost: 1.0,
      };
    }

    // Map compressed Jet-Stream connector progress onto the full real planetary waterway
    // so live GPS zips smoothly across oceans & continents on the 3D Mini-Earth Globe!
    const realLen = leg.realLengthU ?? leg.lengthU;
    const isCompressedConnector = leg.isConnector && realLen > leg.lengthU + 1.0;
    const geoSampleS = isCompressedConnector
      ? clamp(safeLocalS / Math.max(1, leg.lengthU), 0, 1) * realLen
      : safeLocalS;

    const wwSample = earthWorld.sampleWaterway(leg.waterwayId, geoSampleS);
    let lat = wwSample.lat;
    let lng = wwSample.lng;

    // Add gentle organic ocean-wave meander strictly in the middle of long open-ocean connector
    // straits (> 450u) while keeping all junctions and regional waterways 100% geographically exact!
    if (leg.isConnector && leg.lengthU > 450) {
      const env =
        smoothstep01(safeLocalS / 55) *
        smoothstep01((leg.lengthU - safeLocalS) / 55);
      if (env > 0.001) {
        const offsetU =
          env *
          (6.5 * Math.sin(safeLocalS * 0.015 + leg.index * 1.7) +
            3.2 * Math.cos(safeLocalS * 0.031 - 0.8));
        const perpBearing = (wwSample.bearingDeg + (offsetU >= 0 ? 90 : 270)) % 360;
        const shifted = destinationPoint(
          lat,
          lng,
          perpBearing,
          Math.abs(offsetU),
        );
        lat = shifted.lat;
        lng = shifted.lng;
      }
    }

    return {
      lat,
      lng,
      elevation: wwSample.elevation + leg.elevOffset,
      width: wwSample.width,
      depth: wwSample.depth,
      rapids: wwSample.rapids,
      speedBoost: wwSample.speedBoost,
    };
  }

  private findLegAtS(s: number): WaterwayChainLeg | null {
    if (this.chain.length === 0) return null;
    const safeS = Math.max(0, s);
    let lo = 0;
    let hi = this.chain.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const leg = this.chain[mid];
      if (safeS < leg.startS) {
        hi = mid - 1;
      } else if (safeS >= leg.endS) {
        lo = mid + 1;
      } else {
        return leg;
      }
    }
    return this.chain[clamp(lo, 0, this.chain.length - 1)];
  }

  /**
   * Locate the exact spline arc-length `s` corresponding to the physical end junction
   * of `leg` so fork previews align to the millimeter with the main water ribbon.
   */
  private findJunctionSplineS(leg: WaterwayChainLeg): number {
    for (let i = 0; i < this.nodes.length - 1; i++) {
      const n1 = this.nodes[i];
      const n2 = this.nodes[i + 1];
      if (n1.legIndex === leg.index && n2.legIndex > leg.index) {
        const remBefore = Math.max(0, leg.lengthU - n1.legLocalS);
        const span = Math.max(0.01, remBefore + n2.legLocalS);
        const frac = clamp(remBefore / span, 0, 1);
        return lerp(n1.s, n2.s, frac);
      }
    }
    return leg.endS;
  }

  private seedInitialNodes(): void {
    const firstLeg = this.chain[0];
    const start0 = earthWorld.sampleWaterway(firstLeg.waterwayId, 0);
    const backBearing = (start0.bearingDeg + 180) % 360;
    const startRegion = earthWorld.getBlendedRegionAt(start0.lat, start0.lng);

    // Three pre-start ghost nodes at s = -30, -20, -10, and anchor node at s = 0
    for (let i = -3; i <= 0; i++) {
      const s = i * NODE_STEP;
      let lat = start0.lat;
      let lng = start0.lng;
      if (i < 0) {
        const backGeo = destinationPoint(start0.lat, start0.lng, backBearing, -s);
        lat = backGeo.lat;
        lng = backGeo.lng;
      }
      const rawElev = start0.elevation + s * startRegion.riverProfile.slopeBase * 0.72;
      const u = latLngToSphere(lat, lng, 1.0);
      const localPos = earthToLocal(lat, lng, rawElev, this.localFrame);

      this.nodes.push({
        index: i,
        s,
        x: localPos.x,
        z: localPos.z,
        baseY: localPos.y,
        ux: u.x,
        uy: u.y,
        uz: u.z,
        lat,
        lng,
        rawElev,
        width: start0.width,
        depth: start0.depth,
        rapids: start0.rapids,
        waterwayId: firstLeg.waterwayId,
        legIndex: i === 0 ? 0 : -1,
        legLocalS: 0,
        speedBoost: start0.speedBoost,
        segLutS: new Float32Array(SEG_SUBDIVS + 1),
        segLength: NODE_STEP,
      });
    }

    this.nextNodeIndex = 1;
    this.nextSampleS = NODE_STEP;

    for (let i = 0; i < 4; i++) {
      this.appendNextNode();
    }
    this.recomputeArcLengthsFrom(0);
  }

  private ensureAhead(targetS: number): void {
    if (this.isEnsuringAhead) return;
    this.isEnsuringAhead = true;
    try {
      this.ensureChainUpToS(targetS + 260);
      this.scheduleFeaturesUpTo(targetS + 160);

      let added = false;
      const startIdx = Math.max(0, this.nodes.length - 3);
      while (
        this.nodes.length === 0 ||
        this.nodes[this.nodes.length - 1].s < targetS + NODE_STEP * 3
      ) {
        this.appendNextNode();
        added = true;
      }
      if (added) {
        this.recomputeArcLengthsFrom(startIdx);
        this.syncWaterfallElevations();
      }
    } finally {
      this.isEnsuringAhead = false;
    }
  }

  private scheduleFeaturesUpTo(horizonS: number): void {
    // 1. Honor real waypoint waterfalls declared on each physical `EarthWaterway` leg
    //    AND schedule supplemental regional waterfalls on long ocean straits / return loops!
    for (let li = this.scheduledWaterfallsUpToLeg + 1; li < this.chain.length; li++) {
      const leg = this.chain[li];
      if (leg.startS > horizonS + 120) break;

      const addedWfS: number[] = [];

      if (!leg.isReturnLoop && !leg.isConnector) {
        // Scan waterway in 4u steps to detect all declared `isWaterfall` waypoint bands
        let inBand = false;
        let bandStartLocal = 0;
        let bandMaxDrop = 0;

        for (let ls = 0; ls <= leg.lengthU; ls += 4.0) {
          const ws = earthWorld.sampleWaterway(leg.waterwayId, ls);
          if (ws.isWaterfall && !inBand) {
            inBand = true;
            bandStartLocal = ls;
            bandMaxDrop = ws.waterfallDrop;
          } else if (ws.isWaterfall && inBand) {
            bandMaxDrop = Math.max(bandMaxDrop, ws.waterfallDrop);
          } else if (!ws.isWaterfall && inBand) {
            inBand = false;
            const wfStart = leg.startS + Math.max(24, bandStartLocal);
            const lengthS = clamp(ls - bandStartLocal, 14.5, 19.5);
            if (wfStart + lengthS < leg.endS - 36) {
              this.pushWaterfall(wfStart, lengthS, Math.max(9.0, bandMaxDrop));
              addedWfS.push(wfStart);
            }
          }
        }
      }

      // On long connector straits or return loops without explicit waypoint waterfalls,
      // add scenic regional waterfalls respecting `riverProfile.waterfallSpacing`
      if (addedWfS.length === 0 && leg.lengthU >= 220) {
        const midGeo = this.sampleChainLegRaw(leg, leg.lengthU * 0.5);
        const reg = earthWorld.getBlendedRegionAt(midGeo.lat, midGeo.lng);
        const spacing = clamp(reg.riverProfile.waterfallSpacing, 180, 340);
        let cursor = Math.max(70, spacing * 0.55);
        while (cursor < leg.lengthU - 85) {
          const samplePt = this.sampleChainLegRaw(leg, cursor);
          const localReg = earthWorld.getBlendedRegionAt(samplePt.lat, samplePt.lng);
          const lengthS = this.featureRng.range(15.5, 19.0);
          const dropHeight = this.featureRng.range(
            localReg.riverProfile.waterfallDropMin,
            localReg.riverProfile.waterfallDropMax,
          );
          this.pushWaterfall(leg.startS + cursor, lengthS, dropHeight);
          cursor += this.featureRng.range(spacing * 0.9, spacing * 1.25);
        }
      }

      this.scheduledWaterfallsUpToLeg = li;
    }

    // 2. Schedule Submerged Cave Shortcuts driven by regional `caveSpacing` & `caveStyle`,
    //    always keeping physical fork junctions and waterfall lips completely clear!
    while (this.nextCaveS <= horizonS) {
      let startS = this.nextCaveS;
      let lengthS = this.featureRng.range(92, 128);
      let exitsIntoWaterfall = false;
      let linkedWaterfallId: string | undefined;

      // Avoid placing cave entrance inside a waterfall drop or plunge pool
      for (let i = 0; i < this.waterfalls.length; i++) {
        const wf = this.waterfalls[i];
        if (startS >= wf.startS - 28 && startS <= wf.plungePoolEndS + 18) {
          startS = wf.plungePoolEndS + 24;
        }
      }

      // Keep caves strictly inside regional rivers (skip short Jet-Stream connectors so
      // players burst cleanly into the destination continent!) and away from fork junctions!
      let legAtStart = this.findLegAtS(startS);
      if (legAtStart && legAtStart.isConnector) {
        startS = legAtStart.endS + 32;
        legAtStart = this.findLegAtS(startS);
      }

      if (legAtStart && this.routeMode !== 'single_track') {
        const distToJunc = legAtStart.endS - startS;
        if (distToJunc < 95) {
          startS = legAtStart.endS + 34;
        } else if (startS + lengthS > legAtStart.endS - 42) {
          lengthS = Math.max(72, legAtStart.endS - 45 - startS);
        }
      }

      // Bonus spectacle: if a waterfall lies near our planned cave exit, align the cave
      // exit to burst straight out of the waterfall cliff face!
      for (let i = 0; i < this.waterfalls.length; i++) {
        const wf = this.waterfalls[i];
        const distToWf = wf.startS - startS;
        if (distToWf >= 82 && distToWf <= 155) {
          lengthS = distToWf + 3.5;
          exitsIntoWaterfall = true;
          linkedWaterfallId = wf.id;
          break;
        }
        if (startS + lengthS > wf.startS - 22 && startS < wf.startS) {
          lengthS = Math.max(72, wf.startS - 26 - startS);
        }
      }

      const caveLeg = this.findLegAtS(startS + lengthS * 0.5);
      const caveGeo = caveLeg
        ? this.sampleChainLegRaw(
            caveLeg,
            clamp(startS + lengthS * 0.5 - caveLeg.startS, 0, caveLeg.lengthU),
          )
        : { lat: 44.12, lng: -122.18, width: 14, depth: 4 };
      const caveRegion = earthWorld.getBlendedRegionAt(caveGeo.lat, caveGeo.lng);
      const caveProfile = caveRegion.riverProfile;
      const caveVisual = caveRegion.caveStyle;
      const caveStyle = inferLegacyCaveStyle(caveVisual);

      const side: -1 | 1 =
        this.featureRng.next() < 0.72
          ? this.lastCaveSide === 1
            ? -1
            : 1
          : this.lastCaveSide;
      this.lastCaveSide = side;

      const glowColor = hexToCss(caveVisual.glowColor);
      const id = `cave_${++this.caveCounter}`;
      const baseMaxOffset = Math.max(14.4, caveProfile.widthMax * 0.5 + 5.7);

      this.caves.push({
        id,
        startS,
        endS: startS + lengthS,
        side,
        maxOffset: this.featureRng.range(baseMaxOffset, baseMaxOffset + 2.0),
        width: RIVER_CONFIG.caveWidth,
        ceilingHeight: RIVER_CONFIG.caveCeilingHeight,
        depth: clamp(
          lerp(caveProfile.depthMin, caveProfile.depthMax, 0.55),
          3.4,
          5.2,
        ),
        glowColor,
        caveStyle,
        caveVisual,
        exitsIntoWaterfall,
        linkedWaterfallId,
      });

      const caveSpacing = clamp(caveProfile.caveSpacing, 180, 380);
      this.nextCaveS =
        startS + lengthS + this.featureRng.range(caveSpacing * 0.85, caveSpacing * 1.22);
    }
  }

  private pushWaterfall(startS: number, lengthS: number, dropHeight: number): void {
    const id = `wf_${++this.waterfallCounter}`;
    this.waterfalls.push({
      id,
      startS,
      endS: startS + lengthS,
      lengthS,
      dropHeight,
      topY: Number.NaN,
      bottomY: Number.NaN,
      plungePoolEndS: startS + lengthS + 26.0,
    });
  }

  private appendNextNode(): void {
    const idx = this.nextNodeIndex++;
    const sampleS = this.nextSampleS;
    this.nextSampleS += NODE_STEP;

    this.ensureChainUpToS(sampleS + 120);
    const leg = this.findLegAtS(sampleS);
    if (!leg) return;

    const legLocalS = clamp(sampleS - leg.startS, 0, leg.lengthU);
    const raw = this.sampleChainLegRaw(leg, legLocalS);
    const u = latLngToSphere(raw.lat, raw.lng, 1.0);

    const realLen = leg.realLengthU ?? leg.lengthU;
    const isCompressedConnector = leg.isConnector && realLen > leg.lengthU + 1.0;

    let localPos: Vec3;
    const lastNode = this.nodes.length > 0 ? this.nodes[this.nodes.length - 1] : null;
    const prevNode = this.nodes.length > 1 ? this.nodes[this.nodes.length - 2] : null;

    if (isCompressedConnector && lastNode && prevNode) {
      const prevLeg = leg.index > 0 ? this.chain[leg.index - 1] : null;
      if (legLocalS <= 28.0 && prevLeg && !prevLeg.isConnector) {
        // First 28u out of a 2-way fork follow the EXACT physical diverging branch geometry
        // so the Y-fork water split matches `getForkBranchPreview` with 0.000u seam gap!
        const exitGeo = earthWorld.sampleWaterway(leg.waterwayId, legLocalS);
        localPos = this.projectGeoToLegSpace(
          prevLeg,
          exitGeo.lat,
          exitGeo.lng,
          exitGeo.elevation + leg.elevOffset,
        );
        leg.connectorHeading = Math.atan2(
          localPos.x - lastNode.x,
          localPos.z - lastNode.z,
        );
      } else {
        // Smooth 1:1 Jet-Stream rapids glide curving gently into the destination continent
        const baseHeading =
          leg.connectorHeading ??
          Math.atan2(lastNode.x - prevNode.x, lastNode.z - prevNode.z);
        const turnRate =
          Math.sin(legLocalS * 0.055 + leg.index * 1.9) * 0.042;
        const nextHeading = baseHeading + turnRate;
        leg.connectorHeading = nextHeading;
        localPos = {
          x: lastNode.x + Math.sin(nextHeading) * NODE_STEP,
          y: lastNode.baseY - 0.028 * NODE_STEP,
          z: lastNode.z + Math.cos(nextHeading) * NODE_STEP,
        };
      }
    } else {
      // Regional river leg: anchor exact rigid planetary ENU transform flush onto previous leg!
      if (leg.index > 0 && !leg.geoOriginFrame && lastNode && prevNode) {
        const geo0 = earthWorld.sampleWaterway(leg.waterwayId, 0);
        const geo1 = earthWorld.sampleWaterway(leg.waterwayId, 6.0);
        const legFrame = createLocalTangentFrame(
          geo0.lat,
          geo0.lng,
          geo0.elevation + leg.elevOffset,
        );
        const p1 = earthToLocal(
          geo1.lat,
          geo1.lng,
          geo1.elevation + leg.elevOffset,
          legFrame,
        );
        const geoStartYaw = Math.atan2(p1.x, p1.z);
        const prevExitYaw = Math.atan2(
          lastNode.x - prevNode.x,
          lastNode.z - prevNode.z,
        );
        leg.geoOriginFrame = legFrame;
        leg.yawAlignRad = prevExitYaw - geoStartYaw;
        leg.worldAnchorPos = {
          x: lastNode.x,
          y: lastNode.baseY,
          z: lastNode.z,
        };
      }
      localPos = this.projectGeoToLegSpace(leg, raw.lat, raw.lng, raw.elevation);
    }

    const prevS = this.nodes.length > 0 ? this.nodes[this.nodes.length - 1].s : 0;
    this.nodes.push({
      index: idx,
      s: prevS + NODE_STEP,
      x: localPos.x,
      z: localPos.z,
      baseY: localPos.y,
      ux: u.x,
      uy: u.y,
      uz: u.z,
      lat: raw.lat,
      lng: raw.lng,
      rawElev: raw.elevation,
      width: raw.width,
      depth: raw.depth,
      rapids: raw.rapids,
      waterwayId: leg.waterwayId,
      legIndex: leg.index,
      legLocalS,
      speedBoost: raw.speedBoost,
      segLutS: new Float32Array(SEG_SUBDIVS + 1),
      segLength: NODE_STEP,
    });
  }

  private recomputeArcLengthsFrom(startIdx: number): void {
    const from = Math.max(0, startIdx);
    const lastSegmentIdx = this.nodes.length - 2;
    if (lastSegmentIdx < from) return;

    for (let i = from; i <= lastSegmentIdx; i++) {
      const n0 = this.nodes[Math.max(0, i - 1)];
      const n1 = this.nodes[i];
      const n2 = this.nodes[i + 1];
      const n3 = this.nodes[Math.min(this.nodes.length - 1, i + 2)];

      let accum = 0;
      let prevX = n1.x;
      let prevZ = n1.z;
      n1.segLutS[0] = 0;

      for (let k = 1; k <= SEG_SUBDIVS; k++) {
        const t = k / SEG_SUBDIVS;
        const cx = catmullRom(n0.x, n1.x, n2.x, n3.x, t);
        const cz = catmullRom(n0.z, n1.z, n2.z, n3.z, t);
        accum += Math.hypot(cx - prevX, cz - prevZ);
        n1.segLutS[k] = accum;
        prevX = cx;
        prevZ = cz;
      }

      n1.segLength = Math.max(0.01, accum);
      if (n1.index >= 0) {
        n2.s = n1.s + n1.segLength;
      }
    }
  }

  private recomputeArcLengthsAnchored(anchorIdx: number, anchorS: number): void {
    const count = this.nodes.length;
    if (count < 2) return;
    const clampedAnchor = clamp(anchorIdx, 0, count - 1);

    for (let i = 0; i <= count - 2; i++) {
      const n0 = this.nodes[Math.max(0, i - 1)];
      const n1 = this.nodes[i];
      const n2 = this.nodes[i + 1];
      const n3 = this.nodes[Math.min(count - 1, i + 2)];

      let accum = 0;
      let prevX = n1.x;
      let prevZ = n1.z;
      n1.segLutS[0] = 0;

      for (let k = 1; k <= SEG_SUBDIVS; k++) {
        const t = k / SEG_SUBDIVS;
        const cx = catmullRom(n0.x, n1.x, n2.x, n3.x, t);
        const cz = catmullRom(n0.z, n1.z, n2.z, n3.z, t);
        accum += Math.hypot(cx - prevX, cz - prevZ);
        n1.segLutS[k] = accum;
        prevX = cx;
        prevZ = cz;
      }
      n1.segLength = Math.max(0.01, accum);
    }

    // Lock `nodes[clampedAnchor].s` to `anchorS` and integrate outward so duck.s stays exact!
    this.nodes[clampedAnchor].s = anchorS;
    for (let i = clampedAnchor + 1; i < count; i++) {
      this.nodes[i].s = this.nodes[i - 1].s + this.nodes[i - 1].segLength;
    }
    for (let i = clampedAnchor - 1; i >= 0; i--) {
      this.nodes[i].s = this.nodes[i + 1].s - this.nodes[i].segLength;
    }
  }

  private computeWaterfallDropSumAt(s: number): number {
    let dropSum = this.prunedWaterfallDropSum;
    for (let i = 0; i < this.waterfalls.length; i++) {
      const wf = this.waterfalls[i];
      if (s >= wf.endS) {
        dropSum += wf.dropHeight;
      } else if (s >= wf.startS) {
        const phase = clamp((s - wf.startS) / wf.lengthS, 0, 1);
        dropSum += wf.dropHeight * smootherstep01(phase);
      }
    }
    return dropSum;
  }

  private syncWaterfallElevations(): void {
    const maxS = this.getMaxGeneratedS();
    for (let i = 0; i < this.waterfalls.length; i++) {
      const wf = this.waterfalls[i];
      if (Number.isNaN(wf.topY) && wf.startS < maxS - NODE_STEP * 2) {
        const { idx, t } = this.locateSegment(wf.startS);
        const n1 = this.nodes[idx];
        const n2 = this.nodes[Math.min(this.nodes.length - 1, idx + 1)];
        let dropBefore = this.prunedWaterfallDropSum;
        for (let j = 0; j < i; j++) {
          dropBefore += this.waterfalls[j].dropHeight;
        }
        wf.topY = lerp(n1.baseY, n2.baseY, t) - (dropBefore - this.dropBaselineOffset);
        wf.bottomY = wf.topY - wf.dropHeight;
      }
    }
  }

  private pruneBehind(pruneBeforeS: number): void {
    let removeCount = 0;
    while (
      this.nodes.length - removeCount > 12 &&
      this.nodes[removeCount + 2].s < pruneBeforeS
    ) {
      removeCount++;
    }
    if (removeCount > 0) {
      this.nodes.splice(0, removeCount);
    }

    while (
      this.waterfalls.length > 0 &&
      this.waterfalls[0].plungePoolEndS < pruneBeforeS
    ) {
      const removed = this.waterfalls.shift()!;
      this.prunedWaterfallDropSum += removed.dropHeight;
    }

    while (this.caves.length > 0 && this.caves[0].endS < pruneBeforeS) {
      this.caves.shift();
    }
  }

  private locateSegment(s: number): { idx: number; t: number } {
    const count = this.nodes.length;
    if (count < 2) return { idx: 0, t: 0 };

    let lo = 0;
    let hi = count - 2;
    if (s <= this.nodes[0].s) return { idx: 0, t: 0 };
    if (s >= this.nodes[count - 2].s) {
      const lastIdx = count - 2;
      const frac = clamp(
        (s - this.nodes[lastIdx].s) / Math.max(0.01, this.nodes[lastIdx].segLength),
        0,
        1,
      );
      return { idx: lastIdx, t: frac };
    }

    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.nodes[mid].s <= s) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    const node = this.nodes[lo];
    const localS = clamp(s - node.s, 0, node.segLength);
    const lut = node.segLutS;

    let subLo = 0;
    let subHi = SEG_SUBDIVS;
    while (subLo + 1 < subHi) {
      const mid = (subLo + subHi) >> 1;
      if (lut[mid] <= localS) {
        subLo = mid;
      } else {
        subHi = mid;
      }
    }

    const sA = lut[subLo];
    const sB = lut[subLo + 1];
    const subFrac = sB > sA ? (localS - sA) / (sB - sA) : 0;
    const t = clamp((subLo + subFrac) / SEG_SUBDIVS, 0, 1);

    return { idx: lo, t };
  }

  private sampleHorizontalPosition(s: number): { x: number; z: number } {
    const safeS = Math.max(0, s);
    this.ensureAhead(safeS + 30);
    const { idx, t } = this.locateSegment(safeS);
    const n0 = this.nodes[Math.max(0, idx - 1)];
    const n1 = this.nodes[idx];
    const n2 = this.nodes[Math.min(this.nodes.length - 1, idx + 1)];
    const n3 = this.nodes[Math.min(this.nodes.length - 1, idx + 2)];
    return {
      x: catmullRom(n0.x, n1.x, n2.x, n3.x, t),
      z: catmullRom(n0.z, n1.z, n2.z, n3.z, t),
    };
  }

  private getApproxWidthAt(s: number): number {
    const { idx, t } = this.locateSegment(Math.max(0, s));
    const n1 = this.nodes[idx];
    const n2 = this.nodes[Math.min(this.nodes.length - 1, idx + 1)];
    return lerp(n1.width, n2.width, t);
  }

  private refineClosestS(worldPos: Vec3, minS: number, maxS: number): number {
    let a = Math.max(0, minS);
    let b = Math.max(a + 0.001, maxS);
    const invPhi = 0.6180339887498949;

    let c = b - (b - a) * invPhi;
    let d = a + (b - a) * invPhi;

    const evalDistSq = (sVal: number): number => {
      const p = this.sampleHorizontalPosition(sVal);
      const dx = worldPos.x - p.x;
      const dz = worldPos.z - p.z;
      return dx * dx + dz * dz;
    };

    let fc = evalDistSq(c);
    let fd = evalDistSq(d);

    for (let iter = 0; iter < 10; iter++) {
      if (fc < fd) {
        b = d;
        d = c;
        fd = fc;
        c = b - (b - a) * invPhi;
        fc = evalDistSq(c);
      } else {
        a = c;
        c = d;
        fc = fd;
        d = a + (b - a) * invPhi;
        fd = evalDistSq(d);
      }
    }

    return 0.5 * (a + b);
  }
}
