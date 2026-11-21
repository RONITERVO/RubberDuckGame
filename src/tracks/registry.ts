import type { AssetId } from '../types';
import { DEFAULT_REGION_ID, earthWorld } from '../earth/earthWorld';
import {
  adaptZoneToTrackDefinition,
  type EarthTrackDefinition,
} from './schema';

export const DEFAULT_TRACK_ID = DEFAULT_REGION_ID;

const trackMap = new Map<string, EarthTrackDefinition>();
const trackList: EarthTrackDefinition[] = [];
export const TRACK_REGISTRY: Record<string, EarthTrackDefinition> = {};

/**
 * Rebuild the backward-compatible track registry dynamically from all
 * auto-discovered `EarthRegionPack`s in `earthWorld` — ZERO manual imports!
 */
export function syncTrackRegistryFromEarthWorld(): void {
  trackMap.clear();
  trackList.length = 0;
  for (const key of Object.keys(TRACK_REGISTRY)) {
    delete TRACK_REGISTRY[key];
  }

  for (const zone of earthWorld.getAllZones()) {
    const primaryWw = earthWorld.getPrimaryWaterwayForRegion(zone.id);
    const lengthU = primaryWw
      ? Math.max(240, Math.min(310, Math.round(earthWorld.getWaterwayLength(primaryWw.id))))
      : 270;

    // Derive outgoing region connections straight from real physical forks at exit junction!
    const connections: string[] = [];
    if (primaryWw) {
      const outgoing = earthWorld.getOutgoingWaterways(primaryWw.toJunctionId);
      for (const nextWw of outgoing) {
        const destZone = earthWorld.resolveTargetRegionForWaterway(nextWw);
        if (destZone.id !== zone.id && !connections.includes(destZone.id)) {
          connections.push(destZone.id);
        }
      }
    }

    const adapted = adaptZoneToTrackDefinition(zone, connections, lengthU);
    trackMap.set(adapted.id, adapted);
    trackList.push(adapted);
    TRACK_REGISTRY[adapted.id] = adapted;
  }
}

syncTrackRegistryFromEarthWorld();

export function registerTrack(track: EarthTrackDefinition): void {
  const existingIdx = trackList.findIndex((t) => t.id === track.id);
  if (existingIdx >= 0) {
    trackList[existingIdx] = track;
  } else {
    trackList.push(track);
  }
  trackMap.set(track.id, track);
  TRACK_REGISTRY[track.id] = track;
}

export function getAllTracks(): readonly EarthTrackDefinition[] {
  if (trackList.length !== earthWorld.getAllZones().length) {
    syncTrackRegistryFromEarthWorld();
  }
  return trackList;
}

export function findTrackById(id: string): EarthTrackDefinition | undefined {
  if (trackList.length !== earthWorld.getAllZones().length) {
    syncTrackRegistryFromEarthWorld();
  }
  return trackMap.get(id);
}

export function getTrackById(id?: string | null): EarthTrackDefinition {
  if (trackList.length !== earthWorld.getAllZones().length) {
    syncTrackRegistryFromEarthWorld();
  }
  if (id && trackMap.has(id)) {
    return trackMap.get(id)!;
  }
  return trackMap.get(DEFAULT_TRACK_ID) ?? trackList[0];
}

export function getTrackIndex(idOrTrack: string | EarthTrackDefinition): number {
  const id = typeof idOrTrack === 'string' ? idOrTrack : idOrTrack.id;
  return earthWorld.getZoneIndex(id);
}

export function getTrackAssets(
  trackOrId: EarthTrackDefinition | string,
  includeHeroCore: boolean = false,
): AssetId[] {
  const id = typeof trackOrId === 'string' ? trackOrId : trackOrId.id;
  return earthWorld.getRegionAssets(id, includeHeroCore);
}

export interface TrackGraphValidationResult {
  valid: boolean;
  errors: string[];
  reachableCount: number;
  totalCount: number;
}

export function validateTrackGraph(): TrackGraphValidationResult {
  const res = earthWorld.validateWorld();
  return {
    valid: res.valid,
    errors: res.errors,
    reachableCount: res.reachableZoneCount,
    totalCount: res.zoneCount,
  };
}
