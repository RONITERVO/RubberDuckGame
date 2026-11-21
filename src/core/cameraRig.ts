import * as THREE from 'three';
import { CAMERA_CONFIG, DUCK_CONFIG } from '../config';
import { earthToLocal } from '../earth/coords';
import { earthWorld } from '../earth/earthWorld';
import type { DuckState, GameState, RiverCoords, Vec3 } from '../types';
import { RiverSpline, type ExtendedRiverSample } from './riverSpline';

export interface CameraRigState {
  /** True when the camera lens is physically beneath the local water surface. */
  cameraSubmerged: boolean;
  /** Positive depth of camera lens below local water surface (0 when above water). */
  cameraSubmersionDepth: number;
  /** Brief decaying transition impulse [0, 1] spiking whenever camera crosses the water surface. */
  meniscusPulse: number;
  /** Direction of the most recent surface crossing: -1 entering water, +1 exiting water, 0 none. */
  meniscusDirection: -1 | 0 | 1;
  /** Current camera world position. */
  position: Vec3;
  /** Current world-space look target. */
  lookTarget: Vec3;
  /** Unit camera forward direction. */
  forward: Vec3;
  /** Current dynamic vertical FOV in degrees. */
  fov: number;
  /** Camera position projected into river coordinates `(s, u, y)`. */
  riverCoords: RiverCoords;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function expApproach(current: number, target: number, rate: number, dt: number): number {
  const alpha = 1 - Math.exp(-Math.max(0, rate) * dt);
  return current + (target - current) * alpha;
}

/**
 * Spline-following 3D chase camera tuned for 10cm tiny-duck scale,
 * dramatic 40–65u forward sightlines, seamless underwater submersion,
 * subtle turn banking, dynamic speed/rapids/flight FOV, and waterfall landing spring shake.
 */
export class CameraRig {
  public readonly camera: THREE.PerspectiveCamera;

  /** True when camera lens is beneath the local water surface (consumed by UnderwaterFx). */
  public cameraSubmerged = false;
  /** Positive depth beneath local water surface in world units (0 when above). */
  public cameraSubmersionDepth = 0;
  /** Brief [0, 1] transition impulse whenever camera crosses the air/water meniscus. */
  public meniscusPulse = 0;
  /** -1 entering water, +1 exiting water, 0 idle. */
  public meniscusDirection: -1 | 0 | 1 = 0;

  // Smoothed camera state
  private currentPos = new THREE.Vector3();
  private currentLook = new THREE.Vector3();
  private currentForward = new THREE.Vector3(0, 0, -1);
  private currentUp = new THREE.Vector3(0, 1, 0);
  private currentFov: number = CAMERA_CONFIG.fovDesktop;
  private currentBankRoll = 0;

  // Smoothly blended chase parameters
  private smoothFollowDist: number = CAMERA_CONFIG.surfaceFollowDist;
  private smoothHeight: number = CAMERA_CONFIG.surfaceHeight;
  private smoothLookAhead: number = CAMERA_CONFIG.surfaceLookAhead;
  private smoothDiveBlend = 0;
  private smoothLatFollow = 0;
  private smoothGorgeBlend = 0;
  private smoothArchBlend = 0;
  private smoothForkBlend = 0;
  private initialized = false;

  // Floating-Origin ENU seamless recenter subscription
  private attachedRiver: RiverSpline | null = null;
  private unsubOriginRecenter: (() => void) | null = null;

  // Spring-damper vertical & lateral landing shake
  private shakePosY = 0;
  private shakeVelY = 0;
  private shakeTrauma = 0;
  private shakePhase = 0;

  // Cached river coordinates for camera lens
  private riverCoords: RiverCoords = { s: 0, u: 0, y: CAMERA_CONFIG.surfaceHeight };

  // Scratch vectors (zero per-frame heap allocations!)
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredLook = new THREE.Vector3();
  private readonly shakeOffset = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.camera.near = CAMERA_CONFIG.near;
    this.camera.far = CAMERA_CONFIG.far;
    this.currentFov = this.computeBaseFov(camera.aspect || 16 / 9);
    this.camera.fov = this.currentFov;
    this.camera.updateProjectionMatrix();
  }

  /** Update projection aspect ratio (automatically adapts FOV for mobile portrait vs desktop). */
  public setAspect(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Trigger a generic spring/trauma camera shake (e.g., shield bounce, bonk, heavy splash). */
  public triggerShake(intensity: number = 0.6): void {
    const clamped = clamp(intensity, 0.1, 1.5);
    this.shakeTrauma = Math.min(1.4, this.shakeTrauma + clamped);
    this.shakeVelY -= clamped * 4.5;
  }

  /** Trigger a heavy damped spring bounce when splashing into a waterfall plunge pool! */
  public triggerWaterfallLandingShake(intensity: number = 1.0): void {
    const clamped = clamp(intensity, 0.35, 1.4);
    this.shakeTrauma = Math.min(1.5, Math.max(this.shakeTrauma, clamped * 1.15));
    this.shakeVelY -= clamped * 8.2;
  }

  /** Snap camera immediately behind duck (used on instant restart or QA teleport). */
  public snapToDuck(duck: DuckState, river: RiverSpline): void {
    this.initialized = false;
    this.shakePosY = 0;
    this.shakeVelY = 0;
    this.shakeTrauma = 0;
    this.smoothDiveBlend = duck.isUnderwater || duck.mode === 'diving' ? 1.0 : 0.0;
    this.smoothLatFollow = duck.u;
    this.meniscusPulse = 0;
    this.meniscusDirection = 0;
    this.update(0.016, 0, 'playing', duck, river, 0);
    // Guarantee instant snaps (restart / showcase) never flash a water-lens meniscus bar
    this.meniscusPulse = 0;
    this.meniscusDirection = 0;
  }

  /**
   * Per-frame camera update supporting `'title'`, `'playing'`, `'paused'`, and `'gameover'`.
   */
  public update(
    dt: number,
    time: number,
    gameState: GameState,
    duck: DuckState,
    river: RiverSpline,
    rapidsTurbulence: number = 0,
  ): CameraRigState {
    this.ensureOriginSubscription(river);
    const safeDt = clamp(dt, 0.001, 0.05);
    const duckSample = river.sampleAt(duck.s);
    const aspect = this.camera.aspect || 16 / 9;
    const portraitT = clamp((1.05 - aspect) / 0.55, 0, 1);

    // -------------------------------------------------------------------------
    // 1. TITLE SCREEN SCENIC ORBIT / GLIDE CAMERA
    // -------------------------------------------------------------------------
    if (gameState === 'title') {
      this.updateTitleCamera(safeDt, time, duck, river, portraitT);
      return this.getState();
    }

    // -------------------------------------------------------------------------
    // 2. GAMEPLAY / PAUSED / GAMEOVER CHASE CAMERA
    // -------------------------------------------------------------------------
    const activeCave = duck.inCave ? river.isInsideCave(duck.s, duck.u) : null;
    const divingTarget =
      duck.isUnderwater || duck.mode === 'diving' ? 1.0 : 0.0;
    this.smoothDiveBlend = expApproach(
      this.smoothDiveBlend,
      divingTarget,
      divingTarget > 0.5 ? 7.5 : 6.2,
      safeDt,
    );

    // Determine target framing parameters per locomotion mode
    let targetFollowDist: number = CAMERA_CONFIG.surfaceFollowDist;
    let targetHeight: number = CAMERA_CONFIG.surfaceHeight;
    let targetLookAhead: number = CAMERA_CONFIG.surfaceLookAhead;
    let targetLookOffsetY = 0.72;
    let modeFovBoost = 0;

    if (duck.mode === 'flying') {
      targetFollowDist = CAMERA_CONFIG.flyFollowDist + 0.8 + portraitT * 1.1;
      targetHeight = CAMERA_CONFIG.flyHeight + 0.5 + portraitT * 0.25;
      targetLookAhead = CAMERA_CONFIG.flyLookAhead + 3.5;
      targetLookOffsetY = -0.65; // tilt gently down so river bends & aerial rings shine!
      modeFovBoost = 7.5;
    } else if (duck.mode === 'waterfall') {
      targetFollowDist = CAMERA_CONFIG.waterfallFollowDist + 0.5 + portraitT * 1.1;
      targetHeight = CAMERA_CONFIG.waterfallHeight + 0.4;
      targetLookAhead = 14.5;
      targetLookOffsetY = -1.6; // dramatic angle down into the foaming plunge pool!
      modeFovBoost = 8.5;
    } else if (this.smoothDiveBlend > 0.02) {
      targetFollowDist =
        lerp(
          CAMERA_CONFIG.surfaceFollowDist,
          CAMERA_CONFIG.diveFollowDist,
          this.smoothDiveBlend,
        ) +
        portraitT * 1.45;
      // Dip smoothly beneath the surface while diving so underwater roots & caves read crystal-clear!
      targetHeight = lerp(
        CAMERA_CONFIG.surfaceHeight,
        CAMERA_CONFIG.diveHeight,
        this.smoothDiveBlend,
      );
      targetLookAhead = lerp(
        CAMERA_CONFIG.surfaceLookAhead,
        CAMERA_CONFIG.diveLookAhead + 1.5,
        this.smoothDiveBlend,
      );
      targetLookOffsetY = lerp(0.72, 0.28, this.smoothDiveBlend);
      modeFovBoost = lerp(0, -2.4, this.smoothDiveBlend);
    } else if (duck.mode === 'airborne') {
      targetFollowDist = CAMERA_CONFIG.surfaceFollowDist + 0.65 + portraitT * 1.35;
      targetHeight = CAMERA_CONFIG.surfaceHeight + 0.35 + portraitT * 0.2;
      targetLookAhead = CAMERA_CONFIG.surfaceLookAhead + 2.2;
      targetLookOffsetY = 0.35;
      modeFovBoost = 2.5;
    } else {
      // Surface chase: give portrait screens slightly wider pull-back for rich bank & hazard readability
      targetFollowDist += portraitT * 1.4;
      targetHeight += portraitT * 0.22;
    }

    // Check upcoming waterfall lip ahead (~15–45u) to gently elevate sightlines so the drop is unmistakable!
    const nextWf = river.getNextWaterfall(duck.s);
    let waterfallPreview = 0;
    if (nextWf && duck.mode !== 'diving' && !activeCave) {
      const dist = nextWf.startS - duck.s;
      if (dist > 0 && dist < 48) {
        waterfallPreview = 1.0 - dist / 48;
        targetHeight += waterfallPreview * 0.85;
        targetLookAhead += waterfallPreview * 5.0;
      }
    }

    // Canyon, Aurora, Over-River Landmark & Physical Y-Fork cinematic framing:
    // - High-wall gorges (`canyonWallFactor > 0.4`), Aurora skies, and over-river arches subtly
    //   pitch & expand framing so cliffs, overhead arches, and Aurora shine.
    // - Approaching a physical 2-way river fork widens & elevates slightly so BOTH diverging
    //   branches (left & right) are crystal-clear on Desktop (1280x720) & Mobile Portrait (390x844)!
    const { gorgeBlend, auroraBlend, archBlend, forkBlend } =
      this.updateCanyonAndLandmarkFraming(safeDt, duckSample, river, !this.initialized);
    let canyonFovBoost = 0;
    if (!activeCave && this.smoothDiveBlend < 0.45 && !duck.isCrashed && gameState !== 'gameover') {
      const surfaceVis = 1.0 - clamp(this.smoothDiveBlend / 0.45, 0, 1);
      targetFollowDist +=
        (gorgeBlend * 0.42 + archBlend * 0.36 + forkBlend * (0.95 + portraitT * 0.45)) *
        surfaceVis;
      targetHeight +=
        (-gorgeBlend * 0.16 - archBlend * 0.22 + forkBlend * 0.72) * surfaceVis;
      targetLookAhead += forkBlend * 4.5 * surfaceVis;
      targetLookOffsetY +=
        (gorgeBlend * 0.54 + auroraBlend * 0.34 + archBlend * 0.64) *
        surfaceVis *
        lerp(1.0, 0.84, portraitT);
      canyonFovBoost =
        (gorgeBlend * 2.2 + auroraBlend * 1.15 + archBlend * 1.85 + forkBlend * 3.4) *
        surfaceVis;
    }

    // Gently duck chase camera when passing under a low overhead log/willow obstacle
    // so the camera glides cleanly underneath instead of colliding with solid bark!
    if (
      !activeCave &&
      this.smoothDiveBlend < 0.65 &&
      duck.mode !== 'flying' &&
      !duck.isCrashed &&
      gameState !== 'gameover' &&
      river.getObstaclesInRange
    ) {
      const overhead = river.getObstaclesInRange(
        duck.s - this.smoothFollowDist - 3.5,
        duck.s + 2.5,
      );
      for (let i = 0; i < overhead.length; i++) {
        const obs = overhead[i];
        if (obs.type === 'log_dive' || obs.type === 'arch') {
          targetHeight = Math.min(targetHeight, 1.38);
          targetLookOffsetY = Math.min(targetLookOffsetY, 0.35);
          break;
        }
      }
    }

    // Tighter scenic clearance inside caves so camera stays comfortably inside the mossy rock arch
    if (activeCave) {
      targetFollowDist = Math.min(targetFollowDist, 4.35 + portraitT * 0.65);
      targetHeight = Math.min(targetHeight, 1.55);
      targetLookAhead = Math.min(targetLookAhead, 9.5);
    }

    // Subtle zoom-out on comical crash so player enjoys the dizzy duck bob
    if (gameState === 'gameover' || duck.isCrashed) {
      targetFollowDist = 6.2 + portraitT * 1.0;
      targetHeight = 2.6;
      targetLookAhead = 2.5;
      targetLookOffsetY = 0.45;
      modeFovBoost = -2.0;
    }

    const paramRate = 5.8;
    if (!this.initialized) {
      this.smoothFollowDist = targetFollowDist;
      this.smoothHeight = targetHeight;
      this.smoothLookAhead = targetLookAhead;
    } else {
      this.smoothFollowDist = expApproach(
        this.smoothFollowDist,
        targetFollowDist,
        paramRate,
        safeDt,
      );
      this.smoothHeight = expApproach(this.smoothHeight, targetHeight, paramRate, safeDt);
      this.smoothLookAhead = expApproach(
        this.smoothLookAhead,
        targetLookAhead,
        paramRate,
        safeDt,
      );
    }

    // Compute camera spline position behind the duck BEFORE lateral clamping so bank bounds are exact
    const camS = Math.max(0, duck.s - this.smoothFollowDist);
    const camSample = river.sampleAt(camS);

    // Follow duck laterally while clamping strictly inside safe open channel (never clip bank boulders!)
    let targetCamU: number;
    if (activeCave) {
      const caveCenterCam = river.getCaveCenterU(activeCave, camS);
      const maxCaveDev = Math.max(0.4, activeCave.width * 0.5 - 1.3);
      const rawCaveU = lerp(caveCenterCam, duck.u, 0.72);
      targetCamU = clamp(rawCaveU, caveCenterCam - maxCaveDev, caveCenterCam + maxCaveDev);
    } else {
      const latFollowFactor =
        duck.mode === 'diving'
          ? lerp(0.76, 0.88, portraitT)
          : lerp(0.66, 0.82, portraitT);
      const bankSafetyMargin = this.smoothDiveBlend > 0.25 ? 2.25 : 1.9;
      const maxSafeCamU = Math.max(1.0, camSample.width * 0.5 - bankSafetyMargin);
      targetCamU = clamp(duck.u * latFollowFactor, -maxSafeCamU, maxSafeCamU);
    }

    if (!this.initialized) {
      this.smoothLatFollow = targetCamU;
    } else {
      this.smoothLatFollow = expApproach(this.smoothLatFollow, targetCamU, 8.8, safeDt);
      if (!activeCave) {
        const bankSafetyMargin = this.smoothDiveBlend > 0.25 ? 2.25 : 1.9;
        const maxSafeCamU = Math.max(1.0, camSample.width * 0.5 - bankSafetyMargin);
        this.smoothLatFollow = clamp(this.smoothLatFollow, -maxSafeCamU, maxSafeCamU);
      }
    }

    const camSurface = river.getWaterSurfaceAtRiver(camS, this.smoothLatFollow, time);
    const camWaterY = camSurface.height;

    // Anchor vertical offset cleanly relative to duck world height & water surface
    let desiredY: number;
    if (this.smoothDiveBlend > 0.35) {
      // Underwater framing: follow duck beneath surface cleanly without straddling the water plane
      const underwaterY = duck.worldPos.y + this.smoothHeight;
      const surfaceAboveY =
        Math.max(camSample.position.y, duck.worldPos.y) + this.smoothHeight;
      const blendT = clamp((this.smoothDiveBlend - 0.35) / 0.45, 0, 1);
      desiredY = lerp(surfaceAboveY, underwaterY, blendT);
      // Once truly submerged, keep lens clearly below the wave crest (no half-in/half-out flicker!)
      if (duck.isUnderwater && duck.submersionDepth > 0.42) {
        desiredY = Math.min(desiredY, camWaterY - 0.26);
      }
      // Never clip into riverbed pebbles or sloped bank floor
      const riverbedSafeY = Math.max(
        camSample.position.y - camSurface.depth + 0.65,
        camSample.position.y - Math.max(1.45, camSurface.depth * 0.72),
      );
      desiredY = Math.max(desiredY, riverbedSafeY);
    } else {
      // Above-water chase framing: tracks jumps/flight smoothly while staying grounded to river elevation
      const duckAirContrib =
        duck.mode === 'flying'
          ? Math.max(0, duck.y) * 0.82
          : duck.mode === 'waterfall'
            ? duck.y * 0.68
            : Math.max(0, duck.y) * 0.42;
      desiredY =
        Math.max(camSample.position.y, duckSample.position.y) +
        duckAirContrib +
        this.smoothHeight;
    }

    // Respect cave roof clearance inside limestone tunnel
    if (activeCave) {
      const caveCeilWorldY =
        camSample.position.y + river.getCaveCeilingY(activeCave, camS) - 0.65;
      desiredY = Math.min(desiredY, caveCeilWorldY);
    }

    this.desiredPos.set(
      camSample.position.x + camSample.right.x * this.smoothLatFollow,
      desiredY,
      camSample.position.z + camSample.right.z * this.smoothLatFollow,
    );

    // Compute look-at target downstream so horizon & sightlines showcase 45–65u ahead!
    const lookS = duck.s + this.smoothLookAhead;
    const lookSample = river.sampleAt(lookS);
    let lookU: number;
    if (activeCave) {
      lookU = lerp(river.getCaveCenterU(activeCave, lookS), duck.u, lerp(0.45, 0.72, portraitT));
    } else {
      const baseLookFactor =
        this.smoothDiveBlend > 0.35
          ? lerp(0.55, 0.9, portraitT)
          : lerp(0.38, 0.78, portraitT);
      lookU = duck.u * baseLookFactor;

      // Portrait framing guard: ensure the camera optical axis passes near the duck laterally
      // so the hero duck NEVER drifts off the left/right edges on narrow phone screens!
      if (portraitT > 0.15) {
        const span = Math.max(0.1, this.smoothFollowDist + this.smoothLookAhead);
        const duckFrac = this.smoothFollowDist / span;
        const rayUAtDuck = lerp(this.smoothLatFollow, lookU, duckFrac);
        const maxDuckScreenU = lerp(1.5, 0.65, portraitT);
        const err = duck.u - rayUAtDuck;
        if (Math.abs(err) > maxDuckScreenU) {
          const desiredRayU = duck.u - Math.sign(err) * maxDuckScreenU;
          lookU = this.smoothLatFollow + (desiredRayU - this.smoothLatFollow) / duckFrac;
        }
      }
    }

    let desiredLookY: number;
    if (this.smoothDiveBlend > 0.35) {
      desiredLookY = lerp(
        lookSample.position.y + 0.5,
        duck.worldPos.y + targetLookOffsetY,
        clamp((this.smoothDiveBlend - 0.2) / 0.6, 0, 1),
      );
    } else if (duck.mode === 'flying') {
      desiredLookY = duck.worldPos.y * 0.55 + lookSample.position.y * 0.45 + targetLookOffsetY;
    } else if (duck.mode === 'waterfall') {
      desiredLookY = lerp(duck.worldPos.y, lookSample.position.y, 0.55) + targetLookOffsetY;
    } else {
      // Blend duck elevation with far river spline elevation for rich long-range sightlines!
      desiredLookY =
        lerp(duckSample.position.y, lookSample.position.y, 0.58) +
        Math.max(0, duck.y) * 0.25 +
        targetLookOffsetY;
    }

    this.desiredLook.set(
      lookSample.position.x + lookSample.right.x * lookU,
      desiredLookY,
      lookSample.position.z + lookSample.right.z * lookU,
    );

    // Subtle gameover orbit around our dizzy duck!
    if (gameState === 'gameover' || duck.isCrashed) {
      const orbitAngle = Math.sin(time * 0.55) * 0.45;
      const cosO = Math.cos(orbitAngle);
      const sinO = Math.sin(orbitAngle);
      const relX = this.desiredPos.x - duck.worldPos.x;
      const relZ = this.desiredPos.z - duck.worldPos.z;
      this.desiredPos.x = duck.worldPos.x + relX * cosO - relZ * sinO;
      this.desiredPos.z = duck.worldPos.z + relX * sinO + relZ * cosO;
      this.desiredLook.set(duck.worldPos.x, duck.worldPos.y + 0.45, duck.worldPos.z);
    }

    // Smooth camera position & look-at
    if (!this.initialized) {
      this.currentPos.copy(this.desiredPos);
      this.currentLook.copy(this.desiredLook);
      this.initialized = true;
    } else {
      const posAlpha = 1 - Math.exp(-CAMERA_CONFIG.posSmooth * safeDt);
      const lookAlpha = 1 - Math.exp(-CAMERA_CONFIG.lookSmooth * safeDt);
      this.currentPos.lerp(this.desiredPos, posAlpha);
      this.currentLook.lerp(this.desiredLook, lookAlpha);
    }

    // -------------------------------------------------------------------------
    // 3. SPRING-DAMPED LANDING SHAKE & RAPIDS MICRO-VIBRATION
    // -------------------------------------------------------------------------
    this.updateShake(safeDt, rapidsTurbulence, duckSample.right, duck.mode === 'surface');

    // -------------------------------------------------------------------------
    // 4. DYNAMIC FOV BOOST (SPEED + RAPIDS + WATERFALL + FLIGHT)
    // -------------------------------------------------------------------------
    const baseFov = this.computeBaseFov(this.camera.aspect || 16 / 9);
    const speedRatio = clamp(
      (duck.speed - DUCK_CONFIG.baseSpeed) /
        Math.max(1, DUCK_CONFIG.maxSpeed - DUCK_CONFIG.baseSpeed),
      0,
      1.3,
    );
    const speedFov = speedRatio * 5.2;
    const rapidsFov =
      duck.mode === 'surface' ? clamp(rapidsTurbulence, 0, 1) * 2.4 : 0;
    const targetFov = clamp(
      baseFov +
        speedFov +
        rapidsFov +
        modeFovBoost +
        waterfallPreview * 2.5 +
        canyonFovBoost,
      50,
      82,
    );
    this.currentFov = expApproach(this.currentFov, targetFov, 5.5, safeDt);
    if (Math.abs(this.camera.fov - this.currentFov) > 0.02) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    // -------------------------------------------------------------------------
    // 5. SUBTLE TURN BANKING & FINAL TRANSFORM
    // -------------------------------------------------------------------------
    const bankScale =
      duck.mode === 'flying'
        ? 0.095
        : duck.mode === 'diving'
          ? 0.072
          : 0.058;
    const targetBank =
      gameState === 'gameover' ? 0 : clamp(duck.turnAmount * bankScale, -0.11, 0.11);
    this.currentBankRoll = expApproach(this.currentBankRoll, targetBank, 7.5, safeDt);

    this.camera.position.copy(this.currentPos).add(this.shakeOffset);
    this.currentUp
      .set(
        duckSample.right.x * Math.sin(this.currentBankRoll),
        Math.cos(this.currentBankRoll),
        duckSample.right.z * Math.sin(this.currentBankRoll),
      )
      .normalize();
    this.camera.up.copy(this.currentUp);
    this.camera.lookAt(this.currentLook);

    this.currentForward
      .subVectors(this.currentLook, this.camera.position)
      .normalize();

    // -------------------------------------------------------------------------
    // 6. SUBMERSION & MENISCUS CROSSING DETECTION
    // -------------------------------------------------------------------------
    this.updateSubmersionState(safeDt, time, river, duck.s);

    return this.getState();
  }

  public getState(): CameraRigState {
    return {
      cameraSubmerged: this.cameraSubmerged,
      cameraSubmersionDepth: this.cameraSubmersionDepth,
      meniscusPulse: this.meniscusPulse,
      meniscusDirection: this.meniscusDirection,
      position: {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
      },
      lookTarget: {
        x: this.currentLook.x,
        y: this.currentLook.y,
        z: this.currentLook.z,
      },
      forward: {
        x: this.currentForward.x,
        y: this.currentForward.y,
        z: this.currentForward.z,
      },
      fov: this.currentFov,
      riverCoords: { ...this.riverCoords },
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private computeBaseFov(aspect: number): number {
    // Smoothly widen vertical FOV on portrait mobile viewports so river banks stay visible!
    const portraitT = clamp((1.25 - aspect) / 0.72, 0, 1);
    return lerp(CAMERA_CONFIG.fovDesktop, CAMERA_CONFIG.fovMobilePortrait, portraitT);
  }

  /**
   * Keep camera seamlessly locked in world space with zero frame pop whenever
   * `RiverSpline` recenters its Floating-Origin ENU `LocalTangentFrame`.
   */
  private ensureOriginSubscription(river: RiverSpline): void {
    if (this.attachedRiver === river) return;
    this.unsubOriginRecenter?.();
    this.attachedRiver = river;
    this.unsubOriginRecenter = river.onOriginRecenter(
      (prevFrame, _nextFrame, _rev, anchorOldPos, anchorNewPos) => {
        if (!this.initialized) return;
        const shiftedPos = river.transformPointFromFrame(
          { x: this.currentPos.x, y: this.currentPos.y, z: this.currentPos.z },
          prevFrame,
          anchorOldPos,
          anchorNewPos,
        );
        const shiftedLook = river.transformPointFromFrame(
          { x: this.currentLook.x, y: this.currentLook.y, z: this.currentLook.z },
          prevFrame,
          anchorOldPos,
          anchorNewPos,
        );
        this.currentPos.set(shiftedPos.x, shiftedPos.y, shiftedPos.z);
        this.currentLook.set(shiftedLook.x, shiftedLook.y, shiftedLook.z);
      },
    );
  }

  /**
   * Evaluate smoothly damped framing blends for high-wall canyons (`canyonWallFactor > 0.4`),
   * Aurora Borealis skies, upcoming `over_river` / `over_waterway` landmarks, and physical 2-way forks.
   * 100% data-driven from `earthWorld` (zero hardcoded region/asset IDs!).
   */
  private updateCanyonAndLandmarkFraming(
    dt: number,
    sample: ExtendedRiverSample,
    river: RiverSpline,
    snap: boolean,
  ): { gorgeBlend: number; auroraBlend: number; archBlend: number; forkBlend: number } {
    const region = earthWorld.getBlendedRegionAt(sample.lat, sample.lng);
    const canyonFactor = region.riverProfile.canyonWallFactor;
    const targetGorge =
      canyonFactor > 0.4 ? clamp((canyonFactor - 0.4) / 0.55, 0, 1) : 0;
    const auroraBlend = region.atmosphere.hasAurora ? 1.0 : 0.0;

    let targetArch = 0;

    // 1. Check real shared geographic `EarthLandmark`s spanning over the waterway ahead
    const geoLandmarks = earthWorld.getNearbyLandmarks(sample.lat, sample.lng, 44);
    if (geoLandmarks.length > 0) {
      const frame = river.getLocalTangentFrame();
      for (let i = 0; i < geoLandmarks.length; i++) {
        const lm = geoLandmarks[i];
        if (lm.placement !== 'over_waterway') continue;
        const lmPos = earthToLocal(lm.lat, lm.lng, sample.elevation, frame);
        const dx = lmPos.x - sample.position.x;
        const dz = lmPos.z - sample.position.z;
        const ds = dx * sample.tangent.x + dz * sample.tangent.z;
        if (ds >= -2 && ds <= 34) {
          const approach =
            ds >= 0 ? smoothstep01(1.0 - ds / 34) : smoothstep01(1.0 + ds / 2.2);
          targetArch = Math.max(targetArch, approach);
        }
      }
    }

    // 2. Check periodic `over_river` landmarks from the active region's scenery rules
    const leg = river.getLegAtS(sample.s);
    const localLegS = Math.max(0, sample.s - (leg?.startS ?? 0));
    const rules = region.primaryZone.scenery.landmarks;
    for (let i = 0; i < rules.length; i++) {
      const lm = rules[i];
      if (lm.placement === 'over_river' && lm.spacing > 15) {
        const rem = lm.spacing - (localLegS % lm.spacing);
        if (rem >= 0 && rem <= 34) {
          const approach = Math.sin(clamp(1.0 - rem / 34, 0, 1) * Math.PI);
          targetArch = Math.max(targetArch, approach * 0.88);
        }
      }
    }

    // 3. Check spawned overhead arch obstacles ahead in `[s - 2, s + 34]` (data-driven by type!)
    const nearbyObs = river.getObstaclesInRange(sample.s - 2, sample.s + 34);
    for (let i = 0; i < nearbyObs.length; i++) {
      const obs = nearbyObs[i];
      if (obs.type === 'arch' || (obs.type === 'log_dive' && obs.height >= 2.2)) {
        const ds = obs.s - sample.s;
        if (ds >= -2 && ds <= 34) {
          const approach =
            ds >= 0
              ? smoothstep01(1.0 - ds / 34)
              : smoothstep01(1.0 + ds / 2.2);
          targetArch = Math.max(targetArch, approach);
        }
      }
    }

    // 4. Physical 2-way River Fork wider overview framing so both diverging branches read clearly!
    let targetFork = 0;
    if (sample.upcomingFork && sample.upcomingFork.distanceU <= 78) {
      const dist = Math.max(0, sample.upcomingFork.distanceU);
      targetFork =
        smoothstep01(1.0 - dist / 78) * smoothstep01(dist / 8.0 + 0.35);
    }

    if (snap) {
      this.smoothGorgeBlend = targetGorge;
      this.smoothArchBlend = targetArch;
      this.smoothForkBlend = targetFork;
    } else {
      this.smoothGorgeBlend = expApproach(this.smoothGorgeBlend, targetGorge, 4.2, dt);
      this.smoothArchBlend = expApproach(this.smoothArchBlend, targetArch, 5.5, dt);
      this.smoothForkBlend = expApproach(this.smoothForkBlend, targetFork, 4.0, dt);
    }

    return {
      gorgeBlend: this.smoothGorgeBlend,
      auroraBlend,
      archBlend: this.smoothArchBlend,
      forkBlend: this.smoothForkBlend,
    };
  }

  private updateTitleCamera(
    dt: number,
    time: number,
    duck: DuckState,
    river: RiverSpline,
    portraitT: number,
  ): void {
    const sample = river.sampleAt(duck.s);
    const farSample = river.sampleAt(duck.s + 26);
    const { gorgeBlend, auroraBlend, archBlend } =
      this.updateCanyonAndLandmarkFraming(dt, sample, river, !this.initialized);

    // Gentle sunlit hero framing:
    // - Desktop landscape: scenic side-angle sway showcasing both the bobbing duck & winding creek
    // - Mobile portrait: centered framing (small lateral sway, slightly wider pullback) so the
    //   hero yellow duck sits proudly centered below the Play CTA and never clips off-screen!
    const sway = Math.sin(time * 0.34);
    const bob = Math.cos(time * 0.52) * lerp(0.2, 0.12, portraitT);
    const lateralOffset =
      lerp(1.65, -0.05, portraitT) + sway * lerp(1.15, 0.22, portraitT);
    const backDist =
      lerp(4.45, 5.65, portraitT) +
      gorgeBlend * 0.35 +
      Math.cos(time * 0.28) * lerp(0.4, 0.26, portraitT);
    const camHeight =
      lerp(1.85, 2.18, portraitT) - gorgeBlend * 0.12 + bob;

    const camS = Math.max(0, duck.s - backDist);
    const camSample = river.sampleAt(camS);
    const maxSafeU = Math.max(1.2, camSample.width * 0.5 - 2.0);
    const camU = clamp(duck.u + lateralOffset, -maxSafeU, maxSafeU);

    this.desiredPos.set(
      camSample.position.x + camSample.right.x * camU,
      camSample.position.y + camHeight,
      camSample.position.z + camSample.right.z * camU,
    );

    // Look past the hero duck down the canyon vista (subtly tilted up in high-wall gorges & Aurora skies)
    const vistaLift = (gorgeBlend * 0.45 + auroraBlend * 0.35 + archBlend * 0.4) * lerp(1.0, 0.75, portraitT);
    const lookXZBlend = lerp(0.36, 0.07, portraitT);
    const lookYTarget =
      lerp(
        lerp(duck.worldPos.y + 0.52, farSample.position.y + 1.1, 0.35),
        duck.worldPos.y + 1.24,
        portraitT,
      ) + vistaLift;
    this.desiredLook.set(
      lerp(duck.worldPos.x, farSample.position.x, lookXZBlend),
      lookYTarget,
      lerp(duck.worldPos.z, farSample.position.z, lookXZBlend),
    );

    if (!this.initialized) {
      this.currentPos.copy(this.desiredPos);
      this.currentLook.copy(this.desiredLook);
      this.initialized = true;
    } else {
      const alpha = 1 - Math.exp(-4.0 * dt);
      this.currentPos.lerp(this.desiredPos, alpha);
      this.currentLook.lerp(this.desiredLook, alpha);
    }

    const targetFov =
      this.computeBaseFov(this.camera.aspect || 16 / 9) -
      2.0 +
      gorgeBlend * 1.8 +
      auroraBlend * 1.0;
    this.currentFov = expApproach(this.currentFov, targetFov, 4.0, dt);
    if (Math.abs(this.camera.fov - this.currentFov) > 0.02) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    this.currentBankRoll = expApproach(this.currentBankRoll, sway * 0.025, 4.0, dt);
    this.camera.position.copy(this.currentPos);
    this.currentUp
      .set(
        sample.right.x * Math.sin(this.currentBankRoll),
        Math.cos(this.currentBankRoll),
        sample.right.z * Math.sin(this.currentBankRoll),
      )
      .normalize();
    this.camera.up.copy(this.currentUp);
    this.camera.lookAt(this.currentLook);
    this.currentForward
      .subVectors(this.currentLook, this.camera.position)
      .normalize();

    this.updateSubmersionState(dt, time, river, duck.s);
  }

  private updateShake(
    dt: number,
    rapidsTurbulence: number,
    right: Vec3,
    onSurface: boolean,
  ): void {
    // Spring-damper vertical bounce (waterfall plunge pool impact!)
    const springK = 140.0;
    const springDamp = 13.5;
    const accelY = -this.shakePosY * springK - this.shakeVelY * springDamp;
    this.shakeVelY += accelY * dt;
    this.shakePosY = clamp(this.shakePosY + this.shakeVelY * dt, -0.85, 0.85);

    // Trauma decay + subtle rapids rumble
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 1.65);
    this.shakePhase += dt * 34.0;

    const traumaSq = this.shakeTrauma * this.shakeTrauma;
    const rapidsJiggle = onSurface ? Math.max(0, rapidsTurbulence - 0.45) * 0.065 : 0;
    const latAmp = traumaSq * 0.24 + rapidsJiggle;
    const vertAmp = traumaSq * 0.16 + rapidsJiggle * 0.7;

    const lateralShake = Math.sin(this.shakePhase * 1.13) * latAmp;
    const verticalShake = this.shakePosY + Math.cos(this.shakePhase * 1.47) * vertAmp;

    this.shakeOffset.set(
      right.x * lateralShake,
      verticalShake,
      right.z * lateralShake,
    );
  }

  private updateSubmersionState(
    dt: number,
    time: number,
    river: RiverSpline,
    hintS: number,
  ): void {
    const camPos: Vec3 = {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
    };
    const coords = river.worldToRiver(camPos, hintS);
    this.riverCoords = coords;

    const waterY = river.getWaterHeightAtRiver(coords.s, coords.u, time);
    const depthBelowSurface = waterY - camPos.y;
    const prevSubmerged = this.cameraSubmerged;

    // Tiny hysteresis (0.04u) prevents rapid flicker when skimming right at wave crests
    const isNowSubmerged = prevSubmerged
      ? depthBelowSurface > -0.02
      : depthBelowSurface > 0.04;

    this.cameraSubmerged = isNowSubmerged;
    this.cameraSubmersionDepth = isNowSubmerged ? Math.max(0, depthBelowSurface) : 0;

    // Trigger crisp meniscus pulse on every air <-> water lens crossing!
    if (isNowSubmerged !== prevSubmerged) {
      this.meniscusPulse = 1.0;
      this.meniscusDirection = isNowSubmerged ? -1 : 1;
    } else if (this.meniscusPulse > 0) {
      this.meniscusPulse = Math.max(0, this.meniscusPulse - dt * 1.85);
      if (this.meniscusPulse === 0) {
        this.meniscusDirection = 0;
      }
    }
  }
}
