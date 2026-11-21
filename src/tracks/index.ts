export * from './schema';
export * from './registry';
export * from './worldGraph';

// Re-export the shared physical Mini-Earth engine for seamless adoption
export {
  earthWorld,
  EarthWorld,
  DEFAULT_REGION_ID,
  MINI_EARTH_RADIUS,
  createLocalTangentFrame,
  earthToLocal,
  localToEarth,
  latLngToSphere,
  sphereToLatLng,
  greatCircleDistanceU,
  greatCircleDistanceDeg,
  initialBearing,
  interpolateGreatCircle,
  GeoSpatialIndex,
} from '../earth';
