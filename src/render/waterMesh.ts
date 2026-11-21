import * as THREE from 'three';
import { QUALITY_PRESETS, RIVER_CONFIG } from '../config';
import { earthToLocal, type LocalTangentFrame } from '../earth/coords';
import { earthWorld } from '../earth/earthWorld';
import {
  blendEarthRegionZones,
  type BlendedEarthRegion,
} from '../earth/schema';
import {
  worldRoute as defaultWorldRoute,
  type BlendedWorldTrackState,
  type WorldRouteController,
} from '../tracks/worldGraph';
import type {
  CaveBranchInfo,
  DuckState,
  HydroObstacle,
  ResolvedQuality,
  RiverProvider,
  RiverSample,
  Vec3,
} from '../types';
import {
  createWaterShaderMaterial,
  MAX_WATER_OBSTACLES,
  type WaterShaderUniforms,
  type WaterWaveParams,
} from './waterShader';

const MAIN_MAX_ROWS = 180;
const MAIN_MAX_COLS = 23;
const CAVE_ROWS = 52;
const CAVE_COLS = 11;
const FORK_MAX_ROWS = 56;
const FORK_COLS = 13;

type RiverSampleWithExtras = RiverSample & {
  rapidsIntensity?: number;
  waterfallPhase?: number;
  plungePoolIntensity?: number;
};

export interface ForkPreviewPoint {
  s?: number;
  position: Vec3;
  tangent?: Vec3;
  right?: Vec3;
  up?: Vec3;
  width?: number;
  depth?: number;
  slope?: number;
  rapidsIntensity?: number;
  flowSpeedMultiplier?: number;
}

export interface ForkPreviewContainer {
  junctionId?: string;
  waterwayId?: string;
  branchId?: string;
  side?: 'left' | 'right';
  branchSide?: 'left' | 'right';
  chosenSide?: 'left' | 'right';
  samples?: readonly ForkPreviewPoint[];
  points?: readonly ForkPreviewPoint[];
}

export type ForkBranchPreviewResult =
  | readonly ForkPreviewPoint[]
  | ForkPreviewContainer
  | null
  | undefined;

type RiverProviderWithEarthHelpers = RiverProvider & {
  getCaveCenterU?: (branch: CaveBranchInfo, s: number) => number;
  getLocalTangentFrame?: () => LocalTangentFrame;
  getFrameRevision?: () => number;
  getForkBranchPreview?: (playerS: number) => ForkBranchPreviewResult;
};

interface RibbonBuffers {
  geometry: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  positions: Float32Array;
  normals: Float32Array;
  riverData: Float32Array;
  riverMeta: Float32Array;
  waterfallMeta: Float32Array;
  flowDirs: Float32Array;
  posAttr: THREE.BufferAttribute;
  normAttr: THREE.BufferAttribute;
  dataAttr: THREE.BufferAttribute;
  metaAttr: THREE.BufferAttribute;
  wfMetaAttr: THREE.BufferAttribute;
  flowAttr: THREE.BufferAttribute;
  maxRows: number;
  maxCols: number;
}

interface ObstacleCandidate {
  obstacle: HydroObstacle;
  distSq: number;
}

function resolveEarthRegionForSample(
  sample: RiverSample,
  fallbackRoute: WorldRouteController,
): BlendedEarthRegion {
  // Honor leg-aware & single_track-locked region fields stamped by RiverSpline first!
  const regionId = sample.regionId ?? sample.trackId;
  if (regionId) {
    const primary = earthWorld.getZoneById(regionId);
    const secId = sample.secondaryRegionId ?? sample.nextTrackId;
    const secondary = secId ? earthWorld.getZoneById(secId) : primary;
    const blend = THREE.MathUtils.clamp(
      sample.regionBlend ?? sample.trackBlend ?? 0,
      0,
      1,
    );
    return blendEarthRegionZones(primary, secondary, blend);
  }
  if (
    sample.lat !== undefined &&
    sample.lng !== undefined &&
    Number.isFinite(sample.lat) &&
    Number.isFinite(sample.lng)
  ) {
    return earthWorld.getBlendedRegionAt(sample.lat, sample.lng);
  }
  const legacy = fallbackRoute.sampleAt(sample.s);
  const primary = earthWorld.getZoneById(legacy.currentTrack.id);
  const secondary = earthWorld.getZoneById(legacy.nextTrack.id);
  return blendEarthRegionZones(primary, secondary, legacy.blend);
}

function extractForkPreview(
  preview: ForkBranchPreviewResult,
): { key: string; samples: readonly ForkPreviewPoint[] } | null {
  if (!preview) return null;
  if (Array.isArray(preview)) {
    if (preview.length < 2) return null;
    const p0 = preview[0].position;
    const pN = preview[preview.length - 1].position;
    const key = `arr:${preview.length}:${Math.round(p0.x * 2)},${Math.round(p0.z * 2)}:${Math.round(pN.x * 2)},${Math.round(pN.z * 2)}`;
    return { key, samples: preview };
  }
  const container = preview as ForkPreviewContainer;
  const list = container.samples ?? container.points;
  if (!list || list.length < 2) return null;
  const p0 = list[0].position;
  const pN = list[list.length - 1].position;
  const sideTag = container.branchSide ?? container.side ?? '';
  const chosenTag = container.chosenSide ?? '';
  const key = `${container.junctionId ?? ''}:${container.waterwayId ?? container.branchId ?? ''}:${sideTag}:${chosenTag}:${list.length}:${Math.round(p0.x * 2)},${Math.round(p0.z * 2)}:${Math.round(pN.x * 2)},${Math.round(pN.z * 2)}`;
  return { key, samples: list };
}

function createRibbonBuffers(
  maxRows: number,
  maxCols: number,
  material: THREE.ShaderMaterial,
  name: string,
): RibbonBuffers {
  const vertCount = maxRows * maxCols;
  const quadCount = (maxRows - 1) * (maxCols - 1);

  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const riverData = new Float32Array(vertCount * 4);
  const riverMeta = new Float32Array(vertCount * 4);
  const waterfallMeta = new Float32Array(vertCount * 2);
  const flowDirs = new Float32Array(vertCount * 3);
  const indices = new Uint32Array(quadCount * 6);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const normAttr = new THREE.BufferAttribute(normals, 3);
  const dataAttr = new THREE.BufferAttribute(riverData, 4);
  const metaAttr = new THREE.BufferAttribute(riverMeta, 4);
  const wfMetaAttr = new THREE.BufferAttribute(waterfallMeta, 2);
  const flowAttr = new THREE.BufferAttribute(flowDirs, 3);

  posAttr.setUsage(THREE.DynamicDrawUsage);
  normAttr.setUsage(THREE.DynamicDrawUsage);
  dataAttr.setUsage(THREE.DynamicDrawUsage);
  metaAttr.setUsage(THREE.DynamicDrawUsage);
  wfMetaAttr.setUsage(THREE.DynamicDrawUsage);
  flowAttr.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('normal', normAttr);
  geometry.setAttribute('aRiverData', dataAttr);
  geometry.setAttribute('aRiverMeta', metaAttr);
  geometry.setAttribute('aWaterfallMeta', wfMetaAttr);
  geometry.setAttribute('aFlowDir', flowAttr);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;

  return {
    geometry,
    mesh,
    positions,
    normals,
    riverData,
    riverMeta,
    waterfallMeta,
    flowDirs,
    posAttr,
    normAttr,
    dataAttr,
    metaAttr,
    wfMetaAttr,
    flowAttr,
    maxRows,
    maxCols,
  };
}

function writeGridIndices(
  geometry: THREE.BufferGeometry,
  rows: number,
  cols: number,
): void {
  const indexAttr = geometry.getIndex();
  if (!indexAttr) return;
  const arr = indexAttr.array as Uint32Array;
  let ptr = 0;
  for (let r = 0; r < rows - 1; r++) {
    const rowStart = r * cols;
    const nextRowStart = (r + 1) * cols;
    for (let c = 0; c < cols - 1; c++) {
      const a = rowStart + c;
      const b = rowStart + c + 1;
      const d = nextRowStart + c;
      const e = nextRowStart + c + 1;
      // Right-handed +Y front-face winding: (right) x (tangent) = +UP
      arr[ptr++] = a;
      arr[ptr++] = b;
      arr[ptr++] = d;
      arr[ptr++] = b;
      arr[ptr++] = e;
      arr[ptr++] = d;
    }
  }
  geometry.setDrawRange(0, ptr);
  indexAttr.needsUpdate = true;
}

/**
 * Dynamic streaming ribbon water mesh following `RiverProvider`, synced in lockstep
 * with `RiverSpline` wave displacement, parabolic waterfall cascades, plunge pools,
 * side-cave water branches, **visible physical Y-fork diverging water branches**,
 * spatial Mini-Earth water optics (`earthWorld.getBlendedRegionAt`), duck Kelvin
 * V-wake, and obstacle-aware whitewater foam collars.
 */
export class WaterMesh {
  public readonly group: THREE.Group;
  public readonly material: THREE.ShaderMaterial;
  public readonly uniforms: WaterShaderUniforms;

  private readonly mainRibbon: RibbonBuffers;
  private readonly caveRibbon: RibbonBuffers;
  private readonly forkRibbon: RibbonBuffers;

  private routeController: WorldRouteController = defaultWorldRoute;
  private quality: ResolvedQuality;
  private activeRows = 176;
  private activeCols = 23;
  private stepS = 1.2;
  private behindDist: number = RIVER_CONFIG.behindDistance;
  private aheadDist: number = RIVER_CONFIG.aheadDistance;

  private lastWindowStartS = Number.NaN;
  private lastCaveId = '';
  private lastForkKey = '';
  private lastFrameRevision = -1;

  // Zero-allocation scratch state
  private readonly underwaterFogColor = new THREE.Color('#0c5e6e');
  private readonly surfaceFogColor = new THREE.Color('#b7e6f5');
  private underwaterBlend = 0;
  private underwaterFogNear = 4.5;
  private underwaterFogFar = 54.0;

  private readonly rowSamples: RiverSampleWithExtras[] = [];
  private readonly wfFactors = new Float32Array(MAIN_MAX_ROWS);
  private readonly obstaclePool: ObstacleCandidate[] = [];
  private readonly fallbackForkPoints: ForkPreviewPoint[] = [];

  constructor(
    scene?: THREE.Scene,
    quality: ResolvedQuality = 'high',
    routeController: WorldRouteController = defaultWorldRoute,
  ) {
    this.routeController = routeController;
    this.group = new THREE.Group();
    this.group.name = 'water_mesh_group';

    const { material, uniforms } = createWaterShaderMaterial();
    this.material = material;
    this.uniforms = uniforms;

    this.mainRibbon = createRibbonBuffers(
      MAIN_MAX_ROWS,
      MAIN_MAX_COLS,
      this.material,
      'river_water_surface',
    );
    this.caveRibbon = createRibbonBuffers(
      CAVE_ROWS,
      CAVE_COLS,
      this.material,
      'cave_water_surface',
    );
    this.caveRibbon.mesh.visible = false;
    writeGridIndices(this.caveRibbon.geometry, CAVE_ROWS, CAVE_COLS);

    this.forkRibbon = createRibbonBuffers(
      FORK_MAX_ROWS,
      FORK_COLS,
      this.material,
      'fork_branch_water_surface',
    );
    this.forkRibbon.mesh.visible = false;
    this.forkRibbon.mesh.renderOrder = 4;

    this.group.add(this.mainRibbon.mesh);
    this.group.add(this.caveRibbon.mesh);
    this.group.add(this.forkRibbon.mesh);

    this.quality = quality;
    this.applyQualitySettings(quality);

    if (scene) {
      scene.add(this.group);
    }
  }

  public setWorldRoute(routeController: WorldRouteController): void {
    this.routeController = routeController;
    this.lastWindowStartS = Number.NaN;
    this.lastForkKey = '';
  }

  public setQuality(quality: ResolvedQuality): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.applyQualitySettings(quality);
    this.lastWindowStartS = Number.NaN;
  }

  private applyQualitySettings(quality: ResolvedQuality): void {
    const preset = QUALITY_PRESETS[quality];
    this.uniforms.uQuality.value = quality === 'high' ? 1.0 : 0.0;
    this.activeCols = Math.min(MAIN_MAX_COLS, Math.max(9, preset.waterSegmentsAcross + 1));

    if (quality === 'high') {
      this.stepS = 1.2;
      this.behindDist = 34;
      this.aheadDist = 176;
    } else {
      this.stepS = 2.15;
      this.behindDist = 26;
      this.aheadDist = 160;
    }

    const totalLen = this.behindDist + this.aheadDist;
    this.activeRows = Math.min(
      MAIN_MAX_ROWS,
      Math.max(24, Math.ceil(totalLen / this.stepS) + 1),
    );
    writeGridIndices(this.mainRibbon.geometry, this.activeRows, this.activeCols);
  }

  public setWaveParams(params: Partial<WaterWaveParams>): void {
    const v = this.uniforms.uWaveParams.value;
    if (params.ampScale !== undefined) v.x = params.ampScale;
    if (params.freqS !== undefined) v.y = params.freqS;
    if (params.freqU !== undefined) v.z = params.freqU;
    if (params.speedScale !== undefined) v.w = params.speedScale;
  }

  public setSunDirection(dir: THREE.Vector3): void {
    this.uniforms.uSunDir.value.copy(dir).normalize();
  }

  public setUnderwaterState(
    submergedBlend: number,
    underwaterFogColor?: THREE.Color,
    fogNear?: number,
    fogFar?: number,
  ): void {
    this.underwaterBlend = THREE.MathUtils.clamp(submergedBlend, 0, 1);
    this.uniforms.uUnderwater.value = this.underwaterBlend;
    if (underwaterFogColor) {
      this.underwaterFogColor.copy(underwaterFogColor);
    }
    if (fogNear !== undefined) this.underwaterFogNear = fogNear;
    if (fogFar !== undefined) this.underwaterFogFar = fogFar;
  }

  /**
   * Apply spatial `BlendedEarthRegion` water, atmosphere, ground, weather & cave uniforms.
   */
  public applyEarthRegion(region: BlendedEarthRegion): void {
    const { waterStyle, atmosphere, groundStyle, weather, caveStyle } = region;

    this.uniforms.uSkyTop.value.setHex(atmosphere.skyZenith);
    this.uniforms.uSkyHorizon.value.setHex(atmosphere.skyHorizon);
    this.uniforms.uSunColor.value.setHex(atmosphere.sunColor);

    this.uniforms.uShallowColor.value.setHex(waterStyle.shallowColor);
    this.uniforms.uDeepColor.value.setHex(waterStyle.deepColor);
    this.uniforms.uFoamColor.value.setHex(waterStyle.foamColor);
    this.uniforms.uCausticColor.value.setHex(waterStyle.causticColor);
    this.uniforms.uCausticIntensity.value = waterStyle.causticIntensity;
    this.uniforms.uClarity.value = waterStyle.clarity;
    this.uniforms.uReflectivity.value = waterStyle.reflectivity;
    this.uniforms.uRainRippleIntensity.value = Math.max(
      waterStyle.rainRippleIntensity,
      weather.rainRipples,
    );
    this.uniforms.uGeothermalGlow.value = waterStyle.geothermalGlow;

    this.uniforms.uBedColor.value.setHex(groundStyle.bedShallowColor);
    this.uniforms.uCanopyColor.value
      .setHex(groundStyle.primaryColor)
      .multiplyScalar(0.62);
    this.uniforms.uCaveGlowColor.value.setHex(caveStyle.glowColor);

    const auroraA = atmosphere.auroraColors?.[0] ?? 0x2af598;
    const auroraB = atmosphere.auroraColors?.[1] ?? 0x9b5de5;
    this.uniforms.uAuroraColorA.value.setHex(auroraA);
    this.uniforms.uAuroraColorB.value.setHex(auroraB);

    const hasAurA = region.primaryZone.atmosphere.hasAurora ? 1.0 : 0.0;
    const hasAurB = region.secondaryZone.atmosphere.hasAurora ? 1.0 : 0.0;
    this.uniforms.uAuroraStrength.value = THREE.MathUtils.lerp(
      hasAurA,
      hasAurB,
      region.blend,
    );

    this.surfaceFogColor.setHex(atmosphere.fogColor);
    this.underwaterFogColor.setHex(waterStyle.underwaterFogColor);
    this.underwaterFogNear = waterStyle.underwaterFogNear;
    this.underwaterFogFar = waterStyle.underwaterFogFar;

    this.uniforms.uFogColor.value
      .copy(this.surfaceFogColor)
      .lerp(this.underwaterFogColor, this.underwaterBlend);
    this.uniforms.uFogNear.value = THREE.MathUtils.lerp(
      atmosphere.fogNear,
      this.underwaterFogNear,
      this.underwaterBlend,
    );
    this.uniforms.uFogFar.value = THREE.MathUtils.lerp(
      atmosphere.fogFar,
      this.underwaterFogFar,
      this.underwaterBlend,
    );

    this.uniforms.uRainbowStrength.value =
      atmosphere.timeOfDay === 'morning' || atmosphere.timeOfDay === 'golden'
        ? 0.78
        : 0.45;
  }

  /**
   * Backward-compatible helper accepting legacy `BlendedWorldTrackState`.
   */
  public applyTrackState(blended: BlendedWorldTrackState): void {
    const primary = earthWorld.getZoneById(blended.currentTrack.id);
    const secondary = earthWorld.getZoneById(blended.nextTrack.id);
    this.applyEarthRegion(blendEarthRegionZones(primary, secondary, blended.blend));
  }

  public updateObstacles(
    obstacles: readonly HydroObstacle[],
    duckS: number,
    river: RiverProvider,
  ): void {
    const candidates = this.obstaclePool;
    let count = 0;

    for (let i = 0; i < obstacles.length; i++) {
      const obs = obstacles[i];
      if (obs.foamStrength <= 0.01) continue;
      const ds = obs.s - duckS;
      if (ds < -24 || ds > 130) continue;

      const distSq = ds * ds + obs.u * obs.u;
      if (count < candidates.length) {
        candidates[count].obstacle = obs;
        candidates[count].distSq = distSq;
      } else {
        candidates.push({ obstacle: obs, distSq });
      }
      count++;
    }

    const limit = Math.min(count, MAX_WATER_OBSTACLES);
    for (let i = 0; i < limit; i++) {
      let bestIdx = i;
      let bestDist = candidates[i].distSq;
      for (let j = i + 1; j < count; j++) {
        if (candidates[j].distSq < bestDist) {
          bestDist = candidates[j].distSq;
          bestIdx = j;
        }
      }
      if (bestIdx !== i) {
        const tmpObs = candidates[i].obstacle;
        const tmpDist = candidates[i].distSq;
        candidates[i].obstacle = candidates[bestIdx].obstacle;
        candidates[i].distSq = candidates[bestIdx].distSq;
        candidates[bestIdx].obstacle = tmpObs;
        candidates[bestIdx].distSq = tmpDist;
      }

      const obs = candidates[i].obstacle;
      const sample = river.sampleAt(obs.s);
      const foamRadius =
        obs.type === 'log_jump' || obs.type === 'log_dive'
          ? Math.max(obs.radius, obs.width * 0.24)
          : obs.radius;

      this.uniforms.uObstacles.value[i].set(
        obs.worldPos.x,
        obs.worldPos.z,
        foamRadius,
        obs.foamStrength,
      );
      this.uniforms.uObstacleFlow.value[i].set(
        sample.tangent.x,
        sample.tangent.z,
        sample.position.y,
        obs.hasEddy ? 1.0 : 0.0,
      );
    }

    this.uniforms.uObstacleCount.value = limit;
  }

  public update(
    time: number,
    river: RiverProvider,
    duckState: DuckState,
    obstacles?: readonly HydroObstacle[],
    cameraSubmergedBlend?: number,
  ): void {
    this.uniforms.uTime.value = time;

    if (cameraSubmergedBlend !== undefined) {
      this.underwaterBlend = THREE.MathUtils.clamp(cameraSubmergedBlend, 0, 1);
      this.uniforms.uUnderwater.value = this.underwaterBlend;
    }

    this.uniforms.uDuckPos.value.set(
      duckState.worldPos.x,
      duckState.worldPos.y,
      duckState.worldPos.z,
    );
    this.uniforms.uDuckVel.value.set(
      duckState.velocity.x,
      duckState.velocity.y,
      duckState.velocity.z,
    );

    let wakeStrength = 1.0;
    if (duckState.mode === 'flying') {
      wakeStrength = 0.0;
    } else if (duckState.mode === 'airborne') {
      wakeStrength = THREE.MathUtils.clamp(1.0 - duckState.y / 1.4, 0, 1);
    } else if (duckState.mode === 'diving') {
      wakeStrength = THREE.MathUtils.clamp(
        1.0 - duckState.submersionDepth / 1.8,
        0.15,
        0.7,
      );
    }
    this.uniforms.uDuckWakeStrength.value = wakeStrength;

    const duckSample = river.sampleAt(duckState.s);
    const region = resolveEarthRegionForSample(duckSample, this.routeController);
    this.applyEarthRegion(region);

    // Detect Floating-Origin ENU recenter so ALL ribbons rebuild in lockstep on the exact same frame
    const frameRev =
      (river as RiverProviderWithEarthHelpers).getFrameRevision?.() ?? 0;
    if (frameRev !== this.lastFrameRevision) {
      this.lastFrameRevision = frameRev;
      this.lastWindowStartS = Number.NaN;
      this.lastCaveId = '';
      this.lastForkKey = '';
    }

    // Physical River Y-Fork diverging alternate water branch ribbon (checked before mainRibbon
    // so steering LEFT/RIGHT at a fork rebuilds BOTH mainRibbon and forkRibbon on the same frame!)
    const forkChanged = this.updateForkRibbon(duckState.s, duckSample, river);
    if (forkChanged) {
      this.lastWindowStartS = Number.NaN;
    }

    const snappedStart = Math.max(
      0,
      Math.floor((duckState.s - this.behindDist) / this.stepS) * this.stepS,
    );

    const needsRebuild =
      Number.isNaN(this.lastWindowStartS) ||
      Math.abs(snappedStart - this.lastWindowStartS) >= this.stepS * 0.5;

    if (needsRebuild) {
      this.rebuildMainRibbon(snappedStart, river);
      this.lastWindowStartS = snappedStart;
    }

    // Side cave water ribbon
    const sEnd = snappedStart + (this.activeRows - 1) * this.stepS;
    const caves = river.getCaveBranches(snappedStart, sEnd);
    if (caves.length > 0) {
      const cave = caves[0];
      if (this.lastCaveId !== cave.id || !this.caveRibbon.mesh.visible) {
        this.rebuildCaveRibbon(cave, river);
        this.lastCaveId = cave.id;
        this.caveRibbon.mesh.visible = true;
      }
      const caveMidSample = river.sampleAt((cave.startS + cave.endS) * 0.5);
      const caveRegion = resolveEarthRegionForSample(caveMidSample, this.routeController);
      this.uniforms.uCaveGlowColor.value.setHex(caveRegion.caveStyle.glowColor);
    } else if (this.caveRibbon.mesh.visible) {
      this.caveRibbon.mesh.visible = false;
      this.lastCaveId = '';
    }

    const activeObstacles =
      obstacles ?? river.getObstaclesInRange?.(duckState.s - 20, duckState.s + 130);
    if (activeObstacles) {
      this.updateObstacles(activeObstacles, duckState.s, river);
    } else {
      this.uniforms.uObstacleCount.value = 0;
    }
  }

  public isForkRibbonVisible(): boolean {
    return this.forkRibbon.mesh.visible;
  }

  public reset(): void {
    this.lastWindowStartS = Number.NaN;
    this.lastCaveId = '';
    this.lastForkKey = '';
    this.lastFrameRevision = -1;
    this.caveRibbon.mesh.visible = false;
    this.forkRibbon.mesh.visible = false;
    this.uniforms.uObstacleCount.value = 0;
  }

  public dispose(): void {
    this.mainRibbon.geometry.dispose();
    this.caveRibbon.geometry.dispose();
    this.forkRibbon.geometry.dispose();
    this.material.dispose();
    this.group.parent?.remove(this.group);
  }

  private updateForkRibbon(
    duckS: number,
    duckSample: RiverSample,
    river: RiverProvider,
  ): boolean {
    const earthRiver = river as RiverProviderWithEarthHelpers;
    let extracted = extractForkPreview(earthRiver.getForkBranchPreview?.(duckS));

    // Direct EarthWorld fallback if `upcomingFork` is active and `getLocalTangentFrame()` exists
    if (
      !extracted &&
      duckSample.upcomingFork &&
      duckSample.upcomingFork.distanceU <= 115 &&
      earthRiver.getLocalTangentFrame
    ) {
      const fork = duckSample.upcomingFork;
      const altId =
        fork.selectedSide === 'left'
          ? fork.rightBranchId
          : fork.selectedSide === 'right'
            ? fork.leftBranchId
            : fork.defaultBranchId === fork.leftBranchId
              ? fork.rightBranchId
              : fork.leftBranchId;
      const frame = earthRiver.getLocalTangentFrame();
      const juncS = duckS + fork.distanceU;
      const juncSample = river.sampleAt(juncS);

      const wwLen = Math.min(earthWorld.getWaterwayLength(altId), 108);
      const count = Math.min(FORK_MAX_ROWS, Math.max(12, Math.floor(wwLen / 3.0) + 1));
      this.fallbackForkPoints.length = 0;
      const firstEarth = earthWorld.sampleWaterway(altId, 0);
      const firstLocal = earthToLocal(
        firstEarth.lat,
        firstEarth.lng,
        firstEarth.elevation,
        frame,
      );
      const offX = juncSample.position.x - firstLocal.x;
      const offY = juncSample.position.y - firstLocal.y;
      const offZ = juncSample.position.z - firstLocal.z;

      for (let i = 0; i < count; i++) {
        const localS = (i / (count - 1)) * wwLen;
        const es = earthWorld.sampleWaterway(altId, localS);
        const lp = earthToLocal(es.lat, es.lng, es.elevation, frame);
        this.fallbackForkPoints.push({
          s: juncS + localS,
          position: { x: lp.x + offX, y: lp.y + offY, z: lp.z + offZ },
          width: es.width,
          depth: es.depth,
          slope: es.slope,
          rapidsIntensity: es.rapids,
          flowSpeedMultiplier: es.speedBoost,
        });
      }
      extracted = {
        key: `fb:${fork.junctionId}:${altId}:${Math.round(juncSample.position.x)},${Math.round(juncSample.position.z)}`,
        samples: this.fallbackForkPoints,
      };
    }

    if (!extracted || extracted.samples.length < 2) {
      if (this.forkRibbon.mesh.visible) {
        this.forkRibbon.mesh.visible = false;
        this.lastForkKey = '';
        return true;
      }
      return false;
    }

    if (this.lastForkKey !== extracted.key || !this.forkRibbon.mesh.visible) {
      this.rebuildForkRibbon(extracted.samples, duckS);
      this.lastForkKey = extracted.key;
      this.forkRibbon.mesh.visible = true;
      return true;
    }
    return false;
  }

  private rebuildForkRibbon(
    samples: readonly ForkPreviewPoint[],
    baseS: number,
  ): void {
    const rb = this.forkRibbon;
    const rows = Math.min(FORK_MAX_ROWS, samples.length);
    const cols = FORK_COLS;
    const invColsMinus1 = 1 / (cols - 1);

    let vIdx = 0;
    for (let r = 0; r < rows; r++) {
      // Evenly resample if `samples.length > FORK_MAX_ROWS`
      const srcIdx =
        rows === samples.length
          ? r
          : Math.min(
              samples.length - 1,
              Math.round((r / (rows - 1)) * (samples.length - 1)),
            );
      const curr = samples[srcIdx];
      const prev = samples[Math.max(0, srcIdx - 1)];
      const next = samples[Math.min(samples.length - 1, srcIdx + 1)];

      let tx: number;
      let ty: number;
      let tz: number;
      if (curr.tangent) {
        tx = curr.tangent.x;
        ty = curr.tangent.y;
        tz = curr.tangent.z;
      } else {
        tx = next.position.x - prev.position.x;
        ty = next.position.y - prev.position.y;
        tz = next.position.z - prev.position.z;
      }
      const tLen = Math.hypot(tx, ty, tz) || 1;
      tx /= tLen;
      ty /= tLen;
      tz /= tLen;

      let rx: number;
      let ry: number;
      let rz: number;
      if (curr.right) {
        rx = curr.right.x;
        ry = curr.right.y;
        rz = curr.right.z;
      } else {
        // cross(tangent, WORLD_UP(0,1,0)) = (-tz, 0, tx)
        rx = -tz;
        ry = 0;
        rz = tx;
        const rLen = Math.hypot(rx, rz) || 1;
        rx /= rLen;
        rz /= rLen;
      }

      const ux = curr.up?.x ?? 0;
      const uy = curr.up?.y ?? 1;
      const uz = curr.up?.z ?? 0;

      const width = curr.width ?? 13.5;
      const halfWidth = width * 0.5;
      // Gently tuck slightly below main water at the confluence seam (row 0..2) to eliminate z-fighting
      const joinDip = r < 3 ? -0.025 * (1.0 - r / 3) : -0.008;
      const tuckedHalfWidth = halfWidth * 1.04;
      const depth = curr.depth ?? 4.2;
      const rapids = curr.rapidsIntensity ?? 0.34;
      const flowSpeed = curr.flowSpeedMultiplier ?? 1.05;
      const sVal = curr.s ?? baseS + r * 3.0;

      const px = curr.position.x;
      const py = curr.position.y + joinDip;
      const pz = curr.position.z;

      for (let c = 0; c < cols; c++) {
        const uNorm = c * invColsMinus1 * 2.0 - 1.0;
        const lateral = uNorm * tuckedHalfWidth;

        const p3 = vIdx * 3;
        rb.positions[p3] = px + rx * lateral;
        rb.positions[p3 + 1] = py + ry * lateral;
        rb.positions[p3 + 2] = pz + rz * lateral;

        rb.normals[p3] = ux;
        rb.normals[p3 + 1] = uy;
        rb.normals[p3 + 2] = uz;

        rb.flowDirs[p3] = tx;
        rb.flowDirs[p3 + 1] = ty;
        rb.flowDirs[p3 + 2] = tz;

        const edgeRatio = Math.min(Math.abs(uNorm), 1.0);
        const channelProfile = Math.max(0.1, 1.0 - Math.pow(edgeRatio, 2.2) * 0.9);
        const p4 = vIdx * 4;
        rb.riverData[p4] = sVal;
        rb.riverData[p4 + 1] = uNorm;
        rb.riverData[p4 + 2] = depth * channelProfile;
        rb.riverData[p4 + 3] = flowSpeed * (1.0 - edgeRatio * edgeRatio * 0.28);

        rb.riverMeta[p4] = rapids;
        rb.riverMeta[p4 + 1] = 0.0;
        rb.riverMeta[p4 + 2] = halfWidth;
        rb.riverMeta[p4 + 3] = 0.0;

        const p2 = vIdx * 2;
        rb.waterfallMeta[p2] = 0.0;
        rb.waterfallMeta[p2 + 1] = 0.0;

        vIdx++;
      }
    }

    writeGridIndices(rb.geometry, rows, cols);
    rb.posAttr.needsUpdate = true;
    rb.normAttr.needsUpdate = true;
    rb.dataAttr.needsUpdate = true;
    rb.metaAttr.needsUpdate = true;
    rb.wfMetaAttr.needsUpdate = true;
    rb.flowAttr.needsUpdate = true;
  }

  private rebuildMainRibbon(startS: number, river: RiverProvider): void {
    const rows = this.activeRows;
    const cols = this.activeCols;
    const rb = this.mainRibbon;

    this.rowSamples.length = rows;
    for (let r = 0; r < rows; r++) {
      const s = startS + r * this.stepS;
      const sample = river.sampleAt(s) as RiverSampleWithExtras;
      this.rowSamples[r] = sample;

      const steepness = Math.max(0, (-sample.slope - 0.24) * 1.45);
      const rawWf = sample.isWaterfall
        ? Math.max(0.85, Math.min(1.0, steepness + 0.55))
        : Math.min(1.0, steepness);
      this.wfFactors[r] = rawWf;
    }

    for (let pass = 0; pass < 2; pass++) {
      for (let r = 1; r < rows - 1; r++) {
        const smoothed =
          this.wfFactors[r - 1] * 0.28 +
          this.wfFactors[r] * 0.44 +
          this.wfFactors[r + 1] * 0.28;
        this.wfFactors[r] = smoothed;
      }
    }

    const invColsMinus1 = 1 / (cols - 1);
    let vIdx = 0;

    for (let r = 0; r < rows; r++) {
      const sample = this.rowSamples[r];
      const wf = this.wfFactors[r];
      const halfWidth = sample.width * 0.5;
      const tuckedHalfWidth = halfWidth * 1.045;

      const rapids =
        sample.rapidsIntensity ??
        THREE.MathUtils.clamp((-sample.slope - 0.045) * 4.5, 0, 1);
      const wfPhase = sample.waterfallPhase ?? (sample.isWaterfall ? 0.5 : 0.0);
      const plungePool = sample.plungePoolIntensity ?? 0.0;

      const baseFlow =
        (sample.flowSpeedMultiplier ?? 1.0) *
        (1.0 + Math.max(0, -sample.slope) * 4.2);

      const px = sample.position.x;
      const py = sample.position.y;
      const pz = sample.position.z;

      const rx = sample.right.x;
      const ry = sample.right.y;
      const rz = sample.right.z;

      const tx = sample.tangent.x;
      const ty = sample.tangent.y;
      const tz = sample.tangent.z;

      const ux = sample.up.x;
      const uy = sample.up.y;
      const uz = sample.up.z;

      for (let c = 0; c < cols; c++) {
        const uNorm = c * invColsMinus1 * 2.0 - 1.0;
        const lateral = uNorm * tuckedHalfWidth;
        const wfArch = wf * (1.0 - uNorm * uNorm) * 0.24;

        const p3 = vIdx * 3;
        rb.positions[p3] = px + rx * lateral + ux * wfArch;
        rb.positions[p3 + 1] = py + ry * lateral + uy * wfArch;
        rb.positions[p3 + 2] = pz + rz * lateral + uz * wfArch;

        rb.normals[p3] = ux;
        rb.normals[p3 + 1] = uy;
        rb.normals[p3 + 2] = uz;

        rb.flowDirs[p3] = tx;
        rb.flowDirs[p3 + 1] = ty;
        rb.flowDirs[p3 + 2] = tz;

        const edgeRatio = Math.min(Math.abs(uNorm), 1.0);
        const channelProfile = Math.max(0.08, 1.0 - Math.pow(edgeRatio, 2.3) * 0.92);
        const rawDepth = sample.depth * channelProfile;
        const depth = THREE.MathUtils.lerp(rawDepth, 0.42, wf * 0.85);
        const thalweg = 1.0 - edgeRatio * edgeRatio * 0.32;

        const p4 = vIdx * 4;
        rb.riverData[p4] = sample.s;
        rb.riverData[p4 + 1] = uNorm;
        rb.riverData[p4 + 2] = depth;
        rb.riverData[p4 + 3] = baseFlow * thalweg;

        rb.riverMeta[p4] = rapids;
        rb.riverMeta[p4 + 1] = wf;
        rb.riverMeta[p4 + 2] = halfWidth;
        rb.riverMeta[p4 + 3] = 0.0;

        const p2 = vIdx * 2;
        rb.waterfallMeta[p2] = wfPhase;
        rb.waterfallMeta[p2 + 1] = plungePool;

        vIdx++;
      }
    }

    rb.posAttr.needsUpdate = true;
    rb.normAttr.needsUpdate = true;
    rb.dataAttr.needsUpdate = true;
    rb.metaAttr.needsUpdate = true;
    rb.wfMetaAttr.needsUpdate = true;
    rb.flowAttr.needsUpdate = true;
  }

  private rebuildCaveRibbon(cave: CaveBranchInfo, river: RiverProvider): void {
    const rb = this.caveRibbon;
    const rows = CAVE_ROWS;
    const cols = CAVE_COLS;
    const lenS = Math.max(cave.endS - cave.startS, 10);
    const invRows = 1 / (rows - 1);
    const invCols = 1 / (cols - 1);
    const halfW = cave.width * 0.56;
    const caveHelper = river as RiverProviderWithEarthHelpers;

    const evalCenterU = (sVal: number, tVal: number, widthVal: number): number => {
      if (caveHelper.getCaveCenterU) {
        return caveHelper.getCaveCenterU(cave, sVal);
      }
      const startU = widthVal * 0.36;
      return cave.side * (startU + (cave.maxOffset - startU) * Math.sin(tVal * Math.PI));
    };

    let vIdx = 0;
    for (let r = 0; r < rows; r++) {
      const t = r * invRows;
      const s = cave.startS + t * lenS;
      const sample = river.sampleAt(s);

      const swing = Math.sin(t * Math.PI);
      const centerU = evalCenterU(s, t, sample.width);
      const caveMask = THREE.MathUtils.smoothstep(swing, 0.12, 0.4);

      const epsS = 0.5;
      const sNext = Math.min(cave.endS, s + epsS);
      const sPrev = Math.max(cave.startS, s - epsS);
      const tNext = (sNext - cave.startS) / lenS;
      const tPrev = (sPrev - cave.startS) / lenS;
      const uNext = evalCenterU(sNext, tNext, sample.width);
      const uPrev = evalCenterU(sPrev, tPrev, sample.width);
      const dUds = (uNext - uPrev) / Math.max(sNext - sPrev, 0.001);

      let tx = sample.tangent.x + sample.right.x * dUds;
      let ty = sample.tangent.y + sample.right.y * dUds;
      let tz = sample.tangent.z + sample.right.z * dUds;
      const tLen = Math.hypot(tx, ty, tz) || 1;
      tx /= tLen;
      ty /= tLen;
      tz /= tLen;

      let rx = -tz;
      let rz = tx;
      const rLen = Math.hypot(rx, rz) || 1;
      rx /= rLen;
      rz /= rLen;

      const cx = sample.position.x + sample.right.x * centerU;
      const cy = sample.position.y - 0.015;
      const cz = sample.position.z + sample.right.z * centerU;

      for (let c = 0; c < cols; c++) {
        const uNorm = c * invCols * 2.0 - 1.0;
        const lat = uNorm * halfW;

        const p3 = vIdx * 3;
        rb.positions[p3] = cx + rx * lat;
        rb.positions[p3 + 1] = cy;
        rb.positions[p3 + 2] = cz + rz * lat;

        rb.normals[p3] = 0;
        rb.normals[p3 + 1] = 1;
        rb.normals[p3 + 2] = 0;

        rb.flowDirs[p3] = tx;
        rb.flowDirs[p3 + 1] = ty;
        rb.flowDirs[p3 + 2] = tz;

        const depth = cave.depth * Math.max(0.2, 1.0 - uNorm * uNorm * 0.72);
        const p4 = vIdx * 4;
        rb.riverData[p4] = s;
        rb.riverData[p4 + 1] = uNorm;
        rb.riverData[p4 + 2] = depth;
        rb.riverData[p4 + 3] = 1.1;

        rb.riverMeta[p4] = 0.14;
        rb.riverMeta[p4 + 1] = 0.0;
        rb.riverMeta[p4 + 2] = cave.width * 0.5;
        rb.riverMeta[p4 + 3] = caveMask;

        const p2 = vIdx * 2;
        rb.waterfallMeta[p2] = 0.0;
        rb.waterfallMeta[p2 + 1] = 0.0;

        vIdx++;
      }
    }

    rb.posAttr.needsUpdate = true;
    rb.normAttr.needsUpdate = true;
    rb.dataAttr.needsUpdate = true;
    rb.metaAttr.needsUpdate = true;
    rb.wfMetaAttr.needsUpdate = true;
    rb.flowAttr.needsUpdate = true;
  }
}
