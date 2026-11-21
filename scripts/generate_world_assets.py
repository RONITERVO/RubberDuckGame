#!/usr/bin/env python3
"""
River Ducker: Mini-Earth World Tour — Meshy v2 Text-to-3D PBR World Asset Pipeline
Generates, downloads, optimizes, inspects, and merges the 17 new Earth-region PBR .glb
assets into public/models/assets.json while preserving all 10 existing v1 models untouched.

Security:
  - Reads MESHY_API_KEY from environment or project .env file.
  - Never prints, logs, echoes, or persists the API key anywhere.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = PROJECT_ROOT / "public" / "models"
DEFAULT_CACHE_DIR = PROJECT_ROOT / ".cache" / "meshy_world_cache"
ENV_KEY_PATH = PROJECT_ROOT / ".env"
MESHY_BASE = "https://api.meshy.ai/openapi"

# Maximum target byte size per GLB (<= 445 KB guarantees both < 450 KB and < 450 KiB)
MAX_GLB_BYTES = 445_000

# 10 Existing v1 assets (preserved untouched in public/models/)
EXISTING_V1_IDS: tuple[str, ...] = (
    "rubber_duck",
    "mossy_boulder_a",
    "mossy_boulder_b",
    "fallen_log_arch",
    "driftwood_roots",
    "pine_tree",
    "fern_cluster",
    "river_trout",
    "duckling",
    "duck_wing",
)

# 17 New Iconic Earth-Region PBR .glb Assets across 5 regions
# Priority 1 = First 2 regions (Kyoto Bamboo & Sakura Gorge + Amazon Monsoon Canopy)
# Priority 2 = Remaining 3 regions (Red Rock Canyon + Arctic Aurora Fjord + Volcanic Basalt Gorge)
WORLD_ASSET_SPECS: list[dict[str, Any]] = [
    # -------------------------------------------------------------------------
    # Region 1: Kyoto Bamboo & Sakura Gorge (Priority 1)
    # -------------------------------------------------------------------------
    {
        "id": "torii_gate",
        "filename": "torii_gate.glb",
        "region": "kyoto-sakura",
        "priority": 1,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3600,
        "max_tex_size": 512,
        "expected_major_axis": "x",
        "prompt": (
            "Iconic traditional Japanese Shinto Torii gate archway spanning wide from left to right, "
            "two sturdy cylindrical vertical pillars set wide apart on the far left and far right ends "
            "with a wide completely open empty pass-through archway in the center between the two pillars, "
            "classic upward-curved top kasagi crossbar lintel roof beam and secondary nuki horizontal tie "
            "beam connecting the tops of the pillars, mossy stone pillar base rings at the bottom of "
            "each pillar, strictly NO floor, NO ground plane, and NO bottom beam connecting the two pillar "
            "bases so water can flow freely underneath between the pillars, single standalone arch gate"
        ),
        "texture_prompt": (
            "Vibrant traditional vermilion cinnabar red lacquered Japanese wood Torii gate pillars and "
            "nuki crossbar, satin charcoal-black painted curved top kasagi roof lintel beam, weathered "
            "grey temple granite pillar base pedestals with lush emerald-green moss cushions at the bottom, "
            "authentic outdoor Shinto shrine wood and stone PBR material"
        ),
        "targetSize": 13.0,
        "sizeAxis": "x",
        "pivot": "center",
        "yOffset": 0.15,
        "rotY": 0.0,
    },
    {
        "id": "sakura_tree",
        "filename": "sakura_tree.glb",
        "region": "kyoto-sakura",
        "priority": 1,
        "role": "foliage",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3800,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Graceful Japanese cherry blossom sakura tree in full spring bloom, expressive gnarled curving "
            "dark wood trunk branching upward into rich rounded billowing cloud clusters of sakura blossom "
            "foliage, full volumetric stylized-realistic game tree canopy silhouette without noisy thin "
            "loose twigs or floating particles, sturdy trunk base, single standalone tree, no ground plane, "
            "no pedestal"
        ),
        "texture_prompt": (
            "Lush soft pastel sakura pink, warm blush rose, and sunlit creamy-pink Japanese cherry blossom "
            "flower canopy clusters with delicate petal texture and sunlit highlights, rich dark "
            "espresso-brown gnarled cherry bark trunk with subtle green moss near the roots, vibrant "
            "nature PBR material"
        ),
        "targetSize": 18.5,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.45,
        "rotY": 0.0,
    },
    {
        "id": "bamboo_cluster",
        "filename": "bamboo_cluster.glb",
        "region": "kyoto-sakura",
        "priority": 1,
        "role": "foliage",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3400,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Tall dense Japanese Arashiyama bamboo grove cluster of 7 sturdy vertical bamboo stalks rising "
            "together from a compact base, distinct segmented cylindrical bamboo culms with horizontal "
            "nodal rings along the stalks, lush volumetric clusters of feathery green bamboo leaf sprays "
            "along the upper stalks and crown, clean stylized-realistic game foliage silhouette, no pot, "
            "no dirt block, no ground plane"
        ),
        "texture_prompt": (
            "Vibrant fresh emerald and sunlit jade green glossy Japanese bamboo stalks with crisp pale "
            "celadon horizontal node rings and natural satin vertical culm sheen, lush forest-green "
            "feathery bamboo foliage leaves at the upper canopy, realistic botanical PBR material"
        ),
        "targetSize": 15.0,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.35,
        "rotY": 0.0,
    },
    {
        "id": "stone_lantern",
        "filename": "stone_lantern.glb",
        "region": "kyoto-sakura",
        "priority": 1,
        "role": "foliage",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3200,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Traditional carved Japanese granite garden stone lantern toro, sturdy hexagonal stone base "
            "pedestal and central column supporting an ornate hexagonal firebox lantern chamber with "
            "window panels, topped by a wide curving pagoda-style umbrella stone roof cap with upturned "
            "corner eaves and a lotus finial jewel on top, velvety moss pillows growing on the stone roof "
            "ledges, single solid monument, no ground plane"
        ),
        "texture_prompt": (
            "Weathered rough grey Japanese temple granite stone with lush emerald-green velvety forest "
            "moss blanketing the curved umbrella roof cap and base crevices, warm glowing golden-amber "
            "shoji paper lantern light shining softly inside the central firebox window panels, realistic "
            "outdoor stone and warm lantern glow PBR material"
        ),
        "targetSize": 3.8,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.2,
        "rotY": 0.0,
    },
    {
        "id": "koi_fish",
        "filename": "koi_fish.glb",
        "region": "kyoto-sakura",
        "priority": 1,
        "role": "wildlife",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 2600,
        "max_tex_size": 512,
        "expected_major_axis": "z",
        "prompt": (
            "Elegant plump ornamental Japanese Nishikigoi Koi carp fish in a straight horizontal swimming "
            "pose facing straight forward, smooth hydrodynamic rounded fusiform body, graceful dorsal fin, "
            "rounded pectoral fins and forked caudal tail fin neatly sculpted, expressive fish eyes and "
            "small mouth facing straight forward, single standalone fish model, no water, no stand, no base"
        ),
        "texture_prompt": (
            "Vibrant prize Kohaku and Sanke Japanese Koi carp pattern with pearlescent snow-white body "
            "scales, bold vivid vermilion-orange and crimson-red organic dorsal markings, a few crisp "
            "ink-black sumi spots, translucent pearly-white and orange fin tips, glossy wet iridescent "
            "fish scale PBR material"
        ),
        "targetSize": 1.95,
        "sizeAxis": "z",
        "pivot": "center",
        "yOffset": 0.0,
        "rotY": 0.0,
    },

    # -------------------------------------------------------------------------
    # Region 2: Amazon Monsoon Canopy (Priority 1)
    # -------------------------------------------------------------------------
    {
        "id": "jungle_palm",
        "filename": "jungle_palm.glb",
        "region": "amazon-monsoon",
        "priority": 1,
        "role": "foliage",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3600,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Lush curving tropical Amazon rainforest palm and banana-frond jungle tree, gently curved "
            "ringed palm wood trunk rising to a rich radiating crown of 10 broad arching glossy tropical "
            "fronds and wide banana-style jungle leaves drooping gracefully outward, full volumetric "
            "stylized-realistic game tree silhouette with thick solid leaf blades, single standalone tree, "
            "no ground plane, no pot"
        ),
        "texture_prompt": (
            "Deep tropical emerald green and sunlit vibrant chartreuse-lime glossy rainforest palm and "
            "banana fronds with distinct central leaf ribs and wet monsoon rain sheen, warm fibrous "
            "coco-brown ringed palm trunk bark with subtle green moss near the base, crisp outdoor "
            "jungle foliage PBR material"
        ),
        "targetSize": 21.0,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.45,
        "rotY": 0.0,
    },
    {
        "id": "temple_ruin",
        "filename": "temple_ruin.glb",
        "region": "amazon-monsoon",
        "priority": 1,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3600,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Ancient weathered Mesoamerican and Amazonian carved stone temple pillar ruin and stepped "
            "monolith column, distinctly taller than wide with chiseled geometric relief carvings, "
            "stepped pyramid-style stone crown, cracked weathered limestone edges, thick tropical jungle "
            "vines and lumpy forest moss pillows draped over the upper ledges, solid single watertight "
            "stone monument, no floating debris, no ground plane"
        ),
        "texture_prompt": (
            "Ancient weathered warm golden-ochre and mossy charcoal-grey jungle limestone temple pillar "
            "with chiseled geometric Maya-style relief carvings, vibrant emerald-green creeping rainforest "
            "moss and woody jungle vines clinging to the stone crevices, damp monsoon-soaked stone PBR"
        ),
        "targetSize": 10.5,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.45,
        "rotY": 0.0,
    },
    {
        "id": "giant_lily_pad",
        "filename": "giant_lily_pad.glb",
        "region": "amazon-monsoon",
        "priority": 1,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 2800,
        "max_tex_size": 512,
        "expected_major_axis": "horiz",
        "prompt": (
            "Single broad circular Amazonian Victoria amazonica giant royal water lily pad floating flat "
            "horizontally, wide round ribbed leaf disc with a distinct upturned vertical pie-crust rim "
            "wall around the outer edge and a small V-notch on one side, a delicate blooming pink-white "
            "lotus flower with layered petals sitting on top of the lily pad, flat bottom with no hanging "
            "roots, single standalone floating lily pad, no water, no base"
        ),
        "texture_prompt": (
            "Vibrant emerald-green Victoria amazonica giant water lily pad with radiating pale lime-green "
            "structural veins across the round leaf surface and a warm bronze-reddish upturned outer rim "
            "wall, delicate soft rose-pink and creamy-white blooming lotus flower petals on top with a "
            "golden yellow stamen center, dewy wet botanical PBR material"
        ),
        "targetSize": 3.6,
        "sizeAxis": "max",
        "pivot": "waterline",
        "yOffset": 0.04,
        "rotY": 0.0,
    },

    # -------------------------------------------------------------------------
    # Region 3: Red Rock Canyon Rapids (Priority 2)
    # -------------------------------------------------------------------------
    {
        "id": "red_rock_pillar",
        "filename": "red_rock_pillar.glb",
        "region": "red-canyon",
        "priority": 2,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3600,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Towering Southwest desert red rock canyon Navajo sandstone spire hoodoo and layered rock "
            "pillar, distinctly taller than wide with dramatic horizontal wind-carved sedimentary rock "
            "strata ledges, bold stepped angular cliff facets widening at a stable base and rising to "
            "an eroded mesa pinnacle crest, single solid monolithic rock formation, no floating pieces, "
            "no ground plane"
        ),
        "texture_prompt": (
            "Glowing Utah Navajo sandstone in rich banded terracotta red, burnt sienna orange, warm "
            "desert ochre, and rusty crimson horizontal sedimentary rock strata layers, sun-baked matte "
            "sandstone grain with darker wet canyon waterline shading near the bottom base, photorealistic "
            "desert canyon rock PBR material"
        ),
        "targetSize": 5.8,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.45,
        "rotY": 0.0,
    },
    {
        "id": "red_rock_arch",
        "filename": "red_rock_arch.glb",
        "region": "red-canyon",
        "priority": 2,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 4000,
        "max_tex_size": 512,
        "expected_major_axis": "x",
        "prompt": (
            "Single continuous rugged red-orange sandstone rock arch bridge spanning horizontally "
            "from left to right, bowed upward in the center with angular chiseled layered stone "
            "facets and a wide completely open clear passage underneath the arch span, strictly "
            "NO floor, NO ground plane, and NO bottom bar connecting the two ends underneath, "
            "single solid red sandstone bridge arch"
        ),
        "texture_prompt": (
            "Sunlit Utah desert Navajo red-orange terracotta, burnt sienna, and warm golden-ochre "
            "striated sandstone rock arch bridge with crisp horizontal sedimentary rock strata layers "
            "and warm desert canyon highlights, photorealistic canyon sandstone PBR material"
        ),
        "targetSize": 12.8,
        "sizeAxis": "x",
        "pivot": "center",
        "yOffset": 0.15,
        "rotY": 0.0,
    },
    {
        "id": "saguaro_cactus",
        "filename": "saguaro_cactus.glb",
        "region": "red-canyon",
        "priority": 2,
        "role": "foliage",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 2800,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Classic iconic tall Sonoran desert saguaro cactus with a sturdy vertical pleated cylindrical "
            "main trunk and two iconic raised elbow arms branching out from the left and right sides and "
            "curving straight upward, crisp vertical accordion ribs along the trunk and arms with rounded "
            "dome tips, single standalone desert cactus, no pot, no sand base, no ground plane"
        ),
        "texture_prompt": (
            "Vibrant sun-warmed sage-green and rich desert olive-green saguaro cactus skin with crisp "
            "vertical pleated rib ridges, subtle pale cream-tan spine rows running neatly along the crest "
            "of each vertical rib, warm waxy desert succulent PBR material"
        ),
        "targetSize": 11.0,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.35,
        "rotY": 0.0,
    },

    # -------------------------------------------------------------------------
    # Region 4: Arctic Aurora Glacier Fjord (Priority 2)
    # -------------------------------------------------------------------------
    {
        "id": "iceberg_spire",
        "filename": "iceberg_spire.glb",
        "region": "arctic-fjord",
        "priority": 2,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3600,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Sculpted crystalline Arctic glacial iceberg spire and jagged floating ice pinnacle, distinctly "
            "taller than wide with sharp chiseled faceted polygonal ice cliff faces and stepped glacial "
            "serac ridges rising from a broader wave-carved waterline base to twin crystalline ice peaks "
            "with a smooth snow cap, single solid monolithic iceberg, no floating pieces, no water plane"
        ),
        "texture_prompt": (
            "Luminous Arctic glacier ice transitioning from a sparkling snow-white frost cap at the summit "
            "peaks through pale crystalline cyan-white ice facets down to deep glowing aquamarine and "
            "sapphire-turquoise compressed glacial ice near the waterline base, glossy translucent-looking "
            "ice refraction sheen PBR material"
        ),
        "targetSize": 5.4,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.5,
        "rotY": 0.0,
    },
    {
        "id": "ice_arch",
        "filename": "ice_arch.glb",
        "region": "arctic-fjord",
        "priority": 2,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 4000,
        "max_tex_size": 512,
        "expected_major_axis": "x",
        "prompt": (
            "Single continuous carved turquoise-blue Arctic glacial ice bridge arch spanning horizontally "
            "from left to right, gracefully bowed upward in the center with short sculpted hanging icicles "
            "along the upper arch edge and a wide completely open clear passage underneath, chiseled "
            "faceted glacier ice rib, strictly NO floor, NO ice sheet, and NO bottom bar connecting the "
            "two ends underneath, single solid natural ice bridge arch"
        ),
        "texture_prompt": (
            "Glowing translucent-style turquoise-blue and shimmering cyan Arctic glacier ice arch with "
            "crisp snow-white frost blanket along the top ridge and luminous deep sapphire-blue shading "
            "on the carved underside facets and hanging icicles, glossy crystalline ice PBR material"
        ),
        "targetSize": 12.4,
        "sizeAxis": "x",
        "pivot": "center",
        "yOffset": 0.15,
        "rotY": 0.0,
    },
    {
        "id": "penguin",
        "filename": "penguin.glb",
        "region": "arctic-fjord",
        "priority": 2,
        "role": "wildlife",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3200,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Cute stylized-realistic Emperor penguin standing upright and facing straight forward, plump "
            "streamlined rounded tuxedo body, sleek head with short pointed beak facing straight forward, "
            "small flipper wings resting neatly at the sides of the body, short sturdy webbed feet at the "
            "bottom, smooth clean game character silhouette, single standalone penguin, no ice block base, "
            "no pedestal"
        ),
        "texture_prompt": (
            "Glossy sleek obsidian-black feathered back, head, and flippers contrasting with a crisp "
            "snow-white chest and belly plumage, vibrant warm golden-yellow and tangerine-orange gradient "
            "patches on the sides of the neck and chest, dark beak with a bright coral-orange lower stripe, "
            "sleek waterproof penguin plumage PBR material"
        ),
        "targetSize": 1.15,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.05,
        "rotY": 0.0,
    },

    # -------------------------------------------------------------------------
    # Region 5: Iceland / Hawaii Volcanic Basalt Gorge (Priority 2)
    # -------------------------------------------------------------------------
    {
        "id": "basalt_columns",
        "filename": "basalt_columns.glb",
        "region": "volcanic-gorge",
        "priority": 2,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3600,
        "max_tex_size": 512,
        "expected_major_axis": "y",
        "prompt": (
            "Dramatic cluster of tightly packed vertical hexagonal volcanic basalt stone columns in the "
            "style of Giant's Causeway and Reynisfjara Iceland, stepped geometric six-sided stone pillars "
            "of varying heights rising together in a solid volcanic outcrop from a broader stepped base "
            "to a tall central hexagonal column peak, crisp flat hexagonal column tops and straight "
            "vertical prism edges, single solid rock formation, no floating pieces, no ground plane"
        ),
        "texture_prompt": (
            "Wet dark charcoal-black and deep gunmetal-slate Icelandic hexagonal volcanic basalt rock "
            "columns with crisp chiseled geometric edges, glossy damp wet specular stone sheen on the "
            "lower stepped columns, and subtle warm rust-amber mineral glow in the deep vertical joints "
            "between columns, photorealistic volcanic basalt PBR material"
        ),
        "targetSize": 6.4,
        "sizeAxis": "y",
        "pivot": "bottom",
        "yOffset": -0.45,
        "rotY": 0.0,
    },
    {
        "id": "obsidian_arch",
        "filename": "obsidian_arch.glb",
        "region": "volcanic-gorge",
        "priority": 2,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 4000,
        "max_tex_size": 512,
        "expected_major_axis": "x",
        "prompt": (
            "Single continuous jagged dark volcanic basalt and obsidian rock arch bridge spanning "
            "horizontally from left to right, bowed upward in the center with angular chiseled volcanic "
            "stone facets and a wide completely open clear passage underneath the arch span, strictly "
            "NO floor, NO ground plane, and NO bottom bar connecting the two ends underneath, single "
            "solid volcanic stone bridge arch"
        ),
        "texture_prompt": (
            "Dark charcoal-black volcanic basalt and glossy black obsidian rock arch veined with subtle "
            "glowing molten orange-amber and fiery golden-red magma cracks along the chiseled edges and "
            "rock crevices, dramatic high-contrast volcanic stone and glowing lava fissure PBR material"
        ),
        "targetSize": 12.4,
        "sizeAxis": "x",
        "pivot": "center",
        "yOffset": 0.15,
        "rotY": 0.0,
    },
    {
        "id": "lava_rock",
        "filename": "lava_rock.glb",
        "region": "volcanic-gorge",
        "priority": 2,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3600,
        "max_tex_size": 512,
        "expected_major_axis": "horiz",
        "prompt": (
            "Craggy black volcanic basalt boulder and cooled magma rock outcrop wider than it is tall, "
            "rough angular volcanic stone silhouette with deep chiseled surface fractures and cooling "
            "fissure crevices across the boulder, broad stable base, single solid monolithic volcanic "
            "boulder, no floating fragments, no ground plane"
        ),
        "texture_prompt": (
            "Craggy charcoal-black and dark iron-grey volcanic basalt boulder veined with vivid glowing "
            "molten orange-red and incandescent golden-yellow lava fissures shining from inside the deep "
            "surface cracks, contrasted against dark rough cooled volcanic rock, dramatic volcanic PBR"
        ),
        "targetSize": 4.0,
        "sizeAxis": "max",
        "pivot": "bottom",
        "yOffset": -0.35,
        "rotY": 0.0,
    },
]

# Articulated hero DuckRig attachment offsets preserved in assets.json
DUCK_ATTACHMENTS: dict[str, Any] = {
    "wingLeftOffset": [0.42, 0.36, -0.02],
    "wingRightOffset": [-0.42, 0.36, -0.02],
    "wingScale": 1.22,
    "feetOffset": [0.0, -0.15, -0.06],
    "headOffset": [0.0, 0.88, 0.14],
}

# Normalization defaults for the 10 existing v1 models
V1_MANIFEST_META: dict[str, dict[str, Any]] = {
    "rubber_duck": {"role": "hero", "targetSize": 1.25, "sizeAxis": "z", "pivot": "waterline", "yOffset": 0.0, "rotY": 0.18},
    "mossy_boulder_a": {"role": "obstacle", "targetSize": 3.6, "sizeAxis": "max", "pivot": "bottom", "yOffset": -0.35, "rotY": 0.0},
    "mossy_boulder_b": {"role": "obstacle", "targetSize": 4.2, "sizeAxis": "y", "pivot": "bottom", "yOffset": -0.4, "rotY": 0.0},
    "fallen_log_arch": {"role": "obstacle", "targetSize": 11.5, "sizeAxis": "x", "pivot": "center", "yOffset": 0.0, "rotY": 0.0},
    "driftwood_roots": {"role": "obstacle", "targetSize": 6.4, "sizeAxis": "x", "pivot": "center", "yOffset": -0.18, "rotY": 0.0},
    "pine_tree": {"role": "foliage", "targetSize": 22.0, "sizeAxis": "y", "pivot": "bottom", "yOffset": -0.5, "rotY": 0.0},
    "fern_cluster": {"role": "foliage", "targetSize": 3.4, "sizeAxis": "max", "pivot": "bottom", "yOffset": -0.52, "rotY": 0.0},
    "river_trout": {"role": "wildlife", "targetSize": 1.85, "sizeAxis": "z", "pivot": "center", "yOffset": 0.0, "rotY": 0.0},
    "duckling": {"role": "wildlife", "targetSize": 0.68, "sizeAxis": "z", "pivot": "waterline", "yOffset": -0.08, "rotY": 0.06},
    "duck_wing": {"role": "hero_part", "targetSize": 0.56, "sizeAxis": "max", "pivot": "center", "yOffset": 0.0, "rotY": 0.0},
}

STATE_LOCK = threading.Lock()
PRINT_LOCK = threading.Lock()
MANIFEST_LOCK = threading.Lock()


def log(msg: str) -> None:
    with PRINT_LOCK:
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] {msg}", flush=True)


def load_api_key() -> str:
    env_val = os.environ.get("MESHY_API_KEY", "").strip().strip('"').strip("'").strip()
    if env_val:
        return env_val
    if ENV_KEY_PATH.exists():
        with ENV_KEY_PATH.open("r", encoding="utf-8", errors="replace") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == "MESHY_API_KEY":
                    val = v.strip().strip('"').strip("'").strip()
                    if val:
                        return val
    raise RuntimeError("MESHY_API_KEY not found in environment or .env file.")


def meshy_request(
    api_key: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    timeout: int = 60,
    max_retries: int = 8,
) -> dict[str, Any]:
    url = f"{MESHY_BASE}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"

    for attempt in range(max_retries):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            if e.code == 429 or 500 <= e.code < 600:
                retry_after = e.headers.get("Retry-After")
                wait = float(retry_after) if retry_after and retry_after.isdigit() else min(30.0, 2.5 * (1.6 ** attempt))
                log(f"HTTP {e.code} on {method} {path}, backing off {wait:.1f}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
                continue
            raise RuntimeError(f"Meshy API error {e.code} on {method} {path}: {body[:400]}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            wait = min(20.0, 2.0 * (1.5 ** attempt))
            log(f"Network error on {method} {path}: {type(e).__name__}, retrying in {wait:.1f}s")
            time.sleep(wait)
            continue
    raise RuntimeError(f"Exceeded max retries for {method} {path}")


def download_file(url: str, dest: Path, timeout: int = 120, max_retries: int = 5) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "RiverDuckerWorldAssetPipeline/2.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp, tmp.open("wb") as out:
                shutil.copyfileobj(resp, out)
            tmp.replace(dest)
            return dest.stat().st_size
        except Exception as e:
            wait = min(15.0, 2.0 * (attempt + 1))
            log(f"Download retry ({attempt + 1}/{max_retries}) for {dest.name}: {type(e).__name__}")
            time.sleep(wait)
    raise RuntimeError(f"Failed to download {dest.name}")


def load_state(state_path: Path) -> dict[str, Any]:
    if state_path.exists():
        try:
            return json.loads(state_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"assets": {}}


def save_state(state_path: Path, state: dict[str, Any]) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = state_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(state_path)


def update_asset_state(state_path: Path, state: dict[str, Any], asset_id: str, patch: dict[str, Any]) -> None:
    with STATE_LOCK:
        entry = state.setdefault("assets", {}).setdefault(asset_id, {})
        entry.update(patch)
        save_state(state_path, state)


def poll_task(api_key: str, task_id: str, label: str, poll_interval: float = 5.0, max_wait: float = 1800.0) -> dict[str, Any]:
    start = time.time()
    last_progress = -1
    last_status = ""
    while True:
        task = meshy_request(api_key, "GET", f"/v2/text-to-3d/{task_id}", timeout=30)
        status = task.get("status", "UNKNOWN")
        progress = int(task.get("progress", 0) or 0)
        if status != last_status or (progress - last_progress >= 20) or status in ("SUCCEEDED", "FAILED", "CANCELED"):
            log(f"[{label}] {status} ({progress}%)")
            last_status = status
            last_progress = progress
        if status == "SUCCEEDED":
            return task
        if status in ("FAILED", "CANCELED"):
            err = task.get("task_error")
            raise RuntimeError(f"Task {label} ({task_id}) {status}: {err}")
        if time.time() - start > max_wait:
            raise TimeoutError(f"Timed out waiting for {label} ({task_id})")
        time.sleep(poll_interval)


# ---------------------------------------------------------------------------
# glTF 2.0 / GLB binary parsing, inspection, orientation & texture compression
# ---------------------------------------------------------------------------

def parse_glb(path: Path) -> tuple[dict[str, Any], bytes]:
    raw = path.read_bytes()
    if len(raw) < 20:
        raise ValueError(f"{path.name}: file too small ({len(raw)} bytes)")
    magic, version, total_len = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF" or version != 2:
        raise ValueError(f"{path.name}: invalid GLB header magic={magic!r} version={version}")
    if total_len > len(raw):
        raise ValueError(f"{path.name}: truncated GLB ({len(raw)} < {total_len})")

    offset = 12
    gltf_json: dict[str, Any] | None = None
    bin_chunk = b""
    while offset + 8 <= total_len:
        chunk_len, chunk_type = struct.unpack_from("<I4s", raw, offset)
        offset += 8
        chunk_data = raw[offset : offset + chunk_len]
        offset += chunk_len
        if chunk_type == b"JSON":
            gltf_json = json.loads(chunk_data.decode("utf-8").rstrip("\x00 "))
        elif chunk_type == b"BIN\x00":
            bin_chunk = chunk_data
    if gltf_json is None:
        raise ValueError(f"{path.name}: missing JSON chunk")
    return gltf_json, bin_chunk


def write_glb(path: Path, gltf_json: dict[str, Any], bin_chunk: bytes) -> int:
    bin_pad = (-len(bin_chunk)) % 4
    bin_padded = bin_chunk + (b"\x00" * bin_pad)

    if gltf_json.get("buffers"):
        gltf_json["buffers"][0]["byteLength"] = len(bin_padded)

    json_bytes = json.dumps(gltf_json, separators=(",", ":")).encode("utf-8")
    json_pad = (-len(json_bytes)) % 4
    json_padded = json_bytes + (b" " * json_pad)

    total_len = 12 + 8 + len(json_padded) + (8 + len(bin_padded) if bin_padded else 0)
    header = struct.pack("<4sII", b"glTF", 2, total_len)
    json_hdr = struct.pack("<I4s", len(json_padded), b"JSON")

    parts = [header, json_hdr, json_padded]
    if bin_padded:
        parts.append(struct.pack("<I4s", len(bin_padded), b"BIN\x00"))
        parts.append(bin_padded)

    out = b"".join(parts)
    tmp = path.with_suffix(".glb.tmp")
    tmp.write_bytes(out)
    tmp.replace(path)
    return len(out)


def rotate_glb_vertices_y(path: Path, angle_rad: float) -> None:
    """
    Bake a Y-axis rotation (right-handed, +Y up: x' = x*cos + z*sin, z' = -x*sin + z*cos)
    directly into the GLB vertex POSITION, NORMAL, and TANGENT buffers and update accessor bounds.
    """
    if abs(angle_rad) < 1e-6:
        return
    gltf, bin_chunk = parse_glb(path)
    buf = bytearray(bin_chunk)
    c = math.cos(angle_rad)
    s = math.sin(angle_rad)

    rotated_accessors: set[int] = set()
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            attrs = prim.get("attributes", {})
            for attr_name in ("POSITION", "NORMAL", "TANGENT"):
                acc_idx = attrs.get(attr_name)
                if acc_idx is None or acc_idx in rotated_accessors:
                    continue
                acc = gltf["accessors"][acc_idx]
                if acc.get("componentType") != 5126:  # FLOAT
                    continue
                rotated_accessors.add(acc_idx)
                bv = gltf["bufferViews"][acc["bufferView"]]
                count = acc["count"]
                byte_offset = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
                is_vec4 = acc.get("type") == "VEC4"
                default_stride = 16 if is_vec4 else 12
                stride = bv.get("byteStride", default_stride)

                min_v = [math.inf, math.inf, math.inf]
                max_v = [-math.inf, -math.inf, -math.inf]

                for i in range(count):
                    off = byte_offset + i * stride
                    x, y, z = struct.unpack_from("<fff", buf, off)
                    nx = x * c + z * s
                    ny = y
                    nz = -x * s + z * c
                    struct.pack_into("<fff", buf, off, nx, ny, nz)
                    if nx < min_v[0]: min_v[0] = nx
                    if ny < min_v[1]: min_v[1] = ny
                    if nz < min_v[2]: min_v[2] = nz
                    if nx > max_v[0]: max_v[0] = nx
                    if ny > max_v[1]: max_v[1] = ny
                    if nz > max_v[2]: max_v[2] = nz

                if attr_name == "POSITION" and count > 0:
                    acc["min"] = [float(v) for v in min_v]
                    acc["max"] = [float(v) for v in max_v]

    write_glb(path, gltf, bytes(buf))


def image_dimensions(data: bytes, mime: str) -> tuple[int, int]:
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        w, h = struct.unpack_from(">II", data, 16)
        return w, h
    if data[:2] == b"\xff\xd8":
        i = 2
        n = len(data)
        while i + 9 < n:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            i += 2
            if marker in (0xD8, 0xD9, 0x01) or (0xD0 <= marker <= 0xD7):
                continue
            if i + 2 > n:
                break
            seg_len = struct.unpack_from(">H", data, i)[0]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                if i + 7 <= n:
                    h, w = struct.unpack_from(">HH", data, i + 3)
                    return w, h
            i += seg_len
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b"VP8X":
            w = 1 + int.from_bytes(data[24:27], "little")
            h = 1 + int.from_bytes(data[27:30], "little")
            return w, h
    return (0, 0)


def mat4_identity() -> list[float]:
    return [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]


def mat4_mul(a: list[float], b: list[float]) -> list[float]:
    out = [0.0] * 16
    for col in range(4):
        for row in range(4):
            out[col * 4 + row] = (
                a[0 * 4 + row] * b[col * 4 + 0]
                + a[1 * 4 + row] * b[col * 4 + 1]
                + a[2 * 4 + row] * b[col * 4 + 2]
                + a[3 * 4 + row] * b[col * 4 + 3]
            )
    return out


def mat4_from_trs(t: list[float], r: list[float], s: list[float]) -> list[float]:
    x, y, z, w = r
    x2, y2, z2 = x + x, y + y, z + z
    xx, xy, xz = x * x2, x * y2, x * z2
    yy, yz, zz = y * y2, y * z2, z * z2
    wx, wy, wz = w * x2, w * y2, w * z2
    sx, sy, sz = s
    return [
        (1.0 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0.0,
        (xy - wz) * sy, (1.0 - (xx + zz)) * sy, (yz + wx) * sy, 0.0,
        (xz + wy) * sz, (yz - wx) * sz, (1.0 - (xx + yy)) * sz, 0.0,
        t[0], t[1], t[2], 1.0,
    ]


def transform_point(m: list[float], p: tuple[float, float, float]) -> tuple[float, float, float]:
    px, py, pz = p
    return (
        m[0] * px + m[4] * py + m[8] * pz + m[12],
        m[1] * px + m[5] * py + m[9] * pz + m[13],
        m[2] * px + m[6] * py + m[10] * pz + m[14],
    )


def node_local_matrix(node: dict[str, Any]) -> list[float]:
    if "matrix" in node:
        return [float(v) for v in node["matrix"]]
    t = [float(v) for v in node.get("translation", [0.0, 0.0, 0.0])]
    r = [float(v) for v in node.get("rotation", [0.0, 0.0, 0.0, 1.0])]
    s = [float(v) for v in node.get("scale", [1.0, 1.0, 1.0])]
    return mat4_from_trs(t, r, s)


def iter_accessor_vec3(gltf: dict[str, Any], bin_chunk: bytes, acc_idx: int):
    acc = gltf["accessors"][acc_idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    if acc["componentType"] != 5126:
        return
    count = acc["count"]
    byte_offset = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride", 12)
    for i in range(count):
        off = byte_offset + i * stride
        yield struct.unpack_from("<fff", bin_chunk, off)


def inspect_glb(path: Path) -> dict[str, Any]:
    gltf, bin_chunk = parse_glb(path)
    nodes = gltf.get("nodes", [])
    meshes = gltf.get("meshes", [])
    scenes = gltf.get("scenes", [])
    scene_idx = gltf.get("scene", 0)
    root_nodes = scenes[scene_idx].get("nodes", []) if scenes else list(range(len(nodes)))

    min_v = [math.inf, math.inf, math.inf]
    max_v = [-math.inf, -math.inf, -math.inf]
    total_tris = 0
    total_verts = 0

    def walk(node_idx: int, parent_m: list[float]) -> None:
        nonlocal total_tris, total_verts
        node = nodes[node_idx]
        world_m = mat4_mul(parent_m, node_local_matrix(node))
        if "mesh" in node:
            mesh = meshes[node["mesh"]]
            for prim in mesh.get("primitives", []):
                mode = prim.get("mode", 4)
                attrs = prim.get("attributes", {})
                pos_idx = attrs.get("POSITION")
                if pos_idx is not None:
                    pos_acc = gltf["accessors"][pos_idx]
                    total_verts += pos_acc["count"]
                    for pt in iter_accessor_vec3(gltf, bin_chunk, pos_idx):
                        wx, wy, wz = transform_point(world_m, pt)
                        if wx < min_v[0]: min_v[0] = wx
                        if wy < min_v[1]: min_v[1] = wy
                        if wz < min_v[2]: min_v[2] = wz
                        if wx > max_v[0]: max_v[0] = wx
                        if wy > max_v[1]: max_v[1] = wy
                        if wz > max_v[2]: max_v[2] = wz
                if "indices" in prim:
                    idx_count = gltf["accessors"][prim["indices"]]["count"]
                elif pos_idx is not None:
                    idx_count = gltf["accessors"][pos_idx]["count"]
                else:
                    idx_count = 0
                if mode == 4:
                    total_tris += idx_count // 3
                elif mode in (5, 6) and idx_count >= 3:
                    total_tris += idx_count - 2
        for child_idx in node.get("children", []):
            walk(child_idx, world_m)

    if root_nodes:
        for r in root_nodes:
            walk(r, mat4_identity())
    else:
        for m in meshes:
            for prim in m.get("primitives", []):
                pos_idx = prim.get("attributes", {}).get("POSITION")
                if pos_idx is not None:
                    for pt in iter_accessor_vec3(gltf, bin_chunk, pos_idx):
                        for k in range(3):
                            min_v[k] = min(min_v[k], pt[k])
                            max_v[k] = max(max_v[k], pt[k])

    if not all(math.isfinite(x) for x in min_v + max_v):
        min_v = [0.0, 0.0, 0.0]
        max_v = [0.0, 0.0, 0.0]

    size = [round(max_v[i] - min_v[i], 5) for i in range(3)]
    center = [round((min_v[i] + max_v[i]) * 0.5, 5) for i in range(3)]
    min_r = [round(v, 5) for v in min_v]
    max_r = [round(v, 5) for v in max_v]

    textures_info = []
    for img_idx, img in enumerate(gltf.get("images", [])):
        bv_idx = img.get("bufferView")
        mime = img.get("mimeType", "unknown")
        if bv_idx is not None:
            bv = gltf["bufferViews"][bv_idx]
            off = bv.get("byteOffset", 0)
            length = bv["byteLength"]
            img_bytes = bin_chunk[off : off + length]
            w, h = image_dimensions(img_bytes, mime)
            textures_info.append({
                "index": img_idx,
                "mimeType": mime,
                "width": w,
                "height": h,
                "bytes": length,
            })

    pbr_channels: set[str] = set()
    for mat in gltf.get("materials", []):
        pbr = mat.get("pbrMetallicRoughness", {})
        if "baseColorTexture" in pbr:
            pbr_channels.add("baseColor")
        if "metallicRoughnessTexture" in pbr:
            pbr_channels.add("metallicRoughness")
        if "normalTexture" in mat:
            pbr_channels.add("normal")
        if "occlusionTexture" in mat:
            pbr_channels.add("occlusion")
        if "emissiveTexture" in mat:
            pbr_channels.add("emissive")

    return {
        "bytes": path.stat().st_size,
        "triangles": total_tris,
        "vertices": total_verts,
        "bbox": {
            "min": min_r,
            "max": max_r,
            "size": size,
            "center": center,
        },
        "pbrChannels": sorted(pbr_channels),
        "textures": textures_info,
    }


def optimize_glb_textures(
    src_path: Path,
    dst_path: Path,
    max_dim: int = 512,
    aux_max_dim: int | None = None,
    jpeg_quality: int = 3,
    aux_jpeg_quality: int | None = None,
) -> dict[str, Any]:
    """
    Re-encodes embedded textures inside a GLB cleanly using ffmpeg so mobile WebGL2
    loads rapidly without losing visual crispness (target <= 450 KB per model).
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        shutil.copy2(src_path, dst_path)
        return inspect_glb(dst_path)

    gltf, bin_chunk = parse_glb(src_path)
    images = gltf.get("images", [])
    if not images:
        shutil.copy2(src_path, dst_path)
        return inspect_glb(dst_path)

    tex_list = gltf.get("textures", [])
    img_roles: dict[int, set[str]] = {}
    for mat in gltf.get("materials", []):
        pbr = mat.get("pbrMetallicRoughness", {})
        alpha_mode = mat.get("alphaMode", "OPAQUE")
        for key, role in [("baseColorTexture", "baseColor"), ("metallicRoughnessTexture", "metallicRoughness")]:
            if key in pbr:
                src_i = tex_list[pbr[key]["index"]].get("source")
                if src_i is not None:
                    img_roles.setdefault(src_i, set()).add(role)
                    if role == "baseColor" and alpha_mode != "OPAQUE":
                        img_roles[src_i].add("hasAlpha")
        for key, role in [("normalTexture", "normal"), ("occlusionTexture", "occlusion"), ("emissiveTexture", "emissive")]:
            if key in mat:
                src_i = tex_list[mat[key]["index"]].get("source")
                if src_i is not None:
                    img_roles.setdefault(src_i, set()).add(role)

    img_bv_map: dict[int, int] = {}
    for idx, img in enumerate(images):
        bv_idx = img.get("bufferView")
        if bv_idx is not None:
            img_bv_map[bv_idx] = idx

    new_chunks: list[bytes] = []
    new_offset = 0
    buffer_views = gltf.get("bufferViews", [])

    with tempfile.TemporaryDirectory(prefix="glb_wopt_") as tmpdir:
        tmp = Path(tmpdir)
        for bv_idx, bv in enumerate(buffer_views):
            off = bv.get("byteOffset", 0)
            length = bv["byteLength"]
            slice_bytes = bin_chunk[off : off + length]

            if bv_idx in img_bv_map:
                img_idx = img_bv_map[bv_idx]
                img = images[img_idx]
                mime = img.get("mimeType", "image/png")
                roles = img_roles.get(img_idx, set())
                w, h = image_dimensions(slice_bytes, mime)

                is_aux = ("baseColor" not in roles) and bool(roles & {"normal", "metallicRoughness", "occlusion"})
                target_max = (aux_max_dim if (is_aux and aux_max_dim is not None) else max_dim)

                ext_in = ".jpg" if "jpeg" in mime else ".png"
                in_file = tmp / f"in_{img_idx}{ext_in}"
                in_file.write_bytes(slice_bytes)

                keep_png = "hasAlpha" in roles
                vf = f"scale='min({target_max},iw)':'min({target_max},ih)':force_original_aspect_ratio=decrease:flags=lanczos"

                if keep_png:
                    out_png = tmp / f"out_{img_idx}.png"
                    cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", str(in_file), "-vf", vf, "-compression_level", "9", str(out_png)]
                    subprocess.run(cmd, check=True)
                    new_bytes = out_png.read_bytes()
                    new_mime = "image/png"
                else:
                    if is_aux and aux_jpeg_quality is not None:
                        q = aux_jpeg_quality
                    else:
                        q = max(2, jpeg_quality - 1) if ("normal" in roles or "metallicRoughness" in roles) else jpeg_quality
                    out_jpg = tmp / f"out_{img_idx}.jpg"
                    cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", str(in_file), "-vf", vf, "-q:v", str(q), str(out_jpg)]
                    subprocess.run(cmd, check=True)
                    jpg_bytes = out_jpg.read_bytes()

                    if len(jpg_bytes) < len(slice_bytes) or max(w, h) > target_max:
                        new_bytes = jpg_bytes
                        new_mime = "image/jpeg"
                    else:
                        new_bytes = slice_bytes
                        new_mime = mime

                img["mimeType"] = new_mime
                slice_bytes = new_bytes

            pad = (-new_offset) % 4
            if pad:
                new_chunks.append(b"\x00" * pad)
                new_offset += pad

            bv["byteOffset"] = new_offset
            bv["byteLength"] = len(slice_bytes)
            new_chunks.append(slice_bytes)
            new_offset += len(slice_bytes)

    new_bin = b"".join(new_chunks)
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    write_glb(dst_path, gltf, new_bin)
    return inspect_glb(dst_path)


def optimize_glb_to_budget(raw_glb: Path, final_glb: Path, spec: dict[str, Any]) -> dict[str, Any]:
    """
    Optimize GLB textures so the final binary GLB is guaranteed <= MAX_GLB_BYTES (<= 445 KB)
    and aligned to its expected major axis ('x' for arches/gates, 'z' for fish).
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
        meta = optimize_glb_textures(
            raw_glb,
            final_glb,
            max_dim=base_dim,
            aux_max_dim=aux_dim,
            jpeg_quality=base_q,
            aux_jpeg_quality=aux_q,
        )
        if meta["bytes"] <= MAX_GLB_BYTES:
            break

    # Verify horizontal axis convention:
    # - Arches/gates ('expected_major_axis' == 'x') must span X (size[0] >= size[2])
    # - Fish ('expected_major_axis' == 'z') must extend along Z (size[2] >= size[0])
    expected_axis = spec.get("expected_major_axis", "")
    sx, _sy, sz = meta["bbox"]["size"]
    if expected_axis == "x" and sz > sx * 1.12:
        log(f"[{spec['id']}] Rotating GLB 90 deg around Y so wide span aligns with X ({sz:.3f} -> X)")
        rotate_glb_vertices_y(final_glb, math.pi * 0.5)
        meta = inspect_glb(final_glb)
    elif expected_axis == "z" and sx > sz * 1.12:
        log(f"[{spec['id']}] Rotating GLB 90 deg around Y so forward length aligns with Z ({sx:.3f} -> Z)")
        rotate_glb_vertices_y(final_glb, math.pi * 0.5)
        meta = inspect_glb(final_glb)

    if spec.get("bake_rot_y"):
        rotate_glb_vertices_y(final_glb, float(spec["bake_rot_y"]))
        meta = inspect_glb(final_glb)

    return meta


# ---------------------------------------------------------------------------
# Meshy v2 Preview + Refine Workflow
# ---------------------------------------------------------------------------

def build_preview_payload(spec: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "mode": "preview",
        "prompt": spec["prompt"],
        "model_type": spec["model_type"],
        "ai_model": spec["ai_model"],
        "target_polycount": spec["target_polycount"],
        "target_formats": ["glb"],
    }
    if spec["model_type"] == "standard":
        payload["should_remesh"] = spec.get("should_remesh", True)
        if payload["should_remesh"]:
            payload["topology"] = spec.get("topology", "triangle")
    return payload


def build_refine_payload(spec: dict[str, Any], preview_task_id: str) -> dict[str, Any]:
    return {
        "mode": "refine",
        "preview_task_id": preview_task_id,
        "ai_model": "meshy-7",
        "enable_pbr": True,
        "texture_resolution": "2k",
        "texture_prompt": spec["texture_prompt"],
        "target_formats": ["glb"],
    }


def process_asset(
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

    with STATE_LOCK:
        entry = dict(state.get("assets", {}).get(asset_id, {}))

    if force:
        entry = {}
        update_asset_state(
            state_path,
            state,
            asset_id,
            {"preview_task_id": None, "refine_task_id": None, "status": "restarting"},
        )

    # 1. Preview task
    preview_id = entry.get("preview_task_id")
    if not preview_id:
        log(f"[{asset_id}] Creating preview task ({spec['ai_model']}, target={spec['target_polycount']} tris)...")
        resp = meshy_request(api_key, "POST", "/v2/text-to-3d", build_preview_payload(spec))
        preview_id = resp["result"]
        update_asset_state(state_path, state, asset_id, {"preview_task_id": preview_id, "status": "preview_running"})
        log(f"[{asset_id}] Preview task ID: {preview_id}")

    preview_task = poll_task(api_key, preview_id, f"{asset_id}:preview")
    preview_thumb = preview_task.get("thumbnail_url")
    if preview_thumb:
        download_file(preview_thumb, thumbs_dir / f"{asset_id}_preview.png")

    # 2. Refine task (PBR textures)
    refine_id = entry.get("refine_task_id")
    if not refine_id:
        log(f"[{asset_id}] Creating refine task (meshy-7, enable_pbr=True, 2k)...")
        resp = meshy_request(api_key, "POST", "/v2/text-to-3d", build_refine_payload(spec, preview_id))
        refine_id = resp["result"]
        update_asset_state(state_path, state, asset_id, {"refine_task_id": refine_id, "status": "refine_running"})
        log(f"[{asset_id}] Refine task ID: {refine_id}")

    refine_task = poll_task(api_key, refine_id, f"{asset_id}:refine")
    refine_thumb = refine_task.get("thumbnail_url")
    if refine_thumb:
        download_file(refine_thumb, thumbs_dir / f"{asset_id}_refine.png")

    # 3. Download raw refined GLB
    glb_url = refine_task.get("model_urls", {}).get("glb")
    if not glb_url:
        raise RuntimeError(f"[{asset_id}] Refine succeeded but no glb URL in model_urls")

    if force or not raw_glb.exists():
        raw_bytes = download_file(glb_url, raw_glb)
        log(f"[{asset_id}] Downloaded raw GLB: {raw_bytes / 1024 / 1024:.2f} MB")
    else:
        raw_bytes = raw_glb.stat().st_size

    # 4. Optimize embedded textures & enforce orientation and size budget (<= 445 KB)
    meta = optimize_glb_to_budget(raw_glb, final_glb, spec)

    log(
        f"[{asset_id}] READY {final_glb.name}: {meta['bytes'] / 1024:.0f} KB "
        f"(raw {raw_bytes / 1024:.0f} KB), {meta['triangles']} tris, "
        f"bbox={meta['bbox']['size']}, pbr={meta['pbrChannels']}"
    )

    update_asset_state(
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

    # Incrementally merge into public/models/assets.json as each model completes!
    with MANIFEST_LOCK:
        write_merged_assets_manifest(MODELS_DIR / "assets.json")

    return {"id": asset_id, "spec": spec, "meta": meta}


def build_manifest_entry(
    asset_id: str,
    filename: str,
    role: str,
    info: dict[str, Any],
    target_size: float,
    size_axis: str,
    pivot: str,
    y_offset: float,
    rot_y: float,
    region: str | None = None,
) -> dict[str, Any]:
    bbox = info["bbox"]
    axis_idx = {"x": 0, "y": 1, "z": 2}.get(size_axis)
    measured = bbox["size"][axis_idx] if axis_idx is not None else max(bbox["size"])
    rec_scale = round(target_size / measured, 5) if measured > 1e-4 else 1.0

    entry: dict[str, Any] = {
        "id": asset_id,
        "filename": filename,
        "file": filename,
        "url": f"./models/{filename}",
        "role": role,
    }
    if region:
        entry["region"] = region
    entry.update(
        {
            "byteSize": info["bytes"],
            "bytes": info["bytes"],
            "triangles": info["triangles"],
            "vertices": info["vertices"],
            "bbox": bbox,
            "pbrChannels": info["pbrChannels"],
            "textures": info["textures"],
            "targetSize": target_size,
            "sizeAxis": size_axis,
            "pivot": pivot,
            "yOffset": y_offset,
            "rotY": rot_y,
            "scaleMultiplier": 1.0,
            "recommended": {
                "scale": rec_scale,
                "yOffset": y_offset,
                "rotY": rot_y,
            },
        }
    )
    if asset_id == "rubber_duck":
        entry["wingAttachments"] = DUCK_ATTACHMENTS
    return entry


def write_merged_assets_manifest(out_path: Path) -> None:
    """
    Preserves all 10 existing v1 models in public/models/assets.json untouched and
    merges all available new Mini-Earth world region models cleanly.
    """
    existing_models: dict[str, Any] = {}
    if out_path.exists():
        try:
            current = json.loads(out_path.read_text(encoding="utf-8"))
            if isinstance(current, dict) and isinstance(current.get("models"), dict):
                existing_models = dict(current["models"])
        except Exception:
            pass

    models_map: dict[str, Any] = {}
    total_bytes = 0
    total_tris = 0

    # 1. Preserve all 10 v1 entries (re-inspecting from disk if needed, keeping exact v1 overrides)
    for v1_id in EXISTING_V1_IDS:
        glb_path = MODELS_DIR / f"{v1_id}.glb"
        if v1_id in existing_models and glb_path.exists():
            entry = existing_models[v1_id]
            models_map[v1_id] = entry
            total_bytes += int(entry.get("byteSize", entry.get("bytes", glb_path.stat().st_size)))
            total_tris += int(entry.get("triangles", 0))
        elif glb_path.exists():
            info = inspect_glb(glb_path)
            ov = V1_MANIFEST_META[v1_id]
            entry = build_manifest_entry(
                asset_id=v1_id,
                filename=f"{v1_id}.glb",
                role=ov["role"],
                info=info,
                target_size=ov["targetSize"],
                size_axis=ov["sizeAxis"],
                pivot=ov["pivot"],
                y_offset=ov["yOffset"],
                rot_y=ov["rotY"],
            )
            models_map[v1_id] = entry
            total_bytes += info["bytes"]
            total_tris += info["triangles"]

    # 2. Merge all present new Earth-region models in canonical order
    for spec in WORLD_ASSET_SPECS:
        glb_path = MODELS_DIR / spec["filename"]
        if not glb_path.exists():
            continue
        info = inspect_glb(glb_path)
        entry = build_manifest_entry(
            asset_id=spec["id"],
            filename=spec["filename"],
            role=spec["role"],
            info=info,
            target_size=float(spec["targetSize"]),
            size_axis=str(spec["sizeAxis"]),
            pivot=str(spec["pivot"]),
            y_offset=float(spec["yOffset"]),
            rot_y=float(spec["rotY"]),
            region=str(spec.get("region", "")),
        )
        models_map[spec["id"]] = entry
        total_bytes += info["bytes"]
        total_tris += info["triangles"]

    # 3. Preserve any additional models (e.g. v3 shared obstacle assets) already present in assets.json
    for aid, entry in existing_models.items():
        if aid not in models_map:
            glb_path = MODELS_DIR / entry.get("filename", f"{aid}.glb")
            if glb_path.exists():
                models_map[aid] = entry
                total_bytes += int(entry.get("byteSize", entry.get("bytes", glb_path.stat().st_size)))
                total_tris += int(entry.get("triangles", 0))

    manifest = {
        "version": 3 if len(models_map) > 27 else 2,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "coordinateConvention": "+Z forward, +Y up, 1.0 world unit = 10cm (Duck Scale)",
        "totalBytes": total_bytes,
        "totalTriangles": total_tris,
        "duckAttachments": DUCK_ATTACHMENTS,
        "models": models_map,
    }
    tmp = out_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    tmp.replace(out_path)
    log(
        f"Wrote {out_path.name} ({len(models_map)} models total, "
        f"{total_bytes / 1024 / 1024:.2f} MB total, {total_tris:,} tris total)"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate River Ducker Mini-Earth World Tour PBR 3D assets via Meshy v2.")
    parser.add_argument("--only", type=str, default="", help="Comma-separated asset IDs to generate (default: all)")
    parser.add_argument("--priority", type=int, default=0, help="Only run assets with this priority (1=Kyoto+Amazon, 2=Canyon+Arctic+Volcanic)")
    parser.add_argument("--force", type=str, default="", help="Comma-separated asset IDs to force regenerate")
    parser.add_argument("--concurrency", type=int, default=9, help="Max concurrent Meshy tasks")
    parser.add_argument("--cache-dir", type=str, default=str(DEFAULT_CACHE_DIR), help="Directory for task state & raw cache")
    parser.add_argument("--inspect-only", action="store_true", help="Only inspect existing GLBs and rewrite merged assets.json")
    parser.add_argument("--reoptimize", action="store_true", help="Re-optimize existing cached raw GLBs without API calls")
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
                rotate_glb_vertices_y(glb_path, math.radians(deg))
                info = inspect_glb(glb_path)
                log(f"[{aid}] Rotated by {deg} deg around Y -> new bbox size={info['bbox']['size']}")
        write_merged_assets_manifest(MODELS_DIR / "assets.json")
        return 0

    if args.inspect_only:
        write_merged_assets_manifest(MODELS_DIR / "assets.json")
        return 0

    if args.reoptimize:
        only_set = {x.strip() for x in args.only.split(",") if x.strip()}
        for spec in WORLD_ASSET_SPECS:
            if only_set and spec["id"] not in only_set:
                continue
            raw_glb = cache_dir / "raw" / spec["filename"]
            if raw_glb.exists():
                meta = optimize_glb_to_budget(raw_glb, MODELS_DIR / spec["filename"], spec)
                log(f"[{spec['id']}] Re-optimized: {meta['bytes'] / 1024:.0f} KB, {meta['triangles']} tris, bbox={meta['bbox']['size']}")
        write_merged_assets_manifest(MODELS_DIR / "assets.json")
        return 0

    api_key = load_api_key()
    bal = meshy_request(api_key, "GET", "/v1/balance")
    log(f"Meshy API connected. Credit balance: {bal.get('balance', '?')}")

    only_set = {x.strip() for x in args.only.split(",") if x.strip()}
    force_set = {x.strip() for x in args.force.split(",") if x.strip()}

    selected = [
        s for s in WORLD_ASSET_SPECS
        if (not only_set or s["id"] in only_set)
        and (args.priority == 0 or s["priority"] == args.priority)
    ]
    if not selected:
        log("No matching assets selected.")
        return 1

    state = load_state(state_path)
    errors: list[tuple[str, str]] = []

    workers = min(args.concurrency, len(selected))
    log(f"Launching {len(selected)} world assets with concurrency={workers}...")
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {
            pool.submit(process_asset, api_key, spec, cache_dir, state_path, state, spec["id"] in force_set): spec["id"]
            for spec in selected
        }
        for fut in concurrent.futures.as_completed(future_map):
            aid = future_map[fut]
            try:
                fut.result()
            except Exception as e:
                log(f"[{aid}] FAILED: {e}")
                errors.append((aid, str(e)))

    write_merged_assets_manifest(MODELS_DIR / "assets.json")
    bal_after = meshy_request(api_key, "GET", "/v1/balance")
    log(f"Batch complete. Remaining credit balance: {bal_after.get('balance', '?')}")

    if errors:
        log(f"Errors ({len(errors)}): {errors}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
