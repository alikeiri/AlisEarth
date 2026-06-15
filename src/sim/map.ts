// Procedural world map: continents with coastlines, lakes, mountain ridges,
// ore fields. Built identically on server and clients from a shared seed
// (integer-hash noise only — no engine-dependent math).

import { RNG, hash2 } from './rng';
import { hyp, dsin, dcos } from './dmath';

export let W = 96, H = 96;
export const MAXD = 160;           // largest supported map dimension
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

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
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
  heightDirty = false;                        // terraforming edited the heightfield → rebuild mesh
  // dirty bounding box of terraformed cells since the last mesh refresh, so the
  // renderer only rebuilds the touched region instead of the whole terrain
  hdMinX = 1e9; hdMinZ = 1e9; hdMaxX = -1e9; hdMaxZ = -1e9;
  terraMask = new Uint8Array(W * H);          // 1 = cell was terraformed to land (render as concrete)
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
  // amphibious: travels over open ground AND water, but not cliffs/forest
  passableAmphi(cx: number, cz: number): boolean {
    if (!this.inB(cx, cz) || this.occ[cz * W + cx] !== 0) return false;
    const i = cz * W + cx;
    return this.tBlocked[i] === 0 || this.water[i] === 1;
  }
  // crawler (bulldozer): drives over ANY terrain — cliffs, water, freshly-dug
  // holes — only stopped by buildings, so a terraformer can never strand itself
  passableCrawler(cx: number, cz: number): boolean {
    return this.inB(cx, cz) && this.occ[cz * W + cx] === 0;
  }
  heightAt(x: number, z: number): number {
    const cx = Math.min(W - 0.001, Math.max(0, x)), cz = Math.min(H - 0.001, Math.max(0, z));
    const xi = Math.floor(cx), zi = Math.floor(cz);
    const xf = cx - xi, zf = cz - zi;
    const i = zi * (W + 1) + xi;
    const a = this.hN[i], b = this.hN[i + 1], c = this.hN[i + W + 1], d = this.hN[i + W + 2];
    return a + (b - a) * xf + (c - a) * zf + (a - b - c + d) * xf * zf;
  }

  // recompute blocked/water flags for a rectangular region after the heightfield
  // is edited (shared by map gen and terraforming)
  reblock(x0: number, z0: number, x1: number, z1: number) {
    for (let cz = Math.max(0, z0); cz < Math.min(H, z1); cz++)
      for (let cx = Math.max(0, x0); cx < Math.min(W, x1); cx++) {
        const i = cz * (W + 1) + cx;
        const a = this.hN[i], b = this.hN[i + 1], c = this.hN[i + W + 1], d = this.hN[i + W + 2];
        const avg = (a + b + c + d) / 4;
        const slope = Math.max(a, b, c, d) - Math.min(a, b, c, d);
        const ci = cz * W + cx;
        this.tBlocked[ci] = 0; this.water[ci] = 0;
        if (avg < SEA + 0.05) { this.tBlocked[ci] = 1; this.water[ci] = 1; }
        else if (slope > 2.0) this.tBlocked[ci] = 1;
      }
  }

  // nudge one cell's four corner nodes toward a target height by `step`, then
  // refresh its blocked/water flags. Returns true once the cell has settled.
  terraform(cx: number, cz: number, target: number, step: number): boolean {
    if (!this.inB(cx, cz)) return true;
    const ns = [cz * (W + 1) + cx, cz * (W + 1) + cx + 1, (cz + 1) * (W + 1) + cx, (cz + 1) * (W + 1) + cx + 1];
    let done = true;
    for (const i of ns) {
      const dlt = target - this.hN[i];
      if (Math.abs(dlt) <= step) this.hN[i] = target;
      else { this.hN[i] += Math.sign(dlt) * step; done = false; }
    }
    this.reblock(cx - 1, cz - 1, cx + 2, cz + 2);
    // mark cells raised/leveled to land as terraformed (concrete); cells dug to
    // water are cleared so a flooded channel doesn't show concrete
    this.terraMask[cz * W + cx] = target > SEA ? 1 : 0;
    this.heightDirty = true;
    if (cx < this.hdMinX) this.hdMinX = cx;
    if (cx > this.hdMaxX) this.hdMaxX = cx;
    if (cz < this.hdMinZ) this.hdMinZ = cz;
    if (cz > this.hdMaxZ) this.hdMaxZ = cz;
    return done;
  }
}

// Hand-drawn continent silhouettes ('#' = land). Coastlines get fbm domain
// warping at sample time, so the low-res masks read as detailed coasts.
const CONTINENTS: { name: string; rows: string[] }[] = [
  { name: 'Africa', rows: [
    '......########......',
    '...###########......',
    '.#############......',
    '##############......',
    '###############.....',
    '###############.....',
    '##############......',
    '.############.......',
    '...###########......',
    '...############.....',
    '....###########.....',
    '....#########.......',
    '.....########..##...',
    '.....########..##...',
    '......######....#...',
    '......######........',
    '......#####.........',
    '......####..........',
    '.......###..........',
    '.......##...........',
  ] },
  { name: 'South America', rows: [
    '.....#######........',
    '...##########.......',
    '..############......',
    '.##############.....',
    '.###############....',
    '..###############...',
    '..###############...',
    '...##############...',
    '...#############....',
    '....###########.....',
    '....##########......',
    '....#########.......',
    '....########........',
    '...########.........',
    '...#######..........',
    '...######...........',
    '...#####............',
    '...####.............',
    '....###.............',
    '....##..............',
  ] },
  { name: 'Australia', rows: [
    '...####....######...',
    '.######...########..',
    '.#################..',
    '###################.',
    '###################.',
    '###################.',
    '##################..',
    '.################...',
    '..##############....',
    '....###########.....',
    '......########......',
    '....................',
    '..............##....',
    '..............##....',
  ] },
  { name: 'North America', rows: [
    '###########..#####..',
    '#################...',
    '.################...',
    '..###############...',
    '..##############....',
    '...#############....',
    '...############.....',
    '....###########.....',
    '....##########......',
    '.....#########......',
    '......########......',
    '.......######.......',
    '........#####.......',
    '........####........',
    '.........###........',
    '.........###........',
    '..........###.......',
    '...........##.......',
  ] },
  { name: 'Eurasia', rows: [
    '....################',
    '..##################',
    '####################',
    '####################',
    '####################',
    '.###################',
    '.##################.',
    '..#####.###########.',
    '..####..##########..',
    '..####.####.######..',
    '...##..####..#####..',
    '...#...###...#####..',
    '.......###....###...',
    '.......##......##...',
    '.......##......###..',
    '........#.......#...',
  ] },
];

// bilinear sample of a mask, 0 (sea) .. 1 (land); outside the grid = sea
function maskAt(rows: string[], u: number, v: number): number {
  const gw = rows[0].length, gh = rows.length;
  const x = u * (gw - 1), y = v * (gh - 1);
  if (x < 0 || y < 0 || x > gw - 1 || y > gh - 1) return 0;
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const at = (gx: number, gy: number) =>
    (rows[Math.min(gh - 1, gy)]?.charAt(Math.min(gw - 1, gx)) === '#') ? 1 : 0;
  const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

export function genMap(seed: number, nPlayers: number): GameMap {
  const m = new GameMap();
  const rng = new RNG(seed ^ 0x5eed);

  // -- heights: either ONE Earth-continent silhouette, or 2-4 separate islands
  //    divided by water. Islands mode rides in seed bit 0x40000000 so it flows
  //    through skirmish / multiplayer / replays without any extra plumbing.
  const islands = (seed & 0x40000000) !== 0;
  const cont = CONTINENTS[(seed >>> 3) % CONTINENTS.length];
  const nIslands = Math.min(4, Math.max(2, nPlayers));
  const isleC: { x: number; z: number }[] = [];
  if (islands) {
    const quad = [[0.27, 0.27], [0.73, 0.73], [0.73, 0.27], [0.27, 0.73]];
    const jx = (((seed >>> 5) % 100) / 100 - 0.5) * 0.08;
    const jz = (((seed >>> 13) % 100) / 100 - 0.5) * 0.08;
    for (let k = 0; k < nIslands; k++) isleC.push({ x: (quad[k][0] + jx) * W, z: (quad[k][1] + jz) * H });
  }
  const isleR = Math.min(W, H) * (nIslands <= 2 ? 0.30 : 0.23);
  for (let z = 0; z <= H; z++) {
    for (let x = 0; x <= W; x++) {
      const dEdge = Math.min(x, W - x, z, H - z) / (W * 0.5);
      const e = Math.min(1, dEdge / 0.14); // thin sea border at map edges
      let h: number;
      if (islands) {
        // each node takes the height of its nearest island: a warped radial blob
        // that rises from the sea, leaving open water between the landmasses
        let nd = 1e9;
        for (const c of isleC) { const d = hyp(x - c.x, z - c.z); if (d < nd) nd = d; }
        const warp = (fbm(seed + 555, x * 0.05, z * 0.05) - 0.5) * isleR * 0.55; // organic coast
        const r = (nd + warp) / isleR;                 // 0 at island core .. 1 at coast
        const land = 1 - smoothstep(0.6, 1.0, r);
        h = land * 3.0 - 0.9;
        h += (fbm(seed, x * 0.05, z * 0.05) - 0.5) * 1.4 * land;
        const ridge = fbm(seed + 777, x * 0.06, z * 0.06);
        h += Math.max(0, ridge - 0.72) * 7 * land;     // inland peaks
        h += fbm(seed + 313, x * 0.18, z * 0.18) * 0.42;
        h *= (0.35 + 0.65 * e);                         // taper to sea at the very edges
      } else {
        // domain-warped mask sample = detailed coastline from a coarse shape;
        // seed bits mirror the continent for extra per-game variety. 1.06 fills
        // more of the map with land (bigger playable area; tester: felt small).
        let wu = (x / W - 0.5) * 1.06 + 0.5 + (fbm(seed + 91, x * 0.045, z * 0.045) - 0.5) * 0.14;
        let wv = (z / H - 0.5) * 1.06 + 0.5 + (fbm(seed + 92, x * 0.045, z * 0.045) - 0.5) * 0.14;
        if (seed & 32) wu = 1 - wu;
        if (seed & 64) wv = 1 - wv;
        const mask = maskAt(cont.rows, wu, wv);
        // lower, flatter landmass: the plateau rises only gently from the shore so
        // coasts aren't towering cliffs and naval guns can reach shore targets
        h = (smoothstep(0.28, 0.62, mask) * 3.2 - 0.55) * 2.7 * e;
        h += (fbm(seed, x * 0.05, z * 0.05) - 0.5) * 1.6 * mask; // interior variation
        const ridge = fbm(seed + 777, x * 0.06, z * 0.06);
        h += Math.max(0, ridge - 0.7) * 8 * mask; // mountains only well inland
        h += fbm(seed + 313, x * 0.18, z * 0.18) * 0.45; // small texture
      }
      m.hN[z * (W + 1) + x] = Math.max(-1.2, h);
    }
  }

  // -- blocked cells: water or cliffs
  const recomputeBlocked = (x0: number, z0: number, x1: number, z1: number) => {
    for (let cz = Math.max(0, z0); cz < Math.min(H, z1); cz++) {
      for (let cx = Math.max(0, x0); cx < Math.min(W, x1); cx++) {
        const i = cz * (W + 1) + cx;
        const a = m.hN[i], b = m.hN[i + 1], c = m.hN[i + W + 1], d = m.hN[i + W + 2];
        const avg = (a + b + c + d) / 4;
        const slope = Math.max(a, b, c, d) - Math.min(a, b, c, d);
        const ci = cz * W + cx;
        m.tBlocked[ci] = 0; m.water[ci] = 0;
        if (avg < SEA + 0.05) { m.tBlocked[ci] = 1; m.water[ci] = 1; }
        else if (slope > 2.0) m.tBlocked[ci] = 1; // only genuinely steep cliffs block
      }
    }
  };
  recomputeBlocked(0, 0, W, H);

  // -- start positions: snap each corner onto the continent (deterministic
  // spiral; first cell whose 7x7 neighborhood is mostly solid land)
  const landFrac = (cx: number, cz: number) => {
    let n = 0, land = 0;
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      const x = cx + dx, z = cz + dz;
      if (!m.inB(x, z)) continue;
      n++;
      if (!m.water[z * W + x]) land++;
    }
    return n ? land / n : 0;
  };
  const snap = (c: { x: number; z: number }) => {
    if (landFrac(c.x, c.z) >= 0.85) return { ...c };
    for (let r = 1; r <= 46; r++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = c.x + dx, z = c.z + dz;
          if (x < 12 || z < 12 || x > W - 12 || z > H - 12) continue;
          if (landFrac(x, z) >= 0.85) return { x, z };
        }
    return { ...c }; // no land anywhere near — the plateau pass will make some
  };
  // start positions: maximize the minimum pairwise distance so players never
  // begin crammed together (snapping a ring to land used to collapse spawns
  // onto the same shore). Farthest-point sampling over solid-land candidates.
  const need = Math.max(2, nPlayers);
  const cand: { x: number; z: number }[] = [];
  for (let z = 14; z < H - 14; z += 4)
    for (let x = 14; x < W - 14; x += 4)
      if (landFrac(x, z) >= 0.82) cand.push({ x, z });
  let starts: { x: number; z: number }[];
  if (cand.length >= need) {
    // seed with the two farthest-apart candidates (the land's "diameter"), then
    // greedily add the point farthest from every spawn chosen so far. This
    // maximizes the minimum separation so players never start crammed together.
    let a = cand[0], b = cand[0], far = -1;
    for (let i = 0; i < cand.length; i++)
      for (let j = i + 1; j < cand.length; j++) {
        const d = (cand[i].x - cand[j].x) * (cand[i].x - cand[j].x) + (cand[i].z - cand[j].z) * (cand[i].z - cand[j].z);
        if (d > far) { far = d; a = cand[i]; b = cand[j]; }
      }
    starts = need >= 2 ? [a, b] : [a];
    while (starts.length < need) {
      let best = cand[0], bestMin = -1;
      for (const c of cand) {
        let mn = Infinity;
        for (const s of starts) { const d = (c.x - s.x) * (c.x - s.x) + (c.z - s.z) * (c.z - s.z); if (d < mn) mn = d; }
        if (mn > bestMin) { bestMin = mn; best = c; }
      }
      starts.push(best);
    }
  } else {
    // sparse-land fallback: an evenly spread ring snapped onto the continent
    const ang = (((seed >>> 7) % 1000) / 1000) * Math.PI * 2;
    const ringR = 0.4 * Math.min(W, H);
    const pos = (a: number) => snap({
      x: Math.max(14, Math.min(W - 14, Math.round(W / 2 + dcos(a) * ringR))),
      z: Math.max(14, Math.min(H - 14, Math.round(H / 2 + dsin(a) * ringR))),
    });
    starts = [];
    for (let p = 0; p < need; p++) starts.push(pos(ang + (p * 2 * Math.PI) / need));
  }
  for (let p = 0; p < need; p++) m.spawns.push({ ...starts[p] });

  // -- spawn plateaus (guaranteed buildable land). A flat core with a GENTLE
  // coastal skirt out to the edge, so the shore slopes softly into the water
  // (buildable beach, no cliff ring that blocks construction / shipyards).
  const raisePad = (s: { x: number; z: number }, R: number) => {
    const target = Math.max(SEA + 0.9, m.heightAt(s.x, s.z));
    for (let z = s.z - R; z <= s.z + R; z++) {
      for (let x = s.x - R; x <= s.x + R; x++) {
        if (x < 0 || z < 0 || x > W || z > H) continue;
        const d = Math.sqrt((x - s.x) * (x - s.x) + (z - s.z) * (z - s.z));
        if (d > R) continue;
        const u = d / R;
        const t = u < 0.55 ? 1 : smoothstep(1.0, 0.55, u); // flat inside, smooth skirt
        const i = z * (W + 1) + x;
        m.hN[i] = m.hN[i] + (target - m.hN[i]) * t;
      }
    }
    recomputeBlocked(s.x - R - 1, s.z - R - 1, s.x + R + 2, s.z + R + 2);
  };
  for (const s of starts) raisePad(s, 12);

  // -- contiguous-land guarantee: every start needs room for a real base.
  // Flood-fill the buildable area around each spawn; widen the plateau until
  // at least ~300 connected cells exist (a 17x17 base footprint).
  const floodArea = (s: { x: number; z: number }): number => {
    const seen = new Set<number>();
    const q = [s.z * W + s.x];
    seen.add(q[0]);
    let count = 0;
    while (q.length && count < 1400) {
      const i = q.pop()!;
      const cx = i % W, cz = (i / W) | 0;
      if (m.tBlocked[i]) continue;
      if (Math.abs(cx - s.x) > 22 || Math.abs(cz - s.z) > 22) continue;
      count++;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, nz = cz + dz;
        if (!m.inB(nx, nz)) continue;
        const ni = nz * W + nx;
        if (!seen.has(ni)) { seen.add(ni); q.push(ni); }
      }
    }
    return count;
  };
  for (const s of m.spawns) {
    for (const R of [14, 16, 18, 20, 22]) {
      if (floodArea(s) >= 420) break;
      raisePad(s, R);
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
      for (const s of starts)
        if ((cx - s.x) * (cx - s.x) + (cz - s.z) * (cz - s.z) < 15 * 15) { nearSpawn = true; break; }
      if (nearSpawn) continue;
      if (fbm(seed + 555, cx * 0.055, cz * 0.055) > 0.635) { m.forest[i] = 1; m.tBlocked[i] = 1; }
    }
  }

  // -- ore fields. Track patch centres and keep them a minimum distance apart
  // so fields stay distinct (don't merge into one sprawling mega-patch).
  const oreCenters: { x: number; z: number }[] = [];
  const farFromOre = (cx: number, cz: number, gap: number) => {
    for (const c of oreCenters) if ((c.x - cx) * (c.x - cx) + (c.z - cz) * (c.z - cz) < gap * gap) return false;
    return true;
  };
  const addOre = (cx: number, cz: number, r: number, amt: number) => {
    for (let z = cz - r; z <= cz + r; z++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (!m.inB(x, z) || m.blockedT(x, z)) continue;
        const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz));
        if (d > r + 0.4) continue;
        m.ore[z * W + x] = amt * (0.7 + 0.6 * rng.next());
      }
    }
    oreCenters.push({ x: cx, z: cz });
  };
  // two fields near every start (even unused ones - they become expansions)
  for (const s of starts) {
    const dx = Math.sign(W / 2 - s.x) || 1, dz = Math.sign(H / 2 - s.z) || 1;
    addOre(Math.round(s.x + dx * 10), Math.round(s.z + dz * 3 + rng.range(-3, 3)), 2, 700);
    addOre(Math.round(s.x + dx * 3 + rng.range(-3, 3)), Math.round(s.z + dz * 10), 2, 700);
  }
  // central contested fields — spaced out from every existing patch
  const MIN_GAP = 13;
  let placed = 0, tries = 0;
  const wantOre = Math.max(3, Math.round(W / 19));
  while (placed < wantOre && tries < 400) {
    tries++;
    const cx = 24 + rng.int(W - 48), cz = 24 + rng.int(H - 48);
    if (m.blockedT(cx, cz) || !farFromOre(cx, cz, MIN_GAP)) continue;
    addOre(cx, cz, 3, 900);
    placed++;
  }

  // -- special crystal fields: rare, contested, 3x value
  let gems = 0, gtries = 0;
  const wantGems = Math.max(2, Math.round(W / 44));
  while (gems < wantGems && gtries < 400) {
    gtries++;
    const cx = 20 + rng.int(W - 40), cz = 20 + rng.int(H - 40);
    if (m.blockedT(cx, cz) || !farFromOre(cx, cz, MIN_GAP)) continue;
    let farFromSpawns = true;
    for (const s of starts)
      if ((cx - s.x) * (cx - s.x) + (cz - s.z) * (cz - s.z) < 24 * 24) { farFromSpawns = false; break; }
    if (!farFromSpawns) continue;
    oreCenters.push({ x: cx, z: cz });
    for (let z = cz - 2; z <= cz + 2; z++)
      for (let x = cx - 2; x <= cx + 2; x++) {
        if (!m.inB(x, z) || m.blockedT(x, z)) continue;
        const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz));
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
