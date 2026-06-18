// Three.js renderer: splat-textured terrain, animated water, forests, sky dome,
// PBR materials, instanced units, FX. All textures are generated procedurally
// at startup — no asset downloads. Pure WebGL2, runs on any modern browser.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { safeLS } from './store';

// CC0/CC-BY models from poly.pizza (credits in README). size = world units,
// axis: 'l' scales by length (z after ry), 'h' by height. ry orients +Z forward.
const MODEL_DEFS: Record<string, { file: string; size: number; axis: 'l' | 'h'; ry: number; y?: number; tint?: number }> = {
  // all infantry share one rigged SWAT model (the only one with a full animation
  // set: run cycle + gun-pointing idle); type identity comes from the material
  // tint. Rifle Squad is left UNtinted so it shows the SWAT's native look; the
  // other infantry keep their identifying tints.
  rifle:     { file: 'rocket',    size: 1.15, axis: 'h', ry: 0 },
  rocket:    { file: 'rocket',    size: 1.18, axis: 'h', ry: 0, tint: 0x4d5a6b },
  tank:      { file: 'tank',      size: 1.50, axis: 'l', ry: 0 },
  heavy:     { file: 'heavy',     size: 1.85, axis: 'l', ry: 0 },
  ifv:       { file: 'ifv',       size: 1.55, axis: 'l', ry: 0 }, // M2 Bradley (Sketchfab, CC-BY)
  aatank:    { file: 'mlrs',      size: 1.40, axis: 'l', ry: 0, tint: 0x7c93b5 }, // blue-gray missile carrier
  patriot:   { file: 'patriot',   size: 1.6,  axis: 'l', ry: 0 }, // MIM-104 Patriot launcher (Sketchfab, CC-BY)
  mine:      { file: 'drone',     size: 0.42, axis: 'l', ry: 0, tint: 0x33352f }, // small dark buried charge
  fueltruck: { file: 'harv',      size: 1.50, axis: 'l', ry: Math.PI, tint: 0xc0392b }, // red bomb truck (harv flip)
  flak:      { file: 'engineer',  size: 1.30, axis: 'l', ry: Math.PI, tint: 0x848e97 }, // gun truck (same flip as the pickup)
  mlrs:      { file: 'mlrs',      size: 1.60, axis: 'l', ry: 0 },
  artillery: { file: 'artillery', size: 1.75, axis: 'l', ry: Math.PI }, // Ha-To SP artillery (Sketchfab, CC-BY) — flipped to face forward
  // trucks: cab/bed geometry defeats the front heuristic — flip both (user-verified)
  harv:      { file: 'harv',      size: 1.70, axis: 'l', ry: Math.PI },
  engineer:  { file: 'engineer',  size: 1.35, axis: 'l', ry: Math.PI },
  mcv:       { file: 'harv',      size: 1.90, axis: 'l', ry: Math.PI, tint: 0x4a7ab0 }, // big blue construction rig
  dozer:     { file: 'harv',      size: 1.55, axis: 'l', ry: Math.PI, tint: 0xe0a526 }, // yellow bulldozer
  recon:     { file: 'drone',     size: 0.90, axis: 'l', ry: 0 },
  strike:    { file: 'drone',     size: 1.25, axis: 'l', ry: 0 },
  msldrone:  { file: 'drone',     size: 1.60, axis: 'l', ry: 0 },
  fighter:   { file: 'fighter',   size: 1.70, axis: 'l', ry: Math.PI }, // delta wing reads wider at the nose third
  // bomber: wingspan exceeds fuselage length, so the long-axis heuristic picks
  // the wings — quarter-turn nudge puts the prop forward
  bomber:    { file: 'bomber',    size: 2.10, axis: 'l', ry: -Math.PI / 2 },
  dbomber:   { file: 'bomber',    size: 2.40, axis: 'l', ry: -Math.PI / 2 },
  heli:      { file: 'heli',      size: 1.70, axis: 'l', ry: 0 },
  helidrone: { file: 'helidrone', size: 1.20, axis: 'l', ry: 0 },
  gunboat:   { file: 'gunboat',   size: 1.90, axis: 'l', ry: 0 },
  navdrone:  { file: 'gunboat',   size: 1.20, axis: 'l', ry: 0 },
  destroyer: { file: 'destroyer', size: 2.70, axis: 'l', ry: 0 },
  sub:       { file: 'sub',       size: 2.30, axis: 'l', ry: 0, y: -0.15 },
  subhunter: { file: 'gunboat',   size: 1.65, axis: 'l', ry: 0, tint: 0x5a6e7a }, // small gray sonar escort
  mslcruiser:{ file: 'destroyer', size: 2.55, axis: 'l', ry: 0, tint: 0x6f7a58 }, // olive bombardment cruiser
  flakship:  { file: 'destroyer', size: 2.35, axis: 'l', ry: 0, tint: 0x8a8f70 }, // pale AA cruiser
  // new units reuse existing models (themed by team tint / emissive)
  hive:        { file: 'engineer', size: 1.20, axis: 'l', ry: Math.PI },
  minidrone:   { file: 'drone',    size: 0.55, axis: 'l', ry: 0 },
  chemtrooper: { file: 'rocket',   size: 1.15, axis: 'h', ry: 0, tint: 0xa8b23c },
  biotrooper:  { file: 'rocket',   size: 1.15, axis: 'h', ry: 0, tint: 0x8a5cab },
  chemtank:    { file: 'tank',     size: 1.50, axis: 'l', ry: 0 },
  biotank:     { file: 'tank',     size: 1.55, axis: 'l', ry: 0 },
  stealthtank: { file: 'tank',     size: 1.55, axis: 'l', ry: 0 },
  chemdrone:   { file: 'drone',    size: 1.20, axis: 'l', ry: 0 },
  biodrone:    { file: 'drone',    size: 1.20, axis: 'l', ry: 0 },
  // faction signature units (reuse base models, themed by tint / size)
  apoc:        { file: 'heavy',     size: 2.25, axis: 'l', ry: 0, tint: 0x6e3a3a },     // dark-red super-heavy
  brahmos:     { file: 'mlrs',      size: 1.70, axis: 'l', ry: 0, tint: 0xc97b3a },     // orange missile launcher
  gunship:     { file: 'heli',      size: 1.85, axis: 'l', ry: 0, tint: 0xb8923a },     // gold mercenary gunship
  technical:   { file: 'engineer',  size: 1.25, axis: 'l', ry: Math.PI, tint: 0x9a8a55 }, // tan gun-truck
  mech:        { file: 'heavy',     size: 1.55, axis: 'l', ry: 0, tint: 0x6a7a8a },     // steel-blue walker
  silicondrone:{ file: 'drone',     size: 1.05, axis: 'l', ry: 0, tint: 0x3aa8b8 },     // cyan networked drone
  jungleraider:{ file: 'rocket',    size: 1.15, axis: 'h', ry: 0, tint: 0x4a6b3a },     // jungle-green infantry
  marine:      { file: 'rocket',    size: 1.15, axis: 'h', ry: 0, tint: 0x4a6a8a },     // navy infantry
  hovertank:   { file: 'tank',      size: 1.55, axis: 'l', ry: 0, tint: 0xcdd8e0 },     // white arctic hover-tank
};

// spinning rotor / propeller animation per type. y is a fallback hub height —
// replaced by the measured model top once the GLB loads. nose props sit at the
// front of the fuselage and spin around the forward axis.
const ROTORS: Record<string, { y: number; r: number; speed: number; nose?: boolean }> = {
  heli:      { y: 1.05, r: 1.45, speed: 26 },
  helidrone: { y: 0.80, r: 0.95, speed: 31 },
  recon:     { y: 0.55, r: 0.60, speed: 36 },
  strike:    { y: 0.70, r: 0.85, speed: 33 },
  msldrone:  { y: 0.85, r: 1.00, speed: 31 },
  minidrone: { y: 0.34, r: 0.42, speed: 42 },
  chemdrone: { y: 0.70, r: 0.82, speed: 33 },
  biodrone:  { y: 0.70, r: 0.82, speed: 33 },
  bomber:    { y: 0.42, r: 0.85, speed: 30, nose: true },
  dbomber:   { y: 0.48, r: 0.95, speed: 30, nose: true },
  gunship:   { y: 1.05, r: 1.45, speed: 26 },       // mercenary attack heli
  silicondrone: { y: 0.70, r: 0.85, speed: 33 },    // networked attack drone
};
import { GameMap, W, H, SEA, fbm } from '../sim/map';
import { hash2 } from '../sim/rng';
import { PLAYER_COLORS, BUILDINGS, UNITS } from '../sim/data';

// ---- model GLB cache + startup preloader ----
// Parse every GLB once and cache it, so each new game applies models instantly
// (no procedural-placeholder pop-in) and so we can preload them all behind a
// loading screen before the menu is shown.
const GLTF_CACHE = new Map<string, any>();
function loadGLB(file: string): Promise<any> {
  const cached = GLTF_CACHE.get(file);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    new GLTFLoader().load('./models/' + file + '.glb',
      g => { GLTF_CACHE.set(file, g); resolve(g); }, undefined, reject);
  });
}
// Load every unit + building model into the cache. Resolves once all settle
// (a missing file just resolves null — never blocks the menu).
export async function preloadModels(onProgress?: (done: number, total: number) => void): Promise<void> {
  const files = new Set<string>();
  for (const t in MODEL_DEFS) files.add(MODEL_DEFS[t].file);
  for (const f of ['oilfield', 'factory', 'refinery', 'airfield']) files.add(f);
  const list = [...files]; let done = 0;
  onProgress?.(0, list.length);
  await Promise.all(list.map(f => loadGLB(f).catch(() => null).then(() => { onProgress?.(++done, list.length); })));
}

const MAX_INST = 360;
const MAX_TRACER = 256;
// War Factory model orientation: rotate so the exit ramp faces +Z (where new
// vehicles spawn). Flip by Math.PI if the ramp ends up facing the wrong way.
const FACTORY_RY = 0;
const MAX_PART = 700;
const WHITE = new THREE.Color(0xffffff);

// ---------- procedural texture generation ----------
function fbmTile(size: number, octaves: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 4 << o;
    const lat = new Float32Array(n * n);
    for (let i = 0; i < lat.length; i++) lat[i] = Math.random();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * n;
      const y0 = Math.floor(fy) % n, y1 = (y0 + 1) % n;
      const ty = fy - Math.floor(fy), sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * n;
        const x0 = Math.floor(fx) % n, x1 = (x0 + 1) % n;
        const tx = fx - Math.floor(fx), sx = tx * tx * (3 - 2 * tx);
        const a = lat[y0 * n + x0], b = lat[y0 * n + x1], c = lat[y1 * n + x0], d = lat[y1 * n + x1];
        out[y * size + x] += (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * amp;
      }
    }
    total += amp; amp *= 0.55;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

const RAMPS: Record<string, number[][]> = {
  grass: [[0x35, 0x55, 0x25], [0x4d, 0x71, 0x31], [0x67, 0x8a, 0x40]],
  rock:  [[0x52, 0x54, 0x56], [0x75, 0x78, 0x7b], [0x99, 0x9d, 0xa1]],
  sand:  [[0xa6, 0x94, 0x61], [0xc1, 0xaf, 0x78], [0xd7, 0xc8, 0x91]],
  dirt:  [[0x5c, 0x45, 0x2d], [0x7a, 0x5d, 0x3b], [0x94, 0x76, 0x4c]],
};

function groundTexture(kind: string, maxAniso: number): THREE.CanvasTexture {
  const S = 256;
  const base = fbmTile(S, 5), fine = fbmTile(S, 7);
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const [lo, md, hi] = RAMPS[kind];
  for (let i = 0; i < S * S; i++) {
    let t = base[i];
    const f = fine[i];
    if (kind === 'grass') t = t * 0.72 + f * 0.28 + (f > 0.68 ? 0.06 : 0);
    else if (kind === 'rock') {
      const y = (i / S) | 0;
      t = t * 0.8 + f * 0.2 + Math.sin(y * 0.55 + base[i] * 9.0) * 0.05; // strata
    } else t = t * 0.72 + f * 0.28;
    t = Math.min(1, Math.max(0, (t - 0.22) / 0.56));
    const a = t < 0.5 ? lo : md, b = t < 0.5 ? md : hi;
    const k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    img.data[i * 4] = a[0] + (b[0] - a[0]) * k;
    img.data[i * 4 + 1] = a[1] + (b[1] - a[1]) * k;
    img.data[i * 4 + 2] = a[2] + (b[2] - a[2]) * k;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAniso;
  return tex;
}

function waterNormalTexture(maxAniso: number): THREE.CanvasTexture {
  const S = 256;
  const hgt = fbmTile(S, 5);
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const k = 420;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const hx = hgt[y * S + (x + 1) % S] - hgt[y * S + (x - 1 + S) % S];
      const hz = hgt[((y + 1) % S) * S + x] - hgt[((y - 1 + S) % S) * S + x];
      img.data[i * 4] = Math.max(0, Math.min(255, 128 - hx * k));
      img.data[i * 4 + 1] = Math.max(0, Math.min(255, 128 - hz * k));
      img.data[i * 4 + 2] = 235;
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAniso;
  tex.repeat.set(34, 34);
  return tex;
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------- geometry helpers ----------
function coloredBox(w: number, h: number, d: number, x: number, y: number, z: number, color: number, ry = 0, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  bakeColor(g, color);
  return g;
}
function coloredCyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, color: number, rx = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  bakeColor(g, color);
  return g;
}
function bakeColor(g: THREE.BufferGeometry, color: number) {
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

// generic transformed + colored primitive (scale → rotate → translate)
function part(g: THREE.BufferGeometry, color: number,
  t: { x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number; sx?: number; sy?: number; sz?: number } = {}
): THREE.BufferGeometry {
  if (t.sx !== undefined || t.sy !== undefined || t.sz !== undefined) g.scale(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
  if (t.rz) g.rotateZ(t.rz);
  if (t.rx) g.rotateX(t.rx);
  if (t.ry) g.rotateY(t.ry);
  g.translate(t.x ?? 0, t.y ?? 0, t.z ?? 0);
  bakeColor(g, color);
  return g;
}

// beveled vehicle hull with a sloped glacis, extruded from a side profile
function hull(len: number, wid: number, hgt: number, color: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-len / 2, 0.08);
  s.lineTo(-len / 2 + 0.1, hgt);
  s.lineTo(len / 2 - 0.3, hgt);
  s.lineTo(len / 2, 0.18);
  s.lineTo(len / 2, 0.08);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: wid, bevelEnabled: true, bevelSize: 0.035, bevelThickness: 0.035, bevelSegments: 2, steps: 1 });
  g.rotateY(-Math.PI / 2);
  g.translate(wid / 2, 0.04, 0);
  bakeColor(g, color);
  return g;
}

// subtle armor-plating detail texture multiplied over unit/building materials
let DETAIL: THREE.CanvasTexture | null = null;
function detailTex(): THREE.CanvasTexture {
  if (DETAIL) return DETAIL;
  const S = 128;
  const n = fbmTile(S, 5), f = fbmTile(S, 7);
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const v = 236 + (n[i] - 0.5) * 22 - (f[i] > 0.78 ? 9 : 0); // soft wear, no hard lines
      img.data[i * 4] = v * 0.98; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 0.96; img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  DETAIL = new THREE.CanvasTexture(cv);
  DETAIL.wrapS = DETAIL.wrapT = THREE.RepeatWrapping;
  DETAIL.colorSpace = THREE.SRGBColorSpace;
  return DETAIL;
}

// military camo multiply-map for units — visible texture at RTS zoom
let ARMOR: THREE.CanvasTexture | null = null;
function armorTex(): THREE.CanvasTexture {
  if (ARMOR) return ARMOR;
  const S = 128;
  const n = fbmTile(S, 4), f = fbmTile(S, 7);
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const t = n[i];
    let c: number[];
    if (t < 0.44) c = [0.60, 0.66, 0.54];        // dark olive blotch
    else if (t < 0.68) c = [0.78, 0.84, 0.68];   // mid green
    else c = [0.97, 0.93, 0.78];                 // tan
    const w = 1 + (f[i] - 0.5) * 0.14;           // fine wear
    img.data[i * 4] = Math.min(255, c[0] * w * 255);
    img.data[i * 4 + 1] = Math.min(255, c[1] * w * 255);
    img.data[i * 4 + 2] = Math.min(255, c[2] * w * 255);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ARMOR = new THREE.CanvasTexture(cv);
  ARMOR.wrapS = ARMOR.wrapT = THREE.RepeatWrapping;
  ARMOR.colorSpace = THREE.SRGBColorSpace;
  return ARMOR;
}

// rounded, beveled base slab for buildings
function roundedSlabGeo(w: number, d: number, h: number, r = 0.14): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const hw = w / 2, hd = d / 2;
  s.moveTo(-hw + r, -hd);
  s.lineTo(hw - r, -hd); s.quadraticCurveTo(hw, -hd, hw, -hd + r);
  s.lineTo(hw, hd - r); s.quadraticCurveTo(hw, hd, hw - r, hd);
  s.lineTo(-hw + r, hd); s.quadraticCurveTo(-hw, hd, -hw, hd - r);
  s.lineTo(-hw, -hd + r); s.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelSize: 0.045, bevelThickness: 0.045, bevelSegments: 2 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, h + 0.045, 0);
  return g;
}

// half-cylinder quonset/hangar roof, arch spanning width w, length len
function archGeo(rad: number, len: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rad, rad, len, 16, 1, false, 0, Math.PI);
  g.rotateZ(Math.PI / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

// ---- smooth unit models: [neutral body, team-colored accent] ----
function unitGeoSmooth(type: string): [THREE.BufferGeometry, THREE.BufferGeometry] {
  // new unit types reuse an existing procedural shape (GLB models load over them)
  const ALIAS: Record<string, string> = {
    hive: 'harv', minidrone: 'recon', melodydrone: 'recon', chemtrooper: 'rifle', biotrooper: 'rifle',
    chemtank: 'tank', biotank: 'tank', stealthtank: 'tank', chemdrone: 'recon', biodrone: 'recon',
    mcv: 'harv', dozer: 'harv', tews: 'mlrs', transport: 'destroyer', navengineer: 'gunboat',
    mortar: 'rocket', artillery: 'mlrs', artyship: 'destroyer', airtransport: 'heli',
    mortartrack: 'mlrs', fieldgun: 'rocket',
  };
  if (ALIAS[type]) type = ALIAS[type];
  const B: THREE.BufferGeometry[] = [], A: THREE.BufferGeometry[] = [];
  const gun = 0x23262a, metal = 0x666d73, dark = 0x363c41, tread = 0x1f2326, skin = 0xc9a06b;

  if (type === 'rifle' || type === 'rocket') {
    B.push(part(new THREE.CapsuleGeometry(0.115, 0.2, 3, 8), dark, { y: 0.42 }));                    // torso
    B.push(part(new THREE.SphereGeometry(0.075, 10, 8), skin, { y: 0.64 }));                         // head
    B.push(part(new THREE.SphereGeometry(0.097, 10, 8), 0x3c4435, { y: 0.665, sy: 0.75 }));          // helmet
    B.push(part(new THREE.CapsuleGeometry(0.045, 0.17, 2, 6), 0x2c3136, { x: -0.07, y: 0.15 }));     // legs
    B.push(part(new THREE.CapsuleGeometry(0.045, 0.17, 2, 6), 0x2c3136, { x: 0.07, y: 0.15 }));
    B.push(part(new THREE.CapsuleGeometry(0.038, 0.16, 2, 6), dark, { rz: 0.5, x: -0.16, y: 0.45 })); // arms
    B.push(part(new THREE.CapsuleGeometry(0.038, 0.16, 2, 6), dark, { rz: -0.5, x: 0.16, y: 0.45 }));
    if (type === 'rocket') B.push(part(new THREE.CylinderGeometry(0.05, 0.05, 0.52, 8), 0x49505a, { rx: Math.PI / 2, x: 0.13, y: 0.6, z: -0.04 }));
    else B.push(part(new THREE.CylinderGeometry(0.018, 0.018, 0.42, 6), gun, { rx: Math.PI / 2, x: 0.12, y: 0.46, z: 0.12 }));
    A.push(part(new THREE.SphereGeometry(0.128, 10, 6), 0xffffff, { y: 0.52, sy: 0.4 }));            // team band
  } else if (type === 'melody') {
    // elite female operative: slim build, beret + ponytail, long scoped sniper rifle
    const suit = 0x2f3447, hair = 0x6b4422, beret = 0x7a1f3d;
    B.push(part(new THREE.CapsuleGeometry(0.092, 0.21, 3, 8), suit, { y: 0.42 }));                   // slim torso
    B.push(part(new THREE.SphereGeometry(0.068, 10, 8), skin, { y: 0.63 }));                         // head
    B.push(part(new THREE.SphereGeometry(0.084, 10, 8), beret, { y: 0.665, sy: 0.5 }));              // beret
    B.push(part(new THREE.CapsuleGeometry(0.05, 0.13, 2, 6), hair, { rx: 0.6, y: 0.57, z: -0.085 }));// ponytail down the back
    B.push(part(new THREE.CapsuleGeometry(0.04, 0.18, 2, 6), 0x20242f, { x: -0.055, y: 0.14 }));     // legs
    B.push(part(new THREE.CapsuleGeometry(0.04, 0.18, 2, 6), 0x20242f, { x: 0.055, y: 0.14 }));
    B.push(part(new THREE.CapsuleGeometry(0.032, 0.16, 2, 6), suit, { rz: 0.45, x: -0.14, y: 0.45 }));// arms
    B.push(part(new THREE.CapsuleGeometry(0.032, 0.16, 2, 6), suit, { rz: -0.45, x: 0.14, y: 0.45 }));
    B.push(part(new THREE.CylinderGeometry(0.016, 0.016, 0.66, 6), gun, { rx: Math.PI / 2, x: 0.12, y: 0.47, z: 0.22 })); // long barrel
    B.push(part(new THREE.BoxGeometry(0.045, 0.05, 0.14), 0x111316, { x: 0.12, y: 0.51, z: 0.30 }));  // scope
    A.push(part(new THREE.SphereGeometry(0.118, 10, 6), 0xffffff, { y: 0.50, sy: 0.42 }));            // team band
  } else if (type === 'tank' || type === 'heavy') {
    const s = type === 'heavy' ? 1.22 : 1.0;
    B.push(hull(1.28 * s, 0.74 * s, 0.36 * s, metal));
    B.push(part(new THREE.CapsuleGeometry(0.14 * s, 1.05 * s, 3, 8), tread, { sx: 0.8, sz: 0.62, rx: Math.PI / 2, x: -0.45 * s, y: 0.15 * s }));
    B.push(part(new THREE.CapsuleGeometry(0.14 * s, 1.05 * s, 3, 8), tread, { sx: 0.8, sz: 0.62, rx: Math.PI / 2, x: 0.45 * s, y: 0.15 * s }));
    const bxs = type === 'heavy' ? [-0.09, 0.09] : [0];
    for (const bx of bxs) {
      B.push(part(new THREE.CylinderGeometry(0.042 * s, 0.052 * s, 0.95 * s, 8), gun, { rx: Math.PI / 2, x: bx * s, y: 0.52 * s, z: 0.62 * s }));
      B.push(part(new THREE.CylinderGeometry(0.062 * s, 0.062 * s, 0.13 * s, 8), gun, { rx: Math.PI / 2, x: bx * s, y: 0.52 * s, z: 1.05 * s }));
    }
    A.push(part(new THREE.SphereGeometry(0.28 * s, 14, 10), 0xffffff, { y: 0.49 * s, sy: 0.48, sz: 1.2 })); // turret dome
  } else if (type === 'mlrs') {
    B.push(hull(1.15, 0.72, 0.3, metal));
    B.push(part(new THREE.CapsuleGeometry(0.13, 0.95, 3, 8), tread, { sx: 0.8, sz: 0.62, rx: Math.PI / 2, x: -0.42, y: 0.14 }));
    B.push(part(new THREE.CapsuleGeometry(0.13, 0.95, 3, 8), tread, { sx: 0.8, sz: 0.62, rx: Math.PI / 2, x: 0.42, y: 0.14 }));
    B.push(part(new THREE.BoxGeometry(0.56, 0.3, 0.95), dark, { rx: -0.35, y: 0.62, z: -0.1 }));     // rocket pod
    for (const mx of [-0.17, 0, 0.17])
      for (const my of [0, 1])
        B.push(part(new THREE.CylinderGeometry(0.055, 0.055, 0.12, 8), 0x141618,
          { rx: Math.PI / 2 - 0.35, x: mx, y: 0.56 + my * 0.13, z: 0.3 + my * 0.045 }));             // launch tubes
    A.push(part(new THREE.SphereGeometry(0.21, 12, 9), 0xffffff, { y: 0.42, z: 0.42, sy: 0.6 }));    // cab
  } else if (type === 'harv') {
    B.push(hull(1.5, 0.9, 0.45, metal));
    B.push(part(new THREE.CapsuleGeometry(0.16, 1.25, 3, 8), tread, { sx: 0.85, sz: 0.65, rx: Math.PI / 2, x: -0.52, y: 0.17 }));
    B.push(part(new THREE.CapsuleGeometry(0.16, 1.25, 3, 8), tread, { sx: 0.85, sz: 0.65, rx: Math.PI / 2, x: 0.52, y: 0.17 }));
    B.push(part(new THREE.CylinderGeometry(0.42, 0.34, 0.5, 12), dark, { y: 0.72, z: -0.3 }));       // ore drum
    B.push(part(new THREE.SphereGeometry(0.3, 12, 9), dark, { sy: 0.5, sx: 1.4, y: 0.42, z: 0.85 })); // scoop
    A.push(part(new THREE.SphereGeometry(0.26, 12, 9), 0xffffff, { y: 0.72, z: 0.32, sy: 0.7 }));    // cab
  } else if (type === 'engineer') {
    B.push(hull(1.0, 0.62, 0.3, 0x8a8350));                                                              // utility truck
    B.push(part(new THREE.CapsuleGeometry(0.11, 0.8, 3, 8), tread, { sx: 0.8, sz: 0.6, rx: Math.PI / 2, x: -0.36, y: 0.12 }));
    B.push(part(new THREE.CapsuleGeometry(0.11, 0.8, 3, 8), tread, { sx: 0.8, sz: 0.6, rx: Math.PI / 2, x: 0.36, y: 0.12 }));
    B.push(part(new THREE.CylinderGeometry(0.035, 0.045, 0.7, 6), dark, { rx: -0.7, y: 0.55, z: -0.15 })); // crane arm
    B.push(part(new THREE.SphereGeometry(0.07, 8, 6), 0xd8b02a, { y: 0.82, z: 0.12 }));                    // tool head
    B.push(part(new THREE.BoxGeometry(0.34, 0.2, 0.3), 0x6b6f74, { y: 0.42, z: -0.32 }));                  // gear box
    A.push(part(new THREE.SphereGeometry(0.18, 12, 9), 0xffffff, { y: 0.46, z: 0.28, sy: 0.65 }));         // cab (team)
  } else if (type === 'gunboat' || type === 'destroyer' || type === 'navdrone') {
    const s = type === 'destroyer' ? 1.45 : type === 'gunboat' ? 1.0 : 0.62;
    B.push(part(new THREE.CapsuleGeometry(0.22 * s, 1.0 * s, 4, 10), metal, { sy: 1, sx: 0.85, rx: Math.PI / 2, y: 0.02 * s })); // hull
    B.push(part(new THREE.BoxGeometry(0.26 * s, 0.2 * s, 0.5 * s), dark, { y: 0.26 * s, z: -0.1 * s }));                          // superstructure
    if (type === 'destroyer') {
      B.push(part(new THREE.CylinderGeometry(0.03 * s, 0.03 * s, 0.5 * s, 6), dark, { y: 0.55 * s, z: -0.1 * s }));               // mast
      B.push(part(new THREE.SphereGeometry(0.13 * s, 10, 8), gun, { y: 0.2 * s, z: -0.55 * s, sy: 0.6 }));                        // aft turret
    }
    B.push(part(new THREE.SphereGeometry(0.13 * s, 10, 8), gun, { y: 0.2 * s, z: 0.42 * s, sy: 0.6 }));                           // bow turret
    B.push(part(new THREE.CylinderGeometry(0.025 * s, 0.03 * s, 0.5 * s, 6), gun, { rx: Math.PI / 2, y: 0.22 * s, z: 0.7 * s })); // gun
    A.push(part(new THREE.SphereGeometry(0.12 * s, 10, 8), 0xffffff, { y: 0.36 * s, z: 0.12 * s, sy: 0.5, sz: 1.3 }));            // bridge (team)
  } else if (type === 'sub') {
    B.push(part(new THREE.CapsuleGeometry(0.2, 1.2, 4, 12), 0x2e3338, { rx: Math.PI / 2, y: 0.02 }));                              // pressure hull
    B.push(part(new THREE.BoxGeometry(0.12, 0.26, 0.34), dark, { y: 0.26, z: 0.05 }));                                             // sail
    B.push(part(new THREE.CylinderGeometry(0.015, 0.015, 0.22, 5), gun, { y: 0.46, z: 0.05 }));                                    // periscope
    B.push(part(new THREE.BoxGeometry(0.5, 0.03, 0.16), dark, { y: 0.02, z: -0.62 }));                                             // stern planes
    A.push(part(new THREE.BoxGeometry(0.13, 0.06, 0.2), 0xffffff, { y: 0.36, z: 0.05 }));                                          // sail top (team)
  } else if (type === 'fighter' || type === 'bomber' || type === 'dbomber') {
    const s = type === 'fighter' ? 1.0 : 1.5;
    B.push(part(new THREE.CapsuleGeometry(0.1 * s, 0.7 * s, 4, 10), metal, { rx: Math.PI / 2, y: 0.2 * s }));                       // fuselage
    B.push(part(new THREE.ConeGeometry(0.09 * s, 0.25 * s, 8), dark, { rx: Math.PI / 2, y: 0.2 * s, z: 0.55 * s }));                // nose
    const sweep = type === 'fighter' ? 0.55 : 0.15;
    B.push(part(new THREE.BoxGeometry(0.62 * s, 0.035 * s, 0.24 * s), metal, { ry: sweep, x: -0.34 * s, y: 0.18 * s, z: -0.05 * s }));
    B.push(part(new THREE.BoxGeometry(0.62 * s, 0.035 * s, 0.24 * s), metal, { ry: -sweep, x: 0.34 * s, y: 0.18 * s, z: -0.05 * s }));
    B.push(part(new THREE.BoxGeometry(0.03 * s, 0.18 * s, 0.16 * s), metal, { y: 0.32 * s, z: -0.42 * s }));                        // tail fin
    if (type !== 'fighter') {
      B.push(part(new THREE.CylinderGeometry(0.05 * s, 0.05 * s, 0.3 * s, 8), gun, { rx: Math.PI / 2, x: -0.3 * s, y: 0.12 * s }));  // engines
      B.push(part(new THREE.CylinderGeometry(0.05 * s, 0.05 * s, 0.3 * s, 8), gun, { rx: Math.PI / 2, x: 0.3 * s, y: 0.12 * s }));
    }
    if (type === 'dbomber') for (const wx of [-0.62, 0.62]) {                                                                        // escort drones
      B.push(part(new THREE.SphereGeometry(0.07 * s, 8, 6), dark, { x: wx * s, y: 0.2 * s, z: -0.05 * s, sy: 0.6 }));
      B.push(part(new THREE.CylinderGeometry(0.09 * s, 0.09 * s, 0.012, 10), 0x2a2e33, { x: wx * s, y: 0.26 * s, z: -0.05 * s }));
    }
    A.push(part(new THREE.SphereGeometry(0.09 * s, 10, 8), 0xffffff, { y: 0.28 * s, z: 0.18 * s, sy: 0.5, sz: 1.6 }));               // canopy
  } else if (type === 'heli' || type === 'helidrone') {
    const s = type === 'heli' ? 1.0 : 0.68;
    B.push(part(new THREE.SphereGeometry(0.2 * s, 12, 9), dark, { y: 0.22 * s, sy: 0.75, sz: 1.5 }));                                // body
    B.push(part(new THREE.CylinderGeometry(0.035 * s, 0.05 * s, 0.7 * s, 6), metal, { rx: Math.PI / 2, y: 0.24 * s, z: -0.55 * s })); // tail boom
    B.push(part(new THREE.CylinderGeometry(0.09 * s, 0.09 * s, 0.014, 10), 0x2a2e33, { rz: Math.PI / 2, y: 0.3 * s, z: -0.88 * s })); // tail rotor
    B.push(part(new THREE.CylinderGeometry(0.55 * s, 0.55 * s, 0.016, 16), 0x2a2e33, { y: 0.46 * s }));                               // main rotor
    B.push(part(new THREE.SphereGeometry(0.045 * s, 8, 6), gun, { y: 0.42 * s }));                                                    // rotor hub
    if (type === 'heli') for (const sx2 of [-0.16, 0.16]) {
      B.push(part(new THREE.CylinderGeometry(0.02, 0.02, 0.55, 5), gun, { rx: Math.PI / 2, x: sx2, y: 0.05 }));                       // skids
      B.push(part(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 5), gun, { rx: Math.PI / 2, x: sx2 * 1.6, y: 0.16, z: 0.1 }));        // weapon pods
    }
    A.push(part(new THREE.SphereGeometry(0.12 * s, 10, 8), 0xffffff, { y: 0.26 * s, z: 0.18 * s, sy: 0.6, sz: 1.2 }));                // canopy
  } else { // drones: recon / strike / msldrone
    const s = type === 'msldrone' ? 1.6 : type === 'strike' ? 1.35 : 1.0;
    B.push(part(new THREE.SphereGeometry(0.17 * s, 14, 10), dark, { y: 0.17 * s, sy: 0.6, sz: 1.3 })); // airframe
    B.push(part(new THREE.CylinderGeometry(0.024 * s, 0.024 * s, 0.82 * s, 6), metal, { rz: Math.PI / 2, ry: Math.PI / 4, y: 0.2 * s }));
    B.push(part(new THREE.CylinderGeometry(0.024 * s, 0.024 * s, 0.82 * s, 6), metal, { rz: Math.PI / 2, ry: -Math.PI / 4, y: 0.2 * s }));
    for (const [rx2, rz2] of [[0.29, 0.29], [-0.29, 0.29], [0.29, -0.29], [-0.29, -0.29]]) {
      B.push(part(new THREE.CylinderGeometry(0.16 * s, 0.16 * s, 0.016, 14), 0x2a2e33, { x: rx2 * s, y: 0.26 * s, z: rz2 * s }));
      B.push(part(new THREE.SphereGeometry(0.035 * s, 8, 6), gun, { x: rx2 * s, y: 0.26 * s, z: rz2 * s }));
    }
    const nMissiles = type === 'msldrone' ? 4 : type === 'strike' ? 2 : 0;
    const mxs = nMissiles === 4 ? [-0.15, -0.05, 0.05, 0.15] : nMissiles === 2 ? [-0.08, 0.08] : [];
    for (const mx of mxs) {
      B.push(part(new THREE.CylinderGeometry(0.035 * s, 0.035 * s, 0.4 * s, 6), gun, { rx: Math.PI / 2, x: mx * s, y: 0.05 * s }));
      B.push(part(new THREE.ConeGeometry(0.035 * s, 0.09 * s, 6), 0x802020, { rx: Math.PI / 2, x: mx * s, y: 0.05 * s, z: 0.24 * s }));
    }
    if (type === 'msldrone') B.push(part(new THREE.SphereGeometry(0.07 * s, 10, 8), gun, { y: -0.02 * s }));
    A.push(part(new THREE.SphereGeometry(0.1 * s, 10, 8), 0xffffff, { y: 0.27 * s, z: 0.1 * s, sy: 0.55, sz: 1.3 })); // canopy
  }
  // mergeGeometries requires consistent indexing; ExtrudeGeometry is non-indexed
  const flat = (arr: THREE.BufferGeometry[]) => arr.map(g => (g.index ? g.toNonIndexed() : g));
  return [mergeGeometries(flat(B)), mergeGeometries(flat(A))];
}

// ---- legacy blocky models (kept for reference, unused) ----
function unitGeo(type: string): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const B: THREE.BufferGeometry[] = [], A: THREE.BufferGeometry[] = [];
  const gun = 0x2a2e33, metal = 0x6b7178, dark = 0x3a4045, tread = 0x23272b;
  if (type === 'rifle' || type === 'rocket') {
    B.push(coloredBox(0.26, 0.34, 0.18, 0, 0.40, 0, dark));
    B.push(coloredBox(0.16, 0.15, 0.16, 0, 0.66, 0, 0xc9a06b));
    B.push(coloredBox(0.20, 0.06, 0.20, 0, 0.76, 0, dark));
    B.push(coloredBox(0.09, 0.22, 0.09, -0.09, 0.11, 0, 0x2f3338));
    B.push(coloredBox(0.09, 0.22, 0.09, 0.09, 0.11, 0, 0x2f3338));
    if (type === 'rocket') B.push(coloredCyl(0.05, 0.05, 0.5, 6, 0.16, 0.62, -0.05, 0x4a4f55, Math.PI / 2));
    else B.push(coloredBox(0.05, 0.05, 0.42, 0.14, 0.45, 0.12, gun));
    A.push(coloredBox(0.28, 0.10, 0.20, 0, 0.53, 0, 0xffffff));
  } else if (type === 'tank' || type === 'heavy') {
    const s = type === 'heavy' ? 1.22 : 1.0;
    B.push(coloredBox(0.78 * s, 0.26 * s, 1.15 * s, 0, 0.30 * s, 0, metal));
    B.push(coloredBox(0.22 * s, 0.20 * s, 1.25 * s, -0.45 * s, 0.16 * s, 0, tread));
    B.push(coloredBox(0.22 * s, 0.20 * s, 1.25 * s, 0.45 * s, 0.16 * s, 0, tread));
    B.push(coloredCyl(0.06 * s, 0.07 * s, 0.95 * s, 6, 0, 0.52 * s, 0.55 * s, gun, Math.PI / 2));
    if (type === 'heavy') B.push(coloredCyl(0.06 * s, 0.07 * s, 0.95 * s, 6, 0.14 * s, 0.52 * s, 0.55 * s, gun, Math.PI / 2));
    A.push(coloredBox(0.46 * s, 0.20 * s, 0.58 * s, 0, 0.50 * s, -0.05 * s, 0xffffff));
  } else if (type === 'mlrs') {
    B.push(coloredBox(0.78, 0.22, 1.1, 0, 0.27, 0, metal));                       // hull
    B.push(coloredBox(0.22, 0.2, 1.2, -0.45, 0.16, 0, tread));                    // tracks
    B.push(coloredBox(0.22, 0.2, 1.2, 0.45, 0.16, 0, tread));
    B.push(coloredBox(0.56, 0.3, 0.95, 0, 0.62, -0.08, dark, 0, -0.35));          // angled rocket pod
    B.push(coloredBox(0.5, 0.04, 0.85, 0, 0.8, -0.13, 0x1f2326, 0, -0.35));       // tube face
    A.push(coloredBox(0.6, 0.08, 0.5, 0, 0.45, 0.35, 0xffffff));                  // cab plate (team)
  } else if (type === 'msldrone') {
    const s = 1.2;
    B.push(coloredBox(0.42 * s, 0.18 * s, 0.52 * s, 0, 0.16 * s, 0, dark));       // body
    B.push(coloredBox(0.85 * s, 0.05 * s, 0.09 * s, 0, 0.22 * s, 0, metal, Math.PI / 4));
    B.push(coloredBox(0.85 * s, 0.05 * s, 0.09 * s, 0, 0.22 * s, 0, metal, -Math.PI / 4));
    for (const [rx2, rz2] of [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]])
      B.push(coloredCyl(0.17 * s, 0.17 * s, 0.025, 8, rx2 * s, 0.27 * s, rz2 * s, 0x32363a));
    for (const mx of [-0.14, -0.05, 0.05, 0.14])
      B.push(coloredCyl(0.045, 0.045, 0.55, 5, mx * s, 0.04 * s, 0.05, gun, Math.PI / 2)); // 4 missiles
    A.push(coloredBox(0.26 * s, 0.08 * s, 0.3 * s, 0, 0.3 * s, 0, 0xffffff));
  } else if (type === 'recon' || type === 'strike') {
    const s = type === 'strike' ? 1.45 : 1.0;
    B.push(coloredBox(0.3 * s, 0.14 * s, 0.42 * s, 0, 0.15 * s, 0, dark));               // body
    B.push(coloredBox(0.78 * s, 0.04 * s, 0.08 * s, 0, 0.2 * s, 0, metal, Math.PI / 4)); // arms
    B.push(coloredBox(0.78 * s, 0.04 * s, 0.08 * s, 0, 0.2 * s, 0, metal, -Math.PI / 4));
    for (const [rx, rz] of [[0.27, 0.27], [-0.27, 0.27], [0.27, -0.27], [-0.27, -0.27]])
      B.push(coloredCyl(0.15 * s, 0.15 * s, 0.025, 8, rx * s, 0.24 * s, rz * s, 0x32363a));
    if (type === 'strike') {
      B.push(coloredCyl(0.05, 0.05, 0.5, 5, -0.16 * s, 0.05 * s, 0.05, gun, Math.PI / 2)); // missiles
      B.push(coloredCyl(0.05, 0.05, 0.5, 5, 0.16 * s, 0.05 * s, 0.05, gun, Math.PI / 2));
    }
    A.push(coloredBox(0.2 * s, 0.07 * s, 0.26 * s, 0, 0.26 * s, 0, 0xffffff));           // canopy (team)
  } else { // harvester
    B.push(coloredBox(0.95, 0.45, 1.45, 0, 0.42, 0, metal));
    B.push(coloredBox(0.25, 0.22, 1.55, -0.52, 0.18, 0, tread));
    B.push(coloredBox(0.25, 0.22, 1.55, 0.52, 0.18, 0, tread));
    B.push(coloredBox(0.9, 0.35, 0.3, 0, 0.30, 0.85, dark));
    A.push(coloredBox(0.6, 0.3, 0.45, 0, 0.78, -0.35, 0xffffff));
  }
  return [mergeGeometries(B), mergeGeometries(A)];
}

// ---- remodeled buildings: beveled slabs, arches, tanks, cranes ----
function buildingGroupPro(type: string, teamColor: number): THREE.Group {
  const g = new THREE.Group();
  const team = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.45, metalness: 0.3, map: detailTex() });
  const mat = (c: number, r = 0.75, m = 0.1) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m, map: detailTex() });
  const add = (geo: THREE.BufferGeometry, mt: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, mt);
    mesh.position.set(x, y, z);
    mesh.castShadow = true; mesh.receiveShadow = true;
    g.add(mesh); return mesh;
  };
  const concrete = mat(0x979ca1), darkM = mat(0x474d53), steel = mat(0xb6bcc2, 0.5, 0.45), olive = mat(0x6b7a5b);

  // neutral garrisonable city building: reads clearly as an enterable building —
  // banded window floors + a prominent doorway + a roof with a team-colour band
  // (shows who holds it) and a rooftop block. Distinct from the flat cover blocks.
  if (type === 'bldgsm' || type === 'bldglg' || type === 'bldgxl') {
    const sz = type === 'bldgxl' ? 4 : type === 'bldglg' ? 3 : 2;
    const w = sz * 0.82, d = sz * 0.82, h = sz === 4 ? 5.2 : sz === 3 ? 3.6 : 2.4;
    const floors = sz === 4 ? 6 : sz === 3 ? 4 : 3;
    const wall = mat(0xb7bdc2, 0.92, 0.04);   // pale concrete
    const glass = mat(0x39536b, 0.3, 0.55);   // dark blue-grey windows
    // Merge each material's pieces into ONE mesh: a city map holds ~18 of these,
    // so per-building mesh counts matter — ~4 draw calls each instead of ~20.
    const box = (gw: number, gh: number, gd: number, x: number, y: number, z: number) => {
      const bg = new THREE.BoxGeometry(gw, gh, gd); bg.translate(x, y, z); return bg;
    };
    const wallGeos: THREE.BufferGeometry[] = [box(w, h, d, 0, h / 2, 0)];
    const glassGeos: THREE.BufferGeometry[] = [];
    // window bands wrapping each floor (front, back, both sides)
    for (let f = 0; f < floors; f++) {
      const y = (h / floors) * (f + 0.55), bh = h / floors * 0.42;
      glassGeos.push(box(w * 0.82, bh, 0.05, 0, y, d / 2 + 0.01));
      glassGeos.push(box(w * 0.82, bh, 0.05, 0, y, -d / 2 - 0.01));
      glassGeos.push(box(0.05, bh, d * 0.82, w / 2 + 0.01, y, 0));
      glassGeos.push(box(0.05, bh, d * 0.82, -w / 2 - 0.01, y, 0));
    }
    // roof parapet + a small rooftop housing (concrete, merged with the walls)
    wallGeos.push(box(w + 0.1, 0.1, d + 0.1, 0, h + 0.05, 0));
    wallGeos.push(box(w * 0.4, 0.3, d * 0.4, -w * 0.18, h + 0.3, -d * 0.16));
    const wallMesh = new THREE.Mesh(mergeGeometries(wallGeos), wall);
    wallMesh.castShadow = true; wallMesh.receiveShadow = true; g.add(wallMesh);
    const glassMesh = new THREE.Mesh(mergeGeometries(glassGeos), glass);
    glassMesh.receiveShadow = true; g.add(glassMesh);
    // a clear ground-floor doorway (reads as "you can enter here")
    add(new THREE.BoxGeometry(w * 0.3, h * 0.3, 0.08), mat(0x20262d), 0, h * 0.15, d / 2 + 0.02);
    // roof team-colour band shows who currently holds the building (grey = empty)
    add(new THREE.BoxGeometry(w + 0.16, 0.12, d + 0.16), team, 0, h + 0.14, 0);
    return g;
  }

  if (type === 'conyard') {
    add(roundedSlabGeo(2.7, 2.7, 0.55), concrete);
    add(roundedSlabGeo(2.0, 2.0, 0.35), darkM, 0, 0.55, 0.1);
    add(roundedSlabGeo(2.1, 0.18, 0.06, 0.06), team, 0, 0.9, 0.15);
    add(new THREE.CylinderGeometry(0.09, 0.11, 2.0, 8), steel, -1.0, 1.0, -1.0);
    add(new THREE.BoxGeometry(1.9, 0.12, 0.16), steel, -0.1, 2.0, -1.0);
    const hook = add(new THREE.BoxGeometry(0.14, 0.5, 0.14), darkM, 0.6, 1.7, -1.0);
    hook.castShadow = true;
    add(new THREE.SphereGeometry(0.34, 16, 12), steel, 0.85, 1.0, 0.85);
    add(new THREE.CylinderGeometry(0.1, 0.1, 0.45, 8), darkM, -0.8, 0.75, 0.8);
  } else if (type === 'power') {
    add(roundedSlabGeo(1.8, 1.8, 0.4), concrete);
    for (const [tx, tz] of [[-0.42, -0.1], [0.45, 0.25]]) {
      add(new THREE.CylinderGeometry(0.3, 0.43, 1.25, 14), mat(0xc4c9ce), tx, 1.0, tz);
      add(new THREE.TorusGeometry(0.31, 0.035, 8, 16), steel, tx, 1.62, tz).rotation.x = Math.PI / 2;
    }
    add(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 6), steel, 0, 0.5, 0.05).rotation.z = Math.PI / 2;
    add(roundedSlabGeo(1.5, 0.3, 0.08, 0.08), team, 0, 0.4, 0.72);
  } else if (type === 'refinery') {
    add(roundedSlabGeo(2.7, 2.7, 0.45), concrete);
    for (const [tx, tz, h] of [[-0.75, -0.6, 1.1], [0.1, -0.85, 0.85]]) {
      add(new THREE.CylinderGeometry(0.45, 0.45, h, 14), mat(0xb09a45, 0.55, 0.35), tx, 0.45 + h / 2, tz);
      add(new THREE.SphereGeometry(0.45, 14, 8), mat(0xb09a45, 0.55, 0.35), tx, 0.45 + h, tz).scale.y = 0.4;
    }
    add(new THREE.CylinderGeometry(0.045, 0.045, 1.5, 6), steel, -0.3, 0.95, -0.7).rotation.z = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.07, 0.07, 1.7, 6), darkM, 1.1, 1.3, -1.0);
    add(new THREE.BoxGeometry(1.1, 0.7, 0.9), darkM, 0.7, 0.8, -0.2);
    add(roundedSlabGeo(1.7, 1.0, 0.1, 0.1), team, 0, 0.45, 0.8);
  } else if (type === 'barracks') {
    add(roundedSlabGeo(1.85, 1.85, 0.3), concrete);
    add(archGeo(0.8, 1.7), olive, 0, 0.3, 0);
    add(new THREE.BoxGeometry(1.58, 0.74, 0.1), olive, 0, 0.55, 0.82);
    add(new THREE.BoxGeometry(0.45, 0.5, 0.06), darkM, 0, 0.42, 0.9);
    for (const bx of [-0.6, 0, 0.6]) add(new THREE.CapsuleGeometry(0.1, 0.3, 2, 6), mat(0x8a7a55), bx, 0.4, 1.05).rotation.z = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.025, 0.025, 1.2, 5), steel, 0.8, 1.1, 0.8);
    add(new THREE.BoxGeometry(0.42, 0.26, 0.03), team, 1.02, 1.55, 0.8);
  } else if (type === 'factory') {
    add(roundedSlabGeo(2.7, 2.5, 0.35), concrete);
    add(new THREE.BoxGeometry(2.3, 0.9, 2.0), mat(0x848a90), 0, 0.78, 0);
    add(archGeo(1.16, 2.0), mat(0x6e7a86), 0, 1.2, 0);
    add(new THREE.BoxGeometry(1.7, 0.85, 0.1), darkM, 0, 0.72, 1.22);
    add(new THREE.CylinderGeometry(0.11, 0.13, 1.2, 8), darkM, -1.0, 1.9, -0.85);
    add(new THREE.TorusGeometry(0.12, 0.025, 6, 12), steel, -1.0, 2.45, -0.85).rotation.x = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.28, 0.28, 0.7, 10), steel, 1.05, 0.7, -0.85);
    add(roundedSlabGeo(2.1, 0.22, 0.07, 0.07), team, 0, 2.3, 0);
  } else if (type === 'turret') {
    add(new THREE.CylinderGeometry(0.5, 0.6, 0.4, 14), concrete, 0, 0.2, 0);
    add(new THREE.TorusGeometry(0.5, 0.05, 8, 18), darkM, 0, 0.42, 0).rotation.x = Math.PI / 2;
    // gun assembly on a rotating pivot that tracks the current target
    const pivot = new THREE.Group();
    const addP = (geo: THREE.BufferGeometry, mt: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(geo, mt);
      mesh.position.set(x, y, z);
      mesh.castShadow = true; mesh.receiveShadow = true;
      pivot.add(mesh); return mesh;
    };
    addP(new THREE.SphereGeometry(0.3, 14, 10), team, 0, 0.55, 0).scale.y = 0.6;
    addP(new THREE.CylinderGeometry(0.05, 0.06, 0.85, 8), darkM, 0, 0.62, 0.45).rotation.x = Math.PI / 2;
    addP(new THREE.CylinderGeometry(0.075, 0.075, 0.12, 8), darkM, 0, 0.62, 0.9).rotation.x = Math.PI / 2;
    g.add(pivot);
    g.userData.pivot = pivot;
  } else if (type === 'sam') {
    add(new THREE.CylinderGeometry(0.52, 0.6, 0.32, 14), concrete, 0, 0.16, 0);
    add(new THREE.SphereGeometry(0.26, 12, 9), team, 0, 0.42, 0).scale.y = 0.7;
    for (const rx2 of [-0.15, 0.15]) {
      const rack = add(new THREE.BoxGeometry(0.2, 0.13, 0.8), darkM, rx2, 0.62, 0);
      rack.rotation.x = -0.55;
      for (const mz of [-0.05, 0.18]) {
        const tip = add(new THREE.ConeGeometry(0.035, 0.12, 6), mat(0x9a3030), rx2, 0.78 + mz * 0.6, 0.28 + mz);
        tip.rotation.x = -0.55 + Math.PI / 2;
      }
    }
  } else if (type === 'dronefac') {
    add(roundedSlabGeo(1.85, 1.85, 0.35), concrete);
    add(new THREE.CylinderGeometry(0.62, 0.62, 0.06, 18), darkM, 0.32, 0.38, 0.32);
    add(new THREE.BoxGeometry(0.36, 0.05, 0.07), mat(0xd8d8d8), 0.32, 0.42, 0.32);
    add(new THREE.BoxGeometry(0.07, 0.05, 0.36), mat(0xd8d8d8), 0.32, 0.42, 0.32);
    add(new THREE.BoxGeometry(0.5, 0.95, 0.5), mat(0x7d8489), -0.55, 0.85, -0.55);
    add(new THREE.SphereGeometry(0.3, 14, 10), steel, -0.55, 1.5, -0.55).scale.y = 0.5;
    add(new THREE.CylinderGeometry(0.02, 0.02, 0.8, 5), steel, -0.3, 1.6, -0.7);
    add(roundedSlabGeo(1.5, 0.2, 0.06, 0.06), team, 0, 0.35, -0.78);
  } else if (type === 'shipyard') {
    add(roundedSlabGeo(2.7, 2.7, 0.35), concrete);
    const slip = add(new THREE.BoxGeometry(1.6, 0.12, 1.6), darkM, 0, 0.18, 1.0);
    slip.rotation.x = 0.18;
    for (const px of [-1.0, 1.0]) {
      add(new THREE.BoxGeometry(0.14, 1.6, 0.14), steel, px, 0.95, -0.3);
      add(new THREE.BoxGeometry(0.14, 1.6, 0.14), steel, px, 0.95, 0.7);
    }
    add(new THREE.BoxGeometry(2.4, 0.16, 0.2), steel, 0, 1.75, 0.2);
    add(new THREE.BoxGeometry(0.16, 0.5, 0.16), darkM, 0.3, 1.45, 0.2);
    add(archGeo(0.55, 1.0), olive, -0.8, 0.35, -0.9);
    add(roundedSlabGeo(0.9, 0.2, 0.07, 0.07), team, 0.8, 0.35, -1.05);
  } else if (type === 'airforce') {
    add(roundedSlabGeo(2.7, 2.5, 0.3), concrete);
    add(archGeo(1.05, 2.3), mat(0x77808a), 0, 0.3, 0);
    add(new THREE.BoxGeometry(2.05, 1.0, 0.08), darkM, 0, 0.78, 1.16);
    add(new THREE.BoxGeometry(0.4, 0.8, 0.4), mat(0x848a90), -1.05, 0.7, -0.9);
    add(new THREE.BoxGeometry(0.46, 0.3, 0.46), team, -1.05, 1.25, -0.9);
    add(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 5), steel, 1.0, 0.7, -1.0);
  } else if (type === 'lab') {
    add(roundedSlabGeo(1.85, 1.85, 0.4), concrete);
    add(new THREE.CylinderGeometry(0.55, 0.6, 0.9, 16), mat(0xc8ccd0, 0.4, 0.2), 0, 0.85, 0); // dome base
    add(new THREE.SphereGeometry(0.55, 16, 12), mat(0x9fd8e8, 0.25, 0.3), 0, 1.3, 0).scale.y = 0.7; // glass dome
    add(new THREE.TorusGeometry(0.3, 0.05, 8, 16), steel, 0, 1.35, 0).rotation.x = Math.PI / 2.5;
    add(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 6), steel, 0.6, 0.5, 0.6);
    add(roundedSlabGeo(1.5, 0.2, 0.06, 0.06), team, 0, 0.45, -0.75);
  } else if (type === 'wall') {
    // solid concrete wall, crenellated top — symmetric on every side. Plain box
    // geometry (centred origin) keeps it unambiguously right-side up; the block
    // is slightly oversized and sunk a touch so neighbours overlap with no gap.
    add(new THREE.BoxGeometry(1.04, 0.8, 1.04), concrete, 0, 0.28, 0);   // main block (~ -0.12 .. 0.68)
    add(new THREE.BoxGeometry(1.06, 0.1, 1.06), team, 0, 0.6, 0);        // team band near the top
    for (const [dx, dz] of [[-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.32, 0.32]])
      add(new THREE.BoxGeometry(0.32, 0.34, 0.32), concrete, dx, 0.85, dz); // merlons clearly ON TOP
  } else if (type === 'barrier') {
    // crossed concrete tank trap (hedgehog) — no base plate, as in the original
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const beam = add(new THREE.BoxGeometry(0.14, 0.14, 1.18), concrete, 0, 0.3, 0);
      beam.rotation.y = a;
    }
    add(new THREE.BoxGeometry(0.14, 0.14, 1.18), darkM, 0, 0.42, 0);
  } else if (type === 'radar') {
    add(roundedSlabGeo(1.8, 1.8, 0.35), concrete);
    add(new THREE.CylinderGeometry(0.18, 0.26, 0.7, 10), darkM, 0, 0.7, 0); // mast
    // tilted parabolic dish
    const dish = add(new THREE.SphereGeometry(0.55, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2.4), mat(0xd2d7dc, 0.5, 0.4), 0, 1.05, 0);
    dish.rotation.x = -Math.PI / 3.2; dish.scale.set(1, 0.55, 1);
    add(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 6), steel, 0, 1.15, 0.18); // feed horn
    add(roundedSlabGeo(1.4, 0.18, 0.06, 0.06), team, 0, 0.4, -0.75);
    g.userData.spinDish = dish; // rotated each frame by the renderer
  } else if (type === 'silo') {
    add(roundedSlabGeo(1.85, 1.85, 0.35), concrete);
    add(new THREE.CylinderGeometry(0.62, 0.7, 0.25, 16), darkM, 0, 0.45, 0); // blast ring
    add(new THREE.CylinderGeometry(0.55, 0.55, 0.1, 16), steel, 0, 0.58, 0); // hatch
    add(new THREE.ConeGeometry(0.18, 0.55, 10), mat(0xd8dde2, 0.4, 0.5), 0, 0.85, 0); // warhead tip
    add(new THREE.BoxGeometry(0.32, 0.5, 0.32), olive, 0.65, 0.55, 0.65); // control bunker
    add(roundedSlabGeo(1.4, 0.18, 0.06, 0.06), team, 0, 0.4, -0.78);
  } else if (type === 'oilrig') {
    // pump-jack on a pad: tapered derrick tower + a nodding beam + a team band
    add(roundedSlabGeo(0.9, 0.9, 0.16), concrete, 0, 0.08, 0);
    add(new THREE.CylinderGeometry(0.06, 0.18, 1.15, 6), steel, -0.16, 0.66, 0);   // derrick tower
    add(new THREE.CylinderGeometry(0.17, 0.2, 0.22, 10), mat(0x6f767c), -0.16, 0.22, 0); // wellhead
    add(new THREE.BoxGeometry(0.78, 0.09, 0.11), darkM, 0.08, 1.0, 0);             // nodding beam
    add(new THREE.BoxGeometry(0.13, 0.46, 0.13), darkM, 0.36, 0.55, 0);            // counterweight post
    add(roundedSlabGeo(0.82, 0.15, 0.05, 0.05), team, 0, 0.2, 0.42);              // team-colour band
  } else if (type === 'airfield') {
    add(roundedSlabGeo(1.9, 1.9, 0.14, 0.08), mat(0x4e545a));
    for (const sz2 of [-0.55, 0, 0.55]) add(new THREE.BoxGeometry(0.1, 0.02, 0.45), mat(0xd8d8d8), 0, 0.16, sz2);
    add(new THREE.CylinderGeometry(0.12, 0.14, 0.85, 8), concrete, -0.7, 0.55, -0.7);
    add(new THREE.BoxGeometry(0.34, 0.22, 0.34), team, -0.7, 1.05, -0.7);
    add(new THREE.CylinderGeometry(0.015, 0.015, 0.5, 5), steel, 0.75, 0.4, -0.75);
    const sock = add(new THREE.ConeGeometry(0.06, 0.22, 6), mat(0xd07020), 0.75, 0.62, -0.65);
    sock.rotation.x = Math.PI / 2;
  } else if (type === 'cannon') {
    // squat bunker with one big tracking gun barrel
    add(new THREE.CylinderGeometry(0.6, 0.68, 0.4, 14), concrete, 0, 0.2, 0);
    const pivot = new THREE.Group();
    const addP = (geo: THREE.BufferGeometry, mt: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(geo, mt); mesh.position.set(x, y, z);
      mesh.castShadow = true; mesh.receiveShadow = true; pivot.add(mesh); return mesh;
    };
    addP(roundedSlabGeo(0.6, 0.55, 0.4, 0.06), team, 0, 0.55, 0);
    addP(new THREE.CylinderGeometry(0.11, 0.13, 1.4, 10), darkM, 0, 0.62, 0.6).rotation.x = Math.PI / 2;
    addP(new THREE.CylinderGeometry(0.16, 0.16, 0.22, 10), steel, 0, 0.62, 1.25).rotation.x = Math.PI / 2;
    g.add(pivot); g.userData.pivot = pivot;
  } else if (type === 'tesla') {
    // tall coil mast crowned with a glowing electrode orb
    add(roundedSlabGeo(0.9, 0.9, 0.3), concrete, 0, 0.15, 0);
    add(new THREE.CylinderGeometry(0.13, 0.2, 1.45, 10), steel, 0, 0.95, 0);
    for (let i = 0; i < 3; i++)
      add(new THREE.TorusGeometry(0.16 + i * 0.03, 0.04, 8, 16), darkM, 0, 1.0 + i * 0.16, 0).rotation.x = Math.PI / 2;
    add(new THREE.SphereGeometry(0.28, 16, 12), mat(0x9fd8ff, 0.25, 0.6), 0, 1.78, 0);
    add(new THREE.ConeGeometry(0.05, 0.22, 6), steel, 0, 2.05, 0);
    add(roundedSlabGeo(0.78, 0.16, 0.05, 0.05), team, 0, 0.32, -0.42);
  } else if (type === 'irondome') {
    // angled multi-tube interceptor launcher + flat AESA radar panel
    add(roundedSlabGeo(1.85, 1.85, 0.35), concrete);
    add(new THREE.BoxGeometry(1.05, 0.45, 0.85), mat(0x7d8489), 0, 0.5, 0.1);
    const rack = add(new THREE.BoxGeometry(0.95, 0.5, 0.7), darkM, 0, 0.78, 0.05);
    rack.rotation.x = -0.5;
    for (const tx of [-0.3, 0, 0.3]) {
      const tube = add(new THREE.CylinderGeometry(0.07, 0.07, 0.6, 8), steel, tx, 0.95, 0.1);
      tube.rotation.x = -0.5 + Math.PI / 2;
      const tip = add(new THREE.ConeGeometry(0.06, 0.16, 6), mat(0x9a3030), tx, 1.18, 0.35);
      tip.rotation.x = -0.5 + Math.PI / 2;
    }
    const panel = add(new THREE.BoxGeometry(0.55, 0.6, 0.07), mat(0x6b86a8, 0.3, 0.45), -0.62, 0.82, -0.55);
    panel.rotation.y = 0.5;
    add(roundedSlabGeo(1.5, 0.18, 0.06, 0.06), team, 0, 0.42, -0.8);
  }
  return g;
}

// ---- legacy buildings (unused) ----
function buildingGroup(type: string, teamColor: number): THREE.Group {
  const g = new THREE.Group();
  const team = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.5, metalness: 0.25, map: detailTex() });
  const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.78, metalness: 0.08, map: detailTex() });
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true; mesh.receiveShadow = true;
    g.add(mesh); return mesh;
  };
  const concrete = mat(0x8a8f94), dark = mat(0x4a5055), roof = mat(0x5d6e54);
  if (type === 'conyard') {
    add(new THREE.BoxGeometry(2.7, 0.9, 2.7), concrete, 0, 0.45, 0);
    add(new THREE.BoxGeometry(0.4, 1.9, 0.4), dark, -0.9, 0.95, -0.9);
    add(new THREE.BoxGeometry(1.7, 0.16, 0.3), dark, 0, 1.85, -0.9);
    add(new THREE.BoxGeometry(2.2, 0.14, 2.2), team, 0, 0.97, 0.1);
    add(new THREE.SphereGeometry(0.34, 14, 10), mat(0xb8bdc2), 0.85, 1.05, 0.85); // radar dome
  } else if (type === 'power') {
    add(new THREE.BoxGeometry(1.8, 0.5, 1.8), concrete, 0, 0.25, 0);
    add(new THREE.CylinderGeometry(0.34, 0.42, 1.2, 10), mat(0xb8bdc2), -0.4, 1.0, 0);
    add(new THREE.CylinderGeometry(0.34, 0.42, 1.2, 10), mat(0xb8bdc2), 0.45, 1.0, 0.3);
    add(new THREE.BoxGeometry(1.8, 0.14, 0.4), team, 0, 0.57, 0.7);
  } else if (type === 'refinery') {
    add(new THREE.BoxGeometry(2.7, 0.6, 2.7), concrete, 0, 0.3, 0);
    add(new THREE.CylinderGeometry(0.62, 0.62, 1.4, 12), mat(0xb09a45), -0.7, 1.0, -0.6);
    add(new THREE.BoxGeometry(1.2, 0.8, 1.0), dark, 0.6, 0.9, -0.5);
    add(new THREE.BoxGeometry(1.8, 0.12, 1.1), team, 0, 0.66, 0.8);
    add(new THREE.CylinderGeometry(0.08, 0.08, 1.6, 6), dark, 1.1, 1.2, -1.0);
  } else if (type === 'barracks') {
    add(new THREE.BoxGeometry(1.8, 0.75, 1.8), mat(0x6e7a64), 0, 0.37, 0);
    add(new THREE.BoxGeometry(1.9, 0.3, 1.9), roof, 0, 0.85, 0);
    add(new THREE.BoxGeometry(0.5, 0.5, 0.1), dark, 0, 0.3, 0.92);
    add(new THREE.BoxGeometry(0.16, 1.2, 0.16), team, 0.75, 1.2, 0.75);
    add(new THREE.BoxGeometry(0.5, 0.3, 0.04), team, 1.05, 1.6, 0.75);
  } else if (type === 'factory') {
    add(new THREE.BoxGeometry(2.7, 1.4, 2.5), mat(0x7d8489), 0, 0.7, 0);
    add(new THREE.BoxGeometry(2.0, 1.0, 0.12), dark, 0, 0.55, 1.26);
    add(new THREE.BoxGeometry(2.7, 0.2, 2.5), team, 0, 1.5, 0);
    add(new THREE.CylinderGeometry(0.12, 0.12, 1.0, 6), dark, -1.0, 2.0, -0.9);
  } else if (type === 'turret') {
    add(new THREE.CylinderGeometry(0.48, 0.55, 0.35, 10), concrete, 0, 0.17, 0);
    add(new THREE.BoxGeometry(0.45, 0.3, 0.45), team, 0, 0.5, 0);
    add(new THREE.BoxGeometry(0.14, 0.14, 1.0), dark, 0, 0.55, 0.4);
  } else if (type === 'sam') {
    add(new THREE.CylinderGeometry(0.5, 0.58, 0.3, 10), concrete, 0, 0.15, 0);
    add(new THREE.BoxGeometry(0.4, 0.22, 0.4), team, 0, 0.4, 0);
    const rack1 = add(new THREE.BoxGeometry(0.22, 0.14, 0.85), dark, -0.14, 0.62, 0);
    rack1.rotation.x = -0.55;
    const rack2 = add(new THREE.BoxGeometry(0.22, 0.14, 0.85), dark, 0.14, 0.62, 0);
    rack2.rotation.x = -0.55;
  } else if (type === 'dronefac') {
    add(new THREE.BoxGeometry(1.8, 0.4, 1.8), concrete, 0, 0.2, 0);
    const padMesh = add(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 14), dark, 0.3, 0.43, 0.3);
    padMesh.receiveShadow = true;
    add(new THREE.BoxGeometry(0.5, 1.0, 0.5), mat(0x7d8489), -0.55, 0.9, -0.55);
    const dish = add(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 10), mat(0xb8bdc2), -0.55, 1.55, -0.55);
    dish.rotation.x = Math.PI / 4;
    add(new THREE.BoxGeometry(1.8, 0.12, 0.4), team, 0, 0.46, -0.7);
  }
  return g;
}

interface FxTracer { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; t: number }
interface FxPart { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; s: number }
interface FxRocket { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; t: number; delay: number; dur: number; arc: number }

// graphics quality presets. Everything renders at NATIVE resolution (pr 1.0) so
// the world is always crisp — earlier sub-native scaling looked blurry. The
// quality lever is now SHADOWS (the dominant GPU cost): Low turns them off for
// max FPS, Medium uses a 1024 shadow map, High a sharper 2048 one. `pr` is capped
// to the display's devicePixelRatio so a hi-DPI panel isn't wastefully supersampled.
// `groundTex` is the target width (texels) of the one-time baked ground colour map
// across the WHOLE map — higher = crisper ground when zoomed in. It's a one-time
// bake (no per-frame cost), so only memory + load time scale with it; Low stays
// modest for old hardware, High goes much sharper.
export const GFX_QUALITY: Record<string, { pr: number; shadows: boolean; shadowSize: number; groundTex: number }> = {
  low:    { pr: 1.0, shadows: false, shadowSize: 1024, groundTex: 1024 }, // crisp, no shadows — max FPS
  medium: { pr: 1.0, shadows: true,  shadowSize: 1024, groundTex: 2048 }, // crisp + shadows
  high:   { pr: 1.0, shadows: true,  shadowSize: 2048, groundTex: 3072 }, // crisp + sharper shadows + sharp ground
};
export function gfxQuality(): string {
  try { return safeLS.getItem('fe_quality') || 'medium'; } catch { return 'medium'; }
}

export class Renderer {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  three: THREE.WebGLRenderer;
  sun!: THREE.DirectionalLight;
  map: GameMap;

  camX = 48; camZ = 48; yaw = 0; dist = 28; // yaw 0: view matches the minimap exactly

  // per unit type: list of instanced parts; mode 0 = neutral, 1 = full team
  // color (procedural accents), 2 = subtle team tint (external models)
  private unitParts: Record<string, { mesh: THREE.InstancedMesh; mode: number }[]> = {};
  private buildings = new Map<number, { g: THREE.Group; type: string; aim?: number; owner?: number }>();
  private facing = new Map<number, { a: number; lx: number; lz: number }>();
  private selRing: THREE.InstancedMesh;
  private oreMesh: THREE.InstancedMesh;
  private gemMesh!: THREE.InstancedMesh;
  private oilMesh!: THREE.InstancedMesh;
  private roadMesh!: THREE.InstancedMesh;
  private ghost: THREE.Mesh;
  private tracerGeo: THREE.BufferGeometry;
  private tracerPos: Float32Array;
  private tracers: FxTracer[] = [];
  private partMesh: THREE.InstancedMesh;
  private parts: FxPart[] = [];
  private healMesh!: THREE.InstancedMesh;
  private healParts: FxPart[] = [];
  private rocketMesh!: THREE.InstancedMesh;
  private rockets: FxRocket[] = [];
  private smokeMesh!: THREE.InstancedMesh;
  private smokeParts: FxPart[] = [];
  private satLaunches: { g: THREE.Group; t: number; x: number; z: number; y0: number }[] = [];
  private terrain: THREE.Mesh;
  private terraPrev!: THREE.Mesh;
  private waterMat: THREE.MeshPhongMaterial;
  private rallyFlag!: THREE.Group;
  private rallyPennant!: THREE.Mesh;
  private rallyLine!: THREE.Line;
  private rallyLinePos!: Float32Array;
  private formLine!: THREE.Line;
  private formPos!: Float32Array;
  private dummy = new THREE.Object3D();
  private colTmp = new THREE.Color();
  private vTmp = new THREE.Vector3();
  private rotorMesh!: THREE.InstancedMesh;
  private sandbagMesh!: THREE.InstancedMesh;
  private radarDishMesh!: THREE.InstancedMesh;
  // baked skeletal poses for infantry: [aim, runFrame1..N] — instances are
  // written into the pose set matching their state each frame
  private posedParts: Record<string, { mesh: THREE.InstancedMesh; mode: number }[][]> = {};
  private poseCounts: Record<string, number[]> = {};
  private qTmp = new THREE.Quaternion();
  private qTmp2 = new THREE.Quaternion();
  private eTmp = new THREE.Euler();
  private modelDims: Record<string, { h: number; len: number }> = {};
  private time = 0;
  private terrainShader: any = null;
  private extTex: Record<string, THREE.Texture> = {};
  private factoryProto: THREE.Group | null = null; // War Factory GLB (poly.pizza), cloned per building
  private factoryTop = 2.6;                         // scaled model height (team band sits here)
  private bldgProtos: Record<string, THREE.Group> = {}; // other GLB building models, cloned per building
  private cruiseY = 12; // constant flight altitude (set from the map's tallest terrain in buildTerrain)
  private rampAnim = new Map<number, number>();     // unit id → seconds left of the "drive down the ramp" descent
  private prevVeh = new Set<number>();              // ground-vehicle ids seen last frame (to detect freshly-built ones)
  private fogTex: THREE.DataTexture | null = null;
  private fogMesh: THREE.Mesh | null = null;
  private fogGeo: THREE.PlaneGeometry | null = null;
  private treeTrunks: THREE.InstancedMesh | null = null;
  private treeLeaves: THREE.InstancedMesh | null = null;
  private treeBaseMat: Float32Array | null = null;
  private treeN = 0;
  gpuName = 'unknown';

  constructor(canvas: HTMLCanvasElement, map: GameMap) {
    this.map = map;
    // request the discrete GPU: on dual-GPU laptops the browser defaults to
    // the integrated chip unless WebGL explicitly asks for high performance
    this.three = new THREE.WebGLRenderer({ canvas, antialias: gfxQuality() !== 'low', powerPreference: 'high-performance' });
    // report the active GPU (so you can confirm the discrete card is in use)
    try {
      const gl = this.three.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
      console.log('[Ali\'s Earth] GPU in use:', this.gpuName);
    } catch { this.gpuName = 'unknown'; }
    const q = GFX_QUALITY[gfxQuality()] || GFX_QUALITY.medium;
    this.three.setPixelRatio(Math.min(q.pr, window.devicePixelRatio));
    this.three.shadowMap.enabled = q.shadows;
    this.three.shadowMap.type = THREE.PCFShadowMap; // cheaper than PCFSoft
    // Shadows refresh EVERY frame (the default). The previous every-3rd-frame
    // throttle left moving units' shadows trailing behind them and made units
    // flicker dark as they crossed their own stale shadow. Per-frame cost is kept
    // down instead by NOT casting from the heavy/static clutter (trees, ore) —
    // only units and buildings cast (see the cast-shadow assignments below).
    this.three.shadowMap.autoUpdate = true;
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.toneMappingExposure = 1.15;
    const maxAniso = Math.min(8, this.three.capabilities.getMaxAnisotropy());

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.5, 500);

    // image-based ambient for PBR materials
    const pmrem = new THREE.PMREMGenerator(this.three);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    (this.scene as any).environmentIntensity = 0.45;
    pmrem.dispose();

    this.scene.fog = new THREE.FogExp2(0xb9cbdc, 0.0036);

    // gradient sky dome
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(230, 24, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: {
          top: { value: new THREE.Color(0x3f6ca8) },
          mid: { value: new THREE.Color(0x87add2) },
          bot: { value: new THREE.Color(0xc9d9e6) },
        },
        vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `varying vec3 vP; uniform vec3 top, mid, bot;
          void main(){
            float t = normalize(vP).y;
            vec3 c = t > 0.22 ? mix(mid, top, smoothstep(0.22, 0.85, t)) : mix(bot, mid, smoothstep(-0.04, 0.22, t));
            gl_FragColor = vec4(c, 1.0);
          }`,
      })
    );
    dome.position.set(W / 2, 0, H / 2);
    dome.frustumCulled = false;
    this.scene.add(dome);

    // lights
    const hemi = new THREE.HemisphereLight(0xbdd7f2, 0x6a5a42, 0.75);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffe7c4, 2.2);
    this.sun = sun;
    sun.position.set(W / 2 + 40, 85, H / 2 - 25);
    sun.target.position.set(W / 2, 0, H / 2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -75; sc.right = 75; sc.top = 75; sc.bottom = -75; sc.far = 250;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun, sun.target);

    this.terrain = this.buildTerrain(maxAniso);
    this.scene.add(this.terrain);
    this.loadTerrainTextures(maxAniso); // CC0 photo textures; procedural fallback
    this.buildTrees();
    this.buildCity();
    this.buildFog();

    // water: animated normal-mapped surface
    this.waterMat = new THREE.MeshPhongMaterial({
      color: 0x1e4d6b, specular: 0x9db8cc, shininess: 90,
      transparent: true, opacity: 0.92,
      normalMap: waterNormalTexture(maxAniso),
      normalScale: new THREE.Vector2(0.32, 0.32),
    });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(W * 3, H * 3), this.waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(W / 2, SEA, H / 2);
    this.scene.add(water);

    // translucent box that previews a pending terraform area + its target height
    this.terraPrev = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      // depthTest off + high renderOrder so the bulldozer's area preview stays
      // visible even when it sits below the (semi-opaque) water surface
      new THREE.MeshBasicMaterial({ color: 0x57d977, transparent: true, opacity: 0.34, depthWrite: false, depthTest: false }),
    );
    this.terraPrev.renderOrder = 6;
    this.terraPrev.visible = false;
    this.scene.add(this.terraPrev);

    // ore
    const oreGeo = new THREE.OctahedronGeometry(0.34);
    this.oreMesh = new THREE.InstancedMesh(
      oreGeo,
      new THREE.MeshStandardMaterial({ color: 0xe0ad28, roughness: 0.35, metalness: 0.55, emissive: 0x4a3300, emissiveIntensity: 0.35 }),
      2048
    );
    this.oreMesh.frustumCulled = false;
    this.oreMesh.castShadow = false; // ground clutter — kept out of the shadow pass
    this.scene.add(this.oreMesh);

    // roads: flat paved tiles laid by engineers (extend build reach)
    const roadGeo = new THREE.PlaneGeometry(1.04, 1.04);
    roadGeo.rotateX(-Math.PI / 2);
    this.roadMesh = new THREE.InstancedMesh(
      roadGeo,
      new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.95, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -1 }),
      4096
    );
    this.roadMesh.frustumCulled = false;
    this.roadMesh.receiveShadow = true;
    this.roadMesh.count = 0;
    this.scene.add(this.roadMesh);

    // special crystal ore: taller cyan shards, glowing
    const gemGeo = new THREE.OctahedronGeometry(0.3);
    gemGeo.scale(0.8, 1.9, 0.8);
    this.gemMesh = new THREE.InstancedMesh(
      gemGeo,
      new THREE.MeshStandardMaterial({ color: 0x47e8e0, roughness: 0.2, metalness: 0.3, emissive: 0x0a5a56, emissiveIntensity: 0.8 }),
      512
    );
    this.gemMesh.frustumCulled = false;
    this.gemMesh.castShadow = false; // ground clutter — kept out of the shadow pass
    this.scene.add(this.gemMesh);

    // oil wells: an oil-pump model (poly.pizza, CC-BY) swapped in async; until it
    // loads, a stubby derrick marker stands in. Base sits at y=0 so it rests on the
    // ground (offshore wells on the sea surface).
    const oilGeo = new THREE.CylinderGeometry(0.16, 0.34, 1.1, 6);
    oilGeo.translate(0, 0.55, 0);
    this.oilMesh = new THREE.InstancedMesh(
      oilGeo,
      new THREE.MeshStandardMaterial({ color: 0x46474d, roughness: 0.55, metalness: 0.55 }),
      1024
    );
    this.oilMesh.frustumCulled = false;
    this.oilMesh.castShadow = false; // ground clutter — kept out of the shadow pass
    this.scene.add(this.oilMesh);
    this.loadOilModel();
    this.loadFactoryModel();
    this.loadBuildingModel('power', 'power', 2.4);        // Power Plant GLB ("Factory" by ZONK44, CGTrader)
    this.loadBuildingModel('refinery', 'refinery', 8.72); // Ore Refinery GLB (Sketchfab, CC-BY)
    this.loadBuildingModel('airfield', 'airfield', 4.73);  // Airfield GLB (C&C-style building, Sketchfab, CC-BY)
    // Oil Rig reuses the oil-well "Oil Pump" model, 25% taller than the free well
    // (well is normalised to 2.0 tall in loadOilModel) so building one just enlarges it
    this.loadBuildingModel('oilrig', 'oilfield', 2.5, true);

    // unit instancing: procedural models first, external GLBs swap in async
    for (const t of ['rifle', 'rocket', 'melody', 'tank', 'heavy', 'harv', 'engineer', 'recon', 'strike', 'msldrone', 'mlrs',
      'gunboat', 'destroyer', 'sub', 'navdrone', 'fighter', 'bomber', 'dbomber', 'heli', 'helidrone',
      'hive', 'minidrone', 'melodydrone', 'chemtrooper', 'chemtank', 'chemdrone', 'biotrooper', 'biotank', 'biodrone', 'stealthtank',
      'tews', 'transport', 'navengineer', 'mortar', 'mortartrack', 'fieldgun', 'artillery', 'artyship', 'airtransport']) {
      const [body, accent] = unitGeoSmooth(t);
      const bm = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ vertexColors: true, map: armorTex(), roughness: 0.72, metalness: 0.2 }), MAX_INST);
      const am = new THREE.InstancedMesh(accent, new THREE.MeshStandardMaterial({ color: 0xffffff, map: detailTex(), roughness: 0.5, metalness: 0.25 }), MAX_INST);
      for (const m of [bm, am]) {
        m.frustumCulled = false; m.castShadow = true; m.count = 0;
        this.scene.add(m);
      }
      this.unitParts[t] = [{ mesh: bm, mode: 0 }, { mesh: am, mode: 1 }];
    }
    this.loadUnitModels();

    // selection rings
    const ring = new THREE.RingGeometry(0.5, 0.66, 24);
    ring.rotateX(-Math.PI / 2);
    this.selRing = new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial({ color: 0x6aff6a, transparent: true, opacity: 0.85, depthWrite: false }), MAX_INST);
    this.selRing.frustumCulled = false;
    this.scene.add(this.selRing);

    // ghost
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 0.8, 1), new THREE.MeshBasicMaterial({ color: 0x57d977, transparent: true, opacity: 0.4, depthWrite: false }));
    this.ghost.visible = false;
    this.scene.add(this.ghost);

    // rally point marker: flag pole + team pennant + line from the building
    this.rallyFlag = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 1.15, 5),
      new THREE.MeshBasicMaterial({ color: 0xe8e8e8 })
    );
    pole.position.y = 0.57;
    this.rallyFlag.add(pole);
    const penGeo = new THREE.BufferGeometry();
    penGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 1.12, 0, 0.5, 0.99, 0, 0, 0.86, 0,
    ]), 3));
    this.rallyPennant = new THREE.Mesh(penGeo, new THREE.MeshBasicMaterial({ color: 0x6aff6a, side: THREE.DoubleSide }));
    this.rallyFlag.add(this.rallyPennant);
    this.rallyFlag.visible = false;
    this.scene.add(this.rallyFlag);
    this.rallyLinePos = new Float32Array(6);
    const rlGeo = new THREE.BufferGeometry();
    rlGeo.setAttribute('position', new THREE.BufferAttribute(this.rallyLinePos, 3));
    this.rallyLine = new THREE.Line(rlGeo, new THREE.LineBasicMaterial({ color: 0x6aff6a, transparent: true, opacity: 0.45, depthWrite: false }));
    this.rallyLine.frustumCulled = false;
    this.rallyLine.visible = false;
    this.scene.add(this.rallyLine);

    // formation drawing line (right-drag with units selected)
    this.formPos = new Float32Array(128 * 3);
    const fGeo = new THREE.BufferGeometry();
    fGeo.setAttribute('position', new THREE.BufferAttribute(this.formPos, 3));
    this.formLine = new THREE.Line(fGeo, new THREE.LineBasicMaterial({ color: 0x5ab8ff, transparent: true, opacity: 0.9, depthWrite: false }));
    this.formLine.frustumCulled = false;
    this.formLine.visible = false;
    this.scene.add(this.formLine);

    // tracers
    this.tracerPos = new Float32Array(MAX_TRACER * 6);
    this.tracerGeo = new THREE.BufferGeometry();
    this.tracerGeo.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3));
    const tl = new THREE.LineSegments(this.tracerGeo, new THREE.LineBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    tl.frustumCulled = false;
    this.scene.add(tl);

    // particles
    this.partMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.09, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xff8030, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
      MAX_PART
    );
    this.partMesh.frustumCulled = false;
    this.partMesh.count = 0;
    this.scene.add(this.partMesh);

    // rocket projectiles (MLRS / missile drones): arcing flight with smoke trails
    const rGeo = new THREE.ConeGeometry(0.06, 0.28, 6);
    rGeo.rotateX(Math.PI / 2); // point along +Z, oriented per-frame via lookAt
    this.rocketMesh = new THREE.InstancedMesh(
      rGeo,
      new THREE.MeshBasicMaterial({ color: 0xffd080 }),
      64
    );
    this.rocketMesh.frustumCulled = false;
    this.rocketMesh.count = 0;
    this.scene.add(this.rocketMesh);
    this.smokeMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.08, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0x9aa0a4, transparent: true, opacity: 0.42, depthWrite: false }),
      400
    );
    this.smokeMesh.frustumCulled = false;
    this.smokeMesh.count = 0;
    this.scene.add(this.smokeMesh);

    // heal sparkles (green, drift upward)
    this.healMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.07, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0x4dff7a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      128
    );
    this.healMesh.frustumCulled = false;
    this.healMesh.count = 0;
    this.scene.add(this.healMesh);

    // spinning rotor blades: two crossed bars, unit diameter, scaled per type
    const blade1 = new THREE.BoxGeometry(1, 0.022, 0.055).toNonIndexed();
    const blade2 = new THREE.BoxGeometry(0.055, 0.022, 1).toNonIndexed();
    const hub = new THREE.CylinderGeometry(0.045, 0.045, 0.06, 6).toNonIndexed();
    this.rotorMesh = new THREE.InstancedMesh(
      mergeGeometries([blade1, blade2, hub])!,
      new THREE.MeshBasicMaterial({ color: 0x23282d, transparent: true, opacity: 0.8 }),
      MAX_INST
    );
    this.rotorMesh.frustumCulled = false;
    this.rotorMesh.count = 0;
    this.scene.add(this.rotorMesh);

    // sandbag ring for fortified infantry: a circle of stacked sandbag blocks
    const bags: THREE.BufferGeometry[] = [];
    const ringR = 0.62;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const lower = new THREE.BoxGeometry(0.26, 0.13, 0.18).toNonIndexed();
      lower.translate(Math.cos(a) * ringR, 0.07, Math.sin(a) * ringR);
      lower.rotateY(-a);
      bags.push(lower);
      if (i % 2 === 0) { // a sparse second course
        const up = new THREE.BoxGeometry(0.24, 0.12, 0.16).toNonIndexed();
        up.translate(Math.cos(a) * ringR, 0.2, Math.sin(a) * ringR);
        bags.push(up);
      }
    }
    this.sandbagMesh = new THREE.InstancedMesh(
      mergeGeometries(bags)!,
      new THREE.MeshStandardMaterial({ color: 0x9c8a5c, roughness: 0.95 }),
      MAX_INST
    );
    this.sandbagMesh.frustumCulled = false; this.sandbagMesh.castShadow = true; this.sandbagMesh.count = 0;
    this.scene.add(this.sandbagMesh);

    // small deployable radar dish shown over a fortified Patriot: mast + tilted dish
    const dishParts: THREE.BufferGeometry[] = [];
    const mast = new THREE.CylinderGeometry(0.045, 0.06, 0.6, 6).toNonIndexed(); mast.translate(0, 0.3, 0);
    dishParts.push(mast);
    const dish = new THREE.SphereGeometry(0.26, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.6).toNonIndexed();
    dish.scale(1, 0.45, 1); dish.rotateX(-Math.PI / 3); dish.translate(0, 0.66, 0.05);
    dishParts.push(dish);
    const horn = new THREE.CylinderGeometry(0.02, 0.02, 0.16, 5).toNonIndexed(); horn.rotateX(-Math.PI / 3); horn.translate(0, 0.7, 0.18);
    dishParts.push(horn);
    this.radarDishMesh = new THREE.InstancedMesh(
      mergeGeometries(dishParts)!,
      new THREE.MeshStandardMaterial({ color: 0xc4ccd2, roughness: 0.55, metalness: 0.35 }),
      MAX_INST
    );
    this.radarDishMesh.frustumCulled = false; this.radarDishMesh.castShadow = true; this.radarDishMesh.count = 0;
    this.scene.add(this.radarDishMesh);

    this.resize();
  }

  private buildTerrain(maxAniso: number): THREE.Mesh {
    // Mesh density: normal maps at sim-grid resolution (was 2x — the extra detail
    // wasn't visible but quadrupled the triangle count). Flat maps (Flat City /
    // Steel Arena) have edge-to-edge constant height with no river or mountains,
    // so a quarter-resolution mesh is indistinguishable and far cheaper.
    const flatPath = this.map.noTerrainDetail;
    const segX = flatPath ? Math.max(8, W >> 2) : W;
    const segZ = flatPath ? Math.max(8, H >> 2) : H;
    const geo = new THREE.PlaneGeometry(W, H, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate(W / 2, 0, H / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    let maxH = SEA;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = this.map.heightAt(x, z);
      pos.setY(i, h);
      if (h > maxH) maxH = h;
      uv.setXY(i, x / W, z / H); // sample the baked ground map by world position
    }
    // aircraft cruise at a constant altitude above the TALLEST terrain, so they
    // fly level instead of dipping into valleys (per-unit alt added on top)
    this.cruiseY = maxH + 1.5;
    uv.needsUpdate = true;
    geo.computeVertexNormals();

    // Metal Plain: ONE flat-shaded metallic-grey slab — no splat shader, no
    // textures (the cheapest possible ground). Lambert shading still gives the
    // slab subtle light/shadow depth, but it stays a single colour.
    if (this.map.metal) {
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x8d9298 }));
      mesh.receiveShadow = true;
      return mesh;
    }

    // Pre-baked ground: the four splat layers are composited into ONE map texture
    // at load (see bakeGround), so the terrain renders with a plain material —
    // one texture fetch, no per-frame splat blend. (Sampled at uv 0..1, so it also
    // avoids the large-tiled-UV mip bug that blanked terrain on some Adreno GPUs.)
    const mat = new THREE.MeshLambertMaterial({ map: this.bakeGround() });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  // Bake the grass/rock/sand/dirt layers into a single map texture, blended by the
  // same per-cell splat weights the shader used. Runs once at map load; the result
  // is a normal mipmapped texture the terrain mesh samples by world-uv.
  private bakeGround(): THREE.Texture {
    // texels per cell — the bake spans `groundTex` texels across the whole map at
    // the current quality (Low ~1024, High ~3072). One-time cost, so a higher tier
    // just buys a crisper ground without any per-frame penalty.
    const budget = GFX_QUALITY[gfxQuality()]?.groundTex || 1024;
    const S = Math.max(5, Math.floor(budget / Math.max(W, H)));
    const NW = W * S, NH = H * S;
    // per-cell splat weights (identical formula to the old vertex splat)
    const wt = new Float32Array(W * H * 4);
    for (let cz = 0; cz < H; cz++) for (let cx = 0; cx < W; cx++) {
      const x = cx + 0.5, z = cz + 0.5, h = this.map.heightAt(x, z), e = 0.5;
      const gx = this.map.heightAt(x + e, z) - this.map.heightAt(x - e, z);
      const gz = this.map.heightAt(x, z + e) - this.map.heightAt(x, z - e);
      const slope = Math.hypot(gx, gz);
      const sand = 1 - sstep(SEA + 0.12, SEA + 0.55, h);
      const rock = Math.min(1, sstep(0.85, 1.5, slope) + sstep(6.6, 7.8, h));
      const dirt = sstep(0.56, 0.70, fbm(12345, x * 0.09, z * 0.09)) * 0.85 * (1 - sand) * (1 - rock);
      const grass = Math.max(0, 1 - sand - rock - dirt);
      const s = sand + rock + dirt + grass || 1, o = (cz * W + cx) * 4;
      wt[o] = grass / s; wt[o + 1] = rock / s; wt[o + 2] = sand / s; wt[o + 3] = dirt / s;
    }
    // source layer pixels (procedural textures; always available synchronously)
    const grab = (k: string) => { const cv = groundTexture(k, 1).image as HTMLCanvasElement; return cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data; };
    const G = grab('grass'), R = grab('rock'), Sd = grab('sand'), D = grab('dirt'), TS = 256;
    const tx = (u: number) => (((Math.floor(u * TS) % TS) + TS) % TS); // tiled texel coord
    // hoist the per-column tiling indices + cell interpolation out of the inner loop
    const colGx = new Int32Array(NW), colRx = new Int32Array(NW), colDx = new Int32Array(NW);
    const colX0 = new Int32Array(NW), colX1 = new Int32Array(NW), colFx = new Float32Array(NW);
    for (let px = 0; px < NW; px++) {
      const x = (px / NW) * W, u = x * 0.42;
      colGx[px] = tx(u); colRx[px] = tx(u * 0.55); colDx[px] = tx(u * 0.8);
      const cx = Math.max(0, Math.min(W - 1.001, x - 0.5)), x0 = Math.floor(cx);
      colX0[px] = x0; colX1[px] = Math.min(W - 1, x0 + 1); colFx[px] = cx - x0;
    }
    const cv = document.createElement('canvas'); cv.width = NW; cv.height = NH;
    const img = cv.getContext('2d')!.createImageData(NW, NH), d = img.data;
    for (let py = 0; py < NH; py++) {
      const z = (py / NH) * H, v = z * 0.42;
      const rowG = tx(v) * TS, rowR = tx(v * 0.55) * TS, rowD = tx(v * 0.8) * TS; // sand shares grass scale
      const cz = Math.max(0, Math.min(H - 1.001, z - 0.5)), z0 = Math.floor(cz), z1 = Math.min(H - 1, z0 + 1), fz = cz - z0;
      const r0 = z0 * W, r1 = z1 * W;
      let o = py * NW * 4;
      for (let px = 0; px < NW; px++ , o += 4) {
        const x0 = colX0[px], x1 = colX1[px], fx = colFx[px];
        const o00 = (r0 + x0) * 4, o10 = (r0 + x1) * 4, o01 = (r1 + x0) * 4, o11 = (r1 + x1) * 4;
        const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
        const gw = wt[o00] * w00 + wt[o10] * w10 + wt[o01] * w01 + wt[o11] * w11;
        const rw = wt[o00 + 1] * w00 + wt[o10 + 1] * w10 + wt[o01 + 1] * w01 + wt[o11 + 1] * w11;
        const sw = wt[o00 + 2] * w00 + wt[o10 + 2] * w10 + wt[o01 + 2] * w01 + wt[o11 + 2] * w11;
        const dw = wt[o00 + 3] * w00 + wt[o10 + 3] * w10 + wt[o01 + 3] * w01 + wt[o11 + 3] * w11;
        const iG = (rowG + colGx[px]) * 4, iR = (rowR + colRx[px]) * 4, iS = (rowG + colGx[px]) * 4, iD = (rowD + colDx[px]) * 4;
        d[o]     = (G[iG] * gw + R[iR] * rw + Sd[iS] * sw + D[iD] * dw) | 0;
        d[o + 1] = (G[iG + 1] * gw + R[iR + 1] * rw + Sd[iS + 1] * sw + D[iD + 1] * dw) | 0;
        d[o + 2] = (G[iG + 2] * gw + R[iR + 2] * rw + Sd[iS + 2] * sw + D[iD + 2] * dw) | 0;
        d[o + 3] = 255;
      }
    }
    cv.getContext('2d')!.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.flipY = false;                       // row py == world z (matches the world-uv we set)
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    // anisotropy keeps the (now higher-res) ground sharp at grazing angles — the
    // exact case where the baked map looked blurry before. Clamped to GPU max.
    tex.anisotropy = Math.min(8, this.three.capabilities.getMaxAnisotropy());
    return tex;
  }

  // show/hide the terraform preview box over a rectangle, filling from the area's
  // base level up (or down) to the chosen target height
  setTerraPreview(r: { x0: number; z0: number; x1: number; z1: number; h: number; base: number } | null) {
    if (!r) { this.terraPrev.visible = false; return; }
    const minX = Math.min(r.x0, r.x1), maxX = Math.max(r.x0, r.x1);
    const minZ = Math.min(r.z0, r.z1), maxZ = Math.max(r.z0, r.z1);
    const lo = Math.min(r.base, r.h), hi = Math.max(r.base, r.h);
    this.terraPrev.position.set((minX + maxX) / 2, (lo + hi) / 2, (minZ + maxZ) / 2);
    this.terraPrev.scale.set(Math.max(1, maxX - minX), Math.max(0.3, hi - lo), Math.max(1, maxZ - minZ));
    // green cube rising ABOVE the ground when raising, red cube BELOW when lowering
    (this.terraPrev.material as THREE.MeshBasicMaterial).color.setHex(r.h >= r.base ? 0x4ade6a : 0xff4040);
    this.terraPrev.visible = true;
  }

  // 1 if this world position sits on a terraformed (concrete) cell
  private terraAt(x: number, z: number): number {
    const cx = Math.floor(x), cz = Math.floor(z);
    return (cx >= 0 && cz >= 0 && cx < W && cz < H && this.map.terraMask[cz * W + cx]) ? 1 : 0;
  }

  // re-read the heightfield into the terrain mesh after terraforming edits it.
  // The ground COLOUR is baked once (bakeGround), so only the heightfield/normals
  // are refreshed here — reshaped ground keeps its original ground colour.
  refreshTerrain() {
    const geo = this.terrain.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    // only recompute the terraformed region (with a margin for slope/normals) —
    // rebuilding every vertex each frame is what made bulldozing lag
    const m = this.map as any;
    const partial = m.hdMaxX >= m.hdMinX;
    const minX = partial ? m.hdMinX - 2 : -1e9, maxX = partial ? m.hdMaxX + 2 : 1e9;
    const minZ = partial ? m.hdMinZ - 2 : -1e9, maxZ = partial ? m.hdMaxZ + 2 : 1e9;
    m.hdMinX = 1e9; m.hdMinZ = 1e9; m.hdMaxX = -1e9; m.hdMaxZ = -1e9; // consume the box
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      pos.setY(i, this.map.heightAt(x, z));
    }
    pos.needsUpdate = true;
    if (this.fogGeo) this.drapeFog(this.fogGeo); // keep the fog hugging the reshaped ground
    geo.computeVertexNormals();
  }

  // Swap in CC0 photo textures (Poly Haven) when available; the procedural
  // canvas textures remain as instant placeholders and offline fallback.
  private loadTerrainTextures(maxAniso: number) {
    const loader = new THREE.TextureLoader();
    for (const name of ['grass', 'rock', 'sand', 'dirt']) {
      loader.load('./textures/' + name + '.jpg', t => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = maxAniso;
        this.extTex[name] = t;
        if (this.terrainShader) {
          const key = 't' + name[0].toUpperCase() + name.slice(1);
          this.terrainShader.uniforms[key].value = t;
        }
      }, undefined, () => { /* file missing — keep procedural texture */ });
    }
    // building + unit detail maps: swap the photo INTO the shared singleton
    // textures so every existing and future material picks it up automatically
    const img = new THREE.ImageLoader();
    img.load('./textures/concrete.jpg', im => {
      const t = detailTex();
      t.image = im;
      t.repeat.set(1.5, 1.5);
      t.needsUpdate = true;
    }, undefined, () => {});
    img.load('./textures/metal.jpg', im => {
      const t = armorTex();
      t.image = im;
      t.repeat.set(1.5, 1.5);
      t.needsUpdate = true;
    }, undefined, () => {});
  }

  // Load external GLB unit models and swap them into the instanced pipeline.
  // Each model is baked to one merged geometry per material (keeps textures),
  // normalized to footprint size, grounded at y=0, facing +Z.
  private loadUnitModels() {
    const byFile = new Map<string, string[]>();
    for (const t in MODEL_DEFS) {
      const f = MODEL_DEFS[t].file;
      byFile.set(f, [...(byFile.get(f) || []), t]);
    }
    for (const [file, types] of byFile) {
      loadGLB(file).then(gltf => {
        for (const t of types) {
          try { this.applyModel(t, gltf); } catch { /* keep procedural */ }
        }
      }).catch(() => { /* missing model — keep procedural */ });
    }
  }

  // Oil-well model (poly.pizza "Oil pump", CC-BY). Merge all its meshes into one
  // geometry, normalise it (centre horizontally, base at y=0, fixed height) and
  // swap it into the instanced oil-well mesh. Few wells per map, so one shared
  // colour is fine; the shape is what matters. Falls back to the derrick marker.
  // War Factory model (poly.pizza "Factory", CC-BY). Loaded once, normalised
  // (centred, base at y=0, scaled to the 3-cell footprint), the ramp oriented to
  // +Z — the side new vehicles exit from. Cloned per factory in makeBuildingGroup.
  private loadFactoryModel() {
    loadGLB('factory').then(gltf => {
      const src = gltf.scene.clone(true); src.updateMatrixWorld(true); // clone: we mutate transforms
      const box = new THREE.Box3().setFromObject(src);
      const size = new THREE.Vector3(); box.getSize(size);
      const ctr = new THREE.Vector3(); box.getCenter(ctr);
      // auto-orient: the exit ramp slopes to the ground, so it adds the most LOW
      // geometry on one side — rotate (snapped to 90°) so that side faces +Z, the
      // direction new vehicles drive out. FACTORY_RY nudges it if the guess is off.
      let cxs = 0, czs = 0, n = 0; const yLow = box.min.y + size.y * 0.3, vtmp = new THREE.Vector3();
      src.traverse(o => {
        const m = o as any; if (!m.isMesh) return;
        const p = m.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i++) { vtmp.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); if (vtmp.y < yLow) { cxs += vtmp.x; czs += vtmp.z; n++; } }
      });
      let ry = FACTORY_RY;
      if (n > 0) { const ox = cxs / n - ctr.x, oz = czs / n - ctr.z; if (Math.hypot(ox, oz) > size.x * 0.04) ry += -Math.round(Math.atan2(ox, oz) / (Math.PI / 2)) * (Math.PI / 2); }
      const s = 3.1 / Math.max(0.001, Math.max(size.x, size.z)); // fill the size-3 footprint
      src.position.set(-ctr.x, -box.min.y, -ctr.z);              // centre x/z, base at y=0
      src.traverse(o => { const m = o as any; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      const inner = new THREE.Group(); inner.add(src); inner.scale.setScalar(s);
      const proto = new THREE.Group(); proto.add(inner);
      proto.rotation.y = ry;                                      // ramp → +Z
      this.factoryProto = proto;
      this.factoryTop = size.y * s;
      this.refreshBuildingModel('factory'); // swap any factory placed before the GLB loaded
    }).catch(() => { /* missing model — keep the procedural factory */ });
  }

  // Load a GLB building model once: normalise it (centre x/z, base at y=0, scale to
  // its cell footprint) and cache a prototype cloned per building in makeBuildingGroup.
  private loadBuildingModel(type: string, file: string, target: number, byHeight = false) {
    loadGLB(file).then(gltf => {
      const src = gltf.scene.clone(true); src.updateMatrixWorld(true); // clone: we mutate transforms
      const box = new THREE.Box3().setFromObject(src);
      const size = new THREE.Vector3(); box.getSize(size);
      const ctr = new THREE.Vector3(); box.getCenter(ctr);
      // normalise to a target footprint (max x/z) or, for byHeight, a target height
      const s = target / Math.max(0.001, byHeight ? size.y : Math.max(size.x, size.z));
      src.position.set(-ctr.x, -box.min.y, -ctr.z);
      src.traverse(o => { const m = o as any; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      const inner = new THREE.Group(); inner.add(src); inner.scale.setScalar(s);
      const proto = new THREE.Group(); proto.add(inner);
      this.bldgProtos[type] = proto;
      this.refreshBuildingModel(type); // swap any already-placed buildings (e.g. the starting refinery)
    }).catch(() => { /* missing model — keep the procedural building */ });
  }

  // a GLB building model loads async — after game start for the pre-placed base.
  // Drop existing render groups of that type so updateViews rebuilds them with the
  // now-loaded model (the construction-progress scale is reapplied each frame).
  private refreshBuildingModel(type: string) {
    for (const [id, rec] of this.buildings) {
      if (rec.type === type) { this.scene.remove(rec.g); this.buildings.delete(id); }
    }
  }

  // a building's render group: a GLB model once loaded, else the procedural one.
  private makeBuildingGroup(type: string, col: number): THREE.Group {
    // the GLB models speak for themselves; ownership reads via the selection ring,
    // minimap and HUD.
    if (type === 'factory' && this.factoryProto) return this.factoryProto.clone(true);
    if (this.bldgProtos[type]) return this.bldgProtos[type].clone(true);
    return buildingGroupPro(type, col);
  }

  private loadOilModel() {
    loadGLB('oilfield').then(gltf => {
      const geos: THREE.BufferGeometry[] = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse(o => {
        const m = o as any;
        if (!m.isMesh) return;
        let g = (m.geometry as THREE.BufferGeometry).clone();
        g.applyMatrix4(m.matrixWorld);
        if (g.index) g = g.toNonIndexed();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
        if (!g.getAttribute('normal')) g.computeVertexNormals();
        geos.push(g);
      });
      if (!geos.length) return;
      let merged: THREE.BufferGeometry | null = null;
      try { merged = mergeGeometries(geos); } catch { merged = null; }
      if (!merged) return;
      merged.computeBoundingBox();
      const bb = merged.boundingBox!;
      const sz = new THREE.Vector3(); bb.getSize(sz);
      const ctr = new THREE.Vector3(); bb.getCenter(ctr);
      const s = 2.0 / Math.max(0.001, sz.y);     // normalise to ~2 units tall
      merged.translate(-ctr.x, -bb.min.y, -ctr.z); // centre horizontally, base at y=0
      merged.scale(s, s, s);
      this.oilMesh.geometry.dispose();
      this.oilMesh.geometry = merged;
      this.map.oreDirty = true;                  // re-place the wells with the new model
    }).catch(() => { /* missing model — keep the procedural derrick */ });
  }

  // group world-baked geometry by material so each keeps its colour/texture.
  // SkinnedMeshes are baked at their CURRENT skeleton pose via boneTransform.
  private collectGeos(src: THREE.Object3D): Map<THREE.Material, THREE.BufferGeometry[]> {
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const v = new THREE.Vector3();
    src.traverse(o => {
      const m = o as any;
      if (!m.isMesh) return;
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
      let g = (m.geometry as THREE.BufferGeometry).clone();
      if (m.isSkinnedMesh) {
        const srcPos = (m.geometry as THREE.BufferGeometry).getAttribute('position');
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(srcPos as THREE.BufferAttribute, i);
          m.applyBoneTransform(i, v);      // skinned position, mesh-local
          v.applyMatrix4(m.matrixWorld);
          pos.setXYZ(i, v.x, v.y, v.z);
        }
        g.deleteAttribute('normal');       // stale after the pose bake
      } else {
        g.applyMatrix4(m.matrixWorld);
      }
      if (g.index) g = g.toNonIndexed();
      const keepUv = !!(mat as any).map;
      for (const key of Object.keys(g.attributes))
        if (key !== 'position' && key !== 'normal' && !(keepUv && key === 'uv')) g.deleteAttribute(key);
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      byMat.set(mat, [...(byMat.get(mat) || []), g]);
    });
    return byMat;
  }

  private applyModel(type: string, gltf: { scene: THREE.Object3D; animations?: THREE.AnimationClip[] }) {
    const def = MODEL_DEFS[type];
    const src = gltf.scene;
    src.updateMatrixWorld(true);

    // infantry with a rigged skeleton: bake static pose frames — an aiming
    // stance plus a run cycle — instead of the T-shaped bind pose
    const clips = gltf.animations || [];
    let hasSkin = false;
    src.traverse(o => { if ((o as any).isSkinnedMesh) hasSkin = true; });
    const poseSets: Map<THREE.Material, THREE.BufferGeometry[]>[] = [];
    if (def.axis === 'h' && hasSkin && clips.length) {
      const pick = (re: RegExp) => clips.find(a => re.test(a.name));
      // pose 0 = rest (weapon lowered), pose 1 = aim (only while firing), 2.. = run cycle
      const rest = pick(/Idle_Gun(?!_)/i) || pick(/Idle_Neutral/i) || pick(/Standing/i) || pick(/Idle/i) || clips[0];
      const aim = pick(/Idle_Gun_Shoot/i) || pick(/Idle_Gun_Pointing/i) || rest;
      const run = pick(/Run_Shoot/i) || pick(/\|Run$/) || pick(/Walk/i);
      const mixer = new THREE.AnimationMixer(src);
      const bakeAt = (clip: THREE.AnimationClip, t: number) => {
        mixer.stopAllAction();
        mixer.clipAction(clip).reset().play();
        mixer.setTime(Math.max(0.001, t));
        src.updateMatrixWorld(true);
        poseSets.push(this.collectGeos(src));
      };
      bakeAt(rest, rest.duration * 0.5);
      bakeAt(aim === rest ? rest : aim, aim.duration * 0.5);
      if (run) for (const f of [0, 0.25, 0.5, 0.75]) bakeAt(run, run.duration * f);
    } else {
      poseSets.push(this.collectGeos(src));
    }
    const byMat = poseSets[0];
    if (!byMat || !byMat.size) return;

    // overall bounds → normalize to footprint size and ground at y=0
    const box = new THREE.Box3();
    for (const geos of byMat.values()) for (const g of geos) { g.computeBoundingBox(); box.union(g.boundingBox!); }
    const sz = new THREE.Vector3(), ctr = new THREE.Vector3();
    box.getSize(sz); box.getCenter(ctr);
    const extent = def.axis === 'h' ? sz.y : Math.max(sz.x, sz.z);
    const scale = def.size / Math.max(0.001, extent);

    // deterministic orientation: align the model's forward (its narrower, pointy
    // end along the longer horizontal axis) to +Z, the game's facing-zero.
    let autoRy = 0;
    if (def.axis === 'l') {
      const lenX = sz.x >= sz.z;              // longer horizontal axis
      const lo = lenX ? box.min.x : box.min.z;
      const hi = lenX ? box.max.x : box.max.z;
      const span = hi - lo || 1;
      // perpendicular + vertical spread of the near-min vs near-max thirds.
      // widths must be measured as (max-min) extents — models are NOT centred
      // at the origin yet, so abs(coord) is meaningless here.
      let loPMin = Infinity, loPMax = -Infinity, hiPMin = Infinity, hiPMax = -Infinity;
      let loYMax = -Infinity, hiYMax = -Infinity;
      for (const geos of byMat.values()) for (const g of geos) {
        const pos = g.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          const a = lenX ? pos.getX(i) : pos.getZ(i);
          const perp = lenX ? pos.getZ(i) : pos.getX(i);
          const y = pos.getY(i);
          const f = (a - lo) / span;
          if (f < 0.34) {
            if (perp < loPMin) loPMin = perp;
            if (perp > loPMax) loPMax = perp;
            if (y > loYMax) loYMax = y;
          } else if (f > 0.66) {
            if (perp < hiPMin) hiPMin = perp;
            if (perp > hiPMax) hiPMax = perp;
            if (y > hiYMax) hiYMax = y;
          }
        }
      }
      const loW = loPMax - loPMin, hiW = hiPMax - hiPMin;
      // empirically (tank, heli, ships from poly.pizza) the FRONT third measures
      // wider — gun mantlets, canopies and flared bows beat the tapered sterns.
      // Near-equal widths (trucks) fall back to the taller end being the rear bed.
      let frontAtHigh: boolean;
      const wMin = Math.min(loW, hiW), wMax = Math.max(loW, hiW) || 1;
      if (wMin / wMax < 0.88) frontAtHigh = hiW > loW;
      else frontAtHigh = hiYMax < loYMax;
      if (lenX) autoRy = frontAtHigh ? -Math.PI / 2 : Math.PI / 2;
      else autoRy = frontAtHigh ? 0 : Math.PI;
    }
    const totalRy = autoRy + (def.ry || 0); // def.ry is a manual nudge if ever needed
    // post-rotation dims for rotor/prop placement (rotations are 90° multiples)
    const sR = Math.abs(Math.sin(totalRy)), cR = Math.abs(Math.cos(totalRy));
    this.modelDims[type] = { h: sz.y * scale, len: (cR * sz.z + sR * sz.x) * scale };

    // every pose shares pose-0's transform so frames don't pop or drift
    const allPoses: { mesh: THREE.InstancedMesh; mode: number }[][] = [];
    for (const set of poseSets) {
      const newParts: { mesh: THREE.InstancedMesh; mode: number }[] = [];
      for (const [mat, geos] of set) {
        let merged: THREE.BufferGeometry | null;
        try { merged = mergeGeometries(geos); } catch { merged = null; }
        if (!merged) continue;
        merged.translate(-ctr.x, -box.min.y, -ctr.z); // centre XZ, sit on ground
        merged.scale(scale, scale, scale);
        if (totalRy) merged.rotateY(totalRy);
        if (def.y) merged.translate(0, def.y, 0);
        const m0 = mat as THREE.MeshStandardMaterial;
        const mat2 = new THREE.MeshStandardMaterial({
          color: m0.color ? m0.color.clone() : new THREE.Color(0xcccccc),
          map: m0.map || null,
          roughness: m0.roughness ?? 0.7, metalness: m0.metalness ?? 0.1,
          vertexColors: !!merged.getAttribute('color'),
        });
        if (def.tint) mat2.color.lerp(new THREE.Color(def.tint), 0.6); // type identity
        const im = new THREE.InstancedMesh(merged, mat2, MAX_INST);
        im.frustumCulled = false; im.castShadow = true; im.count = 0;
        this.scene.add(im);
        newParts.push({ mesh: im, mode: 2 }); // 2 = subtle team tint
      }
      if (!newParts.length) return;
      allPoses.push(newParts);
    }
    // remove the procedural placeholder meshes for this type
    for (const p of this.unitParts[type] || []) this.scene.remove(p.mesh);
    for (const ps of this.posedParts[type] || []) for (const p of ps) this.scene.remove(p.mesh);
    this.unitParts[type] = allPoses[0];
    if (allPoses.length > 1) this.posedParts[type] = allPoses;
    else delete this.posedParts[type];
  }

  // fog of war: a terrain-HUGGING mesh (same heightfield as the ground, lifted
  // a hair) sampling a W×H mask texture — unseen = opaque dark, explored = dim,
  // visible = clear. Following the surface kills the parallax that made a
  // floating plane read as all-black. Hidden in spectator/replay modes.
  private buildFog() {
    const data = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) data[i * 4 + 3] = 235; // start fully fogged
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.flipY = false; // DataTexture row 0 = cz 0, matches mask index cz*W+cx
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
    this.fogTex = tex;

    // Match the terrain mesh density (was 2× the sim grid, which made the fog the
    // single heaviest mesh on the map). Normal maps drape at sim-grid resolution;
    // flat maps need no draping at all, so a coarse grid covers them just as well.
    const fSegX = this.map.noTerrainDetail ? Math.max(8, W >> 2) : W;
    const fSegZ = this.map.noTerrainDetail ? Math.max(8, H >> 2) : H;
    const geo = new THREE.PlaneGeometry(W, H, fSegX, fSegZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate(W / 2, 0, H / 2);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / W, pos.getZ(i) / H); // sample the mask by world cell
    uv.needsUpdate = true;
    this.fogGeo = geo;
    this.drapeFog(geo); // set vertex heights to hug the terrain

    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, color: 0x05080c, fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 4;
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.scene.add(mesh);
    this.fogMesh = mesh;
  }

  // lay the fog mesh vertices on the terrain surface (lifted a hair) so it hugs
  // cliffs and terraformed slopes. Re-run whenever the terrain height changes.
  private drapeFog(geo: THREE.PlaneGeometry) {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++)
      pos.setY(i, Math.max(this.map.heightAt(pos.getX(i), pos.getZ(i)), SEA) + 0.55);
    pos.needsUpdate = true;
  }

  // push the client's fog mask (0 unseen, 1 explored, 2 visible) to the texture
  setFog(mask: Uint8Array) {
    if (!this.fogTex || !this.fogMesh) return;
    this.fogMesh.visible = true;
    const d = this.fogTex.image.data as Uint8Array;
    for (let i = 0; i < W * H; i++) {
      const v = mask[i];
      d[i * 4 + 3] = v === 2 ? 0 : v === 1 ? 120 : 235;
    }
    this.fogTex.needsUpdate = true;
  }
  fogValue(cx: number, cz: number): number {
    if (!this.fogMesh || !this.fogMesh.visible || !this.fogTex) return 2;
    const d = this.fogTex.image.data as Uint8Array;
    const a = d[(cz * W + cx) * 4 + 3] ?? 0;
    return a === 0 ? 2 : a < 200 ? 1 : 0;
  }

  private buildTrees() {
    const cells: { x: number; z: number }[] = [];
    for (let cz = 0; cz < H; cz++)
      for (let cx = 0; cx < W; cx++)
        if (this.map.forest[cz * W + cx]) cells.push({ x: cx, z: cz });
    if (!cells.length) return;

    const trunkGeo = new THREE.CylinderGeometry(0.06, 0.11, 0.6, 5);
    trunkGeo.translate(0, 0.3, 0);
    const c1 = new THREE.ConeGeometry(0.5, 1.0, 7); c1.translate(0, 1.0, 0);
    const c2 = new THREE.ConeGeometry(0.34, 0.75, 7); c2.translate(0, 1.55, 0);
    const leafGeo = mergeGeometries([c1, c2]);

    const n = Math.min(4000, cells.length * 2);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5d4030, roughness: 0.9 }), n);
    const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }), n);
    let k = 0;
    const col = new THREE.Color();
    for (const c of cells) {
      for (let j = 0; j < 2 && k < n; j++) {
        const h1 = hash2(31 + j, c.x, c.z), h2 = hash2(77 + j, c.x, c.z), h3 = hash2(113 + j, c.x, c.z);
        const x = c.x + 0.2 + h1 * 0.6, z = c.z + 0.2 + h2 * 0.6;
        this.dummy.position.set(x, this.map.heightAt(x, z) - 0.05, z);
        this.dummy.rotation.set(0, h3 * 6.28, 0);
        this.dummy.scale.setScalar(0.8 + h3 * 0.7);
        this.dummy.updateMatrix();
        trunks.setMatrixAt(k, this.dummy.matrix);
        leaves.setMatrixAt(k, this.dummy.matrix);
        const palette = [0x2a4a21, 0x33591f, 0x254420, 0x3a652c, 0x2e5526];
        col.setHex(palette[(h1 * palette.length) | 0]);
        leaves.setColorAt(k, col);
        k++;
      }
    }
    trunks.count = leaves.count = k;
    // forests are the single biggest instance count on the map; keeping them out
    // of the (now per-frame) shadow pass is what makes live shadows affordable.
    // They still RECEIVE shadows, so units passing under them are shaded.
    trunks.castShadow = leaves.castShadow = false;
    trunks.receiveShadow = leaves.receiveShadow = true;
    trunks.instanceMatrix.needsUpdate = leaves.instanceMatrix.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    this.scene.add(trunks, leaves);
    // keep references so the fog can hide trees in unexplored cells (like units)
    this.treeTrunks = trunks; this.treeLeaves = leaves; this.treeN = k;
    this.treeBaseMat = (trunks.instanceMatrix.array as Float32Array).slice(0, k * 16);
  }

  // urban maps: render the building blocks as instanced towers — one draw call,
  // varied heights, a muted concrete/brick palette, and a procedural window
  // facade (with a few lit windows) baked in the shader so they read as real
  // buildings while staying cheap. Keeps the urban map fast.
  private buildCity() {
    const cells: { x: number; z: number }[] = [];
    for (let cz = 0; cz < H; cz++)
      for (let cx = 0; cx < W; cx++)
        if (this.map.cityBlock[cz * W + cx]) cells.push({ x: cx, z: cz });
    if (!cells.length) return;
    const geo = new THREE.BoxGeometry(0.96, 1, 0.96);
    geo.translate(0, 0.5, 0); // sit on the ground, grow up
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.04 });
    // procedural facade: a window grid on the vertical faces (world-space so the
    // floors line up regardless of tower height), darker mullions, some windows
    // lit. Runs in the existing single instanced draw — no extra geometry.
    mat.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNorm;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvec4 wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);\nvWPos = wp.xyz;\nvWNorm = normalize(mat3(modelMatrix * instanceMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNorm;\nfloat hsh(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }')
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          vec3 an = abs(vWNorm);
          float roof = step(0.5, an.y);              // 1 on the flat top, 0 on walls
          float hc = an.x > an.z ? vWPos.z : vWPos.x; // run along whichever wall we are on
          // window cells: columns ~0.5 world units, floors ~1.1 world units
          vec2 cellId = vec2(floor(hc * 2.0) + (an.x > an.z ? 100.0 : 0.0), floor(vWPos.y * 0.9));
          float fcx = fract(hc * 2.0), fcy = fract(vWPos.y * 0.9);
          float wx = smoothstep(0.14, 0.22, fcx) * (1.0 - smoothstep(0.78, 0.86, fcx));
          float wy = smoothstep(0.16, 0.26, fcy) * (1.0 - smoothstep(0.74, 0.86, fcy));
          float win = wx * wy * (1.0 - roof) * step(0.6, vWPos.y); // no windows on the roof or the ground sill
          float lit = step(0.62, hsh(cellId));        // ~38% of windows lit
          vec3 glass = mix(vec3(0.06, 0.08, 0.11), vec3(0.95, 0.82, 0.5), lit); // dark glass / warm lit
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, win);
          vWin = win * lit; // carry the lit-window mask to the emissive stage
        `)
        .replace('vec3 totalEmissiveRadiance = emissive;', 'float vWin;\nvec3 totalEmissiveRadiance = emissive;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vWin * vec3(1.0, 0.84, 0.5) * 0.9;');
    };
    const mesh = new THREE.InstancedMesh(geo, mat, cells.length);
    // muted, realistic facade tones: concrete greys, stone, and a little brick/tan
    const PALETTE = [0x8f9499, 0x9aa0a4, 0x7d8288, 0xa7a29a, 0x9c8d79, 0x8a7d6e, 0xb0aaa0, 0x73787d];
    const col = new THREE.Color();
    let k = 0;
    for (const c of cells) {
      const hh = 1.6 + hash2(53, c.x, c.z) * 3.2; // 1.6..4.8 storeys
      this.dummy.position.set(c.x + 0.5, this.map.heightAt(c.x + 0.5, c.z + 0.5) - 0.1, c.z + 0.5);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, hh, 1);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(k, this.dummy.matrix);
      col.setHex(PALETTE[(hash2(91, c.x, c.z) * PALETTE.length) | 0]);
      mesh.setColorAt(k, col);
      k++;
    }
    mesh.count = k;
    mesh.castShadow = true; mesh.receiveShadow = true; // buildings define the urban look — worth the shadows
    mesh.frustumCulled = false;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
  }

  // hide trees that sit in still-unexplored cells (fog 0); show them once the
  // ground has been scouted (fog >= 1), matching how buildings persist
  setTreeFog(fog: Uint8Array | null) {
    if (!this.treeTrunks || !this.treeBaseMat) return;
    const base = this.treeBaseMat;
    const ta = this.treeTrunks.instanceMatrix.array as Float32Array;
    const la = this.treeLeaves.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.treeN; i++) {
      const o = i * 16;
      // tree's ground cell = the translation columns (m12, m14 in column-major)
      const cx = Math.floor(base[o + 12]), cz = Math.floor(base[o + 14]);
      const seen = !fog || (cx >= 0 && cz >= 0 && cx < W && cz < H && fog[cz * W + cx] >= 1);
      for (let j = 0; j < 16; j++) { const v = seen ? base[o + j] : 0; ta[o + j] = v; la[o + j] = v; }
    }
    this.treeTrunks.instanceMatrix.needsUpdate = true;
    this.treeLeaves.instanceMatrix.needsUpdate = true;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    // updateStyle=true: the canvas CSS size must equal window size, or picking
    // is misaligned on displays with devicePixelRatio > 1 (Windows scaling)
    this.three.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // apply a graphics-quality preset live (pixel ratio + shadows) and persist it
  setQuality(name: string) {
    const q = GFX_QUALITY[name] || GFX_QUALITY.medium;
    try { safeLS.setItem('fe_quality', name); } catch { /* no storage */ }
    this.three.setPixelRatio(Math.min(q.pr, window.devicePixelRatio));
    this.three.shadowMap.enabled = q.shadows;
    if (this.sun) {
      this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); (this.sun.shadow as any).map = null; } // rebuild at the new size
    }
    this.resize();
  }

  // ---- camera ----
  moveCam(dx: number, dz: number) {
    // camera forward on the ground is (sin yaw, cos yaw); screen-right is (-cos yaw, sin yaw)
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.camX += -dx * c + dz * s;
    this.camZ += dx * s + dz * c;
    this.camX = Math.max(4, Math.min(W - 4, this.camX));
    this.camZ = Math.max(4, Math.min(H - 4, this.camZ));
  }
  jumpCam(x: number, z: number) {
    this.camX = Math.max(4, Math.min(W - 4, x));
    this.camZ = Math.max(4, Math.min(H - 4, z));
  }
  zoomBy(f: number, gx?: number, gz?: number) {
    const d0 = this.dist;
    this.dist = Math.max(11, Math.min(58, this.dist * f));
    // zoom toward the cursor: shift the look-at target so the ground point under
    // the pointer stays roughly put (keeps the cursor point fixed as you scroll)
    if (gx !== undefined && gz !== undefined) {
      const r = this.dist / d0;
      this.camX = Math.max(4, Math.min(W - 4, gx + (this.camX - gx) * r));
      this.camZ = Math.max(4, Math.min(H - 4, gz + (this.camZ - gz) * r));
    }
  }
  rotate(a: number) { this.yaw += a; }
  // camera pitch above the horizon; default matches the classic RTS down-angle
  pitch = Math.atan2(0.92, 0.78); // ≈ 0.868 rad
  tiltBy(d: number) { this.pitch = Math.max(0.35, Math.min(1.45, this.pitch + d)); }

  private updateCamera() {
    const gh = Math.max(SEA, this.map.heightAt(this.camX, this.camZ));
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const m = this.dist * 1.206; // boom length (keeps zoom feel constant while tilting)
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.camera.position.set(
      this.camX - s * m * cp,
      gh + 2 + m * sp,
      this.camZ - c * m * cp
    );
    this.camera.lookAt(this.camX, gh, this.camZ);
  }

  groundPoint(nx: number, ny: number): { x: number; z: number } | null {
    const ndc = new THREE.Vector3(nx * 2 - 1, -(ny * 2 - 1), 0.5);
    ndc.unproject(this.camera);
    const dir = ndc.sub(this.camera.position).normalize();
    if (dir.y >= -0.02) return null;
    let y = SEA + 0.5;
    let px = 0, pz = 0;
    for (let i = 0; i < 4; i++) {
      const t = (y - this.camera.position.y) / dir.y;
      if (t < 0) return null;
      px = this.camera.position.x + dir.x * t;
      pz = this.camera.position.z + dir.z * t;
      y = this.map.heightAt(px, pz);
    }
    return { x: Math.max(0, Math.min(W, px)), z: Math.max(0, Math.min(H, pz)) };
  }

  project(x: number, z: number, yOff = 0): { x: number; y: number; ok: boolean } {
    this.vTmp.set(x, Math.max(this.map.heightAt(x, z), SEA) + yOff, z).project(this.camera);
    return {
      x: (this.vTmp.x + 1) / 2 * window.innerWidth,
      y: (1 - this.vTmp.y) / 2 * window.innerHeight,
      ok: this.vTmp.z < 1 && Math.abs(this.vTmp.x) < 1.15 && Math.abs(this.vTmp.y) < 1.15,
    };
  }

  // project at an ABSOLUTE world Y (not relative to the ground) — used to pick
  // flyers, which render at a fixed cruise altitude rather than hugging the ground
  projectY(x: number, y: number, z: number): { x: number; y: number; ok: boolean } {
    this.vTmp.set(x, y, z).project(this.camera);
    return {
      x: (this.vTmp.x + 1) / 2 * window.innerWidth,
      y: (1 - this.vTmp.y) / 2 * window.innerHeight,
      ok: this.vTmp.z < 1 && Math.abs(this.vTmp.x) < 1.15 && Math.abs(this.vTmp.y) < 1.15,
    };
  }

  // the absolute flight altitude for a flyer at (x,z): a level cruise line that
  // never dips into valleys (cruiseY floor) AND always clears terrain taller than
  // that line — e.g. a mountain raised by terraforming after the cruise line was
  // baked. `alt` is the per-model extra height. Shared by rendering AND picking so
  // the click target sits exactly on the model.
  flyY(x: number, z: number, alt = 2.3): number {
    return Math.max(this.cruiseY, Math.max(this.map.heightAt(x, z), SEA) + 1.5) + alt;
  }

  // ---- per-frame state ----
  setGhost(active: boolean, type?: string, cx?: number, cz?: number, ok?: boolean) {
    this.ghost.visible = active;
    if (!active || !type) return;
    const s = BUILDINGS[type].size;
    this.ghost.scale.set(s, 1, s);
    // lift the shipyard ghost to the water surface so it's visible over the sea
    const baseY = this.map.heightAt(cx! + s / 2, cz! + s / 2);
    const gy = type === 'shipyard' ? Math.max(baseY, SEA - 0.05) : baseY;
    this.ghost.position.set(cx! + s / 2, gy + 0.4, cz! + s / 2);
    (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(ok ? 0x57d977 : 0xff5043);
  }

  setFormationPath(pts: { x: number; z: number }[] | null, color = 0x5ab8ff) {
    if (!pts || pts.length < 2) { this.formLine.visible = false; return; }
    (this.formLine.material as THREE.LineBasicMaterial).color.setHex(color);
    const n = Math.min(pts.length, 128);
    for (let i = 0; i < n; i++) {
      this.formPos[i * 3] = pts[i].x;
      this.formPos[i * 3 + 1] = this.map.heightAt(pts[i].x, pts[i].z) + 0.3;
      this.formPos[i * 3 + 2] = pts[i].z;
    }
    this.formLine.geometry.setDrawRange(0, n);
    (this.formLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.formLine.visible = true;
  }

  addEvents(events: any[]) {
    for (const ev of events) {
      if (ev.e === 'shot') {
        const y1 = Math.max(this.map.heightAt(ev.x, ev.z), SEA) + (ev.f ? 2.4 : 0.6);
        const y2 = Math.max(this.map.heightAt(ev.tx, ev.tz), SEA) + 0.5;
        // a turret fired: remember its aim so the gun pivot can track
        for (const rec of this.buildings.values()) {
          if (!rec.g.userData.pivot) continue;
          const dx = rec.g.position.x - ev.x, dz = rec.g.position.z - ev.z;
          if (dx * dx + dz * dz < 0.9) { rec.aim = Math.atan2(ev.tx - ev.x, ev.tz - ev.z); break; }
        }
        if (ev.w === 4) {
          // missile salvo: staggered arcing rockets with smoke trails
          const dist = Math.hypot(ev.tx - ev.x, ev.tz - ev.z);
          for (let k = 0; k < 4 && this.rockets.length < 64; k++) {
            const ox = (Math.random() - 0.5) * 1.0, oz = (Math.random() - 0.5) * 1.0;
            this.rockets.push({
              x0: ev.x, y0: y1 + 0.3, z0: ev.z,
              x1: ev.tx + ox, y1: y2 - 0.3, z1: ev.tz + oz,
              t: 0, delay: k * 0.1, dur: 0.5 + dist * 0.03, arc: 1.6 + dist * 0.28,
            });
          }
          this.spawnParts(ev.x, y1 + 0.3, ev.z, 3, false); // launch flash
        } else if (ev.w === 8) {
          // submarine cruise missile: a lofted missile arcing onto a shore target
          const dist = Math.hypot(ev.tx - ev.x, ev.tz - ev.z);
          const y1s = Math.max(this.map.heightAt(ev.x, ev.z), SEA) + 0.6;
          const y2s = Math.max(this.map.heightAt(ev.tx, ev.tz), SEA) + 0.2;
          if (this.rockets.length < 64) this.rockets.push({
            x0: ev.x, y0: y1s, z0: ev.z, x1: ev.tx, y1: y2s, z1: ev.tz,
            t: 0, delay: 0, dur: Math.max(0.7, dist * 0.05), arc: 3 + dist * 0.2,
          });
          this.spawnParts(ev.x, y1s, ev.z, 5, true); // surface launch plume
        } else if (ev.w === 7) {
          // submarine torpedo: a low projectile skimming the surface with a wake
          const wy = SEA + 0.12;
          const distT = Math.hypot(ev.tx - ev.x, ev.tz - ev.z);
          if (this.rockets.length < 64) this.rockets.push({
            x0: ev.x, y0: wy, z0: ev.z, x1: ev.tx, y1: wy, z1: ev.tz,
            t: 0, delay: 0, dur: Math.max(0.4, distT * 0.07), arc: 0.18,
          });
          this.spawnParts(ev.x, wy, ev.z, 3, false);   // launch bubbles
          this.spawnParts(ev.tx, wy, ev.tz, 4, false); // impact splash
        } else if (ev.w === 9) {
          // Heavy Cannon emplacement: muzzle flash + a fast shell that arcs to the
          // target and auto-detonates (the rockets updater spawns the impact burst)
          this.spawnParts(ev.x, y1 + 0.8, ev.z, 4, false);
          const dist = Math.hypot(ev.tx - ev.x, ev.tz - ev.z);
          if (this.rockets.length < 64) this.rockets.push({
            x0: ev.x, y0: y1 + 0.8, z0: ev.z, x1: ev.tx, y1: y2, z1: ev.tz,
            t: 0, delay: 0, dur: Math.max(0.16, dist * 0.022), arc: 0.5 + dist * 0.1,
          });
        } else if (ev.w === 10) {
          // Tesla Coil: a jagged bright lightning bolt arcing off the coil + sparks
          const yt = y1 + 2.0, seg = 5, jit = () => (Math.random() - 0.5) * 1.3;
          for (let i = 0; i < seg && this.tracers.length < MAX_TRACER; i++) {
            const a = i / seg, b = (i + 1) / seg;
            this.tracers.push({
              x1: ev.x + (ev.tx - ev.x) * a + (i ? jit() : 0), y1: yt + (y2 - yt) * a + jit() * 0.6, z1: ev.z + (ev.tz - ev.z) * a + (i ? jit() : 0),
              x2: ev.x + (ev.tx - ev.x) * b + (i < seg - 1 ? jit() : 0), y2: yt + (y2 - yt) * b + jit() * 0.6, z2: ev.z + (ev.tz - ev.z) * b + (i < seg - 1 ? jit() : 0),
              t: 0.16,
            });
          }
          this.spawnParts(ev.tx, y2, ev.tz, 5, false);
        } else {
          if (this.tracers.length < MAX_TRACER) this.tracers.push({ x1: ev.x, y1, z1: ev.z, x2: ev.tx, y2, z2: ev.tz, t: 0.1 });
          this.spawnParts(ev.tx, y2, ev.tz, 2, false);
        }
      } else if (ev.e === 'silo') {
        // ballistic missile: one big high-arc rocket from silo to target
        const dist = Math.hypot(ev.tx - ev.x, ev.tz - ev.z);
        const y1s = Math.max(this.map.heightAt(ev.x, ev.z), SEA) + 1.2;
        const y2s = Math.max(this.map.heightAt(ev.tx, ev.tz), SEA) + 0.2;
        if (this.rockets.length < 64) this.rockets.push({
          x0: ev.x, y0: y1s, z0: ev.z, x1: ev.tx, y1: y2s, z1: ev.tz,
          t: 0, delay: 0, dur: Math.max(1.0, (ev.ft || 20) / 10), arc: 6 + dist * 0.35,
        });
        this.spawnParts(ev.x, y1s, ev.z, 8, true); // launch plume
      } else if (ev.e === 'burnfx') {
        // building on fire: rising smoke
        const yb = Math.max(this.map.heightAt(ev.x, ev.z), SEA) + 0.8;
        this.smokeParts.push({ x: ev.x, y: yb, z: ev.z, vx: 0, vy: 1.1, vz: 0, life: 0, max: 1.4, s: 2.2 });
        this.spawnParts(ev.x, yb, ev.z, 1, false);
      } else if (ev.e === 'boom') {
        const y = Math.max(this.map.heightAt(ev.x, ev.z), SEA) + 0.4;
        this.spawnParts(ev.x, y, ev.z, ev.big ? 26 : 12, ev.big);
      } else if (ev.e === 'crush') {
        const y = Math.max(this.map.heightAt(ev.x, ev.z), SEA) + 0.15;
        this.spawnParts(ev.x, y, ev.z, 6, false);
      } else if (ev.e === 'heal') {
        const y = Math.max(this.map.heightAt(ev.x, ev.z), SEA) + 0.5;
        for (let i = 0; i < 4 && this.healParts.length < 128; i++) {
          const a = Math.random() * Math.PI * 2;
          this.healParts.push({
            x: ev.x + Math.cos(a) * 0.5, y, z: ev.z + Math.sin(a) * 0.5,
            vx: 0, vy: 1.4 + Math.random(), vz: 0,
            life: 0, max: 0.6 + Math.random() * 0.3, s: 1,
          });
        }
      } else if (ev.e === 'intercept') {
        // a streak from the battery up to the doomed warhead, then an airburst
        const y1 = Math.max(this.map.heightAt(ev.x, ev.z), SEA) + 0.7;
        const y2 = Math.max(this.map.heightAt(ev.tx, ev.tz), SEA) + 3.2; // warhead caught high
        if (this.tracers.length < MAX_TRACER) this.tracers.push({ x1: ev.x, y1, z1: ev.z, x2: ev.tx, y2, z2: ev.tz, t: 0.12 });
        this.spawnParts(ev.tx, y2, ev.tz, 10, true);
      } else if (ev.e === 'empfx') {
        // crackling blue arcs over a stunned unit
        const y = Math.max(this.map.heightAt(ev.x, ev.z), SEA) + 0.6;
        this.spawnParts(ev.x, y, ev.z, 3, false);
      } else if (ev.e === 'mineset') {
        const y = Math.max(this.map.heightAt(ev.x, ev.z), SEA) + 0.1;
        this.spawnParts(ev.x, y, ev.z, 2, false);
      }
    }
  }

  // Spy-satellite launch: a large rocket lifts off from (x,z) and accelerates
  // skyward, leaving a fire-and-smoke trail, then disappears "into space".
  launchSatellite(x: number, z: number) {
    const y0 = Math.max(this.map.heightAt(x, z), SEA);
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xeef2f6, roughness: 0.5, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.7, metalness: 0.2 });
    const red = new THREE.MeshStandardMaterial({ color: 0xd23b3b, roughness: 0.6, metalness: 0.2 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 6, 16), white); body.position.y = 3; g.add(body);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.6, 16), red); band.position.y = 4.6; g.add(band);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.8, 16), white); nose.position.y = 6.9; g.add(nose);
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.82, 0.8, 12), dark); bell.position.y = -0.2; g.add(bell);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.4, 1.0), dark);
      const a = i * Math.PI / 2;
      fin.position.set(Math.cos(a) * 0.7, 0.6, Math.sin(a) * 0.7); fin.rotation.y = -a;
      g.add(fin);
    }
    g.position.set(x, y0, z); g.castShadow = true;
    this.scene.add(g);
    this.satLaunches.push({ g, t: 0, x, z, y0 });
    this.spawnParts(x, y0 + 0.4, z, 16, true); // ignition blast
  }

  private spawnParts(x: number, y: number, z: number, n: number, big: boolean) {
    for (let i = 0; i < n && this.parts.length < MAX_PART; i++) {
      const a = Math.random() * Math.PI * 2, sp = (0.5 + Math.random()) * (big ? 6 : 3.2);
      this.parts.push({
        x, y: y + 0.2, z,
        vx: Math.cos(a) * sp * Math.random(), vy: (1 + Math.random() * 2) * (big ? 2.4 : 1.4), vz: Math.sin(a) * sp * Math.random(),
        life: 0, max: 0.45 + Math.random() * 0.4, s: big ? 2.6 : 1.2,
      });
    }
  }

  // views: array of {i,o,t,b,x,z,h,m,pr,...}; selection: Set of ids
  updateViews(views: any[], selection: Set<number>, dt: number) {
    const counts: Record<string, number> = {};
    for (const t in this.unitParts) counts[t] = 0;
    for (const t in this.posedParts) this.poseCounts[t] = this.posedParts[t].map(() => 0);
    const seen = new Set<number>();
    let selN = 0, rotN = 0, bagN = 0, dishN = 0;
    let rallyV: any = null;
    // factory exit points: a freshly-built vehicle that appears next to one plays a
    // short "drive down the ramp" descent (render-only, see the unit y below)
    const facFront: { x: number; z: number }[] = [];
    for (const v of views) if (v.b && v.t === 'factory') facFront.push({ x: v.x, z: v.z });
    const curVeh = new Set<number>();

    for (const v of views) {
      if (v.b) {
        seen.add(v.i);
        let rec = this.buildings.get(v.i);
        const wantCol = v.ne ? 0x8893a0 : (PLAYER_COLORS[v.o] ?? 0xffffff); // neutral garrison = grey
        if (!rec) {
          rec = { g: this.makeBuildingGroup(v.t, wantCol), type: v.t, owner: v.o };
          this.scene.add(rec.g);
          this.buildings.set(v.i, rec);
        } else if (v.gar && rec.owner !== v.o) {
          // garrison building changed hands — rebuild so the roof band shows the holder
          this.scene.remove(rec.g);
          rec.g = this.makeBuildingGroup(v.t, wantCol); rec.owner = v.o;
          this.scene.add(rec.g);
        }
        // the shipyard straddles the coast — float it at the water surface so it
        // sits on the water (on stilts), not sunk to the ocean floor
        const y = v.t === 'shipyard'
          ? Math.max(this.map.heightAt(v.x, v.z), SEA - 0.05)
          : this.map.heightAt(v.x, v.z);
        rec.g.position.set(v.x, y, v.z);
        const sc = 0.15 + 0.85 * Math.min(1, v.pr);
        const lvS = 1 + 0.06 * ((v.lv || 1) - 1); // upgraded buildings grow slightly
        rec.g.scale.set(lvS, sc * lvS, lvS);
        // turret gun tracks its last target
        const piv = rec.g.userData.pivot as THREE.Group | undefined;
        if (piv && rec.aim !== undefined) {
          let da = rec.aim - piv.rotation.y;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          piv.rotation.y += da * Math.min(1, dt * 7);
        }
        // radar dish sweeps continuously
        const dish = rec.g.userData.spinDish as THREE.Mesh | undefined;
        if (dish) dish.rotation.z = this.time * 1.4;
        if (selection.has(v.i) && selN < MAX_INST) {
          this.dummy.position.set(v.x, y + 0.1, v.z);
          this.dummy.scale.setScalar((v.sz || 1) * 1.6);
          this.dummy.rotation.set(0, 0, 0);
          this.dummy.updateMatrix();
          this.selRing.setMatrixAt(selN++, this.dummy.matrix);
          if (v.rx !== undefined && !rallyV) rallyV = v;
        }
        continue;
      }
      let parts = this.unitParts[v.t];
      if (!parts) continue;

      // facing
      let f = this.facing.get(v.i);
      if (!f) { f = { a: 0, lx: v.x, lz: v.z }; this.facing.set(v.i, f); }
      const dx = v.x - f.lx, dz = v.z - f.lz;
      // prefer the sim's per-tick "really moving" flag (v.mv) so units only walk
      // when actually travelling — a shove/nudge of a few pixels just slides them.
      // Fall back to the per-frame delta for snapshot views that don't carry mv.
      const isMoving = v.mv !== undefined ? !!v.mv : (dx * dx + dz * dz > 0.0004);
      if (isMoving) {
        // face the sim's travel heading when we have it (collision shoves don't
        // change it, so bunched harvesters stop crabbing); else the frame delta
        const want = v.hx !== undefined ? Math.atan2(v.hx, v.hz) : Math.atan2(dx, dz);
        let da = want - f.a;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        f.a += da * Math.min(1, dt * 10);
      } else if (v.ax !== undefined) {
        // standing and firing: swing the hull toward the target
        const want = Math.atan2(v.ax - v.x, v.az - v.z);
        let da = want - f.a;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        f.a += da * Math.min(1, dt * 8);
      }
      f.lx = v.x; f.lz = v.z;

      // posed infantry pick a frame: aim stance when standing (firing happens
      // standing), run-cycle frames 1..N while moving
      const poses = this.posedParts[v.t];
      let idx: number;
      if (poses) {
        // 0 = rest, 1 = aim (while firing), 2.. = run cycle
        let pi = v.fr ? 1 : 0;
        if (isMoving && poses.length > 2) {
          const rf = poses.length - 2;
          pi = 2 + ((Math.floor(this.time * 9) + v.i) % rf);
        }
        parts = poses[pi];
        idx = this.poseCounts[v.t][pi];
        if (idx >= MAX_INST) continue;
        this.poseCounts[v.t][pi] = idx + 1;
      } else {
        idx = counts[v.t];
        if (idx >= MAX_INST) continue;
        counts[v.t] = idx + 1;
      }

      const md = UNITS[v.t];
      // freshly-built ground vehicle next to a factory → start the ramp descent
      if (md && md.kind === 'veh' && !md.fly && md.move !== 'sea') {
        curVeh.add(v.i);
        if (!this.prevVeh.has(v.i)) {
          for (const f of facFront) { const dx = v.x - f.x, dz = v.z - f.z; if (dx * dx + dz * dz < 12) { this.rampAnim.set(v.i, 0.7); break; } }
        }
      }
      let gy = this.map.heightAt(v.x, v.z);
      let y: number;
      if (md?.fly) y = this.flyY(v.x, v.z, md.alt || 2.3) + Math.sin(this.time * 2.5 + v.i * 1.7) * 0.12; // level cruise, lifting over any terrain taller than the cruise line
      else if (md?.move === 'sea') {
        y = SEA + (v.t === 'sub' ? -0.08 : 0.02) + Math.sin(this.time * 1.6 + v.i) * 0.03;
        gy = SEA; // selection ring floats on the water
      } else if (md?.amphibious && gy < SEA + 0.1 && !v.tf) {
        // amphibious unit out over water — float on the surface like a barge
        // (but a bulldozer mid-terraform rides the ground it is reshaping, so it
        //  never appears to hover over the half-raised land)
        y = SEA + 0.05 + Math.sin(this.time * 1.6 + v.i) * 0.03;
        gy = SEA;
      } else y = gy;
      // "drive down the ramp": ease the new vehicle down from the ramp top to ground
      const ramp = this.rampAnim.get(v.i);
      if (ramp !== undefined) {
        y += 0.85 * (ramp / 0.7);
        const nt = ramp - dt;
        if (nt <= 0) this.rampAnim.delete(v.i); else this.rampAnim.set(v.i, nt);
      }
      // infantry walk bob: hop + slight sway while moving (subtle when real
      // run-cycle frames carry the motion)
      let rollZ = 0;
      if (md?.kind === 'inf' && !md.fly && v.t !== 'hive' && isMoving) {
        const ph = this.time * 9 + v.i * 2.1;
        const k = poses ? 0.3 : 1;
        y += Math.abs(Math.sin(ph)) * 0.055 * k;
        rollZ = Math.sin(ph) * 0.05 * k;
      }
      this.dummy.position.set(v.x, y, v.z);
      this.dummy.rotation.set(0, f.a, rollZ);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      const teamHex = PLAYER_COLORS[v.o] ?? 0xffffff;
      for (const part of parts) {
        part.mesh.setMatrixAt(idx, this.dummy.matrix);
        if (part.mode === 1) { this.colTmp.setHex(teamHex); part.mesh.setColorAt(idx, this.colTmp); }
        else if (part.mode === 2) { // external model: team wash that keeps detail
          this.colTmp.setHex(teamHex).lerp(WHITE, 0.4);
          part.mesh.setColorAt(idx, this.colTmp);
        }
      }

      if (selection.has(v.i) && selN < MAX_INST) {
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.position.y = gy + 0.06; // ring stays on the ground, even for flyers
        this.dummy.updateMatrix();
        this.selRing.setMatrixAt(selN++, this.dummy.matrix);
      }

      // whirling rotor blades / nose propellers
      const rot = ROTORS[v.t];
      if (rot && rotN < MAX_INST) {
        const dims = this.modelDims[v.t];
        const spin = this.time * rot.speed + v.i * 1.3;
        if (rot.nose) {
          // prop disc at the nose, spinning around the forward axis
          const fwd = (dims ? dims.len * 0.5 : 0.9) + 0.04;
          this.dummy.position.set(v.x + Math.sin(f.a) * fwd, y + (dims ? dims.h * 0.45 : rot.y), v.z + Math.cos(f.a) * fwd);
          this.qTmp.setFromEuler(this.eTmp.set(0, f.a, 0));
          this.qTmp2.setFromEuler(this.eTmp.set(Math.PI / 2, 0, 0));
          this.qTmp.multiply(this.qTmp2);
          this.qTmp2.setFromEuler(this.eTmp.set(0, spin, 0));
          this.qTmp.multiply(this.qTmp2);
          this.dummy.quaternion.copy(this.qTmp);
          this.dummy.scale.set(rot.r, 1, rot.r);
        } else {
          // main rotor on top of the hull
          this.dummy.position.set(v.x, y + (dims ? dims.h + 0.04 : rot.y), v.z);
          this.dummy.rotation.set(0, spin, 0);
          this.dummy.scale.set(rot.r * 1.6, 1, rot.r * 1.6);
        }
        this.dummy.updateMatrix();
        this.rotorMesh.setMatrixAt(rotN++, this.dummy.matrix);
      }

      // sandbag ring around fortified / deploying infantry
      if ((v.fo || v.ft) && md?.kind === 'inf' && v.t !== 'hive' && bagN < MAX_INST) {
        this.dummy.position.set(v.x, gy + 0.02, v.z);
        this.dummy.rotation.set(0, v.i * 1.7, 0);
        const grow = v.ft ? 0.6 : 1; // half-built while deploying
        this.dummy.scale.set(1, grow, 1);
        this.dummy.updateMatrix();
        this.sandbagMesh.setMatrixAt(bagN++, this.dummy.matrix);
      }
      // deployed radar dish on a fortified Patriot — set on the ground BEHIND the
      // launcher (opposite its facing), not floating on top of it
      if (v.t === 'patriot' && (v.fo || v.ft) && dishN < MAX_INST) {
        this.dummy.position.set(v.x - Math.sin(f.a) * 1.7, gy + 0.05, v.z - Math.cos(f.a) * 1.7);
        const s = v.ft ? 0.6 : 1; // rising into place while deploying
        this.dummy.rotation.set(0, this.time * 0.9 + v.i, 0); // slow radar sweep
        this.dummy.scale.set(s, s, s);
        this.dummy.updateMatrix();
        this.radarDishMesh.setMatrixAt(dishN++, this.dummy.matrix);
      }
      seen.add(v.i);
    }

    for (const t in this.unitParts) {
      if (this.posedParts[t]) continue; // counted per pose below
      for (const part of this.unitParts[t]) {
        part.mesh.count = counts[t] || 0;
        part.mesh.instanceMatrix.needsUpdate = true;
        if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
      }
    }
    for (const t in this.posedParts) {
      const pcs = this.poseCounts[t];
      this.posedParts[t].forEach((ps, k) => {
        for (const part of ps) {
          part.mesh.count = pcs[k] || 0;
          part.mesh.instanceMatrix.needsUpdate = true;
          if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
        }
      });
    }
    this.selRing.count = selN;
    this.selRing.instanceMatrix.needsUpdate = true;
    this.rotorMesh.count = rotN;
    this.sandbagMesh.count = bagN;
    this.sandbagMesh.instanceMatrix.needsUpdate = true;
    this.rotorMesh.instanceMatrix.needsUpdate = true;
    this.radarDishMesh.count = dishN;
    this.radarDishMesh.instanceMatrix.needsUpdate = true;

    // rally marker for the selected production building
    if (rallyV) {
      const ry = Math.max(this.map.heightAt(rallyV.rx, rallyV.rz), SEA); // float the flag on water (shipyard rallies)
      this.rallyFlag.position.set(rallyV.rx, ry, rallyV.rz);
      // gold pennant when the rally sits on an ore field (harvesters will mine there)
      let onOre = false;
      const rcx = Math.floor(rallyV.rx), rcz = Math.floor(rallyV.rz);
      for (let dz = -1; dz <= 1 && !onOre; dz++)
        for (let dx = -1; dx <= 1 && !onOre; dx++)
          if (this.map.inB(rcx + dx, rcz + dz) && this.map.ore[(rcz + dz) * W + rcx + dx] > 0) onOre = true;
      (this.rallyPennant.material as THREE.MeshBasicMaterial).color.setHex(onOre ? 0xd9a520 : (PLAYER_COLORS[rallyV.o] ?? 0x6aff6a));
      const by = Math.max(this.map.heightAt(rallyV.x, rallyV.z), SEA) + 1.0;
      this.rallyLinePos[0] = rallyV.x; this.rallyLinePos[1] = by; this.rallyLinePos[2] = rallyV.z;
      this.rallyLinePos[3] = rallyV.rx; this.rallyLinePos[4] = ry + 0.6; this.rallyLinePos[5] = rallyV.rz;
      (this.rallyLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      this.rallyFlag.visible = this.rallyLine.visible = true;
    } else {
      this.rallyFlag.visible = this.rallyLine.visible = false;
    }

    // remove dead buildings / stale facing
    for (const [id, rec] of this.buildings) {
      if (!seen.has(id)) { this.scene.remove(rec.g); this.buildings.delete(id); }
    }
    if (this.facing.size > 1200) {
      for (const id of this.facing.keys()) if (!seen.has(id)) this.facing.delete(id);
    }
    this.prevVeh = curVeh; // for next frame's "freshly-built vehicle" detection

    // ore refresh
    if (this.map.oreDirty) {
      this.map.oreDirty = false;
      let n = 0, gn = 0, on = 0;
      for (let cz = 0; cz < H; cz++) {
        for (let cx = 0; cx < W; cx++) {
          const amt = this.map.ore[cz * W + cx];
          if (amt <= 0) continue;
          const x = cx + 0.5, z = cz + 0.5;
          const oilCell = this.map.oil[cz * W + cx] === 1;
          // oil wells (incl. offshore) sit on top of the ground/water surface
          const baseY = oilCell ? Math.max(this.map.heightAt(x, z), SEA) : this.map.heightAt(x, z);
          this.dummy.position.set(x, baseY + (oilCell ? 0 : 0.15), z);
          this.dummy.rotation.set(0, (cx * 7 + cz * 13) % 6, 0);
          this.dummy.scale.setScalar(oilCell ? 1 : 0.5 + Math.min(1, amt / 700) * 0.8);
          this.dummy.updateMatrix();
          if (oilCell) { if (this.map.occ[cz * W + cx] === 0 && on < 1024) this.oilMesh.setMatrixAt(on++, this.dummy.matrix); } // hidden once a rig is built on it
          else if (this.map.gem[cz * W + cx] === 1) { if (gn < 512) this.gemMesh.setMatrixAt(gn++, this.dummy.matrix); }
          else if (n < 2048) this.oreMesh.setMatrixAt(n++, this.dummy.matrix);
        }
      }
      this.oreMesh.count = n;
      this.oreMesh.instanceMatrix.needsUpdate = true;
      this.gemMesh.count = gn;
      this.gemMesh.instanceMatrix.needsUpdate = true;
      this.oilMesh.count = on;
      this.oilMesh.instanceMatrix.needsUpdate = true;
    }

    // road refresh
    if (this.map.roadDirty) {
      this.map.roadDirty = false;
      let rn = 0;
      for (let cz = 0; cz < H && rn < 4096; cz++) {
        for (let cx = 0; cx < W && rn < 4096; cx++) {
          if (this.map.road[cz * W + cx] === 0) continue;
          const x = cx + 0.5, z = cz + 0.5;
          this.dummy.position.set(x, this.map.heightAt(x, z) + 0.04, z);
          this.dummy.rotation.set(0, 0, 0);
          this.dummy.scale.setScalar(1);
          this.dummy.updateMatrix();
          this.roadMesh.setMatrixAt(rn++, this.dummy.matrix);
        }
      }
      this.roadMesh.count = rn;
      this.roadMesh.instanceMatrix.needsUpdate = true;
    }
  }

  render(dt: number) {
    this.time += dt;
    // water ripple animation
    const wm = this.waterMat.normalMap as THREE.Texture;
    wm.offset.x += dt * 0.013;
    wm.offset.y += dt * 0.009;

    // tracers
    let tn = 0;
    this.tracers = this.tracers.filter(t => (t.t -= dt) > 0);
    for (const t of this.tracers) {
      this.tracerPos[tn * 6] = t.x1; this.tracerPos[tn * 6 + 1] = t.y1; this.tracerPos[tn * 6 + 2] = t.z1;
      this.tracerPos[tn * 6 + 3] = t.x2; this.tracerPos[tn * 6 + 4] = t.y2; this.tracerPos[tn * 6 + 5] = t.z2;
      tn++;
    }
    this.tracerGeo.setDrawRange(0, tn * 2);
    (this.tracerGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    // particles
    let pn = 0;
    this.parts = this.parts.filter(p => {
      p.life += dt;
      if (p.life >= p.max) return false;
      p.vy -= 7 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const k = 1 - p.life / p.max;
      this.dummy.position.set(p.x, Math.max(p.y, this.map.heightAt(p.x, p.z) + 0.05), p.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(p.s * (0.4 + k));
      this.dummy.updateMatrix();
      if (pn < MAX_PART) this.partMesh.setMatrixAt(pn++, this.dummy.matrix);
      return true;
    });
    this.partMesh.count = pn;
    this.partMesh.instanceMatrix.needsUpdate = true;

    // rockets: ballistic arc, oriented along flight, trailing smoke
    let rn = 0;
    this.rockets = this.rockets.filter(r => {
      r.t += dt;
      const p = (r.t - r.delay) / r.dur;
      if (p < 0) return true;
      if (p >= 1) {
        this.spawnParts(r.x1, r.y1 + 0.3, r.z1, 7, false); // impact
        return false;
      }
      const at = (q: number) => ({
        x: r.x0 + (r.x1 - r.x0) * q,
        y: r.y0 + (r.y1 - r.y0) * q + Math.sin(Math.PI * q) * r.arc,
        z: r.z0 + (r.z1 - r.z0) * q,
      });
      const pos = at(p), ahead = at(Math.min(1, p + 0.04));
      this.dummy.position.set(pos.x, pos.y, pos.z);
      this.dummy.lookAt(ahead.x, ahead.y, ahead.z);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      if (rn < 64) this.rocketMesh.setMatrixAt(rn++, this.dummy.matrix);
      if (this.smokeParts.length < 400) {
        this.smokeParts.push({
          x: pos.x, y: pos.y, z: pos.z,
          vx: (Math.random() - 0.5) * 0.3, vy: 0.4, vz: (Math.random() - 0.5) * 0.3,
          life: 0, max: 0.5 + Math.random() * 0.3, s: 1,
        });
      }
      return true;
    });
    this.rocketMesh.count = rn;
    this.rocketMesh.instanceMatrix.needsUpdate = true;

    // satellite launches: a big rocket accelerates skyward, trailing fire + smoke
    this.satLaunches = this.satLaunches.filter(s => {
      s.t += dt;
      const dur = 7;
      if (s.t >= dur) { this.scene.remove(s.g); return false; }
      const p = s.t / dur;
      s.g.position.set(s.x + p * p * 18, s.y0 + p * p * 150, s.z); // accelerating ascent + gravity-turn drift
      s.g.rotation.z = -Math.min(0.6, p * 0.8);                    // lean downrange as it climbs
      const ex = s.g.position;
      this.spawnParts(ex.x, ex.y - 0.2, ex.z, 3, true);            // engine flame
      if (this.smokeParts.length < 400) this.smokeParts.push({
        x: ex.x + (Math.random() - 0.5) * 0.6, y: ex.y - 0.5, z: ex.z + (Math.random() - 0.5) * 0.6,
        vx: (Math.random() - 0.5) * 0.6, vy: -0.3, vz: (Math.random() - 0.5) * 0.6,
        life: 0, max: 1.3 + Math.random() * 0.8, s: 2.4,
      });
      return true;
    });

    // smoke puffs: drift and grow
    let sn = 0;
    this.smokeParts = this.smokeParts.filter(p => {
      p.life += dt;
      if (p.life >= p.max) return false;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(0.6 + (p.life / p.max) * 1.6);
      this.dummy.updateMatrix();
      if (sn < 400) this.smokeMesh.setMatrixAt(sn++, this.dummy.matrix);
      return true;
    });
    this.smokeMesh.count = sn;
    this.smokeMesh.instanceMatrix.needsUpdate = true;

    // heal sparkles (no gravity — they rise and fade)
    let hn = 0;
    this.healParts = this.healParts.filter(p => {
      p.life += dt;
      if (p.life >= p.max) return false;
      p.y += p.vy * dt;
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(0.5 + (1 - p.life / p.max));
      this.dummy.updateMatrix();
      if (hn < 128) this.healMesh.setMatrixAt(hn++, this.dummy.matrix);
      return true;
    });
    this.healMesh.count = hn;
    this.healMesh.instanceMatrix.needsUpdate = true;

    this.updateCamera();
    this.three.render(this.scene, this.camera);
  }
}
