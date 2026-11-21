import * as THREE from 'three';
import { QUALITY_PRESETS } from '../config';
import { earthWorld } from '../earth/earthWorld';
import {
  blendEarthRegionZones,
  type BlendedEarthRegion,
  type WeatherParams,
  type WeatherParticleShape,
} from '../earth/schema';
import {
  worldRoute as defaultWorldRoute,
  type WorldRouteController,
} from '../tracks/worldGraph';
import type {
  DuckState,
  ResolvedQuality,
  RiverProvider,
  RiverSample,
  Vec3,
} from '../types';

const ALPHA_POOL_CAPACITY = 560;
const ADDITIVE_POOL_CAPACITY = 260;

export const enum ParticleShape {
  Droplet = 0,
  Mist = 1,
  FoamDot = 2,
  Bubble = 3,
  Sparkle = 4,
  WindWisp = 5,
  SakuraPetal = 6,
  RainStreak = 7,
  Snowflake = 8,
}

export type SplashKind = 'jump' | 'land' | 'dive' | 'breach' | 'waterfall';

/**
 * Purely data-driven sprite & kinematic profile per `WeatherParticleShape`.
 * Zero region-name or weather-type switches: any contributor pack can combine
 * any `particleShape` with arbitrary `gravity`, `windStrength`, `driftSpeed`,
 * `rainRipples`, `steamDensity`, `intensity`, and two-tone colors!
 */
interface WeatherShapeProfile {
  sprite: ParticleShape;
  secondarySprite?: ParticleShape;
  useAdditive: boolean;
  secondaryAdditiveProb: number;
  baseRate: number;
  prewarmCount: number;
  baseLife: number;
  lifeJitter: number;
  baseSize: number;
  sizeJitter: number;
  growRate: number;
  baseAlpha: number;
  drag: number;
  wobbleMult: number;
  spinRange: number;
  fallSpeedScale: number;
  riseSpeedScale: number;
  gravityAccelScale: number;
  spawnHeightMin: number;
  spawnHeightSpan: number;
  alignToWindSlant: boolean;
}

const WEATHER_SHAPE_PROFILES: Record<WeatherParticleShape, WeatherShapeProfile> = {
  pollen: {
    sprite: ParticleShape.Sparkle,
    useAdditive: true,
    secondaryAdditiveProb: 1.0,
    baseRate: 20,
    prewarmCount: 22,
    baseLife: 2.1,
    lifeJitter: 1.6,
    baseSize: 0.12,
    sizeJitter: 0.14,
    growRate: 0.0,
    baseAlpha: 0.76,
    drag: 0.22,
    wobbleMult: 0.6,
    spinRange: 1.8,
    fallSpeedScale: 1.4,
    riseSpeedScale: 1.6,
    gravityAccelScale: 0.3,
    spawnHeightMin: 0.6,
    spawnHeightSpan: 5.8,
    alignToWindSlant: false,
  },
  petal: {
    sprite: ParticleShape.SakuraPetal,
    useAdditive: false,
    secondaryAdditiveProb: 0.16,
    baseRate: 44,
    prewarmCount: 38,
    baseLife: 2.4,
    lifeJitter: 1.6,
    baseSize: 0.25,
    sizeJitter: 0.18,
    growRate: 0.0,
    baseAlpha: 0.94,
    drag: 0.18,
    wobbleMult: 1.2,
    spinRange: 4.8,
    fallSpeedScale: 3.1,
    riseSpeedScale: 2.0,
    gravityAccelScale: 0.35,
    spawnHeightMin: 0.9,
    spawnHeightSpan: 8.5,
    alignToWindSlant: false,
  },
  rain: {
    sprite: ParticleShape.RainStreak,
    useAdditive: false,
    secondaryAdditiveProb: 0.22,
    baseRate: 185,
    prewarmCount: 96,
    baseLife: 0.62,
    lifeJitter: 0.28,
    baseSize: 1.05,
    sizeJitter: 0.52,
    growRate: 0.0,
    baseAlpha: 0.88,
    drag: 0.04,
    wobbleMult: 0.0,
    spinRange: 0.0,
    fallSpeedScale: 5.2,
    riseSpeedScale: 4.0,
    gravityAccelScale: 1.35,
    spawnHeightMin: 1.2,
    spawnHeightSpan: 9.2,
    alignToWindSlant: true,
  },
  dust: {
    sprite: ParticleShape.Sparkle,
    secondarySprite: ParticleShape.WindWisp,
    useAdditive: true,
    secondaryAdditiveProb: 1.0,
    baseRate: 34,
    prewarmCount: 28,
    baseLife: 1.7,
    lifeJitter: 1.4,
    baseSize: 0.16,
    sizeJitter: 0.26,
    growRate: 0.18,
    baseAlpha: 0.74,
    drag: 0.25,
    wobbleMult: 0.65,
    spinRange: 1.8,
    fallSpeedScale: 1.8,
    riseSpeedScale: 4.2,
    gravityAccelScale: 0.55,
    spawnHeightMin: 0.5,
    spawnHeightSpan: 7.4,
    alignToWindSlant: false,
  },
  snow: {
    sprite: ParticleShape.Snowflake,
    useAdditive: false,
    secondaryAdditiveProb: 0.36,
    baseRate: 48,
    prewarmCount: 40,
    baseLife: 2.3,
    lifeJitter: 1.6,
    baseSize: 0.22,
    sizeJitter: 0.18,
    growRate: 0.0,
    baseAlpha: 0.92,
    drag: 0.2,
    wobbleMult: 1.15,
    spinRange: 3.2,
    fallSpeedScale: 2.45,
    riseSpeedScale: 2.0,
    gravityAccelScale: 0.28,
    spawnHeightMin: 0.7,
    spawnHeightSpan: 9.0,
    alignToWindSlant: false,
  },
  ember: {
    sprite: ParticleShape.Sparkle,
    useAdditive: true,
    secondaryAdditiveProb: 1.0,
    baseRate: 46,
    prewarmCount: 36,
    baseLife: 1.4,
    lifeJitter: 1.3,
    baseSize: 0.16,
    sizeJitter: 0.18,
    growRate: -0.35,
    baseAlpha: 0.96,
    drag: 0.34,
    wobbleMult: 1.05,
    spinRange: 6.2,
    fallSpeedScale: 2.6,
    riseSpeedScale: 3.4,
    gravityAccelScale: 0.95,
    spawnHeightMin: 0.15,
    spawnHeightSpan: 5.5,
    alignToWindSlant: false,
  },
  mist: {
    sprite: ParticleShape.Mist,
    useAdditive: false,
    secondaryAdditiveProb: 0.0,
    baseRate: 24,
    prewarmCount: 18,
    baseLife: 2.0,
    lifeJitter: 1.2,
    baseSize: 1.35,
    sizeJitter: 1.1,
    growRate: 1.2,
    baseAlpha: 0.34,
    drag: 0.7,
    wobbleMult: 0.4,
    spinRange: 0.0,
    fallSpeedScale: 0.8,
    riseSpeedScale: 1.2,
    gravityAccelScale: 0.2,
    spawnHeightMin: 0.3,
    spawnHeightSpan: 3.2,
    alignToWindSlant: false,
  },
};

function resolveEarthRegionForSample(
  sample: RiverSample,
  fallbackRoute: WorldRouteController,
): BlendedEarthRegion {
  // Honor leg-aware & single_track-locked region fields stamped by RiverSpline first!
  const regionId = sample.regionId ?? sample.trackId;
  if (regionId) {
    const primary = earthWorld.getZoneById(regionId);
    const secId = sample.secondaryRegionId ?? sample.nextTrackId;
    const secondary = secId ? earthWorld.getZoneById(secId) : primary;
    const blend = THREE.MathUtils.clamp(
      sample.regionBlend ?? sample.trackBlend ?? 0,
      0,
      1,
    );
    return blendEarthRegionZones(primary, secondary, blend);
  }
  if (
    sample.lat !== undefined &&
    sample.lng !== undefined &&
    Number.isFinite(sample.lat) &&
    Number.isFinite(sample.lng)
  ) {
    return earthWorld.getBlendedRegionAt(sample.lat, sample.lng);
  }
  const legacy = fallbackRoute.sampleAt(sample.s);
  const primary = earthWorld.getZoneById(legacy.currentTrack.id);
  const secondary = earthWorld.getZoneById(legacy.nextTrack.id);
  return blendEarthRegionZones(primary, secondary, legacy.blend);
}

const PARTICLE_VERTEX_SHADER = /* glsl */ `
precision mediump float;

attribute float aSize;
attribute float aAlpha;
attribute float aShape;
attribute float aAngle;
attribute vec3 aColor;

uniform float uPixelRatio;

varying vec3 vColor;
varying float vAlpha;
varying float vShape;
varying float vAngle;

void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vShape = aShape;
  vAngle = aAngle;

  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mvPos.z, 0.6);
  gl_PointSize = clamp(aSize * uPixelRatio * (340.0 / dist), 1.0, 128.0);
  gl_Position = projectionMatrix * mvPos;
}
`;

const PARTICLE_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

varying vec3 vColor;
varying float vAlpha;
varying float vShape;
varying float vAngle;

void main() {
  if (vAlpha <= 0.004) discard;

  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  float r = sqrt(r2);

  int shape = int(vShape + 0.5);
  float mask = 0.0;
  vec3 col = vColor;

  if (shape == 0) {
    // Glossy water splash droplet with top-left specular crescent highlight
    mask = smoothstep(1.0, 0.32, r);
    float spec = smoothstep(0.36, 0.06, length(uv - vec2(-0.28, -0.28)));
    col = mix(col, vec3(1.0), spec * 0.75);
  } else if (shape == 1) {
    // Billowy soft waterfall mist / geothermal steam plume
    float lobe1 = smoothstep(1.0, 0.08, length(uv - vec2(0.18, 0.08)));
    float lobe2 = smoothstep(0.95, 0.05, length(uv - vec2(-0.2, -0.1)));
    float core = smoothstep(1.0, 0.0, r);
    mask = (core * 0.55 + lobe1 * 0.25 + lobe2 * 0.25) * (1.0 - r * 0.35);
    mask = pow(clamp(mask, 0.0, 1.0), 1.35);
  } else if (shape == 2) {
    // Frothy surface foam wake fleck / rain impact ring
    mask = smoothstep(1.0, 0.25, r) * (0.72 + 0.28 * cos(uv.x * 5.0 + uv.y * 5.0));
  } else if (shape == 3) {
    // Translucent hollow-rimmed underwater air bubble with bright crescent glint
    float rim = smoothstep(0.45, 0.84, r) * smoothstep(1.0, 0.86, r);
    float fill = smoothstep(1.0, 0.2, r) * 0.22;
    float glint = smoothstep(0.28, 0.04, length(uv - vec2(-0.34, -0.34)));
    mask = clamp(rim * 0.92 + fill + glint * 0.95, 0.0, 1.0);
    col = mix(col, vec3(0.95, 1.0, 1.0), clamp(glint + rim * 0.4, 0.0, 1.0));
  } else if (shape == 4) {
    // Crisp 4-point star sparkle (collectible pickup / sunbeam pollen / glowing ember core)
    float c = cos(vAngle);
    float s = sin(vAngle);
    vec2 p = mat2(c, -s, s, c) * uv;
    float starX = exp(-abs(p.y) * 9.0) * smoothstep(1.0, 0.0, abs(p.x));
    float starY = exp(-abs(p.x) * 9.0) * smoothstep(1.0, 0.0, abs(p.y));
    float core = exp(-r2 * 7.5);
    mask = clamp(core + (starX + starY) * 0.85, 0.0, 1.0);
    col = mix(col, vec3(1.0), core * 0.7);
  } else if (shape == 5) {
    // Elongated Wing-Gust wind-ribbon / thermal dust wisp
    float c = cos(vAngle);
    float s = sin(vAngle);
    vec2 p = mat2(c, -s, s, c) * uv;
    float streak = exp(-p.y * p.y * 16.0) * smoothstep(1.0, 0.05, abs(p.x));
    mask = streak;
  } else if (shape == 6) {
    // Delicate notched blossom petal fluttering in the breeze
    float c = cos(vAngle);
    float s = sin(vAngle);
    vec2 p = mat2(c, -s, s, c) * uv;
    vec2 q = vec2(p.x * (1.32 - p.y * 0.28), p.y * 0.96);
    float notch = exp(-pow(p.x * 5.2, 2.0)) * smoothstep(0.15, 0.85, p.y) * 0.34;
    float d = length(q) + notch;
    mask = smoothstep(0.92, 0.42, d);
    col = mix(vec3(1.0, 0.96, 0.98), col, smoothstep(-0.35, 0.65, p.y));
  } else if (shape == 7) {
    // High-velocity slanted raindrop streak with bright silver-cyan core (clearly readable in still frames!)
    float c = cos(vAngle);
    float s = sin(vAngle);
    vec2 p = mat2(c, -s, s, c) * uv;
    float needle = exp(-p.x * p.x * 20.0) * smoothstep(1.0, 0.04, abs(p.y));
    float core = exp(-p.x * p.x * 46.0) * smoothstep(0.92, 0.08, abs(p.y));
    float tip = exp(-p.x * p.x * 16.0) * smoothstep(0.55, -0.78, p.y) * 0.52;
    mask = clamp(needle * 0.92 + tip, 0.0, 1.0);
    col = mix(col, vec3(0.92, 0.98, 1.0), clamp(core * 0.65 + tip * 0.55, 0.0, 1.0));
  } else {
    // 6-pointed crystalline snowflake catching sky light
    float c = cos(vAngle);
    float s = sin(vAngle);
    vec2 p = mat2(c, -s, s, c) * uv;
    float a = atan(p.y, p.x);
    float hexSpoke = pow(max(0.0, cos(a * 6.0)), 6.0) * smoothstep(0.96, 0.12, r);
    float branchRing = smoothstep(0.14, 0.02, abs(r - 0.52)) * pow(max(0.0, cos(a * 6.0)), 2.0) * 0.65;
    float frostCore = exp(-r2 * 8.5);
    mask = clamp(frostCore + hexSpoke * 0.88 + branchRing, 0.0, 1.0);
    col = mix(col, vec3(1.0), frostCore * 0.65);
  }

  float finalAlpha = mask * vAlpha;
  if (finalAlpha <= 0.004) discard;
  gl_FragColor = vec4(col, finalAlpha);
}
`;

interface ParticleSlotPool {
  capacity: number;
  activeBudget: number;
  cursor: number;
  pos: Float32Array;
  vel: Float32Array;
  age: Float32Array;
  maxAge: Float32Array;
  baseSize: Float32Array;
  growRate: Float32Array;
  gravity: Float32Array;
  drag: Float32Array;
  wobble: Float32Array;
  baseAlpha: Float32Array;
  shape: Float32Array;
  angle: Float32Array;
  spin: Float32Array;
  color: Float32Array;
  outSize: Float32Array;
  outAlpha: Float32Array;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  points: THREE.Points;
  posAttr: THREE.BufferAttribute;
  sizeAttr: THREE.BufferAttribute;
  alphaAttr: THREE.BufferAttribute;
  shapeAttr: THREE.BufferAttribute;
  angleAttr: THREE.BufferAttribute;
  colorAttr: THREE.BufferAttribute;
}

function createParticlePool(
  capacity: number,
  blending: THREE.Blending,
  name: string,
  renderOrder: number,
): ParticleSlotPool {
  const pos = new Float32Array(capacity * 3);
  const vel = new Float32Array(capacity * 3);
  const age = new Float32Array(capacity);
  const maxAge = new Float32Array(capacity);
  const baseSize = new Float32Array(capacity);
  const growRate = new Float32Array(capacity);
  const gravity = new Float32Array(capacity);
  const drag = new Float32Array(capacity);
  const wobble = new Float32Array(capacity);
  const baseAlpha = new Float32Array(capacity);
  const shape = new Float32Array(capacity);
  const angle = new Float32Array(capacity);
  const spin = new Float32Array(capacity);
  const color = new Float32Array(capacity * 3);
  const outSize = new Float32Array(capacity);
  const outAlpha = new Float32Array(capacity);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  const sizeAttr = new THREE.BufferAttribute(outSize, 1);
  const alphaAttr = new THREE.BufferAttribute(outAlpha, 1);
  const shapeAttr = new THREE.BufferAttribute(shape, 1);
  const angleAttr = new THREE.BufferAttribute(angle, 1);
  const colorAttr = new THREE.BufferAttribute(color, 3);

  posAttr.setUsage(THREE.DynamicDrawUsage);
  sizeAttr.setUsage(THREE.DynamicDrawUsage);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  shapeAttr.setUsage(THREE.DynamicDrawUsage);
  angleAttr.setUsage(THREE.DynamicDrawUsage);
  colorAttr.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aSize', sizeAttr);
  geometry.setAttribute('aAlpha', alphaAttr);
  geometry.setAttribute('aShape', shapeAttr);
  geometry.setAttribute('aAngle', angleAttr);
  geometry.setAttribute('aColor', colorAttr);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: {
        value: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1,
      },
    },
    vertexShader: PARTICLE_VERTEX_SHADER,
    fragmentShader: PARTICLE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending,
  });

  const points = new THREE.Points(geometry, material);
  points.name = name;
  points.frustumCulled = false;
  points.renderOrder = renderOrder;

  return {
    capacity,
    activeBudget: capacity,
    cursor: 0,
    pos,
    vel,
    age,
    maxAge,
    baseSize,
    growRate,
    gravity,
    drag,
    wobble,
    baseAlpha,
    shape,
    angle,
    spin,
    color,
    outSize,
    outAlpha,
    geometry,
    material,
    points,
    posAttr,
    sizeAttr,
    alphaAttr,
    shapeAttr,
    angleAttr,
    colorAttr,
  };
}

function spawnIntoPool(
  pool: ParticleSlotPool,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  life: number,
  size: number,
  growRate: number,
  gravity: number,
  drag: number,
  wobble: number,
  alpha: number,
  shape: ParticleShape,
  r: number,
  g: number,
  b: number,
  angle: number = 0,
  spin: number = 0,
  initialAgeRatio: number = 0,
): void {
  const budget = pool.activeBudget;
  if (budget <= 0) return;
  const idx = pool.cursor;
  pool.cursor = (idx + 1) % budget;

  const p3 = idx * 3;
  pool.pos[p3] = x;
  pool.pos[p3 + 1] = y;
  pool.pos[p3 + 2] = z;

  pool.vel[p3] = vx;
  pool.vel[p3 + 1] = vy;
  pool.vel[p3 + 2] = vz;

  const startAge = THREE.MathUtils.clamp(initialAgeRatio, 0, 0.85) * life;
  pool.age[idx] = startAge;
  pool.maxAge[idx] = life;
  pool.baseSize[idx] = size;
  pool.growRate[idx] = growRate;
  pool.gravity[idx] = gravity;
  pool.drag[idx] = drag;
  pool.wobble[idx] = wobble;
  pool.baseAlpha[idx] = alpha;
  pool.shape[idx] = shape;
  pool.angle[idx] = angle;
  pool.spin[idx] = spin;

  pool.color[p3] = r;
  pool.color[p3 + 1] = g;
  pool.color[p3 + 2] = b;

  const t = life > 0 ? startAge / life : 0;
  const fadeIn = Math.min(t * 7.5 + 0.15, 1.0);
  const fadeOut = 1.0 - t * t;
  pool.outSize[idx] = Math.max(0.05, size * (1.0 + growRate * t));
  pool.outAlpha[idx] = alpha * fadeIn * fadeOut;
}

function stepPool(pool: ParticleSlotPool, dt: number, time: number): void {
  const budget = pool.activeBudget;
  for (let i = 0; i < budget; i++) {
    const life = pool.maxAge[i];
    if (life <= 0) {
      pool.outAlpha[i] = 0;
      continue;
    }

    const nextAge = pool.age[i] + dt;
    if (nextAge >= life) {
      pool.maxAge[i] = 0;
      pool.outAlpha[i] = 0;
      continue;
    }

    pool.age[i] = nextAge;
    const t = nextAge / life;
    const p3 = i * 3;

    const dragFactor = Math.max(0, 1.0 - pool.drag[i] * dt);
    pool.vel[p3] *= dragFactor;
    pool.vel[p3 + 1] = pool.vel[p3 + 1] * dragFactor + pool.gravity[i] * dt;
    pool.vel[p3 + 2] *= dragFactor;

    const wob = pool.wobble[i];
    const wx = wob > 0 ? Math.sin(time * 5.2 + i * 1.7) * wob : 0;
    const wz = wob > 0 ? Math.cos(time * 4.4 + i * 2.3) * wob : 0;

    pool.pos[p3] += (pool.vel[p3] + wx) * dt;
    pool.pos[p3 + 1] += pool.vel[p3 + 1] * dt;
    pool.pos[p3 + 2] += (pool.vel[p3 + 2] + wz) * dt;

    pool.angle[i] += pool.spin[i] * dt;

    const fadeIn = Math.min(t * 7.5, 1.0);
    const fadeOut = 1.0 - t * t;
    pool.outAlpha[i] = pool.baseAlpha[i] * fadeIn * fadeOut;
    pool.outSize[i] = Math.max(0.05, pool.baseSize[i] * (1.0 + pool.growRate[i] * t));
  }

  pool.posAttr.needsUpdate = true;
  pool.sizeAttr.needsUpdate = true;
  pool.alphaAttr.needsUpdate = true;
  pool.shapeAttr.needsUpdate = true;
  pool.angleAttr.needsUpdate = true;
  pool.colorAttr.needsUpdate = true;
}

/**
 * 100% Data-Driven Zero-Allocation Pooled GPU Particle System (2 draw calls total):
 * - Driven purely from spatial `WeatherParams` (`particleShape`, `intensity`, `windStrength`,
 *   `mistDensity`, `particleColor`, `secondaryParticleColor`, `rainRipples`, `steamDensity`,
 *   `gravity`, `driftSpeed`) from `earthWorld.getBlendedRegionAt(lat, lng)` — ZERO weather-type switches!
 * - Waterfall mist plumes & plunge-pool explosion spray
 * - Duck splash bursts (jump, land, dive plunge, breach pop, waterfall)
 * - Surface foam wake dots & carving spray droplets
 * - Rising underwater air bubbles & Golden Wing Gust ribbons
 */
export class ParticleSystem {
  public readonly group: THREE.Group;

  private readonly alphaPool: ParticleSlotPool;
  private readonly additivePool: ParticleSlotPool;
  private readonly scratchColor = new THREE.Color();
  private readonly primaryWeatherColor = new THREE.Color(0xfff6b8);
  private readonly secondaryWeatherColor = new THREE.Color(0xb8ffdf);

  private routeController: WorldRouteController = defaultWorldRoute;
  private weatherOverride: WeatherParams | null = null;
  private quality: ResolvedQuality;
  private densityScale = 1.0;

  private wakeAccum = 0;
  private bubbleAccum = 0;
  private flyAccum = 0;
  private mistAccum = 0;
  private weatherAccum = 0;
  private rainSplashAccum = 0;
  private steamAccum = 0;

  private prevDuckMode: DuckState['mode'] | null = null;
  private prevUnderwater = false;
  private prevDuckS = Number.NaN;
  private lastWaterfallBurstS = Number.NaN;
  private lastManualSplashTime = -10;
  private currentTime = 0;
  private lastWeatherKey = '';
  private needsWeatherPrewarm = true;

  constructor(
    scene?: THREE.Scene,
    quality: ResolvedQuality = 'high',
    routeController: WorldRouteController = defaultWorldRoute,
  ) {
    this.routeController = routeController;
    this.group = new THREE.Group();
    this.group.name = 'particle_system_group';

    this.alphaPool = createParticlePool(
      ALPHA_POOL_CAPACITY,
      THREE.NormalBlending,
      'particles_alpha',
      7,
    );
    this.additivePool = createParticlePool(
      ADDITIVE_POOL_CAPACITY,
      THREE.AdditiveBlending,
      'particles_additive',
      8,
    );

    this.group.add(this.alphaPool.points);
    this.group.add(this.additivePool.points);

    this.quality = quality;
    this.applyQuality(quality);

    if (scene) {
      scene.add(this.group);
    }
  }

  public setWorldRoute(routeController: WorldRouteController): void {
    this.routeController = routeController;
    this.needsWeatherPrewarm = true;
  }

  /**
   * Optionally override weather parameters explicitly (accepts open `WeatherParams`).
   */
  public setWeather(weather: WeatherParams | null): void {
    const nextKey = weather ? `${weather.id}:${weather.particleShape}` : '';
    if (this.lastWeatherKey !== nextKey) {
      this.needsWeatherPrewarm = true;
    }
    this.weatherOverride = weather;
  }

  public setQuality(quality: ResolvedQuality): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.applyQuality(quality);
  }

  public setPixelRatio(pixelRatio: number): void {
    const clamped = Math.min(Math.max(pixelRatio, 0.5), 2.0);
    this.alphaPool.material.uniforms.uPixelRatio.value = clamped;
    this.additivePool.material.uniforms.uPixelRatio.value = clamped;
  }

  private applyQuality(quality: ResolvedQuality): void {
    const maxTotal = Math.max(QUALITY_PRESETS[quality].maxParticles, 420);
    const alphaBudget = Math.min(ALPHA_POOL_CAPACITY, Math.round(maxTotal * 0.7));
    const addBudget = Math.min(ADDITIVE_POOL_CAPACITY, Math.max(64, maxTotal - alphaBudget));
    this.alphaPool.activeBudget = alphaBudget;
    this.additivePool.activeBudget = addBudget;
    this.alphaPool.geometry.setDrawRange(0, alphaBudget);
    this.additivePool.geometry.setDrawRange(0, addBudget);
    this.densityScale = quality === 'high' ? 1.0 : 0.48;
  }

  public emitSplash(
    worldPos: Vec3,
    intensity: number = 1.0,
    kind: SplashKind = 'land',
  ): void {
    this.lastManualSplashTime = this.currentTime;
    const clamped = THREE.MathUtils.clamp(intensity, 0.25, 2.2);
    const baseCount =
      kind === 'waterfall' ? 32 : kind === 'breach' || kind === 'dive' ? 18 : 14;
    const count = Math.max(4, Math.round(baseCount * clamped * this.densityScale));

    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + Math.random() * 0.45;
      const radialSpeed = (1.6 + Math.random() * 3.8) * clamped;
      const upSpeed =
        (kind === 'waterfall'
          ? 4.5 + Math.random() * 6.5
          : kind === 'jump' || kind === 'breach'
            ? 3.2 + Math.random() * 4.4
            : 2.2 + Math.random() * 4.0) * clamped;

      const isMist = i % 4 === 0;
      spawnIntoPool(
        this.alphaPool,
        worldPos.x + Math.cos(ang) * 0.35,
        worldPos.y + 0.08,
        worldPos.z + Math.sin(ang) * 0.35,
        Math.cos(ang) * radialSpeed,
        upSpeed,
        Math.sin(ang) * radialSpeed,
        isMist ? 0.65 + Math.random() * 0.45 : 0.45 + Math.random() * 0.35,
        isMist ? 0.58 * clamped : 0.14 + Math.random() * 0.14,
        isMist ? 1.6 : -0.35,
        isMist ? 0.6 : -16.5,
        isMist ? 2.4 : 0.6,
        0,
        isMist ? 0.55 : 0.92,
        isMist ? ParticleShape.Mist : ParticleShape.Droplet,
        0.9,
        0.98,
        1.0,
      );
    }

    const foamCount = Math.max(3, Math.round(8 * clamped * this.densityScale));
    for (let i = 0; i < foamCount; i++) {
      const ang = (i / foamCount) * Math.PI * 2 + Math.random() * 0.3;
      const spd = (1.4 + Math.random() * 1.8) * clamped;
      spawnIntoPool(
        this.alphaPool,
        worldPos.x + Math.cos(ang) * 0.3,
        worldPos.y + 0.04,
        worldPos.z + Math.sin(ang) * 0.3,
        Math.cos(ang) * spd,
        0.15,
        Math.sin(ang) * spd,
        0.55 + Math.random() * 0.3,
        0.26 * clamped,
        0.75,
        -0.5,
        3.2,
        0,
        0.78,
        ParticleShape.FoamDot,
        0.94,
        0.99,
        1.0,
      );
    }
  }

  public emitCollectBurst(
    worldPos: Vec3,
    colorHex: THREE.ColorRepresentation = 0xffe066,
    count: number = 14,
  ): void {
    this.scratchColor.set(colorHex);
    const n = Math.max(4, Math.round(count * this.densityScale));
    for (let i = 0; i < n; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.35) * Math.PI;
      const spd = 2.0 + Math.random() * 4.2;
      const vx = Math.cos(theta) * Math.cos(phi) * spd;
      const vy = Math.sin(phi) * spd + 1.8;
      const vz = Math.sin(theta) * Math.cos(phi) * spd;

      spawnIntoPool(
        this.additivePool,
        worldPos.x,
        worldPos.y,
        worldPos.z,
        vx,
        vy,
        vz,
        0.48 + Math.random() * 0.34,
        0.24 + Math.random() * 0.22,
        -0.45,
        -3.5,
        2.2,
        0.3,
        0.95,
        ParticleShape.Sparkle,
        this.scratchColor.r,
        this.scratchColor.g,
        this.scratchColor.b,
        Math.random() * Math.PI,
        (Math.random() - 0.5) * 6.0,
      );
    }
  }

  public emitBubbleBurst(worldPos: Vec3, count: number = 12): void {
    const n = Math.max(3, Math.round(count * this.densityScale));
    for (let i = 0; i < n; i++) {
      spawnIntoPool(
        this.alphaPool,
        worldPos.x + (Math.random() - 0.5) * 0.9,
        worldPos.y + (Math.random() - 0.5) * 0.5,
        worldPos.z + (Math.random() - 0.5) * 0.9,
        (Math.random() - 0.5) * 1.4,
        1.6 + Math.random() * 2.2,
        (Math.random() - 0.5) * 1.4,
        0.95 + Math.random() * 0.75,
        0.13 + Math.random() * 0.16,
        0.22,
        0.8,
        1.2,
        0.85,
        0.86,
        ParticleShape.Bubble,
        0.72,
        0.98,
        1.0,
      );
    }
  }

  public emitWingFlapGust(worldPos: Vec3, intensity: number = 1.0): void {
    const n = Math.max(3, Math.round(9 * intensity * this.densityScale));
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      spawnIntoPool(
        this.additivePool,
        worldPos.x + side * (0.45 + Math.random() * 0.45),
        worldPos.y + (Math.random() - 0.3) * 0.4,
        worldPos.z + (Math.random() - 0.5) * 0.4,
        side * (1.8 + Math.random() * 2.0),
        -1.2 + Math.random() * 1.4,
        (Math.random() - 0.5) * 1.6,
        0.42 + Math.random() * 0.28,
        0.34 + Math.random() * 0.24,
        0.3,
        0.4,
        2.6,
        0.35,
        0.88,
        i % 3 === 0 ? ParticleShape.Sparkle : ParticleShape.WindWisp,
        1.0,
        0.87,
        0.44,
        Math.random() * Math.PI,
        (Math.random() - 0.5) * 4.0,
      );
    }
  }

  public emitShieldPop(worldPos: Vec3): void {
    const n = Math.max(6, Math.round(18 * this.densityScale));
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const spd = 2.6 + Math.random() * 3.4;
      const isPink = i % 2 === 0;
      spawnIntoPool(
        this.additivePool,
        worldPos.x + Math.cos(ang) * 0.5,
        worldPos.y + 0.4 + (Math.random() - 0.5) * 0.4,
        worldPos.z + Math.sin(ang) * 0.5,
        Math.cos(ang) * spd,
        1.4 + Math.random() * 2.6,
        Math.sin(ang) * spd,
        0.55 + Math.random() * 0.28,
        0.26 + Math.random() * 0.16,
        0.2,
        -2.2,
        1.8,
        0.4,
        0.92,
        isPink ? ParticleShape.Bubble : ParticleShape.Sparkle,
        isPink ? 0.96 : 0.56,
        isPink ? 0.68 : 0.95,
        1.0,
        Math.random() * Math.PI,
        3.0,
      );
    }
  }

  public update(
    dt: number,
    time: number,
    duckState: DuckState,
    river: RiverProvider,
    cameraPos: THREE.Vector3,
    cameraSubmerged: boolean,
  ): void {
    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    this.currentTime = time;

    const duckSample = river.sampleAt(duckState.s);
    const region = resolveEarthRegionForSample(duckSample, this.routeController);
    const weather = this.weatherOverride ?? region.weather;

    const isTeleport =
      !Number.isNaN(this.prevDuckS) && Math.abs(duckState.s - this.prevDuckS) > 12;
    this.prevDuckS = duckState.s;

    const weatherKey = `${weather.id}:${weather.particleShape}`;
    if (isTeleport || this.lastWeatherKey !== weatherKey) {
      this.lastWeatherKey = weatherKey;
      this.needsWeatherPrewarm = true;
    }

    if (!isTeleport && this.prevDuckMode !== null && time - this.lastManualSplashTime > 0.12) {
      if (this.prevDuckMode === 'airborne' && duckState.mode === 'surface') {
        this.emitSplash(duckState.worldPos, 1.0, 'land');
      } else if (this.prevDuckMode === 'waterfall' && duckState.mode === 'surface') {
        this.emitSplash(duckState.worldPos, 1.75, 'waterfall');
      } else if (!this.prevUnderwater && duckState.isUnderwater) {
        this.emitSplash(duckState.worldPos, 0.9, 'dive');
        this.emitBubbleBurst(duckState.worldPos, 10);
      } else if (this.prevUnderwater && !duckState.isUnderwater) {
        this.emitSplash(duckState.worldPos, 1.1, 'breach');
      }
    }
    this.prevDuckMode = duckState.mode;
    this.prevUnderwater = duckState.isUnderwater;

    const dPos = duckState.worldPos;
    const dVel = duckState.velocity;

    // 1. Duck surface wake foam dots & carving turn spray
    if (duckState.mode === 'surface' && !duckState.isCrashed) {
      const turnAbs = Math.abs(duckState.turnAmount);
      const wakeRate = (14 + turnAbs * 22 + duckState.spookIntensity * 18) * this.densityScale;
      this.wakeAccum += safeDt * wakeRate;
      while (this.wakeAccum >= 1) {
        this.wakeAccum -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        spawnIntoPool(
          this.alphaPool,
          dPos.x + (Math.random() - 0.5) * 0.55,
          dPos.y + 0.04,
          dPos.z + (Math.random() - 0.5) * 0.55,
          dVel.x * 0.12 + side * (0.5 + turnAbs * 1.4),
          0.18 + turnAbs * 0.8,
          dVel.z * 0.12 + (Math.random() - 0.5) * 0.6,
          0.45 + Math.random() * 0.3,
          0.16 + Math.random() * 0.12,
          0.65,
          -1.2,
          2.6,
          0,
          0.72,
          ParticleShape.FoamDot,
          0.93,
          0.99,
          1.0,
        );

        if (turnAbs > 0.3 || duckState.spookIntensity > 0.25) {
          spawnIntoPool(
            this.alphaPool,
            dPos.x + (Math.random() - 0.5) * 0.6,
            dPos.y + 0.15,
            dPos.z + (Math.random() - 0.5) * 0.6,
            dVel.x * 0.25 + (Math.random() - 0.5) * 3.2,
            1.6 + Math.random() * 2.2,
            dVel.z * 0.25 + (Math.random() - 0.5) * 3.2,
            0.38 + Math.random() * 0.22,
            0.1 + Math.random() * 0.09,
            -0.3,
            -14.5,
            0.5,
            0,
            0.88,
            ParticleShape.Droplet,
            0.9,
            0.98,
            1.0,
          );
        }
      }
    }

    // 2. Rising underwater air bubbles
    if (duckState.isUnderwater || cameraSubmerged) {
      const boostFactor = duckState.breathBoostRemaining > 0 ? 1.8 : 1.0;
      const bubbleRate =
        (duckState.isUnderwater ? 22 * boostFactor : 8) * this.densityScale;
      this.bubbleAccum += safeDt * bubbleRate;
      while (this.bubbleAccum >= 1) {
        this.bubbleAccum -= 1;
        const fromDuck = duckState.isUnderwater && Math.random() < 0.78;
        const bx = fromDuck
          ? dPos.x + (Math.random() - 0.5) * 0.7
          : cameraPos.x + (Math.random() - 0.5) * 14.0;
        const by = fromDuck
          ? dPos.y + (Math.random() - 0.3) * 0.4
          : cameraPos.y - 1.5 + (Math.random() - 0.5) * 2.5;
        const bz = fromDuck
          ? dPos.z + (Math.random() - 0.5) * 0.7
          : cameraPos.z + (Math.random() - 0.5) * 14.0;

        const isAquaBoost = duckState.breathBoostRemaining > 0 && fromDuck;
        spawnIntoPool(
          this.alphaPool,
          bx,
          by,
          bz,
          fromDuck ? dVel.x * 0.18 : 0,
          1.4 + Math.random() * 1.9,
          fromDuck ? dVel.z * 0.18 : 0,
          0.9 + Math.random() * 0.85,
          0.11 + Math.random() * 0.14,
          0.25,
          0.7,
          0.9,
          0.75,
          0.84,
          ParticleShape.Bubble,
          isAquaBoost ? 0.36 : 0.74,
          isAquaBoost ? 0.96 : 0.98,
          1.0,
        );
      }
    }

    // 3. Golden Wing Gust flight ribbons & sparkles
    if (duckState.mode === 'flying' || duckState.flightRemaining > 0) {
      const flyRate = 30 * this.densityScale;
      this.flyAccum += safeDt * flyRate;
      while (this.flyAccum >= 1) {
        this.flyAccum -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        const isSpark = Math.random() < 0.42;
        spawnIntoPool(
          this.additivePool,
          dPos.x + side * (0.55 + Math.random() * 0.45),
          dPos.y + 0.28 + (Math.random() - 0.5) * 0.35,
          dPos.z + (Math.random() - 0.5) * 0.55,
          dVel.x * 0.15 + side * 0.45,
          -0.25 + Math.random() * 0.65,
          dVel.z * 0.15,
          0.42 + Math.random() * 0.3,
          isSpark ? 0.18 + Math.random() * 0.14 : 0.42 + Math.random() * 0.24,
          isSpark ? -0.4 : 0.25,
          0.2,
          2.2,
          0.25,
          0.86,
          isSpark ? ParticleShape.Sparkle : ParticleShape.WindWisp,
          1.0,
          isSpark ? 0.92 : 0.82,
          isSpark ? 0.56 : 0.34,
          Math.random() * Math.PI,
          isSpark ? 4.5 : 0.8,
        );
      }
    }

    // 4. Billowing waterfall mist plumes & plunge-pool explosion spray (scaled by weather.mistDensity)
    const mistScale = THREE.MathUtils.clamp(weather.mistDensity ?? 0.8, 0.35, 1.8);
    const mistRate = 36 * this.densityScale * mistScale;
    this.mistAccum += safeDt * mistRate;

    let lipSample = null;
    let plungeSample = null;
    const scanStart = Math.max(0, duckState.s - 18);
    const scanEnd = duckState.s + 96;
    let prevWasWf = false;
    for (let s = scanStart; s <= scanEnd; s += 3.5) {
      const samp = river.sampleAt(s);
      if (samp.isWaterfall && !lipSample) {
        lipSample = samp;
      }
      if (prevWasWf && !samp.isWaterfall) {
        plungeSample = samp;
        break;
      }
      prevWasWf = samp.isWaterfall;
    }

    const activeWfSample = plungeSample ?? lipSample;
    if (activeWfSample) {
      if (
        Number.isNaN(this.lastWaterfallBurstS) ||
        Math.abs(activeWfSample.s - this.lastWaterfallBurstS) > 35 ||
        isTeleport
      ) {
        this.lastWaterfallBurstS = activeWfSample.s;
        this.mistAccum = Math.max(this.mistAccum, Math.round(24 * this.densityScale));
      }

      const halfW = activeWfSample.width * 0.5;
      while (this.mistAccum >= 1) {
        this.mistAccum -= 1;
        const atLip = lipSample && Math.random() < 0.25;
        const src = atLip ? lipSample! : activeWfSample;
        const u = (Math.random() * 2.0 - 1.0) * halfW;
        const px = src.position.x + src.right.x * u;
        const py = src.position.y + (atLip ? 0.25 : 0.35 + Math.random() * 1.6);
        const pz = src.position.z + src.right.z * u;
        const isMist = Math.random() < 0.72;

        spawnIntoPool(
          this.alphaPool,
          px,
          py,
          pz,
          src.tangent.x * (1.2 + Math.random() * 2.6) + (Math.random() - 0.5) * 2.4,
          isMist ? 2.2 + Math.random() * 3.4 : 3.8 + Math.random() * 5.2,
          src.tangent.z * (1.2 + Math.random() * 2.6) + (Math.random() - 0.5) * 2.4,
          isMist ? 1.5 + Math.random() * 1.1 : 0.65 + Math.random() * 0.45,
          isMist ? 1.35 + Math.random() * 1.15 : 0.18 + Math.random() * 0.16,
          isMist ? 1.95 : -0.25,
          isMist ? 0.55 : -12.5,
          isMist ? 1.25 : 0.55,
          isMist ? 0.55 : 0,
          isMist ? 0.52 : 0.88,
          isMist ? ParticleShape.Mist : ParticleShape.Droplet,
          0.92,
          0.99,
          1.0,
        );
      }
    } else {
      this.mistAccum = Math.min(this.mistAccum, 1.0);
    }

    // 5. 100% Data-Driven Weather Particle Emission (ZERO weather-type switches!)
    this.emitDataDrivenWeather(
      safeDt,
      weather,
      duckState,
      river,
      cameraSubmerged,
      this.needsWeatherPrewarm,
    );
    this.needsWeatherPrewarm = false;

    stepPool(this.alphaPool, safeDt, time);
    stepPool(this.additivePool, safeDt, time);
  }

  private emitDataDrivenWeather(
    dt: number,
    weather: WeatherParams,
    duckState: DuckState,
    river: RiverProvider,
    cameraSubmerged: boolean,
    prewarm: boolean,
  ): void {
    const intensity = THREE.MathUtils.clamp(weather.intensity, 0.05, 1.6);
    const wind = THREE.MathUtils.clamp(weather.windStrength, 0, 2.2);
    const drift = THREE.MathUtils.clamp(weather.driftSpeed, 0.2, 3.0);
    const inCave = Boolean(duckState.inCave);

    this.primaryWeatherColor.setHex(weather.particleColor);
    this.secondaryWeatherColor.setHex(
      weather.secondaryParticleColor ?? weather.particleColor,
    );

    if (inCave || cameraSubmerged) {
      const caveRate = 12 * intensity * this.densityScale;
      this.weatherAccum += dt * caveRate + (prewarm ? 14 * this.densityScale : 0);
      while (this.weatherAccum >= 1) {
        this.weatherAccum -= 1;
        const aheadS = duckState.s - 2 + Math.random() * 34;
        const sample = river.sampleAt(aheadS);
        const lat = (Math.random() * 2.0 - 1.0) * (sample.width * 0.65);
        const heightY = cameraSubmerged
          ? -0.25 - Math.random() * Math.max(sample.depth - 0.5, 1.0)
          : 0.4 + Math.random() * 3.8;
        const col =
          Math.random() < 0.45
            ? this.secondaryWeatherColor
            : this.primaryWeatherColor;
        spawnIntoPool(
          this.additivePool,
          sample.position.x + sample.right.x * lat,
          sample.position.y + heightY,
          sample.position.z + sample.right.z * lat,
          (Math.random() - 0.5) * 0.5,
          (Math.random() - 0.4) * 0.4,
          (Math.random() - 0.5) * 0.5,
          1.8 + Math.random() * 1.6,
          0.11 + Math.random() * 0.12,
          0,
          0,
          0.25,
          0.45,
          cameraSubmerged ? 0.52 : 0.72,
          ParticleShape.Sparkle,
          col.r,
          col.g,
          col.b,
          Math.random() * Math.PI,
          1.4,
          prewarm ? 0.25 : 0,
        );
      }
      return;
    }

    const profile =
      WEATHER_SHAPE_PROFILES[weather.particleShape] ?? WEATHER_SHAPE_PROFILES.pollen;

    // A. Primary Weather Particle Stream (driven continuously by `WeatherParams`)
    const primaryRate = profile.baseRate * intensity * this.densityScale;
    this.weatherAccum +=
      dt * primaryRate + (prewarm ? profile.prewarmCount * this.densityScale : 0);

    const grav = weather.gravity; // >0 downward fall, <0 upward buoyant rise (e.g. embers/thermals)
    const slantAngle = profile.alignToWindSlant
      ? 0.22 * Math.min(wind, 1.5)
      : 0;

    while (this.weatherAccum >= 1) {
      this.weatherAccum -= 1;
      let aheadS: number;
      let latSpan: number;
      if (profile.alignToWindSlant) {
        // Concentrate slanted rain streaks across foreground & midground camera frustum
        const isForeground = Math.random() < 0.48;
        aheadS = isForeground
          ? duckState.s + 0.5 + Math.random() * 17
          : duckState.s + 8 + Math.random() * 28;
        latSpan = isForeground ? 0.72 : 0.96;
      } else {
        aheadS = duckState.s - 5 + Math.random() * 52;
        latSpan = 1.12;
      }
      const sample = river.sampleAt(aheadS);
      const lat = (Math.random() * 2.0 - 1.0) * (sample.width * latSpan);

      const heightY =
        prewarm && profile.alignToWindSlant
          ? 0.5 + Math.random() * (profile.spawnHeightMin + profile.spawnHeightSpan - 0.5)
          : profile.spawnHeightMin + Math.random() * profile.spawnHeightSpan;

      const useSecondaryColor = Math.random() < 0.42;
      const col = useSecondaryColor
        ? this.secondaryWeatherColor
        : this.primaryWeatherColor;

      const useAdditive =
        profile.useAdditive || Math.random() < profile.secondaryAdditiveProb;
      const targetPool = useAdditive ? this.additivePool : this.alphaPool;

      const useSecondarySprite =
        profile.secondarySprite !== undefined && Math.random() < 0.36;
      const spriteShape = useSecondarySprite
        ? profile.secondarySprite!
        : profile.sprite;

      // Continuous horizontal wind + swirling drift velocity
      const crossSpeed =
        (0.55 + wind * 2.1) * drift * (0.55 + Math.random() * 0.7);
      const downSpeed = (0.4 + wind * 1.3) * drift * (0.5 + Math.random() * 0.6);
      const vx =
        sample.right.x * crossSpeed +
        sample.tangent.x * downSpeed +
        (Math.random() - 0.5) * drift * 0.9;
      const vz =
        sample.right.z * crossSpeed +
        sample.tangent.z * downSpeed +
        (Math.random() - 0.5) * drift * 0.9;

      // Continuous vertical velocity & acceleration from `weather.gravity`
      let vy: number;
      if (grav > 0.01) {
        vy = -(grav * profile.fallSpeedScale + Math.random() * (0.65 + grav * 1.4));
      } else if (grav < -0.01) {
        vy = -grav * profile.riseSpeedScale + Math.random() * (0.75 + Math.abs(grav) * 2.8);
      } else {
        vy = (Math.random() - 0.45) * 0.65;
      }
      const accelY = -grav * profile.gravityAccelScale;

      const size =
        (useSecondarySprite ? profile.baseSize * 2.2 : profile.baseSize) +
        Math.random() * profile.sizeJitter;
      const angle = profile.alignToWindSlant
        ? slantAngle
        : Math.random() * Math.PI * 2;
      const spin =
        profile.spinRange > 0
          ? (Math.random() - 0.5) * profile.spinRange
          : 0;

      spawnIntoPool(
        targetPool,
        sample.position.x + sample.right.x * lat,
        sample.position.y + heightY,
        sample.position.z + sample.right.z * lat,
        vx,
        vy,
        vz,
        profile.baseLife + Math.random() * profile.lifeJitter,
        size,
        profile.growRate,
        accelY,
        profile.drag,
        profile.wobbleMult * drift,
        profile.baseAlpha,
        spriteShape,
        col.r,
        col.g,
        col.b,
        angle,
        spin,
        prewarm ? 0.12 + Math.random() * 0.52 : 0,
      );
    }

    // B. Surface Rain-Splash Bursts (purely driven by `weather.rainRipples > 0.05`)
    const rainSplashes = THREE.MathUtils.clamp(weather.rainRipples, 0, 1.2);
    if (rainSplashes > 0.05) {
      const splashRate = 40 * rainSplashes * intensity * this.densityScale;
      this.rainSplashAccum +=
        dt * splashRate + (prewarm ? 16 * rainSplashes * this.densityScale : 0);
      while (this.rainSplashAccum >= 1) {
        this.rainSplashAccum -= 1;
        const aheadS = duckState.s - 2 + Math.random() * 40;
        const sample = river.sampleAt(aheadS);
        const lat = (Math.random() * 2.0 - 1.0) * (sample.width * 0.48);
        const wx = sample.position.x + sample.right.x * lat;
        const wy = sample.position.y + 0.04;
        const wz = sample.position.z + sample.right.z * lat;

        spawnIntoPool(
          this.alphaPool,
          wx,
          wy,
          wz,
          (Math.random() - 0.5) * 0.8,
          0.9 + Math.random() * 1.4,
          (Math.random() - 0.5) * 0.8,
          0.24 + Math.random() * 0.16,
          0.18 + Math.random() * 0.14,
          1.1,
          -8.5,
          1.5,
          0,
          0.78,
          ParticleShape.FoamDot,
          0.88,
          0.97,
          1.0,
          0,
          0,
          prewarm ? 0.25 : 0,
        );
      }
    }

    // C. Rising Surface / Geothermal Steam Clouds (purely driven by `weather.steamDensity > 0.25`)
    const steamAmount = THREE.MathUtils.clamp(weather.steamDensity - 0.25, 0, 1.2);
    if (steamAmount > 0.01) {
      const steamRate = 24 * steamAmount * intensity * this.densityScale;
      this.steamAccum +=
        dt * steamRate + (prewarm ? 14 * steamAmount * this.densityScale : 0);
      while (this.steamAccum >= 1) {
        this.steamAccum -= 1;
        const aheadS = duckState.s + Math.random() * 46;
        const sample = river.sampleAt(aheadS);
        const lat = (Math.random() * 2.0 - 1.0) * (sample.width * 0.58);
        // Tint steam gently toward neutral misty white blended with secondary particle color
        const sr = THREE.MathUtils.lerp(0.92, this.secondaryWeatherColor.r, 0.18);
        const sg = THREE.MathUtils.lerp(0.90, this.secondaryWeatherColor.g, 0.18);
        const sb = THREE.MathUtils.lerp(0.90, this.secondaryWeatherColor.b, 0.18);

        spawnIntoPool(
          this.alphaPool,
          sample.position.x + sample.right.x * lat,
          sample.position.y + 0.25 + Math.random() * 0.9,
          sample.position.z + sample.right.z * lat,
          (Math.random() - 0.5) * 0.9,
          0.85 + Math.random() * 1.35,
          (Math.random() - 0.5) * 0.9,
          1.7 + Math.random() * 1.1,
          1.25 + Math.random() * 1.05,
          1.35,
          0.25,
          0.8,
          0.45,
          0.34,
          ParticleShape.Mist,
          sr,
          sg,
          sb,
          0,
          0,
          prewarm ? 0.25 : 0,
        );
      }
    }
  }

  public reset(): void {
    this.alphaPool.maxAge.fill(0);
    this.alphaPool.outAlpha.fill(0);
    this.alphaPool.alphaAttr.needsUpdate = true;

    this.additivePool.maxAge.fill(0);
    this.additivePool.outAlpha.fill(0);
    this.additivePool.alphaAttr.needsUpdate = true;

    this.prevDuckMode = null;
    this.prevUnderwater = false;
    this.prevDuckS = Number.NaN;
    this.lastWaterfallBurstS = Number.NaN;
    this.wakeAccum = 0;
    this.bubbleAccum = 0;
    this.flyAccum = 0;
    this.mistAccum = 0;
    this.weatherAccum = 0;
    this.rainSplashAccum = 0;
    this.steamAccum = 0;
    this.needsWeatherPrewarm = true;
  }

  public dispose(): void {
    this.alphaPool.geometry.dispose();
    this.alphaPool.material.dispose();
    this.additivePool.geometry.dispose();
    this.additivePool.material.dispose();
    this.group.parent?.remove(this.group);
  }
}
