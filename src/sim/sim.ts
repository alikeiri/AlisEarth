// Authoritative game simulation. Fixed timestep (10 Hz), no rendering imports.
// Runs in the browser for skirmish and on the Node server for multiplayer.

import { TICK, UNITS, BUILDINGS, FACTIONS, Faction, dmgMul, AIRFIELD_CAP, UPG_MAX, upgCost, ORE_VALUE, START_CREDITS, ORE_REGEN, ORE_REGEN_CAP, TECHS } from './data';
import { GameMap, genMap, nearestPassable, nearestSea, W, H } from './map';
import { findPath } from './path';
import { RNG } from './rng';

export interface Order {
  k: string; x?: number; z?: number; tgt?: number; ox?: number; oz?: number;
  pts?: { x: number; z: number }[]; i?: number; dir?: number; loop?: boolean; // patrol route
  ban?: number[]; // harvest: ore cells proven unreachable (don't re-pick them)
  pD?: number; pT?: number; // harvest approach progress watchdog
} // kinds: move attack harvest patrol rtb flee repair road

export interface Entity {
  id: number; owner: number; type: string; b: boolean;
  x: number; z: number; px: number; pz: number;
  hp: number; maxHp: number;
  // units
  orders: Order[]; path: { x: number; z: number }[] | null; pi: number;
  cd: number; mt: number; cargo: number; cargoVal: number; repath: number;
  wx: number; wz: number; stuckT: number; mvi: number; pathFail: number; // stuck/unreachable detection
  ammo: number; // bombers: shots left this sortie (-1 = unlimited)
  stance: number; // 0 aggressive (default), 1 hold position
  lastHitBy: number; lastHitT: number; reactCd: number; // return-fire / flee reactions
  fortified: boolean; emitCd: number; ephLife: number; // drone hive + ephemeral units
  aimX?: number; aimZ?: number; // last firing target — renderer turns the unit toward it
  oreCd: number; // harvester cooldown after every reachable field proved empty/blocked
  research: { tech: string; t: number; t0: number } | null; // research lab
  // buildings
  cx: number; cz: number; size: number;
  progress: number; total: number;
  queue: { type: string; t: number; t0: number; paid?: boolean }[];
  rallyX: number; rallyZ: number; lvl: number;
  patPts: { x: number; z: number }[] | null; // building patrol route for produced units
  rpt: boolean; // repeat production: finished units re-queue themselves
  primary: boolean; // primary building of its type (new units train here)
}

export interface PlayerState {
  name: string; faction: string; fac: Faction; isAI: boolean; aiLvl: number;
  credits: number; alive: boolean;
  powerMade: number; powerUsed: number; pf: number;
  bonusCost: number; bonusIncome: number; // brutal-AI handicaps
  tech: Record<string, boolean>;          // researched technologies
  spawn: { x: number; z: number };
}

export type Cmd = any;

const FORM: { x: number; z: number }[] = [{ x: 0, z: 0 }];
for (let r = 1; r <= 3; r++) {
  const n = r * 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    FORM.push({ x: Math.cos(a) * r * 1.25, z: Math.sin(a) * r * 1.25 });
  }
}

export class Sim {
  map: GameMap;
  ents = new Map<number, Entity>();
  players: PlayerState[] = [];
  nextId = 1;
  tickN = 0;
  rng: RNG;
  events: any[] = [];
  dmgLog: any[] = [];
  aiMem: any[] = [];
  done = false;
  winner = -2;
  aiProfile: any = null; // host-provided study of past human-vs-AI games (adaptive AI)
  aiDirective: any = null; // optional LLM strategist (Claude API) high-level orders
  private aiDmg = { inf: 0, veh: 0, air: 0, sea: 0 }; // human damage to the AI, by weapon class
  private aiDealt = { inf: 0, veh: 0, air: 0, sea: 0 }; // AI damage to the human, by its own weapon class
  private aiLost = { inf: 0, veh: 0, air: 0, sea: 0 }; // AI units lost, by kind
  private aiHarvLost = 0;
  private firstHumanHit = -1;
  private reported = false;
  private grid = new Map<number, number[]>(); // spatial hash of units, cell = 2 units

  constructor(seed: number, specs: { name: string; faction: string; isAI?: boolean; aiLvl?: number }[]) {
    this.rng = new RNG(seed);
    this.map = genMap(seed, specs.length);
    specs.forEach((s, i) => {
      const fac = FACTIONS[s.faction] || FACTIONS.usa;
      const lvl = s.aiLvl ?? 1;
      this.players.push({
        name: s.name, faction: fac.id, fac, isAI: !!s.isAI, aiLvl: lvl,
        credits: START_CREDITS, alive: true, powerMade: 0, powerUsed: 0, pf: 1,
        bonusCost: s.isAI && lvl >= 3 ? 0.85 : 1,
        bonusIncome: s.isAI && lvl >= 3 ? 1.3 : 1,
        tech: {},
        spawn: this.map.spawns[i],
      });
      this.aiMem.push(null);
      this.placeStart(i);
    });
  }

  // ---------- setup ----------
  private placeStart(p: number) {
    const s = this.map.spawns[p];
    const cyd = BUILDINGS.conyard;
    const cy = this.addBuilding(p, 'conyard', Math.round(s.x - cyd.size / 2), Math.round(s.z - cyd.size / 2), true);
    const tryPlace = (type: string, offs: [number, number][]) => {
      const def = BUILDINGS[type];
      for (const [ox, oz] of offs) {
        const cx = Math.round(s.x + ox), cz = Math.round(s.z + oz);
        if (this.canPlace(p, type, cx, cz)) return this.addBuilding(p, type, cx, cz, true);
      }
      return null;
    };
    tryPlace('power', [[-6, -2], [-6, 2], [2, -6], [-2, -6], [4, 4], [-6, -6]]);
    tryPlace('refinery', [[2, 3], [3, -1], [-2, 3], [3, 2], [-6, 3], [3, -5]]);
    // refinery start includes its harvester (spawned by addBuilding for instant refineries)
    for (let i = 0; i < 3; i++) {
      const c = nearestPassable(this.map, Math.round(s.x + 2 + i), Math.round(s.z - 3));
      if (c) this.spawnUnit(p, 'rifle', c.x + 0.5, c.z + 0.5);
    }
  }

  // ---------- helpers ----------
  private newEnt(p: number, type: string, b: boolean): Entity {
    const e: Entity = {
      id: this.nextId++, owner: p, type, b,
      x: 0, z: 0, px: 0, pz: 0, hp: 1, maxHp: 1,
      orders: [], path: null, pi: 0, cd: 0, mt: 0, cargo: 0, cargoVal: 0, repath: 0,
      wx: 0, wz: 0, stuckT: 0, mvi: -9, pathFail: 0, ammo: -1, oreCd: 0,
      stance: 0, lastHitBy: 0, lastHitT: -999, reactCd: 0,
      fortified: false, emitCd: 0, ephLife: 0, research: null,
      cx: 0, cz: 0, size: 1, progress: 0, total: 1, queue: [], rallyX: -1, rallyZ: -1, lvl: 1, patPts: null, rpt: false, primary: false,
    };
    this.ents.set(e.id, e);
    return e;
  }

  spawnUnit(p: number, type: string, x: number, z: number): Entity {
    const def = UNITS[type];
    const e = this.newEnt(p, type, false);
    e.x = e.px = x; e.z = e.pz = z;
    e.maxHp = Math.round(def.hp * this.players[p].fac.hpMul);
    e.hp = e.maxHp;
    if (def.payload) e.ammo = def.payload;
    if (def.cargo) this.autoHarvest(e);
    return e;
  }

  addBuilding(p: number, type: string, cx: number, cz: number, instant: boolean): Entity {
    const def = BUILDINGS[type];
    const e = this.newEnt(p, type, true);
    e.cx = cx; e.cz = cz; e.size = def.size;
    e.x = e.px = cx + def.size / 2; e.z = e.pz = cz + def.size / 2;
    e.maxHp = Math.round(def.hp * this.players[p].fac.hpMul);
    e.total = Math.max(0.001, def.buildTime);
    e.progress = instant ? e.total : 0;
    e.hp = instant ? e.maxHp : Math.round(e.maxHp * 0.15);
    for (let z = cz; z < cz + def.size; z++)
      for (let x = cx; x < cx + def.size; x++)
        if (this.map.inB(x, z)) this.map.occ[z * W + x] = e.id;
    // nudge units standing in the footprint
    for (const u of this.ents.values()) {
      if (u.b) continue;
      const ux = Math.floor(u.x), uz = Math.floor(u.z);
      if (ux >= cx && ux < cx + def.size && uz >= cz && uz < cz + def.size) {
        const n = nearestPassable(this.map, ux, uz);
        if (n) { u.x = n.x + 0.5; u.z = n.z + 0.5; u.path = null; }
      }
    }
    if (instant && type === 'refinery') this.spawnFreeHarvester(e);
    return e;
  }

  private spawnFreeHarvester(refinery: Entity) {
    const c = nearestPassable(this.map, refinery.cx + 1, refinery.cz + refinery.size);
    if (c) this.spawnUnit(refinery.owner, 'harv', c.x + 0.5, c.z + 0.5);
  }

  canPlace(p: number, type: string, cx: number, cz: number): boolean {
    const def = BUILDINGS[type];
    if (!def) return false;
    for (let z = cz; z < cz + def.size; z++)
      for (let x = cx; x < cx + def.size; x++)
        if (!this.map.inB(x, z) || this.map.tBlocked[z * W + x] || this.map.occ[z * W + x]) return false;
    // shipyards must sit on a coast: water cells adjacent to the footprint
    if (type === 'shipyard') {
      let wn = 0;
      for (let z = cz - 1; z <= cz + def.size; z++)
        for (let x = cx - 1; x <= cx + def.size; x++)
          if (this.map.inB(x, z) && this.map.water[z * W + x]) wn++;
      if (wn < 3) return false;
    }
    // must be near an existing friendly building OR a friendly road tile
    const mx = cx + def.size / 2, mz = cz + def.size / 2;
    for (const e of this.ents.values()) {
      if (!e.b || e.owner !== p) continue;
      const d = Math.sqrt((e.x - mx) ** 2 + (e.z - mz) ** 2);
      if (d <= 11) return true;
    }
    const rr = 5; // build reach around roads
    for (let z = Math.max(0, Math.floor(mz - rr)); z < Math.min(H, mz + rr); z++)
      for (let x = Math.max(0, Math.floor(mx - rr)); x < Math.min(W, mx + rr); x++)
        if (this.map.road[z * W + x] === p + 1 && (x - mx) ** 2 + (z - mz) ** 2 <= rr * rr) return true;
    return false;
  }

  distToEnt(x: number, z: number, t: Entity): number {
    if (!t.b) return Math.sqrt((t.x - x) ** 2 + (t.z - z) ** 2);
    const qx = Math.max(t.cx, Math.min(x, t.cx + t.size));
    const qz = Math.max(t.cz, Math.min(z, t.cz + t.size));
    return Math.sqrt((qx - x) ** 2 + (qz - z) ** 2);
  }

  // ---------- commands ----------
  applyCmd(c: Cmd) {
    const pl = this.players[c.p];
    if (!pl || !pl.alive || this.done) return;

    if (c.k === 'place') {
      const def = BUILDINGS[c.type];
      if (!def || c.type === 'conyard') return;
      if (def.prereq && !this.hasBuilding(c.p, def.prereq)) return;
      if (!this.hasBuilding(c.p, 'conyard')) return;
      const cost = Math.round(def.cost * pl.fac.costMul * pl.bonusCost);
      if (pl.credits < cost || !this.canPlace(c.p, c.type, c.cx, c.cz)) return;
      pl.credits -= cost;
      this.addBuilding(c.p, c.type, c.cx, c.cz, false);
      return;
    }
    if (c.k === 'train') {
      const b = this.ents.get(c.bid); const def = UNITS[c.type];
      if (!b || !b.b || b.owner !== c.p || !def || def.builtAt !== b.type) return;
      if (def.tech && !pl.tech[def.tech]) return; // not yet researched
      if (def.internal) return;
      if (b.progress < b.total || b.queue.length >= 6) return;
      // aircraft are limited by total airfield capacity
      if (def.pad && !this.padCapacityFree(c.p)) return;
      const cost = Math.round(def.cost * pl.fac.costMul * pl.bonusCost);
      if (pl.credits < cost) return;
      pl.credits -= cost;
      b.queue.push({ type: c.type, t: def.buildTime, t0: def.buildTime });
      return;
    }
    if (c.k === 'godmode') {
      pl.credits += 50000;
      this.events.push({ e: 'cash', x: pl.spawn.x, z: pl.spawn.z });
      return;
    }
    if (c.k === 'aattack') {
      // area attack: every enemy unit and building inside the circle becomes a
      // target; each attacker works through them nearest-first until the zone
      // is cleared or the attacker dies
      const r = Math.max(1, Math.min(14, c.r || 0));
      const targets: Entity[] = [];
      for (const e of this.ents.values()) {
        if (e.owner === c.p || e.hp <= 0 || !this.players[e.owner].alive) continue;
        const d = e.b ? this.distToEnt(c.x, c.z, e) : Math.hypot(e.x - c.x, e.z - c.z);
        if (d <= r) targets.push(e);
      }
      if (!targets.length) return;
      for (const id of (c.ids || [])) {
        const u = this.ents.get(id);
        if (!u || u.b || u.owner !== c.p) continue;
        if ((UNITS[u.type]?.dmg ?? 0) <= 0) continue;
        const list = [...targets]
          .sort((a, b) => ((a.x - u.x) ** 2 + (a.z - u.z) ** 2) - ((b.x - u.x) ** 2 + (b.z - u.z) ** 2))
          .slice(0, 24);
        u.orders = list.map(t => ({ k: 'attack' as const, tgt: t.id }));
        u.path = null;
      }
      return;
    }
    if (c.k === 'surrender') {
      // white flag: scuttle everything this player owns; the normal
      // elimination flow (deaths → checkEnd) does the rest
      this.events.push({ e: 'surrender', p: c.p });
      for (const e of this.ents.values()) if (e.owner === c.p) e.hp = 0;
      return;
    }
    if (c.k === 'upg') {
      const b = this.ents.get(c.bid);
      if (!b || !b.b || b.owner !== c.p || b.type === 'conyard') return;
      if (b.progress < b.total || b.lvl >= UPG_MAX) return;
      const cost = Math.round(upgCost(b.type, b.lvl, pl.fac.costMul) * pl.bonusCost);
      if (pl.credits < cost) return;
      pl.credits -= cost;
      b.lvl++;
      b.maxHp = Math.round(b.maxHp * 1.2);
      b.hp = Math.min(b.maxHp, b.hp + Math.round(b.maxHp * 0.2));
      this.events.push({ e: 'done', x: b.x, z: b.z });
      return;
    }
    if (c.k === 'cancel') {
      // cancel the most recently queued unit of this type, full refund
      const def = UNITS[c.type];
      if (!def) return;
      let best: Entity | null = null, bestIdx = -1;
      for (const e of this.ents.values()) {
        if (!e.b || e.owner !== c.p || e.type !== def.builtAt) continue;
        for (let i = e.queue.length - 1; i >= 0; i--) {
          if (e.queue[i].type === c.type && i > bestIdx) { best = e; bestIdx = i; break; }
        }
      }
      if (best && bestIdx >= 0) {
        const removed = best.queue.splice(bestIdx, 1)[0];
        if (removed.paid !== false) pl.credits += Math.round(def.cost * pl.fac.costMul * pl.bonusCost);
      }
      return;
    }
    if (c.k === 'rally') {
      const b = this.ents.get(c.bid);
      if (b && b.b && b.owner === c.p) { b.rallyX = c.x; b.rallyZ = c.z; b.patPts = null; }
      return;
    }
    if (c.k === 'repeat') {
      const b = this.ents.get(c.bid);
      if (b && b.b && b.owner === c.p) b.rpt = !!c.on;
      return;
    }
    if (c.k === 'primary') {
      const b = this.ents.get(c.bid);
      if (!b || !b.b || b.owner !== c.p) return;
      for (const e of this.ents.values())
        if (e.b && e.owner === c.p && e.type === b.type) e.primary = (e.id === b.id);
      return;
    }
    if (c.k === 'stance') {
      for (const id of (c.ids || [])) {
        const u = this.ents.get(id);
        if (u && !u.b && u.owner === c.p) u.stance = c.stance ? 1 : 0;
      }
      return;
    }
    if (c.k === 'research') {
      const b = this.ents.get(c.bid);
      const tech = TECHS[c.tech];
      if (!b || !b.b || b.owner !== c.p || b.type !== 'lab' || b.progress < b.total || b.research) return;
      if (!tech || pl.tech[c.tech]) return;
      const rcost = Math.round(tech.cost * pl.fac.costMul * pl.bonusCost);
      if (pl.credits < rcost) return;
      pl.credits -= rcost;
      b.research = { tech: c.tech, t: tech.time, t0: tech.time };
      return;
    }
    if (c.k === 'fortify') {
      for (const id of (c.ids || [])) {
        const u = this.ents.get(id);
        if (u && !u.b && u.owner === c.p && UNITS[u.type]?.fortify) {
          u.fortified = !u.fortified;
          u.orders = []; u.path = null; u.emitCd = 2;
        }
      }
      return;
    }
    if (c.k === 'buildroad') {
      const eng = (c.ids || []).map((i: number) => this.ents.get(i))
        .filter((u: Entity | undefined): u is Entity => !!u && !u.b && u.owner === c.p && UNITS[u.type]?.road);
      for (const u of eng) {
        const ord: Order = { k: 'road', x: c.x, z: c.z };
        if (c.q) u.orders.push(ord); else { u.orders = [ord]; u.path = null; }
      }
      return;
    }
    if (c.k === 'bpatrol') {
      // building patrol route: every produced combat unit walks this beat
      const b = this.ents.get(c.bid);
      if (!b || !b.b || b.owner !== c.p || !Array.isArray(c.pts) || !c.pts.length) return;
      b.patPts = c.pts.slice(0, 24).map((p: any) => ({ x: p.x, z: p.z }));
      return;
    }
    if (c.k === 'form') {
      // per-unit slot targets along a drawn formation line; index-paired arrays
      for (let i = 0; i < (c.ids || []).length; i++) {
        const u = this.ents.get(c.ids[i]);
        if (!u || u.b || u.owner !== c.p) continue;
        if (c.xs?.[i] === undefined || c.zs?.[i] === undefined) continue;
        const ord: Order = { k: 'move', x: c.xs[i], z: c.zs[i] };
        if (c.q) u.orders.push(ord);
        else { u.orders = [ord]; u.path = null; }
      }
      return;
    }

    const units = (c.ids || [])
      .map((i: number) => this.ents.get(i))
      .filter((u: Entity | undefined): u is Entity => !!u && !u.b && u.owner === c.p);
    if (!units.length) return;

    if (c.k === 'stop') {
      for (const u of units) { u.orders = []; u.path = null; }
      return;
    }
    if (c.k === 'patrol' && Array.isArray(c.pts) && c.pts.length) {
      this.assignPatrol(units, c.pts, !!c.q);
      return;
    }
    units.forEach((u, idx) => {
      let ord: Order | null = null;
      if (c.k === 'move') {
        const o = FORM[Math.min(idx, FORM.length - 1)];
        ord = { k: 'move', x: c.x + o.x, z: c.z + o.z };
      } else if (c.k === 'attack') {
        ord = UNITS[u.type].dmg > 0 ? { k: 'attack', tgt: c.tgt } : { k: 'move', x: c.x ?? u.x, z: c.z ?? u.z };
      } else if (c.k === 'harvest') {
        if (UNITS[u.type].cargo) ord = { k: 'harvest', ox: Math.floor(c.x), oz: Math.floor(c.z) };
        else {
          const o = FORM[Math.min(idx, FORM.length - 1)];
          ord = { k: 'move', x: c.x + o.x, z: c.z + o.z };
        }
      } else if (c.k === 'repair') {
        const t2 = this.ents.get(c.tgt);
        if (!t2) return;
        if (UNITS[u.type].repair) ord = { k: 'repair', tgt: c.tgt };
        else { const o = FORM[Math.min(idx, FORM.length - 1)]; ord = { k: 'move', x: t2.x + o.x, z: t2.z + o.z }; }
      }
      if (!ord) return;
      if (c.q) u.orders.push(ord);
      else { u.orders = [ord]; u.path = null; }
    });
  }

  // Patrol assignment: a single unit (or single spot) patrols directly; a group
  // first MOVES into formation — evenly spaced along the drawn route — and only
  // then begins sweeping the full route back and forth.
  private assignPatrol(units: Entity[], rawPts: any[], q: boolean) {
    const pts = rawPts.slice(0, 32).map((p: any) => ({ x: p.x, z: p.z }));
    const loop = pts.length > 2 &&
      Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 3;
    const nearestIdx = (x: number, z: number) => {
      let bi = 0, bd = 1e9;
      for (let i = 0; i < pts.length; i++) {
        const d = (pts[i].x - x) ** 2 + (pts[i].z - z) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      return bi;
    };
    if (pts.length < 2 || units.length === 1) {
      units.forEach((u, idx) => {
        const o = FORM[Math.min(idx, FORM.length - 1)];
        const my = pts.map(p => ({ x: p.x + o.x * 0.5, z: p.z + o.z * 0.5 }));
        const ord: Order = { k: 'patrol', pts: my, i: 0, dir: 1, loop };
        if (q) u.orders.push(ord); else { u.orders = [ord]; u.path = null; }
      });
      return;
    }
    // evenly spaced arc-length slots along the route
    const segLen = [0];
    let L = 0;
    for (let i = 1; i < pts.length; i++) {
      L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      segLen.push(L);
    }
    const n = units.length;
    const slots: { x: number; z: number }[] = [];
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const s = (L * i) / (n - 1);
      while (seg < pts.length - 2 && segLen[seg + 1] < s) seg++;
      const t = (s - segLen[seg]) / Math.max(0.0001, segLen[seg + 1] - segLen[seg]);
      slots.push({
        x: pts[seg].x + (pts[seg + 1].x - pts[seg].x) * Math.min(1, t),
        z: pts[seg].z + (pts[seg + 1].z - pts[seg].z) * Math.min(1, t),
      });
    }
    // assign slots in travel order to minimize crossing
    let ax = pts[pts.length - 1].x - pts[0].x, az = pts[pts.length - 1].z - pts[0].z;
    const al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;
    const sorted = [...units].sort((a, b) => (a.x * ax + a.z * az) - (b.x * ax + b.z * az));
    sorted.forEach((u, i) => {
      const slot = slots[i];
      const mv: Order = { k: 'move', x: slot.x, z: slot.z };
      const pat: Order = { k: 'patrol', pts, i: nearestIdx(slot.x, slot.z), dir: 1, loop };
      if (q) u.orders.push(mv, pat);
      else { u.orders = [mv, pat]; u.path = null; }
    });
  }

  padCapacityFree(p: number): boolean {
    let have = 0, cap = 0;
    for (const e of this.ents.values()) {
      if (e.owner !== p) continue;
      if (!e.b && UNITS[e.type]?.pad) have++;
      if (e.b) {
        if (e.type === 'airfield' && e.progress >= e.total) cap += AIRFIELD_CAP(e.lvl);
        for (const q of e.queue) if (UNITS[q.type]?.pad) have++;
      }
    }
    return have < cap;
  }

  hasBuilding(p: number, type: string, complete = true): boolean {
    for (const e of this.ents.values())
      if (e.b && e.owner === p && e.type === type && (!complete || e.progress >= e.total)) return true;
    return false;
  }

  // ---------- main tick ----------
  tick(cmds: Cmd[]) {
    if (this.done) return;
    this.events = [];
    this.dmgLog = [];
    for (const c of cmds) this.applyCmd(c);

    // power factors
    for (const pl of this.players) { pl.powerMade = 10; pl.powerUsed = 0; }
    for (const e of this.ents.values()) {
      if (!e.b || e.progress < e.total) continue;
      const pw = BUILDINGS[e.type].power;
      const pl = this.players[e.owner];
      if (pw > 0) pl.powerMade += pw * pl.fac.powerMul * (1 + 0.5 * (e.lvl - 1));
      else pl.powerUsed -= pw;
    }
    for (const pl of this.players)
      pl.pf = pl.powerMade >= pl.powerUsed ? 1 : Math.max(0.4, pl.powerMade / Math.max(1, pl.powerUsed));

    this.rebuildGrid();

    for (const e of [...this.ents.values()]) {
      if (e.hp <= 0) continue;
      e.px = e.x; e.pz = e.z;
      if (e.b) this.tickBuilding(e);
      else this.tickUnit(e);
    }

    this.separation();
    this.deaths();

    if (this.tickN % 20 === 0) this.regrowOre();
    if (this.tickN % 10 === 0) this.checkEnd();
    this.tickN++;
  }

  private rebuildGrid() {
    this.grid.clear();
    for (const e of this.ents.values()) {
      if (e.b) continue;
      const key = (Math.floor(e.x / 2) << 8) | Math.floor(e.z / 2);
      let arr = this.grid.get(key);
      if (!arr) { arr = []; this.grid.set(key, arr); }
      arr.push(e.id);
    }
  }

  private nearbyUnits(x: number, z: number, r: number): Entity[] {
    const out: Entity[] = [];
    const c0x = Math.floor((x - r) / 2), c1x = Math.floor((x + r) / 2);
    const c0z = Math.floor((z - r) / 2), c1z = Math.floor((z + r) / 2);
    for (let gx = c0x; gx <= c1x; gx++) {
      for (let gz = c0z; gz <= c1z; gz++) {
        const arr = this.grid.get((gx << 8) | gz);
        if (!arr) continue;
        for (const id of arr) {
          const e = this.ents.get(id);
          if (e && Math.abs(e.x - x) <= r && Math.abs(e.z - z) <= r) out.push(e);
        }
      }
    }
    return out;
  }

  findDamagedFriendly(e: Entity, range: number): Entity | null {
    let best: Entity | null = null, bd = 1e9;
    for (const u of this.nearbyUnits(e.x, e.z, range)) {
      if (u.id === e.id || u.owner !== e.owner || u.hp <= 0 || u.hp >= u.maxHp) continue;
      const d = this.distToEnt(e.x, e.z, u);
      if (d < bd) { bd = d; best = u; }
    }
    for (const u of this.ents.values()) {
      if (!u.b || u.owner !== e.owner || u.hp <= 0 || u.hp >= u.maxHp || u.progress < u.total) continue;
      const d = this.distToEnt(e.x, e.z, u);
      if (d <= range && d < bd) { bd = d; best = u; }
    }
    return best;
  }

  private findEnemy(e: Entity, range: number, skipAir = false): Entity | null {
    let best: Entity | null = null, bd = 1e9;
    for (const u of this.nearbyUnits(e.x, e.z, range + 1)) {
      if (u.owner === e.owner || u.hp <= 0 || !this.players[u.owner].alive) continue;
      const d = this.distToEnt(e.x, e.z, u);
      if (UNITS[u.type]?.cloak && d > 4) continue; // stealth: only seen up close
      // never auto-lock onto air targets the attacker cannot hurt (turret, MLRS)
      if (UNITS[u.type]?.fly && (skipAir || dmgMul(e.type, false, 'air', u.type) <= 0)) continue;
      if (d <= range && d < bd) { bd = d; best = u; }
    }
    if (best) return best;
    // buildings (few — linear scan)
    for (const u of this.ents.values()) {
      if (!u.b || u.owner === e.owner || u.hp <= 0 || !this.players[u.owner].alive) continue;
      const d = this.distToEnt(e.x, e.z, u);
      if (d <= range && d < bd) { bd = d; best = u; }
    }
    return best;
  }

  private dealDamage(att: Entity, tgt: Entity, base: number) {
    let mul = dmgMul(att.type, tgt.b, tgt.b ? 'b' : UNITS[tgt.type].kind, tgt.b ? undefined : tgt.type);
    if (!tgt.b && tgt.fortified) mul *= 0.5; // dug-in drone hive is hard to kill
    tgt.hp -= base * mul;
    // study material for the adaptive AI: what weapon classes the human leans
    // on, and which of the AI's own weapon classes actually pay off
    const ap = this.players[att.owner], vp = this.players[tgt.owner];
    if (ap && vp && !ap.isAI && vp.isAI && !att.b) {
      const k = UNITS[att.type]?.kind as keyof typeof this.aiDmg;
      if (k && this.aiDmg[k] !== undefined) this.aiDmg[k] += base * mul;
      if (this.firstHumanHit < 0) this.firstHumanHit = this.tickN;
    } else if (ap && vp && ap.isAI && !vp.isAI && !att.b) {
      const k = UNITS[att.type]?.kind as keyof typeof this.aiDealt;
      if (k && this.aiDealt[k] !== undefined) this.aiDealt[k] += base * mul;
    }
    if (!tgt.b) { tgt.lastHitBy = att.id; tgt.lastHitT = this.tickN; } // for return-fire / flee
    this.dmgLog.push({ vOwner: tgt.owner, victim: tgt.id, by: att.id, x: tgt.x, z: tgt.z, b: tgt.b });
  }

  private fire(att: Entity, tgt: Entity, dmg: number, rof: number): boolean {
    if (att.cd > 0) return false;
    att.cd = rof;
    att.aimX = tgt.x; att.aimZ = tgt.z;
    this.dealDamage(att, tgt, dmg);
    const ud = UNITS[att.type];
    // weapon class: 0 mg, 1 rocket, 2 cannon, 3 drone zap, 4 missile salvo
    const tgtInf = !tgt.b && UNITS[tgt.type]?.kind === 'inf';
    const w = att.type === 'rifle' || att.type === 'ifv' || att.type === 'flak' ? 0
      : att.type === 'rocket' || att.type === 'sam' || att.type === 'aatank' ? 1
      : att.type === 'mlrs' || att.type === 'msldrone' ? 4
      : att.type === 'heli' || att.type === 'helidrone' ? (tgtInf ? 0 : 1) // guns vs inf, rockets vs veh/bld
      : ud?.kind === 'air' ? 3 : 2;
    const ev: any = { e: 'shot', x: att.x, z: att.z, tx: tgt.x, tz: tgt.z, w };
    if (ud?.fly) ev.f = 1;
    this.events.push(ev);
  }

  // ---------- buildings ----------
  private tickBuilding(b: Entity) {
    const pl = this.players[b.owner];
    const def = BUILDINGS[b.type];
    const rate = pl.fac.buildMul * pl.pf;

    if (b.progress < b.total) {
      const d = TICK * rate;
      b.progress = Math.min(b.total, b.progress + d);
      b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.85 * (d / b.total));
      if (b.progress >= b.total) {
        this.events.push({ e: 'done', x: b.x, z: b.z });
        if (b.type === 'refinery') this.spawnFreeHarvester(b);
      }
      return;
    }

    // research lab progresses one technology at a time
    if (b.research) {
      b.research.t -= TICK * rate;
      if (b.research.t <= 0) {
        pl.tech[b.research.tech] = true;
        this.events.push({ e: 'done', x: b.x, z: b.z });
        this.events.push({ e: 'tech', p: b.owner, tech: b.research.tech });
        b.research = null;
      }
    }

    if (b.queue.length) {
      const it = b.queue[0];
      // repeat-queued items are paid when they reach the front; stall if broke
      if (it.paid === false) {
        const uc = Math.round(UNITS[it.type].cost * pl.fac.costMul * pl.bonusCost);
        if (pl.credits >= uc) { pl.credits -= uc; it.paid = true; }
        else return;
      }
      it.t -= TICK * rate * (1 + 0.25 * (b.lvl - 1)); // upgrades speed up production
      if (it.t <= 0) {
        const c = UNITS[it.type].move === 'sea'
          ? nearestSea(this.map, b.cx + ((b.size / 2) | 0), b.cz + b.size, 8)
          : nearestPassable(this.map, b.cx + ((b.size / 2) | 0), b.cz + b.size);
        if (c) {
          const u = this.spawnUnit(b.owner, it.type, c.x + 0.5, c.z + 0.5);
          if (!UNITS[it.type].cargo && b.patPts && b.patPts.length) {
            // building patrol route: new combat units walk the designated beat
            this.assignPatrol([u], b.patPts, false);
          } else if (b.rallyX >= 0) {
            if (UNITS[it.type].cargo) {
              // rally on/near ore: new harvesters mine that field specifically
              const ord: Order = { k: 'harvest', ox: Math.floor(b.rallyX), oz: Math.floor(b.rallyZ) };
              const n = this.findOreNear(ord);
              if (n) { ord.ox = n.x; ord.oz = n.z; u.orders = [ord]; }
              else u.orders = [{ k: 'move', x: b.rallyX, z: b.rallyZ }];
            } else {
              u.orders = [{ k: 'move', x: b.rallyX, z: b.rallyZ }];
            }
          }
          b.queue.shift();
          this.events.push({ e: 'ready', p: b.owner });
          // repeat production: finished unit re-queues itself (charged on start)
          if (b.rpt && b.queue.length < 6) {
            const rdef = UNITS[it.type];
            if (!rdef.pad || this.padCapacityFree(b.owner))
              b.queue.push({ type: it.type, t: rdef.buildTime, t0: rdef.buildTime, paid: false });
          }
        } else it.t = 1; // exit blocked, retry shortly
      }
    }

    if (def.attack && this.tickN % 5 === b.id % 5) {
      // turret acquires targets periodically; fires every tick via cd
    }
    if (def.attack) {
      b.cd -= TICK;
      const tgt = this.findEnemy(b, def.attack.range + 0.8 * (b.lvl - 1), b.type === 'turret');
      if (tgt) this.fire(b, tgt, def.attack.dmg * (1 + 0.25 * (b.lvl - 1)), def.attack.rof / pl.pf);
    }
  }

  // ---------- units ----------
  private tickUnit(u: Entity) {
    const def = UNITS[u.type];
    u.cd -= TICK;

    // ephemeral units (mini drones) self-destruct after their lifetime
    if (def.ephemeral) {
      u.ephLife += TICK;
      if (u.ephLife >= def.ephemeral) { u.hp = 0; return; }
    }

    // fortified drone hive: stationary, emits mini drones, ignores move orders
    if (def.fortify && u.fortified) {
      u.orders = u.orders.filter(o => o.k === 'fortify');
      u.emitCd -= TICK;
      if (u.emitCd <= 0) {
        u.emitCd = 7;
        const c = nearestPassable(this.map, Math.floor(u.x), Math.floor(u.z));
        if (c && def.emits) {
          const d = this.spawnUnit(u.owner, def.emits, c.x + 0.5, c.z + 0.5);
          d.stance = 0; // aggressive: auto-hunts nearby enemies
        }
      }
      // also fire back if it has a weapon (hives don't, but future-proof)
      return;
    }

    // stuck detection: tried to move last tick but went nowhere → wiggle out
    if (!def.fly) {
      const movedSq = (u.x - u.wx) ** 2 + (u.z - u.wz) ** 2;
      if (u.mvi === this.tickN - 1 && movedSq < 0.0012) u.stuckT += TICK;
      else u.stuckT = 0;
      u.wx = u.x; u.wz = u.z;
      if (u.stuckT >= 1.0) {
        u.stuckT = 0;
        u.path = null; // force a replan
        const a0 = this.rng.int(8);
        const sea = def.move === 'sea';
        for (let k = 0; k < 8; k++) {
          const a = ((a0 + k) & 7) * 0.7854;
          const nx = u.x + Math.cos(a) * 0.7, nz = u.z + Math.sin(a) * 0.7;
          const okC = sea ? this.map.passableSea(Math.floor(nx), Math.floor(nz))
            : this.map.passable(Math.floor(nx), Math.floor(nz));
          if (okC) { u.x = nx; u.z = nz; break; }
        }
      }
    }

    // ---- stance reactions (run even mid-order) ----
    if (u.reactCd > 0) u.reactCd--;
    const recentlyHit = this.tickN - u.lastHitT < 30;
    if (def.dmg > 0) {
      const cur = u.orders[0];
      const busy = cur && (cur.k === 'attack' || cur.k === 'patrol');
      if (u.stance === 1) {
        // HOLD: never move for combat; fire only at enemies already in range
        if (!busy && u.cd <= 0 && this.tickN % 3 === u.id % 3) {
          const tgt = this.findEnemy(u, def.range);
          if (tgt) this.fire(u, tgt, def.dmg, def.rof);
        }
      } else {
        // AGGRESSIVE: return fire when hit, and auto-engage enemies in sight
        if (recentlyHit && !busy && this.ents.has(u.lastHitBy)) {
          u.orders.unshift({ k: 'attack', tgt: u.lastHitBy }); u.path = null;
        } else if (!u.orders.length && this.tickN % 5 === u.id % 5) {
          const tgt = this.findEnemy(u, def.range + 2.5); // chase enemies in sight
          if (tgt) u.orders.unshift({ k: 'attack', tgt: tgt.id });
        }
      }
    } else if (recentlyHit && u.reactCd <= 0 && this.ents.has(u.lastHitBy)) {
      // defenceless (harvester/engineer): flee away from the attacker
      const att = this.ents.get(u.lastHitBy)!;
      const dx = u.x - att.x, dz = u.z - att.z;
      const d = Math.hypot(dx, dz) || 1;
      const fx = Math.max(1, Math.min(W - 1, u.x + (dx / d) * 9));
      const fz = Math.max(1, Math.min(H - 1, u.z + (dz / d) * 9));
      u.orders = [{ k: 'move', x: fx, z: fz }];
      if (def.cargo) u.orders.push({ k: 'harvest', ox: Math.floor(u.x), oz: Math.floor(u.z) }); // resume after
      u.path = null;
      u.reactCd = 25; // don't re-flee every tick
    }

    // idle harvesters resume mining on their own (classic C&C behavior) —
    // unless they recently proved every reachable field is a dead end
    if (def.cargo && !u.orders.length && this.tickN % 20 === u.id % 20) {
      if (u.oreCd > 0) u.oreCd -= 20;
      else this.autoHarvest(u);
    }
    // idle engineers look for something to fix
    if (def.repair && !u.orders.length && this.tickN % 5 === u.id % 5) {
      const t = this.findDamagedFriendly(u, 9);
      if (t) u.orders.unshift({ k: 'repair', tgt: t.id });
    }

    // moving ground vehicles crush enemy infantry under their treads
    if (def.kind === 'veh' && u.mvi >= this.tickN - 1) {
      for (const o of this.nearbyUnits(u.x, u.z, 0.7)) {
        if (o.owner === u.owner || o.hp <= 0) continue;
        if (UNITS[o.type]?.kind !== 'inf') continue;
        if ((o.x - u.x) ** 2 + (o.z - u.z) ** 2 > 0.42) continue;
        this.dealDamage(u, o, 9999);
        this.events.push({ e: 'crush', x: o.x, z: o.z });
      }
    }

    const ord = u.orders[0];
    if (!ord) return;

    if (ord.k === 'move') {
      if (this.moveToward(u, ord.x!, ord.z!, def)) { u.orders.shift(); u.path = null; }
    } else if (ord.k === 'road') {
      // engineer paves the cell it stands on, then drives to the target
      const ci = Math.floor(u.z) * W + Math.floor(u.x);
      if (this.map.road[ci] !== u.owner + 1 && !this.map.tBlocked[ci]) {
        this.map.road[ci] = u.owner + 1; this.map.roadDirty = true;
      }
      if (this.moveToward(u, ord.x!, ord.z!, def)) { u.orders.shift(); u.path = null; }
    } else if (ord.k === 'repair') {
      const t = this.ents.get(ord.tgt!);
      if (!t || t.hp <= 0 || t.owner !== u.owner || t.hp >= t.maxHp) { u.orders.shift(); u.path = null; return; }
      const d = this.distToEnt(u.x, u.z, t);
      if (d <= 1.8) {
        u.path = null;
        t.hp = Math.min(t.maxHp, t.hp + 14 * TICK);
        if (this.tickN % 10 === u.id % 10) this.events.push({ e: 'heal', x: t.x, z: t.z });
      } else this.moveToward(u, t.x, t.z, def);
    } else if (ord.k === 'rtb') {
      // bomber returns to the nearest airfield (plant as fallback), rearms,
      // then resumes the attack order waiting beneath this one
      let pad: Entity | null = null, bs = 1e9;
      for (const e of this.ents.values()) {
        if (!e.b || e.owner !== u.owner || e.progress < e.total) continue;
        if (e.type !== 'airfield' && e.type !== 'airforce') continue;
        const score = this.distToEnt(u.x, u.z, e) + (e.type === 'airforce' ? 1000 : 0);
        if (score < bs) { bs = score; pad = e; }
      }
      if (!pad) { u.mt = 0; return; } // nowhere to land — hold
      const d = this.distToEnt(u.x, u.z, pad);
      if (d > 1.8) { u.mt = 0; this.moveToward(u, pad.x, pad.z, def); }
      else {
        u.path = null;
        u.mt += TICK;
        if (u.mt >= 6) { // rearm complete
          u.mt = 0;
          u.ammo = def.payload || -1;
          u.orders.shift();
        }
      }
    } else if (ord.k === 'patrol') {
      // defensive stance: engage anything in this unit's vicinity, resume after
      if (def.dmg > 0 && this.tickN % 5 === u.id % 5) {
        const tgt = this.findEnemy(u, def.range + 4);
        if (tgt) { u.path = null; u.orders.unshift({ k: 'attack', tgt: tgt.id }); return; }
      }
      // patrolling engineers fix anything damaged along the route
      if (def.repair && this.tickN % 5 === u.id % 5) {
        const t = this.findDamagedFriendly(u, 8);
        if (t) { u.path = null; u.orders.unshift({ k: 'repair', tgt: t.id }); return; }
      }
      const pts = ord.pts || [];
      if (!pts.length) { u.orders.shift(); return; }
      const cur = pts[Math.min(ord.i || 0, pts.length - 1)];
      if (this.moveToward(u, cur.x, cur.z, def) && pts.length > 1) {
        u.path = null;
        if (ord.loop) ord.i = ((ord.i || 0) + 1) % pts.length;
        else {
          let ni = (ord.i || 0) + (ord.dir || 1);
          if (ni >= pts.length || ni < 0) { ord.dir = -(ord.dir || 1); ni = (ord.i || 0) + ord.dir!; }
          ord.i = ni;
        }
      }
      // single point: arrived units simply hold position on guard
    } else if (ord.k === 'attack') {
      const tgt = this.ents.get(ord.tgt!);
      if (!tgt || tgt.hp <= 0) { u.orders.shift(); u.path = null; return; }
      // patrolling units break off the chase if it drags them too far from the route
      if (u.orders[1]?.k === 'patrol' && this.tickN % 10 === u.id % 10) {
        const pp = u.orders[1].pts || [];
        let nearSq = 1e9;
        for (const q of pp) nearSq = Math.min(nearSq, (q.x - u.x) ** 2 + (q.z - u.z) ** 2);
        if (nearSq > 256) { u.orders.shift(); u.path = null; return; }
      }
      const d = this.distToEnt(u.x, u.z, tgt);
      const speed = def.speed * this.players[u.owner].fac.speedMul;
      if (def.kamikaze) {
        // one-way suicide drone: dive straight at the target, detonate on contact
        if (d <= 0.9) {
          this.dealDamage(u, tgt, def.dmg);
          this.events.push({ e: 'boom', x: tgt.x, z: tgt.z, big: true });
          u.hp = 0;
          return;
        }
        u.path = [{ x: tgt.x, z: tgt.z }]; u.pi = 0;
        this.stepPath(u, speed * 1.3, 1); // terminal dive — faster than cruise
        return;
      }
      // bombers fly OVER the target, release the whole stick once (area
      // damage), then turn for home — no hovering in front of buildings
      if (u.type === 'bomber' || u.type === 'dbomber') {
        if (u.ammo <= 0) { u.orders.unshift({ k: 'rtb' }); return; }
        if (d <= 1.4) {
          this.bombDrop(u, tgt);
          u.orders.unshift({ k: 'rtb' }); // rearm, then resume this attack order
          return;
        }
        u.path = [{ x: tgt.x, z: tgt.z }]; u.pi = 0;
        this.stepPath(u, speed, 1);
        return;
      }
      if (d <= def.range) {
        u.path = null;
        if (def.payload && u.ammo <= 0) { u.orders.unshift({ k: 'rtb' }); return; }
        if (this.fire(u, tgt, def.dmg, def.rof) && def.payload) {
          u.ammo--;
          if (u.ammo <= 0) u.orders.unshift({ k: 'rtb' }); // payload spent — fly home to rearm
        }
      } else {
        u.repath -= 1;
        if (!u.path || u.repath <= 0) {
          u.path = def.fly ? [{ x: tgt.x, z: tgt.z }]
            : findPath(this.map, u.x, u.z, tgt.x, tgt.z, 9000, def.move === 'sea');
          u.pi = 0; u.repath = 12;
          // unreachable target (across water / walled in): abandon instead of
          // thrashing a failed 9000-node A* search every few ticks
          if (!u.path && !def.fly) {
            if (++u.pathFail >= 3) { u.orders.shift(); u.path = null; u.pathFail = 0; return; }
            u.repath = 40;
          } else u.pathFail = 0;
        }
        this.stepPath(u, speed, def.fly ? 1 : def.move === 'sea' ? 2 : 0);
      }
    } else if (ord.k === 'harvest') {
      this.tickHarvest(u, ord, def);
    }
  }

  // carpet release: the full remaining payload detonates around the target
  // with linear falloff — splash hits every enemy in the blast radius
  private bombDrop(u: Entity, tgt: Entity) {
    const def = UNITS[u.type];
    const total = def.dmg * Math.max(1, u.ammo);
    const R = 2.6;
    for (const e of [...this.ents.values()]) {
      if (e.owner === u.owner || e.hp <= 0 || !this.players[e.owner].alive) continue;
      const dist = e.b ? this.distToEnt(tgt.x, tgt.z, e) : Math.hypot(e.x - tgt.x, e.z - tgt.z);
      if (dist > R) continue;
      this.dealDamage(u, e, total * (1 - 0.5 * (dist / R)));
    }
    u.ammo = 0;
    this.events.push({ e: 'boom', x: tgt.x, z: tgt.z, big: true });
  }

  private tickHarvest(u: Entity, ord: Order, def: any) {
    const cap = def.cargo as number;
    const pl = this.players[u.owner];

    if (u.cargo >= cap || (u.cargo > 0 && this.map.ore[ord.oz! * W + ord.ox!] <= 0 && !this.findOreNear(ord))) {
      // deliver
      let ref: Entity | null = null, bd = 1e9;
      for (const e of this.ents.values()) {
        if (e.b && e.owner === u.owner && e.type === 'refinery' && e.progress >= e.total) {
          const d = this.distToEnt(u.x, u.z, e);
          if (d < bd) { bd = d; ref = e; }
        }
      }
      if (!ref) { u.path = null; return; } // wait for a refinery
      if (bd <= 1.6) {
        pl.credits += Math.round(u.cargoVal * pl.fac.incomeMul * pl.bonusIncome * (1 + 0.1 * (ref.lvl - 1)));
        u.cargo = 0; u.cargoVal = 0;
        this.events.push({ e: 'cash', x: ref.x, z: ref.z });
      } else {
        this.moveToward(u, ref.x, ref.z + ref.size / 2 + 0.5, def);
      }
      return;
    }

    // ensure ore at target
    if (this.map.ore[ord.oz! * W + ord.ox!] <= 0) {
      const n = this.findOreNear(ord);
      if (!n) { if (u.cargo > 0) { /* deliver branch next tick */ } else u.orders.shift(); return; }
      ord.ox = n.x; ord.oz = n.z;
      u.path = null;
    }
    const tx = ord.ox! + 0.5, tz = ord.oz! + 0.5;
    const d = Math.sqrt((u.x - tx) ** 2 + (u.z - tz) ** 2);
    if (d > 1.2) {
      const done = this.moveToward(u, tx, tz, def);
      // two unreachable signals: pathfinder gave up while we're far away, or
      // we've made no approach progress for 3s (pathfinder snapped the target
      // to a shore cell and we're pacing there). Ban the field and retarget
      // instead of replanning forever and wiggling in place.
      if (d < (ord.pD ?? 1e9) - 0.5) { ord.pD = d; ord.pT = 0; }
      else ord.pT = (ord.pT ?? 0) + TICK;
      if ((done && d > 2.5) || (ord.pT ?? 0) > 3) {
        ord.pD = 1e9; ord.pT = 0;
        ord.ban = ord.ban || [];
        ord.ban.push(ord.oz! * W + ord.ox!);
        const n = ord.ban.length <= 6 ? this.findOreNear(ord) : null;
        if (n) { ord.ox = n.x; ord.oz = n.z; u.path = null; }
        else { u.orders.shift(); u.path = null; u.oreCd = 200; } // nothing reachable — rest 20s
      }
    } else {
      u.mt += TICK;
      if (u.mt >= 0.5) {
        u.mt = 0;
        const i = ord.oz! * W + ord.ox!;
        const take = Math.min(45, this.map.ore[i], cap - u.cargo);
        this.map.ore[i] -= take;
        u.cargo += take;
        u.cargoVal += take * ORE_VALUE * (this.map.gem[i] === 1 ? 3 : 1); // crystal fields pay triple
        if (this.map.ore[i] <= 0) this.map.ore[i] = 0;
        this.map.oreDirty = true;
        this.events.push({ e: 'ore', i, v: Math.round(this.map.ore[i]) });
      }
    }
  }

  private scanOre(ox: number, oz: number, R: number, ban?: Set<number>): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null, bd = 1e9;
    for (let z = Math.max(0, oz - R); z < Math.min(H, oz + R); z++) {
      for (let x = Math.max(0, ox - R); x < Math.min(W, ox + R); x++) {
        if (this.map.ore[z * W + x] > 0 && !(ban && ban.has(z * W + x))) {
          const d = (x - ox) ** 2 + (z - oz) ** 2;
          if (d < bd) { bd = d; best = { x, z }; }
        }
      }
    }
    return best;
  }

  private findOreNear(ord: Order): { x: number; z: number } | null {
    // try locally first, then anywhere on the map — harvesters should never
    // sit idle just because the nearest field is far away
    const ban = ord.ban && ord.ban.length ? new Set(ord.ban) : undefined;
    return this.scanOre(ord.ox!, ord.oz!, 22, ban) || this.scanOre(ord.ox!, ord.oz!, Math.max(W, H), ban);
  }

  autoHarvest(u: Entity) {
    const ord: Order = { k: 'harvest', ox: Math.floor(u.x), oz: Math.floor(u.z) };
    const n = this.findOreNear(ord);
    if (n) { ord.ox = n.x; ord.oz = n.z; u.orders = [ord]; }
  }

  // returns true when arrived
  private moveToward(u: Entity, x: number, z: number, def: any): boolean {
    const d = Math.sqrt((u.x - x) ** 2 + (u.z - z) ** 2);
    if (d < 0.25) return true;
    const speed = def.speed * this.players[u.owner].fac.speedMul;
    if (def.fly) {
      // flyers travel in a straight line over anything
      const end = u.path?.[u.path.length - 1];
      if (!u.path || !end || (end.x - x) ** 2 + (end.z - z) ** 2 > 1) {
        u.path = [{ x, z }];
        u.pi = 0;
      }
      return this.stepPath(u, speed, 1);
    }
    const sea = def.move === 'sea';
    if (!u.path || u.pi >= u.path.length) {
      const end = u.path?.[u.path.length - 1];
      if (!end || (end.x - x) ** 2 + (end.z - z) ** 2 > 1) {
        u.path = findPath(this.map, u.x, u.z, x, z, 9000, sea);
        u.pi = 0;
        if (!u.path) return true; // unreachable — give up
      } else if (u.pi >= u.path.length) return true;
    }
    return this.stepPath(u, speed, sea ? 2 : 0);
  }

  // mode: 0 ground, 1 air, 2 sea
  private stepPath(u: Entity, speed: number, mode = 0): boolean {
    if (!u.path || u.pi >= u.path.length) return true;
    const wp = u.path[u.pi];
    let dx = wp.x - u.x, dz = wp.z - u.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 0.2) {
      u.pi++;
      if (u.pi >= u.path.length) { u.path = null; return true; }
      return false;
    }
    u.mvi = this.tickN; // attempted to move this tick (stuck detection)
    const step = Math.min(d, speed * TICK);
    dx = (dx / d) * step; dz = (dz / d) * step;
    const nx = u.x + dx, nz = u.z + dz;
    if (mode === 1) {
      u.x = Math.max(0.5, Math.min(W - 0.5, nx));
      u.z = Math.max(0.5, Math.min(H - 0.5, nz));
    } else {
      const okCell = mode === 2
        ? this.map.passableSea(Math.floor(nx), Math.floor(nz))
        : this.map.passable(Math.floor(nx), Math.floor(nz));
      if (okCell) { u.x = nx; u.z = nz; }
      else { u.path = null; } // blocked — replan next tick
    }
    return false;
  }

  private separation() {
    for (const e of this.ents.values()) {
      if (e.b) continue;
      const ef = !!UNITS[e.type].fly;
      for (const o of this.nearbyUnits(e.x, e.z, 0.8)) {
        if (o.id <= e.id || o.b) continue;
        if (!!UNITS[o.type].fly !== ef) continue; // air and ground don't collide
        let dx = e.x - o.x, dz = e.z - o.z;
        let d = Math.sqrt(dx * dx + dz * dz);
        if (d > 0.7) continue;
        if (d < 0.01) { dx = ((e.id % 7) - 3) * 0.01 || 0.01; dz = 0.01; d = Math.sqrt(dx * dx + dz * dz); }
        const push = (0.7 - d) * 0.25;
        const px = (dx / d) * push, pz = (dz / d) * push;
        if (this.map.passable(Math.floor(e.x + px), Math.floor(e.z + pz))) { e.x += px; e.z += pz; }
        if (this.map.passable(Math.floor(o.x - px), Math.floor(o.z - pz))) { o.x -= px; o.z -= pz; }
      }
    }
  }

  private deaths() {
    for (const e of [...this.ents.values()]) {
      if (e.hp > 0) continue;
      this.ents.delete(e.id);
      if (e.b) {
        for (let z = e.cz; z < e.cz + e.size; z++)
          for (let x = e.cx; x < e.cx + e.size; x++)
            if (this.map.inB(x, z) && this.map.occ[z * W + x] === e.id) this.map.occ[z * W + x] = 0;
        this.events.push({ e: 'boom', x: e.x, z: e.z, big: true });
      } else {
        this.events.push({ e: 'boom', x: e.x, z: e.z, big: false });
        // AI casualty ledger (drives the next game's unit-mix preferences)
        if (this.players[e.owner]?.isAI) {
          const k = UNITS[e.type]?.kind as keyof typeof this.aiLost;
          if (k && this.aiLost[k] !== undefined && !UNITS[e.type]?.internal) this.aiLost[k]++;
          if (e.type === 'harv') this.aiHarvLost++;
        }
      }
    }
  }

  // Red Alert–style slow ore regrowth: depleted fields creep back toward a
  // fraction of their original value, so map control matters over time.
  private regrowOre() {
    const add = ORE_REGEN * (2.0); // called every 2s
    let changed = false;
    const ore = this.map.ore, max = this.map.oreMax;
    for (let i = 0; i < ore.length; i++) {
      const cap = max[i] * ORE_REGEN_CAP;
      if (cap <= 0 || ore[i] >= cap) continue;
      ore[i] = Math.min(cap, ore[i] + add);
      changed = true;
    }
    if (changed) this.map.oreDirty = true; // renderer redraws on this flag
  }

  private checkEnd() {
    let nAlive = 0, lastAlive = -1;
    this.players.forEach((pl, i) => {
      if (!pl.alive) return;
      let has = false;
      for (const e of this.ents.values()) if (e.b && e.owner === i) { has = true; break; }
      if (!has) { pl.alive = false; this.events.push({ e: 'elim', p: i }); }
      else { nAlive++; lastAlive = i; }
    });
    if (this.players.length > 1 && nAlive <= 1) {
      this.done = true;
      this.winner = lastAlive;
      // hand the host a study report so the AI can adapt next game
      const hasHuman = this.players.some(pl => !pl.isAI);
      const hasAI = this.players.some(pl => pl.isAI);
      if (!this.reported && hasHuman && hasAI) {
        this.reported = true;
        this.events.push({
          e: 'aiReport',
          r: {
            aiWon: this.winner >= 0 ? !!this.players[this.winner].isAI : false,
            rushSec: this.firstHumanHit > 0 ? Math.round(this.firstHumanHit / 10) : 0,
            dmg: {
              inf: Math.round(this.aiDmg.inf), veh: Math.round(this.aiDmg.veh),
              air: Math.round(this.aiDmg.air), sea: Math.round(this.aiDmg.sea),
            },
            dealt: {
              inf: Math.round(this.aiDealt.inf), veh: Math.round(this.aiDealt.veh),
              air: Math.round(this.aiDealt.air), sea: Math.round(this.aiDealt.sea),
            },
            lost: { ...this.aiLost },
            harvLost: this.aiHarvLost,
            len: Math.round(this.tickN / 10),
          },
        });
      }
    }
  }

  // ---------- snapshot (for net + local view) ----------
  snapshot() {
    const ents: any[] = [];
    for (const e of this.ents.values()) {
      const v: any = {
        i: e.id, o: e.owner, t: e.type, b: e.b ? 1 : 0,
        x: Math.round(e.x * 100) / 100, z: Math.round(e.z * 100) / 100,
        h: Math.round(e.hp), m: e.maxHp,
        pr: e.b ? Math.round((e.progress / e.total) * 100) / 100 : 1,
      };
      if (e.b) {
        v.cx = e.cx; v.cz = e.cz; v.sz = e.size; v.lv = e.lvl;
        v.qn = e.queue.length;
        if (e.queue.length) {
          v.qt = 1 - e.queue[0].t / e.queue[0].t0;
          v.qy = e.queue[0].type;
          v.qq = e.queue.map(q => q.type); // full queue composition for the HUD
        }
        if (e.rallyX >= 0) { v.rx = Math.round(e.rallyX * 10) / 10; v.rz = Math.round(e.rallyZ * 10) / 10; }
        if (e.patPts) v.pp = e.patPts;
        if (e.rpt) v.rp = 1;
        if (e.primary) v.pm = 1;
        if (e.research) { v.rs = e.research.tech; v.rsf = 1 - e.research.t / e.research.t0; }
      } else {
        if (e.stance) v.st = e.stance;
        if (e.fortified) v.fo = 1;
        if (UNITS[e.type]?.cloak) v.ck = 1;
        if (e.cd > 0 && UNITS[e.type]?.dmg > 0) {
          v.fr = 1; // mid-reload = in a firefight (drives aim pose)
          if (e.aimX !== undefined) { v.ax = Math.round(e.aimX * 10) / 10; v.az = Math.round(e.aimZ! * 10) / 10; }
        }
      }
      ents.push(v);
    }
    return {
      k: this.tickN,
      e: ents,
      p: this.players.map(pl => ({
        c: Math.round(pl.credits), a: pl.alive, pm: Math.round(pl.powerMade), pu: Math.round(pl.powerUsed),
        n: pl.name, f: pl.faction, tech: Object.keys(pl.tech).filter(k => pl.tech[k]),
      })),
      ev: this.events,
    };
  }
}
