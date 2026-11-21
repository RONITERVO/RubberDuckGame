import { latLngToSphere } from '../earth/coords';
import {
  blendAtmospheres,
  blendAudioProfiles,
  blendGroundStyles,
  blendRiverProfiles,
  blendWaterStyles,
  blendWeathers,
  type EarthTrackDefinition,
  type RouteMode,
  type TrackAtmosphere,
  type TrackAudioProfile,
  type TrackGroundStyle,
  type TrackRiverProfile,
  type TrackWaterStyle,
  type TrackWeather,
} from './schema';
import {
  DEFAULT_TRACK_ID,
  findTrackById,
  getAllTracks,
  getTrackById,
} from './registry';

export const DEFAULT_TRANSITION_SPAN = 42.0;

export interface RouteLeg {
  index: number;
  trackId: string;
  track: EarthTrackDefinition;
  startS: number;
  endS: number;
  length: number;
}

export interface WorldRouteSample {
  currentTrack: EarthTrackDefinition;
  nextTrack: EarthTrackDefinition;
  blend: number;
  trackProgress: number;
  legIndex: number;
  totalLegsVisited: number;
  legStartS: number;
  legEndS: number;
  routeMode: RouteMode;
}

export interface BlendedWorldTrackState extends WorldRouteSample {
  riverProfile: TrackRiverProfile;
  waterStyle: TrackWaterStyle;
  atmosphere: TrackAtmosphere;
  weather: TrackWeather;
  groundStyle: TrackGroundStyle;
  audioProfile: TrackAudioProfile;
}

export interface WorldRouteOptions {
  routeMode?: RouteMode;
  startTrackId?: string;
  transitionSpan?: number;
  seed?: number;
}

export interface GlobeEdgeConnection {
  fromId: string;
  toId: string;
  from: EarthTrackDefinition;
  to: EarthTrackDefinition;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * Backward-compatible route controller backed by auto-discovered Mini-Earth
 * packs in `earthWorld`. Supports `'world_tour'`, `'free_earth'`, and `'single_track'`.
 */
export class WorldRouteController {
  private routeMode: RouteMode = 'world_tour';
  private startTrackId: string = DEFAULT_TRACK_ID;
  private transitionSpan: number = DEFAULT_TRANSITION_SPAN;
  private seed: number = 1;
  private legs: RouteLeg[] = [];
  private legVisitedTracker = new Set<string>();

  constructor(options?: WorldRouteOptions) {
    this.reset(options);
  }

  public reset(options?: WorldRouteOptions): void {
    if (options?.routeMode) {
      this.routeMode = options.routeMode;
    }
    if (options?.startTrackId) {
      this.startTrackId = getTrackById(options.startTrackId).id;
    } else {
      this.startTrackId = getTrackById(this.startTrackId).id;
    }
    if (
      options?.transitionSpan !== undefined &&
      Number.isFinite(options.transitionSpan) &&
      options.transitionSpan > 1
    ) {
      this.transitionSpan = options.transitionSpan;
    }
    if (options?.seed !== undefined && Number.isFinite(options.seed)) {
      this.seed = Math.abs(Math.floor(options.seed)) || 1;
    }

    this.legs = [];
    this.legVisitedTracker.clear();

    const firstTrack = getTrackById(this.startTrackId);
    const length = Math.max(120, firstTrack.segmentLength);
    this.legs.push({
      index: 0,
      trackId: firstTrack.id,
      track: firstTrack,
      startS: 0,
      endS: length,
      length,
    });
    this.legVisitedTracker.add(firstTrack.id);

    this.ensureLegsUpToS(length * 3);
  }

  public configureRoute(
    routeMode: RouteMode,
    startTrackId: string = this.startTrackId,
    seed: number = this.seed,
  ): void {
    this.reset({ routeMode, startTrackId, seed });
  }

  public setRouteMode(mode: RouteMode, lockedTrackId?: string): void {
    this.reset({
      routeMode: mode,
      startTrackId: lockedTrackId ?? this.startTrackId,
    });
  }

  public getRouteMode(): RouteMode {
    return this.routeMode;
  }

  public setStartTrack(trackId: string): void {
    this.reset({
      routeMode: this.routeMode,
      startTrackId: trackId,
    });
  }

  public getStartTrackId(): string {
    return this.startTrackId;
  }

  public getTransitionSpan(): number {
    return this.transitionSpan;
  }

  public sampleAt(s: number): WorldRouteSample {
    const safeS = Math.max(0, s);
    this.ensureLegsUpToS(safeS + 600);

    const legIdx = this.findLegIndexAtS(safeS);
    const currentLeg = this.legs[legIdx];
    const nextLeg = this.legs[legIdx + 1];

    const localS = clamp(safeS - currentLeg.startS, 0, currentLeg.length);
    const trackProgress = clamp(localS / Math.max(1, currentLeg.length), 0, 1);

    const isConnectedMode =
      this.routeMode === 'world_tour' || this.routeMode === 'free_earth';

    let blend = 0;
    if (isConnectedMode && currentLeg.trackId !== nextLeg.trackId) {
      const span = Math.min(this.transitionSpan, currentLeg.length * 0.45);
      const blendStartS = currentLeg.endS - span;
      if (safeS > blendStartS) {
        blend = smoothstep01((safeS - blendStartS) / Math.max(1e-3, span));
      }
    }

    return {
      currentTrack: currentLeg.track,
      nextTrack: isConnectedMode ? nextLeg.track : currentLeg.track,
      blend,
      trackProgress,
      legIndex: currentLeg.index,
      totalLegsVisited: currentLeg.index + 1,
      legStartS: currentLeg.startS,
      legEndS: currentLeg.endS,
      routeMode: this.routeMode,
    };
  }

  public getBlendedStateAt(s: number): BlendedWorldTrackState {
    const sample = this.sampleAt(s);
    const { currentTrack: a, nextTrack: b, blend: t } = sample;
    if (t <= 0 || a.id === b.id) {
      return {
        ...sample,
        riverProfile: a.riverProfile,
        waterStyle: a.waterStyle,
        atmosphere: a.atmosphere,
        weather: a.weather,
        groundStyle: a.groundStyle,
        audioProfile: a.audioProfile,
      };
    }
    return {
      ...sample,
      riverProfile: blendRiverProfiles(a.riverProfile, b.riverProfile, t),
      waterStyle: blendWaterStyles(a.waterStyle, b.waterStyle, t),
      atmosphere: blendAtmospheres(a.atmosphere, b.atmosphere, t),
      weather: blendWeathers(a.weather, b.weather, t),
      groundStyle: blendGroundStyles(a.groundStyle, b.groundStyle, t),
      audioProfile: blendAudioProfiles(a.audioProfile, b.audioProfile, t),
    };
  }

  public getVisitedTrackIds(playerS: number = 0): string[] {
    const safeS = Math.max(0, playerS);
    this.ensureLegsUpToS(safeS + 60);

    const visited: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];
      if (leg.startS <= safeS + 1e-3) {
        if (!seen.has(leg.trackId)) {
          seen.add(leg.trackId);
          visited.push(leg.trackId);
        }
      } else {
        break;
      }
    }
    if (visited.length === 0) {
      visited.push(this.startTrackId);
    }
    return visited;
  }

  public getUpcomingTracks(
    playerS: number,
    lookaheadS: number = 320,
  ): EarthTrackDefinition[] {
    const safeS = Math.max(0, playerS);
    const maxS = safeS + Math.max(60, lookaheadS);
    this.ensureLegsUpToS(maxS + 100);

    const result: EarthTrackDefinition[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];
      if (leg.endS < safeS) continue;
      if (leg.startS > maxS) break;
      if (!seen.has(leg.trackId)) {
        seen.add(leg.trackId);
        result.push(leg.track);
      }
    }
    return result;
  }

  public getPlannedLegs(count: number = 6): readonly RouteLeg[] {
    while (this.legs.length < count) {
      this.appendNextLeg();
    }
    return this.legs.slice(0, count);
  }

  private ensureLegsUpToS(targetS: number): void {
    while (
      this.legs.length < 2 ||
      this.legs[this.legs.length - 1].endS <= targetS
    ) {
      this.appendNextLeg();
    }
  }

  private appendNextLeg(): void {
    const prevLeg = this.legs[this.legs.length - 1];
    const prevPrevLeg =
      this.legs.length >= 2 ? this.legs[this.legs.length - 2] : null;
    const nextIndex = prevLeg.index + 1;

    let nextTrack: EarthTrackDefinition;
    if (this.routeMode === 'single_track') {
      nextTrack = prevLeg.track;
    } else {
      nextTrack = this.chooseNextConnectedTrack(
        prevLeg.track,
        prevPrevLeg?.trackId ?? null,
        nextIndex,
      );
    }

    const length = Math.max(120, nextTrack.segmentLength);
    const startS = prevLeg.endS;
    const endS = startS + length;

    this.legs.push({
      index: nextIndex,
      trackId: nextTrack.id,
      track: nextTrack,
      startS,
      endS,
      length,
    });
    this.legVisitedTracker.add(nextTrack.id);
  }

  private chooseNextConnectedTrack(
    current: EarthTrackDefinition,
    previousTrackId: string | null,
    nextLegIndex: number,
  ): EarthTrackDefinition {
    const validCandidates: EarthTrackDefinition[] = [];
    for (const connId of current.connections) {
      const found = findTrackById(connId);
      if (found && found.id !== current.id) {
        validCandidates.push(found);
      }
    }

    if (validCandidates.length === 0) {
      const all = getAllTracks().filter((t) => t.id !== current.id);
      if (all.length === 0) return current;
      return all[nextLegIndex % all.length];
    }

    const unvisited = validCandidates.filter(
      (c) => !this.legVisitedTracker.has(c.id),
    );
    if (unvisited.length > 0) {
      return unvisited[0];
    }

    const nonPingPong = validCandidates.filter(
      (c) => c.id !== previousTrackId,
    );
    const pool = nonPingPong.length > 0 ? nonPingPong : validCandidates;
    return pool[(nextLegIndex + this.seed) % pool.length];
  }

  private findLegIndexAtS(s: number): number {
    let lo = 0;
    let hi = this.legs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const leg = this.legs[mid];
      if (s < leg.startS) {
        hi = mid - 1;
      } else if (s >= leg.endS) {
        lo = mid + 1;
      } else {
        return mid;
      }
    }
    return clamp(lo, 0, Math.max(0, this.legs.length - 2));
  }
}

export function getAllGlobeConnections(): GlobeEdgeConnection[] {
  const edges: GlobeEdgeConnection[] = [];
  for (const from of getAllTracks()) {
    for (const toId of from.connections) {
      const to = findTrackById(toId);
      if (to) {
        edges.push({ fromId: from.id, toId: to.id, from, to });
      }
    }
  }
  return edges;
}

export function latLngToGlobeVec3(
  lat: number,
  lng: number,
  radius: number = 1.0,
): { x: number; y: number; z: number } {
  return latLngToSphere(lat, lng, radius);
}

export const worldRoute = new WorldRouteController();
