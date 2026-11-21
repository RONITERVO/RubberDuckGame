import * as THREE from 'three';
import { QUALITY_PRESETS } from '../config';
import { earthWorld } from '../earth/earthWorld';
import {
  blendEarthRegionZones,
  type BlendedEarthRegion,
} from '../earth/schema';
import {
  worldRoute as defaultWorldRoute,
  type BlendedWorldTrackState,
  type WorldRouteController,
} from '../tracks/worldGraph';
import type {
  DuckState,
  ResolvedQuality,
  RiverProvider,
  RiverSample,
} from '../types';

export interface SharedCausticsUniforms {
  uCausticsTime: THREE.IUniform<number>;
  uCausticsSunDir: THREE.IUniform<THREE.Vector3>;
  uCausticsIntensity: THREE.IUniform<number>;
  uCausticsColor: THREE.IUniform<THREE.Color>;
  uCausticsEnabled: THREE.IUniform<number>;
}

/**
 * Resolve true spatial `BlendedEarthRegion` at a `RiverSample` using its real
 * Mini-Earth `(lat, lng)` coordinates (with graceful fallback to regionId/route).
 */
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

/**
 * Reusable mobile-safe GLSL snippet for crisp animated Voronoi underwater caustics.
 * Intended for injection into riverbed, boulder, root, and cave shaders via `onBeforeCompile`.
 */
export const CAUSTICS_GLSL = /* glsl */ `
uniform float uCausticsTime;
uniform vec3 uCausticsSunDir;
uniform float uCausticsIntensity;
uniform vec3 uCausticsColor;
uniform float uCausticsEnabled;

vec2 rdCausticHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float rdVoronoiEdge(vec2 x, float t) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float md = 8.0;
  float md2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = rdCausticHash22(n + g);
      o = 0.5 + 0.44 * sin(t * 2.05 + 6.2831 * o);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) {
        md2 = md;
        md = d;
      } else if (d < md2) {
        md2 = d;
      }
    }
  }
  float edge = sqrt(md2) - sqrt(md);
  // Crisp bright sunlight filaments
  return pow(smoothstep(0.22, 0.0, edge), 1.45);
}

float evaluateUnderwaterCaustics(vec3 worldPos, vec3 worldNormal, float subDepth) {
  if (uCausticsEnabled < 0.5 || subDepth <= 0.0) return 0.0;

  vec3 sDir = normalize(uCausticsSunDir);
  vec2 refractShift = sDir.xz / max(sDir.y, 0.28) * (subDepth * 0.55);
  vec2 p = (worldPos.xz - refractShift) * 0.64;

  float c1 = rdVoronoiEdge(p + vec2(uCausticsTime * 0.25, -uCausticsTime * 0.15), uCausticsTime);
  float c2 = rdVoronoiEdge(p * 1.42 - vec2(uCausticsTime * 0.20, uCausticsTime * 0.26) + vec2(4.7, 2.3), uCausticsTime * 1.25);

  // Additive filament intersections create realistic bright sunlit caustic nodes
  float web = clamp(c1 * 0.72 + c2 * 0.62 + c1 * c2 * 0.55, 0.0, 1.35);
  float surfaceFade = smoothstep(0.0, 0.18, subDepth);
  float depthAtten = exp(-subDepth * 0.17);
  float facing = clamp(worldNormal.y * 0.75 + 0.38, 0.0, 1.0);

  return web * surfaceFade * depthAtten * facing * uCausticsIntensity;
}
`;

export function createSharedCausticsUniforms(): SharedCausticsUniforms {
  return {
    uCausticsTime: { value: 0 },
    uCausticsSunDir: { value: new THREE.Vector3(0.45, 0.76, 0.46).normalize() },
    uCausticsIntensity: { value: 1.15 },
    uCausticsColor: { value: new THREE.Color('#a4fff0') },
    uCausticsEnabled: { value: 1.0 },
  };
}

const MAX_GOD_RAYS = 20;
const MENISCUS_DURATION = 0.22;

const GOD_RAY_VERTEX_SHADER = /* glsl */ `
precision mediump float;

attribute float aSeed;
attribute float aRayAlpha;

varying vec2 vUv;
varying float vSeed;
varying float vRayAlpha;
varying float vViewGrazing;

void main() {
  vUv = uv;
  vSeed = aSeed;
  vRayAlpha = aRayAlpha;

  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vec3 worldN = normalize(mat3(modelMatrix) * normal);
  vec3 viewDir = normalize(cameraPosition - worldPos.xyz);
  vViewGrazing = smoothstep(0.05, 0.42, abs(dot(worldN, viewDir)));

  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const GOD_RAY_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

uniform float uTime;
uniform float uIntensity;
uniform vec3 uColorTop;
uniform vec3 uColorBottom;

varying vec2 vUv;
varying float vSeed;
varying float vRayAlpha;
varying float vViewGrazing;

void main() {
  if (uIntensity <= 0.004 || vRayAlpha <= 0.004) discard;

  float xCenter = abs(vUv.x - 0.5) * 2.0;
  float edgeFade = pow(clamp(1.0 - xCenter, 0.0, 1.0), 1.65);

  float shimmer1 = 0.58 + 0.42 * sin(vUv.x * 11.0 + uTime * 2.1 + vSeed * 6.2831);
  float shimmer2 = 0.68 + 0.32 * sin(vUv.x * 21.0 - uTime * 2.9 + vSeed * 11.4);
  float bands = shimmer1 * shimmer2;

  float topSoft = smoothstep(1.0, 0.88, vUv.y);
  float depthFade = pow(clamp(vUv.y, 0.0, 1.0), 1.05) * topSoft;

  float alpha = edgeFade * depthFade * bands * vViewGrazing * vRayAlpha * uIntensity * 0.56;
  if (alpha < 0.003) discard;

  vec3 col = mix(uColorBottom, uColorTop, pow(vUv.y, 0.72));
  gl_FragColor = vec4(col, alpha);
}
`;

interface DropletDom {
  el: HTMLDivElement;
  baseX: number;
  baseY: number;
  size: number;
  speed: number;
  phase: number;
}

export interface UnderwaterUpdateParams {
  dt: number;
  time: number;
  cameraSubmerged: boolean;
  submersionDepth: number;
  meniscusPulse?: number;
  inCave?: boolean;
  breath?: number;
  duckState: DuckState;
  river: RiverProvider;
  scene?: THREE.Scene;
  surfaceFogColor?: THREE.Color;
  surfaceFogNear?: number;
  surfaceFogFar?: number;
}

/**
 * Manages seamless data-driven underwater immersion across Shared Mini-Earth:
 * - Shared Voronoi caustics uniforms (`CAUSTICS_GLSL`) for riverbed & caves
 * - Vivid volumetric sunlit God-Rays piercing beneath the water surface (1 draw call)
 * - Spatial Earth-region-driven underwater fog color/range (`earthWorld.getBlendedRegionAt`)
 * - Subtle GPU-composited viewport vignette, soft organic meniscus & perimeter breach droplets
 */
export class UnderwaterFx {
  public readonly group: THREE.Group;
  public readonly causticsUniforms: SharedCausticsUniforms;

  private readonly godRayGeom: THREE.BufferGeometry;
  private readonly godRayMat: THREE.ShaderMaterial;
  private readonly godRayMesh: THREE.Mesh;
  private readonly rayPositions: Float32Array;
  private readonly rayNormals: Float32Array;
  private readonly rayAlphas: Float32Array;
  private readonly rayPosAttr: THREE.BufferAttribute;
  private readonly rayNormAttr: THREE.BufferAttribute;
  private readonly rayAlphaAttr: THREE.BufferAttribute;

  private routeController: WorldRouteController = defaultWorldRoute;
  private readonly sunDir = new THREE.Vector3(0.45, 0.76, 0.46).normalize();
  private readonly refractedSun = new THREE.Vector3(0.26, -0.93, 0.26).normalize();
  private readonly underwaterFogColor = new THREE.Color('#0c6372');
  private readonly caveUnderwaterFogColor = new THREE.Color('#0a4458');
  private readonly activeUnderwaterFog = new THREE.Color('#0c6372');
  private readonly blendedFogColor = new THREE.Color('#b7e6f5');
  private readonly trackCausticColor = new THREE.Color('#a4fff0');
  private readonly trackShallowColor = new THREE.Color('#28c7b7');
  private readonly whiteScratch = new THREE.Color(0xffffff);

  private underwaterFogNear = 4.5;
  private underwaterFogFar = 36.0;
  private trackCausticBaseIntensity = 1.15;

  private quality: ResolvedQuality;
  private activeRayCount = MAX_GOD_RAYS;

  private submersionBlend = 0;
  private wasSubmerged = false;
  private lastDuckS = Number.NaN;
  private meniscusTimer = 0;
  private meniscusDir: 1 | -1 = 1;
  private dropletStrength = 0;
  private dropletFallProgress = 0;
  private lastRayAnchorS = Number.NaN;
  private lastRayInCave = false;
  private lastFrameRevision = -1;

  // Lightweight viewport overlay DOM
  private overlayRoot: HTMLDivElement | null = null;
  private vignetteEl: HTMLDivElement | null = null;
  private meniscusEl: HTMLDivElement | null = null;
  private breathPulseEl: HTMLDivElement | null = null;
  private droplets: DropletDom[] = [];
  private lastOverlaySubmersion = -1;

  constructor(
    scene?: THREE.Scene,
    quality: ResolvedQuality = 'high',
    overlayContainer?: HTMLElement | null,
    routeController: WorldRouteController = defaultWorldRoute,
  ) {
    this.routeController = routeController;
    this.group = new THREE.Group();
    this.group.name = 'underwater_fx_group';

    this.causticsUniforms = createSharedCausticsUniforms();
    this.quality = quality;

    const vertsPerRay = 4;
    const totalVerts = MAX_GOD_RAYS * vertsPerRay;
    this.rayPositions = new Float32Array(totalVerts * 3);
    this.rayNormals = new Float32Array(totalVerts * 3);
    const uvs = new Float32Array(totalVerts * 2);
    const seeds = new Float32Array(totalVerts);
    this.rayAlphas = new Float32Array(totalVerts);
    const indices = new Uint16Array(MAX_GOD_RAYS * 6);

    for (let i = 0; i < MAX_GOD_RAYS; i++) {
      const vBase = i * 4;
      const uvBase = vBase * 2;
      uvs[uvBase] = 0;
      uvs[uvBase + 1] = 0;
      uvs[uvBase + 2] = 1;
      uvs[uvBase + 3] = 0;
      uvs[uvBase + 4] = 0;
      uvs[uvBase + 5] = 1;
      uvs[uvBase + 6] = 1;
      uvs[uvBase + 7] = 1;

      const seedVal = (i * 0.6180339887) % 1;
      seeds[vBase] = seedVal;
      seeds[vBase + 1] = seedVal;
      seeds[vBase + 2] = seedVal;
      seeds[vBase + 3] = seedVal;

      const idxBase = i * 6;
      indices[idxBase] = vBase;
      indices[idxBase + 1] = vBase + 1;
      indices[idxBase + 2] = vBase + 2;
      indices[idxBase + 3] = vBase + 1;
      indices[idxBase + 4] = vBase + 3;
      indices[idxBase + 5] = vBase + 2;
    }

    this.godRayGeom = new THREE.BufferGeometry();
    this.rayPosAttr = new THREE.BufferAttribute(this.rayPositions, 3);
    this.rayNormAttr = new THREE.BufferAttribute(this.rayNormals, 3);
    this.rayAlphaAttr = new THREE.BufferAttribute(this.rayAlphas, 1);
    this.rayPosAttr.setUsage(THREE.DynamicDrawUsage);
    this.rayNormAttr.setUsage(THREE.DynamicDrawUsage);
    this.rayAlphaAttr.setUsage(THREE.DynamicDrawUsage);

    this.godRayGeom.setAttribute('position', this.rayPosAttr);
    this.godRayGeom.setAttribute('normal', this.rayNormAttr);
    this.godRayGeom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.godRayGeom.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this.godRayGeom.setAttribute('aRayAlpha', this.rayAlphaAttr);
    this.godRayGeom.setIndex(new THREE.BufferAttribute(indices, 1));

    this.godRayMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uColorTop: { value: new THREE.Color('#dcfff6') },
        uColorBottom: { value: new THREE.Color('#2ad4d8') },
      },
      vertexShader: GOD_RAY_VERTEX_SHADER,
      fragmentShader: GOD_RAY_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.godRayMesh = new THREE.Mesh(this.godRayGeom, this.godRayMat);
    this.godRayMesh.name = 'underwater_god_rays';
    this.godRayMesh.frustumCulled = false;
    this.godRayMesh.renderOrder = 6;
    this.group.add(this.godRayMesh);

    this.applyQuality(quality);
    this.initViewportOverlay(overlayContainer);

    if (scene) {
      scene.add(this.group);
    }
  }

  public setWorldRoute(routeController: WorldRouteController): void {
    this.routeController = routeController;
    this.lastRayAnchorS = Number.NaN;
  }

  public setQuality(quality: ResolvedQuality): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.applyQuality(quality);
    this.lastRayAnchorS = Number.NaN;
  }

  private applyQuality(quality: ResolvedQuality): void {
    const preset = QUALITY_PRESETS[quality];
    this.causticsUniforms.uCausticsEnabled.value = preset.causticsEnabled ? 1.0 : 0.0;
    this.activeRayCount = quality === 'high' ? MAX_GOD_RAYS : 10;
    this.godRayGeom.setDrawRange(0, this.activeRayCount * 6);
  }

  public setSunDirection(dir: THREE.Vector3): void {
    this.sunDir.copy(dir).normalize();
    this.causticsUniforms.uCausticsSunDir.value.copy(this.sunDir);
    this.refractedSun
      .set(-this.sunDir.x * 0.52, -Math.max(this.sunDir.y, 0.58), -this.sunDir.z * 0.52)
      .normalize();
  }

  public setSunColor(color: THREE.Color): void {
    this.godRayMat.uniforms.uColorTop.value
      .copy(color)
      .lerp(this.trackCausticColor, 0.45);
    this.causticsUniforms.uCausticsColor.value
      .copy(this.trackCausticColor)
      .lerp(color, 0.32);
  }

  /**
   * Apply blended spatial `BlendedEarthRegion` water optics (fog color/range, caustics, god-rays).
   */
  public applyEarthRegion(region: BlendedEarthRegion): void {
    const { waterStyle, caveStyle } = region;
    this.underwaterFogColor.setHex(waterStyle.underwaterFogColor);
    this.caveUnderwaterFogColor
      .setHex(caveStyle.floorColor)
      .lerp(this.underwaterFogColor, 0.45);
    this.underwaterFogNear = waterStyle.underwaterFogNear;
    this.underwaterFogFar = Math.max(
      waterStyle.underwaterFogFar,
      waterStyle.underwaterFogNear + 12,
    );

    this.trackCausticColor.setHex(waterStyle.causticColor);
    this.trackShallowColor.setHex(waterStyle.shallowColor);
    this.trackCausticBaseIntensity = waterStyle.causticIntensity;

    this.causticsUniforms.uCausticsColor.value.copy(this.trackCausticColor);
    this.godRayMat.uniforms.uColorTop.value
      .copy(this.trackCausticColor)
      .lerp(this.whiteScratch, 0.35);
    this.godRayMat.uniforms.uColorBottom.value.copy(this.trackShallowColor);
  }

  /**
   * Backward-compatible helper accepting legacy `BlendedWorldTrackState`.
   */
  public applyTrackState(blended: BlendedWorldTrackState): void {
    const primary = earthWorld.getZoneById(blended.currentTrack.id);
    const secondary = earthWorld.getZoneById(blended.nextTrack.id);
    this.applyEarthRegion(blendEarthRegionZones(primary, secondary, blended.blend));
  }

  /**
   * Softly trigger a brief water-lens meniscus shimmer & perimeter droplet pulse.
   */
  public triggerMeniscus(direction: 'enter' | 'exit', strength: number = 1.0): void {
    this.meniscusDir = direction === 'enter' ? 1 : -1;
    this.meniscusTimer = Math.max(
      this.meniscusTimer,
      MENISCUS_DURATION * Math.min(strength, 1.1),
    );
    if (direction === 'exit') {
      this.dropletStrength = Math.max(this.dropletStrength, Math.min(strength * 0.85, 0.85));
      this.dropletFallProgress = 0;
    }
  }

  /**
   * Immediately clear any transient meniscus wave or breach droplets.
   * Call on camera teleports / showcase mode transitions to prevent glare flashes.
   */
  public clearMeniscus(syncSubmerged?: boolean): void {
    this.meniscusTimer = 0;
    this.dropletStrength = 0;
    this.dropletFallProgress = 0;
    if (syncSubmerged !== undefined) {
      this.wasSubmerged = syncSubmerged;
      this.submersionBlend = syncSubmerged ? 1.0 : 0.0;
    }
    if (this.meniscusEl) {
      this.meniscusEl.style.opacity = '0';
    }
    for (let i = 0; i < this.droplets.length; i++) {
      this.droplets[i].el.style.opacity = '0';
    }
  }

  public getSubmersionBlend(): number {
    return this.submersionBlend;
  }

  public getUnderwaterFogColor(): THREE.Color {
    return this.activeUnderwaterFog;
  }

  public getUnderwaterFogRange(): { near: number; far: number } {
    return {
      near: this.underwaterFogNear,
      far: this.underwaterFogFar,
    };
  }

  public update(params: UnderwaterUpdateParams): void {
    const dt = Math.min(Math.max(params.dt, 0), 0.1);
    const { time, cameraSubmerged, submersionDepth, duckState, river } = params;
    const inCave = params.inCave ?? duckState.inCave ?? false;

    const duckSample = river.sampleAt(duckState.s);
    const region = resolveEarthRegionForSample(duckSample, this.routeController);
    this.applyEarthRegion(region);

    this.causticsUniforms.uCausticsTime.value = time;
    this.godRayMat.uniforms.uTime.value = time;

    // Detect camera teleport / sudden jump in s so we NEVER flash a meniscus bar on teleports!
    const isTeleport =
      !Number.isNaN(this.lastDuckS) && Math.abs(duckState.s - this.lastDuckS) > 12;
    this.lastDuckS = duckState.s;

    if (isTeleport) {
      this.clearMeniscus(cameraSubmerged);
    } else if (cameraSubmerged !== this.wasSubmerged) {
      this.triggerMeniscus(cameraSubmerged ? 'enter' : 'exit', 0.9);
      this.wasSubmerged = cameraSubmerged;
    } else if (params.meniscusPulse && params.meniscusPulse > 0.25) {
      this.meniscusTimer = Math.max(
        this.meniscusTimer,
        params.meniscusPulse * MENISCUS_DURATION * 0.75,
      );
      if (!cameraSubmerged) {
        this.dropletStrength = Math.max(
          this.dropletStrength,
          Math.min(0.75, params.meniscusPulse * 0.75),
        );
      }
    }

    // Smooth submersion transition
    const targetSub = cameraSubmerged
      ? THREE.MathUtils.clamp(0.72 + submersionDepth * 0.32, 0.72, 1.0)
      : 0.0;
    if (isTeleport) {
      this.submersionBlend = targetSub;
    } else {
      const rate = cameraSubmerged ? 14.0 : 10.5;
      this.submersionBlend += (targetSub - this.submersionBlend) * (1 - Math.exp(-rate * dt));
      if (this.submersionBlend < 0.002 && targetSub === 0) {
        this.submersionBlend = 0;
      }
    }

    if (this.meniscusTimer > 0) {
      this.meniscusTimer = Math.max(0, this.meniscusTimer - dt);
    }
    if (this.dropletStrength > 0) {
      this.dropletFallProgress += dt * 1.15;
      this.dropletStrength = Math.max(0, this.dropletStrength - dt * 1.15);
    }

    this.activeUnderwaterFog
      .copy(this.underwaterFogColor)
      .lerp(this.caveUnderwaterFogColor, inCave ? 0.52 : 0.0);

    if (params.scene && params.surfaceFogColor) {
      const surfNear = params.surfaceFogNear ?? 52;
      const surfFar = params.surfaceFogFar ?? 205;
      const uRange = this.getUnderwaterFogRange();

      this.blendedFogColor
        .copy(params.surfaceFogColor)
        .lerp(this.activeUnderwaterFog, this.submersionBlend);
      const fogNear = THREE.MathUtils.lerp(surfNear, uRange.near, this.submersionBlend);
      const fogFar = THREE.MathUtils.lerp(surfFar, uRange.far, this.submersionBlend);

      if (params.scene.fog instanceof THREE.Fog) {
        params.scene.fog.color.copy(this.blendedFogColor);
        params.scene.fog.near = fogNear;
        params.scene.fog.far = fogFar;
      } else {
        params.scene.fog = new THREE.Fog(this.blendedFogColor, fogNear, fogFar);
      }
    }

    const caveCausticScale = inCave ? 0.65 : 1.0;
    this.causticsUniforms.uCausticsIntensity.value =
      this.trackCausticBaseIntensity *
      THREE.MathUtils.lerp(0.85, 1.38, this.submersionBlend) *
      caveCausticScale;

    const rayIntensity =
      THREE.MathUtils.lerp(
        0.0,
        1.0,
        THREE.MathUtils.smoothstep(this.submersionBlend, 0.08, 0.65),
      ) * (inCave ? 0.65 : 1.0);
    this.godRayMat.uniforms.uIntensity.value = rayIntensity;
    this.godRayMesh.visible = rayIntensity > 0.01;

    if (this.godRayMesh.visible) {
      const frameRev =
        (river as RiverProvider & { getFrameRevision?: () => number }).getFrameRevision?.() ?? 0;
      if (frameRev !== this.lastFrameRevision) {
        this.lastFrameRevision = frameRev;
        this.lastRayAnchorS = Number.NaN;
      }
      const anchorStep = 3.0;
      const snappedS = Math.floor(duckState.s / anchorStep) * anchorStep;
      if (
        Number.isNaN(this.lastRayAnchorS) ||
        Math.abs(snappedS - this.lastRayAnchorS) >= anchorStep * 0.5 ||
        this.lastRayInCave !== inCave
      ) {
        this.rebuildGodRays(snappedS, duckState.u, river, inCave);
        this.lastRayAnchorS = snappedS;
        this.lastRayInCave = inCave;
      }
    }

    this.updateViewportOverlay(time, params.breath ?? duckState.breath, cameraSubmerged);
  }

  private rebuildGodRays(
    anchorS: number,
    duckU: number,
    river: RiverProvider,
    inCave: boolean,
  ): void {
    const count = this.activeRayCount;
    const rxDir = this.refractedSun.x;
    const ryDir = this.refractedSun.y;
    const rzDir = this.refractedSun.z;

    for (let i = 0; i < count; i++) {
      const cellIndex = Math.floor(anchorS / 3.0) + i;
      const hashA = fract(Math.sin(cellIndex * 127.1 + 19.3) * 43758.5453);
      const hashB = fract(Math.sin(cellIndex * 269.5 + 73.1) * 28461.9123);
      const hashC = fract(Math.sin(cellIndex * 419.2 + 41.7) * 19532.4317);

      const s = cellIndex * 3.0 + 3.0 + hashA * 2.0;
      const sample = river.sampleAt(s);
      const u = inCave
        ? duckU + (hashB * 2.0 - 1.0) * 1.8
        : (hashB * 2.0 - 1.0) * (sample.width * 0.34);

      const topX = sample.position.x + sample.right.x * u;
      const topY = sample.position.y + (inCave ? 2.4 : -0.02);
      const topZ = sample.position.z + sample.right.z * u;

      const shaftLen = Math.min(sample.depth + (inCave ? 3.2 : 1.1), 6.8) * (0.85 + hashC * 0.3);
      const widthTop = 1.45 + hashC * 1.25;
      const widthBottom = widthTop * 1.72;

      const crossAngle = (i % 2 === 0 ? 0.35 : -0.35) + (hashA - 0.5) * 0.55;
      const cosA = Math.cos(crossAngle);
      const sinA = Math.sin(crossAngle);
      const sideX = sample.right.x * cosA + sample.tangent.x * sinA;
      const sideZ = sample.right.z * cosA + sample.tangent.z * sinA;

      const botX = topX + rxDir * shaftLen;
      const botY = topY + ryDir * shaftLen;
      const botZ = topZ + rzDir * shaftLen;

      let nx = sideZ * ryDir;
      let ny = sideZ * rxDir - sideX * rzDir;
      let nz = -sideX * ryDir;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;

      const vBase = i * 4;
      const p = this.rayPositions;
      const n = this.rayNormals;

      p[vBase * 3] = botX - sideX * widthBottom * 0.5;
      p[vBase * 3 + 1] = botY;
      p[vBase * 3 + 2] = botZ - sideZ * widthBottom * 0.5;

      p[(vBase + 1) * 3] = botX + sideX * widthBottom * 0.5;
      p[(vBase + 1) * 3 + 1] = botY;
      p[(vBase + 1) * 3 + 2] = botZ + sideZ * widthBottom * 0.5;

      p[(vBase + 2) * 3] = topX - sideX * widthTop * 0.5;
      p[(vBase + 2) * 3 + 1] = topY;
      p[(vBase + 2) * 3 + 2] = topZ - sideZ * widthTop * 0.5;

      p[(vBase + 3) * 3] = topX + sideX * widthTop * 0.5;
      p[(vBase + 3) * 3 + 1] = topY;
      p[(vBase + 3) * 3 + 2] = topZ + sideZ * widthTop * 0.5;

      for (let k = 0; k < 4; k++) {
        n[(vBase + k) * 3] = nx;
        n[(vBase + k) * 3 + 1] = ny;
        n[(vBase + k) * 3 + 2] = nz;
      }

      const rayAlpha = inCave ? (i % 3 === 0 ? 1.0 : 0.0) : 0.72 + hashC * 0.28;
      this.rayAlphas[vBase] = rayAlpha;
      this.rayAlphas[vBase + 1] = rayAlpha;
      this.rayAlphas[vBase + 2] = rayAlpha;
      this.rayAlphas[vBase + 3] = rayAlpha;
    }

    this.rayPosAttr.needsUpdate = true;
    this.rayNormAttr.needsUpdate = true;
    this.rayAlphaAttr.needsUpdate = true;
  }

  private initViewportOverlay(container?: HTMLElement | null): void {
    if (typeof document === 'undefined') return;
    const host = container ?? document.getElementById('app') ?? document.body;
    if (!host) return;

    const root = document.createElement('div');
    root.id = 'underwater-fx-overlay';
    root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:5;overflow:hidden;contain:layout style;';

    const vignette = document.createElement('div');
    vignette.style.cssText = [
      'position:absolute;inset:0;opacity:0;will-change:opacity;',
      'background:radial-gradient(ellipse 78% 72% at 50% 48%, rgba(20,175,185,0.02) 48%, rgba(6,78,96,0.28) 84%, rgba(2,42,58,0.56) 100%);',
      'box-shadow:inset 0 0 38px rgba(72,245,235,0.18), inset 0 14px 36px rgba(155,255,246,0.14);',
    ].join('');
    root.appendChild(vignette);

    const meniscus = document.createElement('div');
    meniscus.style.cssText = [
      'position:absolute;left:-12%;right:-12%;height:18%;top:41%;opacity:0;will-change:transform,opacity;',
      'background:radial-gradient(ellipse 68% 48% at 50% 50%, rgba(180,255,252,0.26) 0%, rgba(110,238,242,0.16) 45%, rgba(20,150,165,0) 100%);',
      'filter:blur(10px);border-radius:50%;',
    ].join('');
    root.appendChild(meniscus);

    const breathPulse = document.createElement('div');
    breathPulse.style.cssText = [
      'position:absolute;inset:0;opacity:0;will-change:opacity;',
      'box-shadow:inset 0 0 58px 12px rgba(56,225,255,0.48);',
    ].join('');
    root.appendChild(breathPulse);

    const dropletSeeds: Array<[number, number, number]> = [
      [7, 13, 14],
      [17, 24, 10],
      [86, 15, 15],
      [92, 34, 11],
      [10, 70, 12],
      [89, 72, 13],
      [28, 9, 9],
      [74, 11, 11],
      [6, 46, 10],
      [94, 52, 9],
    ];
    for (let i = 0; i < dropletSeeds.length; i++) {
      const [bx, by, sz] = dropletSeeds[i];
      const drop = document.createElement('div');
      drop.style.cssText = [
        `position:absolute;left:${bx}%;top:${by}%;width:${sz}px;height:${Math.round(sz * 1.28)}px;`,
        'border-radius:52% 48% 54% 46% / 60% 60% 40% 40%;opacity:0;will-change:transform,opacity;',
        'background:radial-gradient(circle at 35% 30%, rgba(255,255,255,0.72) 0%, rgba(190,250,255,0.22) 45%, rgba(28,164,180,0.12) 78%, rgba(255,255,255,0.38) 100%);',
        'box-shadow:inset -1px -2px 3px rgba(6,52,66,0.22), 0 1px 4px rgba(200,255,255,0.20);',
      ].join('');
      root.appendChild(drop);
      this.droplets.push({
        el: drop,
        baseX: bx,
        baseY: by,
        size: sz,
        speed: 18 + (i % 4) * 9,
        phase: i * 0.7,
      });
    }

    host.appendChild(root);
    this.overlayRoot = root;
    this.vignetteEl = vignette;
    this.meniscusEl = meniscus;
    this.breathPulseEl = breathPulse;
  }

  private updateViewportOverlay(
    time: number,
    breath: number,
    cameraSubmerged: boolean,
  ): void {
    if (!this.vignetteEl || !this.meniscusEl || !this.breathPulseEl) return;

    const sub = this.submersionBlend;
    if (Math.abs(sub - this.lastOverlaySubmersion) > 0.004 || sub > 0.01) {
      const shimmer = sub > 0.02 ? 0.94 + 0.06 * Math.sin(time * 4.2) : 1.0;
      this.vignetteEl.style.opacity = (sub * shimmer).toFixed(3);
      this.lastOverlaySubmersion = sub;
    }

    if (this.meniscusTimer > 0.001) {
      const t = 1.0 - THREE.MathUtils.clamp(this.meniscusTimer / MENISCUS_DURATION, 0, 1);
      const opacity = Math.sin(t * Math.PI) * 0.22;
      const yShift = this.meniscusDir > 0 ? (0.5 - t) * 100 : (t - 0.5) * 100;
      const tilt = Math.sin(time * 10.0) * 1.6;
      this.meniscusEl.style.opacity = opacity.toFixed(3);
      this.meniscusEl.style.transform = `translate3d(0, ${yShift.toFixed(1)}vh, 0) rotate(${tilt.toFixed(2)}deg)`;
    } else if (this.meniscusEl.style.opacity !== '0') {
      this.meniscusEl.style.opacity = '0';
    }

    if (this.dropletStrength > 0.01) {
      const fall = this.dropletFallProgress;
      for (let i = 0; i < this.droplets.length; i++) {
        const d = this.droplets[i];
        const dy = fall * d.speed;
        const alpha =
          this.dropletStrength * 0.72 * (0.72 + 0.28 * Math.sin(d.phase + time * 3.0));
        d.el.style.opacity = alpha.toFixed(3);
        d.el.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0)`;
      }
    } else if (this.droplets.length > 0 && this.droplets[0].el.style.opacity !== '0') {
      for (let i = 0; i < this.droplets.length; i++) {
        this.droplets[i].el.style.opacity = '0';
      }
    }

    if (cameraSubmerged && breath < 0.32) {
      const urgency = THREE.MathUtils.clamp((0.32 - breath) / 0.32, 0, 1);
      const pulse = (0.45 + 0.55 * Math.sin(time * (6.5 + urgency * 6.0))) * urgency * 0.68;
      this.breathPulseEl.style.opacity = pulse.toFixed(3);
    } else if (this.breathPulseEl.style.opacity !== '0') {
      this.breathPulseEl.style.opacity = '0';
    }
  }

  public reset(): void {
    this.submersionBlend = 0;
    this.wasSubmerged = false;
    this.lastDuckS = Number.NaN;
    this.lastRayAnchorS = Number.NaN;
    this.lastFrameRevision = -1;
    this.clearMeniscus(false);
    if (this.vignetteEl) this.vignetteEl.style.opacity = '0';
    if (this.breathPulseEl) this.breathPulseEl.style.opacity = '0';
  }

  public dispose(): void {
    this.godRayGeom.dispose();
    this.godRayMat.dispose();
    this.group.parent?.remove(this.group);
    this.overlayRoot?.remove();
    this.overlayRoot = null;
    this.vignetteEl = null;
    this.meniscusEl = null;
    this.breathPulseEl = null;
    this.droplets.length = 0;
  }
}

function fract(x: number): number {
  return x - Math.floor(x);
}
