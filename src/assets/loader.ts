import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type {
  AssetFallbackArchetype,
  AssetId,
  AssetSpec,
  DuckRig,
  DuckState,
  DuckWingAttachments,
  LoadedAsset,
} from '../types';
import {
  ALL_ASSET_IDS,
  DEFAULT_DUCK_ATTACHMENTS,
  getAssetSpec,
  HERO_CORE_ASSET_IDS,
  loadAssetManifest,
  MANIFEST_URL,
  mergeManifestFromUrl,
  registerAssetSpecs as registerGlobalAssetSpecs,
  resolveModelUrl,
  type ResolvedAssetManifest,
} from './manifest';

const DEFAULT_CORE_TRACK_ID = 'pnw-creek';

const DEFAULT_DRACO_DECODER_PATH =
  'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';

/**
 * Count total triangles across all Mesh children in an Object3D subtree.
 */
function countTriangles(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geom = obj.geometry;
    if (!geom) return;
    if (geom.index) {
      tris += geom.index.count / 3;
    } else {
      const pos = geom.attributes.position;
      if (pos) tris += pos.count / 3;
    }
  });
  return Math.round(tris);
}

/**
 * Configure shadows and PBR material safety flags across an Object3D subtree.
 */
function applyShadowAndMaterialDefaults(
  root: THREE.Object3D,
  castShadow: boolean,
  receiveShadow: boolean,
  envMapIntensity: number = 1.0,
): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.castShadow = castShadow;
    obj.receiveShadow = receiveShadow;

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.envMapIntensity = Math.max(mat.envMapIntensity || 0, envMapIntensity);
      }
    }
  });
}

/**
 * Create a high-gloss bath-rubber yellow material matching iconic rubber ducks.
 */
function createDuckYellowMaterial(
  colorHex: THREE.ColorRepresentation = 0xffd41c,
): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: colorHex,
    roughness: 0.24,
    metalness: 0.02,
    clearcoat: 0.85,
    clearcoatRoughness: 0.14,
  });
}

/**
 * Create a glossy bright-orange bath-rubber material for duck beak & webbed feet.
 */
function createDuckOrangeMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xff6e1a,
    roughness: 0.28,
    metalness: 0.02,
    clearcoat: 0.72,
    clearcoatRoughness: 0.18,
  });
}

/**
 * Sample dominant yellow rubber tone from a loaded GLB rubber duck body so
 * attached articulated wings blend cleanly with the Meshy PBR material.
 */
function sampleDuckBodyMaterial(
  bodyGroup: THREE.Object3D,
): THREE.MeshPhysicalMaterial {
  let sampledColor: THREE.Color | null = null;
  let sampledRoughness = 0.24;

  bodyGroup.traverse((obj) => {
    if (sampledColor || !(obj instanceof THREE.Mesh)) return;
    const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    if (mat instanceof THREE.MeshStandardMaterial) {
      // Only trust mat.color if no base texture map overrides it with pure white tint
      if (!mat.map && mat.color) {
        sampledColor = mat.color.clone();
      }
      if (Number.isFinite(mat.roughness)) {
        sampledRoughness = THREE.MathUtils.clamp(mat.roughness * 0.85, 0.16, 0.42);
      }
    }
  });

  const material = createDuckYellowMaterial(sampledColor ?? 0xffd21f);
  material.roughness = sampledRoughness;
  return material;
}

/**
 * Build a sculpted glossy rubber wing extending from shoulder pivot (0,0,0)
 * outward along +X and swept slightly toward -Z.
 */
function buildProceduralDuckWing(
  material: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'procedural_duck_wing';

  // Teardrop wing blade built from a flattened stretched sphere + feather tip lobe
  const mainGeom = new THREE.SphereGeometry(0.24, 16, 12);
  mainGeom.scale(1.25, 0.34, 0.82);
  const mainMesh = new THREE.Mesh(mainGeom, material);
  mainMesh.position.set(0.24, 0.0, -0.05);
  mainMesh.rotation.y = 0.22;
  group.add(mainMesh);

  const tipGeom = new THREE.SphereGeometry(0.14, 12, 10);
  tipGeom.scale(1.15, 0.28, 0.65);
  const tipMesh = new THREE.Mesh(tipGeom, material);
  tipMesh.position.set(0.42, 0.01, -0.14);
  tipMesh.rotation.y = 0.38;
  group.add(tipMesh);

  return group;
}

/**
 * Build an adorable webbed paddling foot extending from hip/ankle pivot (0,0,0)
 * downward and slightly backward for lively underwater & surface kicks.
 */
function buildWebbedFoot(material: THREE.Material): THREE.Group {
  const foot = new THREE.Group();

  // Short rubber ankle stub
  const ankleGeom = new THREE.CylinderGeometry(0.045, 0.04, 0.14, 8);
  const ankle = new THREE.Mesh(ankleGeom, material);
  ankle.position.set(0, -0.06, 0);
  foot.add(ankle);

  // Sculpted 3-toe webbed paddle shape
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(-0.13, -0.14, -0.14, -0.26);
  shape.quadraticCurveTo(-0.07, -0.22, -0.04, -0.29);
  shape.quadraticCurveTo(0, -0.31, 0.04, -0.29);
  shape.quadraticCurveTo(0.07, -0.22, 0.14, -0.26);
  shape.quadraticCurveTo(0.13, -0.14, 0, 0);

  const paddleGeom = new THREE.ExtrudeGeometry(shape, {
    depth: 0.032,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.012,
    bevelSegments: 2,
  });
  paddleGeom.rotateX(Math.PI * 0.5);
  const paddle = new THREE.Mesh(paddleGeom, material);
  paddle.position.set(0, -0.13, 0.04);
  foot.add(paddle);

  return foot;
}

/**
 * Generic data-driven procedural fallback builder for ANY contributor pack asset
 * based on `spec.fallbackArchetype` + `spec.fallbackColor` — eliminates any need
 * to edit `loader.ts` when adding new custom `.glb` assets!
 */
function buildArchetypeFallback(
  archetype: AssetFallbackArchetype,
  colorHex: number = 0x6b7280,
): THREE.Group {
  const group = new THREE.Group();
  const baseMat = new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: archetype === 'crystal' ? 0.18 : 0.78,
    metalness: archetype === 'crystal' ? 0.1 : 0.05,
    flatShading: true,
    ...(archetype === 'crystal'
      ? { emissive: colorHex, emissiveIntensity: 0.45 }
      : {}),
  });

  switch (archetype) {
    case 'tree': {
      const trunkMat = new THREE.MeshStandardMaterial({
        color: 0x543927,
        roughness: 0.92,
      });
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.85, 6.0, 8),
        trunkMat,
      );
      trunk.position.y = 3.0;
      group.add(trunk);

      const canopy1 = new THREE.Mesh(
        new THREE.DodecahedronGeometry(3.6, 1),
        baseMat,
      );
      canopy1.scale.set(1.1, 0.85, 1.1);
      canopy1.position.y = 8.4;
      group.add(canopy1);

      const canopy2 = new THREE.Mesh(
        new THREE.DodecahedronGeometry(2.6, 1),
        baseMat,
      );
      canopy2.position.set(1.4, 7.2, 0.8);
      group.add(canopy2);
      break;
    }

    case 'rock': {
      const rock = new THREE.Mesh(
        new THREE.DodecahedronGeometry(1.75, 1),
        baseMat,
      );
      rock.scale.set(1.15, 0.8, 1.05);
      rock.position.y = 1.1;
      group.add(rock);
      break;
    }

    case 'arch': {
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-5.8, -1.6, 0),
        new THREE.Vector3(0, 3.6, 0.15),
        new THREE.Vector3(5.8, -1.6, 0),
      );
      const arch = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 16, 0.92, 7, false),
        baseMat,
      );
      group.add(arch);
      break;
    }

    case 'pillar': {
      const spire = new THREE.Mesh(
        new THREE.CylinderGeometry(0.95, 1.65, 5.2, 7),
        baseMat,
      );
      spire.position.y = 2.6;
      group.add(spire);
      break;
    }

    case 'foliage': {
      baseMat.side = THREE.DoubleSide;
      for (let i = 0; i < 7; i++) {
        const angle = (i / 7) * Math.PI * 2;
        const blade = new THREE.Mesh(
          new THREE.ConeGeometry(0.36, 2.2, 4),
          baseMat,
        );
        blade.scale.set(1, 1, 0.18);
        blade.position.y = 1.0;
        blade.rotation.y = angle;
        blade.rotation.x = 0.72 + (i % 2) * 0.18;
        group.add(blade);
      }
      break;
    }

    case 'fish': {
      const bodyGeom = new THREE.SphereGeometry(0.42, 12, 10);
      bodyGeom.scale(0.45, 0.65, 2.0);
      group.add(new THREE.Mesh(bodyGeom, baseMat));
      const tailGeom = new THREE.ConeGeometry(0.3, 0.45, 4);
      tailGeom.scale(0.2, 1.0, 1.0);
      tailGeom.rotateX(Math.PI * 0.5);
      const tail = new THREE.Mesh(tailGeom, baseMat);
      tail.position.z = -0.95;
      group.add(tail);
      break;
    }

    case 'critter': {
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(0.32, 12, 10),
        baseMat,
      );
      body.position.y = 0.32;
      group.add(body);
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 10, 8),
        baseMat,
      );
      head.position.set(0, 0.65, 0.18);
      group.add(head);
      break;
    }

    case 'log': {
      const logGeom = new THREE.CylinderGeometry(0.48, 0.54, 6.2, 10);
      logGeom.rotateZ(Math.PI * 0.5);
      const log = new THREE.Mesh(logGeom, baseMat);
      log.position.y = 0.25;
      group.add(log);
      break;
    }

    case 'pad': {
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(1.65, 1.6, 0.18, 16),
        baseMat,
      );
      disc.position.y = 0.09;
      group.add(disc);
      break;
    }

    case 'landmark': {
      const plinth = new THREE.Mesh(
        new THREE.BoxGeometry(3.2, 1.4, 3.2),
        baseMat,
      );
      plinth.position.y = 0.7;
      group.add(plinth);
      const tower = new THREE.Mesh(
        new THREE.BoxGeometry(2.0, 5.2, 2.0),
        baseMat,
      );
      tower.position.y = 4.0;
      group.add(tower);
      break;
    }

    case 'boat': {
      const hullGeom = new THREE.SphereGeometry(1.1, 14, 10, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55);
      hullGeom.scale(0.65, 0.65, 2.2);
      const hull = new THREE.Mesh(hullGeom, baseMat);
      hull.position.y = 0.45;
      group.add(hull);
      break;
    }

    case 'crystal': {
      const main = new THREE.Mesh(
        new THREE.ConeGeometry(0.85, 3.4, 6),
        baseMat,
      );
      main.position.y = 1.7;
      group.add(main);
      for (const side of [-1, 1]) {
        const shard = new THREE.Mesh(
          new THREE.ConeGeometry(0.55, 2.2, 5),
          baseMat,
        );
        shard.position.set(side * 0.75, 1.1, side * 0.25);
        shard.rotation.z = -side * 0.34;
        group.add(shard);
      }
      break;
    }
  }

  return group;
}

/**
 * High-craft procedural Three.js fallback meshes for built-in assets plus automatic
 * archetype-driven fallback synthesis for ANY contributor pack asset!
 */
function buildProceduralFallback(id: AssetId, spec?: AssetSpec): THREE.Group {
  const group = new THREE.Group();
  group.name = `fallback_${id}`;

  switch (id) {
    case 'rubber_duck': {
      const yellow = createDuckYellowMaterial();
      const orange = createDuckOrangeMaterial();
      const eyeDark = new THREE.MeshPhysicalMaterial({
        color: 0x11131a,
        roughness: 0.08,
        clearcoat: 1.0,
      });
      const glintWhite = new THREE.MeshBasicMaterial({ color: 0xffffff });

      // Plump floating body (+Z forward)
      const bodyGeom = new THREE.SphereGeometry(0.48, 22, 16);
      bodyGeom.scale(0.95, 0.76, 1.24);
      const body = new THREE.Mesh(bodyGeom, yellow);
      body.position.set(0, 0.34, -0.02);
      group.add(body);

      // Cute chest puff
      const chestGeom = new THREE.SphereGeometry(0.32, 16, 12);
      chestGeom.scale(0.92, 0.88, 0.9);
      const chest = new THREE.Mesh(chestGeom, yellow);
      chest.position.set(0, 0.44, 0.28);
      group.add(chest);

      // Upturned bath-duck tail
      const tailGeom = new THREE.ConeGeometry(0.2, 0.34, 12);
      const tail = new THREE.Mesh(tailGeom, yellow);
      tail.position.set(0, 0.52, -0.52);
      tail.rotation.x = -0.95;
      tail.name = 'procedural_tail';
      group.add(tail);

      // Head group
      const headGroup = new THREE.Group();
      headGroup.name = 'procedural_head';
      headGroup.position.set(0, 0.78, 0.24);

      const headGeom = new THREE.SphereGeometry(0.32, 20, 16);
      headGeom.scale(0.98, 0.96, 1.02);
      const head = new THREE.Mesh(headGeom, yellow);
      headGroup.add(head);

      // Rounded smiling orange beak
      const upperBeakGeom = new THREE.SphereGeometry(0.14, 14, 10);
      upperBeakGeom.scale(1.15, 0.44, 1.38);
      const upperBeak = new THREE.Mesh(upperBeakGeom, orange);
      upperBeak.position.set(0, -0.02, 0.31);
      headGroup.add(upperBeak);

      const lowerBeakGeom = new THREE.SphereGeometry(0.11, 12, 8);
      lowerBeakGeom.scale(1.0, 0.35, 1.15);
      const lowerBeak = new THREE.Mesh(lowerBeakGeom, orange);
      lowerBeak.position.set(0, -0.075, 0.28);
      headGroup.add(lowerBeak);

      // Expressive glossy dark eyes + crisp white catchlights
      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.056, 12, 10), eyeDark);
        eye.position.set(side * 0.16, 0.08, 0.23);
        headGroup.add(eye);

        const glint = new THREE.Mesh(
          new THREE.SphereGeometry(0.02, 8, 8),
          glintWhite,
        );
        glint.position.set(side * 0.175, 0.105, 0.275);
        headGroup.add(glint);
      }

      group.add(headGroup);
      break;
    }

    case 'duck_wing': {
      const wing = buildProceduralDuckWing(createDuckYellowMaterial());
      group.add(wing);
      break;
    }

    case 'mossy_boulder_a': {
      const rockMat = new THREE.MeshStandardMaterial({
        color: 0x515b5e,
        roughness: 0.72,
        metalness: 0.05,
        flatShading: true,
      });
      const mossMat = new THREE.MeshStandardMaterial({
        color: 0x3b8a3e,
        roughness: 0.9,
        flatShading: true,
      });

      const rockGeom = new THREE.DodecahedronGeometry(1.75, 1);
      const pos = rockGeom.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i);
        const vy = pos.getY(i);
        const vz = pos.getZ(i);
        const jitter =
          0.86 +
          0.2 * Math.sin(vx * 2.1 + vz * 1.7) +
          0.12 * Math.cos(vy * 3.1);
        pos.setXYZ(i, vx * jitter * 1.1, vy * jitter * 0.78, vz * jitter);
      }
      rockGeom.computeVertexNormals();
      const rock = new THREE.Mesh(rockGeom, rockMat);
      rock.position.y = 1.1;
      group.add(rock);

      // Lush moss cap
      const mossGeom = new THREE.SphereGeometry(1.38, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.48);
      mossGeom.scale(1.12, 0.56, 1.0);
      const moss = new THREE.Mesh(mossGeom, mossMat);
      moss.position.y = 1.68;
      group.add(moss);
      break;
    }

    case 'mossy_boulder_b': {
      const rockMat = new THREE.MeshStandardMaterial({
        color: 0x455054,
        roughness: 0.68,
        flatShading: true,
      });
      const mossMat = new THREE.MeshStandardMaterial({
        color: 0x2f7d44,
        roughness: 0.92,
        flatShading: true,
      });

      const pillarGeom = new THREE.CylinderGeometry(0.95, 1.75, 4.2, 7, 3);
      const pos = pillarGeom.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i);
        const vy = pos.getY(i);
        const vz = pos.getZ(i);
        const n = 0.85 + 0.25 * Math.sin(vx * 1.9 + vy * 1.3 + vz * 2.1);
        pos.setXYZ(i, vx * n, vy, vz * n);
      }
      pillarGeom.computeVertexNormals();
      const pillar = new THREE.Mesh(pillarGeom, rockMat);
      pillar.position.y = 2.1;
      group.add(pillar);

      const tuft = new THREE.Mesh(new THREE.DodecahedronGeometry(0.82, 0), mossMat);
      tuft.scale.set(1.2, 0.55, 1.1);
      tuft.position.set(0.15, 3.85, 0.1);
      group.add(tuft);
      break;
    }

    case 'fallen_log_arch': {
      const barkMat = new THREE.MeshStandardMaterial({
        color: 0x5c3e26,
        roughness: 0.92,
      });
      const mossMat = new THREE.MeshStandardMaterial({
        color: 0x3f8f3b,
        roughness: 0.9,
      });

      // Gently arched trunk spanning along X (-5.75..+5.75)
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-5.75, -0.55, 0),
        new THREE.Vector3(0, 0.55, 0.2),
        new THREE.Vector3(5.75, -0.55, 0),
      );
      const trunkGeom = new THREE.TubeGeometry(curve, 18, 0.72, 10, false);
      const trunk = new THREE.Mesh(trunkGeom, barkMat);
      group.add(trunk);

      // Moss cushion pads along top
      for (const xOff of [-2.4, 0.0, 2.3]) {
        const pad = new THREE.Mesh(new THREE.SphereGeometry(0.68, 10, 8), mossMat);
        pad.scale.set(2.1, 0.42, 0.95);
        pad.position.set(xOff, xOff === 0 ? 1.05 : 0.72, 0.05);
        group.add(pad);
      }
      break;
    }

    case 'driftwood_roots': {
      const woodMat = new THREE.MeshStandardMaterial({
        color: 0x735b44,
        roughness: 0.88,
      });
      const rootMat = new THREE.MeshStandardMaterial({
        color: 0x453526,
        roughness: 0.95,
      });

      // Floating horizontal driftwood trunk along X
      const logGeom = new THREE.CylinderGeometry(0.46, 0.54, 6.4, 10);
      logGeom.rotateZ(Math.PI * 0.5);
      const log = new THREE.Mesh(logGeom, woodMat);
      log.position.y = 0.25;
      group.add(log);

      // Tangled downward-hanging roots underneath signaling "jump over, don't dive!"
      for (let i = -2; i <= 2; i++) {
        const rootGeom = new THREE.ConeGeometry(0.18, 2.1, 6);
        rootGeom.rotateX(Math.PI);
        const root = new THREE.Mesh(rootGeom, rootMat);
        root.position.set(i * 1.15, -0.85, (i % 2) * 0.22);
        root.rotation.z = i * 0.14;
        group.add(root);
      }
      break;
    }

    case 'pine_tree': {
      const trunkMat = new THREE.MeshStandardMaterial({
        color: 0x4f3524,
        roughness: 0.95,
      });
      const foliageMat = new THREE.MeshStandardMaterial({
        color: 0x225c33,
        roughness: 0.88,
        flatShading: true,
      });

      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 1.05, 6.2, 8),
        trunkMat,
      );
      trunk.position.y = 3.1;
      group.add(trunk);

      const tiers = [
        { y: 7.5, r: 4.8, h: 7.0 },
        { y: 12.0, r: 4.0, h: 6.5 },
        { y: 16.0, r: 3.1, h: 5.8 },
        { y: 19.3, r: 2.0, h: 4.8 },
      ];
      for (const t of tiers) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(t.r, t.h, 8), foliageMat);
        cone.position.y = t.y;
        group.add(cone);
      }
      break;
    }

    case 'fern_cluster': {
      const frondMat = new THREE.MeshStandardMaterial({
        color: 0x358c3c,
        roughness: 0.78,
        side: THREE.DoubleSide,
      });
      const frondCount = 9;
      for (let i = 0; i < frondCount; i++) {
        const angle = (i / frondCount) * Math.PI * 2;
        const frondGeom = new THREE.ConeGeometry(0.38, 2.1, 4);
        frondGeom.scale(1.0, 1.0, 0.14);
        frondGeom.translate(0, 1.05, 0);
        const frond = new THREE.Mesh(frondGeom, frondMat);
        frond.rotation.y = angle;
        frond.rotation.x = 0.85 + (i % 2) * 0.22;
        group.add(frond);
      }
      break;
    }

    case 'river_trout': {
      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0x4e8a8f,
        roughness: 0.25,
        metalness: 0.35,
      });
      const stripeMat = new THREE.MeshStandardMaterial({
        color: 0xd96b78,
        roughness: 0.32,
        metalness: 0.2,
      });
      const bodyGeom = new THREE.SphereGeometry(0.42, 14, 10);
      bodyGeom.scale(0.45, 0.65, 2.0);
      const body = new THREE.Mesh(bodyGeom, bodyMat);
      group.add(body);

      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 0.1, 1.1),
        stripeMat,
      );
      group.add(stripe);

      const tailGeom = new THREE.ConeGeometry(0.3, 0.45, 4);
      tailGeom.scale(0.18, 1.0, 1.0);
      tailGeom.rotateX(Math.PI * 0.5);
      const tail = new THREE.Mesh(tailGeom, bodyMat);
      tail.position.z = -0.95;
      group.add(tail);
      break;
    }

    case 'duckling': {
      const fluffYellow = new THREE.MeshStandardMaterial({
        color: 0xffe44d,
        roughness: 0.62,
      });
      const beakOrange = createDuckOrangeMaterial();
      const eyeDark = new THREE.MeshBasicMaterial({ color: 0x111111 });

      const body = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), fluffYellow);
      body.scale.set(0.95, 0.8, 1.2);
      body.position.set(0, 0.2, 0);
      group.add(body);

      const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), fluffYellow);
      head.position.set(0, 0.44, 0.14);
      group.add(head);

      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.14, 8), beakOrange);
      beak.rotation.x = Math.PI * 0.5;
      beak.position.set(0, 0.42, 0.34);
      group.add(beak);

      for (const s of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), eyeDark);
        eye.position.set(s * 0.09, 0.48, 0.28);
        group.add(eye);
      }
      break;
    }

    case 'torii_gate': {
      const vermilion = new THREE.MeshStandardMaterial({
        color: 0xd92b2b,
        roughness: 0.38,
        metalness: 0.08,
      });
      const charcoal = new THREE.MeshStandardMaterial({
        color: 0x1e2129,
        roughness: 0.65,
      });
      const goldMat = new THREE.MeshStandardMaterial({
        color: 0xf5c242,
        roughness: 0.3,
        metalness: 0.6,
      });

      // Left & right main pillars (hashira) spanning river width (-4.6 to +4.6)
      for (const side of [-1, 1]) {
        const x = side * 4.6;
        const shoe = new THREE.Mesh(
          new THREE.CylinderGeometry(0.56, 0.64, 1.3, 12),
          charcoal,
        );
        shoe.position.set(x, -2.4, 0);
        group.add(shoe);

        const pillar = new THREE.Mesh(
          new THREE.CylinderGeometry(0.44, 0.52, 7.6, 14),
          vermilion,
        );
        pillar.position.set(x, 1.4, 0);
        pillar.rotation.z = -side * 0.03;
        group.add(pillar);
      }

      // Lower tie-beam (nuki) high above water surface so duck swims/dives beneath
      const nuki = new THREE.Mesh(
        new THREE.BoxGeometry(10.8, 0.52, 0.44),
        vermilion,
      );
      nuki.position.set(0, 3.65, 0);
      group.add(nuki);

      // Upper main lintel (shimaki + kasagi)
      const shimaki = new THREE.Mesh(
        new THREE.BoxGeometry(11.8, 0.56, 0.64),
        vermilion,
      );
      shimaki.position.set(0, 4.95, 0);
      group.add(shimaki);

      const kasagi = new THREE.Mesh(
        new THREE.BoxGeometry(12.8, 0.45, 0.85),
        charcoal,
      );
      kasagi.position.set(0, 5.4, 0);
      group.add(kasagi);

      // Upturned wing tips on kasagi
      for (const side of [-1, 1]) {
        const wingTip = new THREE.Mesh(
          new THREE.BoxGeometry(1.4, 0.44, 0.86),
          charcoal,
        );
        wingTip.position.set(side * 6.1, 5.54, 0);
        wingTip.rotation.z = side * 0.16;
        group.add(wingTip);
      }

      // Central plaque strut (gakuzuka)
      const plaque = new THREE.Mesh(
        new THREE.BoxGeometry(0.95, 1.25, 0.54),
        goldMat,
      );
      plaque.position.set(0, 4.3, 0);
      group.add(plaque);
      break;
    }

    case 'sakura_tree': {
      const trunkMat = new THREE.MeshStandardMaterial({
        color: 0x4a2f28,
        roughness: 0.9,
      });
      const blossomMain = new THREE.MeshStandardMaterial({
        color: 0xff9ec7,
        roughness: 0.75,
        flatShading: true,
      });
      const blossomLight = new THREE.MeshStandardMaterial({
        color: 0xffcae2,
        roughness: 0.72,
        flatShading: true,
      });

      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 1.05, 6.4, 9),
        trunkMat,
      );
      trunk.position.y = 3.2;
      trunk.rotation.z = 0.08;
      group.add(trunk);

      const puffs = [
        { x: 0.0, y: 10.2, z: 0.0, r: 4.6, mat: blossomMain },
        { x: -2.8, y: 8.8, z: 1.4, r: 3.6, mat: blossomLight },
        { x: 2.9, y: 9.2, z: -1.1, r: 3.8, mat: blossomMain },
        { x: 0.5, y: 12.6, z: 0.6, r: 3.4, mat: blossomLight },
        { x: -1.8, y: 11.4, z: -1.8, r: 3.1, mat: blossomMain },
      ];
      for (const p of puffs) {
        const dome = new THREE.Mesh(
          new THREE.DodecahedronGeometry(p.r, 1),
          p.mat,
        );
        dome.scale.set(1.15, 0.76, 1.1);
        dome.position.set(p.x, p.y, p.z);
        group.add(dome);
      }
      break;
    }

    case 'bamboo_cluster': {
      const culmMat = new THREE.MeshStandardMaterial({
        color: 0x4ca346,
        roughness: 0.48,
      });
      const leafMat = new THREE.MeshStandardMaterial({
        color: 0x62bd55,
        roughness: 0.68,
        side: THREE.DoubleSide,
      });

      const stalks = [
        { x: 0.0, z: 0.0, h: 14.5, r: 0.24, tiltX: 0.03, tiltZ: -0.02 },
        { x: 0.85, z: 0.4, h: 13.2, r: 0.21, tiltX: -0.04, tiltZ: 0.05 },
        { x: -0.78, z: 0.5, h: 13.8, r: 0.22, tiltX: 0.05, tiltZ: 0.04 },
        { x: 0.45, z: -0.75, h: 12.4, r: 0.19, tiltX: -0.03, tiltZ: -0.05 },
        { x: -0.65, z: -0.6, h: 11.8, r: 0.18, tiltX: 0.02, tiltZ: 0.06 },
      ];

      for (const st of stalks) {
        const stalk = new THREE.Mesh(
          new THREE.CylinderGeometry(st.r * 0.78, st.r, st.h, 8),
          culmMat,
        );
        stalk.position.set(st.x, st.h * 0.5, st.z);
        stalk.rotation.set(st.tiltX, 0, st.tiltZ);
        group.add(stalk);

        const crown = new THREE.Mesh(
          new THREE.ConeGeometry(1.45, 3.2, 6),
          leafMat,
        );
        crown.position.set(st.x, st.h - 0.8, st.z);
        group.add(crown);
      }
      break;
    }

    case 'stone_lantern': {
      const stoneMat = new THREE.MeshStandardMaterial({
        color: 0x767c82,
        roughness: 0.85,
        flatShading: true,
      });
      const glowMat = new THREE.MeshStandardMaterial({
        color: 0xffcf70,
        emissive: 0xff9429,
        emissiveIntensity: 1.4,
        roughness: 0.3,
      });

      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.75, 0.95, 0.55, 6),
        stoneMat,
      );
      base.position.y = 0.28;
      group.add(base);

      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.4, 1.45, 6),
        stoneMat,
      );
      post.position.y = 1.25;
      group.add(post);

      const platform = new THREE.Mesh(
        new THREE.CylinderGeometry(0.68, 0.52, 0.28, 6),
        stoneMat,
      );
      platform.position.y = 2.1;
      group.add(platform);

      const firebox = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.45, 0.68, 6),
        glowMat,
      );
      firebox.position.y = 2.55;
      group.add(firebox);

      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(1.12, 0.72, 6),
        stoneMat,
      );
      roof.position.y = 3.22;
      group.add(roof);
      break;
    }

    case 'koi_fish': {
      const whiteMat = new THREE.MeshStandardMaterial({
        color: 0xfaf7f2,
        roughness: 0.22,
        metalness: 0.12,
      });
      const vermilionMat = new THREE.MeshStandardMaterial({
        color: 0xff4d1c,
        roughness: 0.25,
        metalness: 0.15,
      });

      const bodyGeom = new THREE.SphereGeometry(0.44, 14, 10);
      bodyGeom.scale(0.48, 0.66, 2.05);
      const body = new THREE.Mesh(bodyGeom, whiteMat);
      group.add(body);

      const spot1 = new THREE.Mesh(
        new THREE.SphereGeometry(0.24, 10, 8),
        vermilionMat,
      );
      spot1.scale.set(0.88, 0.72, 1.35);
      spot1.position.set(0, 0.12, 0.24);
      group.add(spot1);

      const spot2 = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 10, 8),
        vermilionMat,
      );
      spot2.scale.set(0.85, 0.7, 1.2);
      spot2.position.set(0.02, 0.1, -0.32);
      group.add(spot2);

      const tailGeom = new THREE.ConeGeometry(0.36, 0.56, 4);
      tailGeom.scale(0.18, 1.15, 1.0);
      tailGeom.rotateX(Math.PI * 0.5);
      const tail = new THREE.Mesh(tailGeom, vermilionMat);
      tail.position.z = -1.02;
      group.add(tail);
      break;
    }

    case 'jungle_palm': {
      const trunkMat = new THREE.MeshStandardMaterial({
        color: 0x6b4c35,
        roughness: 0.9,
      });
      const frondMat = new THREE.MeshStandardMaterial({
        color: 0x298a3b,
        roughness: 0.72,
        side: THREE.DoubleSide,
      });

      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1.1, 8.5, 0.4),
        new THREE.Vector3(0.4, 16.5, 0),
      );
      const trunk = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 12, 0.52, 8, false),
        trunkMat,
      );
      group.add(trunk);

      const crownCenter = new THREE.Vector3(0.4, 16.5, 0);
      const frondCount = 8;
      for (let i = 0; i < frondCount; i++) {
        const angle = (i / frondCount) * Math.PI * 2;
        const frondGeom = new THREE.ConeGeometry(1.15, 6.4, 4);
        frondGeom.scale(1.0, 1.0, 0.14);
        frondGeom.translate(0, 3.1, 0);
        const frond = new THREE.Mesh(frondGeom, frondMat);
        frond.position.copy(crownCenter);
        frond.rotation.y = angle;
        frond.rotation.x = 1.08 + (i % 2) * 0.16;
        group.add(frond);
      }
      break;
    }

    case 'temple_ruin': {
      const stoneMat = new THREE.MeshStandardMaterial({
        color: 0x697062,
        roughness: 0.88,
        flatShading: true,
      });
      const mossMat = new THREE.MeshStandardMaterial({
        color: 0x2c823d,
        roughness: 0.9,
        flatShading: true,
      });

      const plinth = new THREE.Mesh(
        new THREE.BoxGeometry(3.8, 1.6, 3.8),
        stoneMat,
      );
      plinth.position.y = 0.8;
      group.add(plinth);

      const tier2 = new THREE.Mesh(
        new THREE.BoxGeometry(2.9, 2.2, 2.9),
        stoneMat,
      );
      tier2.position.y = 2.7;
      group.add(tier2);

      const column = new THREE.Mesh(
        new THREE.BoxGeometry(2.1, 4.8, 2.1),
        stoneMat,
      );
      column.position.y = 6.2;
      group.add(column);

      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(2.7, 1.1, 2.7),
        mossMat,
      );
      cap.position.y = 9.0;
      group.add(cap);
      break;
    }

    case 'giant_lily_pad': {
      const padMat = new THREE.MeshStandardMaterial({
        color: 0x2e9c44,
        roughness: 0.65,
      });
      const flowerMat = new THREE.MeshStandardMaterial({
        color: 0xff8ab8,
        roughness: 0.45,
      });

      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(1.75, 1.68, 0.14, 20),
        padMat,
      );
      disc.position.y = 0.07;
      group.add(disc);

      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(1.72, 0.11, 8, 20),
        padMat,
      );
      rim.rotation.x = Math.PI * 0.5;
      rim.position.y = 0.15;
      group.add(rim);

      const blossom = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.32, 0),
        flowerMat,
      );
      blossom.scale.set(1.2, 0.75, 1.2);
      blossom.position.set(0.55, 0.24, 0.35);
      group.add(blossom);
      break;
    }

    case 'red_rock_pillar': {
      const terracotta = new THREE.MeshStandardMaterial({
        color: 0xc4512d,
        roughness: 0.82,
        flatShading: true,
      });
      const ochre = new THREE.MeshStandardMaterial({
        color: 0xd9733d,
        roughness: 0.8,
        flatShading: true,
      });

      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(1.4, 1.95, 2.2, 7),
        terracotta,
      );
      base.position.y = 1.1;
      group.add(base);

      const mid = new THREE.Mesh(
        new THREE.CylinderGeometry(1.05, 1.45, 2.4, 7),
        ochre,
      );
      mid.position.y = 3.3;
      group.add(mid);

      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(1.55, 1.0, 1.35, 7),
        terracotta,
      );
      cap.position.y = 5.1;
      group.add(cap);
      break;
    }

    case 'red_rock_arch': {
      const sandstoneMat = new THREE.MeshStandardMaterial({
        color: 0xc75430,
        roughness: 0.84,
        flatShading: true,
      });

      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-5.9, -1.8, 0),
        new THREE.Vector3(0, 3.8, 0.15),
        new THREE.Vector3(5.9, -1.8, 0),
      );
      const archGeom = new THREE.TubeGeometry(curve, 18, 1.05, 7, false);
      const arch = new THREE.Mesh(archGeom, sandstoneMat);
      group.add(arch);
      break;
    }

    case 'saguaro_cactus': {
      const cactusMat = new THREE.MeshStandardMaterial({
        color: 0x3b7d3e,
        roughness: 0.78,
      });

      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.52, 0.62, 10.2, 10),
        cactusMat,
      );
      stem.position.y = 5.1;
      group.add(stem);

      const topDome = new THREE.Mesh(
        new THREE.SphereGeometry(0.52, 10, 8),
        cactusMat,
      );
      topDome.position.y = 10.2;
      group.add(topDome);

      for (const arm of [
        { side: -1, y: 4.5, h: 3.1 },
        { side: 1, y: 5.6, h: 2.6 },
      ]) {
        const elbow = new THREE.Mesh(
          new THREE.CylinderGeometry(0.36, 0.38, 1.4, 8),
          cactusMat,
        );
        elbow.rotation.z = Math.PI * 0.5;
        elbow.position.set(arm.side * 0.85, arm.y, 0);
        group.add(elbow);

        const riser = new THREE.Mesh(
          new THREE.CylinderGeometry(0.36, 0.38, arm.h, 8),
          cactusMat,
        );
        riser.position.set(arm.side * 1.45, arm.y + arm.h * 0.5, 0);
        group.add(riser);
      }
      break;
    }

    case 'iceberg_spire': {
      const iceMat = new THREE.MeshPhysicalMaterial({
        color: 0xa6edff,
        emissive: 0x0e4761,
        emissiveIntensity: 0.35,
        roughness: 0.18,
        metalness: 0.05,
        clearcoat: 0.85,
        flatShading: true,
      });

      const mainSpire = new THREE.Mesh(
        new THREE.ConeGeometry(1.75, 5.4, 6),
        iceMat,
      );
      mainSpire.position.y = 2.7;
      group.add(mainSpire);

      const subSpire = new THREE.Mesh(
        new THREE.ConeGeometry(1.15, 3.4, 5),
        iceMat,
      );
      subSpire.position.set(0.95, 1.7, 0.4);
      subSpire.rotation.z = -0.18;
      group.add(subSpire);
      break;
    }

    case 'ice_arch': {
      const iceMat = new THREE.MeshPhysicalMaterial({
        color: 0x8ae5ff,
        emissive: 0x104c66,
        emissiveIntensity: 0.32,
        roughness: 0.16,
        clearcoat: 0.9,
        flatShading: true,
      });

      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-5.8, -1.6, 0),
        new THREE.Vector3(0, 3.6, 0.1),
        new THREE.Vector3(5.8, -1.6, 0),
      );
      const arch = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 16, 0.95, 6, false),
        iceMat,
      );
      group.add(arch);
      break;
    }

    case 'penguin': {
      const blackMat = new THREE.MeshStandardMaterial({
        color: 0x181c26,
        roughness: 0.45,
      });
      const whiteMat = new THREE.MeshStandardMaterial({
        color: 0xf4f9ff,
        roughness: 0.55,
      });
      const orangeMat = createDuckOrangeMaterial();

      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.28, 0.52, 8, 12),
        blackMat,
      );
      body.position.set(0, 0.54, 0);
      group.add(body);

      const belly = new THREE.Mesh(
        new THREE.SphereGeometry(0.23, 12, 10),
        whiteMat,
      );
      belly.scale.set(0.88, 1.35, 0.55);
      belly.position.set(0, 0.48, 0.14);
      group.add(belly);

      const beak = new THREE.Mesh(
        new THREE.ConeGeometry(0.065, 0.18, 8),
        orangeMat,
      );
      beak.rotation.x = Math.PI * 0.5;
      beak.position.set(0, 0.84, 0.3);
      group.add(beak);
      break;
    }

    case 'basalt_columns': {
      const basaltMat = new THREE.MeshStandardMaterial({
        color: 0x23262e,
        roughness: 0.65,
        metalness: 0.15,
        flatShading: true,
      });
      const lavaGlowMat = new THREE.MeshStandardMaterial({
        color: 0xff5917,
        emissive: 0xff3d00,
        emissiveIntensity: 1.5,
        roughness: 0.4,
      });

      const cols = [
        { x: 0.0, z: 0.0, h: 6.4, r: 0.72 },
        { x: 1.05, z: 0.35, h: 4.9, r: 0.64 },
        { x: -1.0, z: 0.4, h: 5.4, r: 0.66 },
        { x: 0.45, z: -0.95, h: 3.8, r: 0.58 },
        { x: -0.55, z: -0.88, h: 4.3, r: 0.6 },
      ];
      for (const c of cols) {
        const prism = new THREE.Mesh(
          new THREE.CylinderGeometry(c.r, c.r, c.h, 6),
          basaltMat,
        );
        prism.position.set(c.x, c.h * 0.5, c.z);
        group.add(prism);
      }

      const magmaBase = new THREE.Mesh(
        new THREE.CylinderGeometry(1.4, 1.65, 0.45, 6),
        lavaGlowMat,
      );
      magmaBase.position.y = 0.25;
      group.add(magmaBase);
      break;
    }

    case 'obsidian_arch': {
      const obsidianMat = new THREE.MeshStandardMaterial({
        color: 0x1b1e26,
        roughness: 0.24,
        metalness: 0.25,
        flatShading: true,
      });
      const magmaMat = new THREE.MeshStandardMaterial({
        color: 0xff5a1a,
        emissive: 0xff3b00,
        emissiveIntensity: 1.35,
      });

      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-5.8, -1.6, 0),
        new THREE.Vector3(0, 3.7, 0.15),
        new THREE.Vector3(5.8, -1.6, 0),
      );
      const arch = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 16, 0.95, 6, false),
        obsidianMat,
      );
      group.add(arch);

      const vein = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 14, 0.34, 5, false),
        magmaMat,
      );
      vein.position.set(0, -0.25, 0.48);
      group.add(vein);
      break;
    }

    case 'lava_rock': {
      const rockMat = new THREE.MeshStandardMaterial({
        color: 0x242730,
        roughness: 0.76,
        flatShading: true,
      });
      const magmaMat = new THREE.MeshStandardMaterial({
        color: 0xff5912,
        emissive: 0xff3700,
        emissiveIntensity: 1.5,
        roughness: 0.35,
      });

      const boulder = new THREE.Mesh(
        new THREE.DodecahedronGeometry(1.75, 1),
        rockMat,
      );
      boulder.scale.set(1.12, 0.85, 1.05);
      boulder.position.y = 1.25;
      group.add(boulder);

      const core = new THREE.Mesh(
        new THREE.DodecahedronGeometry(1.38, 0),
        magmaMat,
      );
      core.scale.set(1.22, 0.55, 1.18);
      core.position.y = 1.05;
      group.add(core);
      break;
    }

    // ---- 10 Shared River Obstacle & Detail Procedural Fallbacks ----
    case 'beaver_dam': {
      const stickMat = new THREE.MeshStandardMaterial({
        color: 0x6b4a2b,
        roughness: 0.92,
      });
      const mudMat = new THREE.MeshStandardMaterial({
        color: 0x4a3828,
        roughness: 0.96,
        flatShading: true,
      });

      const mound = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 1.05, 6.6, 8),
        mudMat,
      );
      mound.rotation.z = Math.PI * 0.5;
      mound.scale.set(1.0, 1.0, 0.85);
      mound.position.y = 0.22;
      group.add(mound);

      for (let i = -3; i <= 3; i++) {
        const branch = new THREE.Mesh(
          new THREE.CylinderGeometry(0.12, 0.16, 2.2, 6),
          stickMat,
        );
        branch.position.set(i * 0.88, 0.55, (i % 2) * 0.35);
        branch.rotation.set(0.55 * (i % 2 ? 1 : -1), 0.2 * i, 0.35 * (i % 2 ? -1 : 1));
        group.add(branch);
      }
      break;
    }

    case 'stone_footbridge': {
      const stoneMat = new THREE.MeshStandardMaterial({
        color: 0x767c80,
        roughness: 0.88,
        flatShading: true,
      });
      const mossMat = new THREE.MeshStandardMaterial({
        color: 0x458042,
        roughness: 0.9,
      });

      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-6.0, -1.6, 0),
        new THREE.Vector3(0, 3.8, 0),
        new THREE.Vector3(6.0, -1.6, 0),
      );
      const deck = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 18, 0.95, 6, false),
        stoneMat,
      );
      deck.scale.set(1.0, 0.82, 1.55);
      group.add(deck);

      for (const zSide of [-1.15, 1.15]) {
        const rail = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 14, 0.28, 6, false),
          mossMat,
        );
        rail.position.set(0, 0.85, zSide);
        group.add(rail);
      }
      break;
    }

    case 'sunken_canoe': {
      const woodMat = new THREE.MeshStandardMaterial({
        color: 0x8a5230,
        roughness: 0.82,
      });
      const trimMat = new THREE.MeshStandardMaterial({
        color: 0x52311b,
        roughness: 0.9,
      });

      const hullGeom = new THREE.SphereGeometry(
        1.1,
        14,
        10,
        0,
        Math.PI * 2,
        Math.PI * 0.48,
        Math.PI * 0.52,
      );
      hullGeom.scale(0.68, 0.62, 2.35);
      const hull = new THREE.Mesh(hullGeom, woodMat);
      hull.position.y = 0.38;
      hull.rotation.set(0.24, 0.25, 0.32);
      group.add(hull);

      const bench = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 0.12, 0.32),
        trimMat,
      );
      bench.position.set(0, 0.42, 0);
      bench.rotation.set(0.24, 0.25, 0.32);
      group.add(bench);
      break;
    }

    case 'willow_overhang': {
      const barkMat = new THREE.MeshStandardMaterial({
        color: 0x5c422c,
        roughness: 0.92,
      });
      const leafMat = new THREE.MeshStandardMaterial({
        color: 0x4b8f42,
        roughness: 0.78,
        side: THREE.DoubleSide,
      });

      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-5.8, -0.6, 0),
        new THREE.Vector3(0, 2.1, 0.2),
        new THREE.Vector3(5.8, -0.6, 0),
      );
      const limb = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 16, 0.6, 8, false),
        barkMat,
      );
      group.add(limb);

      for (let i = -3; i <= 3; i++) {
        const drape = new THREE.Mesh(
          new THREE.ConeGeometry(0.45, 1.9, 5),
          leafMat,
        );
        drape.rotation.x = Math.PI;
        drape.position.set(i * 1.35, 0.8 - Math.abs(i) * 0.16, (i % 2) * 0.25);
        group.add(drape);
      }
      break;
    }

    case 'river_snag_stump': {
      const woodMat = new THREE.MeshStandardMaterial({
        color: 0x8c7b68,
        roughness: 0.9,
        flatShading: true,
      });

      const stump = new THREE.Mesh(
        new THREE.CylinderGeometry(0.62, 1.15, 3.6, 7),
        woodMat,
      );
      stump.position.y = 1.7;
      stump.rotation.set(0.25, 0.1, -0.28);
      group.add(stump);

      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + 0.4;
        const root = new THREE.Mesh(
          new THREE.ConeGeometry(0.28, 2.2, 5),
          woodMat,
        );
        root.position.set(Math.cos(ang) * 0.95, 0.7, Math.sin(ang) * 0.95);
        root.rotation.set(Math.sin(ang) * 0.7, ang, -Math.cos(ang) * 0.7);
        group.add(root);
      }
      break;
    }

    case 'floating_barrel': {
      const oakMat = new THREE.MeshStandardMaterial({
        color: 0x7c4f2b,
        roughness: 0.82,
      });
      const ironMat = new THREE.MeshStandardMaterial({
        color: 0x3b3532,
        roughness: 0.52,
        metalness: 0.65,
      });

      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.76, 0.76, 2.0, 12),
        oakMat,
      );
      barrel.rotation.z = Math.PI * 0.46;
      barrel.position.y = 0.28;
      group.add(barrel);

      for (const offset of [-0.55, 0.55]) {
        const band = new THREE.Mesh(
          new THREE.TorusGeometry(0.77, 0.06, 6, 14),
          ironMat,
        );
        band.rotation.y = Math.PI * 0.5;
        band.position.set(offset, 0.28, 0);
        group.add(band);
      }
      break;
    }

    case 'cattail_reeds': {
      const reedMat = new THREE.MeshStandardMaterial({
        color: 0x4b8c3b,
        roughness: 0.78,
      });
      const headMat = new THREE.MeshStandardMaterial({
        color: 0x5c361d,
        roughness: 0.9,
      });

      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * Math.PI * 2;
        const rad = 0.32 + (i % 3) * 0.22;
        const h = 3.2 + (i % 3) * 0.55;
        const stalk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.05, 0.08, h, 5),
          reedMat,
        );
        stalk.position.set(Math.cos(ang) * rad, h * 0.5, Math.sin(ang) * rad);
        stalk.rotation.set(Math.sin(ang) * 0.12, 0, -Math.cos(ang) * 0.12);
        group.add(stalk);

        if (i % 2 === 0) {
          const head = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.11, 0.55, 4, 6),
            headMat,
          );
          head.position.set(Math.cos(ang) * rad * 1.15, h - 0.5, Math.sin(ang) * rad * 1.15);
          group.add(head);
        }
      }
      break;
    }

    case 'mossy_step_stones': {
      const stoneMat = new THREE.MeshStandardMaterial({
        color: 0x6b7478,
        roughness: 0.76,
        flatShading: true,
      });
      const mossMat = new THREE.MeshStandardMaterial({
        color: 0x458c42,
        roughness: 0.9,
      });

      for (let i = -2; i <= 2; i++) {
        const stone = new THREE.Mesh(
          new THREE.CylinderGeometry(0.65, 0.78, 0.55, 8),
          stoneMat,
        );
        stone.position.set(i * 1.25, 0.18, (i % 2) * 0.35);
        group.add(stone);

        const cap = new THREE.Mesh(
          new THREE.CylinderGeometry(0.54, 0.62, 0.1, 8),
          mossMat,
        );
        cap.position.set(i * 1.25, 0.48, (i % 2) * 0.35);
        group.add(cap);
      }
      break;
    }

    case 'waterwheel_mill': {
      const stoneMat = new THREE.MeshStandardMaterial({
        color: 0x6c7278,
        roughness: 0.88,
        flatShading: true,
      });
      const woodMat = new THREE.MeshStandardMaterial({
        color: 0x785233,
        roughness: 0.86,
      });

      const pier = new THREE.Mesh(
        new THREE.BoxGeometry(3.8, 5.2, 3.6),
        stoneMat,
      );
      pier.position.set(0, 2.6, 0);
      group.add(pier);

      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(3.2, 2.4, 4),
        woodMat,
      );
      roof.position.set(0, 6.4, 0);
      roof.rotation.y = Math.PI * 0.25;
      group.add(roof);

      const wheel = new THREE.Mesh(
        new THREE.TorusGeometry(2.4, 0.28, 8, 16),
        woodMat,
      );
      wheel.position.set(0, 2.9, 2.1);
      group.add(wheel);
      break;
    }

    case 'crystal_cluster': {
      const crystalMat = new THREE.MeshPhysicalMaterial({
        color: 0x3ef2e6,
        emissive: 0x10a8b8,
        emissiveIntensity: 0.85,
        roughness: 0.15,
        metalness: 0.08,
        clearcoat: 1.0,
        flatShading: true,
      });

      const shards = [
        { x: 0, z: 0, h: 3.6, r: 0.65, rx: 0, rz: 0 },
        { x: 0.65, z: 0.25, h: 2.5, r: 0.45, rx: 0.15, rz: -0.35 },
        { x: -0.62, z: 0.3, h: 2.7, r: 0.48, rx: 0.18, rz: 0.32 },
        { x: 0.18, z: -0.65, h: 2.1, r: 0.4, rx: -0.34, rz: -0.1 },
      ];
      for (const s of shards) {
        const shard = new THREE.Mesh(
          new THREE.ConeGeometry(s.r, s.h, 6),
          crystalMat,
        );
        shard.position.set(s.x, s.h * 0.5, s.z);
        shard.rotation.set(s.rx, 0, s.rz);
        group.add(shard);
      }
      break;
    }

    default: {
      const resolvedSpec = spec ?? getAssetSpec(id);
      const archetype = resolvedSpec.fallbackArchetype ?? 'rock';
      const fallback = buildArchetypeFallback(
        archetype,
        resolvedSpec.fallbackColor,
      );
      group.add(fallback);
      break;
    }
  }

  return group;
}

/**
 * Normalize any loaded or fallback Object3D into a uniform scale, pivot, and
 * +Z forward / +Y up container matching its AssetSpec.
 */
function normalizePrototype(
  rawRoot: THREE.Object3D,
  spec: AssetSpec,
  scaleMultiplier: number = 1.0,
): { group: THREE.Group; size: { x: number; y: number; z: number } } {
  const wrapper = new THREE.Group();
  wrapper.name = `asset_${spec.id}`;

  const inner = new THREE.Group();
  inner.add(rawRoot);
  if (spec.rotY !== 0) {
    inner.rotation.y = spec.rotY;
  }
  wrapper.add(inner);

  wrapper.updateMatrixWorld(true);
  const initialBox = new THREE.Box3().setFromObject(inner);
  const rawSize = new THREE.Vector3();
  const rawCenter = new THREE.Vector3();
  initialBox.getSize(rawSize);
  initialBox.getCenter(rawCenter);

  let measured = Math.max(rawSize.x, rawSize.y, rawSize.z);
  if (spec.sizeAxis === 'x') measured = rawSize.x;
  else if (spec.sizeAxis === 'y') measured = rawSize.y;
  else if (spec.sizeAxis === 'z') measured = rawSize.z;

  const safeMeasured = measured > 1e-4 ? measured : 1.0;
  const uniformScale = (spec.targetSize * scaleMultiplier) / safeMeasured;
  inner.scale.setScalar(uniformScale);

  wrapper.updateMatrixWorld(true);
  const scaledBox = new THREE.Box3().setFromObject(inner);
  const scaledSize = new THREE.Vector3();
  const scaledCenter = new THREE.Vector3();
  scaledBox.getSize(scaledSize);
  scaledBox.getCenter(scaledCenter);

  // Align X & Z cleanly (special shoulder alignment for duck_wing!)
  if (spec.id === 'duck_wing') {
    // Inset shoulder root deeper inside the duck's flank so there is zero shoulder seam
    inner.position.x -= scaledBox.min.x + 0.065;
    inner.position.y -= scaledCenter.y;
    inner.position.z -= scaledCenter.z;
  } else {
    inner.position.x -= scaledCenter.x;
    inner.position.z -= scaledCenter.z;
    if (spec.pivot === 'bottom') {
      inner.position.y -= scaledBox.min.y;
    } else if (spec.pivot === 'waterline') {
      // Float naturally with ~14% of bottom height dipped below y=0 waterline
      inner.position.y -= scaledBox.min.y + scaledSize.y * 0.14;
    } else {
      inner.position.y -= scaledCenter.y;
    }
  }
  inner.position.y += spec.yOffset;

  const isHeroDuckPart = spec.id === 'rubber_duck' || spec.id === 'duck_wing';
  applyShadowAndMaterialDefaults(
    wrapper,
    spec.castShadow,
    spec.receiveShadow,
    isHeroDuckPart ? 1.25 : 1.0,
  );
  wrapper.updateMatrixWorld(true);

  return {
    group: wrapper,
    size: {
      x: Number(scaledSize.x.toFixed(3)),
      y: Number(scaledSize.y.toFixed(3)),
      z: Number(scaledSize.z.toFixed(3)),
    },
  };
}

/**
 * Apply expressive multi-state rubber duck animations onto a `DuckRig` from `DuckState`.
 * Handles swimming, turning in all modes, diving, flying, waterfall drops, and spooked balancing.
 */
export function applyDuckRigPose(rig: DuckRig, state: DuckState): void {
  rig.root.position.set(state.worldPos.x, state.worldPos.y, state.worldPos.z);
  rig.root.rotation.set(0, state.yaw, 0);

  // Volume-preserving squash & stretch
  const squashY = THREE.MathUtils.clamp(state.squashStretch, 0.65, 1.45);
  const invXZ = 1 / Math.sqrt(squashY);
  rig.bodyPivot.scale.set(invXZ, squashY, invXZ);

  // Body attitude: pitch (-rotX = nose up), roll (+rotZ = bank right) + balance wobble
  const wagYaw =
    state.animState === 'swim'
      ? Math.sin(state.tailWagPhase) * 0.045
      : 0;
  rig.bodyPivot.rotation.set(
    -state.pitch,
    wagYaw,
    state.roll + state.balanceWobble,
  );

  // Head look & expressive tilt (vivid on procedural duck; subtle accent anchor on GLB)
  rig.headPivot.rotation.set(
    -state.headPitch,
    state.headYaw,
    state.turnAmount * 0.12 + state.balanceWobble * 0.35,
  );

  // Tail wag
  rig.tailPivot.rotation.y = Math.sin(state.tailWagPhase) * 0.24;

  // Wings: sleekly folded against the rounded flanks when spread=0,
  // unfolding cleanly outward along +-X when flying, jumping, turning hard, or spooked.
  const spread = THREE.MathUtils.clamp(state.wingSpread, 0, 1);
  // Smooth ease so small idle spread stays tightly hugged against the duck body
  const openT = THREE.MathUtils.smoothstep(spread, 0.02, 0.92);

  // Slide shoulder pivot slightly inward into flanks when tucked, outward when spread
  const shoulderX = THREE.MathUtils.lerp(0.32, 0.39, openT);
  const shoulderY = THREE.MathUtils.lerp(0.35, 0.38, openT);
  const shoulderZ = THREE.MathUtils.lerp(0.05, 0.01, openT);
  rig.wingLeftPivot.position.set(shoulderX, shoulderY, shoulderZ);
  rig.wingRightPivot.position.set(-shoulderX, shoulderY, shoulderZ);

  // Smoothly scale wings from compact flank-hugging (0.82/1.22 ≈ 0.67) to bold soaring/spooked (1.15/1.22 ≈ 0.94..1.04)
  const wingScaleMult = THREE.MathUtils.lerp(0.68, 1.02, openT);
  rig.wingLeftPivot.scale.setScalar(wingScaleMult);
  rig.wingRightPivot.scale.setScalar(wingScaleMult);

  // 'YXZ' order applies Z (flap), then X (flank-drape roll), then Y (sweep back along flank)
  rig.wingLeftPivot.rotation.order = 'YXZ';
  rig.wingRightPivot.rotation.order = 'YXZ';

  // Swept cleanly back along the flanks (1.36 rad) when tucked, spread wide (0.08 rad) when open
  const sweepYaw = THREE.MathUtils.lerp(1.36, 0.08, openT);
  // Drape wing face cleanly over the rounded flank dome when tucked; flat airfoil when open
  const flankDrapeX = THREE.MathUtils.lerp(0.56, 0.0, openT);
  // Slight downward hug along the hip when tucked
  const tuckDropZ = THREE.MathUtils.lerp(-0.22, 0.0, openT);
  // Subtle airfoil pitch bank when carving turns with wings extended
  const turnTwistX = state.turnAmount * 0.14 * openT;

  // Left wing (+X side): +rotZ raises tip UP, +rotY sweeps tip backward toward -Z
  rig.wingLeftPivot.rotation.set(
    flankDrapeX + turnTwistX,
    sweepYaw,
    tuckDropZ + state.wingLeftAngle,
  );

  // Right wing (-X side): -rotZ raises tip UP, -rotY sweeps tip backward toward -Z
  rig.wingRightPivot.rotation.set(
    flankDrapeX - turnTwistX,
    -sweepYaw,
    -tuckDropZ - state.wingRightAngle,
  );

  // Alternating webbed-feet paddling kicks (fast while diving, calm while swimming, tucked while flying)
  const isFlying = state.mode === 'flying';
  const kickAmp =
    state.mode === 'diving'
      ? 0.72
      : state.mode === 'surface'
        ? 0.42
        : state.animState === 'spooked'
          ? 0.65
          : isFlying
            ? 0.08
            : 0.25;
  const tuckAngle = isFlying ? 0.85 : state.mode === 'diving' ? 0.35 : 0.12;

  rig.footLeftPivot.rotation.x = tuckAngle + Math.sin(state.paddlePhase) * kickAmp;
  rig.footRightPivot.rotation.x =
    tuckAngle + Math.sin(state.paddlePhase + Math.PI) * kickAmp;
}

export interface AssetLoadProgress {
  loaded: number;
  total: number;
  ratio: number;
  lastId?: AssetId;
}

/**
 * Central 3D asset manager supporting GLTF/GLB + DRACO + Meshopt with
 * relative `./models/...` URLs for GitHub Pages and automatic procedural fallbacks.
 */
export class AssetLoader {
  private readonly gltfLoader: GLTFLoader;
  private readonly dracoLoader: DRACOLoader;
  private readonly assets = new Map<AssetId, LoadedAsset>();
  private readonly inFlightGlb = new Map<AssetId, Promise<LoadedAsset | null>>();
  private readonly attemptedGlbIds = new Set<AssetId>();
  private readonly updateListeners = new Set<(updatedIds: AssetId[]) => void>();
  private readonly extraManifestUrls = new Set<string>();
  private trackAssetsResolver: ((trackId: string) => AssetId[]) | null = null;
  private manifest: ResolvedAssetManifest | null = null;
  private initPromise: Promise<void> | null = null;
  private loadedCount = 0;
  private targetTotalCount = ALL_ASSET_IDS.length;

  constructor(dracoDecoderPath: string = DEFAULT_DRACO_DECODER_PATH) {
    this.gltfLoader = new GLTFLoader();
    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath(dracoDecoderPath);
    this.gltfLoader.setDRACOLoader(this.dracoLoader);
    this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  }

  /**
   * Register custom `AssetSpec` entries from a contributor pack at runtime/boot
   * so custom `.glb` models load & normalize cleanly with zero core edits!
   */
  public registerAssetSpecs(specs: Record<string, AssetSpec>): void {
    registerGlobalAssetSpecs(specs);
    if (this.manifest) {
      for (const [key, rawSpec] of Object.entries(specs)) {
        const id = rawSpec.id || key;
        const spec = { ...rawSpec, id };
        if (!this.manifest.entries[id]) {
          this.manifest.entries[id] = {
            id,
            url: spec.url ?? resolveModelUrl(spec.filename),
            spec,
            presentInManifest: false,
          };
        }
      }
    }
  }

  /**
   * Register an additional pack `assets.json` manifest URL to merge into the loader.
   */
  public registerManifestUrl(url: string): void {
    const trimmed = url.trim();
    if (!trimmed) return;
    this.extraManifestUrls.add(trimmed);
    if (this.manifest) {
      void mergeManifestFromUrl(this.manifest, trimmed);
    }
  }

  /**
   * Wire a resolver mapping a track/region ID to its required `AssetId[]` list
   * (installed automatically by `earthWorld` without circular imports).
   */
  public setTrackAssetsResolver(
    resolver: ((trackId: string) => AssetId[]) | null,
  ): void {
    this.trackAssetsResolver = resolver;
  }

  /**
   * Subscribe to notifications whenever background `preloadTrackAssets()` swaps
   * a procedural fallback for a newly loaded `.glb` prototype.
   * Returns an unsubscribe callback.
   */
  public onAssetsUpdated(
    listener: (updatedIds: AssetId[]) => void,
  ): () => void {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  /**
   * Register or clear a primary callback invoked when lazy-loaded track `.glb`s finish.
   */
  public setOnAssetsUpdated(
    listener: ((updatedIds: AssetId[]) => void) | null,
  ): void {
    this.updateListeners.clear();
    if (listener) {
      this.updateListeners.add(listener);
    }
  }

  /**
   * Fast startup loader: fetches `assets.json` (plus any pack manifests), immediately
   * loads hero duck + wing + initial track/region `.glb` models (~2-3 MB), and registers
   * procedural fallbacks for remaining assets so `.get(id)` is synchronous immediately.
   */
  public initCore(
    initialTrackIdOrAssets: string | readonly AssetId[] = DEFAULT_CORE_TRACK_ID,
    onProgress?: (progress: AssetLoadProgress) => void,
    manifestUrl: string = MANIFEST_URL,
  ): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.manifest = await loadAssetManifest(
        manifestUrl,
        Array.from(this.extraManifestUrls),
      );

      const initialAssets = Array.isArray(initialTrackIdOrAssets)
        ? initialTrackIdOrAssets
        : this.resolveTrackAssetIds(initialTrackIdOrAssets as string);

      const coreSet = new Set<AssetId>([
        ...HERO_CORE_ASSET_IDS,
        ...initialAssets,
      ]);
      const coreIds = Array.from(coreSet);

      // Register procedural fallbacks synchronously for all known assets
      for (const id of ALL_ASSET_IDS) {
        if (!this.assets.has(id)) {
          const spec = this.manifest.entries[id]?.spec ?? getAssetSpec(id);
          this.assets.set(id, this.buildFallbackAsset(id, spec));
        }
      }

      this.targetTotalCount = coreIds.length;
      this.loadedCount = 0;

      const updated: AssetId[] = [];
      await Promise.all(
        coreIds.map(async (id) => {
          const loaded = await this.loadSingleAssetGlb(id);
          if (loaded && !loaded.isFallback) {
            updated.push(id);
          }
          this.loadedCount += 1;
          onProgress?.({
            loaded: this.loadedCount,
            total: this.targetTotalCount,
            ratio: this.loadedCount / Math.max(1, this.targetTotalCount),
            lastId: id,
          });
        }),
      );

      if (updated.length > 0) {
        this.notifyAssetsUpdated(updated);
      }
    })();

    return this.initPromise;
  }

  /**
   * Lazily fetch and cache `.glb` models for an upcoming Mini-Earth track/region in the
   * background ahead of transitions. Idempotent and deduplicated.
   */
  public async preloadTrackAssets(
    assetIds: readonly AssetId[],
    onUpdated?: (updatedIds: AssetId[]) => void,
  ): Promise<void> {
    if (!this.manifest) {
      this.manifest = await loadAssetManifest(
        MANIFEST_URL,
        Array.from(this.extraManifestUrls),
      );
    }

    const uniqueIds = Array.from(new Set(assetIds));
    const newlyUpgraded: AssetId[] = [];

    await Promise.all(
      uniqueIds.map(async (id) => {
        const existing = this.assets.get(id);
        if (existing && !existing.isFallback) {
          return;
        }
        const loaded = await this.loadSingleAssetGlb(id);
        if (loaded && !loaded.isFallback) {
          newlyUpgraded.push(id);
        }
      }),
    );

    if (newlyUpgraded.length > 0) {
      onUpdated?.(newlyUpgraded);
      this.notifyAssetsUpdated(newlyUpgraded);
    }
  }

  /**
   * Convenience helper to preload all 3D assets required by a specific track/region ID.
   */
  public preloadTrack(
    trackId: string,
    onUpdated?: (updatedIds: AssetId[]) => void,
  ): Promise<void> {
    return this.preloadTrackAssets(this.resolveTrackAssetIds(trackId), onUpdated);
  }

  /**
   * Backward-compatible full initializer: delegates to `initCore()`.
   */
  public init(
    onProgress?: (progress: AssetLoadProgress) => void,
    manifestUrl: string = MANIFEST_URL,
  ): Promise<void> {
    return this.initCore(DEFAULT_CORE_TRACK_ID, onProgress, manifestUrl);
  }

  public getProgressRatio(): number {
    if (this.targetTotalCount <= 0) return 1;
    return Math.min(1, this.loadedCount / this.targetTotalCount);
  }

  private resolveTrackAssetIds(trackId: string): AssetId[] {
    if (this.trackAssetsResolver) {
      return this.trackAssetsResolver(trackId);
    }
    return [
      'pine_tree',
      'fern_cluster',
      'mossy_boulder_a',
      'mossy_boulder_b',
      'fallen_log_arch',
      'driftwood_roots',
      'river_trout',
      'duckling',
    ];
  }

  private notifyAssetsUpdated(updatedIds: AssetId[]): void {
    for (const listener of this.updateListeners) {
      try {
        listener(updatedIds);
      } catch {
        // Ignore listener error to keep asset pipeline resilient
      }
    }
  }

  private async loadSingleAssetGlb(id: AssetId): Promise<LoadedAsset> {
    const existing = this.assets.get(id);
    if (existing && !existing.isFallback) {
      return existing;
    }

    if (this.attemptedGlbIds.has(id) && existing) {
      return existing;
    }

    let inFlight = this.inFlightGlb.get(id);
    if (!inFlight) {
      const spec = this.manifest?.entries[id]?.spec ?? getAssetSpec(id);
      const entry = this.manifest?.entries[id] ?? {
        id,
        url: spec.url ?? resolveModelUrl(spec.filename),
        spec,
        presentInManifest: false,
      };
      inFlight = this.tryLoadGlb(
        entry.url,
        entry.spec,
        entry.scaleMultiplier ?? 1.0,
      );
      this.inFlightGlb.set(id, inFlight);
    }

    const loaded = await inFlight;
    this.inFlightGlb.delete(id);
    this.attemptedGlbIds.add(id);

    if (loaded) {
      this.assets.set(id, loaded);
      return loaded;
    }

    if (existing) {
      return existing;
    }

    const spec = this.manifest?.entries[id]?.spec ?? getAssetSpec(id);
    const fallback = this.buildFallbackAsset(id, spec);
    this.assets.set(id, fallback);
    return fallback;
  }

  public getDuckAttachments(): DuckWingAttachments {
    return this.manifest?.duckAttachments ?? DEFAULT_DUCK_ATTACHMENTS;
  }

  /**
   * Synchronously retrieve a loaded (or lazily created fallback) asset prototype.
   * Works for ANY open contributor `AssetId`!
   */
  public get(id: AssetId): LoadedAsset {
    const existing = this.assets.get(id);
    if (existing) return existing;
    const spec = this.manifest?.entries[id]?.spec ?? getAssetSpec(id);
    const fallback = this.buildFallbackAsset(id, spec);
    this.assets.set(id, fallback);
    return fallback;
  }

  /**
   * Clone a normalized asset ready to be added directly to the Three.js scene.
   */
  public clone(id: AssetId): THREE.Group {
    return this.get(id).prototype.clone(true);
  }

  /**
   * Assemble an articulated hero `DuckRig` combining either the loaded Meshy
   * `rubber_duck.glb` (plus optional `duck_wing.glb`) or our procedural rubber duck
   * with articulated shoulder wing pivots and alternating webbed paddling feet.
   */
  public createDuckRig(): DuckRig {
    const duckAsset = this.get('rubber_duck');
    const wingAsset = this.get('duck_wing');
    const attachments = this.getDuckAttachments();

    const root = new THREE.Group();
    root.name = 'hero_duck_root';

    const bodyPivot = new THREE.Group();
    bodyPivot.name = 'hero_duck_body_pivot';
    root.add(bodyPivot);

    const bodyMesh = duckAsset.prototype.clone(true);
    bodyMesh.name = 'hero_duck_body_mesh';
    bodyPivot.add(bodyMesh);

    const usingGlbBody = !duckAsset.isFallback;
    const usingGlbWings = !wingAsset.isFallback;
    const bodyMaterial = usingGlbBody
      ? sampleDuckBodyMaterial(bodyMesh)
      : createDuckYellowMaterial();
    const accentMaterial = createDuckOrangeMaterial();

    // Head pivot: reparent procedural head if present so it animates directly;
    // on GLB body, still provide an anchored headPivot for VFX / hats / subtle attachments.
    const headPivot = new THREE.Group();
    headPivot.name = 'hero_duck_head_pivot';
    const proceduralHead = bodyMesh.getObjectByName('procedural_head');
    if (proceduralHead && proceduralHead.parent) {
      const worldOffset = proceduralHead.position.clone();
      const parent = proceduralHead.parent;
      headPivot.position.copy(worldOffset);
      proceduralHead.position.set(0, 0, 0);
      parent.remove(proceduralHead);
      headPivot.add(proceduralHead);
      parent.add(headPivot);
    } else {
      headPivot.position.set(
        attachments.headOffset[0],
        attachments.headOffset[1],
        attachments.headOffset[2],
      );
      bodyPivot.add(headPivot);
    }

    // Tail pivot
    const tailPivot = new THREE.Group();
    tailPivot.name = 'hero_duck_tail_pivot';
    const proceduralTail = bodyMesh.getObjectByName('procedural_tail');
    if (proceduralTail && proceduralTail.parent) {
      const parent = proceduralTail.parent;
      tailPivot.position.copy(proceduralTail.position);
      proceduralTail.position.set(0, 0, 0);
      parent.remove(proceduralTail);
      tailPivot.add(proceduralTail);
      parent.add(tailPivot);
    } else {
      tailPivot.position.set(0, 0.42, -0.52);
      bodyPivot.add(tailPivot);
    }

    // Articulated Left (+X) & Right (-X) Wings (default tucked shoulder position)
    const wingLeftPivot = new THREE.Group();
    wingLeftPivot.name = 'hero_duck_wing_left';
    wingLeftPivot.rotation.order = 'YXZ';
    wingLeftPivot.position.set(
      Math.min(Math.abs(attachments.wingLeftOffset[0]), 0.33),
      attachments.wingLeftOffset[1],
      0.04,
    );

    const wingRightPivot = new THREE.Group();
    wingRightPivot.name = 'hero_duck_wing_right';
    wingRightPivot.rotation.order = 'YXZ';
    wingRightPivot.position.set(
      -Math.min(Math.abs(attachments.wingRightOffset[0]), 0.33),
      attachments.wingRightOffset[1],
      0.04,
    );

    const leftWingMesh = usingGlbWings
      ? wingAsset.prototype.clone(true)
      : buildProceduralDuckWing(bodyMaterial);
    leftWingMesh.scale.setScalar(attachments.wingScale);
    applyShadowAndMaterialDefaults(leftWingMesh, true, true, 1.25);
    wingLeftPivot.add(leftWingMesh);

    const rightWingMesh = usingGlbWings
      ? wingAsset.prototype.clone(true)
      : buildProceduralDuckWing(bodyMaterial);
    rightWingMesh.scale.set(
      -attachments.wingScale,
      attachments.wingScale,
      attachments.wingScale,
    );
    applyShadowAndMaterialDefaults(rightWingMesh, true, true, 1.25);
    wingRightPivot.add(rightWingMesh);

    bodyPivot.add(wingLeftPivot);
    bodyPivot.add(wingRightPivot);

    // Articulated Webbed Paddling Feet
    const feetPivot = new THREE.Group();
    feetPivot.name = 'hero_duck_feet';
    feetPivot.position.set(
      attachments.feetOffset[0],
      attachments.feetOffset[1],
      attachments.feetOffset[2],
    );

    const footLeftPivot = new THREE.Group();
    footLeftPivot.name = 'hero_duck_foot_left';
    footLeftPivot.position.set(0.18, 0, 0);
    footLeftPivot.add(buildWebbedFoot(accentMaterial));

    const footRightPivot = new THREE.Group();
    footRightPivot.name = 'hero_duck_foot_right';
    footRightPivot.position.set(-0.18, 0, 0);
    footRightPivot.add(buildWebbedFoot(accentMaterial));

    applyShadowAndMaterialDefaults(feetPivot, false, true);
    feetPivot.add(footLeftPivot);
    feetPivot.add(footRightPivot);
    bodyPivot.add(feetPivot);

    return {
      root,
      bodyPivot,
      bodyMesh,
      headPivot,
      wingLeftPivot,
      wingRightPivot,
      feetPivot,
      footLeftPivot,
      footRightPivot,
      tailPivot,
      usingGlbBody,
      usingGlbWings,
      bodyMaterial,
      accentMaterial,
    };
  }

  public dispose(): void {
    this.dracoLoader.dispose();
    for (const asset of this.assets.values()) {
      asset.prototype.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m?.dispose();
      });
    }
    this.assets.clear();
    this.inFlightGlb.clear();
    this.attemptedGlbIds.clear();
    this.updateListeners.clear();
    this.initPromise = null;
  }

  private buildFallbackAsset(id: AssetId, spec: AssetSpec): LoadedAsset {
    const raw = buildProceduralFallback(id, spec);
    const { group, size } = normalizePrototype(raw, spec, 1.0);
    return {
      id,
      prototype: group,
      isFallback: true,
      size,
      triangles: countTriangles(group),
      byteSize: 0,
    };
  }

  private async tryLoadGlb(
    url: string,
    spec: AssetSpec,
    scaleMultiplier: number,
  ): Promise<LoadedAsset | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type') ?? '';
      // Avoid trying to parse an HTML 404 fallback page from dev servers
      if (contentType.includes('text/html')) return null;

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength < 12) return null;

      // Check glTF binary magic header "glTF" (0x46546C67)
      const magic = new DataView(buffer).getUint32(0, true);
      if (magic !== 0x46546c67) return null;

      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        this.gltfLoader.parse(
          buffer,
          './models/',
          (parsed) => resolve(parsed),
          (err) => reject(err),
        );
      });

      const { group, size } = normalizePrototype(
        gltf.scene,
        spec,
        scaleMultiplier,
      );

      return {
        id: spec.id,
        prototype: group,
        isFallback: false,
        size,
        triangles: countTriangles(group),
        byteSize: buffer.byteLength,
      };
    } catch {
      return null;
    }
  }
}

export const assetLoader = new AssetLoader();
