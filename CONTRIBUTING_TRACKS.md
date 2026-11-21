# Contributing to Mini-Earth (`src/world/packs/`) 🌍🦆

**River Ducker: Mini-Earth World Tour** runs on a **Zero-Core-Edit Contributor Plugin Architecture** anchored to a real, physically connected **Shared Mini-Earth** (`src/earth/*`).

You can add an entire brand-new continent, mountain valley, canyon gorge, river fork, persistent landmark, custom weather mood, musical scale, and custom 3D `.glb` assets by dropping **ONE folder** into `src/world/packs/<your-pack-id>/index.ts` — with **ZERO edits to any core engine, shader, audio, or registry file**!

---

## How Shared Mini-Earth Works

1. **One Shared Planetary Coordinate System (`src/earth/coords.ts`):**
   - Mini-Earth is a real 3D sphere of radius **`MINI_EARTH_RADIUS = 1600`** Duck Scale world units (`1.0u = 10 cm`; `1°` arc ≈ `27.93u`, planetary circumference ≈ `10,053u`).
   - Every region zone (`EarthRegionZone`), physical river/strait (`EarthWaterway`), fork/confluence (`EarthJunction`), and persistent landmark (`EarthLandmark`) lives at real **`(lat, lng, elevation)`** coordinates on this single shared planet.
2. **Floating-Origin ENU Projection (`LocalTangentFrame`):**
   - As the duck kayaks across continents and oceans, the engine continuously projects nearby Earth coordinates into a crisp float32-safe Three.js **Local Tangent Plane** (`+X` East, `+Y` Up, `+Z` South / `-Z` North) with subtle true planetary horizon curvature (`-dist² / (2R)`).
   - There are **no teleports** and **no 1D disconnected fake tracks** — crossing a confluence (`EarthJunction`) physically transitions onto the exact connected waterway sharing that `(lat, lng, elevation)`.
3. **O(1) Spatial Streaming (`src/earth/spatialIndex.ts`):**
   - Mini-Earth partitions the globe into **`10° × 10°` lat/lng spatial cells** wrapping cleanly across the `±180°` Pacific antimeridian and poles.
   - Runtime queries (`queryZonesAt`, `queryWaterwaysNear`, `queryLandmarksNear`, `queryJunctionsNear`) are strictly **O(local)** — whether the globe holds 6 packs or 1,000 community packs!
4. **Auto-Discovery & Zero Closed Unions (`src/earth/earthWorld.ts`):**
   - Vite automatically discovers every `src/world/packs/**/index.ts` pack at boot via `import.meta.glob`.
   - **`AssetId = string`**: custom `.glb` assets self-register via `pack.assets` with automatic procedural fallbacks (`fallbackArchetype` + `fallbackColor`).
   - **Data-Driven Shaders, Weather, Caves & Audio**: `GroundShaderParams`, `CaveVisualParams`, `WeatherParams`, and `AudioScaleParams` are continuous open parameter objects — no GLSL switches or hardcoded enum tables to edit!

---

## Add a New Region Pack in 1 Folder (Zero Core Edits!)

Create `src/world/packs/nile-oasis/index.ts` exporting an `EarthRegionPack`:

```ts
import type { EarthRegionPack } from '../../../earth/schema';

export const nileOasisPack: EarthRegionPack = {
  id: 'nile-oasis',
  version: '1.0.0',
  author: 'Your GitHub Handle',

  // Optional: declare custom .glb assets placed in public/models/ (or reuse the 37 built-in models!)
  assets: {
    sandstone_obelisk: {
      id: 'sandstone_obelisk',
      filename: 'sandstone_obelisk.glb',
      targetSize: 12.0,
      sizeAxis: 'y',
      pivot: 'bottom',
      yOffset: -0.4,
      rotY: 0,
      castShadow: true,
      receiveShadow: true,
      label: 'Carved Nile Sandstone Obelisk',
      fallbackArchetype: 'pillar', // Automatic procedural 3D fallback if GLB is loading/absent!
      fallbackColor: 0xd9a85b,
    },
  },

  // Spatial geographic biome zone (smoothly blends with neighboring zones automatically!)
  zones: [
    {
      id: 'nile-oasis',
      name: 'Nile Golden Cataracts',
      region: 'Aswan Valley',
      country: 'Egypt',
      subtitle: 'Sunlit sandstone obelisks, palm islands & emerald desert rapids',
      icon: '🐪',
      accentColor: '#facc15',
      globeColor: '#eab308',
      difficulty: 2,
      centerLat: 24.08,
      centerLng: 32.89,
      radiusDeg: 18,
      falloffDeg: 22,
      priority: 10,

      riverProfile: {
        widthMin: 10.5,
        widthMax: 17.5,
        depthMin: 3.0,
        depthMax: 5.4,
        curveAmplitude: 1.15,
        curveFrequency: 1.0,
        rapidsBase: 0.34,
        slopeBase: -0.05,
        waterfallSpacing: 230,
        waterfallDropMin: 9.5,
        waterfallDropMax: 14.0,
        caveSpacing: 235,
        bankSteepness: 1.4,
        bankHeightScale: 1.25,
        canyonWallFactor: 0.45,
      },

      waterStyle: {
        shallowColor: 0x26bfa6,
        deepColor: 0x0b4359,
        foamColor: 0xfff8eb,
        causticColor: 0xffe28a,
        causticIntensity: 1.25,
        clarity: 0.88,
        reflectivity: 1.15,
        flowSpeedMult: 1.05,
        underwaterFogColor: 0x0f4654,
        underwaterFogNear: 4.5,
        underwaterFogFar: 32.0,
        rainRippleIntensity: 0.0,
        geothermalGlow: 0.0,
      },

      atmosphere: {
        timeOfDay: 'golden',
        skyZenith: 0x1e5799,
        skyHorizon: 0xffd28e,
        skyGround: 0x6e4720,
        sunColor: 0xffe49e,
        sunIntensity: 2.55,
        sunDirection: [0.58, 0.62, 0.52],
        hemiSky: 0xffe2ad,
        hemiGround: 0x78522b,
        hemiIntensity: 1.15,
        fogColor: 0xf5cf98,
        fogNear: 55,
        fogFar: 210,
        iblTop: 0x3b78b8,
        iblHorizon: 0xffd89e,
        iblBottom: 0x664522,
        hasAurora: false,
        hasLightning: false,
        hasVolcanicGlow: false,
        exposure: 1.08,
      },

      // 100% open data-driven weather parameters
      weather: {
        id: 'nile_shimmer',
        label: 'Golden Oasis Thermal',
        icon: '☀️',
        particleShape: 'dust',
        intensity: 0.65,
        windStrength: 0.5,
        mistDensity: 0.55,
        particleColor: 0xffe09e,
        secondaryParticleColor: 0xffb35c,
        rainRipples: 0.0,
        lightningChance: 0.0,
        steamDensity: 0.08,
        gravity: -0.05,
        driftSpeed: 1.1,
      },

      // 100% open data-driven terrain shader parameters (no GLSL edits!)
      groundStyle: {
        primaryColor: 0xd49b54,
        secondaryColor: 0xa67132,
        shoreColor: 0x734d22,
        bedShallowColor: 0x9c723e,
        bedDeepColor: 0x243840,
        rockTint: 0xba8443,
        mossTint: 0x4b8f3b,
        strataIntensity: 0.65,
        strataScale: 0.72,
        snowCoverage: 0.0,
        iceReflectivity: 0.0,
        mossCoverage: 0.25,
        petalFlecks: 0.0,
        emissiveColor: 0x000000,
        emissiveIntensity: 0.0,
        roughness: 0.85,
        pebbleScale: 1.1,
      },

      // 100% open data-driven cave visual parameters
      caveStyle: {
        wallColor: 0x9e713c,
        floorColor: 0x47331a,
        glowColor: 0xffd25e,
        glowIntensity: 1.0,
        skylightColor: 0xffe8a3,
        roughness: 0.84,
        crystalAssetId: 'crystal_cluster',
      },

      scenery: {
        bankTrees: [
          { assetId: 'jungle_palm', weight: 0.72, scaleMin: 0.9, scaleMax: 1.35, yEmbed: -0.45 },
          { assetId: 'sandstone_obelisk', weight: 0.28, scaleMin: 0.85, scaleMax: 1.25, yEmbed: -0.4 },
        ],
        bankFoliage: [
          { assetId: 'cattail_reeds', weight: 0.65, scaleMin: 0.85, scaleMax: 1.3, yEmbed: -0.25 },
          { assetId: 'fern_cluster', weight: 0.35, scaleMin: 0.8, scaleMax: 1.2, yEmbed: -0.2 },
        ],
        bankRocks: [
          { assetId: 'red_rock_pillar', weight: 0.6, scaleMin: 0.8, scaleMax: 1.25, yEmbed: -0.45 },
          { assetId: 'mossy_boulder_a', weight: 0.4, scaleMin: 0.8, scaleMax: 1.2, yEmbed: -0.45 },
        ],
        landmarks: [
          { assetId: 'temple_ruin', placement: 'bank_left', spacing: 74, scale: 1.2, yOffset: -0.25 },
          { assetId: 'stone_footbridge', placement: 'over_river', spacing: 115, scale: 1.18, yOffset: 0.45 },
        ],
        treeDensity: 0.95,
        foliageDensity: 0.9,
        rockDensity: 1.1,
        innerTreeClearance: 2.4,
      },

      // Mix your custom assets with the 10 shared river obstacle assets!
      obstacles: {
        boulderAssets: ['red_rock_pillar', 'sunken_canoe', 'floating_barrel', 'river_snag_stump'],
        diveArchAssets: ['stone_footbridge', 'red_rock_arch', 'willow_overhang'],
        jumpLogAssets: ['beaver_dam', 'mossy_step_stones', 'cattail_reeds', 'giant_lily_pad'],
        obstacleDensity: 1.05,
        chuteBias: 0.48,
      },

      wildlife: {
        underwaterAsset: 'river_trout',
        bankCritterAsset: 'duckling',
        hasDragonflies: true,
        hasFrogs: true,
        hasFireflies: false,
      },

      // 100% open data-driven WebAudio musical scale & soundscape
      audioProfile: {
        scaleIntervals: [0, 1, 4, 5, 7, 8, 11, 12, 13, 16, 19], // Hijaz / Phrygian Dominant!
        baseMidi: 69,
        timbre: 'koto',
        riverFilterHz: 820,
        rapidsGain: 1.08,
        rainIntensity: 0.0,
        thunderEnabled: false,
        windIntensity: 0.48,
        windPitch: 0.85,
        geothermalRumble: 0.0,
        ambientTag: 'Nile Cataract Rapids & Oasis Breeze',
      },
    },
  ],

  // Physical planetary junctions (share existing junction IDs like 'junc-amazon-fork' to attach!)
  junctions: [
    { id: 'junc-nile-head', name: 'Aswan High Cataract', lat: 22.8, lng: 31.8, elevation: 14, kind: 'headwaters', regionId: 'nile-oasis' },
    { id: 'junc-nile-fork', name: 'Cairo Nile Delta Fork', lat: 29.8, lng: 31.2, elevation: 0, kind: 'delta', regionId: 'nile-oasis' },
  ],

  // Physical waterways on the R=1600 sphere (connect into any existing junction!)
  waterways: [
    {
      id: 'ww-nile-oasis',
      name: 'Nile Golden Cataracts',
      regionId: 'nile-oasis',
      fromJunctionId: 'junc-nile-head',
      toJunctionId: 'junc-nile-fork',
      isPrimaryForRegion: true,
      difficulty: 2,
      subtitle: 'Carving north past ancient temples & obelisks to the Nile Delta',
      waypoints: [
        { lat: 22.8, lng: 31.8, elevation: 14, width: 14.0, depth: 4.0, rapids: 0.3 },
        { lat: 25.4, lng: 32.7, elevation: 8, width: 12.2, depth: 4.2, rapids: 0.55, isWaterfall: true, waterfallDrop: 10.5 },
        { lat: 29.8, lng: 31.2, elevation: 0, width: 15.6, depth: 4.6, rapids: 0.28 },
      ],
    },
    {
      id: 'ww-strait-nile-kyoto',
      name: 'Silk Road Monsoon Current',
      regionId: 'nile-oasis',
      fromJunctionId: 'junc-nile-fork',
      toJunctionId: 'junc-kyoto-head', // Connects directly into Kyoto's real physical junction!
      isConnector: true,
      speedBoost: 1.8,
      difficulty: 2,
      subtitle: 'Eastbound current flowing across Asia toward Kyoto Sakura Stream',
      waypoints: [
        { lat: 29.8, lng: 31.2, elevation: 0 },
        { lat: 28.0, lng: 78.0, elevation: 7 },
        { lat: 33.0, lng: 131.5, elevation: 14 },
      ],
    },
  ],

  // Persistent world-space landmarks visible to ANY nearby river!
  landmarks: [
    {
      id: 'lm-nile-luxor-obelisk',
      assetId: 'sandstone_obelisk',
      lat: 25.42,
      lng: 32.72,
      elevationOffset: 0.4,
      scale: 1.4,
      placement: 'ground',
      waterwayId: 'ww-nile-oasis',
    },
  ],
};

export default nileOasisPack;
```

---

## Built-In Shared 3D Asset Library (37 Models Ready to Use!)

Every pack can freely mix and match any of the **37 normalized PBR `.glb` assets** in `public/models/`:

- **10 Shared River Obstacles & Details:** `beaver_dam`, `stone_footbridge`, `sunken_canoe`, `willow_overhang`, `river_snag_stump`, `floating_barrel`, `cattail_reeds`, `mossy_step_stones`, `waterwheel_mill`, `crystal_cluster`
- **Core Forest & Wildlife:** `mossy_boulder_a`, `mossy_boulder_b`, `fallen_log_arch`, `driftwood_roots`, `pine_tree`, `fern_cluster`, `river_trout`, `duckling`
- **Regional Landmarks & Flora:** `torii_gate`, `sakura_tree`, `bamboo_cluster`, `stone_lantern`, `koi_fish`, `jungle_palm`, `temple_ruin`, `giant_lily_pad`, `red_rock_pillar`, `red_rock_arch`, `saguaro_cactus`, `iceberg_spire`, `ice_arch`, `penguin`, `basalt_columns`, `obsidian_arch`, `lava_rock`

### Asset Guidelines for Custom `.glb` Models
- **World Scale (Duck Scale):** `1.0 world unit = 10 cm`; normalized models face `+Z` forward, `+Y` up, and arches/bridges span along `X`.
- **Budget:** Keep props `<= 4,500` triangles and `512×512` PBR textures (`<= 420 KB` per `.glb`).
- **Automatic Fallbacks:** Specify `fallbackArchetype` (`'tree' | 'rock' | 'arch' | 'pillar' | 'foliage' | 'fish' | 'critter' | 'log' | 'pad' | 'landmark' | 'boat' | 'crystal'`) + `fallbackColor` so your pack works immediately even before `.glb` files finish loading.

---

## Verify Your Pack

```bash
npm run typecheck
npm run build
```

`earthWorld.validateWorld()` automatically verifies that every waterway's start & end coordinates match its `EarthJunction`s and that all zones form a connected planetary network!
