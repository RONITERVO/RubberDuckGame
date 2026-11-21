# River Ducker: Mini-Earth World Tour 🦆🌍

> Ride whitewater rapids, plunge down waterfalls, dive beneath ancient Torii gates and obsidian arches, explore bioluminescent cave shortcuts, and steer through real physical river forks across a living **Shared Mini-Earth**!

Repository: **[https://github.com/RONITERVO/RubberDuckGame](https://github.com/RONITERVO/RubberDuckGame)**  
Live Game (GitHub Pages): **[https://ronitervo.github.io/RubberDuckGame/](https://ronitervo.github.io/RubberDuckGame/)**

### One-Click GitHub Pages Setup
1. Open **[Repository Settings -> Pages](https://github.com/RONITERVO/RubberDuckGame/settings/pages)**.
2. Under **Build and deployment -> Source**, choose **GitHub Actions** and save.
3. Every push to `main` (or clicking **Run workflow** in [Actions](https://github.com/RONITERVO/RubberDuckGame/actions/workflows/deploy.yml)) automatically runs `npm ci`, `npm run typecheck`, `npm run build`, and deploys `dist/` to **[https://ronitervo.github.io/RubberDuckGame/](https://ronitervo.github.io/RubberDuckGame/)**.

---

## Highlights

- **Shared Physical Mini-Earth (`src/earth/`):**
  - Real planetary sphere (`MINI_EARTH_RADIUS = 1600` world units, `1° ≈ 27.93u`, circumference `~10,053u`) where all regions, rivers, ocean straits, forks/confluences (`EarthJunction`), and landmarks live at genuine `(lat, lng, elevation)` coordinates.
  - **Floating-Origin Local Tangent Plane (ENU) Projection:** Projects Earth coordinates into float32-safe Three.js space (`+X` East, `+Y` Up, `+Z` South / `-Z` North) with subtle true planetary horizon curvature (`-dist² / (2R)`).
  - **O(1) Spatial Streaming (`GeoSpatialIndex`):** `10° × 10°` lat/lng spatial grid wrapping cleanly across the `±180°` antimeridian so Mini-Earth scales effortlessly from 6 to 1,000+ community regions at 60 FPS.
  - **Physical River Forks & Confluences:** Steer LEFT or RIGHT at physical confluences to branch seamlessly onto connected waterways across continents — or lock onto any single regional circuit from the interactive **3D Mini-Earth Globe**.
- **6 Connected Launch Regions (`src/world/packs/`):**
  - 🌲 **Cascade Sunlit Creek** (Oregon, USA) — Emerald Douglas firs, waterfalls, wooden waterwheel mills & mossy rapids
  - 🌸 **Kyoto Sakura Stream** (Kyoto, Japan) — Drifting cherry blossoms, vermilion Torii gates, bamboo groves, stone lanterns & calico koi
  - 🌴 **Amazon Monsoon Rapids** (Amazonas, Brazil) — Monsoon rainstorms, sheet lightning, rain ripples, jungle palms, ruins & giant Victoria lily pads
  - 🏜️ **Red Rock Canyon Rapids** (Utah, USA) — Golden-hour sunset, steep striated terracotta sandstone walls, natural arches & saguaro cacti
  - 🌌 **Aurora Glacier Fjord** (Tromsø & Svalbard, Norway) — Polar twilight under dancing emerald-violet Aurora Borealis, falling snow, ice arches & penguins
  - 🌋 **Volcanic Basalt Gorge** (Reykjanes, Iceland) — Volcanic dusk, hexagonal basalt columns, glowing magma fissures, obsidian arches & rising embers
- **Zero-Core-Edit Contributor Architecture:**
  - Auto-discovers every drop-in pack in `src/world/packs/**/index.ts` via Vite `import.meta.glob`.
  - Data-driven terrain shaders (`GroundShaderParams`), weather particles (`WeatherParams`), caves (`CaveVisualParams`), procedural WebAudio scales (`AudioScaleParams`), and open `AssetId = string` with automatic archetype fallbacks.
  - See [CONTRIBUTING_TRACKS.md](./CONTRIBUTING_TRACKS.md) to add a new region in one folder!

---

## Quick Start

```bash
npm install
npm run dev
```

### Build & Typecheck

```bash
npm run typecheck
npm run build
```

---

## Controls

| Action | Keyboard | Touch / Mobile |
| :--- | :--- | :--- |
| **Steer / Choose Fork** | `A` / `D` or `←` / `→` | Drag horizontally |
| **Jump / Wing Flap** | `Space` / `W` / `↑` | Tap or Swipe Up |
| **Dive Underwater** | Hold `S` / `↓` / `Shift` | Hold Dive button or Swipe Down |
| **Pause** | `Esc` / `P` | Pause button |
| **Mini-Earth Globe** | Globe selector on Title / Pause | Tap Globe icon |

---

## Architecture Overview

```text
src/
├── earth/                 # Shared Physical Mini-Earth planetary engine
│   ├── coords.ts          # Spherical math + Floating-Origin ENU projection
│   ├── schema.ts          # Open data-driven zone, waterway, junction, weather & shader params
│   ├── spatialIndex.ts    # 10°×10° antimeridian-safe O(1) GeoSpatialIndex
│   └── earthWorld.ts      # Auto-discovering planetary spline compiler & world graph
├── world/packs/           # Zero-core-edit drop-in region packs (auto-discovered!)
│   ├── pnw-creek/
│   ├── kyoto-sakura/
│   ├── amazon-monsoon/
│   ├── red-canyon/
│   ├── arctic-fjord/
│   └── volcanic-gorge/
├── assets/                # Open GLB manifest + lazy per-region streaming + archetype fallbacks
├── core/                  # River spline, duck physics & hydrodynamics, chase camera
├── render/                # Custom GLSL water, data-driven terrain, sky/aurora, weather particles
├── gameplay/              # Obstacle spawner, collectibles, wildlife
├── audio/                 # 100% procedural WebAudio water, thunder, wind & musical chimes
└── ui/                    # Interactive 3D Mini-Earth Globe & responsive HUD
```
