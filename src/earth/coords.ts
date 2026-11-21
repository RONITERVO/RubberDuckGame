import { MINI_EARTH_CONFIG } from '../config';
import type { Vec3 } from '../types';

/** Real planetary radius of Mini-Earth in Duck Scale world units (1° arc ≈ 27.93u, circ ≈ 10,053u). */
export const MINI_EARTH_RADIUS = MINI_EARTH_CONFIG.radius;
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const UNITS_PER_DEG = MINI_EARTH_RADIUS * DEG_TO_RAD;

export interface GeoCoord {
  /** Latitude in degrees (-90..+90). */
  lat: number;
  /** Longitude in degrees (-180..+180). */
  lng: number;
  /** Elevation above planetary sea level in world units (0 = sea level). */
  elevation: number;
}

/**
 * Floating-Origin Local Tangent Plane (ENU / right-handed Three.js Y-up) frame:
 * - `+X` = East
 * - `+Y` = Up (radial outward normal on Mini-Earth)
 * - `+Z` = South (`-Z` = North), preserving right-handedness (`East × Up = South`)
 */
export interface LocalTangentFrame {
  originLat: number;
  originLng: number;
  originElev: number;
  radius: number;
  /** Unit outward normal at origin on the globe sphere. */
  up: Vec3;
  /** Unit East vector (+X in local Three.js space). */
  east: Vec3;
  /** Unit South vector (+Z in local Three.js space; -Z is North). */
  south: Vec3;
  /** Unit North vector (-Z in local Three.js space). */
  north: Vec3;
  /** Origin 3D position on the Mini-Earth sphere at `(radius + originElev)`. */
  originSpherePos: Vec3;
}

export function clampLat(lat: number): number {
  return lat < -89.999 ? -89.999 : lat > 89.999 ? 89.999 : lat;
}

/**
 * Wrap any longitude in degrees cleanly into `(-180, 180]`.
 */
export function normalizeLng(lng: number): number {
  let wrapped = ((lng + 180) % 360 + 360) % 360 - 180;
  if (wrapped <= -180) wrapped += 360;
  return wrapped;
}

/**
 * Convert geographic `(lat, lng)` in degrees to 3D Cartesian coordinates on a
 * sphere of radius `radius` (+Y North Pole, +Z Prime Meridian 0°, +X 90°E).
 */
export function latLngToSphere(
  lat: number,
  lng: number,
  radius: number = MINI_EARTH_RADIUS,
): Vec3 {
  const phi = clampLat(lat) * DEG_TO_RAD;
  const theta = normalizeLng(lng) * DEG_TO_RAD;
  const cosPhi = Math.cos(phi);
  return {
    x: radius * cosPhi * Math.sin(theta),
    y: radius * Math.sin(phi),
    z: radius * cosPhi * Math.cos(theta),
  };
}

/**
 * Exact inverse of `latLngToSphere`: convert a 3D sphere vector into `{ lat, lng, radius }`.
 */
export function sphereToLatLng(v: Vec3): {
  lat: number;
  lng: number;
  radius: number;
} {
  const radius = Math.hypot(v.x, v.y, v.z);
  if (radius < 1e-9) {
    return { lat: 0, lng: 0, radius: 0 };
  }
  const sinPhi = Math.max(-1, Math.min(1, v.y / radius));
  const lat = Math.asin(sinPhi) * RAD_TO_DEG;
  const lng = normalizeLng(Math.atan2(v.x, v.z) * RAD_TO_DEG);
  return { lat, lng, radius };
}

/**
 * Great-circle central angle in radians via numerically stable Haversine formula.
 */
export function greatCircleAngleRad(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const p1 = clampLat(lat1) * DEG_TO_RAD;
  const p2 = clampLat(lat2) * DEG_TO_RAD;
  const dPhi = p2 - p1;
  const dLambda = normalizeLng(lng2 - lng1) * DEG_TO_RAD;

  const sinDPhi = Math.sin(dPhi * 0.5);
  const sinDLambda = Math.sin(dLambda * 0.5);
  const a =
    sinDPhi * sinDPhi + Math.cos(p1) * Math.cos(p2) * sinDLambda * sinDLambda;
  return 2 * Math.atan2(Math.sqrt(Math.max(0, a)), Math.sqrt(Math.max(0, 1 - a)));
}

/**
 * Great-circle angular separation in degrees.
 */
export function greatCircleDistanceDeg(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  return greatCircleAngleRad(lat1, lng1, lat2, lng2) * RAD_TO_DEG;
}

/**
 * Great-circle surface arc distance in Mini-Earth world units.
 */
export function greatCircleDistanceU(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  radius: number = MINI_EARTH_RADIUS,
): number {
  return greatCircleAngleRad(lat1, lng1, lat2, lng2) * radius;
}

/**
 * Initial forward compass bearing in degrees `[0, 360)` from `(lat1, lng1)` toward `(lat2, lng2)`
 * (`0° = North`, `90° = East`, `180° = South`, `270° = West`).
 */
export function initialBearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const p1 = clampLat(lat1) * DEG_TO_RAD;
  const p2 = clampLat(lat2) * DEG_TO_RAD;
  const dLambda = normalizeLng(lng2 - lng1) * DEG_TO_RAD;

  const y = Math.sin(dLambda) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) -
    Math.sin(p1) * Math.cos(p2) * Math.cos(dLambda);
  return ((Math.atan2(y, x) * RAD_TO_DEG) % 360 + 360) % 360;
}

/**
 * Signed relative turn angle in `[-180, 180]` degrees from `inBearingDeg` to `outBearingDeg`
 * (`< 0` = LEFT turn, `> 0` = RIGHT turn).
 */
export function relativeBearingDeg(
  inBearingDeg: number,
  outBearingDeg: number,
): number {
  return ((outBearingDeg - inBearingDeg + 540) % 360) - 180;
}

/**
 * Antimeridian-safe and pole-safe spherical linear interpolation (SLERP) along the
 * shortest great-circle arc between `(lat1, lng1)` and `(lat2, lng2)`.
 */
export function interpolateGreatCircle(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  t: number,
): { lat: number; lng: number } {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  if (u <= 0) return { lat: clampLat(lat1), lng: normalizeLng(lng1) };
  if (u >= 1) return { lat: clampLat(lat2), lng: normalizeLng(lng2) };

  const a = latLngToSphere(lat1, lng1, 1.0);
  const b = latLngToSphere(lat2, lng2, 1.0);
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  const omega = Math.acos(dot);

  if (omega < 1e-6) {
    return {
      lat: clampLat(lat1 + (lat2 - lat1) * u),
      lng: normalizeLng(lng1 + normalizeLng(lng2 - lng1) * u),
    };
  }

  const sinOmega = Math.sin(omega);
  const wA = Math.sin((1 - u) * omega) / sinOmega;
  const wB = Math.sin(u * omega) / sinOmega;

  const res = sphereToLatLng({
    x: a.x * wA + b.x * wB,
    y: a.y * wA + b.y * wB,
    z: a.z * wA + b.z * wB,
  });
  return { lat: res.lat, lng: res.lng };
}

/**
 * Compute geodesic destination coordinate from `(lat, lng)` moving `distanceU` world
 * units along `bearingDeg` (`0° = North`, `90° = East`).
 */
export function destinationPoint(
  lat: number,
  lng: number,
  bearingDeg: number,
  distanceU: number,
  radius: number = MINI_EARTH_RADIUS,
): { lat: number; lng: number } {
  const p1 = clampLat(lat) * DEG_TO_RAD;
  const l1 = normalizeLng(lng) * DEG_TO_RAD;
  const brg = bearingDeg * DEG_TO_RAD;
  const ang = distanceU / radius;

  const sinP1 = Math.sin(p1);
  const cosP1 = Math.cos(p1);
  const sinAng = Math.sin(ang);
  const cosAng = Math.cos(ang);

  const sinP2 = sinP1 * cosAng + cosP1 * sinAng * Math.cos(brg);
  const p2 = Math.asin(Math.max(-1, Math.min(1, sinP2)));
  const y = Math.sin(brg) * sinAng * cosP1;
  const x = cosAng - sinP1 * sinP2;
  const l2 = l1 + Math.atan2(y, x);

  return {
    lat: clampLat(p2 * RAD_TO_DEG),
    lng: normalizeLng(l2 * RAD_TO_DEG),
  };
}

/**
 * Construct a right-handed Floating-Origin Local Tangent Plane (ENU) frame anchored
 * at `(originLat, originLng, originElev)` on Mini-Earth:
 * - `+X` = East
 * - `+Y` = Up
 * - `+Z` = South (`-Z` = North)
 */
export function createLocalTangentFrame(
  originLat: number,
  originLng: number,
  originElev: number = 0,
  radius: number = MINI_EARTH_RADIUS,
): LocalTangentFrame {
  const lat = clampLat(originLat);
  const lng = normalizeLng(originLng);
  const phi = lat * DEG_TO_RAD;
  const theta = lng * DEG_TO_RAD;

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);

  const up: Vec3 = {
    x: cosPhi * sinTheta,
    y: sinPhi,
    z: cosPhi * cosTheta,
  };
  const east: Vec3 = {
    x: cosTheta,
    y: 0,
    z: -sinTheta,
  };
  const south: Vec3 = {
    x: sinPhi * sinTheta,
    y: -cosPhi,
    z: sinPhi * cosTheta,
  };
  const north: Vec3 = {
    x: -south.x,
    y: -south.y,
    z: -south.z,
  };

  const r = radius + originElev;
  const originSpherePos: Vec3 = {
    x: up.x * r,
    y: up.y * r,
    z: up.z * r,
  };

  return {
    originLat: lat,
    originLng: lng,
    originElev,
    radius,
    up,
    east,
    south,
    north,
    originSpherePos,
  };
}

/**
 * Project any Earth `(lat, lng, elev)` coordinate into crisp float32-safe Three.js
 * local coordinates relative to `frame`.
 *
 * When `applyHorizonCurvature` is `true` (default), uses exact spherical projection
 * `dot(P - O, frame.up)` which naturally produces the true subtle planetary horizon
 * drop `-dist² / (2 * MINI_EARTH_RADIUS)`.
 */
export function earthToLocal(
  lat: number,
  lng: number,
  elev: number,
  frame: LocalTangentFrame,
  applyHorizonCurvature: boolean = MINI_EARTH_CONFIG.horizonCurvatureEnabled,
): Vec3 {
  const p = latLngToSphere(lat, lng, frame.radius + elev);
  const dx = p.x - frame.originSpherePos.x;
  const dy = p.y - frame.originSpherePos.y;
  const dz = p.z - frame.originSpherePos.z;

  const x = dx * frame.east.x + dy * frame.east.y + dz * frame.east.z;
  const z = dx * frame.south.x + dy * frame.south.y + dz * frame.south.z;
  const y = applyHorizonCurvature
    ? dx * frame.up.x + dy * frame.up.y + dz * frame.up.z
    : elev - frame.originElev;

  return { x, y, z };
}

/**
 * Inverse projection from Three.js local ENU coordinates back to exact Mini-Earth
 * `{ lat, lng, elevation }`.
 */
export function localToEarth(
  localPos: Vec3,
  frame: LocalTangentFrame,
  hadHorizonCurvature: boolean = MINI_EARTH_CONFIG.horizonCurvatureEnabled,
): GeoCoord {
  if (hadHorizonCurvature) {
    const px =
      frame.originSpherePos.x +
      frame.east.x * localPos.x +
      frame.up.x * localPos.y +
      frame.south.x * localPos.z;
    const py =
      frame.originSpherePos.y +
      frame.east.y * localPos.x +
      frame.up.y * localPos.y +
      frame.south.y * localPos.z;
    const pz =
      frame.originSpherePos.z +
      frame.east.z * localPos.x +
      frame.up.z * localPos.y +
      frame.south.z * localPos.z;

    const geo = sphereToLatLng({ x: px, y: py, z: pz });
    return {
      lat: geo.lat,
      lng: geo.lng,
      elevation: geo.radius - frame.radius,
    };
  }

  // Exact orthographic tangent-plane inverse matching earthToLocal(..., false)
  const elevation = frame.originElev + localPos.y;
  const rTarget = frame.radius + elevation;
  const horizSq = localPos.x * localPos.x + localPos.z * localPos.z;
  const pUp = Math.sqrt(Math.max(1e-6, rTarget * rTarget - horizSq));

  const tx =
    frame.up.x * pUp +
    frame.east.x * localPos.x +
    frame.south.x * localPos.z;
  const ty =
    frame.up.y * pUp +
    frame.east.y * localPos.x +
    frame.south.y * localPos.z;
  const tz =
    frame.up.z * pUp +
    frame.east.z * localPos.x +
    frame.south.z * localPos.z;

  const geo = sphereToLatLng({ x: tx, y: ty, z: tz });
  return {
    lat: geo.lat,
    lng: geo.lng,
    elevation,
  };
}
