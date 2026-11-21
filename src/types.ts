import type * as THREE from 'three';

/**
 * Plain 3D vector structure (structurally compatible with THREE.Vector3).
 * World unit convention: 1.0 world unit = 10 cm (0.10 m) "Duck Scale".
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * River-aligned curvilinear coordinates:
 * - s: arc-length downstream from run start (world units, >= 0)
 * - u: signed lateral offset from centerline along sample.right (- left, + right)
 * - y: vertical offset from local water surface (0 = waterline, >0 = air, <0 = underwater)
 */
export interface RiverCoords {
  s: number;
  u: number;
  y: number;
}

export type BiomeId =
  | 'sunlit_creek'
  | 'golden_rapids'
  | 'emerald_falls'
  | 'glow_grotto';

export type RouteMode = 'world_tour' | 'single_track' | 'free_earth';

/**
 * Legacy cave style identifier kept for backwards compatibility during migration.
 * New packs define open, data-driven `CaveVisualParams` in `src/earth/schema.ts`.
 */
export type CaveStyle =
  | 'limestone'
  | 'bamboo_grotto'
  | 'jungle_cenote'
  | 'canyon_slot'
  | 'glacier_ice'
  | 'lava_tube';

/**
 * Upcoming physical river fork / confluence preview shown on HUD & steering hint.
 */
export interface RiverForkHint {
  junctionId: string;
  junctionName: string;
  distanceU: number;
  leftBranchId: string;
  leftBranchName: string;
  leftRegionName: string;
  rightBranchId: string;
  rightBranchName: string;
  rightRegionName: string;
  defaultBranchId: string;
  selectedSide?: 'left' | 'right';
}

/**
 * Sample along the procedural 3D river spline at arc-length `s`.
 * Orthonormal basis convention (right-handed, Y-up):
 * - tangent: unit vector pointing downstream
 * - right:   normalize(cross(tangent, WORLD_UP)) — duck's right when looking downstream
 * - up:      normalize(cross(right, tangent))    — generally +Y, tilted along slopes
 */
export interface RiverSample {
  /** Arc-length downstream along centerline (world units). */
  s: number;
  /** World-space centerline position on the resting water surface. */
  position: Vec3;
  /** Unit downstream direction vector. */
  tangent: Vec3;
  /** Unit river-right direction vector. */
  right: Vec3;
  /** Unit surface up vector perpendicular to tangent and right. */
  up: Vec3;
  /** Full navigable water surface width at this s (world units). */
  width: number;
  /** Channel water depth below surface at centerline (world units). */
  depth: number;
  /** Vertical grade dy/ds (<= 0 downhill; steep negative on waterfalls). */
  slope: number;
  /** Signed horizontal curvature in radians per world unit (+ right, - left). */
  curvature: number;
  /** True when inside a waterfall drop section. */
  isWaterfall: boolean;
  /** Total vertical drop height of this waterfall (0 if not a waterfall). */
  waterfallDrop: number;
  /** True when a side-cave / grotto entrance branches off near this s. */
  hasCaveEntrance: boolean;
  /** Signed lateral offset u toward the cave opening (0 when none). */
  caveOffset: number;
  /** Primary biome index (0..N-1). */
  biomeIndex: number;
  /** Smooth 0..1 blend toward the next biome. */
  biomeBlend: number;
  /** Optional local current speed multiplier (1.0 = nominal). */
  flowSpeedMultiplier?: number;
  /** Active Mini-Earth track/region ID at this arc-length `s`. */
  trackId?: string;
  /** Upcoming/blended Mini-Earth track/region ID across a zone transition. */
  nextTrackId?: string;
  /** Smooth 0..1 transition blend factor from `trackId` toward `nextTrackId`. */
  trackBlend?: number;
  /** 0..1 morph factor from sloped riverbanks (0) to steep canyon/fjord walls (1). */
  canyonWallFactor?: number;
  /** Legacy regional cave geological style at this sample. */
  caveStyle?: CaveStyle;
  /** Real Mini-Earth latitude in degrees (-90..+90). */
  lat?: number;
  /** Real Mini-Earth longitude in degrees (-180..+180). */
  lng?: number;
  /** Real Mini-Earth elevation above sea level (world units). */
  elevation?: number;
  /** Active physical `EarthWaterway` ID on the shared Mini-Earth globe. */
  waterwayId?: string;
  /** Primary spatial `EarthRegionZone` ID at `(lat, lng)`. */
  regionId?: string;
  /** Secondary blended spatial `EarthRegionZone` ID at `(lat, lng)`. */
  secondaryRegionId?: string;
  /** Spatial biome blend weight [0, 1] toward `secondaryRegionId`. */
  regionBlend?: number;
  /** Physical 2-way fork approaching downstream if within warning distance. */
  upcomingFork?: RiverForkHint | null;
}

export interface CaveBranchInfo {
  id: string;
  startS: number;
  endS: number;
  /** -1 = branches off left bank, +1 = branches off right bank. */
  side: -1 | 1;
  /** Peak lateral offset u from the main river centerline (world units). */
  maxOffset: number;
  /** Navigable channel width inside the cave (world units). */
  width: number;
  /** Arch ceiling clearance above water surface (world units). */
  ceilingHeight: number;
  /** Water depth inside the cave (world units). */
  depth: number;
  /** Accent bioluminescent glow color hex string (e.g. '#36f5d5'). */
  glowColor: string;
  /** Optional regional cave architectural style. */
  caveStyle?: CaveStyle;
}

export interface WaterSurfaceQuery {
  /** World Y height of the water surface (including waves if time is supplied). */
  height: number;
  /** Unit normal vector of the water surface. */
  normal: Vec3;
  /** World-space water flow velocity (units/sec). */
  flowVelocity: Vec3;
  /** Whitewater / turbulence intensity in [0, 1]. */
  foam: number;
  /** Local water depth below the surface (world units, 0 at banks). */
  depth: number;
}

export type ObstacleType =
  | 'boulder'
  | 'log_dive'
  | 'log_jump'
  | 'lily_pad'
  | 'snag'
  | 'arch';

/**
 * Hydrodynamic & gameplay obstacle placed in river coordinates.
 * Shared by gameplay collision, procedural river generation, and water foam/wake shaders.
 */
export interface HydroObstacle {
  id: string;
  type: ObstacleType;
  /** Downstream arc-length position. */
  s: number;
  /** Lateral offset from centerline. */
  u: number;
  /** Vertical offset relative to local water surface. */
  y: number;
  /** Primary horizontal bounding radius (world units). */
  radius: number;
  /** Span width across river (world units). */
  width: number;
  /** Vertical height / thickness (world units). */
  height: number;
  /** Safe navigable clearance below obstacle (world units; >0 for diveable logs/arches). */
  clearanceBelow: number;
  /** Vertical height above waterline required to jump cleanly over this obstacle. */
  clearanceAbove: number;
  /** Cached world-space anchor position. */
  worldPos: Vec3;
  /** Whitewater foam collar strength in [0, 1] for the water shader. */
  foamStrength: number;
  /** True if obstacle generates a swirling calm eddy pocket downstream. */
  hasEddy: boolean;
  /** Optional yaw rotation in radians in world space. */
  yaw?: number;
  /** Optional uniform render scale multiplier. */
  scale?: number;
  /** Optional asset ID hint for rendering. */
  assetId?: AssetId;
}

/**
 * Core spatial query interface implemented by the river/world system and consumed by
 * duck physics, water shaders, camera, wildlife, and VFX without circular imports.
 */
export interface RiverProvider {
  /** Sample river spline geometry and attributes at arc-length `s`. */
  sampleAt(s: number): RiverSample;
  /** Sample an evenly spaced range along `[sStart, sEnd]`. */
  sampleRange(sStart: number, sEnd: number, step: number): RiverSample[];
  /** Convert river coordinates `(s, u, y)` to world-space position. */
  riverToWorld(s: number, u: number, y?: number): Vec3;
  /** Project a world-space point into river coordinates `(s, u, y)`. */
  worldToRiver(worldPos: Vec3, hintS?: number): RiverCoords;
  /** Query world-space water surface height, normal, flow, foam, and depth at `(worldX, worldZ)`. */
  getWaterSurface(
    worldX: number,
    worldZ: number,
    time?: number,
    hintS?: number,
  ): WaterSurfaceQuery;
  /** Fast helper returning world Y water height at river coordinates `(s, u)`. */
  getWaterHeightAtRiver(s: number, u: number, time?: number): number;
  /** List cave branches overlapping `[sStart, sEnd]`. */
  getCaveBranches(sStart: number, sEnd: number): readonly CaveBranchInfo[];
  /** Returns the cave branch containing `(s, u)` or null if on the open river. */
  isInsideCave(s: number, u: number): CaveBranchInfo | null;
  /** Optional query for nearby obstacles so water shaders can render foam wakes & ripples. */
  getObstaclesInRange?(sStart: number, sEnd: number): readonly HydroObstacle[];
}

export type DuckMode =
  | 'surface'
  | 'airborne'
  | 'diving'
  | 'flying'
  | 'waterfall';

/**
 * High-level expressive animation state for the hero rubber duck.
 */
export type DuckAnimState =
  | 'swim'
  | 'dive_enter'
  | 'dive_swim'
  | 'fly'
  | 'jump'
  | 'waterfall_drop'
  | 'spooked'
  | 'crash';

/**
 * Complete per-frame state of the hero rubber duck, including physics and
 * expressive multi-state animation channels.
 */
export interface DuckState {
  /** Downstream arc-length coordinate. */
  s: number;
  /** Lateral offset from centerline (world units). */
  u: number;
  /** Height relative to local water surface (world units; <0 underwater). */
  y: number;
  /** World-space position of duck pivot (waterline center). */
  worldPos: Vec3;
  /** World-space velocity vector (units/sec). */
  velocity: Vec3;
  /** Pitch angle in radians (+ nose up, - nose down). */
  pitch: number;
  /** Roll/bank angle in radians (+ bank right, - bank left). */
  roll: number;
  /** World yaw heading in radians. */
  yaw: number;
  /** Current locomotion / hydro state. */
  mode: DuckMode;
  /** High-level expressive animation state. */
  animState: DuckAnimState;
  /** Normalized remaining breath in [0, 1]. */
  breath: number;
  /** Maximum dive duration in seconds (boosted by bubble_lung). */
  maxBreath: number;
  /** True when the duck's head/body is submerged below the water surface. */
  isUnderwater: boolean;
  /** Positive depth below water surface (0 when floating or airborne). */
  submersionDepth: number;
  /** Continuous phase in radians driving procedural wing flaps. */
  wingFlapPhase: number;
  /** Vertical squash-and-stretch factor (1.0 neutral, >1 stretched, <1 squashed). */
  squashStretch: number;
  /** Smoothed normalized carving turn amount in [-1, 1] (-1 left, +1 right) across all modes. */
  turnAmount: number;
  /** Startled / balancing intensity in [0, 1] (rapids jolt, near-miss, waterfall lip, shield bounce). */
  spookIntensity: number;
  /** Left wing flap elevation angle in radians (+ lifts wing tip upward). */
  wingLeftAngle: number;
  /** Right wing flap elevation angle in radians (+ lifts wing tip upward). */
  wingRightAngle: number;
  /** Wing spread factor in [0, 1] (0 tucked against flanks, 1 spread wide for flying/balancing). */
  wingSpread: number;
  /** Continuous phase in radians for alternating underwater/surface webbed-feet paddle kicks. */
  paddlePhase: number;
  /** Expressive head look-yaw in radians (+ looks left, - looks right). */
  headYaw: number;
  /** Expressive head tilt pitch in radians (+ chin up, - tuck down). */
  headPitch: number;
  /** Signed balancing roll wobble in radians during spooked/turbulent recovery. */
  balanceWobble: number;
  /** Continuous phase in radians for happy surface tail wag. */
  tailWagPhase: number;
  /** True while Soap Shield absorbs one obstacle impact. */
  shieldActive: boolean;
  /** Remaining Wing Gust flight duration in seconds (0 if inactive). */
  flightRemaining: number;
  /** Remaining Bubble Lung extended breath duration in seconds (0 if inactive). */
  breathBoostRemaining: number;
  /** Remaining Magnet attraction duration in seconds (0 if inactive). */
  magnetRemaining: number;
  /** Current forward downstream speed ds/dt in world units/sec. */
  speed: number;
  /** True after a fatal collision until run restarts. */
  isCrashed: boolean;
  /** Optional river-space lateral velocity du/dt (units/sec). */
  lateralVelocity?: number;
  /** Optional river-space vertical velocity dy/dt (units/sec). */
  verticalVelocity?: number;
  /** True while the duck is inside a side cave branch. */
  inCave?: boolean;
  /** Remaining post-shield-break invulnerability frames in seconds. */
  invulnerableRemaining?: number;
}

export type PowerUpType =
  | 'wing_gust'
  | 'bubble_lung'
  | 'soap_shield'
  | 'magnet';

export type CollectibleKind =
  | 'bubble_coin'
  | 'golden_feather'
  | 'duckling_friend'
  | PowerUpType;

export interface CollectibleItem {
  id: string;
  kind: CollectibleKind;
  powerUpType?: PowerUpType;
  s: number;
  u: number;
  y: number;
  worldPos: Vec3;
  radius: number;
  value: number;
  collected: boolean;
  inCave: boolean;
  bobPhase: number;
}

export type GameState = 'title' | 'playing' | 'paused' | 'gameover';

export type QualityLevel = 'auto' | 'high' | 'performance';

export type ResolvedQuality = 'high' | 'performance';

export interface ActivePowerUpHud {
  type: PowerUpType;
  remaining: number;
  duration: number;
  /** Normalized remaining ratio in [0, 1]. */
  normalized: number;
}

export interface HudCallout {
  id: number;
  text: string;
  tone: 'info' | 'bonus' | 'warning' | 'powerup';
}

/**
 * Immutable UI snapshot pushed from gameplay loop to HUD layer.
 */
export interface HudSnapshot {
  gameState: GameState;
  score: number;
  highScore: number;
  /** Distance traveled displayed in meters (derived from s * WORLD_UNIT_METERS). */
  distanceMeters: number;
  coins: number;
  combo: number;
  /** Normalized combo decay bar in [0, 1]. */
  comboTimer: number;
  /** Current speed normalized for speedometer visuals [0, 1]. */
  speedNormalized: number;
  mode: DuckMode;
  /** Normalized remaining lung breath [0, 1]. */
  breath: number;
  isUnderwater: boolean;
  inCave: boolean;
  biomeIndex: number;
  biomeName: string;
  shieldActive: boolean;
  activePowerUps: ActivePowerUpHud[];
  quality: QualityLevel;
  resolvedQuality: ResolvedQuality;
  muted: boolean;
  fps: number;
  assetsLoadedRatio: number;
  controlsHintVisible: boolean;
  crashReason?: string;
  callout?: HudCallout | null;
  /** Active world route mode (`'world_tour'` or `'single_track'`). */
  routeMode?: RouteMode;
  /** Active Mini-Earth track ID. */
  currentTrackId?: string;
  /** Active Mini-Earth track display name. */
  currentTrackName?: string;
  /** Active Mini-Earth track geographic region & country label. */
  currentTrackRegion?: string;
  /** Next connected track display name in World Tour. */
  nextTrackName?: string;
  /** Active regional weather display label. */
  weatherLabel?: string;
  /** Normalized progress [0, 1] through the current World Tour leg. */
  trackProgress?: number;
  /** Unique list of track IDs visited during the current run. */
  visitedTrackIds?: string[];
  /** Current real Mini-Earth latitude in degrees. */
  lat?: number;
  /** Current real Mini-Earth longitude in degrees. */
  lng?: number;
  /** Current physical `EarthWaterway` ID. */
  waterwayId?: string;
  /** Current physical `EarthWaterway` display name. */
  waterwayName?: string;
  /** Upcoming physical river fork / confluence preview if approaching a 2-way split. */
  upcomingFork?: RiverForkHint | null;
}

/**
 * Unified per-frame input state from touch gestures, keyboard, or gamepad.
 */
export interface InputState {
  /** Continuous steering axis in [-1, 1] (-1 left, +1 right). */
  steer: number;
  /** Frame-delta lateral drag impulse (normalized viewport width fraction) for snappy touch steering. */
  steerDelta: number;
  /** True on the single frame a jump/flap was triggered. */
  jumpPressed: boolean;
  /** True while jump/fly input is held. */
  jumpHeld: boolean;
  /** True while dive input is held. */
  diveHeld: boolean;
  /** True on the frame dive began. */
  diveJustPressed: boolean;
  /** True on the frame dive was released (for breach-boost pops). */
  diveJustReleased: boolean;
  /** True on the frame pause was toggled. */
  pausePressed: boolean;
  /** True when any touch/mouse pointer is actively steering. */
  pointerActive: boolean;
  /** Most recently used input device for adaptive HUD hints. */
  inputDevice: 'touch' | 'keyboard' | 'gamepad';
}

/**
 * Typed map of gameplay audio event payloads for WebAudio procedural synthesis.
 */
export interface AudioEvents {
  start_run: undefined;
  pause: undefined;
  resume: undefined;
  game_over: { score: number; isNewBest: boolean };
  jump: { charge: number; fromUnderwater: boolean };
  wing_flap: { intensity: number };
  dive_enter: { speed: number };
  dive_exit: { breachPower: number };
  breath_low: { breath: number };
  splash: { intensity: number; kind: 'land' | 'waterfall' | 'skim' };
  quack: { mood: 'happy' | 'startled' | 'spooked' | 'victory' | 'bonk'; pitch?: number };
  spook_balance: { intensity: number };
  collect: { kind: CollectibleKind; combo: number };
  powerup_pickup: { powerUp: PowerUpType };
  powerup_expire: { powerUp: PowerUpType };
  shield_break: undefined;
  near_miss: { combo: number };
  crash: { obstacleType: ObstacleType };
  waterfall_drop: { dropHeight: number };
  cave_transition: { entering: boolean };
  track_transition: { trackId: string; trackName: string };
  thunder: { intensity: number };
}

export type AudioEventName = keyof AudioEvents;

export interface AudioAmbienceState {
  /** Current duck forward speed (world units/sec). */
  speed: number;
  /** Rapids turbulence intensity [0, 1]. */
  rapidsIntensity: number;
  /** Submersion blend [0, 1] (0 surface, 1 fully underwater low-pass). */
  submersion: number;
  /** True when inside a resonant cave branch. */
  inCave: boolean;
  /** Proximity to nearest waterfall [0, 1]. */
  waterfallProximity: number;
  /** Current biome index (0..3). */
  biomeIndex: number;
  /** True while airborne/flying for subtle wind rush. */
  airborneFactor: number;
  /** Optional active Mini-Earth track ID for regional audio profiling. */
  trackId?: string;
  /** Optional next Mini-Earth track ID across a leg transition. */
  nextTrackId?: string;
  /** Optional 0..1 blend toward `nextTrackId`. */
  trackBlend?: number;
}

export interface AudioController {
  unlock(): Promise<void> | void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  emit<K extends AudioEventName>(
    event: K,
    ...args: AudioEvents[K] extends undefined ? [] : [payload: AudioEvents[K]]
  ): void;
  updateAmbience(state: AudioAmbienceState, dt: number): void;
  dispose(): void;
}

/**
 * Core hero rig 3D asset identifiers required for the articulated rubber duck.
 */
export type CoreAssetId = 'rubber_duck' | 'duck_wing';

/**
 * Open 3D asset identifier. Contributor packs can declare brand-new custom `.glb`
 * assets via `EarthRegionPack.assets` / `assetLoader.registerAssetSpecs()` with
 * zero edits to core files!
 */
export type AssetId = string;

/**
 * Built-in procedural fallback geometry archetypes used automatically when a
 * custom pack asset's `.glb` is loading or not yet generated.
 */
export type AssetFallbackArchetype =
  | 'tree'
  | 'rock'
  | 'arch'
  | 'pillar'
  | 'foliage'
  | 'fish'
  | 'critter'
  | 'log'
  | 'pad'
  | 'landmark'
  | 'boat'
  | 'crystal';

export interface DuckWingAttachments {
  /** Local shoulder pivot on duck's LEFT flank (+X side, +Z forward, +Y up). */
  wingLeftOffset: [number, number, number];
  /** Local shoulder pivot on duck's RIGHT flank (-X side). */
  wingRightOffset: [number, number, number];
  /** Scale multiplier applied to the wing mesh. */
  wingScale: number;
  /** Local hip/belly pivot for webbed paddling feet. */
  feetOffset: [number, number, number];
  /** Local neck/head pivot offset. */
  headOffset: [number, number, number];
}

/**
 * Articulated hero rubber duck rig returned by `AssetLoader.createDuckRig()`.
 *
 * Local coordinate convention (right-handed, Y-up):
 * - `+Z` = beak / forward
 * - `+Y` = top of head / up
 * - `+X` = duck's LEFT side (rotate `wingLeftPivot.rotation.z` positively to raise tip)
 * - `-X` = duck's RIGHT side (rotate `wingRightPivot.rotation.z` negatively to raise tip)
 */
export interface DuckRig {
  /** Outer root positioned at `duck.worldPos` and oriented by `duck.yaw`. */
  root: THREE.Group;
  /** Body transform receiving pitch, roll, balanceWobble, and squashStretch. */
  bodyPivot: THREE.Group;
  /** Main duck body mesh group (Meshy `rubber_duck.glb` or procedural fallback body). */
  bodyMesh: THREE.Group;
  /** Head group (full articulated head on procedural fallback; head anchor on GLB). */
  headPivot: THREE.Group;
  /** Left wing shoulder pivot at +X flank. */
  wingLeftPivot: THREE.Group;
  /** Right wing shoulder pivot at -X flank. */
  wingRightPivot: THREE.Group;
  /** Parent container for both webbed feet underneath the duck belly. */
  feetPivot: THREE.Group;
  /** Left webbed paddling foot pivot (+X). */
  footLeftPivot: THREE.Group;
  /** Right webbed paddling foot pivot (-X). */
  footRightPivot: THREE.Group;
  /** Rear tail anchor pivot. */
  tailPivot: THREE.Group;
  /** True when the body uses the loaded Meshy GLB rather than procedural geometry. */
  usingGlbBody: boolean;
  /** True when the articulated wings use the loaded Meshy `duck_wing.glb`. */
  usingGlbWings: boolean;
  /** Primary glossy yellow rubber material matched to the hero duck body. */
  bodyMaterial: THREE.MeshPhysicalMaterial;
  /** Secondary glossy orange rubber material for beak & webbed feet. */
  accentMaterial: THREE.MeshPhysicalMaterial;
}

export interface ModelBoundingBox {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  center: [number, number, number];
}

export type PivotAlignment = 'bottom' | 'center' | 'waterline';

export interface AssetSpec {
  id: AssetId;
  /** Relative filename under `public/models/` (e.g. `rubber_duck.glb`) or pack-relative path. */
  filename: string;
  /** Optional explicit URL override (e.g. `./models/my_pack/bridge.glb`). */
  url?: string;
  /** Target dominant dimension in world units after normalization. */
  targetSize: number;
  /** Which axis/metric `targetSize` matches during normalization. */
  sizeAxis: 'max' | 'x' | 'y' | 'z';
  /** Vertical pivot alignment after normalization. */
  pivot: PivotAlignment;
  /** Additional local Y offset applied after pivot alignment (world units). */
  yOffset: number;
  /** Yaw correction in radians so the asset faces +Z forward. */
  rotY: number;
  /** Whether the asset should cast shadows on high quality. */
  castShadow: boolean;
  /** Whether the asset should receive shadows. */
  receiveShadow: boolean;
  /** Human-readable label. */
  label: string;
  /**
   * Optional procedural fallback archetype so contributor pack assets render
   * cleanly even before or without a `.glb` file — zero core loader edits needed!
   */
  fallbackArchetype?: AssetFallbackArchetype;
  /** Optional 24-bit RGB hex color tint for the procedural archetype fallback. */
  fallbackColor?: number;
}

export interface LoadedAsset {
  id: AssetId;
  /** Normalized prototype group ready to `.clone(true)` for scene instances. */
  prototype: THREE.Group;
  /** True if backed by a loaded `.glb`, false if using procedural Three.js fallback. */
  isFallback: boolean;
  /** Post-normalization bounding box size in world units. */
  size: Vec3;
  /** Approximate triangle count of the prototype. */
  triangles: number;
  /** File size in bytes if loaded from `.glb` (0 for fallback). */
  byteSize: number;
}
