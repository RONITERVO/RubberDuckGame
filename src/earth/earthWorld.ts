/// <reference types="vite/client" />

import { assetLoader } from '../assets/loader';
import { MINI_EARTH_CONFIG } from '../config';
import type { AssetId, Vec3 } from '../types';
import {
  clampLat,
  greatCircleDistanceU,
  initialBearing,
  interpolateGreatCircle,
  latLngToSphere,
  MINI_EARTH_RADIUS,
  normalizeLng,
  relativeBearingDeg,
  sphereToLatLng,
} from './coords';
import {
  blendEarthRegionZones,
  type BlendedEarthRegion,
  type EarthJunction,
  type EarthLandmark,
  type EarthRegionPack,
  type EarthRegionZone,
  type EarthWaterway,
  type EarthWaterwaySample,
  type EarthWaterwayWaypoint,
  type UpcomingForkBranch,
  type UpcomingForkInfo,
} from './schema';
import { GeoSpatialIndex } from './spatialIndex';

export const DEFAULT_REGION_ID = 'pnw-creek';

interface SplineLutPoint {
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
  isWaterfall: boolean;
  waterfallDrop: number;
  waterfallPhase: number;
}

interface CompiledWaterway {
  waterway: EarthWaterway;
  fromJunction: EarthJunction;
  toJunction: EarthJunction;
  totalLengthU: number;
  lut: SplineLutPoint[];
  entryBearingDeg: number;
  exitBearingDeg: number;
  speedBoost: number;
}

export interface GlobeWaterwayPolyline {
  id: string;
  name: string;
  regionId: string;
  fromJunctionId: string;
  toJunctionId: string;
  isConnector: boolean;
  isPrimaryForRegion: boolean;
  difficulty: 1 | 2 | 3;
  lengthU: number;
  accentColor: string;
  points: Array<{ lat: number; lng: number; elevation: number }>;
}

export interface GlobeNetworkData {
  radius: number;
  zones: readonly EarthRegionZone[];
  junctions: readonly EarthJunction[];
  waterways: GlobeWaterwayPolyline[];
  landmarks: readonly EarthLandmark[];
}

export interface EarthWorldValidationResult {
  valid: boolean;
  errors: string[];
  packCount: number;
  zoneCount: number;
  junctionCount: number;
  waterwayCount: number;
  landmarkCount: number;
  reachableZoneCount: number;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smootherstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

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

function isEarthRegionPack(candidate: unknown): candidate is EarthRegionPack {
  if (!candidate || typeof candidate !== 'object') return false;
  const obj = candidate as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    Array.isArray(obj.zones) &&
    Array.isArray(obj.junctions) &&
    Array.isArray(obj.waterways)
  );
}

function extractPackFromModule(mod: Record<string, unknown>): EarthRegionPack | null {
  if (isEarthRegionPack(mod.default)) return mod.default;
  if (isEarthRegionPack(mod.pack)) return mod.pack;
  for (const val of Object.values(mod)) {
    if (isEarthRegionPack(val)) return val;
  }
  return null;
}

/**
 * Shared Physical Mini-Earth Planetary Engine.
 *
 * - Zero-core-edit auto-discovery of all contributor packs via `import.meta.glob`
 * - Registers custom pack `.glb` specs into `assetLoader` automatically
 * - Compiles continuous antimeridian-safe unit-sphere Catmull-Rom waterways
 * - Indexes zones, waterways, junctions, and landmarks into `10° × 10°` `GeoSpatialIndex`
 * - Supports real physical 2-way River Forks (`getUpcomingFork`) and true spatial biome blending
 */
export class EarthWorld {
  private readonly packs: EarthRegionPack[] = [];
  private readonly packMap = new Map<string, EarthRegionPack>();

  private readonly zones: EarthRegionZone[] = [];
  private readonly zoneMap = new Map<string, EarthRegionZone>();

  private readonly junctions: EarthJunction[] = [];
  private readonly junctionMap = new Map<string, EarthJunction>();

  private readonly waterways: EarthWaterway[] = [];
  private readonly waterwayMap = new Map<string, EarthWaterway>();
  private readonly compiledWaterways = new Map<string, CompiledWaterway>();

  private readonly outgoingByJunction = new Map<string, EarthWaterway[]>();
  private readonly incomingByJunction = new Map<string, EarthWaterway[]>();

  private readonly landmarks: EarthLandmark[] = [];
  private readonly spatialIndex = new GeoSpatialIndex(MINI_EARTH_CONFIG.spatialCellDeg);

  private compiled = false;

  constructor(autoDiscover: boolean = true) {
    if (autoDiscover) {
      this.discoverContributorPacks();
    }
  }

  /**
   * Auto-discover every contributor pack matching `src/world/packs/**\/index.ts`.
   * Adding a new Earth region requires ZERO edits to any core file!
   */
  public discoverContributorPacks(): void {
    const modules = import.meta.glob<Record<string, unknown>>(
      '../world/packs/**/index.ts',
      { eager: true },
    );

    const discovered: Array<{ path: string; pack: EarthRegionPack }> = [];
    for (const [path, mod] of Object.entries(modules)) {
      const pack = extractPackFromModule(mod);
      if (pack) {
        discovered.push({ path, pack });
      }
    }

    // Stable deterministic ordering (pnw-creek first, then alphabetical by pack ID)
    discovered.sort((a, b) => {
      if (a.pack.id === DEFAULT_REGION_ID) return -1;
      if (b.pack.id === DEFAULT_REGION_ID) return 1;
      return a.pack.id.localeCompare(b.pack.id);
    });

    for (const entry of discovered) {
      this.addPackRaw(entry.pack);
    }

    this.rebuildWorldIndex();
  }

  /**
   * Dynamically register a contributor `EarthRegionPack` at runtime (useful for tests
   * or hot-loaded community packs) and rebuild spatial indices & splines.
   */
  public registerPack(pack: EarthRegionPack): void {
    this.addPackRaw(pack);
    this.rebuildWorldIndex();
  }

  private addPackRaw(pack: EarthRegionPack): void {
    const existingIdx = this.packs.findIndex((p) => p.id === pack.id);
    if (existingIdx >= 0) {
      this.packs[existingIdx] = pack;
    } else {
      this.packs.push(pack);
    }
    this.packMap.set(pack.id, pack);

    // Self-register pack assets and optional manifests into assetLoader
    if (pack.assets) {
      assetLoader.registerAssetSpecs(pack.assets);
    }
    if (pack.manifestUrls) {
      for (const url of pack.manifestUrls) {
        assetLoader.registerManifestUrl(url);
      }
    }
  }

  /**
   * Compile all registered packs into unified junctions, splines, adjacency lists,
   * and `GeoSpatialIndex` cells.
   */
  public rebuildWorldIndex(): void {
    this.zones.length = 0;
    this.zoneMap.clear();
    this.junctions.length = 0;
    this.junctionMap.clear();
    this.waterways.length = 0;
    this.waterwayMap.clear();
    this.compiledWaterways.clear();
    this.outgoingByJunction.clear();
    this.incomingByJunction.clear();
    this.landmarks.length = 0;
    this.spatialIndex.clear();

    // 1. Collect zones, junctions, waterways, and landmarks across all packs
    for (const pack of this.packs) {
      for (const zone of pack.zones) {
        if (!this.zoneMap.has(zone.id)) {
          this.zones.push(zone);
        }
        this.zoneMap.set(zone.id, zone);
      }
      for (const junc of pack.junctions) {
        if (!this.junctionMap.has(junc.id)) {
          this.junctions.push(junc);
          this.junctionMap.set(junc.id, junc);
        }
      }
      for (const ww of pack.waterways) {
        if (!this.waterwayMap.has(ww.id)) {
          this.waterways.push(ww);
          this.waterwayMap.set(ww.id, ww);
        }
      }
      if (pack.landmarks) {
        for (const lm of pack.landmarks) {
          this.landmarks.push(lm);
        }
      }
    }

    // 2. Index zones, junctions, and landmarks
    for (const zone of this.zones) {
      this.spatialIndex.addZone(zone);
    }
    for (const junc of this.junctions) {
      this.spatialIndex.addJunction(junc);
      this.outgoingByJunction.set(junc.id, []);
      this.incomingByJunction.set(junc.id, []);
    }
    for (const lm of this.landmarks) {
      this.spatialIndex.addLandmark(lm);
    }

    // 3. Compile every waterway's unit-sphere Catmull-Rom spline + arc-length LUT
    for (const ww of this.waterways) {
      const fromJunc = this.junctionMap.get(ww.fromJunctionId);
      const toJunc = this.junctionMap.get(ww.toJunctionId);
      if (!fromJunc || !toJunc) {
        continue;
      }

      const compiled = this.compileWaterway(ww, fromJunc, toJunc);
      this.compiledWaterways.set(ww.id, compiled);

      this.outgoingByJunction.get(fromJunc.id)?.push(ww);
      this.incomingByJunction.get(toJunc.id)?.push(ww);

      // Index waterway into every spatial cell touched by its LUT
      const step = Math.max(1, Math.floor(compiled.lut.length / 40));
      const pts: Array<{ lat: number; lng: number }> = [];
      for (let i = 0; i < compiled.lut.length; i += step) {
        pts.push({ lat: compiled.lut[i].lat, lng: compiled.lut[i].lng });
      }
      const last = compiled.lut[compiled.lut.length - 1];
      pts.push({ lat: last.lat, lng: last.lng });
      this.spatialIndex.addWaterway(ww, pts);
    }

    this.compiled = true;
  }

  // -------------------------------------------------------------------------
  // Public Query API
  // -------------------------------------------------------------------------

  public getPacks(): readonly EarthRegionPack[] {
    return this.packs;
  }

  public getAllZones(): readonly EarthRegionZone[] {
    return this.zones;
  }

  public findZoneById(id: string): EarthRegionZone | undefined {
    return this.zoneMap.get(id);
  }

  public getZoneById(id?: string | null): EarthRegionZone {
    if (id && this.zoneMap.has(id)) {
      return this.zoneMap.get(id)!;
    }
    return this.zoneMap.get(DEFAULT_REGION_ID) ?? this.zones[0];
  }

  public getZoneIndex(idOrZone: string | EarthRegionZone): number {
    const id = typeof idOrZone === 'string' ? idOrZone : idOrZone.id;
    const idx = this.zones.findIndex((z) => z.id === id);
    return idx >= 0 ? idx : 0;
  }

  public getAllJunctions(): readonly EarthJunction[] {
    return this.junctions;
  }

  public getJunctionById(id: string): EarthJunction | undefined {
    return this.junctionMap.get(id);
  }

  public getAllWaterways(): readonly EarthWaterway[] {
    return this.waterways;
  }

  public getWaterwayById(id: string): EarthWaterway | undefined {
    return this.waterwayMap.get(id);
  }

  public getWaterwayLength(waterwayId: string): number {
    return this.compiledWaterways.get(waterwayId)?.totalLengthU ?? 260;
  }

  public getPrimaryWaterwayForRegion(regionId: string): EarthWaterway {
    const primary = this.waterways.find(
      (w) => w.regionId === regionId && w.isPrimaryForRegion,
    );
    if (primary) return primary;
    const regional = this.waterways.find(
      (w) => w.regionId === regionId && !w.isConnector,
    );
    if (regional) return regional;
    const anyRegional = this.waterways.find((w) => w.regionId === regionId);
    return anyRegional ?? this.waterways[0];
  }

  public getOutgoingWaterways(junctionId: string): EarthWaterway[] {
    return [...(this.outgoingByJunction.get(junctionId) ?? [])];
  }

  public getIncomingWaterways(junctionId: string): EarthWaterway[] {
    return [...(this.incomingByJunction.get(junctionId) ?? [])];
  }

  /**
   * Sample a physical `EarthWaterway` at downstream arc-length `s` (`0..totalLengthU`).
   * O(log N) binary search over precompiled unit-sphere Catmull-Rom LUT.
   */
  public sampleWaterway(waterwayId: string, s: number): EarthWaterwaySample {
    const compiled =
      this.compiledWaterways.get(waterwayId) ??
      this.compiledWaterways.values().next().value;

    if (!compiled) {
      return {
        waterwayId,
        s: 0,
        totalLengthU: 260,
        progress: 0,
        lat: 44.12,
        lng: -122.18,
        elevation: 0,
        bearingDeg: 0,
        slope: -0.048,
        curvature: 0,
        width: 13,
        depth: 3.8,
        rapids: 0.25,
        isWaterfall: false,
        waterfallDrop: 0,
        waterfallPhase: 0,
        speedBoost: 1.0,
      };
    }

    const lut = compiled.lut;
    const totalLengthU = Math.max(1e-3, compiled.totalLengthU);
    const clampedS = clamp(s, 0, totalLengthU);

    // Binary search for segment [i, i + 1]
    let lo = 0;
    let hi = lut.length - 2;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (clampedS < lut[mid].s) {
        hi = mid - 1;
      } else if (clampedS > lut[mid + 1].s) {
        lo = mid + 1;
      } else {
        lo = mid;
        break;
      }
    }
    const idx = clamp(lo, 0, lut.length - 2);
    const a = lut[idx];
    const b = lut[idx + 1];
    const segLen = Math.max(1e-5, b.s - a.s);
    const t = clamp((clampedS - a.s) / segLen, 0, 1);

    // Unit-sphere linear lerp + normalize (exact on dense LUT, antimeridian-safe!)
    const ux = a.ux + (b.ux - a.ux) * t;
    const uy = a.uy + (b.uy - a.uy) * t;
    const uz = a.uz + (b.uz - a.uz) * t;
    const invLen = 1 / (Math.hypot(ux, uy, uz) || 1);
    const geo = sphereToLatLng({
      x: ux * invLen,
      y: uy * invLen,
      z: uz * invLen,
    });

    const elevation = lerp(a.elevation, b.elevation, t);
    const width = lerp(a.width, b.width, t);
    const depth = lerp(a.depth, b.depth, t);
    const rapids = lerp(a.rapids, b.rapids, t);
    const isWaterfall = a.isWaterfall || b.isWaterfall;
    const waterfallDrop = Math.max(a.waterfallDrop, b.waterfallDrop);
    const waterfallPhase = isWaterfall
      ? lerp(a.waterfallPhase, b.waterfallPhase, t)
      : 0;

    // Smooth forward bearing & curvature from finite difference across LUT neighbors
    // Avoid zero-length endpoint spans where pPrev === a or pNext === b!
    const bearingDeg =
      idx === lut.length - 2 && t > 0.98
        ? compiled.exitBearingDeg
        : idx === 0 && t < 0.02
          ? compiled.entryBearingDeg
          : initialBearing(a.lat, a.lng, b.lat, b.lng);

    let curvature = 0;
    if (lut.length >= 3) {
      const i0 = clamp(idx - 1, 0, lut.length - 3);
      const i1 = i0 + 1;
      const i2 = i0 + 2;
      const p0 = lut[i0];
      const p1 = lut[i1];
      const p2 = lut[i2];
      const b1 = initialBearing(p0.lat, p0.lng, p1.lat, p1.lng);
      const b2 = initialBearing(p1.lat, p1.lng, p2.lat, p2.lng);
      const midSpanS = Math.max(1.0, 0.5 * (p2.s - p0.s));
      const dBearingRad = (relativeBearingDeg(b1, b2) * Math.PI) / 180;
      curvature = clamp(dBearingRad / midSpanS, -0.08, 0.08);
    }
    const slope = (b.elevation - a.elevation) / segLen;

    return {
      waterwayId: compiled.waterway.id,
      s: clampedS,
      totalLengthU,
      progress: clampedS / totalLengthU,
      lat: geo.lat,
      lng: geo.lng,
      elevation,
      bearingDeg,
      slope,
      curvature,
      width,
      depth,
      rapids,
      isWaterfall,
      waterfallDrop,
      waterfallPhase,
      speedBoost: compiled.speedBoost,
    };
  }

  /**
   * True O(1) spatial biome blending at ANY `(lat, lng)` coordinate on Mini-Earth!
   */
  public getBlendedRegionAt(lat: number, lng: number): BlendedEarthRegion {
    const res = this.spatialIndex.queryZonesAt(lat, lng);
    if (!res) {
      const fallback = this.getZoneById(DEFAULT_REGION_ID);
      return blendEarthRegionZones(fallback, fallback, 0);
    }
    return blendEarthRegionZones(res.primary, res.secondary, res.blend);
  }

  public getNearbyLandmarks(
    lat: number,
    lng: number,
    radiusU: number,
  ): EarthLandmark[] {
    return this.spatialIndex.queryLandmarksNear(lat, lng, radiusU);
  }

  public getNearbyJunctions(
    lat: number,
    lng: number,
    radiusU: number,
  ): EarthJunction[] {
    return this.spatialIndex.queryJunctionsNear(lat, lng, radiusU);
  }

  public getNearbyWaterways(
    lat: number,
    lng: number,
    radiusU: number,
  ): EarthWaterway[] {
    return this.spatialIndex.queryWaterwaysNear(lat, lng, radiusU);
  }

  /**
   * Inspect if an active waterway approaches a physical 2-way (or N-way) fork
   * junction within `warningDistanceU` downstream.
   * Branches are ordered cleanly from LEFT (`relativeBearingDeg < 0`) to RIGHT (`> 0`)
   * relative to the incoming river's real planetary bearing!
   */
  public getUpcomingFork(
    waterwayId: string,
    s: number,
    warningDistanceU: number = MINI_EARTH_CONFIG.forkWarningDistanceU,
  ): UpcomingForkInfo | null {
    const compiled = this.compiledWaterways.get(waterwayId);
    if (!compiled) return null;

    const remainingU = compiled.totalLengthU - s;
    if (remainingU < -2 || remainingU > warningDistanceU) {
      return null;
    }

    const outgoing = this.outgoingByJunction.get(compiled.toJunction.id) ?? [];
    if (outgoing.length < 2) {
      return null;
    }

    const inBearing = compiled.exitBearingDeg;
    const branches: UpcomingForkBranch[] = outgoing.map((ww) => {
      const outCompiled = this.compiledWaterways.get(ww.id);
      const outBearing = outCompiled?.entryBearingDeg ?? inBearing;
      const rel = relativeBearingDeg(inBearing, outBearing);
      const targetRegion = this.resolveTargetRegionForWaterway(ww);
      return {
        waterwayId: ww.id,
        waterwayName: ww.name,
        targetRegionId: targetRegion.id,
        targetRegionName: targetRegion.name,
        targetCountry: targetRegion.country,
        relativeBearingDeg: rel,
      };
    });

    // Sort strictly leftmost (most negative relative bearing) -> rightmost (most positive)
    branches.sort((a, b) => a.relativeBearingDeg - b.relativeBearingDeg);

    const leftBranch = branches[0];
    const rightBranch = branches[branches.length - 1];

    // Default branch prefers non-connector regional valley if available, else straightest
    let defaultBranch = branches[0];
    let bestScore = Infinity;
    for (const br of branches) {
      const ww = this.waterwayMap.get(br.waterwayId);
      const penalty = ww?.isConnector ? 25 : 0;
      const score = Math.abs(br.relativeBearingDeg) + penalty;
      if (score < bestScore) {
        bestScore = score;
        defaultBranch = br;
      }
    }

    return {
      junction: compiled.toJunction,
      distanceU: Math.max(0, remainingU),
      leftBranch,
      rightBranch,
      defaultBranch,
      allBranches: branches,
    };
  }

  /**
   * Resolve the next destination region zone that a waterway leads into.
   */
  public resolveTargetRegionForWaterway(ww: EarthWaterway): EarthRegionZone {
    const toJunc = this.junctionMap.get(ww.toJunctionId);
    if (toJunc?.regionId && this.zoneMap.has(toJunc.regionId)) {
      return this.zoneMap.get(toJunc.regionId)!;
    }
    if (this.zoneMap.has(ww.regionId)) {
      return this.zoneMap.get(ww.regionId)!;
    }
    if (toJunc) {
      return this.getBlendedRegionAt(toJunc.lat, toJunc.lng).primaryZone;
    }
    return this.getZoneById(DEFAULT_REGION_ID);
  }

  /**
   * Collect all unique 3D `AssetId`s referenced by a region zone's scenery, obstacles,
   * wildlife, cave crystals, and persistent landmarks.
   */
  public getRegionAssets(
    regionIdOrZone: string | EarthRegionZone,
    includeHeroCore: boolean = false,
  ): AssetId[] {
    const zone =
      typeof regionIdOrZone === 'string'
        ? this.getZoneById(regionIdOrZone)
        : regionIdOrZone;

    const set = new Set<AssetId>();
    if (includeHeroCore) {
      set.add('rubber_duck');
      set.add('duck_wing');
    }

    for (const entry of zone.scenery.bankTrees) set.add(entry.assetId);
    for (const entry of zone.scenery.bankFoliage) set.add(entry.assetId);
    for (const entry of zone.scenery.bankRocks) set.add(entry.assetId);
    for (const lm of zone.scenery.landmarks) set.add(lm.assetId);

    for (const id of zone.obstacles.boulderAssets) set.add(id);
    for (const id of zone.obstacles.diveArchAssets) set.add(id);
    for (const id of zone.obstacles.jumpLogAssets) set.add(id);

    set.add(zone.wildlife.underwaterAsset);
    if (zone.wildlife.bankCritterAsset) {
      set.add(zone.wildlife.bankCritterAsset);
    }
    if (zone.caveStyle.crystalAssetId) {
      set.add(zone.caveStyle.crystalAssetId);
    }

    // Also include persistent EarthLandmarks located near this region zone
    const nearbyLandmarks = this.spatialIndex.queryLandmarksNear(
      zone.centerLat,
      zone.centerLng,
      (zone.radiusDeg + 8) * (MINI_EARTH_RADIUS * Math.PI / 180),
    );
    for (const lm of nearbyLandmarks) {
      set.add(lm.assetId);
    }

    return Array.from(set);
  }

  /**
   * Collect all unique 3D `AssetId`s needed along a specific waterway (both start
   * and destination region zones).
   */
  public getWaterwayAssets(
    waterwayId: string,
    includeHeroCore: boolean = false,
  ): AssetId[] {
    const ww = this.waterwayMap.get(waterwayId);
    if (!ww) return this.getRegionAssets(DEFAULT_REGION_ID, includeHeroCore);

    const set = new Set<AssetId>(
      this.getRegionAssets(ww.regionId, includeHeroCore),
    );
    const destZone = this.resolveTargetRegionForWaterway(ww);
    for (const id of this.getRegionAssets(destZone, false)) {
      set.add(id);
    }
    return Array.from(set);
  }

  /**
   * Sample a polyline along a physical waterway for rendering on the 3D Mini-Earth Globe.
   */
  public getWaterwayPolyline(
    waterwayId: string,
    maxPoints: number = 32,
  ): Array<{ lat: number; lng: number; elevation: number; s: number }> {
    const compiled = this.compiledWaterways.get(waterwayId);
    if (!compiled || compiled.lut.length === 0) return [];

    const lut = compiled.lut;
    const count = Math.max(4, Math.min(maxPoints, lut.length));
    const out: Array<{ lat: number; lng: number; elevation: number; s: number }> = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.round((i / (count - 1)) * (lut.length - 1));
      const p = lut[idx];
      out.push({ lat: p.lat, lng: p.lng, elevation: p.elevation, s: p.s });
    }
    return out;
  }

  /**
   * Return the complete physical planetary network (zones, real junctions,
   * real river & strait polylines, and persistent landmarks) for the 3D Mini-Earth Globe.
   */
  public getGlobeNetworkData(): GlobeNetworkData {
    const waterways: GlobeWaterwayPolyline[] = [];
    for (const ww of this.waterways) {
      const compiled = this.compiledWaterways.get(ww.id);
      if (!compiled) continue;
      const zone = this.getZoneById(ww.regionId);
      const maxPts = ww.isConnector ? 42 : 24;
      const poly = this.getWaterwayPolyline(ww.id, maxPts);
      waterways.push({
        id: ww.id,
        name: ww.name,
        regionId: ww.regionId,
        fromJunctionId: ww.fromJunctionId,
        toJunctionId: ww.toJunctionId,
        isConnector: Boolean(ww.isConnector),
        isPrimaryForRegion: Boolean(ww.isPrimaryForRegion),
        difficulty: ww.difficulty,
        lengthU: compiled.totalLengthU,
        accentColor: zone.globeColor || zone.accentColor,
        points: poly.map((p) => ({
          lat: p.lat,
          lng: p.lng,
          elevation: p.elevation,
        })),
      });
    }

    return {
      radius: MINI_EARTH_RADIUS,
      zones: this.zones,
      junctions: this.junctions,
      waterways,
      landmarks: this.landmarks,
    };
  }

  /**
   * Validate full physical planetary integrity:
   * - All waterways reference valid start & end `EarthJunction`s
   * - Start/end waypoints physically match junction `(lat, lng)`
   * - Every region zone is reachable from every other region via the connected river graph
   */
  public validateWorld(): EarthWorldValidationResult {
    const errors: string[] = [];

    if (!this.compiled || this.zones.length === 0) {
      return {
        valid: false,
        errors: ['No EarthRegionPacks discovered or registered.'],
        packCount: this.packs.length,
        zoneCount: this.zones.length,
        junctionCount: this.junctions.length,
        waterwayCount: this.waterways.length,
        landmarkCount: this.landmarks.length,
        reachableZoneCount: 0,
      };
    }

    for (const ww of this.waterways) {
      const fromJ = this.junctionMap.get(ww.fromJunctionId);
      const toJ = this.junctionMap.get(ww.toJunctionId);
      if (!fromJ) {
        errors.push(`Waterway "${ww.id}" references missing fromJunctionId "${ww.fromJunctionId}".`);
      }
      if (!toJ) {
        errors.push(`Waterway "${ww.id}" references missing toJunctionId "${ww.toJunctionId}".`);
      }
      if (ww.waypoints.length < 2) {
        errors.push(`Waterway "${ww.id}" must have at least 2 waypoints.`);
      } else if (fromJ && toJ) {
        const first = ww.waypoints[0];
        const last = ww.waypoints[ww.waypoints.length - 1];
        const dStart = greatCircleDistanceU(first.lat, first.lng, fromJ.lat, fromJ.lng);
        const dEnd = greatCircleDistanceU(last.lat, last.lng, toJ.lat, toJ.lng);
        if (dStart > 2.5) {
          errors.push(
            `Waterway "${ww.id}" first waypoint is ${dStart.toFixed(1)}u away from fromJunction "${fromJ.id}".`,
          );
        }
        if (dEnd > 2.5) {
          errors.push(
            `Waterway "${ww.id}" last waypoint is ${dEnd.toFixed(1)}u away from toJunction "${toJ.id}".`,
          );
        }
      }
    }

    // Check reachability across all zones via directed physical waterways
    let minReachableZones = this.zones.length;
    for (const startZone of this.zones) {
      const startWw = this.getPrimaryWaterwayForRegion(startZone.id);
      if (!startWw) continue;

      const visitedJuncs = new Set<string>([startWw.fromJunctionId, startWw.toJunctionId]);
      const visitedZones = new Set<string>([startZone.id]);
      const queue: string[] = [startWw.toJunctionId];

      while (queue.length > 0) {
        const jId = queue.shift()!;
        const outgoing = this.outgoingByJunction.get(jId) ?? [];
        for (const nextWw of outgoing) {
          if (this.zoneMap.has(nextWw.regionId)) {
            visitedZones.add(nextWw.regionId);
          }
          const targetZ = this.resolveTargetRegionForWaterway(nextWw);
          visitedZones.add(targetZ.id);
          if (!visitedJuncs.has(nextWw.toJunctionId)) {
            visitedJuncs.add(nextWw.toJunctionId);
            queue.push(nextWw.toJunctionId);
          }
        }
      }

      if (visitedZones.size < minReachableZones) {
        minReachableZones = visitedZones.size;
      }
      if (visitedZones.size < this.zones.length) {
        errors.push(
          `Starting from zone "${startZone.id}" only reaches ${visitedZones.size}/${this.zones.length} planetary zones.`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      packCount: this.packs.length,
      zoneCount: this.zones.length,
      junctionCount: this.junctions.length,
      waterwayCount: this.waterways.length,
      landmarkCount: this.landmarks.length,
      reachableZoneCount: minReachableZones,
    };
  }

  // -------------------------------------------------------------------------
  // Unit-Sphere Catmull-Rom Waterway Compilation
  // -------------------------------------------------------------------------

  private compileWaterway(
    ww: EarthWaterway,
    fromJunc: EarthJunction,
    toJunc: EarthJunction,
  ): CompiledWaterway {
    const zone = this.getZoneById(ww.regionId);
    const defaultWidth = (zone.riverProfile.widthMin + zone.riverProfile.widthMax) * 0.5;
    const defaultDepth = (zone.riverProfile.depthMin + zone.riverProfile.depthMax) * 0.5;
    const defaultRapids = zone.riverProfile.rapidsBase;

    // 1. Normalize control points and enforce exact endpoint match with junctions
    const rawControls: Array<{
      lat: number;
      lng: number;
      elevation: number;
      width: number;
      depth: number;
      rapids: number;
      isWaterfall: boolean;
      waterfallDrop: number;
    }> = [];

    const wps: EarthWaterwayWaypoint[] =
      ww.waypoints.length >= 2
        ? ww.waypoints
        : [
            { lat: fromJunc.lat, lng: fromJunc.lng, elevation: fromJunc.elevation },
            { lat: toJunc.lat, lng: toJunc.lng, elevation: toJunc.elevation },
          ];

    const nWps = wps.length;
    for (let i = 0; i < nWps; i++) {
      const wp = wps[i];
      const frac = i / Math.max(1, nWps - 1);
      const isFirst = i === 0;
      const isLast = i === nWps - 1;

      const lat = isFirst ? fromJunc.lat : isLast ? toJunc.lat : clampLat(wp.lat);
      const lng = isFirst
        ? fromJunc.lng
        : isLast
          ? toJunc.lng
          : normalizeLng(wp.lng);
      const elevation = isFirst
        ? fromJunc.elevation
        : isLast
          ? toJunc.elevation
          : wp.elevation ?? lerp(fromJunc.elevation, toJunc.elevation, frac);

      rawControls.push({
        lat,
        lng,
        elevation,
        width: wp.width ?? defaultWidth,
        depth: wp.depth ?? defaultDepth,
        rapids: wp.rapids ?? defaultRapids,
        isWaterfall: Boolean(wp.isWaterfall),
        waterfallDrop: wp.waterfallDrop ?? 0,
      });
    }

    // 2. Densify any long great-circle span (> 10°) so unit-sphere Catmull-Rom hugs the sphere
    const controls: Array<{
      u: Vec3;
      elevation: number;
      width: number;
      depth: number;
      rapids: number;
      isWaterfall: boolean;
      waterfallDrop: number;
    }> = [];

    for (let i = 0; i < rawControls.length; i++) {
      const curr = rawControls[i];
      controls.push({
        u: latLngToSphere(curr.lat, curr.lng, 1.0),
        elevation: curr.elevation,
        width: curr.width,
        depth: curr.depth,
        rapids: curr.rapids,
        isWaterfall: curr.isWaterfall,
        waterfallDrop: curr.waterfallDrop,
      });

      if (i < rawControls.length - 1) {
        const next = rawControls[i + 1];
        const segU = greatCircleDistanceU(curr.lat, curr.lng, next.lat, next.lng);
        const subdivisions = Math.max(0, Math.floor(segU / 220));
        for (let k = 1; k <= subdivisions; k++) {
          const frac = k / (subdivisions + 1);
          const midGeo = interpolateGreatCircle(
            curr.lat,
            curr.lng,
            next.lat,
            next.lng,
            frac,
          );
          controls.push({
            u: latLngToSphere(midGeo.lat, midGeo.lng, 1.0),
            elevation: lerp(curr.elevation, next.elevation, frac),
            width: lerp(curr.width, next.width, frac),
            depth: lerp(curr.depth, next.depth, frac),
            rapids: lerp(curr.rapids, next.rapids, frac),
            isWaterfall: false,
            waterfallDrop: 0,
          });
        }
      }
    }

    // 3. Evaluate unit-sphere Catmull-Rom into dense arc-length LUT
    const lut: SplineLutPoint[] = [];
    const segCount = controls.length - 1;
    let cumulativeS = 0;

    // Collect waterfall centers in arc-length for smooth waterfall drop profiles
    const waterfallCenters: Array<{ centerS: number; drop: number }> = [];

    for (let seg = 0; seg < segCount; seg++) {
      const c0 = controls[Math.max(0, seg - 1)];
      const c1 = controls[seg];
      const c2 = controls[seg + 1];
      const c3 = controls[Math.min(controls.length - 1, seg + 2)];

      const dot12 = clamp(
        c1.u.x * c2.u.x + c1.u.y * c2.u.y + c1.u.z * c2.u.z,
        -1,
        1,
      );
      const chordU = Math.acos(dot12) * MINI_EARTH_RADIUS;
      const steps = clamp(Math.ceil(chordU / 6.0), 6, 36);

      if (c1.isWaterfall && c1.waterfallDrop > 0) {
        waterfallCenters.push({ centerS: cumulativeS, drop: c1.waterfallDrop });
      }

      const startStep = seg === 0 ? 0 : 1;
      for (let step = startStep; step <= steps; step++) {
        const t = step / steps;
        const rx = catmullRom(c0.u.x, c1.u.x, c2.u.x, c3.u.x, t);
        const ry = catmullRom(c0.u.y, c1.u.y, c2.u.y, c3.u.y, t);
        const rz = catmullRom(c0.u.z, c1.u.z, c2.u.z, c3.u.z, t);
        const invL = 1 / (Math.hypot(rx, ry, rz) || 1);
        const ux = rx * invL;
        const uy = ry * invL;
        const uz = rz * invL;

        const geo = sphereToLatLng({ x: ux, y: uy, z: uz });
        if (lut.length > 0) {
          const prev = lut[lut.length - 1];
          const d = clamp(prev.ux * ux + prev.uy * uy + prev.uz * uz, -1, 1);
          cumulativeS += Math.acos(d) * MINI_EARTH_RADIUS;
        }

        const elevation = lerp(c1.elevation, c2.elevation, t);
        const width = clamp(
          catmullRom(c0.width, c1.width, c2.width, c3.width, t),
          7.5,
          24.0,
        );
        const depth = clamp(
          catmullRom(c0.depth, c1.depth, c2.depth, c3.depth, t),
          2.2,
          7.5,
        );
        const rapids = clamp(
          catmullRom(c0.rapids, c1.rapids, c2.rapids, c3.rapids, t),
          0,
          1,
        );

        lut.push({
          s: cumulativeS,
          ux,
          uy,
          uz,
          lat: geo.lat,
          lng: geo.lng,
          elevation,
          width,
          depth,
          rapids,
          isWaterfall: false,
          waterfallDrop: 0,
          waterfallPhase: 0,
        });
      }
    }

    // 4. Mark sculpted waterfall bands & rapids spikes smoothly along the LUT
    const wfLength = 16.0;
    for (const wf of waterfallCenters) {
      const startS = Math.max(12, wf.centerS - wfLength * 0.5);
      const endS = Math.min(cumulativeS - 12, wf.centerS + wfLength * 0.5);
      const span = Math.max(4, endS - startS);
      for (let i = 0; i < lut.length; i++) {
        const pt = lut[i];
        if (pt.s >= startS && pt.s <= endS) {
          const phase = clamp((pt.s - startS) / span, 0, 1);
          pt.isWaterfall = true;
          pt.waterfallDrop = wf.drop;
          pt.waterfallPhase = phase;
          pt.rapids = Math.max(pt.rapids, 0.85 + 0.15 * Math.sin(phase * Math.PI));
          // Subtle step accent centered at waterfall while preserving exact junction endpoints
          const stepShape = smootherstep01(phase) - phase;
          pt.elevation -= stepShape * Math.min(wf.drop * 0.45, 4.5);
        }
      }
    }

    // Exact endpoint guarantee
    if (lut.length >= 2) {
      lut[0].lat = fromJunc.lat;
      lut[0].lng = fromJunc.lng;
      lut[0].elevation = fromJunc.elevation;
      const last = lut[lut.length - 1];
      last.lat = toJunc.lat;
      last.lng = toJunc.lng;
      last.elevation = toJunc.elevation;
    }

    const p0 = lut[0];
    const p1 = lut[Math.min(2, lut.length - 1)];
    const pEndPrev = lut[Math.max(0, lut.length - 3)];
    const pEnd = lut[lut.length - 1];

    const entryBearingDeg = initialBearing(p0.lat, p0.lng, p1.lat, p1.lng);
    const exitBearingDeg = initialBearing(pEndPrev.lat, pEndPrev.lng, pEnd.lat, pEnd.lng);

    return {
      waterway: ww,
      fromJunction: fromJunc,
      toJunction: toJunc,
      totalLengthU: cumulativeS,
      lut,
      entryBearingDeg,
      exitBearingDeg,
      speedBoost: ww.speedBoost ?? (ww.isConnector ? 1.65 : 1.0),
    };
  }
}

/**
 * Shared singleton planetary Mini-Earth world instance.
 * Auto-discovers all contributor packs in `src/world/packs/**\/index.ts` on load!
 */
export const earthWorld = new EarthWorld(true);

// Wire assetLoader's track-asset resolver automatically with zero circular imports!
assetLoader.setTrackAssetsResolver((regionOrTrackId: string) =>
  earthWorld.getRegionAssets(regionOrTrackId, false),
);
