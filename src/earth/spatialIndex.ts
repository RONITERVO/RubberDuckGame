import { MINI_EARTH_CONFIG } from '../config';
import {
  clampLat,
  DEG_TO_RAD,
  greatCircleDistanceDeg,
  greatCircleDistanceU,
  MINI_EARTH_RADIUS,
  normalizeLng,
  UNITS_PER_DEG,
} from './coords';
import type {
  EarthJunction,
  EarthLandmark,
  EarthRegionZone,
  EarthWaterway,
} from './schema';

export interface ZoneQueryResult {
  primary: EarthRegionZone;
  secondary: EarthRegionZone;
  /** Smooth [0, 0.5] blend weight toward `secondary` (continuous across zone midpoints). */
  blend: number;
}

function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * Geographic `10° × 10°` lat/lng spatial grid index for Mini-Earth.
 * Wraps longitude seamlessly across the `±180°` antimeridian and guarantees
 * O(local) runtime whether Mini-Earth holds 6 regions or 1,000 contributor regions!
 */
export class GeoSpatialIndex {
  public readonly cellSizeDeg: number;
  private readonly numLatCells: number;
  private readonly numLngCells: number;

  private readonly zoneCells = new Map<number, EarthRegionZone[]>();
  private readonly waterwayCells = new Map<number, Set<EarthWaterway>>();
  private readonly landmarkCells = new Map<number, EarthLandmark[]>();
  private readonly junctionCells = new Map<number, EarthJunction[]>();

  private allZones: EarthRegionZone[] = [];

  constructor(cellSizeDeg: number = MINI_EARTH_CONFIG.spatialCellDeg) {
    this.cellSizeDeg = Math.max(1, cellSizeDeg);
    this.numLatCells = Math.ceil(180 / this.cellSizeDeg);
    this.numLngCells = Math.ceil(360 / this.cellSizeDeg);
  }

  public clear(): void {
    this.zoneCells.clear();
    this.waterwayCells.clear();
    this.landmarkCells.clear();
    this.junctionCells.clear();
    this.allZones = [];
  }

  public addZone(zone: EarthRegionZone): void {
    this.allZones.push(zone);
    const maxDeg = Math.max(1, zone.radiusDeg + zone.falloffDeg);
    const cells = this.collectCellsInRadiusDeg(
      zone.centerLat,
      zone.centerLng,
      maxDeg,
    );
    for (const key of cells) {
      let bucket = this.zoneCells.get(key);
      if (!bucket) {
        bucket = [];
        this.zoneCells.set(key, bucket);
      }
      if (!bucket.includes(zone)) {
        bucket.push(zone);
      }
    }
  }

  /**
   * Index a waterway across every `10° × 10°` cell touched by its sampled points.
   */
  public addWaterway(
    waterway: EarthWaterway,
    sampledPoints: ReadonlyArray<{ lat: number; lng: number }>,
  ): void {
    for (let i = 0; i < sampledPoints.length; i++) {
      const pt = sampledPoints[i];
      const key = this.cellKeyAt(pt.lat, pt.lng);
      let bucket = this.waterwayCells.get(key);
      if (!bucket) {
        bucket = new Set<EarthWaterway>();
        this.waterwayCells.set(key, bucket);
      }
      bucket.add(waterway);
    }
  }

  public addLandmark(landmark: EarthLandmark): void {
    const key = this.cellKeyAt(landmark.lat, landmark.lng);
    let bucket = this.landmarkCells.get(key);
    if (!bucket) {
      bucket = [];
      this.landmarkCells.set(key, bucket);
    }
    bucket.push(landmark);
  }

  public addJunction(junction: EarthJunction): void {
    const key = this.cellKeyAt(junction.lat, junction.lng);
    let bucket = this.junctionCells.get(key);
    if (!bucket) {
      bucket = [];
      this.junctionCells.set(key, bucket);
    }
    bucket.push(junction);
  }

  /**
   * O(1) spatial biome field query at `(lat, lng)`.
   * Returns the top-2 overlapping `EarthRegionZone`s and a C1-continuous `blend`
   * weight toward `secondary` so transitions across zone boundaries never pop.
   */
  public queryZonesAt(lat: number, lng: number): ZoneQueryResult | null {
    if (this.allZones.length === 0) return null;

    const key = this.cellKeyAt(lat, lng);
    const localCandidates = this.zoneCells.get(key);

    if (localCandidates && localCandidates.length > 0) {
      let bestZone: EarthRegionZone | null = null;
      let bestW = -1;
      let bestPriority = -Infinity;

      let secondZone: EarthRegionZone | null = null;
      let secondW = -1;
      let secondPriority = -Infinity;

      for (let i = 0; i < localCandidates.length; i++) {
        const z = localCandidates[i];
        const distDeg = greatCircleDistanceDeg(lat, lng, z.centerLat, z.centerLng);
        const outer = z.radiusDeg + Math.max(0.5, z.falloffDeg);
        if (distDeg >= outer) continue;

        let w: number;
        if (distDeg <= z.radiusDeg) {
          w = 1.0;
        } else {
          const t = (distDeg - z.radiusDeg) / Math.max(0.5, z.falloffDeg);
          w = 1.0 - smoothstep01(t);
        }
        if (w <= 1e-5) continue;

        const prio = z.priority ?? 0;
        const beatsBest =
          w > bestW + 1e-5 || (Math.abs(w - bestW) <= 1e-5 && prio > bestPriority);

        if (beatsBest) {
          secondZone = bestZone;
          secondW = bestW;
          secondPriority = bestPriority;
          bestZone = z;
          bestW = w;
          bestPriority = prio;
        } else {
          const beatsSecond =
            w > secondW + 1e-5 ||
            (Math.abs(w - secondW) <= 1e-5 && prio > secondPriority);
          if (beatsSecond) {
            secondZone = z;
            secondW = w;
            secondPriority = prio;
          }
        }
      }

      if (bestZone) {
        if (!secondZone || secondW <= 1e-4) {
          return { primary: bestZone, secondary: bestZone, blend: 0 };
        }
        const blend = secondW / (bestW + secondW);
        return { primary: bestZone, secondary: secondZone, blend };
      }
    }

    // Open-ocean fallback between distant continents: smoothly blend 2 globally nearest zones
    let nearestA: EarthRegionZone = this.allZones[0];
    let distA = Infinity;
    let nearestB: EarthRegionZone = this.allZones[0];
    let distB = Infinity;

    for (let i = 0; i < this.allZones.length; i++) {
      const z = this.allZones[i];
      const rawDist = greatCircleDistanceDeg(lat, lng, z.centerLat, z.centerLng);
      const edgeDist = Math.max(0.25, rawDist - z.radiusDeg);
      if (edgeDist < distA) {
        nearestB = nearestA;
        distB = distA;
        nearestA = z;
        distA = edgeDist;
      } else if (edgeDist < distB) {
        nearestB = z;
        distB = edgeDist;
      }
    }

    if (nearestA.id === nearestB.id || !Number.isFinite(distB)) {
      return { primary: nearestA, secondary: nearestA, blend: 0 };
    }

    const wA = 1 / (distA * distA);
    const wB = 1 / (distB * distB);
    const blend = wB / (wA + wB);
    return { primary: nearestA, secondary: nearestB, blend };
  }

  /**
   * O(local) spatial query for all `EarthWaterway`s touching cells within `radiusU`.
   */
  public queryWaterwaysNear(
    lat: number,
    lng: number,
    radiusU: number,
  ): EarthWaterway[] {
    const radiusDeg = Math.max(0.5, radiusU / UNITS_PER_DEG);
    const cells = this.collectCellsInRadiusDeg(lat, lng, radiusDeg);
    const seen = new Set<EarthWaterway>();
    for (const key of cells) {
      const bucket = this.waterwayCells.get(key);
      if (!bucket) continue;
      for (const ww of bucket) {
        seen.add(ww);
      }
    }
    return Array.from(seen);
  }

  /**
   * O(local) spatial query for persistent `EarthLandmark`s within `radiusU` world units.
   */
  public queryLandmarksNear(
    lat: number,
    lng: number,
    radiusU: number,
  ): EarthLandmark[] {
    const radiusDeg = Math.max(0.25, radiusU / UNITS_PER_DEG);
    const cells = this.collectCellsInRadiusDeg(lat, lng, radiusDeg);
    const out: EarthLandmark[] = [];
    for (const key of cells) {
      const bucket = this.landmarkCells.get(key);
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        const lm = bucket[i];
        if (greatCircleDistanceU(lat, lng, lm.lat, lm.lng, MINI_EARTH_RADIUS) <= radiusU) {
          out.push(lm);
        }
      }
    }
    return out;
  }

  /**
   * O(local) spatial query for physical `EarthJunction`s within `radiusU` world units.
   */
  public queryJunctionsNear(
    lat: number,
    lng: number,
    radiusU: number,
  ): EarthJunction[] {
    const radiusDeg = Math.max(0.25, radiusU / UNITS_PER_DEG);
    const cells = this.collectCellsInRadiusDeg(lat, lng, radiusDeg);
    const out: EarthJunction[] = [];
    for (const key of cells) {
      const bucket = this.junctionCells.get(key);
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        const j = bucket[i];
        if (greatCircleDistanceU(lat, lng, j.lat, j.lng, MINI_EARTH_RADIUS) <= radiusU) {
          out.push(j);
        }
      }
    }
    return out;
  }

  private latToRow(lat: number): number {
    const clamped = clampLat(lat);
    const row = Math.floor((clamped + 90) / this.cellSizeDeg);
    return Math.max(0, Math.min(this.numLatCells - 1, row));
  }

  private lngToCol(lng: number): number {
    const wrapped = normalizeLng(lng);
    const raw = Math.floor((wrapped + 180) / this.cellSizeDeg);
    return ((raw % this.numLngCells) + this.numLngCells) % this.numLngCells;
  }

  private cellKey(row: number, col: number): number {
    return row * 1024 + col;
  }

  private cellKeyAt(lat: number, lng: number): number {
    return this.cellKey(this.latToRow(lat), this.lngToCol(lng));
  }

  /**
   * Collect all cell keys covering a spherical cap of angular radius `radiusDeg`
   * centered at `(lat, lng)`, handling polar expansion and `±180°` wrapping cleanly.
   */
  private collectCellsInRadiusDeg(
    lat: number,
    lng: number,
    radiusDeg: number,
  ): number[] {
    const minLat = Math.max(-89.999, lat - radiusDeg);
    const maxLat = Math.min(89.999, lat + radiusDeg);
    const minRow = this.latToRow(minLat);
    const maxRow = this.latToRow(maxLat);

    // Polar cap: if radius reaches within 3° of either pole, include all longitude columns
    const touchesPole = Math.abs(lat) + radiusDeg >= 87.0;
    const keys: number[] = [];

    if (touchesPole) {
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = 0; c < this.numLngCells; c++) {
          keys.push(this.cellKey(r, c));
        }
      }
      return keys;
    }

    const maxAbsLat = Math.max(Math.abs(minLat), Math.abs(maxLat));
    const cosLat = Math.max(0.08, Math.cos(maxAbsLat * DEG_TO_RAD));
    const lngSpanDeg = Math.min(180, radiusDeg / cosLat);

    if (lngSpanDeg >= 179.5) {
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = 0; c < this.numLngCells; c++) {
          keys.push(this.cellKey(r, c));
        }
      }
      return keys;
    }

    const colHalfSpan = Math.ceil(lngSpanDeg / this.cellSizeDeg) + 1;
    const centerCol = this.lngToCol(lng);

    for (let r = minRow; r <= maxRow; r++) {
      for (let dc = -colHalfSpan; dc <= colHalfSpan; dc++) {
        const c = ((centerCol + dc) % this.numLngCells + this.numLngCells) % this.numLngCells;
        keys.push(this.cellKey(r, c));
      }
    }
    return keys;
  }
}
