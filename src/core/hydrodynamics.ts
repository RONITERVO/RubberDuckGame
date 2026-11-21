import { DUCK_CONFIG, OBSTACLE_CONFIG, RIVER_CONFIG } from '../config';
import { DEFAULT_REGION_ID, earthWorld } from '../earth/earthWorld';
import type { BlendedEarthRegion } from '../earth/schema';
import { worldRoute, type WorldRouteController } from '../tracks/worldGraph';
import type { HydroObstacle, RiverProvider, WaterSurfaceQuery } from '../types';
import { RiverSpline, type ExtendedRiverSample } from './riverSpline';

export interface HydroForceSample {
  /** Local downstream water current speed (world units/sec). */
  flowSpeed: number;
  /** Downstream acceleration contribution from slope, chute, pillow, eddy, and waterfall lip (u/s^2). */
  forwardAccel: number;
  /** Lateral cross-current, centrifugal bend pull, rock pillow push, rapids chop, and surface/aerial wind (u/s^2). */
  lateralAccel: number;
  /** Vertical buoyancy boil / plunge-pool aeration / chop heave perturbation (u/s^2). */
  verticalAccel: number;
  /** Roll angular perturbation from choppy rapids, rock seams, and crosswind gusts (rad/s^2). */
  rollPerturbation: number;
  /** Pitch angular perturbation from rapids surges and wave faces (rad/s^2). */
  pitchPerturbation: number;
  /** Combined whitewater turbulence intensity in [0, 1]. */
  turbulence: number;
  /** True when the queried point sits inside a calm downstream boulder eddy pocket. */
  inEddy: boolean;
  /** Perturbation signal [0, 1] that triggers the duck's spooked balancing animation. */
  spookSignal: number;
  /** Nearest obstacle grazing within the near-miss hydrodynamic envelope, if any. */
  nearMissObstacle: HydroObstacle | null;
  /** Underlying water surface height, analytical wave normal, foam, and depth at (s, u, time). */
  surface: WaterSurfaceQuery;
  /** Sampled river spline frame at `s`. */
  riverSample: ExtendedRiverSample;
  /** Regional weather lateral wind/gust drift acceleration (u/s^2), active when airborne/flying or in stormy stretches. */
  windLateralAccel: number;
  /** Blended regional wind strength [0..2] at arc-length `s`. */
  windStrength: number;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * Kayaking-inspired whitewater hydrodynamics force field.
 *
 * Computes realistic, playable river currents at `(s, u, y, time)`:
 * - Faster flow in narrow chutes, steep slopes, and outer bends (thalweg profile)
 * - Tangible but always fair & counter-steerable centrifugal & cross-current lateral pull
 * - Rapids turbulence chop waves & lateral/roll nudges
 * - Upstream rock water-pillow deflection & calm downstream eddy pockets (`hasEddy`)
 * - Waterfall lip draw acceleration & plunge-pool churning buoyancy bounce
 * - Turbulence & near-miss perturbation signals driving spooked balancing animations
 */
export class Hydrodynamics {
  private readonly river: RiverProvider;
  private route: WorldRouteController;

  constructor(river: RiverProvider, route?: WorldRouteController) {
    this.river = river;
    this.route =
      route ??
      (river instanceof RiverSpline ? river.getRouteController() : worldRoute);
  }

  public setRouteController(route: WorldRouteController): void {
    this.route = route;
  }

  public getRouteController(): WorldRouteController {
    return this.river instanceof RiverSpline
      ? this.river.getRouteController()
      : this.route;
  }

  /**
   * Query full hydrodynamic force field at river coordinates `(s, u, y)` and elapsed `time`.
   * Pass active nearby `obstacles` (if omitted, queries `river.getObstaclesInRange?.(...)`).
   */
  public sampleForces(
    s: number,
    u: number,
    y: number,
    time: number,
    obstacles?: readonly HydroObstacle[],
    currentForwardSpeed: number = DUCK_CONFIG.baseSpeed,
  ): HydroForceSample {
    const rawSample = this.river.sampleAt(s);
    const defaultZone = earthWorld.getZoneById(DEFAULT_REGION_ID);
    const sampleLat = rawSample.lat ?? defaultZone.centerLat;
    const sampleLng = rawSample.lng ?? defaultZone.centerLng;
    const blendedRegion = earthWorld.getBlendedRegionAt(sampleLat, sampleLng);
    const trackProfile = blendedRegion.riverProfile;
    const trackWater = blendedRegion.waterStyle;
    const trackWeather = blendedRegion.weather;

    const sample = this.asExtendedSample(rawSample, blendedRegion);
    const surface =
      this.river instanceof RiverSpline
        ? this.river.getWaterSurfaceAtRiver(s, u, time)
        : this.river.getWaterSurface(
            sample.position.x + sample.right.x * u,
            sample.position.z + sample.right.z * u,
            time,
            s,
          );

    const activeCave = this.river.isInsideCave(s, u);
    const halfWidth = activeCave ? activeCave.width * 0.5 : sample.width * 0.5;
    const localU =
      activeCave && this.river instanceof RiverSpline
        ? u - this.river.getCaveCenterU(activeCave, s)
        : u;
    const edgeNorm = clamp(Math.abs(localU) / Math.max(1.0, halfWidth), 0, 1);

    // 1. Thalweg & Chute Flow Profile scaled by regional waterStyle.flowSpeedMult & waterway speedBoost
    const refMidWidth = 0.5 * (trackProfile.widthMin + trackProfile.widthMax);
    const chuteFactor = Math.pow(
      clamp(refMidWidth / Math.max(4.0, sample.width), 0.72, 1.55),
      0.68,
    );
    const slopeExcess = Math.max(0, -sample.slope - 0.042);
    const slopeFactor = 1.0 + Math.min(1.15, slopeExcess * 4.8);

    // Outer bend thalweg shift:
    // +curvature bends RIGHT, so outer bank is LEFT (-u). Shift peak flow toward -curvature.
    const outerSign = -Math.sign(sample.curvature);
    const bendStrength = clamp(Math.abs(sample.curvature) * 32.0, 0, 1);
    const thalwegOffsetU = activeCave
      ? 0
      : outerSign * bendStrength * halfWidth * 0.42;
    const distFromThalweg = clamp(
      Math.abs(localU - thalwegOffsetU) / Math.max(1.0, halfWidth * 1.15),
      0,
      1,
    );
    const transverseProfile = 1.08 - 0.36 * distFromThalweg * distFromThalweg;

    // Slight vertical shear: water near riverbed pebbles flows slightly slower than surface
    const depthFrac = clamp(-y / Math.max(1.0, surface.depth), 0, 1);
    const verticalShear = y < 0 ? 1.0 - 0.14 * depthFrac * depthFrac : 1.0;

    // Cave shortcut has a crisp rushing underwater siphon surge; ocean straits boost smoothly
    const caveSurge = activeCave ? 1.14 : 1.0;
    const regionalFlowMult = clamp(trackWater.flowSpeedMult, 0.85, 1.32);
    const jetStreamMult = clamp(1.0 + (sample.speedBoost - 1.0) * 0.42, 0.9, 1.42);

    let flowSpeed = clamp(
      DUCK_CONFIG.baseSpeed *
        regionalFlowMult *
        jetStreamMult *
        chuteFactor *
        slopeFactor *
        transverseProfile *
        verticalShear *
        caveSurge,
      DUCK_CONFIG.baseSpeed * 0.65,
      DUCK_CONFIG.maxSpeed * 1.28,
    );

    // Water contact factor: 1.0 when on/below surface, fading cleanly to 0 when airborne
    const waveSurfaceY = surface.height - sample.position.y;
    const heightAboveWater = y - waveSurfaceY;
    const waterContact = 1.0 - smoothstep01((heightAboveWater - 0.12) / 0.65);

    let forwardAccel = (flowSpeed - currentForwardSpeed) * 0.65 * waterContact;
    let lateralAccel = 0;
    let verticalAccel = 0;
    let rollPerturbation = 0;
    let pitchPerturbation = 0;
    let inEddy = false;
    let spookSignal = 0;
    let nearMissObstacle: HydroObstacle | null = null;

    // 2. Centrifugal & Cross-Current Lateral Pull around Bends (fair & counter-steerable)
    if (!activeCave && waterContact > 0.01) {
      // Secondary helical current: pushes gently outward near surface, slightly less deep down
      const helicalScale = 1.0 - 0.35 * depthFrac;
      const rawCentrifugal =
        -sample.curvature *
        currentForwardSpeed *
        currentForwardSpeed *
        0.46 *
        helicalScale;
      // Cap lateral bend pull firmly so player steering (58 u/s^2) always dominates comfortably
      lateralAccel += clamp(rawCentrifugal, -4.2, 4.2) * waterContact;

      // Subtle bank reflection cushion very close to edges
      if (edgeNorm > 0.82) {
        const edgePush = smoothstep01((edgeNorm - 0.82) / 0.18);
        lateralAccel += -Math.sign(localU) * edgePush * 3.8 * waterContact;
      }
    }

    // 3. Rapids Turbulence Chop Waves & Lateral/Roll Nudges scaled by regional rapidsBase
    const rapidsBaseBoost = clamp(trackProfile.rapidsBase, 0.15, 0.75);
    const regionalChopScale = 0.82 + 0.45 * rapidsBaseBoost;
    const rapids = activeCave
      ? sample.rapidsIntensity * 0.38
      : clamp(Math.max(sample.rapidsIntensity, rapidsBaseBoost * 0.78), 0, 1);
    let turbulence = clamp(
      (rapids * 0.78 +
        sample.plungePoolIntensity * 0.55 +
        (sample.isWaterfall ? 0.45 : 0)) *
        regionalChopScale,
      0,
      1,
    );

    if (waterContact > 0.01) {
      // Deterministic multi-octave whitewater chop field
      const n1 = Math.sin(s * 0.43 + u * 0.71 - time * 6.4);
      const n2 = Math.cos(s * 0.89 - u * 1.13 - time * 9.8);
      const n3 = Math.sin(s * 1.47 + u * 0.53 - time * 13.5);
      const lateralChop = (0.55 * n1 + 0.32 * n2 + 0.13 * n3) * turbulence;
      const verticalChop = (0.5 * n2 - 0.5 * n3) * turbulence;

      // Underwater is smoother than surface whitewater froth
      const surfaceRoughness = y < -0.35 ? 0.35 : 1.0;

      lateralAccel += lateralChop * 3.6 * regionalChopScale * surfaceRoughness * waterContact;
      verticalAccel += verticalChop * 4.4 * regionalChopScale * surfaceRoughness * waterContact;
      rollPerturbation += lateralChop * 2.8 * regionalChopScale * surfaceRoughness * waterContact;
      pitchPerturbation += verticalChop * 1.9 * regionalChopScale * surfaceRoughness * waterContact;

      // Occasional heavy whitewater jolt triggers playful spooked balancing!
      const joltPeak = Math.abs(n1 * n2);
      if (turbulence > 0.62 && joltPeak > 0.72 && y > -0.3) {
        const joltStrength = clamp((turbulence - 0.55) * 1.45 * joltPeak, 0, 0.85);
        spookSignal = Math.max(spookSignal, joltStrength);
      }
    }

    // 3b. 100% Data-Driven Regional Weather Wind & Gust Influence (zero hardcoded weather IDs!)
    let windLateralAccel = 0;
    const windStrength = activeCave ? 0 : clamp(trackWeather.windStrength, 0, 1.5);
    if (windStrength > 0.05) {
      // Smooth multi-frequency gusting breeze wave along the river corridor
      const gustWave =
        0.58 * Math.sin(time * 1.45 + s * 0.022) +
        0.42 * Math.cos(time * 2.35 - s * 0.036 + u * 0.12);

      // Compute continuous storminess purely from data-driven WeatherParams
      const storminess = clamp(
        trackWeather.rainRipples * 0.45 +
          trackWeather.lightningChance * 0.35 +
          Math.max(0, trackWeather.windStrength - 0.5) * 0.55 +
          trackWeather.intensity * 0.25,
        0,
        1,
      );
      const stormMult = 0.82 + 0.48 * storminess;

      // Airborne / flying feels crisp lateral crosswind gusts; surface feels subtle stormy breeze drift;
      // deep underwater diving is completely sheltered from wind!
      const airborneExposure = smoothstep01((heightAboveWater - 0.05) / 0.9);
      const surfaceExposure =
        y > -0.18
          ? (1.0 - airborneExposure) * (0.26 + 0.34 * storminess)
          : 0.0;
      const edgeShelter =
        edgeNorm > 0.78 ? 1.0 - smoothstep01((edgeNorm - 0.78) / 0.22) * 0.65 : 1.0;

      windLateralAccel =
        gustWave *
        windStrength *
        stormMult *
        2.35 *
        (airborneExposure + surfaceExposure) *
        edgeShelter;

      lateralAccel += windLateralAccel;
      rollPerturbation += windLateralAccel * (0.28 + 0.22 * airborneExposure);
    }

    // 4. Waterfall Lip Draw Acceleration & Plunge Pool Churning Bounce
    if (this.river instanceof RiverSpline) {
      const nextWf = this.river.getNextWaterfall(s - 30);
      if (nextWf) {
        const distToLip = nextWf.startS - s;
        // Accelerating shallow draw right before waterfall cliff edge
        if (distToLip > -2 && distToLip < 16 && waterContact > 0.05) {
          const drawT = smoothstep01(1.0 - Math.max(0, distToLip) / 16);
          forwardAccel += drawT * 11.5 * waterContact;
          // Gentle centering draw away from cliff corners
          lateralAccel += -localU * 0.14 * drawT * waterContact;
          if (distToLip < 5.5) {
            spookSignal = Math.max(spookSignal, 0.72 * drawT);
          }
        }
      }
    }

    if (sample.plungePoolIntensity > 0.01 && waterContact > 0.01) {
      // Aerated foaming boil in the waterfall plunge pool bounces the rubber duck playfully!
      const boilOsc = 0.65 + 0.35 * Math.sin(time * 12.0 + s * 0.5);
      const boil = sample.plungePoolIntensity * waterContact;
      verticalAccel += boil * 9.5 * boilOsc;
      lateralAccel += Math.sin(time * 8.4 + u * 0.9) * boil * 3.4;
      rollPerturbation += Math.cos(time * 10.2 + s * 0.7) * boil * 3.2;
      turbulence = clamp(turbulence + boil * 0.35, 0, 1);
    }

    // 5. Obstacle Hydrodynamics: Upstream Water Pillow, Downstream Eddy Pocket & Near-Misses
    const activeObstacles =
      obstacles ?? this.river.getObstaclesInRange?.(s - 12, s + 16) ?? [];

    let closestNearMissDist = Infinity;

    for (let i = 0; i < activeObstacles.length; i++) {
      const obs = activeObstacles[i];
      const ds = obs.s - s; // >0 means obstacle is downstream ahead of duck
      if (ds < -14 || ds > 14) continue;

      const du = u - obs.u; // >0 means duck is to the RIGHT of obstacle
      const absDu = Math.abs(du);
      const effRadius = Math.max(0.7, obs.radius);

      // Skip vertical non-interacting obstacles (e.g. duck flying high overhead or diving well under arch)
      const isBoulderLike = obs.type === 'boulder' || obs.type === 'snag';

      if (isBoulderLike && waterContact > 0.05) {
        // Upstream Water-Pillow Push: cushion of piled water right in front of boulder
        if (ds > 0 && ds < effRadius * 3.0 && absDu < effRadius * 1.85) {
          const longitudinal = smoothstep01(1.0 - ds / (effRadius * 3.0));
          const lateralEnv = smoothstep01(1.0 - absDu / (effRadius * 1.85));
          const pillow = longitudinal * lateralEnv * waterContact;

          // Push laterally around whichever side the duck leans toward (biased by slight offset)
          const deflectDir = absDu > 0.08 ? Math.sign(du) : localU >= 0 ? -1 : 1;
          lateralAccel += deflectDir * pillow * 9.2;
          forwardAccel -= pillow * 5.2;
          verticalAccel += pillow * 2.4;
          rollPerturbation += deflectDir * pillow * 1.9;
          turbulence = clamp(turbulence + pillow * 0.35, 0, 1);
        }

        // Downstream Calm Eddy Pocket (hasEddy): slower swirling pool behind rock
        if (obs.hasEddy && ds < -effRadius * 0.25 && ds > -effRadius * 4.0) {
          const behindDist = -ds;
          if (absDu < effRadius * 1.25) {
            const eddyLong =
              smoothstep01((behindDist - effRadius * 0.25) / (effRadius * 0.9)) *
              smoothstep01(1.0 - behindDist / (effRadius * 4.0));
            const eddyLat = smoothstep01(1.0 - absDu / (effRadius * 1.25));
            const eddyStrength = eddyLong * eddyLat * waterContact;

            if (eddyStrength > 0.12) {
              inEddy = true;
              flowSpeed *= 1.0 - 0.42 * eddyStrength;
              forwardAccel -= eddyStrength * 6.8;
              // Gentle inward eddy-line pull + soft swirl
              lateralAccel += -Math.sign(du) * eddyStrength * 2.4;
              rollPerturbation += Math.sin(time * 7.5 + behindDist) * eddyStrength * 1.1;
            }
          }
        }
      }

      // Near-miss perturbation signal (boulders, snags, or tight log skims!)
      const horizDist = Math.hypot(ds, du);
      const bodyRadius = effRadius + DUCK_CONFIG.collisionRadius;
      const nearMargin = OBSTACLE_CONFIG.nearMissMargin;

      if (isBoulderLike && y < obs.height + 0.5) {
        if (horizDist > bodyRadius * 0.85 && horizDist < bodyRadius + nearMargin) {
          const closeness =
            1.0 - clamp((horizDist - bodyRadius) / nearMargin, 0, 1);
          spookSignal = Math.max(spookSignal, 0.45 + 0.5 * closeness);
          if (horizDist < closestNearMissDist) {
            closestNearMissDist = horizDist;
            nearMissObstacle = obs;
          }
        }
      } else if (
        (obs.type === 'log_dive' || obs.type === 'log_jump') &&
        Math.abs(ds) < effRadius + 1.1 &&
        absDu < obs.width * 0.5 + 0.4
      ) {
        // Exciting close vertical skim under dive-log or over jump-log!
        const verticalClear =
          obs.type === 'log_dive'
            ? Math.abs(y - (-0.45))
            : Math.abs(y - (obs.clearanceAbove + 0.25));
        if (verticalClear < 0.72) {
          const skimSignal = 0.5 + 0.4 * (1.0 - verticalClear / 0.72);
          spookSignal = Math.max(spookSignal, skimSignal);
          if (Math.abs(ds) < closestNearMissDist) {
            closestNearMissDist = Math.abs(ds);
            nearMissObstacle = obs;
          }
        }
      }
    }

    return {
      flowSpeed,
      forwardAccel,
      lateralAccel,
      verticalAccel,
      rollPerturbation,
      pitchPerturbation,
      turbulence,
      inEddy,
      spookSignal: clamp(spookSignal, 0, 1),
      nearMissObstacle,
      surface,
      riverSample: sample,
      windLateralAccel,
      windStrength,
    };
  }

  private asExtendedSample(
    sample: ReturnType<RiverProvider['sampleAt']>,
    blendedRegion: BlendedEarthRegion,
  ): ExtendedRiverSample {
    if (
      'rapidsIntensity' in sample &&
      'waterfallPhase' in sample &&
      'regionId' in sample &&
      'speedBoost' in sample
    ) {
      return sample as ExtendedRiverSample;
    }
    const narrowness = clamp(
      (RIVER_CONFIG.baseWidth - sample.width) /
        (RIVER_CONFIG.baseWidth - RIVER_CONFIG.minWidth),
      0,
      1,
    );
    const slopeBoost = clamp((-sample.slope - 0.045) * 4.5, 0, 1);
    const regionId = sample.regionId ?? blendedRegion.primaryZone.id;
    const secondaryRegionId =
      sample.secondaryRegionId ?? blendedRegion.secondaryZone.id;
    const regionBlend = sample.regionBlend ?? blendedRegion.blend;

    return {
      ...sample,
      biomeIndex: sample.biomeIndex ?? earthWorld.getZoneIndex(regionId),
      biomeBlend: sample.biomeBlend ?? regionBlend,
      waterfallPhase: sample.isWaterfall ? 0.5 : 0,
      rapidsIntensity: clamp(
        Math.max(
          blendedRegion.riverProfile.rapidsBase * 0.72,
          narrowness * 0.65 + slopeBoost * 0.55,
        ),
        0,
        1,
      ),
      plungePoolIntensity: 0,
      waterfall: null,
      caveBranch: null,
      lat: sample.lat ?? blendedRegion.primaryZone.centerLat,
      lng: sample.lng ?? blendedRegion.primaryZone.centerLng,
      elevation: sample.elevation ?? 0,
      waterwayId:
        sample.waterwayId ??
        earthWorld.getPrimaryWaterwayForRegion(regionId).id,
      regionId,
      secondaryRegionId,
      regionBlend,
      upcomingFork: sample.upcomingFork ?? null,
      trackId: sample.trackId ?? regionId,
      nextTrackId: sample.nextTrackId ?? secondaryRegionId,
      trackBlend: sample.trackBlend ?? regionBlend,
      canyonWallFactor:
        sample.canyonWallFactor ?? blendedRegion.riverProfile.canyonWallFactor,
      caveStyle: sample.caveStyle ?? 'limestone',
      caveVisual: blendedRegion.caveStyle,
      speedBoost: 1.0,
    };
  }
}
