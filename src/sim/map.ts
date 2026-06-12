// Procedural world map: continents with coastlines, lakes, mountain ridges,
// ore fields. Built identically on server and clients from a shared seed
// (integer-hash noise only — no engine-dependent math).

import { RNG, hash2 } from './rng';

export let W = 96, H = 96;
export const MAXD = 128;           // largest supported map dimension
export const SEA = 1.2;
export function setMapSize(n: number) { W = n; H = n; }

function vnoise(seed: number, x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(seed, xi, yi), b = hash2(seed, xi + 1, yi);
  const c = hash2(seed, xi, yi + 1), d = hash2(seed, xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(seed: number, x: number, y: number, oct = 4): number {
  let f = 0, amp = 0.5, fr = 1;
  for (let i = 0; i < oct; i++) { f += amp * vnoise(seed + i * 101, x * fr, y * fr); amp *= 0.5; fr *= 2; }
  return f;
}

export class GameMap {
  hN = new Float32Array((W + 1) * (H + 1));   // node heights
  ore = new Float32Array(W * H);              // ore credits per cell
  occ = new Int32Array(W * H);                // building entity id occupying cell (0 = none)
  tBlocked = new Uint8Array(W * H);           // terrain-blocked (water / cliff / forest)
  forest = new Uint8Array(W * H);             // forest cells (blocked, rendered as trees)
  water = new Uint8Array(W * H);              // water cells (navigable by ships)
  gem = new Uint8Array(W * H);                // special ore: 3x credit value
  oreMax = new Float32Array(W * H);           // original ore amount (for regrowth)
  road = new Int8Array(W * H);                // 0 none, else owner+1 (extends build reach)
  roadDirty = true;
  spawns: { x: number; z: number }[] = [];
  oreDirty = true;

  node(x: number, z: number): number { return this.hN[z * (W + 1) + x]; }
  cellH(cx: number, cz: number): number {
    const i = cz * (W + 1) + cx;
    return (this.hN[i] + this.hN[i + 1] + this.hN[i + W + 1] + this.hN[i + W + 2]) / 4;
  }
  inB(cx: number, cz: number): boolean { return cx >= 0 && cz >= 0 && cx < W && cz < H; }
  blockedT(cx: number, cz: number): boolean { return !this.inB(cx, cz) || this.tBlocked[cz * W + cx] !== 0; }
  passable(cx: number, cz: number): boolean {
    return this.inB(cx, cz) && this.tBlocked[cz * W + cx] === 0 && this.occ[cz * W + cx] === 0;
  }
  passableSea(cx: number, cz: number): boolean {
    return this.inB(cx, cz) && this.water[cz * W + cx] === 1 && this.occ[cz * W + cx] === 0;
  }
  heightAt(x: number, z: number): number {
    const cx = Math.min(W - 0.001, Math.max(0, x)), cz = Math.min(H - 0.001, Math.max(0, z));
    const xi = Math.floor(cx), zi = Math.floor(cz);
    const xf = cx - xi, zf = cz - zi;
    const i = zi * (W + 1) + xi;
    const a = this.hN[i], b = this.hN[i + 1], c = this.hN[i + W + 1], d = this.hN[i + W + 2];
    return a + (b - a) * xf + (c - a) * zf + (a - b - c + d) * xf * zf;
  }
}

export function genMap(seed: number, nPlayers: number): GameMap {
  const m = new GameMap();
  const rng = new RNG(seed ^ 0x5eed);

  // -- heights: continental noise * edge falloff (sea border), plus ridges
  for (let z = 0; z <= H; z++) {
    for (let x = 0; x <= W; x++) {
      const dEdge = Math.min(x, W - x, z, H - z) / (W * 0.5);
      const e = Math.min(1, dEdge / 0.24);
      let h = (fbm(seed, x * 0.035, z * 0.035) * 1.65 - 0.42) * 7.0 * e;
      const ridge = fbm(seed + 777, x * 0.06, z * 0.06);
      h += Math.max(0, ridge - 0.66) * 16;
      h += fbm(seed + 313, x * 0.18, z * 0.18) * 0.5; // small texture
      m.hN[z * (W + 1) + x] = Math.max(-1.2, h);
    }
  }

  // -- spawn plateaus (guaranteed buildable land)
  const corners = [
    { x: 17, z: 17 }, { x: W - 17, z: H - 17 },
    { x: 17, z: H - 17 }, { x: W - 17, z: 17 },
  ];
  for (let p = 0; p < Math.max(2, nPlayers); p++) {
    const s = corners[p];
    m.spawns.push({ x: s.x, z: s.z });
    const R = 9;
    // plateau height: solid land
    const target = Math.max(SEA + 1.0, m.heightAt(s.x, s.z));
    for (let z = s.z - R; z <= s.z + R; z++) {
      for (let x = s.x - R; x <= s.x + R; x++) {
        if (x < 0 || z < 0 || x > W || z > H) continue;
        const d = Math.sqrt((x - s.x) * (x - s.x) + (z - s.z) * (z - s.z));
        if (d > R) continue;
        const t = Math.min(1, (1 - d / R) * 2.2);
        const i = z * (W + 1) + x;
        m.hN[i] = m.hN[i] + (target - m.hN[i]) * t;
      }
    }
  }

  // -- blocked cells: water or cliffs
  for (let cz = 0; cz < H; cz++) {
    for (let cx = 0; cx < W; cx++) {
      const i = cz * (W + 1) + cx;
      const a = m.hN[i], b = m.hN[i + 1], c = m.hN[i + W + 1], d = m.hN[i + W + 2];
      const avg = (a + b + c + d) / 4;
      const slope = Math.max(a, b, c, d) - Math.min(a, b, c, d);
      if (avg < SEA + 0.05) { m.tBlocked[cz * W + cx] = 1; m.water[cz * W + cx] = 1; }
      else if (slope > 1.7) m.tBlocked[cz * W + cx] = 1;
    }
  }

  // -- forests: impassable tree cover on temperate land, away from spawns
  for (let cz = 0; cz < H; cz++) {
    for (let cx = 0; cx < W; cx++) {
      const i = cz * W + cx;
      if (m.tBlocked[i]) continue;
      const h = m.cellH(cx, cz);
      if (h < SEA + 0.45 || h > 6.2) continue;
      let nearSpawn = false;
      for (const s of corners)
        if ((cx - s.x) ** 2 + (cz - s.z) ** 2 < 15 * 15) { nearSpawn = true; break; }
      if (nearSpawn) continue;
      if (fbm(seed + 555, cx * 0.055, cz * 0.055) > 0.635) { m.forest[i] = 1; m.tBlocked[i] = 1; }
    }
  }

  // -- ore fields
  const addOre = (cx: number, cz: number, r: number, amt: number) => {
    for (let z = cz - r; z <= cz + r; z++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (!m.inB(x, z) || m.blockedT(x, z)) continue;
        const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz));
        if (d > r + 0.4) continue;
        m.ore[z * W + x] = amt * (0.7 + 0.6 * rng.next());
      }
    }
  };
  // two fields near every spawn (even unused ones - they become expansions)
  for (const s of corners) {
    const dx = Math.sign(W / 2 - s.x), dz = Math.sign(H / 2 - s.z);
    addOre(Math.round(s.x + dx * 10), Math.round(s.z + dz * 3 + rng.range(-3, 3)), 2, 700);
    addOre(Math.round(s.x + dx * 3 + rng.range(-3, 3)), Math.round(s.z + dz * 10), 2, 700);
  }
  // central contested fields
  let placed = 0, tries = 0;
  const wantOre = Math.max(3, Math.round(W / 19));
  while (placed < wantOre && tries < 200) {
    tries++;
    const cx = 24 + rng.int(W - 48), cz = 24 + rng.int(H - 48);
    if (m.blockedT(cx, cz)) continue;
    addOre(cx, cz, 3, 900);
    placed++;
  }

  // -- special crystal fields: rare, contested, 3x value
  let gems = 0, gtries = 0;
  const wantGems = Math.max(2, Math.round(W / 44));
  while (gems < wantGems && gtries < 300) {
    gtries++;
    const cx = 20 + rng.int(W - 40), cz = 20 + rng.int(H - 40);
    if (m.blockedT(cx, cz)) continue;
    let farFromSpawns = true;
    for (const s of corners)
      if ((cx - s.x) ** 2 + (cz - s.z) ** 2 < 24 * 24) { farFromSpawns = false; break; }
    if (!farFromSpawns) continue;
    for (let z = cz - 2; z <= cz + 2; z++)
      for (let x = cx - 2; x <= cx + 2; x++) {
        if (!m.inB(x, z) || m.blockedT(x, z)) continue;
        const d = Math.sqrt((x - cx) ** 2 + (z - cz) ** 2);
        if (d > 2.4) continue;
        m.ore[z * W + x] = 600 * (0.7 + 0.6 * rng.next());
        m.gem[z * W + x] = 1;
      }
    gems++;
  }
  // record original amounts so fields can slowly regrow (territory control)
  m.oreMax.set(m.ore);
  return m;
}

// Spiral outward to the nearest navigable water cell.
export function nearestSea(m: GameMap, cx: number, cz: number, maxR = 10): { x: number; z: number } | null {
  if (m.passableSea(cx, cz)) return { x: cx, z: cz };
  for (let r = 1; r <= maxR; r++)
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (m.passableSea(cx + dx, cz + dz)) return { x: cx + dx, z: cz + dz };
      }
  return null;
}

function _unused(m: GameMap) {

  return m;
}

// Spiral outward to the nearest passable cell.
export function nearestPassable(m: GameMap, cx: number, cz: number, maxR = 12): { x: number; z: number } | null {
  if (m.passable(cx, cz)) return { x: cx, z: cz };
  for (let r = 1; r <= maxR; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (m.passable(cx + dx, cz + dz)) return { x: cx + dx, z: cz + dz };
      }
    }
  }
  return null;
}
