// Authoritative game simulation. Fixed timestep (10 Hz), no rendering imports.
// Runs in the browser for skirmish and on the Node server for multiplayer.

import { TICK, UNITS, BUILDINGS, FACTIONS, Faction, dmgMul, AIRFIELD_HELI, AIRFIELD_PLANE, airSlotClass, UPG_MAX, upgCost, ORE_VALUE, START_CREDITS, ORE_REGEN, ORE_REGEN_CAP, TECHS, DRONE_TYPES } from './data';
import { hyp, dsin, dcos } from './dmath';
import { GameMap, genMap, nearestPassable, nearestSea, W, H, SEA } from './map';
import { findPath } from './path';
import { RNG } from './rng';

export interface Order {
  k: string; x?: number; z?: number; tgt?: number; ox?: number; oz?: number;
  pts?: { x: number; z: number }[]; i?: number; dir?: number; loop?: boolean; // patrol route
  ban?: number[]; // harvest: ore cells proven unreachable (don't re-pick them)
  pD?: number; pT?: number; // harvest approach progress watchdog
  keep?: boolean; // attack: a player-issued order — stick to THIS target, no auto-switch
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
  fortT: number; fortGoal: boolean; // fortify deploy/pack transition (vulnerable while changing)
  aimX?: number; aimZ?: number; // last firing target — renderer turns the unit toward it
  hx?: number; hz?: number; // last travel heading (unit vector) — facing follows this, NOT raw
                            // position deltas, so collision shoves don't spin clustered units
  oreCd: number; // harvester cooldown after every reachable field proved empty/blocked
  sd: number; // self-destruct: seconds left (0 = inactive); detonates at 0
  cmdT: number; // tick of the last explicit player/AI order (protects it from auto-reactions)
  research: { tech: string; t: number; t0: number } | null; // research lab
  // buildings
  cx: number; cz: number; size: number;
  progress: number; total: number;
  queue: { type: string; t: number; t0: number; paid?: boolean }[];
  rallyX: number; rallyZ: number; lvl: number;
  patPts: { x: number; z: number }[] | null; // building patrol route for produced units
  rpt: boolean; // repeat production: finished units re-queue themselves
  primary: boolean; // primary building of its type (new units train here)
  storedMissile?: string | null; // silo: type of the FIRST armed missile (UI hint)
  missileStock?: string[]; // silo: armed missiles awaiting launch (up to MISSILE_CAP)
  lastMissile?: string; // silo: missile type to auto-rebuild for a strike order
  strikeX?: number; strikeZ?: number; strikeR?: number; // silo: persistent strike zone
  terraPath?: { x: number; z: number }[]; terraI?: number; terraH?: number; // bulldozer job
  terraHs?: number[]; // per-cell target heights (auto-bridge ramp); parallel to terraPath
  terraBridge?: { ax: number; az: number; bx: number; bz: number }; // auto-bridge: connect these two land cells
  burnT?: number; burnPs?: number; // building on fire: seconds left, damage/s
  upg?: { t: number; t0: number }; // building upgrade in progress: seconds left, total
  icd?: number; // interceptor (Iron Dome / Patriot): reload cooldown between missile kills
  stunT?: number; // EMP stun: seconds the unit is frozen (can't move or fire)
  mineStock?: number; // engineer: proximity mines left to lay
  rzx?: number; rzz?: number; rzr?: number; // engineer: assigned auto-repair zone (centre + radius)
  hzx?: number; hzz?: number; hzr?: number; // harvester: assigned ore-gathering work area (centre + radius)
  cargoUnits?: Entity[]; // transport ship: ground units stowed aboard (removed from the map while carried)
  wpLoop?: Order[]; // waypoint repeat: the saved chain to re-run when the orders empty (until cancelled)
  holdFire?: boolean; // weapons-hold: never fires, even when attacked, until toggled off
  forceTgt?: number; forceT?: number; // defensive building: force-fire target id + ticks left
  forceX?: number; forceZ?: number;   // defensive building: force-fire ground point (no entity)
  off?: boolean;     // power: user manually deactivated this building (stays off until toggled)
  autoOff?: boolean; // power: automatically load-shed this tick (low power; recomputed each tick)
}

export interface PlayerState {
  name: string; faction: string; fac: Faction; isAI: boolean; aiLvl: number;
  team: number;                            // allies share a team; FFA = unique per player
  credits: number; alive: boolean;
  neutral?: boolean;                       // the garrison "owner" — not a contender (skipped in win/foe/AI)
  left?: boolean;                          // departed via "Just Exit" — not a defeat
  passive?: boolean;                       // tutorial target: AI does nothing
  powerMade: number; powerUsed: number; pf: number;
  bonusCost: number; bonusIncome: number; // brutal-AI handicaps
  godmode?: boolean;                       // cheat: instant builds (taints the game)
  tech: Record<string, boolean>;          // researched technologies
  satOk?: boolean;                         // satellite researched AND powered AND a lab still stands
  spawn: { x: number; z: number };
}

export type Cmd = any;

const FORT_TIME = 2.0;      // seconds to dig in or pack up (vulnerable meanwhile)
const FORT_ATK_MUL = 1.5;   // fortified infantry hit harder
const FORT_DEF_MUL = 0.5;   // ...and take half damage (settled)
const FORT_DEPLOY_VULN = 1.5; // ...but take extra while deploying / packing
const FORT_RANGE_MUL = 1.2; // ...and see/shoot 20% farther while dug in
// power load-shedding order: when a base is in power deficit, consumers are auto
// switched off LOWEST-number first to rebalance — DEFENCES are shed last (9).
// Producers (power plant) and the conyard are never shed.
const SHED_PRIO: Record<string, number> = {
  airfield: 1, airforce: 1, silo: 1, dronefac: 2, shipyard: 2, lab: 2,
  factory: 3, barracks: 3, radar: 4, refinery: 5,
  turret: 9, sam: 9, cannon: 9, tesla: 9, irondome: 9,
};
const shedPrio = (t: string): number => SHED_PRIO[t] ?? 5;
const MISSILE_CAP = 25;     // max armed missiles a single silo can stockpile
const CARRY_VEH = 10;       // transport ship capacity: vehicles
const CARRY_INF = 30;       // transport ship capacity: infantry
const GARR_ATK = 1.3;       // garrisoned infantry hit 30% harder firing from cover
// how many of each kind a transport already holds
function carriedCounts(ship: Entity): { veh: number; inf: number } {
  let veh = 0, inf = 0;
  for (const e of ship.cargoUnits || []) { const k = UNITS[e.type]?.kind; if (k === 'veh') veh++; else if (k === 'inf') inf++; }
  return { veh, inf };
}
// can this ship take one more unit of the given type?
function canBoard(ship: Entity, type: string): boolean {
  const k = UNITS[type]?.kind;
  if (k !== 'veh' && k !== 'inf') return false;   // only ground units
  const sd = UNITS[ship.type];
  const maxVeh = sd?.carryVeh ?? CARRY_VEH, maxInf = sd?.carryInf ?? CARRY_INF;
  const c = carriedCounts(ship);
  return k === 'veh' ? c.veh < maxVeh : c.inf < maxInf;
}

const FORM: { x: number; z: number }[] = [{ x: 0, z: 0 }];
for (let r = 1; r <= 3; r++) {
  const n = r * 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    FORM.push({ x: dcos(a) * r * 1.25, z: dsin(a) * r * 1.25 });
  }
}

export class Sim {
  map: GameMap;
  ents = new Map<number, Entity>();
  players: PlayerState[] = [];
  nextId = 1;
  tickN = 0;
  rng: RNG;
  // per-player AI RNG, SEPARATE from the gameplay rng. AI decisions must not draw
  // from `rng` or lockstep desyncs: each client computes only some players' AI, so
  // sharing `rng` would consume it asymmetrically. Per-player streams also let a
  // dropped player's AI be recomputed identically by every surviving client.
  aiRngP: RNG[] = [];
  events: any[] = [];
  dmgLog: any[] = [];
  aiMem: any[] = [];
  done = false;
  winner = -2;
  neutralP = -1; // player index of the neutral "owner" of garrisonable buildings (-1 = none)
  aiProfile: any = null; // host-provided study of past human-vs-AI games (adaptive AI)
  aiDirective: any = null; // optional LLM strategist (Claude API) high-level orders
  cheated = false; // godmode was used — don't feed this game into the AI's learning
  // post-game statistics (per player index): production, kills, losses, and a
  // time-series sampled during the match for the end-of-game charts
  stats = {
    builtU: [] as number[], builtB: [] as number[],   // units / buildings produced
    destU: [] as number[], destB: [] as number[],     // enemy units / buildings destroyed (kills)
    lostU: [] as number[], lostB: [] as number[],     // own units / buildings lost
    series: [] as { t: number; u: number[]; b: number[]; c: number[] }[],
  };
  private aiDmg = { inf: 0, veh: 0, air: 0, sea: 0 }; // human damage to the AI, by weapon class
  private aiDealt = { inf: 0, veh: 0, air: 0, sea: 0 }; // AI damage to the human, by its own weapon class
  private aiLost = { inf: 0, veh: 0, air: 0, sea: 0 }; // AI units lost, by kind
  private aiHarvLost = 0;
  // per-AI-player ledgers (AI-vs-AI simulations study the winner's doctrine)
  private dealtP: Record<number, Record<string, number>> = {};
  private lostP: Record<number, Record<string, number>> = {};
  private pendingBlasts: { t: number; x: number; z: number; type: string; owner: number }[] = [];
  private firstHumanHit = -1;
  private reported = false;
  private grid = new Map<number, number[]>(); // spatial hash of units, cell = 2 units

  constructor(seed: number, specs: { name: string; faction: string; isAI?: boolean; aiLvl?: number; team?: number }[]) {
    this.rng = new RNG(seed);
    this.map = genMap(seed, specs.length);
    specs.forEach((s, i) => {
      const fac = FACTIONS[s.faction] || FACTIONS.usa;
      const lvl = s.aiLvl ?? 1;
      this.players.push({
        name: s.name, faction: fac.id, fac, isAI: !!s.isAI, aiLvl: lvl,
        team: s.team ?? i, // default: everyone on their own team (free-for-all)
        credits: START_CREDITS, alive: true, powerMade: 0, powerUsed: 0, pf: 1,
        // Brutal gets a leg up; Easy gets a handicap (pricier builds, less income)
        bonusCost: s.isAI ? (lvl >= 3 ? 0.85 : lvl === 0 ? 1.25 : 1) : 1,
        bonusIncome: s.isAI ? (lvl >= 3 ? 1.3 : lvl === 0 ? 0.8 : 1) : 1,
        tech: {},
        spawn: this.map.spawns[i],
      });
      this.aiMem.push(null);
      this.aiRngP.push(new RNG((seed ^ 0xa1c0ffe ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0));
      this.placeStart(i);
    });
    // neutral "owner" for garrisonable city buildings — a non-contender slot that
    // foe()/checkEnd()/the AI all skip. Empty garrison buildings sit under it; a
    // building flips to the garrisoning player while occupied, back here when empty.
    if (this.map.garrisonSites.length) {
      this.neutralP = this.players.length;
      this.players.push({
        name: 'Neutral', faction: FACTIONS.usa.id, fac: FACTIONS.usa, isAI: false, aiLvl: 0,
        team: -99, credits: 0, alive: true, neutral: true, powerMade: 0, powerUsed: 0, pf: 1,
        bonusCost: 1, bonusIncome: 1, tech: {}, spawn: { x: 0, z: 0 },
      });
      this.aiMem.push(null);
      this.aiRngP.push(new RNG((seed ^ 0xbeef) >>> 0));
    }
    const n = this.players.length;
    const z = () => new Array(n).fill(0);
    Object.assign(this.stats, { builtU: z(), builtB: z(), destU: z(), destB: z(), lostU: z(), lostB: z() });
    // place the neutral garrison buildings the map laid out. canPlace() can't be
    // used — it requires friendly build-reach, which neutral has none of — so just
    // confirm the footprint is clear land (the map already reserved it).
    if (this.neutralP >= 0)
      for (const g of this.map.garrisonSites) {
        const def = BUILDINGS[g.type]; let ok = true;
        for (let z = g.cz; z < g.cz + def.size && ok; z++)
          for (let x = g.cx; x < g.cx + def.size && ok; x++)
            if (!this.map.inB(x, z) || this.map.occ[z * W + x] || this.map.tBlocked[z * W + x] || this.map.ore[z * W + x] > 0) ok = false;
        if (ok) this.addBuilding(this.neutralP, g.type, g.cx, g.cz, true);
      }
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
      wx: 0, wz: 0, stuckT: 0, mvi: -9, pathFail: 0, ammo: -1, oreCd: 0, sd: 0, cmdT: -999,
      stance: 0, lastHitBy: 0, lastHitT: -999, reactCd: 0,
      fortified: false, emitCd: 0, ephLife: 0, fortT: 0, fortGoal: false, research: null,
      cx: 0, cz: 0, size: 1, progress: 0, total: 1, queue: [], rallyX: -1, rallyZ: -1, lvl: 1, patPts: null, rpt: false, primary: false,
      missileStock: [],
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
    if (def.mines) e.mineStock = def.mines;
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
    const onWater = type === 'shipyard'; // ports sit ON the water
    for (let z = cz; z < cz + def.size; z++)
      for (let x = cx; x < cx + def.size; x++) {
        const i = z * W + x;
        if (!this.map.inB(x, z) || this.map.occ[i]) return false;
        // water blocks normal buildings, but a shipyard is built on it
        if (this.map.tBlocked[i] && !(onWater && this.map.water[i])) return false;
        // never build on an ore patch — it buries the field and traps the
        // harvesters trying to mine it (reported: AI harvesters getting stuck)
        if (this.map.ore[i] > 0) return false;
      }
    // shipyards must straddle the coast: water in/around the footprint
    if (type === 'shipyard') {
      let wn = 0;
      for (let z = cz - 1; z <= cz + def.size; z++)
        for (let x = cx - 1; x <= cx + def.size; x++)
          if (this.map.inB(x, z) && this.map.water[z * W + x]) wn++;
      if (wn < 2) return false;
    }
    // must be near an existing friendly building OR a friendly road tile.
    // shipyards get extra reach so they can stretch out to a coast that isn't
    // right next to the base (otherwise they were impossible to place).
    // walls and tank barriers are NOT anchors — you can't creep the base
    // outward with a chain of cheap walls; a real structure must be in reach.
    const reach = type === 'shipyard' ? 24 : 14;
    const mx = cx + def.size / 2, mz = cz + def.size / 2;
    for (const e of this.ents.values()) {
      if (!e.b || e.owner !== p || e.type === 'wall' || e.type === 'barrier') continue;
      const d = Math.sqrt((e.x - mx) * (e.x - mx) + (e.z - mz) * (e.z - mz));
      if (d <= reach) return true;
    }
    const rr = 5; // build reach around roads
    for (let z = Math.max(0, Math.floor(mz - rr)); z < Math.min(H, mz + rr); z++)
      for (let x = Math.max(0, Math.floor(mx - rr)); x < Math.min(W, mx + rr); x++)
        if (this.map.road[z * W + x] === p + 1 && (x - mx) * (x - mx) + (z - mz) * (z - mz) <= rr * rr) return true;
    return false;
  }

  distToEnt(x: number, z: number, t: Entity): number {
    if (!t.b) return Math.sqrt((t.x - x) * (t.x - x) + (t.z - z) * (t.z - z));
    const qx = Math.max(t.cx, Math.min(x, t.cx + t.size));
    const qz = Math.max(t.cz, Math.min(z, t.cz + t.size));
    return Math.sqrt((qx - x) * (qx - x) + (qz - z) * (qz - z));
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
      this.addBuilding(c.p, c.type, c.cx, c.cz, !!pl.godmode); // godmode: finished instantly
      return;
    }
    if (c.k === 'train') {
      const b = this.ents.get(c.bid); const def = UNITS[c.type];
      if (!b || !b.b || b.owner !== c.p || !def || (def.builtAt !== b.type && def.altBuiltAt !== b.type)) return;
      if (def.tech && !pl.tech[def.tech] && !pl.godmode) return; // not yet researched (godmode unlocks all)
      if (def.faction && def.faction !== pl.faction && !pl.godmode) return; // faction-exclusive signature (godmode unlocks all)
      if (def.internal) return;
      // hero/unique units (Melody, Bulldozer): only one alive (or in production) at a time
      if (def.commando || def.unique) {
        let have = 0;
        for (const e of this.ents.values()) if (e.owner === c.p && e.type === c.type && e.hp > 0) have++;
        for (const bb of this.ents.values()) if (bb.b && bb.owner === c.p) for (const it of bb.queue) if (it.type === c.type) have++;
        if (have >= 1) return;
      }
      // production queues are uncapped (build as many as you like); aircraft are
      // still bounded by airfield slots below, and the building must be finished
      if (b.progress < b.total) return;
      // aircraft are limited by per-class airfield capacity (helis 30 / planes 10)
      if (def.pad && !this.padCapacityFree(c.p, c.type)) return;
      // queue freely even when broke — the item is charged only when it reaches the
      // front of the queue AND the credits are there (tickBuilding handles the
      // pay-or-stall). So a queued unit waits its turn, then builds once affordable.
      b.queue.push({ type: c.type, t: def.buildTime, t0: def.buildTime, paid: false });
      return;
    }
    if (c.k === 'godmode') {
      // no cheating in human-vs-human matches
      if (this.players.filter(p => !p.isAI).length > 1) return;
      pl.godmode = true;     // instant builds from now on
      this.cheated = true;   // taint the game so it never trains the AI
      pl.credits += 50000;
      this.events.push({ e: 'cash', x: pl.spawn.x, z: pl.spawn.z });
      return;
    }
    if (c.k === 'launch') {
      // fire the silo's stored missile once at a point
      const b = this.ents.get(c.bid);
      if (!b || !b.b || b.owner !== c.p || b.type !== 'silo' || b.progress < b.total) return;
      this.launchMissile(b, c.x, c.z);
      return;
    }
    if (c.k === 'silostrike') {
      // designate a persistent strike zone: the silo auto-builds and bombards
      // the densest enemy cluster inside it until cleared or out of credits.
      // r <= 0 cancels the standing order.
      const b = this.ents.get(c.bid);
      if (!b || !b.b || b.owner !== c.p || b.type !== 'silo') return;
      if ((c.r || 0) <= 0) { b.strikeR = 0; return; }
      b.strikeX = Math.max(0, Math.min(W - 0.01, c.x));
      b.strikeZ = Math.max(0, Math.min(H - 0.01, c.z));
      b.strikeR = Math.min(20, c.r);
      // fire immediately if armed, so the first missile flies now
      this.siloAutoStrike(b);
      return;
    }
    if (c.k === 'aattack') {
      // area attack: every enemy unit and building inside the circle becomes a
      // target; each attacker works through them nearest-first until the zone
      // is cleared or the attacker dies
      const r = Math.max(1, Math.min(14, c.r || 0));
      const targets: Entity[] = [];
      for (const e of this.ents.values()) {
        if (!this.foe(e.owner, c.p) || e.hp <= 0 || !this.players[e.owner].alive) continue;
        const d = e.b ? this.distToEnt(c.x, c.z, e) : hyp(e.x - c.x, e.z - c.z);
        if (d <= r) targets.push(e);
      }
      if (!targets.length) return;
      for (const id of (c.ids || [])) {
        const u = this.ents.get(id);
        if (!u || u.b || u.owner !== c.p) continue;
        if ((UNITS[u.type]?.dmg ?? 0) <= 0) continue;
        const list = [...targets]
          .sort((a, b) => ((a.x - u.x) * (a.x - u.x) + (a.z - u.z) * (a.z - u.z)) - ((b.x - u.x) * (b.x - u.x) + (b.z - u.z) * (b.z - u.z)))
          .slice(0, 24);
        u.orders = list.map(t => ({ k: 'attack' as const, tgt: t.id }));
        u.path = null;
      }
      return;
    }
    if (c.k === 'selfdestruct') {
      // Ctrl-D toggle: if any selected unit is already counting down, cancel
      // them all; otherwise arm a 5s sequence on each
      const ids = (c.ids || []).map((id: number) => this.ents.get(id)).filter((u: Entity) => u && !u.b && u.owner === c.p);
      const anyArmed = ids.some((u: Entity) => u.sd > 0);
      for (const u of ids) u.sd = anyArmed ? 0 : 5;
      return;
    }
    if (c.k === 'dismantle') {
      // sell a building for a partial refund (construction yard excluded)
      const b = this.ents.get(c.bid);
      if (!b || !b.b || b.owner !== c.p || b.type === 'conyard') return;
      const refund = Math.round(BUILDINGS[b.type].cost * pl.fac.costMul * pl.bonusCost * 0.5 * (b.progress / b.total));
      pl.credits += refund;
      this.events.push({ e: 'cash', x: b.x, z: b.z });
      this.events.push({ e: 'boom', x: b.x, z: b.z, big: false });
      b.hp = 0; // death sweep frees the cells
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
      if (b.type === 'wall' || b.type === 'barrier') return; // walls/barriers can't be upgraded
      if (b.progress < b.total || b.lvl >= UPG_MAX || b.upg) return; // maxed or already upgrading
      const cost = Math.round(upgCost(b.type, b.lvl, pl.fac.costMul) * pl.bonusCost);
      if (pl.credits < cost) return;
      pl.credits -= cost;
      // upgrades now take TIME, scaled by the target level and the building's
      // original build time (so a bigger building / higher tier takes longer)
      const dur = Math.max(3, BUILDINGS[b.type].buildTime * 0.6 * (b.lvl + 1));
      b.upg = { t: dur, t0: dur };
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
    if (c.k === 'evac') {
      // evacuate a garrison building we hold: spill the occupants onto the street,
      // and hand the now-empty building back to neutral so anyone can re-take it
      const b = this.ents.get(c.bid);
      if (b && b.b && b.owner === c.p && BUILDINGS[b.type]?.garrison) this.evacuate(b);
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
    if (c.k === 'bholdfire') {
      // weapons-hold toggle for selected defensive buildings (turret/cannon/tesla/sam)
      const blds = (c.ids || []).map((i: number) => this.ents.get(i))
        .filter((b: Entity | undefined): b is Entity => !!b && b.b && b.owner === c.p && !!BUILDINGS[b.type]?.attack);
      if (!blds.length) return;
      const on = c.on !== undefined ? !!c.on : !blds.every(b => b.holdFire);
      for (const b of blds) b.holdFire = on;
      return;
    }
    if (c.k === 'bforcefire') {
      // force a defensive building to fire on a target entity OR a ground point for
      // a short window, overriding hold-fire. Only guns flagged forceFire (Defense
      // Turret, Heavy Cannon) accept it — Tesla Coil / Missile Battery do not.
      for (const i of (c.ids || [])) {
        const b = this.ents.get(i);
        if (!b || !b.b || b.owner !== c.p || !BUILDINGS[b.type]?.forceFire) continue;
        if (c.tgt != null) { b.forceTgt = c.tgt; b.forceX = undefined; b.forceZ = undefined; b.forceT = 30; }
        else if (c.x != null) { b.forceTgt = undefined; b.forceX = c.x; b.forceZ = c.z; b.forceT = 30; }
      }
      return;
    }
    if (c.k === 'stance') {
      for (const id of (c.ids || [])) {
        const u = this.ents.get(id);
        if (u && !u.b && u.owner === c.p) {
          u.stance = c.stance ? 1 : 0;
          // Hold Position halts the unit immediately, even one already en route
          if (c.stance) { u.orders = []; u.path = null; u.cmdT = this.tickN; }
        }
      }
      return;
    }
    if (c.k === 'research') {
      const b = this.ents.get(c.bid);
      const tech = TECHS[c.tech];
      if (!b || !b.b || b.owner !== c.p || b.type !== 'lab' || b.progress < b.total || b.research) return;
      if (!tech || pl.tech[c.tech]) return;
      if (tech.minLab && b.lvl < tech.minLab) return; // e.g. Spy Satellite needs a level-3 lab
      const rcost = Math.round(tech.cost * pl.fac.costMul * pl.bonusCost);
      if (pl.credits < rcost) return;
      pl.credits -= rcost;
      b.research = { tech: c.tech, t: tech.time, t0: tech.time };
      return;
    }
    if (c.k === 'fortify') {
      for (const id of (c.ids || [])) {
        const u = this.ents.get(id);
        if (u && !u.b && u.owner === c.p && UNITS[u.type]?.fortify && u.fortT <= 0) {
          // start a deploy (or pack-up) transition — vulnerable while it runs
          u.fortGoal = !u.fortified;
          u.fortT = FORT_TIME;
          u.orders = []; u.path = null; u.emitCd = 2;
          this.events.push({ e: 'fortify', x: u.x, z: u.z });
        }
      }
      return;
    }
    if (c.k === 'deploy') {
      // Construction Vehicle unfolds into a forward construction yard. Unlike a
      // normal placement this needs NO adjacency — that's the whole point.
      for (const id of (c.ids || [])) {
        const u = this.ents.get(id);
        if (!u || u.b || u.owner !== c.p) continue;
        // engineer lays a proximity mine at its feet (from its onboard stock)
        const lays = UNITS[u.type]?.lays;
        if (lays) {
          if ((u.mineStock ?? 0) > 0) {
            u.mineStock = (u.mineStock ?? 0) - 1;
            const m = this.spawnUnit(u.owner, lays, u.x, u.z);
            m.orders = []; m.stance = 1;
            this.events.push({ e: 'mineset', x: u.x, z: u.z });
          }
          continue;
        }
        const target = UNITS[u.type]?.deploys;
        if (!target) continue;
        const def = BUILDINGS[target];
        const cx = Math.round(u.x - def.size / 2), cz = Math.round(u.z - def.size / 2);
        let clear = true;
        for (let z = cz; z < cz + def.size && clear; z++)
          for (let x = cx; x < cx + def.size && clear; x++) {
            const i = z * W + x;
            if (!this.map.inB(x, z) || this.map.tBlocked[i] || this.map.ore[i] > 0) clear = false;
            else if (this.map.occ[i] && this.map.occ[i] !== u.id) clear = false;
          }
        if (clear) {
          u.hp = 0;                                  // consume the vehicle
          this.addBuilding(c.p, target, cx, cz, true); // instant forward yard
          this.events.push({ e: 'done', x: u.x, z: u.z });
        }
      }
      return;
    }
    if (c.k === 'terraform') {
      // assign a bulldozer a path of cells to reshape toward a target height
      const dozer = (c.ids || []).map((i: number) => this.ents.get(i))
        .find((u: Entity | undefined): u is Entity => !!u && !u.b && u.owner === c.p && UNITS[u.type]?.terra);
      if (!dozer || !Array.isArray(c.path) || !c.path.length) return;
      const cells = c.path.slice(0, 2500).map((p: any) => ({ x: Math.floor(p.x), z: Math.floor(p.z) }));
      dozer.terraPath = cells;
      dozer.terraI = 0;
      dozer.terraH = Math.max(-1.0, Math.min(8, c.h ?? (SEA + 1.5)));
      dozer.terraHs = undefined; dozer.terraBridge = undefined;
      // auto-bridge: a flat "simple click" (no height adjustment) over a span that
      // crosses water between two landmasses. Raise the gap into a land path and
      // ramp it between the two shore heights so vehicles & infantry can cross.
      if (c.auto) this.planBridge(dozer, cells);
      dozer.orders = []; dozer.path = null;
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

    if (c.k === 'togglepower') {
      // manually switch a building on/off; conyard/power plants can't be toggled
      for (const id of (c.ids || [])) {
        const b = this.ents.get(id);
        if (b && b.b && b.owner === c.p && b.type !== 'conyard' && BUILDINGS[b.type]?.power <= 0)
          b.off = !b.off;
      }
      return;
    }

    const units = (c.ids || [])
      .map((i: number) => this.ents.get(i))
      .filter((u: Entity | undefined): u is Entity => !!u && !u.b && u.owner === c.p);
    if (!units.length) return;

    if (c.k === 'stop') {
      for (const u of units) { u.orders = []; u.path = null; u.terraPath = undefined; u.terraHs = undefined; u.terraBridge = undefined; u.rzr = 0; u.wpLoop = undefined; u.cmdT = this.tickN; }
      return;
    }
    if (c.k === 'wprepeat') {
      // toggle waypoint repeat: capture the current positional order chain so the
      // unit re-runs it forever once its orders empty (off = clear the saved loop)
      for (const u of units) {
        if (u.wpLoop) { u.wpLoop = undefined; continue; }
        const loop = u.orders.filter(o => o.k === 'move' || o.k === 'attack' || o.k === 'harvest' || o.k === 'force').map(o => ({ ...o }));
        if (loop.length) u.wpLoop = loop;
      }
      return;
    }
    if (c.k === 'repairzone') {
      // engineers: stand watch over an area, auto-repairing friendlies inside it
      for (const u of units) if (UNITS[u.type]?.repair) { u.rzx = c.cx; u.rzz = c.cz; u.rzr = c.r; }
      return;
    }
    if (c.k === 'harvestzone') {
      // harvesters: confine ore gathering to a drawn work area and head there now
      for (const u of units) if (UNITS[u.type]?.cargo) {
        u.hzx = c.cx; u.hzz = c.cz; u.hzr = c.r;
        const n = this.scanOreZone(c.cx, c.cz, c.r) || { x: Math.floor(c.cx), z: Math.floor(c.cz) };
        u.orders = [{ k: 'harvest', ox: n.x, oz: n.z }]; u.path = null; u.cmdT = this.tickN;
      }
      return;
    }
    if (c.k === 'load') {
      // ground units board a transport ship (c.tgt). They walk to it and embark
      // when adjacent; only infantry/vehicles can board, up to the ship's capacity.
      const ship = this.ents.get(c.tgt);
      if (!ship || !UNITS[ship.type]?.carrier || ship.owner !== c.p) return;
      for (const u of units) {
        const k = UNITS[u.type]?.kind;
        if ((k === 'inf' || k === 'veh') && u.id !== ship.id) { u.orders = [{ k: 'board', tgt: c.tgt }]; u.path = null; u.cmdT = this.tickN; }
      }
      return;
    }
    if (c.k === 'garrison') {
      // infantry enter a neutral (or our own) garrison building and fire out from it
      const b = this.ents.get(c.tgt);
      if (!b || !b.b || !BUILDINGS[b.type]?.garrison || (b.owner !== this.neutralP && b.owner !== c.p)) return;
      for (const u of units) if (UNITS[u.type]?.kind === 'inf') { u.orders = [{ k: 'garrison', tgt: c.tgt }]; u.path = null; u.cmdT = this.tickN; }
      return;
    }
    if (c.k === 'oilrig') {
      // an Engineer drives to an oil well and builds an Oil Rig on it
      const i = c.cz * W + c.cx;
      if (!this.map.inB(c.cx, c.cz) || this.map.oil[i] !== 1 || this.map.occ[i]) return;
      for (const u of units) if (UNITS[u.type]?.repair && UNITS[u.type]?.road) { // the (land) Engineer
        u.orders = [{ k: 'oilrig', ox: c.cx, oz: c.cz }]; u.path = null; u.cmdT = this.tickN;
      }
      return;
    }
    if (c.k === 'unload') {
      // transports drop their cargo: onto shore if close, else sail to the nearest coast first
      for (const u of units) if (UNITS[u.type]?.carrier && (u.cargoUnits?.length || 0) > 0) {
        u.orders = [{ k: 'unload' }]; u.path = null; u.cmdT = this.tickN;
      }
      return;
    }
    if (c.k === 'holdfire') {
      // weapons-hold toggle: when set, the unit never fires (even when attacked)
      const on = c.on !== undefined ? !!c.on : !units.every(u => u.holdFire);
      for (const u of units) u.holdFire = on;
      return;
    }
    if (c.k === 'escort') {
      // follow a (friendly) unit and engage anything that threatens it
      for (const u of units) if (UNITS[u.type]?.dmg > 0 && c.tgt !== u.id) {
        u.orders = [{ k: 'escort', tgt: c.tgt }]; u.path = null; u.cmdT = this.tickN;
      }
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
        // a human's direct attack order sticks to THIS target (no auto-switching
        // to whatever wanders into range); the AI keeps its fighting-advance
        const human = !this.players[c.p]?.isAI;
        ord = UNITS[u.type].dmg > 0 ? { k: 'attack', tgt: c.tgt, keep: human } : { k: 'move', x: c.x ?? u.x, z: c.z ?? u.z };
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
      } else if (c.k === 'forcefire') {
        // force-fire at a point or entity, ignoring allegiance (armed units only)
        if (UNITS[u.type].dmg > 0 && (c.tgt != null || c.x != null))
          ord = { k: 'force', tgt: c.tgt, x: c.x, z: c.z, keep: true };
      }
      if (!ord) return;
      u.cmdT = this.tickN; // explicit order — shield it from auto-reactions
      // a manual order cancels an in-progress terraform job (keep what was already
      // reshaped — just stop here) so the bulldozer is free to drive off
      if (u.terraPath) { u.terraPath = undefined; u.terraHs = undefined; u.terraBridge = undefined; }
      if (c.q) u.orders.push(ord);
      else { u.orders = [ord]; u.path = null; u.wpLoop = undefined; } // a fresh order cancels the repeat loop
    });
  }

  // Patrol assignment: a single unit (or single spot) patrols directly; a group
  // first MOVES into formation — evenly spaced along the drawn route — and only
  // then begins sweeping the full route back and forth.
  private assignPatrol(units: Entity[], rawPts: any[], q: boolean) {
    const pts = rawPts.slice(0, 32).map((p: any) => ({ x: p.x, z: p.z }));
    const loop = pts.length > 2 &&
      hyp(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 3;
    const nearestIdx = (x: number, z: number) => {
      let bi = 0, bd = 1e9;
      for (let i = 0; i < pts.length; i++) {
        const d = (pts[i].x - x) * (pts[i].x - x) + (pts[i].z - z) * (pts[i].z - z);
        if (d < bd) { bd = d; bi = i; }
      }
      return bi;
    };
    if (pts.length < 2) {
      // a single chosen point: each unit patrols between ITS OWN current position
      // and that point, bouncing back and forth until given new orders
      const tgt = pts[0];
      units.forEach(u => {
        const ord: Order = { k: 'patrol', pts: [{ x: u.x, z: u.z }, { x: tgt.x, z: tgt.z }], i: 0, dir: 1, loop: false };
        if (q) u.orders.push(ord); else { u.orders = [ord]; u.path = null; }
      });
      return;
    }
    if (units.length === 1) {
      const u = units[0];
      const ord: Order = { k: 'patrol', pts: pts.map(p => ({ x: p.x, z: p.z })), i: 0, dir: 1, loop };
      if (q) u.orders.push(ord); else { u.orders = [ord]; u.path = null; }
      return;
    }
    // evenly spaced arc-length slots along the route
    const segLen = [0];
    let L = 0;
    for (let i = 1; i < pts.length; i++) {
      L += hyp(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
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
    const al = hyp(ax, az) || 1;
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

  // per-class airfield capacity: helidrones are unlimited; helicopters get 30 per
  // airfield, airplanes 10. Counts that class's live units + in-production queue.
  padCapacityFree(p: number, type: string): boolean {
    const cls = airSlotClass(type);
    if (!cls || cls === 'drone') return true;       // not slot-limited / unlimited
    const per = cls === 'heli' ? AIRFIELD_HELI : AIRFIELD_PLANE;
    let have = 0, cap = 0;
    for (const e of this.ents.values()) {
      if (e.owner !== p) continue;
      if (!e.b && airSlotClass(e.type) === cls) have++;
      if (e.b) {
        if (e.type === 'airfield' && e.progress >= e.total) cap += per;
        for (const q of e.queue) if (airSlotClass(q.type) === cls) have++;
      }
    }
    return have < cap;
  }

  // Plan an auto-bridge across a drawn rectangle that spans water between two
  // landmasses. Picks the bridge's long axis, finds a shore height at each end,
  // and assigns every cell a per-cell target that ramps from one shore to the
  // other — so the finished span is solid land sloped gently between the two
  // island heights (no cliffs to block vehicles/infantry). Stores two anchor
  // cells so the job can stop the moment the two land regions actually connect.
  private planBridge(dozer: Entity, cells: { x: number; z: number }[]) {
    if (!cells.length) return;
    let xMin = 1e9, xMax = -1e9, zMin = 1e9, zMax = -1e9;
    for (const c of cells) { if (c.x < xMin) xMin = c.x; if (c.x > xMax) xMax = c.x; if (c.z < zMin) zMin = c.z; if (c.z > zMax) zMax = c.z; }
    const horiz = (xMax - xMin) >= (zMax - zMin); // long axis = bridge direction
    const sOf = (c: { x: number; z: number }) => horiz ? c.x : c.z;
    const sMin = horiz ? xMin : zMin, sMax = horiz ? xMax : zMax;
    const span = Math.max(1, sMax - sMin);
    const LAND = SEA + 0.6; // a comfortably-dry land height to fall back on
    // sample shore heights: average the height of land cells in the first/last
    // fifth of the span (the two island ends). Fall back to a flat land height.
    let h0Sum = 0, h0N = 0, h1Sum = 0, h1N = 0;
    let aCell: { x: number; z: number } | null = null, bCell: { x: number; z: number } | null = null;
    for (const c of cells) {
      if (this.map.regionAt(c.x, c.z) < 0) continue;        // water/cliff — not shore
      const t = (sOf(c) - sMin) / span;
      const h = this.map.cellH(c.x, c.z);
      if (t <= 0.2) { h0Sum += h; h0N++; if (!aCell) aCell = c; }
      else if (t >= 0.8) { h1Sum += h; h1N++; bCell = c; }
    }
    const h0 = h0N ? h0Sum / h0N : LAND;
    const h1 = h1N ? h1Sum / h1N : LAND;
    // per-cell ramp: lerp shore-to-shore along the long axis, floored to dry land
    dozer.terraHs = cells.map(c => {
      const t = (sOf(c) - sMin) / span;
      return Math.max(LAND, Math.min(8, h0 + (h1 - h0) * t));
    });
    // anchors for the connectivity check: a solid-land cell just outside each end
    const endLand = (lo: boolean) => {
      let best: { x: number; z: number } | null = null, bd = 1e9;
      for (const c of cells) {
        const r = this.map.regionAt(c.x, c.z);
        if (r < 0) continue;
        const t = (sOf(c) - sMin) / span;
        const key = lo ? t : 1 - t;
        if (key < bd) { bd = key; best = c; }
      }
      return best;
    };
    const a = aCell || endLand(true), b = bCell || endLand(false);
    if (a && b) dozer.terraBridge = { ax: a.x, az: a.z, bx: b.x, bz: b.z };
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

    // anti-missile shield: Iron Dome / Patriot shoot down incoming warheads
    this.tickIntercept();

    // incoming missiles reach their targets
    if (this.pendingBlasts.length && this.pendingBlasts.some(p => this.tickN >= p.t)) {
      const due = this.pendingBlasts.filter(p => this.tickN >= p.t);
      this.pendingBlasts = this.pendingBlasts.filter(p => this.tickN < p.t);
      for (const bl of due) this.missileBlast(bl);
    }

    // ---- power: producers vs consumers, with automatic load-shedding ----
    // A building that is user-deactivated (off) or auto load-shed (autoOff) makes/uses
    // no power and stops functioning (gated in tickBuilding). autoOff is recomputed
    // every tick: a player in deficit switches off their lowest-priority consumers
    // (defences last) until balanced, and they auto-recover when power returns. The
    // user's manual on/off (off) is never auto-touched.
    const labs = new Array(this.players.length).fill(0);
    for (const pl of this.players) { pl.powerMade = 10; pl.powerUsed = 0; }
    const consumers: Record<number, Entity[]> = {};
    for (const e of this.ents.values()) {
      if (!e.b || e.progress < e.total) { e.autoOff = false; continue; }
      e.autoOff = false; // recomputed fresh below
      if (e.off) continue; // user-deactivated: contributes no power, runs nothing
      const pw = BUILDINGS[e.type].power;
      const pl = this.players[e.owner];
      if (e.type === 'lab') labs[e.owner]++;
      if (pw > 0) pl.powerMade += pw * pl.fac.powerMul * (1 + 0.5 * (e.lvl - 1));
      else if (pw < 0) { pl.powerUsed += -pw; (consumers[e.owner] ??= []).push(e); }
    }
    for (let i = 0; i < this.players.length; i++) {
      const pl = this.players[i];
      if (pl.powerUsed > pl.powerMade) {
        // shed lowest-priority consumers first; deterministic id tie-break (lockstep)
        const cs = (consumers[i] || []).sort((a, b) => shedPrio(a.type) - shedPrio(b.type) || a.id - b.id);
        for (const e of cs) {
          if (pl.powerUsed <= pl.powerMade) break;
          e.autoOff = true; pl.powerUsed += BUILDINGS[e.type].power; // power<0 → reduces usage
        }
      }
      pl.pf = pl.powerUsed <= pl.powerMade ? 1 : Math.max(0.4, pl.powerMade / Math.max(1, pl.powerUsed));
      // Spy Satellite only stays online while powered AND a research lab survives
      pl.satOk = !!pl.tech.satellite && pl.powerUsed <= pl.powerMade && labs[i] > 0;
    }

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
    if (this.tickN % 50 === 0) this.sampleStats(); // 5s cadence time-series for the end charts
    this.tickN++;
  }

  // snapshot per-player unit count, building count and credits for the charts
  private sampleStats() {
    const n = this.players.length;
    const u = new Array(n).fill(0), b = new Array(n).fill(0);
    for (const e of this.ents.values()) {
      if (e.hp <= 0) continue;
      if (e.b) b[e.owner]++;
      else if (!UNITS[e.type]?.internal) u[e.owner]++;
    }
    const c = this.players.map(p => Math.round(p.credits));
    this.stats.series.push({ t: Math.round(this.tickN / 10), u, b, c });
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

  // nearest damaged friendly around a POINT (used by engineers patrolling a zone)
  private findDamagedFriendlyAt(owner: number, cx: number, cz: number, r: number, selfId: number): Entity | null {
    let best: Entity | null = null, bd = 1e9;
    for (const u of this.nearbyUnits(cx, cz, r)) {
      if (u.id === selfId || u.owner !== owner || u.hp <= 0 || u.hp >= u.maxHp) continue;
      const d = hyp(u.x - cx, u.z - cz);
      if (d <= r && d < bd) { bd = d; best = u; }
    }
    for (const u of this.ents.values()) {
      if (!u.b || u.owner !== owner || u.hp <= 0 || u.hp >= u.maxHp || u.progress < u.total) continue;
      const d = this.distToEnt(cx, cz, u);
      if (d <= r && d < bd) { bd = d; best = u; }
    }
    return best;
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

  // two owners are foes when they sit on different teams (same team = allies,
  // and a player is always allied with itself)
  foe(a: number, b: number): boolean {
    // neutral is foe to no one: empty garrison buildings (owned by neutral) are
    // never auto-targeted, and neutral never attacks. An OCCUPIED garrison building
    // is owned by the garrisoning player, so it's a normal enemy to their foes.
    if (this.players[a]?.neutral || this.players[b]?.neutral) return false;
    return a !== b && this.players[a]?.team !== this.players[b]?.team;
  }

  // garrison capacity scales with the building footprint (2x2 -> 4, 3x3 -> 9)
  garrisonCap(b: Entity): number { return Math.max(2, b.size * b.size); }
  private canGarrison(b: Entity): boolean { return (b.cargoUnits?.length || 0) < this.garrisonCap(b); }

  // hand everything a departing player owns to a teammate (used when a human
  // "Just Exits" and an allied human is still in the match) — the leaver is
  // marked gone but their forces fight on under the new owner
  transferOwnership(from: number, to: number): void {
    for (const e of this.ents.values()) if (e.owner === from) e.owner = to;
    if (this.players[from]) {
      this.players[from].alive = false;
      this.players[from].left = true;            // departed, not defeated
    }
  }

  // can this attacker actually deal damage to this target? encodes the submarine
  // rules in ONE place so auto-acquire, return-fire and explicit orders all agree:
  //  - a submarine can be hurt ONLY by a sonar-equipped attacker (Destroyer,
  //    Sub Hunter, Helicopter) — land units, aircraft, turrets, other subs can't
  //  - a submarine itself can only hit ships (torpedoes) and buildings (cruise
  //    missiles) — never land units or aircraft
  canHarm(att: Entity, tgt: Entity): boolean {
    if (!tgt.b && UNITS[tgt.type]?.cloak && UNITS[tgt.type]?.move === 'sea')
      return !att.b && !!UNITS[att.type]?.sonar;
    if (!att.b && UNITS[att.type]?.cloak && UNITS[att.type]?.move === 'sea')
      return tgt.b || UNITS[tgt.type]?.kind === 'sea';
    return true;
  }

  // nearest enemy wall/barrier within reach that sits toward the target — the
  // thing to blast through when a unit is walled off from its objective
  private nearestWallToward(u: Entity, tgt: Entity): Entity | null {
    const dxT = tgt.x - u.x, dzT = tgt.z - u.z, dl = hyp(dxT, dzT) || 1;
    let best: Entity | null = null, bd = 1e9;
    for (const e of this.ents.values()) {
      if (!e.b || e.hp <= 0 || (e.type !== 'wall' && e.type !== 'barrier')) continue;
      if (!this.foe(e.owner, u.owner) || !this.players[e.owner].alive) continue;
      const dx = e.x - u.x, dz = e.z - u.z, d2 = dx * dx + dz * dz;
      // reach far enough that an army staged near the wall line will march to it
      // and breach (it paths to the wall's open edge); bounded so the O(n) scan
      // and the cross-map treks stay cheap
      if (d2 > 55 * 55) continue;
      if ((dx * dxT + dz * dzT) / dl < -1) continue;     // not the ones behind us
      if (d2 < bd) { bd = d2; best = e; }
    }
    return best;
  }

  // nearest enemy that has wandered within range of an ESCORTED unit and that
  // the escort can actually hurt (used by the escort/guard order)
  private escortThreat(u: Entity, t: Entity, r: number): Entity | null {
    let best: Entity | null = null, bd = r * r;
    for (const o of this.nearbyUnits(t.x, t.z, r + 1)) {
      if (!this.foe(o.owner, u.owner) || o.hp <= 0 || !this.players[o.owner]?.alive) continue;
      if (!this.canHarm(u, o)) continue;
      if (UNITS[o.type]?.fly && dmgMul(u.type, false, 'air', o.type) <= 0) continue;
      const d2 = (o.x - t.x) * (o.x - t.x) + (o.z - t.z) * (o.z - t.z);
      if (d2 < bd) { bd = d2; best = o; }
    }
    return best;
  }

  private findEnemy(e: Entity, range: number, skipAir = false): Entity | null {
    // threat-first acquisition: anything that can shoot back outranks a harmless
    // target (harvester, power plant), and among equals the nearest wins. So a
    // unit clears the turret/tank threatening it before pecking at a refinery.
    let best: Entity | null = null, bestScore = -1e9;
    const attDef = UNITS[e.type];
    // a submarine torpedoes only ships and cruise-missiles only buildings — it
    // never engages land units or aircraft, and reaches buildings from afar
    const subAtt = !e.b && !!attDef?.cloak && attDef?.move === 'sea';
    const consider = (u: Entity, d: number) => {
      const dangerous = (u.b ? (BUILDINGS[u.type]?.attack?.dmg || 0) : (UNITS[u.type]?.dmg || 0)) > 0;
      const score = (dangerous ? 1000 : 0) - d; // dangerous first, then closest
      if (score > bestScore) { bestScore = score; best = u; }
    };
    for (const u of this.nearbyUnits(e.x, e.z, range + 1)) {
      if (!this.foe(u.owner, e.owner) || u.hp <= 0 || !this.players[u.owner].alive) continue;
      const d = this.distToEnt(e.x, e.z, u);
      const tdef = UNITS[u.type];
      if (tdef?.mine) continue;                     // buried proximity mines aren't visible targets
      if (subAtt && tdef?.kind !== 'sea') continue; // subs only torpedo other ships
      const cloaked = tdef?.cloak || (tdef?.stealthTech && this.players[u.owner]?.tech?.stealth);
      if (cloaked) {
        if (tdef.move === 'sea') {
          // submarine: only a sonar ship (Destroyer / Sub Hunter) holds the
          // contact, and only inside its sonar reach (the destroyer's is short)
          const sonar = UNITS[e.type]?.sonar || 0;
          if (!sonar || d > sonar) continue;
        } else if (d > 4) continue;                 // stealth land unit: seen only up close
      }
      // never auto-lock onto air targets the attacker cannot hurt (turret, MLRS)
      if (UNITS[u.type]?.fly && (skipAir || dmgMul(e.type, false, 'air', u.type) <= 0)) continue;
      if (d <= range) consider(u, d);
    }
    // buildings (few — linear scan). Walls and tank barriers are inert obstacles,
    // never auto-targeted: ground units route around them, air flies over.
    // submarines never AUTO-target buildings (only on an explicit player order).
    if (!subAtt) for (const u of this.ents.values()) {
      if (!u.b || !this.foe(u.owner, e.owner) || u.hp <= 0 || !this.players[u.owner].alive) continue;
      if (u.type === 'wall' || u.type === 'barrier') continue;
      const d = this.distToEnt(e.x, e.z, u);
      if (d <= range) consider(u, d);
    }
    return best;
  }

  private dealDamage(att: Entity, tgt: Entity, base: number, force = false) {
    if (!force && !this.foe(att.owner, tgt.owner)) return; // no friendly fire — unless force-fired
    // submarines are immune to everything but dedicated anti-submarine warfare:
    // only a sonar-equipped ship (Destroyer / Sub Hunter) can actually hurt one
    if (!tgt.b && UNITS[tgt.type]?.cloak && UNITS[tgt.type]?.move === 'sea' && !UNITS[att.type]?.sonar) return;
    // ...and a submarine itself only hits ships (torpedoes) and buildings (cruise
    // missiles) — never land units or aircraft
    if (UNITS[att.type]?.cloak && UNITS[att.type]?.move === 'sea' && !tgt.b && UNITS[tgt.type]?.kind !== 'sea') return;
    let mul = dmgMul(att.type, tgt.b, tgt.b ? 'b' : UNITS[tgt.type].kind, tgt.b ? undefined : tgt.type);
    if (!tgt.b) {
      if (tgt.fortT > 0) mul *= FORT_DEPLOY_VULN;        // exposed while digging in / packing up
      else if (tgt.fortified) {
        // sandbags stop bullets but not gas: chem/bio weapons devastate the
        // dug-in instead of being soaked by the fortify armor
        mul *= /^(chem|bio)/.test(att.type) ? 1.7 : FORT_DEF_MUL;
      }
    }
    const wasAlive = tgt.hp > 0;
    tgt.hp -= base * mul;
    // credit the destroyed-by tally to the attacker's faction on the lethal blow
    // (walls/barriers don't count; self-destruct/dismantle bypass this path)
    if (wasAlive && tgt.hp <= 0 && att.owner !== tgt.owner) {
      if (tgt.b) { if (tgt.type !== 'wall' && tgt.type !== 'barrier') this.stats.destB[att.owner]++; }
      else if (!UNITS[tgt.type]?.internal) this.stats.destU[att.owner]++;
    }
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
    if (ap?.isAI && att.owner !== tgt.owner && !att.b) {
      const k = UNITS[att.type]?.kind;
      if (k === 'inf' || k === 'veh' || k === 'air' || k === 'sea') {
        const led = this.dealtP[att.owner] || (this.dealtP[att.owner] = { inf: 0, veh: 0, air: 0, sea: 0 });
        led[k] += base * mul;
      }
    }
    if (!tgt.b) { tgt.lastHitBy = att.id; tgt.lastHitT = this.tickN; } // for return-fire / flee
    this.dmgLog.push({ vOwner: tgt.owner, victim: tgt.id, by: att.id, x: tgt.x, z: tgt.z, b: tgt.b });
  }

  private fire(att: Entity, tgt: Entity, dmg: number, rof: number, force = false): boolean {
    if (att.holdFire && !force) return false; // weapons-hold: never fires on its own
    if (att.cd > 0) return false;
    att.cd = rof;
    att.aimX = tgt.x; att.aimZ = tgt.z;
    this.dealDamage(att, tgt, dmg, force);
    const ud = UNITS[att.type];
    if (ud?.splash) this.splashHit(att, tgt.x, tgt.z, dmg, ud.splash, tgt.id, force); // artillery AoE
    // weapon class: 0 mg, 1 rocket, 2 cannon, 3 drone zap, 4 missile salvo
    const tgtInf = !tgt.b && UNITS[tgt.type]?.kind === 'inf';
    const w = att.type === 'rifle' || att.type === 'ifv' ? 0
      : att.type === 'sub' ? (tgt.b ? 8 : 7)                                 // sub: cruise missile vs buildings, torpedo vs ships
      : att.type === 'flak' ? 5                                              // pom-pom flak
      : att.type === 'rocket' || att.type === 'sam' || att.type === 'aatank' ? 1
      : att.type === 'mlrs' || att.type === 'msldrone' || att.type === 'mortar' || att.type === 'artillery' || att.type === 'artyship' ? 4
      : att.type === 'heli' || att.type === 'helidrone' ? (tgtInf ? 0 : 1)   // guns vs inf, rockets vs veh/bld
      : att.type === 'heavy' || att.type === 'destroyer' ? 6                 // heavy/naval gun
      : att.type === 'cannon' ? 9                                            // Heavy Cannon emplacement: visible shell
      : att.type === 'tesla' ? 10                                            // Tesla Coil: lightning bolt
      : ud?.kind === 'air' ? 3 : 2;
    const ev: any = { e: 'shot', x: att.x, z: att.z, tx: tgt.x, tz: tgt.z, w };
    if (ud?.fly) ev.f = 1;
    this.events.push(ev);
  }

  // artillery area-of-effect: splash everything (foes; friends too on force-fire)
  // around the shell's impact with linear falloff. dealDamage applies the matrix
  // + friendly-fire rules per target, so we just hand it the reduced amount.
  private splashHit(att: Entity, x: number, z: number, base: number, R: number, primaryId: number, force: boolean) {
    const R2 = R * R;
    for (const o of this.nearbyUnits(x, z, R)) {
      if (o.b || o.id === primaryId || o.id === att.id || o.hp <= 0) continue;
      const dx = o.x - x, dz = o.z - z, d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      this.dealDamage(att, o, base * (1 - 0.55 * (Math.sqrt(d2) / R)) * 0.7, force);
    }
    for (const o of this.ents.values()) {
      if (!o.b || o.id === primaryId || o.hp <= 0) continue;
      const d = this.distToEnt(x, z, o);
      if (d > R) continue;
      this.dealDamage(att, o, base * (1 - 0.55 * (d / R)) * 0.7, force);
    }
  }

  // commando (Melody) special engagement: against a building she plants a heavy
  // demolition charge (big flat damage, ignores her feeble structure multiplier);
  // against a vehicle/ship she launches a homing kamikaze drone that chases it down
  private commandoSpecial(u: Entity, tgt: Entity, def: any) {
    if (tgt.b) {
      const wasAlive = tgt.hp > 0;
      tgt.hp -= def.demoCharge || 1200;                 // C4 cuts through any armour
      if (wasAlive && tgt.hp <= 0 && tgt.type !== 'wall' && tgt.type !== 'barrier' && u.owner !== tgt.owner)
        this.stats.destB[u.owner]++;
      u.cd = 5;                                         // time to set the next charge
      this.events.push({ e: 'boom', x: tgt.x, z: tgt.z, big: true });
    } else {
      // launch the anti-vehicle drone — it homes onto and detonates on the target
      const drone = this.spawnUnit(u.owner, def.droneVs || 'melodydrone', u.x, u.z);
      drone.orders = [{ k: 'attack', tgt: tgt.id, keep: true }];
      drone.stance = 1;
      u.cd = 4;                                         // reload between drones
      this.events.push({ e: 'shot', x: u.x, z: u.z, tx: tgt.x, tz: tgt.z, w: 4, f: 1 });
    }
  }

  // Mass-production bonus: if another finished building of the same type and owner
  // is currently producing the same unit, both build 25% faster. Encourages
  // splitting one unit across twin factories instead of stacking a single queue.
  private coProdBonus(b: Entity, type: string): number {
    for (const bb of this.ents.values()) {
      if (bb === b || !bb.b || bb.owner !== b.owner || bb.type !== b.type) continue;
      if (bb.progress < bb.total) continue;          // still under construction
      const h = bb.queue[0];
      if (h && h.type === type && h.paid !== false) return 1.25; // actively building same unit
    }
    return 1;
  }

  // ---------- buildings ----------
  private tickBuilding(b: Entity) {
    const pl = this.players[b.owner];
    const def = BUILDINGS[b.type];
    const rate = pl.fac.buildMul * pl.pf;

    // on fire (suicide truck): long-term damage until it burns out
    if (b.burnT && b.burnT > 0) {
      b.burnT -= TICK;
      b.hp -= (b.burnPs || 12) * TICK;
      if (this.tickN % 7 === b.id % 7)
        this.events.push({ e: 'burnfx', x: b.x + (this.rng.next() - 0.5) * b.size, z: b.z + (this.rng.next() - 0.5) * b.size });
      if (b.hp <= 0) return; // the death sweep takes it from here
    }

    if (b.progress < b.total) {
      const d = TICK * rate;
      b.progress = Math.min(b.total, b.progress + d);
      b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.85 * (d / b.total));
      if (b.progress >= b.total) {
        this.events.push({ e: 'done', x: b.x, z: b.z });
        this.stats.builtB[b.owner]++;
        if (b.type === 'refinery') this.spawnFreeHarvester(b);
      }
      return;
    }

    // power: a deactivated (user off) or load-shed (autoOff) building does NOTHING —
    // no production, research, income, defence or upgrade — and draws no power.
    if (b.off || b.autoOff) return;

    // Oil Rig: steady passive income while it stands (faction/difficulty scaled,
    // like harvester deliveries). It does nothing else, so we're done here.
    if (def.income) {
      pl.credits += def.income * TICK * pl.fac.incomeMul * pl.bonusIncome;
      return;
    }

    // building upgrade in progress: tick it down, then apply the level (and the
    // HP/level bonuses) when it completes. power shortage slows it like a build.
    if (b.upg) {
      b.upg.t -= TICK * rate;
      if (b.upg.t <= 0) {
        b.upg = undefined;
        b.lvl++;
        b.maxHp = Math.round(b.maxHp * 1.2);
        b.hp = Math.min(b.maxHp, b.hp + Math.round(b.maxHp * 0.2));
        this.events.push({ e: 'done', x: b.x, z: b.z });
      }
    }

    // research lab progresses one technology at a time
    if (b.research) {
      b.research.t -= TICK * rate;
      if (b.research.t <= 0) {
        pl.tech[b.research.tech] = true;
        this.events.push({ e: 'done', x: b.x, z: b.z });
        this.events.push({ e: 'tech', p: b.owner, tech: b.research.tech, x: b.x, z: b.z });
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
      if (pl.godmode) it.t = 0;                       // cheat: instant production
      // upgrades speed up production; a twin factory building the same unit adds +25%
      else it.t -= TICK * rate * (1 + 0.25 * (b.lvl - 1)) * this.coProdBonus(b, it.type);
      if (it.t <= 0 && UNITS[it.type].missile) {
        // missiles don't spawn — they arm the silo, stacking up to MISSILE_CAP
        (b.missileStock ??= []).push(it.type);
        b.storedMissile = b.missileStock[0]; // UI hint: the next to fly
        b.lastMissile = it.type;
        b.queue.shift();
        this.events.push({ e: 'ready', p: b.owner });
        // repeat: keep building missiles while toggled on (uncapped)
        if (b.rpt)
          b.queue.push({ type: it.type, t: UNITS[it.type].buildTime, t0: UNITS[it.type].buildTime, paid: false });
      } else if (it.t <= 0) {
        const c = UNITS[it.type].move === 'sea'
          ? nearestSea(this.map, b.cx + ((b.size / 2) | 0), b.cz + b.size, 8)
          : nearestPassable(this.map, b.cx + ((b.size / 2) | 0), b.cz + b.size);
        if (c) {
          const u = this.spawnUnit(b.owner, it.type, c.x + 0.5, c.z + 0.5);
          this.stats.builtU[b.owner]++;
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
          } else if (!UNITS[it.type].cargo && !UNITS[it.type].fly && u.orders.length === 0) {
            // no rally/patrol set: drive a couple of cells clear of the building
            // so the new unit is visible instead of hidden in the doorway
            const sx = c.x + 0.5, sz = c.z + 0.5;
            const dx = sx - b.x, dz = sz - b.z, dl = hyp(dx, dz) || 1;
            u.orders = [{ k: 'move', x: sx + (dx / dl) * 2.5, z: sz + (dz / dl) * 2.5 }];
          }
          // volley units (Shahed): a single build order launches a whole swarm
          const vol = UNITS[it.type].volley || 1;
          for (let vk = 1; vk < vol; vk++) {
            const v = this.spawnUnit(b.owner, it.type, c.x + 0.5 + (this.rng.next() - 0.5) * 2.2, c.z + 0.5 + (this.rng.next() - 0.5) * 2.2);
            this.stats.builtU[b.owner]++;
            v.orders = u.orders.map(o => ({ ...o }));
          }
          b.queue.shift();
          this.events.push({ e: 'ready', p: b.owner });
          // repeat production: finished unit re-queues itself (charged on start).
          // hero/unique units (Melody, Bulldozer) are one-per-player, so they never
          // re-queue even with Repeat on.
          const rdef = UNITS[it.type];
          if (b.rpt && !rdef.unique && !rdef.commando) {
            if (!rdef.pad || this.padCapacityFree(b.owner, it.type))
              b.queue.push({ type: it.type, t: rdef.buildTime, t0: rdef.buildTime, paid: false });
          }
        } else it.t = 1; // exit blocked, retry shortly
      }
    }

    // garrison: an occupied building fires out with the COMBINED firepower of its
    // occupants plus a cover bonus. Occupants are protected (only the building's HP
    // takes hits); they all die only if the building is destroyed (see deaths()).
    if (def.garrison && b.cargoUnits && b.cargoUnits.length) {
      b.cd -= TICK; // garrison buildings have no def.attack, so tick the reload here
      let rng = 0, dmg = 0;
      for (const o of b.cargoUnits) { const od = UNITS[o.type]; if (od && od.dmg > 0) { if (od.range > rng) rng = od.range; dmg += od.dmg; } }
      if (dmg > 0) {
        const tgt = this.findEnemy(b, rng + 1.5);
        if (tgt) this.fire(b, tgt, dmg * GARR_ATK, 1.3, false);
      }
    }

    if (def.attack && this.tickN % 5 === b.id % 5) {
      // turret acquires targets periodically; fires every tick via cd
    }
    if (def.attack) {
      const ready = b.cd <= 0;                              // will this shot actually fire?
      b.cd -= TICK;
      const rng = def.attack.range + 0.8 * (b.lvl - 1);
      let tgt = this.findEnemy(b, rng, !!def.noAir);
      // force-fire: lock onto the commanded target (entity OR ground point) for a
      // short window, overriding the hold-fire toggle, as long as it stays in range
      let forced = false;
      if (b.forceT && b.forceT > 0) {
        b.forceT -= 1;
        const ft = b.forceTgt != null ? this.ents.get(b.forceTgt) : undefined;
        if (ft && ft.hp > 0 && (b.x - ft.x) * (b.x - ft.x) + (b.z - ft.z) * (b.z - ft.z) <= rng * rng) { tgt = ft; forced = true; }
        else if (b.forceX !== undefined) {
          const px = b.forceX, pz = b.forceZ!;
          if ((b.x - px) * (b.x - px) + (b.z - pz) * (b.z - pz) <= rng * rng) {
            // resolve whatever sits at the point (any owner — friend or foe)
            let hit: Entity | null = null, hd = 1.8;
            for (const o of this.nearbyUnits(px, pz, 2.4)) { if (o.hp <= 0 || o.id === b.id) continue; const dd = hyp(o.x - px, o.z - pz); if (dd < hd) { hd = dd; hit = o; } }
            for (const o of this.ents.values()) { if (!o.b || o.hp <= 0 || o.id === b.id) continue; const dd = this.distToEnt(px, pz, o); if (dd < hd) { hd = dd; hit = o; } }
            if (hit) { tgt = hit; forced = true; }
            else if (ready) { // empty ground: a suppressive shot at the spot
              b.cd = def.attack.rof / pl.pf; b.aimX = px; b.aimZ = pz;
              this.events.push({ e: 'shot', x: b.x, z: b.z, tx: px, tz: pz, w: 2 });
              tgt = null;
            }
          }
        }
      }
      if (tgt) {
        this.fire(b, tgt, def.attack.dmg * (1 + 0.25 * (b.lvl - 1)), def.attack.rof / pl.pf, forced);
        // tesla coil: the bolt briefly EMP-freezes the struck unit
        if (ready && def.emp && !tgt.b && tgt.hp > 0) {
          tgt.stunT = Math.max(tgt.stunT || 0, def.emp);
          this.events.push({ e: 'emp', x: tgt.x, z: tgt.z });
        }
      }
    }

    // missile silo with a standing strike order: bombard the zone (throttled)
    if (b.type === 'silo' && b.strikeR && b.strikeR > 0 && this.tickN % 3 === b.id % 3)
      this.siloAutoStrike(b);
  }

  // ---------- units ----------
  private tickUnit(u: Entity) {
    const def = UNITS[u.type];
    u.cd -= TICK;

    // TEWS area EMP: a periodic pulse that ONLY damages enemy drones in range
    // (and briefly stuns survivors). Harmless to infantry/vehicles/aircraft/ships.
    if (def.droneEmp && u.cd <= 0) {
      const e = def.droneEmp; let hit = false;
      for (const o of this.nearbyUnits(u.x, u.z, e.range)) {
        if (o.b || o.hp <= 0 || !this.foe(o.owner, u.owner) || !DRONE_TYPES.has(o.type)) continue;
        if ((o.x - u.x) * (o.x - u.x) + (o.z - u.z) * (o.z - u.z) > e.range * e.range) continue;
        this.dealDamage(u, o, e.dmg); hit = true;
        if (o.hp > 0) o.stunT = Math.max(o.stunT || 0, 0.6);
      }
      u.cd = e.cd;
      if (hit) this.events.push({ e: 'emp', x: u.x, z: u.z });
    }

    // proximity mine: lie dormant until an enemy ground unit steps within the
    // trigger radius, then detonate in an area blast (aircraft fly safely over)
    if (def.mine) {
      const trig = def.trigger || 1.5;
      let armed = false;
      for (const o of this.nearbyUnits(u.x, u.z, trig + 1)) {
        if (o.b || !this.foe(o.owner, u.owner) || o.hp <= 0 || UNITS[o.type]?.fly) continue;
        if ((o.x - u.x) * (o.x - u.x) + (o.z - u.z) * (o.z - u.z) <= trig * trig) { armed = true; break; }
      }
      if (armed) {
        const R = def.blastR || 2.4;
        const fake: any = { id: u.id, owner: u.owner, type: 'mine', b: false };
        for (const o of [...this.ents.values()]) {
          if (!this.foe(o.owner, u.owner) || o.hp <= 0 || (!o.b && UNITS[o.type]?.fly)) continue;
          const d = o.b ? this.distToEnt(u.x, u.z, o) : hyp(o.x - u.x, o.z - u.z);
          if (d <= R) this.dealDamage(fake, o, def.dmg * (1 - 0.4 * (d / R)));
        }
        u.hp = 0;
        this.events.push({ e: 'boom', x: u.x, z: u.z, big: true });
      }
      return;
    }

    // EMP stun (tesla coil): frozen solid — can't move or fire — until it wears off
    if (u.stunT && u.stunT > 0) {
      u.stunT -= TICK;
      if (this.tickN % 3 === u.id % 3) this.events.push({ e: 'empfx', x: u.x, z: u.z });
      return;
    }

    // self-destruct countdown → fireball (incinerates nearby enemies, like a
    // last stand) then the unit dies
    if (u.sd > 0) {
      const prev = Math.ceil(u.sd);
      u.sd -= TICK;
      if (Math.ceil(u.sd) !== prev && u.sd > 0) this.events.push({ e: 'sdtick', x: u.x, z: u.z, owner: u.owner });
      if (u.sd <= 0) {
        const R = 2.6;
        for (const o of this.nearbyUnits(u.x, u.z, R + 1)) {
          if (!this.foe(o.owner, u.owner) || o.hp <= 0 || o.id === u.id) continue;
          const d = hyp(o.x - u.x, o.z - u.z);
          if (d <= R) this.dealDamage(u, o, u.maxHp * 0.6 * (1 - 0.5 * (d / R)));
        }
        u.hp = 0;
        this.events.push({ e: 'boom', x: u.x, z: u.z, big: true });
        return;
      }
    }

    // ephemeral units (mini drones) self-destruct after their lifetime
    if (def.ephemeral) {
      u.ephLife += TICK;
      if (u.ephLife >= def.ephemeral) { u.hp = 0; return; }
    }

    // bulldozer terraform job: crawl toward the nearest cell still off-target and
    // reshape a brush of cells around it toward the target height. The dozer is a
    // crawler (drives over anything) so it can never strand itself; the job costs
    // credits per cell and finishes when every cell reaches the target.
    if (def.terra && u.terraPath && u.terraPath.length) {
      const pl = this.players[u.owner];
      const hs = u.terraHs;                                   // per-cell ramp (auto-bridge) or undefined
      const tgtAt = (k: number) => hs ? hs[k] : u.terraH!;
      const settled = (k: number) => Math.abs(this.map.cellH(u.terraPath![k].x, u.terraPath![k].z) - tgtAt(k)) < 0.2;
      // auto-bridge finishes the instant the two landmasses actually connect for
      // ground units — even if a few cells haven't reached their exact target yet
      const br = u.terraBridge;
      if (br) {
        const ra = this.map.regionAt(br.ax, br.az), rb = this.map.regionAt(br.bx, br.bz);
        if (ra >= 0 && ra === rb) {
          u.terraPath = undefined; u.terraHs = undefined; u.terraBridge = undefined;
          this.events.push({ e: 'done', x: u.x, z: u.z });
          return;
        }
      }
      let near: { x: number; z: number } | null = null, nd = 1e9;
      for (let k = 0; k < u.terraPath.length; k++) {
        if (settled(k)) continue;
        const c = u.terraPath[k];
        const dd = (u.x - (c.x + 0.5)) * (u.x - (c.x + 0.5)) + (u.z - (c.z + 0.5)) * (u.z - (c.z + 0.5));
        if (dd < nd) { nd = dd; near = c; }
      }
      if (!near) { u.terraPath = undefined; u.terraHs = undefined; u.terraBridge = undefined; this.events.push({ e: 'done', x: u.x, z: u.z }); return; }
      if (nd > 4) this.moveToward(u, near.x + 0.5, near.z + 0.5, def); // crawl to the work
      if (this.tickN % 2 === 0 && pl.credits >= 1) {
        for (let k = 0; k < u.terraPath.length; k++) {       // reshape a 5x5-ish brush
          const c = u.terraPath[k];
          if ((u.x - (c.x + 0.5)) * (u.x - (c.x + 0.5)) + (u.z - (c.z + 0.5)) * (u.z - (c.z + 0.5)) > 7 || settled(k)) continue;
          if (pl.credits < 1) break;
          pl.credits -= 1;                                   // cost per cell pulse
          this.map.terraform(c.x, c.z, tgtAt(k), 0.25);
          this.events.push({ e: 'terra', x: c.x + 0.5, z: c.z + 0.5 });
        }
      }
      return;
    }

    // fortify deploy / pack-up: the unit is rooted and vulnerable while it digs
    // in or tears down (the FORT_DEPLOY_VULN penalty is applied in dealDamage)
    if (u.fortT > 0) {
      u.fortT -= TICK;
      u.orders = u.orders.filter(o => o.k === 'fortify');
      if (u.fortT <= 0) { u.fortified = u.fortGoal; u.fortT = 0; u.emitCd = 1; this.events.push({ e: u.fortified ? 'dug' : 'packed', x: u.x, z: u.z }); }
      return;
    }

    // fortified infantry: dug in behind sandbags — hold position, fire harder
    // at anything in range (extended a touch); cannot move until unfortified
    if (def.fortify && u.fortified && !def.emits) {
      u.orders = u.orders.filter(o => o.k === 'fortify');
      if (def.dmg > 0 && u.cd <= 0) {
        const tgt = this.findEnemy(u, def.range * FORT_RANGE_MUL);
        if (tgt) this.fire(u, tgt, def.dmg * FORT_ATK_MUL, def.rof);
      }
      return;
    }

    // fortified drone hive: stationary watchtower with extended reach. It scans
    // for the nearest enemy in range and launches interceptor drones DIRECTLY
    // at it — fast under threat, a slow standing screen when quiet.
    if (def.fortify && u.fortified) {
      u.orders = u.orders.filter(o => o.k === 'fortify');
      // When shelled — especially by long-range artillery (MLRS / Mortar) that
      // out-ranges or out-prioritises the hive's scan — scramble drones after the
      // ACTUAL attacker, not just the nearest intruder. lastHitBy/lastHitT (set
      // in dealDamage) name it; drones have a long life + high speed, so they can
      // chase a distant artillery piece down. Falls back to nearest-in-range.
      let attacker: Entity | null = null;
      if (this.tickN - u.lastHitT < 60 && this.ents.has(u.lastHitBy)) {
        const a = this.ents.get(u.lastHitBy)!;
        if (a.hp > 0 && this.foe(a.owner, u.owner)) attacker = a;
      }
      const threat = attacker || (def.range > 0 ? this.findEnemy(u, def.range * FORT_RANGE_MUL) : null);
      u.emitCd -= TICK;
      if (u.emitCd <= 0 && def.emits) {
        const c = nearestPassable(this.map, Math.floor(u.x), Math.floor(u.z));
        if (c) {
          const d = this.spawnUnit(u.owner, def.emits, c.x + 0.5, c.z + 0.5);
          d.stance = 0;
          if (threat) { d.orders = [{ k: 'attack', tgt: threat.id }]; d.cmdT = this.tickN; } // hunt the attacker / intruder
          u.emitCd = threat ? 1.8 : 9; // swarm a real threat; idle patrol otherwise
        } else u.emitCd = 1;
      }
      return;
    }

    // stuck detection: tried to move last tick but went nowhere → wiggle out
    if (!def.fly) {
      const movedSq = (u.x - u.wx) * (u.x - u.wx) + (u.z - u.wz) * (u.z - u.wz);
      if (u.mvi === this.tickN - 1 && movedSq < 0.0012) u.stuckT += TICK;
      else u.stuckT = 0;
      u.wx = u.x; u.wz = u.z;
      if (u.stuckT >= 1.0) {
        u.stuckT = 0;
        u.path = null; // force a replan
        const a0 = this.rng.int(8);
        const sea = def.move === 'sea', crawl = !!def.terra, amphi = !!def.amphibious;
        for (let k = 0; k < 8; k++) {
          const a = ((a0 + k) & 7) * 0.7854;
          const nx = u.x + dcos(a) * 0.7, nz = u.z + dsin(a) * 0.7;
          const okC = crawl ? this.map.passableCrawler(Math.floor(nx), Math.floor(nz))
            : amphi ? this.map.passableAmphi(Math.floor(nx), Math.floor(nz))
              : sea ? this.map.passableSea(Math.floor(nx), Math.floor(nz))
                : this.map.passable(Math.floor(nx), Math.floor(nz));
          if (okC) { u.x = nx; u.z = nz; break; }
        }
      }
    }

    // ---- stance reactions (run even mid-order) ----
    if (u.reactCd > 0) u.reactCd--;
    const recentlyHit = this.tickN - u.lastHitT < 30;
    if (def.dmg > 0 && u.holdFire) {
      // weapons-hold: don't auto-engage, return fire, or chase — just hold
    } else if (def.dmg > 0) {
      const cur = u.orders[0];
      const busy = cur && (cur.k === 'attack' || cur.k === 'patrol');
      if (u.stance === 1) {
        // HOLD: never move for combat; fire only at enemies already in range
        if (!busy && u.cd <= 0 && this.tickN % 3 === u.id % 3) {
          const tgt = this.findEnemy(u, def.range);
          if (tgt) this.fire(u, tgt, def.dmg, def.rof);
        }
      } else {
        // AGGRESSIVE: return fire when hit, and auto-engage enemies in sight.
        // BUT a fresh player/AI order wins for ~2.5s so the player can always
        // pull a unit OUT of a firefight (fixed: units became unresponsive,
        // the return-fire kept burying every move command).
        const manual = this.tickN - u.cmdT < 25;
        // a player-locked attack target is sacrosanct: never auto-switch off it
        const sticky = cur && cur.k === 'attack' && cur.keep && this.ents.has(cur.tgt!);
        if (sticky) {
          // hold this exact target — drive to it and fire when in range
        } else if (recentlyHit && !busy && !manual && this.ents.has(u.lastHitBy) && this.canHarm(u, this.ents.get(u.lastHitBy)!)) {
          u.orders.unshift({ k: 'attack', tgt: u.lastHitBy }); u.path = null;
        } else if (!u.orders.length && this.tickN % 5 === u.id % 5) {
          const tgt = this.findEnemy(u, def.range + 2.5); // chase enemies in sight
          if (tgt) u.orders.unshift({ k: 'attack', tgt: tgt.id });
        } else if (cur && cur.k === 'attack' && this.tickN % 5 === u.id % 5) {
          // fighting advance: en route to a DISTANT target, clear whatever is
          // already in weapons range (turrets, escorts) instead of driving
          // through the kill zone; the deeper order resumes afterwards
          const dest = this.ents.get(cur.tgt!);
          const dDest = dest ? this.distToEnt(u.x, u.z, dest) : 1e9;
          if (dDest > def.range + 3) {
            const near = this.findEnemy(u, def.range + 1.0);
            if (near && near.id !== cur.tgt) { u.orders.unshift({ k: 'attack', tgt: near.id }); u.path = null; }
          }
        }
      }
    } else if (recentlyHit && u.reactCd <= 0 && this.ents.has(u.lastHitBy)) {
      // defenceless (harvester/engineer): run for cover — head to the nearest
      // friendly defensive structure (or the base) so they regroup under guns
      // instead of bolting into the open; fall back to fleeing away if we have none
      const att = this.ents.get(u.lastHitBy)!;
      let safe: Entity | null = null, bd = 1e9;
      for (const e of this.ents.values()) {
        if (!e.b || e.owner !== u.owner || e.hp <= 0 || e.progress < e.total) continue;
        if (!BUILDINGS[e.type]?.attack && e.type !== 'conyard') continue;
        const dd = (e.x - u.x) * (e.x - u.x) + (e.z - u.z) * (e.z - u.z);
        if (dd < bd) { bd = dd; safe = e; }
      }
      let fx: number, fz: number;
      if (safe) { fx = safe.x; fz = safe.z; }
      else {
        const dx = u.x - att.x, dz = u.z - att.z, d = hyp(dx, dz) || 1;
        fx = Math.max(1, Math.min(W - 1, u.x + (dx / d) * 9));
        fz = Math.max(1, Math.min(H - 1, u.z + (dz / d) * 9));
      }
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
      if (u.rzr && u.rzr > 0) {
        // assigned an auto-repair zone: fix damaged friendlies inside it, and
        // drift back toward the zone when there's nothing to do nearby
        const t = this.findDamagedFriendlyAt(u.owner, u.rzx!, u.rzz!, u.rzr, u.id);
        if (t) u.orders.unshift({ k: 'repair', tgt: t.id });
        else if (hyp(u.x - u.rzx!, u.z - u.rzz!) > u.rzr) u.orders.unshift({ k: 'move', x: u.rzx!, z: u.rzz! });
      } else {
        const t = this.findDamagedFriendly(u, 9);
        if (t) u.orders.unshift({ k: 'repair', tgt: t.id });
      }
    }

    // moving ground vehicles crush enemy infantry under their treads
    if (def.kind === 'veh' && u.mvi >= this.tickN - 1) {
      for (const o of this.nearbyUnits(u.x, u.z, 0.7)) {
        if (!this.foe(o.owner, u.owner) || o.hp <= 0) continue;
        if (UNITS[o.type]?.kind !== 'inf') continue;
        if ((o.x - u.x) * (o.x - u.x) + (o.z - u.z) * (o.z - u.z) > 0.42) continue;
        this.dealDamage(u, o, 9999);
        this.events.push({ e: 'crush', x: o.x, z: o.z });
      }
    }

    // waypoint repeat: finished the chain but repeat is on → run it again
    if (!u.orders.length && u.wpLoop && u.wpLoop.length) { u.orders = u.wpLoop.map(o => ({ ...o })); u.path = null; }

    const ord = u.orders[0];
    if (!ord) return;

    if (ord.k === 'move') {
      if (this.moveToward(u, ord.x!, ord.z!, def)) { u.orders.shift(); u.path = null; }
    } else if (ord.k === 'escort') {
      // shadow a friendly unit and engage anything that threatens it
      const t = this.ents.get(ord.tgt!);
      if (!t || t.hp <= 0) { u.orders.shift(); u.path = null; return; }
      if (def.dmg > 0 && !u.holdFire) {
        const threat = this.escortThreat(u, t, def.range + 6);
        if (threat) { u.orders.unshift({ k: 'attack', tgt: threat.id }); u.path = null; return; }
      }
      const d = hyp(t.x - u.x, t.z - u.z);
      if (d > 3.2) this.moveToward(u, t.x, t.z, def); else u.path = null; // hold near it when close
    } else if (ord.k === 'board') {
      // walk to a transport ship and embark when adjacent (it sits just offshore)
      const ship = this.ents.get(ord.tgt!);
      if (!ship || ship.hp <= 0 || !UNITS[ship.type]?.carrier || ship.owner !== u.owner) { u.orders.shift(); u.path = null; return; }
      if (!canBoard(ship, u.type)) { u.orders.shift(); u.path = null; return; } // full or not loadable
      if (Math.hypot(ship.x - u.x, ship.z - u.z) <= 2.6) {
        (ship.cargoUnits ??= []).push(u);   // stow aboard
        this.ents.delete(u.id);             // leave the map while carried (safe: tick iterates a copy)
        u.orders = []; u.path = null;
        this.events.push({ e: 'board', x: u.x, z: u.z });
        return;
      }
      this.moveToward(u, ship.x, ship.z, def); // pathing lands a land unit on the shore beside the ship
    } else if (ord.k === 'garrison') {
      // walk into a neutral/own garrison building and fire out from inside
      const b = this.ents.get(ord.tgt!);
      if (!b || b.hp <= 0 || !b.b || !BUILDINGS[b.type]?.garrison || UNITS[u.type]?.kind !== 'inf') { u.orders.shift(); u.path = null; return; }
      // can only enter if it's empty (neutral) or already held by us — not an enemy's
      if (b.owner !== this.neutralP && b.owner !== u.owner) { u.orders.shift(); u.path = null; return; }
      if (!this.canGarrison(b)) { u.orders.shift(); u.path = null; return; } // full
      const reach = b.size / 2 + 1.6;
      if (Math.abs(b.x - u.x) <= reach && Math.abs(b.z - u.z) <= reach) {
        if (b.owner === this.neutralP) b.owner = u.owner; // capture the empty building
        (b.cargoUnits ??= []).push(u);
        this.ents.delete(u.id);
        u.orders = []; u.path = null;
        this.events.push({ e: 'board', x: u.x, z: u.z });
        return;
      }
      // the building's own cells are blocked, so path to a passable cell beside it
      const ap = nearestPassable(this.map, Math.floor(b.x), Math.floor(b.z), b.size + 3)
        || { x: Math.floor(b.x), z: Math.floor(b.z) };
      this.moveToward(u, ap.x + 0.5, ap.z + 0.5, def);
    } else if (ord.k === 'unload') {
      // drop all cargo: onto shore if we're close, otherwise sail to the nearest coast
      if (!(u.cargoUnits?.length)) { u.orders.shift(); u.path = null; return; }
      const shore = nearestPassable(this.map, Math.floor(u.x), Math.floor(u.z), 5);
      if (shore && Math.hypot(shore.x + 0.5 - u.x, shore.z + 0.5 - u.z) <= 4.5) {
        this.unloadAll(u);
        u.orders.shift(); u.path = null;
      } else {
        const coast = nearestPassable(this.map, Math.floor(u.x), Math.floor(u.z), 80);
        if (!coast) { u.orders.shift(); u.path = null; return; } // no land anywhere — give up
        // air transport flies straight over the land cell to drop; a ship parks in the sea beside it
        const drop = def.fly ? coast : (nearestSea(this.map, coast.x, coast.z, 8) || { x: Math.floor(u.x), z: Math.floor(u.z) });
        this.moveToward(u, drop.x + 0.5, drop.z + 0.5, def);
      }
    } else if (ord.k === 'force') {
      // force-fire at a fixed point (or a tracked entity), hitting friend OR foe
      let px = ord.x!, pz = ord.z!;
      const te = ord.tgt != null ? this.ents.get(ord.tgt) : null;
      if (ord.tgt != null) {
        if (!te || te.hp <= 0) { u.orders.shift(); u.path = null; return; } // target destroyed → done
        px = te.x; pz = te.z;
      }
      // suicide truck: a force-fire order means "drive there and detonate", not shoot
      if (def.bombTruck) {
        if (hyp(px - u.x, pz - u.z) <= 1.4) { this.truckBoom(u, true); return; }
        this.moveToward(u, px, pz, def);
        return;
      }
      const range = (te?.b && def.siegeRange) ? def.siegeRange : def.range;
      const d = hyp(px - u.x, pz - u.z);
      if (d <= range) {
        u.path = null;
        if (u.cd <= 0) {
          // resolve whatever sits at the point (explicit target preferred), any owner
          let hit: Entity | null = te && te.hp > 0 ? te : null;
          if (!hit) {
            let hd = 1.8;
            for (const o of this.nearbyUnits(px, pz, 2.4)) { if (o.hp <= 0 || o.id === u.id) continue; const dd = hyp(o.x - px, o.z - pz); if (dd < hd) { hd = dd; hit = o; } }
            for (const o of this.ents.values()) { if (!o.b || o.hp <= 0) continue; const dd = this.distToEnt(px, pz, o); if (dd < hd) { hd = dd; hit = o; } }
          }
          if (hit) this.fire(u, hit, def.dmg, def.rof, true); // force = bypass allegiance
          else { // empty ground: suppressive shot at the spot
            u.cd = def.rof; u.aimX = px; u.aimZ = pz;
            const w = u.type === 'sub' ? 7 : UNITS[u.type]?.kind === 'air' ? 3 : 2;
            this.events.push({ e: 'shot', x: u.x, z: u.z, tx: px, tz: pz, w, f: def.fly ? 1 : undefined });
          }
        }
      } else this.moveToward(u, px, pz, def); // close into weapon range
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
    } else if (ord.k === 'oilrig') {
      // drive onto the oil well and erect an Oil Rig there; the Engineer is consumed
      const ox = ord.ox!, oz = ord.oz!, i = oz * W + ox;
      if (!this.map.inB(ox, oz) || this.map.oil[i] !== 1 || this.map.occ[i]) { u.orders.shift(); u.path = null; return; }
      if (hyp(ox + 0.5 - u.x, oz + 0.5 - u.z) <= 1.6) {
        this.addBuilding(u.owner, 'oilrig', ox, oz, true);
        this.stats.builtB[u.owner]++;
        this.map.oreDirty = true; // hide the bare oil-well derrick under the new rig
        this.events.push({ e: 'done', x: ox + 0.5, z: oz + 0.5 });
        u.hp = 0; // the Engineer is spent building the rig
        u.orders = []; u.path = null;
        return;
      }
      this.moveToward(u, ox + 0.5, oz + 0.5, def);
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
      // can't actually hurt this target (e.g. a land unit ordered onto a sub, or
      // a sub onto a tank)? drop the order instead of pinging it harmlessly
      if (!this.canHarm(u, tgt)) { u.orders.shift(); u.path = null; return; }
      // patrolling units break off the chase if it drags them too far from the route
      if (u.orders[1]?.k === 'patrol' && this.tickN % 10 === u.id % 10) {
        const pp = u.orders[1].pts || [];
        let nearSq = 1e9;
        for (const q of pp) nearSq = Math.min(nearSq, (q.x - u.x) * (q.x - u.x) + (q.z - u.z) * (q.z - u.z));
        if (nearSq > 256) { u.orders.shift(); u.path = null; return; }
      }
      const d = this.distToEnt(u.x, u.z, tgt);
      const speed = def.speed * this.players[u.owner].fac.speedMul;
      // commando (Melody): demolition charge on buildings (point-blank), homing
      // drone on vehicles/ships (mid-range), sniper rifle on infantry/air
      if (def.commando) {
        const veh = !tgt.b && (UNITS[tgt.type]?.kind === 'veh' || UNITS[tgt.type]?.kind === 'sea');
        if (tgt.b || veh) {
          const reach = tgt.b ? 1.8 : 10;
          if (d <= reach) { u.path = null; if (u.cd <= 0) this.commandoSpecial(u, tgt, def); }
          else this.moveToward(u, tgt.x, tgt.z, def);
          return;
        }
        // infantry / aircraft: fall through to the normal sniper-fire path below
      }
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
      // suicide truck: drive to contact, then one giant fireball
      if (def.bombTruck) {
        if (d <= 1.4) { this.truckBoom(u); return; }
        u.repath -= 1;
        if (u.repath <= 0 || (!u.path && (u.pathFail || 0) === 0)) {
          u.path = findPath(this.map, u.x, u.z, tgt.x, tgt.z, 4500, false);
          u.pi = 0; u.repath = 12;
          if (!u.path) {
            if (++u.pathFail >= 2) { u.orders.shift(); u.path = null; u.pathFail = 0; return; }
            u.repath = 20;
          } else u.pathFail = 0;
        }
        this.stepPath(u, speed, 0);
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
      // subs (and any siege unit) reach buildings at their longer cruise range
      const atkRange = (tgt.b && def.siegeRange) ? def.siegeRange : def.range;
      if (d <= atkRange) {
        u.path = null;
        if (def.payload && u.ammo <= 0) { u.orders.unshift({ k: 'rtb' }); return; }
        if (this.fire(u, tgt, def.dmg, def.rof) && def.payload) {
          u.ammo--;
          if (u.ammo <= 0) u.orders.unshift({ k: 'rtb' }); // payload spent — fly home to rearm
        }
      } else {
        u.repath -= 1;
        // Recompute on the timer, OR immediately when we have a stale/empty path
        // but ONLY if we aren't already backing off from a failed search. A unit
        // whose target is walled off would otherwise run a full-cost A* EVERY
        // tick (path stays null) — the single biggest sim hotspot. pathFail>0
        // means "we just failed", so wait out the backoff instead of re-searching.
        // recompute on the timer, or right away when our path is empty AND we
        // aren't backing off from a failure (a fresh/just-finished path searches
        // immediately so commands stay responsive)
        if (u.repath <= 0 || (!u.path && (u.pathFail || 0) === 0)) {
          u.path = def.fly ? [{ x: tgt.x, z: tgt.z }]
            : findPath(this.map, u.x, u.z, tgt.x, tgt.z, 4500, def.move === 'sea');
          u.pi = 0; u.repath = 12;
          // can't reach the target. If a wall/barrier is blocking the way, BREACH
          // it (attack the nearest one toward the target) instead of giving up;
          // only abandon when the target is genuinely unreachable (e.g. across
          // water). Air just flies over, so this is ground-only.
          if (!u.path && !def.fly) {
            if (++u.pathFail >= 2) {
              u.pathFail = 0; u.path = null;
              const tgtIsWall = tgt.b && (tgt.type === 'wall' || tgt.type === 'barrier');
              const wall = tgtIsWall ? null : this.nearestWallToward(u, tgt);
              if (wall) { u.orders.unshift({ k: 'attack', tgt: wall.id, keep: true }); return; }
              u.orders.shift(); return;
            }
            u.repath = 20 + (u.id % 13); // backoff + per-unit jitter (desync retries)
          } else u.pathFail = 0;
        }
        this.stepPath(u, speed, def.fly ? 1 : def.move === 'sea' ? 2 : 0);
      }
    } else if (ord.k === 'harvest') {
      this.tickHarvest(u, ord, def);
    }
  }

  // fire the silo's stored missile at a point (consumes the warhead)
  private launchMissile(b: Entity, x: number, z: number) {
    const stock = b.missileStock;
    if (!stock || !stock.length) return false;
    const type = stock.shift()!;
    const mdef = UNITS[type];
    const tx = Math.max(0, Math.min(W - 0.01, x)), tz = Math.max(0, Math.min(H - 0.01, z));
    const ft = Math.max(12, Math.round((hyp(tx - b.x, tz - b.z) / (mdef.speed || 7)) * 10));
    this.pendingBlasts.push({ t: this.tickN + ft, x: tx, z: tz, type, owner: b.owner });
    this.events.push({ e: 'silo', x: b.x, z: b.z, tx, tz, ft });
    b.lastMissile = type;
    b.storedMissile = stock[0] || null; // next armed missile (or empty)
    return true;
  }

  // strike-zone autopilot: bombard the densest enemy cluster in the zone, auto-
  // rebuild between shots, and stand down once the zone is clear of enemies
  private siloAutoStrike(b: Entity) {
    if (!b.strikeR || b.strikeR <= 0 || b.progress < b.total) return;
    const pl = this.players[b.owner];
    const R = b.strikeR, R2 = R * R;
    // find the enemy in the zone with the most neighbors inside one blast radius
    let target: Entity | null = null, best = -1;
    const inZone: Entity[] = [];
    for (const e of this.ents.values()) {
      if (!this.foe(e.owner, b.owner) || e.hp <= 0 || !this.players[e.owner].alive) continue;
      const dx = e.x - b.strikeX!, dz = e.z - b.strikeZ!;
      if (dx * dx + dz * dz <= R2) inZone.push(e);
    }
    if (!inZone.length) { b.strikeR = 0; return; } // zone cleared — order complete
    for (const e of inZone) {
      let n = 0;
      for (const o of inZone) if ((o.x - e.x) * (o.x - e.x) + (o.z - e.z) * (o.z - e.z) <= 9) n++;
      if (e.b) n += 1; // bias slightly toward structures
      if (n > best) { best = n; target = e; }
    }
    // keep a missile cooking for the next salvo (when the stockpile runs dry)
    if (!(b.missileStock?.length) && !b.queue.length) {
      const type = b.lastMissile || 'cmissile';
      const def = UNITS[type];
      if (def && (!def.tech || pl.tech[def.tech])) {
        const cost = Math.round(def.cost * pl.fac.costMul * pl.bonusCost);
        if (pl.credits >= cost) { pl.credits -= cost; b.queue.push({ type, t: def.buildTime, t0: def.buildTime }); }
      }
    }
    if (b.missileStock?.length && target) this.launchMissile(b, target.x, target.z);
  }

  // anti-missile defence: each ready interceptor (Iron Dome building / Patriot
  // vehicle) shoots down one in-flight silo warhead whose target sits inside its
  // shield radius, then goes on cooldown — so a saturation salvo can still punch
  // through a lone battery. Cooldowns tick here for every interceptor.
  private tickIntercept() {
    const ints: { e: Entity; r2: number; cd: number }[] = [];
    for (const e of this.ents.values()) {
      const def: any = e.b ? BUILDINGS[e.type] : UNITS[e.type];
      if (!def?.intercept || e.hp <= 0) continue;
      if (e.b && e.progress < e.total) continue;            // still under construction
      if (e.icd && e.icd > 0) e.icd -= TICK;
      ints.push({ e, r2: def.intercept.range * def.intercept.range, cd: def.intercept.cd });
    }
    if (!ints.length || !this.pendingBlasts.length) return;
    const killed: typeof this.pendingBlasts = [];
    for (const bl of this.pendingBlasts) {
      let best: { e: Entity; r2: number; cd: number } | null = null, bd = 1e9;
      for (const it of ints) {
        if (it.e.icd && it.e.icd > 0) continue;             // reloading
        if (!this.foe(it.e.owner, bl.owner)) continue;
        const dx = it.e.x - bl.x, dz = it.e.z - bl.z, d2 = dx * dx + dz * dz;
        if (d2 > it.r2 || d2 >= bd) continue;
        bd = d2; best = it;
      }
      if (best) {
        best.e.icd = best.cd;                               // spend the interceptor
        killed.push(bl);
        this.events.push({ e: 'intercept', x: best.e.x, z: best.e.z, tx: bl.x, tz: bl.z });
      }
    }
    if (killed.length) this.pendingBlasts = this.pendingBlasts.filter(b => !killed.includes(b));
  }

  // missile impact: area damage with falloff; the warhead type drives dmgMul
  private missileBlast(bl: { x: number; z: number; type: string; owner: number }) {
    const mdef = UNITS[bl.type];
    const R = mdef.blastR || 3;
    const fake: any = { id: 0, owner: bl.owner, type: bl.type, b: false };
    for (const e of [...this.ents.values()]) {
      if (!this.foe(e.owner, bl.owner) || e.hp <= 0 || !this.players[e.owner].alive) continue;
      const d = e.b ? this.distToEnt(bl.x, bl.z, e) : hyp(e.x - bl.x, e.z - bl.z);
      if (d > R) continue;
      this.dealDamage(fake, e, mdef.dmg * (1 - 0.45 * (d / R)));
    }
    this.events.push({ e: 'boom', x: bl.x, z: bl.z, big: true });
  }

  // suicide truck: fuel-and-explosives fireball — incinerates infantry and
  // leaves buildings BURNING (damage over time) long after the blast
  private truckBoom(u: Entity, force = false) {
    const def = UNITS[u.type];
    const R = 3.0;
    for (const e of [...this.ents.values()]) {
      // a normal detonation only burns enemies; a FORCE-fire detonation (the player
      // deliberately drove it onto a spot) hits friend OR foe at full strength —
      // including your own buildings, e.g. to clear them off the map
      if (e.hp <= 0 || !this.players[e.owner].alive || (!force && !this.foe(e.owner, u.owner)) || (force && e.id === u.id)) continue;
      const d = e.b ? this.distToEnt(u.x, u.z, e) : hyp(e.x - u.x, e.z - u.z);
      if (d > R) continue;
      this.dealDamage(u, e, def.dmg * (1 - 0.4 * (d / R)));
      if (e.b && e.hp > 0) { e.burnT = Math.max(e.burnT || 0, 10); e.burnPs = 14; }
    }
    u.hp = 0;
    this.events.push({ e: 'boom', x: u.x, z: u.z, big: true });
    this.events.push({ e: 'boom', x: u.x + 0.8, z: u.z - 0.5, big: false });
    this.events.push({ e: 'boom', x: u.x - 0.6, z: u.z + 0.7, big: false });
  }

  // carpet release: the full remaining payload detonates around the target
  // with linear falloff — splash hits every enemy in the blast radius
  private bombDrop(u: Entity, tgt: Entity) {
    const def = UNITS[u.type];
    const total = def.dmg * Math.max(1, u.ammo);
    const R = 2.6;
    for (const e of [...this.ents.values()]) {
      if (e.owner === u.owner || e.hp <= 0 || !this.players[e.owner].alive) continue;
      const dist = e.b ? this.distToEnt(tgt.x, tgt.z, e) : hyp(e.x - tgt.x, e.z - tgt.z);
      if (dist > R) continue;
      this.dealDamage(u, e, total * (1 - 0.5 * (dist / R)));
    }
    u.ammo = 0;
    this.events.push({ e: 'boom', x: tgt.x, z: tgt.z, big: true });
  }

  private tickHarvest(u: Entity, ord: Order, def: any) {
    const cap = def.cargo as number;
    const pl = this.players[u.owner];
    const oilMiner = !!def.oilMiner, sea = def.move === 'sea';
    const deliverR = sea ? 6 : 1.6; // sea oil ships pump ashore from just offshore

    if (u.cargo >= cap || (u.cargo > 0 && this.map.ore[ord.oz! * W + ord.ox!] <= 0 && !this.findOreNear(ord, oilMiner, sea))) {
      // deliver (oil refines at the Ore Refinery just like ore)
      let ref: Entity | null = null, bd = 1e9;
      for (const e of this.ents.values()) {
        if (e.b && e.owner === u.owner && e.type === 'refinery' && e.progress >= e.total) {
          const d = this.distToEnt(u.x, u.z, e);
          if (d < bd) { bd = d; ref = e; }
        }
      }
      if (!ref) { u.path = null; return; } // wait for a refinery
      if (bd <= deliverR) {
        pl.credits += Math.round(u.cargoVal * pl.fac.incomeMul * pl.bonusIncome * (1 + 0.1 * (ref.lvl - 1)));
        u.cargo = 0; u.cargoVal = 0;
        this.events.push({ e: 'cash', x: ref.x, z: ref.z });
      } else {
        this.moveToward(u, ref.x, ref.z + ref.size / 2 + 0.5, def);
      }
      return;
    }

    // ensure ore at target — when the field is mined out, re-pick a fresh one
    // with the spread-aware chooser so the fleet fans out across fields
    if (this.map.ore[ord.oz! * W + ord.ox!] <= 0) {
      const n = this.chooseOre(u, ord.ban && ord.ban.length ? new Set(ord.ban) : undefined);
      if (!n) { if (u.cargo > 0) { /* deliver branch next tick */ } else u.orders.shift(); return; }
      ord.ox = n.x; ord.oz = n.z;
      u.path = null;
    }
    const tx = ord.ox! + 0.5, tz = ord.oz! + 0.5;
    const d = Math.sqrt((u.x - tx) * (u.x - tx) + (u.z - tz) * (u.z - tz));
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
        const n = ord.ban.length <= 6 ? this.chooseOre(u, new Set(ord.ban)) : null;
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

  private scanOre(ox: number, oz: number, R: number, ban: Set<number> | undefined, oilMiner: boolean, sea: boolean, reg: number): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null, bd = 1e9;
    for (let z = Math.max(0, oz - R); z < Math.min(H, oz + R); z++) {
      for (let x = Math.max(0, ox - R); x < Math.min(W, ox + R); x++) {
        const i = z * W + x;
        if ((ban && ban.has(i)) || !this.mineCellOk(i, x, z, oilMiner, sea, reg)) continue;
        const d = (x - ox) * (x - ox) + (z - oz) * (z - oz);
        if (d < bd) { bd = d; best = { x, z }; }
      }
    }
    return best;
  }

  // nearest ore cell within a harvester's assigned circular work area
  private scanOreZone(cx: number, cz: number, r: number): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null, bd = 1e9;
    const R = Math.ceil(r), ox = Math.floor(cx), oz = Math.floor(cz), r2 = r * r;
    for (let z = Math.max(0, oz - R); z < Math.min(H, oz + R + 1); z++)
      for (let x = Math.max(0, ox - R); x < Math.min(W, ox + R + 1); x++) {
        if (this.map.ore[z * W + x] <= 0) continue;
        const d = (x - cx) * (x - cx) + (z - cz) * (z - cz);
        if (d <= r2 && d < bd) { bd = d; best = { x, z }; }
      }
    return best;
  }

  private findOreNear(ord: Order, oilMiner = false, sea = false): { x: number; z: number } | null {
    // try locally first, then anywhere on the map — miners should never sit idle
    // just because the nearest field is far away. Stay on the same landmass (land)
    // / on water (sea ships); oil miners seek oil, harvesters seek ore.
    const ban = ord.ban && ord.ban.length ? new Set(ord.ban) : undefined;
    const reg = sea ? -1 : this.map.regionAt(ord.ox!, ord.oz!);
    return this.scanOre(ord.ox!, ord.oz!, 22, ban, oilMiner, sea, reg) || this.scanOre(ord.ox!, ord.oz!, Math.max(W, H), ban, oilMiner, sea, reg);
  }

  // Pick an ore cell for this harvester so the fleet SPREADS instead of blobbing
  // onto the single nearest field. Scores candidates by richness, travel
  // distance and how many friendly harvesters already work/head there. A
  // dedicated fraction of the AI's harvesters "prospect" the high-value gem
  // fields even when they sit in farther, riskier ground.
  private chooseOre(u: Entity, ban?: Set<number>): { x: number; z: number } | null {
    // a harvester with an assigned work area mines ONLY inside it; once the area
    // is exhausted the zone is released so the unit forages normally again
    if (u.hzr && u.hzr > 0) {
      const zb = this.scanOreZone(u.hzx!, u.hzz!, u.hzr);
      if (zb) return zb;
      u.hzr = 0;
    }
    const ox = Math.floor(u.x), oz = Math.floor(u.z);
    const oilMiner = !!UNITS[u.type].oilMiner, sea = UNITS[u.type].move === 'sea';
    const reg = sea ? -1 : this.map.regionAt(ox, oz); // land: only ore on the same landmass
    // tally where friendly harvesters are already working / heading (crowding)
    const targets: { x: number; z: number }[] = [];
    for (const e of this.ents.values()) {
      if (e.b || e.owner !== u.owner || e.id === u.id || !UNITS[e.type]?.cargo) continue;
      const o = e.orders[0];
      if (o && o.k === 'harvest' && o.ox !== undefined) targets.push({ x: o.ox, z: o.oz! });
      else targets.push({ x: e.x, z: e.z });
    }
    const prospector = !!this.players[u.owner]?.isAI && (u.id % 10) < 3; // ~30% chase value
    let best: { x: number; z: number } | null = null, bestScore = -1e9;
    const R = 48;
    for (let z = Math.max(0, oz - R); z < Math.min(H, oz + R); z++) {
      for (let x = Math.max(0, ox - R); x < Math.min(W, ox + R); x++) {
        const i = z * W + x;
        if ((ban && ban.has(i)) || !this.mineCellOk(i, x, z, oilMiner, sea, reg)) continue;
        const value = this.map.ore[i] * (this.map.gem[i] === 1 ? 3 : 1);
        const dist = hyp(x - ox, z - oz);
        let crowd = 0;
        for (const t of targets) if ((t.x - x) * (t.x - x) + (t.z - z) * (t.z - z) < 49) crowd++; // within ~7 cells
        const score = prospector
          ? value * 0.04 - dist * 0.25 - crowd * 1.5   // value first, distance/risk shrugged off
          : value * 0.012 - dist * 0.7 - crowd * 3.0;  // nearest + least-crowded field
        if (score > bestScore) { bestScore = score; best = { x, z }; }
      }
    }
    return best || this.findOreNear({ k: 'harvest', ox, oz, ban: ban ? [...ban] : undefined }, oilMiner, sea);
  }

  // can this cell be worked by the given miner? oil miners take only OIL wells
  // (sea ships: water wells; land trucks: same-landmass land wells); ore
  // harvesters take only non-oil ore on their own landmass.
  private mineCellOk(i: number, x: number, z: number, oilMiner: boolean, sea: boolean, reg: number): boolean {
    if (this.map.ore[i] <= 0) return false;
    if ((this.map.oil[i] === 1) !== oilMiner) return false;
    if (sea) return this.map.water[i] === 1;
    return reg < 0 || this.map.regionAt(x, z) === reg;
  }

  autoHarvest(u: Entity) {
    const ord: Order = { k: 'harvest', ox: Math.floor(u.x), oz: Math.floor(u.z) };
    const n = this.chooseOre(u);
    if (n) { ord.ox = n.x; ord.oz = n.z; u.orders = [ord]; }
  }

  // returns true when arrived
  // disgorge a transport's whole cargo onto nearby shore cells, spread out so
  // they don't all stack on one tile (separation tidies the rest)
  private unloadAll(ship: Entity) {
    const cu = ship.cargoUnits || [];
    const ring = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [0, 2], [-2, 0], [0, -2]];
    cu.forEach((u, i) => {
      const o = ring[i % ring.length];
      const c = nearestPassable(this.map, Math.floor(ship.x) + o[0] * 2, Math.floor(ship.z) + o[1] * 2, 14)
        || nearestPassable(this.map, Math.floor(ship.x), Math.floor(ship.z), 16)
        || { x: Math.floor(ship.x), z: Math.floor(ship.z) };
      u.x = c.x + 0.5; u.z = c.z + 0.5; u.px = u.x; u.pz = u.z;
      u.orders = []; u.path = null; u.cmdT = this.tickN;
      this.ents.set(u.id, u);                 // back onto the map
      this.events.push({ e: 'unload', x: u.x, z: u.z });
    });
    ship.cargoUnits = [];
  }

  // empty a garrison building onto the surrounding streets and return it to neutral
  private evacuate(b: Entity) {
    const cu = b.cargoUnits || [];
    const ring = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [0, 2], [-2, 0], [0, -2]];
    cu.forEach((u, i) => {
      const o = ring[i % ring.length];
      const c = nearestPassable(this.map, Math.floor(b.x) + o[0], Math.floor(b.z) + o[1], 8)
        || nearestPassable(this.map, Math.floor(b.x), Math.floor(b.z), 12)
        || { x: Math.floor(b.x), z: Math.floor(b.z) };
      u.x = c.x + 0.5; u.z = c.z + 0.5; u.px = u.x; u.pz = u.z;
      u.orders = []; u.path = null; u.cmdT = this.tickN;
      this.ents.set(u.id, u);
      this.events.push({ e: 'unload', x: u.x, z: u.z });
    });
    b.cargoUnits = [];
    if (this.neutralP >= 0) b.owner = this.neutralP; // empty → back to neutral, re-takeable
  }

  private moveToward(u: Entity, x: number, z: number, def: any): boolean {
    const d = Math.sqrt((u.x - x) * (u.x - x) + (u.z - z) * (u.z - z));
    if (d < 0.25) return true;
    const speed = def.speed * this.players[u.owner].fac.speedMul;
    if (def.fly) {
      // flyers travel in a straight line over anything
      const end = u.path?.[u.path.length - 1];
      if (!u.path || !end || (end.x - x) * (end.x - x) + (end.z - z) * (end.z - z) > 1) {
        u.path = [{ x, z }];
        u.pi = 0;
      }
      return this.stepPath(u, speed, 1);
    }
    const sea = def.move === 'sea';
    const crawl = !!def.terra;          // bulldozer: drives over anything
    const amphi = !!def.amphibious && !crawl;
    if (!u.path || u.pi >= u.path.length) {
      const end = u.path?.[u.path.length - 1];
      if (!end || (end.x - x) * (end.x - x) + (end.z - z) * (end.z - z) > 1) {
        u.path = findPath(this.map, u.x, u.z, x, z, 9000, sea, amphi, crawl);
        u.pi = 0;
        if (!u.path) return true; // unreachable — give up
      } else if (u.pi >= u.path.length) return true;
    }
    return this.stepPath(u, speed, crawl ? 4 : amphi ? 3 : sea ? 2 : 0);
  }

  // mode: 0 ground, 1 air, 2 sea, 3 amphibious (land + water), 4 crawler (anywhere)
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
    u.hx = dx / d; u.hz = dz / d; // travel heading — what the renderer faces along
    const step = Math.min(d, speed * TICK);
    dx = (dx / d) * step; dz = (dz / d) * step;
    const nx = u.x + dx, nz = u.z + dz;
    if (mode === 1) {
      u.x = Math.max(0.5, Math.min(W - 0.5, nx));
      u.z = Math.max(0.5, Math.min(H - 0.5, nz));
    } else {
      const passAt = mode === 4 ? (cx: number, cz: number) => this.map.passableCrawler(cx, cz)
        : mode === 3 ? (cx: number, cz: number) => this.map.passableAmphi(cx, cz)
          : mode === 2 ? (cx: number, cz: number) => this.map.passableSea(cx, cz)
            : (cx: number, cz: number) => this.map.passable(cx, cz);
      const ncx = Math.floor(nx), ncz = Math.floor(nz);
      let okCell = passAt(ncx, ncz);
      // a diagonal cell change must not squeeze between two blocked cells — stops
      // units slipping through wall corners/joins even when shoved off their path
      const ocx = Math.floor(u.x), ocz = Math.floor(u.z);
      if (okCell && ncx !== ocx && ncz !== ocz && !passAt(ncx, ocz) && !passAt(ocx, ncz)) okCell = false;
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
        if (BUILDINGS[e.type]?.income) this.map.oreDirty = true; // oil rig gone → restore the well marker
        this.events.push({ e: 'boom', x: e.x, z: e.z, big: true });
        if (e.type !== 'wall' && e.type !== 'barrier') this.stats.lostB[e.owner]++;
        // a garrison building destroyed with troops inside: the occupants die with it
        if (e.cargoUnits?.length) { for (const c of e.cargoUnits) if (!UNITS[c.type]?.internal) this.stats.lostU[c.owner]++; e.cargoUnits = []; }
      } else {
        this.events.push({ e: 'boom', x: e.x, z: e.z, big: false });
        if (!UNITS[e.type]?.internal) this.stats.lostU[e.owner]++;
        // a transport sunk with troops aboard: they go down with the ship
        if (e.cargoUnits?.length) { for (const c of e.cargoUnits) if (!UNITS[c.type]?.internal) this.stats.lostU[c.owner]++; e.cargoUnits = []; }
        // AI casualty ledger (drives the next game's unit-mix preferences)
        if (this.players[e.owner]?.isAI) {
          const k = UNITS[e.type]?.kind as keyof typeof this.aiLost;
          if (k && this.aiLost[k] !== undefined && !UNITS[e.type]?.internal) this.aiLost[k]++;
          if (e.type === 'harv') this.aiHarvLost++;
          if (k && !UNITS[e.type]?.internal) {
            const led = this.lostP[e.owner] || (this.lostP[e.owner] = { inf: 0, veh: 0, air: 0, sea: 0 });
            if (led[k] !== undefined) led[k]++;
          }
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
    let lastAlive = -1;
    const aliveTeams = new Set<number>();
    const PROD = ['barracks', 'factory', 'dronefac', 'airforce', 'shipyard'];
    this.players.forEach((pl, i) => {
      if (!pl.alive || pl.neutral) return; // neutral slot is never a contender
      // inventory this player's surviving assets
      let anyEnt = false, builder = false, producer = false, harv = false, refinery = false;
      for (const e of this.ents.values()) {
        if (e.owner !== i || e.hp <= 0) continue;
        anyEnt = true;
        if (e.b) {
          if (e.type === 'conyard') builder = true;           // can place new buildings
          if (e.type === 'refinery') refinery = true;
          if (e.progress >= e.total && PROD.includes(e.type)) producer = true; // can make units
        } else {
          if (UNITS[e.type]?.deploys) builder = true;         // an MCV can redeploy a conyard
          if (e.type === 'harv') harv = true;
        }
      }
      let defeated: boolean;
      if (!anyEnt) {
        defeated = true;                                      // wiped out (humans only lose here)
      } else if (pl.isAI) {
        // the AI gives up only when it genuinely can't recover: it can neither
        // build units nor build buildings, OR it has no economy at all (no
        // harvester, no refinery, no money) to ever fund anything again
        const income = harv || refinery || pl.credits >= 500;
        defeated = !((builder || producer) && income);
      } else {
        defeated = false;                                     // human: never auto-surrender while anything stands
      }
      if (defeated) {
        pl.alive = false;
        this.events.push({ e: 'elim', p: i });
        for (const e of this.ents.values()) if (e.owner === i && e.hp > 0) e.hp = 0; // disband
      } else { aliveTeams.add(pl.team); lastAlive = i; }
    });
    // the match ends when only ONE team still has players standing
    if (this.players.length > 1 && aliveTeams.size <= 1) {
      this.done = true;
      // credit a surviving human on the winning team (so they see VICTORY),
      // otherwise the last player standing represents the winning side
      this.winner = lastAlive;
      for (let i = 0; i < this.players.length; i++)
        if (this.players[i].alive && !this.players[i].isAI) { this.winner = i; break; }
      // hand the host a study report so the AI can adapt next game
      const hasHuman = this.players.some(pl => !pl.isAI);
      const hasAI = this.players.some(pl => pl.isAI);
      if (!this.reported && !hasHuman && hasAI && this.winner >= 0) {
        // AI-vs-AI simulation: study the WINNER's doctrine (damage dealt and
        // units lost per weapon class) — spectated matches train the AI too
        this.reported = true;
        const wd = this.dealtP[this.winner] || { inf: 0, veh: 0, air: 0, sea: 0 };
        const wl = this.lostP[this.winner] || { inf: 0, veh: 0, air: 0, sea: 0 };
        this.events.push({
          e: 'aiReport',
          r: {
            simMatch: true, aiWon: true,
            winnerName: this.players[this.winner].name, winnerLvl: this.players[this.winner].aiLvl,
            dealt: { inf: Math.round(wd.inf), veh: Math.round(wd.veh), air: Math.round(wd.air), sea: Math.round(wd.sea) },
            lost: { ...wl },
            len: Math.round(this.tickN / 10),
          },
        });
      } else if (!this.reported && hasHuman && hasAI) {
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
            cheated: this.cheated,
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
        if (e.upg) v.up = Math.round((1 - e.upg.t / e.upg.t0) * 100) / 100;
        if (e.storedMissile) v.ms = e.storedMissile;
        if (e.missileStock && e.missileStock.length) v.msn = e.missileStock.length;
        if (e.strikeR && e.strikeR > 0) { v.kx = e.strikeX; v.kz = e.strikeZ; v.kr = e.strikeR; }
        if (e.burnT && e.burnT > 0) v.bn = 1;
        if (e.holdFire) v.hf = 1;                       // defensive building on weapons-hold
      } else {
        if (e.stance) v.st = e.stance;
        if (e.fortified) v.fo = 1;
        if (e.fortT > 0) v.ft = e.fortGoal ? 1 : 2; // 1 = digging in, 2 = packing up
        if (UNITS[e.type]?.cloak || (UNITS[e.type]?.stealthTech && this.players[e.owner]?.tech?.stealth)) v.ck = 1;
        if (e.holdFire) v.hf = 1;
        if (e.orders[0]?.k === 'patrol') v.pa = 1;
        if (e.cargoUnits && e.cargoUnits.length) v.cu = e.cargoUnits.length;
        if (e.wpLoop && e.wpLoop.length) v.lp = 1;
        if (e.orders && e.orders.length) {
          const wp: { x: number; z: number; a: number }[] = [];
          for (const o of e.orders) {
            if (o.k === 'move' || o.k === 'force') wp.push({ x: o.x!, z: o.z!, a: o.k === 'force' ? 1 : 0 });
            else if (o.k === 'harvest' && o.ox !== undefined) wp.push({ x: o.ox + 0.5, z: o.oz! + 0.5, a: 0 });
            else if (o.k === 'attack' && o.tgt != null) { const t = this.ents.get(o.tgt); if (t) wp.push({ x: t.x, z: t.z, a: 1 }); }
            if (wp.length >= 24) break;
          }
          if (wp.length) v.wp = wp;
        }
        if (e.rzr && e.rzr > 0) { v.rzx = e.rzx; v.rzz = e.rzz; v.rzr = e.rzr; }
        if (e.hzr && e.hzr > 0) { v.hzx = e.hzx; v.hzz = e.hzz; v.hzr = e.hzr; }
        if (e.cd > 0 && UNITS[e.type]?.dmg > 0) {
          v.fr = 1; // mid-reload = in a firefight (drives aim pose)
          if (e.aimX !== undefined) { v.ax = Math.round(e.aimX * 10) / 10; v.az = Math.round(e.aimZ! * 10) / 10; }
        }
        if (e.sd > 0) v.sd = Math.ceil(e.sd); // self-destruct countdown
      }
      ents.push(v);
    }
    return {
      k: this.tickN,
      e: ents,
      p: this.players.map(pl => ({
        c: Math.round(pl.credits), a: pl.alive, pm: Math.round(pl.powerMade), pu: Math.round(pl.powerUsed),
        n: pl.name, f: pl.faction, tm: pl.team, ai: pl.isAI, tech: Object.keys(pl.tech).filter(k => pl.tech[k]),
        god: pl.godmode ? 1 : 0, // cheat: client unlocks every unit in the build menu
      })),
      ev: this.events,
    };
  }
}
