import type { AssetId, AssetSpec, RouteMode } from '../types';

export type WeatherParticleShape =
  | 'pollen'
  | 'petal'
  | 'rain'
  | 'dust'
  | 'snow'
  | 'ember'
  | 'mist';

export type AudioTimbre =
  | 'marimba'
  | 'koto'
  | 'bell'
  | 'crystal'
  | 'warm'
  | 'deep';

export type TimeOfDay =
  | 'morning'
  | 'golden'
  | 'monsoon'
  | 'sunset'
  | 'aurora_night'
  | 'volcanic_dusk';

export type LandmarkPlacement =
  | 'over_river'
  | 'bank_left'
  | 'bank_right'
  | 'cliff_overlook';

export type EarthJunctionKind =
  | 'confluence'
  | 'fork'
  | 'delta'
  | 'strait_gate'
  | 'headwaters';

/**
 * 100% data-driven physical terrain & riverbank shader parameters.
 * Any contributor pack can compose arbitrary geological styles with ZERO shader switches!
 */
export interface GroundShaderParams {
  /** Primary upper bank / cliff face 24-bit RGB hex color. */
  primaryColor: number;
  /** Secondary strata / soil / ice-band 24-bit RGB hex color. */
  secondaryColor: number;
  /** Wet shoreline band 24-bit RGB hex color right above waterline. */
  shoreColor: number;
  /** Shallow riverbed shoal 24-bit RGB hex color. */
  bedShallowColor: number;
  /** Deep riverbed channel 24-bit RGB hex color. */
  bedDeepColor: number;
  /** Instanced bank rock / cliff boulder tint 24-bit RGB hex color. */
  rockTint: number;
  /** Moss, lichen, snow-cap, or mineral tint 24-bit RGB hex color. */
  mossTint: number;
  /** Sedimentary or basalt horizontal strata banding strength in [0, 1]. */
  strataIntensity: number;
  /** Spatial frequency of cliff strata bands (world units^-1, e.g. 0.3..1.4). */
  strataScale: number;
  /** Snow & frost surface blanketing coverage in [0, 1]. */
  snowCoverage: number;
  /** Glacial ice specular / clearcoat reflectivity in [0, 1]. */
  iceReflectivity: number;
  /** Organic moss & lush bank grass coverage in [0, 1]. */
  mossCoverage: number;
  /** Fallen blossom petal / leaf fleck scatter intensity in [0, 1]. */
  petalFlecks: number;
  /** Optional glowing fissure / bioluminescent vein 24-bit RGB hex color. */
  emissiveColor: number;
  /** Emissive fissure / glow strength in [0, 2]. */
  emissiveIntensity: number;
  /** Base surface roughness in [0.1, 1.0]. */
  roughness: number;
  /** Riverbed pebble & gravel detail scale multiplier (0.5..2.0). */
  pebbleScale: number;
}

/**
 * 100% data-driven submerged cave / grotto interior visual parameters.
 */
export interface CaveVisualParams {
  /** Vaulted cave wall 24-bit RGB hex color. */
  wallColor: number;
  /** Submerged cave floor 24-bit RGB hex color. */
  floorColor: number;
  /** Bioluminescent vein / magma / ice refraction glow 24-bit RGB hex color. */
  glowColor: number;
  /** Cave ambient & vein glow intensity (0..2). */
  glowIntensity: number;
  /** Skylight shaft light beam 24-bit RGB hex color. */
  skylightColor: number;
  /** Cave stone / ice wall roughness in [0.1, 1.0]. */
  roughness: number;
  /** Optional 3D crystal / mineral cluster asset spawned along cave walls. */
  crystalAssetId?: AssetId;
}

/**
 * 100% data-driven regional weather & atmospheric particle parameters.
 */
export interface WeatherParams {
  /** Open string weather preset identifier (e.g. `'cherry_blossoms'`, `'sahara_simoom'`). */
  id: string;
  /** Human-readable HUD display label (e.g. `'Sakura Blossom Drift'`). */
  label: string;
  /** Optional HUD/globe icon string (e.g. `'🌸'`, `'❄️'`). */
  icon?: string;
  /** Particle sprite shape rendered by `ParticleSystem`. */
  particleShape: WeatherParticleShape;
  /** Overall weather particle spawn intensity in [0, 1]. */
  intensity: number;
  /** Lateral & downstream wind strength (0..2). */
  windStrength: number;
  /** Low river-surface mist & waterfall spray density multiplier (0..2). */
  mistDensity: number;
  /** Primary weather particle 24-bit RGB hex color. */
  particleColor: number;
  /** Secondary two-tone weather particle 24-bit RGB hex color. */
  secondaryParticleColor: number;
  /** Surface raindrop ring ripple intensity on water shader in [0, 1]. */
  rainRipples: number;
  /** Probability/rate weight in [0, 1] for periodic storm lightning flashes. */
  lightningChance: number;
  /** Rising geothermal / waterfall mist steam density in [0, 1]. */
  steamDensity: number;
  /** Vertical particle acceleration/velocity bias (>0 falls downward, <0 rises like embers). */
  gravity: number;
  /** Horizontal swirling drift speed multiplier (0..3). */
  driftSpeed: number;
}

/**
 * 100% data-driven procedural WebAudio soundscape & musical chime scale parameters.
 */
export interface AudioScaleParams {
  /** Musical scale offsets in semitones above `baseMidi` (e.g. `[0, 2, 4, 7, 9, 12]`). */
  scaleIntervals: number[];
  /** Root MIDI note number (e.g. `72` = C5, `60` = C4). */
  baseMidi: number;
  /** Procedural WebAudio synthesizer timbre for chimes & fanfare. */
  timbre: AudioTimbre;
  /** Center/cutoff frequency (Hz) for continuous river water flow filter. */
  riverFilterHz: number;
  /** Relative gain multiplier for churning whitewater rapids (0.5..1.8). */
  rapidsGain: number;
  /** Continuous rainfall ambience layer intensity in [0, 1]. */
  rainIntensity: number;
  /** True to synthesize distant thunder rumbles on lightning flashes. */
  thunderEnabled: boolean;
  /** Continuous wind howl / breeze layer intensity in [0, 1]. */
  windIntensity: number;
  /** Wind bandpass resonator pitch multiplier (0.5..1.5). */
  windPitch: number;
  /** Deep volcanic / glacial subterranean rumble layer in [0, 1]. */
  geothermalRumble: number;
  /** Human-readable ambient soundscape tag. */
  ambientTag: string;
}

export interface EarthRiverProfile {
  widthMin: number;
  widthMax: number;
  depthMin: number;
  depthMax: number;
  curveAmplitude: number;
  curveFrequency: number;
  rapidsBase: number;
  slopeBase: number;
  waterfallSpacing: number;
  waterfallDropMin: number;
  waterfallDropMax: number;
  caveSpacing: number;
  bankSteepness: number;
  bankHeightScale: number;
  /** 0 = lush sloped banks, 1 = dramatic vertical terraced cliffs/gorges. */
  canyonWallFactor: number;
}

export interface EarthWaterStyle {
  shallowColor: number;
  deepColor: number;
  foamColor: number;
  causticColor: number;
  causticIntensity: number;
  clarity: number;
  reflectivity: number;
  flowSpeedMult: number;
  underwaterFogColor: number;
  underwaterFogNear: number;
  underwaterFogFar: number;
  rainRippleIntensity: number;
  geothermalGlow: number;
}

export interface EarthAtmosphere {
  timeOfDay: TimeOfDay;
  skyZenith: number;
  skyHorizon: number;
  skyGround: number;
  sunColor: number;
  sunIntensity: number;
  sunDirection: [number, number, number];
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  iblTop: number;
  iblHorizon: number;
  iblBottom: number;
  hasAurora: boolean;
  auroraColors?: [number, number];
  hasLightning: boolean;
  hasVolcanicGlow: boolean;
  exposure: number;
}

export interface EarthSceneryWeightedAsset {
  assetId: AssetId;
  weight: number;
  scaleMin: number;
  scaleMax: number;
  yEmbed: number;
}

export interface EarthLandmarkRule {
  assetId: AssetId;
  placement: LandmarkPlacement;
  spacing: number;
  scale: number;
  yOffset: number;
}

export interface EarthScenery {
  bankTrees: EarthSceneryWeightedAsset[];
  bankFoliage: EarthSceneryWeightedAsset[];
  bankRocks: EarthSceneryWeightedAsset[];
  landmarks: EarthLandmarkRule[];
  treeDensity: number;
  foliageDensity: number;
  rockDensity: number;
  innerTreeClearance: number;
}

export interface EarthObstacles {
  /** Mid-river slalom hazards (boulders, spires, sunken canoes, snag stumps, barrels). */
  boulderAssets: AssetId[];
  /** Overhead dive-under hazards (Torii gates, stone footbridges, willow overhangs, arches). */
  diveArchAssets: AssetId[];
  /** Low surface jump-over hazards (beaver dams, driftwood, lily pads, stepping stones). */
  jumpLogAssets: AssetId[];
  obstacleDensity: number;
  chuteBias: number;
}

export interface EarthWildlife {
  underwaterAsset: AssetId;
  bankCritterAsset?: AssetId;
  hasDragonflies: boolean;
  hasFrogs: boolean;
  hasFireflies: boolean;
  wildlifeTint?: number;
}

/**
 * Physical planetary junction node where 2+ waterways share the exact same
 * `(lat, lng, elevation)` coordinate on Mini-Earth!
 */
export interface EarthJunction {
  id: string;
  name: string;
  lat: number;
  lng: number;
  elevation: number;
  kind: EarthJunctionKind;
  /** Optional home region zone ID for UI labeling. */
  regionId?: string;
}

export interface EarthWaterwayWaypoint {
  lat: number;
  lng: number;
  /** Optional explicit elevation override (linearly/smoothly interpolated if omitted). */
  elevation?: number;
  /** Optional local channel width override (world units). */
  width?: number;
  /** Optional local channel depth override (world units). */
  depth?: number;
  /** Optional local rapids intensity override [0, 1]. */
  rapids?: number;
  /** True to place a dramatic terraced waterfall plunge at this waypoint. */
  isWaterfall?: boolean;
  /** Vertical drop height of the waterfall in world units. */
  waterfallDrop?: number;
}

/**
 * A real physical river, canyon gorge, fjord, or ocean strait channel living at
 * exact `(lat, lng, elevation)` coordinates on the shared Mini-Earth globe.
 * Its first point is `fromJunctionId` and its last point is `toJunctionId`!
 */
export interface EarthWaterway {
  id: string;
  name: string;
  /** Primary regional zone ID owning/hosting this waterway. */
  regionId: string;
  fromJunctionId: string;
  toJunctionId: string;
  waypoints: EarthWaterwayWaypoint[];
  difficulty: 1 | 2 | 3;
  subtitle: string;
  tags?: string[];
  /** True for intercontinental ocean current / jet-stream connecting straits. */
  isConnector?: boolean;
  /** Optional hydrodynamic current speed multiplier (e.g. 1.65 for ocean jet-streams). */
  speedBoost?: number;
  /** True if this is a region's primary hero showcase waterway (default start for this region). */
  isPrimaryForRegion?: boolean;
}

/**
 * A persistent world-space landmark anchored at real `(lat, lng)` coordinates on
 * Mini-Earth so ANY nearby waterway passing near it sees the exact same landmark!
 */
export interface EarthLandmark {
  id: string;
  assetId: AssetId;
  lat: number;
  lng: number;
  elevationOffset?: number;
  scale: number;
  rotY?: number;
  placement?: 'ground' | 'over_waterway' | 'cliff';
  waterwayId?: string;
}

/**
 * A spatial geographic biome zone on Mini-Earth! Any `(lat, lng)` on the planet
 * smoothly blends the top-2 overlapping/nearest `EarthRegionZone`s.
 */
export interface EarthRegionZone {
  id: string;
  name: string;
  region: string;
  country: string;
  subtitle: string;
  /** Optional icon/emoji shown on the Mini-Earth Globe & HUD badge. */
  icon?: string;
  accentColor: string;
  globeColor: string;
  difficulty: 1 | 2 | 3;
  /** Geographic center latitude in degrees (-90..+90). */
  centerLat: number;
  /** Geographic center longitude in degrees (-180..+180). */
  centerLng: number;
  /** Core full-strength influence radius in degrees. */
  radiusDeg: number;
  /** Outer smooth biome transition falloff band in degrees. */
  falloffDeg: number;
  /** Tie-breaker priority when two zones overlap equally (higher wins). */
  priority?: number;
  riverProfile: EarthRiverProfile;
  waterStyle: EarthWaterStyle;
  atmosphere: EarthAtmosphere;
  weather: WeatherParams;
  groundStyle: GroundShaderParams;
  caveStyle: CaveVisualParams;
  scenery: EarthScenery;
  obstacles: EarthObstacles;
  wildlife: EarthWildlife;
  audioProfile: AudioScaleParams;
}

/**
 * ONE self-contained contributor drop-in pack inside `src/world/packs/<pack-id>/index.ts`.
 * Auto-discovered via `import.meta.glob('../world/packs/**\/index.ts', { eager: true })`
 * with ZERO edits to any core file!
 */
export interface EarthRegionPack {
  id: string;
  version: string;
  author?: string;
  /** Optional custom 3D `.glb` asset specs self-registered into `assetLoader`. */
  assets?: Record<string, AssetSpec>;
  /** Optional custom `assets.json` manifest URLs merged into `assetLoader`. */
  manifestUrls?: string[];
  zones: EarthRegionZone[];
  junctions: EarthJunction[];
  waterways: EarthWaterway[];
  landmarks?: EarthLandmark[];
}

/**
 * Result of sampling a physical `EarthWaterway` at arc-length `s` (in Duck Scale world units).
 */
export interface EarthWaterwaySample {
  waterwayId: string;
  /** Downstream arc-length along this waterway (`0..totalLengthU`). */
  s: number;
  /** Total physical arc-length of this waterway on Mini-Earth (world units). */
  totalLengthU: number;
  /** Normalized progress `s / totalLengthU` in [0, 1]. */
  progress: number;
  /** Exact planetary latitude in degrees. */
  lat: number;
  /** Exact planetary longitude in degrees. */
  lng: number;
  /** Exact elevation above sea level in world units. */
  elevation: number;
  /** Compass forward bearing in degrees `[0, 360)` (`0° = North`, `90° = East`). */
  bearingDeg: number;
  /** Vertical grade `delev / ds`. */
  slope: number;
  /** Signed horizontal curvature in radians per world unit (+ right, - left). */
  curvature: number;
  /** Local navigable river width (world units). */
  width: number;
  /** Local centerline water depth (world units). */
  depth: number;
  /** Local baseline rapids intensity in [0, 1]. */
  rapids: number;
  /** True inside a sculpted waterfall drop along this waterway. */
  isWaterfall: boolean;
  /** Waterfall drop height in world units (0 outside waterfall). */
  waterfallDrop: number;
  /** Normalized waterfall drop progress [0, 1]. */
  waterfallPhase: number;
  /** Local waterway speed multiplier (e.g. 1.65 on jet-stream ocean straits). */
  speedBoost: number;
}

/**
 * Spatial query result describing the top-2 blended `EarthRegionZone`s at any `(lat, lng)`.
 */
export interface BlendedEarthRegion {
  primaryZone: EarthRegionZone;
  secondaryZone: EarthRegionZone;
  /** Smooth 0..1 weight toward `secondaryZone` (0 = 100% primaryZone). */
  blend: number;
  riverProfile: EarthRiverProfile;
  waterStyle: EarthWaterStyle;
  atmosphere: EarthAtmosphere;
  weather: WeatherParams;
  groundStyle: GroundShaderParams;
  caveStyle: CaveVisualParams;
  audioProfile: AudioScaleParams;
}

export interface UpcomingForkBranch {
  waterwayId: string;
  waterwayName: string;
  targetRegionId: string;
  targetRegionName: string;
  targetCountry: string;
  relativeBearingDeg: number;
}

/**
 * Physical 2-way (or N-way) river confluence/fork approaching ahead of the duck.
 */
export interface UpcomingForkInfo {
  junction: EarthJunction;
  distanceU: number;
  leftBranch: UpcomingForkBranch;
  rightBranch: UpcomingForkBranch;
  defaultBranch: UpcomingForkBranch;
  allBranches: UpcomingForkBranch[];
}

export type EarthPlayMode = RouteMode;

// ---------------------------------------------------------------------------
// Fast Allocation-Free Color & Open Data-Driven Parameter Blending Helpers
// ---------------------------------------------------------------------------

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpHexColor(colorA: number, colorB: number, t: number): number {
  const u = clamp01(t);
  const rA = (colorA >> 16) & 0xff;
  const gA = (colorA >> 8) & 0xff;
  const bA = colorA & 0xff;

  const rB = (colorB >> 16) & 0xff;
  const gB = (colorB >> 8) & 0xff;
  const bB = colorB & 0xff;

  const r = Math.round(rA + (rB - rA) * u) & 0xff;
  const g = Math.round(gA + (gB - gA) * u) & 0xff;
  const b = Math.round(bA + (bB - bA) * u) & 0xff;

  return (r << 16) | (g << 8) | b;
}

export function hexToCss(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function blendEarthRiverProfiles(
  a: EarthRiverProfile,
  b: EarthRiverProfile,
  t: number,
): EarthRiverProfile {
  const u = clamp01(t);
  if (u <= 0) return a;
  if (u >= 1) return b;
  return {
    widthMin: lerpNum(a.widthMin, b.widthMin, u),
    widthMax: lerpNum(a.widthMax, b.widthMax, u),
    depthMin: lerpNum(a.depthMin, b.depthMin, u),
    depthMax: lerpNum(a.depthMax, b.depthMax, u),
    curveAmplitude: lerpNum(a.curveAmplitude, b.curveAmplitude, u),
    curveFrequency: lerpNum(a.curveFrequency, b.curveFrequency, u),
    rapidsBase: lerpNum(a.rapidsBase, b.rapidsBase, u),
    slopeBase: lerpNum(a.slopeBase, b.slopeBase, u),
    waterfallSpacing: lerpNum(a.waterfallSpacing, b.waterfallSpacing, u),
    waterfallDropMin: lerpNum(a.waterfallDropMin, b.waterfallDropMin, u),
    waterfallDropMax: lerpNum(a.waterfallDropMax, b.waterfallDropMax, u),
    caveSpacing: lerpNum(a.caveSpacing, b.caveSpacing, u),
    bankSteepness: lerpNum(a.bankSteepness, b.bankSteepness, u),
    bankHeightScale: lerpNum(a.bankHeightScale, b.bankHeightScale, u),
    canyonWallFactor: lerpNum(a.canyonWallFactor, b.canyonWallFactor, u),
  };
}

export function blendEarthWaterStyles(
  a: EarthWaterStyle,
  b: EarthWaterStyle,
  t: number,
): EarthWaterStyle {
  const u = clamp01(t);
  if (u <= 0) return a;
  if (u >= 1) return b;
  return {
    shallowColor: lerpHexColor(a.shallowColor, b.shallowColor, u),
    deepColor: lerpHexColor(a.deepColor, b.deepColor, u),
    foamColor: lerpHexColor(a.foamColor, b.foamColor, u),
    causticColor: lerpHexColor(a.causticColor, b.causticColor, u),
    causticIntensity: lerpNum(a.causticIntensity, b.causticIntensity, u),
    clarity: lerpNum(a.clarity, b.clarity, u),
    reflectivity: lerpNum(a.reflectivity, b.reflectivity, u),
    flowSpeedMult: lerpNum(a.flowSpeedMult, b.flowSpeedMult, u),
    underwaterFogColor: lerpHexColor(a.underwaterFogColor, b.underwaterFogColor, u),
    underwaterFogNear: lerpNum(a.underwaterFogNear, b.underwaterFogNear, u),
    underwaterFogFar: lerpNum(a.underwaterFogFar, b.underwaterFogFar, u),
    rainRippleIntensity: lerpNum(a.rainRippleIntensity, b.rainRippleIntensity, u),
    geothermalGlow: lerpNum(a.geothermalGlow, b.geothermalGlow, u),
  };
}

export function blendEarthAtmospheres(
  a: EarthAtmosphere,
  b: EarthAtmosphere,
  t: number,
): EarthAtmosphere {
  const u = clamp01(t);
  if (u <= 0) return a;
  if (u >= 1) return b;

  const sx = lerpNum(a.sunDirection[0], b.sunDirection[0], u);
  const sy = lerpNum(a.sunDirection[1], b.sunDirection[1], u);
  const sz = lerpNum(a.sunDirection[2], b.sunDirection[2], u);
  const sLen = Math.hypot(sx, sy, sz) || 1;

  const auroraA = a.auroraColors ?? [0x2af598, 0x9b5de5];
  const auroraB = b.auroraColors ?? auroraA;

  return {
    timeOfDay: u < 0.5 ? a.timeOfDay : b.timeOfDay,
    skyZenith: lerpHexColor(a.skyZenith, b.skyZenith, u),
    skyHorizon: lerpHexColor(a.skyHorizon, b.skyHorizon, u),
    skyGround: lerpHexColor(a.skyGround, b.skyGround, u),
    sunColor: lerpHexColor(a.sunColor, b.sunColor, u),
    sunIntensity: lerpNum(a.sunIntensity, b.sunIntensity, u),
    sunDirection: [sx / sLen, sy / sLen, sz / sLen],
    hemiSky: lerpHexColor(a.hemiSky, b.hemiSky, u),
    hemiGround: lerpHexColor(a.hemiGround, b.hemiGround, u),
    hemiIntensity: lerpNum(a.hemiIntensity, b.hemiIntensity, u),
    fogColor: lerpHexColor(a.fogColor, b.fogColor, u),
    fogNear: lerpNum(a.fogNear, b.fogNear, u),
    fogFar: lerpNum(a.fogFar, b.fogFar, u),
    iblTop: lerpHexColor(a.iblTop, b.iblTop, u),
    iblHorizon: lerpHexColor(a.iblHorizon, b.iblHorizon, u),
    iblBottom: lerpHexColor(a.iblBottom, b.iblBottom, u),
    hasAurora: u < 0.5 ? a.hasAurora : b.hasAurora,
    auroraColors: [
      lerpHexColor(auroraA[0], auroraB[0], u),
      lerpHexColor(auroraA[1], auroraB[1], u),
    ],
    hasLightning: u < 0.5 ? a.hasLightning : b.hasLightning,
    hasVolcanicGlow: u < 0.5 ? a.hasVolcanicGlow : b.hasVolcanicGlow,
    exposure: lerpNum(a.exposure, b.exposure, u),
  };
}

export function blendGroundShaderParams(
  a: GroundShaderParams,
  b: GroundShaderParams,
  t: number,
): GroundShaderParams {
  const u = clamp01(t);
  if (u <= 0) return a;
  if (u >= 1) return b;
  return {
    primaryColor: lerpHexColor(a.primaryColor, b.primaryColor, u),
    secondaryColor: lerpHexColor(a.secondaryColor, b.secondaryColor, u),
    shoreColor: lerpHexColor(a.shoreColor, b.shoreColor, u),
    bedShallowColor: lerpHexColor(a.bedShallowColor, b.bedShallowColor, u),
    bedDeepColor: lerpHexColor(a.bedDeepColor, b.bedDeepColor, u),
    rockTint: lerpHexColor(a.rockTint, b.rockTint, u),
    mossTint: lerpHexColor(a.mossTint, b.mossTint, u),
    strataIntensity: lerpNum(a.strataIntensity, b.strataIntensity, u),
    strataScale: lerpNum(a.strataScale, b.strataScale, u),
    snowCoverage: lerpNum(a.snowCoverage, b.snowCoverage, u),
    iceReflectivity: lerpNum(a.iceReflectivity, b.iceReflectivity, u),
    mossCoverage: lerpNum(a.mossCoverage, b.mossCoverage, u),
    petalFlecks: lerpNum(a.petalFlecks, b.petalFlecks, u),
    emissiveColor: lerpHexColor(a.emissiveColor, b.emissiveColor, u),
    emissiveIntensity: lerpNum(a.emissiveIntensity, b.emissiveIntensity, u),
    roughness: lerpNum(a.roughness, b.roughness, u),
    pebbleScale: lerpNum(a.pebbleScale, b.pebbleScale, u),
  };
}

export function blendCaveVisualParams(
  a: CaveVisualParams,
  b: CaveVisualParams,
  t: number,
): CaveVisualParams {
  const u = clamp01(t);
  if (u <= 0) return a;
  if (u >= 1) return b;
  return {
    wallColor: lerpHexColor(a.wallColor, b.wallColor, u),
    floorColor: lerpHexColor(a.floorColor, b.floorColor, u),
    glowColor: lerpHexColor(a.glowColor, b.glowColor, u),
    glowIntensity: lerpNum(a.glowIntensity, b.glowIntensity, u),
    skylightColor: lerpHexColor(a.skylightColor, b.skylightColor, u),
    roughness: lerpNum(a.roughness, b.roughness, u),
    crystalAssetId: u < 0.5 ? a.crystalAssetId : b.crystalAssetId,
  };
}

export function blendWeatherParams(
  a: WeatherParams,
  b: WeatherParams,
  t: number,
): WeatherParams {
  const u = clamp01(t);
  if (u <= 0) return a;
  if (u >= 1) return b;
  return {
    id: u < 0.5 ? a.id : b.id,
    label: u < 0.5 ? a.label : b.label,
    icon: u < 0.5 ? a.icon : b.icon,
    particleShape: u < 0.5 ? a.particleShape : b.particleShape,
    intensity: lerpNum(a.intensity, b.intensity, u),
    windStrength: lerpNum(a.windStrength, b.windStrength, u),
    mistDensity: lerpNum(a.mistDensity, b.mistDensity, u),
    particleColor: lerpHexColor(a.particleColor, b.particleColor, u),
    secondaryParticleColor: lerpHexColor(
      a.secondaryParticleColor,
      b.secondaryParticleColor,
      u,
    ),
    rainRipples: lerpNum(a.rainRipples, b.rainRipples, u),
    lightningChance: lerpNum(a.lightningChance, b.lightningChance, u),
    steamDensity: lerpNum(a.steamDensity, b.steamDensity, u),
    gravity: lerpNum(a.gravity, b.gravity, u),
    driftSpeed: lerpNum(a.driftSpeed, b.driftSpeed, u),
  };
}

export function blendAudioScaleParams(
  a: AudioScaleParams,
  b: AudioScaleParams,
  t: number,
): AudioScaleParams {
  const u = clamp01(t);
  if (u <= 0) return a;
  if (u >= 1) return b;
  return {
    scaleIntervals: u < 0.5 ? a.scaleIntervals : b.scaleIntervals,
    baseMidi: u < 0.5 ? a.baseMidi : b.baseMidi,
    timbre: u < 0.5 ? a.timbre : b.timbre,
    riverFilterHz: lerpNum(a.riverFilterHz, b.riverFilterHz, u),
    rapidsGain: lerpNum(a.rapidsGain, b.rapidsGain, u),
    rainIntensity: lerpNum(a.rainIntensity, b.rainIntensity, u),
    thunderEnabled: u < 0.5 ? a.thunderEnabled : b.thunderEnabled,
    windIntensity: lerpNum(a.windIntensity, b.windIntensity, u),
    windPitch: lerpNum(a.windPitch, b.windPitch, u),
    geothermalRumble: lerpNum(a.geothermalRumble, b.geothermalRumble, u),
    ambientTag: u < 0.5 ? a.ambientTag : b.ambientTag,
  };
}

export function blendEarthRegionZones(
  primaryZone: EarthRegionZone,
  secondaryZone: EarthRegionZone,
  blend: number,
): BlendedEarthRegion {
  const u = clamp01(blend);
  if (u <= 0 || primaryZone.id === secondaryZone.id) {
    return {
      primaryZone,
      secondaryZone: primaryZone,
      blend: 0,
      riverProfile: primaryZone.riverProfile,
      waterStyle: primaryZone.waterStyle,
      atmosphere: primaryZone.atmosphere,
      weather: primaryZone.weather,
      groundStyle: primaryZone.groundStyle,
      caveStyle: primaryZone.caveStyle,
      audioProfile: primaryZone.audioProfile,
    };
  }

  return {
    primaryZone,
    secondaryZone,
    blend: u,
    riverProfile: blendEarthRiverProfiles(
      primaryZone.riverProfile,
      secondaryZone.riverProfile,
      u,
    ),
    waterStyle: blendEarthWaterStyles(
      primaryZone.waterStyle,
      secondaryZone.waterStyle,
      u,
    ),
    atmosphere: blendEarthAtmospheres(
      primaryZone.atmosphere,
      secondaryZone.atmosphere,
      u,
    ),
    weather: blendWeatherParams(primaryZone.weather, secondaryZone.weather, u),
    groundStyle: blendGroundShaderParams(
      primaryZone.groundStyle,
      secondaryZone.groundStyle,
      u,
    ),
    caveStyle: blendCaveVisualParams(
      primaryZone.caveStyle,
      secondaryZone.caveStyle,
      u,
    ),
    audioProfile: blendAudioScaleParams(
      primaryZone.audioProfile,
      secondaryZone.audioProfile,
      u,
    ),
  };
}
