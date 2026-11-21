#!/usr/bin/env python3
"""
River Ducker: Mini-Earth World Tour — Shared River Obstacle & Detail Meshy v2 PBR Pipeline
Generates, downloads, optimizes, inspects, and merges 10 new shared river obstacle & detail
PBR .glb models into public/models/assets.json while preserving ALL 27 existing models
(10 v1 + 17 v2) and duckAttachments untouched (total: 37 models).

Security:
  - Reads MESHY_API_KEY from environment or project .env file.
  - Never prints, logs, echoes, or persists the API key anywhere.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import sys
import threading
import time
from pathlib import Path
from typing import Any

# Reuse proven glTF 2.0 binary parsing, texture compression, rotation, and Meshy API helpers
sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_world_assets as gwa

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = PROJECT_ROOT / "public" / "models"
DEFAULT_CACHE_DIR = PROJECT_ROOT / ".cache" / "meshy_shared_cache"

# Strict mobile size budget: <= 415,000 bytes (guarantees both <= 420 KB and <= 420 KiB)
MAX_SHARED_GLB_BYTES = 415_000

# 10 New Shared River Obstacle & Detail PBR .glb Assets
SHARED_OBSTACLE_SPECS: list[dict[str, Any]] = [
    {
        "id": "beaver_dam",
        "filename": "beaver_dam.glb",
        "region": "shared",
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3800,
        "max_tex_size": 512,
        "expected_major_axis": "x",
        "prompt": (
            "Chunky stylized-realistic rustic river beaver dam wall spanning horizontally from left to "
            "right, built from thick rounded cylindrical gnawed wooden logs, stout peeled tree branches, "
            "and chunky river stones tightly stacked and woven together into a low solid horizontal "
            "wood-and-mud embankment barrier, blunt chewed log ends jutting out cleanly along the front "
            "and thick matted sticks filling the lower base so nothing can pass beneath, rounded log "
            "crest on top smooth enough to jump over, strictly thick solid sculpted timber cylinders "
            "with no paper-thin spikes, no water, no ground plane"
        ),
        "texture_prompt": (
            "Weathered wet dark umber bark logs and pale freshly-chewed creamy-tan birch and cedar log "
            "ends packed together with damp dark river mud, mossy pebbles, and lush emerald creek moss "
            "tufts along the upper log crest, photorealistic stylized woodland river PBR material"
        ),
        "targetSize": 7.2,
        "sizeAxis": "x",
        "pivot": "center",
        "yOffset": -0.15,
        "rotY": 0.0,
    },
    {
        "id": "stone_footbridge",
        "filename": "stone_footbridge.glb",
        "region": "shared",
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 4000,
        "max_tex_size": 512,
        "expected_major_axis": "x",
        "prompt": (
            "Charming weathered mossy cobblestone arched pedestrian footbridge spanning wide horizontally "
            "from left to right, graceful semicircular arched stone vault with low curved cobblestone "
            "parapet walls along the top edges and a wide completely open empty rounded archway underneath "
            "the center so a river flows freely beneath, frontal elevation view facing straight forward, "
            "strictly NO floor, NO ground plane, and NO bottom slab connecting the two bridge piers "
            "underneath, single standalone stone bridge arch"
        ),
        "texture_prompt": (
            "Weathered warm grey and tan hand-laid rustic river cobblestones and cut granite arch voussoir "
            "stones with aged mortar joints, rich emerald-green velvety moss growing thickly along the "
            "stone parapet coping and damp lower arch piers, authentic picturesque stone bridge PBR"
        ),
        "targetSize": 12.2,
        "sizeAxis": "x",
        "pivot": "center",
        "yOffset": 0.15,
        "rotY": 0.0,
    },
    {
        "id": "sunken_canoe",
        "filename": "sunken_canoe.glb",
        "region": "shared",
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3600,
        "max_tex_size": 512,
        "expected_major_axis": "z",
        "prompt": (
            "Weathered rustic wooden cedar canoe half-submerged and wedged at a dramatic upward tilt "
            "against two smooth mossy river boulders, open hollow curved wooden canoe hull with wooden "
            "gunwale ribs, cross thwarts, and weathered prow jutting diagonally upward, single solid "
            "unified obstacle cluster with the river stones firmly supporting the tilted canoe hull, "
            "no water plane, no ground base"
        ),
        "texture_prompt": (
            "Aged sun-bleached weathered cedar wood canoe planks with faded peeling forest-green and "
            "vintage terracotta paint along the gunwales, dark wet waterlogged lower hull resting "
            "against damp slate-grey river boulders capped with vibrant emerald moss, photorealistic "
            "woodland creek PBR material"
        ),
        "targetSize": 4.8,
        "sizeAxis": "max",
        "pivot": "bottom",
        "yOffset": -0.35,
        "rotY": 0.0,
    },
    {
        "id": "willow_overhang",
        "filename": "willow_overhang.glb",
        "region": "shared",
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 4000,
        "max_tex_size": 512,
        "expected_major_axis": "x",
        "prompt": (
            "Single continuous symmetrical gnarled mossy weeping-willow tree arch bridge spanning wide "
            "horizontally from left to right, thick twisted natural willow wood arch anchored at both "
            "the far left and far right ends and bowing high upward across the middle like a natural "
            "tree archway, lush short sculpted green weeping willow foliage leaf drapes hanging neatly "
            "along the upper curved branch crown while keeping the entire wide lower center archway "
            "completely open and clear underneath so water flows freely through, strictly NO floor, "
            "NO ground plane, single connected overhanging tree arch"
        ),
        "texture_prompt": (
            "Deeply furrowed weathered grey-brown weeping willow bark encrusted with lush chartreuse "
            "forest moss along the upper arched limb, vibrant sunlit lime-green and soft emerald weeping "
            "willow foliage garlands catching warm river light, stylized-realistic woodland PBR material"
        ),
        "targetSize": 11.8,
        "sizeAxis": "x",
        "pivot": "center",
        "yOffset": 0.22,
        "rotY": 0.0,
    },
    {
        "id": "river_snag_stump",
        "filename": "river_snag_stump.glb",
        "region": "shared",
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3600,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Dramatic upturned weathered dead river tree snag stump jutting diagonally upward at a "
            "35-degree angle with gnarled splintered trunk wood and thick splayed bleached tree roots "
            "flaring outward around the heavy base, sculptural rugged deadwood river hazard silhouette, "
            "single solid monolithic snag stump, no floating twigs, no water, no ground plane"
        ),
        "texture_prompt": (
            "Sun-bleached silvery-tan weathered driftwood bark and cracked pale exposed deadwood "
            "splinters along the upper jagged snag, transitioning into dark wet waterlogged espresso "
            "wood and dark emerald river moss near the lower splayed root crown, realistic river PBR"
        ),
        "targetSize": 4.4,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.4,
        "rotY": 0.0,
    },
    {
        "id": "floating_barrel",
        "filename": "floating_barrel.glb",
        "region": "shared",
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 2800,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Single isolated upright rustic weathered wooden oak cask barrel standing vertically, "
            "classic bulging curved oak wood staves bound tightly by four sturdy iron metal hoop bands "
            "with rivets, recessed planked wooden circular top lid with a small wooden cork bung plug, "
            "clean flat circular bottom with strictly NO stand, NO wooden rack, NO cradle, NO chocks, "
            "NO pedestal, and NO ground plane, standalone rustic oak barrel only"
        ),
        "texture_prompt": (
            "Weathered river-soaked warm golden-brown and dark water-stained oak barrel staves with deep "
            "wood plank grain, aged dark corroded iron hoop bands with rich burnt-orange rust patina and "
            "wet glossy river sheen along the lower half, stylized-realistic outdoor PBR material"
        ),
        "targetSize": 2.3,
        "sizeAxis": "y",
        "pivot": "waterline",
        "yOffset": -0.18,
        "rotY": 0.0,
    },
    {
        "id": "cattail_reeds",
        "filename": "cattail_reeds.glb",
        "region": "shared",
        "role": "foliage",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3200,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Lush dense river shoreline cluster of tall creek cattails and arching green water reeds "
            "growing upright from a compact flat base clump, 7 sturdy vertical cattail stalks topped "
            "with plump velvety cylindrical cattail seed-head spikes surrounded by thick gracefully "
            "curving sword-like reed blades fanning outward, clean stylized-realistic game foliage "
            "silhouette with solid thick blades, no pot, no dirt block, no water plane"
        ),
        "texture_prompt": (
            "Rich velvety dark cocoa-brown cattail seed heads atop vibrant fresh chartreuse and deep "
            "emerald-green glossy marsh reed blades, natural damp creek sheen near the lower stems, "
            "crisp botanical nature PBR material"
        ),
        "targetSize": 3.8,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.25,
        "rotY": 0.0,
    },
    {
        "id": "mossy_step_stones",
        "filename": "mossy_step_stones.glb",
        "region": "shared",
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3400,
        "max_tex_size": 512,
        "expected_major_axis": "x",
        "prompt": (
            "Organic gently curving horizontal row of 4 chunky broad flat-topped water-worn granite "
            "river stepping stones nestled closely touching side by side from left to right, thick "
            "rounded pillow-like granite cobble boulders of varied organic sizes fused cleanly where "
            "they touch with lush cushions of velvety forest moss wedged in the stone crevices, "
            "strictly NO flat ground plate, NO puddle disc, NO base sheet, and NO thin rim skirt around "
            "the stones, only the chunky 3D granite boulders touching each other"
        ),
        "texture_prompt": (
            "Smooth water-worn speckled warm grey and damp slate river granite stepping stones with "
            "glossy wet dark lower sides and lighter dry flat tops, accented with rich emerald and "
            "bright chartreuse velvety moss pillows tucked cleanly along the stone rims and gaps, "
            "photorealistic creek rock PBR material"
        ),
        "targetSize": 5.8,
        "sizeAxis": "x",
        "pivot": "bottom",
        "yOffset": -0.22,
        "rotY": 0.0,
    },
    {
        "id": "waterwheel_mill",
        "filename": "waterwheel_mill.glb",
        "region": "shared",
        "role": "foliage",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 4000,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Charming weathered wooden creekside waterwheel mounted upright against a sturdy mossy "
            "cobblestone stone pier with a rustic timber frame overhang, large circular spoked wooden "
            "paddle wheel with wooden buckets around the outer rim and sturdy oak hub axle, picturesque "
            "riverbank mill landmark structure, single solid unified monument, no water, no ground plane"
        ),
        "texture_prompt": (
            "Aged damp dark weathered oak and warm cedar timber waterwheel spokes and wet glossy paddle "
            "blades tinged with bright green creek algae, mounted against rugged mossy grey-tan river "
            "stone masonry pier with lush emerald moss cushions and weathered cedar shingles, rich PBR"
        ),
        "targetSize": 8.5,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.45,
        "rotY": 0.0,
    },
    {
        "id": "crystal_cluster",
        "filename": "crystal_cluster.glb",
        "region": "shared",
        "role": "foliage",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 2800,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Dramatic cluster of 7 sharp hexagonal faceted quartz crystal prisms radiating upward and "
            "outward at graceful angles from a compact dark cavern stone matrix base, crisp geometric "
            "six-sided crystal spires terminating in clean pyramid points of varying heights, luminous "
            "subterranean grotto crystal formation, single solid watertight mesh, no floating shards, "
            "no ground plane"
        ),
        "texture_prompt": (
            "Luminous glowing translucent-looking turquoise, electric aquamarine, and bright cyan-white "
            "crystalline quartz prisms with glossy specular crystal facets and subtle sapphire internal "
            "depth shading, anchored in a dark wet charcoal-slate cave rock base matrix, magical PBR"
        ),
        "targetSize": 3.4,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.25,
        "rotY": 0.0,
    },
]

MANIFEST_LOCK = threading.Lock()


def optimize_shared_glb(raw_glb: Path, final_glb: Path, spec: dict[str, Any]) -> dict[str, Any]:
    """
    Optimize GLB textures so the final binary GLB is guaranteed <= MAX_SHARED_GLB_BYTES (<= 415 KB)
    and aligned to its expected major axis ('x' for arches/barriers, 'z' for canoe).
    """
    max_dim = spec.get("max_tex_size", 512)
    tiers = [
        (max_dim, max_dim, 3, 2),
        (max_dim, max_dim, 4, 4),
        (max_dim, 384, 5, 5),
        (max_dim, 384, 6, 6),
        (384, 256, 6, 7),
        (256, 256, 7, 8),
    ]
    meta: dict[str, Any] = {}
    for base_dim, aux_dim, base_q, aux_q in tiers:
        meta = gwa.optimize_glb_textures(
            raw_glb,
            final_glb,
            max_dim=base_dim,
            aux_max_dim=aux_dim,
            jpeg_quality=base_q,
            aux_jpeg_quality=aux_q,
        )
        if meta["bytes"] <= MAX_SHARED_GLB_BYTES:
            break

    expected_axis = spec.get("expected_major_axis", "")
    sx, _sy, sz = meta["bbox"]["size"]
    if expected_axis == "x" and sz > sx * 1.12:
        gwa.log(f"[{spec['id']}] Rotating GLB 90 deg around Y so wide span aligns with X ({sz:.3f} -> X)")
        gwa.rotate_glb_vertices_y(final_glb, math.pi * 0.5)
        meta = gwa.inspect_glb(final_glb)
    elif expected_axis == "z" and sx > sz * 1.12:
        gwa.log(f"[{spec['id']}] Rotating GLB 90 deg around Y so length aligns with Z ({sx:.3f} -> Z)")
        gwa.rotate_glb_vertices_y(final_glb, math.pi * 0.5)
        meta = gwa.inspect_glb(final_glb)

    if spec.get("bake_rot_y"):
        gwa.rotate_glb_vertices_y(final_glb, float(spec["bake_rot_y"]))
        meta = gwa.inspect_glb(final_glb)

    return meta


def write_merged_all_assets_manifest(out_path: Path) -> None:
    """
    Preserves ALL 27 existing models (10 v1 + 17 v2) and duckAttachments untouched
    in public/models/assets.json and merges all available shared obstacle/detail models
    cleanly (up to 37 models total).
    """
    existing_models: dict[str, Any] = {}
    existing_duck_attachments = gwa.DUCK_ATTACHMENTS
    if out_path.exists():
        try:
            current = json.loads(out_path.read_text(encoding="utf-8"))
            if isinstance(current, dict):
                if isinstance(current.get("models"), dict):
                    existing_models = dict(current["models"])
                if isinstance(current.get("duckAttachments"), dict):
                    existing_duck_attachments = current["duckAttachments"]
        except Exception:
            pass

    models_map: dict[str, Any] = {}
    total_bytes = 0
    total_tris = 0

    # 1. Preserve ALL 10 v1 + 17 v2 existing entries untouched
    v1_v2_ids = list(gwa.EXISTING_V1_IDS) + [s["id"] for s in gwa.WORLD_ASSET_SPECS]
    for aid in v1_v2_ids:
        glb_path = MODELS_DIR / f"{aid}.glb"
        if aid in existing_models and glb_path.exists():
            entry = existing_models[aid]
            models_map[aid] = entry
            total_bytes += int(entry.get("byteSize", entry.get("bytes", glb_path.stat().st_size)))
            total_tris += int(entry.get("triangles", 0))

    # Preserve any other non-shared entries already in assets.json
    shared_ids = {s["id"] for s in SHARED_OBSTACLE_SPECS}
    for aid, entry in existing_models.items():
        if aid not in models_map and aid not in shared_ids:
            glb_path = MODELS_DIR / entry.get("filename", f"{aid}.glb")
            if glb_path.exists():
                models_map[aid] = entry
                total_bytes += int(entry.get("byteSize", entry.get("bytes", glb_path.stat().st_size)))
                total_tris += int(entry.get("triangles", 0))

    # 2. Merge all present new shared obstacle & detail models in canonical order
    for spec in SHARED_OBSTACLE_SPECS:
        glb_path = MODELS_DIR / spec["filename"]
        if not glb_path.exists():
            continue
        info = gwa.inspect_glb(glb_path)
        entry = gwa.build_manifest_entry(
            asset_id=spec["id"],
            filename=spec["filename"],
            role=spec["role"],
            info=info,
            target_size=float(spec["targetSize"]),
            size_axis=str(spec["sizeAxis"]),
            pivot=str(spec["pivot"]),
            y_offset=float(spec["yOffset"]),
            rot_y=float(spec["rotY"]),
            region=str(spec.get("region", "shared")),
        )
        models_map[spec["id"]] = entry
        total_bytes += info["bytes"]
        total_tris += info["triangles"]

    manifest = {
        "version": 3,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "coordinateConvention": "+Z forward, +Y up, 1.0 world unit = 10cm (Duck Scale)",
        "totalBytes": total_bytes,
        "totalTriangles": total_tris,
        "duckAttachments": existing_duck_attachments,
        "models": models_map,
    }
    tmp = out_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    tmp.replace(out_path)
    gwa.log(
        f"Wrote {out_path.name} ({len(models_map)} models total, "
        f"{total_bytes / 1024 / 1024:.2f} MB total, {total_tris:,} tris total)"
    )


def process_shared_asset(
    api_key: str,
    spec: dict[str, Any],
    cache_dir: Path,
    state_path: Path,
    state: dict[str, Any],
    force: bool = False,
) -> dict[str, Any]:
    asset_id = spec["id"]
    raw_glb = cache_dir / "raw" / spec["filename"]
    final_glb = MODELS_DIR / spec["filename"]
    thumbs_dir = cache_dir / "thumbs"
    thumbs_dir.mkdir(parents=True, exist_ok=True)

    with gwa.STATE_LOCK:
        entry = dict(state.get("assets", {}).get(asset_id, {}))

    if force:
        entry = {}
        gwa.update_asset_state(
            state_path,
            state,
            asset_id,
            {"preview_task_id": None, "refine_task_id": None, "status": "restarting"},
        )

    # 1. Preview task
    preview_id = entry.get("preview_task_id")
    if not preview_id:
        gwa.log(f"[{asset_id}] Creating preview task ({spec['ai_model']}, target={spec['target_polycount']} tris)...")
        resp = gwa.meshy_request(api_key, "POST", "/v2/text-to-3d", gwa.build_preview_payload(spec))
        preview_id = resp["result"]
        gwa.update_asset_state(state_path, state, asset_id, {"preview_task_id": preview_id, "status": "preview_running"})
        gwa.log(f"[{asset_id}] Preview task ID: {preview_id}")

    preview_task = gwa.poll_task(api_key, preview_id, f"{asset_id}:preview")
    preview_thumb = preview_task.get("thumbnail_url")
    if preview_thumb:
        gwa.download_file(preview_thumb, thumbs_dir / f"{asset_id}_preview.png")

    # 2. Refine task (PBR textures)
    refine_id = entry.get("refine_task_id")
    if not refine_id:
        gwa.log(f"[{asset_id}] Creating refine task (meshy-7, enable_pbr=True, 2k)...")
        resp = gwa.meshy_request(api_key, "POST", "/v2/text-to-3d", gwa.build_refine_payload(spec, preview_id))
        refine_id = resp["result"]
        gwa.update_asset_state(state_path, state, asset_id, {"refine_task_id": refine_id, "status": "refine_running"})
        gwa.log(f"[{asset_id}] Refine task ID: {refine_id}")

    refine_task = gwa.poll_task(api_key, refine_id, f"{asset_id}:refine")
    refine_thumb = refine_task.get("thumbnail_url")
    if refine_thumb:
        gwa.download_file(refine_thumb, thumbs_dir / f"{asset_id}_refine.png")

    # 3. Download raw refined GLB
    glb_url = refine_task.get("model_urls", {}).get("glb")
    if not glb_url:
        raise RuntimeError(f"[{asset_id}] Refine succeeded but no glb URL in model_urls")

    if force or not raw_glb.exists():
        raw_bytes = gwa.download_file(glb_url, raw_glb)
        gwa.log(f"[{asset_id}] Downloaded raw GLB: {raw_bytes / 1024 / 1024:.2f} MB")
    else:
        raw_bytes = raw_glb.stat().st_size

    # 4. Optimize embedded textures & enforce orientation and size budget (<= 415 KB)
    meta = optimize_shared_glb(raw_glb, final_glb, spec)

    gwa.log(
        f"[{asset_id}] READY {final_glb.name}: {meta['bytes'] / 1024:.0f} KB "
        f"(raw {raw_bytes / 1024:.0f} KB), {meta['triangles']} tris, "
        f"bbox={meta['bbox']['size']}, pbr={meta['pbrChannels']}"
    )

    gwa.update_asset_state(
        state_path,
        state,
        asset_id,
        {
            "preview_task_id": preview_id,
            "refine_task_id": refine_id,
            "status": "done",
            "raw_bytes": raw_bytes,
            "final_bytes": meta["bytes"],
            "meta": meta,
        },
    )

    with MANIFEST_LOCK:
        write_merged_all_assets_manifest(MODELS_DIR / "assets.json")

    return {"id": asset_id, "spec": spec, "meta": meta}


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate 10 Shared River Obstacle & Detail PBR .glb assets via Meshy v2.")
    parser.add_argument("--only", type=str, default="", help="Comma-separated asset IDs to generate (default: all 10)")
    parser.add_argument("--force", type=str, default="", help="Comma-separated asset IDs to force regenerate")
    parser.add_argument("--concurrency", type=int, default=10, help="Max concurrent Meshy tasks")
    parser.add_argument("--cache-dir", type=str, default=str(DEFAULT_CACHE_DIR), help="Directory for task state & raw cache")
    parser.add_argument("--inspect-only", action="store_true", help="Only inspect existing GLBs and rewrite merged assets.json")
    parser.add_argument("--reoptimize", action="store_true", help="Re-optimize cached raw GLBs without API calls")
    parser.add_argument("--rotate-y", type=str, default="", help="Rotate specific asset IDs around Y: id=deg,id2=deg")
    args = parser.parse_args()

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    cache_dir = Path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    state_path = cache_dir / "state.json"

    if args.rotate_y:
        for pair in args.rotate_y.split(","):
            if "=" not in pair:
                continue
            aid, deg_str = pair.split("=", 1)
            aid = aid.strip()
            deg = float(deg_str.strip())
            glb_path = MODELS_DIR / f"{aid}.glb"
            if glb_path.exists():
                gwa.rotate_glb_vertices_y(glb_path, math.radians(deg))
                info = gwa.inspect_glb(glb_path)
                gwa.log(f"[{aid}] Rotated by {deg} deg around Y -> new bbox size={info['bbox']['size']}")
        write_merged_all_assets_manifest(MODELS_DIR / "assets.json")
        return 0

    if args.inspect_only:
        write_merged_all_assets_manifest(MODELS_DIR / "assets.json")
        return 0

    if args.reoptimize:
        only_set = {x.strip() for x in args.only.split(",") if x.strip()}
        for spec in SHARED_OBSTACLE_SPECS:
            if only_set and spec["id"] not in only_set:
                continue
            raw_glb = cache_dir / "raw" / spec["filename"]
            if raw_glb.exists():
                meta = optimize_shared_glb(raw_glb, MODELS_DIR / spec["filename"], spec)
                gwa.log(f"[{spec['id']}] Re-optimized: {meta['bytes'] / 1024:.0f} KB, {meta['triangles']} tris, bbox={meta['bbox']['size']}")
        write_merged_all_assets_manifest(MODELS_DIR / "assets.json")
        return 0

    api_key = gwa.load_api_key()
    bal = gwa.meshy_request(api_key, "GET", "/v1/balance")
    gwa.log(f"Meshy API connected. Credit balance: {bal.get('balance', '?')}")

    only_set = {x.strip() for x in args.only.split(",") if x.strip()}
    force_set = {x.strip() for x in args.force.split(",") if x.strip()}

    selected = [s for s in SHARED_OBSTACLE_SPECS if (not only_set or s["id"] in only_set)]
    if not selected:
        gwa.log("No matching assets selected.")
        return 1

    state = gwa.load_state(state_path)
    errors: list[tuple[str, str]] = []

    workers = min(args.concurrency, len(selected))
    gwa.log(f"Launching {len(selected)} shared river obstacle/detail assets with concurrency={workers}...")
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {
            pool.submit(process_shared_asset, api_key, spec, cache_dir, state_path, state, spec["id"] in force_set): spec["id"]
            for spec in selected
        }
        for fut in concurrent.futures.as_completed(future_map):
            aid = future_map[fut]
            try:
                fut.result()
            except Exception as e:
                gwa.log(f"[{aid}] FAILED: {e}")
                errors.append((aid, str(e)))

    write_merged_all_assets_manifest(MODELS_DIR / "assets.json")
    bal_after = gwa.meshy_request(api_key, "GET", "/v1/balance")
    gwa.log(f"Batch complete. Remaining credit balance: {bal_after.get('balance', '?')}")

    if errors:
        gwa.log(f"Errors ({len(errors)}): {errors}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
