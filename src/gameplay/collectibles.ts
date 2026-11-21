import * as THREE from 'three';
import { DUCK_CONFIG, POWERUP_CONFIG, RIVER_CONFIG, SCORING_CONFIG } from '../config';
import type {
  CaveBranchInfo,
  CollectibleItem,
  CollectibleKind,
  DuckState,
  PowerUpType,
  ResolvedQuality,
  RiverProvider,
  Vec3,
} from '../types';
import type { ObstacleClusterMeta, ObstacleSpawner } from './obstacleSpawner';

export interface CollectionEvent {
  item: CollectibleItem;
  isPowerUp: boolean;
  worldPos: Vec3;
}

interface ActiveSpecialVisual {
  item: CollectibleItem;
  mesh: THREE.Group;
  ringA?: THREE.Object3D;
  ringB?: THREE.Object3D;
  core?: THREE.Object3D;
}

const MAX_BUBBLE_INSTANCES = 220;
const POWERUP_ROTATION: readonly PowerUpType[] = [
  'wing_gust',
  'soap_shield',
  'magnet',
  'bubble_lung',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isPowerUpKind(kind: CollectibleKind): kind is PowerUpType {
  return (
    kind === 'wing_gust' ||
    kind === 'bubble_lung' ||
    kind === 'soap_shield' ||
    kind === 'magnet'
  );
}

/**
 * Spawns shimmering Golden Bubbles / Dewdrops along readable kayaking racing lines
 * (around boulders, parabolic jump arcs over driftwood roots, submerged dive lines
 * under log arches, packed cave shortcut runs, waterfall drop arcs, and sky flight arcs)
 * plus distinct glowing 3D Power-Up Orbs (`wing_gust`, `bubble_lung`, `soap_shield`, `magnet`).
 */
export class Collectibles {
  public readonly group = new THREE.Group();

  private readonly river: RiverProvider;
  private readonly obstacleSpawner: ObstacleSpawner;
  private rng: () => number;
  private quality: ResolvedQuality = 'high';

  // Instanced Golden Bubbles / Dewdrops (2 draw calls total for up to 220 items!)
  private readonly bubbleCoreMesh: THREE.InstancedMesh;
  private readonly bubbleShellMesh: THREE.InstancedMesh;
  private readonly bubbleCoreGeom: THREE.SphereGeometry;
  private readonly bubbleShellGeom: THREE.SphereGeometry;
  private readonly bubbleCoreMat: THREE.MeshStandardMaterial;
  private readonly bubbleShellMat: THREE.MeshPhysicalMaterial;

  // Shared geometries & materials for Golden Feathers and Power-Up Orbs
  private readonly featherVaneGeom: THREE.SphereGeometry;
  private readonly featherQuillGeom: THREE.CylinderGeometry;
  private readonly featherMat: THREE.MeshPhysicalMaterial;
  private readonly featherHaloMat: THREE.MeshBasicMaterial;
  private readonly auraSphereGeom: THREE.SphereGeometry;
  private readonly swirlArcGeom: THREE.TorusGeometry;
  private readonly smallOrbGeom: THREE.SphereGeometry;
  private readonly sparkleMoteGeom: THREE.OctahedronGeometry;
  private readonly wingBladeGeom: THREE.SphereGeometry;
  private readonly powerUpMaterials: Record<
    PowerUpType,
    {
      core: THREE.MeshPhysicalMaterial;
      aura: THREE.MeshPhysicalMaterial;
      ring: THREE.MeshBasicMaterial;
    }
  >;

  private readonly items: CollectibleItem[] = [];
  private readonly specials = new Map<string, ActiveSpecialVisual>();
  private readonly handledClusters = new Set<string>();
  private readonly handledCaves = new Set<string>();
  private readonly handledWaterfallKeys = new Set<number>();

  private itemSeq = 0;
  private nextFreeRibbonS = 18;
  private nextPowerUpS = 68;
  private powerUpCycleIndex = 0;
  private lastSkyArcS = -100;

  // Scratch math objects (zero per-frame GC churn)
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();

  constructor(
    river: RiverProvider,
    obstacleSpawner: ObstacleSpawner,
    seed: number = 4242,
  ) {
    this.river = river;
    this.obstacleSpawner = obstacleSpawner;
    this.group.name = 'collectibles_root';
    this.rng = mulberry32(seed);

    // Golden Bubble / Dewdrop instanced meshes (refined sunlit pearlescent droplets!)
    this.bubbleCoreGeom = new THREE.SphereGeometry(0.175, 8, 6);
    this.bubbleCoreGeom.scale(0.92, 1.15, 0.92);
    this.bubbleCoreMat = new THREE.MeshStandardMaterial({
      color: 0xffd54f,
      emissive: 0xff9500,
      emissiveIntensity: 0.78,
      roughness: 0.12,
      metalness: 0.45,
    });

    this.bubbleShellGeom = new THREE.SphereGeometry(0.3, 10, 8);
    this.bubbleShellMat = new THREE.MeshPhysicalMaterial({
      color: 0xfff8dc,
      emissive: 0xffc830,
      emissiveIntensity: 0.2,
      roughness: 0.04,
      metalness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });

    this.bubbleCoreMesh = new THREE.InstancedMesh(
      this.bubbleCoreGeom,
      this.bubbleCoreMat,
      MAX_BUBBLE_INSTANCES,
    );
    this.bubbleCoreMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bubbleCoreMesh.frustumCulled = false;

    this.bubbleShellMesh = new THREE.InstancedMesh(
      this.bubbleShellGeom,
      this.bubbleShellMat,
      MAX_BUBBLE_INSTANCES,
    );
    this.bubbleShellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bubbleShellMesh.frustumCulled = false;
    this.bubbleShellMesh.renderOrder = 8;

    this.group.add(this.bubbleCoreMesh, this.bubbleShellMesh);

    // Shared special item geometries (sleek jewel-like orbs & translucent wind ribbons!)
    this.featherVaneGeom = new THREE.SphereGeometry(0.24, 12, 10);
    this.featherVaneGeom.scale(0.62, 1.95, 0.16);
    this.featherQuillGeom = new THREE.CylinderGeometry(0.016, 0.022, 0.96, 6);
    this.featherMat = new THREE.MeshPhysicalMaterial({
      color: 0xffe45c,
      emissive: 0xff9f00,
      emissiveIntensity: 0.75,
      roughness: 0.16,
      metalness: 0.6,
      clearcoat: 0.85,
    });
    this.featherHaloMat = new THREE.MeshBasicMaterial({
      color: 0xffdf6b,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.auraSphereGeom = new THREE.SphereGeometry(0.54, 18, 14);
    // Slender translucent energy ribbon arc (NO opaque bulky donuts!)
    this.swirlArcGeom = new THREE.TorusGeometry(0.58, 0.028, 8, 22, Math.PI * 1.22);
    this.smallOrbGeom = new THREE.SphereGeometry(0.18, 12, 10);
    this.sparkleMoteGeom = new THREE.OctahedronGeometry(0.065, 0);
    this.wingBladeGeom = new THREE.SphereGeometry(0.18, 10, 8);
    this.wingBladeGeom.scale(1.65, 0.24, 0.62);

    this.powerUpMaterials = {
      wing_gust: this.makePowerUpMaterials('wing_gust'),
      bubble_lung: this.makePowerUpMaterials('bubble_lung'),
      soap_shield: this.makePowerUpMaterials('soap_shield'),
      magnet: this.makePowerUpMaterials('magnet'),
    };
  }

  public setQuality(quality: ResolvedQuality): void {
    this.quality = quality;
    this.bubbleShellMesh.visible = quality === 'high';
  }

  public reset(seed: number = 4242): void {
    this.clearAll();
    this.rng = mulberry32(seed);
    this.itemSeq = 0;
    this.nextFreeRibbonS = 16;
    this.nextPowerUpS = 68;
    this.powerUpCycleIndex = 0;
    this.lastSkyArcS = -100;
    this.handledClusters.clear();
    this.handledCaves.clear();
    this.handledWaterfallKeys.clear();
  }

  /**
   * Stream new racing lines & power-ups ahead of the duck, animate floating orbs,
   * apply magnet attraction, and return any newly collected items this frame.
   */
  public update(duck: DuckState, dt: number, time: number): CollectionEvent[] {
    const aheadS = duck.s + RIVER_CONFIG.aheadDistance - 15;
    const pruneS = duck.s - RIVER_CONFIG.behindDistance;

    // 1. Spawn obstacle-guided racing lines (jump arcs, dive ribbons, slalom lines)
    this.spawnClusterLines(duck.s - 5, aheadS);

    // 2. Spawn cave treasure runs + pre-cave Bubble Lung orbs
    this.spawnCaveLines(duck.s - 10, aheadS + 30);

    // 3. Spawn waterfall plunge-arc trails
    this.spawnWaterfallArcs(duck.s, aheadS);

    // 4. Spawn sweeping open-river lines & balanced Power-Up Orbs
    this.spawnOpenRiverLinesAndPowerUps(aheadS);

    // 5. Spawn thrilling high aerial sky arcs whenever Wing Gust flight is active!
    if (duck.flightRemaining > 1.2 && duck.s + 26 > this.lastSkyArcS + 28) {
      this.spawnSkyFlightArc(Math.max(duck.s + 24, this.lastSkyArcS + 28));
    }

    // 6. Update magnet attraction, collection detection, animations, and instanced transforms
    const collectedEvents: CollectionEvent[] = [];
    const duckPos = duck.worldPos;
    const magnetActive = duck.magnetRemaining > 0 && !duck.isCrashed;
    const magnetRadiusSq = SCORING_CONFIG.magnetPullRadius * SCORING_CONFIG.magnetPullRadius;
    const baseCollectPad = DUCK_CONFIG.collisionRadius + 0.48;

    let bubbleCount = 0;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];

      // Prune collected or far-behind items
      if (item.collected || item.s < pruneS) {
        this.removeSpecialVisual(item.id);
        this.items.splice(i, 1);
        continue;
      }

      const bobY = Math.sin(time * 3.4 + item.bobPhase) * 0.14;

      // Magnet pulls Golden Bubbles & Feathers smoothly along the current toward the duck
      if (
        magnetActive &&
        (item.kind === 'bubble_coin' || item.kind === 'golden_feather')
      ) {
        const dx = duckPos.x - item.worldPos.x;
        const dy = duckPos.y + 0.35 - (item.worldPos.y + bobY);
        const dz = duckPos.z - item.worldPos.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq < magnetRadiusSq && distSq > 1e-4) {
          const dist = Math.sqrt(distSq);
          const pullStep = Math.min(dist, SCORING_CONFIG.magnetPullSpeed * dt * (1.25 - dist / (SCORING_CONFIG.magnetPullRadius * 1.3)));
          const inv = pullStep / dist;
          item.worldPos.x += dx * inv;
          item.worldPos.y += dy * inv;
          item.worldPos.z += dz * inv;
        }
      }

      // Collection detection
      if (!duck.isCrashed) {
        const dx = duckPos.x - item.worldPos.x;
        const dy = duckPos.y + 0.32 - (item.worldPos.y + bobY);
        const dz = duckPos.z - item.worldPos.z;
        const hitRadius = item.radius + baseCollectPad;
        if (dx * dx + dy * dy + dz * dz <= hitRadius * hitRadius) {
          item.collected = true;
          collectedEvents.push({
            item,
            isPowerUp: isPowerUpKind(item.kind),
            worldPos: {
              x: item.worldPos.x,
              y: item.worldPos.y + bobY,
              z: item.worldPos.z,
            },
          });
          this.removeSpecialVisual(item.id);
          this.items.splice(i, 1);
          continue;
        }
      }

      // Render transform update
      if (item.kind === 'bubble_coin') {
        if (bubbleCount < MAX_BUBBLE_INSTANCES) {
          const pulse = 1.0 + Math.sin(time * 5.2 + item.bobPhase * 1.7) * 0.08;
          this.tmpPos.set(item.worldPos.x, item.worldPos.y + bobY, item.worldPos.z);
          this.tmpQuat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, time * 1.6 + item.bobPhase);
          this.tmpScale.setScalar(pulse);
          this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
          this.bubbleCoreMesh.setMatrixAt(bubbleCount, this.tmpMatrix);

          if (this.quality === 'high') {
            this.tmpScale.setScalar(pulse * 1.02);
            this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
            this.bubbleShellMesh.setMatrixAt(bubbleCount, this.tmpMatrix);
          }
          bubbleCount += 1;
        }
      } else {
        const visual = this.specials.get(item.id);
        if (visual) {
          visual.mesh.position.set(
            item.worldPos.x,
            item.worldPos.y + bobY * 1.35,
            item.worldPos.z,
          );
          visual.mesh.rotation.y = time * 1.9 + item.bobPhase;
          if (visual.ringA) {
            visual.ringA.rotation.x = time * 2.5 + item.bobPhase;
            visual.ringA.rotation.z = time * 1.4;
          }
          if (visual.ringB) {
            visual.ringB.rotation.y = -time * 2.8;
            visual.ringB.rotation.x = Math.PI * 0.35 + Math.sin(time * 2.2) * 0.35;
          }
          if (visual.core) {
            const s = 1 + Math.sin(time * 6.0 + item.bobPhase) * 0.1;
            visual.core.scale.setScalar(s);
          }
        }
      }
    }

    this.bubbleCoreMesh.count = bubbleCount;
    this.bubbleCoreMesh.instanceMatrix.needsUpdate = true;
    this.bubbleShellMesh.count = this.quality === 'high' ? bubbleCount : 0;
    this.bubbleShellMesh.instanceMatrix.needsUpdate = true;

    return collectedEvents;
  }

  /**
   * Manually spawn a power-up right ahead of the duck (useful for QA showcase modes).
   */
  public spawnPowerUpAt(s: number, u: number, type: PowerUpType, y: number = 0.85): CollectibleItem {
    return this.addItem(type, s, u, y, false);
  }

  /**
   * Spawn an immediate sky flight arc ahead of `startS` (called when Wing Gust activates!).
   */
  public spawnSkyFlightArc(startS: number): void {
    this.lastSkyArcS = startS;
    const side = this.rng() < 0.5 ? -1 : 1;
    const count = 8;
    for (let i = 0; i < count; i++) {
      const frac = i / (count - 1);
      const s = startS + i * 4.2;
      const sample = this.river.sampleAt(s);
      const sway = Math.sin(frac * Math.PI) * side * Math.min(3.4, sample.width * 0.26);
      // Matches DuckController's soaring Wing Gust cruising altitude (~5.6..6.9u)!
      const y = 5.6 + Math.sin(frac * Math.PI) * 1.15;
      const kind: CollectibleKind = i === Math.floor(count / 2) ? 'golden_feather' : 'bubble_coin';
      this.addItem(kind, s, sway, y, false);
    }
  }

  public getActiveCount(): number {
    return this.items.length;
  }

  /**
   * Re-project all active collectible world positions after a Floating-Origin ENU recenter.
   */
  public syncWorldPositions(): void {
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      item.worldPos = this.river.riverToWorld(item.s, item.u, item.y);
      const visual = this.specials.get(item.id);
      if (visual) {
        visual.mesh.position.set(item.worldPos.x, item.worldPos.y, item.worldPos.z);
      }
    }
  }

  public dispose(): void {
    this.clearAll();
    this.bubbleCoreGeom.dispose();
    this.bubbleShellGeom.dispose();
    this.bubbleCoreMat.dispose();
    this.bubbleShellMat.dispose();
    this.featherVaneGeom.dispose();
    this.featherQuillGeom.dispose();
    this.featherMat.dispose();
    this.featherHaloMat.dispose();
    this.auraSphereGeom.dispose();
    this.swirlArcGeom.dispose();
    this.smallOrbGeom.dispose();
    this.sparkleMoteGeom.dispose();
    this.wingBladeGeom.dispose();
    for (const type of POWERUP_ROTATION) {
      this.powerUpMaterials[type].core.dispose();
      this.powerUpMaterials[type].aura.dispose();
      this.powerUpMaterials[type].ring.dispose();
    }
  }

  private clearAll(): void {
    for (const visual of this.specials.values()) {
      this.group.remove(visual.mesh);
    }
    this.specials.clear();
    this.items.length = 0;
    this.bubbleCoreMesh.count = 0;
    this.bubbleShellMesh.count = 0;
    this.bubbleCoreMesh.instanceMatrix.needsUpdate = true;
    this.bubbleShellMesh.instanceMatrix.needsUpdate = true;
  }

  private spawnClusterLines(sStart: number, sEnd: number): void {
    const clusters = this.obstacleSpawner.getClustersInRange(sStart, sEnd);
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      if (this.handledClusters.has(cluster.id)) continue;
      this.handledClusters.add(cluster.id);
      this.buildLineForCluster(cluster);
    }
  }

  private buildLineForCluster(cluster: ObstacleClusterMeta): void {
    const { s, maneuver, recommendedLineU, highRewardChuteU } = cluster;

    if (maneuver === 'jump') {
      // Parabolic jump arc naturally teaching jump timing & height over driftwood roots!
      const count = 5;
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1) - 0.5; // -0.5 .. +0.5
        const itemS = s + t * 9.2;
        const arcNorm = 1 - 4 * t * t; // 0 at ends, 1 at peak
        const y = 0.65 + arcNorm * 1.55;
        const kind: CollectibleKind =
          i === 2 && this.rng() < 0.35 ? 'golden_feather' : 'bubble_coin';
        this.addItem(kind, itemS, recommendedLineU, y, false);
      }

      if (highRewardChuteU !== undefined) {
        // Bonus slalom bubbles through the tight gap beside split-choice jump logs
        for (let i = -1; i <= 1; i++) {
          this.addItem('bubble_coin', s + i * 2.6, highRewardChuteU, 0.58, false);
        }
      }
      return;
    }

    if (maneuver === 'dive') {
      // Submerged diving line dipping cleanly under fallen log arches!
      const count = 5;
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1) - 0.5;
        const itemS = s + t * 10.5;
        const dipNorm = 1 - 4 * t * t; // 0 at ends, 1 directly under log
        const y = -0.45 - dipNorm * 1.38;
        const kind: CollectibleKind =
          i === 2 && this.rng() < 0.3 ? 'golden_feather' : 'bubble_coin';
        this.addItem(kind, itemS, recommendedLineU, y, false);
      }
      return;
    }

    // Slalom / Rock Island racing lines
    if (highRewardChuteU !== undefined) {
      // Safer channel gets steady guide bubbles; tighter high-reward chute gets dense treasure + feather!
      for (let i = -1; i <= 1; i++) {
        this.addItem('bubble_coin', s + i * 3.0, recommendedLineU, 0.58, false);
      }
      for (let i = -2; i <= 2; i++) {
        const kind: CollectibleKind = i === 0 ? 'golden_feather' : 'bubble_coin';
        this.addItem(kind, s + i * 2.2, highRewardChuteU, 0.68, false);
      }
    } else {
      // Sweeping racing curve around boulders/snags
      const count = 5;
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1) - 0.5;
        const itemS = s + t * 10.0;
        const curvePull = 1 - 3.2 * t * t;
        const u = recommendedLineU * Math.max(0.25, curvePull);
        this.addItem('bubble_coin', itemS, u, 0.56, false);
      }
    }
  }

  private spawnCaveLines(sStart: number, sEnd: number): void {
    const caves = this.river.getCaveBranches(sStart, sEnd);
    for (let i = 0; i < caves.length; i++) {
      const cave = caves[i];
      if (this.handledCaves.has(cave.id)) continue;
      this.handledCaves.add(cave.id);
      this.populateCaveShortcut(cave);
    }
  }

  private populateCaveShortcut(cave: CaveBranchInfo): void {
    // 1. Place an inviting Bubble Lung Power-Up upstream on the cave's bank side
    const preS = Math.max(24, cave.startS - 22);
    const preSample = this.river.sampleAt(preS);
    const preU = cave.side * Math.min(preSample.width * 0.34, 4.2);
    this.addItem('bubble_lung', preS, preU, 0.88, false);

    // 2. Leading dive-guide breadcrumbs pointing right into the flooded cave mouth
    for (let i = 0; i < 4; i++) {
      const frac = i / 3;
      const leadS = cave.startS - 11 + frac * 11;
      const leadSample = this.river.sampleAt(leadS);
      const leadU = cave.side * THREE.MathUtils.lerp(leadSample.width * 0.36, cave.maxOffset * 0.52, frac);
      const leadY = THREE.MathUtils.lerp(0.25, -1.25, frac);
      this.addItem('bubble_coin', leadS, leadU, leadY, false);
    }

    // 3. Packed treasure ribbon curving dead-center through the submerged cave shortcut!
    // Synced with RiverSpline.getCaveCenterU: side * (width*0.36 + (maxOffset - width*0.36) * sin(frac*PI))
    const length = cave.endS - cave.startS;
    const count = Math.max(10, Math.floor(length / 4.2));
    for (let i = 0; i < count; i++) {
      const frac = (i + 0.5) / count;
      const s = cave.startS + frac * length;
      const sample = this.river.sampleAt(s);
      const entryOffset = sample.width * 0.36;
      const centerU =
        cave.side * (entryOffset + (cave.maxOffset - entryOffset) * Math.sin(frac * Math.PI));
      const u = centerU + Math.sin(frac * Math.PI * 3) * 0.55;
      const y = -0.95 - Math.sin(frac * Math.PI) * 0.45;
      const isFeather = i === Math.floor(count * 0.33) || i === Math.floor(count * 0.66);
      this.addItem(isFeather ? 'golden_feather' : 'bubble_coin', s, u, y, true);
    }
  }

  private spawnWaterfallArcs(sStart: number, sEnd: number): void {
    for (let s = Math.max(30, Math.floor(sStart / 8) * 8); s <= sEnd; s += 8) {
      const sample = this.river.sampleAt(s);
      if (!sample.isWaterfall) continue;
      // Quantize waterfall bucket so we spawn one dramatic arc per waterfall
      const bucket = Math.floor(s / 60);
      if (this.handledWaterfallKeys.has(bucket)) continue;
      this.handledWaterfallKeys.add(bucket);

      // Find exact waterfall lip start
      let lipS = s;
      while (lipS > 4 && this.river.sampleAt(lipS - 2).isWaterfall) {
        lipS -= 2;
      }

      const arcCount = 6;
      for (let i = 0; i < arcCount; i++) {
        const frac = i / (arcCount - 1);
        const itemS = lipS + frac * 13.5;
        const y = 1.1 + Math.sin(frac * Math.PI) * 2.2;
        const kind: CollectibleKind = i === 2 ? 'golden_feather' : 'bubble_coin';
        this.addItem(kind, itemS, 0, y, false);
      }
    }
  }

  private spawnOpenRiverLinesAndPowerUps(aheadS: number): void {
    // Opening welcoming ribbon right at the start of the creek
    while (this.nextFreeRibbonS < aheadS) {
      const s = this.nextFreeRibbonS;
      const nearby = this.obstacleSpawner.getObstaclesInRange(s - 6, s + 14);
      const sample = this.river.sampleAt(s);

      if (nearby.length === 0 && !sample.isWaterfall) {
        const navHalfW = Math.max(2.2, sample.width * 0.34);
        const phase = this.rng() * Math.PI * 2;
        const side = this.rng() < 0.5 ? -1 : 1;
        for (let i = 0; i < 5; i++) {
          const frac = i / 4;
          const itemS = s + i * 2.8;
          const u = Math.sin(frac * Math.PI + phase * 0.15) * side * navHalfW * 0.68;
          this.addItem('bubble_coin', itemS, u, 0.55, false);
        }
      }

      this.nextFreeRibbonS += 34 + this.rng() * 18;
    }

    // Balanced Power-Up Orbs every ~72–112u in clean navigable corridors
    while (this.nextPowerUpS < aheadS) {
      const s = this.nextPowerUpS;
      const sample = this.river.sampleAt(s);
      if (!sample.isWaterfall) {
        const type = POWERUP_ROTATION[this.powerUpCycleIndex % POWERUP_ROTATION.length];
        this.powerUpCycleIndex += 1;

        const safeU = this.findSafeLateralU(s, sample);
        this.addItem(type, s, safeU, 0.92, false);

        // If Wing Gust orb spawned, preview an enticing high aerial arc just downstream!
        if (type === 'wing_gust') {
          this.spawnSkyFlightArc(s + 16);
        }
      }

      this.nextPowerUpS += 74 + this.rng() * 38;
    }
  }

  private findSafeLateralU(s: number, sample: { width: number }): number {
    const navHalfW = Math.max(2.0, sample.width * 0.5 - DUCK_CONFIG.bankPadding - 0.8);
    const nearby = this.obstacleSpawner.getObstaclesInRange(s - 5, s + 5);
    let candidateU = (this.rng() - 0.5) * navHalfW * 1.1;

    for (let attempt = 0; attempt < 5; attempt++) {
      let clear = true;
      for (let i = 0; i < nearby.length; i++) {
        const obs = nearby[i];
        if (obs.type === 'boulder' || obs.type === 'snag') {
          if (Math.abs(candidateU - obs.u) < obs.radius + 1.4) {
            clear = false;
            candidateU = -Math.sign(obs.u || 1) * Math.min(navHalfW, Math.abs(obs.u) + obs.radius + 1.6);
            break;
          }
        }
      }
      if (clear) break;
    }

    return THREE.MathUtils.clamp(candidateU, -navHalfW, navHalfW);
  }

  private addItem(
    kind: CollectibleKind,
    s: number,
    u: number,
    y: number,
    inCave: boolean,
  ): CollectibleItem {
    const id = `col_${++this.itemSeq}`;
    const worldPos = this.river.riverToWorld(s, u, y);
    const powerUp = isPowerUpKind(kind) ? kind : undefined;
    const value =
      kind === 'bubble_coin'
        ? SCORING_CONFIG.bubbleCoinPoints
        : kind === 'golden_feather'
          ? SCORING_CONFIG.goldenFeatherPoints
          : 75;

    const item: CollectibleItem = {
      id,
      kind,
      powerUpType: powerUp,
      s,
      u,
      y,
      worldPos,
      radius: powerUp ? 0.78 : kind === 'golden_feather' ? 0.62 : 0.45,
      value,
      collected: false,
      inCave,
      bobPhase: this.rng() * Math.PI * 2,
    };

    this.items.push(item);

    if (kind !== 'bubble_coin') {
      const visual = this.createSpecialVisual(item);
      this.specials.set(id, visual);
      this.group.add(visual.mesh);
    }

    return item;
  }

  private createSpecialVisual(item: CollectibleItem): ActiveSpecialVisual {
    const mesh = new THREE.Group();
    mesh.position.set(item.worldPos.x, item.worldPos.y, item.worldPos.z);

    if (item.kind === 'golden_feather') {
      const featherGroup = new THREE.Group();
      const vane = new THREE.Mesh(this.featherVaneGeom, this.featherMat);
      vane.position.y = 0.08;
      vane.rotation.z = 0.24;
      const quill = new THREE.Mesh(this.featherQuillGeom, this.featherMat);
      quill.rotation.z = 0.24;
      featherGroup.add(vane, quill);
      mesh.add(featherGroup);

      // Delicate translucent golden shimmer ribbon arc
      const halo = new THREE.Mesh(this.swirlArcGeom, this.featherHaloMat);
      halo.scale.setScalar(0.84);
      halo.renderOrder = 9;
      mesh.add(halo);
      return { item, mesh, ringA: halo, core: featherGroup };
    }

    const pType: PowerUpType = item.powerUpType ?? 'wing_gust';
    const mats = this.powerUpMaterials[pType];

    // Lustrous translucent crystal/soap energy orb (renderOrder > waterMesh's 5!)
    const aura = new THREE.Mesh(this.auraSphereGeom, mats.aura);
    aura.renderOrder = 8;
    mesh.add(aura);

    // Distinct floating 3D icon inside each power-up orb
    const coreGroup = new THREE.Group();
    mesh.add(coreGroup);

    // Slender translucent swirling energy ribbon arcs (additive glow — never opaque plastic!)
    const ringA = new THREE.Group();
    const arc1 = new THREE.Mesh(this.swirlArcGeom, mats.ring);
    arc1.renderOrder = 9;
    const mote1 = new THREE.Mesh(this.sparkleMoteGeom, mats.ring);
    mote1.position.set(0.58, 0, 0);
    mote1.renderOrder = 9;
    ringA.add(arc1, mote1);
    mesh.add(ringA);

    const ringB = new THREE.Group();
    const arc2 = new THREE.Mesh(this.swirlArcGeom, mats.ring);
    arc2.rotation.z = Math.PI;
    arc2.renderOrder = 9;
    const mote2 = new THREE.Mesh(this.sparkleMoteGeom, mats.ring);
    mote2.position.set(-0.58, 0, 0);
    mote2.renderOrder = 9;
    ringB.add(arc2, mote2);
    ringB.scale.setScalar(1.08);
    mesh.add(ringB);

    switch (pType) {
      case 'wing_gust': {
        // Swept luminous golden twin wings + glowing amber pearl heart inside the orb
        const heart = new THREE.Mesh(this.smallOrbGeom, mats.core);
        heart.scale.setScalar(0.75);
        const leftWing = new THREE.Mesh(this.wingBladeGeom, mats.core);
        leftWing.position.set(0.22, 0.08, -0.02);
        leftWing.rotation.set(0.12, 0.28, 0.46);
        const rightWing = new THREE.Mesh(this.wingBladeGeom, mats.core);
        rightWing.position.set(-0.22, 0.08, -0.02);
        rightWing.rotation.set(0.12, -0.28, -0.46);
        coreGroup.add(heart, leftWing, rightWing);
        break;
      }

      case 'bubble_lung': {
        // Luminous cyan-aqua 3-bubble oxygen cluster!
        const offsets: Array<[number, number, number, number]> = [
          [0, 0.12, 0, 1.05],
          [-0.17, -0.11, 0.08, 0.78],
          [0.18, -0.09, -0.06, 0.68],
        ];
        for (const [ox, oy, oz, sc] of offsets) {
          const b = new THREE.Mesh(this.smallOrbGeom, mats.core);
          b.position.set(ox, oy, oz);
          b.scale.setScalar(sc);
          coreGroup.add(b);
        }
        ringA.scale.setScalar(0.96);
        ringB.scale.setScalar(1.04);
        break;
      }

      case 'soap_shield': {
        // Iridescent soap bubble pearl core with delicate shimmering arcs
        const innerBubble = new THREE.Mesh(this.smallOrbGeom, mats.core);
        innerBubble.scale.setScalar(1.3);
        coreGroup.add(innerBubble);
        break;
      }

      case 'magnet': {
        // Warm glowing golden-rose magnetic vortex core + dual swirl trails
        const vortexCore = new THREE.Mesh(this.smallOrbGeom, mats.core);
        vortexCore.scale.setScalar(1.05);
        const moteA = new THREE.Mesh(this.sparkleMoteGeom, mats.core);
        moteA.position.set(0.26, 0.14, 0);
        const moteB = new THREE.Mesh(this.sparkleMoteGeom, mats.core);
        moteB.position.set(-0.26, -0.14, 0);
        coreGroup.add(vortexCore, moteA, moteB);
        break;
      }
    }

    return { item, mesh, ringA, ringB, core: coreGroup };
  }

  private makePowerUpMaterials(type: PowerUpType): {
    core: THREE.MeshPhysicalMaterial;
    aura: THREE.MeshPhysicalMaterial;
    ring: THREE.MeshBasicMaterial;
  } {
    const cfg = POWERUP_CONFIG[type];
    const baseColor = new THREE.Color(cfg.color);
    const emissiveColor = new THREE.Color(cfg.emissive);

    return {
      core: new THREE.MeshPhysicalMaterial({
        color: baseColor,
        emissive: emissiveColor,
        emissiveIntensity: 0.9,
        roughness: 0.14,
        metalness: 0.32,
        clearcoat: 0.9,
      }),
      aura: new THREE.MeshPhysicalMaterial({
        color: baseColor,
        emissive: emissiveColor,
        emissiveIntensity: 0.58,
        roughness: 0.04,
        metalness: 0.05,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        transparent: true,
        opacity: 0.36,
        depthWrite: false,
      }),
      ring: new THREE.MeshBasicMaterial({
        color: baseColor,
        transparent: true,
        opacity: 0.74,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    };
  }

  private removeSpecialVisual(id: string): void {
    const existing = this.specials.get(id);
    if (!existing) return;
    this.group.remove(existing.mesh);
    this.specials.delete(id);
  }
}
