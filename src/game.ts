import * as THREE from 'three';
import { applyDuckRigPose, assetLoader } from './assets/loader';
import {
  getAssetSpec,
  getRegisteredAssetIds,
  HERO_CORE_ASSET_IDS,
  SHARED_OBSTACLE_ASSET_IDS,
} from './assets/manifest';
import { SoundEngine } from './audio/soundEngine';
import {
  CAMERA_CONFIG,
  DUCK_CONFIG,
  POWERUP_CONFIG,
  QUALITY_PRESETS,
  SCALE,
  SCORING_CONFIG,
} from './config';
import { CameraRig, type CameraRigState } from './core/cameraRig';
import { DuckController, type DuckEvent } from './core/duckController';
import { Hydrodynamics } from './core/hydrodynamics';
import { RiverSpline } from './core/riverSpline';
import { earthWorld } from './earth';
import { Collectibles } from './gameplay/collectibles';
import { ObstacleSpawner } from './gameplay/obstacleSpawner';
import { Wildlife } from './gameplay/wildlife';
import { InputManager } from './input/inputManager';
import { Environment } from './render/environment';
import { ParticleSystem } from './render/particles';
import { UnderwaterFx } from './render/underwaterFx';
import { WaterMesh } from './render/waterMesh';
import {
  getAllTracks,
  getTrackAssets,
  getWeatherLabel,
  validateTrackGraph,
  worldRoute,
} from './tracks';
import type {
  ActivePowerUpHud,
  AssetId,
  DuckRig,
  DuckState,
  GameState,
  HudCallout,
  HudSnapshot,
  HydroObstacle,
  InputState,
  ObstacleType,
  PowerUpType,
  QualityLevel,
  ResolvedQuality,
  RouteMode,
} from './types';
import { Hud } from './ui/hud';

const STORAGE_HIGH_SCORE_KEY = 'river_ducker_high_score_v1';
const STORAGE_BEST_DIST_KEY = 'river_ducker_best_dist_v1';
const STORAGE_QUALITY_KEY = 'river_ducker_quality_v1';

export type ShowcaseMode =
  | 'surface'
  | 'turning'
  | 'turning_left'
  | 'turning_right'
  | 'diving'
  | 'cave'
  | 'waterfall'
  | 'flying'
  | 'spooked'
  | 'jump_log'
  | 'dive_log'
  | 'boulder'
  | 'fork'
  | 'obstacles'
  | 'gameover';

export interface RiverDuckerDebugHandle {
  getState(): Record<string, unknown>;
  getWorldInfo(): Record<string, unknown>;
  getTracks(): Record<string, unknown>;
  setTrack(
    regionOrWaterwayId: string,
    routeMode?: RouteMode,
  ): Promise<Record<string, unknown>>;
  setForkChoice(side: 'left' | 'right' | null): void;
  openGlobe(open?: boolean): void;
  start(): void;
  restart(): void;
  pause(): void;
  resume(): void;
  returnTitle(): void;
  setQuality(level: QualityLevel): void;
  setMuted(muted: boolean): void;
  setInputOverride(override: Partial<InputState> | null): void;
  activatePowerUp(type: PowerUpType): void;
  showcase(mode: ShowcaseMode): Record<string, unknown>;
}

declare global {
  interface Window {
    __riverDucker?: RiverDuckerDebugHandle;
  }
}

function readStoredNumber(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? Number(raw) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeStoredValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures in sandboxed/private browsing
  }
}

function readStoredQuality(): QualityLevel {
  try {
    const raw = localStorage.getItem(STORAGE_QUALITY_KEY);
    if (raw === 'auto' || raw === 'high' || raw === 'performance') {
      return raw;
    }
  } catch {
    // Ignore
  }
  return 'auto';
}

/**
 * 100% data-driven crash reason derived from the hit obstacle's AssetSpec label + maneuver type.
 */
function formatCrashReason(type: ObstacleType, obstacle?: HydroObstacle): string {
  const rawLabel = obstacle?.assetId ? getAssetSpec(obstacle.assetId).label : '';
  const cleanLabel = rawLabel.replace(/\s*\([^)]*\)\s*/g, '').trim();

  switch (type) {
    case 'boulder':
      return cleanLabel ? `Bonked ${cleanLabel}!` : 'Bonked a river boulder!';
    case 'snag':
      return cleanLabel ? `Snagged on ${cleanLabel}!` : 'Snagged on deadwood!';
    case 'log_dive':
    case 'arch':
      return cleanLabel
        ? `Bonked ${cleanLabel} — dive under!`
        : 'Bonked an overhead barrier — dive under!';
    case 'log_jump':
      return cleanLabel
        ? `Caught on ${cleanLabel} — jump over!`
        : 'Caught on driftwood roots — jump over!';
    case 'lily_pad':
      return 'Tangled in lily-pad stems!';
  }
}

interface DuckPowerUpAuras {
  shieldMesh: THREE.Mesh;
  flightGroup: THREE.Group;
  breathGroup: THREE.Group;
  magnetGroup: THREE.Group;
  dispose(): void;
}

function createDuckPowerUpAuras(parent: THREE.Object3D): DuckPowerUpAuras {
  const shieldGeom = new THREE.SphereGeometry(0.84, 20, 16);
  const shieldMat = new THREE.MeshPhysicalMaterial({
    color: 0xf4ccff,
    emissive: 0x9b5de5,
    emissiveIntensity: 0.2,
    roughness: 0.04,
    metalness: 0.08,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
  });
  const shieldMesh = new THREE.Mesh(shieldGeom, shieldMat);
  shieldMesh.position.set(0, 0.42, 0.02);
  shieldMesh.renderOrder = 8;
  shieldMesh.visible = false;
  parent.add(shieldMesh);

  const windArcGeom = new THREE.TorusGeometry(0.72, 0.018, 6, 22, Math.PI * 0.68);
  const flightMat = new THREE.MeshBasicMaterial({
    color: 0xffe066,
    transparent: true,
    opacity: 0.48,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const flightGroup = new THREE.Group();
  flightGroup.position.set(0, 0.36, -0.1);
  const flightArcA = new THREE.Mesh(windArcGeom, flightMat);
  flightArcA.rotation.set(Math.PI * 0.48, 0.18, 0);
  flightArcA.renderOrder = 9;
  const flightArcB = new THREE.Mesh(windArcGeom, flightMat);
  flightArcB.rotation.set(Math.PI * 0.52, -0.18, Math.PI);
  flightArcB.scale.setScalar(1.12);
  flightArcB.renderOrder = 9;
  flightGroup.add(flightArcA, flightArcB);
  flightGroup.visible = false;
  parent.add(flightGroup);

  const breathMat = new THREE.MeshBasicMaterial({
    color: 0x4de8ff,
    transparent: true,
    opacity: 0.42,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const breathGroup = new THREE.Group();
  breathGroup.position.set(0, 0.26, 0);
  const breathArcA = new THREE.Mesh(windArcGeom, breathMat);
  breathArcA.rotation.x = Math.PI * 0.5;
  breathArcA.scale.setScalar(0.86);
  breathArcA.renderOrder = 9;
  const breathArcB = new THREE.Mesh(windArcGeom, breathMat);
  breathArcB.rotation.set(Math.PI * 0.5, 0, Math.PI);
  breathArcB.scale.setScalar(0.86);
  breathArcB.renderOrder = 9;
  breathGroup.add(breathArcA, breathArcB);
  breathGroup.visible = false;
  parent.add(breathGroup);

  const magnetMat = new THREE.MeshBasicMaterial({
    color: 0xff7aa8,
    transparent: true,
    opacity: 0.42,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const magnetGroup = new THREE.Group();
  magnetGroup.position.set(0, 0.2, 0);
  const magnetArcA = new THREE.Mesh(windArcGeom, magnetMat);
  magnetArcA.rotation.x = Math.PI * 0.5;
  magnetArcA.scale.setScalar(1.04);
  magnetArcA.renderOrder = 9;
  const magnetArcB = new THREE.Mesh(windArcGeom, magnetMat);
  magnetArcB.rotation.set(Math.PI * 0.5, 0, Math.PI);
  magnetArcB.scale.setScalar(1.04);
  magnetArcB.renderOrder = 9;
  magnetGroup.add(magnetArcA, magnetArcB);
  magnetGroup.visible = false;
  parent.add(magnetGroup);

  return {
    shieldMesh,
    flightGroup,
    breathGroup,
    magnetGroup,
    dispose(): void {
      shieldGeom.dispose();
      shieldMat.dispose();
      windArcGeom.dispose();
      flightMat.dispose();
      breathMat.dispose();
      magnetMat.dispose();
    },
  };
}

/**
 * Main River Ducker: Shared Physical Mini-Earth orchestrator integrating
 * `earthWorld` geographic river networks, Floating-Origin ENU spline & physical
 * 2-way river forks, regional hydrodynamics & weather forces, articulated rubber
 * duck rig, data-driven WebGL2 water/terrain/weather shaders, 37 shared & regional
 * Meshy PBR assets, data-driven obstacles/wildlife/audio, and the live GPS 3D Mini-Earth Globe.
 */
export class RiverDuckerGame {
  private readonly canvas: HTMLCanvasElement;
  private readonly hudRoot: HTMLElement;
  private readonly appRoot: HTMLElement | null;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly cameraRig: CameraRig;

  private readonly river: RiverSpline;
  private readonly hydro: Hydrodynamics;
  private readonly sound: SoundEngine;
  private readonly duckController: DuckController;
  private readonly obstacleSpawner: ObstacleSpawner;
  private readonly collectibles: Collectibles;
  private readonly wildlife: Wildlife;
  private readonly underwaterFx: UnderwaterFx;
  private readonly environment: Environment;
  private readonly waterMesh: WaterMesh;
  private readonly particles: ParticleSystem;
  private readonly inputManager: InputManager;
  private readonly hud: Hud;

  private duckRig: DuckRig;
  private duckAuras: DuckPowerUpAuras;
  private unsubscribeAssetsUpdated: (() => void) | null = null;
  private unsubscribeOriginRecenter: (() => void) | null = null;
  private readonly preloadedAssetKeys = new Set<string>();

  // Game progression & scoring state
  private gameState: GameState = 'title';
  private runSeed = 202607;
  private score = 0;
  private highScore = readStoredNumber(STORAGE_HIGH_SCORE_KEY);
  private bestDistanceMeters = readStoredNumber(STORAGE_BEST_DIST_KEY);
  private isNewBest = false;
  private coins = 0;
  private combo = 1;
  private comboTimer = 0;
  private cavesCleared = 0;
  private waterfallsCleared = 0;
  private crashReason: string | undefined;
  private runStartS = 6;
  private lastTrackedS = 6;
  private lastActiveRegionId: string = worldRoute.getStartTrackId();
  private activeStartTargetId: string = worldRoute.getStartTrackId();
  private activeRouteMode: RouteMode = worldRoute.getRouteMode();
  private showcaseNoCrashTimer = 0;
  private showcaseSpookHoldTimer = 0;

  // HUD callout notification state
  private calloutSeq = 0;
  private activeCallout: HudCallout | null = null;
  private calloutRemaining = 0;

  // Power-up expiration trackers (for clean expire audio)
  private prevFlightActive = false;
  private prevBreathBoostActive = false;
  private prevMagnetActive = false;

  // Quality & adaptive performance tracking
  private qualitySetting: QualityLevel = readStoredQuality();
  private resolvedQuality: ResolvedQuality = 'high';
  private adaptiveWindowFrames = 0;
  private adaptiveWindowTimeMs = 0;
  private slowWindowsStreak = 0;
  private fastWindowsStreak = 0;
  private smoothedFps = 60;
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private assetsLoadedRatio = 0;
  private assetsReady = false;

  // Loop & lifecycle
  private rafId: number | null = null;
  private disposed = false;
  private lastFrameMs = 0;
  private elapsedTime = 0;
  private lastCamState: CameraRigState;
  private inputOverride: Partial<InputState> | null = null;

  constructor(canvas: HTMLCanvasElement, hudRoot: HTMLElement) {
    this.canvas = canvas;
    this.hudRoot = hudRoot;
    this.appRoot = document.getElementById('app');

    // Initial quality resolution
    this.resolvedQuality =
      this.qualitySetting === 'performance' ? 'performance' : 'high';

    // 1. WebGL2 Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: QUALITY_PRESETS[this.resolvedQuality].antialias,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = QUALITY_PRESETS[this.resolvedQuality].shadowsEnabled;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // 2. Scene & Camera
    this.scene = new THREE.Scene();
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(
      aspect < 0.85 ? CAMERA_CONFIG.fovMobilePortrait : CAMERA_CONFIG.fovDesktop,
      aspect,
      CAMERA_CONFIG.near,
      CAMERA_CONFIG.far,
    );
    this.cameraRig = new CameraRig(this.camera);

    // 3. Core Shared-Earth River Spline, Hydrodynamics, Audio & Duck Controller
    this.river = new RiverSpline(this.runSeed, worldRoute);
    this.obstacleSpawner = new ObstacleSpawner(this.river, this.runSeed + 17);
    this.river.setObstacleProvider((sStart, sEnd) =>
      this.obstacleSpawner.getObstaclesInRange(sStart, sEnd),
    );
    this.hydro = new Hydrodynamics(this.river);
    this.sound = new SoundEngine();
    this.duckController = new DuckController(this.river, this.hydro, this.sound);

    // 4. Data-Driven Rendering & FX Subsystems
    this.underwaterFx = new UnderwaterFx(this.scene, this.resolvedQuality, this.appRoot);
    this.underwaterFx.setWorldRoute(worldRoute);

    this.environment = new Environment(
      this.scene,
      assetLoader,
      this.underwaterFx.causticsUniforms,
      this.resolvedQuality,
    );
    this.environment.setWorldRoute(worldRoute);
    this.environment.setOnLightningFlash((intensity) => {
      if (this.gameState === 'playing' || this.gameState === 'title') {
        this.sound.emit('thunder', { intensity });
      }
    });

    this.waterMesh = new WaterMesh(this.scene, this.resolvedQuality);
    this.waterMesh.setWorldRoute(worldRoute);

    this.particles = new ParticleSystem(this.scene, this.resolvedQuality);
    this.particles.setWorldRoute(worldRoute);

    // 5. Data-Driven Gameplay World Subsystems
    this.collectibles = new Collectibles(this.river, this.obstacleSpawner, this.runSeed + 41);
    this.wildlife = new Wildlife(
      this.river,
      {
        onMiniSplash: (pos) => {
          this.particles.emitSplash(pos, 0.34, 'jump');
        },
      },
      this.runSeed + 99,
    );

    this.scene.add(
      this.obstacleSpawner.group,
      this.collectibles.group,
      this.wildlife.group,
    );

    // Keep all world-space gameplay caches synced seamlessly across Floating-Origin ENU recenters!
    this.unsubscribeOriginRecenter = this.river.onOriginRecenter(() => {
      this.obstacleSpawner.syncWorldPositions();
      this.collectibles.syncWorldPositions();
      this.wildlife.syncWorldPositions();
      this.environment.reset();
    });

    // 6. Articulated Hero Rubber Duck Rig (upgraded automatically once Meshy GLBs load!)
    this.duckRig = assetLoader.createDuckRig();
    this.duckAuras = createDuckPowerUpAuras(this.duckRig.bodyPivot);
    this.scene.add(this.duckRig.root);

    // Subscribe to on-demand / background GLB asset completions
    this.unsubscribeAssetsUpdated = assetLoader.onAssetsUpdated((updatedIds) => {
      if (this.disposed) return;
      if (
        updatedIds.includes('rubber_duck') ||
        updatedIds.includes('duck_wing')
      ) {
        this.rebuildHeroDuckRig();
      }
      this.environment.refreshAssets(updatedIds);
      this.obstacleSpawner.refreshAssets();
      this.wildlife.refreshAssets();
    });

    // 7. Input Manager
    this.inputManager = new InputManager({
      onFirstGesture: () => {
        void this.sound.unlock();
      },
      onPauseToggle: () => {
        if (this.gameState === 'playing') this.pause();
        else if (this.gameState === 'paused') this.resume();
      },
      onRestart: () => {
        if (this.gameState === 'gameover' || this.gameState === 'paused') {
          this.restartRun();
        }
      },
      onStartConfirm: () => {
        if (this.hud.isGlobeModalOpen()) return;
        if (this.gameState === 'title') {
          this.startRun();
        } else if (this.gameState === 'gameover') {
          this.restartRun();
        }
      },
      onMuteToggle: () => {
        const nextMuted = this.sound.toggleMuted();
        this.hud.setSettings({ muted: nextMuted });
      },
      onInputDeviceChange: (device) => {
        this.hud.setInputDevice(device);
      },
    });
    this.inputManager.attach(this.canvas);

    // 8. Diegetic HUD, Fork Signpost & Live-GPS 3D Mini-Earth Globe
    this.hud = new Hud(
      this.hudRoot,
      {
        onPlay: () => {
          void this.sound.unlock();
          this.startRun();
        },
        onPause: () => {
          this.pause();
        },
        onResume: () => {
          void this.sound.unlock();
          this.resume();
        },
        onRestart: () => {
          void this.sound.unlock();
          this.restartRun();
        },
        onReturnTitle: () => {
          this.returnToTitle();
        },
        onMuteToggle: (muted) => {
          this.sound.setMuted(muted);
        },
        onQualityChange: (level) => {
          this.setQuality(level);
        },
        onVirtualJump: (pressed) => {
          this.inputManager.setVirtualJump(pressed);
        },
        onVirtualDive: (held) => {
          this.inputManager.setVirtualDive(held);
        },
        onUserGesture: () => {
          void this.sound.unlock();
        },
        onRouteChange: (routeMode, trackId, startImmediately) => {
          this.handleRouteChange(routeMode, trackId, Boolean(startImmediately));
        },
      },
      {
        quality: this.qualitySetting,
        muted: this.sound.isMuted(),
        routeMode: this.activeRouteMode,
        startTrackId: this.activeStartTargetId,
      },
    );
    this.hud.setInputDevice(this.inputManager.getInputDevice());

    // Initial sizing, world streaming, and camera snap
    this.applyQualityToSubsystems(this.resolvedQuality);
    this.handleResize();
    this.prepareTitleScene();
    this.lastCamState = this.cameraRig.getState();

    // Window & visibility listeners
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('blur', this.handleWindowBlur);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    // Expose QA & verification handle
    this.exposeDebugHandle();

    // Preload hero core + shared river obstacles + starting region GLBs, then stream connected waterways smoothly
    void this.loadAssetsAsync();
  }

  public start(): void {
    if (this.rafId !== null || this.disposed) return;
    this.lastFrameMs = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  public startRun(): void {
    this.hud.closeGlobeModal();
    this.runSeed = (Date.now() & 0x7fffffff) || 202607;
    this.resetWorldForRun(this.runSeed);
    this.gameState = 'playing';
    const sample = this.river.sampleAt(this.duckController.getState().s);
    const zone = earthWorld.getZoneById(sample.regionId ?? sample.trackId);
    if (sample.lat !== undefined && sample.lng !== undefined) {
      this.sound.setGeoAudioPosition(sample.lat, sample.lng);
    } else {
      this.sound.setTrackAudioProfile(zone.id, zone.id, 0);
    }
    this.sound.emit('start_run');
    this.sound.emit('quack', { mood: 'happy', pitch: 1.05 });
    this.pushCallout(`SPLASH INTO ${zone.name.toUpperCase()}!`, 'info', 1.8);
  }

  public restartRun(): void {
    this.startRun();
  }

  public pause(): void {
    if (this.gameState !== 'playing') return;
    this.gameState = 'paused';
    this.sound.emit('pause');
  }

  public resume(): void {
    if (this.gameState !== 'paused') return;
    this.hud.closeGlobeModal();
    this.gameState = 'playing';
    this.lastFrameMs = performance.now();
    this.sound.emit('resume');
  }

  public returnToTitle(): void {
    this.inputOverride = null;
    this.hud.closeGlobeModal();
    this.gameState = 'title';
    this.prepareTitleScene();
  }

  public setQuality(level: QualityLevel): void {
    this.qualitySetting = level;
    writeStoredValue(STORAGE_QUALITY_KEY, level);

    const target: ResolvedQuality =
      level === 'performance' ? 'performance' : 'high';
    this.slowWindowsStreak = 0;
    this.fastWindowsStreak = 0;
    this.adaptiveWindowFrames = 0;
    this.adaptiveWindowTimeMs = 0;

    this.applyQualityToSubsystems(target);
    this.hud.setSettings({ quality: level });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    this.unsubscribeAssetsUpdated?.();
    this.unsubscribeAssetsUpdated = null;
    this.unsubscribeOriginRecenter?.();
    this.unsubscribeOriginRecenter = null;

    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('blur', this.handleWindowBlur);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);

    if (window.__riverDucker) {
      delete window.__riverDucker;
    }

    this.inputManager.dispose();
    this.hud.dispose();
    this.sound.dispose();
    this.duckAuras.dispose();
    this.obstacleSpawner.dispose();
    this.collectibles.dispose();
    this.wildlife.dispose();
    this.particles.dispose();
    this.waterMesh.dispose();
    this.underwaterFx.dispose();
    this.environment.dispose();
    this.renderer.dispose();
  }

  private rebuildHeroDuckRig(): void {
    this.scene.remove(this.duckRig.root);
    this.duckAuras.dispose();
    this.duckRig = assetLoader.createDuckRig();
    this.duckAuras = createDuckPowerUpAuras(this.duckRig.bodyPivot);
    this.scene.add(this.duckRig.root);
    applyDuckRigPose(this.duckRig, this.duckController.getState());
  }

  private preloadAssetsOnce(key: string, assetIds: readonly AssetId[]): void {
    if (this.preloadedAssetKeys.has(key)) return;
    this.preloadedAssetKeys.add(key);
    void assetLoader.preloadTrackAssets(assetIds);
  }

  private preloadRegionAndShared(regionOrWaterwayId: string): Promise<void> {
    const ww = earthWorld.getWaterwayById(regionOrWaterwayId);
    const regionAssets = ww
      ? earthWorld.getWaterwayAssets(ww.id, true)
      : earthWorld.getRegionAssets(regionOrWaterwayId, true);
    const combined = Array.from(
      new Set<AssetId>([
        ...HERO_CORE_ASSET_IDS,
        ...SHARED_OBSTACLE_ASSET_IDS,
        ...regionAssets,
      ]),
    );
    this.preloadedAssetKeys.add(`region:${regionOrWaterwayId}`);
    return assetLoader.preloadTrackAssets(combined);
  }

  private async loadAssetsAsync(): Promise<void> {
    const startRegionId = earthWorld.getZoneById(this.activeStartTargetId).id;
    this.preloadedAssetKeys.add(`region:${startRegionId}`);

    // 1. Load hero core + starting region assets first
    await assetLoader.initCore(startRegionId, (progress) => {
      this.assetsLoadedRatio = progress.ratio * 0.72;
    });
    if (this.disposed) return;

    // 2. Immediately load the 10 shared river obstacle & detail models alongside starting region
    await assetLoader.preloadTrackAssets(SHARED_OBSTACLE_ASSET_IDS);
    if (this.disposed) return;

    this.assetsLoadedRatio = 1;
    this.assetsReady = true;

    this.rebuildHeroDuckRig();
    this.environment.refreshAssets();
    this.obstacleSpawner.refreshAssets();
    this.wildlife.refreshAssets();

    // 3. Lazily preload remaining connected Earth regions sequentially in the background
    for (const zone of earthWorld.getAllZones()) {
      if (this.disposed) return;
      if (zone.id === startRegionId) continue;
      if (!this.preloadedAssetKeys.has(`region:${zone.id}`)) {
        this.preloadedAssetKeys.add(`region:${zone.id}`);
        await assetLoader.preloadTrackAssets(earthWorld.getRegionAssets(zone.id, false));
      }
    }
  }

  private handleRouteChange(
    routeMode: RouteMode,
    trackId: string,
    startImmediately: boolean,
  ): void {
    const ww = earthWorld.getWaterwayById(trackId);
    const resolvedZone = ww
      ? earthWorld.getZoneById(ww.regionId)
      : earthWorld.getZoneById(trackId);
    const targetId = ww ? ww.id : resolvedZone.id;

    this.activeRouteMode = routeMode;
    this.activeStartTargetId = targetId;
    this.river.setStartWaterway(targetId, routeMode);
    this.lastActiveRegionId = resolvedZone.id;
    this.hud.setRouteSelection(routeMode, resolvedZone.id, false);
    this.sound.setGeoAudioPosition(resolvedZone.centerLat, resolvedZone.centerLng);
    void this.preloadRegionAndShared(targetId);

    if (startImmediately) {
      void this.sound.unlock();
      this.startRun();
      return;
    }

    // Transform the live 3D background river immediately into the selected Earth region!
    if (this.gameState === 'title') {
      this.prepareTitleScene();
    } else {
      this.resetWorldForRun(this.runSeed);
    }
    this.stepSimulationAndRender(0.016);
  }

  private clearMeniscusSafely(syncSubmerged?: boolean): void {
    this.underwaterFx.clearMeniscus(syncSubmerged);
  }

  /**
   * Read-only scan along leg 0 using `earthWorld.sampleWaterway(...)` to find a scenic
   * non-waterfall stretch squarely inside `targetRegionId`.
   * IMPORTANT: NEVER calls `this.river.updateWindow()` inside a probe loop (which would
   * prune earlier spline nodes and collapse camera framing if falling back to `minStartS`).
   */
  private findRegionStartS(targetRegionId: string, minStartS: number = 6): number {
    const leg0 = this.river.getLegAtS(minStartS);
    if (!leg0) return minStartS;

    const isPureTargetSample = (localS: number): boolean => {
      const wwSample = earthWorld.sampleWaterway(leg0.waterwayId, localS);
      if (wwSample.isWaterfall) return false;
      const geoReg = earthWorld.getBlendedRegionAt(wwSample.lat, wwSample.lng);
      return geoReg.primaryZone.id === targetRegionId && geoReg.blend < 0.08;
    };

    const startLocalS = Math.max(0, minStartS - leg0.startS);
    if (isPureTargetSample(startLocalS)) {
      return minStartS;
    }

    // Read-only forward probe along leg 0 (zero spline mutation or node pruning)
    const maxScanS = Math.max(minStartS + 10, leg0.endS - 48);
    for (let probeS = minStartS + 10; probeS <= maxScanS; probeS += 10) {
      const localS = Math.max(0, probeS - leg0.startS);
      if (isPureTargetSample(localS)) {
        return probeS;
      }
    }

    // Fallback: pick the non-waterfall stretch along leg 0 whose primary geographic zone
    // matches `targetRegionId` (lowest blend) without ever pruning the spline window.
    let bestS = minStartS;
    let bestBlend = Infinity;
    for (let probeS = minStartS; probeS <= maxScanS; probeS += 10) {
      const localS = Math.max(0, probeS - leg0.startS);
      const wwSample = earthWorld.sampleWaterway(leg0.waterwayId, localS);
      if (wwSample.isWaterfall) continue;
      const geoReg = earthWorld.getBlendedRegionAt(wwSample.lat, wwSample.lng);
      if (geoReg.primaryZone.id === targetRegionId && geoReg.blend < bestBlend) {
        bestBlend = geoReg.blend;
        bestS = probeS;
      }
    }
    return bestS;
  }

  private prepareTitleScene(): void {
    this.showcaseNoCrashTimer = 0;
    this.showcaseSpookHoldTimer = 0;
    this.river.setStartWaterway(this.activeStartTargetId, this.activeRouteMode);
    this.river.reset(202607);
    this.river.updateWindow(0);

    const targetZone = earthWorld.getWaterwayById(this.activeStartTargetId)
      ? earthWorld.getZoneById(earthWorld.getWaterwayById(this.activeStartTargetId)!.regionId)
      : earthWorld.getZoneById(this.activeStartTargetId);
    const startS = this.findRegionStartS(targetZone.id, 6);
    this.river.updateWindow(startS);
    if (startS > 40) {
      this.river.recenterOriginAt(startS);
    }

    const startSample = this.river.sampleAt(startS);
    this.lastActiveRegionId = startSample.regionId ?? startSample.trackId ?? 'pnw-creek';

    this.obstacleSpawner.reset(202607 + 17);
    this.collectibles.reset(202607 + 41);
    this.wildlife.reset(202607 + 99);
    this.environment.reset();
    this.waterMesh.reset();
    this.underwaterFx.reset();
    this.clearMeniscusSafely();
    this.particles.reset();
    this.duckController.reset(startS);
    this.runStartS = startS;
    this.lastTrackedS = startS;
    this.activeCallout = null;
    this.calloutRemaining = 0;
    this.hud.resetTransientUi();

    const state = this.duckController.getState();
    this.obstacleSpawner.update(state.s, this.elapsedTime);
    this.collectibles.update(state, 0.016, this.elapsedTime);
    this.wildlife.update(state, 0.016, this.elapsedTime);
    this.cameraRig.snapToDuck(state, this.river);
    applyDuckRigPose(this.duckRig, state);

    if (startSample.lat !== undefined && startSample.lng !== undefined) {
      this.hud.setLivePosition(startSample.lat, startSample.lng, startSample.waterwayId);
    }
  }

  private resetWorldForRun(seed: number, minStartS: number = 6): void {
    this.inputOverride = null;
    this.showcaseNoCrashTimer = 0;
    this.showcaseSpookHoldTimer = 0;
    this.inputManager.reset();
    this.river.setStartWaterway(this.activeStartTargetId, this.activeRouteMode);
    this.river.reset(seed);
    this.river.updateWindow(0);

    const targetZone = earthWorld.getWaterwayById(this.activeStartTargetId)
      ? earthWorld.getZoneById(earthWorld.getWaterwayById(this.activeStartTargetId)!.regionId)
      : earthWorld.getZoneById(this.activeStartTargetId);
    const startS = this.findRegionStartS(targetZone.id, minStartS);
    this.river.updateWindow(startS);
    if (startS > 40) {
      this.river.recenterOriginAt(startS);
    }

    const startSample = this.river.sampleAt(startS);
    this.lastActiveRegionId = startSample.regionId ?? startSample.trackId ?? 'pnw-creek';

    this.obstacleSpawner.reset(seed + 17);
    this.collectibles.reset(seed + 41);
    this.wildlife.reset(seed + 99);
    this.environment.reset();
    this.waterMesh.reset();
    this.underwaterFx.reset();
    this.clearMeniscusSafely();
    this.particles.reset();
    this.duckController.reset(startS);

    this.score = 0;
    this.isNewBest = false;
    this.coins = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.cavesCleared = 0;
    this.waterfallsCleared = 0;
    this.crashReason = undefined;
    this.runStartS = startS;
    this.lastTrackedS = startS;
    this.activeCallout = null;
    this.calloutRemaining = 0;
    this.prevFlightActive = false;
    this.prevBreathBoostActive = false;
    this.prevMagnetActive = false;
    this.hud.resetTransientUi();

    const state = this.duckController.getState();
    this.obstacleSpawner.update(state.s, this.elapsedTime);
    this.collectibles.update(state, 0.016, this.elapsedTime);
    this.wildlife.update(state, 0.016, this.elapsedTime);
    this.cameraRig.snapToDuck(state, this.river);
    applyDuckRigPose(this.duckRig, state);

    if (startSample.lat !== undefined && startSample.lng !== undefined) {
      this.hud.setLivePosition(startSample.lat, startSample.lng, startSample.waterwayId);
    }
  }

  private applyQualityToSubsystems(resolved: ResolvedQuality): void {
    this.resolvedQuality = resolved;
    const preset = QUALITY_PRESETS[resolved];
    const dpr = Math.min(window.devicePixelRatio || 1, preset.maxPixelRatio, 2);

    this.renderer.setPixelRatio(dpr);
    this.renderer.shadowMap.enabled = preset.shadowsEnabled;
    this.renderer.shadowMap.needsUpdate = true;

    this.environment.setQuality(resolved);
    this.waterMesh.setQuality(resolved);
    this.underwaterFx.setQuality(resolved);
    this.particles.setQuality(resolved);
    this.particles.setPixelRatio(dpr);
    this.obstacleSpawner.setQuality(resolved);
    this.collectibles.setQuality(resolved);
    this.wildlife.setQuality(resolved);
  }

  private readonly handleResize = (): void => {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const aspect = width / height;

    const preset = QUALITY_PRESETS[this.resolvedQuality];
    const dpr = Math.min(window.devicePixelRatio || 1, preset.maxPixelRatio, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.particles.setPixelRatio(dpr);
    this.cameraRig.setAspect(aspect);
  };

  private readonly handleWindowBlur = (): void => {
    if (this.gameState === 'playing') {
      this.pause();
    }
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden && this.gameState === 'playing') {
      this.pause();
    }
  };

  private readonly tick = (nowMs: number): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.tick);

    const rawDtMs = Math.max(1, nowMs - this.lastFrameMs);
    this.lastFrameMs = nowMs;
    const dt = Math.min(rawDtMs / 1000, 0.05);

    this.updatePerformanceMetrics(rawDtMs);
    this.stepSimulationAndRender(dt);
  };

  private updatePerformanceMetrics(rawDtMs: number): void {
    const clampedMs = Math.min(rawDtMs, 100);
    const instFps = 1000 / Math.max(4, clampedMs);
    this.smoothedFps += (instFps - this.smoothedFps) * 0.08;

    if (this.qualitySetting !== 'auto' || rawDtMs > 120) return;

    this.adaptiveWindowFrames += 1;
    this.adaptiveWindowTimeMs += rawDtMs;

    if (this.adaptiveWindowFrames >= 90) {
      const avgMs = this.adaptiveWindowTimeMs / this.adaptiveWindowFrames;
      this.adaptiveWindowFrames = 0;
      this.adaptiveWindowTimeMs = 0;

      if (avgMs > 25.5 && this.resolvedQuality === 'high') {
        this.slowWindowsStreak += 1;
        this.fastWindowsStreak = 0;
        if (this.slowWindowsStreak >= 2) {
          this.slowWindowsStreak = 0;
          this.applyQualityToSubsystems('performance');
        }
      } else if (avgMs < 14.5 && this.resolvedQuality === 'performance') {
        this.fastWindowsStreak += 1;
        this.slowWindowsStreak = 0;
        if (this.fastWindowsStreak >= 4) {
          this.fastWindowsStreak = 0;
          this.applyQualityToSubsystems('high');
        }
      } else {
        this.slowWindowsStreak = 0;
        this.fastWindowsStreak = 0;
      }
    }
  }

  private stepSimulationAndRender(dt: number): void {
    const isPaused = this.gameState === 'paused';
    const simDt = isPaused ? 0 : dt;
    if (!isPaused) {
      this.elapsedTime += dt;
    }

    // Read unified input (plus any QA override)
    this.inputManager.update(dt);
    const baseInput = this.inputManager.getState();
    const input: InputState = this.inputOverride
      ? { ...baseInput, ...this.inputOverride }
      : baseInput;

    // Handle edge-latched pause/restart inputs
    if (this.inputManager.consumePause()) {
      if (this.gameState === 'playing') this.pause();
      else if (this.gameState === 'paused') this.resume();
    }
    if (this.inputManager.consumeRestart() && this.gameState === 'gameover') {
      this.restartRun();
    }

    let duckState = this.duckController.getState();
    let rapidsTurbulence = 0.25;

    if (this.gameState === 'title') {
      duckState = this.duckController.updateTitleIdle(simDt, this.elapsedTime);
      this.river.updateWindow(duckState.s);
      this.obstacleSpawner.update(
        duckState.s,
        this.elapsedTime,
        this.cameraRig.getState().position,
      );
      this.collectibles.update(duckState, simDt, this.elapsedTime);
      this.wildlife.update(duckState, simDt, this.elapsedTime);
    } else if (this.gameState === 'playing') {
      const nearbyObs = this.obstacleSpawner.getObstaclesInRange(
        duckState.s - 12,
        duckState.s + 28,
      );
      const stepRes = this.duckController.update(
        simDt,
        this.elapsedTime,
        input,
        nearbyObs,
      );
      duckState = stepRes.state;
      rapidsTurbulence = stepRes.hydro.turbulence;

      this.river.updateWindow(duckState.s);
      this.obstacleSpawner.update(
        duckState.s,
        this.elapsedTime,
        this.cameraRig.getState().position,
      );

      // Lazily prioritize upcoming connected waterways' assets when approaching any fork or leg end!
      const liveSample = this.river.sampleAt(duckState.s);
      if (liveSample.upcomingFork) {
        this.preloadAssetsOnce(
          `ww:${liveSample.upcomingFork.leftBranchId}`,
          earthWorld.getWaterwayAssets(liveSample.upcomingFork.leftBranchId, false),
        );
        this.preloadAssetsOnce(
          `ww:${liveSample.upcomingFork.rightBranchId}`,
          earthWorld.getWaterwayAssets(liveSample.upcomingFork.rightBranchId, false),
        );
      }

      // Track region transition fallback
      const liveRegionId = liveSample.regionId ?? liveSample.trackId;
      if (liveRegionId && liveRegionId !== this.lastActiveRegionId) {
        this.lastActiveRegionId = liveRegionId;
        const alreadyInEvents = stepRes.events.some(
          (e) => e.type === 'track_transition',
        );
        if (!alreadyInEvents) {
          const z = earthWorld.getZoneById(liveRegionId);
          this.sound.emit('track_transition', {
            trackId: z.id,
            trackName: z.name,
          });
        }
      }

      // Distance score
      const deltaS = Math.max(0, duckState.s - this.lastTrackedS);
      this.lastTrackedS = duckState.s;
      this.score += deltaS * SCORING_CONFIG.distancePointsPerUnit;

      // Combo decay
      if (this.comboTimer > 0) {
        this.comboTimer = Math.max(0, this.comboTimer - simDt);
        if (this.comboTimer <= 0) {
          this.combo = 1;
        }
      }

      // Callout decay
      if (this.calloutRemaining > 0) {
        this.calloutRemaining = Math.max(0, this.calloutRemaining - simDt);
        if (this.calloutRemaining <= 0) {
          this.activeCallout = null;
        }
      }

      // Process physics/locomotion/fork/transition events from DuckController
      this.handleDuckEvents(stepRes.events);

      // Track power-up expirations for audio polish
      this.checkPowerUpExpirations(duckState);

      // Showcase helper timers
      if (this.showcaseNoCrashTimer > 0) {
        this.showcaseNoCrashTimer = Math.max(0, this.showcaseNoCrashTimer - simDt);
      }
      if (this.showcaseSpookHoldTimer > 0) {
        this.showcaseSpookHoldTimer = Math.max(0, this.showcaseSpookHoldTimer - simDt);
        this.duckController.triggerSpook(0.95);
      }

      // Check obstacle collisions & lily-pad bounces
      const collision =
        this.showcaseNoCrashTimer > 0
          ? null
          : this.obstacleSpawner.checkDuckCollision(duckState);
      if (collision) {
        if (collision.kind === 'lily_bounce') {
          this.duckController.triggerBouncePad(10.8, 2.8);
          this.particles.emitSplash(duckState.worldPos, 0.55, 'jump');
          this.awardComboBonus(40, 'LILY BOUNCE!', 'bonus');
        } else {
          const outcome = this.duckController.handleObstacleCollision(collision.obstacle);
          if (outcome === 'shield_absorbed') {
            this.particles.emitShieldPop(duckState.worldPos);
            this.cameraRig.triggerShake(0.68);
            this.pushCallout('SOAP SHIELD!', 'powerup', 1.6);
          } else if (outcome === 'crashed') {
            this.particles.emitSplash(duckState.worldPos, 0.92, 'land');
            this.cameraRig.triggerShake(0.95);
            this.triggerGameOver(
              formatCrashReason(collision.obstacle.type, collision.obstacle),
            );
          }
        }
      }

      // Evaluate near-misses & clean jump/dive obstacle clears
      if (this.gameState === 'playing') {
        const interactions = this.obstacleSpawner.evaluateDuckInteractions(duckState);
        for (let i = 0; i < interactions.length; i++) {
          const evt = interactions[i];
          if (evt.kind === 'near_miss') {
            this.duckController.triggerSpook(evt.isSkim ? 0.96 : 0.72);
            this.bumpCombo();
            this.score += SCORING_CONFIG.nearMissPoints * this.combo;
            this.sound.emit('near_miss', { combo: this.combo });
            this.particles.emitCollectBurst(evt.worldPos, 0xfff0a0, 10);
            this.pushCallout(
              evt.isSkim ? `WOAH! CLOSE CALL x${this.combo}` : `NEAR MISS x${this.combo}`,
              'bonus',
              1.35,
            );
          } else if (evt.kind === 'log_dive_clear') {
            if (evt.isSkim) {
              this.duckController.triggerSpook(0.66);
            }
            this.awardComboBonus(
              SCORING_CONFIG.logDiveBonusPoints,
              evt.isSkim ? 'SKIM DIVE!' : 'CLEAN DIVE!',
              'bonus',
            );
          } else if (evt.kind === 'log_jump_clear') {
            if (evt.isSkim) {
              this.duckController.triggerSpook(0.62);
            }
            this.awardComboBonus(
              SCORING_CONFIG.logJumpBonusPoints,
              evt.isSkim ? 'CLOSE HOP!' : 'CLEAN HOP!',
              'bonus',
            );
          }
        }
      }

      // Update collectibles & process pickups
      const collected = this.collectibles.update(duckState, simDt, this.elapsedTime);
      for (let i = 0; i < collected.length; i++) {
        const c = collected[i];
        this.bumpCombo();
        this.score += c.item.value * this.combo;

        if (c.isPowerUp && c.item.powerUpType) {
          const pType = c.item.powerUpType;
          this.duckController.activatePowerUp(pType);
          this.sound.emit('powerup_pickup', { powerUp: pType });
          const hex = new THREE.Color(POWERUP_CONFIG[pType].color).getHex();
          this.particles.emitCollectBurst(c.worldPos, hex, 24);
          if (pType === 'wing_gust') {
            this.collectibles.spawnSkyFlightArc(duckState.s + 18);
          }
          this.pushCallout(`${POWERUP_CONFIG[pType].label.toUpperCase()}!`, 'powerup', 1.85);
        } else {
          this.coins += c.item.kind === 'golden_feather' ? 3 : 1;
          this.sound.emit('collect', { kind: c.item.kind, combo: this.combo });
          this.particles.emitCollectBurst(
            c.worldPos,
            c.item.kind === 'golden_feather' ? 0xffd23f : 0xffe985,
            c.item.kind === 'golden_feather' ? 20 : 10,
          );
          if (c.item.kind === 'golden_feather') {
            this.pushCallout(`GOLDEN FEATHER +${c.item.value * this.combo}`, 'bonus', 1.3);
          }
        }
      }

      // Live best tracking during active gameplay
      if (this.showcaseNoCrashTimer <= 0) {
        if (this.score > this.highScore) {
          this.highScore = Math.floor(this.score);
          this.isNewBest = true;
        }
        const distM = Math.max(
          0,
          Math.floor((duckState.s - this.runStartS) * SCALE.DISPLAY_METERS_PER_UNIT),
        );
        if (distM > this.bestDistanceMeters) {
          this.bestDistanceMeters = distM;
        }
      }

      // Update ambient wildlife
      this.wildlife.update(duckState, simDt, this.elapsedTime);
    } else if (this.gameState === 'gameover') {
      const neutralInput: InputState = {
        steer: 0,
        steerDelta: 0,
        jumpPressed: false,
        jumpHeld: false,
        diveHeld: false,
        diveJustPressed: false,
        diveJustReleased: false,
        pausePressed: false,
        pointerActive: false,
        inputDevice: input.inputDevice,
      };
      const stepRes = this.duckController.update(simDt, this.elapsedTime, neutralInput, []);
      duckState = stepRes.state;
      this.wildlife.update(duckState, simDt, this.elapsedTime);
    }

    // Apply articulated DuckRig animations + visual power-up auras
    applyDuckRigPose(this.duckRig, duckState);
    this.updateDuckAuras(duckState, this.elapsedTime);

    // Update Camera Rig (tracks underwater submersion + canyon/landmark + Y-fork overview framing!)
    const camState = this.cameraRig.update(
      simDt,
      this.elapsedTime,
      this.gameState,
      duckState,
      this.river,
      rapidsTurbulence,
    );
    this.lastCamState = camState;

    // Update Data-Driven Spatial Procedural Audio Ambience (using real lat/lng!)
    this.updateAudioAmbience(duckState, camState, rapidsTurbulence, dt);

    // -------------------------------------------------------------------------
    // Exact Per-Frame Rendering Sync Order:
    //   1. Environment (data-driven sky, aurora, lightning, terrain, caves, dynamic pools, shared EarthLandmarks)
    //   2. Sync sun & exposure to Renderer, UnderwaterFx & WaterMesh
    //   3. UnderwaterFx (spatial caustics, volumetric god-rays, underwater fog, meniscus)
    //   4. WaterMesh (main river + visible physical Y-fork branch water ribbon!)
    //   5. ParticleSystem (data-driven WeatherParams + splashes, bubbles, steam)
    // -------------------------------------------------------------------------
    const prevSubBlend = this.underwaterFx.getSubmersionBlend();
    this.environment.update({
      time: this.elapsedTime,
      river: this.river,
      duckState,
      cameraPos: this.camera.position,
      cameraSubmergedBlend: prevSubBlend,
    });
    this.renderer.toneMappingExposure = this.environment.currentExposure;

    this.underwaterFx.setSunDirection(this.environment.sunDirection);
    this.underwaterFx.setSunColor(this.environment.sunLight.color);
    this.waterMesh.setSunDirection(this.environment.sunDirection);

    this.underwaterFx.update({
      dt: simDt,
      time: this.elapsedTime,
      cameraSubmerged: camState.cameraSubmerged,
      submersionDepth: camState.cameraSubmersionDepth,
      meniscusPulse: camState.meniscusPulse,
      inCave: Boolean(duckState.inCave),
      breath: duckState.breath,
      duckState,
      river: this.river,
      scene: this.scene,
      surfaceFogColor: this.environment.currentFogColor,
      surfaceFogNear: this.environment.currentFogNear,
      surfaceFogFar: this.environment.currentFogFar,
    });

    const subBlend = this.underwaterFx.getSubmersionBlend();
    const uRange = this.underwaterFx.getUnderwaterFogRange();
    this.waterMesh.setUnderwaterState(
      subBlend,
      this.underwaterFx.getUnderwaterFogColor(),
      uRange.near,
      uRange.far,
    );

    const activeObstacles = this.obstacleSpawner.getObstaclesInRange(
      duckState.s - 25,
      duckState.s + 135,
    );
    this.waterMesh.update(
      this.elapsedTime,
      this.river,
      duckState,
      activeObstacles,
      subBlend,
    );

    this.particles.update(
      simDt,
      this.elapsedTime,
      duckState,
      this.river,
      this.camera.position,
      camState.cameraSubmerged,
    );

    // Render frame & collect GPU stats
    this.renderer.render(this.scene, this.camera);
    this.lastDrawCalls = this.renderer.info.render.calls;
    this.lastTriangles = this.renderer.info.render.triangles;

    // Push immutable snapshot (with live lat/lng GPS, waterway, and physical fork signpost!) to HUD
    this.pushHudSnapshot(duckState);
  }

  private handleDuckEvents(events: DuckEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      switch (evt.type) {
        case 'jump':
          this.particles.emitSplash(evt.worldPos, 0.55 * evt.intensity, 'jump');
          break;
        case 'dive_enter':
          this.particles.emitSplash(evt.worldPos, 0.72 * evt.intensity, 'dive');
          this.particles.emitBubbleBurst(evt.worldPos, 12);
          this.underwaterFx.triggerMeniscus('enter', 0.85);
          break;
        case 'dive_exit':
          this.particles.emitSplash(evt.worldPos, 0.68 * evt.intensity, 'breach');
          this.particles.emitBubbleBurst(evt.worldPos, 10);
          this.underwaterFx.triggerMeniscus('exit', 0.9);
          break;
        case 'splash': {
          const kind =
            evt.detail === 'waterfall'
              ? 'waterfall'
              : evt.detail === 'skim'
                ? 'jump'
                : 'land';
          this.particles.emitSplash(evt.worldPos, evt.intensity, kind);
          break;
        }
        case 'waterfall_lip':
          this.pushCallout('WATERFALL DROP!', 'info', 1.5);
          break;
        case 'waterfall_land':
          this.waterfallsCleared += 1;
          this.cameraRig.triggerWaterfallLandingShake(evt.intensity);
          this.awardComboBonus(
            SCORING_CONFIG.waterfallClearPoints,
            'WATERFALL CLEARED!',
            'bonus',
          );
          break;
        case 'cave_enter':
          this.particles.emitBubbleBurst(evt.worldPos, 16);
          this.pushCallout('CAVE SHORTCUT!', 'powerup', 2.0);
          break;
        case 'cave_exit':
          this.cavesCleared += 1;
          this.particles.emitSplash(evt.worldPos, 0.85, 'land');
          this.awardComboBonus(
            SCORING_CONFIG.caveClearPoints,
            'GROTTO BONUS!',
            'bonus',
          );
          break;
        case 'wing_flap':
          this.particles.emitWingFlapGust(evt.worldPos, evt.intensity);
          break;
        case 'shield_break':
          this.particles.emitShieldPop(evt.worldPos);
          this.cameraRig.triggerShake(0.65);
          break;
        case 'spook':
          this.particles.emitSplash(evt.worldPos, 0.35, 'jump');
          break;
        case 'bank_bounce':
          this.particles.emitSplash(evt.worldPos, 0.42, 'jump');
          this.cameraRig.triggerShake(0.28);
          break;
        case 'breath_low':
          this.pushCallout('BREATH LOW — SURFACE!', 'warning', 1.1);
          break;
        case 'track_transition': {
          const nextZone = earthWorld.getZoneById(evt.detail);
          this.lastActiveRegionId = nextZone.id;
          this.sound.emit('track_transition', {
            trackId: nextZone.id,
            trackName: nextZone.name,
          });
          this.particles.emitCollectBurst(evt.worldPos, 0xffe680, 18);
          break;
        }
        case 'fork_taken': {
          const ww = evt.detail ? earthWorld.getWaterwayById(evt.detail) : undefined;
          if (ww) {
            this.particles.emitCollectBurst(evt.worldPos, 0x6bf5ff, 14);
            this.pushCallout(`ENTERING ${ww.name.toUpperCase()}`, 'info', 1.8);
          }
          break;
        }
        case 'crash':
          break;
      }
    }
  }

  private checkPowerUpExpirations(duck: DuckState): void {
    const flightNow = duck.flightRemaining > 0;
    const breathNow = duck.breathBoostRemaining > 0;
    const magnetNow = duck.magnetRemaining > 0;

    if (this.prevFlightActive && !flightNow) {
      this.sound.emit('powerup_expire', { powerUp: 'wing_gust' });
    }
    if (this.prevBreathBoostActive && !breathNow) {
      this.sound.emit('powerup_expire', { powerUp: 'bubble_lung' });
    }
    if (this.prevMagnetActive && !magnetNow) {
      this.sound.emit('powerup_expire', { powerUp: 'magnet' });
    }

    this.prevFlightActive = flightNow;
    this.prevBreathBoostActive = breathNow;
    this.prevMagnetActive = magnetNow;
  }

  private bumpCombo(): void {
    this.combo = Math.min(SCORING_CONFIG.maxComboMultiplier, this.combo + 1);
    this.comboTimer = SCORING_CONFIG.comboTimeoutSeconds;
  }

  private awardComboBonus(
    basePoints: number,
    label: string,
    tone: HudCallout['tone'],
  ): void {
    this.bumpCombo();
    const awarded = basePoints * this.combo;
    this.score += awarded;
    this.pushCallout(`${label} +${awarded}`, tone, 1.5);
  }

  private pushCallout(
    text: string,
    tone: HudCallout['tone'],
    durationSec: number,
  ): void {
    this.activeCallout = {
      id: ++this.calloutSeq,
      text,
      tone,
    };
    this.calloutRemaining = durationSec;
  }

  private triggerGameOver(reason: string): void {
    if (this.gameState === 'gameover') return;
    this.gameState = 'gameover';
    this.crashReason = reason;

    const finalScore = Math.floor(this.score);
    const finalDist = Math.max(
      0,
      Math.floor((this.duckController.getState().s - this.runStartS) * SCALE.DISPLAY_METERS_PER_UNIT),
    );

    if (finalScore >= this.highScore) {
      this.highScore = finalScore;
      writeStoredValue(STORAGE_HIGH_SCORE_KEY, String(finalScore));
    }
    if (finalDist >= this.bestDistanceMeters) {
      this.bestDistanceMeters = finalDist;
      writeStoredValue(STORAGE_BEST_DIST_KEY, String(finalDist));
    }

    this.sound.emit('game_over', {
      score: finalScore,
      isNewBest: this.isNewBest,
    });
  }

  private updateDuckAuras(duck: DuckState, time: number): void {
    this.duckAuras.shieldMesh.visible = duck.shieldActive;
    if (duck.shieldActive) {
      const pulse = 1.0 + Math.sin(time * 5.0) * 0.04;
      this.duckAuras.shieldMesh.scale.setScalar(pulse);
      this.duckAuras.shieldMesh.rotation.y = time * 1.1;
    }

    const flying = duck.flightRemaining > 0;
    this.duckAuras.flightGroup.visible = flying;
    if (flying) {
      this.duckAuras.flightGroup.rotation.y = time * 5.4;
      this.duckAuras.flightGroup.rotation.z = Math.sin(time * 4.0) * 0.14;
      this.duckAuras.flightGroup.scale.setScalar(1.0 + Math.sin(time * 7.5) * 0.08);
    }

    const breathBoost = duck.breathBoostRemaining > 0;
    this.duckAuras.breathGroup.visible = breathBoost;
    if (breathBoost) {
      this.duckAuras.breathGroup.rotation.y = -time * 3.2;
    }

    const magnet = duck.magnetRemaining > 0;
    this.duckAuras.magnetGroup.visible = magnet;
    if (magnet) {
      this.duckAuras.magnetGroup.rotation.y = time * 5.0;
      this.duckAuras.magnetGroup.scale.setScalar(1.02 + Math.sin(time * 6.0) * 0.1);
    }
  }

  private updateAudioAmbience(
    duck: DuckState,
    camState: CameraRigState,
    rapidsTurbulence: number,
    dt: number,
  ): void {
    const sample = this.river.sampleAt(duck.s);
    const nextWf = this.river.getNextWaterfall(duck.s);
    let wfProximity = sample.isWaterfall ? 1.0 : 0.0;
    if (nextWf && wfProximity < 1.0) {
      const distToWf = Math.max(0, nextWf.startS - duck.s);
      wfProximity = Math.max(wfProximity, Math.max(0, 1 - distToWf / 75));
    }

    const submersion = Math.max(
      camState.cameraSubmerged ? 1.0 : 0.0,
      Math.min(1, duck.submersionDepth / 0.9),
    );
    const airborneFactor =
      duck.mode === 'flying'
        ? 1.0
        : duck.mode === 'waterfall'
          ? 0.75
          : duck.mode === 'airborne'
            ? 0.45
            : 0.0;

    this.sound.updateAmbience(
      {
        speed: this.gameState === 'playing' ? duck.speed : DUCK_CONFIG.baseSpeed * 0.45,
        rapidsIntensity: Math.max(sample.rapidsIntensity, rapidsTurbulence),
        submersion: this.gameState === 'paused' ? 0 : submersion,
        inCave: Boolean(duck.inCave),
        waterfallProximity: wfProximity,
        biomeIndex: sample.biomeIndex,
        airborneFactor,
        lat: sample.lat,
        lng: sample.lng,
        trackId: sample.regionId ?? sample.trackId,
        nextTrackId: sample.secondaryRegionId ?? sample.nextTrackId,
        trackBlend: sample.regionBlend ?? sample.trackBlend ?? 0,
      },
      dt,
    );
  }

  private pushHudSnapshot(duck: DuckState): void {
    const sample = this.river.sampleAt(duck.s);
    const blendedRegion = this.river.getBlendedRegionAtS(duck.s);
    const currentZone = blendedRegion.primaryZone;
    const leg = this.river.getLegAtS(duck.s);
    const legProgress = leg
      ? THREE.MathUtils.clamp((duck.s - leg.startS) / Math.max(1, leg.lengthU), 0, 1)
      : 0;
    const activeWaterway = sample.waterwayId
      ? earthWorld.getWaterwayById(sample.waterwayId)
      : undefined;

    // Resolve next destination region name for HUD expedition progress bar
    let nextDestName: string | undefined;
    if (this.activeRouteMode !== 'single_track') {
      if (sample.upcomingFork) {
        nextDestName =
          sample.upcomingFork.selectedSide === 'left'
            ? sample.upcomingFork.leftRegionName
            : sample.upcomingFork.selectedSide === 'right'
              ? sample.upcomingFork.rightRegionName
              : `${sample.upcomingFork.leftRegionName} / ${sample.upcomingFork.rightRegionName}`;
      } else if (leg) {
        const nextLeg = this.river.getLegAtS(leg.endS + 2);
        if (nextLeg && nextLeg.regionId !== currentZone.id) {
          nextDestName = earthWorld.getZoneById(nextLeg.regionId).name;
        } else if (activeWaterway) {
          const targetZone = earthWorld.resolveTargetRegionForWaterway(activeWaterway);
          if (targetZone.id !== currentZone.id) {
            nextDestName = targetZone.name;
          }
        }
      }
    }

    const activePowerUps: ActivePowerUpHud[] = [];
    if (duck.flightRemaining > 0) {
      activePowerUps.push({
        type: 'wing_gust',
        remaining: duck.flightRemaining,
        duration: POWERUP_CONFIG.wing_gust.duration,
        normalized: Math.min(1, duck.flightRemaining / POWERUP_CONFIG.wing_gust.duration),
      });
    }
    if (duck.breathBoostRemaining > 0) {
      activePowerUps.push({
        type: 'bubble_lung',
        remaining: duck.breathBoostRemaining,
        duration: POWERUP_CONFIG.bubble_lung.duration,
        normalized: Math.min(1, duck.breathBoostRemaining / POWERUP_CONFIG.bubble_lung.duration),
      });
    }
    const shieldRem = this.duckController.getShieldRemaining();
    if (duck.shieldActive && shieldRem > 0) {
      activePowerUps.push({
        type: 'soap_shield',
        remaining: shieldRem,
        duration: POWERUP_CONFIG.soap_shield.duration,
        normalized: Math.min(1, shieldRem / POWERUP_CONFIG.soap_shield.duration),
      });
    }
    if (duck.magnetRemaining > 0) {
      activePowerUps.push({
        type: 'magnet',
        remaining: duck.magnetRemaining,
        duration: POWERUP_CONFIG.magnet.duration,
        normalized: Math.min(1, duck.magnetRemaining / POWERUP_CONFIG.magnet.duration),
      });
    }

    const speedNorm = THREE.MathUtils.clamp(
      (duck.speed - DUCK_CONFIG.baseSpeed * 0.7) /
        (DUCK_CONFIG.maxSpeed * 1.15 - DUCK_CONFIG.baseSpeed * 0.7),
      0,
      1,
    );

    const snapshot: HudSnapshot = {
      gameState: this.gameState,
      score: Math.floor(this.score),
      highScore: Math.max(this.highScore, Math.floor(this.score)),
      distanceMeters: Math.max(
        0,
        Math.floor((duck.s - this.runStartS) * SCALE.DISPLAY_METERS_PER_UNIT),
      ),
      coins: this.coins,
      combo: this.combo,
      comboTimer: this.combo > 1 ? this.comboTimer / SCORING_CONFIG.comboTimeoutSeconds : 0,
      speedNormalized: speedNorm,
      mode: duck.mode,
      breath: duck.breath,
      isUnderwater: duck.isUnderwater,
      inCave: Boolean(duck.inCave),
      biomeIndex: earthWorld.getZoneIndex(currentZone.id),
      biomeName: currentZone.name,
      shieldActive: duck.shieldActive,
      activePowerUps,
      quality: this.qualitySetting,
      resolvedQuality: this.resolvedQuality,
      muted: this.sound.isMuted(),
      fps: Math.round(this.smoothedFps),
      assetsLoadedRatio: this.assetsLoadedRatio,
      controlsHintVisible: this.gameState === 'playing' && duck.s < 110,
      crashReason: this.crashReason,
      callout: this.activeCallout,
      routeMode: this.activeRouteMode,
      currentTrackId: currentZone.id,
      currentTrackName: currentZone.name,
      currentTrackRegion: `${currentZone.region}, ${currentZone.country}`,
      nextTrackName: nextDestName,
      weatherLabel: blendedRegion.weather.label,
      trackProgress: legProgress,
      visitedTrackIds: this.river.getVisitedRegionIds(duck.s),
      lat: sample.lat,
      lng: sample.lng,
      waterwayId: sample.waterwayId ?? leg?.waterwayId,
      waterwayName: activeWaterway?.name ?? leg?.waterwayName ?? currentZone.name,
      upcomingFork: this.gameState === 'playing' ? (sample.upcomingFork ?? null) : null,
    };

    this.hud.update(snapshot, {
      drawCalls: this.lastDrawCalls,
      cavesCleared: this.cavesCleared,
      waterfallsCleared: this.waterfallsCleared,
      bestDistanceMeters: this.bestDistanceMeters,
      isNewBest: this.isNewBest,
    });
  }

  /**
   * Expose comprehensive QA & visual verification handle on `window.__riverDucker`
   * covering Shared Physical Mini-Earth (`getWorldInfo`, `setTrack`, `setForkChoice`,
   * `openGlobe`, `getTracks`, `showcase('fork')`, `showcase('obstacles')`, and all 37 models).
   */
  private exposeDebugHandle(): void {
    const collectModelTelemetry = (): {
      models: Record<
        string,
        {
          isFallback: boolean;
          triangles: number;
          byteSize: number;
          size: { x: number; y: number; z: number };
        }
      >;
      loadedGlbCount: number;
      totalRegisteredAssets: number;
    } => {
      const ids = getRegisteredAssetIds();
      const models: Record<
        string,
        {
          isFallback: boolean;
          triangles: number;
          byteSize: number;
          size: { x: number; y: number; z: number };
        }
      > = {};
      let loadedGlbCount = 0;
      for (const id of ids) {
        const asset = assetLoader.get(id);
        if (!asset.isFallback) loadedGlbCount += 1;
        models[id] = {
          isFallback: asset.isFallback,
          triangles: asset.triangles,
          byteSize: asset.byteSize,
          size: asset.size,
        };
      }
      return {
        models,
        loadedGlbCount,
        totalRegisteredAssets: ids.length,
      };
    };

    const getDebugState = (): Record<string, unknown> => {
      const duck = this.duckController.getState();
      const sample = this.river.sampleAt(duck.s);
      const blendedRegion = this.river.getBlendedRegionAtS(duck.s);
      const currentZone = blendedRegion.primaryZone;
      const leg = this.river.getLegAtS(duck.s);
      const activeWaterway = sample.waterwayId
        ? earthWorld.getWaterwayById(sample.waterwayId)
        : undefined;
      const { models, loadedGlbCount, totalRegisteredAssets } =
        collectModelTelemetry();

      return {
        gameState: this.gameState,
        score: Math.floor(this.score),
        highScore: this.highScore,
        distanceMeters: Math.max(
          0,
          Math.floor((duck.s - this.runStartS) * SCALE.DISPLAY_METERS_PER_UNIT),
        ),
        coins: this.coins,
        combo: this.combo,
        fps: Math.round(this.smoothedFps),
        drawCalls: this.lastDrawCalls,
        triangles: this.lastTriangles,
        quality: this.qualitySetting,
        resolvedQuality: this.resolvedQuality,
        pixelRatio: this.renderer.getPixelRatio(),
        assetsReady: this.assetsReady,
        assetsLoadedRatio: this.assetsLoadedRatio,
        loadedGlbCount,
        totalRegisteredAssets,
        biomeIndex: earthWorld.getZoneIndex(currentZone.id),
        biomeName: currentZone.name,
        trackId: currentZone.id,
        trackName: currentZone.name,
        regionId: currentZone.id,
        regionName: currentZone.name,
        trackRegion: `${currentZone.region}, ${currentZone.country}`,
        lat: sample.lat,
        lng: sample.lng,
        elevation: sample.elevation,
        waterwayId: sample.waterwayId ?? leg?.waterwayId,
        waterwayName: activeWaterway?.name ?? leg?.waterwayName ?? currentZone.name,
        upcomingFork: sample.upcomingFork ?? null,
        forkRibbonVisible: this.waterMesh.isForkRibbonVisible(),
        routeMode: this.activeRouteMode,
        weatherType: blendedRegion.weather.id,
        weatherLabel: blendedRegion.weather.label,
        visitedTrackIds: this.river.getVisitedRegionIds(duck.s),
        globeOpen: this.hud.isGlobeModalOpen(),
        canyonWallFactor: sample.canyonWallFactor ?? blendedRegion.riverProfile.canyonWallFactor,
        caveStyle: sample.caveStyle,
        duckRig: {
          usingGlbBody: this.duckRig.usingGlbBody,
          usingGlbWings: this.duckRig.usingGlbWings,
        },
        duck: { ...duck },
        camera: {
          cameraSubmerged: this.lastCamState.cameraSubmerged,
          cameraSubmersionDepth: this.lastCamState.cameraSubmersionDepth,
          meniscusPulse: this.lastCamState.meniscusPulse,
          fov: this.lastCamState.fov,
          position: { ...this.lastCamState.position },
        },
        activeObstaclesCount: this.obstacleSpawner.getAllObstacles().length,
        activeCollectiblesCount: this.collectibles.getActiveCount(),
        models,
      };
    };

    const getWorldInfo = (): Record<string, unknown> => {
      const duck = this.duckController.getState();
      const sample = this.river.sampleAt(duck.s);
      const blendedRegion = this.river.getBlendedRegionAtS(duck.s);
      const leg = this.river.getLegAtS(duck.s);
      const activeWaterway = sample.waterwayId
        ? earthWorld.getWaterwayById(sample.waterwayId)
        : undefined;
      const { models, loadedGlbCount, totalRegisteredAssets } =
        collectModelTelemetry();

      return {
        validation: earthWorld.validateWorld(),
        lat: sample.lat,
        lng: sample.lng,
        elevation: sample.elevation,
        waterwayId: sample.waterwayId ?? leg?.waterwayId,
        waterwayName: activeWaterway?.name ?? leg?.waterwayName,
        regionId: blendedRegion.primaryZone.id,
        regionName: blendedRegion.primaryZone.name,
        secondaryRegionId: blendedRegion.secondaryZone.id,
        regionBlend: Number(blendedRegion.blend.toFixed(3)),
        routeMode: this.activeRouteMode,
        upcomingFork: sample.upcomingFork ?? null,
        forkRibbonVisible: this.waterMesh.isForkRibbonVisible(),
        globeOpen: this.hud.isGlobeModalOpen(),
        activeWaterwayChain: this.river.getActiveWaterwayChain().map((l) => ({
          index: l.index,
          waterwayId: l.waterwayId,
          regionId: l.regionId,
          startS: Number(l.startS.toFixed(1)),
          endS: Number(l.endS.toFixed(1)),
          isConnector: l.isConnector,
        })),
        dynamicPoolStats: this.environment.getDynamicPoolStats(),
        totalRegisteredAssets,
        loadedGlbCount,
        models,
      };
    };

    const getTracksInfo = (): Record<string, unknown> => {
      const duck = this.duckController.getState();
      const blendedRegion = this.river.getBlendedRegionAtS(duck.s);
      const currentZone = blendedRegion.primaryZone;
      const validation = validateTrackGraph();

      const trackAssetStatus: Record<
        string,
        {
          requiredAssets: AssetId[];
          loadedGlbCount: number;
          totalCount: number;
          allGlbLoaded: boolean;
          assets: Record<
            string,
            { isFallback: boolean; byteSize: number; triangles: number }
          >;
        }
      > = {};

      const tracks = getAllTracks().map((t) => {
        const reqAssets = getTrackAssets(t, true);
        let loadedGlbCount = 0;
        const assetMap: Record<
          string,
          { isFallback: boolean; byteSize: number; triangles: number }
        > = {};
        for (const id of reqAssets) {
          const loaded = assetLoader.get(id);
          if (!loaded.isFallback) loadedGlbCount += 1;
          assetMap[id] = {
            isFallback: loaded.isFallback,
            byteSize: loaded.byteSize,
            triangles: loaded.triangles,
          };
        }
        const status = {
          requiredAssets: reqAssets,
          loadedGlbCount,
          totalCount: reqAssets.length,
          allGlbLoaded: loadedGlbCount === reqAssets.length,
          assets: assetMap,
        };
        trackAssetStatus[t.id] = status;

        return {
          id: t.id,
          name: t.name,
          region: t.region,
          country: t.country,
          subtitle: t.subtitle,
          accentColor: t.accentColor,
          globeColor: t.globeColor,
          difficulty: t.difficulty,
          coordinates: t.coordinates,
          connections: t.connections,
          segmentLength: t.segmentLength,
          weatherType: t.weather.type,
          weatherLabel: getWeatherLabel(t.weather.type),
          groundStyle: t.groundStyle.style,
          caveStyle: t.riverProfile.caveStyle,
          canyonWallFactor: t.riverProfile.canyonWallFactor,
          chimeScale: t.audioProfile.chimeScale,
          allGlbLoaded: status.allGlbLoaded,
          loadedGlbCount: status.loadedGlbCount,
          totalAssetCount: status.totalCount,
        };
      });

      return {
        currentTrackId: currentZone.id,
        currentTrackName: currentZone.name,
        routeMode: this.activeRouteMode,
        weatherType: blendedRegion.weather.id,
        weatherLabel: blendedRegion.weather.label,
        validation,
        earthValidation: earthWorld.validateWorld(),
        tracks,
        trackAssetStatus,
      };
    };

    const setTrackAsync = async (
      regionOrWaterwayId: string,
      routeMode: RouteMode = 'single_track',
    ): Promise<Record<string, unknown>> => {
      const ww = earthWorld.getWaterwayById(regionOrWaterwayId);
      const targetZone = ww
        ? earthWorld.getZoneById(ww.regionId)
        : earthWorld.getZoneById(regionOrWaterwayId);
      const targetId = ww ? ww.id : targetZone.id;

      this.activeRouteMode = routeMode;
      this.activeStartTargetId = targetId;
      this.river.setStartWaterway(targetId, routeMode);
      this.lastActiveRegionId = targetZone.id;
      this.hud.setRouteSelection(routeMode, targetZone.id, false);
      this.hud.closeGlobeModal();

      // Preload hero core + all 10 shared river obstacles + this waterway/region's assets
      await this.preloadRegionAndShared(targetId);
      this.rebuildHeroDuckRig();
      this.environment.refreshAssets();
      this.obstacleSpawner.refreshAssets();
      this.wildlife.refreshAssets();

      // Reset cleanly onto a scenic stretch of this physical Earth waterway in ONE pass
      // (zero backward `updateWindow` or premature node pruning!)
      this.resetWorldForRun(202607, 18);
      this.gameState = 'playing';
      this.inputOverride = null;
      this.showcaseNoCrashTimer = 3.2;
      this.showcaseSpookHoldTimer = 0;

      const scenicS = this.duckController.getState().s;
      this.duckController.teleportTo(scenicS, 0, 0.03, 'surface');
      this.runStartS = scenicS;
      this.lastTrackedS = scenicS;
      this.obstacleSpawner.reset(202607 + 17);
      this.obstacleSpawner.update(scenicS, this.elapsedTime);
      const st = this.duckController.getState();
      this.collectibles.reset(202607 + 41);
      this.collectibles.update(st, 0.016, this.elapsedTime);
      this.wildlife.reset(202607 + 99);
      this.wildlife.update(st, 0.016, this.elapsedTime);
      this.cameraRig.snapToDuck(st, this.river);
      applyDuckRigPose(this.duckRig, st);

      const scenicSample = this.river.sampleAt(scenicS);
      if (scenicSample.lat !== undefined && scenicSample.lng !== undefined) {
        this.hud.setLivePosition(
          scenicSample.lat,
          scenicSample.lng,
          scenicSample.waterwayId,
        );
      }

      for (let i = 0; i < 4; i++) {
        this.stepSimulationAndRender(0.016);
      }
      this.activeCallout = null;
      this.calloutRemaining = 0;
      this.hud.resetTransientUi();
      this.clearMeniscusSafely(false);
      this.stepSimulationAndRender(0.001);

      return getDebugState();
    };

    const openGlobeModal = (open: boolean = true): void => {
      if (open) {
        const sample = this.river.sampleAt(this.duckController.getState().s);
        if (sample.lat !== undefined && sample.lng !== undefined) {
          this.hud.setLivePosition(sample.lat, sample.lng, sample.waterwayId);
        }
        this.hud.openGlobeModal();
      } else {
        this.hud.closeGlobeModal();
      }
      this.stepSimulationAndRender(0.001);
    };

    const runShowcase = (mode: ShowcaseMode): Record<string, unknown> => {
      this.hud.closeGlobeModal();

      // `'fork'` requires connected world mode so a real 2-way physical fork exists!
      if (mode === 'fork' && this.activeRouteMode === 'single_track') {
        this.activeRouteMode = 'world_tour';
        this.river.setStartWaterway(this.activeStartTargetId, 'world_tour');
        const ww = earthWorld.getWaterwayById(this.activeStartTargetId);
        const zone = ww
          ? earthWorld.getZoneById(ww.regionId)
          : earthWorld.getZoneById(this.activeStartTargetId);
        this.hud.setRouteSelection('world_tour', zone.id, false);
      }

      this.resetWorldForRun(202607);
      this.gameState = 'playing';
      this.inputOverride = null;
      this.showcaseNoCrashTimer = mode === 'gameover' ? 0 : 2.8;
      this.showcaseSpookHoldTimer = 0;

      // Base s after `resetWorldForRun` — never jump backward behind pruned spline nodes!
      const baseS = this.duckController.getState().s;

      const ensureAt = (s: number, u: number, y: number, duckMode?: DuckState['mode']): void => {
        const safeS = Math.max(baseS, s);
        this.river.updateWindow(safeS);
        this.duckController.teleportTo(safeS, u, y, duckMode);
        this.runStartS = Math.min(this.runStartS, safeS);
        this.lastTrackedS = safeS;
        this.obstacleSpawner.update(safeS, this.elapsedTime);
        const st = this.duckController.getState();
        this.collectibles.update(st, 0.016, this.elapsedTime);
        this.wildlife.update(st, 0.016, this.elapsedTime);
        this.cameraRig.snapToDuck(st, this.river);
        applyDuckRigPose(this.duckRig, st);
      };

      let warmupFrames = 3;

      switch (mode) {
        case 'surface':
          ensureAt(Math.max(baseS + 8, 34), 0, 0.02, 'surface');
          break;

        case 'turning':
        case 'turning_right':
          ensureAt(Math.max(baseS + 6, 18), -1.6, 0.02, 'surface');
          this.inputOverride = { steer: 0.95 };
          warmupFrames = 12;
          break;

        case 'turning_left':
          ensureAt(Math.max(baseS + 6, 18), 1.6, 0.02, 'surface');
          this.inputOverride = { steer: -0.95 };
          warmupFrames = 12;
          break;

        case 'diving': {
          const diveS = Math.max(baseS + 24, 84);
          this.duckController.activatePowerUp('bubble_lung');
          ensureAt(diveS, 0, -1.95, 'diving');
          this.wildlife.spawnUnderwaterSchoolAt(diveS + 7.5, -0.35, -1.45, 5);
          this.inputOverride = { diveHeld: true };
          warmupFrames = 8;
          break;
        }

        case 'cave': {
          let searchS = Math.max(baseS + 20, 60);
          let cave = this.river.getNextCave(searchS);
          for (let i = 0; i < 8 && !cave; i++) {
            searchS += 140;
            this.river.updateWindow(searchS);
            cave = this.river.getNextCave(searchS - 140);
          }
          if (cave) {
            this.duckController.activatePowerUp('bubble_lung');
            const targetS = cave.startS + 16;
            this.river.updateWindow(targetS);
            const targetU = this.river.getCaveCenterU(cave, targetS);
            ensureAt(targetS, targetU, -1.35, 'diving');
            this.inputOverride = { diveHeld: true };
            warmupFrames = 8;
          }
          break;
        }

        case 'waterfall': {
          let searchS = Math.max(baseS + 20, 60);
          let wf = this.river.getNextWaterfall(searchS);
          for (let i = 0; i < 8 && !wf; i++) {
            searchS += 140;
            this.river.updateWindow(searchS);
            wf = this.river.getNextWaterfall(searchS - 140);
          }
          if (wf) {
            ensureAt(Math.max(baseS, wf.startS + 1.5), 0, 0.15, 'surface');
            warmupFrames = 6;
          }
          break;
        }

        case 'flying': {
          const flyS = Math.max(baseS + 32, 110);
          ensureAt(flyS, 0, 6.1, 'flying');
          this.duckController.activatePowerUp('wing_gust');
          this.collectibles.spawnSkyFlightArc(flyS + 14);
          this.cameraRig.snapToDuck(this.duckController.getState(), this.river);
          warmupFrames = 6;
          break;
        }

        case 'spooked': {
          ensureAt(Math.max(baseS + 6, 18), 0, 0.05, 'surface');
          this.duckController.triggerSpook(1.0);
          this.showcaseSpookHoldTimer = 1.6;
          this.pushCallout('WOAH! BALANCING!', 'bonus', 2.0);
          warmupFrames = 4;
          break;
        }

        case 'jump_log': {
          const scanS = Math.max(baseS + 12, 40);
          this.obstacleSpawner.update(scanS, this.elapsedTime);
          const obs = this.obstacleSpawner
            .getObstaclesInRange(scanS, scanS + 180)
            .find((o) => o.type === 'log_jump' || o.type === 'lily_pad');
          const targetS = obs ? Math.max(baseS, obs.s - 10.5) : scanS + 24;
          ensureAt(targetS, obs ? obs.u : 0, 0.05, 'surface');
          break;
        }

        case 'dive_log': {
          const scanS = Math.max(baseS + 12, 40);
          this.obstacleSpawner.update(scanS, this.elapsedTime);
          const obs = this.obstacleSpawner
            .getObstaclesInRange(scanS, scanS + 200)
            .find((o) => o.type === 'log_dive' || o.type === 'arch');
          const targetS = obs ? Math.max(baseS, obs.s - 11.2) : scanS + 52;
          ensureAt(targetS, obs ? obs.u : 0, 0.05, 'surface');
          break;
        }

        case 'boulder': {
          const scanS = Math.max(baseS + 12, 40);
          this.obstacleSpawner.update(scanS, this.elapsedTime);
          const obs = this.obstacleSpawner
            .getObstaclesInRange(scanS, scanS + 160)
            .find((o) => o.type === 'boulder');
          const targetS = obs ? Math.max(baseS, obs.s - 9.5) : scanS + 2;
          ensureAt(targetS, 0, 0.05, 'surface');
          break;
        }

        case 'fork': {
          // Read-only scan along waterway chain to locate the nearest 2-way EarthJunction fork
          // without pruning spline nodes during probing!
          let forkS = Math.max(baseS + 20, 160);
          let probeS = baseS;
          for (let attempt = 0; attempt < 6; attempt++) {
            const leg = this.river.getLegAtS(probeS);
            if (!leg) break;
            const ww = earthWorld.getWaterwayById(leg.waterwayId);
            const outgoing = ww ? earthWorld.getOutgoingWaterways(ww.toJunctionId) : [];
            if (outgoing.length >= 2) {
              forkS = Math.max(baseS, leg.endS - 35);
              break;
            }
            probeS = leg.endS + 8;
          }
          this.river.setForkChoice('left');
          this.river.updateWindow(forkS);
          this.river.recenterOriginAt(forkS);
          ensureAt(forkS, -1.2, 0.04, 'surface');
          this.cameraRig.snapToDuck(this.duckController.getState(), this.river);
          warmupFrames = 6;
          break;
        }

        case 'obstacles': {
          // Frame a curated showcase gallery of the 6 signature new shared Meshy obstacles!
          const startS = Math.max(baseS + 10, 26);
          this.river.updateWindow(startS);
          this.duckController.teleportTo(startS, 0, 0.04, 'surface');
          this.runStartS = Math.min(this.runStartS, startS);
          this.lastTrackedS = startS;
          this.obstacleSpawner.spawnShowcaseStretch(startS);
          const st = this.duckController.getState();
          this.collectibles.update(st, 0.016, this.elapsedTime);
          this.wildlife.update(st, 0.016, this.elapsedTime);
          this.cameraRig.snapToDuck(st, this.river);
          applyDuckRigPose(this.duckRig, st);
          warmupFrames = 4;
          break;
        }

        case 'gameover': {
          ensureAt(Math.max(baseS + 24, 62), 0, 0.05, 'surface');
          const st = this.duckController.getState();
          this.score = 1280;
          this.coins = 24;
          this.duckController.handleObstacleCollision({
            id: 'qa_boulder',
            type: 'boulder',
            s: st.s + 0.5,
            u: st.u,
            y: 0,
            radius: 1.8,
            width: 3.6,
            height: 2.8,
            clearanceBelow: 0,
            clearanceAbove: 3.2,
            worldPos: { ...st.worldPos },
            foamStrength: 0.9,
            hasEddy: true,
            assetId: 'mossy_boulder_a',
          });
          this.triggerGameOver(formatCrashReason('boulder'));
          warmupFrames = 3;
          break;
        }
      }

      // Advance crisp warmup frames so animations, water Y-fork & camera settle cleanly
      for (let i = 0; i < warmupFrames; i++) {
        this.stepSimulationAndRender(0.016);
        if (i === 0 && mode === 'fork') {
          // Clear any initial title->playing postcard toast before fork signpost renders
          this.activeCallout = null;
          this.calloutRemaining = 0;
          this.hud.resetTransientUi();
        }
      }
      if (mode === 'diving' || mode === 'cave') {
        this.cameraRig.snapToDuck(this.duckController.getState(), this.river);
        this.clearMeniscusSafely(true);
        this.stepSimulationAndRender(0.016);
        this.clearMeniscusSafely(true);
      } else if (mode === 'fork') {
        this.activeCallout = null;
        this.calloutRemaining = 0;
        this.clearMeniscusSafely(false);
        this.stepSimulationAndRender(0.001);
        // Settle the fork signpost's 180ms CSS entrance animation immediately for deterministic QA frames
        if (typeof document !== 'undefined') {
          const signpost = document.querySelector<HTMLElement>('[data-ref="fork-signpost"]');
          if (signpost && typeof signpost.getAnimations === 'function') {
            void signpost.offsetWidth;
            for (const anim of signpost.getAnimations()) {
              anim.finish();
            }
          }
        }
      } else if (mode !== 'spooked') {
        this.activeCallout = null;
        this.calloutRemaining = 0;
        this.hud.resetTransientUi();
        this.clearMeniscusSafely(false);
        this.stepSimulationAndRender(0.001);
      } else {
        this.clearMeniscusSafely(false);
      }
      return getDebugState();
    };

    window.__riverDucker = {
      getState: getDebugState,
      getWorldInfo,
      getTracks: getTracksInfo,
      setTrack: setTrackAsync,
      setForkChoice: (side) => {
        this.river.setForkChoice(side);
        const st = this.duckController.getState();
        const sample = this.river.sampleAt(st.s);
        if (sample.upcomingFork) {
          const targetU = side === 'left' ? -1.2 : 1.2;
          if ((side === 'left' && st.u > -0.6) || (side === 'right' && st.u < 0.6)) {
            this.duckController.teleportTo(st.s, targetU, st.y, st.mode);
            this.cameraRig.snapToDuck(this.duckController.getState(), this.river);
            applyDuckRigPose(this.duckRig, this.duckController.getState());
          }
        }
        this.stepSimulationAndRender(0.001);
      },
      openGlobe: openGlobeModal,
      start: () => this.startRun(),
      restart: () => this.restartRun(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      returnTitle: () => this.returnToTitle(),
      setQuality: (level) => this.setQuality(level),
      setMuted: (muted) => {
        this.sound.setMuted(muted);
        this.hud.setSettings({ muted });
      },
      setInputOverride: (override) => {
        this.inputOverride = override;
      },
      activatePowerUp: (type) => {
        this.duckController.activatePowerUp(type);
        if (type === 'wing_gust') {
          this.collectibles.spawnSkyFlightArc(this.duckController.getState().s + 16);
        }
      },
      showcase: runShowcase,
    };
  }
}
