import * as THREE from 'three';
import { QUALITY_PRESETS } from '../config';
import type { AssetLoader } from '../assets/loader';
import { getAssetSpec } from '../assets/manifest';
import { earthToLocal, type LocalTangentFrame } from '../earth/coords';
import { earthWorld } from '../earth/earthWorld';
import {
  blendEarthRegionZones,
  type BlendedEarthRegion,
  type EarthLandmark,
  type EarthLandmarkRule,
  type EarthSceneryWeightedAsset,
} from '../earth/schema';
import {
  worldRoute as defaultWorldRoute,
  type WorldRouteController,
} from '../tracks/worldGraph';
import type {
  AssetId,
  CaveBranchInfo,
  DuckState,
  ResolvedQuality,
  RiverProvider,
  RiverSample,
} from '../types';
import {
  CAUSTICS_GLSL,
  createSharedCausticsUniforms,
  type SharedCausticsUniforms,
} from './underwaterFx';
import type {
  ForkBranchPreviewResult,
  ForkPreviewContainer,
  ForkPreviewPoint,
} from './waterMesh';

// ---------------------------------------------------------------------------
// Deterministic fast hash helpers (zero allocations, mobile-safe)
// ---------------------------------------------------------------------------
function hash11(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function hash21(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}

function smoothNoise1D(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash11(i) * (1 - u) + hash11(i + 1) * u;
}

function fbm1D(x: number): number {
  return (
    smoothNoise1D(x) * 0.6 +
    smoothNoise1D(x * 2.17 + 13.4) * 0.28 +
    smoothNoise1D(x * 4.53 + 29.1) * 0.12
  );
}

function pickWeightedAsset(
  list: readonly EarthSceneryWeightedAsset[],
  rnd01: number,
): EarthSceneryWeightedAsset | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    total += Math.max(0.001, list[i].weight);
  }
  let target = rnd01 * total;
  for (let i = 0; i < list.length; i++) {
    target -= Math.max(0.001, list[i].weight);
    if (target <= 0) return list[i];
  }
  return list[list.length - 1];
}

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

function extractForkPoints(
  preview: ForkBranchPreviewResult,
): readonly ForkPreviewPoint[] | null {
  if (!preview) return null;
  if (Array.isArray(preview)) {
    return preview.length >= 2 ? preview : null;
  }
  const c = preview as ForkPreviewContainer;
  const list = c.samples ?? c.points;
  return list && list.length >= 2 ? list : null;
}

// ---------------------------------------------------------------------------
// Shared Bank & Canyon Wall Height Profile (used by BOTH terrain mesh & prop grounding!)
// Capped cleanly (y5 <= 26.5u) so canyon/fjord walls look dramatic WITHOUT sealing off
// the sky dome, Aurora Borealis, or volcanic dusk horizon!
// ---------------------------------------------------------------------------
const BANK_DIST_STATIONS = [0.12, 1.85, 5.0, 11.5, 21.5, 34.0] as const;

function computeBankHeightY(
  distFromBank: number,
  bankNoise: number,
  hillNoise: number,
  bankHeightScale: number = 1.0,
  bankSteepness: number = 1.0,
  canyonWallFactor: number = 0.08,
): number {
  const cwf = THREE.MathUtils.clamp(canyonWallFactor, 0, 1);
  const hScale = THREE.MathUtils.clamp(bankHeightScale, 0.22, 1.55);
  const steep = THREE.MathUtils.clamp(bankSteepness, 0.5, 1.85);

  const y0 = 0.06;
  const y1 = Math.min(
    1.35,
    (0.56 + bankNoise * 0.30) *
      THREE.MathUtils.lerp(Math.min(hScale, 1.15), Math.min(hScale, 1.25) * 1.16, cwf),
  );
  const y2 = Math.min(
    3.85,
    (1.52 + bankNoise * 0.68) *
      THREE.MathUtils.lerp(hScale, hScale * (0.86 + steep * 0.22), cwf),
  );
  const cliffBoost3 = THREE.MathUtils.lerp(
    hScale,
    hScale * (0.88 + steep * 0.32),
    cwf,
  );
  const cliffBoost4 = THREE.MathUtils.lerp(
    hScale,
    hScale * (0.94 + steep * 0.36),
    cwf,
  );
  const y3 = Math.min(11.5, (3.45 + bankNoise * 1.65) * cliffBoost3);
  const y4 = Math.min(19.5, (6.85 + hillNoise * 3.15) * cliffBoost4);
  const y5 = Math.min(26.5, (11.2 + hillNoise * 4.85) * cliffBoost4);

  const d = Math.max(BANK_DIST_STATIONS[0], distFromBank);
  if (d <= BANK_DIST_STATIONS[1]) {
    const t =
      (d - BANK_DIST_STATIONS[0]) /
      (BANK_DIST_STATIONS[1] - BANK_DIST_STATIONS[0]);
    return y0 + (y1 - y0) * t;
  }
  if (d <= BANK_DIST_STATIONS[2]) {
    const t =
      (d - BANK_DIST_STATIONS[1]) /
      (BANK_DIST_STATIONS[2] - BANK_DIST_STATIONS[1]);
    return y1 + (y2 - y1) * t;
  }
  if (d <= BANK_DIST_STATIONS[3]) {
    const t =
      (d - BANK_DIST_STATIONS[2]) /
      (BANK_DIST_STATIONS[3] - BANK_DIST_STATIONS[2]);
    return y2 + (y3 - y2) * t;
  }
  if (d <= BANK_DIST_STATIONS[4]) {
    const t =
      (d - BANK_DIST_STATIONS[3]) /
      (BANK_DIST_STATIONS[4] - BANK_DIST_STATIONS[3]);
    return y3 + (y4 - y3) * t;
  }
  const t = Math.min(
    1,
    (d - BANK_DIST_STATIONS[4]) /
      (BANK_DIST_STATIONS[5] - BANK_DIST_STATIONS[4]),
  );
  return y4 + (y5 - y4) * t;
}

// ---------------------------------------------------------------------------
// Procedural Sunlit Sky + Forest + Creek-Bounce Equirectangular IBL Texture
// ---------------------------------------------------------------------------
function createProceduralNatureEnvironmentTexture(): THREE.DataTexture {
  const width = 256;
  const height = 128;
  const data = new Uint8Array(width * height * 4);

  const sunX = 0.45;
  const sunY = 0.78;
  const sunZ = 0.43;
  const sunLen = Math.hypot(sunX, sunY, sunZ);
  const sx = sunX / sunLen;
  const sy = sunY / sunLen;
  const sz = sunZ / sunLen;

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const phi = (v - 0.5) * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const theta = u * Math.PI * 2;
      const dx = cosPhi * Math.cos(theta);
      const dy = sinPhi;
      const dz = cosPhi * Math.sin(theta);

      let r = 0;
      let g = 0;
      let b = 0;

      if (dy >= 0) {
        const skyT = Math.pow(dy, 0.55);
        r = THREE.MathUtils.lerp(0.84, 0.36, skyT);
        g = THREE.MathUtils.lerp(0.95, 0.68, skyT);
        b = THREE.MathUtils.lerp(1.0, 0.98, skyT);

        const canopyMask =
          Math.exp(-dy * 12.0) * (0.45 + 0.25 * Math.sin(theta * 5.0));
        r = THREE.MathUtils.lerp(r, 0.48, canopyMask * 0.32);
        g = THREE.MathUtils.lerp(g, 0.72, canopyMask * 0.32);
        b = THREE.MathUtils.lerp(b, 0.54, canopyMask * 0.32);
      } else {
        const downT = Math.pow(Math.min(-dy, 1), 0.6);
        r = THREE.MathUtils.lerp(0.62, 0.24, downT);
        g = THREE.MathUtils.lerp(0.82, 0.52, downT);
        b = THREE.MathUtils.lerp(0.8, 0.48, downT);
      }

      const sunDot = Math.max(0, dx * sx + dy * sy + dz * sz);
      const sunHalo =
        Math.pow(sunDot, 6.0) * 0.38 + Math.pow(sunDot, 42.0) * 0.9;
      r += sunHalo * 1.05;
      g += sunHalo * 0.96;
      b += sunHalo * 0.78;

      const idx = (y * width + x) * 4;
      data[idx] = Math.min(255, Math.max(0, Math.round(r * 255)));
      data[idx + 1] = Math.min(255, Math.max(0, Math.round(g * 255)));
      data[idx + 2] = Math.min(255, Math.max(0, Math.round(b * 255)));
      data[idx + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// Sky Dome & Aurora Borealis Shaders
// ---------------------------------------------------------------------------
const SKY_VERTEX_SHADER = /* glsl */ `
varying vec3 vWorldDir;
void main() {
  vWorldDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uTime;
uniform float uTwilight;
uniform float uVolcanicGlow;
uniform float uLightningFlash;
uniform float uUnderwater;
uniform vec3 uUnderwaterBg;

varying vec3 vWorldDir;

float hash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x),
    mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float cloudFbm(vec2 p) {
  float v = noise2(p) * 0.56;
  v += noise2(p * 2.15 + vec2(5.2, 1.3)) * 0.28;
  v += noise2(p * 4.4 + vec2(9.1, 7.7)) * 0.16;
  return v;
}

void main() {
  vec3 dir = normalize(vWorldDir);
  vec3 sunDir = normalize(uSunDir);

  float h = clamp(dir.y, -0.25, 1.0);
  float horizonCurve = pow(clamp(max(h, 0.0), 0.0, 1.0), 0.56);
  vec3 sky = mix(uSkyHorizon, uSkyTop, horizonCurve);

  float horizonBand = exp(-abs(dir.y) * 6.8);
  sky = mix(sky, mix(uSkyHorizon, uSunColor, 0.28), horizonBand * 0.48);

  if (uVolcanicGlow > 0.01) {
    float emberWave = 0.72 + 0.28 * sin(dir.x * 7.0 + dir.z * 5.0 + uTime * 1.8);
    float emberBand = exp(-abs(dir.y - 0.08) * 3.6) * emberWave;
    float upperGlow = smoothstep(0.0, 0.34, dir.y) * (1.0 - smoothstep(0.28, 0.72, dir.y)) * 0.42;
    sky += vec3(1.0, 0.30, 0.07) * (emberBand * 0.76 + upperGlow) * uVolcanicGlow;
  }

  if (dir.y > 0.03) {
    vec2 cloudUv = dir.xz / (dir.y + 0.22) * 1.15 + vec2(uTime * 0.008, uTime * 0.004);
    float c = cloudFbm(cloudUv);
    float cloudMask = smoothstep(0.46, 0.78, c) * smoothstep(0.03, 0.24, dir.y) * (1.0 - uTwilight * 0.55);
    float sunLit = 0.65 + 0.35 * clamp(dot(dir, sunDir), 0.0, 1.0);
    vec3 cloudCol = mix(uSkyHorizon * 1.12, uSunColor * 1.08, sunLit * 0.6);
    if (uVolcanicGlow > 0.01) {
      cloudCol = mix(cloudCol, vec3(1.0, 0.36, 0.12), uVolcanicGlow * 0.38);
    }
    sky = mix(sky, cloudCol, cloudMask * 0.64);
  }

  float sunDot = clamp(dot(dir, sunDir), 0.0, 1.0);
  float mieGlow = pow(sunDot, 7.0) * 0.36 + pow(sunDot, 48.0) * 0.68;
  float sunDisc = smoothstep(0.9965, 0.9992, sunDot);
  sky += uSunColor * (mieGlow + sunDisc * 2.2);

  if (uTwilight > 0.05 && dir.y > 0.08) {
    vec2 starCell = floor(dir.xz / (dir.y + 0.15) * 72.0);
    float starRnd = hash2(starCell);
    float star = step(0.991, starRnd) * (0.55 + 0.45 * sin(uTime * 3.2 + starRnd * 50.0));
    sky += vec3(0.80, 0.94, 1.0) * star * uTwilight * smoothstep(0.08, 0.42, dir.y) * 1.25;
  }

  if (dir.y < 0.0) {
    sky = mix(uSkyHorizon * 0.82, uSkyGround, clamp(-dir.y * 3.2, 0.0, 1.0));
  }

  if (uLightningFlash > 0.01) {
    float boltZone = smoothstep(-0.1, 0.75, dir.y) * (0.65 + 0.35 * sin(dir.x * 4.0 + dir.z * 3.0));
    sky += vec3(0.82, 0.94, 1.0) * uLightningFlash * boltZone * 1.15;
  }

  sky = mix(sky, uUnderwaterBg, clamp(uUnderwater, 0.0, 1.0));

  gl_FragColor = vec4(sky, 1.0);
}
`;

const AURORA_VERTEX_SHADER = /* glsl */ `
varying vec3 vLocalDir;
void main() {
  vLocalDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const AURORA_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

uniform float uTime;
uniform float uStrength;
uniform vec3 uColorA;
uniform vec3 uColorB;

varying vec3 vLocalDir;

float aurHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float aurNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(aurHash(i), aurHash(i + vec2(1.0, 0.0)), u.x),
    mix(aurHash(i + vec2(0.0, 1.0)), aurHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void main() {
  if (uStrength <= 0.01) discard;
  vec3 d = normalize(vLocalDir);
  if (d.y <= 0.015) discard;

  float azim = atan(d.z, d.x);
  vec2 skyP = d.xz / (d.y + 0.24);

  // Sweeping horizon-visible aurora plasma curtains across d.y in [0.04, 0.56]
  // so vibrant emerald-cyan & violet-magenta waves pop unmistakably in every polar heading!
  float bandWave1 = 0.17 + 0.065 * sin(azim * 3.0 + uTime * 0.42) + 0.032 * cos(azim * 6.0 - uTime * 0.31);
  float bandDist1 = abs(d.y - bandWave1);
  float curtain1 = exp(-bandDist1 * 11.5) * smoothstep(bandWave1 - 0.06, bandWave1 + 0.02, d.y);

  float bandWave2 = 0.29 + 0.075 * sin(azim * 2.0 - uTime * 0.36 + 1.4) + 0.038 * sin(azim * 5.0 + uTime * 0.52);
  float bandDist2 = abs(d.y - bandWave2);
  float curtain2 = exp(-bandDist2 * 9.0) * smoothstep(bandWave2 - 0.07, bandWave2 + 0.03, d.y);

  float wave3 = sin(skyP.x * 2.2 + skyP.y * 1.4 + uTime * 0.38) * 0.44;
  float ribbonDist3 = abs(fract(skyP.y * 0.72 + wave3) - 0.5);
  float upperRibbon = smoothstep(0.28, 0.02, ribbonDist3) * smoothstep(0.14, 0.34, d.y);

  // Vertical magnetic field-line shimmer rays streaming upward from the curtain base
  float rays = 0.56 + 0.44 * sin(azim * 28.0 + sin(azim * 7.0 + uTime * 0.85) * 3.4 - uTime * 1.45);
  float fineRays = 0.64 + 0.36 * aurNoise(vec2(azim * 16.0 + uTime * 0.55, d.y * 7.5));

  float elevMask = smoothstep(0.02, 0.14, d.y) * (1.0 - smoothstep(0.70, 0.96, d.y));
  float skyGlow = exp(-abs(d.y - 0.22) * 5.2) * 0.24 * elevMask;
  float curtain = (curtain1 * 1.05 + curtain2 * 0.82 + upperRibbon * 0.58) * rays * fineRays * elevMask + skyGlow;

  float alpha = clamp(curtain * uStrength * 1.12, 0.0, 0.94);
  if (alpha <= 0.005) discard;

  float colorMix = clamp(
    curtain2 * 0.52 + upperRibbon * 0.42 + smoothstep(0.16, 0.48, d.y) * 0.58,
    0.0,
    1.0
  );
  vec3 col = mix(uColorA, uColorB, colorMix);
  col += uColorA * pow(clamp(curtain1 * rays, 0.0, 1.0), 1.8) * 0.62;
  col += vec3(0.45, 1.0, 0.88) * pow(clamp(curtain1, 0.0, 1.0), 3.0) * 0.35;

  gl_FragColor = vec4(col, alpha);
}
`;

// ---------------------------------------------------------------------------
// Zero-Hardcode Dynamic Instanced Asset Pool (Allocated On-Demand for ANY AssetId!)
// Zero-Overhead Culling: count === 0 -> visible = false -> 0 draw calls & 0 tris!
// ---------------------------------------------------------------------------
interface InstancedPart {
  mesh: THREE.InstancedMesh;
  localMatrix: THREE.Matrix4;
}

class DynamicInstancedPool {
  public readonly group: THREE.Group;
  public readonly assetId: AssetId;
  private readonly maxCount: number;
  private readonly castShadow: boolean;
  private readonly receiveShadow: boolean;
  private parts: InstancedPart[] = [];
  private activeCount = 0;

  private readonly tmpMat = new THREE.Matrix4();

  constructor(
    assetId: AssetId,
    maxCount: number,
    castShadow: boolean,
    receiveShadow: boolean,
  ) {
    this.assetId = assetId;
    this.maxCount = maxCount;
    this.castShadow = castShadow;
    this.receiveShadow = receiveShadow;
    this.group = new THREE.Group();
    this.group.name = `dynamic_pool_${assetId}`;
    this.group.visible = false;
  }

  public buildFromLoader(loader: AssetLoader, shadowsEnabled: boolean): void {
    this.clearMeshes();

    const loaded = loader.get(this.assetId);
    const proto = loaded.prototype;
    proto.updateMatrixWorld(true);

    const protoInverse = new THREE.Matrix4().copy(proto.matrixWorld).invert();
    const extracted: Array<{
      geometry: THREE.BufferGeometry;
      material: THREE.Material;
      localMatrix: THREE.Matrix4;
    }> = [];

    proto.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      if (!obj.geometry || !mat) return;
      const localMat = new THREE.Matrix4()
        .copy(protoInverse)
        .multiply(obj.matrixWorld);
      extracted.push({
        geometry: obj.geometry,
        material: mat.clone(),
        localMatrix: localMat,
      });
    });

    for (let i = 0; i < extracted.length; i++) {
      const part = extracted[i];
      if (part.material instanceof THREE.MeshStandardMaterial) {
        part.material.envMapIntensity = 1.15;
        if (part.material.metalness > 0.25) {
          part.material.metalness = 0.12;
        }
      }

      const inst = new THREE.InstancedMesh(
        part.geometry,
        part.material,
        this.maxCount,
      );
      inst.count = 0;
      inst.visible = false;
      inst.frustumCulled = false;
      inst.castShadow = this.castShadow && shadowsEnabled;
      inst.receiveShadow = this.receiveShadow;
      this.group.add(inst);

      this.parts.push({
        mesh: inst,
        localMatrix: part.localMatrix,
      });
    }
    this.group.visible = false;
  }

  public setShadowsEnabled(enabled: boolean): void {
    for (let i = 0; i < this.parts.length; i++) {
      this.parts[i].mesh.castShadow = this.castShadow && enabled;
    }
  }

  public beginFrame(): void {
    this.activeCount = 0;
  }

  public getActiveCount(): number {
    return this.activeCount;
  }

  public pushInstance(worldMatrix: THREE.Matrix4, colorTint?: THREE.Color): boolean {
    if (this.activeCount >= this.maxCount) return false;
    const idx = this.activeCount;
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      this.tmpMat.copy(worldMatrix).multiply(part.localMatrix);
      part.mesh.setMatrixAt(idx, this.tmpMat);
      if (colorTint) {
        part.mesh.setColorAt(idx, colorTint);
      }
    }
    this.activeCount++;
    return true;
  }

  public commit(): void {
    const hasActive = this.activeCount > 0;
    this.group.visible = hasActive;
    for (let i = 0; i < this.parts.length; i++) {
      const mesh = this.parts[i].mesh;
      mesh.count = this.activeCount;
      mesh.visible = hasActive;
      if (hasActive) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.needsUpdate = true;
        }
      }
    }
  }

  public clearMeshes(): void {
    for (let i = 0; i < this.parts.length; i++) {
      const mesh = this.parts[i].mesh;
      this.group.remove(mesh);
      if (Array.isArray(mesh.material)) {
        for (const m of mesh.material) m.dispose();
      } else {
        mesh.material.dispose();
      }
      mesh.dispose();
    }
    this.parts = [];
    this.activeCount = 0;
    this.group.visible = false;
  }

  public dispose(): void {
    this.clearMeshes();
    this.group.parent?.remove(this.group);
  }
}

// ---------------------------------------------------------------------------
// 100% Continuous Data-Driven Terrain & Cave Shaders (ZERO hardcoded styleId!)
// ---------------------------------------------------------------------------
const TERRAIN_ROWS = 132;
const TERRAIN_COLS = 25;
const TERRAIN_STEP_S = 1.8;

const CAVE_ROWS = 56;
const CAVE_RING_SEGS = 20;

interface TerrainShaderUniforms {
  uMossTint: THREE.IUniform<THREE.Color>;
  uRockTint: THREE.IUniform<THREE.Color>;
  uBedShallowColor: THREE.IUniform<THREE.Color>;
  uBedDeepColor: THREE.IUniform<THREE.Color>;
  uShoreColor: THREE.IUniform<THREE.Color>;
  uEmissiveColor: THREE.IUniform<THREE.Color>;
  uPebbleScale: THREE.IUniform<number>;
  uTerrainTime: THREE.IUniform<number>;
}

interface CaveShaderUniforms {
  uCaveWallColor: THREE.IUniform<THREE.Color>;
  uCaveFloorColor: THREE.IUniform<THREE.Color>;
  uCaveGlowColor: THREE.IUniform<THREE.Color>;
  uCaveGlowIntensity: THREE.IUniform<number>;
  uCaveSkylightColor: THREE.IUniform<THREE.Color>;
  uCaveRoughness: THREE.IUniform<number>;
  uCaveTime: THREE.IUniform<number>;
}

function createTerrainMaterial(
  causticsUniforms: SharedCausticsUniforms,
): { material: THREE.MeshStandardMaterial; uniforms: TerrainShaderUniforms } {
  const uniforms: TerrainShaderUniforms = {
    uMossTint: { value: new THREE.Color('#3e8e41') },
    uRockTint: { value: new THREE.Color('#667174') },
    uBedShallowColor: { value: new THREE.Color('#736854') },
    uBedDeepColor: { value: new THREE.Color('#243b42') },
    uShoreColor: { value: new THREE.Color('#4c463d') },
    uEmissiveColor: { value: new THREE.Color('#000000') },
    uPebbleScale: { value: 1.0 },
    uTerrainTime: { value: 0.0 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.86,
    metalness: 0.02,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMossTint = uniforms.uMossTint;
    shader.uniforms.uRockTint = uniforms.uRockTint;
    shader.uniforms.uBedShallowColor = uniforms.uBedShallowColor;
    shader.uniforms.uBedDeepColor = uniforms.uBedDeepColor;
    shader.uniforms.uShoreColor = uniforms.uShoreColor;
    shader.uniforms.uEmissiveColor = uniforms.uEmissiveColor;
    shader.uniforms.uPebbleScale = uniforms.uPebbleScale;
    shader.uniforms.uTerrainTime = uniforms.uTerrainTime;

    shader.uniforms.uCausticsTime = causticsUniforms.uCausticsTime;
    shader.uniforms.uCausticsSunDir = causticsUniforms.uCausticsSunDir;
    shader.uniforms.uCausticsIntensity = causticsUniforms.uCausticsIntensity;
    shader.uniforms.uCausticsColor = causticsUniforms.uCausticsColor;
    shader.uniforms.uCausticsEnabled = causticsUniforms.uCausticsEnabled;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aTerrainMeta;    // x: heightAboveWater, y: waterfallProx, z: caveOpen, w: noiseSeed
attribute vec3 aGroundPrimary;  // per-slice blended primaryColor RGB
attribute vec3 aGroundSecondary;// per-slice blended secondaryColor RGB
attribute vec4 aGroundSurface;  // x: mossCoverage, y: snowCoverage, z: strataIntensity, w: strataScale
attribute vec4 aGroundFx;       // x: iceReflectivity, y: petalFlecks, z: emissiveIntensity, w: roughness
varying vec3 vRdWorldPos;
varying vec3 vRdWorldNormal;
varying vec4 vRdMeta;
varying vec3 vGroundPrimary;
varying vec3 vGroundSecondary;
varying vec4 vGroundSurface;
varying vec4 vGroundFx;
`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vec4 rdWp = modelMatrix * vec4(transformed, 1.0);
vRdWorldPos = rdWp.xyz;
vRdWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
vRdMeta = aTerrainMeta;
vGroundPrimary = aGroundPrimary;
vGroundSecondary = aGroundSecondary;
vGroundSurface = aGroundSurface;
vGroundFx = aGroundFx;
`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uMossTint;
uniform vec3 uRockTint;
uniform vec3 uBedShallowColor;
uniform vec3 uBedDeepColor;
uniform vec3 uShoreColor;
uniform vec3 uEmissiveColor;
uniform float uPebbleScale;
uniform float uTerrainTime;
varying vec3 vRdWorldPos;
varying vec3 vRdWorldNormal;
varying vec4 vRdMeta;
varying vec3 vGroundPrimary;
varying vec3 vGroundSecondary;
varying vec4 vGroundSurface;
varying vec4 vGroundFx;
${CAUSTICS_GLSL}

float rdTerrHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float rdTerrNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(rdTerrHash(i), rdTerrHash(i + vec2(1.0, 0.0)), u.x),
    mix(rdTerrHash(i + vec2(0.0, 1.0)), rdTerrHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float rdTerrFbm(vec2 p) {
  float v = rdTerrNoise(p) * 0.54;
  v += rdTerrNoise(p * 2.27 + vec2(13.1, 7.4)) * 0.30;
  v += rdTerrNoise(p * 5.13 + vec2(4.7, 23.9)) * 0.16;
  return v;
}

vec2 rdFinePebble(vec2 p) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  float md = 8.0;
  float cellId = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = rdCausticHash22(n + g);
      vec2 r = g + 0.18 + 0.64 * o - f;
      float d = dot(r, r);
      if (d < md) {
        md = d;
        cellId = o.x;
      }
    }
  }
  float dome = smoothstep(0.58, 0.08, md);
  return vec2(dome, cellId);
}
`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float hWater = vRdMeta.x;
  float wfProx = vRdMeta.y;
  vec3 wN = normalize(vRdWorldNormal);
  float flatMask = smoothstep(0.40, 0.86, wN.y);

  float mossCov = clamp(vGroundSurface.x, 0.0, 1.0);
  float snowCov = clamp(vGroundSurface.y, 0.0, 1.0);
  float strataInt = clamp(vGroundSurface.z, 0.0, 1.0);
  float strataSc = max(0.2, vGroundSurface.w);

  float iceRefl = clamp(vGroundFx.x, 0.0, 1.0);
  float petalFl = clamp(vGroundFx.y, 0.0, 1.0);
  float baseRough = clamp(vGroundFx.w, 0.1, 1.0);

  float macroPatch = rdTerrFbm(vRdWorldPos.xz * 0.14);
  float medGrain = rdTerrFbm(vRdWorldPos.xz * 0.72);
  float fineGrain = rdTerrNoise(vRdWorldPos.xz * 3.4);
  float rockStrata = rdTerrFbm(vec2((vRdWorldPos.x + vRdWorldPos.z) * 0.38, vRdWorldPos.y * 1.65));

  // 1. Riverbed fine gravel, silt & smooth cobbles scaled by pebbleScale
  vec2 peb = rdFinePebble(vRdWorldPos.xz * (4.65 * clamp(uPebbleScale, 0.4, 2.5)));
  float microGravel = rdTerrNoise(vRdWorldPos.xz * 13.0);
  vec3 riverSilt = mix(uBedDeepColor, uBedShallowColor, 0.45) * (0.82 + 0.34 * medGrain);
  vec3 cobbleWarm = uBedShallowColor * vec3(0.86, 0.80, 0.72);
  vec3 cobbleSlate = uRockTint * vec3(0.68, 0.74, 0.78);
  vec3 stoneTone = mix(cobbleSlate, cobbleWarm, smoothstep(0.2, 0.8, peb.y));
  vec3 cobbleLayer = stoneTone * (0.60 + 0.42 * peb.x) * (0.85 + 0.25 * microGravel);
  vec3 pebbleCol = mix(riverSilt, cobbleLayer, 0.52 + 0.38 * smoothstep(0.22, 0.78, medGrain));

  // 2. Continuous Cliff & Rock Face with Horizontal Sedimentary Strata / Hexagonal Column Facets
  float strataCoord = vRdWorldPos.y * (1.65 * strataSc) + rockStrata * 1.85 + macroPatch * 0.9;
  float bandA = sin(strataCoord * 3.1) * 0.5 + 0.5;
  float bandB = cos(strataCoord * 7.2 + medGrain * 2.4) * 0.5 + 0.5;

  vec3 baseRock = mix(uRockTint * 0.74, vGroundPrimary, 0.52) * (0.58 + 0.46 * rockStrata);
  vec3 strataRock = mix(vGroundSecondary * 0.82, vGroundPrimary * 1.12, smoothstep(0.18, 0.82, bandA));
  strataRock = mix(strataRock, mix(vGroundPrimary, uMossTint, 0.48) * 1.08, smoothstep(0.45, 0.88, bandB) * 0.42);
  // Subtle desert-varnish / columnar relief on steep striated rock cliffs
  vec2 colGrid = abs(fract(vRdWorldPos.xz * (0.95 * strataSc)) - 0.5);
  float colFacet = smoothstep(0.06, 0.44, max(colGrid.x, colGrid.y));
  float varnish = rdTerrNoise(vRdWorldPos.xz * 0.85) * (1.0 - flatMask);
  strataRock *= mix(1.0, 0.78 + 0.34 * colFacet, strataInt * smoothstep(0.82, 0.55, baseRough));
  strataRock = mix(strataRock, vGroundSecondary * 0.58, smoothstep(0.52, 0.86, varnish) * strataInt * 0.38);

  vec3 cliffCol = mix(baseRock, strataRock, strataInt) * (0.80 + 0.32 * fineGrain);

  // 3. Continuous Riverbank Earth, Loam & Moss Coverage
  vec3 soilBase = mix(uShoreColor * 0.85, vGroundSecondary, 0.58) * (0.74 + 0.48 * fineGrain);
  vec3 lushMoss = mix(vGroundPrimary, uMossTint, 0.58) * (0.68 + 0.50 * medGrain) * (0.84 + 0.28 * fineGrain);
  float mossMask = smoothstep(0.24, 0.78, macroPatch * 0.56 + medGrain * 0.44 + flatMask * 0.20) * mossCov;
  vec3 bankSurface = mix(soilBase, lushMoss, mossMask * 0.88);
  // Exposed riverbank stones near lower waterline
  float shoreStoneMask = (1.0 - smoothstep(0.2, 3.0, hWater)) * smoothstep(0.38, 0.74, medGrain);
  bankSurface = mix(bankSurface, cliffCol, shoreStoneMask * 0.56);

  // 4. Continuous Fallen Petal / Leaf Fleck Scatter (petalFlecks)
  if (petalFl > 0.01) {
    float fleck = smoothstep(0.74, 0.89, fineGrain * 0.66 + medGrain * 0.34) * smoothstep(0.08, 4.8, hWater);
    vec3 fleckCol = mix(vec3(0.98, 0.74, 0.85), max(uEmissiveColor, vec3(0.85, 0.65, 0.78)), 0.35);
    bankSurface = mix(bankSurface, fleckCol, fleck * petalFl * 0.62);
  }

  // 5. Continuous Snow Blanket & Glacial Ice Shelves (snowCoverage & iceReflectivity)
  if (snowCov > 0.01 || iceRefl > 0.01) {
    vec3 snowCol = mix(vGroundPrimary, vec3(0.92, 0.97, 1.0), 0.55) * (0.88 + 0.18 * fineGrain);
    vec3 iceCol = mix(vGroundSecondary, uRockTint, 0.52) * (0.76 + 0.44 * rockStrata);
    float snowMask = smoothstep(0.18, 0.72, flatMask * 0.76 + macroPatch * 0.40) * snowCov;
    float iceShelf = (1.0 - smoothstep(0.3, 5.2, hWater)) * smoothstep(0.25, 0.76, medGrain) * iceRefl;
    cliffCol = mix(cliffCol, iceCol, clamp(iceRefl * 0.72 + snowCov * 0.25, 0.0, 0.88));
    bankSurface = mix(bankSurface, snowCol, snowMask * 0.92);
    bankSurface = mix(bankSurface, iceCol * 1.06, iceShelf * 0.64);
  }

  // Combine cliff faces vs flatter banks, then blend riverbed -> dry terrain
  float aboveWaterMask = smoothstep(-0.10, 0.48, hWater);
  vec3 dryTerrain = mix(cliffCol, bankSurface, flatMask * (1.0 - wfProx * 0.66));
  vec3 baseCol = mix(pebbleCol, dryTerrain, aboveWaterMask);

  // Wet darkened shoreline band right above waterline & waterfall splash walls
  float wetBand = (1.0 - smoothstep(0.05, 1.05, hWater)) * smoothstep(-0.45, 0.02, hWater);
  float wetTotal = clamp(max(wetBand, wfProx * 0.85), 0.0, 1.0);
  baseCol = mix(baseCol, mix(baseCol * 0.58, uShoreColor, 0.34), wetTotal * 0.78);

  // Aquatic absorption on submerged riverbed
  float subDepth = max(0.0, -hWater);
  baseCol = mix(baseCol, mix(baseCol * vec3(0.46, 0.76, 0.82), uBedDeepColor, 0.36), clamp(0.22 + subDepth * 0.16, 0.0, 0.68));

  diffuseColor.rgb *= baseCol;
}
`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
{
  float hWater = vRdMeta.x;
  float wfProx = vRdMeta.y;
  float iceRefl = clamp(vGroundFx.x, 0.0, 1.0);
  float baseRough = clamp(vGroundFx.w, 0.12, 1.0);
  float wetZone = clamp(max(1.0 - smoothstep(0.05, 0.95, hWater), wfProx * 0.85), 0.0, 1.0);
  float dryRough = mix(baseRough, 0.14, iceRefl * 0.74);
  roughnessFactor = mix(dryRough, 0.16, wetZone);
}
`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float hWater = vRdMeta.x;
  float subDepth = max(0.0, -hWater);
  if (subDepth > 0.01) {
    float cVal = evaluateUnderwaterCaustics(vRdWorldPos, normalize(vRdWorldNormal), subDepth);
    totalEmissiveRadiance += uCausticsColor * cVal * 0.46;
  }

  float emissInt = vGroundFx.z;
  float mossCov = clamp(vGroundSurface.x, 0.0, 1.0);
  float snowCov = clamp(vGroundSurface.y, 0.0, 1.0);
  // Keep emissive fissures strictly on exposed rock/basalt (never glowing webs over moss or snow!)
  float rockCrackGate = (1.0 - mossCov * 0.85) * (1.0 - snowCov * 0.85);
  if (emissInt > 0.01 && rockCrackGate > 0.05) {
    float crackA = rdTerrNoise(vRdWorldPos.xz * 0.92 + vec2(0.0, vRdWorldPos.y * 0.75));
    float crackB = rdTerrNoise(vRdWorldPos.xz * 2.45 - vec2(vRdWorldPos.y * 1.35, 0.0));
    float fissure = 1.0 - abs(crackA * 2.0 - 1.0);
    float hotVein = pow(clamp(fissure * (0.68 + 0.32 * crackB), 0.0, 1.0), 5.6);
    float shoreBoost = 1.0 - smoothstep(-0.6, 5.2, hWater);
    float pulse = 0.84 + 0.16 * sin(uTerrainTime * 2.8 + vRdWorldPos.x * 0.4 + vRdWorldPos.z * 0.4);
    totalEmissiveRadiance += uEmissiveColor * hotVein * (0.42 + 1.05 * shoreBoost) * emissInt * rockCrackGate * pulse * 1.65;
  }
}
`,
      );
  };

  material.customProgramCacheKey = () => 'river-ducker-terrain-v4-datadriven';
  return { material, uniforms };
}

function createCaveMaterial(
  causticsUniforms: SharedCausticsUniforms,
): { material: THREE.MeshStandardMaterial; uniforms: CaveShaderUniforms } {
  const uniforms: CaveShaderUniforms = {
    uCaveWallColor: { value: new THREE.Color('#3d484d') },
    uCaveFloorColor: { value: new THREE.Color('#1e2c33') },
    uCaveGlowColor: { value: new THREE.Color('#36f5d5') },
    uCaveGlowIntensity: { value: 0.95 },
    uCaveSkylightColor: { value: new THREE.Color('#9cf7ff') },
    uCaveRoughness: { value: 0.72 },
    uCaveTime: { value: 0 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCaveWallColor = uniforms.uCaveWallColor;
    shader.uniforms.uCaveFloorColor = uniforms.uCaveFloorColor;
    shader.uniforms.uCaveGlowColor = uniforms.uCaveGlowColor;
    shader.uniforms.uCaveGlowIntensity = uniforms.uCaveGlowIntensity;
    shader.uniforms.uCaveSkylightColor = uniforms.uCaveSkylightColor;
    shader.uniforms.uCaveRoughness = uniforms.uCaveRoughness;
    shader.uniforms.uCaveTime = uniforms.uCaveTime;

    shader.uniforms.uCausticsTime = causticsUniforms.uCausticsTime;
    shader.uniforms.uCausticsSunDir = causticsUniforms.uCausticsSunDir;
    shader.uniforms.uCausticsIntensity = causticsUniforms.uCausticsIntensity;
    shader.uniforms.uCausticsColor = causticsUniforms.uCausticsColor;
    shader.uniforms.uCausticsEnabled = causticsUniforms.uCausticsEnabled;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aCaveMeta; // x: heightAboveWater, y: skylightMask, z: glowVeinMask
varying vec3 vCaveWorldPos;
varying vec3 vCaveWorldNormal;
varying vec3 vCaveMeta;
`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vec4 cWp = modelMatrix * vec4(transformed, 1.0);
vCaveWorldPos = cWp.xyz;
vCaveWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
vCaveMeta = aCaveMeta;
`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uCaveWallColor;
uniform vec3 uCaveFloorColor;
uniform vec3 uCaveGlowColor;
uniform float uCaveGlowIntensity;
uniform vec3 uCaveSkylightColor;
uniform float uCaveRoughness;
uniform float uCaveTime;
varying vec3 vCaveWorldPos;
varying vec3 vCaveWorldNormal;
varying vec3 vCaveMeta;
${CAUSTICS_GLSL}

float caveHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float caveNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(caveHash(i), caveHash(i + vec2(1.0, 0.0)), u.x),
    mix(caveHash(i + vec2(0.0, 1.0)), caveHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float n1 = caveNoise(vCaveWorldPos.xz * 0.45 + vCaveWorldPos.y * 0.70);
  float n2 = caveNoise(vCaveWorldPos.xz * 1.95 - vCaveWorldPos.y * 1.65);
  float strata = caveNoise(vec2((vCaveWorldPos.x + vCaveWorldPos.z) * 0.65, vCaveWorldPos.y * 2.6));
  float n = n1 * 0.52 + n2 * 0.28 + strata * 0.20;

  float floorToWall = smoothstep(-0.35, 1.6, vCaveMeta.x);
  vec3 baseWall = uCaveWallColor * (0.56 + 0.72 * n);
  vec3 baseFloor = uCaveFloorColor * (0.68 + 0.52 * n2);
  vec3 strataBand = mix(baseWall, uCaveWallColor * 1.24, smoothstep(0.35, 0.82, sin(vCaveWorldPos.y * 3.1 + strata * 2.6) * 0.5 + 0.5) * 0.34);

  diffuseColor.rgb = mix(baseFloor, strataBand, floorToWall);
  float wet = 1.0 - smoothstep(0.0, 1.5, vCaveMeta.x);
  diffuseColor.rgb *= mix(1.0, 0.68, wet);
}
`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
{
  float wet = 1.0 - smoothstep(0.0, 1.6, vCaveMeta.x);
  roughnessFactor = mix(clamp(uCaveRoughness, 0.14, 0.96), 0.15, wet);
}
`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float veinN = caveNoise(vCaveWorldPos.xz * 0.85 + vec2(0.0, vCaveWorldPos.y * 1.15));
  float fineN = caveNoise(vCaveWorldPos.xz * 2.8 + vCaveWorldPos.y * 2.2);
  float pulse = 0.80 + 0.20 * sin(uCaveTime * 2.4 + vCaveWorldPos.z * 0.28);

  float softVein = smoothstep(0.58, 0.86, veinN * 0.68 + fineN * 0.42);
  float sharpFissure = pow(clamp(1.0 - abs(veinN * 2.0 - 1.0), 0.0, 1.0), 3.6);
  float fissureMix = clamp((uCaveGlowIntensity - 0.95) * 1.1, 0.0, 1.0);
  float glowMask = mix(softVein, max(softVein, sharpFissure * 1.25), fissureMix) * vCaveMeta.z * pulse;

  totalEmissiveRadiance += uCaveGlowColor * (glowMask * uCaveGlowIntensity + 0.03 * uCaveGlowIntensity);
  totalEmissiveRadiance += uCaveSkylightColor * vCaveMeta.y * 1.15;

  float subDepth = max(0.0, -vCaveMeta.x);
  if (subDepth > 0.01) {
    float cVal = evaluateUnderwaterCaustics(vCaveWorldPos, normalize(vCaveWorldNormal), subDepth);
    totalEmissiveRadiance += uCaveGlowColor * cVal * 0.36;
  }
}
`,
      );
  };

  material.customProgramCacheKey = () => 'river-ducker-cave-v4-datadriven';
  return { material, uniforms };
}

// ---------------------------------------------------------------------------
// Procedural geometry builders for Riverbed Pebbles & Creek Reeds
// ---------------------------------------------------------------------------
function createRiverPebbleGeometry(): THREE.BufferGeometry {
  const geom = new THREE.IcosahedronGeometry(0.32, 1);
  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = 0.88 + 0.14 * Math.sin(x * 4.5 + z * 3.2);
    pos.setXYZ(i, x * n * 1.15, y * 0.48, z * n * 0.92);
  }
  geom.computeVertexNormals();
  return geom;
}

function createReedClusterGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let vBase = 0;

  const blades = 5;
  for (let b = 0; b < blades; b++) {
    const angle = (b / blades) * Math.PI * 2 + 0.3;
    const lean = 0.28 + (b % 3) * 0.12;
    const height = 1.35 + (b % 2) * 0.42;
    const halfW = 0.075;
    const ox = Math.cos(angle) * 0.16;
    const oz = Math.sin(angle) * 0.16;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const px = -dz;
    const pz = dx;

    for (let seg = 0; seg <= 3; seg++) {
      const t = seg / 3;
      const w = halfW * (1.0 - t * 0.92);
      const bend = t * t * lean;
      const cx = ox + dx * bend;
      const cy = t * height;
      const cz = oz + dz * bend;

      positions.push(cx - px * w, cy, cz - pz * w);
      positions.push(cx + px * w, cy, cz + pz * w);
      normals.push(dx * 0.4, 0.9, dz * 0.4);
      normals.push(dx * 0.4, 0.9, dz * 0.4);
    }

    for (let seg = 0; seg < 3; seg++) {
      const i0 = vBase + seg * 2;
      indices.push(i0, i0 + 1, i0 + 2);
      indices.push(i0 + 1, i0 + 3, i0 + 2);
    }
    vBase += 8;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setIndex(indices);
  return geom;
}

// ---------------------------------------------------------------------------
// Main Environment System
// ---------------------------------------------------------------------------
export interface EnvironmentUpdateState {
  time: number;
  dt?: number;
  river: RiverProvider;
  duckState: DuckState;
  cameraPos: THREE.Vector3;
  cameraSubmergedBlend?: number;
}

type RiverProviderWithEarthHelpers = RiverProvider & {
  getCaveCenterU?: (branch: CaveBranchInfo, s: number) => number;
  getCaveCeilingY?: (branch: CaveBranchInfo, s: number) => number;
  getLocalTangentFrame?: () => LocalTangentFrame;
  getFrameRevision?: () => number;
  getForkBranchPreview?: (playerS: number) => ForkBranchPreviewResult;
};

/**
 * 100% Data-Driven Shared Mini-Earth Environment Builder & Atmospheric Director:
 * - Zero-hardcode dynamic `Map<string, DynamicInstancedPool>` allocating/culling
 *   instanced pools on demand for ANY contributor pack asset (`count === 0` = 0 draw calls!)
 * - Renders real persistent geographic `EarthLandmark`s (`earthWorld.getNearbyLandmarks`)
 *   projected through `river.getLocalTangentFrame()`, plus procedural regional scenery & cave crystals
 * - 100% continuous `GroundShaderParams` terrain shader & `CaveVisualParams` cave tunnel shader
 *   (ZERO hardcoded `styleId == 0..5` branches!)
 * - Smooth terrain bank carving around both submerged caves and physical river Y-fork splits
 * - Dancing Aurora Borealis curtains (`hasAurora`) & Monsoon Sheet-Lightning (`hasLightning` / `lightningChance`)
 */
export class Environment {
  public readonly group: THREE.Group;
  public readonly sunLight: THREE.DirectionalLight;
  public readonly sunTarget: THREE.Object3D;
  public readonly hemiLight: THREE.HemisphereLight;
  public readonly caveGlowLight: THREE.PointLight;
  public readonly sunDirection = new THREE.Vector3(0.45, 0.78, 0.44).normalize();

  public readonly currentFogColor = new THREE.Color('#b7e6f5');
  public currentFogNear = 55;
  public currentFogFar = 215;
  public currentExposure = 1.08;

  public justFlashedLightning = false;
  public lastLightningIntensity = 0;

  private readonly scene: THREE.Scene;
  private readonly loader: AssetLoader;
  private readonly causticsUniforms: SharedCausticsUniforms;
  private readonly envMapTexture: THREE.DataTexture;
  private routeController: WorldRouteController = defaultWorldRoute;
  private quality: ResolvedQuality;
  private unsubscribeAssets: (() => void) | null = null;
  private onLightningCallback: ((intensity: number) => void) | null = null;

  // Sky dome & Aurora Borealis curtain dome
  private readonly skyMesh: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly auroraMesh: THREE.Mesh;
  private readonly auroraMat: THREE.ShaderMaterial;

  // Monsoon lightning flash state
  private prevUpdateTime = Number.NaN;
  private nextLightningTimer = 7.5;
  private lightningAge = 10.0;
  private lightningPeak = 0.0;

  // Continuous data-driven terrain ribbon buffers
  private readonly terrainGeom: THREE.BufferGeometry;
  private readonly terrainMat: THREE.MeshStandardMaterial;
  private readonly terrainUniforms: TerrainShaderUniforms;
  private readonly terrainMesh: THREE.Mesh;
  private readonly terrainPos: Float32Array;
  private readonly terrainMeta: Float32Array;
  private readonly terrainGroundPrimary: Float32Array;
  private readonly terrainGroundSecondary: Float32Array;
  private readonly terrainGroundSurface: Float32Array;
  private readonly terrainGroundFx: Float32Array;
  private readonly terrainPosAttr: THREE.BufferAttribute;
  private readonly terrainMetaAttr: THREE.BufferAttribute;
  private readonly terrainPrimaryAttr: THREE.BufferAttribute;
  private readonly terrainSecondaryAttr: THREE.BufferAttribute;
  private readonly terrainSurfaceAttr: THREE.BufferAttribute;
  private readonly terrainFxAttr: THREE.BufferAttribute;

  // Closed 360° data-driven cave tunnel + glowing beacons
  private readonly caveGeom: THREE.BufferGeometry;
  private readonly caveMat: THREE.MeshStandardMaterial;
  private readonly caveUniforms: CaveShaderUniforms;
  private readonly caveMesh: THREE.Mesh;
  private readonly cavePos: Float32Array;
  private readonly caveMeta: Float32Array;
  private readonly cavePosAttr: THREE.BufferAttribute;
  private readonly caveMetaAttr: THREE.BufferAttribute;
  private readonly caveBeaconMesh: THREE.InstancedMesh;
  private readonly caveBeaconMat: THREE.MeshBasicMaterial;

  // Zero-hardcode dynamic instanced pools allocated on demand for ANY AssetId!
  private readonly sceneryPools = new Map<string, DynamicInstancedPool>();
  private readonly pebbleMesh: THREE.InstancedMesh;
  private readonly pebbleMat: THREE.MeshStandardMaterial;
  private readonly reedMesh: THREE.InstancedMesh;
  private readonly reedMat: THREE.MeshStandardMaterial;

  private lastTerrainStartS = Number.NaN;
  private lastPropCellStart = Number.NaN;
  private lastActiveRegionKey = '';
  private lastForkCarveKey = '';
  private lastCaveId = '';
  private lastFrameRevision = -1;

  // Scratch objects (zero allocations in update)
  private readonly colorA = new THREE.Color();
  private readonly colorB = new THREE.Color();
  private readonly tmpFoliageTint = new THREE.Color();
  private readonly tmpTint = new THREE.Color();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpEuler = new THREE.Euler();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpMat = new THREE.Matrix4();
  private readonly rowSamples: RiverSample[] = [];
  private readonly rowSignedCurv = new Float32Array(TERRAIN_ROWS);
  private readonly rowLeftDistScale = new Float32Array(TERRAIN_ROWS).fill(1);
  private readonly rowRightDistScale = new Float32Array(TERRAIN_ROWS).fill(1);
  private readonly rowLeftHeightMult = new Float32Array(TERRAIN_ROWS).fill(1);
  private readonly rowRightHeightMult = new Float32Array(TERRAIN_ROWS).fill(1);
  private readonly rowForkFlatten = new Float32Array(TERRAIN_ROWS);
  private readonly placedGeoLandmarkEntries: Array<{ assetId: string; s: number }> = [];
  private readonly placedOverRiverS: number[] = [];
  private readonly activeWindowWaterways = new Set<string>();

  constructor(
    scene: THREE.Scene,
    loader: AssetLoader,
    causticsUniforms?: SharedCausticsUniforms,
    quality: ResolvedQuality = 'high',
    routeController: WorldRouteController = defaultWorldRoute,
  ) {
    this.scene = scene;
    this.loader = loader;
    this.causticsUniforms = causticsUniforms ?? createSharedCausticsUniforms();
    this.quality = quality;
    this.routeController = routeController;

    this.group = new THREE.Group();
    this.group.name = 'environment_group';

    // 0. Sunlit Nature PMREM IBL (`scene.environment`)
    this.envMapTexture = createProceduralNatureEnvironmentTexture();
    this.scene.environment = this.envMapTexture;
    this.scene.environmentIntensity = 1.05;

    // 1. Atmospheric Sky Dome
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uSkyTop: { value: new THREE.Color(0x2b7de9) },
        uSkyHorizon: { value: new THREE.Color(0xb9ebff) },
        uSkyGround: { value: new THREE.Color(0x244a2c) },
        uSunDir: { value: this.sunDirection.clone() },
        uSunColor: { value: new THREE.Color(0xfff5d6) },
        uTime: { value: 0 },
        uTwilight: { value: 0 },
        uVolcanicGlow: { value: 0 },
        uLightningFlash: { value: 0 },
        uUnderwater: { value: 0 },
        uUnderwaterBg: { value: new THREE.Color(0x0b4c5e) },
      },
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.skyMesh = new THREE.Mesh(
      new THREE.SphereGeometry(280, 28, 18),
      this.skyMat,
    );
    this.skyMesh.name = 'sky_dome';
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -10;
    this.group.add(this.skyMesh);

    // 1b. Dancing Aurora Borealis Upper-Sky Curtain Dome
    this.auroraMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uStrength: { value: 0 },
        uColorA: { value: new THREE.Color(0x2af598) },
        uColorB: { value: new THREE.Color(0x9b5de5) },
      },
      vertexShader: AURORA_VERTEX_SHADER,
      fragmentShader: AURORA_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    });
    this.auroraMesh = new THREE.Mesh(
      new THREE.SphereGeometry(262, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.48),
      this.auroraMat,
    );
    this.auroraMesh.name = 'aurora_borealis_curtain';
    this.auroraMesh.frustumCulled = false;
    this.auroraMesh.renderOrder = -9;
    this.auroraMesh.visible = false;
    this.group.add(this.auroraMesh);

    // 2. Dynamic Sun/Moon Lighting Rig
    this.sunTarget = new THREE.Object3D();
    this.sunTarget.name = 'sun_target';
    this.group.add(this.sunTarget);

    this.sunLight = new THREE.DirectionalLight(0xfff5d6, 2.45);
    this.sunLight.target = this.sunTarget;
    this.sunLight.shadow.camera.left = -30;
    this.sunLight.shadow.camera.right = 30;
    this.sunLight.shadow.camera.top = 30;
    this.sunLight.shadow.camera.bottom = -30;
    this.sunLight.shadow.camera.near = 6;
    this.sunLight.shadow.camera.far = 115;
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.03;
    this.group.add(this.sunLight);

    this.hemiLight = new THREE.HemisphereLight(0xa8e2ff, 0x2f5932, 1.55);
    this.group.add(this.hemiLight);

    this.caveGlowLight = new THREE.PointLight(0x4df5e3, 0, 38, 1.25);
    this.group.add(this.caveGlowLight);

    // 3. Sculpted Riverbed, Riverbanks & Canyon Walls Terrain (Data-Driven Vertex Attributes)
    const terrainVerts = TERRAIN_ROWS * TERRAIN_COLS;
    this.terrainPos = new Float32Array(terrainVerts * 3);
    this.terrainMeta = new Float32Array(terrainVerts * 4);
    this.terrainGroundPrimary = new Float32Array(terrainVerts * 3);
    this.terrainGroundSecondary = new Float32Array(terrainVerts * 3);
    this.terrainGroundSurface = new Float32Array(terrainVerts * 4);
    this.terrainGroundFx = new Float32Array(terrainVerts * 4);
    const terrainIdx = new Uint32Array(
      (TERRAIN_ROWS - 1) * (TERRAIN_COLS - 1) * 6,
    );
    let ptr = 0;
    for (let r = 0; r < TERRAIN_ROWS - 1; r++) {
      const r0 = r * TERRAIN_COLS;
      const r1 = (r + 1) * TERRAIN_COLS;
      for (let c = 0; c < TERRAIN_COLS - 1; c++) {
        const a = r0 + c;
        const b = r0 + c + 1;
        const d = r1 + c;
        const e = r1 + c + 1;
        terrainIdx[ptr++] = a;
        terrainIdx[ptr++] = b;
        terrainIdx[ptr++] = d;
        terrainIdx[ptr++] = b;
        terrainIdx[ptr++] = e;
        terrainIdx[ptr++] = d;
      }
    }

    this.terrainGeom = new THREE.BufferGeometry();
    this.terrainPosAttr = new THREE.BufferAttribute(this.terrainPos, 3);
    this.terrainMetaAttr = new THREE.BufferAttribute(this.terrainMeta, 4);
    this.terrainPrimaryAttr = new THREE.BufferAttribute(this.terrainGroundPrimary, 3);
    this.terrainSecondaryAttr = new THREE.BufferAttribute(this.terrainGroundSecondary, 3);
    this.terrainSurfaceAttr = new THREE.BufferAttribute(this.terrainGroundSurface, 4);
    this.terrainFxAttr = new THREE.BufferAttribute(this.terrainGroundFx, 4);

    const terrainNormals = new Float32Array(terrainVerts * 3);
    for (let i = 0; i < terrainVerts; i++) terrainNormals[i * 3 + 1] = 1;
    const terrainNormAttr = new THREE.BufferAttribute(terrainNormals, 3);

    this.terrainPosAttr.setUsage(THREE.DynamicDrawUsage);
    this.terrainMetaAttr.setUsage(THREE.DynamicDrawUsage);
    this.terrainPrimaryAttr.setUsage(THREE.DynamicDrawUsage);
    this.terrainSecondaryAttr.setUsage(THREE.DynamicDrawUsage);
    this.terrainSurfaceAttr.setUsage(THREE.DynamicDrawUsage);
    this.terrainFxAttr.setUsage(THREE.DynamicDrawUsage);
    terrainNormAttr.setUsage(THREE.DynamicDrawUsage);

    this.terrainGeom.setAttribute('position', this.terrainPosAttr);
    this.terrainGeom.setAttribute('normal', terrainNormAttr);
    this.terrainGeom.setAttribute('aTerrainMeta', this.terrainMetaAttr);
    this.terrainGeom.setAttribute('aGroundPrimary', this.terrainPrimaryAttr);
    this.terrainGeom.setAttribute('aGroundSecondary', this.terrainSecondaryAttr);
    this.terrainGeom.setAttribute('aGroundSurface', this.terrainSurfaceAttr);
    this.terrainGeom.setAttribute('aGroundFx', this.terrainFxAttr);
    this.terrainGeom.setIndex(new THREE.BufferAttribute(terrainIdx, 1));

    const terrainPack = createTerrainMaterial(this.causticsUniforms);
    this.terrainMat = terrainPack.material;
    this.terrainUniforms = terrainPack.uniforms;

    this.terrainMesh = new THREE.Mesh(this.terrainGeom, this.terrainMat);
    this.terrainMesh.name = 'riverbed_and_banks';
    this.terrainMesh.frustumCulled = false;
    this.terrainMesh.receiveShadow = true;
    this.group.add(this.terrainMesh);

    // 4. Closed 360° Data-Driven Cave Tunnel + Glowing Beacons
    const stride = CAVE_RING_SEGS + 1;
    const caveVerts = CAVE_ROWS * stride;
    this.cavePos = new Float32Array(caveVerts * 3);
    this.caveMeta = new Float32Array(caveVerts * 3);
    const caveIdx = new Uint32Array((CAVE_ROWS - 1) * CAVE_RING_SEGS * 6);
    let cPtr = 0;
    for (let r = 0; r < CAVE_ROWS - 1; r++) {
      const r0 = r * stride;
      const r1 = (r + 1) * stride;
      for (let a = 0; a < CAVE_RING_SEGS; a++) {
        const v0 = r0 + a;
        const v1 = r0 + a + 1;
        const v2 = r1 + a;
        const v3 = r1 + a + 1;
        caveIdx[cPtr++] = v0;
        caveIdx[cPtr++] = v2;
        caveIdx[cPtr++] = v1;
        caveIdx[cPtr++] = v1;
        caveIdx[cPtr++] = v2;
        caveIdx[cPtr++] = v3;
      }
    }

    this.caveGeom = new THREE.BufferGeometry();
    this.cavePosAttr = new THREE.BufferAttribute(this.cavePos, 3);
    this.caveMetaAttr = new THREE.BufferAttribute(this.caveMeta, 3);
    const caveNormals = new Float32Array(caveVerts * 3);
    for (let i = 0; i < caveVerts; i++) caveNormals[i * 3 + 1] = 1;
    const caveNormAttr = new THREE.BufferAttribute(caveNormals, 3);
    this.cavePosAttr.setUsage(THREE.DynamicDrawUsage);
    this.caveMetaAttr.setUsage(THREE.DynamicDrawUsage);
    caveNormAttr.setUsage(THREE.DynamicDrawUsage);
    this.caveGeom.setAttribute('position', this.cavePosAttr);
    this.caveGeom.setAttribute('normal', caveNormAttr);
    this.caveGeom.setAttribute('aCaveMeta', this.caveMetaAttr);
    this.caveGeom.setIndex(new THREE.BufferAttribute(caveIdx, 1));

    const cavePack = createCaveMaterial(this.causticsUniforms);
    this.caveMat = cavePack.material;
    this.caveUniforms = cavePack.uniforms;

    this.caveMesh = new THREE.Mesh(this.caveGeom, this.caveMat);
    this.caveMesh.name = 'limestone_cave_tunnel';
    this.caveMesh.frustumCulled = false;
    this.caveMesh.visible = false;
    this.group.add(this.caveMesh);

    this.caveBeaconMat = new THREE.MeshBasicMaterial({
      color: 0x66ffee,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.caveBeaconMesh = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.38, 0),
      this.caveBeaconMat,
      44,
    );
    this.caveBeaconMesh.name = 'cave_glow_moss_beacons';
    this.caveBeaconMesh.count = 0;
    this.caveBeaconMesh.frustumCulled = false;
    this.caveBeaconMesh.visible = false;
    this.group.add(this.caveBeaconMesh);

    // 5. Procedural Riverbed Cobbles & Shoreline Reeds
    this.pebbleMat = new THREE.MeshStandardMaterial({
      color: 0x72695b,
      roughness: 0.35,
      metalness: 0.03,
      flatShading: true,
    });
    this.pebbleMesh = new THREE.InstancedMesh(
      createRiverPebbleGeometry(),
      this.pebbleMat,
      115,
    );
    this.pebbleMesh.name = 'riverbed_pebbles';
    this.pebbleMesh.count = 0;
    this.pebbleMesh.frustumCulled = false;
    this.pebbleMesh.receiveShadow = true;
    this.group.add(this.pebbleMesh);

    this.reedMat = new THREE.MeshStandardMaterial({
      color: 0x458b40,
      roughness: 0.72,
      side: THREE.DoubleSide,
    });
    this.reedMesh = new THREE.InstancedMesh(
      createReedClusterGeometry(),
      this.reedMat,
      72,
    );
    this.reedMesh.name = 'creek_reeds';
    this.reedMesh.count = 0;
    this.reedMesh.frustumCulled = false;
    this.reedMesh.receiveShadow = true;
    this.group.add(this.reedMesh);

    this.applyQuality(quality);

    // Auto-upgrade any dynamic instanced pool when background per-track GLBs finish loading
    this.unsubscribeAssets = this.loader.onAssetsUpdated((updatedIds) => {
      this.refreshAssets(updatedIds);
    });

    scene.add(this.group);
  }

  public setWorldRoute(routeController: WorldRouteController): void {
    this.routeController = routeController;
    this.lastTerrainStartS = Number.NaN;
    this.lastPropCellStart = Number.NaN;
  }

  public setOnLightningFlash(callback: ((intensity: number) => void) | null): void {
    this.onLightningCallback = callback;
  }

  public triggerLightningFlash(intensity: number = 0.95): void {
    this.lightningPeak = THREE.MathUtils.clamp(intensity, 0.3, 1.2);
    this.lightningAge = 0;
    this.justFlashedLightning = true;
    this.lastLightningIntensity = this.lightningPeak;
    this.onLightningCallback?.(this.lightningPeak);
  }

  public consumeLightningFlash(): number {
    if (!this.justFlashedLightning) return 0;
    this.justFlashedLightning = false;
    return this.lastLightningIntensity;
  }

  /**
   * Diagnostic helper returning currently allocated dynamic scenery pool asset IDs & active counts.
   */
  public getDynamicPoolStats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, pool] of this.sceneryPools.entries()) {
      out[id] = pool.getActiveCount();
    }
    return out;
  }

  /**
   * Rebuild dynamic instanced scenery & landmark pools from `AssetLoader` when
   * lazy-loaded `.glb` models finish preloading.
   */
  public refreshAssets(updatedIds?: readonly AssetId[]): void {
    const shadowsEnabled = QUALITY_PRESETS[this.quality].shadowsEnabled;
    if (updatedIds && updatedIds.length > 0) {
      let touched = false;
      for (let i = 0; i < updatedIds.length; i++) {
        const pool = this.sceneryPools.get(updatedIds[i]);
        if (pool) {
          pool.buildFromLoader(this.loader, shadowsEnabled);
          touched = true;
        }
      }
      if (touched) {
        this.lastPropCellStart = Number.NaN;
      }
      return;
    }

    for (const pool of this.sceneryPools.values()) {
      pool.buildFromLoader(this.loader, shadowsEnabled);
    }
    this.lastPropCellStart = Number.NaN;
  }

  public setQuality(quality: ResolvedQuality): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.applyQuality(quality);
    this.lastPropCellStart = Number.NaN;
  }

  private applyQuality(quality: ResolvedQuality): void {
    const preset = QUALITY_PRESETS[quality];
    this.sunLight.castShadow = preset.shadowsEnabled;
    this.sunLight.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
    if (this.sunLight.shadow.map) {
      this.sunLight.shadow.map.dispose();
      this.sunLight.shadow.map = null;
    }
    for (const pool of this.sceneryPools.values()) {
      pool.setShadowsEnabled(preset.shadowsEnabled);
    }
  }

  /**
   * Zero-hardcode dynamic pool allocator: allocates & caches a `DynamicInstancedPool`
   * on first use for ANY `assetId: string` declared by any contributor pack!
   */
  private getOrCreatePool(assetId: AssetId): DynamicInstancedPool {
    let pool = this.sceneryPools.get(assetId);
    if (pool) return pool;

    const spec = getAssetSpec(assetId);
    const arch = spec.fallbackArchetype;
    let maxCount = 32;
    if (arch === 'arch' || (spec.sizeAxis === 'x' && spec.targetSize >= 10)) {
      maxCount = 12;
    } else if (arch === 'landmark' || arch === 'boat') {
      maxCount = 18;
    } else if (arch === 'tree') {
      maxCount = 40;
    } else if (arch === 'crystal') {
      maxCount = 30;
    } else if (arch === 'pillar' || arch === 'rock') {
      maxCount = 36;
    }

    pool = new DynamicInstancedPool(assetId, maxCount, false, true);
    pool.buildFromLoader(this.loader, QUALITY_PRESETS[this.quality].shadowsEnabled);
    this.sceneryPools.set(assetId, pool);
    this.group.add(pool.group);
    return pool;
  }

  public update(state: EnvironmentUpdateState): void {
    const { time, river, duckState, cameraPos } = state;
    const dt =
      state.dt !== undefined
        ? Math.min(Math.max(state.dt, 0), 0.1)
        : Number.isNaN(this.prevUpdateTime)
          ? 0.016
          : Math.min(Math.max(time - this.prevUpdateTime, 0), 0.1);
    this.prevUpdateTime = time;

    this.justFlashedLightning = false;

    const underwaterBlend = THREE.MathUtils.clamp(
      state.cameraSubmergedBlend ?? 0,
      0,
      1,
    );

    this.skyMesh.position.copy(cameraPos);
    this.auroraMesh.position.copy(cameraPos);
    this.skyMat.uniforms.uTime.value = time;
    this.skyMat.uniforms.uUnderwater.value = underwaterBlend;
    this.auroraMat.uniforms.uTime.value = time;
    this.terrainUniforms.uTerrainTime.value = time;
    this.caveUniforms.uCaveTime.value = time;

    const duckSample = river.sampleAt(duckState.s);
    const blendedRegion = resolveEarthRegionForSample(
      duckSample,
      this.routeController,
    );
    const regionKey = `${blendedRegion.primaryZone.id}:${blendedRegion.secondaryZone.id}:${Math.round(blendedRegion.blend * 20)}`;
    if (regionKey !== this.lastActiveRegionKey) {
      this.lastActiveRegionKey = regionKey;
      this.lastTerrainStartS = Number.NaN;
      this.lastPropCellStart = Number.NaN;
    }

    this.updateEarthAtmosphereAndLighting(
      blendedRegion,
      duckState,
      underwaterBlend,
      dt,
      time,
    );

    // Texel-snapped sun shadow target following duck ahead
    const targetX = duckState.worldPos.x + duckSample.tangent.x * 14;
    const targetY = duckState.worldPos.y + duckSample.tangent.y * 14;
    const targetZ = duckState.worldPos.z + duckSample.tangent.z * 14;
    const snapX = Math.round(targetX);
    const snapY = Math.round(targetY);
    const snapZ = Math.round(targetZ);
    this.sunTarget.position.set(snapX, snapY, snapZ);
    this.sunLight.position.set(
      snapX + this.sunDirection.x * 52,
      snapY + this.sunDirection.y * 52,
      snapZ + this.sunDirection.z * 52,
    );

    // Data-driven cave glow light illuminating wet grotto walls & rubber duck inside caves
    const caveInside = river.isInsideCave(duckState.s, duckState.u);
    if (caveInside || duckState.inCave) {
      this.caveGlowLight.position.set(
        duckState.worldPos.x,
        duckState.worldPos.y + 2.0,
        duckState.worldPos.z,
      );
      this.caveGlowLight.color.setHex(blendedRegion.caveStyle.glowColor);
      this.caveGlowLight.intensity =
        (1.8 + 0.32 * Math.sin(time * 3.1)) *
        Math.max(0.75, blendedRegion.caveStyle.glowIntensity);
    } else {
      this.caveGlowLight.intensity = 0;
    }

    const snappedTerrainS = Math.max(
      0,
      Math.floor((duckState.s - 34) / TERRAIN_STEP_S) * TERRAIN_STEP_S,
    );
    const terrainEndS = snappedTerrainS + (TERRAIN_ROWS - 1) * TERRAIN_STEP_S;
    const activeCaves = river.getCaveBranches(snappedTerrainS, terrainEndS);

    const earthRiver = river as RiverProviderWithEarthHelpers;

    // Detect Floating-Origin ENU recenter so terrain, caves, props & landmarks rebuild on the exact frame!
    const frameRev = earthRiver.getFrameRevision?.() ?? 0;
    if (frameRev !== this.lastFrameRevision) {
      this.lastFrameRevision = frameRev;
      this.lastTerrainStartS = Number.NaN;
      this.lastPropCellStart = Number.NaN;
      this.lastCaveId = '';
      this.lastForkCarveKey = '';
    }

    const forkPreview = earthRiver.getForkBranchPreview?.(duckState.s);
    const forkPoints = extractForkPoints(forkPreview);
    const forkContainer =
      forkPreview && !Array.isArray(forkPreview)
        ? (forkPreview as ForkPreviewContainer)
        : null;
    const forkKey =
      forkPoints && forkPoints.length >= 2
        ? `${forkContainer?.junctionId ?? ''}:${forkContainer?.branchSide ?? ''}:${forkContainer?.chosenSide ?? ''}:${forkPoints.length}:${Math.round(forkPoints[0].position.x)},${Math.round(forkPoints[0].position.z)}:${Math.round(forkPoints[forkPoints.length - 1].position.x)}`
        : '';
    const forkChanged = forkKey !== this.lastForkCarveKey;
    if (forkChanged) {
      this.lastForkCarveKey = forkKey;
      this.lastTerrainStartS = Number.NaN;
      this.lastPropCellStart = Number.NaN;
    }

    if (
      Number.isNaN(this.lastTerrainStartS) ||
      Math.abs(snappedTerrainS - this.lastTerrainStartS) >= TERRAIN_STEP_S * 0.5
    ) {
      this.rebuildTerrain(snappedTerrainS, river, activeCaves, forkPoints);
      this.lastTerrainStartS = snappedTerrainS;
      // Refresh props whenever terrain curvature/fork window shifts meaningfully
      if (forkChanged) {
        this.lastPropCellStart = Number.NaN;
      }
    }

    if (activeCaves.length > 0) {
      const cave = activeCaves[0];
      const caveMidSample = river.sampleAt((cave.startS + cave.endS) * 0.5);
      const caveRegion = resolveEarthRegionForSample(
        caveMidSample,
        this.routeController,
      );
      const cv = caveRegion.caveStyle;
      this.caveUniforms.uCaveWallColor.value.setHex(cv.wallColor);
      this.caveUniforms.uCaveFloorColor.value.setHex(cv.floorColor);
      this.caveUniforms.uCaveGlowColor.value.setHex(cv.glowColor);
      this.caveUniforms.uCaveGlowIntensity.value = cv.glowIntensity;
      this.caveUniforms.uCaveSkylightColor.value.setHex(cv.skylightColor);
      this.caveUniforms.uCaveRoughness.value = cv.roughness;
      this.caveBeaconMat.color.setHex(cv.glowColor);

      if (this.lastCaveId !== cave.id || !this.caveMesh.visible) {
        this.rebuildCaveTunnel(cave, river);
        this.lastCaveId = cave.id;
        this.caveMesh.visible = true;
        this.caveBeaconMesh.visible = true;
        this.lastPropCellStart = Number.NaN;
      }
    } else if (this.caveMesh.visible) {
      this.caveMesh.visible = false;
      this.caveBeaconMesh.visible = false;
      this.caveBeaconMesh.count = 0;
      this.lastCaveId = '';
    }

    // Stream grounded dynamic InstancedMesh scenery, shared geographic landmarks & cave crystals
    const propStep = 7.8;
    const propCellStart = Math.max(0, Math.floor((duckState.s - 10) / propStep));
    if (
      Number.isNaN(this.lastPropCellStart) ||
      Math.abs(propCellStart - this.lastPropCellStart) >= 1
    ) {
      this.rebuildInstancedProps(
        propCellStart,
        propStep,
        duckState.s,
        duckSample,
        river,
        activeCaves,
        forkPoints,
        forkContainer,
      );
      this.lastPropCellStart = propCellStart;
    }
  }

  public reset(): void {
    this.lastTerrainStartS = Number.NaN;
    this.lastPropCellStart = Number.NaN;
    this.lastActiveRegionKey = '';
    this.lastForkCarveKey = '';
    this.lastCaveId = '';
    this.lastFrameRevision = -1;
    this.caveMesh.visible = false;
    this.caveBeaconMesh.visible = false;
    this.justFlashedLightning = false;
    this.lightningAge = 10.0;
    this.nextLightningTimer = 6.5;
  }

  public dispose(): void {
    this.unsubscribeAssets?.();
    this.unsubscribeAssets = null;

    if (this.scene.environment === this.envMapTexture) {
      this.scene.environment = null;
    }
    this.envMapTexture.dispose();

    this.skyMesh.geometry.dispose();
    this.skyMat.dispose();
    this.auroraMesh.geometry.dispose();
    this.auroraMat.dispose();
    this.terrainGeom.dispose();
    this.terrainMat.dispose();
    this.caveGeom.dispose();
    this.caveMat.dispose();
    this.caveBeaconMesh.geometry.dispose();
    this.caveBeaconMat.dispose();
    this.caveBeaconMesh.dispose();
    for (const pool of this.sceneryPools.values()) {
      pool.dispose();
    }
    this.sceneryPools.clear();
    this.pebbleMesh.geometry.dispose();
    this.pebbleMat.dispose();
    this.pebbleMesh.dispose();
    this.reedMesh.geometry.dispose();
    this.reedMat.dispose();
    this.reedMesh.dispose();
    this.group.parent?.remove(this.group);
  }

  private evalCaveCenterU(
    cave: CaveBranchInfo,
    s: number,
    width: number,
    river: RiverProvider,
  ): number {
    const helper = river as RiverProviderWithEarthHelpers;
    if (helper.getCaveCenterU) {
      return helper.getCaveCenterU(cave, s);
    }
    const t = THREE.MathUtils.clamp(
      (s - cave.startS) / Math.max(1, cave.endS - cave.startS),
      0,
      1,
    );
    const startU = width * 0.36;
    return (
      cave.side * (startU + (cave.maxOffset - startU) * Math.sin(t * Math.PI))
    );
  }

  private updateEarthAtmosphereAndLighting(
    blended: BlendedEarthRegion,
    duckState: DuckState,
    underwaterBlend: number,
    dt: number,
    time: number,
  ): void {
    const { atmosphere, groundStyle, waterStyle, weather } = blended;

    // 1. Storm / Volcanic Sheet-Lightning Flash Timer
    let flashBoost = 0;
    const lightningEnabled =
      atmosphere.hasLightning || weather.lightningChance > 0.15;
    if (lightningEnabled) {
      const rateScale = Math.max(0.5, weather.lightningChance || 0.7);
      this.nextLightningTimer -= dt * rateScale;
      if (this.nextLightningTimer <= 0) {
        const seed = Math.sin(time * 13.7 + duckState.s * 0.31) * 0.5 + 0.5;
        this.nextLightningTimer = 6.8 + seed * 4.5;
        this.triggerLightningFlash(0.85 + seed * 0.2);
      }
    }
    if (this.lightningAge < 0.55) {
      this.lightningAge += dt;
      const a = this.lightningAge;
      const pulse1 = Math.exp(-Math.pow((a - 0.04) * 28.0, 2.0));
      const pulse2 = Math.exp(-Math.pow((a - 0.16) * 22.0, 2.0)) * 0.72;
      const tail = Math.exp(-a * 6.5) * 0.25;
      flashBoost = Math.min(1.0, (pulse1 + pulse2 + tail) * this.lightningPeak);
    }
    this.skyMat.uniforms.uLightningFlash.value = flashBoost;

    // 2. Sky Dome & Fog Uniforms
    this.skyMat.uniforms.uSkyTop.value.setHex(atmosphere.skyZenith);
    this.skyMat.uniforms.uSkyHorizon.value.setHex(atmosphere.skyHorizon);
    this.skyMat.uniforms.uSkyGround.value.setHex(atmosphere.skyGround);
    this.skyMat.uniforms.uSunColor.value.setHex(atmosphere.sunColor);
    this.skyMat.uniforms.uUnderwaterBg.value.setHex(
      waterStyle.underwaterFogColor,
    );

    const isNightOrDusk =
      atmosphere.timeOfDay === 'aurora_night'
        ? 1.0
        : atmosphere.timeOfDay === 'volcanic_dusk'
          ? 0.78
          : atmosphere.timeOfDay === 'sunset'
            ? 0.38
            : 0.0;
    this.skyMat.uniforms.uTwilight.value = isNightOrDusk;

    const volcA = blended.primaryZone.atmosphere.hasVolcanicGlow ? 1.0 : 0.0;
    const volcB = blended.secondaryZone.atmosphere.hasVolcanicGlow ? 1.0 : 0.0;
    this.skyMat.uniforms.uVolcanicGlow.value = THREE.MathUtils.lerp(
      volcA,
      volcB,
      blended.blend,
    );

    // 3. Dancing Aurora Borealis Curtains
    const aurA = blended.primaryZone.atmosphere.hasAurora ? 1.0 : 0.0;
    const aurB = blended.secondaryZone.atmosphere.hasAurora ? 1.0 : 0.0;
    const auroraStrength =
      THREE.MathUtils.lerp(aurA, aurB, blended.blend) *
      (1.0 - underwaterBlend * 0.85);
    this.auroraMat.uniforms.uStrength.value = auroraStrength;
    this.auroraMesh.visible = auroraStrength > 0.01;
    if (this.auroraMesh.visible) {
      const colA = atmosphere.auroraColors?.[0] ?? 0x2af598;
      const colB = atmosphere.auroraColors?.[1] ?? 0x9b5de5;
      this.auroraMat.uniforms.uColorA.value.setHex(colA);
      this.auroraMat.uniforms.uColorB.value.setHex(colB);
    }

    // 4. Fog, Directional Sun/Moon, Hemisphere Fill & IBL Intensity
    this.currentFogColor.setHex(atmosphere.fogColor);
    if (flashBoost > 0.02) {
      this.currentFogColor.lerp(this.colorA.setHex(0xd8f0ff), flashBoost * 0.35);
    }
    this.currentFogNear = atmosphere.fogNear;
    this.currentFogFar = atmosphere.fogFar;
    this.currentExposure = atmosphere.exposure;

    this.sunDirection
      .set(
        atmosphere.sunDirection[0],
        atmosphere.sunDirection[1],
        atmosphere.sunDirection[2],
      )
      .normalize();
    this.skyMat.uniforms.uSunDir.value.copy(this.sunDirection);

    this.sunLight.color.setHex(atmosphere.sunColor);
    const caveDim = duckState.inCave ? 0.55 : 1.0;
    this.sunLight.intensity =
      (atmosphere.sunIntensity + flashBoost * 2.2) *
      THREE.MathUtils.lerp(1.0, 0.78, underwaterBlend) *
      caveDim;

    this.hemiLight.color.setHex(atmosphere.hemiSky);
    this.hemiLight.groundColor.setHex(atmosphere.hemiGround);
    this.hemiLight.groundColor.lerp(
      this.colorA.setHex(atmosphere.iblBottom),
      0.28,
    );
    this.hemiLight.intensity =
      (atmosphere.hemiIntensity * 1.32 + flashBoost * 0.85) *
      THREE.MathUtils.lerp(1.0, 0.75, underwaterBlend);

    this.scene.environmentIntensity =
      THREE.MathUtils.lerp(1.08, 0.82, isNightOrDusk * 0.5) *
      THREE.MathUtils.lerp(1.0, 0.62, underwaterBlend) *
      (duckState.inCave ? 0.58 : 1.0);

    // 5. Data-Driven Terrain Material Uniforms
    this.terrainUniforms.uMossTint.value.setHex(groundStyle.mossTint);
    this.terrainUniforms.uRockTint.value.setHex(groundStyle.rockTint);
    this.terrainUniforms.uBedShallowColor.value.setHex(
      groundStyle.bedShallowColor,
    );
    this.terrainUniforms.uBedDeepColor.value.setHex(groundStyle.bedDeepColor);
    this.terrainUniforms.uShoreColor.value.setHex(groundStyle.shoreColor);
    this.terrainUniforms.uEmissiveColor.value.setHex(groundStyle.emissiveColor);
    this.terrainUniforms.uPebbleScale.value = groundStyle.pebbleScale;

    this.tmpFoliageTint.copy(this.terrainUniforms.uMossTint.value);
    this.pebbleMat.color.setHex(groundStyle.bedShallowColor);
    this.reedMat.color.copy(this.tmpFoliageTint).multiplyScalar(1.04);
  }

  private evaluateForkChannelCarve(
    wx: number,
    wz: number,
    forkPoints: readonly ForkPreviewPoint[] | null,
    extraMargin: number = 0,
  ): { carve: number; targetDepth: number } {
    if (!forkPoints || forkPoints.length < 2) {
      return { carve: 0, targetDepth: 0 };
    }
    let minDistSq = Infinity;
    let bestWidth = 13.5;
    let bestDepth = 4.2;

    // Exact point-to-segment distance across the diverging fork centerline so zero bumps remain!
    for (let i = 0; i < forkPoints.length - 1; i++) {
      const p0 = forkPoints[i];
      const p1 = forkPoints[i + 1];
      const ax = p0.position.x;
      const az = p0.position.z;
      const abx = p1.position.x - ax;
      const abz = p1.position.z - az;
      const abLenSq = abx * abx + abz * abz;
      let t = 0;
      if (abLenSq > 1e-6) {
        t = THREE.MathUtils.clamp(
          ((wx - ax) * abx + (wz - az) * abz) / abLenSq,
          0,
          1,
        );
      }
      const cx = ax + abx * t;
      const cz = az + abz * t;
      const dx = wx - cx;
      const dz = wz - cz;
      const dSq = dx * dx + dz * dz;
      if (dSq < minDistSq) {
        minDistSq = dSq;
        const w0 = p0.width ?? 13.5;
        const w1 = p1.width ?? 13.5;
        const d0 = p0.depth ?? 4.2;
        const d1 = p1.depth ?? 4.2;
        bestWidth = w0 + (w1 - w0) * t;
        bestDepth = d0 + (d1 - d0) * t;
      }
    }

    const fullChannelHalfW = bestWidth * 0.5 * 1.12 + extraMargin;
    const maxReach = fullChannelHalfW + 10.5;
    if (minDistSq >= maxReach * maxReach) {
      return { carve: 0, targetDepth: 0 };
    }
    const dist = Math.sqrt(minDistSq);
    const carve =
      1.0 - THREE.MathUtils.smoothstep(dist, fullChannelHalfW, maxReach);
    return { carve, targetDepth: bestDepth };
  }

  /**
   * Sample the exact curvature-safe compression & fork-valley flattening factors
   * computed for the terrain mesh at arc-length `s` and bank `side` (-1 left, +1 right).
   */
  private sampleTerrainBankModifiers(
    s: number,
    side: -1 | 1,
  ): { distScale: number; heightMult: number; forkFlatten: number } {
    if (Number.isNaN(this.lastTerrainStartS) || this.rowSamples.length < 2) {
      return { distScale: 1, heightMult: 1, forkFlatten: 0 };
    }
    const fRow = THREE.MathUtils.clamp(
      (s - this.lastTerrainStartS) / TERRAIN_STEP_S,
      0,
      TERRAIN_ROWS - 1,
    );
    const r0 = Math.floor(fRow);
    const r1 = Math.min(TERRAIN_ROWS - 1, r0 + 1);
    const t = fRow - r0;

    const distArr = side < 0 ? this.rowLeftDistScale : this.rowRightDistScale;
    const heightArr = side < 0 ? this.rowLeftHeightMult : this.rowRightHeightMult;

    return {
      distScale: distArr[r0] + (distArr[r1] - distArr[r0]) * t,
      heightMult: heightArr[r0] + (heightArr[r1] - heightArr[r0]) * t,
      forkFlatten:
        this.rowForkFlatten[r0] +
        (this.rowForkFlatten[r1] - this.rowForkFlatten[r0]) * t,
    };
  }

  /**
   * Evaluate exact terrain-matched bank offset, slope, and inner-edge-grounded Y
   * for any bank prop so wide rocks, basalt columns, ruins, cacti, and penguins NEVER
   * cantilever or float in midair!
   */
  private evaluateGroundedBankProp(
    s: number,
    side: -1 | 1,
    nominalDist: number,
    halfFootprint: number,
    prof: {
      bankHeightScale: number;
      bankSteepness: number;
      canyonWallFactor: number;
    },
  ): {
    effDist: number;
    yAnchor: number;
    localSlope: number;
    distScale: number;
  } {
    const mods = this.sampleTerrainBankModifiers(s, side);
    const effDist = Math.max(
      BANK_DIST_STATIONS[0],
      nominalDist * mods.distScale,
    );
    const effHeightScale =
      THREE.MathUtils.lerp(
        prof.bankHeightScale,
        Math.min(prof.bankHeightScale, 0.36),
        mods.forkFlatten,
      ) * mods.heightMult;
    const effCanyonWall =
      THREE.MathUtils.lerp(prof.canyonWallFactor, 0.06, mods.forkFlatten) *
      mods.heightMult;

    const bankN = fbm1D(s * 0.045 + (side < 0 ? 1.7 : 41.3));
    const hillN = fbm1D(s * 0.018 + (side < 0 ? 7.1 : 83.5));

    const dInner = Math.max(BANK_DIST_STATIONS[0], effDist - halfFootprint);
    const dOuter = Math.min(BANK_DIST_STATIONS[5], effDist + halfFootprint);

    const yCenter = computeBankHeightY(
      effDist,
      bankN,
      hillN,
      effHeightScale,
      prof.bankSteepness,
      effCanyonWall,
    );
    const yInner = computeBankHeightY(
      dInner,
      bankN,
      hillN,
      effHeightScale,
      prof.bankSteepness,
      effCanyonWall,
    );
    const yOuter = computeBankHeightY(
      dOuter,
      bankN,
      hillN,
      effHeightScale,
      prof.bankSteepness,
      effCanyonWall,
    );

    const localSlope = (yOuter - yInner) / Math.max(0.45, dOuter - dInner);
    // Anchor base solidly at the lower (river-facing) edge height minus natural grounding embed!
    const groundEmbed = 0.24 + Math.min(0.68, halfFootprint * 0.17);
    const yAnchor = Math.min(yCenter, yInner) - groundEmbed;

    return {
      effDist,
      yAnchor,
      localSlope,
      distScale: mods.distScale,
    };
  }

  private getPropHalfFootprint(assetId: AssetId, scale: number): number {
    const loaded = this.loader.get(assetId);
    const spec = getAssetSpec(assetId);
    const sx = loaded.size.x || spec.targetSize * 0.5 || 2.0;
    const sz = loaded.size.z || spec.targetSize * 0.5 || 2.0;
    return THREE.MathUtils.clamp(Math.max(sx, sz) * 0.46 * scale, 0.35, 4.4);
  }

  private hasNearbyOverRiverArch(s: number, minGap: number = 34): boolean {
    for (let i = 0; i < this.placedOverRiverS.length; i++) {
      if (Math.abs(this.placedOverRiverS[i] - s) < minGap) {
        return true;
      }
    }
    return false;
  }

  private rebuildTerrain(
    startS: number,
    river: RiverProvider,
    activeCaves: readonly CaveBranchInfo[],
    forkPoints: readonly ForkPreviewPoint[] | null,
  ): void {
    this.rowSamples.length = TERRAIN_ROWS;
    for (let r = 0; r < TERRAIN_ROWS; r++) {
      this.rowSamples[r] = river.sampleAt(startS + r * TERRAIN_STEP_S);
    }

    // 1. Pre-compute unclamped signed horizontal curvature (+ right, - left) for every row
    for (let r = 0; r < TERRAIN_ROWS; r++) {
      const rPrev = Math.max(0, r - 1);
      const rNext = Math.min(TERRAIN_ROWS - 1, r + 1);
      const sPrev = this.rowSamples[rPrev];
      const sCurr = this.rowSamples[r];
      const sNext = this.rowSamples[rNext];
      const dsSpan = Math.max(0.5, (rNext - rPrev) * TERRAIN_STEP_S);

      const lenP = Math.hypot(sPrev.tangent.x, sPrev.tangent.z) || 1;
      const lenN = Math.hypot(sNext.tangent.x, sNext.tangent.z) || 1;
      const dTx = sNext.tangent.x / lenN - sPrev.tangent.x / lenP;
      const dTz = sNext.tangent.z / lenN - sPrev.tangent.z / lenP;
      const discreteKappa = (dTx * sCurr.right.x + dTz * sCurr.right.z) / dsSpan;
      const sampleK = sCurr.curvature ?? 0;
      this.rowSignedCurv[r] =
        Math.abs(discreteKappa) >= Math.abs(sampleK) ? discreteKappa : sampleK;
    }

    // 2. Compute smooth curvature-safe inner-bank compression & Y-fork valley flattening
    const maxStation = BANK_DIST_STATIONS[5];
    const hasFork = forkPoints !== null && forkPoints.length >= 2;
    const forkOriginX = hasFork ? forkPoints[0].position.x : 0;
    const forkOriginZ = hasFork ? forkPoints[0].position.z : 0;

    for (let r = 0; r < TERRAIN_ROWS; r++) {
      let maxLeftK = 0;
      let maxRightK = 0;
      for (let off = -6; off <= 6; off++) {
        const j = Math.max(0, Math.min(TERRAIN_ROWS - 1, r + off));
        const absOff = Math.abs(off);
        const w = absOff <= 3 ? 1.0 : 1.0 - (absOff - 3) / 4.0;
        const k = this.rowSignedCurv[j];
        if (k < 0) maxLeftK = Math.max(maxLeftK, -k * w);
        if (k > 0) maxRightK = Math.max(maxRightK, k * w);
      }

      const sample = this.rowSamples[r];
      const halfW = sample.width * 0.5;

      // Guarantee inner bank stays strictly inside 0.68 / |kappa| so triangles NEVER fold over river/camera!
      const maxLeftU = maxLeftK > 0.0005 ? 0.68 / maxLeftK : 999;
      const safeLeftDist = Math.max(1.2, maxLeftU - halfW);
      const leftScale = THREE.MathUtils.clamp(safeLeftDist / maxStation, 0.04, 1.0);
      this.rowLeftDistScale[r] = leftScale;
      this.rowLeftHeightMult[r] = THREE.MathUtils.lerp(
        0.28,
        1.0,
        Math.sqrt(leftScale),
      );

      const maxRightU = maxRightK > 0.0005 ? 0.68 / maxRightK : 999;
      const safeRightDist = Math.max(1.2, maxRightU - halfW);
      const rightScale = THREE.MathUtils.clamp(safeRightDist / maxStation, 0.04, 1.0);
      this.rowRightDistScale[r] = rightScale;
      this.rowRightHeightMult[r] = THREE.MathUtils.lerp(
        0.28,
        1.0,
        Math.sqrt(rightScale),
      );

      // Broaden & flatten valley around Y-fork junctions so both diverging channels read cleanly!
      let forkFlatten = 0;
      if (sample.upcomingFork && sample.upcomingFork.distanceU < 46) {
        forkFlatten = Math.max(
          forkFlatten,
          1.0 - THREE.MathUtils.smoothstep(sample.upcomingFork.distanceU, 10, 46),
        );
      }
      if (hasFork) {
        const dJunc = Math.hypot(
          sample.position.x - forkOriginX,
          sample.position.z - forkOriginZ,
        );
        if (dJunc < 56) {
          forkFlatten = Math.max(
            forkFlatten,
            1.0 - THREE.MathUtils.smoothstep(dJunc, 18, 56),
          );
        }
      }
      this.rowForkFlatten[r] = forkFlatten;
    }

    let vIdx = 0;

    for (let r = 0; r < TERRAIN_ROWS; r++) {
      const sample = this.rowSamples[r];
      const s = sample.s;
      const halfW = sample.width * 0.5;
      const depth = sample.depth;
      const wfProx = sample.isWaterfall
        ? 1.0
        : THREE.MathUtils.clamp((-sample.slope - 0.16) * 2.5, 0, 1);

      const sliceRegion = resolveEarthRegionForSample(
        sample,
        this.routeController,
      );
      const prof = sliceRegion.riverProfile;
      const gs = sliceRegion.groundStyle;

      const forkFlatten = this.rowForkFlatten[r];
      const baseForkHeightScale = THREE.MathUtils.lerp(
        prof.bankHeightScale,
        Math.min(prof.bankHeightScale, 0.36),
        forkFlatten,
      );
      const baseForkCanyon = THREE.MathUtils.lerp(
        prof.canyonWallFactor,
        0.06,
        forkFlatten,
      );

      const leftDistScale = this.rowLeftDistScale[r];
      const leftHeightMult = this.rowLeftHeightMult[r];
      const rightDistScale = this.rowRightDistScale[r];
      const rightHeightMult = this.rowRightHeightMult[r];

      this.colorA.setHex(gs.primaryColor);
      this.colorB.setHex(gs.secondaryColor);
      const primR = this.colorA.r;
      const primG = this.colorA.g;
      const primB = this.colorA.b;
      const secR = this.colorB.r;
      const secG = this.colorB.g;
      const secB = this.colorB.b;

      const noiseL = fbm1D(s * 0.045 + 1.7);
      const noiseR = fbm1D(s * 0.045 + 41.3);
      const hillL = fbm1D(s * 0.018 + 7.1);
      const hillR = fbm1D(s * 0.018 + 83.5);

      for (let c = 0; c < TERRAIN_COLS; c++) {
        let u = 0;
        let yRel = 0;

        if (c <= 5) {
          const stationIdx = 5 - c;
          const effDist = Math.max(
            BANK_DIST_STATIONS[0],
            BANK_DIST_STATIONS[stationIdx] * leftDistScale,
          );
          u = -(halfW + effDist);
          yRel = computeBankHeightY(
            effDist,
            noiseL,
            hillL,
            baseForkHeightScale * leftHeightMult,
            prof.bankSteepness,
            baseForkCanyon * leftHeightMult,
          );
        } else if (c >= 19) {
          const stationIdx = c - 19;
          const effDist = Math.max(
            BANK_DIST_STATIONS[0],
            BANK_DIST_STATIONS[stationIdx] * rightDistScale,
          );
          u = halfW + effDist;
          yRel = computeBankHeightY(
            effDist,
            noiseR,
            hillR,
            baseForkHeightScale * rightHeightMult,
            prof.bankSteepness,
            baseForkCanyon * rightHeightMult,
          );
        } else {
          const bedT = (c - 6) / 12;
          const uNorm = bedT * 2.0 - 1.0;
          u = uNorm * (halfW * 0.94);

          const profile = Math.max(
            0.14,
            1.0 - Math.pow(Math.abs(uNorm), 2.1) * 0.86,
          );
          const bedRipple = (hash21(Math.floor(s * 0.4), c) - 0.5) * 0.28;
          const effDepth = THREE.MathUtils.lerp(
            depth * profile,
            1.85,
            wfProx * 0.72,
          );
          yRel = -effDepth + bedRipple * (1.0 - wfProx * 0.65);
        }

        // Carve bank cleanly across active submerged cave tunnels
        let caveCarveMask = 0;
        for (let ci = 0; ci < activeCaves.length; ci++) {
          const cave = activeCaves[ci];
          if (s < cave.startS - 12 || s > cave.endS + 12) continue;

          const sClamped = THREE.MathUtils.clamp(s, cave.startS, cave.endS);
          const sEdgeFade =
            s < cave.startS
              ? 1.0 - THREE.MathUtils.smoothstep(cave.startS - s, 0, 12)
              : s > cave.endS
                ? 1.0 - THREE.MathUtils.smoothstep(s - cave.endS, 0, 12)
                : 1.0;

          const caveCenterU = this.evalCaveCenterU(
            cave,
            sClamped,
            sample.width,
            river,
          );
          const distToCaveU = Math.abs(u - caveCenterU);
          const radialCarve =
            1.0 -
            THREE.MathUtils.smoothstep(
              distToCaveU,
              cave.width * 0.82,
              cave.width * 1.45,
            );
          const carve = radialCarve * sEdgeFade;
          if (carve > 0.001) {
            const targetFloorY = -(cave.depth + 2.35);
            yRel = THREE.MathUtils.lerp(
              yRel,
              Math.min(yRel, targetFloorY),
              carve,
            );
            caveCarveMask = Math.max(caveCarveMask, carve);
          }
        }

        const wx = sample.position.x + sample.right.x * u;
        const wz = sample.position.z + sample.right.z * u;

        // Carve bank smoothly wherever the diverging Y-fork alternate branch cuts through!
        if (forkPoints && (c <= 5 || c >= 19)) {
          const fCarve = this.evaluateForkChannelCarve(wx, wz, forkPoints);
          if (fCarve.carve > 0.001) {
            const forkBedY = -(fCarve.targetDepth * 0.85 + 0.5);
            yRel = THREE.MathUtils.lerp(yRel, Math.min(yRel, forkBedY), fCarve.carve);
          }
        }

        const wy = sample.position.y + yRel;

        const p3 = vIdx * 3;
        this.terrainPos[p3] = wx;
        this.terrainPos[p3 + 1] = wy;
        this.terrainPos[p3 + 2] = wz;

        this.terrainGroundPrimary[p3] = primR;
        this.terrainGroundPrimary[p3 + 1] = primG;
        this.terrainGroundPrimary[p3 + 2] = primB;

        this.terrainGroundSecondary[p3] = secR;
        this.terrainGroundSecondary[p3 + 1] = secG;
        this.terrainGroundSecondary[p3 + 2] = secB;

        const p4 = vIdx * 4;
        this.terrainMeta[p4] = yRel;
        this.terrainMeta[p4 + 1] = wfProx;
        this.terrainMeta[p4 + 2] = caveCarveMask;
        this.terrainMeta[p4 + 3] = hash21(r, c);

        this.terrainGroundSurface[p4] = gs.mossCoverage;
        this.terrainGroundSurface[p4 + 1] = gs.snowCoverage;
        this.terrainGroundSurface[p4 + 2] = gs.strataIntensity;
        this.terrainGroundSurface[p4 + 3] = gs.strataScale;

        this.terrainGroundFx[p4] = gs.iceReflectivity;
        this.terrainGroundFx[p4 + 1] = gs.petalFlecks;
        this.terrainGroundFx[p4 + 2] = gs.emissiveIntensity;
        this.terrainGroundFx[p4 + 3] = gs.roughness;

        vIdx++;
      }
    }

    this.terrainPosAttr.needsUpdate = true;
    this.terrainMetaAttr.needsUpdate = true;
    this.terrainPrimaryAttr.needsUpdate = true;
    this.terrainSecondaryAttr.needsUpdate = true;
    this.terrainSurfaceAttr.needsUpdate = true;
    this.terrainFxAttr.needsUpdate = true;
    this.terrainGeom.computeVertexNormals();
  }

  private rebuildCaveTunnel(cave: CaveBranchInfo, river: RiverProvider): void {
    const lenS = Math.max(cave.endS - cave.startS, 12);
    const invRows = 1 / (CAVE_ROWS - 1);
    const invRing = 1 / CAVE_RING_SEGS;
    const archHalfW = cave.width * 0.66;
    const archH = cave.ceilingHeight;

    const caveHelper = river as RiverProviderWithEarthHelpers;

    let vIdx = 0;
    let beaconIdx = 0;
    const maxBeacons = this.caveBeaconMesh.instanceMatrix.count;

    for (let r = 0; r < CAVE_ROWS; r++) {
      const t = r * invRows;
      const s = cave.startS + t * lenS;
      const sample = river.sampleAt(s);

      const centerU = this.evalCaveCenterU(cave, s, sample.width, river);

      const portalFlare =
        1.0 + 0.22 * (Math.exp(-t * 14.0) + Math.exp(-(1.0 - t) * 14.0));
      const localArchH = caveHelper.getCaveCeilingY
        ? Math.max(caveHelper.getCaveCeilingY(cave, s) * 1.15, archH * 0.88)
        : archH * portalFlare;

      const epsS = 0.5;
      const sNext = Math.min(cave.endS, s + epsS);
      const sPrev = Math.max(cave.startS, s - epsS);
      const uNext = this.evalCaveCenterU(cave, sNext, sample.width, river);
      const uPrev = this.evalCaveCenterU(cave, sPrev, sample.width, river);
      const dUds = (uNext - uPrev) / Math.max(sNext - sPrev, 0.001);

      let tx = sample.tangent.x + sample.right.x * dUds;
      let tz = sample.tangent.z + sample.right.z * dUds;
      const tLen = Math.hypot(tx, tz) || 1;
      tx /= tLen;
      tz /= tLen;
      const rx = -tz;
      const rz = tx;

      const cx = sample.position.x + sample.right.x * centerU;
      const cy = sample.position.y;
      const cz = sample.position.z + sample.right.z * centerU;

      const skyWave = Math.sin(t * Math.PI * 5.0);
      const hasSkylight = t > 0.14 && t < 0.86 && skyWave > 0.72;

      for (let a = 0; a <= CAVE_RING_SEGS; a++) {
        const ringT = a * invRing;
        const theta = ringT * Math.PI * 2.0;
        const cosT = Math.cos(theta);
        const sinTheta = Math.sin(theta);

        const rockJitter =
          0.93 +
          0.1 * Math.sin(r * 0.85 + a * 1.6) +
          0.06 * Math.cos(r * 1.7 - a * 2.3);

        const localX = cosT * archHalfW * portalFlare * rockJitter;
        const localY =
          sinTheta >= 0
            ? sinTheta * localArchH * portalFlare * rockJitter
            : sinTheta *
              (cave.depth + 0.45) *
              (0.94 + 0.08 * Math.sin(r * 0.9 + a));

        const p3 = vIdx * 3;
        this.cavePos[p3] = cx + rx * localX;
        this.cavePos[p3 + 1] = cy + localY;
        this.cavePos[p3 + 2] = cz + rz * localX;

        const isTopCrown = sinTheta > 0.78 ? 1.0 : 0.0;
        const skylightVal = hasSkylight && isTopCrown > 0.5 ? 1.0 : 0.0;
        const glowVein =
          (localY > -0.4 && localY < 2.4) || isTopCrown > 0.5 ? 1.0 : 0.35;

        this.caveMeta[p3] = localY;
        this.caveMeta[p3 + 1] = skylightVal;
        this.caveMeta[p3 + 2] = glowVein;
        vIdx++;
      }

      if (
        (r === 1 || r === CAVE_ROWS - 2 || r % 3 === 0) &&
        beaconIdx < maxBeacons - 2
      ) {
        const isPortal = r === 1 || r === CAVE_ROWS - 2;
        const angles = isPortal
          ? [0.18 * Math.PI, 0.5 * Math.PI, 0.82 * Math.PI]
          : [0.22 * Math.PI, 0.78 * Math.PI];
        for (let bi = 0; bi < angles.length && beaconIdx < maxBeacons; bi++) {
          const ang = angles[bi];
          const lx = Math.cos(ang) * (archHalfW * (isPortal ? 1.04 : 0.88));
          const ly = Math.sin(ang) * (localArchH * (isPortal ? 1.02 : 0.86));
          this.tmpPos.set(cx + rx * lx, cy + ly, cz + rz * lx);
          this.tmpEuler.set(r * 0.4, bi * 1.1, ang);
          this.tmpQuat.setFromEuler(this.tmpEuler);
          const sc = isPortal ? 1.45 : 0.92;
          this.tmpScale.set(sc, sc * 1.45, sc);
          this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
          this.caveBeaconMesh.setMatrixAt(beaconIdx++, this.tmpMat);
        }
      }
    }

    this.cavePosAttr.needsUpdate = true;
    this.caveMetaAttr.needsUpdate = true;
    this.caveGeom.computeVertexNormals();

    this.caveBeaconMesh.count = beaconIdx;
    this.caveBeaconMesh.instanceMatrix.needsUpdate = true;
  }

  private pushToDynamicPool(
    assetId: AssetId,
    matrix: THREE.Matrix4,
    tint?: THREE.Color,
  ): boolean {
    if (!assetId) return false;
    const pool = this.getOrCreatePool(assetId);
    return pool.pushInstance(matrix, tint);
  }

  private isCaveSideExcluded(
    s: number,
    side: -1 | 1,
    activeCaves: readonly CaveBranchInfo[],
  ): boolean {
    for (let ci = 0; ci < activeCaves.length; ci++) {
      const cave = activeCaves[ci];
      if (cave.side === side && s >= cave.startS - 12 && s <= cave.endS + 12) {
        return true;
      }
    }
    return false;
  }

  /**
   * Place 3D cave wall crystal clusters (`caveStyle.crystalAssetId`) along active
   * cave tunnel walls & entrance portals — 100% data-driven!
   */
  private placeCaveCrystals(
    activeCaves: readonly CaveBranchInfo[],
    river: RiverProvider,
  ): void {
    for (let ci = 0; ci < activeCaves.length; ci++) {
      const cave = activeCaves[ci];
      const midSample = river.sampleAt((cave.startS + cave.endS) * 0.5);
      const caveRegion = resolveEarthRegionForSample(
        midSample,
        this.routeController,
      );
      const crystalAssetId = caveRegion.caveStyle.crystalAssetId;
      if (!crystalAssetId) continue;

      const glowColor = this.colorA.setHex(caveRegion.caveStyle.glowColor);
      const lenS = Math.max(cave.endS - cave.startS, 12);
      const archHalfW = cave.width * 0.62;
      const archH = cave.ceilingHeight;
      const count = 8;

      for (let k = 0; k < count; k++) {
        const t = 0.04 + (k / (count - 1)) * 0.92;
        const s = cave.startS + t * lenS;
        const sample = river.sampleAt(s);
        const centerU = this.evalCaveCenterU(cave, s, sample.width, river);

        const cx = sample.position.x + sample.right.x * centerU;
        const cy = sample.position.y;
        const cz = sample.position.z + sample.right.z * centerU;

        const side: -1 | 1 = k % 2 === 0 ? -1 : 1;
        const wallOffset = side * archHalfW * 0.92;
        const heightOffset = 0.4 + (k % 3) * 0.65;

        this.tmpPos.set(
          cx + sample.right.x * wallOffset,
          cy + Math.min(heightOffset, archH * 0.55),
          cz + sample.right.z * wallOffset,
        );
        const yaw = Math.atan2(-side * sample.right.x, -side * sample.right.z);
        this.tmpEuler.set(0.18, yaw, side * 0.42);
        this.tmpQuat.setFromEuler(this.tmpEuler);
        const sc = 0.72 + hash11(k * 17.3 + ci * 5.1) * 0.45;
        this.tmpScale.setScalar(sc);
        this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);

        this.tmpTint.setRGB(1, 1, 1).lerp(glowColor, 0.35);
        this.pushToDynamicPool(crystalAssetId, this.tmpMat, this.tmpTint);
      }
    }
  }

  /**
   * Project & place real persistent Shared-Earth geographic landmarks from
   * `earthWorld.getNearbyLandmarks(duckLat, duckLng, 165)` via `river.getLocalTangentFrame()`.
   * Strictly filters by active visible waterway/region and true 2D horizontal distance (< 40u)
   * so distant landmarks are NEVER clamped onto `duckS ± 28` by `worldToRiver`!
   */
  private placeSharedGeographicLandmarks(
    duckS: number,
    duckSample: RiverSample,
    river: RiverProvider,
    activeCaves: readonly CaveBranchInfo[],
    forkPoints: readonly ForkPreviewPoint[] | null,
    forkContainer: ForkPreviewContainer | null,
  ): void {
    this.placedGeoLandmarkEntries.length = 0;
    this.placedOverRiverS.length = 0;
    this.activeWindowWaterways.clear();

    const earthRiver = river as RiverProviderWithEarthHelpers;
    const frame = earthRiver.getLocalTangentFrame?.();
    if (
      !frame ||
      duckSample.lat === undefined ||
      duckSample.lng === undefined
    ) {
      return;
    }

    // Collect the exact set of waterways actively traversed in the visible river window
    for (let sProbe = Math.max(0, duckS - 18); sProbe <= duckS + 150; sProbe += 16) {
      const pSample = river.sampleAt(sProbe);
      if (pSample.waterwayId) {
        this.activeWindowWaterways.add(pSample.waterwayId);
      }
    }
    if (duckSample.waterwayId) {
      this.activeWindowWaterways.add(duckSample.waterwayId);
    }
    if (forkContainer?.waterwayId) {
      this.activeWindowWaterways.add(forkContainer.waterwayId);
    }

    const nearby = earthWorld.getNearbyLandmarks(
      duckSample.lat,
      duckSample.lng,
      165,
    );
    if (nearby.length === 0) return;

    const minWindowS = Math.max(0, duckS - 18);
    const maxWindowS = duckS + 150;

    for (let i = 0; i < nearby.length; i++) {
      const lm: EarthLandmark = nearby[i];

      // Filter strictly by active visible waterway so off-route landmarks never bleed in!
      if (
        lm.waterwayId &&
        this.activeWindowWaterways.size > 0 &&
        !this.activeWindowWaterways.has(lm.waterwayId)
      ) {
        continue;
      }

      const refElev = duckSample.elevation ?? frame.originElev;
      const roughLocal = earthToLocal(lm.lat, lm.lng, refElev, frame);
      const rc = river.worldToRiver(roughLocal, duckS);

      if (rc.s < minWindowS || rc.s > maxWindowS) continue;

      const lmSample = river.sampleAt(rc.s);
      const sliceRegion = resolveEarthRegionForSample(
        lmSample,
        this.routeController,
      );

      // Verify landmark belongs to the active region at `rc.s` (critical in single_track mode)
      if (lm.waterwayId) {
        const lmWw = earthWorld.getWaterwayById(lm.waterwayId);
        if (
          lmWw &&
          lmWw.regionId !== sliceRegion.primaryZone.id &&
          !(sliceRegion.blend > 0.2 && lmWw.regionId === sliceRegion.secondaryZone.id)
        ) {
          continue;
        }
      }

      // Guard against `worldToRiver` endpoint clamping: reject any landmark > 40u horizontally from spline!
      const horizDist = Math.hypot(
        roughLocal.x - lmSample.position.x,
        roughLocal.z - lmSample.position.z,
      );
      if (horizDist > 40 || Math.abs(rc.u) > 40) continue;

      const prof = sliceRegion.riverProfile;
      const halfW = lmSample.width * 0.5;
      const elevOffset = lm.elevationOffset ?? 0;

      if (lm.placement === 'over_waterway') {
        if (horizDist > Math.max(24, lmSample.width * 1.6)) continue;
        if (lmSample.isWaterfall) continue;
        if (lmSample.upcomingFork && lmSample.upcomingFork.distanceU < 28) continue;
        if (this.hasNearbyOverRiverArch(rc.s, 36)) continue;

        this.placeOverRiverLandmarkTransform(
          lm.assetId,
          lmSample,
          lm.scale,
          elevOffset,
          lm.rotY,
        );
        this.tmpTint.setRGB(1, 1, 1);
        this.pushToDynamicPool(lm.assetId, this.tmpMat, this.tmpTint);
        this.placedGeoLandmarkEntries.push({ assetId: lm.assetId, s: rc.s });
        this.placedOverRiverS.push(rc.s);
      } else {
        const side: -1 | 1 = rc.u >= 0 ? 1 : -1;
        if (this.isCaveSideExcluded(rc.s, side, activeCaves)) continue;

        const minBankDist = lm.placement === 'cliff' ? 4.2 : 1.75;
        const absU = Math.abs(rc.u);
        const nominalDist =
          absU > halfW + minBankDist
            ? Math.min(absU - halfW, 20.0)
            : minBankDist;

        const halfFoot = this.getPropHalfFootprint(lm.assetId, lm.scale);
        const grounded = this.evaluateGroundedBankProp(
          rc.s,
          side,
          nominalDist,
          halfFoot,
          prof,
        );
        if (grounded.distScale < 0.35 && nominalDist > 3.2) continue;

        const latOffset = halfW + grounded.effDist;
        const wx = lmSample.position.x + lmSample.right.x * (side * latOffset);
        const wz = lmSample.position.z + lmSample.right.z * (side * latOffset);
        if (this.evaluateForkChannelCarve(wx, wz, forkPoints, 2.5).carve > 0.03) {
          continue;
        }
        const wy = lmSample.position.y + grounded.yAnchor + elevOffset;

        const faceYaw =
          lm.rotY ??
          Math.atan2(
            -side * lmSample.right.x + lmSample.tangent.x * 0.25,
            -side * lmSample.right.z + lmSample.tangent.z * 0.25,
          );
        this.tmpPos.set(wx, wy, wz);
        this.tmpEuler.set(0, faceYaw, 0);
        this.tmpQuat.setFromEuler(this.tmpEuler);
        this.tmpScale.setScalar(lm.scale);
        this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);

        this.tmpTint.setRGB(1, 1, 1);
        this.pushToDynamicPool(lm.assetId, this.tmpMat, this.tmpTint);
        this.placedGeoLandmarkEntries.push({ assetId: lm.assetId, s: rc.s });
      }
    }
  }

  /**
   * Compute data-driven over-river arch/bridge/gate transform using `AssetSpec` &
   * normalized prototype bounds (ZERO hardcoded asset ID checks!).
   */
  private placeOverRiverLandmarkTransform(
    assetId: AssetId,
    lmSample: RiverSample,
    scale: number,
    yOffset: number,
    rotYOverride?: number,
  ): void {
    const loaded = this.loader.get(assetId);
    const spec = getAssetSpec(assetId);
    const protoSpanX = Math.max(7.5, loaded.size.x || spec.targetSize || 12.2);
    const protoHeightY = Math.max(2.0, loaded.size.y || 6.0);

    const spanScaleX = Math.max(scale, (lmSample.width * 1.16) / protoSpanX);
    // Ensure lower-profile arches (height < 7u) get generous archway height clearance
    const scaleY =
      protoHeightY < 7.2 && yOffset < 1.4
        ? Math.max(scale * 1.28, (7.6 * scale) / protoHeightY)
        : scale;
    const scaleZ = scale;

    // If `yOffset` already specifies a high bridge deck (>1.4u), keep subtle lift;
    // otherwise lift center-pivoted arches so open passage stays well above duck jump height!
    const archCenterLift =
      spec.pivot !== 'center'
        ? 0.0
        : yOffset >= 1.4
          ? 0.35
          : THREE.MathUtils.clamp(3.35 - protoHeightY * 0.16, 1.35, 2.0);

    this.tmpPos.set(
      lmSample.position.x,
      lmSample.position.y + yOffset + archCenterLift,
      lmSample.position.z,
    );
    const yaw =
      rotYOverride ?? Math.atan2(lmSample.tangent.x, lmSample.tangent.z);
    this.tmpEuler.set(0, yaw, 0);
    this.tmpQuat.setFromEuler(this.tmpEuler);
    this.tmpScale.set(spanScaleX, scaleY, scaleZ);
    this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
  }

  private placeProceduralRegionLandmarks(
    windowStartS: number,
    windowEndS: number,
    river: RiverProvider,
    activeCaves: readonly CaveBranchInfo[],
    forkPoints: readonly ForkPreviewPoint[] | null,
  ): void {
    const midSample = river.sampleAt((windowStartS + windowEndS) * 0.5);
    const midRegion = resolveEarthRegionForSample(
      midSample,
      this.routeController,
    );
    const landmarks = midRegion.primaryZone.scenery.landmarks;
    if (!landmarks || landmarks.length === 0) return;

    const anchorBaseS = 0;

    for (let li = 0; li < landmarks.length; li++) {
      const lm: EarthLandmarkRule = landmarks[li];
      const spacing = Math.max(32, lm.spacing);
      const firstOffset =
        lm.placement === 'over_river'
          ? 30 + li * 16
          : lm.placement === 'bank_left'
            ? 20 + li * 7
            : lm.placement === 'bank_right'
              ? 26 + li * 7
              : 24 + li * 9;

      const minK = Math.max(
        0,
        Math.floor((windowStartS - anchorBaseS - firstOffset) / spacing),
      );
      const maxK = Math.ceil(
        (windowEndS - anchorBaseS - firstOffset) / spacing,
      );

      for (let k = minK; k <= maxK; k++) {
        let lmS = anchorBaseS + firstOffset + k * spacing;
        if (lmS < windowStartS || lmS > windowEndS) continue;

        // Deduplicate if a persistent shared EarthLandmark of the same assetId is nearby
        let duplicate = false;
        for (let gi = 0; gi < this.placedGeoLandmarkEntries.length; gi++) {
          const g = this.placedGeoLandmarkEntries[gi];
          if (g.assetId === lm.assetId && Math.abs(g.s - lmS) < 24) {
            duplicate = true;
            break;
          }
        }
        if (duplicate) continue;

        let lmSample = river.sampleAt(lmS);
        // Keep fork junction zone clear of over-river arches so diverging branches shine clearly
        if (
          lm.placement === 'over_river' &&
          lmSample.upcomingFork &&
          lmSample.upcomingFork.distanceU < 22
        ) {
          continue;
        }
        if (
          lm.placement === 'over_river' &&
          (lmSample.isWaterfall || -lmSample.slope > 0.2)
        ) {
          lmS += 14;
          if (lmS > windowEndS) continue;
          lmSample = river.sampleAt(lmS);
          if (lmSample.isWaterfall) continue;
        }

        const halfW = lmSample.width * 0.5;
        const sliceRegion = resolveEarthRegionForSample(
          lmSample,
          this.routeController,
        );
        if (sliceRegion.primaryZone.id !== midRegion.primaryZone.id) {
          continue;
        }
        const prof = sliceRegion.riverProfile;

        if (lm.placement === 'over_river') {
          if (this.hasNearbyOverRiverArch(lmS, 36)) continue;
          this.placeOverRiverLandmarkTransform(
            lm.assetId,
            lmSample,
            lm.scale,
            lm.yOffset,
          );
          this.tmpTint.setRGB(1, 1, 1);
          this.pushToDynamicPool(lm.assetId, this.tmpMat, this.tmpTint);
          this.placedOverRiverS.push(lmS);
        } else if (
          lm.placement === 'bank_left' ||
          lm.placement === 'bank_right'
        ) {
          const side: -1 | 1 = lm.placement === 'bank_left' ? -1 : 1;
          if (this.isCaveSideExcluded(lmS, side, activeCaves)) continue;

          const nominalDist = 1.55 + (k % 2) * 0.55;
          const halfFoot = this.getPropHalfFootprint(lm.assetId, lm.scale);
          const grounded = this.evaluateGroundedBankProp(
            lmS,
            side,
            nominalDist,
            halfFoot,
            prof,
          );
          if (grounded.localSlope > 0.85) continue;

          const lat = halfW + grounded.effDist;
          const wx = lmSample.position.x + lmSample.right.x * (side * lat);
          const wz = lmSample.position.z + lmSample.right.z * (side * lat);
          if (this.evaluateForkChannelCarve(wx, wz, forkPoints, 3.0).carve > 0.03) {
            continue;
          }

          this.tmpPos.set(
            wx,
            lmSample.position.y + grounded.yAnchor + lm.yOffset,
            wz,
          );
          const faceRiverYaw = Math.atan2(
            -side * lmSample.right.x + lmSample.tangent.x * 0.35,
            -side * lmSample.right.z + lmSample.tangent.z * 0.35,
          );
          this.tmpEuler.set(0, faceRiverYaw, 0);
          this.tmpQuat.setFromEuler(this.tmpEuler);
          this.tmpScale.setScalar(lm.scale);
          this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);

          this.tmpTint.setRGB(1, 1, 1);
          this.pushToDynamicPool(lm.assetId, this.tmpMat, this.tmpTint);
        } else if (lm.placement === 'cliff_overlook') {
          for (const side of [-1, 1] as const) {
            if ((k + (side > 0 ? 1 : 0)) % 2 !== 0 && k > 0) continue;
            if (this.isCaveSideExcluded(lmS, side, activeCaves)) continue;

            const nominalDist = 4.6 + ((k + (side > 0 ? 1 : 0)) % 2) * 2.2;
            const halfFoot = this.getPropHalfFootprint(lm.assetId, lm.scale);
            const grounded = this.evaluateGroundedBankProp(
              lmS,
              side,
              nominalDist,
              halfFoot,
              prof,
            );
            if (grounded.distScale < 0.38 || grounded.localSlope > 0.92) continue;

            const lat = halfW + grounded.effDist;
            const wx = lmSample.position.x + lmSample.right.x * (side * lat);
            const wz = lmSample.position.z + lmSample.right.z * (side * lat);
            if (this.evaluateForkChannelCarve(wx, wz, forkPoints, 3.0).carve > 0.03) {
              continue;
            }

            this.tmpPos.set(
              wx,
              lmSample.position.y + grounded.yAnchor + lm.yOffset - 0.55,
              wz,
            );
            this.tmpEuler.set(0, (k * 1.7 + side * 0.9) % (Math.PI * 2), 0);
            this.tmpQuat.setFromEuler(this.tmpEuler);
            this.tmpScale.setScalar(lm.scale);
            this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);

            this.tmpTint.setRGB(1, 1, 1);
            this.pushToDynamicPool(lm.assetId, this.tmpMat, this.tmpTint);
          }
        }
      }
    }
  }

  private rebuildInstancedProps(
    cellStart: number,
    cellStep: number,
    duckS: number,
    duckSample: RiverSample,
    river: RiverProvider,
    activeCaves: readonly CaveBranchInfo[],
    forkPoints: readonly ForkPreviewPoint[] | null,
    forkContainer: ForkPreviewContainer | null = null,
  ): void {
    const qualityDensity = QUALITY_PRESETS[this.quality].foliageDensity;
    // Focus props strictly on visible forward window [-10u .. +134u] to stay well below <= 380k tris!
    const totalCells = Math.ceil(144 / cellStep);
    const windowStartS = cellStart * cellStep;
    const windowEndS = (cellStart + totalCells) * cellStep;
    const totalInstanceBudget = this.quality === 'high' ? 88 : 48;
    let totalInstancesPushed = 0;

    for (const pool of this.sceneryPools.values()) {
      pool.beginFrame();
    }

    // 1. Place persistent shared geographic `EarthLandmark`s FIRST!
    this.placeSharedGeographicLandmarks(
      duckS,
      duckSample,
      river,
      activeCaves,
      forkPoints,
      forkContainer,
    );

    // 2. Place procedural regional `scenery.landmarks` (deduplicated against geo landmarks)
    this.placeProceduralRegionLandmarks(
      windowStartS,
      windowEndS,
      river,
      activeCaves,
      forkPoints,
    );

    // 3. Place data-driven cave crystal clusters (`caveStyle.crystalAssetId`)
    if (activeCaves.length > 0) {
      this.placeCaveCrystals(activeCaves, river);
    }

    for (const pool of this.sceneryPools.values()) {
      totalInstancesPushed += pool.getActiveCount();
    }

    let pebbleIdx = 0;
    let reedIdx = 0;
    const maxPebbles = Math.floor(96 * qualityDensity);
    const maxReeds = Math.floor(64 * qualityDensity);

    for (let offset = 0; offset < totalCells; offset++) {
      const cell = cellStart + offset;
      const baseS = cell * cellStep;
      const ahead = baseS - duckS;
      const sample = river.sampleAt(baseS);
      const halfW = sample.width * 0.5;

      const sliceRegion = resolveEarthRegionForSample(
        sample,
        this.routeController,
      );
      const prof = sliceRegion.riverProfile;
      const pickSecondary =
        sliceRegion.blend > 0.01 && hash11(cell * 43.17) < sliceRegion.blend;
      const activeZone = pickSecondary
        ? sliceRegion.secondaryZone
        : sliceRegion.primaryZone;
      const scenery = activeZone.scenery;
      const gs = sliceRegion.groundStyle;

      for (const side of [-1, 1] as const) {
        if (this.isCaveSideExcluded(baseS, side, activeCaves)) continue;

        const seedBase = cell * 19.37 + (side > 0 ? 71.1 : 13.7);
        const r0 = hash11(seedBase);
        const r1 = hash11(seedBase + 1.7);
        const r2 = hash11(seedBase + 3.1);
        const r3 = hash11(seedBase + 5.9);
        const r4 = hash11(seedBase + 9.4);

        const isNearWaterfall = sample.isWaterfall || -sample.slope > 0.22;

        // 4. Regional `bankTrees`
        if (totalInstancesPushed < totalInstanceBudget) {
          const treeDensity = qualityDensity * scenery.treeDensity;
          const treeRows = treeDensity > 0.78 && ahead < 106 ? 2 : 1;
          const innerClearance = Math.max(1.8, scenery.innerTreeClearance);

          for (let p = 0; p < treeRows; p++) {
            if (totalInstancesPushed >= totalInstanceBudget) break;
            const rp = hash11(seedBase + 17.3 + p * 7.1);
            if (p === 1 && rp > 0.30 * treeDensity) continue;
            if (p === 0 && rp > 0.85 * treeDensity) continue;

            const treeEntry = pickWeightedAsset(
              scenery.bankTrees,
              hash11(seedBase + 29.1 + p * 11.3),
            );
            if (!treeEntry) continue;

            const sJit = (r0 - 0.5) * cellStep * 0.72;
            const pS = baseS + sJit;
            const pSample = river.sampleAt(pS);
            const pHalfW = pSample.width * 0.5;
            const treeScale = THREE.MathUtils.lerp(
              treeEntry.scaleMin,
              treeEntry.scaleMax,
              rp,
            );
            const halfFoot = this.getPropHalfFootprint(
              treeEntry.assetId,
              treeScale,
            );

            const nominalDist =
              p === 0
                ? innerClearance + 2.8 + r1 * 5.8
                : innerClearance + 11.2 + rp * 9.5;
            const grounded = this.evaluateGroundedBankProp(
              pS,
              side,
              nominalDist,
              halfFoot,
              prof,
            );
            if (grounded.distScale < 0.36 || grounded.localSlope > 0.92) {
              continue;
            }

            const latOffset = pHalfW + grounded.effDist;
            const wx = pSample.position.x + pSample.right.x * (side * latOffset);
            const wz = pSample.position.z + pSample.right.z * (side * latOffset);
            if (this.evaluateForkChannelCarve(wx, wz, forkPoints, 3.2).carve > 0.02) {
              continue;
            }

            this.tmpPos.set(
              wx,
              pSample.position.y + grounded.yAnchor + treeEntry.yEmbed - 0.45,
              wz,
            );
            this.tmpEuler.set(
              (r2 - 0.5) * 0.06,
              r3 * Math.PI * 2,
              (r4 - 0.5) * 0.06,
            );
            this.tmpQuat.setFromEuler(this.tmpEuler);
            this.tmpScale.set(
              treeScale,
              treeScale * (0.94 + r2 * 0.16),
              treeScale,
            );
            this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);

            this.tmpTint.setRGB(
              0.96 + r1 * 0.1,
              0.97 + r2 * 0.08,
              0.95 + r3 * 0.1,
            );
            if (this.pushToDynamicPool(treeEntry.assetId, this.tmpMat, this.tmpTint)) {
              totalInstancesPushed++;
            }
          }
        }

        // 5. Regional `bankFoliage` (ferns, cattail reeds, stone lanterns, temple ruins, saguaros, penguins, crystals)
        const foliageDensity = qualityDensity * scenery.foliageDensity;
        if (
          totalInstancesPushed < totalInstanceBudget &&
          !isNearWaterfall &&
          ahead <= 90 &&
          r1 < 0.80 * foliageDensity
        ) {
          const folEntry = pickWeightedAsset(
            scenery.bankFoliage,
            hash11(seedBase + 47.9),
          );
          if (folEntry) {
            const fScale = THREE.MathUtils.lerp(
              folEntry.scaleMin,
              folEntry.scaleMax,
              r4,
            );
            const spec = getAssetSpec(folEntry.assetId);
            const arch = spec.fallbackArchetype;
            const isUprightProp =
              arch === 'landmark' ||
              arch === 'critter' ||
              arch === 'pillar' ||
              arch === 'tree' ||
              arch === 'crystal';
            const halfFoot = this.getPropHalfFootprint(folEntry.assetId, fScale);

            let nominalDist = arch === 'critter' ? 1.15 + r2 * 1.15 : 1.45 + r2 * 3.0;
            let grounded = this.evaluateGroundedBankProp(
              baseS,
              side,
              nominalDist,
              halfFoot,
              prof,
            );
            // Pull upright wildlife/landmarks onto flatter shoreline bench if bank slope is steep
            if (isUprightProp && grounded.localSlope > 0.65 && nominalDist > 1.8) {
              nominalDist = 1.25 + r2 * 0.75;
              grounded = this.evaluateGroundedBankProp(
                baseS,
                side,
                nominalDist,
                halfFoot,
                prof,
              );
            }

            if (grounded.distScale >= 0.30 && (!isUprightProp || grounded.localSlope <= 0.78)) {
              const folLat = halfW + grounded.effDist;
              const wx = sample.position.x + sample.right.x * (side * folLat);
              const wz = sample.position.z + sample.right.z * (side * folLat);

              if (this.evaluateForkChannelCarve(wx, wz, forkPoints, 3.0).carve <= 0.02) {
                this.tmpPos.set(
                  wx,
                  sample.position.y + grounded.yAnchor + folEntry.yEmbed,
                  wz,
                );
                if (isUprightProp) {
                  const faceYaw = Math.atan2(
                    -side * sample.right.x + (r3 - 0.5) * 0.4,
                    -side * sample.right.z + (r0 - 0.5) * 0.4,
                  );
                  this.tmpEuler.set(0, faceYaw, 0);
                } else {
                  this.tmpEuler.set(
                    (r0 - 0.5) * 0.12,
                    r3 * Math.PI * 2,
                    -side * (0.12 + r4 * 0.14),
                  );
                }
                this.tmpQuat.setFromEuler(this.tmpEuler);
                this.tmpScale.setScalar(fScale);
                this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);

                this.tmpTint.setRGB(
                  0.96 + r2 * 0.1,
                  0.98 + r0 * 0.08,
                  0.95 + r1 * 0.08,
                );
                if (this.pushToDynamicPool(folEntry.assetId, this.tmpMat, this.tmpTint)) {
                  totalInstancesPushed++;
                }
              }
            }
          }
        }

        // 6. Regional `bankRocks`
        const rockDensity = qualityDensity * scenery.rockDensity;
        const rockProb = isNearWaterfall ? 0.92 : 0.42 * rockDensity;
        if (
          totalInstancesPushed < totalInstanceBudget &&
          ahead <= 104 &&
          r2 < rockProb
        ) {
          const rockEntry = pickWeightedAsset(
            scenery.bankRocks,
            hash11(seedBase + 63.7),
          );
          if (rockEntry) {
            const bScale = THREE.MathUtils.lerp(
              rockEntry.scaleMin,
              rockEntry.scaleMax,
              r0,
            );
            const halfFoot = this.getPropHalfFootprint(rockEntry.assetId, bScale);
            const bDist = isNearWaterfall
              ? 1.55 + r4 * 2.5
              : 1.4 + r4 * 3.4;
            const grounded = this.evaluateGroundedBankProp(
              baseS,
              side,
              bDist,
              halfFoot,
              prof,
            );
            if (grounded.distScale >= 0.34 && grounded.localSlope <= 0.96) {
              const bLat = halfW + grounded.effDist;
              const wx = sample.position.x + sample.right.x * (side * bLat);
              const wz = sample.position.z + sample.right.z * (side * bLat);

              if (this.evaluateForkChannelCarve(wx, wz, forkPoints, 3.0).carve <= 0.02) {
                this.tmpPos.set(
                  wx,
                  sample.position.y + grounded.yAnchor + rockEntry.yEmbed - 0.18,
                  wz,
                );
                this.tmpEuler.set(
                  (r0 - 0.5) * 0.14,
                  r1 * Math.PI * 2,
                  (r4 - 0.5) * 0.14,
                );
                this.tmpQuat.setFromEuler(this.tmpEuler);
                this.tmpScale.set(
                  bScale,
                  bScale * (0.88 + r3 * 0.28),
                  bScale,
                );
                this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);

                this.tmpTint.setRGB(
                  0.96 + r1 * 0.1,
                  0.97 + r2 * 0.1,
                  0.96 + r3 * 0.1,
                );
                if (this.pushToDynamicPool(rockEntry.assetId, this.tmpMat, this.tmpTint)) {
                  totalInstancesPushed++;
                }
              }
            }
          }
        }

        // 7. Data-driven shoreline reeds (driven purely by mossCoverage & snowCoverage!)
        const hasReeds = gs.mossCoverage > 0.45 && gs.snowCoverage < 0.2;
        if (
          hasReeds &&
          !isNearWaterfall &&
          r4 < 0.46 * qualityDensity &&
          reedIdx < maxReeds
        ) {
          const reedLat = halfW - 0.1 + r0 * 0.85;
          const wx = sample.position.x + sample.right.x * (side * reedLat);
          const wz = sample.position.z + sample.right.z * (side * reedLat);
          if (this.evaluateForkChannelCarve(wx, wz, forkPoints, 2.5).carve <= 0.02) {
            this.tmpPos.set(wx, sample.position.y - 0.26, wz);
            this.tmpEuler.set(0, r2 * Math.PI * 2, -side * 0.1);
            this.tmpQuat.setFromEuler(this.tmpEuler);
            const rScale = 0.72 + r3 * 0.58;
            this.tmpScale.setScalar(rScale);
            this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
            this.reedMesh.setMatrixAt(reedIdx++, this.tmpMat);
          }
        }
      }

      // 8. Tactile 3D Riverbed Cobbles resting naturally on the creekbed
      if (!sample.isWaterfall && pebbleIdx < maxPebbles - 2) {
        const pebCount = qualityDensity > 0.75 ? 3 : 2;
        for (let k = 0; k < pebCount && pebbleIdx < maxPebbles; k++) {
          const hp1 = hash11(cell * 31.7 + k * 11.3);
          const hp2 = hash11(cell * 53.1 + k * 23.9);
          const hp3 = hash11(cell * 89.3 + k * 41.1);
          const uNorm = (hp1 * 2.0 - 1.0) * 0.8;
          const u = uNorm * halfW;
          const profile = Math.max(
            0.14,
            1.0 - Math.pow(Math.abs(uNorm), 2.1) * 0.86,
          );
          const bedY = sample.position.y - sample.depth * profile - 0.02;

          const sJit = (hp2 - 0.5) * cellStep;
          const pSample = river.sampleAt(baseS + sJit);
          this.tmpPos.set(
            pSample.position.x + pSample.right.x * u,
            bedY,
            pSample.position.z + pSample.right.z * u,
          );
          this.tmpEuler.set(hp3 * 0.25, hp1 * Math.PI * 2, hp2 * 0.25);
          this.tmpQuat.setFromEuler(this.tmpEuler);
          const sc = 0.62 + hp3 * 0.92;
          this.tmpScale.set(
            sc * (0.85 + hp1 * 0.35),
            sc * 0.7,
            sc * (0.85 + hp2 * 0.35),
          );
          this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
          this.pebbleMesh.setMatrixAt(pebbleIdx, this.tmpMat);

          const tone = 0.72 + hp2 * 0.32;
          this.tmpTint.setRGB(tone * 0.96, tone * 0.94, tone * 0.88);
          this.pebbleMesh.setColorAt(pebbleIdx, this.tmpTint);
          pebbleIdx++;
        }
      }
    }

    // Commit all dynamic scenery & landmark pools with zero-overhead culling for unused pools!
    for (const pool of this.sceneryPools.values()) {
      pool.commit();
    }

    this.pebbleMesh.count = pebbleIdx;
    this.pebbleMesh.visible = pebbleIdx > 0;
    if (pebbleIdx > 0) {
      this.pebbleMesh.instanceMatrix.needsUpdate = true;
      if (this.pebbleMesh.instanceColor) {
        this.pebbleMesh.instanceColor.needsUpdate = true;
      }
    }

    this.reedMesh.count = reedIdx;
    this.reedMesh.visible = reedIdx > 0;
    if (reedIdx > 0) {
      this.reedMesh.instanceMatrix.needsUpdate = true;
    }
  }
}
