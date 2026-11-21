import * as THREE from 'three';
import { assetLoader } from '../assets/loader';
import { RIVER_CONFIG } from '../config';
import {
  blendEarthRegionZones,
  earthWorld,
  type BlendedEarthRegion,
} from '../earth';
import type {
  AssetId,
  DuckState,
  ResolvedQuality,
  RiverProvider,
  RiverSample,
  Vec3,
} from '../types';

export interface WildlifeCallbacks {
  onMiniSplash?: (worldPos: Vec3) => void;
}

interface FishMember {
  mesh: THREE.Group;
  offsetS: number;
  offsetU: number;
  offsetY: number;
  phase: number;
  scatterVelU: number;
  scatterVelS: number;
  scatterTimer: number;
  scale: number;
}

interface UnderwaterSchool {
  s: number;
  baseU: number;
  baseY: number;
  swimSpeed: number;
  headingSign: -1 | 1;
  assetId: AssetId;
  members: FishMember[];
}

interface BankCritter {
  container: THREE.Group;
  critterMesh: THREE.Group;
  assetId: AssetId;
  s: number;
  u: number;
  baseYaw: number;
  phase: number;
  scale: number;
  onIceFloe: boolean;
}

interface Dragonfly {
  mesh: THREE.Group;
  wingLeftF: THREE.Mesh;
  wingRightF: THREE.Mesh;
  wingLeftB: THREE.Mesh;
  wingRightB: THREE.Mesh;
  anchorS: number;
  anchorU: number;
  anchorY: number;
  phase: number;
  zipSpeed: number;
}

interface CreekFrog {
  group: THREE.Group;
  frogMesh: THREE.Group;
  s: number;
  u: number;
  bankSide: -1 | 1;
  state: 'perched' | 'hopping' | 'submerged';
  hopT: number;
  startPos: THREE.Vector3;
  targetPos: THREE.Vector3;
  splashed: boolean;
}

interface FireflyMote {
  mesh: THREE.Group;
  coreMat: THREE.MeshBasicMaterial;
  haloMat: THREE.MeshBasicMaterial;
  offsetS: number;
  offsetU: number;
  offsetY: number;
  phase: number;
  speed: number;
}

interface FireflyCluster {
  s: number;
  rising: boolean;
  motes: FireflyMote[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 100% data-driven regional wildlife streaming system for Shared Physical Mini-Earth:
 * Queries `earthWorld.getBlendedRegionAt(sample.lat, sample.lng)` with ZERO hardcoded
 * region IDs so any contributor pack automatically spawns its configured underwater fish,
 * bank critters (with automatic glacial ice floes in icy/snowy regions), dragonflies,
 * hopping frogs, and glowing fireflies / rising ember motes!
 */
export class Wildlife {
  public readonly group = new THREE.Group();

  private readonly river: RiverProvider;
  private readonly callbacks: WildlifeCallbacks;
  private rng: () => number;
  private quality: ResolvedQuality = 'high';

  private readonly fishSchools: UnderwaterSchool[] = [];
  private readonly bankCritters: BankCritter[] = [];
  private readonly dragonflies: Dragonfly[] = [];
  private readonly frogs: CreekFrog[] = [];
  private readonly fireflyClusters: FireflyCluster[] = [];

  private nextFishS = 34;
  private nextCritterS = 48;
  private nextDragonflyS = 24;
  private nextFrogS = 46;
  private nextFireflyS = 22;

  // Shared procedural geometries & materials for dragonflies, hopping frogs, ice floes, and fireflies
  private readonly dragonflyBodyGeom: THREE.CylinderGeometry;
  private readonly dragonflyWingGeom: THREE.PlaneGeometry;
  private readonly dragonflyMatCyan: THREE.MeshStandardMaterial;
  private readonly dragonflyMatCobalt: THREE.MeshStandardMaterial;
  private readonly dragonflyWingMat: THREE.MeshBasicMaterial;

  private readonly frogBodyGeom: THREE.SphereGeometry;
  private readonly frogEyeGeom: THREE.SphereGeometry;
  private readonly frogLegGeom: THREE.SphereGeometry;
  private readonly frogStoneGeom: THREE.DodecahedronGeometry;
  private readonly frogMat: THREE.MeshStandardMaterial;
  private readonly frogEyeMat: THREE.MeshBasicMaterial;
  private readonly frogStoneMat: THREE.MeshStandardMaterial;

  private readonly iceFloeGeom: THREE.CylinderGeometry;
  private readonly iceFloeRimGeom: THREE.CylinderGeometry;
  private readonly iceFloeMat: THREE.MeshPhysicalMaterial;

  private readonly fireflyCoreGeom: THREE.SphereGeometry;
  private readonly fireflyHaloGeom: THREE.SphereGeometry;

  constructor(
    river: RiverProvider,
    callbacks: WildlifeCallbacks = {},
    seed: number = 9001,
  ) {
    this.river = river;
    this.callbacks = callbacks;
    this.group.name = 'wildlife_root';
    this.rng = mulberry32(seed);

    // Dragonfly shared parts
    this.dragonflyBodyGeom = new THREE.CylinderGeometry(0.022, 0.012, 0.56, 6);
    this.dragonflyBodyGeom.rotateX(Math.PI * 0.5);
    this.dragonflyWingGeom = new THREE.PlaneGeometry(0.32, 0.085);
    this.dragonflyWingGeom.translate(0.16, 0, 0);

    this.dragonflyMatCyan = new THREE.MeshStandardMaterial({
      color: 0x1ee6d6,
      emissive: 0x094f55,
      emissiveIntensity: 0.4,
      roughness: 0.16,
      metalness: 0.82,
    });
    this.dragonflyMatCobalt = new THREE.MeshStandardMaterial({
      color: 0x3b8dff,
      emissive: 0x102a66,
      emissiveIntensity: 0.4,
      roughness: 0.18,
      metalness: 0.85,
    });
    this.dragonflyWingMat = new THREE.MeshBasicMaterial({
      color: 0xdffbff,
      transparent: true,
      opacity: 0.52,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    // Frog shared parts
    this.frogBodyGeom = new THREE.SphereGeometry(0.22, 10, 8);
    this.frogBodyGeom.scale(1.0, 0.72, 1.22);
    this.frogEyeGeom = new THREE.SphereGeometry(0.055, 8, 6);
    this.frogLegGeom = new THREE.SphereGeometry(0.12, 8, 6);
    this.frogLegGeom.scale(0.65, 0.55, 1.35);
    this.frogStoneGeom = new THREE.DodecahedronGeometry(0.62, 0);

    this.frogMat = new THREE.MeshStandardMaterial({
      color: 0x45b842,
      roughness: 0.36,
      metalness: 0.05,
    });
    this.frogEyeMat = new THREE.MeshBasicMaterial({ color: 0x151515 });
    this.frogStoneMat = new THREE.MeshStandardMaterial({
      color: 0x4b5c4d,
      roughness: 0.8,
      flatShading: true,
    });

    // Crystalline floating ice floe shared parts for glacial/polar critters
    this.iceFloeGeom = new THREE.CylinderGeometry(0.95, 1.12, 0.24, 7);
    this.iceFloeRimGeom = new THREE.CylinderGeometry(0.76, 0.92, 0.12, 6);
    this.iceFloeMat = new THREE.MeshPhysicalMaterial({
      color: 0xdff8ff,
      emissive: 0x124e6b,
      emissiveIntensity: 0.28,
      roughness: 0.22,
      metalness: 0.04,
      clearcoat: 0.75,
      flatShading: true,
    });

    // Firefly / Ember-fly glowing orb geometries
    this.fireflyCoreGeom = new THREE.SphereGeometry(0.085, 8, 6);
    this.fireflyHaloGeom = new THREE.SphereGeometry(0.23, 8, 6);
  }

  public setQuality(quality: ResolvedQuality): void {
    this.quality = quality;
  }

  /**
   * Re-project perched/hopping bank frog coordinates after a Floating-Origin ENU recenter.
   * (Fish, bank critters, dragonflies, and fireflies recompute via `riverToWorld` every frame.)
   */
  public syncWorldPositions(): void {
    for (let i = 0; i < this.frogs.length; i++) {
      const frog = this.frogs[i];
      const sample = this.river.sampleAt(frog.s);
      const stoneWorld = this.river.riverToWorld(frog.s, frog.u, 0.05);
      const splashWorld = this.river.riverToWorld(
        frog.s + 1.4,
        frog.bankSide * (sample.width * 0.5 - 1.55),
        -0.08,
      );
      frog.startPos.set(stoneWorld.x, stoneWorld.y + 0.52, stoneWorld.z);
      frog.targetPos.set(splashWorld.x, splashWorld.y, splashWorld.z);
      const stone = frog.group.children[0];
      if (stone) {
        stone.position.set(stoneWorld.x, stoneWorld.y + 0.14, stoneWorld.z);
      }
      if (frog.state === 'perched') {
        frog.frogMesh.position.copy(frog.startPos);
        frog.frogMesh.lookAt(frog.targetPos.x, frog.startPos.y, frog.targetPos.z);
      }
    }
  }

  public reset(seed: number = 9001): void {
    this.clearAll();
    this.rng = mulberry32(seed);
    this.nextFishS = 34;
    this.nextCritterS = 48;
    this.nextDragonflyS = 24;
    this.nextFrogS = 46;
    this.nextFireflyS = 22;
  }

  /**
   * Upgrade active fish & bank critter meshes when lazy-loaded `.glb` models finish preloading.
   */
  public refreshAssets(): void {
    this.rebuildMeshes();
  }

  /**
   * Upgrade active wildlife meshes if GLBs finish loading after initial spawn.
   */
  public rebuildMeshes(): void {
    for (const school of this.fishSchools) {
      for (const m of school.members) {
        const pos = m.mesh.position.clone();
        const rot = m.mesh.rotation.clone();
        this.group.remove(m.mesh);
        const replacement = assetLoader.clone(school.assetId);
        replacement.scale.setScalar(m.scale);
        replacement.position.copy(pos);
        replacement.rotation.copy(rot);
        replacement.traverse((o) => {
          if (o instanceof THREE.Mesh) o.castShadow = false;
        });
        m.mesh = replacement;
        this.group.add(replacement);
      }
    }
    for (const c of this.bankCritters) {
      const localPos = c.critterMesh.position.clone();
      const localRot = c.critterMesh.rotation.clone();
      c.container.remove(c.critterMesh);
      const replacement = assetLoader.clone(c.assetId);
      replacement.scale.setScalar(c.scale);
      replacement.position.copy(localPos);
      replacement.rotation.copy(localRot);
      replacement.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = false;
      });
      c.critterMesh = replacement;
      c.container.add(replacement);
    }
  }

  /**
   * Manually spawn a visible school of the active Earth region's underwater fish
   * at a specific river position (used by `showcase('diving')`).
   */
  public spawnTroutSchoolAt(
    s: number,
    baseU: number = 0,
    baseY: number = -1.4,
    count: number = 5,
    forcedAssetId?: AssetId,
  ): void {
    this.spawnUnderwaterSchoolAt(s, baseU, baseY, count, forcedAssetId);
  }

  /**
   * Spawn an underwater school of the active Earth region's configured `underwaterAsset` at `s`.
   */
  public spawnUnderwaterSchoolAt(
    s: number,
    baseU: number = 0,
    baseY: number = -1.4,
    count: number = 5,
    forcedAssetId?: AssetId,
  ): void {
    const sample = this.river.sampleAt(s);
    const region = this.getRegionAt(s, sample);
    const assetId: AssetId =
      forcedAssetId ??
      region.primaryZone.wildlife.underwaterAsset ??
      'river_trout';

    const members: FishMember[] = [];
    const offsets: Array<[number, number, number, number]> = [
      [-0.6, -1.35, -0.15, 0.96],
      [1.2, 1.15, 0.22, 1.04],
      [2.6, -0.55, -0.25, 0.88],
      [3.8, 1.55, 0.05, 0.92],
      [4.9, -1.1, 0.18, 0.84],
    ];
    const total = Math.max(1, Math.min(count, offsets.length));
    for (let i = 0; i < total; i++) {
      const [os, ou, oy, sc] = offsets[i];
      const mesh = assetLoader.clone(assetId);
      mesh.scale.setScalar(sc);
      mesh.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = false;
      });
      this.group.add(mesh);
      members.push({
        mesh,
        offsetS: os,
        offsetU: ou,
        offsetY: oy,
        phase: i * 1.35,
        scatterVelU: 0,
        scatterVelS: 0,
        scatterTimer: 0,
        scale: sc,
      });
    }
    this.fishSchools.push({
      s,
      baseU,
      baseY,
      swimSpeed: 1.6,
      headingSign: -1,
      assetId,
      members,
    });
  }

  /**
   * Stream ambient wildlife ahead of the duck, animate swimming/bobbing/fluttering/hopping/glowing,
   * and prune behind.
   */
  public update(duck: DuckState, dt: number, time: number): void {
    const aheadS = duck.s + Math.min(RIVER_CONFIG.aheadDistance - 130, 58);
    const pruneS = duck.s - 16;

    this.streamAhead(aheadS);
    this.updateFishSchools(duck, dt, time, pruneS);
    this.updateBankCritters(duck, time, pruneS);
    this.updateDragonflies(time, pruneS);
    this.updateFrogs(duck, dt, pruneS);
    this.updateFireflies(time, pruneS);
  }

  public dispose(): void {
    this.clearAll();
    this.dragonflyBodyGeom.dispose();
    this.dragonflyWingGeom.dispose();
    this.dragonflyMatCyan.dispose();
    this.dragonflyMatCobalt.dispose();
    this.dragonflyWingMat.dispose();
    this.frogBodyGeom.dispose();
    this.frogEyeGeom.dispose();
    this.frogLegGeom.dispose();
    this.frogStoneGeom.dispose();
    this.frogMat.dispose();
    this.frogEyeMat.dispose();
    this.frogStoneMat.dispose();
    this.iceFloeGeom.dispose();
    this.iceFloeRimGeom.dispose();
    this.iceFloeMat.dispose();
    this.fireflyCoreGeom.dispose();
    this.fireflyHaloGeom.dispose();
  }

  private clearAll(): void {
    for (const school of this.fishSchools) {
      for (const m of school.members) this.group.remove(m.mesh);
    }
    this.fishSchools.length = 0;

    for (const c of this.bankCritters) this.group.remove(c.container);
    this.bankCritters.length = 0;

    for (const df of this.dragonflies) this.group.remove(df.mesh);
    this.dragonflies.length = 0;

    for (const f of this.frogs) this.group.remove(f.group);
    this.frogs.length = 0;

    for (const fc of this.fireflyClusters) {
      for (const mote of fc.motes) {
        this.group.remove(mote.mesh);
        mote.coreMat.dispose();
        mote.haloMat.dispose();
      }
    }
    this.fireflyClusters.length = 0;
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

  private streamAhead(aheadS: number): void {
    const densitySpacing = this.quality === 'high' ? 1.0 : 1.55;

    // 1. Underwater Fish Schools (driven purely by `zone.wildlife.underwaterAsset`)
    while (this.nextFishS < aheadS) {
      const s = this.nextFishS;
      const sample = this.river.sampleAt(s);
      const region = this.getRegionAt(s, sample);
      if (!sample.isWaterfall && sample.depth >= 2.7 && region.primaryZone.wildlife.underwaterAsset) {
        this.spawnFishSchool(
          s,
          sample.width,
          sample.depth,
          region.primaryZone.wildlife.underwaterAsset,
        );
      }
      this.nextFishS += (64 + this.rng() * 34) * densitySpacing;
    }

    // 2. Bank & Eddy Critters (driven purely by `zone.wildlife.bankCritterAsset` + ground ice properties)
    while (this.nextCritterS < aheadS) {
      const s = this.nextCritterS;
      const sample = this.river.sampleAt(s);
      const region = this.getRegionAt(s, sample);
      const critterAsset = region.primaryZone.wildlife.bankCritterAsset;
      const useIceFloe =
        region.groundStyle.iceReflectivity >= 0.45 ||
        region.groundStyle.snowCoverage >= 0.5;
      if (critterAsset && !sample.isWaterfall && sample.width >= 9.6) {
        this.spawnBankCritterGroup(s, sample.width, critterAsset, useIceFloe);
      }
      const baseStep = useIceFloe ? 78 : 105;
      this.nextCritterS += (baseStep + this.rng() * 52) * densitySpacing;
    }

    // 3. Skimming Dragonflies along reed banks (driven by `zone.wildlife.hasDragonflies`)
    while (this.nextDragonflyS < aheadS) {
      const s = this.nextDragonflyS;
      const sample = this.river.sampleAt(s);
      const region = this.getRegionAt(s, sample);
      if (!sample.isWaterfall && region.primaryZone.wildlife.hasDragonflies) {
        const pairCount = this.quality === 'high' && this.rng() < 0.45 ? 2 : 1;
        for (let i = 0; i < pairCount; i++) {
          this.spawnDragonfly(s + i * 3.5, sample.width);
        }
      }
      this.nextDragonflyS += (44 + this.rng() * 28) * densitySpacing;
    }

    // 4. Hopping Creek Frogs on bank stones (driven by `zone.wildlife.hasFrogs`)
    while (this.nextFrogS < aheadS) {
      const s = this.nextFrogS;
      const sample = this.river.sampleAt(s);
      const region = this.getRegionAt(s, sample);
      if (!sample.isWaterfall && region.primaryZone.wildlife.hasFrogs) {
        this.spawnFrog(s, sample.width);
      }
      this.nextFrogS += (82 + this.rng() * 52) * densitySpacing;
    }

    // 5. Glowing Fireflies / Ember-Flies / Spirit Motes (driven by `zone.wildlife.hasFireflies` & weather/tint data)
    while (this.nextFireflyS < aheadS) {
      const s = this.nextFireflyS;
      const sample = this.river.sampleAt(s);
      const region = this.getRegionAt(s, sample);
      if (!sample.isWaterfall && region.primaryZone.wildlife.hasFireflies) {
        this.spawnFireflyCluster(s, sample.width, region);
      }
      this.nextFireflyS += (38 + this.rng() * 22) * densitySpacing;
    }
  }

  private spawnFishSchool(
    s: number,
    width: number,
    depth: number,
    assetId: AssetId,
  ): void {
    const count = 2;
    const baseU = (this.rng() - 0.5) * width * 0.48;
    const baseY = -THREE.MathUtils.lerp(0.95, Math.min(2.1, depth - 0.8), this.rng());
    const headingSign: -1 | 1 = this.rng() < 0.65 ? -1 : 1;
    const members: FishMember[] = [];

    for (let i = 0; i < count; i++) {
      const scale = THREE.MathUtils.lerp(0.8, 1.12, this.rng());
      const mesh = assetLoader.clone(assetId);
      mesh.scale.setScalar(scale);
      mesh.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = false;
      });
      this.group.add(mesh);

      members.push({
        mesh,
        offsetS: (this.rng() - 0.5) * 4.2,
        offsetU: (this.rng() - 0.5) * 2.8,
        offsetY: (this.rng() - 0.5) * 0.65,
        phase: this.rng() * Math.PI * 2,
        scatterVelU: 0,
        scatterVelS: 0,
        scatterTimer: 0,
        scale,
      });
    }

    this.fishSchools.push({
      s,
      baseU,
      baseY,
      swimSpeed: THREE.MathUtils.lerp(1.2, 2.4, this.rng()),
      headingSign,
      assetId,
      members,
    });
  }

  private spawnBankCritterGroup(
    s: number,
    width: number,
    assetId: AssetId,
    onIceFloe: boolean,
  ): void {
    const side: -1 | 1 = this.rng() < 0.5 ? -1 : 1;
    const count = 2;
    const bankEdgeU = side * (width * 0.5 - (onIceFloe ? 1.35 : 1.15));
    const sample = this.river.sampleAt(s);
    const streamYaw = Math.atan2(sample.tangent.x, sample.tangent.z);

    for (let i = 0; i < count; i++) {
      const dS = s + (i - (count - 1) * 0.5) * (onIceFloe ? 1.45 : 1.15) + (this.rng() - 0.5) * 0.35;
      const dU = bankEdgeU - side * (0.25 + (i % 2) * 0.55);
      const scale = onIceFloe
        ? THREE.MathUtils.lerp(0.92, 1.18, this.rng())
        : THREE.MathUtils.lerp(0.88, 1.12, this.rng());

      const container = new THREE.Group();
      const pos = this.river.riverToWorld(dS, dU, 0.02);
      container.position.set(pos.x, pos.y, pos.z);

      if (onIceFloe) {
        const floe = new THREE.Mesh(this.iceFloeGeom, this.iceFloeMat);
        const floeScale = scale * 0.92;
        floe.scale.set(floeScale, 1.0, floeScale * 0.88);
        floe.position.y = -0.02;
        floe.rotation.y = this.rng() * Math.PI * 2;
        floe.receiveShadow = true;
        container.add(floe);

        const snowCap = new THREE.Mesh(this.iceFloeRimGeom, this.iceFloeMat);
        snowCap.scale.set(floeScale * 0.85, 1.0, floeScale * 0.8);
        snowCap.position.y = 0.09;
        snowCap.rotation.y = floe.rotation.y + 0.5;
        container.add(snowCap);
      }

      const critterMesh = assetLoader.clone(assetId);
      critterMesh.scale.setScalar(scale);
      critterMesh.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = false;
      });
      if (onIceFloe) {
        critterMesh.position.y = 0.14;
      }
      container.add(critterMesh);
      this.group.add(container);

      this.bankCritters.push({
        container,
        critterMesh,
        assetId,
        s: dS,
        u: dU,
        baseYaw: streamYaw - side * 0.85 + (this.rng() - 0.5) * 0.5,
        phase: this.rng() * Math.PI * 2,
        scale,
        onIceFloe,
      });
    }
  }

  private spawnDragonfly(s: number, width: number): void {
    const side: -1 | 1 = this.rng() < 0.5 ? -1 : 1;
    const anchorU = side * (width * 0.44 + (this.rng() - 0.5) * 1.4);
    const anchorY = THREE.MathUtils.lerp(0.75, 2.15, this.rng());

    const mesh = new THREE.Group();
    const mat = this.rng() < 0.55 ? this.dragonflyMatCyan : this.dragonflyMatCobalt;
    const body = new THREE.Mesh(this.dragonflyBodyGeom, mat);
    mesh.add(body);

    const wingLeftF = new THREE.Mesh(this.dragonflyWingGeom, this.dragonflyWingMat);
    wingLeftF.position.set(0.02, 0.02, 0.06);
    const wingRightF = new THREE.Mesh(this.dragonflyWingGeom, this.dragonflyWingMat);
    wingRightF.scale.x = -1;
    wingRightF.position.set(-0.02, 0.02, 0.06);

    const wingLeftB = new THREE.Mesh(this.dragonflyWingGeom, this.dragonflyWingMat);
    wingLeftB.scale.set(0.86, 1, 0.9);
    wingLeftB.position.set(0.02, 0.01, -0.05);
    const wingRightB = new THREE.Mesh(this.dragonflyWingGeom, this.dragonflyWingMat);
    wingRightB.scale.set(-0.86, 1, 0.9);
    wingRightB.position.set(-0.02, 0.01, -0.05);

    mesh.add(wingLeftF, wingRightF, wingLeftB, wingRightB);
    this.group.add(mesh);

    this.dragonflies.push({
      mesh,
      wingLeftF,
      wingRightF,
      wingLeftB,
      wingRightB,
      anchorS: s,
      anchorU,
      anchorY,
      phase: this.rng() * Math.PI * 2,
      zipSpeed: THREE.MathUtils.lerp(1.4, 2.3, this.rng()),
    });
  }

  private spawnFrog(s: number, width: number): void {
    const bankSide: -1 | 1 = this.rng() < 0.5 ? -1 : 1;
    const u = bankSide * (width * 0.5 + 0.35);
    const stoneWorld = this.river.riverToWorld(s, u, 0.05);
    const splashWorld = this.river.riverToWorld(
      s + 1.4,
      bankSide * (width * 0.5 - 1.55),
      -0.08,
    );

    const container = new THREE.Group();
    const stone = new THREE.Mesh(this.frogStoneGeom, this.frogStoneMat);
    stone.scale.set(1.15, 0.55, 1.0);
    stone.position.set(stoneWorld.x, stoneWorld.y + 0.14, stoneWorld.z);
    stone.rotation.y = this.rng() * Math.PI * 2;
    stone.receiveShadow = true;
    container.add(stone);

    const frogMesh = new THREE.Group();
    const body = new THREE.Mesh(this.frogBodyGeom, this.frogMat);
    frogMesh.add(body);

    for (const eyeSide of [-1, 1]) {
      const eye = new THREE.Mesh(this.frogEyeGeom, this.frogEyeMat);
      eye.position.set(eyeSide * 0.11, 0.12, 0.15);
      frogMesh.add(eye);

      const leg = new THREE.Mesh(this.frogLegGeom, this.frogMat);
      leg.position.set(eyeSide * 0.18, -0.04, -0.1);
      frogMesh.add(leg);
    }

    const startPos = new THREE.Vector3(stoneWorld.x, stoneWorld.y + 0.52, stoneWorld.z);
    const targetPos = new THREE.Vector3(splashWorld.x, splashWorld.y, splashWorld.z);
    frogMesh.position.copy(startPos);
    frogMesh.lookAt(targetPos.x, startPos.y, targetPos.z);
    container.add(frogMesh);
    this.group.add(container);

    this.frogs.push({
      group: container,
      frogMesh,
      s,
      u,
      bankSide,
      state: 'perched',
      hopT: 0,
      startPos,
      targetPos,
      splashed: false,
    });
  }

  private spawnFireflyCluster(
    s: number,
    width: number,
    region: BlendedEarthRegion,
  ): void {
    // 100% data-driven firefly/ember/sprite colors & buoyancy from region's wildlifeTint & weather params!
    const haloHex =
      region.primaryZone.wildlife.wildlifeTint ??
      region.weather.particleColor ??
      0x38e54d;
    const coreHex =
      region.weather.secondaryParticleColor ??
      region.weather.particleColor ??
      0xb8ff78;
    const rising = region.weather.gravity < -0.05;

    const moteCount = this.quality === 'high' ? 6 : 4;
    const motes: FireflyMote[] = [];

    for (let i = 0; i < moteCount; i++) {
      const side: -1 | 1 = i % 2 === 0 ? 1 : -1;
      const offsetS = (this.rng() - 0.5) * 14.0;
      const offsetU = side * THREE.MathUtils.lerp(width * 0.18, width * 0.52, this.rng());
      const offsetY = THREE.MathUtils.lerp(0.65, 2.85, this.rng());

      const coreMat = new THREE.MeshBasicMaterial({
        color: coreHex,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const haloMat = new THREE.MeshBasicMaterial({
        color: haloHex,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });

      const moteGroup = new THREE.Group();
      const coreMesh = new THREE.Mesh(this.fireflyCoreGeom, coreMat);
      const haloMesh = new THREE.Mesh(this.fireflyHaloGeom, haloMat);
      coreMesh.renderOrder = 9;
      haloMesh.renderOrder = 9;
      moteGroup.add(coreMesh, haloMesh);
      this.group.add(moteGroup);

      motes.push({
        mesh: moteGroup,
        coreMat,
        haloMat,
        offsetS,
        offsetU,
        offsetY,
        phase: this.rng() * Math.PI * 2,
        speed: THREE.MathUtils.lerp(1.1, 2.2, this.rng()),
      });
    }

    this.fireflyClusters.push({
      s,
      rising,
      motes,
    });
  }

  private updateFishSchools(
    duck: DuckState,
    dt: number,
    time: number,
    pruneS: number,
  ): void {
    for (let i = this.fishSchools.length - 1; i >= 0; i--) {
      const school = this.fishSchools[i];
      if (school.s < pruneS) {
        for (const m of school.members) this.group.remove(m.mesh);
        this.fishSchools.splice(i, 1);
        continue;
      }

      const sample = this.river.sampleAt(school.s);
      const streamYaw = Math.atan2(sample.tangent.x, sample.tangent.z);
      const navLimit = sample.width * 0.42;

      for (let j = 0; j < school.members.length; j++) {
        const m = school.members[j];
        const fishS = school.s + m.offsetS + Math.sin(time * 0.9 + m.phase) * 0.9;
        const fishU = THREE.MathUtils.clamp(
          school.baseU + m.offsetU + Math.cos(time * 0.75 + m.phase) * 0.7,
          -navLimit,
          navLimit,
        );
        const fishY = school.baseY + m.offsetY + Math.sin(time * 1.5 + m.phase) * 0.16;

        const ds = fishS - duck.s;
        const du = fishU - duck.u;
        if (duck.isUnderwater && m.scatterTimer <= 0 && ds * ds + du * du < 130) {
          m.scatterTimer = 1.4;
          const awayU = du >= 0 ? 1 : -1;
          m.scatterVelU = awayU * (4.5 + this.rng() * 2.5);
          m.scatterVelS = (ds >= 0 ? 1 : -1) * (3.2 + this.rng() * 2.2);
        }

        if (m.scatterTimer > 0) {
          m.scatterTimer = Math.max(0, m.scatterTimer - dt);
          m.offsetU += m.scatterVelU * dt;
          m.offsetS += m.scatterVelS * dt;
          m.scatterVelU *= Math.exp(-2.4 * dt);
          m.scatterVelS *= Math.exp(-2.4 * dt);
        }

        const worldPos = this.river.riverToWorld(fishS, fishU, fishY);
        m.mesh.position.set(worldPos.x, worldPos.y, worldPos.z);

        const wiggleFreq = m.scatterTimer > 0 ? 19.0 : 8.5;
        const wiggleAmp = m.scatterTimer > 0 ? 0.34 : 0.16;
        const swimYaw =
          streamYaw +
          (school.headingSign < 0 ? Math.PI : 0) +
          (m.scatterTimer > 0 ? Math.atan2(m.scatterVelU, m.scatterVelS || 0.1) * 0.35 : 0);

        m.mesh.rotation.set(
          Math.sin(time * 2.1 + m.phase) * 0.06,
          swimYaw + Math.sin(time * wiggleFreq + m.phase) * wiggleAmp,
          Math.cos(time * wiggleFreq + m.phase) * 0.1,
        );
      }
    }
  }

  private updateBankCritters(duck: DuckState, time: number, pruneS: number): void {
    for (let i = this.bankCritters.length - 1; i >= 0; i--) {
      const c = this.bankCritters[i];
      if (c.s < pruneS) {
        this.group.remove(c.container);
        this.bankCritters.splice(i, 1);
        continue;
      }

      const waterY = this.river.getWaterHeightAtRiver(c.s, c.u, time);
      const pos = this.river.riverToWorld(c.s, c.u, 0);
      const happyBob = Math.sin(time * (c.onIceFloe ? 3.2 : 4.6) + c.phase) * 0.065;
      c.container.position.set(pos.x, waterY + 0.02 + happyBob, pos.z);

      const dx = duck.worldPos.x - pos.x;
      const dz = duck.worldPos.z - pos.z;
      const distSq = dx * dx + dz * dz;
      const targetYaw =
        distSq < 280 ? Math.atan2(dx, dz) : c.baseYaw + Math.sin(time * 1.1 + c.phase) * 0.25;

      if (c.onIceFloe) {
        c.container.rotation.set(
          Math.sin(time * 2.6 + c.phase) * 0.05,
          0,
          Math.cos(time * 2.9 + c.phase) * 0.06,
        );
        const hopY = distSq < 220 ? Math.abs(Math.sin(time * 7.5 + c.phase)) * 0.12 : 0;
        c.critterMesh.position.y = 0.14 + hopY;
        c.critterMesh.rotation.set(
          0,
          targetYaw,
          Math.sin(time * 5.8 + c.phase) * 0.12,
        );
      } else {
        c.critterMesh.rotation.set(
          Math.sin(time * 3.8 + c.phase) * 0.08,
          targetYaw,
          Math.cos(time * 4.2 + c.phase) * 0.1,
        );
      }
    }
  }

  private updateDragonflies(time: number, pruneS: number): void {
    for (let i = this.dragonflies.length - 1; i >= 0; i--) {
      const df = this.dragonflies[i];
      if (df.anchorS < pruneS) {
        this.group.remove(df.mesh);
        this.dragonflies.splice(i, 1);
        continue;
      }

      const t = time * df.zipSpeed + df.phase;
      const s = df.anchorS + Math.sin(t) * 2.8;
      const u = df.anchorU + Math.sin(t * 2.0) * 1.15;
      const y = df.anchorY + Math.cos(t * 1.7) * 0.35;

      const worldPos = this.river.riverToWorld(s, u, y);
      const prevPos = df.mesh.position;
      const vx = worldPos.x - prevPos.x;
      const vz = worldPos.z - prevPos.z;
      df.mesh.position.set(worldPos.x, worldPos.y, worldPos.z);

      if (vx * vx + vz * vz > 1e-6) {
        df.mesh.rotation.y = Math.atan2(vx, vz);
      }
      df.mesh.rotation.z = Math.sin(t * 2.0) * 0.22;

      const flapA = Math.sin(time * 52.0 + df.phase) * 0.58;
      const flapB = Math.sin(time * 52.0 + df.phase + 0.9) * 0.54;
      df.wingLeftF.rotation.z = flapA;
      df.wingRightF.rotation.z = -flapA;
      df.wingLeftB.rotation.z = flapB;
      df.wingRightB.rotation.z = -flapB;
    }
  }

  private updateFrogs(duck: DuckState, dt: number, pruneS: number): void {
    for (let i = this.frogs.length - 1; i >= 0; i--) {
      const frog = this.frogs[i];
      if (frog.s < pruneS) {
        this.group.remove(frog.group);
        this.frogs.splice(i, 1);
        continue;
      }

      if (frog.state === 'perched') {
        const ds = frog.s - duck.s;
        if (ds < 16 && ds > -2) {
          frog.state = 'hopping';
          frog.hopT = 0;
        }
      } else if (frog.state === 'hopping') {
        frog.hopT = Math.min(1, frog.hopT + dt * 2.15);
        const t = frog.hopT;
        frog.frogMesh.position.lerpVectors(frog.startPos, frog.targetPos, t);
        frog.frogMesh.position.y += Math.sin(t * Math.PI) * 1.15;
        frog.frogMesh.rotation.x = (t - 0.45) * 1.3;

        if (t >= 1) {
          frog.state = 'submerged';
          frog.frogMesh.visible = false;
          if (!frog.splashed) {
            frog.splashed = true;
            this.callbacks.onMiniSplash?.({
              x: frog.targetPos.x,
              y: frog.targetPos.y + 0.1,
              z: frog.targetPos.z,
            });
          }
        }
      }
    }
  }

  private updateFireflies(time: number, pruneS: number): void {
    for (let i = this.fireflyClusters.length - 1; i >= 0; i--) {
      const cluster = this.fireflyClusters[i];
      if (cluster.s < pruneS) {
        for (const mote of cluster.motes) {
          this.group.remove(mote.mesh);
          mote.coreMat.dispose();
          mote.haloMat.dispose();
        }
        this.fireflyClusters.splice(i, 1);
        continue;
      }

      for (let j = 0; j < cluster.motes.length; j++) {
        const m = cluster.motes[j];
        const t = time * m.speed + m.phase;
        const s = cluster.s + m.offsetS + Math.sin(t * 0.7) * 1.35;
        const u = m.offsetU + Math.cos(t * 0.9) * 1.15;
        const y = cluster.rising
          ? m.offsetY + ((time * m.speed * 0.65 + m.phase) % 2.4)
          : m.offsetY + Math.sin(t * 1.3) * 0.45;

        const worldPos = this.river.riverToWorld(s, u, y);
        m.mesh.position.set(worldPos.x, worldPos.y, worldPos.z);

        const pulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(time * 4.2 + m.phase * 2.1));
        m.coreMat.opacity = 0.55 + pulse * 0.42;
        m.haloMat.opacity = 0.14 + pulse * 0.28;
        m.mesh.scale.setScalar(0.78 + pulse * 0.42);
      }
    }
  }
}
