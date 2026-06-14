// A* pathfinding on the cell grid with string-pulling smoothing.
// Supports two movement domains: ground (default) and sea (ships).

import { GameMap, W, MAXD } from './map';

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const DCOST = [10, 10, 10, 10, 14, 14, 14, 14];

// Reused scratch buffers sized for the largest map (sim is single-threaded per side).
const gScore = new Int32Array(MAXD * MAXD);
const cameFrom = new Int32Array(MAXD * MAXD);
const inClosed = new Uint8Array(MAXD * MAXD);
const stampArr = new Int32Array(MAXD * MAXD);
let stamp = 0;

const heapF: number[] = [];
const heapI: number[] = [];
function heapPush(f: number, i: number) {
  heapF.push(f); heapI.push(i);
  let c = heapF.length - 1;
  while (c > 0) {
    const p = (c - 1) >> 1;
    if (heapF[p] <= heapF[c]) break;
    [heapF[p], heapF[c]] = [heapF[c], heapF[p]];
    [heapI[p], heapI[c]] = [heapI[c], heapI[p]];
    c = p;
  }
}
function heapPop(): number {
  const top = heapI[0];
  const lf = heapF.pop()!, li = heapI.pop()!;
  if (heapF.length) {
    heapF[0] = lf; heapI[0] = li;
    let p = 0;
    for (;;) {
      let s = p;
      const l = p * 2 + 1, r = l + 1;
      if (l < heapF.length && heapF[l] < heapF[s]) s = l;
      if (r < heapF.length && heapF[r] < heapF[s]) s = r;
      if (s === p) break;
      [heapF[p], heapF[s]] = [heapF[s], heapF[p]];
      [heapI[p], heapI[s]] = [heapI[s], heapI[p]];
      p = s;
    }
  }
  return top;
}

export function findPath(
  m: GameMap, sx: number, sz: number, tx: number, tz: number, maxExpand = 9000, sea = false, amphi = false, crawl = false
): { x: number; z: number }[] | null {
  const ok = crawl
    ? (cx: number, cz: number) => m.passableCrawler(cx, cz)
    : amphi
      ? (cx: number, cz: number) => m.passableAmphi(cx, cz)
      : sea
        ? (cx: number, cz: number) => m.passableSea(cx, cz)
        : (cx: number, cz: number) => m.passable(cx, cz);
  const lineClear = (x0: number, z0: number, x1: number, z1: number): boolean => {
    const d = Math.sqrt((x1 - x0) ** 2 + (z1 - z0) ** 2);
    const steps = Math.max(1, Math.ceil(d / 0.25));
    let pcx = Math.floor(x0), pcz = Math.floor(z0);
    if (!ok(pcx, pcz)) return false;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const cx = Math.floor(x0 + (x1 - x0) * t), cz = Math.floor(z0 + (z1 - z0) * t);
      if (cx === pcx && cz === pcz) continue;
      if (!ok(cx, cz)) return false;
      // a diagonal cell change must not squeeze past a blocked corner — matches the
      // A* no-corner-cutting rule so units can't slip through wall joins/corners
      if (cx !== pcx && cz !== pcz && (!ok(pcx, cz) || !ok(cx, pcz))) return false;
      pcx = cx; pcz = cz;
    }
    return true;
  };
  const nearestOk = (cx: number, cz: number, maxR: number): { x: number; z: number } | null => {
    if (ok(cx, cz)) return { x: cx, z: cz };
    for (let r = 1; r <= maxR; r++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (ok(cx + dx, cz + dz)) return { x: cx + dx, z: cz + dz };
        }
    return null;
  };

  let scx = Math.floor(sx), scz = Math.floor(sz);
  if (!ok(scx, scz)) {
    const n = nearestOk(scx, scz, 4);
    if (!n) return null;
    scx = n.x; scz = n.z;
  }
  let tcx = Math.floor(tx), tcz = Math.floor(tz);
  if (!ok(tcx, tcz)) {
    const n = nearestOk(tcx, tcz, 14);
    if (!n) return null;
    tcx = n.x; tcz = n.z;
  }

  if (lineClear(sx, sz, tcx + 0.5, tcz + 0.5)) return [{ x: tcx + 0.5, z: tcz + 0.5 }];

  stamp++;
  heapF.length = 0; heapI.length = 0;
  const sIdx = scz * W + scx, tIdx = tcz * W + tcx;
  gScore[sIdx] = 0; stampArr[sIdx] = stamp; cameFrom[sIdx] = -1; inClosed[sIdx] = 0;
  heapPush(0, sIdx);
  let found = false;
  let expand = 0;

  while (heapF.length && expand < maxExpand) {
    const cur = heapPop();
    if (cur === tIdx) { found = true; break; }
    if (stampArr[cur] === stamp && inClosed[cur]) continue;
    inClosed[cur] = 1;
    expand++;
    const cx = cur % W, cz = (cur / W) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k], nz = cz + DZ[k];
      if (!ok(nx, nz)) continue;
      if (k >= 4 && (!ok(cx + DX[k], cz) || !ok(cx, cz + DZ[k]))) continue; // no corner cutting
      const ni = nz * W + nx;
      const ng = gScore[cur] + DCOST[k];
      if (stampArr[ni] === stamp && (inClosed[ni] || gScore[ni] <= ng)) continue;
      if (stampArr[ni] !== stamp) { stampArr[ni] = stamp; inClosed[ni] = 0; }
      gScore[ni] = ng;
      cameFrom[ni] = cur;
      const ddx = Math.abs(nx - tcx), ddz = Math.abs(nz - tcz);
      heapPush(ng + 10 * Math.max(ddx, ddz) + 4 * Math.min(ddx, ddz), ni);
    }
  }
  if (!found) return null;

  const raw: { x: number; z: number }[] = [];
  let cur = tIdx;
  while (cur !== -1 && raw.length < 600) {
    raw.push({ x: (cur % W) + 0.5, z: ((cur / W) | 0) + 0.5 });
    cur = stampArr[cur] === stamp ? cameFrom[cur] : -1;
  }
  raw.reverse();

  const out: { x: number; z: number }[] = [];
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !lineClear(raw[i].x, raw[i].z, raw[j].x, raw[j].z)) j--;
    out.push(raw[j]);
    i = j;
  }
  if (!out.length) out.push(raw[raw.length - 1]);
  return out;
}
