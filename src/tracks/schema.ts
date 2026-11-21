import type { AssetId, CaveStyle, RouteMode } from '../types';
import {
  blendAudioScaleParams,
  blendEarthAtmospheres,
  blendEarthRiverProfiles,
  blendEarthWaterStyles,
  blendGroundShaderParams,
  blendWeatherParams,
  hexToCss,
  lerpHexColor,
  type AudioScaleParams,
  type CaveVisualParams,
  type EarthAtmosphere,
  type EarthLandmarkRule,
  type EarthObstacles,
  type EarthRegionZone,
  type EarthRiverProfile,
  type EarthScenery,
  type EarthSceneryWeightedAsset,
  type EarthWaterStyle,
  type EarthWildlife,
  type GroundShaderParams,
  type LandmarkPlacement,
  type TimeOfDay,
  type WeatherParams,
} from '../earth/schema';

export type {
  AudioScaleParams,
  CaveStyle,
  CaveVisualParams,
  EarthRegionZone,
  GroundShaderParams,
  LandmarkPlacement,
  RouteMode,
  TimeOfDay,
  WeatherParams,
};
export { hexToCss, lerpHexColor };

/**
 * Legacy weather identifier alias kept for backward compatibility while
 * renderer/UI migrate to open data-driven `WeatherParams` in `src/earth/schema.ts`.
 */
export type WeatherType =
  | 'clear_sunbeams'
  | 'cherry_blossoms'
  | 'monsoon_rain'
  | 'canyon_dust'
  | 'arctic_snow'
  | 'volcanic_embers';

/**
 * Legacy ground style identifier alias kept for backward compatibility while
 * terrain shaders migrate to open data-driven `GroundShaderParams` in `src/earth/schema.ts`.
 */
export type GroundStyle =
  | 'pnw_moss'
  | 'kyoto_stone'
  | 'amazon_jungle'
  | 'red_sandstone'
  | 'arctic_ice'
  | 'volcanic_basalt';

/**
 * Legacy musical scale identifier alias kept for backward compatibility while
 * SoundEngine migrates to open `AudioScaleParams.scaleIntervals` in `src/earth/schema.ts`.
 */
export type ChimeScale =
  | 'pentatonic_major'
  | 'japanese_hirajoshi'
  | 'tropical_marimba'
  | 'canyon_warm'
  | 'arctic_crystal'
  | 'volcanic_deep';

export interface TrackCoordinates {
  lat: number;
  lng: number;
}

export interface TrackRiverProfile extends EarthRiverProfile {
  caveStyle: CaveStyle;
}

export type TrackWaterStyle = EarthWaterStyle;
export type TrackAtmosphere = EarthAtmosphere;

export interface TrackWeather extends WeatherParams {
  type: WeatherType;
}

export interface TrackGroundStyle extends GroundShaderParams {
  style: GroundStyle;
  wetShoreColor: number;
  emissiveTint?: number;
  emissiveStrength?: number;
}

export type TrackSceneryWeightedAsset = EarthSceneryWeightedAsset;
export type TrackLandmarkSpec = EarthLandmarkRule;
export type TrackScenery = EarthScenery;
export type TrackObstacles = EarthObstacles;
export type TrackWildlife = EarthWildlife;

export interface TrackAudioProfile extends AudioScaleParams {
  chimeScale: ChimeScale;
}

/**
 * Backward-compatible track view synthesized dynamically from a shared-planet
 * `EarthRegionZone` + its connected `EarthWaterway` network in `src/earth/earthWorld.ts`.
 */
export interface EarthTrackDefinition {
  id: string;
  name: string;
  region: string;
  country: string;
  subtitle: string;
  accentColor: string;
  difficulty: 1 | 2 | 3;
  coordinates: TrackCoordinates;
  globeColor: string;
  connections: string[];
  segmentLength: number;
  riverProfile: TrackRiverProfile;
  waterStyle: TrackWaterStyle;
  atmosphere: TrackAtmosphere;
  weather: TrackWeather;
  groundStyle: TrackGroundStyle;
  caveVisual: CaveVisualParams;
  scenery: TrackScenery;
  obstacles: TrackObstacles;
  wildlife: TrackWildlife;
  audioProfile: TrackAudioProfile;
  /** Underlying real planetary `EarthRegionZone` from `src/world/packs/`. */
  zone: EarthRegionZone;
}

export const WEATHER_LABELS: Record<WeatherType, string> = {
  clear_sunbeams: 'Sunlit Forest Breeze',
  cherry_blossoms: 'Sakura Blossom Drift',
  monsoon_rain: 'Tropical Monsoon Storm',
  canyon_dust: 'Golden Canyon Thermal',
  arctic_snow: 'Aurora Polar Snowfall',
  volcanic_embers: 'Geothermal Ash & Embers',
};

export function getWeatherLabel(type: WeatherType | string): string {
  if (type in WEATHER_LABELS) {
    return WEATHER_LABELS[type as WeatherType];
  }
  return type.replace(/_/g, ' ');
}

export function inferLegacyWeatherType(weather: WeatherParams): WeatherType {
  if (weather.id in WEATHER_LABELS) {
    return weather.id as WeatherType;
  }
  switch (weather.particleShape) {
    case 'petal':
      return 'cherry_blossoms';
    case 'rain':
      return 'monsoon_rain';
    case 'dust':
      return 'canyon_dust';
    case 'snow':
      return 'arctic_snow';
    case 'ember':
      return 'volcanic_embers';
    default:
      return 'clear_sunbeams';
  }
}

export function inferLegacyGroundStyle(ground: GroundShaderParams): GroundStyle {
  if (ground.snowCoverage >= 0.5 || ground.iceReflectivity >= 0.5) return 'arctic_ice';
  if (ground.emissiveIntensity >= 0.5 && ground.strataIntensity >= 0.4) return 'volcanic_basalt';
  if (ground.strataIntensity >= 0.55) return 'red_sandstone';
  if (ground.petalFlecks >= 0.4) return 'kyoto_stone';
  if (ground.mossCoverage >= 0.94 && ground.emissiveIntensity > 0.1) return 'amazon_jungle';
  return 'pnw_moss';
}

export function inferLegacyCaveStyle(zone: EarthRegionZone): CaveStyle {
  if (zone.groundStyle.snowCoverage >= 0.5) return 'glacier_ice';
  if (zone.groundStyle.emissiveIntensity >= 0.5) return 'lava_tube';
  if (zone.groundStyle.strataIntensity >= 0.55) return 'canyon_slot';
  if (zone.groundStyle.petalFlecks >= 0.4) return 'bamboo_grotto';
  if (zone.weather.rainRipples >= 0.5) return 'jungle_cenote';
  return 'limestone';
}

export function inferLegacyChimeScale(audio: AudioScaleParams): ChimeScale {
  switch (audio.timbre) {
    case 'koto':
      return 'japanese_hirajoshi';
    case 'crystal':
      return 'arctic_crystal';
    case 'deep':
      return 'volcanic_deep';
    case 'warm':
      return 'canyon_warm';
    case 'marimba':
      return audio.rainIntensity > 0.3 ? 'tropical_marimba' : 'pentatonic_major';
    default:
      return 'pentatonic_major';
  }
}

export function adaptZoneToTrackDefinition(
  zone: EarthRegionZone,
  connections: string[],
  segmentLength: number = 270,
): EarthTrackDefinition {
  const legacyCaveStyle = inferLegacyCaveStyle(zone);
  const legacyWeatherType = inferLegacyWeatherType(zone.weather);
  const legacyGroundStyle = inferLegacyGroundStyle(zone.groundStyle);
  const legacyChimeScale = inferLegacyChimeScale(zone.audioProfile);

  return {
    id: zone.id,
    name: zone.name,
    region: zone.region,
    country: zone.country,
    subtitle: zone.subtitle,
    accentColor: zone.accentColor,
    difficulty: zone.difficulty,
    coordinates: { lat: zone.centerLat, lng: zone.centerLng },
    globeColor: zone.globeColor,
    connections,
    segmentLength,
    riverProfile: {
      ...zone.riverProfile,
      caveStyle: legacyCaveStyle,
    },
    waterStyle: zone.waterStyle,
    atmosphere: zone.atmosphere,
    weather: {
      ...zone.weather,
      type: legacyWeatherType,
    },
    groundStyle: {
      ...zone.groundStyle,
      style: legacyGroundStyle,
      wetShoreColor: zone.groundStyle.shoreColor,
      emissiveTint: zone.groundStyle.emissiveColor,
      emissiveStrength: zone.groundStyle.emissiveIntensity,
    },
    caveVisual: zone.caveStyle,
    scenery: zone.scenery,
    obstacles: zone.obstacles,
    wildlife: zone.wildlife,
    audioProfile: {
      ...zone.audioProfile,
      chimeScale: legacyChimeScale,
    },
    zone,
  };
}

export function blendRiverProfiles(
  a: TrackRiverProfile,
  b: TrackRiverProfile,
  t: number,
): TrackRiverProfile {
  return {
    ...blendEarthRiverProfiles(a, b, t),
    caveStyle: t < 0.5 ? a.caveStyle : b.caveStyle,
  };
}

export function blendWaterStyles(
  a: TrackWaterStyle,
  b: TrackWaterStyle,
  t: number,
): TrackWaterStyle {
  return blendEarthWaterStyles(a, b, t);
}

export function blendAtmospheres(
  a: TrackAtmosphere,
  b: TrackAtmosphere,
  t: number,
): TrackAtmosphere {
  return blendEarthAtmospheres(a, b, t);
}

export function blendWeathers(
  a: TrackWeather,
  b: TrackWeather,
  t: number,
): TrackWeather {
  return {
    ...blendWeatherParams(a, b, t),
    type: t < 0.5 ? a.type : b.type,
  };
}

export function blendGroundStyles(
  a: TrackGroundStyle,
  b: TrackGroundStyle,
  t: number,
): TrackGroundStyle {
  const blended = blendGroundShaderParams(a, b, t);
  return {
    ...blended,
    style: t < 0.5 ? a.style : b.style,
    wetShoreColor: blended.shoreColor,
    emissiveTint: blended.emissiveColor,
    emissiveStrength: blended.emissiveIntensity,
  };
}

export function blendAudioProfiles(
  a: TrackAudioProfile,
  b: TrackAudioProfile,
  t: number,
): TrackAudioProfile {
  return {
    ...blendAudioScaleParams(a, b, t),
    chimeScale: t < 0.5 ? a.chimeScale : b.chimeScale,
  };
}

export type { AssetId };
