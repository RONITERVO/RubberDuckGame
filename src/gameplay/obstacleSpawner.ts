import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { assetLoader } from '../assets/loader';
import { getAssetSpec } from '../assets/manifest';
import { DUCK_CONFIG, OBSTACLE_CONFIG, RIVER_CONFIG } from '../config';
import {
  blendEarthRegionZones,
  earthWorld,
  type BlendedEarthRegion,
  type EarthRegionZone,
} from '../earth';
import type {
  AssetId,
  DuckState,
  HydroObstacle,
  ResolvedQuality,
  RiverProvider,
  RiverSample,
  Vec3,
} from '../types';

export type ObstaclePatternKind =
  | 'single_boulder'
  | 'slalom_pair'
  | 'rock_island'
  | 'dive_log'
  | 'dive_arch'
  | 'jump_log'
  | 'lily_thicket'
  | 'snag_chicane'
  | 'split_choice';

export interface ObstacleClusterMeta {
  id: string;
  s: number;
  pattern: ObstaclePatternKind;
  /** Primary safe/optimal lateral line `u` recommended for collectible trails. */
  recommendedLineU: number;
  /** Optional tighter high-reward chute `u` (e.g. narrow side of a rock island). */
  highRewardChuteU?: number;
  /** Whether the primary line expects a jump or dive maneuver at slice `s`. */
  maneuver: 'slalom' | 'jump' | 'dive';
  /** Obstacles belonging to this cluster. */
  obstacles: HydroObstacle[];
}

export interface ObstacleInteractionEvent {
  kind: 'near_miss' | 'log_dive_clear' | 'log_jump_clear';
  obstacle: HydroObstacle;
  /** True when the duck barely skimmed under a log or over roots. */
  isSkim: boolean;
  worldPos: Vec3;
}

export interface ObstacleCollisionHit {
  obstacle: HydroObstacle;
  kind: 'hit' | 'lily_bounce';
}

interface SpawnedObstacleEntry {
  data: HydroObstacle;
  mesh: THREE.Group;
  clusterId: string;
  nearMissAwarded: boolean;
  clearAwarded: boolean;
  bounceTriggered: boolean;
  bobStyle: 'none' | 'gentle' | 'barrel' | 'canoe';
}

interface Interval {
  min: number;
  max: number;
}

/**
 * Build a single merged non-indexed BufferGeometry from positioned/rotated/scaled copies
 * of a prototype geometry, collapsing 10-20 obstacle sub-meshes into 1 GPU draw call.
 */
function buildMergedSubMesh(
  baseGeom: THREE.BufferGeometry,
  material: THREE.Material,
  transforms: Array<{
    pos: [number, number, number];
    rot?: [number, number, number];
    scale?: [number, number, number];
  }>,
): THREE.Mesh | null {
  if (transforms.length === 0) return null;
  const clones: THREE.BufferGeometry[] = [];
  const mat = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();

  for (let i = 0; i < transforms.length; i++) {
    const t = transforms[i];
    const g = baseGeom.index ? baseGeom.toNonIndexed() : baseGeom.clone();
    pos.set(t.pos[0], t.pos[1], t.pos[2]);
    if (t.rot) {
      euler.set(t.rot[0], t.rot[1], t.rot[2]);
      quat.setFromEuler(euler);
    } else {
      quat.identity();
    }
    if (t.scale) {
      scale.set(t.scale[0], t.scale[1], t.scale[2]);
    } else {
      scale.set(1, 1, 1);
    }
    mat.compose(pos, quat, scale);
    g.applyMatrix4(mat);
    clones.push(g);
  }

  const merged = mergeGeometries(clones, false);
  for (let i = 0; i < clones.length; i++) {
    clones[i].dispose();
  }
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, material);
  mesh.userData.ownsGeometry = true;
  return mesh;
}

/**
 * Dispose any dynamically merged geometries owned by an obstacle group.
 */
function disposeOwnedGeometries(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.userData.ownsGeometry) {
      obj.geometry.dispose();
    }
  });
}

/**
 * Deterministic mulberry32 PRNG for reproducible obstacle layouts per run seed.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isBouncePadAsset(assetId: AssetId): boolean {
  if (assetId === 'giant_lily_pad') return true;
  if (assetId === 'mossy_step_stones') return false;
  return getAssetSpec(assetId).fallbackArchetype === 'pad';
}

function isFloatingBarrelAsset(assetId?: AssetId): boolean {
  return assetId === 'floating_barrel';
}

function isBoatAsset(assetId?: AssetId): boolean {
  if (!assetId) return false;
  return assetId === 'sunken_canoe' || getAssetSpec(assetId).fallbackArchetype === 'boat';
}

function isReedsAsset(assetId?: AssetId): boolean {
  if (!assetId) return false;
  return assetId === 'cattail_reeds' || getAssetSpec(assetId).fallbackArchetype === 'foliage';
}

function isSteppingStonesAsset(assetId?: AssetId): boolean {
  return assetId === 'mossy_step_stones';
}

function isSpireOrColumnAsset(assetId: AssetId): boolean {
  const arch = getAssetSpec(assetId).fallbackArchetype;
  return arch === 'pillar' || arch === 'crystal';
}

/**
 * Shared reusable procedural geometries & data-driven regional materials for
 * submerged root/twig curtains, grounded bank abutments, lily stems, and snags.
 */
class SharedObstacleParts {
  public readonly submergedRootMat: THREE.MeshStandardMaterial;
  public readonly snagWoodMat: THREE.MeshStandardMaterial;
  public readonly mossMat: THREE.MeshStandardMaterial;
  public readonly lilyPadMat: THREE.MeshStandardMaterial;
  public readonly lilyStemMat: THREE.MeshStandardMaterial;
  public readonly lotusMat: THREE.MeshStandardMaterial;

  public readonly rootConeGeom: THREE.CylinderGeometry;
  public readonly rootBranchGeom: THREE.CylinderGeometry;
  public readonly rockBaseGeom: THREE.CylinderGeometry;
  public readonly lilyPadGeom: THREE.CylinderGeometry;
  public readonly lilyStemGeom: THREE.CylinderGeometry;
  public readonly lotusGeom: THREE.DodecahedronGeometry;
  public readonly snagTrunkGeom: THREE.CylinderGeometry;
  public readonly archButtressGeom: THREE.DodecahedronGeometry;

  private readonly regionRockMaterials = new Map<string, THREE.MeshStandardMaterial>();

  constructor() {
    // Warm sunlit waterlogged cedar roots/twigs so tangled underwater barriers read clearly
    // both through transparent surface water and when diving!
    this.submergedRootMat = new THREE.MeshStandardMaterial({
      color: 0x805e3c,
      emissive: 0x2b1b0b,
      emissiveIntensity: 0.26,
      roughness: 0.76,
      metalness: 0.02,
    });
    this.snagWoodMat = new THREE.MeshStandardMaterial({
      color: 0x866b50,
      roughness: 0.8,
      metalness: 0.02,
    });
    this.mossMat = new THREE.MeshStandardMaterial({
      color: 0x489143,
      roughness: 0.84,
      flatShading: true,
    });
    this.lilyPadMat = new THREE.MeshStandardMaterial({
      color: 0x329c46,
      roughness: 0.4,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });
    this.lilyStemMat = new THREE.MeshStandardMaterial({
      color: 0x2f6938,
      emissive: 0x0c2411,
      emissiveIntensity: 0.18,
      roughness: 0.8,
    });
    this.lotusMat = new THREE.MeshStandardMaterial({
      color: 0xffb3d0,
      emissive: 0x6b203b,
      emissiveIntensity: 0.3,
      roughness: 0.4,
    });

    this.rootConeGeom = new THREE.CylinderGeometry(0.068, 0.018, 1.0, 6);
    this.rootBranchGeom = new THREE.CylinderGeometry(0.048, 0.016, 1.0, 5);
    this.rockBaseGeom = new THREE.CylinderGeometry(0.84, 1.1, 1.0, 8);
    // Notched lily-pad disc (330 degrees)
    this.lilyPadGeom = new THREE.CylinderGeometry(
      1.0,
      0.96,
      0.06,
      14,
      1,
      false,
      0.24,
      Math.PI * 2 - 0.48,
    );
    this.lilyStemGeom = new THREE.CylinderGeometry(0.045, 0.03, 1.0, 5);
    this.lotusGeom = new THREE.DodecahedronGeometry(0.18, 0);
    this.snagTrunkGeom = new THREE.CylinderGeometry(0.22, 0.46, 1.0, 7);
    this.archButtressGeom = new THREE.DodecahedronGeometry(1.15, 1);
  }

  /**
   * 100% data-driven regional stone/ice/basalt material derived directly from
   * `zone.groundStyle` — zero hardcoded region IDs!
   */
  public getRockBaseMaterial(zone: EarthRegionZone): THREE.MeshStandardMaterial {
    const existing = this.regionRockMaterials.get(zone.id);
    if (existing) return existing;

    const gs = zone.groundStyle;
    const isIcy = gs.iceReflectivity >= 0.45;
    const mat = new THREE.MeshStandardMaterial({
      color: gs.rockTint,
      emissive: gs.emissiveIntensity > 0.12 ? gs.emissiveColor : isIcy ? 0x0c3c54 : 0x000000,
      emissiveIntensity:
        gs.emissiveIntensity > 0.12
          ? Math.min(0.42, gs.emissiveIntensity * 0.45)
          : isIcy
            ? 0.25
            : 0,
      roughness: THREE.MathUtils.clamp(gs.roughness * 0.85, 0.22, 0.85),
      metalness: isIcy ? 0.08 : 0.06,
      flatShading: true,
    });
    this.regionRockMaterials.set(zone.id, mat);
    return mat;
  }

  public dispose(): void {
    for (const mat of this.regionRockMaterials.values()) {
      mat.dispose();
    }
    this.regionRockMaterials.clear();

    this.submergedRootMat.dispose();
    this.snagWoodMat.dispose();
    this.mossMat.dispose();
    this.lilyPadMat.dispose();
    this.lilyStemMat.dispose();
    this.lotusMat.dispose();

    this.rootConeGeom.dispose();
    this.rootBranchGeom.dispose();
    this.rockBaseGeom.dispose();
    this.lilyPadGeom.dispose();
    this.lilyStemGeom.dispose();
    this.lotusGeom.dispose();
    this.snagTrunkGeom.dispose();
    this.archButtressGeom.dispose();
  }
}

/**
 * 100% data-driven obstacle streaming system for Shared Physical Mini-Earth:
 * - Drives obstacle palettes purely from `earthWorld.getBlendedRegionAt(sample.lat, sample.lng)`
 * - Supports all 37 shared & regional Meshy PBR models (beaver_dam, stone_footbridge,
 *   sunken_canoe, willow_overhang, river_snag_stump, floating_barrel, cattail_reeds,
 *   mossy_step_stones, giant_lily_pad, regional arches, pillars, spires, boulders)
 * - Guarantees fork-safe obstacle-free lanes within ±25u of physical EarthJunction forks
 * - Validates strict passability on every single slice!
 */
export class ObstacleSpawner {
  public readonly group = new THREE.Group();

  private readonly river: RiverProvider;
  private readonly parts = new SharedObstacleParts();
  private readonly entries: SpawnedObstacleEntry[] = [];
  private readonly clusters: ObstacleClusterMeta[] = [];

  private quality: ResolvedQuality = 'high';
  private rng: () => number;
  private nextSpawnS: number = OBSTACLE_CONFIG.safeStartDistance + 6;
  private rowIndex = 0;
  private obstacleSeq = 0;
  private lastOpenLaneU = 0;
  private lastManeuver: 'slalom' | 'jump' | 'dive' = 'slalom';
  private lastManeuverS = 0;
  private slalomSign: -1 | 1 = 1;
  private boulderCycleIdx = 0;
  private diveCycleIdx = 0;
  private jumpCycleIdx = 0;

  // Reusable math scratch objects (zero per-frame allocations)
  private readonly tmpLeft = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3();
  private readonly tmpTan = new THREE.Vector3();
  private readonly tmpMat = new THREE.Matrix4();

  constructor(river: RiverProvider, seed: number = 1337) {
    this.river = river;
    this.group.name = 'obstacles_root';
    this.rng = mulberry32(seed);
  }

  public setQuality(quality: ResolvedQuality): void {
    if (this.quality === quality) return;
    this.quality = quality;
  }

  public reset(seed: number = 1337): void {
    this.clearAll();
    this.rng = mulberry32(seed);
    this.nextSpawnS = OBSTACLE_CONFIG.safeStartDistance + 6 + this.rng() * 8;
    this.rowIndex = 0;
    this.obstacleSeq = 0;
    this.lastOpenLaneU = (this.rng() - 0.5) * 3.0;
    this.lastManeuver = 'slalom';
    this.lastManeuverS = 0;
    this.slalomSign = this.rng() < 0.5 ? -1 : 1;
    this.boulderCycleIdx = Math.floor(this.rng() * 12);
    this.diveCycleIdx = Math.floor(this.rng() * 12);
    this.jumpCycleIdx = Math.floor(this.rng() * 12);
  }

  /**
   * Rebuilds meshes of currently active obstacles when lazy-loaded shared or regional
   * Meshy `.glb` models finish loading (`assetLoader.onAssetsUpdated`).
   */
  public refreshAssets(): void {
    this.rebuildMeshes();
  }

  /**
   * Rebuilds meshes of currently active obstacles (e.g. if Meshy GLBs finish loading
   * after initial fallback spawns).
   */
  public rebuildMeshes(): void {
    for (const entry of this.entries) {
      this.group.remove(entry.mesh);
      disposeOwnedGeometries(entry.mesh);
      const sample = this.river.sampleAt(entry.data.s);
      const rebuilt = this.buildObstacleMesh(
        entry.data,
        sample,
        entry.data.type === 'boulder' && entry.data.radius >= 2.25 && !isBoatAsset(entry.data.assetId),
      );
      entry.mesh = rebuilt;
      this.group.add(rebuilt);
    }
  }

  /**
   * Curated QA showcase gallery placing all 6 signature new shared Meshy river obstacles
   * (`sunken_canoe`, `floating_barrel`, `beaver_dam`, `river_snag_stump`,
   * `stone_footbridge`, `willow_overhang`) cleanly framed ahead of `startS`.
   */
  public spawnShowcaseStretch(startS: number): void {
    this.clearAll();
    this.nextSpawnS = startS + 78;

    const addShowcaseObs = (obs: HydroObstacle, maneuver: 'slalom' | 'jump' | 'dive'): void => {
      const sample = this.river.sampleAt(obs.s);
      const mesh = this.buildObstacleMesh(obs, sample, false);
      this.group.add(mesh);
      const clusterId = `showcase_obs_${obs.id}`;
      this.entries.push({
        data: obs,
        mesh,
        clusterId,
        nearMissAwarded: false,
        clearAwarded: false,
        bounceTriggered: false,
        bobStyle: this.resolveBobStyle(obs),
      });
      this.clusters.push({
        id: clusterId,
        s: obs.s,
        pattern:
          maneuver === 'dive'
            ? 'dive_arch'
            : maneuver === 'jump'
              ? 'jump_log'
              : 'single_boulder',
        recommendedLineU: maneuver === 'slalom' ? -Math.sign(obs.u || 1) * 1.6 : obs.u,
        maneuver,
        obstacles: [obs],
      });
    };

    // 1. Sunken Canoe (slalom left) + Floating Barrel (bobbing right)
    const s1 = startS + 10.5;
    const sample1 = this.river.sampleAt(s1);
    const zone1 = this.getRegionAt(s1, sample1).primaryZone;
    addShowcaseObs(
      this.createBoulderData(s1, -2.9, 1.75, sample1, zone1, 'sunken_canoe'),
      'slalom',
    );
    const s2 = startS + 12.2;
    const sample2 = this.river.sampleAt(s2);
    addShowcaseObs(
      this.createBoulderData(s2, 3.1, 1.15, sample2, zone1, 'floating_barrel'),
      'slalom',
    );

    // 2. Woven Beaver Dam (jump over center-left) + River Snag Stump (slalom right)
    const s3 = startS + 20.0;
    const sample3 = this.river.sampleAt(s3);
    addShowcaseObs(
      this.createLogJumpData(s3, -1.2, Math.min(6.4, sample3.width * 0.52), sample3, zone1, 'beaver_dam'),
      'jump',
    );
    const s4 = startS + 26.5;
    const sample4 = this.river.sampleAt(s4);
    addShowcaseObs(
      this.createSnagData(s4, 3.3, sample4, zone1, 'river_snag_stump'),
      'slalom',
    );

    // 3. Mossy Cobblestone Footbridge Arch (dive under)
    const s5 = startS + 34.0;
    const sample5 = this.river.sampleAt(s5);
    addShowcaseObs(
      this.createLogDiveData(s5, 0, sample5.width * 1.02, sample5, zone1, 'arch', 'stone_footbridge'),
      'dive',
    );

    // 4. Weeping Willow Overhang Arch (dive under further ahead)
    const s6 = startS + 52.0;
    const sample6 = this.river.sampleAt(s6);
    addShowcaseObs(
      this.createLogDiveData(s6, 0, sample6.width * 1.0, sample6, zone1, 'log_dive', 'willow_overhang'),
      'dive',
    );
  }

  /**
   * Re-project all active obstacle world transforms after a Floating-Origin ENU recenter.
   */
  public syncWorldPositions(): void {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const obs = entry.data;
      const sample = this.river.sampleAt(obs.s);
      obs.worldPos = this.river.riverToWorld(obs.s, obs.u, obs.y);
      entry.mesh.position.set(obs.worldPos.x, obs.worldPos.y, obs.worldPos.z);

      if (
        obs.type === 'log_dive' ||
        obs.type === 'arch' ||
        obs.type === 'log_jump' ||
        obs.type === 'lily_pad'
      ) {
        const streamYaw = Math.atan2(sample.tangent.x, sample.tangent.z);
        const extraYaw = obs.type === 'lily_pad' ? 0 : (obs.yaw ?? streamYaw) - streamYaw;
        this.alignGroupToRiver(entry.mesh, sample, extraYaw);
      }
    }
  }

  /**
   * Stream new obstacles ahead of `duckS`, hide overhead logs that would occlude
   * the chase camera directly behind the duck, and prune far-behind obstacles.
   */
  public update(duckS: number, time: number, cameraPos?: Vec3): void {
    const aheadS = duckS + Math.min(RIVER_CONFIG.aheadDistance - 114, 72);
    const pruneS = duckS - Math.min(RIVER_CONFIG.behindDistance, 18);

    // 1. Spawn new rows smoothly up to streaming horizon
    let safetyCounter = 0;
    while (this.nextSpawnS < aheadS && safetyCounter < 48) {
      safetyCounter += 1;
      const targetS = this.nextSpawnS;
      const spacing = this.computeRowSpacing(targetS);

      if (!this.isForbiddenZone(targetS)) {
        const spawned = this.spawnClusterAt(targetS);
        if (spawned) {
          const extra =
            spawned.maneuver === 'dive'
              ? 10.5
              : spawned.maneuver === 'jump'
                ? 6.5
                : spawned.pattern === 'rock_island'
                  ? 4.0
                  : 0;
          this.nextSpawnS = targetS + spacing + extra;
          this.rowIndex += 1;
          continue;
        }
      }

      // Advance cleanly past forbidden zones (waterfalls / cave mouths / physical river forks)
      this.nextSpawnS = targetS + 8.0;
    }

    // 2. Expressive gentle bob & current sway on floating hazards + camera-occlusion safety
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const obs = entry.data;
      if (entry.bobStyle === 'gentle') {
        const bob = Math.sin(time * 2.4 + obs.s * 0.35) * 0.045;
        entry.mesh.position.y = obs.worldPos.y + bob;
      } else if (entry.bobStyle === 'barrel') {
        const phase = time * 3.1 + obs.s * 0.42;
        entry.mesh.position.y = obs.worldPos.y + Math.sin(phase) * 0.085;
        entry.mesh.rotation.z = Math.sin(phase * 0.85) * 0.14;
        entry.mesh.rotation.x = Math.cos(phase * 0.72) * 0.1;
      } else if (entry.bobStyle === 'canoe') {
        const phase = time * 1.9 + obs.s * 0.31;
        entry.mesh.position.y = obs.worldPos.y + Math.sin(phase) * 0.035;
      }

      // Prevent overhead dive logs / arches behind the duck from clipping straight into
      // the chase camera and blinding the player's view of upcoming obstacles!
      if (cameraPos && (obs.type === 'log_dive' || obs.type === 'arch')) {
        const behindDuck = obs.s < duckS - 0.35;
        const dx = obs.worldPos.x - cameraPos.x;
        const dy = obs.worldPos.y - cameraPos.y;
        const dz = obs.worldPos.z - cameraPos.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const occludesCamera = behindDuck && distSq < 34.0; // within ~5.8u of camera lens
        entry.mesh.visible = !occludesCamera;
      } else {
        entry.mesh.visible = true;
      }

      // Keep obstacle draw calls & shadow-pass triangle count lean across all 6 regions (<= 380k)
      if (entry.mesh.userData.castingShadow !== false) {
        entry.mesh.userData.castingShadow = false;
        entry.mesh.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.castShadow = false;
          }
        });
      }
    }

    // 3. Prune behind
    while (this.entries.length > 0 && this.entries[0].data.s < pruneS) {
      const removed = this.entries.shift()!;
      this.group.remove(removed.mesh);
      disposeOwnedGeometries(removed.mesh);
    }
    while (this.clusters.length > 0 && this.clusters[0].s < pruneS) {
      this.clusters.shift();
    }
  }

  /**
   * Query active obstacles overlapping `[sStart, sEnd]` (for WaterMesh foam uniforms,
   * Hydrodynamics eddies/pillows, and DuckController collision checks).
   */
  public getObstaclesInRange(sStart: number, sEnd: number): readonly HydroObstacle[] {
    const result: HydroObstacle[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const obs = this.entries[i].data;
      const pad = Math.max(obs.radius, 1.5);
      if (obs.s + pad >= sStart && obs.s - pad <= sEnd) {
        result.push(obs);
      }
    }
    return result;
  }

  /**
   * All currently active obstacles.
   */
  public getAllObstacles(): readonly HydroObstacle[] {
    return this.entries.map((e) => e.data);
  }

  /**
   * Query spawned obstacle cluster metadata so Collectibles can align racing lines,
   * jump arcs, and dive lines with every obstacle!
   */
  public getClustersInRange(sStart: number, sEnd: number): readonly ObstacleClusterMeta[] {
    const out: ObstacleClusterMeta[] = [];
    for (let i = 0; i < this.clusters.length; i++) {
      const c = this.clusters[i];
      if (c.s >= sStart && c.s <= sEnd) {
        out.push(c);
      }
    }
    return out;
  }

  /**
   * Check accurate, player-fair 3D collision between the duck and active obstacles.
   * Respects the strict kayaking grammar:
   * - `boulder` / `snag`: solid from riverbed to `height` (slalom around or fly over)
   * - `log_dive` / `arch`: solid beam/bridge/overhang above water; crystal-clear open passage underwater!
   * - `log_jump`: solid floating trunk/beaver dam/reeds/step stones + submerged barrier blocking dive; jump over!
   * - `lily_pad`: springy bounce pad on surface, tangled stems block underwater diving!
   */
  public checkDuckCollision(duck: DuckState): ObstacleCollisionHit | null {
    if (duck.isCrashed || duck.inCave) return null;
    if ((duck.invulnerableRemaining ?? 0) > 0) return null;

    const duckR = DUCK_CONFIG.collisionRadius * 0.92;
    const duckBottom = duck.y - 0.14;
    const duckTop = duck.y + 0.9;

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const obs = entry.data;
      const ds = duck.s - obs.s;
      const maxS = Math.max(obs.radius, 1.5) + duckR + 0.5;
      if (Math.abs(ds) > maxS) continue;

      switch (obs.type) {
        case 'boulder':
        case 'snag': {
          const du = duck.u - obs.u;
          const hitR = obs.radius * 0.86 + duckR;
          if (ds * ds + du * du <= hitR * hitR) {
            if (duckBottom < obs.height * 0.86) {
              return { obstacle: obs, kind: 'hit' };
            }
          }
          break;
        }

        case 'log_dive':
        case 'arch': {
          const alongHit = Math.abs(ds) <= obs.radius * 0.8 + duckR;
          const spanHit = Math.abs(duck.u - obs.u) <= obs.width * 0.48 + duckR * 0.5;
          if (alongHit && spanHit) {
            const logBottom = Math.max(0.58, obs.y - obs.height * 0.44);
            const logTop = obs.y + obs.height * 0.58;
            if (duckTop > logBottom && duckBottom < logTop) {
              return { obstacle: obs, kind: 'hit' };
            }
          }
          break;
        }

        case 'log_jump': {
          const alongHit = Math.abs(ds) <= obs.radius * 0.85 + duckR;
          const spanHit = Math.abs(duck.u - obs.u) <= obs.width * 0.48 + duckR * 0.4;
          if (alongHit && spanHit) {
            const jumpTop = obs.clearanceAbove * 0.86;
            if (duckBottom < jumpTop) {
              return { obstacle: obs, kind: 'hit' };
            }
          }
          break;
        }

        case 'lily_pad': {
          const alongHit = Math.abs(ds) <= obs.radius * 0.82 + duckR;
          const spanHit = Math.abs(duck.u - obs.u) <= obs.width * 0.48 + duckR * 0.4;
          if (alongHit && spanHit) {
            if (duck.y < -0.32) {
              return { obstacle: obs, kind: 'hit' };
            }
            if (!entry.bounceTriggered && duck.y <= 0.48 && duck.mode !== 'flying') {
              entry.bounceTriggered = true;
              return { obstacle: obs, kind: 'lily_bounce' };
            }
          }
          break;
        }
      }
    }

    return null;
  }

  /**
   * Evaluate near-misses (passing within ~1.3u of boulders/canoes/snags or skimming closely
   * under bridges/logs / over beaver dams & roots) and clean jump/dive clears.
   */
  public evaluateDuckInteractions(duck: DuckState): ObstacleInteractionEvent[] {
    const events: ObstacleInteractionEvent[] = [];
    if (duck.isCrashed || duck.inCave) return events;

    const duckRadius = DUCK_CONFIG.collisionRadius;
    const nearMissWindow = Math.max(OBSTACLE_CONFIG.nearMissMargin, 1.3);

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const obs = entry.data;
      const ds = duck.s - obs.s;

      if (ds < -3.0 || ds > 4.0) continue;

      if (obs.type === 'boulder' || obs.type === 'snag') {
        if (!entry.nearMissAwarded && ds >= -0.35 && ds <= 1.6) {
          if (duck.y < obs.height + 0.45) {
            const du = duck.u - obs.u;
            const horizDist = Math.hypot(ds, du);
            const edgeClearance = horizDist - (obs.radius + duckRadius);
            if (edgeClearance > 0.02 && edgeClearance <= nearMissWindow) {
              entry.nearMissAwarded = true;
              events.push({
                kind: 'near_miss',
                obstacle: obs,
                isSkim: edgeClearance <= 0.55,
                worldPos: { ...duck.worldPos },
              });
            }
          }
        }
      } else if (obs.type === 'log_dive' || obs.type === 'arch') {
        if (!entry.clearAwarded && ds >= 0.35 && ds <= 2.4) {
          const halfSpan = obs.width * 0.5 + 0.3;
          if (Math.abs(duck.u - obs.u) <= halfSpan && duck.y <= -0.25) {
            entry.clearAwarded = true;
            const isSkim = duck.y > -0.92;
            events.push({
              kind: 'log_dive_clear',
              obstacle: obs,
              isSkim,
              worldPos: { ...duck.worldPos },
            });
          }
        }
      } else if (obs.type === 'log_jump' || obs.type === 'lily_pad') {
        if (!entry.clearAwarded && ds >= 0.35 && ds <= 2.4) {
          const halfSpan = obs.width * 0.5 + 0.35;
          if (
            Math.abs(duck.u - obs.u) <= halfSpan &&
            duck.y >= Math.max(0.5, obs.clearanceAbove - 0.4) &&
            duck.mode !== 'flying'
          ) {
            entry.clearAwarded = true;
            const isSkim = duck.y <= obs.clearanceAbove + 0.65;
            events.push({
              kind: 'log_jump_clear',
              obstacle: obs,
              isSkim,
              worldPos: { ...duck.worldPos },
            });
          }
        }
      }
    }

    return events;
  }

  public dispose(): void {
    this.clearAll();
    this.parts.dispose();
  }

  private clearAll(): void {
    for (const entry of this.entries) {
      this.group.remove(entry.mesh);
      disposeOwnedGeometries(entry.mesh);
    }
    this.entries.length = 0;
    this.clusters.length = 0;
  }

  private resolveBobStyle(obs: HydroObstacle): SpawnedObstacleEntry['bobStyle'] {
    if (isFloatingBarrelAsset(obs.assetId)) return 'barrel';
    if (isBoatAsset(obs.assetId)) return 'canoe';
    if (
      (obs.type === 'log_jump' && !isSteppingStonesAsset(obs.assetId)) ||
      obs.type === 'lily_pad'
    ) {
      return 'gentle';
    }
    return 'none';
  }

  /**
   * 100% data-driven region lookup honoring `RiverSpline`'s leg-aware / `single_track`
   * resolution (`sample.regionId`/`secondaryRegionId`/`regionBlend`), falling back to
   * direct planetary `(lat, lng)` lookup via `earthWorld.getBlendedRegionAt`.
   */
  private getRegionAt(s: number, sample?: RiverSample): BlendedEarthRegion {
    const resolvedSample = sample ?? this.river.sampleAt(s);
    if (resolvedSample.regionId) {
      const primary = earthWorld.getZoneById(resolvedSample.regionId);
      const secondary = resolvedSample.secondaryRegionId
        ? earthWorld.getZoneById(resolvedSample.secondaryRegionId)
        : primary;
      const blend =
        resolvedSample.regionBlend !== undefined &&
        Number.isFinite(resolvedSample.regionBlend)
          ? THREE.MathUtils.clamp(resolvedSample.regionBlend, 0, 1)
          : 0;
      return blendEarthRegionZones(primary, secondary, blend);
    }
    if (
      resolvedSample.lat !== undefined &&
      resolvedSample.lng !== undefined &&
      Number.isFinite(resolvedSample.lat) &&
      Number.isFinite(resolvedSample.lng)
    ) {
      return earthWorld.getBlendedRegionAt(resolvedSample.lat, resolvedSample.lng);
    }
    const zone = earthWorld.getZoneById(resolvedSample.trackId);
    return blendEarthRegionZones(zone, zone, 0);
  }

  private computeRowSpacing(s: number): number {
    const zone = this.getRegionAt(s).primaryZone;
    const density = THREE.MathUtils.clamp(
      zone.obstacles.obstacleDensity || 1.0,
      0.6,
      1.5,
    );
    const t = THREE.MathUtils.clamp((s - 80) / 2200, 0, 1);
    const base =
      THREE.MathUtils.lerp(
        OBSTACLE_CONFIG.initialRowSpacing,
        OBSTACLE_CONFIG.minRowSpacing + 1.0,
        t,
      ) / density;
    const jitter = (this.rng() - 0.5) * 2.8;
    return Math.max(OBSTACLE_CONFIG.minRowSpacing * 0.85, base + jitter);
  }

  /**
   * Ensure we NEVER place obstacles:
   * - On waterfall approaches/lips/drops/plunge pools
   * - Blocking submerged cave entrances & exits
   * - Within ±25u of any physical `EarthJunction` river fork so players can cleanly read
   *   the Fork Signpost and steer LEFT or RIGHT into their chosen real connected river!
   */
  private isForbiddenZone(s: number): boolean {
    if (s < OBSTACLE_CONFIG.safeStartDistance) return true;

    const centerSample = this.river.sampleAt(s);
    if (centerSample.upcomingFork && centerSample.upcomingFork.distanceU < 28) {
      return true;
    }

    // Check fork approach + post-fork recovery (±25u across waterway transitions) & waterfalls
    // Generous downstream recovery buffer (44u past waterfall drop!) so players never land
    // from a waterfall plunge directly onto a boulder or stepping stones!
    let prevWaterwayId = centerSample.waterwayId;
    for (let probe = s - 44; probe <= s + 28; probe += 4) {
      if (probe < 0) continue;
      const sample = this.river.sampleAt(probe);
      const plungeIntensity =
        (sample as { plungePoolIntensity?: number }).plungePoolIntensity ?? 0;
      if (
        sample.isWaterfall ||
        plungeIntensity > 0.1 ||
        Math.abs(sample.slope) > 0.22
      ) {
        return true;
      }
      if (sample.upcomingFork && sample.upcomingFork.distanceU < 26) {
        return true;
      }
      if (
        prevWaterwayId &&
        sample.waterwayId &&
        sample.waterwayId !== prevWaterwayId &&
        Math.abs(probe - s) <= 25
      ) {
        return true;
      }
      prevWaterwayId = sample.waterwayId ?? prevWaterwayId;
    }

    // Cave entrance & exit clearance
    const caves = this.river.getCaveBranches(s - 28, s + 22);
    for (let i = 0; i < caves.length; i++) {
      const cave = caves[i];
      if (s >= cave.startS - 20 && s <= cave.startS + 14) {
        return true;
      }
      if (s >= cave.endS - 10 && s <= cave.endS + 26) {
        return true;
      }
    }

    return false;
  }

  /**
   * Pick a readable, varied kayaking pattern using the spatial region's obstacle pools
   * and validate strict passability before committing it to the river!
   */
  private spawnClusterAt(s: number): ObstacleClusterMeta | null {
    const sample = this.river.sampleAt(s);
    const zone = this.getRegionAt(s, sample).primaryZone;
    const navHalfW = Math.max(2.6, sample.width * 0.5 - DUCK_CONFIG.bankPadding);

    const hasBouncePad = zone.obstacles.jumpLogAssets.some((id) =>
      isBouncePadAsset(id),
    );
    const hasFeaturedArch = zone.obstacles.diveArchAssets.some(
      (id) => id !== 'fallen_log_arch',
    );

    // Varied readable opening (shuffled per run seed so every restart feels fresh!)
    let pattern: ObstaclePatternKind;
    if (this.rowIndex === 0) {
      const r0 = this.rng();
      if (r0 < 0.45) {
        pattern = zone.obstacles.chuteBias >= 0.55 ? 'slalom_pair' : 'single_boulder';
      } else if (r0 < 0.78) {
        pattern = 'slalom_pair';
      } else {
        pattern = hasBouncePad ? 'lily_thicket' : 'jump_log';
      }
    } else if (this.rowIndex === 1) {
      const r1 = this.rng();
      if (r1 < 0.5) {
        pattern = hasBouncePad ? 'lily_thicket' : 'jump_log';
      } else if (r1 < 0.8) {
        pattern = 'dive_log';
      } else {
        pattern = 'snag_chicane';
      }
    } else if (this.rowIndex === 2) {
      const r2 = this.rng();
      if (r2 < 0.45) {
        pattern = hasFeaturedArch ? 'dive_arch' : 'dive_log';
      } else if (r2 < 0.75) {
        pattern = 'jump_log';
      } else {
        pattern = 'rock_island';
      }
    } else {
      pattern = this.chooseNextPattern(s, sample, zone);
    }

    const candidate = this.buildPatternCandidate(
      pattern,
      s,
      sample,
      zone,
      navHalfW,
    );
    if (!candidate) return null;

    // Guaranteed Passability Validator!
    const validated = this.validateAndAdjustCluster(candidate, sample, navHalfW);
    if (!validated) return null;

    const clusterId = `cluster_${this.rowIndex}_${Math.round(s)}`;
    validated.id = clusterId;

    for (const obs of validated.obstacles) {
      const isIsland =
        validated.pattern === 'rock_island' &&
        obs.type === 'boulder' &&
        obs.radius >= 2.1 &&
        !isBoatAsset(obs.assetId) &&
        !isFloatingBarrelAsset(obs.assetId);
      const mesh = this.buildObstacleMesh(obs, sample, isIsland);
      this.group.add(mesh);
      this.entries.push({
        data: obs,
        mesh,
        clusterId,
        nearMissAwarded: false,
        clearAwarded: false,
        bounceTriggered: false,
        bobStyle: this.resolveBobStyle(obs),
      });
    }

    this.clusters.push(validated);
    this.lastOpenLaneU = validated.recommendedLineU;
    this.lastManeuver = validated.maneuver;
    this.lastManeuverS = s;

    return validated;
  }

  private chooseNextPattern(
    s: number,
    sample: RiverSample,
    zone: EarthRegionZone,
  ): ObstaclePatternKind {
    const difficulty = THREE.MathUtils.clamp((s - 100) / 1800, 0, 1);
    const chuteBias = THREE.MathUtils.clamp(zone.obstacles.chuteBias ?? 0.4, 0, 1);
    const canSwitchVertical = s - this.lastManeuverS >= 24;
    const canDive = sample.depth >= 2.85 && (this.lastManeuver !== 'jump' || canSwitchVertical);
    const canJump = this.lastManeuver !== 'dive' || canSwitchVertical;
    const wideEnoughForIsland = sample.width >= 11.8;

    const hasFeaturedArch = zone.obstacles.diveArchAssets.some(
      (id) => id !== 'fallen_log_arch',
    );
    const hasLogDive = zone.obstacles.diveArchAssets.some(
      (id) => id === 'fallen_log_arch' || id === 'willow_overhang',
    );
    const hasBouncePad = zone.obstacles.jumpLogAssets.some((id) =>
      isBouncePadAsset(id),
    );

    const weights: Array<{ pattern: ObstaclePatternKind; weight: number }> = [
      { pattern: 'single_boulder', weight: 1.35 - difficulty * 0.4 },
      { pattern: 'slalom_pair', weight: 1.35 + chuteBias * 1.15 + difficulty * 0.6 },
      { pattern: 'snag_chicane', weight: 1.15 + chuteBias * 0.55 + difficulty * 0.45 },
    ];

    if (wideEnoughForIsland) {
      weights.push({
        pattern: 'rock_island',
        weight: 1.2 + chuteBias * 0.9 + difficulty * 0.45,
      });
    }
    if (canDive) {
      if (hasFeaturedArch) {
        weights.push({ pattern: 'dive_arch', weight: 1.65 + difficulty * 0.35 });
      } else {
        weights.push({ pattern: 'dive_arch', weight: 0.8 + difficulty * 0.35 });
      }
      if (hasLogDive || zone.obstacles.diveArchAssets.length > 0) {
        weights.push({
          pattern: 'dive_log',
          weight: hasFeaturedArch ? 1.15 : 1.55,
        });
      }
    }
    if (canJump) {
      weights.push({
        pattern: 'jump_log',
        weight: hasBouncePad ? 1.4 : 1.7,
      });
      if (hasBouncePad) {
        weights.push({ pattern: 'lily_thicket', weight: 1.65 });
      }
    }
    if (sample.width >= 12.4 && canJump && canDive) {
      weights.push({
        pattern: 'split_choice',
        weight: 0.85 + chuteBias * 0.45 + difficulty * 0.65,
      });
    }

    let total = 0;
    for (const w of weights) total += Math.max(0.05, w.weight);
    let roll = this.rng() * total;
    for (const w of weights) {
      roll -= Math.max(0.05, w.weight);
      if (roll <= 0) return w.pattern;
    }
    return 'single_boulder';
  }

  private buildPatternCandidate(
    pattern: ObstaclePatternKind,
    s: number,
    sample: RiverSample,
    zone: EarthRegionZone,
    navHalfW: number,
  ): ObstacleClusterMeta | null {
    const obstacles: HydroObstacle[] = [];
    let recommendedLineU = 0;
    let highRewardChuteU: number | undefined;
    let maneuver: 'slalom' | 'jump' | 'dive' = 'slalom';

    // Alternate preferred slalom side organically
    this.slalomSign = this.slalomSign === 1 ? -1 : 1;
    const side: -1 | 1 = this.rng() < 0.72 ? this.slalomSign : (this.slalomSign === 1 ? -1 : 1);

    switch (pattern) {
      case 'single_boulder': {
        const radius = THREE.MathUtils.lerp(
          OBSTACLE_CONFIG.boulder.minRadius + 0.15,
          Math.min(OBSTACLE_CONFIG.boulder.maxRadius, navHalfW * 0.44),
          this.rng(),
        );
        const u = side * THREE.MathUtils.lerp(0.6, navHalfW - radius - 0.6, this.rng() * 0.85);
        obstacles.push(this.createBoulderData(s, u, radius, sample, zone));
        recommendedLineU = -Math.sign(u || side) * Math.min(navHalfW * 0.52, Math.abs(u) + radius + 1.3);
        break;
      }

      case 'slalom_pair': {
        const r1 = THREE.MathUtils.lerp(1.4, Math.min(2.1, navHalfW * 0.36), this.rng());
        const r2 = THREE.MathUtils.lerp(1.3, Math.min(1.95, navHalfW * 0.34), this.rng());
        const u1 = side * (navHalfW - r1 * 0.75);
        const u2 = -side * (navHalfW - r2 * 0.75);
        obstacles.push(this.createBoulderData(s, u1, r1, sample, zone));
        obstacles.push(this.createBoulderData(s + 5.8, u2, r2, sample, zone));
        recommendedLineU = -side * Math.min(navHalfW * 0.45, 2.2);
        break;
      }

      case 'rock_island': {
        const islandRadius = THREE.MathUtils.lerp(2.15, Math.min(2.75, navHalfW * 0.42), this.rng());
        const islandU = side * THREE.MathUtils.lerp(0.55, 1.25, this.rng());
        // Prefer solid geological rock/pillar asset for central island
        const solidAsset =
          zone.obstacles.boulderAssets.find(
            (id) => !isBoatAsset(id) && !isFloatingBarrelAsset(id),
          ) ?? zone.obstacles.boulderAssets[0] ?? 'mossy_boulder_a';
        obstacles.push(this.createBoulderData(s, islandU, islandRadius, sample, zone, solidAsset));

        const leftEdge = islandU - islandRadius;
        const rightEdge = islandU + islandRadius;
        const leftGapCenter = (-navHalfW + leftEdge) * 0.5;
        const rightGapCenter = (rightEdge + navHalfW) * 0.5;
        const leftWidth = leftEdge - -navHalfW;
        const rightWidth = navHalfW - rightEdge;

        if (leftWidth >= rightWidth) {
          recommendedLineU = leftGapCenter;
          if (rightWidth >= 2.5) highRewardChuteU = rightGapCenter;
        } else {
          recommendedLineU = rightGapCenter;
          if (leftWidth >= 2.5) highRewardChuteU = leftGapCenter;
        }
        break;
      }

      case 'dive_log': {
        const isIntro = this.rowIndex <= 2;
        const span = isIntro ? sample.width * 0.82 : sample.width * 0.96;
        const u = isIntro ? side * 0.35 : 0;
        const obs = this.createLogDiveData(s, u, span, sample, zone, 'log_dive');
        obstacles.push(obs);
        recommendedLineU = THREE.MathUtils.clamp(u, -navHalfW * 0.35, navHalfW * 0.35);
        maneuver = 'dive';
        break;
      }

      case 'dive_arch': {
        const span = sample.width * 1.04;
        const obs = this.createLogDiveData(s, 0, span, sample, zone, 'arch');
        obstacles.push(obs);
        recommendedLineU = 0;
        maneuver = 'dive';
        break;
      }

      case 'jump_log': {
        const isIntro = this.rowIndex <= 2;
        const span = isIntro
          ? sample.width * 0.68
          : THREE.MathUtils.lerp(sample.width * 0.68, sample.width * 0.92, this.rng());
        const maxShift = Math.max(0, navHalfW - span * 0.5);
        const u = maxShift > 0.4 ? side * maxShift * 0.65 : 0;
        obstacles.push(this.createLogJumpData(s, u, span, sample, zone));
        recommendedLineU = THREE.MathUtils.clamp(u, -navHalfW * 0.4, navHalfW * 0.4);
        maneuver = 'jump';
        break;
      }

      case 'lily_thicket': {
        const span = THREE.MathUtils.lerp(4.4, Math.min(6.8, sample.width * 0.58), this.rng());
        const u = side * THREE.MathUtils.lerp(0.2, Math.max(0.4, navHalfW - span * 0.45), this.rng());
        const padAsset =
          zone.obstacles.jumpLogAssets.find((id) => isBouncePadAsset(id)) ??
          'giant_lily_pad';
        obstacles.push(this.createLilyPadData(s, u, span, sample, padAsset));
        if (sample.width >= 13.5) {
          const br = 1.55;
          const bu = -side * (navHalfW - br * 0.65);
          obstacles.push(this.createBoulderData(s + 2.4, bu, br, sample, zone));
        }
        recommendedLineU = u;
        maneuver = 'jump';
        break;
      }

      case 'snag_chicane': {
        const snagU = side * THREE.MathUtils.lerp(0.8, navHalfW * 0.55, this.rng());
        obstacles.push(this.createSnagData(s, snagU, sample, zone));
        if (sample.width >= 11.8) {
          const br = THREE.MathUtils.lerp(1.4, 1.9, this.rng());
          const bu = -side * (navHalfW - br * 0.55);
          obstacles.push(this.createBoulderData(s + 5.2, bu, br, sample, zone));
        }
        recommendedLineU = -Math.sign(snagU || side) * Math.min(navHalfW * 0.48, 2.5);
        break;
      }

      case 'split_choice': {
        const jumpSpan = Math.min(5.8, sample.width * 0.46);
        const jumpU = side * (navHalfW - jumpSpan * 0.48);
        const br = THREE.MathUtils.lerp(1.45, 1.9, this.rng());
        const boulderU = -side * (navHalfW - br * 0.6);
        const padAsset = zone.obstacles.jumpLogAssets.find((id) =>
          isBouncePadAsset(id),
        );
        if (padAsset && this.rng() < 0.5) {
          obstacles.push(this.createLilyPadData(s, jumpU, jumpSpan, sample, padAsset));
        } else {
          obstacles.push(this.createLogJumpData(s, jumpU, jumpSpan, sample, zone));
        }
        obstacles.push(this.createBoulderData(s + 1.5, boulderU, br, sample, zone));
        recommendedLineU = jumpU;
        highRewardChuteU = (jumpU - side * (jumpSpan * 0.5) + (boulderU + side * br)) * 0.5;
        maneuver = 'jump';
        break;
      }
    }

    return {
      id: '',
      s,
      pattern,
      recommendedLineU,
      highRewardChuteU,
      maneuver,
      obstacles,
    };
  }

  /**
   * Guaranteed Passability Validator:
   * Verifies every committed cluster provides EITHER:
   * - A clean lateral corridor >= max(3.2 * duckRadius, 2.75u) reachable from previous lane, OR
   * - Clean Jump clearance (clearanceAbove <= 1.35u), OR
   * - Clean Dive clearance (clearanceBelow >= 1.6u with riverbed depth >= 2.7u).
   */
  private validateAndAdjustCluster(
    cluster: ObstacleClusterMeta,
    sample: RiverSample,
    navHalfW: number,
  ): ObstacleClusterMeta | null {
    const minCorridor = Math.max(3.2 * DUCK_CONFIG.collisionRadius, 2.75);
    const duckPad = DUCK_CONFIG.collisionRadius + 0.22;

    if (cluster.maneuver === 'dive') {
      const allDiveable = cluster.obstacles.every(
        (o) => (o.type === 'log_dive' || o.type === 'arch') && o.clearanceBelow >= 1.6,
      );
      if (allDiveable && sample.depth >= 2.7) {
        return cluster;
      }
      return null;
    }

    if (cluster.maneuver === 'jump') {
      const allJumpableOrOffset = cluster.obstacles.every(
        (o) =>
          o.type === 'log_jump' ||
          o.type === 'lily_pad' ||
          Math.abs(o.u - cluster.recommendedLineU) >= o.radius + duckPad + 1.1,
      );
      if (allJumpableOrOffset) {
        return cluster;
      }
      if (cluster.obstacles.length > 1) {
        cluster.obstacles = [cluster.obstacles[0]];
        return cluster;
      }
      return null;
    }

    const findBestCorridor = (obsList: HydroObstacle[]): Interval | null => {
      const blocked: Interval[] = [];
      for (const o of obsList) {
        if (Math.abs(o.s - cluster.s) > 4.2) continue;
        const halfExtent =
          o.type === 'boulder' || o.type === 'snag'
            ? o.radius + duckPad
            : o.width * 0.5 + duckPad;
        blocked.push({
          min: Math.max(-navHalfW, o.u - halfExtent),
          max: Math.min(navHalfW, o.u + halfExtent),
        });
      }
      blocked.sort((a, b) => a.min - b.min);

      const merged: Interval[] = [];
      for (const seg of blocked) {
        if (merged.length === 0 || seg.min > merged[merged.length - 1].max) {
          merged.push({ ...seg });
        } else {
          merged[merged.length - 1].max = Math.max(merged[merged.length - 1].max, seg.max);
        }
      }

      const gaps: Interval[] = [];
      let cursor = -navHalfW;
      for (const seg of merged) {
        if (seg.min - cursor >= minCorridor) {
          gaps.push({ min: cursor, max: seg.min });
        }
        cursor = Math.max(cursor, seg.max);
      }
      if (navHalfW - cursor >= minCorridor) {
        gaps.push({ min: cursor, max: navHalfW });
      }

      if (gaps.length === 0) return null;

      const deltaS = Math.max(8, cluster.s - this.lastManeuverS);
      const maxReachDeltaU = (deltaS / DUCK_CONFIG.baseSpeed) * DUCK_CONFIG.maxLateralSpeed * 0.82;

      let best: Interval | null = null;
      let bestScore = -Infinity;
      for (const g of gaps) {
        const center = (g.min + g.max) * 0.5;
        const width = g.max - g.min;
        const distFromPrev = Math.abs(center - this.lastOpenLaneU);
        const reachPenalty = distFromPrev > maxReachDeltaU ? 10 : 0;
        const score = width - reachPenalty - distFromPrev * 0.12;
        if (score > bestScore) {
          bestScore = score;
          best = g;
        }
      }
      return best;
    };

    let corridor = findBestCorridor(cluster.obstacles);
    if (!corridor && cluster.obstacles.length > 1) {
      cluster.obstacles = [cluster.obstacles[0]];
      corridor = findBestCorridor(cluster.obstacles);
    }

    if (!corridor) return null;

    cluster.recommendedLineU = THREE.MathUtils.clamp(
      (corridor.min + corridor.max) * 0.5,
      -navHalfW + 0.6,
      navHalfW - 0.6,
    );
    return cluster;
  }

  /**
   * Shuffle-balanced picker so players experience rich obstacle variety across
   * every river instead of repeating the same rock/log twice in a row.
   */
  private pickVariedFromPool(
    pool: readonly AssetId[],
    fallback: AssetId,
    channel: 'boulder' | 'dive' | 'jump',
  ): AssetId {
    if (!pool || pool.length === 0) return fallback;
    if (pool.length === 1) return pool[0];
    let idx: number;
    if (channel === 'boulder') {
      idx = (this.boulderCycleIdx++ + Math.floor(this.rng() * 2)) % pool.length;
    } else if (channel === 'dive') {
      idx = this.diveCycleIdx++ % pool.length;
    } else {
      idx = this.jumpCycleIdx++ % pool.length;
    }
    return pool[idx];
  }

  private createBoulderData(
    s: number,
    u: number,
    radius: number,
    sample: RiverSample,
    zone: EarthRegionZone,
    forcedAsset?: AssetId,
  ): HydroObstacle {
    const assetId: AssetId =
      forcedAsset ??
      this.pickVariedFromPool(
        zone.obstacles.boulderAssets,
        'mossy_boulder_a',
        'boulder',
      );

    const streamYaw = Math.atan2(sample.tangent.x, sample.tangent.z);
    let finalRadius = radius;
    let height: number;
    let yaw = this.rng() * Math.PI * 2;
    let foamStrength = THREE.MathUtils.clamp(
      OBSTACLE_CONFIG.boulder.foamStrength * (0.85 + radius * 0.08),
      0.75,
      1.0,
    );

    if (isFloatingBarrelAsset(assetId)) {
      finalRadius = THREE.MathUtils.clamp(radius * 0.72, 1.05, 1.38);
      height = THREE.MathUtils.lerp(1.45, 1.85, this.rng());
      foamStrength = 0.78;
    } else if (isBoatAsset(assetId)) {
      finalRadius = THREE.MathUtils.clamp(radius * 0.96, 1.55, 2.05);
      height = THREE.MathUtils.lerp(1.65, 2.15, this.rng());
      yaw = streamYaw + (u >= 0 ? -0.42 : 0.42) + (this.rng() - 0.5) * 0.25;
      foamStrength = 0.94;
    } else if (isSpireOrColumnAsset(assetId)) {
      height = THREE.MathUtils.lerp(3.2, OBSTACLE_CONFIG.boulder.maxHeight + 0.5, this.rng());
    } else {
      height = THREE.MathUtils.lerp(OBSTACLE_CONFIG.boulder.minHeight, 3.35, this.rng());
    }

    const worldPos = this.river.riverToWorld(s, u, 0);
    return {
      id: `obs_${++this.obstacleSeq}`,
      type: 'boulder',
      s,
      u,
      y: 0,
      radius: finalRadius,
      width: finalRadius * 2,
      height,
      clearanceBelow: 0,
      clearanceAbove: height + 0.5,
      worldPos,
      foamStrength,
      hasEddy: true,
      yaw,
      scale: 1,
      assetId,
    };
  }

  private createSnagData(
    s: number,
    u: number,
    sample: RiverSample,
    zone: EarthRegionZone,
    forcedAsset?: AssetId,
  ): HydroObstacle {
    const radius = OBSTACLE_CONFIG.snag.radius * THREE.MathUtils.lerp(0.95, 1.25, this.rng());
    const height = OBSTACLE_CONFIG.snag.height * THREE.MathUtils.lerp(0.95, 1.3, this.rng());
    const baseYaw = Math.atan2(sample.tangent.x, sample.tangent.z);
    const worldPos = this.river.riverToWorld(s, u, 0);

    // Data-driven snag asset selection from the region's boulder pool (stump, canoe, or spire)
    let snagAsset = forcedAsset;
    if (!snagAsset) {
      const pool = zone.obstacles.boulderAssets;
      snagAsset =
        pool.find((id) => id === 'river_snag_stump') ??
        pool.find((id) => isSpireOrColumnAsset(id)) ??
        pool.find((id) => isBoatAsset(id)) ??
        'river_snag_stump';
    }

    return {
      id: `obs_${++this.obstacleSeq}`,
      type: 'snag',
      s,
      u,
      y: 0,
      radius,
      width: radius * 2,
      height,
      clearanceBelow: 0,
      clearanceAbove: height + 0.4,
      worldPos,
      foamStrength: OBSTACLE_CONFIG.snag.foamStrength,
      hasEddy: true,
      yaw: baseYaw + (this.rng() - 0.5) * 0.7,
      scale: 1,
      assetId: snagAsset,
    };
  }

  private createLogDiveData(
    s: number,
    u: number,
    width: number,
    sample: RiverSample,
    zone: EarthRegionZone,
    type: 'log_dive' | 'arch',
    forcedAsset?: AssetId,
  ): HydroObstacle {
    const isArch = type === 'arch';
    // Never pick tall open scenic pass-through bridges/gates as head-bonk dive obstacles;
    // they belong strictly in `Environment` as non-lethal scenic `over_river` landmarks!
    const rawPool = zone.obstacles.diveArchAssets ?? [];
    const safePool = rawPool.filter(
      (id) => id !== 'stone_footbridge' && id !== 'torii_gate',
    );
    const pool = safePool.length > 0 ? safePool : ['fallen_log_arch'];
    let assetId: AssetId = forcedAsset ?? 'fallen_log_arch';
    if (!forcedAsset && pool.length > 0) {
      if (isArch) {
        const archCandidates = pool.filter((id) => id !== 'fallen_log_arch');
        assetId =
          archCandidates.length > 0
            ? this.pickVariedFromPool(archCandidates, archCandidates[0], 'dive')
            : pool[0];
      } else {
        assetId = this.pickVariedFromPool(pool, 'fallen_log_arch', 'dive');
      }
    }

    const centerY = isArch ? 1.24 : THREE.MathUtils.lerp(1.12, 1.32, this.rng());
    const height = isArch ? 1.45 : 1.35;
    const clearanceBelow = Math.max(1.8, Math.min(sample.depth - 0.55, isArch ? 2.6 : 2.2));
    const worldPos = this.river.riverToWorld(s, u, centerY);
    const baseYaw = Math.atan2(sample.tangent.x, sample.tangent.z);

    return {
      id: `obs_${++this.obstacleSeq}`,
      type,
      s,
      u,
      y: centerY,
      radius: isArch ? 1.05 : 0.85,
      width,
      height,
      clearanceBelow,
      clearanceAbove: centerY + height * 0.55 + 0.7,
      worldPos,
      foamStrength: isArch ? OBSTACLE_CONFIG.arch.foamStrength : OBSTACLE_CONFIG.logDive.foamStrength,
      hasEddy: false,
      yaw: baseYaw + (this.rng() - 0.5) * 0.08,
      scale: 1,
      assetId,
    };
  }

  private createLogJumpData(
    s: number,
    u: number,
    width: number,
    sample: RiverSample,
    zone: EarthRegionZone,
    forcedAsset?: AssetId,
  ): HydroObstacle {
    const y = 0.2;
    const worldPos = this.river.riverToWorld(s, u, y);
    const baseYaw = Math.atan2(sample.tangent.x, sample.tangent.z);

    // Filter out bounce-pad lily pads (those use lily_thicket) and cycle through beaver_dam, driftwood_roots, mossy_step_stones, cattail_reeds, etc.
    const jumpCandidates = zone.obstacles.jumpLogAssets.filter(
      (id) => !isBouncePadAsset(id),
    );
    const assetId: AssetId =
      forcedAsset ??
      this.pickVariedFromPool(
        jumpCandidates.length > 0 ? jumpCandidates : zone.obstacles.jumpLogAssets,
        'driftwood_roots',
        'jump',
      );

    return {
      id: `obs_${++this.obstacleSeq}`,
      type: 'log_jump',
      s,
      u,
      y,
      radius: isSteppingStonesAsset(assetId)
        ? 0.95
        : OBSTACLE_CONFIG.logJump.radius,
      width,
      height: OBSTACLE_CONFIG.logJump.topHeightAboveWater,
      clearanceBelow: 0,
      clearanceAbove: OBSTACLE_CONFIG.logJump.clearanceAbove,
      worldPos,
      foamStrength: OBSTACLE_CONFIG.logJump.foamStrength,
      hasEddy: true,
      yaw: baseYaw + (this.rng() - 0.5) * 0.1,
      scale: 1,
      assetId,
    };
  }

  private createLilyPadData(
    s: number,
    u: number,
    width: number,
    sample: RiverSample,
    assetId: AssetId = 'giant_lily_pad',
  ): HydroObstacle {
    const y = 0.06;
    const worldPos = this.river.riverToWorld(s, u, y);
    const baseYaw = Math.atan2(sample.tangent.x, sample.tangent.z);

    return {
      id: `obs_${++this.obstacleSeq}`,
      type: 'lily_pad',
      s,
      u,
      y,
      radius: Math.max(1.3, width * 0.3),
      width,
      height: 0.45,
      clearanceBelow: 0,
      clearanceAbove: 0.88,
      worldPos,
      foamStrength: OBSTACLE_CONFIG.lilyPad.foamStrength,
      hasEddy: false,
      yaw: baseYaw,
      scale: 1,
      assetId,
    };
  }

  /**
   * Build the 3D scene representation for an obstacle using all 37 shared + regional
   * Meshy PBR assets, strictly enforcing the Kayaking Visual Readability Grammar!
   */
  private buildObstacleMesh(
    obs: HydroObstacle,
    sample: RiverSample,
    isIsland: boolean,
  ): THREE.Group {
    const root = new THREE.Group();
    root.name = `${obs.type}_${obs.id}`;
    root.position.set(obs.worldPos.x, obs.worldPos.y, obs.worldPos.z);

    const zone = this.getRegionAt(obs.s, sample).primaryZone;
    const baseMat = this.parts.getRockBaseMaterial(zone);

    switch (obs.type) {
      case 'boulder': {
        const assetId: AssetId =
          obs.assetId ?? zone.obstacles.boulderAssets[0] ?? 'mossy_boulder_a';
        const loaded = assetLoader.get(assetId);
        const clone = loaded.prototype.clone(true);

        if (isFloatingBarrelAsset(assetId)) {
          // Bobbing weathered oak barrel half-submerged in the current (no rock cylinder below!)
          const maxDim = Math.max(0.5, loaded.size.x, loaded.size.y, loaded.size.z);
          const barrelScale = (obs.radius * 1.95) / maxDim;
          clone.scale.setScalar(barrelScale);
          clone.rotation.set(0.18, obs.yaw ?? 0, 0.24);
          clone.position.y = -0.14;
          root.add(clone);
          break;
        }

        if (isBoatAsset(assetId)) {
          // Weathered half-submerged wooden canoe wedged against river stones
          const maxDim = Math.max(0.5, loaded.size.x, loaded.size.z);
          const canoeScale = (obs.radius * 2.35) / maxDim;
          clone.scale.setScalar(canoeScale);
          clone.rotation.set(0.14, obs.yaw ?? 0, 0.22);
          clone.position.y = -0.22;
          root.add(clone);

          // Low river cobble wedged under canoe bow
          const wedgeStone = new THREE.Mesh(this.parts.archButtressGeom, baseMat);
          wedgeStone.scale.set(obs.radius * 0.48, 0.65, obs.radius * 0.48);
          wedgeStone.position.set(0, -0.45, 0.3);
          root.add(wedgeStone);
          break;
        }

        // Geological boulder / spire / column / stump
        const horizSize = Math.max(0.5, (loaded.size.x + loaded.size.z) * 0.5);
        const scaleXZ = (obs.radius * 2.02) / horizSize;
        const scaleY = obs.height / Math.max(0.5, loaded.size.y);
        clone.scale.set(scaleXZ, scaleY, scaleXZ);
        clone.rotation.y = obs.yaw ?? 0;
        clone.position.y = -0.32;
        root.add(clone);

        // Grounded wet underwater stone/ice/basalt base descending to riverbed
        const subDepth = Math.max(2.6, sample.depth + 0.4);
        const baseMesh = new THREE.Mesh(this.parts.rockBaseGeom, baseMat);
        baseMesh.scale.set(obs.radius * 0.9, subDepth, obs.radius * 0.9);
        baseMesh.position.y = -subDepth * 0.5 + 0.05;
        baseMesh.rotation.y = (obs.yaw ?? 0) * 0.5;
        baseMesh.receiveShadow = true;
        root.add(baseMesh);

        // Data-driven Rock Island embellishment: low-poly flanking stone + region's primary foliage/prop!
        if (isIsland) {
          const accent = new THREE.Mesh(this.parts.archButtressGeom, baseMat);
          accent.scale.set(0.85, 0.65, 0.85);
          accent.position.set(obs.radius * 0.68, 0.25, -obs.radius * 0.35);
          accent.rotation.y = (obs.yaw ?? 0) + 1.2;
          root.add(accent);

          const crestSpec = zone.scenery.bankFoliage[0];
          if (crestSpec) {
            const crestLoaded = assetLoader.get(crestSpec.assetId);
            const crest = crestLoaded.prototype.clone(true);
            const crestMaxY = Math.max(0.8, crestLoaded.size.y);
            const crestScale = THREE.MathUtils.clamp(1.75 / crestMaxY, 0.25, 0.85);
            crest.scale.setScalar(crestScale);
            crest.position.set(-obs.radius * 0.15, obs.height * 0.68, 0.15);
            crest.rotation.y = (obs.yaw ?? 0) + 0.7;
            root.add(crest);
          }
        }
        break;
      }

      case 'snag': {
        root.rotation.y = obs.yaw ?? 0;
        const subDepth = Math.max(2.6, sample.depth * 0.85);
        const snagAssetId: AssetId = obs.assetId ?? 'river_snag_stump';
        const loaded = assetLoader.get(snagAssetId);
        const snagModel = loaded.prototype.clone(true);

        if (isBoatAsset(snagAssetId)) {
          const maxDim = Math.max(0.5, loaded.size.x, loaded.size.z);
          snagModel.scale.setScalar((obs.radius * 2.4) / maxDim);
          snagModel.rotation.set(0.16, 0.35, 0.2);
          snagModel.position.y = -0.22;
          root.add(snagModel);
          break;
        }

        const horizSize = Math.max(0.5, (loaded.size.x + loaded.size.z) * 0.5);
        const scaleXZ = (obs.radius * 1.98) / horizSize;
        const scaleY = (obs.height * 1.15) / Math.max(0.5, loaded.size.y);
        snagModel.scale.set(scaleXZ, scaleY, scaleXZ);
        snagModel.position.y = -0.35;
        snagModel.rotation.x = 0.18;
        snagModel.rotation.z = 0.1;
        root.add(snagModel);

        // Underwater base / root anchor descending cleanly to riverbed
        if (snagAssetId === 'river_snag_stump') {
          const snagRoots: Array<{
            pos: [number, number, number];
            rot: [number, number, number];
            scale: [number, number, number];
          }> = [];
          for (let i = 0; i < 4; i++) {
            const ang = (i / 4) * Math.PI * 2 + 0.4;
            snagRoots.push({
              pos: [Math.cos(ang) * 0.42, -subDepth * 0.45, Math.sin(ang) * 0.42],
              rot: [Math.sin(ang) * 0.35, 0, Math.cos(ang) * 0.35],
              scale: [1.5, subDepth * 0.9, 1.5],
            });
          }
          const mergedSnagRoots = buildMergedSubMesh(
            this.parts.rootConeGeom,
            this.parts.submergedRootMat,
            snagRoots,
          );
          if (mergedSnagRoots) root.add(mergedSnagRoots);
        } else {
          const baseMesh = new THREE.Mesh(this.parts.rockBaseGeom, baseMat);
          baseMesh.scale.set(obs.radius * 0.85, subDepth, obs.radius * 0.85);
          baseMesh.position.y = -subDepth * 0.5 + 0.05;
          root.add(baseMesh);
        }
        break;
      }

      case 'log_dive':
      case 'arch': {
        this.alignGroupToRiver(
          root,
          sample,
          (obs.yaw ?? 0) - Math.atan2(sample.tangent.x, sample.tangent.z),
        );

        const archAssetId: AssetId =
          obs.assetId ?? zone.obstacles.diveArchAssets[0] ?? 'fallen_log_arch';
        const loaded = assetLoader.get(archAssetId);
        const archModel = loaded.prototype.clone(true);

        // Orient longest horizontal axis across X (bank-to-bank)
        let spanSize = loaded.size.x;
        let depthSize = loaded.size.z;
        if (loaded.size.z > loaded.size.x * 1.15) {
          archModel.rotation.y = Math.PI * 0.5;
          spanSize = loaded.size.z;
          depthSize = loaded.size.x;
        }

        const heightRatio = loaded.size.y / Math.max(0.5, spanSize);
        const isHorizontalLog = archAssetId === 'fallen_log_arch' || heightRatio < 0.28;

        if (isHorizontalLog) {
          const scaleX = obs.width / Math.max(0.5, spanSize);
          const targetVisualHeight = obs.type === 'arch' ? 2.05 : 1.55;
          const scaleY = THREE.MathUtils.clamp(
            targetVisualHeight / Math.max(0.4, loaded.size.y),
            0.42,
            1.35,
          );
          const targetDepth = obs.type === 'arch' ? 2.1 : 1.65;
          const scaleZ = THREE.MathUtils.clamp(
            targetDepth / Math.max(0.4, depthSize),
            0.42,
            1.35,
          );
          archModel.scale.set(scaleX, scaleY, scaleZ);
          archModel.position.y = obs.type === 'arch' ? 0.25 : 0.12;
          root.add(archModel);
        } else {
          // Low-slung overhanging branches / dive arches visually matched 1:1 to head-bonk height!
          const scaleX = (obs.width * 1.06) / Math.max(0.5, spanSize);
          const isTallGate = heightRatio > 0.72;
          const targetArchHeight =
            archAssetId === 'willow_overhang'
              ? 2.85
              : archAssetId === 'stone_footbridge'
                ? 4.7
                : isTallGate
                  ? 4.8
                  : 3.15;
          const scaleY = THREE.MathUtils.clamp(
            targetArchHeight / Math.max(0.8, loaded.size.y),
            0.35,
            1.35,
          );
          const targetDepth =
            archAssetId === 'stone_footbridge'
              ? 3.3
              : archAssetId === 'willow_overhang'
                ? 2.4
                : 2.5;
          const scaleZ = THREE.MathUtils.clamp(
            targetDepth / Math.max(0.5, depthSize),
            0.35,
            1.35,
          );

          archModel.scale.set(scaleX, scaleY, scaleZ);
          archModel.position.y =
            archAssetId === 'willow_overhang'
              ? -0.22
              : archAssetId === 'stone_footbridge'
                ? -0.45
                : isTallGate
                  ? -0.68
                  : -0.35;
          root.add(archModel);

          // For very tall gateways (e.g. Torii gate whose cross-beam sits high up),
          // place a low rustic cedar cross-beam at head level so dive-under readability is 100%!
          if (isTallGate) {
            const crossBeam = new THREE.Mesh(
              this.parts.snagTrunkGeom,
              this.parts.snagWoodMat,
            );
            crossBeam.rotation.z = Math.PI * 0.5;
            crossBeam.scale.set(1.25, obs.width * 0.9, 1.25);
            crossBeam.position.y = 0.08;
            root.add(crossBeam);
          }
        }

        // Grounded data-driven regional stone piers framing both banks (zero black spheres!)
        const endX = obs.width * 0.5 + 0.35;
        for (const side of [-1, 1]) {
          const pier = new THREE.Mesh(this.parts.archButtressGeom, baseMat);
          pier.scale.set(1.05, 0.82, 1.05);
          pier.position.set(side * endX, -obs.y + 0.45, 0);
          pier.rotation.y = side > 0 ? 0.65 : 2.35;
          root.add(pier);
        }
        break;
      }

      case 'log_jump': {
        this.alignGroupToRiver(
          root,
          sample,
          (obs.yaw ?? 0) - Math.atan2(sample.tangent.x, sample.tangent.z),
        );

        const jumpAssetId: AssetId = obs.assetId ?? 'driftwood_roots';
        const loaded = assetLoader.get(jumpAssetId);
        const subDepth = Math.max(2.85, Math.min(3.55, sample.depth * 0.94));

        if (isReedsAsset(jumpAssetId)) {
          // Dense clump of cattails & water reeds with submerged stalks blocking diving
          const clumpCount = Math.max(2, Math.min(3, Math.round(obs.width * 0.4)));
          for (let i = 0; i < clumpCount; i++) {
            const frac = clumpCount === 1 ? 0 : i / (clumpCount - 1) - 0.5;
            const clump = loaded.prototype.clone(true);
            const scaleY = THREE.MathUtils.clamp(1.32 / Math.max(0.5, loaded.size.y), 0.25, 0.85);
            clump.scale.set(scaleY * 1.25, scaleY, scaleY * 1.15);
            clump.position.set(frac * obs.width * 0.62, -0.18, ((i % 2) - 0.5) * 0.35);
            clump.rotation.y = i * 1.9;
            root.add(clump);
          }

          // Submerged green reed stalks blocking underwater passage
          const stalkCount = Math.max(10, Math.round(obs.width * 1.8));
          const stalkTransforms: Array<{
            pos: [number, number, number];
            rot: [number, number, number];
            scale: [number, number, number];
          }> = [];
          for (let i = 0; i < stalkCount; i++) {
            const frac = (i + 0.5) / stalkCount - 0.5;
            const sx = frac * obs.width * 0.88;
            const len = subDepth * (0.8 + (i % 3) * 0.06);
            stalkTransforms.push({
              pos: [sx, -len * 0.5, ((i % 3) - 1) * 0.2],
              rot: [((i % 2) - 0.5) * 0.14, 0, ((i % 3) - 1) * 0.16],
              scale: [1.35, len, 1.35],
            });
          }
          const mergedStalks = buildMergedSubMesh(
            this.parts.lilyStemGeom,
            this.parts.lilyStemMat,
            stalkTransforms,
          );
          if (mergedStalks) root.add(mergedStalks);
          break;
        }

        if (isSteppingStonesAsset(jumpAssetId)) {
          // Flat mossy stepping stones breaking the water surface over a submerged cobble ledge
          const stones = loaded.prototype.clone(true);
          let spanSize = loaded.size.x;
          let depthSize = loaded.size.z;
          if (loaded.size.z > loaded.size.x * 1.15) {
            stones.rotation.y = Math.PI * 0.5;
            spanSize = loaded.size.z;
            depthSize = loaded.size.x;
          }
          const scaleX = obs.width / Math.max(0.5, spanSize);
          const scaleY = THREE.MathUtils.clamp(0.95 / Math.max(0.2, loaded.size.y), 0.7, 2.2);
          const scaleZ = THREE.MathUtils.clamp(1.7 / Math.max(0.4, depthSize), 0.55, 1.45);
          stones.scale.set(scaleX, scaleY, scaleZ);
          stones.position.y = -0.05;
          root.add(stones);

          // Submerged cobble columns supporting the stepping stones (blocks diving underneath)
          const colTransforms: Array<{
            pos: [number, number, number];
            scale: [number, number, number];
          }> = [];
          const colCount = Math.max(4, Math.round(obs.width * 0.72));
          for (let i = 0; i < colCount; i++) {
            const frac = (i + 0.5) / colCount - 0.5;
            colTransforms.push({
              pos: [frac * obs.width * 0.84, -subDepth * 0.5 - 0.05, ((i % 2) - 0.5) * 0.25],
              scale: [0.62, subDepth, 0.62],
            });
          }
          const mergedCols = buildMergedSubMesh(
            this.parts.rockBaseGeom,
            baseMat,
            colTransforms,
          );
          if (mergedCols) root.add(mergedCols);
          break;
        }

        // Woven `beaver_dam` or classic `driftwood_roots` jump-over barrier!
        const logModel = loaded.prototype.clone(true);
        let spanSize = loaded.size.x;
        let depthSize = loaded.size.z;
        if (loaded.size.z > loaded.size.x * 1.15) {
          logModel.rotation.y = Math.PI * 0.5;
          spanSize = loaded.size.z;
          depthSize = loaded.size.x;
        }

        const isBeaverDam = jumpAssetId === 'beaver_dam';
        const scaleX = obs.width / Math.max(0.5, spanSize);
        const targetH = isBeaverDam ? 1.32 : 1.25;
        const scaleY = THREE.MathUtils.clamp(targetH / Math.max(0.4, loaded.size.y), 0.36, 1.35);
        const scaleZ = THREE.MathUtils.clamp(
          (isBeaverDam ? 1.85 : 1.45) / Math.max(0.4, depthSize),
          0.42,
          1.35,
        );
        logModel.scale.set(scaleX, scaleY, scaleZ);
        logModel.position.y = isBeaverDam ? 0.18 : 0.22;
        root.add(logModel);

        // CRITICAL READABILITY GRAMMAR:
        // Dense curtain of visibly tangled gnarled driftwood roots / woven beaver-dam sticks
        // extending from waterline deep underwater (-3.1u), merged into 2 GPU draw calls!
        const rootCount = Math.max(11, Math.round(obs.width * 1.9));
        const vertRoots: Array<{
          pos: [number, number, number];
          rot: [number, number, number];
          scale: [number, number, number];
        }> = [];
        const crossRoots: Array<{
          pos: [number, number, number];
          rot: [number, number, number];
          scale: [number, number, number];
        }> = [];

        for (let i = 0; i < rootCount; i++) {
          const frac = (i + 0.5) / rootCount - 0.5;
          const rx = frac * obs.width * 0.88;
          const length = subDepth * (0.76 + ((i * 37) % 10) * 0.028);
          const thickness = (isBeaverDam ? 1.15 : 0.85) + ((i * 19) % 5) * 0.14;
          const swayZ = ((i % 3) - 1) * 0.2;

          vertRoots.push({
            pos: [rx, -length * 0.5 + 0.04, swayZ],
            rot: [((i % 3) - 1) * 0.18, 0, ((i % 2 === 0 ? 1 : -1) * 0.22) + frac * 0.26],
            scale: [thickness, length, thickness],
          });

          const forkLen = 1.15 + (i % 3) * 0.34;
          crossRoots.push({
            pos: [rx + (i % 2 === 0 ? 0.22 : -0.22), -0.44 - (i % 2) * 0.26, -swayZ * 0.75],
            rot: [0.2 * (i % 2 === 0 ? 1 : -1), i * 0.4, (i % 2 === 0 ? 0.62 : -0.62)],
            scale: [0.95, forkLen, 0.95],
          });

          if (i < rootCount - 1) {
            const crossLen = (obs.width / rootCount) * 2.15;
            crossRoots.push({
              pos: [
                rx + (obs.width / rootCount) * 0.48,
                -0.78 - (i % 3) * 0.48,
                ((i % 2) - 0.5) * 0.24,
              ],
              rot: [0.1, (i % 3 - 1) * 0.26, Math.PI * 0.5 + (i % 4 - 1.5) * 0.26],
              scale: [0.98, crossLen, 0.98],
            });
          }
        }

        const mergedVertRoots = buildMergedSubMesh(
          this.parts.rootConeGeom,
          this.parts.submergedRootMat,
          vertRoots,
        );
        if (mergedVertRoots) root.add(mergedVertRoots);

        const mergedCrossRoots = buildMergedSubMesh(
          this.parts.rootBranchGeom,
          this.parts.submergedRootMat,
          crossRoots,
        );
        if (mergedCrossRoots) root.add(mergedCrossRoots);
        break;
      }

      case 'lily_pad': {
        this.alignGroupToRiver(root, sample, 0);

        const subDepth = Math.max(2.4, Math.min(3.2, sample.depth * 0.88));
        const padAssetId = obs.assetId ?? 'giant_lily_pad';
        const giantPadAsset = assetLoader.get(padAssetId);

        // Hero Meshy 3D `giant_lily_pad` centerpiece
        const padClone = giantPadAsset.prototype.clone(true);
        padClone.scale.setScalar(0.68);
        padClone.position.set(0, 0.02, 0);
        padClone.rotation.y = obs.s % 3.14;
        root.add(padClone);

        // Companion satellite pads & dense underwater stem curtain
        const padCount = Math.max(5, Math.round(obs.width * 1.35));
        const padTransforms: Array<{
          pos: [number, number, number];
          rot: [number, number, number];
          scale: [number, number, number];
        }> = [];
        const stemTransforms: Array<{
          pos: [number, number, number];
          rot: [number, number, number];
          scale: [number, number, number];
        }> = [];
        const lotusTransforms: Array<{
          pos: [number, number, number];
          scale: [number, number, number];
        }> = [];

        for (let i = 0; i < padCount; i++) {
          const frac = (i + 0.5) / padCount - 0.5;
          const px = frac * obs.width * 0.84;
          const pz = Math.sin(i * 2.3) * obs.radius * 0.58;
          const padR = 0.55 + ((i * 29) % 7) * 0.07;

          padTransforms.push({
            pos: [px, 0.015 + (i % 2) * 0.015, pz],
            rot: [0, i * 1.45, 0],
            scale: [padR, 1, padR],
          });

          const stemLen = subDepth * (0.78 + (i % 3) * 0.08);
          stemTransforms.push({
            pos: [px, -stemLen * 0.5, pz],
            rot: [Math.cos(i * 1.7) * 0.14, 0, Math.sin(i * 1.9) * 0.16],
            scale: [1.2, stemLen, 1.2],
          });

          if (i % 3 === 1) {
            lotusTransforms.push({
              pos: [px, 0.16, pz],
              scale: [1.1, 0.85, 1.1],
            });
          }
        }

        const mergedPads = buildMergedSubMesh(
          this.parts.lilyPadGeom,
          this.parts.lilyPadMat,
          padTransforms,
        );
        if (mergedPads) {
          mergedPads.receiveShadow = true;
          root.add(mergedPads);
        }

        const mergedStems = buildMergedSubMesh(
          this.parts.lilyStemGeom,
          this.parts.lilyStemMat,
          stemTransforms,
        );
        if (mergedStems) root.add(mergedStems);

        const mergedLotuses = buildMergedSubMesh(
          this.parts.lotusGeom,
          this.parts.lotusMat,
          lotusTransforms,
        );
        if (mergedLotuses) root.add(mergedLotuses);
        break;
      }
    }

    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = false;
        obj.receiveShadow = true;
      }
    });

    return root;
  }

  /**
   * Align a group's local basis so `+Z` points downstream (`sample.tangent`),
   * `+Y` points along `sample.up`, and `+X` points river-left (`-sample.right`),
   * matching our right-handed Duck Scale model convention.
   */
  private alignGroupToRiver(
    target: THREE.Object3D,
    sample: RiverSample,
    extraYaw: number,
  ): void {
    this.tmpLeft.set(-sample.right.x, -sample.right.y, -sample.right.z).normalize();
    this.tmpUp.set(sample.up.x, sample.up.y, sample.up.z).normalize();
    this.tmpTan.set(sample.tangent.x, sample.tangent.y, sample.tangent.z).normalize();
    this.tmpMat.makeBasis(this.tmpLeft, this.tmpUp, this.tmpTan);
    target.quaternion.setFromRotationMatrix(this.tmpMat);
    if (Math.abs(extraYaw) > 1e-4) {
      target.rotateY(extraYaw);
    }
  }
}
