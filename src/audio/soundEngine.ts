import { DUCK_CONFIG } from '../config';
import {
  blendAudioScaleParams,
  earthWorld,
  type AudioScaleParams,
  type AudioTimbre,
} from '../earth';
import type {
  AudioAmbienceState,
  AudioController,
  AudioEventName,
  AudioEvents,
  CollectibleKind,
  PowerUpType,
} from '../types';

const STORAGE_MUTE_KEY = 'river_ducker_muted_v1';

const DEFAULT_SCALE_INTERVALS = [0, 2, 4, 7, 9, 12];

export interface EarthAudioAmbienceState extends AudioAmbienceState {
  /** Optional real Mini-Earth latitude in degrees for spatial biome audio blending. */
  lat?: number;
  /** Optional real Mini-Earth longitude in degrees for spatial biome audio blending. */
  lng?: number;
}

type WebkitWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Convert a MIDI note number (e.g. 69 = A4 = 440Hz, 72 = C5) into frequency in Hz.
 */
function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Compute frequency (Hz) for step `stepIndex` along any contributor pack's
 * data-driven `AudioScaleParams` (`baseMidi` + `scaleIntervals`, with octave wrapping).
 */
function getScaleNoteHz(profile: AudioScaleParams, stepIndex: number): number {
  const intervals =
    profile.scaleIntervals && profile.scaleIntervals.length > 0
      ? profile.scaleIntervals
      : DEFAULT_SCALE_INTERVALS;
  const safeIdx = Math.max(0, Math.floor(stepIndex));
  const octaves = Math.floor(safeIdx / intervals.length);
  const degree = safeIdx % intervals.length;
  const midi = profile.baseMidi + intervals[degree] + octaves * 12;
  return clamp(midiToHz(midi), 65, 4200);
}

function readStoredMute(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStoredMute(muted: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_MUTE_KEY, muted ? '1' : '0');
    }
  } catch {
    // Ignore storage errors in private browsing or restricted contexts.
  }
}

/**
 * 100% data-driven procedural Web Audio API sound engine for River Ducker: Shared Mini-Earth.
 *
 * Drives all musical chimes, near-miss accents, transition fanfares, and continuous
 * regional weather/river/wind/geothermal soundscapes directly from `AudioScaleParams`
 * blended spatially via `earthWorld.getBlendedRegionAt(lat, lng)` — zero hardcoded regions!
 */
export class SoundEngine implements AudioController {
  private ctx: AudioContext | null = null;
  private muted: boolean;
  private disposed = false;
  private graphReady = false;

  // Active data-driven AudioScaleParams (blended spatially or by region ID)
  private currentAudioProfile: AudioScaleParams = earthWorld.getZoneById().audioProfile;

  // Noise buffers (generated once on unlock)
  private whiteBuffer: AudioBuffer | null = null;
  private pinkBuffer: AudioBuffer | null = null;
  private brownBuffer: AudioBuffer | null = null;

  // Master & routing nodes
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private underwaterFilter: BiquadFilterNode | null = null;
  private sfxBus: GainNode | null = null;
  private sfxUnderwaterFilter: BiquadFilterNode | null = null;

  // Cave & canyon echo/resonance send bus
  private caveAmbienceSend: GainNode | null = null;
  private caveSfxSend: GainNode | null = null;
  private caveReturnGain: GainNode | null = null;

  // Continuous ambience layers
  private creekGain: GainNode | null = null;
  private creekFilter: BiquadFilterNode | null = null;
  private rapidsGain: GainNode | null = null;
  private rapidsFilter: BiquadFilterNode | null = null;
  private roarGain: GainNode | null = null;
  private roarFilter: BiquadFilterNode | null = null;
  private sprayGain: GainNode | null = null;
  private sprayFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windWhistleGain: GainNode | null = null;
  private windWhistleFilter: BiquadFilterNode | null = null;
  private rainPatterGain: GainNode | null = null;
  private rainPatterFilter: BiquadFilterNode | null = null;
  private rainShimmerGain: GainNode | null = null;
  private rainShimmerFilter: BiquadFilterNode | null = null;
  private geothermalGain: GainNode | null = null;
  private geothermalOsc: OscillatorNode | null = null;
  private geothermalSteamGain: GainNode | null = null;
  private geothermalSteamFilter: BiquadFilterNode | null = null;
  private subHumGain: GainNode | null = null;
  private subHumOsc: OscillatorNode | null = null;

  private activeLoops: AudioBufferSourceNode[] = [];

  // Dynamic modulation & cooldown tracking
  private ambienceTime = 0;
  private bubbleTimer = 0.25;
  private rainDropletTimer = 0.12;
  private lastBreathPulseAt = -10;
  private lastSpookAt = -10;
  private lastFlapAt = -10;
  private lastThunderAt = -10;
  private lastBubbleChimeAt = -10;
  private lastSubmersion = 0;

  // Auto-unlock gesture cleanup
  private unlockCleanup: (() => void) | null = null;

  constructor(options?: { muted?: boolean; autoAttachUnlock?: boolean }) {
    this.muted = options?.muted ?? readStoredMute();
    if (options?.autoAttachUnlock !== false && typeof window !== 'undefined') {
      this.attachAutoUnlock();
    }
  }

  /** Attach one-shot gesture listeners so Web Audio unlocks cleanly on first tap/key. */
  public attachAutoUnlock(target: EventTarget = window): void {
    if (this.unlockCleanup || this.disposed) return;
    const onGesture = (): void => {
      void this.unlock();
      this.detachAutoUnlock();
    };
    const events = ['pointerdown', 'touchstart', 'keydown'] as const;
    for (const ev of events) {
      target.addEventListener(ev, onGesture, { passive: true });
    }
    this.unlockCleanup = () => {
      for (const ev of events) {
        target.removeEventListener(ev, onGesture);
      }
      this.unlockCleanup = null;
    };
  }

  private detachAutoUnlock(): void {
    if (this.unlockCleanup) {
      this.unlockCleanup();
    }
  }

  public async unlock(): Promise<void> {
    if (this.disposed) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    if (!this.graphReady) {
      this.buildGraph(ctx);
    }

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // Ignore resume failure in restricted headless environments.
      }
    }
    this.applyMasterMute(0.04);
  }

  public isUnlocked(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    writeStoredMute(muted);
    this.applyMasterMute(0.035);
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public getCurrentAudioProfile(): AudioScaleParams {
    return this.currentAudioProfile;
  }

  public getCurrentTimbre(): AudioTimbre {
    return this.currentAudioProfile.timbre;
  }

  /**
   * Update active regional audio parameters directly from planetary `(lat, lng)`.
   */
  public setGeoAudioPosition(lat: number, lng: number): AudioScaleParams {
    const blended = earthWorld.getBlendedRegionAt(lat, lng).audioProfile;
    this.currentAudioProfile = blended;
    return blended;
  }

  /**
   * Fallback helper to set/blend regional audio parameters by region/track ID.
   */
  public setTrackAudioProfile(
    trackId?: string | null,
    nextTrackId?: string | null,
    blend = 0,
  ): AudioScaleParams {
    const zoneA = earthWorld.getZoneById(trackId);
    const zoneB = nextTrackId ? earthWorld.getZoneById(nextTrackId) : zoneA;
    const blended = blendAudioScaleParams(
      zoneA.audioProfile,
      zoneB.audioProfile,
      clamp(blend, 0, 1),
    );
    this.currentAudioProfile = blended;
    return blended;
  }

  /**
   * Typed AudioController event dispatcher.
   */
  public emit<K extends AudioEventName>(
    event: K,
    ...args: AudioEvents[K] extends undefined ? [] : [payload: AudioEvents[K]]
  ): void {
    if (this.disposed || this.muted) return;
    const ctx = this.ctx;
    if (!ctx || !this.graphReady) return;
    if (ctx.state !== 'running') {
      if (event === 'start_run' && ctx.state === 'suspended') {
        void ctx
          .resume()
          .then(() => {
            if (!this.disposed && !this.muted && this.ctx?.state === 'running') {
              this.playStartRun(this.ctx.currentTime);
            }
          })
          .catch(() => undefined);
      }
      return;
    }

    const payload = args[0] as AudioEvents[K];
    const now = ctx.currentTime;

    switch (event) {
      case 'start_run':
        this.playStartRun(now);
        break;
      case 'pause':
        this.playUiDrop(now, 520, 360, 0.12);
        break;
      case 'resume':
        this.playUiDrop(now, 390, 620, 0.12);
        break;
      case 'game_over': {
        const p = payload as AudioEvents['game_over'];
        this.playGameOver(now, p.isNewBest);
        break;
      }
      case 'jump': {
        const p = payload as AudioEvents['jump'];
        const charge = clamp(p.charge, 0.2, 1.5);
        this.playRubberDuckSqueak(now, 'happy', 1.0 + charge * 0.08, 0.55);
        if (p.fromUnderwater) {
          this.playBreachSplash(now, 0.95);
        } else {
          this.playSplashBurst(now, 0.48 + charge * 0.2, 'skim');
        }
        break;
      }
      case 'wing_flap': {
        const p = payload as AudioEvents['wing_flap'];
        if (now - this.lastFlapAt >= 0.09) {
          this.lastFlapAt = now;
          this.playWingFlap(now, clamp(p.intensity, 0.15, 1.2));
        }
        break;
      }
      case 'dive_enter': {
        const p = payload as AudioEvents['dive_enter'];
        const normSpeed = clamp(p.speed / DUCK_CONFIG.maxSpeed, 0.35, 1.2);
        this.playDivePlunge(now, normSpeed);
        break;
      }
      case 'dive_exit': {
        const p = payload as AudioEvents['dive_exit'];
        this.playBreachSplash(now, clamp(p.breachPower, 0.35, 1.3));
        break;
      }
      case 'breath_low': {
        const p = payload as AudioEvents['breath_low'];
        const urgency = clamp(
          1 - p.breath / Math.max(DUCK_CONFIG.lowBreathThreshold, 0.01),
          0,
          1,
        );
        const minInterval = lerp(0.85, 0.42, urgency);
        if (now - this.lastBreathPulseAt >= minInterval) {
          this.lastBreathPulseAt = now;
          this.playLowBreathPulse(now, urgency);
        }
        break;
      }
      case 'splash': {
        const p = payload as AudioEvents['splash'];
        this.playSplashBurst(now, clamp(p.intensity, 0.1, 1.5), p.kind);
        break;
      }
      case 'quack': {
        const p = payload as AudioEvents['quack'];
        this.playRubberDuckSqueak(now, p.mood, p.pitch ?? 1.0, 0.72);
        break;
      }
      case 'spook_balance': {
        const p = payload as AudioEvents['spook_balance'];
        if (now - this.lastSpookAt >= 0.24) {
          this.lastSpookAt = now;
          const intensity = clamp(p.intensity, 0.25, 1.2);
          this.playRubberDuckSqueak(now, 'spooked', 1.0 + intensity * 0.08, 0.65 * intensity);
          this.playWingFlap(now + 0.03, 0.55 * intensity);
        }
        break;
      }
      case 'collect': {
        const p = payload as AudioEvents['collect'];
        this.playCollectibleChime(now, p.kind, p.combo);
        break;
      }
      case 'powerup_pickup': {
        const p = payload as AudioEvents['powerup_pickup'];
        this.playPowerUpFanfare(now, p.powerUp);
        break;
      }
      case 'powerup_expire': {
        this.playPowerUpExpire(now);
        break;
      }
      case 'shield_break':
        this.playShieldBounce(now);
        break;
      case 'near_miss': {
        const p = payload as AudioEvents['near_miss'];
        this.playNearMiss(now, p.combo);
        break;
      }
      case 'crash':
        this.playCrash(now);
        break;
      case 'waterfall_drop': {
        const p = payload as AudioEvents['waterfall_drop'];
        this.playWaterfallDropCue(now, clamp(p.dropHeight / 12, 0.5, 1.4));
        break;
      }
      case 'cave_transition': {
        const p = payload as AudioEvents['cave_transition'];
        this.playCaveTransition(now, p.entering);
        break;
      }
      case 'track_transition': {
        const p = payload as AudioEvents['track_transition'];
        const zone = earthWorld.getZoneById(p?.trackId);
        this.currentAudioProfile = zone.audioProfile;
        this.playTrackTransitionFanfare(now, zone.audioProfile);
        break;
      }
      case 'thunder': {
        const p = payload as AudioEvents['thunder'];
        if (now - this.lastThunderAt >= 0.35) {
          this.lastThunderAt = now;
          this.playThunderRumble(now, clamp(p?.intensity ?? 0.9, 0.2, 1.5));
        }
        break;
      }
    }
  }

  /**
   * Convenience wrapper allowing intensity-only triggers when callers don't build a full event payload.
   */
  public playEvent(event: AudioEventName, intensity = 1.0): void {
    const clamped = clamp(intensity, 0.1, 1.5);
    switch (event) {
      case 'start_run':
        this.emit('start_run');
        break;
      case 'pause':
        this.emit('pause');
        break;
      case 'resume':
        this.emit('resume');
        break;
      case 'shield_break':
        this.emit('shield_break');
        break;
      case 'game_over':
        this.emit('game_over', { score: 0, isNewBest: false });
        break;
      case 'jump':
        this.emit('jump', { charge: clamped, fromUnderwater: this.lastSubmersion > 0.4 });
        break;
      case 'wing_flap':
        this.emit('wing_flap', { intensity: clamped });
        break;
      case 'dive_enter':
        this.emit('dive_enter', { speed: clamped * DUCK_CONFIG.baseSpeed });
        break;
      case 'dive_exit':
        this.emit('dive_exit', { breachPower: clamped });
        break;
      case 'breath_low':
        this.emit('breath_low', { breath: clamp(0.28 * (1 - clamped * 0.5), 0.02, 0.27) });
        break;
      case 'splash':
        this.emit('splash', {
          intensity: clamped,
          kind: clamped >= 1.15 ? 'waterfall' : clamped <= 0.45 ? 'skim' : 'land',
        });
        break;
      case 'quack':
        this.emit('quack', { mood: 'happy', pitch: 0.9 + clamped * 0.15 });
        break;
      case 'spook_balance':
        this.emit('spook_balance', { intensity: clamped });
        break;
      case 'collect':
        this.emit('collect', { kind: 'bubble_coin', combo: Math.max(1, Math.round(clamped * 3)) });
        break;
      case 'powerup_pickup':
        this.emit('powerup_pickup', { powerUp: 'wing_gust' });
        break;
      case 'powerup_expire':
        this.emit('powerup_expire', { powerUp: 'wing_gust' });
        break;
      case 'near_miss':
        this.emit('near_miss', { combo: Math.max(1, Math.round(clamped * 2)) });
        break;
      case 'crash':
        this.emit('crash', { obstacleType: 'boulder' });
        break;
      case 'waterfall_drop':
        this.emit('waterfall_drop', { dropHeight: 11 * clamped });
        break;
      case 'cave_transition':
        this.emit('cave_transition', { entering: clamped >= 0.5 });
        break;
      case 'track_transition': {
        const defZone = earthWorld.getZoneById();
        this.emit('track_transition', {
          trackId: defZone.id,
          trackName: defZone.name,
        });
        break;
      }
      case 'thunder':
        this.emit('thunder', { intensity: clamped });
        break;
    }
  }

  /**
   * Smoothly modulates all continuous soundscape layers from data-driven `AudioScaleParams`
   * blended spatially at `(state.lat, state.lng)` via `earthWorld.getBlendedRegionAt(lat, lng)`
   * (with graceful fallback to `state.trackId` / `state.nextTrackId` / `state.trackBlend`).
   */
  public updateAmbience(state: EarthAudioAmbienceState, dt: number): void {
    if (this.disposed) return;
    const safeDt = clamp(Number.isFinite(dt) ? dt : 0.016, 0, 0.12);
    this.ambienceTime += safeDt;

    // 100% data-driven spatial Earth biome audio blending (fallback to trackId)
    let profile: AudioScaleParams;
    if (
      state.lat !== undefined &&
      state.lng !== undefined &&
      Number.isFinite(state.lat) &&
      Number.isFinite(state.lng)
    ) {
      profile = earthWorld.getBlendedRegionAt(state.lat, state.lng).audioProfile;
    } else {
      const zoneA = earthWorld.getZoneById(state.trackId);
      const zoneB = state.nextTrackId ? earthWorld.getZoneById(state.nextTrackId) : zoneA;
      profile = blendAudioScaleParams(
        zoneA.audioProfile,
        zoneB.audioProfile,
        clamp(state.trackBlend ?? 0, 0, 1),
      );
    }
    this.currentAudioProfile = profile;

    const submersion = clamp(state.submersion, 0, 1);
    const rapids = clamp(state.rapidsIntensity, 0, 1);
    const waterfall = clamp(state.waterfallProximity, 0, 1);
    const airborne = clamp(state.airborneFactor, 0, 1);
    const speedNorm = clamp(
      (state.speed - DUCK_CONFIG.baseSpeed * 0.45) /
        Math.max(DUCK_CONFIG.maxSpeed - DUCK_CONFIG.baseSpeed * 0.45, 1),
      0,
      1.25,
    );

    this.lastSubmersion = submersion;

    const ctx = this.ctx;
    if (!ctx || !this.graphReady || ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const tau = 0.085;

    // Gentle organic babbling & wind gust LFOs
    const babbleLfoA = Math.sin(this.ambienceTime * 1.35) * 0.5 + 0.5;
    const babbleLfoB = Math.sin(this.ambienceTime * 2.9 + 1.4) * 0.5 + 0.5;
    const windGustLfo = Math.sin(this.ambienceTime * 0.72 + 0.6) * 0.5 + 0.5;

    // 1. Babbling creek bed driven purely by `profile.riverFilterHz`
    if (this.creekFilter && this.creekGain) {
      const baseHz = clamp(profile.riverFilterHz, 420, 1450);
      const creekFreq = baseHz + babbleLfoA * 420 + babbleLfoB * 210 + speedNorm * 260;
      const creekLevel = (0.11 + speedNorm * 0.06 + babbleLfoA * 0.025) * (1 - airborne * 0.38);
      this.creekFilter.frequency.setTargetAtTime(creekFreq, now, 0.14);
      this.creekGain.gain.setTargetAtTime(creekLevel, now, tau);
    }

    // 2. Whitewater rapids rush driven purely by `profile.rapidsGain`
    if (this.rapidsFilter && this.rapidsGain) {
      const rapidsMult = clamp(profile.rapidsGain, 0.4, 2.0);
      const rapidsFreq = 500 + rapids * 920 + speedNorm * 420;
      const rapidsLevel =
        (0.038 + rapids * 0.15 + speedNorm * 0.048) * rapidsMult * (1 - airborne * 0.3);
      this.rapidsFilter.frequency.setTargetAtTime(rapidsFreq, now, tau);
      this.rapidsGain.gain.setTargetAtTime(rapidsLevel, now, tau);
    }

    // 3. Deep river body + waterfall thunderous rumble
    if (this.roarFilter && this.roarGain) {
      const roarFreq = 135 + waterfall * 235 + rapids * 70;
      const roarLevel = 0.07 + rapids * 0.09 + waterfall * 0.34;
      this.roarFilter.frequency.setTargetAtTime(roarFreq, now, tau);
      this.roarGain.gain.setTargetAtTime(roarLevel, now, tau);
    }

    // 4. Waterfall bright spray hiss
    if (this.sprayFilter && this.sprayGain) {
      const sprayFreq = 2600 + waterfall * 1500 + babbleLfoB * 350;
      const sprayLevel = (waterfall * 0.16 + rapids * 0.035) * (1 - submersion * 0.9);
      this.sprayFilter.frequency.setTargetAtTime(sprayFreq, now, tau);
      this.sprayGain.gain.setTargetAtTime(sprayLevel, now, tau);
    }

    // 5. Regional & Flight Wind (`profile.windIntensity`, `profile.windPitch`)
    const regWind = clamp(profile.windIntensity, 0, 1);
    const regPitch = clamp(profile.windPitch, 0.45, 1.6);
    if (this.windFilter && this.windGain) {
      const baseWindHz = (420 + windGustLfo * 240 + airborne * 580 + speedNorm * 320) * regPitch;
      const regionalWindLevel = regWind * (0.045 + windGustLfo * 0.04);
      const flightWindLevel = airborne * (0.12 + speedNorm * 0.08);
      const totalWindLevel = (regionalWindLevel + flightWindLevel) * (1 - submersion * 0.92);

      this.windFilter.frequency.setTargetAtTime(clamp(baseWindHz, 160, 3400), now, 0.08);
      this.windFilter.Q.setTargetAtTime(lerp(1.7, 3.6, regWind), now, 0.1);
      this.windGain.gain.setTargetAtTime(totalWindLevel, now, 0.08);
    }

    // Secondary harmonic wind whistle / leaf-breeze resonator driven by continuous wind params
    if (this.windWhistleFilter && this.windWhistleGain) {
      // Lower windPitch + high windIntensity => resonant polar/canyon howl; higher windPitch => breezy rustle
      const howlWeight = clamp((0.92 - regPitch) * 2.4, 0, 1) * regWind;
      const whistleFreq = clamp(
        (560 + Math.sin(this.ambienceTime * 1.15) * 180 + windGustLfo * 220) *
          (regPitch > 1.0 ? regPitch * 1.45 : lerp(1.0, 1.28, howlWeight)),
        320,
        2800,
      );
      const whistleQ = lerp(1.9, 7.2, howlWeight);
      const whistleGain =
        regWind *
        (0.016 + howlWeight * 0.038 + Math.max(0, regPitch - 1.0) * 0.045) *
        (0.65 + windGustLfo * 0.55) *
        (1 - submersion * 0.95);

      this.windWhistleFilter.frequency.setTargetAtTime(whistleFreq, now, 0.1);
      this.windWhistleFilter.Q.setTargetAtTime(whistleQ, now, 0.12);
      this.windWhistleGain.gain.setTargetAtTime(whistleGain, now, 0.1);
    }

    // 6. Monsoon Rain Layer (`profile.rainIntensity`)
    const rain = clamp(profile.rainIntensity, 0, 1);
    if (this.rainPatterFilter && this.rainPatterGain) {
      const patterFreq = 1480 + babbleLfoA * 320 + windGustLfo * 220;
      const patterLevel = rain * (0.11 + windGustLfo * 0.03) * (1 - submersion * 0.82);
      this.rainPatterFilter.frequency.setTargetAtTime(patterFreq, now, 0.1);
      this.rainPatterGain.gain.setTargetAtTime(patterLevel, now, 0.1);
    }
    if (this.rainShimmerFilter && this.rainShimmerGain) {
      const shimmerFreq = 4100 + babbleLfoB * 600;
      const shimmerLevel = rain * (0.065 + babbleLfoA * 0.02) * (1 - submersion * 0.92);
      this.rainShimmerFilter.frequency.setTargetAtTime(shimmerFreq, now, 0.1);
      this.rainShimmerGain.gain.setTargetAtTime(shimmerLevel, now, 0.1);
    }
    if (!this.muted && rain > 0.12 && submersion < 0.75) {
      this.rainDropletTimer -= safeDt * (1.2 + rain * 3.8);
      if (this.rainDropletTimer <= 0) {
        this.rainDropletTimer = 0.045 + Math.random() * 0.11;
        this.playRainDropletCrackle(now, rain * (1 - submersion * 0.7));
      }
    }

    // 7. Geothermal Sub-Bass Rumble & Steam Vent Hiss (`profile.geothermalRumble`)
    const geo = clamp(profile.geothermalRumble, 0, 1);
    if (this.geothermalGain && this.geothermalOsc) {
      const geoLevel = geo * (0.105 + windGustLfo * 0.038);
      const geoFreq = 45 + Math.sin(this.ambienceTime * 1.7) * 4 + rapids * 6;
      this.geothermalGain.gain.setTargetAtTime(geoLevel, now, 0.12);
      this.geothermalOsc.frequency.setTargetAtTime(geoFreq, now, 0.12);
    }
    if (this.geothermalSteamFilter && this.geothermalSteamGain) {
      const steamPulse = Math.pow(Math.sin(this.ambienceTime * 0.95 + 2.1) * 0.5 + 0.5, 2);
      const steamFreq = 1950 + steamPulse * 1100;
      const steamLevel = geo * (0.028 + steamPulse * 0.055) * (1 - submersion * 0.88);
      this.geothermalSteamFilter.frequency.setTargetAtTime(steamFreq, now, 0.1);
      this.geothermalSteamGain.gain.setTargetAtTime(steamLevel, now, 0.1);
    }

    // 8. Seamless underwater audio morph (biquad lowpass down to ~380 Hz + sub-aquatic hum)
    if (this.underwaterFilter) {
      const cutoff = 18000 * Math.pow(380 / 18000, submersion);
      this.underwaterFilter.frequency.setTargetAtTime(cutoff, now, 0.06);
      this.underwaterFilter.Q.setTargetAtTime(lerp(0.65, 2.2, submersion), now, 0.06);
    }
    if (this.sfxUnderwaterFilter) {
      const sfxCutoff = 18000 * Math.pow(1750 / 18000, submersion);
      this.sfxUnderwaterFilter.frequency.setTargetAtTime(sfxCutoff, now, 0.06);
    }
    if (this.subHumGain && this.subHumOsc) {
      this.subHumGain.gain.setTargetAtTime(submersion * 0.115, now, 0.08);
      this.subHumOsc.frequency.setTargetAtTime(
        64 + Math.sin(this.ambienceTime * 1.1) * 5 + speedNorm * 8,
        now,
        0.12,
      );
    }

    // 9. Warm cave / deep gorge acoustic echo send
    const gorgeEchoHint =
      profile.timbre === 'warm' || profile.timbre === 'deep' ? 0.2 : 0;
    const caveAmt = state.inCave ? 1 : gorgeEchoHint;
    if (this.caveAmbienceSend && this.caveSfxSend && this.caveReturnGain) {
      this.caveAmbienceSend.gain.setTargetAtTime(caveAmt * 0.34, now, 0.22);
      this.caveSfxSend.gain.setTargetAtTime(caveAmt * 0.42, now, 0.18);
      this.caveReturnGain.gain.setTargetAtTime(caveAmt * 0.62, now, 0.22);
    }

    // 10. Gentle resonant underwater bubble pops when submerged
    if (!this.muted && submersion > 0.32) {
      this.bubbleTimer -= safeDt * (0.85 + speedNorm * 0.8 + submersion * 0.6);
      if (this.bubbleTimer <= 0) {
        this.bubbleTimer = 0.14 + Math.random() * 0.28;
        this.playUnderwaterBubblePop(now, submersion);
      }
    } else {
      this.bubbleTimer = Math.min(this.bubbleTimer, 0.18);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.detachAutoUnlock();

    for (const src of this.activeLoops) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already stopped source nodes.
      }
    }
    this.activeLoops = [];

    if (this.subHumOsc) {
      try {
        this.subHumOsc.stop();
        this.subHumOsc.disconnect();
      } catch {
        // Ignore
      }
      this.subHumOsc = null;
    }

    if (this.geothermalOsc) {
      try {
        this.geothermalOsc.stop();
        this.geothermalOsc.disconnect();
      } catch {
        // Ignore
      }
      this.geothermalOsc = null;
    }

    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.graphReady = false;
  }

  // ---------------------------------------------------------------------------
  // Audio Graph & Procedural Buffer Setup
  // ---------------------------------------------------------------------------

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === 'undefined') return null;

    const AudioCtxCtor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!AudioCtxCtor) return null;

    try {
      this.ctx = new AudioCtxCtor({ latencyHint: 'interactive' });
      return this.ctx;
    } catch {
      return null;
    }
  }

  private buildGraph(ctx: AudioContext): void {
    this.whiteBuffer = this.createNoiseBuffer(ctx, 'white', 3.0);
    this.pinkBuffer = this.createNoiseBuffer(ctx, 'pink', 3.0);
    this.brownBuffer = this.createNoiseBuffer(ctx, 'brown', 3.0);

    // Master dynamics & output gain
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.knee.value = 14;
    compressor.ratio.value = 4.5;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.16;

    const masterGain = ctx.createGain();
    masterGain.gain.value = this.muted ? 0 : 0.78;
    compressor.connect(masterGain);
    masterGain.connect(ctx.destination);

    this.compressor = compressor;
    this.masterGain = masterGain;

    // Cave & Gorge echo & warm resonance send bus
    const caveInput = ctx.createGain();
    caveInput.gain.value = 1.0;

    const caveDelayA = ctx.createDelay(0.5);
    caveDelayA.delayTime.value = 0.092;
    const caveDelayB = ctx.createDelay(0.5);
    caveDelayB.delayTime.value = 0.143;

    const caveDamp = ctx.createBiquadFilter();
    caveDamp.type = 'lowpass';
    caveDamp.frequency.value = 1250;

    const caveResonance = ctx.createBiquadFilter();
    caveResonance.type = 'peaking';
    caveResonance.frequency.value = 260;
    caveResonance.Q.value = 1.6;
    caveResonance.gain.value = 5.5;

    const caveFeedback = ctx.createGain();
    caveFeedback.gain.value = 0.34;

    const caveReturnGain = ctx.createGain();
    caveReturnGain.gain.value = 0;

    caveInput.connect(caveDelayA);
    caveDelayA.connect(caveDamp);
    caveDamp.connect(caveDelayB);
    caveDelayB.connect(caveFeedback);
    caveFeedback.connect(caveDelayA);

    caveDamp.connect(caveResonance);
    caveDelayB.connect(caveResonance);
    caveResonance.connect(caveReturnGain);
    caveReturnGain.connect(compressor);
    this.caveReturnGain = caveReturnGain;

    // Ambience bus -> Underwater lowpass morph -> Dry + Cave send
    const ambienceMix = ctx.createGain();
    ambienceMix.gain.value = 1.0;

    const underwaterFilter = ctx.createBiquadFilter();
    underwaterFilter.type = 'lowpass';
    underwaterFilter.frequency.value = 18000;
    underwaterFilter.Q.value = 0.7;

    const caveAmbienceSend = ctx.createGain();
    caveAmbienceSend.gain.value = 0;

    ambienceMix.connect(underwaterFilter);
    underwaterFilter.connect(compressor);
    underwaterFilter.connect(caveAmbienceSend);
    caveAmbienceSend.connect(caveInput);

    this.underwaterFilter = underwaterFilter;
    this.caveAmbienceSend = caveAmbienceSend;

    // SFX bus -> light underwater rounding -> Dry + Cave send
    const sfxBus = ctx.createGain();
    sfxBus.gain.value = 1.0;

    const sfxUnderwaterFilter = ctx.createBiquadFilter();
    sfxUnderwaterFilter.type = 'lowpass';
    sfxUnderwaterFilter.frequency.value = 18000;
    sfxUnderwaterFilter.Q.value = 0.65;

    const caveSfxSend = ctx.createGain();
    caveSfxSend.gain.value = 0;

    sfxBus.connect(sfxUnderwaterFilter);
    sfxUnderwaterFilter.connect(compressor);
    sfxUnderwaterFilter.connect(caveSfxSend);
    caveSfxSend.connect(caveInput);

    this.sfxBus = sfxBus;
    this.sfxUnderwaterFilter = sfxUnderwaterFilter;
    this.caveSfxSend = caveSfxSend;

    // Layer 1: Babbling Creek
    const creekSrc = this.createLoopSource(ctx, this.pinkBuffer, 0.0);
    const creekFilter = ctx.createBiquadFilter();
    creekFilter.type = 'bandpass';
    creekFilter.frequency.value = 1100;
    creekFilter.Q.value = 1.1;
    const creekGain = ctx.createGain();
    creekGain.gain.value = 0.08;
    creekSrc.connect(creekFilter);
    creekFilter.connect(creekGain);
    creekGain.connect(ambienceMix);
    this.creekFilter = creekFilter;
    this.creekGain = creekGain;

    // Layer 2: Whitewater Rapids Rush
    const rapidsSrc = this.createLoopSource(ctx, this.pinkBuffer, 1.15);
    const rapidsFilter = ctx.createBiquadFilter();
    rapidsFilter.type = 'bandpass';
    rapidsFilter.frequency.value = 720;
    rapidsFilter.Q.value = 0.75;
    const rapidsGain = ctx.createGain();
    rapidsGain.gain.value = 0.04;
    rapidsSrc.connect(rapidsFilter);
    rapidsFilter.connect(rapidsGain);
    rapidsGain.connect(ambienceMix);
    this.rapidsFilter = rapidsFilter;
    this.rapidsGain = rapidsGain;

    // Layer 3: Deep River Body / Waterfall Roar
    const roarSrc = this.createLoopSource(ctx, this.brownBuffer, 0.3);
    const roarFilter = ctx.createBiquadFilter();
    roarFilter.type = 'lowpass';
    roarFilter.frequency.value = 170;
    roarFilter.Q.value = 0.8;
    const roarGain = ctx.createGain();
    roarGain.gain.value = 0.07;
    roarSrc.connect(roarFilter);
    roarFilter.connect(roarGain);
    roarGain.connect(ambienceMix);
    this.roarFilter = roarFilter;
    this.roarGain = roarGain;

    // Layer 4: Waterfall Bright Spray Hiss
    const spraySrc = this.createLoopSource(ctx, this.whiteBuffer, 0.6);
    const sprayFilter = ctx.createBiquadFilter();
    sprayFilter.type = 'highpass';
    sprayFilter.frequency.value = 3100;
    sprayFilter.Q.value = 0.6;
    const sprayGain = ctx.createGain();
    sprayGain.gain.value = 0;
    spraySrc.connect(sprayFilter);
    sprayFilter.connect(sprayGain);
    sprayGain.connect(ambienceMix);
    this.sprayFilter = sprayFilter;
    this.sprayGain = sprayGain;

    // Layer 5A: Primary Regional & Flight Wind
    const windSrc = this.createLoopSource(ctx, this.pinkBuffer, 2.05);
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 650;
    windFilter.Q.value = 2.1;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    windSrc.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(ambienceMix);
    this.windFilter = windFilter;
    this.windGain = windGain;

    // Layer 5B: Harmonic Wind Whistle / Breeze Resonator
    const windWhistleSrc = this.createLoopSource(ctx, this.pinkBuffer, 0.45);
    const windWhistleFilter = ctx.createBiquadFilter();
    windWhistleFilter.type = 'bandpass';
    windWhistleFilter.frequency.value = 820;
    windWhistleFilter.Q.value = 4.5;
    const windWhistleGain = ctx.createGain();
    windWhistleGain.gain.value = 0;
    windWhistleSrc.connect(windWhistleFilter);
    windWhistleFilter.connect(windWhistleGain);
    windWhistleGain.connect(ambienceMix);
    this.windWhistleFilter = windWhistleFilter;
    this.windWhistleGain = windWhistleGain;

    // Layer 6: Stereo Monsoon Rain (Water Patter + High Canopy Shimmer)
    const rainPatterSrc = this.createLoopSource(ctx, this.pinkBuffer, 1.55);
    const rainPatterFilter = ctx.createBiquadFilter();
    rainPatterFilter.type = 'bandpass';
    rainPatterFilter.frequency.value = 1600;
    rainPatterFilter.Q.value = 0.85;
    const rainPatterGain = ctx.createGain();
    rainPatterGain.gain.value = 0;
    rainPatterSrc.connect(rainPatterFilter);
    if (typeof ctx.createStereoPanner === 'function') {
      const panL = ctx.createStereoPanner();
      panL.pan.value = -0.32;
      rainPatterFilter.connect(panL);
      panL.connect(rainPatterGain);
    } else {
      rainPatterFilter.connect(rainPatterGain);
    }
    rainPatterGain.connect(ambienceMix);
    this.rainPatterFilter = rainPatterFilter;
    this.rainPatterGain = rainPatterGain;

    const rainShimmerSrc = this.createLoopSource(ctx, this.whiteBuffer, 2.25);
    const rainShimmerFilter = ctx.createBiquadFilter();
    rainShimmerFilter.type = 'highpass';
    rainShimmerFilter.frequency.value = 4200;
    rainShimmerFilter.Q.value = 0.65;
    const rainShimmerGain = ctx.createGain();
    rainShimmerGain.gain.value = 0;
    rainShimmerSrc.connect(rainShimmerFilter);
    if (typeof ctx.createStereoPanner === 'function') {
      const panR = ctx.createStereoPanner();
      panR.pan.value = 0.32;
      rainShimmerFilter.connect(panR);
      panR.connect(rainShimmerGain);
    } else {
      rainShimmerFilter.connect(rainShimmerGain);
    }
    rainShimmerGain.connect(ambienceMix);
    this.rainShimmerFilter = rainShimmerFilter;
    this.rainShimmerGain = rainShimmerGain;

    // Layer 7: Geothermal Sub-Bass Rumble & Steam Vent Hiss
    const geothermalGain = ctx.createGain();
    geothermalGain.gain.value = 0;

    const geothermalOsc = ctx.createOscillator();
    geothermalOsc.type = 'triangle';
    geothermalOsc.frequency.value = 48;
    const geoOscLP = ctx.createBiquadFilter();
    geoOscLP.type = 'lowpass';
    geoOscLP.frequency.value = 95;
    geothermalOsc.connect(geoOscLP);
    geoOscLP.connect(geothermalGain);
    geothermalOsc.start();
    this.geothermalOsc = geothermalOsc;

    const geoBrownSrc = this.createLoopSource(ctx, this.brownBuffer, 0.85);
    const geoBrownLP = ctx.createBiquadFilter();
    geoBrownLP.type = 'lowpass';
    geoBrownLP.frequency.value = 110;
    geoBrownLP.Q.value = 1.5;
    geoBrownSrc.connect(geoBrownLP);
    geoBrownLP.connect(geothermalGain);
    geothermalGain.connect(compressor);
    this.geothermalGain = geothermalGain;

    const geoSteamSrc = this.createLoopSource(ctx, this.whiteBuffer, 1.35);
    const geothermalSteamFilter = ctx.createBiquadFilter();
    geothermalSteamFilter.type = 'bandpass';
    geothermalSteamFilter.frequency.value = 2200;
    geothermalSteamFilter.Q.value = 1.4;
    const geothermalSteamGain = ctx.createGain();
    geothermalSteamGain.gain.value = 0;
    geoSteamSrc.connect(geothermalSteamFilter);
    geothermalSteamFilter.connect(geothermalSteamGain);
    geothermalSteamGain.connect(ambienceMix);
    this.geothermalSteamFilter = geothermalSteamFilter;
    this.geothermalSteamGain = geothermalSteamGain;

    // Layer 8: Deep Sub-Aquatic Hum
    const subHumGain = ctx.createGain();
    subHumGain.gain.value = 0;

    const subHumOsc = ctx.createOscillator();
    subHumOsc.type = 'sine';
    subHumOsc.frequency.value = 66;
    const subOscTrim = ctx.createGain();
    subOscTrim.gain.value = 0.55;
    subHumOsc.connect(subOscTrim);
    subOscTrim.connect(subHumGain);
    subHumOsc.start();
    this.subHumOsc = subHumOsc;

    const subNoiseSrc = this.createLoopSource(ctx, this.brownBuffer, 1.7);
    const subNoiseLP = ctx.createBiquadFilter();
    subNoiseLP.type = 'lowpass';
    subNoiseLP.frequency.value = 145;
    subNoiseLP.Q.value = 1.4;
    subNoiseSrc.connect(subNoiseLP);
    subNoiseLP.connect(subHumGain);

    subHumGain.connect(compressor);
    this.subHumGain = subHumGain;

    this.graphReady = true;
  }

  private createLoopSource(
    ctx: AudioContext,
    buffer: AudioBuffer,
    offsetSeconds: number,
  ): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start(0, offsetSeconds % buffer.duration);
    this.activeLoops.push(src);
    return src;
  }

  private createNoiseBuffer(
    ctx: AudioContext,
    kind: 'white' | 'pink' | 'brown',
    durationSec: number,
  ): AudioBuffer {
    const sampleRate = ctx.sampleRate;
    const length = Math.max(1024, Math.floor(sampleRate * durationSec));
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    if (kind === 'white') {
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
    } else if (kind === 'pink') {
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
        data[i] = pink * 0.11;
      }
    } else {
      let last = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.025 * w) / 1.025;
        data[i] = last * 3.1;
      }
    }

    const fadeSamples = Math.min(Math.floor(sampleRate * 0.04), Math.floor(length * 0.1));
    for (let i = 0; i < fadeSamples; i++) {
      const t = i / fadeSamples;
      const w = 0.5 - 0.5 * Math.cos(t * Math.PI);
      const tailIdx = length - fadeSamples + i;
      data[i] = data[i] * w + data[tailIdx] * (1 - w);
    }

    let peak = 0.001;
    for (let i = 0; i < length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    const norm = 0.88 / peak;
    for (let i = 0; i < length; i++) {
      data[i] *= norm;
    }
    return buffer;
  }

  private applyMasterMute(tau: number): void {
    if (!this.ctx || !this.masterGain) return;
    const target = this.muted ? 0 : 0.78;
    this.masterGain.gain.setTargetAtTime(target, this.ctx.currentTime, tau);
  }

  // ---------------------------------------------------------------------------
  // Procedural Data-Driven Weather & Musical SFX Synthesizers
  // ---------------------------------------------------------------------------

  private playRainDropletCrackle(now: number, intensity: number): void {
    const ctx = this.ctx;
    const dest = this.sfxBus;
    if (!ctx || !dest) return;

    const freq = 1400 + Math.random() * 1900;
    const dur = 0.022 + Math.random() * 0.024;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.45, now + dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.026 * clamp(intensity, 0.1, 1.0), now + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(env);
    env.connect(dest);
    osc.start(now);
    osc.stop(now + dur + 0.008);
  }

  /**
   * Distant rolling thunder rumble (`emit('thunder', { intensity })`) with multi-stage
   * low-pass filtered noise swells and canyon/jungle echo decay.
   */
  private playThunderRumble(now: number, intensity: number): void {
    const ctx = this.ctx;
    const dest = this.sfxBus;
    if (!ctx || !dest || !this.brownBuffer || !this.pinkBuffer) return;

    const power = clamp(intensity, 0.25, 1.4);

    this.playNoiseSweep(now, this.pinkBuffer, 'bandpass', 860, 140, 0.52, 0.24 * power, 0.9);
    this.playNoiseSweep(
      now + 0.04,
      this.brownBuffer,
      'lowpass',
      240,
      52,
      1.85,
      0.52 * power,
      1.15,
    );
    this.playNoiseSweep(
      now + 0.34,
      this.brownBuffer,
      'lowpass',
      175,
      44,
      1.65,
      0.38 * power,
      1.3,
    );
    this.playNoiseSweep(
      now + 0.82,
      this.brownBuffer,
      'lowpass',
      130,
      38,
      1.45,
      0.24 * power,
      1.1,
    );
    this.playSoftThump(now + 0.05, 68, 28, 1.25, 0.58 * power);
  }

  /**
   * Data-driven 4-note arrival fanfare generated directly from `AudioScaleParams`
   * (`baseMidi`, `scaleIntervals`, `timbre`).
   */
  private playTrackTransitionFanfare(now: number, profile: AudioScaleParams): void {
    const pattern = [0, 2, 4, 5];
    for (let i = 0; i < pattern.length; i++) {
      const hz = getScaleNoteHz(profile, pattern[i]);
      const t = now + i * 0.085;
      this.playTimbreNote(t, hz, 0.32 + i * 0.06, 0.19, profile.timbre);
    }
  }

  private playRubberDuckSqueak(
    now: number,
    mood: 'happy' | 'startled' | 'spooked' | 'victory' | 'bonk',
    pitchMult: number,
    volume: number,
  ): void {
    const p = clamp(pitchMult, 0.6, 1.8);
    const v = clamp(volume, 0.08, 1.0);

    if (mood === 'spooked') {
      this.triggerSingleSqueak(now, 880 * p, 1260 * p, 980 * p, 0.072, v * 0.85);
      this.triggerSingleSqueak(now + 0.082, 1020 * p, 1460 * p, 1140 * p, 0.078, v * 0.95);
      return;
    }

    if (mood === 'victory') {
      this.triggerSingleSqueak(now, 740 * p, 1020 * p, 860 * p, 0.085, v * 0.8);
      this.triggerSingleSqueak(now + 0.095, 880 * p, 1240 * p, 1040 * p, 0.09, v * 0.85);
      this.triggerSingleSqueak(now + 0.195, 1040 * p, 1480 * p, 1220 * p, 0.125, v * 0.95);
      return;
    }

    if (mood === 'bonk') {
      this.triggerSingleSqueak(now, 700 * p, 420 * p, 520 * p, 0.15, v * 0.9);
      this.playSoftThump(now, 145, 52, 0.16, v * 0.75);
      return;
    }

    if (mood === 'startled') {
      this.triggerSingleSqueak(now, 820 * p, 1340 * p, 1060 * p, 0.105, v * 0.9);
      return;
    }

    this.triggerSingleSqueak(now, 720 * p, 1040 * p, 810 * p, 0.11, v * 0.82);
  }

  private triggerSingleSqueak(
    startTime: number,
    fStart: number,
    fPeak: number,
    fEnd: number,
    dur: number,
    vol: number,
  ): void {
    const ctx = this.ctx;
    const dest = this.sfxBus;
    if (!ctx || !dest) return;

    const osc1 = ctx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(fStart, startTime);
    osc1.frequency.exponentialRampToValueAtTime(Math.max(120, fPeak), startTime + dur * 0.42);
    osc1.frequency.exponentialRampToValueAtTime(Math.max(120, fEnd), startTime + dur);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(fStart * 2.01, startTime);
    osc2.frequency.exponentialRampToValueAtTime(
      Math.max(240, fPeak * 2.01),
      startTime + dur * 0.42,
    );
    osc2.frequency.exponentialRampToValueAtTime(Math.max(240, fEnd * 1.98), startTime + dur);

    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.28;

    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.setValueAtTime(fPeak * 1.65, startTime);
    formant.Q.value = 2.6;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(vol * 0.32, startTime + 0.012);
    env.gain.exponentialRampToValueAtTime(vol * 0.22, startTime + dur * 0.65);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + dur);

    osc1.connect(formant);
    osc2.connect(osc2Gain);
    osc2Gain.connect(formant);
    formant.connect(env);
    env.connect(dest);

    osc1.start(startTime);
    osc2.start(startTime);
    osc1.stop(startTime + dur + 0.015);
    osc2.stop(startTime + dur + 0.015);
  }

  private playSplashBurst(
    now: number,
    intensity: number,
    kind: 'land' | 'waterfall' | 'skim',
  ): void {
    const ctx = this.ctx;
    const dest = this.sfxBus;
    if (!ctx || !dest || !this.pinkBuffer || !this.whiteBuffer) return;

    if (kind === 'waterfall') {
      this.playSoftThump(now, 108, 32, 0.46, 0.72 * intensity);
      this.playNoiseSweep(now, this.pinkBuffer, 'bandpass', 1800, 340, 0.65, 0.46 * intensity, 0.8);
      this.playNoiseSweep(
        now + 0.03,
        this.whiteBuffer,
        'highpass',
        3400,
        1400,
        0.58,
        0.24 * intensity,
        0.7,
      );
      for (let i = 0; i < 4; i++) {
        this.playUnderwaterBubblePop(now + 0.08 + i * 0.055, 0.7 * intensity, true);
      }
      return;
    }

    if (kind === 'skim') {
      this.playNoiseSweep(now, this.whiteBuffer, 'bandpass', 2800, 1200, 0.14, 0.16 * intensity, 1.3);
      return;
    }

    this.playSoftThump(now, 165, 68, 0.14, 0.34 * intensity);
    this.playNoiseSweep(now, this.pinkBuffer, 'bandpass', 2200, 520, 0.28, 0.28 * intensity, 0.9);
    this.playNoiseSweep(now + 0.015, this.whiteBuffer, 'highpass', 3200, 1800, 0.22, 0.12 * intensity, 0.7);
  }

  private playDivePlunge(now: number, normSpeed: number): void {
    const ctx = this.ctx;
    const dest = this.sfxBus;
    if (!ctx || !dest || !this.pinkBuffer) return;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(145, now + 0.14);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.22 * normSpeed, now + 0.014);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    osc.connect(env);
    env.connect(dest);
    osc.start(now);
    osc.stop(now + 0.17);

    this.playNoiseSweep(now, this.pinkBuffer, 'lowpass', 2200, 320, 0.26, 0.26 * normSpeed, 1.2);
  }

  private playBreachSplash(now: number, power: number): void {
    const ctx = this.ctx;
    const dest = this.sfxBus;
    if (!ctx || !dest || !this.whiteBuffer || !this.pinkBuffer) return;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(250, now);
    osc.frequency.exponentialRampToValueAtTime(780 + power * 180, now + 0.095);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.2 * power, now + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

    osc.connect(env);
    env.connect(dest);
    osc.start(now);
    osc.stop(now + 0.12);

    this.playNoiseSweep(now, this.whiteBuffer, 'highpass', 1800, 4200, 0.22, 0.18 * power, 0.8);
    this.playNoiseSweep(now, this.pinkBuffer, 'bandpass', 1100, 2600, 0.18, 0.2 * power, 1.0);
  }

  private playWingFlap(now: number, intensity: number): void {
    if (!this.pinkBuffer) return;
    this.playNoiseSweep(
      now,
      this.pinkBuffer,
      'bandpass',
      420,
      1150,
      0.085,
      0.16 * intensity,
      1.7,
    );
  }

  /**
   * 100% data-driven collectible chime using active `AudioScaleParams`
   * (`baseMidi`, `scaleIntervals`, `timbre`) — zero hardcoded scales!
   */
  private playCollectibleChime(now: number, kind: CollectibleKind, combo: number): void {
    const profile = this.currentAudioProfile;
    const step = clamp(Math.max(0, combo - 1), 0, 14);
    const baseHz = getScaleNoteHz(profile, step);

    if (kind === 'golden_feather') {
      const n1 = getScaleNoteHz(profile, step);
      const n2 = getScaleNoteHz(profile, step + 1);
      const n3 = getScaleNoteHz(profile, step + 2);
      this.playTimbreNote(now, n1, 0.14, 0.2, profile.timbre);
      this.playTimbreNote(now + 0.055, n2, 0.16, 0.22, profile.timbre);
      this.playTimbreNote(now + 0.11, n3, 0.24, 0.24, profile.timbre);
      return;
    }

    if (kind === 'duckling_friend') {
      this.playRubberDuckSqueak(now, 'happy', 1.42, 0.62);
      const upperHz = getScaleNoteHz(profile, step + 2);
      this.playTimbreNote(now + 0.06, baseHz, 0.18, 0.2, profile.timbre);
      this.playTimbreNote(now + 0.12, upperHz, 0.24, 0.2, profile.timbre);
      return;
    }

    // Soft 65ms cadence limiter on rapid bubble chains (Wing Gust / Magnet) so streaks
    // sparkle musically instead of harsh machine-gun beeping!
    if (now - this.lastBubbleChimeAt < 0.065) return;
    this.lastBubbleChimeAt = now;

    const accentHz = getScaleNoteHz(profile, step + 2);
    this.playTimbreNote(now, baseHz, 0.16, 0.16, profile.timbre);
    this.playTimbreNote(now + 0.044, accentHz, 0.13, 0.08, profile.timbre);
  }

  /**
   * Synthesize a procedural musical note driven directly by `AudioTimbre`:
   * `'marimba' | 'koto' | 'bell' | 'crystal' | 'warm' | 'deep'`.
   */
  private playTimbreNote(
    startTime: number,
    freq: number,
    dur: number,
    vol: number,
    timbre: AudioTimbre = this.currentAudioProfile.timbre,
  ): void {
    const ctx = this.ctx;
    const dest = this.sfxBus;
    if (!ctx || !dest) return;

    const osc = ctx.createOscillator();
    const overtone = ctx.createOscillator();
    const overtoneGain = ctx.createGain();

    if (timbre === 'koto') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq * 1.015, startTime);
      osc.frequency.exponentialRampToValueAtTime(freq, startTime + 0.018);
      overtone.type = 'sine';
      overtone.frequency.setValueAtTime(freq * 3.0, startTime);
      overtoneGain.gain.value = 0.22;
    } else if (timbre === 'marimba') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      overtone.type = 'sine';
      overtone.frequency.setValueAtTime(freq * 4.0, startTime);
      overtoneGain.gain.setValueAtTime(0.32, startTime);
      overtoneGain.gain.exponentialRampToValueAtTime(0.01, startTime + dur * 0.45);
    } else if (timbre === 'crystal') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      overtone.type = 'sine';
      overtone.frequency.setValueAtTime(freq * 2.756, startTime);
      overtoneGain.gain.value = 0.26;
    } else if (timbre === 'deep') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq * 0.94, startTime);
      osc.frequency.exponentialRampToValueAtTime(freq, startTime + 0.025);
      overtone.type = 'sine';
      overtone.frequency.setValueAtTime(freq * 2.5, startTime);
      overtoneGain.gain.value = 0.25;
    } else if (timbre === 'warm') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq * 0.92, startTime);
      osc.frequency.exponentialRampToValueAtTime(freq, startTime + 0.02);
      overtone.type = 'sine';
      overtone.frequency.setValueAtTime(freq * 1.5, startTime);
      overtoneGain.gain.value = 0.22;
    } else {
      // 'bell' (watery buoyant bell chime)
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 0.86, startTime);
      osc.frequency.exponentialRampToValueAtTime(freq, startTime + 0.022);
      overtone.type = 'triangle';
      overtone.frequency.setValueAtTime(freq * 2.0, startTime);
      overtoneGain.gain.value = 0.18;
    }

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(vol, startTime + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + dur);

    osc.connect(env);
    overtone.connect(overtoneGain);
    overtoneGain.connect(env);
    env.connect(dest);

    osc.start(startTime);
    overtone.start(startTime);
    osc.stop(startTime + dur + 0.015);
    overtone.stop(startTime + dur + 0.015);
  }

  private playBubbleNote(startTime: number, freq: number, dur: number, vol: number): void {
    this.playTimbreNote(startTime, freq, dur, vol, this.currentAudioProfile.timbre);
  }

  private playPowerUpFanfare(now: number, powerUp: PowerUpType): void {
    const profile = this.currentAudioProfile;
    const patterns: Record<PowerUpType, readonly number[]> = {
      wing_gust: [0, 2, 3, 5, 7],
      bubble_lung: [0, 1, 3, 4, 6],
      soap_shield: [1, 3, 4, 6],
      magnet: [0, 2, 4, 5, 7],
    };
    const steps = patterns[powerUp];
    steps.forEach((step, i) => {
      const t = now + i * 0.055;
      const hz = getScaleNoteHz(profile, step);
      this.playTimbreNote(t, hz, 0.28 + i * 0.04, 0.2, profile.timbre);
    });

    if (powerUp === 'wing_gust' && this.pinkBuffer) {
      this.playNoiseSweep(now, this.pinkBuffer, 'bandpass', 500, 2000, 0.35, 0.2, 1.4);
    } else if (powerUp === 'bubble_lung') {
      for (let i = 0; i < 4; i++) {
        this.playUnderwaterBubblePop(now + 0.04 + i * 0.05, 0.9, true);
      }
    } else if (powerUp === 'soap_shield') {
      this.playRubberDuckSqueak(now + 0.14, 'happy', 1.18, 0.45);
    }
  }

  private playPowerUpExpire(now: number): void {
    const profile = this.currentAudioProfile;
    this.playTimbreNote(now, getScaleNoteHz(profile, 2), 0.14, 0.12, profile.timbre);
    this.playTimbreNote(now + 0.09, getScaleNoteHz(profile, 0), 0.18, 0.1, profile.timbre);
  }

  private playShieldBounce(now: number): void {
    this.playRubberDuckSqueak(now, 'startled', 1.12, 0.78);
    this.playUnderwaterBubblePop(now + 0.02, 1.1, true);
    this.playSoftThump(now, 240, 95, 0.18, 0.42);
  }

  private playNearMiss(now: number, combo: number): void {
    if (this.pinkBuffer) {
      this.playNoiseSweep(now, this.pinkBuffer, 'bandpass', 950, 2600, 0.13, 0.16, 1.8);
    }
    const profile = this.currentAudioProfile;
    const hz = getScaleNoteHz(profile, clamp(combo + 2, 2, 12));
    this.playTimbreNote(now + 0.02, hz, 0.15, 0.15, profile.timbre);
  }

  private playLowBreathPulse(now: number, urgency: number): void {
    const ctx = this.ctx;
    const dest = this.compressor;
    if (!ctx || !dest) return;

    const baseHz = lerp(490, 620, urgency);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseHz, now);
    osc.frequency.exponentialRampToValueAtTime(baseHz * 0.94, now + 0.24);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.14 + urgency * 0.08, now + 0.018);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);

    osc.connect(env);
    env.connect(dest);
    osc.start(now);
    osc.stop(now + 0.28);
  }

  private playUnderwaterBubblePop(now: number, intensity: number, toSfxBus = false): void {
    const ctx = this.ctx;
    const dest = toSfxBus ? this.sfxBus : this.compressor;
    if (!ctx || !dest) return;

    const f0 = 220 + Math.random() * 260;
    const f1 = f0 * (1.9 + Math.random() * 0.8);
    const dur = 0.036 + Math.random() * 0.035;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.075 * clamp(intensity, 0.2, 1.2), now + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(env);
    env.connect(dest);
    osc.start(now);
    osc.stop(now + dur + 0.01);
  }

  private playWaterfallDropCue(now: number, scale: number): void {
    if (this.pinkBuffer) {
      this.playNoiseSweep(now, this.pinkBuffer, 'bandpass', 1500, 420, 0.45, 0.24 * scale, 1.1);
    }
    this.playRubberDuckSqueak(now + 0.03, 'startled', 1.16, 0.58);
  }

  private playCaveTransition(now: number, entering: boolean): void {
    if (entering) {
      this.playBubbleNote(now, 392.0, 0.34, 0.14);
      this.playBubbleNote(now + 0.09, 293.66, 0.44, 0.15);
    } else {
      this.playBubbleNote(now, 392.0, 0.22, 0.14);
      this.playBubbleNote(now + 0.07, 587.33, 0.28, 0.16);
    }
  }

  private playCrash(now: number): void {
    this.playRubberDuckSqueak(now, 'bonk', 0.92, 0.85);
    this.playSplashBurst(now + 0.02, 0.95, 'land');
  }

  private playStartRun(now: number): void {
    const profile = this.currentAudioProfile;
    this.playTimbreNote(now, getScaleNoteHz(profile, 0), 0.12, 0.16, profile.timbre);
    this.playTimbreNote(now + 0.06, getScaleNoteHz(profile, 2), 0.14, 0.17, profile.timbre);
    this.playTimbreNote(now + 0.12, getScaleNoteHz(profile, 3), 0.22, 0.2, profile.timbre);
    this.playRubberDuckSqueak(now + 0.14, 'happy', 1.05, 0.48);
  }

  private playGameOver(now: number, isNewBest: boolean): void {
    const profile = this.currentAudioProfile;
    if (isNewBest) {
      this.playTimbreNote(now, getScaleNoteHz(profile, 0), 0.16, 0.18, profile.timbre);
      this.playTimbreNote(now + 0.09, getScaleNoteHz(profile, 2), 0.16, 0.18, profile.timbre);
      this.playTimbreNote(now + 0.18, getScaleNoteHz(profile, 3), 0.2, 0.2, profile.timbre);
      this.playTimbreNote(now + 0.27, getScaleNoteHz(profile, 5), 0.38, 0.22, profile.timbre);
      this.playRubberDuckSqueak(now + 0.3, 'victory', 1.05, 0.52);
    } else {
      this.playTimbreNote(now, getScaleNoteHz(profile, 2), 0.18, 0.15, profile.timbre);
      this.playTimbreNote(now + 0.12, getScaleNoteHz(profile, 1), 0.2, 0.14, profile.timbre);
      this.playTimbreNote(now + 0.25, getScaleNoteHz(profile, 0), 0.34, 0.14, profile.timbre);
    }
  }

  private playUiDrop(now: number, f0: number, f1: number, vol: number): void {
    const ctx = this.ctx;
    const dest = this.compressor;
    if (!ctx || !dest) return;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + 0.065);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(vol, now + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);

    osc.connect(env);
    env.connect(dest);
    osc.start(now);
    osc.stop(now + 0.085);
  }

  private playSoftThump(
    now: number,
    fStart: number,
    fEnd: number,
    dur: number,
    vol: number,
  ): void {
    const ctx = this.ctx;
    const dest = this.sfxBus;
    if (!ctx || !dest) return;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(fStart, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(24, fEnd), now + dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(vol * 0.5, now + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(env);
    env.connect(dest);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  private playNoiseSweep(
    now: number,
    buffer: AudioBuffer,
    filterType: BiquadFilterType,
    fStart: number,
    fEnd: number,
    dur: number,
    vol: number,
    q: number,
  ): void {
    const ctx = this.ctx;
    const dest = this.sfxBus;
    if (!ctx || !dest) return;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const offset = Math.random() * Math.max(0.01, buffer.duration - dur - 0.05);

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(Math.max(30, fStart), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(30, fEnd), now + dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(vol, now + Math.min(0.025, dur * 0.2));
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(filter);
    filter.connect(env);
    env.connect(dest);

    src.start(now, offset, dur + 0.02);
    src.stop(now + dur + 0.02);
  }
}
