import '../styles.css';
import { DUCK_CONFIG, POWERUP_CONFIG, SCALE } from '../config';
import {
  DEFAULT_REGION_ID,
  earthWorld,
  type EarthRegionZone,
} from '../earth';
import type {
  ActivePowerUpHud,
  GameState,
  HudSnapshot,
  PowerUpType,
  QualityLevel,
  RiverForkHint,
  RouteMode,
} from '../types';
import {
  formatLatLng,
  formatTrackDifficulty,
  getConnectedZonesForRegion,
  getWeatherIcon,
  getZoneIcon,
  MiniEarthGlobe,
} from './miniEarthGlobe';

const STORAGE_TOUCH_CONTROLS_KEY = 'river_ducker_touch_controls_v1';
const STORAGE_SHOW_FPS_KEY = 'river_ducker_show_fps_v1';
const STORAGE_HINTS_SEEN_KEY = 'river_ducker_hints_seen_v1';
const STORAGE_BEST_DIST_KEY = 'river_ducker_best_dist_v1';
const STORAGE_ROUTE_MODE_KEY = 'river_ducker_route_mode_v1';
const STORAGE_START_TRACK_KEY = 'river_ducker_start_track_v1';
const STORAGE_TRACK_BEST_DIST_KEY = 'river_ducker_track_best_v1';

const BREATH_RING_RADIUS = 31;
const BREATH_RING_CIRCUMFERENCE = 2 * Math.PI * BREATH_RING_RADIUS;

const POWERUP_ORDER: readonly PowerUpType[] = [
  'wing_gust',
  'bubble_lung',
  'soap_shield',
  'magnet',
];

const ROUTE_MODE_CYCLE: readonly RouteMode[] = [
  'world_tour',
  'free_earth',
  'single_track',
];

const ROUTE_MODE_LABELS: Record<RouteMode, string> = {
  world_tour: '🌍 World Tour',
  free_earth: '🧭 Free Earth',
  single_track: '📍 Single Track',
};

export interface HudSettings {
  quality: QualityLevel;
  muted: boolean;
  showTouchControls: boolean;
  showFps: boolean;
  routeMode?: RouteMode;
  startTrackId?: string;
}

export interface HudExtraMetrics {
  drawCalls?: number;
  cavesCleared?: number;
  waterfallsCleared?: number;
  bestDistanceMeters?: number;
  isNewBest?: boolean;
}

export interface HudCallbacks {
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onReturnTitle?: () => void;
  onMuteToggle: (muted: boolean) => void;
  onQualityChange: (quality: QualityLevel) => void;
  onTouchControlsChange?: (enabled: boolean) => void;
  onFpsToggle?: (enabled: boolean) => void;
  onVirtualJump?: (pressed: boolean) => void;
  onVirtualDive?: (held: boolean) => void;
  onUserGesture?: () => void;
  onRouteChange?: (
    routeMode: RouteMode,
    trackId: string,
    startImmediately?: boolean,
  ) => void;
}

interface BoostPillRefs {
  root: HTMLElement;
  timeEl: HTMLElement;
  fillEl: HTMLElement;
}

interface TrackCardRefs {
  card: HTMLElement;
  bestEl: HTMLElement;
}

type ForkHintWithCompat = RiverForkHint & {
  chosenSide?: 'left' | 'right';
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function formatInt(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString('en-US');
}

function isRouteMode(v: string | null): v is RouteMode {
  return v === 'world_tour' || v === 'free_earth' || v === 'single_track';
}

function safeStorageGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage errors in private or sandboxed contexts.
  }
}

function readTrackBestMap(): Record<string, number> {
  const raw = safeStorageGet(STORAGE_TRACK_BEST_DIST_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function detectCoarsePointer(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.matchMedia?.('(pointer: coarse)').matches || (navigator.maxTouchPoints ?? 0) > 0,
  );
}

// Inline crisp SVG icons (zero external icon fonts or broken image links)
const SVG_SPEAKER_ON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" fill-opacity="0.22"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';

const SVG_SPEAKER_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" fill-opacity="0.18"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';

const SVG_PAUSE =
  '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.5" height="16" rx="1.6"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.6"/></svg>';

const SVG_SETTINGS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09c-.66 0-1.25.4-1.51 1Z"/></svg>';

const SVG_PLAY =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.5 4.8a1.4 1.4 0 0 1 2.13-1.19l10.6 6.7a1.4 1.4 0 0 1 0 2.38l-10.6 6.7A1.4 1.4 0 0 1 7.5 18.2V4.8Z"/></svg>';

const SVG_RESTART =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';

const SVG_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

const SVG_GLOBE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M2.6 12h18.8"/><path d="M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19"/></svg>';

const SVG_STEER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/><path d="M3 12h18"/></svg>';

const SVG_JUMP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/><path d="M12 9v10"/></svg>';

const SVG_DIVE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v10"/><path d="m6 11 6 6 6-6"/><path d="M4 20c2-1.2 4-1.2 6 0s4 1.2 6 0 3-1 4-0.5"/></svg>';

const SVG_BUBBLES =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="14" r="5" fill="currentColor" fill-opacity="0.22"/><circle cx="17.5" cy="7.5" r="2.8" fill="currentColor" fill-opacity="0.22"/><circle cx="16.5" cy="17.5" r="1.8"/></svg>';

const SVG_HOME =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5"/></svg>';

const SVG_DUCK_CREST = `
<svg class="rd-emblem-crest" viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="rd-duck-body" x1="20" y1="16" x2="72" y2="74" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#fff48f"/>
      <stop offset="52%" stop-color="#ffd22b"/>
      <stop offset="100%" stop-color="#f59800"/>
    </linearGradient>
    <linearGradient id="rd-duck-wave" x1="8" y1="68" x2="88" y2="86" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#6fffe9"/>
      <stop offset="100%" stop-color="#00b4d8"/>
    </linearGradient>
  </defs>
  <circle cx="48" cy="46" r="40" fill="rgba(7,34,46,0.44)" stroke="rgba(196,248,255,0.34)" stroke-width="2"/>
  <path d="M23 54c0-11 8-16 18-16h12c5-1 8-5 8-10 0-7.5-6-13-13.5-13S34 20.5 34 28c0 4 1.8 7.6 4.7 10.1" fill="url(#rd-duck-body)"/>
  <circle cx="52" cy="27.5" r="12.5" fill="url(#rd-duck-body)"/>
  <path d="M23 54c0 11 10 18 25 18s24-7 24-17c0-6.5-4.4-11.2-11-12.5-3.2 3.2-9 5.5-17.5 5.5-9.5 0-14.5-3.2-17.5-6.5-2 3.5-3 7.7-3 12.5Z" fill="url(#rd-duck-body)"/>
  <path d="M62 27.5c5.8 0 11 1.6 11 4.4 0 2.5-4.4 4.1-11.2 4.1-1.6 0-2.6-1.4-2.4-3.2l.4-2.8c.2-1.5 1-2.5 2.2-2.5Z" fill="#ff6b1a"/>
  <circle cx="55.5" cy="25" r="2.7" fill="#17232c"/>
  <circle cx="56.3" cy="24.2" r="0.95" fill="#ffffff"/>
  <path d="M35 53c5.5-2.5 13-2 17.5 2.5-5.5 4.2-14 4.2-19 0 .4-1 .9-1.9 1.5-2.5Z" fill="#fff6a8" fill-opacity="0.72"/>
  <path d="M12 71c8-5 15-5 22 0s14 5 22 0 15-5 24 0" stroke="url(#rd-duck-wave)" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M19 80c7-3.8 13-3.8 19 0s13 3.8 20 0 13-3.8 19 0" stroke="#bffef5" stroke-opacity="0.78" stroke-width="3" stroke-linecap="round"/>
</svg>`;

const POWERUP_ICONS: Record<PowerUpType, string> = {
  wing_gust:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>',
  bubble_lung: SVG_BUBBLES,
  soap_shield:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="currentColor" fill-opacity="0.18"/></svg>',
  magnet:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/><path d="m5 8 4 4"/><path d="m12 15 4 4"/></svg>',
};

/**
 * Diegetic, nature-tactile HUD, Shared-Planet 3D Mini-Earth Globe Route Selector,
 * Physical River Fork Signpost, and Live GPS Expedition Overlay mounted inside `#hud-root`.
 * Zero per-frame DOM allocations: builds the DOM tree once and diffs values cleanly.
 */
export class Hud {
  private readonly root: HTMLElement;
  private readonly callbacks: HudCallbacks;
  private settings: HudSettings;
  private extraMetrics: HudExtraMetrics = {};
  private inputDevice: 'touch' | 'keyboard' | 'gamepad';

  // Route & Shared Mini-Earth Globe state
  private selectedRouteMode: RouteMode;
  private selectedTrackId: string;
  private trackBestMeters: Record<string, number>;
  private globeModalOpen = false;
  private globe!: MiniEarthGlobe;

  // Persistent state & run tracking
  private settingsDrawerOpen = false;
  private currentGameState: GameState = 'title';
  private hintsSeen: boolean;
  private bestDistanceMeters: number;
  private runStartMs = 0;
  private runStartHighScore = 0;
  private lastBiomeName = '';
  private lastTrackId = '';
  private biomeToastTimer: number | null = null;
  private lastCalloutId = -1;
  private calloutTimer: number | null = null;
  private prevCombo = 0;
  private prevInCave = false;
  private prevMode: HudSnapshot['mode'] = 'surface';
  private autoCavesCleared = 0;
  private autoWaterfallsCleared = 0;
  private activeHintStage = -1;

  // Cached DOM references (zero querySelector per frame)
  private fpsPill!: HTMLElement;
  private muteBtn!: HTMLButtonElement;
  private pauseSettingsBtn!: HTMLButtonElement;

  // Title screen
  private titleOverlay!: HTMLElement;
  private bestBadge!: HTMLElement;
  private bestScoreTitleEl!: HTMLElement;
  private bestDistTitleEl!: HTMLElement;
  private titleModeChip!: HTMLButtonElement;
  private titleRouteSeqEl!: HTMLElement;
  private openGlobeBtn!: HTMLButtonElement;
  private loadingBar!: HTMLElement;
  private loadingFill!: HTMLElement;
  private hintSteerSub!: HTMLElement;
  private hintJumpSub!: HTMLElement;
  private hintDiveSub!: HTMLElement;
  private tapNoteEl!: HTMLElement;

  // Shared Mini-Earth Globe Modal
  private globeModalBackdrop!: HTMLElement;
  private globeCanvasHost!: HTMLElement;
  private globeSelectedIconEl!: HTMLElement;
  private globeSelectedNameEl!: HTMLElement;
  private globeCoordsPillEl!: HTMLElement;
  private globeTrackGridEl!: HTMLElement;
  private globeContribNoteEl!: HTMLElement;
  private globeModeBtns = new Map<RouteMode, HTMLButtonElement>();
  private globeTrackCards = new Map<string, TrackCardRefs>();
  private globeCardCleanups: Array<() => void> = [];
  private globeLaunchBtn!: HTMLButtonElement;
  private globeLaunchTextEl!: HTMLElement;

  // Gameplay HUD
  private playHud!: HTMLElement;
  private distanceValEl!: HTMLElement;
  private scoreValEl!: HTMLElement;
  private coinsValEl!: HTMLElement;
  private comboBadge!: HTMLElement;
  private comboMultEl!: HTMLElement;
  private comboFillEl!: HTMLElement;
  private expeditionBadge!: HTMLElement;
  private expeditionTitleEl!: HTMLElement;
  private expeditionWeatherEl!: HTMLElement;
  private expeditionGpsEl!: HTMLElement;
  private expeditionWaterwayEl!: HTMLElement;
  private expeditionNextEl!: HTMLElement;
  private expeditionProgressWrap!: HTMLElement;
  private expeditionProgressFill!: HTMLElement;

  // Physical River Fork Signpost
  private forkSignpost!: HTMLElement;
  private forkHeaderEl!: HTMLElement;
  private forkLeftWing!: HTMLElement;
  private forkLeftTitleEl!: HTMLElement;
  private forkLeftSubEl!: HTMLElement;
  private forkRightWing!: HTMLElement;
  private forkRightTitleEl!: HTMLElement;
  private forkRightSubEl!: HTMLElement;

  private biomeToast!: HTMLElement;
  private biomeToastText!: HTMLElement;
  private biomeToastSub!: HTMLElement;
  private cavePill!: HTMLElement;
  private calloutEl!: HTMLElement;
  private boostPills = new Map<PowerUpType, BoostPillRefs>();

  // Underwater Breath Ring
  private breathWrap!: HTMLElement;
  private breathArc!: SVGCircleElement;
  private breathLabel!: HTMLElement;

  // First-Run Hints
  private hintBanner!: HTMLElement;
  private hintIconSlot!: HTMLElement;
  private hintTextEl!: HTMLElement;

  // Mobile On-Screen Buttons
  private touchControlsWrap!: HTMLElement;
  private touchJumpBtn!: HTMLButtonElement;
  private touchDiveBtn!: HTMLButtonElement;
  private jumpPointerId: number | null = null;
  private divePointerId: number | null = null;

  // Pause & Settings Drawer
  private drawerBackdrop!: HTMLElement;
  private drawerTitleEl!: HTMLElement;
  private pauseActionsWrap!: HTMLElement;
  private qualityButtons = new Map<QualityLevel, HTMLButtonElement>();
  private qualityActiveSub!: HTMLElement;
  private switchSound!: HTMLButtonElement;
  private switchTouch!: HTMLButtonElement;
  private switchFps!: HTMLButtonElement;

  // Game Over Card
  private gameOverOverlay!: HTMLElement;
  private newBestRibbon!: HTMLElement;
  private gameOverTitleEl!: HTMLElement;
  private crashReasonEl!: HTMLElement;
  private goDistEl!: HTMLElement;
  private goScoreEl!: HTMLElement;
  private goBestEl!: HTMLElement;
  private goCoinsEl!: HTMLElement;
  private goCavesEl!: HTMLElement;
  private goWaterfallsEl!: HTMLElement;
  private goRegionsEl!: HTMLElement;

  // Diff cache to skip redundant DOM mutations
  private cachedDistance = -1;
  private cachedScore = -1;
  private cachedCoins = -1;
  private cachedFpsText = '';
  private cachedMuted: boolean | null = null;
  private cachedResolvedQuality = '';
  private cachedQuality: QualityLevel | null = null;
  private cachedLoadPct = -1;
  private cachedExpeditionKey = '';
  private cachedGpsKey = '';
  private cachedForkKey = '';

  // Cleanup handlers
  private cleanups: Array<() => void> = [];

  constructor(
    root: HTMLElement,
    callbacks: HudCallbacks,
    initialSettings?: Partial<HudSettings>,
  ) {
    this.root = root;
    this.callbacks = callbacks;

    const coarse = detectCoarsePointer();
    this.inputDevice = coarse ? 'touch' : 'keyboard';

    const storedTouch = safeStorageGet(STORAGE_TOUCH_CONTROLS_KEY);
    const storedFps = safeStorageGet(STORAGE_SHOW_FPS_KEY);
    const storedMode = safeStorageGet(STORAGE_ROUTE_MODE_KEY);
    const storedTrack = safeStorageGet(STORAGE_START_TRACK_KEY);

    this.hintsSeen = safeStorageGet(STORAGE_HINTS_SEEN_KEY) === '1';
    this.bestDistanceMeters = Number(safeStorageGet(STORAGE_BEST_DIST_KEY) || '0') || 0;
    this.trackBestMeters = readTrackBestMap();

    this.selectedRouteMode =
      initialSettings?.routeMode ??
      (isRouteMode(storedMode) ? storedMode : 'world_tour');
    this.selectedTrackId = earthWorld.getZoneById(
      initialSettings?.startTrackId ?? storedTrack ?? DEFAULT_REGION_ID,
    ).id;

    this.settings = {
      quality: initialSettings?.quality ?? 'auto',
      muted: initialSettings?.muted ?? false,
      showTouchControls:
        initialSettings?.showTouchControls ??
        (storedTouch !== null ? storedTouch === '1' : coarse),
      showFps: initialSettings?.showFps ?? storedFps === '1',
      routeMode: this.selectedRouteMode,
      startTrackId: this.selectedTrackId,
    };

    this.mount();
    this.syncSettingsUi();
    this.syncRouteUi();
    this.syncDeviceCopy();
  }

  public getSettings(): HudSettings {
    return {
      ...this.settings,
      routeMode: this.selectedRouteMode,
      startTrackId: this.selectedTrackId,
    };
  }

  public setSettings(partial: Partial<HudSettings>): void {
    this.settings = { ...this.settings, ...partial };
    if (partial.showTouchControls !== undefined) {
      safeStorageSet(STORAGE_TOUCH_CONTROLS_KEY, partial.showTouchControls ? '1' : '0');
    }
    if (partial.showFps !== undefined) {
      safeStorageSet(STORAGE_SHOW_FPS_KEY, partial.showFps ? '1' : '0');
    }
    if (partial.routeMode !== undefined || partial.startTrackId !== undefined) {
      this.setRouteSelection(
        partial.routeMode ?? this.selectedRouteMode,
        partial.startTrackId ?? this.selectedTrackId,
        false,
      );
    }
    this.syncSettingsUi();
  }

  public setExtraMetrics(extra: HudExtraMetrics): void {
    this.extraMetrics = { ...this.extraMetrics, ...extra };
    if (
      extra.bestDistanceMeters !== undefined &&
      extra.bestDistanceMeters > this.bestDistanceMeters
    ) {
      this.bestDistanceMeters = extra.bestDistanceMeters;
      safeStorageSet(STORAGE_BEST_DIST_KEY, String(Math.round(this.bestDistanceMeters)));
    }
  }

  public setInputDevice(device: 'touch' | 'keyboard' | 'gamepad'): void {
    if (this.inputDevice !== device) {
      this.inputDevice = device;
      this.syncDeviceCopy();
    }
  }

  public getGlobe(): MiniEarthGlobe {
    return this.globe;
  }

  /**
   * Forward the duck's live planetary GPS coordinates onto the 3D Mini-Earth Globe.
   */
  public setLivePosition(lat: number, lng: number, waterwayId?: string | null): void {
    this.globe?.setLivePosition(lat, lng, waterwayId);
  }

  /**
   * Rebuild the Globe Modal region cards, footer counts, and globe network data
   * after dynamic pack registration (`earthWorld.registerPack(...)`).
   */
  public refreshWorldAtlas(): void {
    this.globe?.refreshNetworkData();
    this.buildGlobeTrackCards();
    this.syncGlobeFooterStats();
    this.syncRouteUi();
  }

  public getSelectedTrackId(): string {
    return this.selectedTrackId;
  }

  public getSelectedRouteMode(): RouteMode {
    return this.selectedRouteMode;
  }

  public getTrackBestDistance(trackId: string): number {
    return Math.round(this.trackBestMeters[trackId] ?? 0);
  }

  public setRouteSelection(
    routeMode: RouteMode,
    trackId: string,
    notify = false,
  ): void {
    const resolvedZone = earthWorld.getZoneById(trackId);
    this.selectedRouteMode = routeMode;
    this.selectedTrackId = resolvedZone.id;
    this.settings.routeMode = routeMode;
    this.settings.startTrackId = resolvedZone.id;

    safeStorageSet(STORAGE_ROUTE_MODE_KEY, routeMode);
    safeStorageSet(STORAGE_START_TRACK_KEY, resolvedZone.id);

    this.globe.setRouteMode(routeMode);
    this.globe.setSelectedTrack(resolvedZone.id, true);
    this.syncRouteUi();

    if (notify) {
      this.callbacks.onRouteChange?.(routeMode, resolvedZone.id, false);
    }
  }

  public openGlobeModal(): void {
    this.globeModalOpen = true;
    this.settingsDrawerOpen = false;
    this.syncGlobeFooterStats();
    this.updateOverlayVisibility();
    this.globe.setActive(true);
    const live = this.globe.getLivePosition();
    if (live && this.currentGameState !== 'title') {
      this.globe.centerOnLatLng(live.lat, live.lng, false);
    } else {
      this.globe.centerOnTrack(this.selectedTrackId, false);
    }
  }

  public closeGlobeModal(): void {
    if (!this.globeModalOpen) return;
    this.globeModalOpen = false;
    this.globe.setActive(false);
    this.updateOverlayVisibility();
  }

  public isGlobeModalOpen(): boolean {
    return this.globeModalOpen;
  }

  public openSettings(): void {
    this.globeModalOpen = false;
    this.globe.setActive(false);
    this.settingsDrawerOpen = true;
    this.updateOverlayVisibility();
  }

  public closeSettings(): void {
    this.settingsDrawerOpen = false;
    if (this.currentGameState === 'paused') {
      this.callbacks.onResume();
    } else {
      this.updateOverlayVisibility();
    }
  }

  public resetHints(): void {
    this.hintsSeen = false;
    this.activeHintStage = -1;
    safeStorageSet(STORAGE_HINTS_SEEN_KEY, '0');
  }

  /**
   * Immediately clear transient toasts, fork signpost, callouts, combo pop, cave pill,
   * hint banner, breath ring, and boost pills.
   */
  public resetTransientUi(): void {
    if (this.biomeToastTimer !== null) {
      window.clearTimeout(this.biomeToastTimer);
      this.biomeToastTimer = null;
    }
    if (this.calloutTimer !== null) {
      window.clearTimeout(this.calloutTimer);
      this.calloutTimer = null;
    }
    this.biomeToast.classList.remove('is-visible');
    this.forkSignpost.classList.remove('is-visible');
    this.playHud.classList.remove('has-fork');
    this.calloutEl.classList.remove('is-visible');
    this.calloutEl.textContent = '';
    this.cavePill.classList.remove('is-visible');
    this.comboBadge.classList.remove('is-visible', 'is-pop');
    this.hintBanner.classList.remove('is-visible', 'has-breath');
    this.breathWrap.classList.remove('is-visible', 'is-boosted', 'is-low');
    for (const refs of this.boostPills.values()) {
      refs.root.classList.add('rd-hidden');
    }
    this.lastCalloutId = -1;
    this.prevCombo = 0;
    this.activeHintStage = -1;
    this.cachedExpeditionKey = '';
    this.cachedGpsKey = '';
    this.cachedForkKey = '';
  }

  /**
   * High-frequency UI sync called each animation frame with immutable HudSnapshot.
   */
  public update(snapshot: HudSnapshot, extra?: HudExtraMetrics): void {
    if (extra) {
      this.extraMetrics = { ...this.extraMetrics, ...extra };
    }

    // Update live planetary GPS position on the 3D Mini-Earth Globe
    if (
      snapshot.lat !== undefined &&
      snapshot.lng !== undefined &&
      Number.isFinite(snapshot.lat) &&
      Number.isFinite(snapshot.lng)
    ) {
      this.globe.setLivePosition(snapshot.lat, snapshot.lng, snapshot.waterwayId);
    }

    // Sync routeMode from snapshot if game engine pushes it
    if (snapshot.routeMode && snapshot.routeMode !== this.selectedRouteMode) {
      this.selectedRouteMode = snapshot.routeMode;
      this.globe.setRouteMode(snapshot.routeMode);
      this.syncRouteUi();
    }
    if (
      snapshot.gameState === 'title' &&
      snapshot.currentTrackId &&
      snapshot.currentTrackId !== this.selectedTrackId &&
      !this.globeModalOpen
    ) {
      this.selectedTrackId = earthWorld.getZoneById(snapshot.currentTrackId).id;
      this.globe.setSelectedTrack(this.selectedTrackId, false);
      this.syncRouteUi();
    }

    const prevState = this.currentGameState;
    if (snapshot.gameState !== prevState) {
      this.handleStateTransition(prevState, snapshot);
    }
    this.currentGameState = snapshot.gameState;

    // Sync muted & quality if updated externally
    if (this.cachedMuted !== snapshot.muted) {
      this.cachedMuted = snapshot.muted;
      this.settings.muted = snapshot.muted;
      this.muteBtn.innerHTML = snapshot.muted ? SVG_SPEAKER_OFF : SVG_SPEAKER_ON;
      this.muteBtn.setAttribute('aria-label', snapshot.muted ? 'Unmute audio' : 'Mute audio');
      this.switchSound.setAttribute('aria-checked', String(!snapshot.muted));
    }

    if (this.cachedQuality !== snapshot.quality) {
      this.cachedQuality = snapshot.quality;
      this.settings.quality = snapshot.quality;
      this.syncQualityButtons();
    }

    const qualityKey = `${snapshot.quality}:${snapshot.resolvedQuality}`;
    if (this.cachedResolvedQuality !== qualityKey) {
      this.cachedResolvedQuality = qualityKey;
      this.qualityActiveSub.textContent =
        snapshot.quality === 'auto'
          ? `Auto (${snapshot.resolvedQuality === 'high' ? 'High' : 'Performance'})`
          : snapshot.resolvedQuality === 'high'
            ? 'High detail'
            : 'Performance mode';
    }

    // Optional FPS / Draw-Calls pill
    if (this.settings.showFps) {
      const fpsVal = Math.round(snapshot.fps);
      const dc = this.extraMetrics.drawCalls;
      const text = dc !== undefined ? `${fpsVal} FPS · ${dc} DC` : `${fpsVal} FPS`;
      if (text !== this.cachedFpsText) {
        this.cachedFpsText = text;
        this.fpsPill.textContent = text;
      }
      this.fpsPill.classList.remove('rd-hidden');
    } else {
      this.fpsPill.classList.add('rd-hidden');
    }

    // Track overall & per-region best distance persistently during gameplay / gameover
    if (snapshot.gameState === 'playing' || snapshot.gameState === 'gameover') {
      if (snapshot.distanceMeters > this.bestDistanceMeters) {
        this.bestDistanceMeters = snapshot.distanceMeters;
        safeStorageSet(STORAGE_BEST_DIST_KEY, String(Math.round(this.bestDistanceMeters)));
      }
      const activeTrackId = snapshot.currentTrackId ?? this.selectedTrackId;
      const prevTrackBest = this.trackBestMeters[activeTrackId] ?? 0;
      if (snapshot.distanceMeters > prevTrackBest) {
        this.trackBestMeters[activeTrackId] = Math.round(snapshot.distanceMeters);
        safeStorageSet(STORAGE_TRACK_BEST_DIST_KEY, JSON.stringify(this.trackBestMeters));
        const cardRef = this.globeTrackCards.get(activeTrackId);
        if (cardRef) {
          cardRef.bestEl.textContent = `Best: ${formatInt(snapshot.distanceMeters)} m`;
        }
      }
    }

    // Title screen updates
    if (snapshot.gameState === 'title') {
      this.updateTitleMetrics(snapshot);
    }

    // Active gameplay HUD updates
    if (snapshot.gameState === 'playing' || snapshot.gameState === 'paused') {
      this.updatePlayHud(snapshot);
    }

    // Game Over metrics
    if (snapshot.gameState === 'gameover') {
      this.updateGameOverCard(snapshot);
    }

    // Track cave & waterfall transitions for automatic summary counts
    if (snapshot.gameState === 'playing') {
      if (!this.prevInCave && snapshot.inCave) {
        this.autoCavesCleared += 1;
      }
      if (this.prevMode === 'waterfall' && snapshot.mode !== 'waterfall') {
        this.autoWaterfallsCleared += 1;
      }
    }
    this.prevInCave = snapshot.inCave;
    this.prevMode = snapshot.mode;
  }

  public dispose(): void {
    this.releaseVirtualButtons();
    if (this.biomeToastTimer !== null) {
      window.clearTimeout(this.biomeToastTimer);
      this.biomeToastTimer = null;
    }
    if (this.calloutTimer !== null) {
      window.clearTimeout(this.calloutTimer);
      this.calloutTimer = null;
    }
    this.globe?.dispose();
    for (const fn of this.globeCardCleanups) {
      fn();
    }
    this.globeCardCleanups = [];
    for (const fn of this.cleanups) {
      fn();
    }
    this.cleanups = [];
    this.root.innerHTML = '';
  }

  // ---------------------------------------------------------------------------
  // State Transitions & Sub-updaters
  // ---------------------------------------------------------------------------

  private handleStateTransition(prev: GameState, snap: HudSnapshot): void {
    if (snap.gameState === 'playing' && (prev === 'title' || prev === 'gameover')) {
      this.settingsDrawerOpen = false;
      this.closeGlobeModal();
      this.resetTransientUi();
      this.runStartMs = performance.now();
      this.runStartHighScore = snap.highScore;
      this.autoCavesCleared = 0;
      this.autoWaterfallsCleared = 0;

      const zone = earthWorld.getZoneById(snap.currentTrackId ?? this.selectedTrackId);
      this.lastTrackId = zone.id;
      this.lastBiomeName = snap.biomeName;
      this.showExpeditionPostcardToast(zone);
    } else if (snap.gameState === 'playing' && prev === 'paused') {
      this.settingsDrawerOpen = false;
      this.closeGlobeModal();
    } else if (snap.gameState === 'paused') {
      if (!this.globeModalOpen) {
        this.settingsDrawerOpen = true;
      }
      this.releaseVirtualButtons();
    } else if (snap.gameState === 'gameover') {
      this.settingsDrawerOpen = false;
      this.closeGlobeModal();
      this.releaseVirtualButtons();
      if (!this.hintsSeen && performance.now() - this.runStartMs > 8500) {
        this.hintsSeen = true;
        safeStorageSet(STORAGE_HINTS_SEEN_KEY, '1');
      }
      this.updateGameOverCard(snap);
    } else if (snap.gameState === 'title') {
      this.settingsDrawerOpen = false;
      this.releaseVirtualButtons();
      this.resetTransientUi();
    }

    this.currentGameState = snap.gameState;
    this.updateOverlayVisibility();
  }

  private updateOverlayVisibility(): void {
    const state = this.currentGameState;
    const isPlaying = state === 'playing';
    const isPaused = state === 'paused';
    const isTitle = state === 'title';
    const isGameOver = state === 'gameover';

    this.titleOverlay.classList.toggle('rd-hidden', !isTitle);
    this.playHud.classList.toggle('rd-hidden', !(isPlaying || isPaused));
    this.gameOverOverlay.classList.toggle('rd-hidden', !isGameOver);

    this.globeModalBackdrop.classList.toggle('rd-hidden', !this.globeModalOpen);

    const showDrawer = (isPaused || this.settingsDrawerOpen) && !this.globeModalOpen;
    this.drawerBackdrop.classList.toggle('rd-hidden', !showDrawer);
    this.pauseActionsWrap.classList.toggle('rd-hidden', !isPaused);
    this.drawerTitleEl.textContent = isPaused ? 'Paused' : 'Settings';

    this.pauseSettingsBtn.innerHTML = isPlaying ? SVG_PAUSE : SVG_SETTINGS;
    this.pauseSettingsBtn.setAttribute('aria-label', isPlaying ? 'Pause game' : 'Open settings');

    const showTouch = isPlaying && this.settings.showTouchControls && !this.globeModalOpen;
    this.touchControlsWrap.classList.toggle('rd-hidden', !showTouch);
    this.playHud.classList.toggle('has-touch-controls', showTouch);
  }

  private updateTitleMetrics(snap: HudSnapshot): void {
    const bestDist = Math.max(
      this.bestDistanceMeters,
      this.extraMetrics.bestDistanceMeters ?? 0,
    );
    const hasRecord = snap.highScore > 0 || bestDist >= 5;
    this.bestBadge.classList.toggle('rd-hidden', !hasRecord);
    if (hasRecord) {
      this.bestScoreTitleEl.textContent = `Best ${formatInt(snap.highScore)}`;
      this.bestDistTitleEl.textContent = `${formatInt(bestDist)} m`;
    }

    const loadPct = clamp(Math.round(snap.assetsLoadedRatio * 100), 0, 100);
    if (loadPct !== this.cachedLoadPct) {
      this.cachedLoadPct = loadPct;
      this.loadingFill.style.width = `${loadPct}%`;
      this.loadingBar.classList.toggle('rd-hidden', loadPct >= 100);
    }
  }

  private updatePlayHud(snap: HudSnapshot): void {
    // Distance, Score, Coins (diffed integers)
    const distInt = Math.max(0, Math.floor(snap.distanceMeters));
    if (distInt !== this.cachedDistance) {
      this.cachedDistance = distInt;
      this.distanceValEl.textContent = formatInt(distInt);
    }

    const scoreInt = Math.max(0, Math.floor(snap.score));
    if (scoreInt !== this.cachedScore) {
      this.cachedScore = scoreInt;
      this.scoreValEl.textContent = formatInt(scoreInt);
    }

    const coinsInt = Math.max(0, Math.floor(snap.coins));
    if (coinsInt !== this.cachedCoins) {
      this.cachedCoins = coinsInt;
      this.coinsValEl.textContent = formatInt(coinsInt);
    }

    // Combo badge (only visible when combo > 1)
    const comboActive = snap.combo > 1 && snap.comboTimer > 0.01;
    this.comboBadge.classList.toggle('is-visible', comboActive);
    if (comboActive) {
      if (snap.combo !== this.prevCombo) {
        this.comboMultEl.textContent = `x${snap.combo}`;
        this.comboBadge.classList.remove('is-pop');
        void this.comboBadge.offsetWidth;
        this.comboBadge.classList.add('is-pop');
      }
      this.comboFillEl.style.transform = `scaleX(${clamp(snap.comboTimer, 0, 1).toFixed(3)})`;
    }
    this.prevCombo = snap.combo;

    // Top-Center In-Game Shared Earth Expedition Badge (Region, Weather, Live GPS & Waterway)
    const activeZone = earthWorld.getZoneById(snap.currentTrackId ?? this.selectedTrackId);
    const activeMode: RouteMode = snap.routeMode ?? this.selectedRouteMode;
    const isConnectedMode = activeMode !== 'single_track';
    const weatherText = snap.weatherLabel ?? activeZone.weather.label;
    const weatherIcon = getWeatherIcon(activeZone.weather);
    const zoneIcon = getZoneIcon(activeZone);

    // Determine next destination label for connected modes
    const connectedZones = getConnectedZonesForRegion(activeZone.id);
    const fallbackNextZone = connectedZones[0] ?? activeZone;
    const matchedNextZone = snap.nextTrackName
      ? (earthWorld.getAllZones().find((z) => z.name === snap.nextTrackName) ?? fallbackNextZone)
      : fallbackNextZone;
    const nextLabel = isConnectedMode
      ? `Next: ${getZoneIcon(matchedNextZone)} ${snap.nextTrackName ?? matchedNextZone.name}`
      : `📍 Single Track · ${activeZone.country}`;

    const waterwayLabel =
      snap.waterwayName ??
      (snap.waterwayId ? earthWorld.getWaterwayById(snap.waterwayId)?.name : undefined) ??
      earthWorld.getPrimaryWaterwayForRegion(activeZone.id)?.name ??
      activeZone.name;

    const expKey = `${activeZone.id}|${activeMode}|${weatherText}|${nextLabel}|${waterwayLabel}`;
    if (expKey !== this.cachedExpeditionKey) {
      this.cachedExpeditionKey = expKey;
      this.expeditionTitleEl.textContent = `${zoneIcon} ${(snap.currentTrackName ?? activeZone.name).toUpperCase()}`;
      this.expeditionWeatherEl.textContent = `${weatherIcon} ${weatherText}`;
      this.expeditionWaterwayEl.textContent = waterwayLabel;
      this.expeditionNextEl.textContent = nextLabel;
      this.expeditionBadge.style.setProperty('--rd-track-accent', activeZone.accentColor);
      this.expeditionProgressWrap.classList.toggle('rd-hidden', !isConnectedMode);
    }

    // Live GPS coords readout inside expedition badge (diffed to 0.1 deg precision)
    const gpsLat = snap.lat ?? activeZone.centerLat;
    const gpsLng = snap.lng ?? activeZone.centerLng;
    const gpsText = formatLatLng(gpsLat, gpsLng);
    if (gpsText !== this.cachedGpsKey) {
      this.cachedGpsKey = gpsText;
      this.expeditionGpsEl.textContent = gpsText;
    }

    if (isConnectedMode) {
      const prog =
        snap.trackProgress !== undefined
          ? clamp(snap.trackProgress, 0, 1)
          : clamp((snap.distanceMeters % 26.5) / 26.5, 0, 1);
      this.expeditionProgressFill.style.transform = `scaleX(${prog.toFixed(3)})`;
    }

    // Physical Kayaking River Fork Signpost (`snapshot.upcomingFork`)
    this.updateForkSignpost(snap.upcomingFork ?? null);

    // Check if active region changed during World Tour / Free Earth
    if (snap.currentTrackId && snap.currentTrackId !== this.lastTrackId) {
      this.lastTrackId = snap.currentTrackId;
      this.showExpeditionPostcardToast(activeZone);
      if (snap.visitedTrackIds) {
        this.globe.setVisitedTracks(snap.visitedTrackIds);
      }
    } else if (!snap.currentTrackId && snap.biomeName && snap.biomeName !== this.lastBiomeName) {
      this.lastBiomeName = snap.biomeName;
      this.showBiomeToast(snap.biomeName);
    }

    // Cave Shortcut indicator
    this.cavePill.classList.toggle('is-visible', snap.inCave);

    // Floating gameplay callouts
    if (snap.callout && snap.callout.id !== this.lastCalloutId) {
      this.lastCalloutId = snap.callout.id;
      this.showCallout(snap.callout.text, snap.callout.tone);
    }

    // Active power-up pills
    const activeByType = new Map<PowerUpType, ActivePowerUpHud>();
    for (let i = 0; i < snap.activePowerUps.length; i++) {
      const p = snap.activePowerUps[i];
      if (p.remaining > 0.01) {
        activeByType.set(p.type, p);
      }
    }

    for (const type of POWERUP_ORDER) {
      const refs = this.boostPills.get(type);
      if (!refs) continue;
      const item = activeByType.get(type);
      if (item) {
        refs.root.classList.remove('rd-hidden');
        refs.timeEl.textContent = `${item.remaining.toFixed(1)}s`;
        refs.fillEl.style.transform = `scaleX(${clamp(item.normalized, 0, 1).toFixed(3)})`;
      } else if (type === 'soap_shield' && snap.shieldActive) {
        refs.root.classList.remove('rd-hidden');
        refs.timeEl.textContent = '1 HIT';
        refs.fillEl.style.transform = 'scaleX(1)';
      } else {
        refs.root.classList.add('rd-hidden');
      }
    }

    // Diegetic Underwater Breath Ring (shows ONLY while diving or recovering)
    const breath = clamp(snap.breath, 0, 1);
    const showBreath = snap.isUnderwater || breath < 0.985;
    const bubbleLungActive = activeByType.has('bubble_lung');
    const isLowBreath = breath < DUCK_CONFIG.lowBreathThreshold;

    this.breathWrap.classList.toggle('is-visible', showBreath);
    this.breathWrap.classList.toggle('is-boosted', bubbleLungActive);
    this.breathWrap.classList.toggle('is-low', showBreath && isLowBreath);
    this.hintBanner.classList.toggle('has-breath', showBreath);

    if (showBreath) {
      const offset = BREATH_RING_CIRCUMFERENCE * (1 - breath);
      this.breathArc.style.strokeDashoffset = offset.toFixed(2);
      this.breathLabel.textContent = `${Math.round(breath * 100)}%`;
    }

    // First-run sequential non-intrusive hints
    this.updateFirstRunHints(snap);
  }

  /**
   * Render and smoothly update the Kayaking River Fork Signpost when approaching
   * a real 2-way physical `EarthJunction` split.
   */
  private updateForkSignpost(forkRaw: RiverForkHint | null): void {
    const fork = forkRaw as ForkHintWithCompat | null;
    const visible = Boolean(fork && fork.distanceU >= 0);

    this.forkSignpost.classList.toggle('is-visible', visible);
    this.playHud.classList.toggle('has-fork', visible);

    if (!visible || !fork) {
      if (this.cachedForkKey !== '') {
        this.cachedForkKey = '';
      }
      return;
    }

    const chosenSide: 'left' | 'right' =
      fork.selectedSide ??
      fork.chosenSide ??
      (fork.defaultBranchId === fork.rightBranchId ? 'right' : 'left');
    const distMeters = Math.max(1, Math.round(fork.distanceU * SCALE.DISPLAY_METERS_PER_UNIT));

    const forkKey = `${fork.junctionId}|${distMeters}|${chosenSide}|${fork.leftBranchId}|${fork.rightBranchId}`;
    if (forkKey === this.cachedForkKey) return;
    this.cachedForkKey = forkKey;

    const leftWw = earthWorld.getWaterwayById(fork.leftBranchId);
    const rightWw = earthWorld.getWaterwayById(fork.rightBranchId);
    const leftTargetZone = leftWw ? earthWorld.resolveTargetRegionForWaterway(leftWw) : null;
    const rightTargetZone = rightWw ? earthWorld.resolveTargetRegionForWaterway(rightWw) : null;

    const leftIcon = leftTargetZone ? getZoneIcon(leftTargetZone) : '🌊';
    const rightIcon = rightTargetZone ? getZoneIcon(rightTargetZone) : '🌊';

    this.forkHeaderEl.textContent = `🔱 RIVER FORK · ${fork.junctionName.toUpperCase()} (${distMeters} m)`;
    this.forkLeftTitleEl.textContent = `⬅️ ${leftIcon} ${fork.leftRegionName || fork.leftBranchName}`;
    this.forkLeftSubEl.textContent = fork.leftBranchName;

    this.forkRightTitleEl.textContent = `${rightIcon} ${fork.rightRegionName || fork.rightBranchName} ➡️`;
    this.forkRightSubEl.textContent = fork.rightBranchName;

    this.forkLeftWing.classList.toggle('is-chosen', chosenSide === 'left');
    this.forkRightWing.classList.toggle('is-chosen', chosenSide === 'right');
    if (leftTargetZone) {
      this.forkLeftWing.style.setProperty('--rd-fork-accent', leftTargetZone.accentColor);
    }
    if (rightTargetZone) {
      this.forkRightWing.style.setProperty('--rd-fork-accent', rightTargetZone.accentColor);
    }
  }

  private updateFirstRunHints(snap: HudSnapshot): void {
    if (this.hintsSeen || !snap.controlsHintVisible || snap.gameState !== 'playing') {
      if (this.activeHintStage !== -1) {
        this.activeHintStage = -1;
        this.hintBanner.classList.remove('is-visible');
      }
      return;
    }

    const elapsedSec = (performance.now() - this.runStartMs) / 1000;
    let stage = -1;
    if (elapsedSec >= 0.45 && elapsedSec < 3.85) {
      stage = 0;
    } else if (elapsedSec >= 4.5 && elapsedSec < 8.1) {
      stage = 1;
    } else if (elapsedSec >= 8.8 && elapsedSec < 12.6) {
      stage = 2;
    } else if (elapsedSec >= 13.0) {
      this.hintsSeen = true;
      safeStorageSet(STORAGE_HINTS_SEEN_KEY, '1');
      stage = -1;
    }

    if (stage !== this.activeHintStage) {
      this.activeHintStage = stage;
      if (stage === -1) {
        this.hintBanner.classList.remove('is-visible');
      } else {
        const touch = this.inputDevice === 'touch';
        const pad = this.inputDevice === 'gamepad';
        if (stage === 0) {
          this.hintIconSlot.innerHTML = SVG_STEER;
          this.hintTextEl.textContent = touch
            ? 'Drag to Carve & Pick Forks'
            : pad
              ? 'Left Stick to Carve & Pick Forks'
              : 'A / D to Carve & Pick River Forks';
        } else if (stage === 1) {
          this.hintIconSlot.innerHTML = SVG_JUMP;
          this.hintTextEl.textContent = touch
            ? 'Swipe ↑ to Jump Dams'
            : pad
              ? 'Press A to Jump Dams & Roots'
              : 'Space / ↑ to Jump Dams & Roots';
        } else {
          this.hintIconSlot.innerHTML = SVG_DIVE;
          this.hintTextEl.textContent = touch
            ? 'Hold ↓ to Dive Bridges'
            : pad
              ? 'Hold B to Dive Under Bridges'
              : 'Hold S / ↓ to Dive Under Bridges';
        }
        this.hintBanner.classList.add('is-visible');
      }
    }
  }

  private updateGameOverCard(snap: HudSnapshot): void {
    const score = Math.max(0, Math.round(snap.score));
    const bestScore = Math.max(score, Math.round(snap.highScore));
    const isNewBest =
      this.extraMetrics.isNewBest ?? (score > 0 && score > this.runStartHighScore);

    this.newBestRibbon.classList.toggle('rd-hidden', !isNewBest);
    this.gameOverTitleEl.textContent = isNewBest ? 'New River Record!' : 'Splashdown!';

    if (snap.crashReason) {
      this.crashReasonEl.textContent = snap.crashReason;
      this.crashReasonEl.classList.remove('rd-hidden');
    } else {
      this.crashReasonEl.classList.add('rd-hidden');
    }

    this.goDistEl.textContent = `${formatInt(snap.distanceMeters)} m`;
    this.goScoreEl.textContent = formatInt(score);
    this.goBestEl.textContent = formatInt(bestScore);
    this.goCoinsEl.textContent = formatInt(snap.coins);

    const caves = this.extraMetrics.cavesCleared ?? this.autoCavesCleared;
    const waterfalls = this.extraMetrics.waterfallsCleared ?? this.autoWaterfallsCleared;
    this.goCavesEl.textContent = `${caves} ${caves === 1 ? 'Cave' : 'Caves'}`;
    this.goWaterfallsEl.textContent = `${waterfalls} ${waterfalls === 1 ? 'Waterfall' : 'Waterfalls'}`;

    const visited =
      snap.visitedTrackIds && snap.visitedTrackIds.length > 0
        ? snap.visitedTrackIds
        : [snap.currentTrackId ?? this.selectedTrackId];
    const icons = visited.map((id) => getZoneIcon(id)).join(' ');
    this.goRegionsEl.textContent = `🌍 ${visited.length} ${visited.length === 1 ? 'Region' : 'Regions'} ${icons}`;
  }

  private showExpeditionPostcardToast(zone: EarthRegionZone): void {
    const icon = getZoneIcon(zone);
    this.biomeToastText.textContent = `🌍 ENTERING ${zone.region.toUpperCase()}, ${zone.country.toUpperCase()} — ${zone.name}`;
    this.biomeToastSub.textContent = `${icon} ${zone.subtitle}`;
    this.biomeToastSub.classList.remove('rd-hidden');
    this.biomeToast.style.setProperty('--rd-track-accent', zone.accentColor);
    this.biomeToast.classList.add('is-visible');

    if (this.biomeToastTimer !== null) {
      window.clearTimeout(this.biomeToastTimer);
    }
    this.biomeToastTimer = window.setTimeout(() => {
      this.biomeToast.classList.remove('is-visible');
      this.biomeToastTimer = null;
    }, 3600);
  }

  private showBiomeToast(biomeName: string): void {
    this.biomeToastText.textContent = biomeName;
    this.biomeToastSub.textContent = '';
    this.biomeToastSub.classList.add('rd-hidden');
    this.biomeToast.classList.add('is-visible');
    if (this.biomeToastTimer !== null) {
      window.clearTimeout(this.biomeToastTimer);
    }
    this.biomeToastTimer = window.setTimeout(() => {
      this.biomeToast.classList.remove('is-visible');
      this.biomeToastTimer = null;
    }, 3100);
  }

  private showCallout(text: string, tone: 'info' | 'bonus' | 'warning' | 'powerup'): void {
    this.calloutEl.textContent = text;
    this.calloutEl.dataset.tone = tone;
    this.calloutEl.classList.add('is-visible');
    if (this.calloutTimer !== null) {
      window.clearTimeout(this.calloutTimer);
    }
    this.calloutTimer = window.setTimeout(() => {
      this.calloutEl.classList.remove('is-visible');
      this.calloutTimer = null;
    }, 1850);
  }

  /**
   * Build a 3-hop connected planetary route preview starting from `startZone`.
   */
  private buildRoutePreviewText(startZone: EarthRegionZone, mode: RouteMode): string {
    if (mode === 'single_track') {
      return `${getZoneIcon(startZone)} ${startZone.name} (${startZone.country}) · Locked Route`;
    }

    const hops: EarthRegionZone[] = [startZone];
    const visited = new Set<string>([startZone.id]);
    let curr = startZone;
    for (let i = 0; i < 2; i++) {
      const connected = getConnectedZonesForRegion(curr.id);
      const next = connected.find((z) => !visited.has(z.id)) ?? connected[0];
      if (!next) break;
      hops.push(next);
      visited.add(next.id);
      curr = next;
    }

    const sep = mode === 'free_earth' ? ' ⑂ ' : ' → ';
    const parts = hops.map((z, idx) =>
      idx === 0 ? `${getZoneIcon(z)} ${z.name}` : `${getZoneIcon(z)} ${z.country}`,
    );
    return `${parts.join(sep)}...`;
  }

  private syncGlobeFooterStats(): void {
    const net = earthWorld.getGlobeNetworkData();
    this.globeContribNoteEl.textContent = `Shared Mini-Earth · ${net.zones.length} Regions · ${net.waterways.length} Connected Waterways · ${net.junctions.length} Junctions — zero-core-edit contributor packs`;
  }

  private syncRouteUi(): void {
    const zone = earthWorld.getZoneById(this.selectedTrackId);
    const isConnectedMode = this.selectedRouteMode !== 'single_track';

    // 1. Title screen route preview bar
    this.titleModeChip.textContent = ROUTE_MODE_LABELS[this.selectedRouteMode];
    this.titleModeChip.dataset.mode = this.selectedRouteMode;
    this.titleRouteSeqEl.textContent = this.buildRoutePreviewText(zone, this.selectedRouteMode);

    // 2. Globe stage selected overlay pill (keep coords concise so both pills show cleanly)
    this.globeSelectedIconEl.textContent = getZoneIcon(zone);
    this.globeSelectedNameEl.textContent = zone.name;
    this.globeCoordsPillEl.textContent = formatLatLng(zone.centerLat, zone.centerLng);

    // 3. Globe Modal Mode Toggle buttons
    for (const [mode, btn] of this.globeModeBtns) {
      const active = mode === this.selectedRouteMode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }

    // 4. Region cards selection & outgoing connection highlighting
    const connectedIds = new Set(getConnectedZonesForRegion(zone.id).map((z) => z.id));
    for (const [id, refs] of this.globeTrackCards) {
      const isSelected = id === zone.id;
      const isOutgoing = isConnectedMode && connectedIds.has(id);
      refs.card.classList.toggle('is-selected', isSelected);
      refs.card.classList.toggle('is-connected', isOutgoing);
      refs.card.setAttribute('aria-pressed', String(isSelected));
      const bestM = Math.round(this.trackBestMeters[id] ?? 0);
      refs.bestEl.textContent = bestM > 0 ? `Best: ${formatInt(bestM)} m` : 'Best: —';
    }

    // 5. Modal Launch CTA text
    this.globeLaunchTextEl.textContent = `Splash Into ${zone.name}!`;
  }

  private buildGlobeTrackCards(): void {
    for (const fn of this.globeCardCleanups) {
      fn();
    }
    this.globeCardCleanups = [];
    this.globeTrackCards.clear();
    this.globeTrackGridEl.innerHTML = '';

    const allZones = earthWorld.getAllZones();
    for (const zone of allZones) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'rd-track-card';
      card.dataset.trackId = zone.id;
      card.dataset.hudInteractive = 'true';
      card.style.setProperty('--rd-track-accent', zone.accentColor);

      const diff = formatTrackDifficulty(zone.difficulty);
      const weatherIcon = getWeatherIcon(zone.weather);
      const weatherLabel = zone.weather.label;
      const connectedZones = getConnectedZonesForRegion(zone.id);
      const connNames =
        connectedZones.length > 0
          ? connectedZones.map((z) => `${getZoneIcon(z)} ${z.name}`).join(', ')
          : 'Open Planetary Network';

      card.innerHTML = `
        <div class="rd-track-card-top">
          <span class="rd-track-card-region">
            <span class="rd-track-card-icon">${getZoneIcon(zone)}</span>
            <span class="rd-track-card-region-text">${zone.country} · ${zone.region}</span>
          </span>
          <span class="rd-track-card-diff" title="Difficulty: ${diff.label}">
            <span class="rd-track-card-stars">${diff.stars}</span>
            <span>${diff.label}</span>
          </span>
        </div>
        <div class="rd-track-card-title">${zone.name}</div>
        <div class="rd-track-card-subtitle">${zone.subtitle}</div>
        <div class="rd-track-card-badges">
          <span class="rd-track-weather-pill">${weatherIcon} ${weatherLabel}</span>
          <span class="rd-track-best-pill rd-tabular" data-ref="track-best">Best: —</span>
        </div>
        <div class="rd-track-card-conns">
          <span class="rd-track-conns-label">Forks to:</span>
          <span class="rd-track-conns-list">${connNames}</span>
        </div>
      `;

      this.globeTrackGridEl.appendChild(card);
      this.globeTrackCards.set(zone.id, {
        card,
        bestEl: card.querySelector('[data-ref="track-best"]') as HTMLElement,
      });

      const onCardClick = (e: MouseEvent): void => {
        e.stopPropagation();
        this.callbacks.onUserGesture?.();
        this.setRouteSelection(this.selectedRouteMode, zone.id, true);
      };
      card.addEventListener('click', onCardClick);
      this.globeCardCleanups.push(() => card.removeEventListener('click', onCardClick));
    }
  }

  private syncSettingsUi(): void {
    this.syncQualityButtons();
    this.switchSound.setAttribute('aria-checked', String(!this.settings.muted));
    this.switchTouch.setAttribute('aria-checked', String(this.settings.showTouchControls));
    this.switchFps.setAttribute('aria-checked', String(this.settings.showFps));
    this.updateOverlayVisibility();
  }

  private syncQualityButtons(): void {
    for (const [level, btn] of this.qualityButtons) {
      btn.classList.toggle('is-active', level === this.settings.quality);
      btn.setAttribute('aria-pressed', String(level === this.settings.quality));
    }
  }

  private syncDeviceCopy(): void {
    const touch = this.inputDevice === 'touch';
    const pad = this.inputDevice === 'gamepad';
    this.hintSteerSub.textContent = touch ? 'Drag' : pad ? 'Left Stick' : 'A / D · ← / →';
    this.hintJumpSub.textContent = touch ? 'Swipe ↑' : pad ? 'A / RB' : 'Space / ↑';
    this.hintDiveSub.textContent = touch ? 'Hold ↓' : pad ? 'Hold B / LT' : 'Hold S / ↓';
    this.tapNoteEl.textContent = touch
      ? 'Tap Play or explore Mini-Earth below'
      : pad
        ? 'Press A to splash in'
        : 'Press Space or click Play';
  }

  private releaseVirtualButtons(): void {
    if (this.jumpPointerId !== null) {
      this.jumpPointerId = null;
      this.touchJumpBtn?.classList.remove('is-pressed');
      this.callbacks.onVirtualJump?.(false);
    }
    if (this.divePointerId !== null) {
      this.divePointerId = null;
      this.touchDiveBtn?.classList.remove('is-pressed');
      this.callbacks.onVirtualDive?.(false);
    }
  }

  // ---------------------------------------------------------------------------
  // DOM Construction & Event Binding (Runs Once)
  // ---------------------------------------------------------------------------

  private mount(): void {
    this.root.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'rd-hud';

    const net = earthWorld.getGlobeNetworkData();

    container.innerHTML = `
      <!-- Persistent Top-Right Utility Controls -->
      <div class="rd-top-right">
        <div class="rd-fps-pill rd-tabular rd-hidden" data-ref="fps-pill">60 FPS</div>
        <button type="button" class="rd-icon-btn" data-hud-interactive="true" data-ref="mute-btn" aria-label="Mute audio">
          ${SVG_SPEAKER_ON}
        </button>
        <button type="button" class="rd-icon-btn" data-hud-interactive="true" data-ref="pause-settings-btn" aria-label="Open settings">
          ${SVG_SETTINGS}
        </button>
      </div>

      <!-- Title Screen Overlay -->
      <section class="rd-title-overlay" data-ref="title-overlay" aria-label="River Ducker Title Screen">
        <header class="rd-title-hero">
          <div class="rd-emblem">
            ${SVG_DUCK_CREST}
            <h1 class="rd-title-wordmark">RIVER DUCKER</h1>
            <p class="rd-title-tagline">Shared Mini-Earth World Tour</p>
          </div>
          <div class="rd-best-badge rd-glass rd-tabular rd-hidden" data-ref="best-badge">
            <span data-ref="best-score-title">Best 0</span>
            <span class="rd-best-sep">·</span>
            <span data-ref="best-dist-title">0 m</span>
          </div>
        </header>

        <div class="rd-title-actions">
          <!-- Mini-Earth Route Bar / Preview Pill -->
          <div class="rd-route-preview-bar rd-glass" data-hud-interactive="true" data-ref="title-route-bar">
            <div class="rd-route-preview-top">
              <button
                type="button"
                class="rd-route-mode-chip"
                data-hud-interactive="true"
                data-ref="title-mode-chip"
                title="Click to cycle World Tour, Free Earth, or Single Track"
              >
                🌍 World Tour
              </button>
              <span class="rd-route-preview-seq" data-ref="title-route-seq">
                🌲 Cascade Sunlit Creek → 🌸 Japan → 🌧️ Brazil...
              </span>
            </div>
            <button
              type="button"
              class="rd-explore-globe-btn"
              data-hud-interactive="true"
              data-ref="open-globe-btn"
            >
              ${SVG_GLOBE}
              <span>🌍 Explore Mini-Earth / Select Track</span>
            </button>
          </div>

          <button type="button" class="rd-cta-btn rd-play-cta" data-hud-interactive="true" data-ref="play-btn">
            ${SVG_PLAY}
            <span>Play</span>
          </button>
          <div class="rd-tap-note" data-ref="tap-note">Press Space or click Play</div>
          <div class="rd-loading-bar rd-hidden" data-ref="loading-bar" aria-label="Loading assets">
            <div class="rd-loading-fill" data-ref="loading-fill"></div>
          </div>
        </div>

        <div class="rd-controls-strip" aria-label="Controls overview">
          <div class="rd-control-chip rd-glass">
            ${SVG_STEER}
            <span class="rd-control-chip-title">Steer & Forks</span>
            <span class="rd-control-chip-sub" data-ref="hint-steer-sub">Drag</span>
          </div>
          <div class="rd-control-chip rd-glass">
            ${SVG_JUMP}
            <span class="rd-control-chip-title">Jump</span>
            <span class="rd-control-chip-sub" data-ref="hint-jump-sub">Swipe ↑</span>
          </div>
          <div class="rd-control-chip rd-glass">
            ${SVG_DIVE}
            <span class="rd-control-chip-title">Dive</span>
            <span class="rd-control-chip-sub" data-ref="hint-dive-sub">Hold ↓</span>
          </div>
        </div>
      </section>

      <!-- Active Gameplay HUD -->
      <section class="rd-play-hud rd-hidden" data-ref="play-hud" aria-label="Gameplay HUD">
        <div class="rd-top-left">
          <div class="rd-score-cluster rd-glass rd-tabular">
            <div class="rd-metric-primary">
              <span class="rd-distance-val" data-ref="distance-val">0</span>
              <span class="rd-distance-unit">m</span>
            </div>
            <div class="rd-metric-sub-group">
              <div class="rd-metric-col">
                <span class="rd-metric-label">Score</span>
                <span class="rd-metric-num" data-ref="score-val">0</span>
              </div>
              <div class="rd-coin-pill" title="Golden Bubbles">
                <span class="rd-coin-dot"></span>
                <span data-ref="coins-val">0</span>
              </div>
            </div>
          </div>

          <div class="rd-combo-badge rd-tabular" data-ref="combo-badge">
            <div class="rd-combo-row">
              <span class="rd-combo-mult" data-ref="combo-mult">x2</span>
              <span class="rd-combo-text">Combo</span>
            </div>
            <div class="rd-combo-bar">
              <div class="rd-combo-fill" data-ref="combo-fill"></div>
            </div>
          </div>

          <div class="rd-boost-stack" data-ref="boost-stack"></div>
        </div>

        <div class="rd-top-center">
          <!-- Persistent Shared-Earth Live GPS Expedition Badge -->
          <div class="rd-expedition-badge rd-glass" data-ref="expedition-badge">
            <div class="rd-expedition-main">
              <span class="rd-expedition-title" data-ref="expedition-title">🌲 CASCADE SUNLIT CREEK</span>
              <span class="rd-expedition-sep">·</span>
              <span class="rd-expedition-weather" data-ref="expedition-weather">☀️ Sunlit Forest Breeze</span>
            </div>
            <div class="rd-expedition-gps-row">
              <span class="rd-expedition-gps rd-tabular" data-ref="expedition-gps">44.1°N · 122.2°W</span>
              <span class="rd-expedition-sep">·</span>
              <span class="rd-expedition-waterway" data-ref="expedition-waterway">Cascade Sunlit Creek</span>
            </div>
            <div class="rd-expedition-sub">
              <div class="rd-expedition-progress" data-ref="expedition-progress-wrap">
                <div class="rd-expedition-progress-fill" data-ref="expedition-progress-fill"></div>
              </div>
              <span class="rd-expedition-next" data-ref="expedition-next">Next: 🌸 Kyoto Sakura Stream</span>
            </div>
          </div>

          <!-- Kayaking Physical River Fork Signpost -->
          <div class="rd-fork-signpost rd-glass" data-ref="fork-signpost" aria-live="polite">
            <div class="rd-fork-header rd-tabular" data-ref="fork-header">
              🔱 RIVER FORK · CONFLUENCE AHEAD
            </div>
            <div class="rd-fork-wings">
              <div class="rd-fork-wing rd-fork-wing--left" data-ref="fork-left-wing">
                <span class="rd-fork-wing-title" data-ref="fork-left-title">⬅️ Left Branch</span>
                <span class="rd-fork-wing-sub" data-ref="fork-left-sub">Waterway</span>
              </div>
              <div class="rd-fork-wing rd-fork-wing--right" data-ref="fork-right-wing">
                <span class="rd-fork-wing-title" data-ref="fork-right-title">Right Branch ➡️</span>
                <span class="rd-fork-wing-sub" data-ref="fork-right-sub">Waterway</span>
              </div>
            </div>
          </div>

          <!-- Expedition Postcard / Biome Toast -->
          <div class="rd-biome-toast rd-glass" data-ref="biome-toast">
            <div class="rd-biome-toast-row">
              <span class="rd-biome-dot"></span>
              <span data-ref="biome-toast-text">Sunlit Moss Creek</span>
            </div>
            <div class="rd-biome-toast-sub rd-hidden" data-ref="biome-toast-sub"></div>
          </div>

          <div class="rd-cave-pill" data-ref="cave-pill">
            <span>✦</span>
            <span>CAVE SHORTCUT!</span>
          </div>
          <div class="rd-callout" data-ref="callout" data-tone="info"></div>
        </div>

        <!-- Diegetic Underwater Breath Ring -->
        <div class="rd-breath-wrap" data-ref="breath-wrap" aria-label="Underwater Breath">
          <div class="rd-breath-core">
            <svg class="rd-breath-svg" viewBox="0 0 78 78">
              <defs>
                <linearGradient id="rd-breath-boost-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#4de8ff"/>
                  <stop offset="100%" stop-color="#ffe45e"/>
                </linearGradient>
              </defs>
              <circle class="rd-breath-track" cx="39" cy="39" r="${BREATH_RING_RADIUS}"/>
              <circle
                class="rd-breath-arc"
                data-ref="breath-arc"
                cx="39"
                cy="39"
                r="${BREATH_RING_RADIUS}"
                stroke-dasharray="${BREATH_RING_CIRCUMFERENCE.toFixed(2)}"
                stroke-dashoffset="0"
              />
            </svg>
            <div class="rd-breath-center">
              ${SVG_BUBBLES}
              <span class="rd-breath-label rd-tabular" data-ref="breath-label">100%</span>
            </div>
          </div>
        </div>

        <!-- First-Run Visual Hint -->
        <div class="rd-hint-banner rd-glass" data-ref="hint-banner">
          <span data-ref="hint-icon-slot">${SVG_STEER}</span>
          <span data-ref="hint-text">Drag to Carve</span>
        </div>

        <!-- Mobile Optional On-Screen Jump & Hold-Dive Buttons -->
        <div class="rd-touch-controls rd-hidden" data-ref="touch-controls">
          <button
            type="button"
            class="rd-touch-btn rd-touch-btn--jump"
            data-hud-interactive="true"
            data-ref="touch-jump-btn"
            aria-label="Jump"
          >
            ${SVG_JUMP}
            <span>Jump</span>
          </button>
          <button
            type="button"
            class="rd-touch-btn rd-touch-btn--dive"
            data-hud-interactive="true"
            data-ref="touch-dive-btn"
            aria-label="Hold to Dive"
          >
            ${SVG_DIVE}
            <span>Dive</span>
          </button>
        </div>
      </section>

      <!-- Interactive 3D Shared Mini-Earth Globe & Route Selector Modal -->
      <div
        class="rd-modal-backdrop rd-globe-backdrop rd-hidden"
        data-hud-interactive="true"
        data-ref="globe-modal-backdrop"
      >
        <div
          class="rd-globe-modal-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rd-globe-modal-heading"
        >
          <header class="rd-globe-modal-header">
            <div class="rd-globe-modal-title-group">
              <h2 class="rd-globe-modal-title" id="rd-globe-modal-heading">
                🌍 Shared Mini-Earth Globe & Planetary Waterways
              </h2>
              <p class="rd-globe-modal-subtitle">
                Explore real connected rivers, 2-way forks & landmarks on one living globe — drag to spin or tap any region
              </p>
            </div>
            <button
              type="button"
              class="rd-icon-btn rd-drawer-close"
              data-hud-interactive="true"
              data-ref="globe-close-btn"
              aria-label="Close Mini-Earth Globe"
            >
              ${SVG_CLOSE}
            </button>
          </header>

          <div class="rd-globe-modal-body">
            <!-- Left / Top: Interactive 3D Shared Mini-Earth Globe Stage -->
            <div class="rd-globe-stage-col">
              <div class="rd-globe-canvas-host" data-ref="globe-canvas-host">
                <div class="rd-globe-stage-overlayTop">
                  <span class="rd-globe-selected-pill">
                    <span class="rd-globe-selected-icon" data-ref="globe-selected-icon">🌲</span>
                    <span class="rd-globe-selected-name" data-ref="globe-selected-name">Cascade Sunlit Creek</span>
                  </span>
                  <span class="rd-globe-coords-pill rd-tabular" data-ref="globe-coords-pill">
                    44.1°N · 122.2°W
                  </span>
                </div>
                <div class="rd-globe-stage-hint">
                  Drag to spin 3D Earth · Cyan diamonds = 2-way River Forks
                </div>
              </div>

              <!-- 3-Mode Route Toggle (World Tour / Free Earth / Single Track) -->
              <div class="rd-globe-mode-toggle rd-globe-mode-toggle--3" role="group" aria-label="Expedition Route Mode">
                <button
                  type="button"
                  class="rd-globe-mode-btn is-active"
                  data-hud-interactive="true"
                  data-route-mode="world_tour"
                >
                  <span class="rd-globe-mode-title">🌍 World Tour</span>
                  <span class="rd-globe-mode-desc">Connected Journey</span>
                </button>
                <button
                  type="button"
                  class="rd-globe-mode-btn"
                  data-hud-interactive="true"
                  data-route-mode="free_earth"
                >
                  <span class="rd-globe-mode-title">🧭 Free Earth</span>
                  <span class="rd-globe-mode-desc">Steer Any Fork</span>
                </button>
                <button
                  type="button"
                  class="rd-globe-mode-btn"
                  data-hud-interactive="true"
                  data-route-mode="single_track"
                >
                  <span class="rd-globe-mode-title">📍 Single Track</span>
                  <span class="rd-globe-mode-desc">Lock Region</span>
                </button>
              </div>
            </div>

            <!-- Right / Bottom: Auto-Discovered Region Atlas Grid -->
            <div class="rd-globe-tracks-col">
              <div class="rd-globe-track-grid" data-ref="globe-track-grid"></div>
            </div>
          </div>

          <footer class="rd-globe-modal-footer">
            <span class="rd-globe-contrib-note" data-ref="globe-contrib-note">
              Shared Mini-Earth · ${net.zones.length} Regions · ${net.waterways.length} Connected Waterways · ${net.junctions.length} Junctions — zero-core-edit contributor packs
            </span>
            <button
              type="button"
              class="rd-cta-btn rd-globe-launch-btn"
              data-hud-interactive="true"
              data-ref="globe-launch-btn"
            >
              ${SVG_PLAY}
              <span data-ref="globe-launch-text">Splash Into Cascade Sunlit Creek!</span>
            </button>
          </footer>
        </div>
      </div>

      <!-- Pause & Settings Drawer -->
      <div class="rd-modal-backdrop rd-hidden" data-hud-interactive="true" data-ref="drawer-backdrop">
        <div class="rd-drawer-card" role="dialog" aria-modal="true" aria-labelledby="rd-drawer-heading">
          <div class="rd-drawer-header">
            <h2 class="rd-drawer-title" id="rd-drawer-heading" data-ref="drawer-title">Settings</h2>
            <button type="button" class="rd-icon-btn rd-drawer-close" data-hud-interactive="true" data-ref="drawer-close-btn" aria-label="Close">
              ${SVG_CLOSE}
            </button>
          </div>

          <div class="rd-pause-actions rd-hidden" data-ref="pause-actions">
            <button type="button" class="rd-cta-btn" data-hud-interactive="true" data-ref="resume-btn">
              ${SVG_PLAY}
              <span>Resume</span>
            </button>
            <button type="button" class="rd-secondary-btn rd-world-map-btn" data-hud-interactive="true" data-ref="pause-globe-btn">
              <span>🌍 World Map</span>
            </button>
            <div class="rd-pause-row">
              <button type="button" class="rd-secondary-btn" data-hud-interactive="true" data-ref="pause-restart-btn">
                ${SVG_RESTART}
                <span>Restart</span>
              </button>
              <button type="button" class="rd-secondary-btn" data-hud-interactive="true" data-ref="pause-title-btn">
                ${SVG_HOME}
                <span>Title</span>
              </button>
            </div>
          </div>

          <div class="rd-settings-group">
            <div class="rd-setting-block">
              <div class="rd-setting-row">
                <span class="rd-setting-label">Graphics Quality</span>
                <span class="rd-setting-sub" data-ref="quality-active-sub">Auto (High)</span>
              </div>
              <div class="rd-segmented" role="group" aria-label="Graphics Quality">
                <button type="button" class="rd-seg-btn" data-hud-interactive="true" data-quality="auto">Auto</button>
                <button type="button" class="rd-seg-btn" data-hud-interactive="true" data-quality="high">High</button>
                <button type="button" class="rd-seg-btn" data-hud-interactive="true" data-quality="performance">Performance</button>
              </div>
            </div>

            <div class="rd-setting-row">
              <span class="rd-setting-label">Sound Effects & Creek</span>
              <button type="button" class="rd-switch" role="switch" aria-checked="true" data-hud-interactive="true" data-ref="switch-sound" aria-label="Toggle Sound"></button>
            </div>

            <div class="rd-setting-row">
              <span class="rd-setting-label">On-Screen Buttons</span>
              <button type="button" class="rd-switch" role="switch" aria-checked="false" data-hud-interactive="true" data-ref="switch-touch" aria-label="Toggle On-Screen Buttons"></button>
            </div>

            <div class="rd-setting-row">
              <span class="rd-setting-label">FPS Counter</span>
              <button type="button" class="rd-switch" role="switch" aria-checked="false" data-hud-interactive="true" data-ref="switch-fps" aria-label="Toggle FPS Counter"></button>
            </div>
          </div>
        </div>
      </div>

      <!-- Instant-Restart Game Over Card -->
      <section class="rd-gameover-overlay rd-hidden" data-hud-interactive="true" data-ref="gameover-overlay" aria-label="Game Over Summary">
        <div class="rd-gameover-card">
          <div class="rd-new-best-ribbon rd-hidden" data-ref="new-best-ribbon">★ NEW BEST! ★</div>
          <h2 class="rd-gameover-title" data-ref="gameover-title">Splashdown!</h2>
          <p class="rd-crash-reason rd-hidden" data-ref="crash-reason"></p>

          <div class="rd-stats-grid rd-tabular">
            <div class="rd-stat-tile">
              <span class="rd-stat-label">Distance</span>
              <span class="rd-stat-val" data-ref="go-dist">0 m</span>
            </div>
            <div class="rd-stat-tile rd-stat-tile--highlight">
              <span class="rd-stat-label">Score</span>
              <span class="rd-stat-val" data-ref="go-score">0</span>
            </div>
            <div class="rd-stat-tile">
              <span class="rd-stat-label">Best Score</span>
              <span class="rd-stat-val" data-ref="go-best">0</span>
            </div>
            <div class="rd-stat-tile">
              <span class="rd-stat-label">Bubbles</span>
              <span class="rd-stat-val" data-ref="go-coins">0</span>
            </div>
          </div>

          <div class="rd-cleared-row rd-tabular">
            <span class="rd-mini-pill" data-ref="go-regions">🌍 1 Region 🌲</span>
            <span class="rd-mini-pill" data-ref="go-waterfalls">0 Waterfalls</span>
            <span class="rd-mini-pill" data-ref="go-caves">0 Caves</span>
          </div>

          <button type="button" class="rd-secondary-btn rd-go-globe-btn" data-hud-interactive="true" data-ref="go-globe-btn">
            <span>🌍 World Map — Change Region / Mode</span>
          </button>

          <div class="rd-gameover-actions">
            <button type="button" class="rd-cta-btn rd-restart-cta" data-hud-interactive="true" data-ref="restart-btn">
              ${SVG_RESTART}
              <span>Splash Again!</span>
            </button>
            <button type="button" class="rd-icon-btn rd-gameover-icon-btn" data-hud-interactive="true" data-ref="go-title-btn" aria-label="Return to Title">
              ${SVG_HOME}
            </button>
            <button type="button" class="rd-icon-btn rd-gameover-icon-btn" data-hud-interactive="true" data-ref="go-settings-btn" aria-label="Open Settings">
              ${SVG_SETTINGS}
            </button>
          </div>
        </div>
      </section>
    `;

    this.root.appendChild(container);

    const q = <T extends HTMLElement>(ref: string): T => {
      const el = container.querySelector<T>(`[data-ref="${ref}"]`);
      if (!el) throw new Error(`River Ducker HUD missing element ref: ${ref}`);
      return el;
    };

    // Bind refs
    this.fpsPill = q('fps-pill');
    this.muteBtn = q<HTMLButtonElement>('mute-btn');
    this.pauseSettingsBtn = q<HTMLButtonElement>('pause-settings-btn');

    this.titleOverlay = q('title-overlay');
    this.bestBadge = q('best-badge');
    this.bestScoreTitleEl = q('best-score-title');
    this.bestDistTitleEl = q('best-dist-title');
    this.titleModeChip = q<HTMLButtonElement>('title-mode-chip');
    this.titleRouteSeqEl = q('title-route-seq');
    this.openGlobeBtn = q<HTMLButtonElement>('open-globe-btn');
    this.loadingBar = q('loading-bar');
    this.loadingFill = q('loading-fill');
    this.hintSteerSub = q('hint-steer-sub');
    this.hintJumpSub = q('hint-jump-sub');
    this.hintDiveSub = q('hint-dive-sub');
    this.tapNoteEl = q('tap-note');

    this.globeModalBackdrop = q('globe-modal-backdrop');
    this.globeCanvasHost = q('globe-canvas-host');
    this.globeSelectedIconEl = q('globe-selected-icon');
    this.globeSelectedNameEl = q('globe-selected-name');
    this.globeCoordsPillEl = q('globe-coords-pill');
    this.globeTrackGridEl = q('globe-track-grid');
    this.globeContribNoteEl = q('globe-contrib-note');
    this.globeLaunchBtn = q<HTMLButtonElement>('globe-launch-btn');
    this.globeLaunchTextEl = q('globe-launch-text');

    this.playHud = q('play-hud');
    this.distanceValEl = q('distance-val');
    this.scoreValEl = q('score-val');
    this.coinsValEl = q('coins-val');
    this.comboBadge = q('combo-badge');
    this.comboMultEl = q('combo-mult');
    this.comboFillEl = q('combo-fill');
    this.expeditionBadge = q('expedition-badge');
    this.expeditionTitleEl = q('expedition-title');
    this.expeditionWeatherEl = q('expedition-weather');
    this.expeditionGpsEl = q('expedition-gps');
    this.expeditionWaterwayEl = q('expedition-waterway');
    this.expeditionNextEl = q('expedition-next');
    this.expeditionProgressWrap = q('expedition-progress-wrap');
    this.expeditionProgressFill = q('expedition-progress-fill');

    this.forkSignpost = q('fork-signpost');
    this.forkHeaderEl = q('fork-header');
    this.forkLeftWing = q('fork-left-wing');
    this.forkLeftTitleEl = q('fork-left-title');
    this.forkLeftSubEl = q('fork-left-sub');
    this.forkRightWing = q('fork-right-wing');
    this.forkRightTitleEl = q('fork-right-title');
    this.forkRightSubEl = q('fork-right-sub');

    this.biomeToast = q('biome-toast');
    this.biomeToastText = q('biome-toast-text');
    this.biomeToastSub = q('biome-toast-sub');
    this.cavePill = q('cave-pill');
    this.calloutEl = q('callout');

    this.breathWrap = q('breath-wrap');
    this.breathArc = container.querySelector('[data-ref="breath-arc"]') as SVGCircleElement;
    this.breathLabel = q('breath-label');

    this.hintBanner = q('hint-banner');
    this.hintIconSlot = q('hint-icon-slot');
    this.hintTextEl = q('hint-text');

    this.touchControlsWrap = q('touch-controls');
    this.touchJumpBtn = q<HTMLButtonElement>('touch-jump-btn');
    this.touchDiveBtn = q<HTMLButtonElement>('touch-dive-btn');

    this.drawerBackdrop = q('drawer-backdrop');
    this.drawerTitleEl = q('drawer-title');
    this.pauseActionsWrap = q('pause-actions');
    this.qualityActiveSub = q('quality-active-sub');
    this.switchSound = q<HTMLButtonElement>('switch-sound');
    this.switchTouch = q<HTMLButtonElement>('switch-touch');
    this.switchFps = q<HTMLButtonElement>('switch-fps');

    this.gameOverOverlay = q('gameover-overlay');
    this.newBestRibbon = q('new-best-ribbon');
    this.gameOverTitleEl = q('gameover-title');
    this.crashReasonEl = q('crash-reason');
    this.goDistEl = q('go-dist');
    this.goScoreEl = q('go-score');
    this.goBestEl = q('go-best');
    this.goCoinsEl = q('go-coins');
    this.goCavesEl = q('go-caves');
    this.goWaterfallsEl = q('go-waterfalls');
    this.goRegionsEl = q('go-regions');

    // Instantiate interactive Shared-Planet 3D Mini-Earth Globe inside `globeCanvasHost`
    this.globe = new MiniEarthGlobe(this.globeCanvasHost, {
      initialTrackId: this.selectedTrackId,
      initialRouteMode: this.selectedRouteMode,
      onSelectTrack: (trackId) => {
        this.callbacks.onUserGesture?.();
        this.setRouteSelection(this.selectedRouteMode, trackId, true);
      },
    });

    // Build dynamic Region Cards from `earthWorld.getAllZones()`
    this.buildGlobeTrackCards();
    this.syncGlobeFooterStats();

    // Bind Globe Mode Toggle buttons (world_tour / free_earth / single_track)
    const modeBtns = container.querySelectorAll<HTMLButtonElement>('[data-route-mode]');
    modeBtns.forEach((btn) => {
      const mode = btn.dataset.routeMode as RouteMode;
      this.globeModeBtns.set(mode, btn);
      this.on(btn, 'click', (e) => {
        e.stopPropagation();
        btn.blur();
        this.callbacks.onUserGesture?.();
        this.setRouteSelection(mode, this.selectedTrackId, true);
      });
    });

    // Title route bar interactions
    this.on(this.titleModeChip, 'click', (e) => {
      e.stopPropagation();
      this.titleModeChip.blur();
      this.callbacks.onUserGesture?.();
      const currIdx = ROUTE_MODE_CYCLE.indexOf(this.selectedRouteMode);
      const nextMode = ROUTE_MODE_CYCLE[(currIdx + 1) % ROUTE_MODE_CYCLE.length];
      this.setRouteSelection(nextMode, this.selectedTrackId, true);
    });

    this.on(this.openGlobeBtn, 'click', (e) => {
      e.stopPropagation();
      this.openGlobeBtn.blur();
      this.callbacks.onUserGesture?.();
      this.openGlobeModal();
    });

    const titleRouteBar = q('title-route-bar');
    this.on(titleRouteBar, 'click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-ref="title-mode-chip"]')) return;
      this.callbacks.onUserGesture?.();
      this.openGlobeModal();
    });

    // Globe Modal close & launch actions
    const globeCloseBtn = q<HTMLButtonElement>('globe-close-btn');
    this.on(globeCloseBtn, 'click', (e) => {
      e.stopPropagation();
      globeCloseBtn.blur();
      this.closeGlobeModal();
    });

    this.on(this.globeModalBackdrop, 'click', (e) => {
      if (e.target === this.globeModalBackdrop) {
        this.closeGlobeModal();
      }
    });

    this.on(this.globeLaunchBtn, 'click', (e) => {
      e.stopPropagation();
      this.globeLaunchBtn.blur();
      this.callbacks.onUserGesture?.();
      this.closeGlobeModal();
      this.settingsDrawerOpen = false;
      this.updateOverlayVisibility();

      if (this.callbacks.onRouteChange) {
        this.callbacks.onRouteChange(this.selectedRouteMode, this.selectedTrackId, true);
      } else if (this.currentGameState === 'title') {
        this.callbacks.onPlay();
      } else {
        this.callbacks.onRestart();
      }
    });

    // World Map buttons on Pause Drawer and Game Over Card
    const pauseGlobeBtn = q<HTMLButtonElement>('pause-globe-btn');
    this.on(pauseGlobeBtn, 'click', (e) => {
      e.stopPropagation();
      pauseGlobeBtn.blur();
      this.callbacks.onUserGesture?.();
      this.openGlobeModal();
    });

    const goGlobeBtn = q<HTMLButtonElement>('go-globe-btn');
    this.on(goGlobeBtn, 'click', (e) => {
      e.stopPropagation();
      goGlobeBtn.blur();
      this.callbacks.onUserGesture?.();
      this.openGlobeModal();
    });

    // Pre-build reusable boost pills (zero DOM churn during play)
    const boostStack = q('boost-stack');
    for (const type of POWERUP_ORDER) {
      const pill = document.createElement('div');
      pill.className = 'rd-boost-pill rd-hidden';
      pill.dataset.type = type;
      pill.innerHTML = `
        <span class="rd-boost-icon">${POWERUP_ICONS[type]}</span>
        <div class="rd-boost-body">
          <div class="rd-boost-head">
            <span>${POWERUP_CONFIG[type].label}</span>
            <span class="rd-boost-time rd-tabular">0.0s</span>
          </div>
          <div class="rd-boost-track">
            <div class="rd-boost-fill"></div>
          </div>
        </div>
      `;
      boostStack.appendChild(pill);
      this.boostPills.set(type, {
        root: pill,
        timeEl: pill.querySelector('.rd-boost-time') as HTMLElement,
        fillEl: pill.querySelector('.rd-boost-fill') as HTMLElement,
      });
    }

    // Bind quality segmented buttons
    const segButtons = container.querySelectorAll<HTMLButtonElement>('[data-quality]');
    segButtons.forEach((btn) => {
      const level = btn.dataset.quality as QualityLevel;
      this.qualityButtons.set(level, btn);
      this.on(btn, 'click', () => {
        btn.blur();
        this.callbacks.onUserGesture?.();
        this.settings.quality = level;
        this.syncQualityButtons();
        this.callbacks.onQualityChange(level);
      });
    });

    // Wire primary buttons
    const playBtn = q<HTMLButtonElement>('play-btn');
    this.on(playBtn, 'click', (e) => {
      e.stopPropagation();
      playBtn.blur();
      this.callbacks.onUserGesture?.();
      this.callbacks.onPlay();
    });

    // Tap anywhere on open title overlay to play seamlessly
    this.on(this.titleOverlay, 'click', (e) => {
      if (this.settingsDrawerOpen || this.globeModalOpen) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-hud-interactive]')) return;
      this.callbacks.onUserGesture?.();
      this.callbacks.onPlay();
    });

    this.on(this.muteBtn, 'click', (e) => {
      e.stopPropagation();
      this.muteBtn.blur();
      this.callbacks.onUserGesture?.();
      const nextMuted = !this.settings.muted;
      this.settings.muted = nextMuted;
      this.callbacks.onMuteToggle(nextMuted);
    });

    this.on(this.pauseSettingsBtn, 'click', (e) => {
      e.stopPropagation();
      this.pauseSettingsBtn.blur();
      this.callbacks.onUserGesture?.();
      if (this.globeModalOpen) {
        this.closeGlobeModal();
        return;
      }
      if (this.currentGameState === 'playing') {
        this.callbacks.onPause();
      } else if (this.currentGameState === 'paused') {
        this.callbacks.onResume();
      } else {
        this.settingsDrawerOpen = !this.settingsDrawerOpen;
        this.updateOverlayVisibility();
      }
    });

    // Drawer controls
    const drawerCloseBtn = q<HTMLButtonElement>('drawer-close-btn');
    this.on(drawerCloseBtn, 'click', () => {
      drawerCloseBtn.blur();
      this.closeSettings();
    });

    this.on(this.drawerBackdrop, 'click', (e) => {
      if (e.target === this.drawerBackdrop) {
        this.closeSettings();
      }
    });

    const resumeBtn = q<HTMLButtonElement>('resume-btn');
    this.on(resumeBtn, 'click', () => {
      resumeBtn.blur();
      this.callbacks.onUserGesture?.();
      this.callbacks.onResume();
    });

    const pauseRestartBtn = q<HTMLButtonElement>('pause-restart-btn');
    this.on(pauseRestartBtn, 'click', () => {
      pauseRestartBtn.blur();
      this.callbacks.onUserGesture?.();
      this.settingsDrawerOpen = false;
      this.callbacks.onRestart();
    });

    const pauseTitleBtn = q<HTMLButtonElement>('pause-title-btn');
    if (!this.callbacks.onReturnTitle) {
      pauseTitleBtn.classList.add('rd-hidden');
      const pauseRow = pauseTitleBtn.parentElement;
      if (pauseRow) {
        pauseRow.style.gridTemplateColumns = '1fr';
      }
    } else {
      this.on(pauseTitleBtn, 'click', () => {
        pauseTitleBtn.blur();
        this.settingsDrawerOpen = false;
        this.callbacks.onReturnTitle?.();
      });
    }

    // Settings switches
    this.on(this.switchSound, 'click', () => {
      this.switchSound.blur();
      this.callbacks.onUserGesture?.();
      const nextMuted = !this.settings.muted;
      this.settings.muted = nextMuted;
      this.switchSound.setAttribute('aria-checked', String(!nextMuted));
      this.callbacks.onMuteToggle(nextMuted);
    });

    this.on(this.switchTouch, 'click', () => {
      this.switchTouch.blur();
      const next = !this.settings.showTouchControls;
      this.setSettings({ showTouchControls: next });
      this.callbacks.onTouchControlsChange?.(next);
    });

    this.on(this.switchFps, 'click', () => {
      this.switchFps.blur();
      const next = !this.settings.showFps;
      this.setSettings({ showFps: next });
      this.callbacks.onFpsToggle?.(next);
    });

    // Game Over controls
    const restartBtn = q<HTMLButtonElement>('restart-btn');
    this.on(restartBtn, 'click', () => {
      restartBtn.blur();
      this.callbacks.onUserGesture?.();
      this.callbacks.onRestart();
    });

    const goTitleBtn = q<HTMLButtonElement>('go-title-btn');
    if (!this.callbacks.onReturnTitle) {
      goTitleBtn.classList.add('rd-hidden');
    } else {
      this.on(goTitleBtn, 'click', () => {
        goTitleBtn.blur();
        this.callbacks.onReturnTitle?.();
      });
    }

    const goSettingsBtn = q<HTMLButtonElement>('go-settings-btn');
    this.on(goSettingsBtn, 'click', () => {
      goSettingsBtn.blur();
      this.openSettings();
    });

    // Virtual Mobile Jump & Hold-Dive buttons (multi-touch safe, isolated from canvas drag)
    this.bindVirtualButton(this.touchJumpBtn, 'jump');
    this.bindVirtualButton(this.touchDiveBtn, 'dive');
  }

  private bindVirtualButton(btn: HTMLButtonElement, kind: 'jump' | 'dive'): void {
    const onDown = (e: PointerEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      this.callbacks.onUserGesture?.();

      if (kind === 'jump') {
        if (this.jumpPointerId !== null) return;
        this.jumpPointerId = e.pointerId;
        btn.classList.add('is-pressed');
        this.callbacks.onVirtualJump?.(true);
      } else {
        if (this.divePointerId !== null) return;
        this.divePointerId = e.pointerId;
        btn.classList.add('is-pressed');
        this.callbacks.onVirtualDive?.(true);
      }

      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture failure on synthetic events.
      }
    };

    const onUp = (e: PointerEvent): void => {
      e.preventDefault();
      e.stopPropagation();

      if (kind === 'jump' && e.pointerId === this.jumpPointerId) {
        this.jumpPointerId = null;
        btn.classList.remove('is-pressed');
        this.callbacks.onVirtualJump?.(false);
      } else if (kind === 'dive' && e.pointerId === this.divePointerId) {
        this.divePointerId = null;
        btn.classList.remove('is-pressed');
        this.callbacks.onVirtualDive?.(false);
      }

      try {
        if (btn.hasPointerCapture?.(e.pointerId)) {
          btn.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore.
      }
    };

    this.on(btn, 'pointerdown', onDown);
    this.on(btn, 'pointerup', onUp);
    this.on(btn, 'pointercancel', onUp);
    this.on(btn, 'contextmenu', (e) => e.preventDefault());
  }

  private on<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ): void {
    el.addEventListener(type, handler);
    this.cleanups.push(() => el.removeEventListener(type, handler));
  }
}
