import type { BiomeId, PowerUpType, ResolvedQuality } from './types';

/**
 * ============================================================================
 * RIVER DUCKER — WORLD SCALE & COORDINATE CONVENTION
 * ============================================================================
 *
 * 1.0 WORLD UNIT = 0.10 METERS (10 cm) — "Duck Scale"
 *
 * Why 1 unit = 10 cm?
 * - Our hero rubber bath duck is ~12 cm long => 1.2 world units long (1.0 wide, 1.1 tall).
 * - Everything in nature feels grand & heroic from a tiny duck's low POV while keeping
 *   WebGL2 depth precision, shadow frustums, and physics velocities clean and well-scaled:
 *     * Hero rubber duck:        ~1.2 u long x 1.0 u wide x 1.1 u tall (radius 0.48 u)
 *     * River channel width:     10.0 - 17.0 u (1.0 m - 1.7 m lush forest creek)
 *     * River water depth:       3.0 - 5.5 u (generous underwater diving canyon)
 *     * Mossy boulders:          2.6 - 5.8 u diameter (towering obstacles)
 *     * Fallen log (dive under): clearanceBelow ~1.9 u; duck dives down to y = -1.6..-2.4 u
 *     * Driftwood (jump over):   height ~1.1 u above waterline; duck jumps up to y = +2.8 u
 *     * Waterfall drops:         9.0 - 15.0 u vertical plunge!
 *     * Side caves / grottos:    width 6.2 u, ceiling 4.8 u, length 55 - 85 u
 *     * Riverbank pines:         18.0 - 30.0 u tall
 *     * Riverbank ferns:         2.8 - 4.4 u spread
 *     * River trout:             1.6 - 2.2 u long
 *     * Baby ducklings:          0.68 u long
 *
 * Coordinate Basis:
 * - World space: Right-handed Three.js Y-up.
 * - River space `(s, u, y)`:
 *     * `s`: arc-length downstream (>= 0). Display meters = `s * WORLD_UNIT_METERS`
 *            (or gameplay distance scale `s * DISPLAY_METERS_PER_UNIT` for arcade feel).
 *     * `u`: lateral offset along `right = normalize(cross(tangent, (0,1,0)))`.
 *            `-u` is river-left, `+u` is river-right.
 *     * `y`: vertical offset from local water surface (`0` waterline, `>0` air, `<0` dive).
 * - Model facing: All normalized 3D models face `+Z` forward, `+Y` up.
 */

export const SCALE = {
  /** Physical meters represented by 1.0 world unit (10 cm). */
  WORLD_UNIT_METERS: 0.1,
  /** Arcade distance readout multiplier so 100 u feels like 25m of epic creek adventure. */
  DISPLAY_METERS_PER_UNIT: 0.25,
} as const;

export const DUCK_CONFIG = {
  /** Visual dimensions in world units (1 u = 10 cm). */
  length: 1.25,
  width: 1.0,
  height: 1.1,
  /** Generous player-friendly collision sphere/capsule radius (slightly smaller than mesh). */
  collisionRadius: 0.44,
  /** Resting vertical draft (waterline sits slightly up the belly). */
  floatingOffsetY: 0.02,

  /** Forward downstream speed progression (world units / sec). */
  baseSpeed: 13.5,
  maxSpeed: 29.0,
  /** Distance (in world units `s`) over which speed ramps smoothly from baseSpeed toward maxSpeed. */
  speedRampDistance: 2400,
  /** Speed multiplier while diving underwater (streamlined surge!). */
  diveSpeedMultiplier: 1.12,
  /** Speed multiplier during Wing Gust flight. */
  flySpeedMultiplier: 1.25,
  /** Extra acceleration down steep rapids / waterfalls. */
  slopeGravityFactor: 14.0,

  /** Lateral steering dynamics (snappy yet buoyant). */
  maxLateralSpeed: 13.5,
  lateralAccel: 58.0,
  lateralDamping: 10.5,
  /** Keep duck slightly inside banks so it rides soft bank cushions rather than clipping. */
  bankPadding: 0.85,
  /** Max roll/bank angle (radians) when carving turns. */
  maxBankRoll: 0.48,

  /** Jump & gravity physics (world units). */
  jumpVelocity: 11.4,
  /** Bonus upward pop when breaching out of a deep dive! */
  breachBonusVelocity: 2.6,
  /** Coyote time after leaving water / waterfall lip (seconds). */
  coyoteTime: 0.14,
  /** Input jump buffer window before splashdown (seconds). */
  jumpBufferTime: 0.14,
  gravity: 27.5,
  /** Lighter gravity when holding jump near apex for forgiving arc control. */
  apexHoldGravityFactor: 0.72,
  /** Max upward jump apex is ~2.35 - 2.9 u above waterline (easily clears log_jump). */

  /** Underwater diving & buoyancy physics. */
  diveDownAccel: 26.0,
  maxDiveSpeed: 9.5,
  /** Target cruising depth when holding dive (world units below surface). */
  targetDiveDepth: 1.85,
  /** Clearance above riverbed when diving. */
  riverbedPadding: 0.55,
  /** Upward buoyancy acceleration when dive is released underwater. */
  buoyancyAccel: 24.0,
  maxAscentSpeed: 10.5,
  /** Surface bob spring stiffness & damping. */
  surfaceSpringK: 38.0,
  surfaceSpringDamping: 7.5,

  /** Breath / lung meter. */
  baseMaxBreath: 4.5, // seconds underwater before forced surface / warning
  bubbleLungMaxBreath: 9.5, // seconds while Bubble Lung power-up active
  breathRechargeRate: 2.4, // normalized fill per second on surface
  lowBreathThreshold: 0.28,

  /** Wing Gust flight mode. */
  flightTargetHeight: 3.4, // world units above water surface
  flightHoverStiffness: 18.0,
  flightHoverDamping: 6.5,

  /** Post-shield-break invulnerability (seconds). */
  shieldBreakInvulnerability: 1.35,
} as const;

export const DUCK_ANIM_CONFIG = {
  /** Swimming bob & tail wag rates (rad/s). */
  swimBobFreq: 5.4,
  swimTailWagFreq: 7.2,
  swimPaddleFreq: 8.5,

  /** Diving paddle kick rate & plunge tuck pitch. */
  divePaddleFreq: 19.0,
  diveEnterPitch: -0.68,
  diveCruisePitch: -0.22,
  breachPopPitch: 0.52,

  /** Wing Gust flying flap rate & soar amplitude. */
  flyFlapFreq: 16.5,
  flyFlapAmplitude: 0.82,
  flyBankMultiplier: 0.65,

  /** Spooked / balancing frantic asymmetric flap & wobble. */
  spookFlapFreq: 26.0,
  spookWobbleFreq: 18.0,
  spookMaxWobbleRad: 0.42,
  spookDecayRate: 1.45,
  /** Duration of spook reaction on near-miss / rapids slam / waterfall lip / shield bounce (s). */
  spookDuration: 1.15,

  /** Carving bank multipliers per mode (radians at full turnAmount = +-1). */
  turnBankSurface: 0.44,
  turnBankDive: 0.56,
  turnBankFly: 0.68,
  turnBankAir: 0.38,
  turnYawLead: 0.28,
} as const;

export const RIVER_CONFIG = {
  /** Base channel width & variation (world units). */
  baseWidth: 13.0,
  minWidth: 9.8,
  maxWidth: 17.5,

  /** Base water depth & variation (world units). */
  baseDepth: 3.8,
  minDepth: 2.9,
  maxDepth: 5.4,

  /** Gentle baseline downhill gradient (dy/ds). */
  baseSlope: -0.048,

  /** Look-ahead & look-behind active streaming window around duck `s` (world units). */
  aheadDistance: 190,
  behindDistance: 35,
  /** Spline sample spacing for smooth mesh generation (world units). */
  meshStepS: 2.0,

  /** Waterfalls. */
  waterfallMinSpacing: 260,
  waterfallMaxSpacing: 420,
  waterfallMinDrop: 9.0,
  waterfallMaxDrop: 14.5,
  waterfallLengthS: 16.0,

  /** Side caves / grottos. */
  caveMinSpacing: 220,
  caveMaxSpacing: 380,
  caveLengthMin: 56.0,
  caveLengthMax: 84.0,
  caveWidth: 6.4,
  caveCeilingHeight: 4.8,
  caveLateralOffset: 9.2,

  /** Distance (world units) per biome cycle. */
  biomeLength: 320,
  biomeBlendLength: 48,
} as const;

export const OBSTACLE_CONFIG = {
  /** Initial calm stretch at run start so player feels the flow before first hazard. */
  safeStartDistance: 42,
  /** Spacing between obstacle rows/clusters (decreases smoothly with distance). */
  initialRowSpacing: 24.0,
  minRowSpacing: 13.5,

  /** Dimensional tuning per obstacle type (world units). */
  boulder: {
    minRadius: 1.35,
    maxRadius: 2.65,
    minHeight: 2.2,
    maxHeight: 4.4,
    foamStrength: 0.9,
  },
  logDive: {
    /** Underside sits just above/at waterline; duck dives underneath (y <= -0.9). */
    trunkHeight: 1.65,
    clearanceBelow: 2.1,
    centerY: 0.85,
    foamStrength: 0.45,
  },
  logJump: {
    /** Low floating log with submerged hanging roots blocking dive; duck jumps over! */
    topHeightAboveWater: 1.08,
    radius: 0.72,
    clearanceAbove: 1.25,
    foamStrength: 0.75,
  },
  lilyPad: {
    radius: 1.55,
    height: 0.16,
    /** Lily pads act as bouncy speed/hop pads or gentle skimmable cover. */
    foamStrength: 0.25,
  },
  snag: {
    radius: 1.15,
    height: 2.4,
    foamStrength: 0.8,
  },
  arch: {
    width: 11.0,
    height: 4.2,
    clearanceBelow: 2.6,
    foamStrength: 0.35,
  },

  /** Near-miss bonus window outside obstacle collision radius (world units). */
  nearMissMargin: 1.15,
} as const;

export const POWERUP_CONFIG: Record<
  PowerUpType,
  {
    label: string;
    duration: number;
    color: string;
    emissive: string;
  }
> = {
  wing_gust: {
    label: 'Wing Gust',
    duration: 5.5,
    color: '#ffe066',
    emissive: '#ff9f1c',
  },
  bubble_lung: {
    label: 'Bubble Lung',
    duration: 10.0,
    color: '#4de8ff',
    emissive: '#00a8e8',
  },
  soap_shield: {
    label: 'Soap Shield',
    duration: 16.0,
    color: '#f4b6ff',
    emissive: '#c77dff',
  },
  magnet: {
    label: 'Bubble Magnet',
    duration: 9.0,
    color: '#ff6b9d',
    emissive: '#ff2e63',
  },
};

export const SCORING_CONFIG = {
  distancePointsPerUnit: 1.0,
  bubbleCoinPoints: 25,
  goldenFeatherPoints: 100,
  ducklingFriendPoints: 150,
  nearMissPoints: 60,
  waterfallClearPoints: 200,
  caveClearPoints: 250,
  logDiveBonusPoints: 50,
  logJumpBonusPoints: 50,
  comboTimeoutSeconds: 3.8,
  maxComboMultiplier: 8,
  magnetPullRadius: 7.5,
  magnetPullSpeed: 26.0,
} as const;

export const CAMERA_CONFIG = {
  fovDesktop: 58,
  fovMobilePortrait: 66,
  near: 0.15,
  far: 420,
  /** Third-person chase offsets relative to duck in river-space (world units). */
  surfaceFollowDist: 5.4,
  surfaceHeight: 2.55,
  surfaceLookAhead: 10.5,
  /** Dive camera pulls slightly closer & dips smoothly under the surface with turquoise tint. */
  diveFollowDist: 4.6,
  diveHeight: 0.55,
  diveLookAhead: 9.0,
  /** Airborne / flying camera pulls wider for scenic river vista. */
  flyFollowDist: 6.8,
  flyHeight: 3.4,
  flyLookAhead: 13.5,
  /** Waterfall plunge dramatic camera pullback. */
  waterfallFollowDist: 7.2,
  waterfallHeight: 3.8,
  /** Exponential smoothing rates (1/sec). */
  posSmooth: 9.5,
  lookSmooth: 12.0,
} as const;

export interface BiomePalette {
  id: BiomeId;
  name: string;
  skyTop: string;
  skyHorizon: string;
  fogColor: string;
  fogNear: number;
  fogFar: number;
  sunColor: string;
  sunIntensity: number;
  hemiSky: string;
  hemiGround: string;
  waterShallow: string;
  waterDeep: string;
  foamColor: string;
  foliageTint: string;
  rockTint: string;
  ambientGlow: string;
}

export const BIOMES: readonly BiomePalette[] = [
  {
    id: 'sunlit_creek',
    name: 'Sunlit Moss Creek',
    skyTop: '#2b7de9',
    skyHorizon: '#b9ebff',
    fogColor: '#b7e6f5',
    fogNear: 55,
    fogFar: 215,
    sunColor: '#fff5d6',
    sunIntensity: 2.4,
    hemiSky: '#a8e2ff',
    hemiGround: '#2f5932',
    waterShallow: '#28c7b7',
    waterDeep: '#094e63',
    foamColor: '#f3fcff',
    foliageTint: '#3e8e41',
    rockTint: '#5c6669',
    ambientGlow: '#6bf5d0',
  },
  {
    id: 'golden_rapids',
    name: 'Golden Cedar Rapids',
    skyTop: '#3267a8',
    skyHorizon: '#ffd59e',
    fogColor: '#f2cfa5',
    fogNear: 52,
    fogFar: 205,
    sunColor: '#ffd796',
    sunIntensity: 2.55,
    hemiSky: '#ffe3b3',
    hemiGround: '#593d24',
    waterShallow: '#2ab3a3',
    waterDeep: '#0e4d5c',
    foamColor: '#fff9ef',
    foliageTint: '#9c782b',
    rockTint: '#6e6259',
    ambientGlow: '#ffcf6b',
  },
  {
    id: 'emerald_falls',
    name: 'Misty Emerald Falls',
    skyTop: '#1f6478',
    skyHorizon: '#9be0dc',
    fogColor: '#98d6d4',
    fogNear: 46,
    fogFar: 188,
    sunColor: '#e6fff9',
    sunIntensity: 2.15,
    hemiSky: '#9de8e5',
    hemiGround: '#1e4d3a',
    waterShallow: '#1ed4b5',
    waterDeep: '#063d4d',
    foamColor: '#ebfffd',
    foliageTint: '#257a55',
    rockTint: '#4b5c5e',
    ambientGlow: '#52ffe8',
  },
  {
    id: 'glow_grotto',
    name: 'Twilight Crystal Gorge',
    skyTop: '#101d42',
    skyHorizon: '#2a5a7a',
    fogColor: '#1d4460',
    fogNear: 44,
    fogFar: 185,
    sunColor: '#9ad8ff',
    sunIntensity: 1.75,
    hemiSky: '#63b4ff',
    hemiGround: '#152b3b',
    waterShallow: '#26d9cf',
    waterDeep: '#07223d',
    foamColor: '#c9f8ff',
    foliageTint: '#1f6b63',
    rockTint: '#3e4c5e',
    ambientGlow: '#4df5e3',
  },
] as const;

export interface QualityPreset {
  maxPixelRatio: number;
  antialias: boolean;
  shadowsEnabled: boolean;
  shadowMapSize: number;
  waterSegmentsAcross: number;
  waterSubdivisionsPerUnit: number;
  maxParticles: number;
  causticsEnabled: boolean;
  refractionEnabled: boolean;
  foliageDensity: number;
}

export const QUALITY_PRESETS: Record<ResolvedQuality, QualityPreset> = {
  high: {
    maxPixelRatio: 2.0,
    antialias: true,
    shadowsEnabled: true,
    shadowMapSize: 1024,
    waterSegmentsAcross: 22,
    waterSubdivisionsPerUnit: 0.65,
    maxParticles: 420,
    causticsEnabled: true,
    refractionEnabled: true,
    foliageDensity: 1.0,
  },
  performance: {
    maxPixelRatio: 1.35,
    antialias: false,
    shadowsEnabled: false,
    shadowMapSize: 512,
    waterSegmentsAcross: 12,
    waterSubdivisionsPerUnit: 0.4,
    maxParticles: 160,
    causticsEnabled: false,
    refractionEnabled: false,
    foliageDensity: 0.55,
  },
};

export const INPUT_CONFIG = {
  /** Touch horizontal drag distance (fraction of screen width) for full lateral steer. */
  touchDragFullRange: 0.28,
  /** Vertical swipe velocity/distance (px) thresholds on mobile. */
  swipeUpThresholdPx: 34,
  swipeDownThresholdPx: 34,
  /** Tap duration max (ms) to trigger a crisp hop. */
  tapMaxDurationMs: 210,
  tapMaxMovePx: 18,
  /** Hold threshold (ms) on dive gesture / button. */
  diveHoldDelayMs: 90,
} as const;

export const WORLD_TOUR_CONFIG = {
  /** Default starting track ID on the Mini-Earth Globe. */
  defaultTrackId: 'pnw-creek',
  /** Default route mode on game launch. */
  defaultRouteMode: 'world_tour' as const,
  /** Arc-length transition blending window (world units) at the end of each World Tour leg. */
  transitionSpanS: 42.0,
  /** Look-ahead arc-length distance (world units) to trigger lazy GLB preloading for the next track. */
  preloadAheadS: 260.0,
} as const;

export const MINI_EARTH_CONFIG = {
  /** Real Mini-Earth planetary radius in Duck Scale world units (1° arc ≈ 27.93u, circ ≈ 10,053u). */
  radius: 1600.0,
  /** Geographic spatial hash cell size in degrees (10° × 10° grid wrapping ±180°). */
  spatialCellDeg: 10.0,
  /** Apply subtle true planetary horizon curvature drop (-dist² / (2R)) in local ENU projection. */
  horizonCurvatureEnabled: true,
  /** Re-center Floating-Origin ENU frame when duck moves farther than this from origin (world units). */
  floatingOriginRecenterDistanceU: 280.0,
  /** Downstream distance (world units) before a 2-way fork junction when HUD fork cue appears. */
  forkWarningDistanceU: 85.0,
  /** Downstream distance (world units) before a 2-way fork junction when steering locks in the branch. */
  forkCommitDistanceU: 10.0,
} as const;
