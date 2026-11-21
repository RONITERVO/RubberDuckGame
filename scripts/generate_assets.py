#!/usr/bin/env python3
"""
River Ducker — Meshy v2 Text-to-3D PBR Asset Pipeline
Generates, downloads, optimizes, inspects, and catalogs game-ready .glb assets.

Security:
  - Reads MESHY_API_KEY from environment or project .env file.
  - Never prints, logs, or persists the API key anywhere.
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
DEFAULT_CACHE_DIR = PROJECT_ROOT / ".cache" / "meshy_cache"
ENV_KEY_PATH = PROJECT_ROOT / ".env"
MESHY_BASE = "https://api.meshy.ai/openapi"

# Cohesive Pacific Northwest creek + iconic glossy yellow bath duck pack
ASSET_SPECS: list[dict[str, Any]] = [
    {
        "id": "rubber_duck",
        "filename": "rubber_duck.glb",
        "priority": 1,
        "role": "hero",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 10000,
        "max_tex_size": 1024,
        "max_glb_mb": 2.4,
        "prompt": (
            "Classic iconic cute rubber bath duck toy, plump rounded floating body with gently "
            "flattened bottom, round adorable head, cheerful smooth rounded orange duck beak "
            "slightly smiling, two large expressive glossy round eyes symmetrically placed on head, "
            "small cute tucked sculpted wings on both sides of the body, tiny cute upturned tail "
            "at the back, smooth seamless vinyl toy silhouette, facing straight forward, upright, "
            "single standalone object, no pedestal, no water, no base"
        ),
        "texture_prompt": (
            "Vibrant glossy sunshine canary yellow rubber bath duck toy with smooth satiny wet "
            "vinyl sheen, bright warm tangerine orange glossy beak, shiny jet black glossy eyes "
            "with crisp white catchlight reflections, subtle soft warm yellow shading around "
            "tucked wings, realistic glossy molded rubber PBR material, clean unblemished bright colors"
        ),
        "default_scale": 1.0,
        "default_y_offset": 0.0,
        "default_rot_y": 0.0,
    },
    {
        "id": "mossy_boulder_a",
        "filename": "mossy_boulder_a.glb",
        "priority": 1,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3800,
        "max_tex_size": 512,
        "max_glb_mb": 1.6,
        "prompt": (
            "Realistic craggy water-worn Pacific Northwest river granite boulder with rich natural "
            "rock crevices, broad organic asymmetrical stone silhouette wider than it is tall, "
            "sculpted thick lumpy velvety forest moss pillows blanketing the entire top half of "
            "the boulder and draping over upper ledges, smooth wet faceted granite base, single "
            "solid monolithic boulder, no floating pieces, no water, no ground plane"
        ),
        "texture_prompt": (
            "Lush vibrant emerald green and sunlit bright chartreuse velvety forest moss covering "
            "the entire upper half and crown of a weathered dark wet charcoal-slate river granite "
            "boulder, speckled natural grey-brown granite stone with damp dark waterlogged lower "
            "sides and subtle pale green lichen spots, photorealistic outdoor nature PBR material"
        ),
        "default_scale": 1.0,
        "default_y_offset": -0.35,
        "default_rot_y": 0.0,
    },
    {
        "id": "mossy_boulder_b",
        "filename": "mossy_boulder_b.glb",
        "priority": 1,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3800,
        "max_tex_size": 512,
        "max_glb_mb": 1.6,
        "prompt": (
            "Dramatic tall jagged Pacific Northwest creek basalt rock spire and outcrop pillar, "
            "distinctly taller than wide with chiseled diagonal layered rock strata ledges, bold "
            "craggy angular silhouette widening slightly at the stable base and tapering to an "
            "uneven rocky crest topped with thick mossy tufts, solid single watertight rock "
            "formation, no holes, no floating pieces, no water"
        ),
        "texture_prompt": (
            "Wet dark charcoal-blue and deep slate layered basalt river rock with glossy wet dark "
            "waterline base and realistic warm grey-brown weathered stone striations, vivid lush "
            "emerald and deep forest green moss cushions thriving on every horizontal rock ledge, "
            "crevice, and summit ridge, photorealistic PBR stone and moss"
        ),
        "default_scale": 1.0,
        "default_y_offset": -0.4,
        "default_rot_y": 0.0,
    },
    {
        "id": "fallen_log_arch",
        "filename": "fallen_log_arch.glb",
        "priority": 1,
        "role": "obstacle",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 4800,
        "max_tex_size": 512,
        "max_glb_mb": 1.8,
        "prompt": (
            "Single continuous horizontal fallen mossy cedar tree trunk forming a clean arched "
            "natural footbridge log spanning left to right, gracefully bowed slightly upward in "
            "the center with open empty space underneath, thick gnarled cylindrical bark trunk "
            "with a few short broken branch stubs attached firmly to the trunk, lush sculpted "
            "moss blanket along the top ridge and small flat shelf bracket fungi fused tightly "
            "onto the upper bark side, strictly one single connected solid object with zero "
            "detached or floating parts underneath"
        ),
        "texture_prompt": (
            "Weathered damp warm reddish-brown and dark umber furrowed cedar tree bark, rich "
            "thick vibrant emerald and bright yellow-green velvety forest moss carpeting the top "
            "ridge of the fallen log, small warm tan-and-cream bracket shelf mushrooms tightly "
            "attached on the upper bark side, realistic damp Pacific Northwest woodland PBR"
        ),
        "default_scale": 1.0,
        "default_y_offset": 0.0,
        "default_rot_y": 0.0,
    },
    {
        "id": "driftwood_roots",
        "filename": "driftwood_roots.glb",
        "priority": 1,
        "role": "obstacle",
        "model_type": "smart-topology",
        "ai_model": "meshy-t2.5",
        "target_polycount": 4500,
        "max_tex_size": 512,
        "max_glb_mb": 1.8,
        "prompt": (
            "Horizontal floating tangled river driftwood log with dramatic gnarly twisted tree "
            "roots and crooked submerged branches hanging densely downward underneath the main "
            "trunk, forming a thick woody barrier along the bottom while the top trunk ridge is "
            "clear and smooth enough to jump over, organic bleached gnarled forest wood snag, "
            "single solid game obstacle asset, no water, no base"
        ),
        "texture_prompt": (
            "Sun-bleached pale driftwood tan and silvery weathered wood along the dry upper "
            "trunk, transitioning to dark wet espresso-brown waterlogged soaked wood and slimy "
            "dark green river algae along the lower tangled roots and hanging branches, rough "
            "wood grain cracks and damp specular sheen on lower wood, photorealistic PBR material"
        ),
        "default_scale": 1.0,
        "default_y_offset": 0.0,
        "default_rot_y": 0.0,
    },
    {
        "id": "pine_tree",
        "filename": "pine_tree.glb",
        "priority": 2,
        "role": "foliage",
        "model_type": "smart-topology",
        "ai_model": "meshy-t2.5",
        "target_polycount": 4500,
        "max_tex_size": 512,
        "max_glb_mb": 1.8,
        "prompt": (
            "Lush Pacific Northwest alpine Douglas fir and spruce pine tree, tall tapered conical "
            "silhouette with rich tiered overlapping foliage bough clusters cascading outward from "
            "bottom to pointed top crown, sturdy straight textured bark trunk visible at the base "
            "and between tiers, clean full stylized-realistic game-ready forest tree silhouette "
            "without noisy thin loose needles, single standalone tree, no ground, no snow"
        ),
        "texture_prompt": (
            "Deep rich Pacific Northwest evergreen pine needles in layered dark forest green and "
            "fresh sunlit mossy-green bough tips, warm reddish-brown furrowed conifer bark on the "
            "sturdy lower trunk with subtle green lichen touches, crisp game-ready realistic "
            "nature PBR textures"
        ),
        "default_scale": 1.0,
        "default_y_offset": 0.0,
        "default_rot_y": 0.0,
    },
    {
        "id": "fern_cluster",
        "filename": "fern_cluster.glb",
        "priority": 2,
        "role": "foliage",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 2800,
        "max_tex_size": 512,
        "max_glb_mb": 1.4,
        "prompt": (
            "Lush Pacific Northwest woodland sword fern foliage bush, dense low radial rosette of "
            "16 broad gracefully arching serrated green fern fronds fanning outward and upward from "
            "a flat ground-level base, full low-lying forest bush silhouette sitting flat at bottom, "
            "no exposed roots underneath, no stems hanging below, no pot, no dirt block"
        ),
        "texture_prompt": (
            "Vibrant lush woodland sword fern foliage with sunlit bright chartreuse-green inner "
            "fronds transitioning to deep rich emerald forest green outer fronds, crisp fern pinnae "
            "leaf detail and fresh dewy forest sheen, realistic nature PBR foliage texture"
        ),
        "default_scale": 1.0,
        "default_y_offset": -0.15,
        "default_rot_y": 0.0,
    },
    {
        "id": "river_trout",
        "filename": "river_trout.glb",
        "priority": 2,
        "role": "wildlife",
        "model_type": "smart-topology",
        "ai_model": "meshy-t2.5",
        "target_polycount": 2500,
        "max_tex_size": 512,
        "max_glb_mb": 1.4,
        "prompt": (
            "Sleek streamlined Pacific Northwest rainbow river trout fish swimming straight "
            "forward, smooth hydrodynamic torpedo body, crisp dorsal fin, forked tail fin, "
            "pectoral and pelvic fins neatly sculpted, expressive fish eyes and small closed "
            "mouth, straight horizontal swimming pose facing forward, single standalone fish "
            "model, no stand, no water"
        ),
        "texture_prompt": (
            "Iridescent wet rainbow trout scales with olive-emerald speckled dark back, "
            "shimmering rosy-pink iridescent lateral stripe down each side, pearlescent "
            "silver-white belly, fine black speckles along dorsal and tail fins, glossy wet "
            "metallic-iridescent fish skin PBR material"
        ),
        "default_scale": 1.0,
        "default_y_offset": 0.0,
        "default_rot_y": 0.0,
    },
    {
        "id": "duckling",
        "filename": "duckling.glb",
        "priority": 2,
        "role": "wildlife",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 3500,
        "max_tex_size": 512,
        "max_glb_mb": 1.5,
        "prompt": (
            "Tiny adorable stylized Pixar-like baby duckling floating peacefully on water, "
            "smooth plump rounded swimming body with gently flattened floating belly and NO legs "
            "visible underneath, cute slightly oversized round head, tiny soft rounded peach-orange "
            "beak, big dark glossy expressive eyes, small smooth rounded tucked wings, tiny cute "
            "upturned tail, smooth clean silhouette without spiky geometry, facing straight forward, "
            "no water, no base"
        ),
        "texture_prompt": (
            "Soft warm buttercup-yellow velvety baby duckling plumage with gentle golden-yellow "
            "shading on cheeks and tucked wings, soft matte downy PBR roughness, cute warm "
            "peach-orange rounded beak, glossy dark expressive eyes with bright white catchlights"
        ),
        "default_scale": 1.0,
        "default_y_offset": 0.0,
        "default_rot_y": 0.0,
    },
    {
        "id": "duck_wing",
        "filename": "duck_wing.glb",
        "priority": 2,
        "role": "hero_part",
        "model_type": "standard",
        "ai_model": "meshy-7.1",
        "should_remesh": True,
        "topology": "triangle",
        "target_polycount": 1600,
        "max_tex_size": 512,
        "max_glb_mb": 0.9,
        "prompt": (
            "Single isolated detached stylized cartoon bird wing accessory piece ONLY, smooth "
            "plump horizontal teardrop flipper wing paddle extending sideways with three soft "
            "rounded sculpted scalloped feather tips at the outer edge and a smooth rounded ball "
            "joint root at the inner edge, gently curved airfoil thickness like a glossy toy "
            "appendage part, strictly ONLY ONE detached wing piece by itself with no animal, "
            "no body, no head, no eyes, no beak, no stand"
        ),
        "texture_prompt": (
            "Solid vibrant glossy sunshine canary yellow molded rubber toy vinyl material, smooth "
            "satiny wet sheen matching a bright yellow bath toy, subtle warm golden-yellow shading "
            "between the three smooth rounded scalloped feather ridges, clean uniform bright yellow PBR"
        ),
        "default_scale": 1.0,
        "default_y_offset": 0.0,
        "default_rot_y": 0.0,
    },
]

STATE_LOCK = threading.Lock()
PRINT_LOCK = threading.Lock()


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
                wait = float(retry_after) if retry_after and retry_after.isdigit() else min(30.0, 2.0 * (1.6 ** attempt))
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
            req = urllib.request.Request(url, headers={"User-Agent": "RiverDuckerAssetPipeline/1.0"})
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
# glTF 2.0 / GLB binary parsing, inspection, and texture optimization
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
    # Pad BIN chunk to 4-byte boundary with 0x00
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
    # Column-major 4x4 matrix multiplication (glTF convention)
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
    comp_type = acc["componentType"]
    if comp_type != 5126:  # FLOAT
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
                mode = prim.get("mode", 4)  # 4 = TRIANGLES
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
        # Fallback if no scenes
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

    # Inspect images & PBR material channels
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


def optimize_glb_textures(src_path: Path, dst_path: Path, max_dim: int = 512, jpeg_quality: int = 3) -> dict[str, Any]:
    """
    Re-encodes embedded textures inside a GLB cleanly using ffmpeg so mobile WebGL2
    loads rapidly without losing visual crispness.
    - Keeps glTF 2.0 core-spec image/jpeg & image/png (100% browser compatible).
    - Uses JPEG for opaque baseColor/normal/metallicRoughness when significantly smaller
      (high quality q=2..4 avoids visible artifacts while slashing 4-8x file size).
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

    # Identify which image indices are used for which PBR role
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

    with tempfile.TemporaryDirectory(prefix="glb_opt_") as tmpdir:
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

                # Determine target resolution (preserve aspect ratio, cap longest side at max_dim)
                target_max = max_dim
                # Normal & ORM maps don't need >512 on environment props; hero keeps up to max_dim
                if max_dim >= 1024 and ("metallicRoughness" in roles or "occlusion" in roles) and "baseColor" not in roles:
                    target_max = 512

                ext_in = ".jpg" if "jpeg" in mime else ".png"
                in_file = tmp / f"in_{img_idx}{ext_in}"
                in_file.write_bytes(slice_bytes)

                # If needs alpha channel, keep PNG; otherwise encode high-quality JPEG (and compare against resized PNG)
                keep_png = "hasAlpha" in roles
                vf = f"scale='min({target_max},iw)':'min({target_max},ih)':force_original_aspect_ratio=decrease:flags=lanczos"

                if keep_png:
                    out_png = tmp / f"out_{img_idx}.png"
                    cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", str(in_file), "-vf", vf, "-compression_level", "9", str(out_png)]
                    subprocess.run(cmd, check=True)
                    new_bytes = out_png.read_bytes()
                    new_mime = "image/png"
                else:
                    # Use q:v 2 for normal/metallicRoughness (minimal compression artifacts), q:v 3 for baseColor
                    q = 2 if ("normal" in roles or "metallicRoughness" in roles) else jpeg_quality
                    out_jpg = tmp / f"out_{img_idx}.jpg"
                    cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", str(in_file), "-vf", vf, "-q:v", str(q), str(out_jpg)]
                    subprocess.run(cmd, check=True)
                    jpg_bytes = out_jpg.read_bytes()

                    # Only accept re-encoded bytes if smaller or if we downscaled oversized textures
                    if len(jpg_bytes) < len(slice_bytes) or max(w, h) > target_max:
                        new_bytes = jpg_bytes
                        new_mime = "image/jpeg"
                    else:
                        new_bytes = slice_bytes
                        new_mime = mime

                img["mimeType"] = new_mime
                slice_bytes = new_bytes

            # 4-byte align every bufferView
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


# ---------------------------------------------------------------------------
# End-to-end per-asset pipeline
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
        update_asset_state(state_path, state, asset_id, {"preview_task_id": None, "refine_task_id": None, "status": "restarting"})

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

    # 4. Optimize embedded textures for mobile WebGL2 60fps & fast GitHub Pages load
    max_dim = spec["max_tex_size"]
    meta = optimize_glb_textures(raw_glb, final_glb, max_dim=max_dim, jpeg_quality=3)

    # If still over per-asset size budget, tighten compression slightly
    if meta["bytes"] > spec["max_glb_mb"] * 1024 * 1024 and max_dim > 512:
        meta = optimize_glb_textures(raw_glb, final_glb, max_dim=512, jpeg_quality=4)
    elif meta["bytes"] > spec["max_glb_mb"] * 1024 * 1024:
        meta = optimize_glb_textures(raw_glb, final_glb, max_dim=512, jpeg_quality=5)

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
    return {"id": asset_id, "spec": spec, "meta": meta}


# Articulated hero DuckRig attachment offsets (in normalized Duck Scale, 1u = 10cm, +Z forward, +Y up)
DUCK_ATTACHMENTS: dict[str, Any] = {
    "wingLeftOffset": [0.42, 0.36, -0.02],
    "wingRightOffset": [-0.42, 0.36, -0.02],
    "wingScale": 1.22,
    "feetOffset": [0.0, -0.15, -0.06],
    "headOffset": [0.0, 0.88, 0.14],
}

# Normalization defaults matching src/assets/manifest.ts
MANIFEST_OVERRIDES: dict[str, dict[str, Any]] = {
    "rubber_duck": {"targetSize": 1.25, "sizeAxis": "z", "pivot": "waterline", "yOffset": 0.0, "rotY": 0.18},
    "duck_wing": {"targetSize": 0.56, "sizeAxis": "max", "pivot": "center", "yOffset": 0.0, "rotY": 0.0},
    "mossy_boulder_a": {"targetSize": 3.6, "sizeAxis": "max", "pivot": "bottom", "yOffset": -0.35, "rotY": 0.0},
    "mossy_boulder_b": {"targetSize": 4.2, "sizeAxis": "y", "pivot": "bottom", "yOffset": -0.4, "rotY": 0.0},
    "fallen_log_arch": {"targetSize": 11.5, "sizeAxis": "x", "pivot": "center", "yOffset": 0.0, "rotY": 0.0},
    "driftwood_roots": {"targetSize": 6.4, "sizeAxis": "x", "pivot": "center", "yOffset": -0.18, "rotY": 0.0},
    "pine_tree": {"targetSize": 22.0, "sizeAxis": "y", "pivot": "bottom", "yOffset": -0.5, "rotY": 0.0},
    "fern_cluster": {"targetSize": 3.4, "sizeAxis": "max", "pivot": "bottom", "yOffset": -0.52, "rotY": 0.0},
    "river_trout": {"targetSize": 1.85, "sizeAxis": "z", "pivot": "center", "yOffset": 0.0, "rotY": 0.0},
    "duckling": {"targetSize": 0.68, "sizeAxis": "z", "pivot": "waterline", "yOffset": -0.08, "rotY": 0.06},
}


def write_assets_manifest(out_path: Path) -> None:
    """Inspect all existing GLBs in MODELS_DIR and write public/models/assets.json."""
    models_map: dict[str, Any] = {}
    total_bytes = 0
    total_tris = 0

    for spec in ASSET_SPECS:
        glb_path = MODELS_DIR / spec["filename"]
        if not glb_path.exists():
            continue
        info = inspect_glb(glb_path)
        total_bytes += info["bytes"]
        total_tris += info["triangles"]
        bbox = info["bbox"]
        ov = MANIFEST_OVERRIDES.get(spec["id"], {})
        target_size = ov.get("targetSize", 1.0)
        size_axis = ov.get("sizeAxis", "max")
        pivot = ov.get("pivot", "bottom")
        y_offset = ov.get("yOffset", spec.get("default_y_offset", 0.0))
        rot_y = ov.get("rotY", spec.get("default_rot_y", 0.0))

        axis_idx = {"x": 0, "y": 1, "z": 2}.get(size_axis)
        measured = bbox["size"][axis_idx] if axis_idx is not None else max(bbox["size"])
        rec_scale = round(target_size / measured, 5) if measured > 1e-4 else 1.0

        entry: dict[str, Any] = {
            "id": spec["id"],
            "filename": spec["filename"],
            "file": spec["filename"],
            "url": f"./models/{spec['filename']}",
            "role": spec["role"],
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
        if spec["id"] == "rubber_duck":
            entry["wingAttachments"] = DUCK_ATTACHMENTS
        models_map[spec["id"]] = entry

    manifest = {
        "version": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "coordinateConvention": "+Z forward, +Y up, 1.0 world unit = 10cm (Duck Scale)",
        "totalBytes": total_bytes,
        "totalTriangles": total_tris,
        "duckAttachments": DUCK_ATTACHMENTS,
        "models": models_map,
    }
    out_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    log(f"Wrote {out_path} ({len(models_map)} models, {total_bytes / 1024 / 1024:.2f} MB total, {total_tris:,} tris total)")


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate River Ducker PBR 3D assets via Meshy v2 API.")
    parser.add_argument("--only", type=str, default="", help="Comma-separated asset IDs to generate (default: all)")
    parser.add_argument("--priority", type=int, default=0, help="Only run assets with this priority (1 or 2)")
    parser.add_argument("--force", type=str, default="", help="Comma-separated asset IDs to force regenerate")
    parser.add_argument("--concurrency", type=int, default=9, help="Max concurrent Meshy tasks")
    parser.add_argument("--cache-dir", type=str, default=str(DEFAULT_CACHE_DIR), help="Directory for task state & raw cache")
    parser.add_argument("--inspect-only", action="store_true", help="Only inspect existing GLBs and rewrite assets.json")
    parser.add_argument("--reoptimize", action="store_true", help="Re-optimize existing cached raw GLBs without API calls")
    parser.add_argument("--no-manifest", action="store_true", help="Skip rewriting assets.json on completion")
    args = parser.parse_args()

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    cache_dir = Path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    state_path = cache_dir / "state.json"

    if args.inspect_only:
        write_assets_manifest(MODELS_DIR / "assets.json")
        return 0

    if args.reoptimize:
        for spec in ASSET_SPECS:
            raw_glb = cache_dir / "raw" / spec["filename"]
            if raw_glb.exists():
                meta = optimize_glb_textures(raw_glb, MODELS_DIR / spec["filename"], max_dim=spec["max_tex_size"], jpeg_quality=3)
                log(f"[{spec['id']}] Re-optimized: {meta['bytes'] / 1024:.0f} KB, {meta['triangles']} tris")
        write_assets_manifest(MODELS_DIR / "assets.json")
        return 0

    api_key = load_api_key()
    bal = meshy_request(api_key, "GET", "/v1/balance")
    log(f"Meshy API connected. Credit balance: {bal.get('balance', '?')}")

    only_set = {x.strip() for x in args.only.split(",") if x.strip()}
    force_set = {x.strip() for x in args.force.split(",") if x.strip()}

    selected = [
        s for s in ASSET_SPECS
        if (not only_set or s["id"] in only_set)
        and (args.priority == 0 or s["priority"] == args.priority)
    ]
    if not selected:
        log("No matching assets selected.")
        return 1

    state = load_state(state_path)
    errors: list[tuple[str, str]] = []

    log(f"Launching {len(selected)} assets with concurrency={min(args.concurrency, len(selected))}...")
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(args.concurrency, len(selected))) as pool:
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

    if not args.no_manifest:
        write_assets_manifest(MODELS_DIR / "assets.json")
    bal_after = meshy_request(api_key, "GET", "/v1/balance")
    log(f"Done. Remaining credit balance: {bal_after.get('balance', '?')}")

    if errors:
        log(f"Errors ({len(errors)}): {errors}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
