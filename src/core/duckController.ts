import {
  DUCK_ANIM_CONFIG,
  DUCK_CONFIG,
  MINI_EARTH_CONFIG,
  POWERUP_CONFIG,
} from '../config';
import { DEFAULT_REGION_ID } from '../earth/earthWorld';
import type {
  AudioController,
  DuckAnimState,
  DuckMode,
  DuckState,
  HydroObstacle,
  InputState,
  PowerUpType,
  Vec3,
} from '../types';
import { Hydrodynamics, type HydroForceSample } from './hydrodynamics';
import {
  RiverSpline,
  type ExtendedCaveBranchInfo,
  type ExtendedRiverSample,
} from './riverSpline';

export type DuckEventType =
  | 'jump'
  | 'dive_enter'
  | 'dive_exit'
  | 'splash'
  | 'waterfall_lip'
  | 'waterfall_land'
  | 'cave_enter'
  | 'cave_exit'
  | 'spook'
  | 'shield_break'
  | 'wing_flap'
  | 'breath_low'
  | 'bank_bounce'
  | 'crash'
  | 'track_transition'
  | 'fork_taken';

export interface DuckEvent {
  type: DuckEventType;
  /** Normalized intensity in [0, 1]. */
  intensity: number;
  worldPos: Vec3;
  /** Optional subtype / metadata (e.g. 'land' | 'waterfall' | 'skim' or obstacle type). */
  detail?: string;
}

export interface DuckUpdateResult {
  state: DuckState;
  hydro: HydroForceSample;
  events: DuckEvent[];
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function expApproach(current: number, target: number, rate: number, dt: number): number {
  const alpha = 1 - Math.exp(-Math.max(0, rate) * dt);
  return current + (target - current) * alpha;
}

function wrapAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function lerpAngle(current: number, target: number, rate: number, dt: number): number {
  const diff = wrapAngle(target - current);
  const alpha = 1 - Math.exp(-Math.max(0, rate) * dt);
  return wrapAngle(current + diff * alpha);
}

/**
 * Continuous `(s, u, y)` river-space duck physics & expressive multi-state animation controller.
 *
 * Drives all `DuckState` fields consumed by `applyDuckRigPose(rig, state)` in `src/assets/loader.ts`:
 * - Joyful kayak-like carving, buoyancy bobbing, jump (with coyote time & input buffering)
 * - Hold-to-dive underwater swimming, breath meter, Bubble Lung surge, Submerged Cave Shortcuts
 * - Wing Gust high-altitude flight & soaring glides
 * - Waterfall cliff launches & foaming plunge-pool splashes
 * - Soap-Suds Shield bouncy recovery & Spooked Asymmetric Wing-Flap Balancing
 */
export class DuckController {
  private readonly river: RiverSpline;
  private readonly hydro: Hydrodynamics;
  private audio: AudioController | null;

  private state: DuckState;
  private activeCave: ExtendedCaveBranchInfo | null = null;
  private currentRegionId: string = DEFAULT_REGION_ID;
  private currentWaterwayId: string = '';
  private lastFrameRevision = -1;

  // Timers & state trackers
  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private diveEnterTimer = 0;
  private breachPopTimer = 0;
  private spookTimer = 0;
  private spookAudioCooldown = 0;
  private breathLowCooldown = 0;
  private bankBounceCooldown = 0;
  private wingFlapAudioCooldown = 0;
  private shieldRemaining = 0;
  private forcedSurface = false;

  // Waterfall world-space ballistic arc tracker
  private waterfallWorldY = 0;
  private waterfallWorldVy = 0;
  private waterfallAirTime = 0;
  private lastWaterfallId: string | null = null;

  // Animation continuous phases & secondary spring states
  private wobblePhase = 0;
  private swimBobPhase = 0;
  private crashTimer = 0;
  private squashVelocity = 0;
  private prevWorldPos: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    river: RiverSpline,
    hydro: Hydrodynamics,
    audio: AudioController | null = null,
  ) {
    this.river = river;
    this.hydro = hydro;
    this.audio = audio;
    this.state = this.createInitialState(8);
    this.reset(8);
  }

  public setAudio(audio: AudioController | null): void {
    this.audio = audio;
  }

  public getState(): DuckState {
    return this.state;
  }

  public getActiveCave(): ExtendedCaveBranchInfo | null {
    return this.activeCave;
  }

  public getShieldRemaining(): number {
    return this.shieldRemaining;
  }

  public getCurrentTrackId(): string {
    return this.currentRegionId;
  }

  public getCurrentRegionId(): string {
    return this.currentRegionId;
  }

  public getCurrentWaterwayId(): string {
    return this.currentWaterwayId;
  }

  /** Reset duck cleanly at `startS` for a new run or title screen. */
  public reset(startS: number = 8): void {
    this.activeCave = null;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.diveEnterTimer = 0;
    this.breachPopTimer = 0;
    this.spookTimer = 0;
    this.spookAudioCooldown = 0;
    this.breathLowCooldown = 0;
    this.bankBounceCooldown = 0;
    this.wingFlapAudioCooldown = 0;
    this.shieldRemaining = 0;
    this.forcedSurface = false;
    this.waterfallWorldY = 0;
    this.waterfallWorldVy = 0;
    this.waterfallAirTime = 0;
    this.lastWaterfallId = null;
    this.wobblePhase = 0;
    this.swimBobPhase = 0;
    this.crashTimer = 0;
    this.squashVelocity = 0;

    this.state = this.createInitialState(startS);
    const startSample = this.river.sampleAt(startS);
    this.currentRegionId = startSample.regionId ?? startSample.trackId ?? DEFAULT_REGION_ID;
    this.currentWaterwayId = startSample.waterwayId ?? '';
    this.lastFrameRevision = this.river.getFrameRevision();
    this.syncWorldTransformFromSpline(startSample, 0, true);
    this.prevWorldPos = { ...this.state.worldPos };
  }

  /**
   * Gentle live animation while on the `'title'` screen: duck floats, bobs on real waves,
   * wags its tail happily, paddles softly, and looks around the sunlit creek.
   */
  public updateTitleIdle(dt: number, time: number): DuckState {
    const safeDt = clamp(dt, 0.001, 0.05);
    const sample = this.river.sampleAt(this.state.s);
    const surface = this.river.getWaterSurfaceAtRiver(this.state.s, this.state.u, time);
    const waveY = surface.height - sample.position.y;

    this.swimBobPhase += safeDt * DUCK_ANIM_CONFIG.swimBobFreq * 0.72;
    this.state.tailWagPhase += safeDt * DUCK_ANIM_CONFIG.swimTailWagFreq * 0.78;
    this.state.paddlePhase += safeDt * DUCK_ANIM_CONFIG.swimPaddleFreq * 0.62;

    // Gentle buoyant bob on the actual creek waves
    const bobExtra = Math.sin(this.swimBobPhase) * 0.045;
    this.state.u = Math.sin(time * 0.45) * 0.55;
    this.state.y = waveY + DUCK_CONFIG.floatingOffsetY + bobExtra;
    this.state.mode = 'surface';
    this.state.animState = 'swim';
    this.state.isUnderwater = false;
    this.state.submersionDepth = 0;
    this.state.speed = 0;
    this.state.turnAmount = Math.cos(time * 0.45) * 0.14;
    this.state.spookIntensity = 0;
    this.state.balanceWobble = 0;
    this.state.squashStretch = 1.0 + Math.sin(this.swimBobPhase) * 0.025;

    // Align subtly to wave normal
    const { wavePitch, waveRoll } = this.computeWavePitchRoll(sample, surface.normal);
    this.state.pitch = expApproach(
      this.state.pitch,
      wavePitch + Math.sin(this.swimBobPhase * 0.9) * 0.04,
      8,
      safeDt,
    );
    this.state.roll = expApproach(
      this.state.roll,
      waveRoll + Math.sin(time * 0.9) * 0.06,
      8,
      safeDt,
    );

    const baseYaw = Math.atan2(sample.tangent.x, sample.tangent.z);
    this.state.yaw = lerpAngle(
      this.state.yaw,
      baseYaw - this.state.turnAmount * 0.2,
      6,
      safeDt,
    );

    // Curious head gaze + tightly tucked calm-water wings
    this.state.headYaw = Math.sin(time * 0.95) * 0.28;
    this.state.headPitch = 0.07 + Math.sin(time * 1.9) * 0.05;
    this.state.wingSpread = 0.0;
    this.state.wingLeftAngle = Math.sin(this.swimBobPhase) * 0.015;
    this.state.wingRightAngle = Math.sin(this.swimBobPhase + 0.4) * 0.015;

    this.syncWorldTransformFromSpline(sample, safeDt, true);
    this.state.velocity = { x: 0, y: 0, z: 0 };
    return this.state;
  }

  /**
   * Main per-frame gameplay update step.
   */
  public update(
    dt: number,
    time: number,
    input: InputState,
    obstacles?: readonly HydroObstacle[],
  ): DuckUpdateResult {
    const safeDt = clamp(dt, 0.001, 0.05);
    const events: DuckEvent[] = [];

    // Update spline streaming window around duck
    this.river.updateWindow(this.state.s);

    // Query hydrodynamics force field at current duck coordinates
    const hydro = this.hydro.sampleForces(
      this.state.s,
      this.state.u,
      this.state.y,
      time,
      obstacles,
      this.state.speed,
    );
    const sample = hydro.riverSample;
    const waveY = hydro.surface.height - sample.position.y;

    // Decay timers
    this.spookAudioCooldown = Math.max(0, this.spookAudioCooldown - safeDt);
    this.breathLowCooldown = Math.max(0, this.breathLowCooldown - safeDt);
    this.bankBounceCooldown = Math.max(0, this.bankBounceCooldown - safeDt);
    this.wingFlapAudioCooldown = Math.max(0, this.wingFlapAudioCooldown - safeDt);
    this.diveEnterTimer = Math.max(0, this.diveEnterTimer - safeDt);
    this.breachPopTimer = Math.max(0, this.breachPopTimer - safeDt);
    this.state.invulnerableRemaining = Math.max(
      0,
      (this.state.invulnerableRemaining ?? 0) - safeDt,
    );

    // Handle crashed comical dizzy bob state
    if (this.state.isCrashed) {
      this.updateCrashedState(safeDt, time, sample, waveY);
      return { state: this.state, hydro, events };
    }

    // Power-up timers
    if (this.state.flightRemaining > 0) {
      this.state.flightRemaining = Math.max(0, this.state.flightRemaining - safeDt);
      if (this.state.flightRemaining === 0) {
        this.audio?.emit('powerup_expire', { powerUp: 'wing_gust' });
        if (this.state.mode === 'flying') {
          this.state.mode = 'airborne';
        }
      }
    }

    if (this.state.breathBoostRemaining > 0) {
      this.state.breathBoostRemaining = Math.max(
        0,
        this.state.breathBoostRemaining - safeDt,
      );
      this.state.maxBreath = DUCK_CONFIG.bubbleLungMaxBreath;
      if (this.state.breathBoostRemaining === 0) {
        this.state.maxBreath = DUCK_CONFIG.baseMaxBreath;
        this.audio?.emit('powerup_expire', { powerUp: 'bubble_lung' });
      }
    } else {
      this.state.maxBreath = DUCK_CONFIG.baseMaxBreath;
    }

    if (this.shieldRemaining > 0) {
      this.shieldRemaining = Math.max(0, this.shieldRemaining - safeDt);
      if (this.shieldRemaining === 0 && this.state.shieldActive) {
        this.state.shieldActive = false;
        this.audio?.emit('powerup_expire', { powerUp: 'soap_shield' });
      }
    }

    if (this.state.magnetRemaining > 0) {
      this.state.magnetRemaining = Math.max(0, this.state.magnetRemaining - safeDt);
      if (this.state.magnetRemaining === 0) {
        this.audio?.emit('powerup_expire', { powerUp: 'magnet' });
      }
    }

    // Hydrodynamic spook perturbations (heavy whitewater chop, waterfall lip draw, near-miss)
    if (hydro.spookSignal > 0.42 && this.state.mode !== 'flying') {
      this.triggerSpook(hydro.spookSignal, events);
    }

    // Spook timer & decay
    if (this.spookTimer > 0) {
      this.spookTimer = Math.max(0, this.spookTimer - safeDt);
    } else if (this.state.spookIntensity > 0) {
      this.state.spookIntensity = Math.max(
        0,
        this.state.spookIntensity - DUCK_ANIM_CONFIG.spookDecayRate * safeDt,
      );
    }

    // Jump input buffer & coyote time
    if (input.jumpPressed) {
      this.jumpBufferTimer = DUCK_CONFIG.jumpBufferTime;
    } else {
      this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - safeDt);
    }

    if (this.state.mode === 'surface') {
      this.coyoteTimer = DUCK_CONFIG.coyoteTime;
    } else {
      this.coyoteTimer = Math.max(0, this.coyoteTimer - safeDt);
    }

    // -------------------------------------------------------------------------
    // 1. FORWARD SPEED & PROGRESSION
    // -------------------------------------------------------------------------
    const progressT = clamp(this.state.s / DUCK_CONFIG.speedRampDistance, 0, 1);
    const progressionSpeed = lerp(
      DUCK_CONFIG.baseSpeed,
      DUCK_CONFIG.maxSpeed,
      Math.pow(progressT, 0.85),
    );
    const flowRatio = clamp(hydro.flowSpeed / DUCK_CONFIG.baseSpeed, 0.78, 1.48);

    let modeSpeedMult = 1.0;
    if (this.state.mode === 'diving') {
      modeSpeedMult =
        this.state.breathBoostRemaining > 0
          ? DUCK_CONFIG.diveSpeedMultiplier * 1.12
          : DUCK_CONFIG.diveSpeedMultiplier;
    } else if (this.state.mode === 'flying') {
      modeSpeedMult = DUCK_CONFIG.flySpeedMultiplier;
    } else if (this.state.mode === 'waterfall') {
      modeSpeedMult = 1.18;
    }

    const slopeBonus = Math.max(0, -sample.slope - 0.048) * DUCK_CONFIG.slopeGravityFactor;
    const targetSpeed = clamp(
      progressionSpeed * lerp(1.0, flowRatio, 0.58) * modeSpeedMult + slopeBonus * 0.45,
      DUCK_CONFIG.baseSpeed * 0.72,
      DUCK_CONFIG.maxSpeed * 1.42,
    );

    const speedRate = this.state.mode === 'airborne' ? 1.4 : 4.2;
    this.state.speed = expApproach(this.state.speed, targetSpeed, speedRate, safeDt);
    this.state.speed = clamp(
      this.state.speed + hydro.forwardAccel * 0.16 * safeDt,
      DUCK_CONFIG.baseSpeed * 0.65,
      DUCK_CONFIG.maxSpeed * 1.48,
    );

    // Advance downstream arc-length `s`
    const prevSampleY = sample.position.y;
    const prevS = this.state.s;
    this.state.s += this.state.speed * safeDt;

    // -------------------------------------------------------------------------
    // 2. LATERAL CARVING STEERING & CAVE / BANK CONSTRAINTS
    // -------------------------------------------------------------------------
    let latVel = this.state.lateralVelocity ?? 0;
    const steerInput = clamp(input.steer, -1, 1);

    // Support snappy mobile horizontal drag delta alongside continuous steer axis
    const deltaSteerImpulse = clamp(input.steerDelta, -0.35, 0.35) * 28.0;
    const modeMaxLat =
      this.state.mode === 'flying'
        ? DUCK_CONFIG.maxLateralSpeed * 1.18
        : this.state.mode === 'diving'
          ? DUCK_CONFIG.maxLateralSpeed * 0.96
          : DUCK_CONFIG.maxLateralSpeed;

    const targetLatAccel =
      steerInput * DUCK_CONFIG.lateralAccel +
      (this.state.mode === 'flying'
        ? (hydro.windLateralAccel ?? 0) * 0.85
        : hydro.lateralAccel);

    latVel += targetLatAccel * safeDt;
    // Crisp kayaking damping when reversing or centering
    const dampRate =
      this.state.mode === 'flying'
        ? DUCK_CONFIG.lateralDamping * 0.82
        : this.state.mode === 'diving'
          ? DUCK_CONFIG.lateralDamping * 0.88
          : DUCK_CONFIG.lateralDamping;
    latVel *= Math.exp(-dampRate * safeDt);
    latVel = clamp(latVel, -modeMaxLat, modeMaxLat);

    this.state.u += latVel * safeDt + deltaSteerImpulse;

    // Sample updated spline position at new `s`
    let newSample = this.river.sampleAt(this.state.s);

    // Live physical River Fork steering:
    // As duck approaches an upcoming 2-way fork (before the ~12–14u commit window),
    // steering LEFT (u < 0) or RIGHT (u >= 0) selects that real connected EarthWaterway!
    if (
      newSample.upcomingFork &&
      newSample.upcomingFork.distanceU >
        Math.max(12.0, MINI_EARTH_CONFIG.forkCommitDistanceU) &&
      !this.activeCave
    ) {
      const activelySteering =
        Math.abs(steerInput) > 0.12 || Math.abs(input.steerDelta) > 0.01;
      if (activelySteering || Math.abs(this.state.u) > 0.55) {
        const chosenSide: 'left' | 'right' =
          this.state.u + steerInput * 1.1 < 0 ? 'left' : 'right';
        if (this.river.getForkChoice() !== chosenSide) {
          this.river.setForkChoice(chosenSide);
          newSample = this.river.sampleAt(this.state.s);
        }
      }
    }

    const newSurface = this.river.getWaterSurfaceAtRiver(this.state.s, this.state.u, time);
    const newWaveY = newSurface.height - newSample.position.y;

    // Detect physical waterway transition (fork taken / confluence crossed)
    if (
      newSample.waterwayId &&
      this.currentWaterwayId &&
      newSample.waterwayId !== this.currentWaterwayId
    ) {
      this.currentWaterwayId = newSample.waterwayId;
      events.push({
        type: 'fork_taken',
        intensity: 1.0,
        worldPos: this.river.riverToWorld(this.state.s, this.state.u, this.state.y),
        detail: newSample.waterwayId,
      });
    } else if (newSample.waterwayId) {
      this.currentWaterwayId = newSample.waterwayId;
    }

    // Detect spatial Earth region zone transition cleanly!
    const nextRegionId = newSample.regionId ?? newSample.trackId;
    if (nextRegionId && nextRegionId !== this.currentRegionId) {
      this.currentRegionId = nextRegionId;
      events.push({
        type: 'track_transition',
        intensity: 1.0,
        worldPos: this.river.riverToWorld(this.state.s, this.state.u, this.state.y),
        detail: nextRegionId,
      });
    }

    // Check Submerged Cave Shortcut entry, guidance & exit
    this.updateCaveNavigation(prevS, newSample, input, safeDt, events);

    // Soft bank / cave-wall cushion clamping (never unfair instant death on banks!)
    latVel = this.applyLateralCorridorConstraints(newSample, latVel, safeDt, events);
    this.state.lateralVelocity = latVel;

    // Smooth responsive turnAmount [-1, 1] across ALL modes (drives carving animations!)
    const effectiveSteer = clamp(
      steerInput * 0.74 +
        (latVel / Math.max(1, modeMaxLat)) * 0.52 +
        clamp(input.steerDelta * 14, -0.6, 0.6),
      -1,
      1,
    );
    this.state.turnAmount = expApproach(this.state.turnAmount, effectiveSteer, 11.5, safeDt);

    // -------------------------------------------------------------------------
    // 3. VERTICAL PHYSICS & MODE TRANSITIONS (SURFACE / JUMP / DIVE / FLY / WATERFALL)
    // -------------------------------------------------------------------------
    let vy = this.state.verticalVelocity ?? 0;

    // Wing Gust Flight takeover
    if (this.state.flightRemaining > 0 && this.state.mode !== 'flying') {
      this.state.mode = 'flying';
      this.forcedSurface = false;
      this.state.isUnderwater = false;
      vy = Math.max(vy, 11.5);
      this.triggerSquash(1.24);
      events.push({
        type: 'wing_flap',
        intensity: 1.0,
        worldPos: { ...this.state.worldPos },
      });
      this.audio?.emit('wing_flap', { intensity: 1.0 });
    }

    // Detect waterfall cliff launch!
    const wf = newSample.waterfall;
    if (
      wf &&
      newSample.isWaterfall &&
      newSample.waterfallPhase < 0.45 &&
      this.state.mode !== 'flying' &&
      this.state.mode !== 'waterfall' &&
      !this.activeCave &&
      this.lastWaterfallId !== wf.id
    ) {
      this.enterWaterfallDrop(wf, prevSampleY, newSample, vy, events);
      vy = this.state.verticalVelocity ?? vy;
    }

    // Release forced-surface flag once player stops holding dive or refills some breath
    if (!input.diveHeld || this.state.breath > 0.35) {
      this.forcedSurface = false;
    }

    const wantsDive =
      input.diveHeld &&
      !this.forcedSurface &&
      this.state.flightRemaining <= 0 &&
      this.state.mode !== 'waterfall';

    // Handle active mode vertical dynamics
    switch (this.state.mode) {
      case 'flying': {
        // Soar high above boulders, arches & waterfalls (y ~ 6.2..7.8u), gliding down gently at end
        const glideOutT = clamp(this.state.flightRemaining / 1.35, 0, 1);
        const altitudeTarget =
          lerp(2.4, 6.45, Math.sqrt(glideOutT)) + (input.jumpHeld ? 1.25 : 0);
        const soarBob = Math.sin(time * 3.8) * 0.28;
        const desiredY = altitudeTarget + soarBob;

        const springForce =
          (desiredY - this.state.y) * DUCK_CONFIG.flightHoverStiffness -
          vy * DUCK_CONFIG.flightHoverDamping;
        vy += springForce * safeDt;
        this.state.y += vy * safeDt;
        this.state.y = Math.max(newWaveY + 0.8, this.state.y);

        // Refill breath quickly while flying in crisp mountain air!
        this.state.breath = Math.min(
          1,
          this.state.breath + DUCK_CONFIG.breathRechargeRate * safeDt,
        );

        // Emit subtle periodic airy flap audio while climbing or holding jump
        if (
          (vy > 2.2 || input.jumpHeld) &&
          this.wingFlapAudioCooldown <= 0
        ) {
          this.wingFlapAudioCooldown = 0.34;
          events.push({
            type: 'wing_flap',
            intensity: clamp(0.5 + vy * 0.08, 0.4, 1.0),
            worldPos: { ...this.state.worldPos },
          });
          this.audio?.emit('wing_flap', {
            intensity: clamp(0.5 + vy * 0.08, 0.4, 1.0),
          });
        }
        break;
      }

      case 'waterfall': {
        this.waterfallAirTime += safeDt;
        // True world-space parabolic cliff plunge!
        this.waterfallWorldVy -= DUCK_CONFIG.gravity * 0.82 * safeDt;
        this.waterfallWorldY += this.waterfallWorldVy * safeDt;
        this.state.y = this.waterfallWorldY - newSample.position.y;
        vy = this.waterfallWorldVy - this.state.speed * newSample.slope;

        // Allow subtle mid-drop flap if player holds jump
        if (input.jumpHeld && this.waterfallWorldVy < -4) {
          this.waterfallWorldVy += DUCK_CONFIG.gravity * 0.16 * safeDt;
        }

        // Splashdown into the foaming plunge pool!
        const pastCrest =
          !newSample.isWaterfall ||
          newSample.waterfallPhase > 0.62 ||
          this.waterfallAirTime > 0.42;

        if (pastCrest && this.state.y <= newWaveY + 0.18) {
          const impactIntensity = clamp(Math.abs(this.waterfallWorldVy) / 14.0, 0.65, 1.0);
          this.state.y = newWaveY - 0.52;
          vy = -4.2; // cork-like plunge dip that bounces right back up!
          this.triggerSquash(0.68);
          this.triggerSpook(0.75, events);

          events.push({
            type: 'splash',
            intensity: impactIntensity,
            worldPos: this.river.riverToWorld(this.state.s, this.state.u, newWaveY),
            detail: 'waterfall',
          });
          events.push({
            type: 'waterfall_land',
            intensity: impactIntensity,
            worldPos: this.river.riverToWorld(this.state.s, this.state.u, newWaveY),
          });
          this.audio?.emit('splash', {
            intensity: impactIntensity,
            kind: 'waterfall',
          });
          this.audio?.emit('quack', { mood: 'happy', pitch: 1.08 });

          this.state.mode = wantsDive ? 'diving' : 'surface';
        }
        break;
      }

      case 'diving': {
        const minBedY = -Math.max(1.8, newSurface.depth - DUCK_CONFIG.riverbedPadding);
        const caveCeilCap = this.getActiveCaveCeilingCap(this.state.s);

        // Breach-jump! Pressing jump while rising near the surface pops out with bonus height!
        if (this.jumpBufferTimer > 0 && this.state.y > -0.95 && caveCeilCap > 1.8) {
          this.jumpBufferTimer = 0;
          this.coyoteTimer = 0;
          vy = DUCK_CONFIG.jumpVelocity + DUCK_CONFIG.breachBonusVelocity;
          this.state.y = Math.max(this.state.y, newWaveY + 0.08);
          this.state.mode = 'airborne';
          this.breachPopTimer = 0.28;
          this.triggerSquash(1.32);
          const pos = this.river.riverToWorld(this.state.s, this.state.u, newWaveY);
          events.push({ type: 'dive_exit', intensity: 1.0, worldPos: pos });
          events.push({ type: 'jump', intensity: 1.0, worldPos: pos });
          this.audio?.emit('dive_exit', { breachPower: 1.0 });
          this.audio?.emit('jump', { charge: 1.0, fromUnderwater: true });
          break;
        }

        if (wantsDive && this.state.breath > 0) {
          // Smooth spring-guided plunge down to target cruising depth (`-1.85u`)
          const targetDepthY = Math.max(
            minBedY,
            newWaveY - DUCK_CONFIG.targetDiveDepth,
          );
          const depthErr = targetDepthY - this.state.y;
          const diveForce =
            depthErr * 24.0 - vy * 7.2 + hydro.verticalAccel * 0.25;
          vy = clamp(
            vy + diveForce * safeDt,
            -DUCK_CONFIG.maxDiveSpeed,
            DUCK_CONFIG.maxAscentSpeed * 0.65,
          );
        } else {
          // Released dive or ran out of breath -> buoyant cork ascent!
          if (this.state.breath <= 0) {
            this.forcedSurface = true;
          }
          vy = Math.min(
            DUCK_CONFIG.maxAscentSpeed,
            vy + (DUCK_CONFIG.buoyancyAccel + Math.max(0, hydro.verticalAccel) * 0.3) * safeDt,
          );
        }

        this.state.y += vy * safeDt;
        if (this.state.y < minBedY) {
          this.state.y = minBedY;
          vy = Math.max(0, vy);
        }

        // Keep under cave arch lip at cave entrances/exits
        if (this.state.y > caveCeilCap) {
          this.state.y = caveCeilCap;
          vy = Math.min(0, vy);
        }

        // Consume breath while submerged
        if (this.state.y < newWaveY - 0.14) {
          this.state.breath = Math.max(
            0,
            this.state.breath - safeDt / Math.max(1.0, this.state.maxBreath),
          );
          if (
            this.state.breath <= DUCK_CONFIG.lowBreathThreshold &&
            this.state.breath > 0 &&
            this.breathLowCooldown <= 0
          ) {
            this.breathLowCooldown = 0.72;
            events.push({
              type: 'breath_low',
              intensity: 1.0 - this.state.breath / DUCK_CONFIG.lowBreathThreshold,
              worldPos: { ...this.state.worldPos },
            });
            this.audio?.emit('breath_low', { breath: this.state.breath });
          }
        }

        // Surface breach transition when rising back above waterline!
        if (!wantsDive && this.state.y >= newWaveY - 0.04) {
          const breachPower = clamp(vy / DUCK_CONFIG.maxAscentSpeed, 0.25, 1.0);
          this.breachPopTimer = 0.34;
          const pos = this.river.riverToWorld(this.state.s, this.state.u, newWaveY);
          events.push({ type: 'dive_exit', intensity: breachPower, worldPos: pos });
          this.audio?.emit('dive_exit', { breachPower });

          if (vy > 5.8 && caveCeilCap > 1.6) {
            // Playful little buoyant pop just out of the water!
            vy = Math.min(vy * 0.52, 5.2);
            this.state.mode = 'airborne';
            this.triggerSquash(1.18);
          } else {
            this.state.mode = 'surface';
            vy *= 0.35;
            this.triggerSquash(1.12);
          }
        }
        break;
      }

      case 'airborne': {
        const caveCeilCap = this.getActiveCaveCeilingCap(this.state.s);

        // Allow coyote jump right after leaving surface/crest
        if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0) {
          this.performSurfaceJump(newWaveY, events);
          vy = this.state.verticalVelocity ?? DUCK_CONFIG.jumpVelocity;
        }

        // Holding dive mid-air initiates an energetic fast plunge-dive straight underwater!
        if (wantsDive && input.diveJustPressed && this.state.y < 3.5) {
          vy = Math.min(vy, -7.8);
          this.diveEnterTimer = 0.26;
        }

        // Lighter gravity near jump apex while holding jump for joyful forgiving arcs
        const nearApex = Math.abs(vy) < 3.4 && input.jumpHeld;
        const gravScale = nearApex ? DUCK_CONFIG.apexHoldGravityFactor : 1.0;
        vy -= DUCK_CONFIG.gravity * gravScale * safeDt;
        this.state.y += vy * safeDt;

        if (this.state.y > caveCeilCap) {
          this.state.y = caveCeilCap;
          vy = Math.min(0, vy);
        }

        // Breath recharges in the air
        this.state.breath = Math.min(
          1,
          this.state.breath + DUCK_CONFIG.breathRechargeRate * safeDt,
        );

        // Splashdown back into the river!
        if (this.state.y <= newWaveY + 0.04) {
          const impactSpeed = Math.abs(vy);
          const splashIntensity = clamp(impactSpeed / 12.0, 0.25, 1.0);
          const pos = this.river.riverToWorld(this.state.s, this.state.u, newWaveY);

          if (wantsDive && this.state.breath > 0.08) {
            this.state.mode = 'diving';
            this.diveEnterTimer = 0.26;
            vy = Math.min(vy * 0.72, -6.2);
            this.triggerSquash(1.16);
            events.push({ type: 'dive_enter', intensity: splashIntensity, worldPos: pos });
            this.audio?.emit('dive_enter', { speed: impactSpeed });
          } else {
            this.state.mode = 'surface';
            this.state.y = newWaveY - clamp(impactSpeed * 0.028, 0.05, 0.34);
            vy = -impactSpeed * 0.28;
            this.triggerSquash(lerp(0.92, 0.74, splashIntensity));
            events.push({
              type: 'splash',
              intensity: splashIntensity,
              worldPos: pos,
              detail: 'land',
            });
            this.audio?.emit('splash', { intensity: splashIntensity, kind: 'land' });
          }
        }
        break;
      }

      case 'surface': {
        // Trigger dive immediately when holding dive
        if (wantsDive && this.state.breath > 0.1) {
          this.state.mode = 'diving';
          this.diveEnterTimer = 0.26;
          vy = Math.min(vy, -5.8);
          this.triggerSquash(1.15);
          const pos = this.river.riverToWorld(this.state.s, this.state.u, newWaveY);
          events.push({ type: 'dive_enter', intensity: 0.75, worldPos: pos });
          this.audio?.emit('dive_enter', { speed: this.state.speed });
          break;
        }

        // Trigger jump cleanly (supports jump buffer!)
        if (this.jumpBufferTimer > 0) {
          const caveCeilCap = this.getActiveCaveCeilingCap(this.state.s);
          if (caveCeilCap > 1.8) {
            this.performSurfaceJump(newWaveY, events);
            vy = this.state.verticalVelocity ?? DUCK_CONFIG.jumpVelocity;
            break;
          }
        }

        // Buoyancy spring-damper riding real analytical river waves!
        const targetY = newWaveY + DUCK_CONFIG.floatingOffsetY;
        const springAccel =
          (targetY - this.state.y) * DUCK_CONFIG.surfaceSpringK -
          vy * DUCK_CONFIG.surfaceSpringDamping +
          hydro.verticalAccel * 0.45;
        vy += springAccel * safeDt;
        this.state.y += vy * safeDt;

        // Prevent surface buoyancy from accidentally dunking duck deep below waterline
        if (this.state.y < newWaveY - 0.55) {
          this.state.y = newWaveY - 0.55;
          vy = Math.max(vy, 2.2);
        }

        // Recharge breath smoothly on the surface
        this.state.breath = Math.min(
          1,
          this.state.breath + DUCK_CONFIG.breathRechargeRate * safeDt,
        );
        break;
      }
    }

    this.state.verticalVelocity = vy;

    // Submersion state
    const submersion = Math.max(0, newWaveY - this.state.y);
    this.state.isUnderwater = submersion > 0.22;
    this.state.submersionDepth = submersion;

    // -------------------------------------------------------------------------
    // 4. SQUASH & STRETCH SPRING + EXPRESSIVE MULTI-STATE ANIMATIONS
    // -------------------------------------------------------------------------
    this.updateSquashSpring(safeDt);
    this.updateExpressiveAnimations(safeDt, time, newSample, hydro, input);

    // -------------------------------------------------------------------------
    // 5. WORLD POSITION & VELOCITY SYNC (Floating-Origin Recenter Safe)
    // -------------------------------------------------------------------------
    const curFrameRev = this.river.getFrameRevision();
    const frameRecentered = curFrameRev !== this.lastFrameRevision;
    this.lastFrameRevision = curFrameRev;
    this.syncWorldTransformFromSpline(newSample, safeDt, frameRecentered);

    return { state: this.state, hydro, events };
  }

  /** Activate a collected power-up immediately with tactile duck feedback. */
  public activatePowerUp(type: PowerUpType): void {
    const cfg = POWERUP_CONFIG[type];
    switch (type) {
      case 'wing_gust':
        this.state.flightRemaining = cfg.duration;
        this.state.mode = 'flying';
        this.state.verticalVelocity = Math.max(this.state.verticalVelocity ?? 0, 11.8);
        this.forcedSurface = false;
        this.triggerSquash(1.25);
        this.audio?.emit('quack', { mood: 'happy', pitch: 1.18 });
        break;

      case 'bubble_lung':
        this.state.breathBoostRemaining = cfg.duration;
        this.state.maxBreath = DUCK_CONFIG.bubbleLungMaxBreath;
        this.state.breath = 1.0;
        this.forcedSurface = false;
        break;

      case 'soap_shield':
        this.state.shieldActive = true;
        this.shieldRemaining = cfg.duration;
        break;

      case 'magnet':
        this.state.magnetRemaining = cfg.duration;
        break;
    }
  }

  /**
   * Resolve a gameplay obstacle impact reported by `ObstacleSpawner` / `game.ts`.
   * - If Soap-Suds Shield is active: absorbs impact with bouncy knockback + spook recovery + squeak!
   * - Otherwise: enters comical dizzy `'crash'` animation!
   */
  public handleObstacleCollision(
    obstacle: HydroObstacle,
  ): 'shield_absorbed' | 'crashed' | 'ignored' {
    if (this.state.isCrashed) return 'ignored';
    if ((this.state.invulnerableRemaining ?? 0) > 0) return 'ignored';

    if (this.state.shieldActive) {
      this.state.shieldActive = false;
      this.shieldRemaining = 0;
      this.state.invulnerableRemaining = DUCK_CONFIG.shieldBreakInvulnerability;

      // Bouncy playful deflection away from the obstacle!
      const pushDir = this.state.u >= obstacle.u ? 1 : -1;
      this.state.lateralVelocity = pushDir * 10.5;
      this.state.u += pushDir * 0.65;
      this.state.verticalVelocity = Math.max(this.state.verticalVelocity ?? 0, 6.4);
      if (this.state.mode === 'surface' || this.state.mode === 'diving') {
        this.state.mode = 'airborne';
      }
      this.triggerSquash(0.72);
      this.triggerSpook(1.0);
      this.audio?.emit('shield_break');
      this.audio?.emit('quack', { mood: 'startled', pitch: 1.24 });
      return 'shield_absorbed';
    }

    // Fatal bonk -> comical dizzy rubber-duck bob
    this.state.isCrashed = true;
    this.state.animState = 'crash';
    this.crashTimer = 0;
    this.state.speed = 0;
    this.state.lateralVelocity = (this.state.u >= obstacle.u ? 1 : -1) * 3.2;
    this.state.verticalVelocity = 3.8;
    this.triggerSquash(0.66);
    this.audio?.emit('crash', { obstacleType: obstacle.type });
    this.audio?.emit('quack', { mood: 'bonk', pitch: 0.85 });
    return 'crashed';
  }

  /**
   * Trigger the expressive **Spooked Balancing** animation (frantic asymmetric wing flaps,
   * off-kilter roll wobble, startled head wobble, and micro-squeak!).
   * Called automatically on heavy rapids jolts, waterfall lips, bank bounces, shield breaks,
   * and externally by `world-gameplay` on near-miss bonuses!
   */
  public triggerSpook(intensity: number = 0.85, outEvents?: DuckEvent[]): void {
    const clamped = clamp(intensity, 0.3, 1.0);
    this.state.spookIntensity = Math.max(this.state.spookIntensity, clamped);
    this.spookTimer = Math.max(
      this.spookTimer,
      DUCK_ANIM_CONFIG.spookDuration * (0.65 + 0.35 * clamped),
    );
    // Crisp startled wing-pop on frame 1 so near-misses & jolts read instantly!
    this.state.wingSpread = Math.max(this.state.wingSpread, 0.62 * clamped);

    if (this.spookAudioCooldown <= 0 && clamped >= 0.48) {
      this.spookAudioCooldown = 0.7;
      this.audio?.emit('spook_balance', { intensity: clamped });
      if (clamped >= 0.72) {
        this.audio?.emit('quack', { mood: 'spooked', pitch: 1.15 + clamped * 0.15 });
      }
      outEvents?.push({
        type: 'spook',
        intensity: clamped,
        worldPos: { ...this.state.worldPos },
      });
    }
  }

  /** Bouncy hop when skimming onto a springy lily pad. */
  public triggerBouncePad(boostY: number = 10.6, boostSpeed: number = 2.6): void {
    if (this.state.isCrashed || this.state.mode === 'flying') return;
    this.state.mode = 'airborne';
    this.state.verticalVelocity = Math.max(this.state.verticalVelocity ?? 0, boostY);
    this.state.speed = Math.min(DUCK_CONFIG.maxSpeed * 1.35, this.state.speed + boostSpeed);
    this.triggerSquash(1.28);
    this.audio?.emit('jump', { charge: 0.9, fromUnderwater: false });
    this.audio?.emit('quack', { mood: 'happy', pitch: 1.16 });
  }

  /**
   * Clean QA/showcase teleport helper (used by `window.__riverDucker` showcase modes
   * to jump directly to waterfalls, caves, diving, flying, or spooked states).
   */
  public teleportTo(
    s: number,
    u: number = 0,
    y: number = 0,
    mode?: DuckMode,
  ): void {
    this.river.updateWindow(s);
    this.state.s = Math.max(0, s);
    this.state.u = u;
    this.state.y = y;
    this.state.isCrashed = false;
    this.state.lateralVelocity = 0;
    this.state.verticalVelocity = 0;
    this.lastWaterfallId = null;

    if (mode) {
      this.state.mode = mode;
      if (mode === 'flying' && this.state.flightRemaining < 2) {
        this.state.flightRemaining = POWERUP_CONFIG.wing_gust.duration;
      }
    } else {
      this.state.mode = y < -0.25 ? 'diving' : y > 0.6 ? 'airborne' : 'surface';
    }

    this.activeCave = this.river.isInsideCave(this.state.s, this.state.u);
    this.state.inCave = this.activeCave !== null;
    this.state.isUnderwater = y < -0.22;
    this.state.submersionDepth = Math.max(0, -y);

    const sample = this.river.sampleAt(this.state.s);
    this.currentRegionId = sample.regionId ?? sample.trackId ?? DEFAULT_REGION_ID;
    this.currentWaterwayId = sample.waterwayId ?? '';
    this.lastFrameRevision = this.river.getFrameRevision();
    this.syncWorldTransformFromSpline(sample, 0.016, true);
    this.prevWorldPos = { ...this.state.worldPos };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private createInitialState(startS: number): DuckState {
    return {
      s: startS,
      u: 0,
      y: DUCK_CONFIG.floatingOffsetY,
      worldPos: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: -DUCK_CONFIG.baseSpeed },
      pitch: 0,
      roll: 0,
      yaw: Math.PI,
      mode: 'surface',
      animState: 'swim',
      breath: 1.0,
      maxBreath: DUCK_CONFIG.baseMaxBreath,
      isUnderwater: false,
      submersionDepth: 0,
      wingFlapPhase: 0,
      squashStretch: 1.0,
      turnAmount: 0,
      spookIntensity: 0,
      wingLeftAngle: 0,
      wingRightAngle: 0,
      wingSpread: 0.0,
      paddlePhase: 0,
      headYaw: 0,
      headPitch: 0.05,
      balanceWobble: 0,
      tailWagPhase: 0,
      shieldActive: false,
      flightRemaining: 0,
      breathBoostRemaining: 0,
      magnetRemaining: 0,
      speed: DUCK_CONFIG.baseSpeed,
      isCrashed: false,
      lateralVelocity: 0,
      verticalVelocity: 0,
      inCave: false,
      invulnerableRemaining: 0,
    };
  }

  private performSurfaceJump(waveY: number, events: DuckEvent[]): void {
    this.jumpBufferTimer = 0;
    this.coyoteTimer = 0;
    this.state.mode = 'airborne';
    this.state.y = Math.max(this.state.y, waveY + 0.05);
    this.state.verticalVelocity = DUCK_CONFIG.jumpVelocity;
    this.triggerSquash(1.28);

    const pos = this.river.riverToWorld(this.state.s, this.state.u, waveY);
    events.push({ type: 'jump', intensity: 0.9, worldPos: pos });
    this.audio?.emit('jump', { charge: 0.85, fromUnderwater: false });
    this.audio?.emit('quack', { mood: 'happy', pitch: 1.06 });
  }

  private enterWaterfallDrop(
    wf: NonNullable<ExtendedRiverSample['waterfall']>,
    prevSampleY: number,
    newSample: ExtendedRiverSample,
    currentVy: number,
    events: DuckEvent[],
  ): void {
    this.lastWaterfallId = wf.id;
    this.state.mode = 'waterfall';
    this.waterfallAirTime = 0;
    this.waterfallWorldY = prevSampleY + Math.max(this.state.y, 0.1);
    // Crisp energetic launch out over the waterfall lip!
    this.waterfallWorldVy = Math.max(1.8, currentVy * 0.6 + 2.4);
    this.state.verticalVelocity = this.waterfallWorldVy;
    this.triggerSquash(1.22);
    this.triggerSpook(0.95, events);

    const lipPos = this.river.riverToWorld(this.state.s, this.state.u, this.state.y);
    events.push({
      type: 'waterfall_lip',
      intensity: clamp(wf.dropHeight / 14.5, 0.6, 1.0),
      worldPos: lipPos,
      detail: wf.id,
    });
    this.audio?.emit('waterfall_drop', { dropHeight: wf.dropHeight });
    this.audio?.emit('quack', { mood: 'startled', pitch: 1.25 });

    // Recompute relative y right away
    this.state.y = this.waterfallWorldY - newSample.position.y;
  }

  private updateCaveNavigation(
    prevS: number,
    sample: ExtendedRiverSample,
    input: InputState,
    dt: number,
    events: DuckEvent[],
  ): void {
    if (!this.activeCave) {
      // Check if entering a Submerged Cave Shortcut mouth!
      const candidate = sample.caveBranch;
      if (
        candidate &&
        this.state.mode !== 'flying' &&
        this.state.s >= candidate.startS - 3 &&
        this.state.s <= candidate.startS + 16
      ) {
        const halfW = sample.width * 0.5;
        const nearEntranceBank = this.state.u * candidate.side >= halfW - 3.0;
        const insidePortalMouth = this.state.u * candidate.side >= halfW - 0.65;
        const duckingUnderArch =
          this.state.isUnderwater ||
          this.state.mode === 'diving' ||
          input.diveHeld ||
          this.state.y < -0.12;

        if ((nearEntranceBank && duckingUnderArch) || insidePortalMouth) {
          this.activeCave = candidate;
          this.state.inCave = true;
          if (duckingUnderArch) {
            // Smoothly tuck beneath the mossy entrance archway while diving
            this.state.y = Math.min(this.state.y, -0.45);
            this.state.mode = 'diving';
          }
          // Refresh a generous sip of cave air so players can enjoy the grotto shortcut
          this.state.breath = Math.max(this.state.breath, 0.78);
          events.push({
            type: 'cave_enter',
            intensity: 1.0,
            worldPos: { ...this.state.worldPos },
            detail: candidate.id,
          });
          this.audio?.emit('cave_transition', { entering: true });
        }
      }
      return;
    }

    // Currently inside a curving Submerged Cave Shortcut!
    const cave = this.activeCave;
    if (this.state.s >= cave.endS) {
      // Shoot back out into the main river (or burst straight out of a waterfall cliff face!)
      this.activeCave = null;
      this.state.inCave = false;
      this.state.speed = Math.min(DUCK_CONFIG.maxSpeed * 1.38, this.state.speed + 4.5);

      // Push gently back toward main channel center
      const exitLatPush = -cave.side * 6.5;
      this.state.lateralVelocity = (this.state.lateralVelocity ?? 0) * 0.35 + exitLatPush;

      const exitPos = this.river.riverToWorld(this.state.s, this.state.u, this.state.y);
      events.push({
        type: 'cave_exit',
        intensity: 1.0,
        worldPos: exitPos,
        detail: cave.exitsIntoWaterfall ? 'waterfall_burst' : cave.id,
      });
      this.audio?.emit('cave_transition', { entering: false });

      // Bonus spectacle: cave bursting out of a waterfall cliff face!
      if (cave.exitsIntoWaterfall && sample.waterfall) {
        this.state.u = cave.side * (sample.width * 0.34);
        this.enterWaterfallDrop(
          sample.waterfall,
          sample.position.y,
          sample,
          3.2,
          events,
        );
      }
      return;
    }

    // Smoothly carry duck along the curving tunnel centerline while keeping steering responsive!
    const prevCenter = this.river.getCaveCenterU(cave, prevS);
    const currCenter = this.river.getCaveCenterU(cave, this.state.s);
    const tunnelShift = currCenter - prevCenter;
    this.state.u += tunnelShift;

    // Gentle centering guidance right at entrance & exit transitions
    const t = clamp(
      (this.state.s - cave.startS) / Math.max(1, cave.endS - cave.startS),
      0,
      1,
    );
    if (t < 0.12 || t > 0.88) {
      this.state.u = expApproach(this.state.u, currCenter, 3.2, dt);
    }
  }

  private getActiveCaveCeilingCap(s: number): number {
    if (!this.activeCave) return 999;
    const ceilingY = this.river.getCaveCeilingY(this.activeCave, s);
    return ceilingY - 0.72;
  }

  private applyLateralCorridorConstraints(
    sample: ExtendedRiverSample,
    latVel: number,
    dt: number,
    events: DuckEvent[],
  ): number {
    let minU: number;
    let maxU: number;

    if (this.activeCave) {
      const centerU = this.river.getCaveCenterU(this.activeCave, this.state.s);
      const halfCave = this.activeCave.width * 0.5 - 0.62;
      minU = centerU - halfCave;
      maxU = centerU + halfCave;
    } else {
      const halfW = sample.width * 0.5 - DUCK_CONFIG.bankPadding;
      minU = -halfW;
      maxU = halfW;

      // Open a wider bank mouth near a Submerged Cave Shortcut entrance so player can slip in cleanly
      const cave = sample.caveBranch;
      if (
        cave &&
        this.state.s >= cave.startS - 6 &&
        this.state.s <= cave.startS + 16 &&
        this.state.mode !== 'flying'
      ) {
        if (cave.side > 0) {
          maxU += 2.6;
        } else {
          minU -= 2.6;
        }
      }
    }

    // Soft elastic water-cushion zone near walls (0.85u before hard boundary)
    const cushionMargin = 0.85;
    let nextVel = latVel;

    if (this.state.u < minU + cushionMargin) {
      const pen = clamp((minU + cushionMargin - this.state.u) / cushionMargin, 0, 1);
      nextVel += pen * 22.0 * dt;
    } else if (this.state.u > maxU - cushionMargin) {
      const pen = clamp((this.state.u - (maxU - cushionMargin)) / cushionMargin, 0, 1);
      nextVel -= pen * 22.0 * dt;
    }

    // Hard cushioned bounce at corridor wall (never crashes unfairly!)
    if (this.state.u < minU) {
      const impact = Math.abs(nextVel);
      this.state.u = minU;
      nextVel = Math.max(1.8, impact * 0.42);
      if (impact > 4.2 && this.bankBounceCooldown <= 0) {
        this.bankBounceCooldown = 0.45;
        this.triggerSpook(clamp(impact / 14, 0.38, 0.72), events);
        this.triggerSquash(0.86);
        events.push({
          type: 'bank_bounce',
          intensity: clamp(impact / 12, 0.3, 0.9),
          worldPos: { ...this.state.worldPos },
        });
      }
    } else if (this.state.u > maxU) {
      const impact = Math.abs(nextVel);
      this.state.u = maxU;
      nextVel = -Math.max(1.8, impact * 0.42);
      if (impact > 4.2 && this.bankBounceCooldown <= 0) {
        this.bankBounceCooldown = 0.45;
        this.triggerSpook(clamp(impact / 14, 0.38, 0.72), events);
        this.triggerSquash(0.86);
        events.push({
          type: 'bank_bounce',
          intensity: clamp(impact / 12, 0.3, 0.9),
          worldPos: { ...this.state.worldPos },
        });
      }
    }

    return nextVel;
  }

  private triggerSquash(targetScaleY: number): void {
    this.state.squashStretch = clamp(targetScaleY, 0.66, 1.38);
    this.squashVelocity = 0;
  }

  private updateSquashSpring(dt: number): void {
    const k = 115.0;
    const damp = 14.5;
    const accel = (1.0 - this.state.squashStretch) * k - this.squashVelocity * damp;
    this.squashVelocity += accel * dt;
    this.state.squashStretch = clamp(
      this.state.squashStretch + this.squashVelocity * dt,
      0.66,
      1.42,
    );
  }

  private computeWavePitchRoll(
    sample: ExtendedRiverSample,
    normal: Vec3,
  ): { wavePitch: number; waveRoll: number } {
    // Project surface normal onto horizontal downstream tangent & right
    const hLen = Math.hypot(sample.tangent.x, sample.tangent.z) || 1.0;
    const htx = sample.tangent.x / hLen;
    const htz = sample.tangent.z / hLen;

    // Normal tilted backward (against tangent) means wave faces upstream -> nose UP (+pitch)
    const nDotTan = normal.x * htx + normal.z * htz;
    // Normal tilted right (+right) means surface slopes down to right -> bank RIGHT (+roll)
    const nDotRight = normal.x * sample.right.x + normal.z * sample.right.z;

    const wavePitch = clamp(-Math.asin(clamp(nDotTan, -0.75, 0.75)), -0.55, 0.55);
    const waveRoll = clamp(Math.asin(clamp(nDotRight, -0.7, 0.7)), -0.45, 0.45);
    return { wavePitch, waveRoll };
  }

  /**
   * Populate EVERY animation channel on `DuckState` so `applyDuckRigPose(rig, state)`
   * renders unmistakable, lively, personality-filled duck motion across all modes!
   */
  private updateExpressiveAnimations(
    dt: number,
    time: number,
    sample: ExtendedRiverSample,
    hydro: HydroForceSample,
    input: InputState,
  ): void {
    const turn = this.state.turnAmount;
    const absTurn = Math.abs(turn);
    const vy = this.state.verticalVelocity ?? 0;
    const spook = this.state.spookIntensity;

    // Advance base animation phases
    this.swimBobPhase += dt * (DUCK_ANIM_CONFIG.swimBobFreq + this.state.speed * 0.1);
    this.state.tailWagPhase +=
      dt * (DUCK_ANIM_CONFIG.swimTailWagFreq + this.state.speed * 0.14);
    this.wobblePhase += dt * DUCK_ANIM_CONFIG.spookWobbleFreq;

    // Resolve primary expressive animState
    let animState: DuckAnimState = 'swim';
    if (this.state.mode === 'flying') {
      animState = 'fly';
    } else if (this.state.mode === 'waterfall') {
      animState = 'waterfall_drop';
    } else if (this.state.mode === 'diving') {
      animState = this.diveEnterTimer > 0 ? 'dive_enter' : 'dive_swim';
    } else if (this.state.mode === 'airborne') {
      animState = spook > 0.48 ? 'spooked' : 'jump';
    } else {
      animState = spook > 0.25 ? 'spooked' : 'swim';
    }
    this.state.animState = animState;

    const { wavePitch, waveRoll } = this.computeWavePitchRoll(
      sample,
      hydro.surface.normal,
    );
    const baseSplineYaw = Math.atan2(sample.tangent.x, sample.tangent.z);

    let targetPitch = 0;
    let targetRoll = 0;
    let yawLeadFactor: number = DUCK_ANIM_CONFIG.turnYawLead;
    let targetWingSpread = 0.0;
    let targetWingLeft = 0;
    let targetWingRight = 0;
    let targetHeadYaw = -turn * 0.32;
    let targetHeadPitch = 0.05;
    let targetBalanceWobble = 0;

    switch (animState) {
      case 'swim': {
        // Rhythmic buoyant bob, happy tail wag, gentle paddling, kayak carving bank & wing counter-balance!
        this.state.paddlePhase +=
          dt * (DUCK_ANIM_CONFIG.swimPaddleFreq + this.state.speed * 0.24 + absTurn * 4.0);
        this.state.wingFlapPhase += dt * 5.2;

        const bobPitch = Math.sin(this.swimBobPhase) * 0.055;
        const breachTilt = this.breachPopTimer > 0 ? this.breachPopTimer * 1.15 : 0;
        targetPitch = clamp(
          wavePitch * 0.72 + bobPitch + breachTilt + hydro.pitchPerturbation * 0.03,
          -0.48,
          0.55,
        );
        targetRoll = clamp(
          waveRoll * 0.55 +
            turn * DUCK_ANIM_CONFIG.turnBankSurface +
            hydro.rollPerturbation * 0.04,
          -0.65,
          0.65,
        );

        // Keep wings sleekly tucked (0.0) during calm straight swimming; flare outward to
        // counter-balance only on deliberate kayak carving turns!
        const carveFactor = clamp((absTurn - 0.18) / 0.82, 0, 1);
        targetWingSpread = carveFactor * 0.48;
        const idleFlutter = Math.sin(this.state.wingFlapPhase) * 0.015;
        // Turning RIGHT (+turn): inner right wing dips, outer left wing lifts for balance!
        targetWingLeft = idleFlutter + turn * 0.44 * carveFactor;
        targetWingRight = -idleFlutter - turn * 0.44 * carveFactor;

        // Curious natural look into turns + subtle creek scan
        targetHeadYaw = -turn * 0.36 + Math.sin(time * 1.45) * 0.09;
        targetHeadPitch = 0.06 + Math.sin(time * 2.5) * 0.04;
        break;
      }

      case 'spooked': {
        // Startled off-kilter wobble + FRANTIC ASYMMETRIC balancing wing flaps!
        this.state.paddlePhase += dt * 18.5;
        this.state.wingFlapPhase += dt * DUCK_ANIM_CONFIG.spookFlapFreq;

        const wobble =
          Math.sin(this.wobblePhase) * DUCK_ANIM_CONFIG.spookMaxWobbleRad * spook;
        targetBalanceWobble = wobble;

        targetPitch = clamp(
          wavePitch * 0.5 + 0.14 * spook + Math.cos(this.wobblePhase * 0.85) * 0.14 * spook,
          -0.45,
          0.52,
        );
        targetRoll =
          turn *
            (this.state.mode === 'airborne'
              ? DUCK_ANIM_CONFIG.turnBankAir
              : DUCK_ANIM_CONFIG.turnBankSurface) +
          waveRoll * 0.35;

        // Splay wings wide and flail left & right asymmetrically trying to regain balance!
        targetWingSpread = lerp(0.32, 0.96, spook);
        const leftFlail = Math.sin(this.state.wingFlapPhase) * 0.82 * spook;
        const rightFlail = Math.sin(this.state.wingFlapPhase + 2.35) * 0.82 * spook;
        targetWingLeft = 0.24 + leftFlail + wobble * 0.55 + turn * 0.2;
        targetWingRight = 0.24 + rightFlail - wobble * 0.55 - turn * 0.2;

        // Startled head snap & chin pop
        targetHeadYaw = -turn * 0.26 + Math.sin(this.wobblePhase * 1.25) * 0.38 * spook;
        targetHeadPitch = 0.22 * spook + Math.cos(this.wobblePhase * 1.4) * 0.14 * spook;
        break;
      }

      case 'dive_enter':
      case 'dive_swim': {
        // Sleek hydrodynamic underwater swimming: rapid alternating webbed-foot kicks + barrel-bank turns!
        this.state.paddlePhase +=
          dt * (DUCK_ANIM_CONFIG.divePaddleFreq + absTurn * 5.5 + (this.state.breathBoostRemaining > 0 ? 4.0 : 0));
        this.state.wingFlapPhase += dt * 9.0;

        if (animState === 'dive_enter') {
          targetPitch = DUCK_ANIM_CONFIG.diveEnterPitch;
        } else if (!input.diveHeld || this.forcedSurface) {
          // Joyful nose-up buoyant breach climb toward surface!
          targetPitch = clamp(
            lerp(0.18, DUCK_ANIM_CONFIG.breachPopPitch, clamp(vy / 8.0, 0, 1)),
            -0.3,
            0.62,
          );
        } else {
          targetPitch = clamp(
            DUCK_ANIM_CONFIG.diveCruisePitch + vy * 0.055,
            -0.68,
            0.42,
          );
        }

        // Sleek underwater barrel-bank into turns!
        targetRoll = turn * DUCK_ANIM_CONFIG.turnBankDive;
        yawLeadFactor = DUCK_ANIM_CONFIG.turnYawLead * 1.2;

        // Tightly tucked hydrodynamic wings underwater (barely flex on sharp barrel-bank turns)
        const diveCarve = clamp((absTurn - 0.25) / 0.75, 0, 1);
        targetWingSpread = diveCarve * 0.06;
        targetWingLeft = turn * 0.16 * diveCarve;
        targetWingRight = -turn * 0.16 * diveCarve;

        targetHeadYaw = -turn * 0.3;
        targetHeadPitch = clamp(targetPitch * 0.35, -0.25, 0.25);

        // If startled underwater (e.g. close brush under a root), subtle wobble
        if (spook > 0.25) {
          targetBalanceWobble = Math.sin(this.wobblePhase) * 0.22 * spook;
          targetWingSpread = Math.max(targetWingSpread, 0.45 * spook);
        }
        break;
      }

      case 'fly': {
        // Wing Gust Flight: wide spread wings, energetic flapping on climb & rhythmic soaring glides + airplane bank!
        const climbing = vy > 0.8 || input.jumpHeld || this.state.flightRemaining > POWERUP_CONFIG.wing_gust.duration - 0.85;
        const flapSpeed = climbing ? DUCK_ANIM_CONFIG.flyFlapFreq : 7.4;
        this.state.wingFlapPhase += dt * flapSpeed;
        this.state.paddlePhase += dt * 4.0;

        const glideOut = this.state.flightRemaining < 1.2;
        targetPitch = glideOut
          ? -0.18
          : clamp(0.08 + vy * 0.045, -0.22, 0.34);

        // Dramatic airplane wing-bank roll into turns!
        targetRoll = turn * DUCK_ANIM_CONFIG.turnBankFly;
        yawLeadFactor = DUCK_ANIM_CONFIG.turnYawLead * 1.3;

        targetWingSpread = 1.0;
        // Rhythmic energetic flaps during climb, alternating with serene wide soaring glides!
        const soarWave = Math.sin(this.state.wingFlapPhase);
        const flapAmp = climbing
          ? DUCK_ANIM_CONFIG.flyFlapAmplitude
          : 0.28 + 0.22 * Math.max(0, Math.sin(time * 2.1));
        const baseFlap = soarWave * flapAmp + (climbing ? 0.12 : 0.18);
        // Outer wing pumps slightly higher in banked turns
        targetWingLeft = baseFlap + turn * 0.22;
        targetWingRight = baseFlap - turn * 0.22;

        targetHeadYaw = -turn * 0.42;
        targetHeadPitch = glideOut ? -0.08 : 0.14;
        break;
      }

      case 'jump': {
        // Energetic hop arc + mid-air twist/tilt & joyful flap!
        this.state.wingFlapPhase += dt * 17.5;
        this.state.paddlePhase += dt * 13.0;

        targetPitch = clamp(vy * 0.048, -0.42, 0.54);
        targetRoll = turn * DUCK_ANIM_CONFIG.turnBankAir;
        yawLeadFactor = DUCK_ANIM_CONFIG.turnYawLead * 1.15;

        targetWingSpread = 0.68;
        const hopFlap = Math.sin(this.state.wingFlapPhase) * 0.56 + 0.16;
        targetWingLeft = hopFlap + turn * 0.24;
        targetWingRight = hopFlap - turn * 0.24;

        targetHeadYaw = -turn * 0.34;
        targetHeadPitch = clamp(vy * 0.025, -0.18, 0.24);
        break;
      }

      case 'waterfall_drop': {
        // Dramatic forward cliff pitch + panicked fast asymmetric wing flailing!
        this.state.wingFlapPhase += dt * 29.0;
        this.state.paddlePhase += dt * 22.0;

        const fallPitch = clamp(this.waterfallWorldVy * 0.045 - 0.15, -0.68, 0.24);
        targetPitch = fallPitch;
        targetRoll = turn * DUCK_ANIM_CONFIG.turnBankAir * 1.15;
        targetBalanceWobble = Math.sin(this.wobblePhase * 1.15) * 0.32;

        targetWingSpread = 1.0;
        targetWingLeft = 0.34 + Math.sin(this.state.wingFlapPhase) * 0.88;
        targetWingRight = 0.34 + Math.sin(this.state.wingFlapPhase + 2.4) * 0.88;

        targetHeadYaw = -turn * 0.24 + Math.sin(this.wobblePhase) * 0.22;
        targetHeadPitch = 0.28;
        break;
      }
    }

    // Apply crisp exponential smoothing to all orientation & rig channels
    this.state.pitch = expApproach(this.state.pitch, targetPitch, 13.0, dt);
    this.state.roll = expApproach(this.state.roll, targetRoll, 13.5, dt);
    this.state.yaw = lerpAngle(
      this.state.yaw,
      baseSplineYaw - turn * yawLeadFactor,
      14.0,
      dt,
    );
    this.state.wingSpread = expApproach(this.state.wingSpread, targetWingSpread, 14.0, dt);
    this.state.wingLeftAngle = expApproach(
      this.state.wingLeftAngle,
      targetWingLeft,
      18.0,
      dt,
    );
    this.state.wingRightAngle = expApproach(
      this.state.wingRightAngle,
      targetWingRight,
      18.0,
      dt,
    );
    this.state.headYaw = expApproach(this.state.headYaw, targetHeadYaw, 12.0, dt);
    this.state.headPitch = expApproach(this.state.headPitch, targetHeadPitch, 12.0, dt);
    this.state.balanceWobble = expApproach(
      this.state.balanceWobble,
      targetBalanceWobble,
      16.0,
      dt,
    );
  }

  private updateCrashedState(
    dt: number,
    _time: number,
    sample: ExtendedRiverSample,
    waveY: number,
  ): void {
    this.crashTimer += dt;
    this.updateSquashSpring(dt);

    // Gentle comical bobbing drift after bonk
    let vy = (this.state.verticalVelocity ?? 0) - DUCK_CONFIG.gravity * 0.6 * dt;
    this.state.y += vy * dt;
    if (this.state.y < waveY) {
      this.state.y = expApproach(this.state.y, waveY + 0.02, 10, dt);
      vy *= 0.4;
    }
    this.state.verticalVelocity = vy;
    this.state.lateralVelocity = (this.state.lateralVelocity ?? 0) * Math.exp(-4 * dt);
    this.state.u += (this.state.lateralVelocity ?? 0) * dt;

    // Comical dizzy tilted bob + spinning woozy head wobble + limp splayed wings!
    const decay = Math.exp(-this.crashTimer * 0.35);
    this.state.animState = 'crash';
    this.state.roll = 0.48 + Math.sin(this.crashTimer * 6.5) * 0.48 * decay;
    this.state.pitch = Math.cos(this.crashTimer * 5.2) * 0.24 * decay;
    this.state.balanceWobble = Math.sin(this.crashTimer * 10.5) * 0.18 * decay;
    this.state.headYaw = Math.sin(this.crashTimer * 9.5) * 0.52;
    this.state.headPitch = -0.14 + Math.cos(this.crashTimer * 7.0) * 0.12;
    this.state.wingSpread = 0.72;
    this.state.wingLeftAngle = -0.22 + Math.sin(this.crashTimer * 5.5) * 0.18;
    this.state.wingRightAngle = 0.16 - Math.sin(this.crashTimer * 5.5) * 0.18;
    this.state.paddlePhase += dt * 4.5 * decay;
    this.state.isUnderwater = false;
    this.state.submersionDepth = 0;

    this.syncWorldTransformFromSpline(sample, dt, false);
  }

  private syncWorldTransformFromSpline(
    sample: ExtendedRiverSample,
    dt: number,
    snapVelocity: boolean,
  ): void {
    const newX = sample.position.x + sample.right.x * this.state.u;
    const newY = sample.position.y + this.state.y;
    const newZ = sample.position.z + sample.right.z * this.state.u;

    if (!snapVelocity && dt > 1e-4) {
      this.state.velocity = {
        x: (newX - this.prevWorldPos.x) / dt,
        y: (newY - this.prevWorldPos.y) / dt,
        z: (newZ - this.prevWorldPos.z) / dt,
      };
    } else {
      this.state.velocity = {
        x: sample.tangent.x * this.state.speed,
        y: sample.tangent.y * this.state.speed,
        z: sample.tangent.z * this.state.speed,
      };
    }

    this.state.worldPos = { x: newX, y: newY, z: newZ };
    this.prevWorldPos = { x: newX, y: newY, z: newZ };
  }
}
