import type {
  AssetId,
  AssetSpec,
  CoreAssetId,
  DuckWingAttachments,
  ModelBoundingBox,
  PivotAlignment,
} from '../types';

export const MODELS_BASE_URL = './models/';
export const MANIFEST_URL = './models/assets.json';

export const HERO_CORE_ASSET_IDS: readonly CoreAssetId[] = [
  'rubber_duck',
  'duck_wing',
] as const;

export const SHARED_OBSTACLE_ASSET_IDS: readonly AssetId[] = [
  'beaver_dam',
  'stone_footbridge',
  'sunken_canoe',
  'willow_overhang',
  'river_snag_stump',
  'floating_barrel',
  'cattail_reeds',
  'mossy_step_stones',
  'waterwheel_mill',
  'crystal_cluster',
] as const;

/**
 * Open, extensible 3D asset normalization registry in Duck Scale (1.0 world unit = 10 cm).
 * All normalized models face +Z forward and +Y up.
 * Contributor packs in `src/world/packs/` register custom `.glb` assets dynamically
 * via `registerAssetSpecs()` with zero edits to this file!
 */
export const DEFAULT_ASSET_SPECS: Record<string, AssetSpec> = {
  // ---- Core Hero Duck Rig ----
  rubber_duck: {
    id: 'rubber_duck',
    filename: 'rubber_duck.glb',
    targetSize: 1.25,
    sizeAxis: 'z',
    pivot: 'waterline',
    yOffset: 0.0,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Hero Rubber Duck',
    fallbackArchetype: 'critter',
    fallbackColor: 0xffd41c,
  },
  duck_wing: {
    id: 'duck_wing',
    filename: 'duck_wing.glb',
    targetSize: 0.56,
    sizeAxis: 'max',
    pivot: 'center',
    yOffset: 0.0,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Articulated Rubber Duck Wing',
    fallbackArchetype: 'critter',
    fallbackColor: 0xffd41c,
  },

  // ---- Shared Core Creek & Valley Assets ----
  mossy_boulder_a: {
    id: 'mossy_boulder_a',
    filename: 'mossy_boulder_a.glb',
    targetSize: 3.6,
    sizeAxis: 'max',
    pivot: 'bottom',
    yOffset: -0.35,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Mossy River Boulder A',
    fallbackArchetype: 'rock',
    fallbackColor: 0x515b5e,
  },
  mossy_boulder_b: {
    id: 'mossy_boulder_b',
    filename: 'mossy_boulder_b.glb',
    targetSize: 4.2,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.4,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Jagged Creek Rock Pillar B',
    fallbackArchetype: 'pillar',
    fallbackColor: 0x455054,
  },
  fallen_log_arch: {
    id: 'fallen_log_arch',
    filename: 'fallen_log_arch.glb',
    targetSize: 11.5,
    sizeAxis: 'x',
    pivot: 'center',
    yOffset: 0.0,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Mossy Fallen Log Arch (Dive Under)',
    fallbackArchetype: 'arch',
    fallbackColor: 0x5c3e26,
  },
  driftwood_roots: {
    id: 'driftwood_roots',
    filename: 'driftwood_roots.glb',
    targetSize: 6.4,
    sizeAxis: 'x',
    pivot: 'center',
    yOffset: -0.18,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Tangled Driftwood Log (Jump Over)',
    fallbackArchetype: 'log',
    fallbackColor: 0x735b44,
  },
  pine_tree: {
    id: 'pine_tree',
    filename: 'pine_tree.glb',
    targetSize: 22.0,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.5,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Alpine Pine Tree',
    fallbackArchetype: 'tree',
    fallbackColor: 0x225c33,
  },
  fern_cluster: {
    id: 'fern_cluster',
    filename: 'fern_cluster.glb',
    targetSize: 3.4,
    sizeAxis: 'max',
    pivot: 'bottom',
    yOffset: -0.15,
    rotY: 0,
    castShadow: false,
    receiveShadow: true,
    label: 'Woodland Fern Cluster',
    fallbackArchetype: 'foliage',
    fallbackColor: 0x358c3c,
  },
  river_trout: {
    id: 'river_trout',
    filename: 'river_trout.glb',
    targetSize: 1.85,
    sizeAxis: 'z',
    pivot: 'center',
    yOffset: 0.0,
    rotY: 0,
    castShadow: false,
    receiveShadow: true,
    label: 'Speckled River Trout',
    fallbackArchetype: 'fish',
    fallbackColor: 0x4e8a8f,
  },
  duckling: {
    id: 'duckling',
    filename: 'duckling.glb',
    targetSize: 0.68,
    sizeAxis: 'z',
    pivot: 'waterline',
    yOffset: 0.0,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Baby Duckling',
    fallbackArchetype: 'critter',
    fallbackColor: 0xffe44d,
  },

  // ---- 10 New Shared River Obstacle & Detail Meshy Assets ----
  beaver_dam: {
    id: 'beaver_dam',
    filename: 'beaver_dam.glb',
    targetSize: 6.8,
    sizeAxis: 'x',
    pivot: 'center',
    yOffset: -0.12,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Rustic Woven Beaver Dam (Jump Over)',
    fallbackArchetype: 'log',
    fallbackColor: 0x6b4a2b,
  },
  stone_footbridge: {
    id: 'stone_footbridge',
    filename: 'stone_footbridge.glb',
    targetSize: 12.6,
    sizeAxis: 'x',
    pivot: 'center',
    yOffset: 0.2,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Mossy Cobblestone Footbridge Arch (Dive Under)',
    fallbackArchetype: 'arch',
    fallbackColor: 0x767c80,
  },
  sunken_canoe: {
    id: 'sunken_canoe',
    filename: 'sunken_canoe.glb',
    targetSize: 4.8,
    sizeAxis: 'z',
    pivot: 'waterline',
    yOffset: -0.15,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Half-Submerged Weathered Wooden Canoe',
    fallbackArchetype: 'boat',
    fallbackColor: 0x8a5230,
  },
  willow_overhang: {
    id: 'willow_overhang',
    filename: 'willow_overhang.glb',
    targetSize: 11.8,
    sizeAxis: 'x',
    pivot: 'center',
    yOffset: 0.15,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Weeping Willow Branch Overhang (Dive Under)',
    fallbackArchetype: 'arch',
    fallbackColor: 0x457d3e,
  },
  river_snag_stump: {
    id: 'river_snag_stump',
    filename: 'river_snag_stump.glb',
    targetSize: 4.4,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.4,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Bleached River Snag Stump & Roots',
    fallbackArchetype: 'pillar',
    fallbackColor: 0x8c7b68,
  },
  floating_barrel: {
    id: 'floating_barrel',
    filename: 'floating_barrel.glb',
    targetSize: 2.3,
    sizeAxis: 'max',
    pivot: 'waterline',
    yOffset: -0.05,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Bobbing Weathered Oak River Barrel',
    fallbackArchetype: 'log',
    fallbackColor: 0x7c4f2b,
  },
  cattail_reeds: {
    id: 'cattail_reeds',
    filename: 'cattail_reeds.glb',
    targetSize: 4.2,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.25,
    rotY: 0,
    castShadow: false,
    receiveShadow: true,
    label: 'Dense Creek Cattails & Water Reeds',
    fallbackArchetype: 'foliage',
    fallbackColor: 0x4e8c3c,
  },
  mossy_step_stones: {
    id: 'mossy_step_stones',
    filename: 'mossy_step_stones.glb',
    targetSize: 5.8,
    sizeAxis: 'x',
    pivot: 'waterline',
    yOffset: -0.1,
    rotY: 0,
    castShadow: false,
    receiveShadow: true,
    label: 'Mossy Granite Creek Stepping Stones',
    fallbackArchetype: 'pad',
    fallbackColor: 0x6c7578,
  },
  waterwheel_mill: {
    id: 'waterwheel_mill',
    filename: 'waterwheel_mill.glb',
    targetSize: 10.2,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.5,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Rustic Creekside Wooden Waterwheel Mill',
    fallbackArchetype: 'landmark',
    fallbackColor: 0x78563a,
  },
  crystal_cluster: {
    id: 'crystal_cluster',
    filename: 'crystal_cluster.glb',
    targetSize: 3.6,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.2,
    rotY: 0,
    castShadow: false,
    receiveShadow: true,
    label: 'Glowing Turquoise Cave Crystal Cluster',
    fallbackArchetype: 'crystal',
    fallbackColor: 0x3bf0e4,
  },

  // ---- Built-in Regional Pack Models (also self-registered by their packs) ----
  torii_gate: {
    id: 'torii_gate',
    filename: 'torii_gate.glb',
    targetSize: 13.0,
    sizeAxis: 'x',
    pivot: 'center',
    yOffset: 0.15,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Vermilion Shinto Torii Gate',
    fallbackArchetype: 'arch',
    fallbackColor: 0xd92b2b,
  },
  sakura_tree: {
    id: 'sakura_tree',
    filename: 'sakura_tree.glb',
    targetSize: 18.5,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.45,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Blooming Kyoto Sakura Cherry Tree',
    fallbackArchetype: 'tree',
    fallbackColor: 0xff9ec7,
  },
  bamboo_cluster: {
    id: 'bamboo_cluster',
    filename: 'bamboo_cluster.glb',
    targetSize: 15.0,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.35,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Arashiyama Green Bamboo Grove Cluster',
    fallbackArchetype: 'tree',
    fallbackColor: 0x4ca346,
  },
  stone_lantern: {
    id: 'stone_lantern',
    filename: 'stone_lantern.glb',
    targetSize: 3.8,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.2,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Mossy Kyoto Toro Stone Lantern',
    fallbackArchetype: 'landmark',
    fallbackColor: 0x767c82,
  },
  koi_fish: {
    id: 'koi_fish',
    filename: 'koi_fish.glb',
    targetSize: 1.95,
    sizeAxis: 'z',
    pivot: 'center',
    yOffset: 0.0,
    rotY: 0,
    castShadow: false,
    receiveShadow: true,
    label: 'Nishikigoi Calico Koi Fish',
    fallbackArchetype: 'fish',
    fallbackColor: 0xff4d1c,
  },
  jungle_palm: {
    id: 'jungle_palm',
    filename: 'jungle_palm.glb',
    targetSize: 21.0,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.45,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Amazonian Rainforest Canopy Palm',
    fallbackArchetype: 'tree',
    fallbackColor: 0x298a3b,
  },
  temple_ruin: {
    id: 'temple_ruin',
    filename: 'temple_ruin.glb',
    targetSize: 10.5,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.45,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Overgrown Vine-Draped Jungle Temple Pillar',
    fallbackArchetype: 'landmark',
    fallbackColor: 0x697062,
  },
  giant_lily_pad: {
    id: 'giant_lily_pad',
    filename: 'giant_lily_pad.glb',
    targetSize: 3.6,
    sizeAxis: 'max',
    pivot: 'waterline',
    yOffset: 0.04,
    rotY: 0,
    castShadow: false,
    receiveShadow: true,
    label: 'Giant Victoria Amazonica Lotus Lily Pad',
    fallbackArchetype: 'pad',
    fallbackColor: 0x2e9c44,
  },
  red_rock_pillar: {
    id: 'red_rock_pillar',
    filename: 'red_rock_pillar.glb',
    targetSize: 5.8,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.45,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Striated Red Sandstone Hoodoo Pillar',
    fallbackArchetype: 'pillar',
    fallbackColor: 0xc4512d,
  },
  red_rock_arch: {
    id: 'red_rock_arch',
    filename: 'red_rock_arch.glb',
    targetSize: 12.8,
    sizeAxis: 'x',
    pivot: 'center',
    yOffset: 0.15,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Natural Desert Sandstone Bridge Arch',
    fallbackArchetype: 'arch',
    fallbackColor: 0xc75430,
  },
  saguaro_cactus: {
    id: 'saguaro_cactus',
    filename: 'saguaro_cactus.glb',
    targetSize: 11.0,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.35,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Desert Canyon Saguaro Cactus',
    fallbackArchetype: 'pillar',
    fallbackColor: 0x3b7d3e,
  },
  iceberg_spire: {
    id: 'iceberg_spire',
    filename: 'iceberg_spire.glb',
    targetSize: 5.4,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.5,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Crystalline Glacial Iceberg Spire',
    fallbackArchetype: 'crystal',
    fallbackColor: 0xa6edff,
  },
  ice_arch: {
    id: 'ice_arch',
    filename: 'ice_arch.glb',
    targetSize: 12.4,
    sizeAxis: 'x',
    pivot: 'center',
    yOffset: 0.15,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Translucent Blue Glacier Ice Arch',
    fallbackArchetype: 'arch',
    fallbackColor: 0x8ae5ff,
  },
  penguin: {
    id: 'penguin',
    filename: 'penguin.glb',
    targetSize: 1.15,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.05,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Arctic Fjord Emperor Penguin',
    fallbackArchetype: 'critter',
    fallbackColor: 0x181c26,
  },
  basalt_columns: {
    id: 'basalt_columns',
    filename: 'basalt_columns.glb',
    targetSize: 6.4,
    sizeAxis: 'y',
    pivot: 'bottom',
    yOffset: -0.45,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Hexagonal Volcanic Basalt Column Cluster',
    fallbackArchetype: 'pillar',
    fallbackColor: 0x23262e,
  },
  obsidian_arch: {
    id: 'obsidian_arch',
    filename: 'obsidian_arch.glb',
    targetSize: 12.4,
    sizeAxis: 'x',
    pivot: 'center',
    yOffset: 0.15,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Jagged Glowing Obsidian Lava Arch',
    fallbackArchetype: 'arch',
    fallbackColor: 0x1b1e26,
  },
  lava_rock: {
    id: 'lava_rock',
    filename: 'lava_rock.glb',
    targetSize: 4.0,
    sizeAxis: 'max',
    pivot: 'bottom',
    yOffset: -0.35,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: 'Magma-Veined Volcanic Basalt Boulder',
    fallbackArchetype: 'rock',
    fallbackColor: 0x242730,
  },
};

/**
 * Live mutable list of all registered asset IDs (grows automatically when
 * contributor packs register custom `.glb` assets via `registerAssetSpecs()`).
 */
export const ALL_ASSET_IDS: AssetId[] = Object.keys(DEFAULT_ASSET_SPECS);

/**
 * Register one or more custom `AssetSpec` entries dynamically (e.g. from an
 * auto-discovered `EarthRegionPack`). Existing core specs are preserved unless
 * explicitly overridden by a pack spec.
 */
export function registerAssetSpecs(specs: Record<string, AssetSpec>): void {
  for (const [key, spec] of Object.entries(specs)) {
    const id = spec.id || key;
    const normalized: AssetSpec = { ...spec, id };
    const isNew = !(id in DEFAULT_ASSET_SPECS);
    DEFAULT_ASSET_SPECS[id] = normalized;
    if (isNew && !ALL_ASSET_IDS.includes(id)) {
      ALL_ASSET_IDS.push(id);
    }
  }
}

export function getRegisteredAssetIds(): readonly AssetId[] {
  return ALL_ASSET_IDS;
}

/**
 * Retrieve a registered `AssetSpec` or synthesize a safe default spec for an
 * ad-hoc contributor `.glb` filename so unknown asset IDs never crash the loader.
 */
export function getAssetSpec(id: AssetId): AssetSpec {
  const found = DEFAULT_ASSET_SPECS[id];
  if (found) return found;
  return {
    id,
    filename: `${id}.glb`,
    targetSize: 4.0,
    sizeAxis: 'max',
    pivot: 'bottom',
    yOffset: -0.25,
    rotY: 0,
    castShadow: true,
    receiveShadow: true,
    label: id.replace(/_/g, ' '),
    fallbackArchetype: 'rock',
    fallbackColor: 0x6b7280,
  };
}

/**
 * Default local pivot coordinates for assembling the articulated DuckRig
 * relative to a normalized 1.25-unit rubber duck facing +Z forward, +Y up.
 */
export const DEFAULT_DUCK_ATTACHMENTS: DuckWingAttachments = {
  wingLeftOffset: [0.4, 0.36, -0.02],
  wingRightOffset: [-0.4, 0.36, -0.02],
  wingScale: 1.0,
  feetOffset: [0.0, -0.04, -0.06],
  headOffset: [0.0, 0.66, 0.22],
};

export interface ManifestModelEntry {
  id: AssetId;
  url: string;
  spec: AssetSpec;
  presentInManifest: boolean;
  bbox?: ModelBoundingBox;
  triangles?: number;
  byteSize?: number;
  /** Optional relative scale multiplier from assets.json (1.0 = default targetSize). */
  scaleMultiplier?: number;
}

export interface ResolvedAssetManifest {
  entries: Record<string, ManifestModelEntry>;
  duckAttachments: DuckWingAttachments;
  loadedFromDisk: boolean;
}

/**
 * Convert any manifest path (`/models/foo.glb`, `models/foo.glb`, `foo.glb`, or `./packs/...`)
 * into a GitHub-Pages-safe relative URL.
 */
export function resolveModelUrl(filenameOrPath: string): string {
  const trimmed = filenameOrPath.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('./') && !trimmed.startsWith('./models/')) {
    return trimmed;
  }
  const cleaned = trimmed
    .replace(/^\.?\/*/, '')
    .replace(/^public\//, '')
    .replace(/^models\//, '');
  return `${MODELS_BASE_URL}${cleaned}`;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asPivot(value: unknown): PivotAlignment | undefined {
  if (value === 'bottom' || value === 'center' || value === 'waterline') {
    return value;
  }
  return undefined;
}

function asSizeAxis(value: unknown): 'max' | 'x' | 'y' | 'z' | undefined {
  if (value === 'max' || value === 'x' || value === 'y' || value === 'z') {
    return value;
  }
  return undefined;
}

function asVec3Tuple(value: unknown): [number, number, number] | undefined {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    return [value[0], value[1], value[2]];
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const x = asNumber(obj.x);
    const y = asNumber(obj.y);
    const z = asNumber(obj.z);
    if (x !== undefined && y !== undefined && z !== undefined) {
      return [x, y, z];
    }
  }
  return undefined;
}

function parseBbox(raw: unknown): ModelBoundingBox | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const min = asVec3Tuple(obj.min);
  const max = asVec3Tuple(obj.max);
  const size = asVec3Tuple(obj.size);
  const center = asVec3Tuple(obj.center);
  if (!min || !max) return undefined;
  return {
    min,
    max,
    size: size ?? [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: center ?? [
      (min[0] + max[0]) * 0.5,
      (min[1] + max[1]) * 0.5,
      (min[2] + max[2]) * 0.5,
    ],
  };
}

function extractRawEntries(
  json: unknown,
): Array<[string, Record<string, unknown>]> {
  if (!json || typeof json !== 'object') return [];

  if (Array.isArray(json)) {
    const out: Array<[string, Record<string, unknown>]> = [];
    for (const item of json) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const rawId =
        (typeof rec.id === 'string' && rec.id) ||
        (typeof rec.name === 'string' && rec.name) ||
        (typeof rec.filename === 'string' && rec.filename.replace(/\.glb$/i, '')) ||
        (typeof rec.file === 'string' && rec.file.replace(/\.glb$/i, '')) ||
        '';
      if (rawId) out.push([rawId, rec]);
    }
    return out;
  }

  const root = json as Record<string, unknown>;
  const container = root.models ?? root.assets ?? root;
  if (container !== root) {
    return extractRawEntries(container);
  }

  const out: Array<[string, Record<string, unknown>]> = [];
  for (const [key, val] of Object.entries(root)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      out.push([key, val as Record<string, unknown>]);
    }
  }
  return out;
}

function parseDuckAttachments(
  rawRecord: Record<string, unknown> | undefined,
  rootJson: unknown,
): DuckWingAttachments {
  const attachments: DuckWingAttachments = {
    wingLeftOffset: [...DEFAULT_DUCK_ATTACHMENTS.wingLeftOffset],
    wingRightOffset: [...DEFAULT_DUCK_ATTACHMENTS.wingRightOffset],
    wingScale: DEFAULT_DUCK_ATTACHMENTS.wingScale,
    feetOffset: [...DEFAULT_DUCK_ATTACHMENTS.feetOffset],
    headOffset: [...DEFAULT_DUCK_ATTACHMENTS.headOffset],
  };

  const sources: Array<Record<string, unknown>> = [];
  if (rootJson && typeof rootJson === 'object' && !Array.isArray(rootJson)) {
    const r = rootJson as Record<string, unknown>;
    if (r.duckAttachments && typeof r.duckAttachments === 'object') {
      sources.push(r.duckAttachments as Record<string, unknown>);
    }
    if (r.wingAttachments && typeof r.wingAttachments === 'object') {
      sources.push(r.wingAttachments as Record<string, unknown>);
    }
  }
  if (rawRecord) {
    sources.push(rawRecord);
    for (const nestedKey of [
      'wingAttachments',
      'wing_attachments',
      'attachments',
      'rig',
    ]) {
      const nested = rawRecord[nestedKey];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        sources.push(nested as Record<string, unknown>);
      }
    }
  }

  for (const src of sources) {
    const left =
      asVec3Tuple(src.wingLeftOffset) ??
      asVec3Tuple(src.wing_left_offset) ??
      asVec3Tuple(src.leftWingOffset) ??
      asVec3Tuple(src.left);
    const right =
      asVec3Tuple(src.wingRightOffset) ??
      asVec3Tuple(src.wing_right_offset) ??
      asVec3Tuple(src.rightWingOffset) ??
      asVec3Tuple(src.right);
    if (left) attachments.wingLeftOffset = left;
    if (right) attachments.wingRightOffset = right;
    if (left && !right) {
      attachments.wingRightOffset = [-Math.abs(left[0]), left[1], left[2]];
    }

    const scale = asNumber(src.wingScale) ?? asNumber(src.wing_scale);
    if (scale !== undefined && scale > 0) {
      attachments.wingScale = scale;
    }

    const feet = asVec3Tuple(src.feetOffset) ?? asVec3Tuple(src.feet_offset);
    if (feet) attachments.feetOffset = feet;

    const head = asVec3Tuple(src.headOffset) ?? asVec3Tuple(src.head_offset);
    if (head) attachments.headOffset = head;
  }

  return attachments;
}

/**
 * Merge entries from a manifest JSON URL into an existing `ResolvedAssetManifest`.
 * Supports arbitrary contributor pack asset IDs without requiring core manifest edits!
 */
export async function mergeManifestFromUrl(
  manifest: ResolvedAssetManifest,
  manifestUrl: string,
): Promise<{ loaded: boolean; duckRaw?: Record<string, unknown>; rootJson: unknown }> {
  let duckRaw: Record<string, unknown> | undefined;
  let rootJson: unknown = null;

  try {
    const response = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!response.ok) return { loaded: false, rootJson: null };

    rootJson = (await response.json()) as unknown;
    const rawPairs = extractRawEntries(rootJson);

    for (const [rawKey, rec] of rawPairs) {
      const normalizedKey = rawKey.replace(/\.glb$/i, '').trim();
      if (!normalizedKey) continue;

      if (normalizedKey === 'rubber_duck') {
        duckRaw = rec;
      }

      const base = manifest.entries[normalizedKey]?.spec ?? getAssetSpec(normalizedKey);
      const filename =
        (typeof rec.filename === 'string' && rec.filename) ||
        (typeof rec.file === 'string' && rec.file) ||
        (typeof rec.path === 'string' && rec.path) ||
        (typeof rec.url === 'string' && rec.url) ||
        base.filename;

      const rotY =
        asNumber(rec.rotY) ??
        asNumber(rec.rotationY) ??
        asNumber(rec.rot_y) ??
        base.rotY;
      const yOffset =
        asNumber(rec.yOffset) ??
        asNumber(rec.offsetY) ??
        asNumber(rec.y_offset) ??
        base.yOffset;
      const targetSize =
        asNumber(rec.targetSize) ?? asNumber(rec.target_size) ?? base.targetSize;
      const pivot = asPivot(rec.pivot) ?? base.pivot;
      const sizeAxis = asSizeAxis(rec.sizeAxis ?? rec.size_axis) ?? base.sizeAxis;

      const spec: AssetSpec = {
        ...base,
        id: normalizedKey,
        filename,
        rotY,
        yOffset,
        targetSize,
        pivot,
        sizeAxis,
      };

      if (!(normalizedKey in DEFAULT_ASSET_SPECS)) {
        registerAssetSpecs({ [normalizedKey]: spec });
      }

      manifest.entries[normalizedKey] = {
        id: normalizedKey,
        url: base.url ?? resolveModelUrl(filename),
        spec,
        presentInManifest: true,
        bbox: parseBbox(rec.bbox ?? rec.boundingBox),
        triangles:
          asNumber(rec.triangles) ??
          asNumber(rec.triangleCount) ??
          asNumber(rec.tri_count),
        byteSize:
          asNumber(rec.byteSize) ??
          asNumber(rec.bytes) ??
          asNumber(rec.fileSize) ??
          asNumber(rec.sizeBytes),
        scaleMultiplier: asNumber(rec.scaleMultiplier),
      };
    }

    return { loaded: true, duckRaw, rootJson };
  } catch {
    return { loaded: false, rootJson: null };
  }
}

/**
 * Fetches and normalizes `./models/assets.json` (plus any extra pack manifest URLs),
 * falling back cleanly to `DEFAULT_ASSET_SPECS` when manifests are absent or partial.
 */
export async function loadAssetManifest(
  manifestUrl: string = MANIFEST_URL,
  extraManifestUrls: readonly string[] = [],
): Promise<ResolvedAssetManifest> {
  const entries: Record<string, ManifestModelEntry> = {};
  for (const id of ALL_ASSET_IDS) {
    const spec = { ...getAssetSpec(id) };
    entries[id] = {
      id,
      url: spec.url ?? resolveModelUrl(spec.filename),
      spec,
      presentInManifest: false,
    };
  }

  const manifest: ResolvedAssetManifest = {
    entries,
    duckAttachments: {
      wingLeftOffset: [...DEFAULT_DUCK_ATTACHMENTS.wingLeftOffset],
      wingRightOffset: [...DEFAULT_DUCK_ATTACHMENTS.wingRightOffset],
      wingScale: DEFAULT_DUCK_ATTACHMENTS.wingScale,
      feetOffset: [...DEFAULT_DUCK_ATTACHMENTS.feetOffset],
      headOffset: [...DEFAULT_DUCK_ATTACHMENTS.headOffset],
    },
    loadedFromDisk: false,
  };

  const primary = await mergeManifestFromUrl(manifest, manifestUrl);
  if (primary.loaded) {
    manifest.loadedFromDisk = true;
    manifest.duckAttachments = parseDuckAttachments(
      primary.duckRaw,
      primary.rootJson,
    );
  }

  for (const extraUrl of extraManifestUrls) {
    const res = await mergeManifestFromUrl(manifest, extraUrl);
    if (res.loaded) {
      manifest.loadedFromDisk = true;
    }
  }

  return manifest;
}
