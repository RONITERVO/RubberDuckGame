import * as THREE from 'three';

export const MAX_WATER_OBSTACLES = 24;

export interface WaterWaveParams {
  ampScale: number;
  freqS: number;
  freqU: number;
  speedScale: number;
}

export const DEFAULT_WATER_WAVE_PARAMS: WaterWaveParams = {
  ampScale: 1.0,
  freqS: 1.0,
  freqU: 1.0,
  speedScale: 1.0,
};

/**
 * Deterministic CPU-side water wave height function matching `RiverSpline`
 * (`WATER_WAVE_PARAMS`) and the GLSL water vertex shader in lockstep.
 */
export function evaluateWaterWaveHeight(
  s: number,
  u: number,
  time: number,
  rapidsIntensity: number = 0.15,
  halfWidth: number = 6.5,
  waterfallPhase: number = 0.0,
  params: WaterWaveParams = DEFAULT_WATER_WAVE_PARAMS,
): number {
  const safeHalf = Math.max(halfWidth, 1.0);
  const edgeNorm = Math.min(Math.abs(u) / safeHalf, 1.0);
  const bankDamp = 1.0 - 0.55 * edgeNorm * edgeNorm;
  const wfDamp =
    waterfallPhase > 0.001
      ? 0.35 + 0.65 * Math.abs(2.0 * waterfallPhase - 1.0)
      : 1.0;

  const amp =
    (0.08 + 0.16 * rapidsIntensity) * bankDamp * wfDamp * params.ampScale;

  const sF = s * params.freqS;
  const uF = u * params.freqU;
  const tF = time * params.speedScale;

  const p0 = 0.34 * sF + 0.16 * uF - 3.6 * tF;
  const p1 = 0.62 * sF - 0.48 * uF - 5.1 * tF;
  const p2 = 1.15 * sF + 0.82 * uF - 7.8 * tF;

  return amp * (0.52 * Math.sin(p0) + 0.3 * Math.sin(p1) + 0.18 * Math.sin(p2));
}

export interface WaterShaderUniforms {
  [uniform: string]: THREE.IUniform<unknown>;
  uTime: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSkyTop: THREE.IUniform<THREE.Color>;
  uSkyHorizon: THREE.IUniform<THREE.Color>;
  uCanopyColor: THREE.IUniform<THREE.Color>;
  uShallowColor: THREE.IUniform<THREE.Color>;
  uDeepColor: THREE.IUniform<THREE.Color>;
  uBedColor: THREE.IUniform<THREE.Color>;
  uFoamColor: THREE.IUniform<THREE.Color>;
  uCausticColor: THREE.IUniform<THREE.Color>;
  uCausticIntensity: THREE.IUniform<number>;
  uClarity: THREE.IUniform<number>;
  uReflectivity: THREE.IUniform<number>;
  uRainRippleIntensity: THREE.IUniform<number>;
  uGeothermalGlow: THREE.IUniform<number>;
  uAuroraStrength: THREE.IUniform<number>;
  uAuroraColorA: THREE.IUniform<THREE.Color>;
  uAuroraColorB: THREE.IUniform<THREE.Color>;
  uFogColor: THREE.IUniform<THREE.Color>;
  uFogNear: THREE.IUniform<number>;
  uFogFar: THREE.IUniform<number>;
  uCaveGlowColor: THREE.IUniform<THREE.Color>;
  uUnderwater: THREE.IUniform<number>;
  uDuckPos: THREE.IUniform<THREE.Vector3>;
  uDuckVel: THREE.IUniform<THREE.Vector3>;
  uDuckWakeStrength: THREE.IUniform<number>;
  uObstacleCount: THREE.IUniform<number>;
  uObstacles: THREE.IUniform<THREE.Vector4[]>;
  uObstacleFlow: THREE.IUniform<THREE.Vector4[]>;
  uQuality: THREE.IUniform<number>;
  uWaveParams: THREE.IUniform<THREE.Vector4>;
  uRainbowStrength: THREE.IUniform<number>;
}

const WATER_VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute vec4 aRiverData;     // x: s, y: uNorm [-1..1], z: depth, w: flowSpeed
attribute vec4 aRiverMeta;     // x: rapidsIntensity [0..1], y: waterfallFactor [0..1], z: halfWidth, w: caveMask [0..1]
attribute vec2 aWaterfallMeta; // x: waterfallPhase [0..1], y: plungePoolIntensity [0..1]
attribute vec3 aFlowDir;       // unit downstream tangent

uniform float uTime;
uniform vec4 uWaveParams;      // x: ampScale, y: freqS, z: freqU, w: speedScale

varying vec3 vWorldPos;
varying vec3 vMacroNormal;
varying vec3 vFlowDir;
varying vec4 vRiverData;
varying vec4 vRiverMeta;
varying vec2 vWaterfallMeta;
varying float vWaveCrest;

// Exact lockstep match with RiverSpline WATER_WAVE_PARAMS
float evalWave(
  float s,
  float u,
  float uNorm,
  float time,
  float rapids,
  float halfWidth,
  float wfPhase,
  float wfFactor
) {
  float edgeNorm = clamp(abs(u) / max(1.0, halfWidth), 0.0, 1.0);
  float seal = 1.0 - smoothstep(0.92, 1.04, abs(uNorm));
  float bankDamp = (1.0 - 0.55 * edgeNorm * edgeNorm) * seal;
  float wfDamp = wfPhase > 0.001 ? (0.35 + 0.65 * abs(2.0 * wfPhase - 1.0)) : 1.0;

  float amp = (0.08 + 0.16 * rapids) * bankDamp * wfDamp * uWaveParams.x;

  float sF = s * uWaveParams.y;
  float uF = u * uWaveParams.z;
  float tF = time * uWaveParams.w;

  float p0 = 0.34 * sF + 0.16 * uF - 3.6 * tF;
  float p1 = 0.62 * sF - 0.48 * uF - 5.1 * tF;
  float p2 = 1.15 * sF + 0.82 * uF - 7.8 * tF;

  float waveY = amp * (0.52 * sin(p0) + 0.30 * sin(p1) + 0.18 * sin(p2));
  float curtain = sin(s * 2.6 - time * 14.5 + u * 1.9) * 0.04 * wfFactor * seal;
  return waveY + curtain;
}

void main() {
  float s = aRiverData.x;
  float uNorm = aRiverData.y;
  float rapids = clamp(aRiverMeta.x, 0.0, 1.0);
  float wf = clamp(aRiverMeta.y, 0.0, 1.0);
  float halfWidth = max(aRiverMeta.z, 1.0);
  float wfPhase = clamp(aWaterfallMeta.x, 0.0, 1.0);
  float u = uNorm * halfWidth;

  float h0 = evalWave(s, u, uNorm, uTime, rapids, halfWidth, wfPhase, wf);
  float eps = 0.22;
  float hs = evalWave(s + eps, u, uNorm, uTime, rapids, halfWidth, wfPhase, wf);
  float hu = evalWave(s, u + eps, uNorm, uTime, rapids, halfWidth, wfPhase, wf);
  float dHds = (hs - h0) / eps;
  float dHdu = (hu - h0) / eps;

  vec3 flowT = normalize(aFlowDir);
  vec3 baseN = normalize(normal);
  vec3 flowR = normalize(cross(flowT, baseN));

  vec3 dispAxis = normalize(mix(vec3(0.0, 1.0, 0.0), baseN, wf));
  vec3 displaced = position + dispAxis * h0;

  vec3 tiltedN = normalize(baseN - flowT * (dHds * 0.78) - flowR * (dHdu * 0.78));

  vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
  vWorldPos = worldPosition.xyz;
  vMacroNormal = normalize(mat3(modelMatrix) * tiltedN);
  vFlowDir = normalize(mat3(modelMatrix) * flowT);
  vRiverData = aRiverData;
  vRiverMeta = aRiverMeta;
  vWaterfallMeta = aWaterfallMeta;
  vWaveCrest = clamp((h0 / max((0.08 + 0.16 * rapids) * uWaveParams.x, 0.06)) * 0.5 + 0.5, 0.0, 1.0);

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const WATER_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

#define MAX_OBSTACLES ${MAX_WATER_OBSTACLES}

uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uCanopyColor;
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uBedColor;
uniform vec3 uFoamColor;
uniform vec3 uCausticColor;
uniform float uCausticIntensity;
uniform float uClarity;
uniform float uReflectivity;
uniform float uRainRippleIntensity;
uniform float uGeothermalGlow;
uniform float uAuroraStrength;
uniform vec3 uAuroraColorA;
uniform vec3 uAuroraColorB;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uCaveGlowColor;
uniform float uUnderwater;
uniform vec3 uDuckPos;
uniform vec3 uDuckVel;
uniform float uDuckWakeStrength;
uniform int uObstacleCount;
uniform vec4 uObstacles[MAX_OBSTACLES];    // x: worldX, y: worldZ, z: radius, w: foamStrength
uniform vec4 uObstacleFlow[MAX_OBSTACLES]; // x: flowDirX, y: flowDirZ, z: waterY, w: eddyFlag
uniform float uQuality;
uniform float uRainbowStrength;

varying vec3 vWorldPos;
varying vec3 vMacroNormal;
varying vec3 vFlowDir;
varying vec4 vRiverData;
varying vec4 vRiverMeta;
varying vec2 vWaterfallMeta;
varying float vWaveCrest;

// Mobile-safe arithmetic hashes
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Crisp 3-octave lacy foam FBM (eliminates blurry milky foam blobs!)
float lacyFoamFbm(vec2 p) {
  float v = valueNoise(p) * 0.50;
  v += valueNoise(p * 2.35 + vec2(17.3, 9.2)) * 0.32;
  if (uQuality > 0.5) {
    v += valueNoise(p * 5.20 + vec2(4.1, 27.6)) * 0.18;
  } else {
    v += valueNoise(p * 3.80 + vec2(4.1, 27.6)) * 0.18;
  }
  return v;
}

// High-definition layered capillary ripples for glossy nature reflections & sun glints
vec2 rippleGrad(vec2 uv, float t, float flowSpeed, float rapids, float wf) {
  vec2 uv1 = uv * vec2(0.88, 1.25) - vec2(t * (1.45 + flowSpeed * 0.38), t * 0.18);
  vec2 uv2 = uv * vec2(1.92, 2.45) - vec2(t * (2.25 + flowSpeed * 0.54), -t * 0.30);

  float e = 0.06;
  float n1 = valueNoise(uv1);
  float n1x = valueNoise(uv1 + vec2(e, 0.0)) - n1;
  float n1y = valueNoise(uv1 + vec2(0.0, e)) - n1;

  float n2 = valueNoise(uv2);
  float n2x = valueNoise(uv2 + vec2(e, 0.0)) - n2;
  float n2y = valueNoise(uv2 + vec2(0.0, e)) - n2;

  vec2 g = vec2(n1x, n1y) * (2.15 + rapids * 1.15) + vec2(n2x, n2y) * (1.55 + rapids * 1.0);

  if (uQuality > 0.5) {
    // Crisp high-frequency sunlit capillary micro-ripples
    vec2 uv3 = uv * vec2(4.40, 5.10) - vec2(t * (3.4 + flowSpeed * 0.72), t * 0.55);
    float n3 = valueNoise(uv3);
    float n3x = valueNoise(uv3 + vec2(e, 0.0)) - n3;
    float n3y = valueNoise(uv3 + vec2(0.0, e)) - n3;
    g += vec2(n3x, n3y) * (1.15 + rapids * 0.65);
  }

  // Fine vertical turbulent cascade striations on steep waterfalls
  if (wf > 0.02) {
    vec2 wUv = vec2(uv.x * 1.05 - t * 11.5, uv.y * 5.2);
    float wn = valueNoise(wUv);
    float wnx = valueNoise(wUv + vec2(e, 0.0)) - wn;
    float wny = valueNoise(wUv + vec2(0.0, e)) - wn;
    g = mix(g, vec2(wnx * 1.1, wny * 3.4), clamp(wf * 1.15, 0.0, 1.0));
  }

  return g;
}

// Expanding concentric monsoon raindrop impact rings & micro-splash crowns
vec3 evalRainRippleLayer(vec2 p, float t) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  vec2 center = 0.20 + 0.60 * hash22(ip);
  float seed = hash12(ip);
  float age = fract(t * (1.55 + seed * 0.55) + seed);
  vec2 delta = fp - center;
  float r = length(delta);
  float ringRadius = age * 0.44;
  float ringDist = r - ringRadius;

  float env = exp(-abs(ringDist) * 19.0) * (1.0 - age) * smoothstep(0.0, 0.07, age);
  float phase = ringDist * 54.0;
  float slope = cos(phase) * env * 1.35;
  vec2 grad = (delta / max(r, 0.008)) * slope;

  float ringCrest = max(0.0, sin(phase)) * env;
  float centerPop = smoothstep(0.075, 0.0, r) * smoothstep(0.14, 0.0, age);
  return vec3(grad, ringCrest * 0.72 + centerPop * 0.95);
}

vec3 evaluateRainRipples(vec2 flowUV, float t, float intensity) {
  if (intensity <= 0.01) return vec3(0.0);
  vec3 r1 = evalRainRippleLayer(flowUV * 1.38, t);
  vec3 r2 = evalRainRippleLayer(flowUV * 2.15 + vec2(4.7, 8.3), t + 0.37);
  return (r1 + r2 * 0.85) * intensity;
}

float shallowCaustic(vec2 p, float t) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float md = 1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash22(ip + g);
      o = 0.5 + 0.42 * sin(t * 2.1 + 6.2831 * o);
      vec2 d = g + o - fp;
      md = min(md, dot(d, d));
    }
  }
  return pow(clamp(md, 0.0, 1.0), 1.85);
}

void main() {
  float s = vRiverData.x;
  float uNorm = vRiverData.y;
  float depth = max(vRiverData.z, 0.05);
  float flowSpeed = vRiverData.w;

  float rapids = clamp(vRiverMeta.x, 0.0, 1.0);
  float wf = clamp(vRiverMeta.y, 0.0, 1.0);
  float halfWidth = max(vRiverMeta.z, 1.0);
  float caveMask = clamp(vRiverMeta.w, 0.0, 1.0);
  float plungePool = clamp(vWaterfallMeta.y, 0.0, 1.0);
  float u = uNorm * halfWidth;

  vec3 flowT = normalize(vFlowDir);
  vec3 macroN = normalize(vMacroNormal);
  vec3 flowR = normalize(cross(flowT, macroN));
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 sunDir = normalize(uSunDir);

  vec2 flowUV = vec2(s, u);
  vec2 rGrad = rippleGrad(flowUV, uTime, flowSpeed, rapids, wf);

  // Monsoon raindrop concentric impact rings & micro-splashes
  vec3 rainRipples = evaluateRainRipples(
    flowUV,
    uTime,
    uRainRippleIntensity * (1.0 - wf * 0.85) * (1.0 - caveMask * 0.9)
  );

  // =========================================================================
  // CRISP HIGH-FREQUENCY DUCK KELVIN V-WAKE & WATERLINE RIPPLES (NO BLOBS!)
  // =========================================================================
  float duckWakeFoam = 0.0;
  vec2 duckWakeGrad = vec2(0.0);
  float wakeLace = lacyFoamFbm(vec2(s * 3.8 - uTime * 7.2, u * 4.6));

  if (uDuckWakeStrength > 0.01) {
    vec3 toFrag = vWorldPos - uDuckPos;
    vec2 flow2D = normalize(flowT.xz + vec2(1e-5, 0.0));
    vec2 right2D = vec2(-flow2D.y, flow2D.x);
    float relS = dot(toFrag.xz, flow2D);
    float relU = dot(toFrag.xz, right2D);
    float distXZ = length(toFrag.xz);

    // Delicate concentric glassy bobbing rings hugging the rubber duck
    if (distXZ < 2.8) {
      float ringEnv = exp(-distXZ * 1.45) * smoothstep(0.24, 0.48, distXZ);
      float ringPhase = distXZ * 11.0 - uTime * 8.2;
      float ringSlope = cos(ringPhase) * ringEnv * 0.56 * uDuckWakeStrength;
      vec2 radialDir = toFrag.xz / max(distXZ, 0.05);
      duckWakeGrad += vec2(dot(radialDir, flow2D), dot(radialDir, right2D)) * ringSlope;
      // Thin sparkling waterline meniscus collar right against duck belly
      float bowRim = smoothstep(0.58, 0.34, distXZ) * smoothstep(0.32, 0.72, wakeLace);
      duckWakeFoam += bowRim * 0.42 * uDuckWakeStrength;
    }

    // Crisp diverging Kelvin V-wake arms trailing behind the duck
    float behind = -relS;
    if (behind > 0.05 && behind < 9.5 && abs(relU) < 4.2) {
      float wakeSpread = 0.30 * behind + 0.34;
      float armDist = abs(abs(relU) - wakeSpread);
      float longitudinalFade = smoothstep(0.05, 0.48, behind) * (1.0 - smoothstep(1.8, 9.2, behind));
      // Tight crisp V-crest ripples (sharp wave crests rather than wide blurry bands)
      float armCrest = exp(-armDist * armDist * 18.0) * longitudinalFade;
      float secondaryArm = exp(-pow(abs(abs(relU) - wakeSpread * 0.66), 2.0) * 24.0) * longitudinalFade * 0.55;
      float waveTrain = sin(behind * 5.6 - uTime * 11.0 - abs(relU) * 2.2);

      duckWakeGrad.y += sign(relU) * (armCrest * 1.05 + secondaryArm * 0.6) * (0.7 + 0.45 * waveTrain) * uDuckWakeStrength;
      duckWakeGrad.x -= armCrest * 0.48 * uDuckWakeStrength;

      // Delicate lacy white froth along the sharp V-arm tips & narrow bubbling stern trail
      float lacyArmFoam = (armCrest * 0.85 + secondaryArm * 0.45) * smoothstep(0.42, 0.76, wakeLace);
      float sternBubbles = exp(-relU * relU * 14.0) * smoothstep(0.1, 0.45, behind) * (1.0 - smoothstep(1.2, 5.2, behind));
      sternBubbles *= smoothstep(0.46, 0.78, wakeLace) * 0.62;
      duckWakeFoam += (lacyArmFoam + sternBubbles) * uDuckWakeStrength;
    }
  }

  float rippleStrength = mix(0.28, 0.50, max(rapids, plungePool));
  vec2 totalGrad = rGrad * rippleStrength + duckWakeGrad * 0.52 + rainRipples.xy * 0.38;
  vec3 N = normalize(macroN - flowT * totalGrad.x - flowR * totalGrad.y);

  // =========================================================================
  // HIGH-FREQ LACY OBSTACLE FOAM, BANK EDGE FOAM & CRISP WATERFALL WHITEWATER
  // =========================================================================
  float foamLace = lacyFoamFbm(vec2(s * 1.85 - uTime * (2.6 + flowSpeed * 0.22), u * 2.35 + sin(s * 0.35) * 0.35));
  float fineFoam = valueNoise(vec2(s * 5.8 - uTime * 6.8, u * 6.4));

  // 1. Crisp shoreline bank edge lacy foam
  float bankEdge = smoothstep(0.84, 0.99, abs(uNorm));
  float bankFoam = bankEdge * smoothstep(0.36, 0.76, foamLace + bankEdge * 0.28) * (0.45 + 0.38 * rapids);

  // 2. Obstacle foam collars + crisp lacy downstream V-wake tails
  float obsFoam = 0.0;
  for (int i = 0; i < MAX_OBSTACLES; i++) {
    if (i >= uObstacleCount) break;
    vec4 obs = uObstacles[i];
    float rad = obs.z;
    float strength = obs.w;
    if (strength <= 0.01) continue;

    vec2 delta = vWorldPos.xz - obs.xy;
    float maxReach = rad * 4.4 + 2.2;
    if (abs(delta.x) > maxReach || abs(delta.y) > maxReach) continue;

    float dist = length(delta);
    float rimDist = dist - rad;

    vec4 oFlow = uObstacleFlow[i];
    vec2 oDir = normalize(oFlow.xy + vec2(1e-5, 0.0));
    vec2 oRight = vec2(-oDir.y, oDir.x);

    float along = dot(delta, oDir);
    float across = abs(dot(delta, oRight));

    // Tight aerated upstream pillow collar with lacy broken tendrils
    float upstreamBoost = mix(0.82, 1.32, smoothstep(0.35, -0.5, along / max(rad, 0.5)));
    float organicRim = rimDist + (foamLace - 0.5) * 0.62;
    float collarCore = smoothstep(0.62 * upstreamBoost, -0.14, organicRim);
    float collarLace = smoothstep(1.05 * upstreamBoost, 0.12, organicRim) * smoothstep(0.38, 0.76, foamLace);
    float outerRing = exp(-pow((rimDist - 0.44 - 0.14 * sin(uTime * 5.0 + float(i))) * 4.6, 2.0)) * 0.52 * fineFoam;

    // Directional aerated downstream V-wake tail behind boulder
    float wakeLen = rad * 3.4 + 1.8;
    float wakeTail = 0.0;
    if (along > -rad * 0.2 && along < wakeLen) {
      float tailT = clamp((along + rad * 0.2) / wakeLen, 0.0, 1.0);
      float tailHalfW = mix(rad * 0.86, rad * 1.25, tailT);
      float acrossMask = 1.0 - smoothstep(tailHalfW * 0.30, tailHalfW, across + (foamLace - 0.5) * 0.55);
      float lacyStreak = smoothstep(0.34, 0.78, foamLace * 0.65 + fineFoam * 0.42);
      float tailFade = (1.0 - tailT) * (1.0 - tailT * 0.45);
      wakeTail = acrossMask * tailFade * lacyStreak * 0.90;
    }

    obsFoam = max(obsFoam, (max(collarCore * 0.95, collarLace * 0.8) + outerRing + wakeTail) * strength);
  }

  // 3. Rapids whitewater foam ribbons
  float rapidsStreaks = lacyFoamFbm(vec2(s * 0.95 - uTime * 4.8, u * 3.2));
  float rapidsFoam = rapids * smoothstep(0.46, 0.80, rapidsStreaks * 0.68 + vWaveCrest * 0.44) * 0.68;

  // 4. Crisp cascading waterfall whitewater striations & frothy plunge-pool boil!
  float wfFineStreaks = lacyFoamFbm(vec2(s * 1.15 - uTime * 12.8, u * 5.4));
  float wfMicroSpray = valueNoise(vec2(s * 3.2 - uTime * 19.0, u * 11.0));
  // Modulate waterfall transition organically by lacy foam so curtain tongues feather naturally into plunge pool (zero horizontal seam!)
  float wfOrganic = clamp(wf + (wfFineStreaks - 0.5) * 0.42 * smoothstep(0.02, 0.35, wf) * (1.0 - smoothstep(0.65, 0.98, wf)), 0.0, 1.0);
  float wfCurtain = wfOrganic * (0.28 + 0.72 * smoothstep(0.26, 0.76, wfFineStreaks * 0.68 + wfMicroSpray * 0.42));
  float wfPhase = clamp(vWaterfallMeta.x, 0.0, 1.0);
  float lipCrest = wfOrganic * (exp(-pow((wfPhase - 0.10) * 5.0, 2.0)) * 0.35 + exp(-pow((wfPhase - 0.94) * 4.5, 2.0)) * 0.55);
  float plungeBoil = plungePool * smoothstep(0.30, 0.74, foamLace * 0.68 + fineFoam * 0.42) * 0.88;

  float rainSplashFoam = clamp(rainRipples.z * 0.58, 0.0, 0.65);

  float totalFoam = clamp(
    max(max(bankFoam, obsFoam), max(rapidsFoam, max(wfCurtain + lipCrest, plungeBoil))) + duckWakeFoam + rainSplashFoam,
    0.0,
    1.0
  );
  // Crisp high-contrast lacy whitewater threshold (never mushy!)
  float lacyFoam = clamp(smoothstep(0.22, 0.74, totalFoam + (fineFoam - 0.48) * 0.28) + rainRipples.z * 0.34, 0.0, 1.0);

  // =========================================================================
  // BRANCH: UNDERWATER UNDERSIDE (SNELL'S WINDOW + TOTAL INTERNAL REFLECTION)
  // =========================================================================
  if (!gl_FrontFacing || uUnderwater > 0.75) {
    vec3 underN = normalize(-N);
    float cosTheta = clamp(dot(underN, V), 0.0, 1.0);
    float snellPortal = smoothstep(0.54, 0.72, cosTheta);
    float snellRim = exp(-pow((cosTheta - 0.65) * 13.0, 2.0));

    vec3 skyPortal = mix(uSkyHorizon, uSkyTop, clamp(cosTheta * 1.1, 0.0, 1.0));
    float sunBurst = pow(clamp(dot(reflect(-V, underN), -sunDir), 0.0, 1.0), 18.0);
    skyPortal += uSunColor * (sunBurst * 1.6 + 0.28);
    skyPortal = mix(skyPortal, uCaveGlowColor * 0.55, caveMask * 0.85);

    vec3 tirColor = mix(uDeepColor * 0.48, uShallowColor * 0.58, 0.25 + 0.25 * foamLace);
    tirColor += uCaveGlowColor * (caveMask * 0.42);

    vec3 rimTint = mix(uCausticColor, uSunColor, 0.42);
    vec3 underColor = mix(tirColor, skyPortal, snellPortal) + rimTint * snellRim * 0.46 * (1.0 - caveMask * 0.7);
    underColor = mix(underColor, uFoamColor * 0.95, lacyFoam * 0.75);

    float distCam = length(cameraPosition - vWorldPos);
    float fogFactor = clamp((distCam - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
    underColor = mix(underColor, uFogColor, fogFactor);

    float underAlpha = mix(0.84, 0.58, snellPortal);
    underAlpha = max(underAlpha, lacyFoam * 0.92);
    gl_FragColor = vec4(underColor, underAlpha);
    return;
  }

  // =========================================================================
  // TOP WATER SURFACE: GLOSSY BEER-LAMBERT OPTICS, FRESNEL & SUN SPARKLES
  // =========================================================================
  float NdotV = clamp(dot(N, V), 0.001, 1.0);
  float clarityScale = mix(1.52, 0.72, clamp(uClarity, 0.25, 1.0));
  float opticalDepth = (depth / max(NdotV, 0.28)) * clarityScale;

  vec3 absorption = exp(-opticalDepth * vec3(0.54, 0.17, 0.13));
  float shallowFactor = clamp(absorption.g, 0.0, 1.0);

  float causticGlow = 0.0;
  if (uQuality > 0.5 && shallowFactor > 0.08 && caveMask < 0.8) {
    float c1 = shallowCaustic(flowUV * 0.82 - vec2(uTime * 0.36, 0.0), uTime);
    causticGlow = c1 * shallowFactor * (1.0 - caveMask) * 0.52 * uCausticIntensity;
  }

  vec3 waterBody = mix(uDeepColor, uShallowColor, pow(shallowFactor, 0.68));
  waterBody = mix(waterBody, uBedColor * 1.12, clamp(absorption.r * 0.36 * uClarity, 0.0, 0.38));
  waterBody += mix(uCausticColor, uSunColor, 0.35) * causticGlow * 0.58;

  // Subsurface Geothermal Magma Glow in Volcanic Gorge & warm canyons
  vec3 magmaGlow = vec3(0.0);
  if (uGeothermalGlow > 0.01) {
    float geoVein = valueNoise(vec2(s * 0.62 - uTime * 0.32, u * 0.92));
    float geoFine = valueNoise(vec2(s * 1.45 + uTime * 0.22, u * 1.85));
    float geoMask = smoothstep(0.32, 0.82, geoVein * 0.65 + geoFine * 0.35);
    float geoPulse = 0.80 + 0.20 * sin(uTime * 2.5 + s * 0.28);
    magmaGlow = mix(vec3(1.0, 0.28, 0.05), vec3(1.0, 0.66, 0.16), geoMask) * (uGeothermalGlow * geoPulse);
    waterBody += magmaGlow * (0.20 + 0.42 * geoMask) * (1.0 - shallowFactor * 0.35);
  }

  // Jewel-like aqua-emerald subsurface scattering through sunlit wave crests & waterfall sheets
  vec3 scatterDir = normalize(sunDir + N * 0.42);
  float sssView = pow(clamp(dot(V, -scatterDir), 0.0, 1.0), 2.6);
  float sssCrest = (0.40 + 0.60 * vWaveCrest + wf * 0.85 + plungePool * 0.35) * (1.0 - caveMask * 0.8);
  vec3 sssColor = mix(uShallowColor, uCausticColor, 0.48) * uSunColor;
  waterBody += sssColor * (sssView * 0.50 + wf * 0.24) * sssCrest;

  // Crisp glossy Schlick Fresnel
  float fresnel = 0.04 + 0.96 * pow(1.0 - NdotV, 4.0);

  vec3 R = reflect(-V, N);
  float skyElev = clamp(R.y * 1.35 + 0.06, 0.0, 1.0);
  vec3 skyRefl = mix(uSkyHorizon * 1.06, uSkyTop * 1.05, pow(skyElev, 0.62));
  float sunCorona = pow(clamp(dot(R, sunDir), 0.0, 1.0), 12.0);
  skyRefl += uSunColor * sunCorona * 0.72;

  // Reflect active Aurora Borealis ribbons across glassy Arctic Fjord water!
  if (uAuroraStrength > 0.01) {
    float aurWave = sin(R.x * 5.2 + R.z * 3.4 + uTime * 0.85) * 0.5 + 0.5;
    float aurStriation = 0.55 + 0.45 * sin(R.x * 16.0 - R.z * 9.0 - uTime * 1.35);
    float aurMask = smoothstep(0.02, 0.55, R.y) * aurStriation;
    vec3 aurCol = mix(uAuroraColorA, uAuroraColorB, aurWave);
    skyRefl += aurCol * aurMask * uAuroraStrength * 0.72;
  }

  // Overhanging bank/cliff/canopy reflections hugging outer edges
  float canopyBand = (1.0 - smoothstep(0.05, 0.40, R.y)) * (0.35 + 0.65 * smoothstep(0.32, 0.90, abs(uNorm)));
  float canopyDapple = 0.82 + 0.22 * valueNoise(vec2(s * 0.26, u * 0.32));
  vec3 envRefl = mix(skyRefl, uCanopyColor * 1.22 * canopyDapple, clamp(canopyBand * 0.72, 0.0, 0.76));

  if (caveMask > 0.01) {
    vec3 caveRefl = vec3(0.04, 0.13, 0.17) + uCaveGlowColor * (0.42 + 0.26 * foamLace);
    envRefl = mix(envRefl, caveRefl, caveMask);
    waterBody = mix(waterBody, mix(uDeepColor * 0.7, uCaveGlowColor * 0.52, 0.42), caveMask * 0.68);
  }

  float reflFactor = clamp(fresnel * 0.86 * uReflectivity, 0.0, 0.95);
  vec3 surfaceColor = mix(waterBody, envRefl, reflFactor);

  // Crisp dual-lobe Sun Specular Sparkle Glints dancing on capillary & rain ripples!
  vec3 H = normalize(sunDir + V);
  float NdotH = clamp(dot(N, H), 0.0, 1.0);
  float broadSpec = pow(NdotH, 54.0) * 0.68;
  float diamondGlint = pow(NdotH, 340.0) * 4.2;
  float sunMask = (1.0 - caveMask * 0.90) * (1.0 - lacyFoam * 0.68);
  surfaceColor += uSunColor * (broadSpec + diamondGlint) * sunMask;

  // Prismatic mist rainbow glint near sunlit waterfalls
  if ((wf > 0.12 || plungePool > 0.25) && uRainbowStrength > 0.01) {
    float viewSun = clamp(dot(V, -sunDir), 0.0, 1.0);
    float band = fract(vWorldPos.y * 0.28 + u * 0.14);
    vec3 prism = 0.5 + 0.5 * cos(6.2831 * (band + vec3(0.0, 0.33, 0.67)));
    float rainbowMask = max(wf, plungePool * 0.7) * smoothstep(0.08, 0.82, viewSun) * uRainbowStrength * 0.28;
    surfaceColor += prism * rainbowMask;
  }

  // Sunlit frothy lacy whitewater foam (with warm geothermal rim glow in Volcanic Gorge)
  float foamLit = 0.78 + 0.22 * clamp(dot(N, sunDir), 0.0, 1.0);
  vec3 shadedFoam = uFoamColor * mix(vec3(0.88, 0.96, 0.98), uSunColor, 0.38) * foamLit;
  shadedFoam += magmaGlow * 0.28;
  shadedFoam = mix(shadedFoam, uCaveGlowColor * 0.72 + vec3(0.28), caveMask * 0.55);
  surfaceColor = mix(surfaceColor, shadedFoam, lacyFoam);

  float depthOpacity = 1.0 - exp(-opticalDepth * 0.48);
  float alpha = clamp(
    mix(0.32, 0.92, depthOpacity) + fresnel * 0.38 + lacyFoam * 0.56 + wf * 0.36,
    0.26,
    0.97
  );
  alpha *= 1.0 - smoothstep(0.96, 1.04, abs(uNorm)) * 0.35;

  float distCam = length(cameraPosition - vWorldPos);
  float fogFactor = clamp((distCam - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
  surfaceColor = mix(surfaceColor, uFogColor, fogFactor);

  gl_FragColor = vec4(surfaceColor, alpha);
}
`;

export function createWaterShaderMaterial(): {
  material: THREE.ShaderMaterial;
  uniforms: WaterShaderUniforms;
} {
  const obstacles: THREE.Vector4[] = [];
  const obstacleFlow: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_WATER_OBSTACLES; i++) {
    obstacles.push(new THREE.Vector4(0, 0, 1, 0));
    obstacleFlow.push(new THREE.Vector4(0, 1, 0, 0));
  }

  const uniforms: WaterShaderUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.45, 0.76, 0.46).normalize() },
    uSunColor: { value: new THREE.Color('#fff5d6') },
    uSkyTop: { value: new THREE.Color('#2b7de9') },
    uSkyHorizon: { value: new THREE.Color('#b9ebff') },
    uCanopyColor: { value: new THREE.Color('#2d6b3e') },
    uShallowColor: { value: new THREE.Color('#28c7b7') },
    uDeepColor: { value: new THREE.Color('#094e63') },
    uBedColor: { value: new THREE.Color('#7c7159') },
    uFoamColor: { value: new THREE.Color('#f3fcff') },
    uCausticColor: { value: new THREE.Color('#72ffe8') },
    uCausticIntensity: { value: 1.15 },
    uClarity: { value: 0.92 },
    uReflectivity: { value: 1.0 },
    uRainRippleIntensity: { value: 0.0 },
    uGeothermalGlow: { value: 0.0 },
    uAuroraStrength: { value: 0.0 },
    uAuroraColorA: { value: new THREE.Color('#2af598') },
    uAuroraColorB: { value: new THREE.Color('#9b5de5') },
    uFogColor: { value: new THREE.Color('#b7e6f5') },
    uFogNear: { value: 55 },
    uFogFar: { value: 215 },
    uCaveGlowColor: { value: new THREE.Color('#4df5e3') },
    uUnderwater: { value: 0 },
    uDuckPos: { value: new THREE.Vector3(0, 0, 0) },
    uDuckVel: { value: new THREE.Vector3(0, 0, 12) },
    uDuckWakeStrength: { value: 1.0 },
    uObstacleCount: { value: 0 },
    uObstacles: { value: obstacles },
    uObstacleFlow: { value: obstacleFlow },
    uQuality: { value: 1.0 },
    uWaveParams: {
      value: new THREE.Vector4(
        DEFAULT_WATER_WAVE_PARAMS.ampScale,
        DEFAULT_WATER_WAVE_PARAMS.freqS,
        DEFAULT_WATER_WAVE_PARAMS.freqU,
        DEFAULT_WATER_WAVE_PARAMS.speedScale,
      ),
    },
    uRainbowStrength: { value: 0.65 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  return { material, uniforms };
}
