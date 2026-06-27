// Client entry: menus, game loop, input. Two game modes share one interface:
// LocalGame (sim + AI in-browser) and NetGame (server-authoritative snapshots).

import { Sim } from '../sim/sim';
import { aiTick } from '../sim/ai';
import { FACTIONS, BUILDINGS, UNITS, PLAYER_COLORS, SIM_VERSION, UPG_MAX, SPACING_EXEMPT } from '../sim/data';
import { GameMap, genMap, setMapSize, W, H, MAXD, SEA } from '../sim/map';
import { Renderer, gfxQuality, preloadModels } from './render';
import { UI } from './ui';
import { twemojify, twemojiParse } from './twemoji';
import { safeLS } from './store';
import { Net } from './net';
import { RtcMesh, VoiceController } from './rtc';
import { prof } from './prof';
import { audio } from './audio';
import { runDeterminismProbe, mathCanary, detMathCanary } from '../sim/determinism';
import { runNetlessLockstep, LockstepEngine } from '../sim/lockstep';

// lockstep determinism gate (available from page load, even on the menu): run
// these in two browser engines and diff the digests — same hashes = cross-engine
// deterministic. __detmath() = native Math (expected to differ); __detmathDet()
// = the sim's deterministic replacements (must match); __detsim() = full run.
// See LOCKSTEP.md.
(window as any).__detsim = (seed = 12345, ticks = 3000, size = 112) => runDeterminismProbe(seed >>> 0, size, ticks);
(window as any).__detmath = () => mathCanary();
(window as any).__detmathDet = () => detMathCanary();
// netless lockstep validation: two in-process sims through a fake lossy link
(window as any).__lockstep = (seed = 12345, ticks = 1000, opts = {}) => runNetlessLockstep(seed >>> 0, ticks, opts);

// build stamp, injected by vite (see vite.config.ts)
declare const __APP_REV__: string;
declare const __APP_HASH__: string;
declare const __BUILD_TIME__: string;

interface GameLike {
  me: number;
  map: GameMap;
  tickN: number;
  isNet?: boolean;
  sendChat?(to: any, msg: string): void;
  chatTargets?(): { v: any; label: string }[];
  drainChat?(): any[];
  update(dtMs: number): void;
  views(): any[];
  players(): any[];
  drainEvents(): any[];
  issue(cmd: any): void;
  status(): { over: boolean; winner: number };
  leave(): void;
  // lockstep only: ms of wall time we've been frozen waiting on a peer's input
  // (0 when there are no human peers, or we're ticking normally). Drives the
  // "connection stalled" pause popup.
  stalledMs?(): number;
  netStats?(): any;
}

// sim entities -> client view objects (with `a` = 0..1 interpolation between the
// previous and current tick). Shared by LocalGame and NetLockstepGame.
function simViews(sim: Sim, a: number): any[] {
  const out: any[] = [];
  for (const e of sim.ents.values()) {
    const v: any = {
      i: e.id, o: e.owner, t: e.type, b: e.b ? 1 : 0,
      x: e.b ? e.x : e.px + (e.x - e.px) * a,
      z: e.b ? e.z : e.pz + (e.z - e.pz) * a,
      h: e.hp, m: e.maxHp, pr: e.b ? e.progress / e.total : 1,
    };
    if (e.b) {
      v.cx = e.cx; v.cz = e.cz; v.sz = e.size; v.lv = e.lvl; v.qn = e.queue.length;
      if (e.queue.length) { v.qt = 1 - e.queue[0].t / e.queue[0].t0; v.qy = e.queue[0].type; v.qq = e.queue.map(q => q.type); }
      if (e.rallyX >= 0) { v.rx = e.rallyX; v.rz = e.rallyZ; }
      if (e.patPts) v.pp = e.patPts;
      if (e.rpt) v.rp = 1;
      if (e.primary) v.pm = 1;
      if (e.research) { v.rs = e.research.tech; v.rsf = 1 - e.research.t / e.research.t0; }
      if (e.upg) v.up = 1 - e.upg.t / e.upg.t0;
      if (e.storedMissile) v.ms = e.storedMissile;
      if (e.missileStock && e.missileStock.length) v.msn = e.missileStock.length;
      if (e.strikeR && e.strikeR > 0) { v.kx = e.strikeX; v.kz = e.strikeZ; v.kr = e.strikeR; }
      if (e.burnT && e.burnT > 0) v.bn = 1;
      if (e.holdFire) v.hf = 1;
      // garrison buildings: mark them + report occupancy / capacity so the UI can
      // show occupants, the enter cursor, and the evacuate hint
      if (BUILDINGS[e.type]?.garrison) {
        v.gar = 1;
        v.cu = e.cargoUnits?.length || 0;
        v.gcap = Math.max(2, e.size * e.size);
        if (sim.players[e.owner]?.neutral) v.ne = 1; // empty/neutral (not owned by a player)
      }
    } else {
      // per-TICK travel (framerate-independent): real path movement is ~0.2+/tick,
      // a collision shove/micro-nudge is far smaller — only the former animates legs
      const ddx = e.x - e.px, ddz = e.z - e.pz;
      if (ddx * ddx + ddz * ddz > 0.0036) v.mv = 1;
      // travel heading the renderer faces along — set only by real path steps, so a
      // collision shove (e.g. harvesters bunched at ore / the refinery) can't spin
      // the model sideways the way the raw position delta would
      if (e.hx !== undefined) { v.hx = e.hx; v.hz = e.hz; }
      if (e.stance) v.st = e.stance;
      if (e.fortified) v.fo = 1;
      if (e.fortT > 0) v.ft = e.fortGoal ? 1 : 2;
      if (UNITS[e.type]?.cloak || (UNITS[e.type]?.stealthTech && sim.players[e.owner]?.tech?.stealth)) v.ck = 1;
      if (e.cd > 0 && UNITS[e.type]?.dmg > 0) { v.fr = 1; if (e.aimX !== undefined) { v.ax = e.aimX; v.az = e.aimZ; } }
      if (e.sd > 0) v.sd = Math.ceil(e.sd);
      if (e.rzr && e.rzr > 0) { v.rzx = e.rzx; v.rzz = e.rzz; v.rzr = e.rzr; }
      if (e.hzr && e.hzr > 0) { v.hzx = e.hzx; v.hzz = e.hzz; v.hzr = e.hzr; }
      if (e.holdFire) v.hf = 1;
      if (e.orders[0]?.k === 'patrol') v.pa = 1;
      if (e.orders[0]?.k === 'harvest') v.hv = 1; // actively on a gather/deliver run
      if (e.terraPath && e.terraPath.length) v.tf = 1; // bulldozer mid-terraform: ride the real ground, never float
      if (e.cargoUnits && e.cargoUnits.length) v.cu = e.cargoUnits.length; // transport: units aboard
      { const cap = UNITS[e.type]?.cargo; if (cap) v.cg = Math.max(0, Math.min(1, e.cargo / cap)); } // harvester/oil-miner fill %
      if (e.ammo >= 0 && (UNITS[e.type]?.payload || 0) > 0) v.am = e.ammo;          // bomber bombs left this sortie
      if (UNITS[e.type]?.fly && (e as any).grounded) v.gr = 1;                      // bomber landed/parked on an airfield (render sits it on the pad)
      if (e.mineStock !== undefined && (UNITS[e.type]?.mines || 0) > 0) v.mn = e.mineStock; // engineer mines left
      if (e.wpLoop && e.wpLoop.length) v.lp = 1;                          // waypoint repeat on
      if (e.orders && e.orders.length) {                                  // remaining waypoints (for the path overlay)
        const wp: { x: number; z: number; a: number }[] = [];
        for (const o of e.orders) {
          if (o.k === 'move' || o.k === 'force') wp.push({ x: o.x!, z: o.z!, a: o.k === 'force' ? 1 : 0 });
          else if (o.k === 'harvest' && o.ox !== undefined) wp.push({ x: o.ox + 0.5, z: o.oz! + 0.5, a: 0 });
          else if (o.k === 'attack' && o.tgt != null) { const t = sim.ents.get(o.tgt); if (t) wp.push({ x: t.x, z: t.z, a: 1 }); }
          if (wp.length >= 24) break;
        }
        if (wp.length) v.wp = wp;
      }
      // standing ground force-fire / barrage target — kept so the marker (and the
      // barrage circle) stays drawn on the ground while the unit is selected
      const fo: any = e.orders.find((o: any) => o.k === 'force' && o.tgt == null && o.x != null);
      if (fo) { v.fax = fo.x; v.faz = fo.z; if (fo.r) v.far = fo.r; }
    }
    out.push(v);
  }
  return out;
}
function simPlayers(sim: Sim): any[] {
  return sim.players.map(pl => ({
    c: Math.floor(pl.credits), a: pl.alive, pm: Math.round(pl.powerMade), pu: Math.round(pl.powerUsed),
    pwr: Math.round(pl.power), pmax: Math.round(pl.powerMax), // stored battery + capacity for the HUD meter
    n: pl.name, f: pl.faction, tm: pl.team, ai: pl.isAI, tech: Object.keys(pl.tech).filter(k => pl.tech[k]), satOk: !!pl.satOk,
  }));
}

// ---------------- Local skirmish ----------------
class LocalGame implements GameLike {
  sim: Sim;
  me = 0;
  speed = 1; // 0.5×–8× sim speed (+/- keys); multiplayer has no such field
  isSim = false; // spectator simulation: AI vs AI, no human player
  tutorial = false; // guided first-game: passive enemy, scripted overlay, no replay upload
  private pending: any[] = [];
  private acc = 0;
  private evQ: any[] = [];
  private reportSaved = false;
  // replay recording: seed + the full command stream (incl. AI) replays exactly
  private recSeed = 0; private recSize = 96; private recPlayers: any[] = [];
  private recCmds: { k: number; c: any[] }[] = [];
  private recSaved = false;

  // simLvl2 !== null switches to simulation mode: two AIs fight, you spectate.
  // enemyLevels lists one difficulty per AI opponent (1-3) in a skirmish.
  constructor(name: string, faction: string, aiLvl = 1, size = 96, simLvl2: number | null = null, enemyLevels: number[] = [1], teams: number[] = [], tutorial = false) {
    this.tutorial = tutorial;
    // more players need more room — a 4-player FFA on a small map crams the
    // spawns together. Grow the map with the player count (never shrink the
    // player's chosen size), capped at the largest supported dimension.
    const nPlayers = simLvl2 !== null ? 2 : Math.min(4, 1 + enemyLevels.slice(0, 3).length);
    const minForPlayers = nPlayers >= 4 ? 160 : nPlayers === 3 ? 136 : 112;
    const effSize = Math.min(MAXD, Math.max(size, minForPlayers));
    setMapSize(effSize);
    // map type rides in seed bits 26-30; ore/oil level in bits 24-25 (0=normal)
    let seed = ((Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0) & ~0x7f000000;
    if (islandsEnabled) seed |= 0x40000000;
    if (urbanEnabled) seed |= 0x20000000;
    if (flatEnabled) seed |= 0x10000000;
    if (steelEnabled) seed |= 0x08000000;
    if (metalEnabled) seed |= 0x04000000;
    seed |= (oreLevelSel & 3) << 24;
    const LVL_NAMES = AI_DIFF_NAMES;
    const pickFacs = (avoid: string[], n: number) => {
      const pool = Object.keys(FACTIONS).filter(f => !avoid.includes(f));
      const out: string[] = [];
      for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      return out;
    };
    if (simLvl2 !== null) {
      this.isSim = true;
      const [f1, f2] = pickFacs([], 2);
      this.sim = new Sim(seed, [
        { name: `AI ${FACTIONS[f1].name} (${LVL_NAMES[aiLvl]})`, faction: f1, isAI: true, aiLvl },
        { name: `AI ${FACTIONS[f2].name} (${LVL_NAMES[simLvl2]})`, faction: f2, isAI: true, aiLvl: simLvl2 },
      ]);
    } else {
      const lvls = enemyLevels.slice(0, 3);
      const facs = pickFacs([faction], lvls.length);
      const specs: any[] = [{ name, faction, team: teams[0] }];
      lvls.forEach((lv, i) =>
        specs.push({ name: `AI ${FACTIONS[facs[i]].name} (${LVL_NAMES[lv] || 'Normal'})`, faction: facs[i], isAI: true, aiLvl: lv, team: teams[i + 1] }));
      this.sim = new Sim(seed, specs);
      this.recSeed = seed; this.recSize = effSize; this.recPlayers = specs.map(s => ({ ...s }));
    }
    // the AI studies past games and adapts: server intelligence is primary,
    // the browser's own profile fills in when the server is unreachable
    this.sim.aiProfile = mergedProfile();
    if (tutorial) {
      // calm sandbox: the lone enemy sits still as a practice target, and the
      // learner gets a fat treasury so they can build whatever a step asks for
      this.sim.players.forEach(pl => { if (pl.isAI) pl.passive = true; });
      this.sim.players[0].credits = 12000;
    }
  }
  get map() { return this.sim.map; }
  get tickN() { return this.sim.tickN; }
  issue(cmd: any) { this.pending.push(cmd); }
  // send the finished skirmish to the server's replay store so it's watchable
  private uploadReplay() {
    if (!this.recPlayers.length) return;
    const meta = {
      // record the FULL spec (aiLvl + team included) so the replay reconstructs
      // the players identically — stripping them desynced economy/teams
      players: this.recPlayers.map(p => ({ name: p.name, faction: p.faction, isAI: !!p.isAI, aiLvl: p.aiLvl, team: p.team })),
      winner: this.sim.winner, winnerName: this.sim.winner >= 0 ? this.recPlayers[this.sim.winner]?.name : null,
      lenSec: Math.round(this.sim.tickN / 10), done: true,
    };
    fetch('/replays', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meta, seed: this.recSeed, size: this.recSize, ver: SIM_VERSION, cmds: this.recCmds }),
    }).catch(() => { /* offline / static host — replay just isn't stored */ });
  }
  update(dtMs: number) {
    this.acc += dtMs * this.speed;
    let guard = 0;
    const gMax = this.speed > 8 ? 48 : 8; // 16×/32× need more ticks per frame
    while (this.acc >= 100 && guard < gMax) {
      this.acc -= 100; guard++;
      const cmds = this.pending; this.pending = [];
      this.sim.players.forEach((pl, i) => { if (pl.isAI) cmds.push(...aiTick(this.sim, i)); });
      if (!this.isSim && cmds.length && this.recCmds.length < 20000) this.recCmds.push({ k: this.sim.tickN, c: cmds.map(x => ({ ...x })) });
      this.sim.tick(cmds);
      for (const ev of this.sim.events) {
        if (ev.e === 'aiReport' && !this.reportSaved) {
          this.reportSaved = true;
          if (!ev.r.cheated && !this.tutorial) { // godmode/tutorial never train the AI
            saveAiReport(ev.r);
            requestLesson(ev.r); // fire-and-forget post-mortem
          }
        }
      }
      // skip the replay too for cheated/tutorial games (would skew match analysis)
      if (this.sim.done && !this.recSaved && !this.isSim && !this.tutorial) { this.recSaved = true; if (!this.sim.cheated) this.uploadReplay(); }
      this.evQ.push(...this.sim.events);
    }
    if (guard >= gMax) this.acc = 0; // tab was backgrounded — drop the backlog
  }
  views(): any[] { return simViews(this.sim, Math.max(0, Math.min(1, this.acc / 100))); }
  players(): any[] { return simPlayers(this.sim); }
  drainEvents() { const e = this.evQ; this.evQ = []; return e; }
  status() { return this.sim.done ? { over: true, winner: this.sim.winner } : { over: false, winner: -2 }; }
  leave() {}
}

// ---------------- Replay playback ----------------
// A replay is { meta, seed, size, cmds } — the deterministic sim rebuilt from
// the seed and fed the recorded command stream (including the AI's commands).
class ReplayGame implements GameLike {
  sim: Sim;
  me = 0;
  speed = 2; // replays default to 2× — +/- adjusts as usual
  isSim = true;
  isReplay = true;
  meta: any;
  private cmds: { k: number; c: any[] }[];
  private ci = 0;
  private acc = 0;
  private evQ: any[] = [];

  constructor(data: any) {
    setMapSize(data.size || 96);
    this.meta = data.meta || {};
    this.sim = new Sim(data.seed, this.meta.players || []);
    this.cmds = data.cmds || [];
  }
  get map() { return this.sim.map; }
  get tickN() { return this.sim.tickN; }
  issue() { /* spectators don't command the past */ }
  update(dtMs: number) {
    this.acc += dtMs * this.speed;
    let guard = 0;
    const gMax = this.speed > 8 ? 48 : 8;
    while (this.acc >= 100 && guard < gMax) {
      this.acc -= 100; guard++;
      const cs: any[] = [];
      while (this.ci < this.cmds.length && this.cmds[this.ci].k <= this.sim.tickN) {
        cs.push(...this.cmds[this.ci].c); this.ci++;
      }
      this.sim.tick(cs);
      // note: NO aiReport handling — a replayed match must not double-learn
      this.evQ.push(...this.sim.events.filter(ev => ev.e !== 'aiReport'));
    }
    if (guard >= gMax) this.acc = 0;
  }
  views(): any[] {
    const a = Math.max(0, Math.min(1, this.acc / 100));
    const out: any[] = [];
    for (const e of this.sim.ents.values()) {
      const v: any = {
        i: e.id, o: e.owner, t: e.type, b: e.b ? 1 : 0,
        x: e.b ? e.x : e.px + (e.x - e.px) * a,
        z: e.b ? e.z : e.pz + (e.z - e.pz) * a,
        h: e.hp, m: e.maxHp, pr: e.b ? e.progress / e.total : 1,
      };
      if (e.b) {
        v.cx = e.cx; v.cz = e.cz; v.sz = e.size; v.lv = e.lvl; v.qn = e.queue.length;
        if (e.storedMissile) v.ms = e.storedMissile;
        if (e.burnT && e.burnT > 0) v.bn = 1;
        if (e.holdFire) v.hf = 1;                       // defensive building on weapons-hold
      } else {
        if (e.fortified) v.fo = 1;
        if (UNITS[e.type]?.fly && (e as any).grounded) v.gr = 1; // bomber landed/parked
        if (e.cd > 0 && UNITS[e.type]?.dmg > 0) {
          v.fr = 1;
          if (e.aimX !== undefined) { v.ax = e.aimX; v.az = e.aimZ; }
        }
      }
      out.push(v);
    }
    return out;
  }
  players(): any[] {
    return this.sim.players.map(pl => ({
      c: Math.floor(pl.credits), a: pl.alive, pm: Math.round(pl.powerMade), pu: Math.round(pl.powerUsed),
      pwr: Math.round(pl.power), pmax: Math.round(pl.powerMax), // stored battery + capacity for the HUD meter
      n: pl.name, f: pl.faction, tm: pl.team, ai: pl.isAI, tech: Object.keys(pl.tech).filter(k => pl.tech[k]), satOk: !!pl.satOk,
    }));
  }
  drainEvents() { const e = this.evQ; this.evQ = []; return e; }
  status() {
    // a replay is over when the sim ends OR the recorded commands run dry
    const dry = this.ci >= this.cmds.length && this.sim.tickN > (this.cmds[this.cmds.length - 1]?.k || 0) + 300;
    return (this.sim.done || dry) ? { over: true, winner: this.sim.winner } : { over: false, winner: -2 };
  }
  leave() { /* nothing to clean up */ }
}

// ---------------- Networked game ----------------
// voice chat channel options: Everyone, Team only, or one specific human player
function voiceTargetList(roster: { name: string; isAI?: boolean }[], me: number) {
  const t: { v: any; label: string }[] = [{ v: 'all', label: '🔊 Everyone' }, { v: 'team', label: '👥 Team only' }];
  roster.forEach((p, i) => { if (i !== me && !p.isAI) t.push({ v: i, label: '🎙 ' + (p.name || ('Player ' + (i + 1))) }); });
  return t;
}

class NetGame implements GameLike {
  map: GameMap;
  me: number;
  tickN = 0;
  private prev: any = null;
  private cur: any = null;
  private tPrev = 0;
  private tCur = 0;
  private evQ: any[] = [];
  private pl: any[] = [];
  private end: { over: boolean; winner: number } = { over: false, winner: -2 };

  isNet = true;
  endData: any = null; // final {players, stats} delivered with the end message
  private chatQ: any[] = [];
  private roster: { name: string; isAI: boolean }[] = [];
  private voiceRtc: RtcMesh | null = null;  // snapshot mode has no input mesh — voice gets its own
  private voice: VoiceController | null = null;

  constructor(private net: Net, seed: number, nPlayers: number, me: number, roster?: any[], iceServers?: RTCIceServer[]) {
    this.map = genMap(seed, nPlayers);
    this.me = me;
    this.roster = roster || [];
    net.on('snap', m => this.onSnap(m));
    net.on('end', m => {
      this.end = { over: true, winner: m.winner };
      // the server bundles the final stats with the end signal — keep them so the
      // post-game report can render (a NetGame has no local sim of its own)
      if (m.stats && m.players) this.endData = { players: m.players, stats: m.stats };
    });
    net.on('chat', m => { if (this.chatQ.length < 50) this.chatQ.push(m); });
    // voice chat: a voice-only WebRTC mesh among the HUMAN players (snapshot mode
    // relays input via the server, so it has no P2P mesh otherwise). Signaling rides
    // the server-relayed 'rtc' messages.
    const peerSlots = this.roster.map((_, i) => i).filter(i => i !== me && !this.roster[i]?.isAI);
    if (peerSlots.length) {
      this.voiceRtc = new RtcMesh(s => this.net.send(s), me, peerSlots, iceServers);
      net.on('rtc', (x: any) => this.voiceRtc?.onSignal(x));
      this.voice = new VoiceController(this.voiceRtc, { myTeam: (this.roster[me] as any)?.team, teamOf: (s) => (this.roster[s] as any)?.team });
    }
  }
  voiceAvailable(): boolean { return !!this.voice && this.voice.available(); }
  voiceState(): 'off' | 'live' | 'muted' { return this.voice ? this.voice.state() : 'off'; }
  toggleVoice(): Promise<'off' | 'live' | 'muted'> { return this.voice ? this.voice.toggle() : Promise.resolve('off'); }
  voiceTargets() { return voiceTargetList(this.roster as any, this.me); }
  setVoiceTarget(v: any) { this.voice?.setTarget(v === 'all' || v === 'team' ? v : +v); }
  voiceTarget() { return this.voice ? this.voice.getTarget() : 'all'; }

  sendChat(to: any, msg: string) { this.net.send({ t: 'chat', to, msg }); }
  drainChat() { const q = this.chatQ; this.chatQ = []; return q; }
  chatTargets() {
    const t: { v: any; label: string }[] = [{ v: 'all', label: 'Everyone' }, { v: 'allies', label: 'Allies' }];
    this.roster.forEach((p, i) => {
      if (i !== this.me && !p.isAI) t.push({ v: i, label: '@ ' + p.name });
    });
    return t;
  }
  private onSnap(m: any) {
    this.prev = this.cur; this.tPrev = this.tCur;
    this.cur = m; this.tCur = performance.now();
    this.tickN = m.k;
    this.pl = m.p;
    for (const ev of m.ev || []) {
      if (ev.e === 'ore') { this.map.ore[ev.i] = ev.v; this.map.oreDirty = true; }
      else this.evQ.push(ev);
    }
  }
  update() {}
  views(): any[] {
    if (!this.cur) return [];
    if (!this.prev) return this.cur.e;
    const span = Math.max(50, this.tCur - this.tPrev);
    const a = Math.max(0, Math.min(1, (performance.now() - this.tCur) / span));
    const prevById = new Map<number, any>();
    for (const v of this.prev.e) prevById.set(v.i, v);
    return this.cur.e.map((v: any) => {
      const p = prevById.get(v.i);
      if (!p || v.b) return v;
      return { ...v, x: p.x + (v.x - p.x) * a, z: p.z + (v.z - p.z) * a };
    });
  }
  players() { return this.pl; }
  drainEvents() { const e = this.evQ; this.evQ = []; return e; }
  issue(cmd: any) { this.net.send({ t: 'cmd', cmd }); }
  status() { return this.end; }
  leave() { this.voice?.dispose(); this.voiceRtc?.close(); this.net.close(); }
  // perf overlay telemetry: snapshot timing + the socket's receive counters
  netStats() {
    return { ...this.net.stats, sinceSnap: this.tCur ? performance.now() - this.tCur : 0, interpSpan: this.tCur - this.tPrev };
  }
}

// ---------------- Networked LOCKSTEP game ----------------
// Each client runs its OWN deterministic sim; the server only relays inputs
// (no server sim, no snapshots). Bandwidth = O(inputs), so it scales to thousands
// of units. AI players (incl. dropped peers) are computed locally by every client.
class NetLockstepGame implements GameLike {
  map: GameMap;
  me: number;
  sim: Sim;
  isNet = true;
  private engine: LockstepEngine;
  private pending: any[] = [];      // user commands queued since the last tick
  private acc = 0;                  // wall-time accumulator (ms) toward the next tick
  private prodAcc = 0;             // free-running wall clock (ms) driving INPUT production
  private prodTick = 0;           // ticks of real time elapsed — input is sent this far ahead
  private frac = 0;                 // interpolation 0..1 toward the latest executed tick
  private lastAdvanceWall = 0;      // performance.now() of the last tick we actually executed
  private evQ: any[] = [];
  private chatQ: any[] = [];
  private roster: { name: string; isAI: boolean }[] = [];
  private rtc: RtcMesh | null = null;
  private voice: VoiceController | null = null;    // voice chat over the input mesh

  constructor(private net: Net, m: any) {
    setMapSize(m.size || 112);
    this.me = m.you;
    this.roster = m.players || [];
    // include aiLvl so lockstep AIs run at the host's chosen difficulty (incl. Bomber
    // Baron / lvl 4). It comes from the server's start payload — same for every client —
    // so all sims stay deterministic. Without it the sim defaulted every AI to Normal.
    const specs = (m.players || []).map((p: any, i: number) => ({ name: p.name, faction: p.faction, isAI: !!p.isAI, team: p.team ?? (i + 1), aiLvl: p.aiLvl }));
    this.sim = new Sim(m.seed, specs);
    this.map = this.sim.map;
    // input delay is chosen by the server from the worst player's ping (6..18),
    // so a far/janky peer's lag is buffered instead of stalling everyone
    this.engine = new LockstepEngine(this.sim, this.me, specs.length, { delay: m.delay || 6, redundancy: 16 });
    this.engine.aiFor = (s, p) => aiTick(s as any, p);
    this.engine.localInput = () => { const c = this.pending; this.pending = []; return c; };
    // P2P input transport (WebRTC): the human peers in this room. We send input
    // over a DataChannel when EVERY peer's channel is open, else fall back to the
    // WS relay below — so a hardened browser or un-traversable NAT never regresses.
    const aiSet = new Set<number>(m.aiSlots || []);
    const peerSlots = specs.map((_: any, i: number) => i).filter((i: number) => i !== this.me && !aiSet.has(i) && !specs[i].isAI);
    if (peerSlots.length) {
      this.rtc = new RtcMesh(s => this.net.send(s), this.me, peerSlots, m.iceServers);
      this.rtc.onFrame = (player, frames) => this.engine.receive({ player, frames });
      net.on('rtc', (x: any) => this.rtc?.onSignal(x));
      // voice chat rides the input mesh's audio; team info lets the player talk to team-only
      this.voice = new VoiceController(this.rtc, { myTeam: (this.roster[this.me] as any)?.team, teamOf: (s) => (this.roster[s] as any)?.team });
    }
    this.engine.send = msg => {
      // prefer the unreliable DataChannel (no head-of-line blocking) once P2P is up
      if (this.rtc && this.rtc.allConnected()) this.rtc.send(msg.frames, this.me);
      else this.net.send({ t: 'lsin', frames: msg.frames }); // TCP relay fallback
    };
    this.engine.recordHashes = false;                 // no per-tick hashing in real play
    this.engine.onTick = () => { this.evQ.push(...this.sim.events); }; // drain each executed tick's events
    // AI slots are computed locally by EVERY client from tick 0 (deterministic)
    for (const slot of (m.aiSlots || [])) this.engine.dropToAI(slot, 0);
    // receive on BOTH paths — engine.receive is idempotent, so a frame arriving via
    // P2P and the WS fallback during a transition is harmless (first value wins)
    net.on('lsin', (x: any) => this.engine.receive({ player: x.player, frames: x.frames }));
    net.on('lsdropvote', (x: any) => this.net.send({ t: 'lslast', player: x.player, tick: this.engine.lastInputTickFor(x.player) }));
    net.on('lsdrop', (x: any) => this.engine.dropToResign(x.player, x.tick)); // a peer left → resign them, game continues
    net.on('chat', (x: any) => { if (this.chatQ.length < 50) this.chatQ.push(x); });
  }
  get tickN() { return this.sim.tickN; }
  issue(cmd: any) { this.pending.push(cmd); }
  update(dtMs: number) {
    // Step the sim at ~10 Hz of wall time, but ONLY consume a tick's worth of
    // accumulated time when a tick actually executes. If the peer's input is late
    // the sim stalls — we then leave `acc` un-consumed and clamp the render frac
    // to 1 so units HOLD at their last position instead of oscillating (the old
    // code advanced a wall clock regardless, which made units twitch every 100ms
    // while stalled). When the backlog clears it catches up in one burst.
    const nowWall = performance.now();
    if (!this.lastAdvanceWall) this.lastAdvanceWall = nowWall;
    const tickBefore = this.sim.tickN;
    this.acc += dtMs;
    // Drive INPUT PRODUCTION off a free-running wall clock, independent of whether
    // our sim is stalled. This keeps our future inputs flowing to peers even while
    // we wait on theirs — without it a single stall snowballs into a
    // one-tick-per-round-trip crawl (chronic stalls on a high-latency link).
    this.prodAcc += dtMs;
    while (this.prodAcc >= 100) { this.prodAcc -= 100; this.prodTick++; }
    this.engine.produceTo(this.prodTick + this.engine.delay);
    let guard = 0;
    while (this.acc >= 100 && guard++ < 8) {
      const before = this.sim.tickN;
      this.engine.pump(before + 1);          // try to advance exactly one tick
      if (this.sim.tickN === before) break;  // stalled (waiting on a peer) — stop consuming time
      this.acc -= 100;
    }
    if (this.acc > 1000) this.acc = 1000;    // bound a pathological backlog (peer can only lead by ~delay)
    this.frac = Math.min(1, this.acc / 100); // clamp: a stall sits at the target, never past it
    // stall tracking for the desync pause popup: any tick executed this frame means
    // we're in sync; otherwise the gap since the last advance is our stall duration
    if (this.sim.tickN > tickBefore) this.lastAdvanceWall = nowWall;
  }
  // ms we've been frozen waiting on a peer. 0 when there are no human peers
  // (solo-vs-AI never stalls) or while we're ticking normally.
  stalledMs(): number { return this.rtc ? performance.now() - this.lastAdvanceWall : 0; }
  views(): any[] { return simViews(this.sim, this.frac); }
  players(): any[] { return simPlayers(this.sim); }
  drainEvents() { const e = this.evQ; this.evQ = []; return e; }
  // debug overlay telemetry: socket counters + ping + lockstep-specific health
  netStats() { return { ...this.net.stats, stalls: this.engine.stalls, tick: this.sim.tickN, delay: this.engine.delay, leads: this.engine.inputLeads(), roster: this.roster, rtc: this.rtc ? { n: this.rtc.connectedCount(), of: this.rtc.peerCount() } : null }; }
  status() { return this.sim.done ? { over: true, winner: this.sim.winner } : { over: false, winner: -2 }; }
  // ---- voice chat (WebRTC audio over the existing peer mesh) ----
  voiceAvailable(): boolean { return !!this.voice && this.voice.available(); }
  voiceState(): 'off' | 'live' | 'muted' { return this.voice ? this.voice.state() : 'off'; }
  toggleVoice(): Promise<'off' | 'live' | 'muted'> { return this.voice ? this.voice.toggle() : Promise.resolve('off'); }
  voiceTargets() { return voiceTargetList(this.roster as any, this.me); }
  setVoiceTarget(v: any) { this.voice?.setTarget(v === 'all' || v === 'team' ? v : +v); }
  voiceTarget() { return this.voice ? this.voice.getTarget() : 'all'; }
  sendChat(to: any, msg: string) { this.net.send({ t: 'chat', to, msg }); }
  drainChat() { const q = this.chatQ; this.chatQ = []; return q; }
  chatTargets() {
    const t: { v: any; label: string }[] = [{ v: 'all', label: 'Everyone' }, { v: 'allies', label: 'Allies' }];
    this.roster.forEach((p, i) => { if (i !== this.me && !p.isAI) t.push({ v: i, label: '@ ' + p.name }); });
    return t;
  }
  leave() { this.voice?.dispose(); this.rtc?.close(); this.net.close(); }
}

// ---------------- Game client (render + input loop) ----------------
function canPlaceClient(map: GameMap, views: any[], me: number, type: string, cx: number, cz: number): boolean {
  const def = BUILDINGS[type];
  const s = def.size;
  const onWater = type === 'shipyard';
  for (let z = cz; z < cz + s; z++)
    for (let x = cx; x < cx + s; x++) {
      const i = z * W + x;
      if (!map.inB(x, z)) return false;
      if (map.tBlocked[i] && !(onWater && map.water[i])) return false; // shipyards sit on water
      if (map.ore && map.ore[i] > 0) return false; // can't build on an ore patch
    }
  // prerequisite building must exist and be finished (else placement fails server-side)
  if (def.prereq && !views.some(v => v.b && v.o === me && v.t === def.prereq && (v.pr ?? 1) >= 1)) return false;
  let near = false;
  const reach = onWater ? 24 : 14;
  for (const v of views) {
    if (!v.b) continue;
    if (v.cx < cx + s && v.cx + v.sz > cx && v.cz < cz + s && v.cz + v.sz > cz) return false;
    // 1-tile spacing: economy/production buildings can't be placed directly touching
    // another such building (mirrors sim.canPlace). Walls + defenses are exempt.
    if (!SPACING_EXEMPT.has(type) && !SPACING_EXEMPT.has(v.t) &&
        v.cx < cx + s + 1 && v.cx + v.sz > cx - 1 && v.cz < cz + s + 1 && v.cz + v.sz > cz - 1) return false;
    // walls / tank barriers don't anchor placement — can't creep the base out
    // with a chain of cheap walls; a real structure must be within reach
    if (v.o === me && v.t !== 'wall' && v.t !== 'barrier') {
      const d = Math.sqrt((v.x - (cx + s / 2)) ** 2 + (v.z - (cz + s / 2)) ** 2);
      if (d <= reach) near = true; // shipyards reach out to the coast
    }
  }
  return near;
}

class GameClient {
  renderer: Renderer;
  ui: UI;
  selection = new Set<number>();
  private lastViews: any[] = [];
  private byId = new Map<number, any>();
  private keys = new Set<string>();
  private mouse = {
    x: 0, y: 0, in: false, downX: 0, downY: 0, dragging: false, lDown: false,
    rDown: false, rDownX: 0, rDownY: 0, rDragging: false,
  };
  private grab: { x: number; z: number } | null = null;
  // touch input state (mobile, no mouse)
  private touch = {
    mode: '' as '' | 'pan' | 'box' | 'pinch', sx: 0, sy: 0, downT: 0, moved: false,
    pinchD: 0, pinchA: 0, boxToggle: false, longTimer: 0 as any,
  };
  private rMode: 'pan' | 'form' | 'aatk' | 'silo' | 'reparea' | 'harvarea' | 'rotate' | 'barrage' = 'pan';
  private rotLast = { x: 0, y: 0 }; // last cursor pos while Ctrl+right-dragging to rotate the camera
  private formPath: { x: number; z: number }[] | null = null;
  private areaDrag: { cx: number; cz: number; r: number } | null = null;
  private patrolMode = false;
  private patrolDraw: { x: number; z: number }[] | null = null;
  // bulldozer terraforming: draw a rectangle area, then move the mouse up/down to
  // set the target height and click to lock it in. '' off, 'draw' picking the
  // area, 'height' adjusting the level.
  private terraMode: '' | 'draw' | 'height' = '';
  private terraRect: { x0: number; z0: number; x1: number; z1: number } | null = null;
  private terraBaseH = 0;   // ground height of the drawn area (anchor)
  private terraTargetH = 0; // chosen target height
  private terraAnchorY = 0; // mouse Y when height-picking began
  // drag-line placement for walls/barriers
  private lineStart: { cx: number; cz: number } | null = null;
  private lineCells: { cx: number; cz: number; ok: boolean }[] = [];
  private lastCursor = '';
  private cheatBuf = '';
  private groups: Record<number, number[]> = {};
  private lastGroupTap = { n: 0, t: 0 };
  private lastHover: { x: number; y: number } | null = null;
  private loadHover = false; // hovering my transport with loadable units selected
  private garrisonHover = false; // hovering a garrisonable building with infantry selected
  private oilHover = false; // engineer selected + hovering a claimable oil well
  private oilCell: { cx: number; cz: number } | null = null; // that well's cell, for the oil-rig ghost
  private tipEl: HTMLDivElement | null = null;  // delayed name+HP hover tooltip
  private tipEntId = -1;
  private tipSince = 0;
  private showRanges = true;
  // perf overlay (toggle F3): smoothed FPS + per-frame work/render/sim timing
  private perfOn = false;
  private perfEl: HTMLDivElement | null = null;
  private fps = 60; private fpsAccN = 0; private fpsAccT = 0; private renderMs = 0; private updateMs = 0; private workMs = 0;
  private perfRx = { bytes: 0, t: 0 };
  // "clean screen" toggle (V): hides the whole GUI AND skips its per-frame draw
  // (HUD, minimap, 2D overlay) so the GUI's render cost can be measured. While
  // hidden, the average FPS is logged to the console every 10s.
  private guiHidden = false; private fpsLogT = 0; private fpsLogFrames = 0;
  private cmdFx: { fx: number; fz: number; tx: number; tz: number; t: number; atk: boolean }[] = [];
  private wpTrail: { x: number; z: number; atk: boolean }[] = []; // shift-queued waypoint chain (visual)
  private lastClick = { t: 0, x: 0, y: 0 };
  private lastGhost: { cx: number; cz: number; ok: boolean } | null = null;
  private raf = 0;
  private lastT = 0;
  private frame = 0;
  private lastMinimap = 0; // wall-clock ms of the last minimap redraw (throttled to 1/s)
  private lastUiUpdate = 0; // wall-clock ms of the last sidebar/build-menu DOM update (throttled ~12/s)
  private lastSelSig = -1;  // selection signature — when it changes the sidebar refreshes immediately
  private over = false;
  private surrendered = false;   // player hit Surrender (only changes the banner wording)
  private pendingWinner = '';    // winner name to pass to the report screen once the player clicks through
  private pendingWon = false;    // did the local player win? (passed to the report on click-through)
  private hb: Worker | null = null;     // heartbeat worker: keeps the sim/net advancing when the tab is hidden
  private hbUrl = '';
  private lastRaf = 0;                  // wall clock of the last rAF frame (watchdog)
  private lastHidden = 0;               // wall clock at the last background step
  private overlayCtx: CanvasRenderingContext2D;
  private cleanups: (() => void)[] = [];
  // throttled audio-cue state
  private cueT: Record<string, number> = {}; // last-played wall clock per cue
  private pwrState = 0;                  // 0 ok, 1 low, 2 insufficient (for crossing detection)
  private siloCued = false;             // missile-silo cue: once per session
  private satCued = new Set<number>();  // satellite cue: once per player
  private hpPrev = new Map<number, number>(); // my entities' hp last frame (under-attack detection)

  // fog of war: 0 never seen, 1 explored, 2 currently visible — client-side
  // per-player view masking (spectator modes see everything)
  private fog: Uint8Array | null = null;
  private allies = new Set<number>(); // owners on my team (incl. me) — shared vision
  // radar: threat detection near the base, pierces fog within its range
  private radarBlips: any[] = [];
  private lastAlert = 0;

  constructor(public game: GameLike, private onEnd: (won: boolean, winnerName: string) => void) {
    const canvas = document.getElementById('three') as HTMLCanvasElement;
    const overlay = document.getElementById('overlay') as HTMLCanvasElement;
    this.overlayCtx = overlay.getContext('2d')!;
    this.renderer = new Renderer(canvas, game.map);
    const spawn = game.map.spawns[Math.min(game.me, game.map.spawns.length - 1)];
    this.renderer.jumpCam(spawn.x, spawn.z);

    this.ui = new UI(
      t => { this.ui.setPlacing(this.ui.placing === t ? null : t); audio.play('click'); },
      (t, bulk) => this.train(t, bulk ? 5 : 1),       // Ctrl+click → queue 5 (sim caps to capacity)
      (x, z) => this.renderer.jumpCam(x, z),
      (t, bulk) => this.cancelTrain(t, bulk ? 5 : 1), // Ctrl+right-click → drop 5 from the queue
      bid => { this.game.issue({ k: 'upg', p: this.game.me, bid }); audio.play('confirm'); },
      (bid, on) => { this.game.issue({ k: 'repeat', p: this.game.me, bid, on }); audio.play('click'); },
      t => { // chip click: narrow selection to one type
        const keep = [...this.selection].filter(id => this.byId.get(id)?.t === t);
        this.selection.clear();
        keep.forEach(id => this.selection.add(id));
        audio.play('click');
      },
      (bid, tech) => { this.game.issue({ k: 'research', p: this.game.me, bid, tech }); audio.play('confirm'); },
    );
    this.ui.setHudVisible(true);

    const on = <K extends keyof WindowEventMap>(tgt: any, ev: string, fn: any, opt?: any) => {
      tgt.addEventListener(ev, fn, opt);
      this.cleanups.push(() => tgt.removeEventListener(ev, fn, opt));
    };
    on(window, 'resize', () => { this.renderer.resize(); this.sizeOverlay(); });
    on(canvas, 'contextmenu', (e: Event) => e.preventDefault());
    on(canvas, 'mousedown', (e: MouseEvent) => this.onDown(e));
    // touch input (mobile)
    on(canvas, 'touchstart', (e: TouchEvent) => this.onTouchStart(e), { passive: false });
    on(canvas, 'touchmove', (e: TouchEvent) => this.onTouchMove(e), { passive: false });
    on(canvas, 'touchend', (e: TouchEvent) => this.onTouchEnd(e), { passive: false });
    on(canvas, 'touchcancel', (e: TouchEvent) => this.onTouchEnd(e), { passive: false });
    on(window, 'mousemove', (e: MouseEvent) => {
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      this.mouse.in = true;
      if (this.mouse.lDown && !this.mouse.dragging) {
        const d = Math.hypot(e.clientX - this.mouse.downX, e.clientY - this.mouse.downY);
        if (d > 6) this.mouse.dragging = true;
      }
      if (this.mouse.rDown && !this.mouse.rDragging) {
        const d = Math.hypot(e.clientX - this.mouse.rDownX, e.clientY - this.mouse.rDownY);
        if (d > 6) {
          this.mouse.rDragging = true;
          if (this.rMode === 'pan') {
            this.grab = this.renderer.groundPoint(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
          } else {
            const g = this.renderer.groundPoint(this.mouse.rDownX / window.innerWidth, this.mouse.rDownY / window.innerHeight);
            this.formPath = g ? [g] : [];
          }
        }
      }
    });
    on(window, 'mouseup', (e: MouseEvent) => this.onUp(e));
    on(document, 'mouseleave', () => { this.mouse.in = false; });
    on(canvas, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      // Ctrl+wheel tilts the camera (horizon view ↔ top-down); plain wheel zooms
      if (e.ctrlKey) this.renderer.tiltBy(e.deltaY > 0 ? 0.07 : -0.07);
      else {
        const g = this.renderer.groundPoint(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
        this.renderer.zoomBy(e.deltaY > 0 ? 1.12 : 0.89, g?.x, g?.z); // zoom toward the cursor
      }
    }, { passive: false });
    on(window, 'keydown', (e: KeyboardEvent) => {
      // typing in the chat input (or any form field) must not trigger hotkeys
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Enter' && this.game.isNet) { this.openChat(); e.preventDefault(); return; }
      // perf overlay toggle — backquote/tilde (F-keys collide with browser shortcuts).
      // Shift+backquote also toggles the deep profiler (per-section timing breakdown).
      if (e.code === 'Backquote') {
        if (e.shiftKey) {
          prof.enabled = !prof.enabled;
          if (prof.enabled) { prof.reset(); this.perfOn = true; } // profiler needs the perf HUD visible
          console.log('[prof] profiler ' + (prof.enabled ? 'ON — Shift+` to stop · __prof.table() in console' : 'off'));
        } else this.togglePerf();
        e.preventDefault(); return;
      }
      // clean-screen toggle (V): hide the whole GUI to gauge its render cost
      if (e.code === 'KeyV') { this.toggleGui(); e.preventDefault(); return; }
      this.keys.add(e.code);
      // cheat code buffer
      if (/^[a-zA-Z]$/.test(e.key)) {
        this.cheatBuf = (this.cheatBuf + e.key.toUpperCase()).slice(-12);
        if (this.cheatBuf.endsWith('GODMODE')) {
          this.cheatBuf = '';
          this.game.issue({ k: 'godmode', p: this.game.me });
          audio.play('cash');
        }
      }
      if (e.code === 'Escape') {
        this.ui.setPlacing(null); this.selection.clear();
        this.patrolMode = false; this.patrolDraw = null;
        this.terraMode = ''; this.terraRect = null; this.renderer.setTerraPreview(null);
        this.renderer.setFormationPath(null);
      }
      if (e.code === 'KeyX') this.issueToUnits({ k: 'stop' }); // Stop (S is taken by WASD map-pan)
      // U: transport ships unload cargo; garrison buildings evacuate their occupants
      if (e.code === 'KeyU') {
        const ships = this.myUnitIds().filter(id => { const v = this.byId.get(id); return v && UNITS[v.t]?.carrier && (v.cu || 0) > 0; });
        if (ships.length) { this.game.issue({ k: 'unload', p: this.game.me, ids: ships }); audio.play('confirm'); }
        for (const id of this.selection) {
          const v = this.byId.get(id);
          if (v && v.b === 1 && v.gar && v.o === this.game.me && (v.cu || 0) > 0) { this.game.issue({ k: 'evac', p: this.game.me, bid: id }); audio.play('confirm'); }
        }
      }
      // L: load selected ground units into the nearest friendly carrier that can
      // take them (transport ship or IFV) — the keyboard twin of right-clicking it
      if (e.code === 'KeyL') {
        const ground = this.myUnitIds().filter(id => { const k = UNITS[this.byId.get(id)?.t]?.kind; return k === 'inf' || k === 'veh'; });
        if (ground.length) {
          let cx = 0, cz = 0;
          for (const id of ground) { const v = this.byId.get(id); cx += v.x; cz += v.z; }
          cx /= ground.length; cz /= ground.length;
          const me2 = this.game.me;
          let best: any = null, bd = Infinity;
          for (const v of this.lastViews) {
            if (v.b || v.o !== me2 || !UNITS[v.t]?.carrier || ground.includes(v.i)) continue;
            const cInf = UNITS[v.t].carryInf ?? 30, cVeh = UNITS[v.t].carryVeh ?? 10;
            const takes = ground.some(id => { const k = UNITS[this.byId.get(id)?.t]?.kind; return (k === 'inf' && cInf > 0) || (k === 'veh' && cVeh > 0); });
            if (!takes) continue;
            const d = (v.x - cx) ** 2 + (v.z - cz) ** 2;
            if (d < bd) { bd = d; best = v; }
          }
          if (best) {
            const cInf = UNITS[best.t].carryInf ?? 30, cVeh = UNITS[best.t].carryVeh ?? 10;
            const loadable = ground.filter(id => { const k = UNITS[this.byId.get(id)?.t]?.kind; return (k === 'inf' && cInf > 0) || (k === 'veh' && cVeh > 0); });
            this.game.issue({ k: 'load', p: me2, ids: loadable, tgt: best.i });
            audio.play('confirm'); audio.ack(this.dominantType(loadable), 'move');
            this.markCmd(loadable, best.x, best.z, false);
          }
        }
      }
      // H: weapons-hold toggle (don't fire even when attacked)
      if (e.code === 'KeyH') {
        const ids = this.myUnitIds();
        if (ids.length) { const anyFiring = ids.some(id => !this.byId.get(id)?.hf); this.game.issue({ k: 'holdfire', p: this.game.me, ids, on: anyFiring }); audio.play('confirm'); }
        else { const bids = this.selectedDefBuildings(); if (bids.length) { const anyFiring = bids.some(id => !this.byId.get(id)?.hf); this.game.issue({ k: 'bholdfire', p: this.game.me, ids: bids, on: anyFiring }); audio.play('confirm'); } }
      }
      // +/- game speed (skirmish only — multiplayer is server-paced)
      if (e.code === 'Equal' || e.code === 'NumpadAdd') this.changeSpeed(1);
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') this.changeSpeed(-1);
      // control groups: Ctrl/Alt+1-9 assign, 1-9 recall (double-tap centers camera)
      const dm = e.code.match(/^Digit([1-9])$/);
      if (dm) {
        const n = +dm[1];
        if (e.ctrlKey || e.altKey) {
          e.preventDefault();
          if (this.selection.size) { this.groups[n] = [...this.selection]; audio.play('click'); }
        } else {
          const ids = (this.groups[n] || []).filter(id => this.byId.has(id));
          if (ids.length) {
            this.selection.clear();
            ids.forEach(id => this.selection.add(id));
            const now = performance.now();
            if (this.lastGroupTap.n === n && now - this.lastGroupTap.t < 400) {
              let cx = 0, cz = 0;
              ids.forEach(id => { const v = this.byId.get(id); cx += v.x; cz += v.z; });
              this.renderer.jumpCam(cx / ids.length, cz / ids.length);
            }
            this.lastGroupTap = { n, t: now };
            audio.play('click');
          }
        }
      }
      if (e.code === 'KeyR') {
        const pb = this.selectedProdBuilding();
        if (pb) {
          this.game.issue({ k: 'repeat', p: this.game.me, bid: pb.i, on: !pb.rp });
          audio.play('click');
        } else {
          // units: toggle waypoint repeat (loop the queued waypoints until cancelled)
          const ids = this.myUnitIds();
          if (ids.length) { this.game.issue({ k: 'wprepeat', p: this.game.me, ids }); audio.play('click'); }
        }
      }
      if (e.code === 'KeyP' && (this.myUnitIds().length || this.selectedProdBuilding())) {
        this.patrolMode = !this.patrolMode;
        this.patrolDraw = null;
        audio.play('click');
      }
      // T: with a bulldozer selected, start terraforming — drag a rectangle area,
      // then move the mouse up/down to set the height and click to lock it in
      if (e.code === 'KeyT' && this.myUnitIds().some(id => UNITS[this.byId.get(id)?.t]?.terra)) {
        this.terraMode = this.terraMode ? '' : 'draw';
        this.terraRect = null;
        this.patrolMode = false; this.patrolDraw = null;
        this.renderer.setTerraPreview(null);
        audio.play('click');
      }
      // G: toggle Hold Position stance for selected units
      if (e.code === 'KeyG') {
        const ids = this.myUnitIds();
        if (ids.length) {
          const anyAgg = ids.some(id => !this.byId.get(id)?.st);
          this.game.issue({ k: 'stance', p: this.game.me, ids, stance: anyAgg ? 1 : 0 });
          audio.play('click');
        }
      }
      // Ctrl-D: arm/cancel a 5s self-destruct on units; dismantle a building
      if (e.code === 'KeyD' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const ids = this.myUnitIds();
        if (ids.length) { this.game.issue({ k: 'selfdestruct', p: this.game.me, ids }); audio.play('sdbeep'); }
        else {
          const sel = [...this.selection].map(id => this.byId.get(id)).filter(Boolean);
          const b = sel.find(v => v && v.b && v.o === this.game.me && v.t !== 'conyard');
          if (b) { this.game.issue({ k: 'dismantle', p: this.game.me, bid: b.i }); audio.play('cancel'); }
        }
      }
      // C: toggle range/detection circles on selected units & buildings
      else if (e.code === 'KeyC') this.showRanges = !this.showRanges;
      // F: fortify / unfortify selected Drone Hives
      // F: fortify / unfortify selected units (hives, rifle/rocket/troopers).
      // Press again to pack up and move.
      if (e.code === 'KeyF') {
        const sel = this.myUnitIds();
        const ids = sel.filter(id => UNITS[this.byId.get(id)?.t]?.fortify);
        if (ids.length) { this.game.issue({ k: 'fortify', p: this.game.me, ids }); audio.play('confirm'); }
        // F also deploys a Construction Vehicle into a forward construction yard
        const dep = sel.filter(id => UNITS[this.byId.get(id)?.t]?.deploys);
        if (dep.length) { this.game.issue({ k: 'deploy', p: this.game.me, ids: dep }); audio.play('confirm'); }
        // F also has engineers drop a proximity mine from their onboard stock
        const lay = sel.filter(id => UNITS[this.byId.get(id)?.t]?.lays);
        if (lay.length) { this.game.issue({ k: 'deploy', p: this.game.me, ids: lay }); audio.play('confirm'); }
      }
      // B: selected engineers build a road toward the cursor (extends base reach)
      if (e.code === 'KeyB') {
        const eng = this.myUnitIds().filter(id => this.byId.get(id)?.t === 'engineer');
        if (eng.length) {
          const g = this.renderer.groundPoint(this.mouse.x / window.innerWidth, this.mouse.y / window.innerHeight);
          if (g) { this.game.issue({ k: 'buildroad', p: this.game.me, ids: eng, x: g.x, z: g.z }); audio.play('confirm'); }
        }
      }
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));

    // chat input handles its own keys
    const chatInp = document.getElementById('chatInput') as HTMLInputElement;
    const chatKeys = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.code === 'Enter') {
        const msg = chatInp.value.trim();
        if (msg && this.game.sendChat) {
          const sel = document.getElementById('chatTo') as HTMLSelectElement;
          const raw = sel.value;
          const to = /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
          this.game.sendChat(to, msg);
          // show our own line immediately — the server only relays to others, so
          // the sender never depends on a round-trip to see what they typed
          const myName = this.game.players?.()[this.game.me]?.n || 'You';
          this.appendChat({ name: myName, to, msg });
        }
        this.closeChat();
      } else if (e.code === 'Escape') this.closeChat();
    };
    chatInp.addEventListener('keydown', chatKeys);
    this.cleanups.push(() => chatInp.removeEventListener('keydown', chatKeys));
    // click the collapsed chat to briefly expand it to the last 10 lines
    const chatLogEl = document.getElementById('chatLog')!;
    const chatLogClick = () => { this.chatExpanded = true; this.chatExpandT = performance.now(); this.renderChat(); };
    chatLogEl.addEventListener('click', chatLogClick);
    this.cleanups.push(() => chatLogEl.removeEventListener('click', chatLogClick));

    this.setupTouchBar(on);
    this.sizeOverlay();
    this.lastT = performance.now();
    (window as any).__fe = this; // debug/testing handle
    this.startHeartbeat(on);
    this.loop(this.lastT);
  }

  // requestAnimationFrame is paused/throttled whenever the tab is hidden OR the
  // window loses focus — fatal for lockstep, where a backgrounded client stops
  // pumping inputs and every peer stalls waiting on it. A dedicated Web Worker
  // timer is NOT throttled by visibility/focus, so it acts as a watchdog: if the
  // rAF loop hasn't run recently (i.e. it's been throttled away), the worker
  // drives the sim + network pump itself. When rAF is healthy the worker stays
  // out of the way entirely, so foreground play is byte-for-byte unchanged.
  private startHeartbeat(_on: any) {
    try {
      const src = 'var t=setInterval(function(){postMessage(0)},16);onmessage=function(e){if(e.data==="x"){clearInterval(t)}}';
      this.hbUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      this.hb = new Worker(this.hbUrl);
      this.hb.onmessage = () => {
        if (this.over) return;
        const now = performance.now();
        // Only take over when the page is GENUINELY backgrounded — a hidden tab
        // (rAF=0), or a long rAF stall (≥400ms) on the rare systems where a
        // window blur freezes rAF. A transient foreground frame hitch (a heavy
        // sim tick) must NOT trigger this, or rAF + worker would both drive the
        // sim and units would twitch. When visible, the rAF loop owns the sim.
        const backgrounded = document.hidden || (now - this.lastRaf > 400);
        if (!backgrounded) { this.lastHidden = 0; return; }
        let dt = this.lastHidden ? (now - this.lastHidden) / 1000 : 0.1;
        this.lastHidden = now;
        this.game.update(Math.min(0.2, dt) * 1000);    // advance sim + lockstep pump; no render while hidden
      };
    } catch { /* no Worker support: background play just won't advance */ }
  }

  // on-screen action buttons for touch devices (keyboard-free controls)
  private setupTouchBar(on: any) {
    // collapsible build sidebar (handy on phones; available everywhere)
    const sb = document.getElementById('sidebar'), tog = document.getElementById('sidebarToggle');
    if (sb && tog) {
      const toggle = () => {
        const col = sb.classList.toggle('collapsed');
        tog.classList.toggle('collapsed', col);
        tog.textContent = col ? '⮜' : '⮜'; // ⮜ open / ⮝? use arrows
        tog.textContent = col ? '☰' : '⮜'; // ☰ when collapsed, ⮜ when open
      };
      on(tog, 'click', toggle);
      // on phones the build menu eats half the screen — start it COLLAPSED so the
      // map is clear; the ☰ toggle opens it on demand
      const phone = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 600;
      if (phone) { sb.classList.add('collapsed'); tog.classList.add('collapsed'); tog.textContent = '☰'; }
    }
    const bar = document.getElementById('touchBar');
    if (!bar) return;
    // the command quickbar is useful with a mouse too — keep it visible on all
    // widths (it tucks into the bottom-left and stays out of the way)
    bar.classList.remove('hidden');
    const tap = (act: string, btn: HTMLElement) => {
      const ids = this.myUnitIds();
      if (act === 'box') { this.touch.boxToggle = !this.touch.boxToggle; btn.classList.toggle('on', this.touch.boxToggle); }
      else if (act === 'deselect') { this.selection.clear(); this.patrolMode = false; this.patrolDraw = null; this.ui.setPlacing(null); }
      else if (act === 'stop') this.issueToUnits({ k: 'stop' });
      else if (act === 'hold') { if (ids.length) { const anyAgg = ids.some(id => !this.byId.get(id)?.st); this.game.issue({ k: 'stance', p: this.game.me, ids, stance: anyAgg ? 1 : 0 }); } }
      else if (act === 'holdfire') {
        if (ids.length) { const anyFiring = ids.some(id => !this.byId.get(id)?.hf); this.game.issue({ k: 'holdfire', p: this.game.me, ids, on: anyFiring }); }
        else { const bids = this.selectedDefBuildings(); if (bids.length) { const anyFiring = bids.some(id => !this.byId.get(id)?.hf); this.game.issue({ k: 'bholdfire', p: this.game.me, ids: bids, on: anyFiring }); } }
      }
      else if (act === 'patrol') { if (ids.length || this.selectedProdBuilding()) { this.patrolMode = !this.patrolMode; this.patrolDraw = null; } }
      else if (act === 'fortify') { const f = ids.filter(id => UNITS[this.byId.get(id)?.t]?.fortify); if (f.length) this.game.issue({ k: 'fortify', p: this.game.me, ids: f }); }
      else if (act === 'ranges') { this.showRanges = !this.showRanges; btn.classList.toggle('on', this.showRanges); }
      else if (act === 'primary') { const pb = this.selectedProdBuilding(); if (pb) this.game.issue({ k: 'primary', p: this.game.me, bid: pb.i }); }
      else if (act === 'destruct') {
        if (ids.length) { this.game.issue({ k: 'selfdestruct', p: this.game.me, ids }); audio.play('sdbeep'); }
        else { const b = [...this.selection].map(id => this.byId.get(id)).find(v => v && v.b && v.o === this.game.me && v.t !== 'conyard'); if (b) { this.game.issue({ k: 'dismantle', p: this.game.me, bid: b.i }); audio.play('cancel'); } }
      }
      audio.play('click');
    };
    bar.querySelectorAll('.tbtn').forEach(btn => {
      const act = (btn as HTMLElement).getAttribute('data-act')!;
      const h = (e: Event) => { e.preventDefault(); tap(act, btn as HTMLElement); };
      on(btn, 'touchstart', h, { passive: false });
      on(btn, 'click', h);
    });
    // voice chat: a mic toggle in the topbar, shown only in a multiplayer game with
    // human peers. First tap asks for the mic; later taps mute/unmute.
    const voiceBtn = document.getElementById('voiceBtn');
    const voiceTo = document.getElementById('voiceTo') as HTMLSelectElement | null;
    const g: any = this.game;
    if (voiceBtn && g && typeof g.voiceAvailable === 'function' && g.voiceAvailable()) {
      voiceBtn.classList.remove('hidden');
      const syncVoice = () => {
        const st = g.voiceState ? g.voiceState() : 'off';
        voiceBtn.classList.toggle('live', st === 'live');
        voiceBtn.classList.toggle('muted', st === 'muted');
        voiceBtn.title = st === 'live' ? 'Voice: ON (talking) — click to mute'
          : st === 'muted' ? 'Voice: muted — click to talk'
          : 'Voice chat — click to talk to other players';
      };
      syncVoice();
      on(voiceBtn, 'click', async () => { audio.init(); await g.toggleVoice(); syncVoice(); });
      // channel picker: Everyone / Team only / a specific player
      if (voiceTo && g.voiceTargets) {
        voiceTo.innerHTML = (g.voiceTargets() as { v: any; label: string }[])
          .map(o => `<option value="${o.v}">${o.label}</option>`).join('');
        voiceTo.value = String(g.voiceTarget ? g.voiceTarget() : 'all');
        voiceTo.classList.remove('hidden');
        on(voiceTo, 'change', () => g.setVoiceTarget?.(voiceTo.value));
      }
    } else {
      voiceBtn?.classList.add('hidden'); // single-player / no peers
      voiceTo?.classList.add('hidden');
    }
    // minimap: tap/drag to jump the camera (touch); on desktop left-click/drag
    // jumps the camera and right-click sends the selected units to that spot
    const mm = document.getElementById('minimap');
    if (mm) {
      const toWorld = (cx: number, cy: number) => {
        const r = mm.getBoundingClientRect();
        // both axes flipped to match the camera's ground orientation
        return { x: (1 - (cx - r.left) / r.width) * W, z: (1 - (cy - r.top) / r.height) * H };
      };
      const jump = (cx: number, cy: number) => { const w = toWorld(cx, cy); this.renderer.jumpCam(w.x, w.z); };
      const mh = (e: TouchEvent) => { e.preventDefault(); const t = e.touches[0]; if (t) jump(t.clientX, t.clientY); };
      on(mm, 'touchstart', mh, { passive: false });
      on(mm, 'touchmove', mh, { passive: false });
      let panning = false;
      on(mm, 'mousedown', (e: MouseEvent) => {
        e.preventDefault();
        if (e.button === 2) {
          // right-click on the minimap = move/harvest order for the selection
          const ids = this.myUnitIds();
          if (!ids.length) return;
          const w = toWorld(e.clientX, e.clientY);
          const cx = Math.floor(w.x), cz = Math.floor(w.z);
          const onOre = this.game.map.inB(cx, cz) && this.game.map.ore[cz * W + cx] > 0;
          this.game.issue({ k: onOre ? 'harvest' : 'move', p: this.game.me, ids, x: w.x, z: w.z, q: e.shiftKey });
          this.recordWp(w.x, w.z, false, e.shiftKey);
          this.markCmd(ids, w.x, w.z, false);
          audio.ack(this.dominantType(ids), 'move');
        } else if (e.button === 0) { panning = true; jump(e.clientX, e.clientY); }
      });
      on(mm, 'mousemove', (e: MouseEvent) => { if (panning) jump(e.clientX, e.clientY); });
      on(window, 'mouseup', () => { panning = false; });
    }
  }

  // ---- multiplayer chat ----
  private openChat() {
    const bar = document.getElementById('chatBar')!;
    const sel = document.getElementById('chatTo') as HTMLSelectElement;
    const inp = document.getElementById('chatInput') as HTMLInputElement;
    const prev = sel.value;
    sel.innerHTML = (this.game.chatTargets?.() || [])
      .map(t => `<option value="${t.v}">${t.label}</option>`).join('');
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    bar.classList.remove('hidden');
    inp.value = '';
    this.renderChat(); // expand to the last 10 lines as a typing aid
    setTimeout(() => inp.focus(), 0);
  }

  private closeChat() {
    document.getElementById('chatBar')!.classList.add('hidden');
    (document.getElementById('chatInput') as HTMLInputElement).blur();
    this.renderChat(); // collapse back to the recent few
  }

  // radio line from the enemy AI commander (Claude strategist taunts)
  aiSays(msg: string) {
    const who = this.game.players?.()[1]?.n || 'Enemy AI';
    this.appendChat({ name: who, to: 'all', msg, ai: true }); // tagged so the taunt toggle can hide it
    if (!hideTaunts) audio.play('click');
  }
  // the topbar 🤖 toggle flipped — re-render so existing taunts hide/show immediately
  redrawChat() { this.renderChat(); }

  private chatHistory: { name: string; to: any; msg: string; t: number; ai?: boolean }[] = [];
  private chatT0 = performance.now();   // game-start reference for chat timestamps
  private chatExpanded = false;          // click the chat to briefly show the last 10
  private chatExpandT = 0;

  private appendChat(m: any) {
    this.chatHistory.push({ name: String(m.name), to: m.to, msg: String(m.msg), t: performance.now(), ai: !!m.ai });
    if (this.chatHistory.length > 40) this.chatHistory.shift();
    this.renderChat();
  }

  // rebuild the chat log from history. Typing → last 10 (a typing aid); otherwise
  // just the last 2 to save screen space — click the log to briefly expand to 10.
  private renderChat() {
    const log = document.getElementById('chatLog')!;
    const typing = !document.getElementById('chatBar')!.classList.contains('hidden');
    log.classList.toggle('typing', typing);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    // elapsed-since-game-start stamp, HH:MM
    const stamp = (t: number) => {
      const min = Math.max(0, Math.floor((t - this.chatT0) / 60000));
      return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    };
    const count = (typing || this.chatExpanded) ? 10 : 2;
    const visible = hideTaunts ? this.chatHistory.filter(m => !m.ai) : this.chatHistory; // taunt toggle
    log.innerHTML = visible.slice(-count).map(m => {
      const dm = typeof m.to === 'number';
      const chan = dm ? 'DM' : m.to === 'allies' ? 'ALLY' : 'ALL';
      return `<div class="chatMsg${dm ? ' dm' : ''}" data-t="${m.t}">` +
        `<span class="chan">${stamp(m.t)} [${chan}]</span>` +
        `<span class="who">${esc(m.name)}:</span> ${esc(m.msg)}</div>`;
    }).join('');
  }

  private sizeOverlay() {
    const o = document.getElementById('overlay') as HTMLCanvasElement;
    o.width = window.innerWidth; o.height = window.innerHeight;
  }

  destroy() {
    disableExitGuard();   // tearing down the match — stop trapping the Back button
    document.getElementById('reportBanner')?.classList.add('hidden');
    cancelAnimationFrame(this.raf);
    if (this.hb) { try { this.hb.postMessage('x'); this.hb.terminate(); } catch { /* already gone */ } this.hb = null; }
    if (this.hbUrl) { try { URL.revokeObjectURL(this.hbUrl); } catch { /* ignore */ } this.hbUrl = ''; }
    for (const c of this.cleanups) c();
    this.ui.destroy();
    this.ui.setHudVisible(false);
    this.closeChat();
    this.chatHistory = [];
    document.getElementById('chatLog')!.innerHTML = '';
    if (this.perfEl) { this.perfEl.remove(); this.perfEl = null; }
    this.game.leave();
  }

  private myUnitIds(): number[] {
    return [...this.selection].filter(id => { const v = this.byId.get(id); return v && !v.b; });
  }

  private issueToUnits(partial: any) {
    const ids = this.myUnitIds();
    if (ids.length) this.game.issue({ ...partial, p: this.game.me, ids });
  }

  // single selected production building of mine (rally / patrol-route target)
  private selectedProdBuilding(): any {
    if (this.selection.size !== 1) return null;
    const v = this.byId.get([...this.selection][0]);
    if (!v || !v.b || v.o !== this.game.me) return null;
    return ['barracks', 'factory', 'dronefac', 'airforce', 'shipyard'].includes(v.t) ? v : null;
  }

  // my selected defensive buildings (turret/cannon/tesla/sam) — for Hold/Force Fire
  private selectedDefBuildings(): number[] {
    return [...this.selection].map(id => this.byId.get(id))
      .filter(b => b && b.b && b.o === this.game.me && BUILDINGS[b.t]?.attack).map(b => b.i);
  }

  // most common unit type in the current selection (for voice acknowledgments)
  private dominantType(ids: number[]): string {
    const tally: Record<string, number> = {};
    for (const id of ids) {
      const v = this.byId.get(id);
      if (v && !v.b) tally[v.t] = (tally[v.t] || 0) + 1;
    }
    let best = 'rifle', n = 0;
    for (const t in tally) if (tally[t] > n) { n = tally[t]; best = t; }
    return best;
  }

  private train(type: string, count = 1) {
    const def = UNITS[type];
    if (!def) return;
    const canMake = (v: any) => v && v.b && v.o === this.game.me && v.pr >= 1 &&
      (v.t === def.builtAt || v.t === def.altBuiltAt);
    // pick the production building: a single selected matching one wins (so twin
    // factories can each build something different), else a primary (double-click) or
    // the shortest queue. some units (MCV) can come from a second type too (altBuiltAt).
    let bid = -1;
    if (this.selection.size === 1) {
      const sel = this.byId.get([...this.selection][0]);
      if (canMake(sel)) bid = sel.i;
    }
    if (bid < 0) {
      let primary: any = null, best: any = null;
      for (const v of this.lastViews) {
        if (!canMake(v)) continue;
        if (v.pm) primary = v;
        if (!best || (v.qn || 0) < (best.qn || 0)) best = v;
      }
      const tgt = primary || best;
      if (tgt) bid = tgt.i;
    }
    if (bid < 0) return;
    // Ctrl+click queues a batch; the sim validates/caps each one (airfield slots,
    // 1-per-player heroes, tech/faction/credits), so it adds up to the capacity.
    for (let i = 0; i < count; i++) this.game.issue({ k: 'train', p: this.game.me, bid, type });
    audio.play('click');
  }

  // right-click a unit button: cancel one queued unit, preferring the SELECTED
  // production building so the queue badge the player is looking at always drops
  private cancelTrain(type: string, count = 1) {
    const def = UNITS[type];
    if (!def) return;
    let bid = -1;
    if (this.selection.size === 1) {
      const sel = this.byId.get([...this.selection][0]);
      if (sel && sel.b && sel.o === this.game.me && (sel.t === def.builtAt || sel.t === def.altBuiltAt) && (sel.qn || 0) > 0) bid = sel.i;
    }
    for (let i = 0; i < count; i++) this.game.issue({ k: 'cancel', p: this.game.me, type, bid }); // Ctrl+right-click drops a batch
    audio.play('cancel');
  }

  // finish a patrol-route draw (shared by mouse + touch)
  private finishPatrol(sx: number, sy: number) {
    const me = this.game.me;
    this.mouse.dragging = false;
    let pts = this.patrolDraw || [];
    this.patrolDraw = null;
    this.patrolMode = false;
    this.renderer.setFormationPath(null);
    const g = this.renderer.groundPoint(sx / window.innerWidth, sy / window.innerHeight);
    if (pts.length < 2) pts = g ? [g] : [];
    else {
      const step = Math.max(1, Math.ceil(pts.length / 24));
      pts = pts.filter((_, i) => i % step === 0);
      if (g) pts.push(g);
    }
    const ids = this.myUnitIds();
    const rounded = pts.map(p => ({ x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10 }));
    if (pts.length && ids.length) {
      this.game.issue({ k: 'patrol', p: me, ids, pts: rounded });
      audio.play('confirm'); audio.ack(this.dominantType(ids), 'move');
    } else if (pts.length) {
      const pb = this.selectedProdBuilding();
      if (pb) { this.game.issue({ k: 'bpatrol', p: me, bid: pb.i, pts: rounded }); audio.play('confirm'); }
    }
  }

  // the terraform rectangle is drawn — anchor the height picker at the area's
  // current average ground level and switch to the height-adjust phase
  private beginTerraHeight() {
    const r = this.terraRect!;
    const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1);
    const z0 = Math.min(r.z0, r.z1), z1 = Math.max(r.z0, r.z1);
    let sum = 0, n = 0;
    for (let z = Math.floor(z0); z <= Math.floor(z1); z++)
      for (let x = Math.floor(x0); x <= Math.floor(x1); x++) { sum += this.game.map.heightAt(x + 0.5, z + 0.5); n++; }
    this.terraBaseH = n ? sum / n : SEA + 1;
    this.terraTargetH = this.terraBaseH;
    this.terraAnchorY = this.mouse.y;
    this.terraMode = 'height';
  }

  // lock in the chosen height and dispatch the terraform job over every cell of
  // the rectangle (raising a span across water builds a land bridge)
  private commitTerra() {
    const r = this.terraRect; const me = this.game.me;
    this.terraMode = ''; this.terraRect = null;
    this.renderer.setTerraPreview(null);
    if (!r) return;
    const x0 = Math.floor(Math.min(r.x0, r.x1)), x1 = Math.floor(Math.max(r.x0, r.x1));
    const z0 = Math.floor(Math.min(r.z0, r.z1)), z1 = Math.floor(Math.max(r.z0, r.z1));
    const cells: { x: number; z: number }[] = [];
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++)
      if (x >= 0 && z >= 0 && x < W && z < H) cells.push({ x, z });
    const dozers = this.myUnitIds().filter(id => UNITS[this.byId.get(id)?.t]?.terra);
    if (dozers.length && cells.length) {
      // a "simple click" — committing without nudging the height up or down — asks
      // the dozer to auto-bridge: fill the span into a passable land path between
      // the two shores (ramped if they sit at different heights)
      const auto = Math.abs(this.terraTargetH - this.terraBaseH) < 0.15;
      this.game.issue({ k: 'terraform', p: me, ids: [dozers[0]], path: cells, h: this.terraTargetH, auto });
      audio.play('confirm');
    }
  }

  // select all own units inside a screen rectangle (shared by mouse + touch)
  private boxSelect(x0: number, y0: number, x1: number, y1: number, additive: boolean) {
    const me = this.game.me;
    const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
    const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
    if (!additive) this.selection.clear();
    const boxed: any[] = [];
    for (const v of this.lastViews) {
      if (v.b || v.o !== me) continue;
      // aircraft render at cruise altitude — project at that height so a click/box on
      // the MODEL selects them (not the empty ground beneath, which was confusing)
      const ud = UNITS[v.t];
      const p = ud?.fly
        ? this.renderer.projectY(v.x, this.renderer.flyY(v.x, v.z, ud.alt || 2.3), v.z)
        : this.renderer.project(v.x, v.z, 0.5);
      if (p.ok && p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y) boxed.push(v);
    }
    // a mixed box-select drops the economy miners (harvesters + oil miners) so
    // orders don't drag them off their fields; a miners-only box still selects them
    const combat = boxed.filter(v => !UNITS[v.t]?.cargo);
    for (const v of (combat.length ? combat : boxed)) this.selection.add(v.i);
  }

  // walls/barriers can be dragged into a line of segments
  private isLineBuild(t: string | null): boolean { return t === 'wall' || t === 'barrier'; }

  // cells along a straight line from a→b, each validated. Segments chain: the
  // line must start near a building/road, then later cells stay valid if they
  // touch an earlier valid cell (classic wall extension). Capped by credits.
  private computeLine(type: string, a: { cx: number; cz: number }, b: { cx: number; cz: number }): { cx: number; cz: number; ok: boolean }[] {
    const dx = b.cx - a.cx, dz = b.cz - a.cz;
    const steps = Math.max(Math.abs(dx), Math.abs(dz));
    const cost = BUILDINGS[type].cost;
    const me = this.game.me;
    let credits = this.game.players?.()[me]?.c ?? 1e9;
    const placed: { cx: number; cz: number }[] = [];
    const out: { cx: number; cz: number; ok: boolean }[] = [];
    const seen = new Set<number>();
    for (let i = 0; i <= steps && out.length < 48; i++) {
      const cx = Math.round(a.cx + (dx * i) / (steps || 1));
      const cz = Math.round(a.cz + (dz * i) / (steps || 1));
      const key = cz * W + cx;
      if (seen.has(key)) continue;
      seen.add(key);
      let ok = canPlaceClient(this.game.map, this.lastViews, me, type, cx, cz);
      if (!ok) // chain off an earlier segment in this line
        ok = placed.some(p => Math.max(Math.abs(p.cx - cx), Math.abs(p.cz - cz)) <= 1)
          && this.game.map.inB(cx, cz) && !this.game.map.tBlocked[key]
          && !this.lastViews.some(v => v.b && v.cx <= cx && v.cx + (v.sz || 1) > cx && v.cz <= cz && v.cz + (v.sz || 1) > cz);
      if (ok && credits < cost) ok = false; // can't afford more
      if (ok) { credits -= cost; placed.push({ cx, cz }); }
      out.push({ cx, cz, ok });
    }
    return out;
  }

  // place every valid cell of the current drag-line; keep placing mode active
  // (walls come in lines — exit with Esc / right-click) unless Shift is held
  private commitLine(_shift: boolean) {
    let n = 0;
    for (const c of this.lineCells) if (c.ok) { this.game.issue({ k: 'place', p: this.game.me, type: this.ui.placing!, cx: c.cx, cz: c.cz }); n++; }
    if (n) audio.play('place'); else audio.play('cancel');
    this.lineStart = null; this.lineCells = [];
    // walls stay armed so you can keep drawing; Esc / right-click exits
  }

  // compute the building-ghost cell + validity at a screen point
  private ghostAt(sx: number, sy: number): { cx: number; cz: number; ok: boolean } | null {
    if (!this.ui.placing) return null;
    const g = this.renderer.groundPoint(sx / window.innerWidth, sy / window.innerHeight);
    if (!g) return null;
    const s = BUILDINGS[this.ui.placing].size;
    const cx = Math.max(0, Math.min(W - s, Math.round(g.x - s / 2)));
    const cz = Math.max(0, Math.min(H - s, Math.round(g.z - s / 2)));
    return { cx, cz, ok: canPlaceClient(this.game.map, this.lastViews, this.game.me, this.ui.placing, cx, cz) };
  }

  // touch: tap selects own units, or issues a command when something's selected
  private tapAt(sx: number, sy: number) {
    const me = this.game.me;
    if (this.ui.placing) {
      // compute the spot fresh at the tap (lastGhost can be stale on touch)
      const gh = this.ghostAt(sx, sy);
      if (gh && gh.ok) { this.game.issue({ k: 'place', p: me, type: this.ui.placing, cx: gh.cx, cz: gh.cz }); audio.play('place'); this.ui.setPlacing(null); }
      else audio.play('cancel');
      return;
    }
    const now = performance.now();
    const dbl = now - this.lastClick.t < 350 && Math.hypot(sx - this.lastClick.x, sy - this.lastClick.y) < 24;
    this.lastClick = { t: now, x: sx, y: sy };
    const ownHit = this.pickView(sx, sy, v => v.o === me);
    if (dbl && ownHit) { // double-tap own unit OR building → select all of that type on screen (FOV)
      this.selection.clear();
      for (const v of this.lastViews) {
        if (!!v.b !== !!ownHit.b || v.o !== me || v.t !== ownHit.t) continue;
        if (this.renderer.project(v.x, v.z, v.b ? 1 : 0.5).ok) this.selection.add(v.i);
      }
      audio.play('click');
      return;
    }
    // with a selection, tapping ground/enemy issues an order; tapping own unit selects it
    if (ownHit && (!this.myUnitIds().length || ownHit.b)) {
      this.selection.clear(); this.selection.add(ownHit.i); audio.play('click'); return;
    }
    if (this.selection.size && (this.myUnitIds().length || this.selectedProdBuilding())) {
      this.contextCommand(sx, sy, false); return;
    }
    if (ownHit) { this.selection.clear(); this.selection.add(ownHit.i); audio.play('click'); return; }
    this.selection.clear();
  }

  private pickView(sx: number, sy: number, filter: (v: any) => boolean): any {
    let best: any = null, bd = 1e9;
    for (const v of this.lastViews) {
      if (!filter(v)) continue;
      // aircraft render at a fixed cruise altitude — project at that exact world
      // height so the click lands on the model itself, not the empty ground beneath
      const ud = UNITS[v.t];
      const p = (!v.b && ud?.fly)
        ? this.renderer.projectY(v.x, this.renderer.flyY(v.x, v.z, ud.alt || 2.3), v.z)
        : this.renderer.project(v.x, v.z, v.b ? 1 : 0.5);
      if (!p.ok) continue;
      const d = Math.hypot(p.x - sx, p.y - sy);
      let r: number;
      if (v.b) {
        // GLB building models can be much larger than their grid footprint (e.g. the
        // airfield) — size the hit area to the model's on-screen footprint so clicking
        // the visible model selects it, not just the ground beside it
        const foot = this.renderer.bldgFoot[v.t];
        if (foot) {
          const e = this.renderer.project(v.x + foot, v.z, 0.5);
          const px = e.ok ? Math.hypot(e.x - p.x, e.y - p.y) : 0;
          r = Math.max(14 + (v.sz || 1) * 7, px + 12);
        } else r = 14 + (v.sz || 1) * 7;
      } else r = ud?.fly ? 20 : 16; // a touch more slack for fast movers
      if (d < r && d < bd) { bd = d; best = v; }
    }
    return best;
  }

  // ---- touch input (mobile) ----
  // one finger: tap = select/command, drag = pan, long-press+drag = box select.
  // two fingers: pinch = zoom, twist = rotate. A toolbar toggle makes one-finger
  // drag box-select instead of pan.
  private onTouchStart(e: TouchEvent) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      this.touch.sx = t.clientX; this.touch.sy = t.clientY;
      this.touch.downT = performance.now(); this.touch.moved = false;
      this.mouse.x = t.clientX; this.mouse.y = t.clientY;
      if (this.ui.placing) {
        // placing: finger moves the ghost; walls/barriers start a drag-line
        this.touch.mode = '';
        if (this.isLineBuild(this.ui.placing)) { const gh = this.ghostAt(t.clientX, t.clientY); this.lineStart = gh ? { cx: gh.cx, cz: gh.cz } : null; }
        return;
      }
      if (this.touch.boxToggle || this.patrolMode) {
        this.touch.mode = this.patrolMode ? 'pan' : 'box';
        if (this.patrolMode) { const g = this.renderer.groundPoint(t.clientX / window.innerWidth, t.clientY / window.innerHeight); this.patrolDraw = g ? [g] : []; }
      } else {
        this.touch.mode = 'pan';
        this.grab = this.renderer.groundPoint(t.clientX / window.innerWidth, t.clientY / window.innerHeight);
        // hold-still for 300ms promotes a pan into a box-select
        clearTimeout(this.touch.longTimer);
        this.touch.longTimer = setTimeout(() => { if (!this.touch.moved) { this.touch.mode = 'box'; this.grab = null; } }, 300);
      }
    } else if (e.touches.length === 2) {
      clearTimeout(this.touch.longTimer);
      this.touch.mode = 'pinch';
      const [a, b] = [e.touches[0], e.touches[1]];
      this.touch.pinchD = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      this.touch.pinchA = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
    }
  }
  private onTouchMove(e: TouchEvent) {
    e.preventDefault();
    if (this.touch.mode === 'pinch' && e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const ang = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
      if (this.touch.pinchD > 0) this.renderer.zoomBy(this.touch.pinchD / d);
      this.renderer.rotate((ang - this.touch.pinchA) * 1.0);
      this.touch.pinchD = d; this.touch.pinchA = ang;
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    this.mouse.x = t.clientX; this.mouse.y = t.clientY;
    if (Math.hypot(t.clientX - this.touch.sx, t.clientY - this.touch.sy) > 8) this.touch.moved = true;
    if (this.ui.placing) return; // ghost follows this.mouse in the loop; lift to place
    if (this.touch.mode === 'pan' && this.grab) {
      const g = this.renderer.groundPoint(t.clientX / window.innerWidth, t.clientY / window.innerHeight);
      if (g) this.renderer.jumpCam(this.renderer.camX + (this.grab.x - g.x), this.renderer.camZ + (this.grab.z - g.z));
    } else if (this.touch.mode === 'box') {
      // drive the existing selection-box overlay via the mouse drag fields
      this.mouse.dragging = true; this.mouse.downX = this.touch.sx; this.mouse.downY = this.touch.sy;
    } else if (this.patrolMode && this.patrolDraw) {
      const g = this.renderer.groundPoint(t.clientX / window.innerWidth, t.clientY / window.innerHeight);
      if (g) { const last = this.patrolDraw[this.patrolDraw.length - 1]; if (!last || Math.hypot(g.x - last.x, g.z - last.z) >= 0.75) this.patrolDraw.push(g); }
      this.renderer.setFormationPath(this.patrolDraw, 0xffd24a);
    }
  }
  private onTouchEnd(e: TouchEvent) {
    e.preventDefault();
    clearTimeout(this.touch.longTimer);
    if (e.touches.length > 0) return; // still fingers down (end of a pinch)
    const mode = this.touch.mode; this.touch.mode = '';
    this.grab = null;
    if (this.ui.placing) {
      if (this.lineStart) this.commitLine(false); // wall/barrier line
      else this.tapAt(this.mouse.x, this.mouse.y); // single building at the ghost
      return;
    }
    if (this.patrolMode) { this.finishPatrol(this.touch.sx, this.touch.sy); return; }
    if (mode === 'box' && this.touch.moved) {
      this.mouse.dragging = false;
      this.boxSelect(this.touch.sx, this.touch.sy, this.mouse.x, this.mouse.y, false);
      return;
    }
    if (!this.touch.moved && performance.now() - this.touch.downT < 500) this.tapAt(this.touch.sx, this.touch.sy);
  }

  private onDown(e: MouseEvent) {
    // middle button: Chrome pops its autoscroll "compass" cursor — kill it
    if (e.button === 1) { e.preventDefault(); return; }
    if (e.button === 0) {
      // walls/barriers: press starts a drag-line, committed on release
      if (this.ui.placing && this.isLineBuild(this.ui.placing)) {
        const gh = this.ghostAt(e.clientX, e.clientY);
        this.lineStart = gh ? { cx: gh.cx, cz: gh.cz } : null;
        this.mouse.lDown = true; this.mouse.downX = e.clientX; this.mouse.downY = e.clientY; this.mouse.dragging = false;
        return;
      }
      if (this.ui.placing && this.lastGhost) {
        if (this.lastGhost.ok) {
          this.game.issue({ k: 'place', p: this.game.me, type: this.ui.placing, cx: this.lastGhost.cx, cz: this.lastGhost.cz });
          audio.play('place');
          if (!e.shiftKey) this.ui.setPlacing(null);
        }
        return;
      }
      if (this.terraMode === 'height') { this.commitTerra(); return; } // click locks the height
      if (this.terraMode === 'draw') {
        const g = this.renderer.groundPoint(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
        if (g) { this.terraRect = { x0: g.x, z0: g.z, x1: g.x, z1: g.z }; this.mouse.lDown = true; this.mouse.dragging = true; }
        return;
      }
      if (this.patrolMode) {
        this.mouse.lDown = true;
        this.mouse.downX = e.clientX; this.mouse.downY = e.clientY;
        this.mouse.dragging = false;
        const g = this.renderer.groundPoint(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
        this.patrolDraw = g ? [g] : [];
        return;
      }
      this.mouse.lDown = true;
      this.mouse.downX = e.clientX; this.mouse.downY = e.clientY;
      this.mouse.dragging = false;
    } else if (e.button === 2) {
      if (this.ui.placing) { this.ui.setPlacing(null); this.lineStart = null; this.lineCells = []; return; }
      this.mouse.rDown = true;
      this.mouse.rDragging = false;
      this.mouse.rDownX = e.clientX; this.mouse.rDownY = e.clientY;
      // right-press ON an enemy with units selected: drag opens an attack
      // circle — everything inside gets targeted on release
      const enemyUnder = this.myUnitIds().length
        ? this.pickView(e.clientX, e.clientY, v => !this.allies.has(v.o)) : null;
      const siloSel = (this.selection.size === 1 && !this.myUnitIds().length) ? this.byId.get([...this.selection][0]) : null;
      if (e.ctrlKey) {
        // Ctrl + right-drag normally rotates (and tilts) the camera. But when the
        // selection is purely mortar/artillery (splash units), Ctrl + right-drag
        // instead draws a Sperrfeuer barrage circle — shells scatter across it.
        // A Ctrl+right-CLICK (no drag) still force-fires via contextCommand.
        const sids = this.myUnitIds();
        const allSplash = sids.length > 0 && sids.every(id => UNITS[this.byId.get(id)?.t]?.splash);
        if (allSplash) {
          const g = this.renderer.groundPoint(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
          this.rMode = 'barrage';
          this.areaDrag = g ? { cx: g.x, cz: g.z, r: 0 } : null;
        } else {
          this.rMode = 'rotate';
          this.rotLast = { x: e.clientX, y: e.clientY };
        }
      } else if (enemyUnder) {
        const g = this.renderer.groundPoint(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
        this.rMode = 'aatk';
        this.areaDrag = g ? { cx: g.x, cz: g.z, r: 0 } : null;
      } else if (siloSel && siloSel.b && siloSel.t === 'silo' && siloSel.o === this.game.me) {
        // a selected silo: right-drag sizes a custom strike zone
        const g = this.renderer.groundPoint(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
        this.rMode = 'silo';
        this.areaDrag = g ? { cx: g.x, cz: g.z, r: 0 } : null;
      } else {
        const ids = this.myUnitIds();
        const engs = ids.filter(id => UNITS[this.byId.get(id)?.t]?.repair);
        const harvs = ids.filter(id => UNITS[this.byId.get(id)?.t]?.cargo);
        if (ids.length && engs.length === ids.length) {
          // engineers only: right-drag marks out an auto-repair patrol zone
          const g = this.renderer.groundPoint(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
          this.rMode = 'reparea';
          this.areaDrag = g ? { cx: g.x, cz: g.z, r: 0 } : null;
        } else if (ids.length && harvs.length === ids.length) {
          // harvesters only: right-drag marks out an ore-gathering work area
          const g = this.renderer.groundPoint(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
          this.rMode = 'harvarea';
          this.areaDrag = g ? { cx: g.x, cz: g.z, r: 0 } : null;
        } else {
          // 2+ units selected: right-drag draws a formation line; otherwise it pans
          this.rMode = ids.length >= 2 ? 'form' : 'pan';
        }
      }
    }
  }

  private onUp(e: MouseEvent) {
    if (e.button === 2) {
      if (!this.mouse.rDown) return;
      this.mouse.rDown = false;
      const wasDrag = this.mouse.rDragging;
      this.mouse.rDragging = false;
      this.grab = null;
      const path = this.formPath;
      this.formPath = null;
      const area = this.areaDrag;
      this.areaDrag = null;
      this.renderer.setFormationPath(null);
      if (!wasDrag) this.contextCommand(e.clientX, e.clientY, e.shiftKey, e.ctrlKey); // quick right-click = order (Ctrl = force-fire)
      else if (this.rMode === 'aatk' && area && area.r >= 1) {
        // area attack: everything inside the circle becomes a target
        const ids = this.myUnitIds();
        if (ids.length) {
          this.game.issue({
            k: 'aattack', p: this.game.me, ids,
            x: Math.round(area.cx * 10) / 10, z: Math.round(area.cz * 10) / 10,
            r: Math.round(area.r * 10) / 10,
          });
          audio.play('confirm');
          audio.ack(this.dominantType(ids), 'attack');
          this.markCmd(ids, area.cx, area.cz, true);
        }
      }
      else if (this.rMode === 'barrage' && area && area.r >= 1) {
        // Sperrfeuer: order the selected mortar/artillery to bombard the whole circle
        const ids = this.myUnitIds().filter(id => UNITS[this.byId.get(id)?.t]?.splash);
        if (ids.length) {
          this.game.issue({
            k: 'forcefire', p: this.game.me, ids,
            x: Math.round(area.cx * 10) / 10, z: Math.round(area.cz * 10) / 10,
            r: Math.round(area.r * 10) / 10,
          });
          audio.play('confirm');
          audio.ack(this.dominantType(ids), 'attack');
          this.markCmd(ids, area.cx, area.cz, true);
        }
      }
      else if (this.rMode === 'silo' && area && area.r >= 1) {
        // designate a custom-radius strike zone for the selected silo
        const silo = this.byId.get([...this.selection][0]);
        if (silo && silo.t === 'silo') {
          this.game.issue({ k: 'silostrike', p: this.game.me, bid: silo.i, x: Math.round(area.cx * 10) / 10, z: Math.round(area.cz * 10) / 10, r: Math.round(area.r * 10) / 10 });
          audio.play('confirm');
          this.markCmd([silo.i], area.cx, area.cz, true);
        }
      }
      else if (this.rMode === 'reparea' && area && area.r >= 1) {
        // assign the selected engineers an auto-repair zone
        const engs = this.myUnitIds().filter(id => UNITS[this.byId.get(id)?.t]?.repair);
        if (engs.length) {
          this.game.issue({ k: 'repairzone', p: this.game.me, ids: engs, cx: Math.round(area.cx * 10) / 10, cz: Math.round(area.cz * 10) / 10, r: Math.round(area.r * 10) / 10 });
          audio.play('confirm');
          this.markCmd(engs, area.cx, area.cz, false);
        }
      }
      else if (this.rMode === 'harvarea' && area && area.r >= 1) {
        // assign the selected harvesters an ore-gathering work area
        const harvs = this.myUnitIds().filter(id => UNITS[this.byId.get(id)?.t]?.cargo);
        if (harvs.length) {
          this.game.issue({ k: 'harvestzone', p: this.game.me, ids: harvs, cx: Math.round(area.cx * 10) / 10, cz: Math.round(area.cz * 10) / 10, r: Math.round(area.r * 10) / 10 });
          audio.play('confirm');
          this.markCmd(harvs, area.cx, area.cz, false);
        }
      }
      else if (this.rMode === 'form' && path && path.length >= 2) this.issueFormation(path, e.shiftKey);
      return;
    }
    if (e.button !== 0 || !this.mouse.lDown) return;
    this.mouse.lDown = false;
    const me = this.game.me;

    // commit a wall/barrier drag-line (clear the drag state so no stray
    // selection rubber-band lingers once the line is placed)
    if (this.lineStart) { this.mouse.dragging = false; this.commitLine(e.shiftKey); return; }

    if (this.patrolMode) { this.finishPatrol(e.clientX, e.clientY); return; }
    // finished dragging the terraform rectangle → switch to height-picking
    if (this.terraMode === 'draw' && this.terraRect) {
      this.mouse.lDown = false; this.mouse.dragging = false;
      this.beginTerraHeight();
      return;
    }

    if (this.mouse.dragging) {
      this.mouse.dragging = false;
      this.boxSelect(this.mouse.downX, this.mouse.downY, e.clientX, e.clientY, e.shiftKey);
      return;
    }

    const now = performance.now();
    const dbl = now - this.lastClick.t < 350 && Math.hypot(e.clientX - this.lastClick.x, e.clientY - this.lastClick.y) < 10;
    this.lastClick = { t: now, x: e.clientX, y: e.clientY };

    const hit = this.pickView(e.clientX, e.clientY, v => v.o === me);
    // (rally points are set with RIGHT click; left-click on ground deselects)

    if (dbl && hit) {
      // double-click own unit OR building → select all of that type on screen (FOV)
      this.selection.clear();
      for (const v of this.lastViews) {
        if (!!v.b !== !!hit.b || v.o !== me || v.t !== hit.t) continue;
        if (this.renderer.project(v.x, v.z, v.b ? 1 : 0.5).ok) this.selection.add(v.i);
      }
      audio.play('click');
      return;
    }
    if (!e.shiftKey) this.selection.clear();
    if (hit) {
      if (this.selection.has(hit.i) && e.shiftKey) this.selection.delete(hit.i);
      else { this.selection.add(hit.i); audio.play('click'); }
    }
  }

  // recompute the fog mask from my units' sight: demote visible→explored,
  // then light up cells around everything I own
  private natMask: Uint8Array | null = null; // cells seen by NATURAL sight (not radar/satellite) — TEWS can't jam these
  private updateFog(allViews: any[]) {
    const f = this.fog!;
    if (!this.natMask || this.natMask.length !== f.length) this.natMask = new Uint8Array(f.length);
    const nat = this.natMask; nat.fill(0);
    for (let i = 0; i < f.length; i++) if (f[i] === 2) f[i] = 1;
    const players = this.game.players?.() || [];
    for (const v of allViews) {
      if (!this.allies.has(v.o)) continue; // my team (incl. allies) grants vision
      const def = (UNITS as any)[v.t] || (BUILDINGS as any)[v.t];
      let sight = v.b ? 7 : Math.max(5, (def?.range || 4) + 3);
      // the Radar Dome's wide sweep is long-range INTEL (jammable by a TEWS); a
      // unit's own eyes and a deployed Patriot are NATURAL sight (never jammed).
      // a power-shed (v.po) or still-building (pr<1) dome grants no radar vision.
      const radar = !!(v.b && def?.sight) && !v.po && (v.pr ?? 1) >= 1;
      if (radar) sight = def.sight * (1 + 0.25 * ((v.lv || 1) - 1)); // +25% coverage per upgrade level
      if (!v.b && v.t === 'patriot' && v.fo) sight = 20; // fortified Patriot: bigger deployed radar
      // high-ground vantage: sight extends with the unit's OWN absolute terrain
      // height (a % of how high it stands), up to +30% on peaks — independent of any
      // enemy. Not stacked on the Radar Dome's long-range intel sweep.
      if (!radar) {
        const gh = v.b ? this.game.map.cellH(v.cx, v.cz) : this.game.map.heightAt(v.x, v.z);
        const frac = Math.max(0, Math.min(1, (gh - (SEA + 1.15)) / 4.0));
        sight *= 1 + 0.30 * frac;
      }
      const cx = Math.floor(v.x), cz = Math.floor(v.z), r = Math.ceil(sight);
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > sight * sight) continue;
        const x = cx + dx, z = cz + dz;
        if (x >= 0 && z >= 0 && x < W && z < H) { const i = z * W + x; f[i] = 2; if (!radar) nat[i] = 1; }
      }
    }
  }

  // enemy TEWS units jam radar + satellite intel inside their bubble: any cell
  // there that was lit ONLY by long-range intel (not natural sight) goes dark.
  private applyJamming(allViews: any[]) {
    const f = this.fog, nat = this.natMask;
    if (!f || !nat) return;
    for (const v of allViews) {
      if (v.b || this.allies.has(v.o)) continue;
      const jam = (UNITS as any)[v.t]?.jam;
      if (!jam) continue;
      const cx = Math.floor(v.x), cz = Math.floor(v.z), r = Math.ceil(jam), R2 = jam * jam;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > R2) continue;
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= W || z >= H) continue;
        const i = z * W + x;
        if (f[i] === 2 && nat[i] !== 1) f[i] = 1; // strip intel-only vision
      }
    }
  }

  // brief centered announcement banner (satellite online, etc.)
  private satBanner: HTMLElement | null = null;
  private satBannerSeq = 0;
  flashBanner(text: string) {
    if (!this.satBanner) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;top:84px;left:50%;transform:translateX(-50%);z-index:40;' +
        'padding:10px 22px;border-radius:8px;background:rgba(10,16,24,0.92);border:1px solid #4aa3ff;' +
        'color:#cfe6ff;font:600 15px/1.3 system-ui,sans-serif;letter-spacing:0.5px;' +
        'box-shadow:0 4px 18px rgba(0,0,0,0.5);pointer-events:none;text-align:center;transition:opacity .4s';
      document.body.appendChild(el);
      this.satBanner = el;
    }
    this.satBanner.textContent = text;
    this.satBanner.style.opacity = '1';
    this.satBanner.style.display = 'block';
    const seq = ++this.satBannerSeq;
    window.setTimeout(() => { if (this.satBanner && seq === this.satBannerSeq) this.satBanner.style.opacity = '0'; }, 5000);
  }

  // radar threat detection: with a powered Radar Dome, scan for enemy combat
  // units near the base (through fog) and warn — banner + minimap ping + klaxon
  private scanRadar(allViews: any[]) {
    const me = this.game.me;
    const players = this.game.players?.() || [];
    const myBuildings = allViews.filter(v => v.b && v.o === me);
    const powered = !players[me] || (players[me].pm ?? 1) >= (players[me].pu ?? 0); // radar needs power
    // radar sources: powered Radar Domes PLUS any fortified Patriot (its own
    // deployed radar works off-grid, no power needed)
    const sources = [
      ...(powered ? myBuildings.filter(v => v.t === 'radar' && (v.pr ?? 1) >= 1) : []),
      ...allViews.filter(v => !v.b && v.o === me && v.t === 'patriot' && v.fo),
    ];
    const warn = document.getElementById('radarWarn');
    if (!sources.length) {
      this.radarBlips = [];
      if (warn && !warn.classList.contains('hidden')) warn.classList.add('hidden');
      return;
    }
    // detection radius per source: Radar Domes gain +25% per upgrade level
    const srcRange = (b: any) => (b.b && b.t === 'radar') ? 24 * (1 + 0.25 * ((b.lv || 1) - 1)) : 24;
    const threats: any[] = [];
    for (const v of allViews) {
      if (this.allies.has(v.o) || v.b) continue; // allied units aren't threats
      if (!(UNITS[v.t]?.dmg > 0) && v.t !== 'fueltruck') continue; // only attackers
      let near = false;
      for (const b of sources) { const r = srcRange(b); if ((b.x - v.x) ** 2 + (b.z - v.z) ** 2 < r * r) { near = true; break; } }
      if (near) threats.push(v);
    }
    this.radarBlips = threats;
    if (!threats.length) { if (warn && !warn.classList.contains('hidden')) warn.classList.add('hidden'); return; }
    // source centroid → bearing to the threat cluster, for a compass hint
    let bx = 0, bz = 0; for (const b of sources) { bx += b.x; bz += b.z; }
    bx /= sources.length; bz /= sources.length;
    let tx = 0, tz = 0; for (const t of threats) { tx += t.x; tz += t.z; }
    tx /= threats.length; tz /= threats.length;
    // camera yaw 0: +Z is up-screen (N), +X is left-screen (W)
    const dx = tx - bx, dz = tz - bz;
    const ns = dz > 4 ? 'N' : dz < -4 ? 'S' : '';
    const ew = dx > 4 ? 'W' : dx < -4 ? 'E' : '';
    const dir = (ns + ew) || 'nearby';
    if (warn) {
      warn.textContent = `⚠ INCOMING — ${threats.length} enemy unit${threats.length > 1 ? 's' : ''} ${dir === 'nearby' ? 'nearby' : 'to the ' + dir}`;
      warn.classList.remove('hidden');
    }
    const now = performance.now();
    if (now - this.lastAlert > 6000) {
      this.lastAlert = now;
      audio.play('alert');
      this.ui.ping(tx, tz);
    }
  }

  // sim speed ladder: skirmish caps at 8×, spectator modes go to 32×
  private changeSpeed(dir: number) {
    const g: any = this.game;
    if (g.speed === undefined) return; // networked game: server keeps the clock
    const S = g.isSim ? [0, 0.25, 0.5, 1, 2, 4, 8, 16, 32] : [0, 0.25, 0.5, 1, 2, 4, 8];
    let i = S.indexOf(g.speed);
    if (i < 0) i = 1;
    i = Math.max(0, Math.min(S.length - 1, i + dir));
    g.speed = S[i];
    if (g.isSim && !g.isReplay && simQueue) simQueue.speed = g.speed; // carry into the next match
    updateSpeedInd(g.speed);
    audio.play('click');
  }

  // transient destination marker + lines from each commanded unit
  private markCmd(ids: number[], tx: number, tz: number, atk: boolean) {
    for (const id of ids.slice(0, 40)) {
      const v = this.byId.get(id);
      if (v) this.cmdFx.push({ fx: v.x, fz: v.z, tx, tz, t: 1.0, atk });
    }
  }

  private wpT = 0; // last time the waypoint trail was touched (for auto-expiry)
  // record a movement target for the on-screen waypoint trail: a shift-queued
  // order extends the chain, a plain order starts it fresh (single moves clear it)
  private recordWp(x: number, z: number, atk: boolean, queue: boolean) {
    if (queue) this.wpTrail.push({ x, z, atk });
    else this.wpTrail = [];
    this.wpT = performance.now();
  }

  private contextCommand(sx: number, sy: number, queue: boolean, force = false) {
    const me = this.game.me;
    const g = this.renderer.groundPoint(sx / window.innerWidth, sy / window.innerHeight);
    if (!g) return;

    // CTRL+right-click: force-fire at the exact spot or entity under the cursor,
    // even a friendly unit/building or empty ground (artillery suppression etc.)
    if (force) {
      const ids0 = this.myUnitIds();
      if (ids0.length) {
        const tgt = this.pickView(sx, sy, () => true);
        this.game.issue({ k: 'forcefire', p: me, ids: ids0, tgt: tgt ? tgt.i : undefined, x: g.x, z: g.z });
        audio.ack(this.dominantType(ids0), 'attack');
        this.markCmd(ids0, tgt ? tgt.x : g.x, tgt ? tgt.z : g.z, true);
        return;
      }
      // no units selected: force-fire from selected force-fire-capable buildings
      // (Defense Turret, Heavy Cannon — not Tesla Coil / Missile Battery)
      const bids = [...this.selection].map(id => this.byId.get(id)).filter(b => b && b.b && b.o === me && BUILDINGS[b.t]?.forceFire).map(b => b.i);
      if (bids.length) {
        const tgt = this.pickView(sx, sy, () => true);
        this.game.issue({ k: 'bforcefire', p: me, ids: bids, tgt: tgt ? tgt.i : undefined, x: g.x, z: g.z });
        audio.play('confirm');
        this.markCmd(bids, tgt ? tgt.x : g.x, tgt ? tgt.z : g.z, true);
        return;
      }
    }

    // single selected production building → rally point (armed silo → LAUNCH)
    const sel = [...this.selection].map(id => this.byId.get(id)).filter(Boolean);
    if (sel.length === 1 && sel[0].b && sel[0].o === me) {
      if (sel[0].t === 'silo') {
        // quick right-click on a silo: set a standing strike zone (radius 4) at
        // the point — fires now if armed, keeps building + bombarding until the
        // area is clear. Right-click the silo itself to cancel the order.
        const onSilo = Math.abs(g.x - sel[0].x) < (sel[0].sz || 2) / 2 + 0.5 && Math.abs(g.z - sel[0].z) < (sel[0].sz || 2) / 2 + 0.5;
        const r = onSilo ? 0 : 4;
        this.game.issue({ k: 'silostrike', p: me, bid: sel[0].i, x: Math.round(g.x * 10) / 10, z: Math.round(g.z * 10) / 10, r });
        audio.play('confirm');
        if (r) this.markCmd([sel[0].i], g.x, g.z, true);
        return;
      }
      // rally points only make sense for unit-producing buildings — a right-click
      // on a defensive/utility building (turret, radar, conyard…) does nothing
      if (['barracks', 'factory', 'dronefac', 'airforce', 'shipyard'].includes(sel[0].t))
        this.game.issue({ k: 'rally', p: me, bid: sel[0].i, x: g.x, z: g.z });
      return;
    }
    const ids = this.myUnitIds();
    if (!ids.length) return;

    audio.play('confirm');
    // engineers (land or naval): right-click a damaged friendly unit/building to repair it
    const hasEngineer = ids.some(id => UNITS[this.byId.get(id)?.t]?.repair);
    if (hasEngineer) {
      const friendly = this.pickView(sx, sy, v => v.o === me && v.h < v.m && !ids.includes(v.i));
      if (friendly) {
        this.game.issue({ k: 'repair', p: me, ids, tgt: friendly.i, q: queue });
        audio.ack('engineer', 'move');
        return;
      }
    }
    // right-click MY carrier (transport ship OR IFV) with loadable units selected →
    // load them aboard. Only the kinds the carrier can hold (an IFV takes infantry
    // only) so right-clicking with tanks selected still falls through to attack-move.
    const carrier = this.pickView(sx, sy, v => v.o === me && v.b !== 1 && UNITS[v.t]?.carrier);
    if (carrier) {
      const cInf = UNITS[carrier.t].carryInf ?? 30, cVeh = UNITS[carrier.t].carryVeh ?? 10;
      const ground = ids.filter(id => { const k = UNITS[this.byId.get(id)?.t]?.kind; return (k === 'inf' && cInf > 0) || (k === 'veh' && cVeh > 0); });
      if (ground.length) {
        this.game.issue({ k: 'load', p: me, ids: ground, tgt: carrier.i });
        audio.play('confirm'); audio.ack(this.dominantType(ground), 'move');
        this.markCmd(ground, carrier.x, carrier.z, false);
        return;
      }
    }
    // right-click a garrison building (neutral, or one we already hold) with
    // infantry selected → move in and fire out from inside
    const garr = this.pickView(sx, sy, v => v.b === 1 && v.gar === 1 && (v.ne === 1 || v.o === me) && (v.cu || 0) < (v.gcap || 0));
    if (garr) {
      const inf = ids.filter(id => UNITS[this.byId.get(id)?.t]?.kind === 'inf');
      if (inf.length) {
        this.game.issue({ k: 'garrison', p: me, ids: inf, tgt: garr.i });
        audio.play('confirm'); audio.ack(this.dominantType(inf), 'move');
        this.markCmd(inf, garr.x, garr.z, false);
        return;
      }
    }
    // right-click an Engineer on an oil well → build an Oil Rig there (passive income)
    if (hasEngineer) {
      const ocx = Math.floor(g.x), ocz = Math.floor(g.z);
      if (this.game.map.inB(ocx, ocz) && this.game.map.oil[ocz * W + ocx] === 1 && this.game.map.occ[ocz * W + ocx] === 0) {
        const engs = ids.filter(id => { const d = UNITS[this.byId.get(id)?.t]; return d?.repair && d?.road; });
        if (engs.length) {
          this.game.issue({ k: 'oilrig', p: me, ids: engs, cx: ocx, cz: ocz });
          audio.ack('engineer', 'move');
          this.markCmd(engs, ocx + 0.5, ocz + 0.5, false);
          return;
        }
      }
    }
    // right-click a friendly unit (not one of the selected ones) with combat
    // units selected → escort it: follow it and engage anything that threatens it
    if (ids.some(id => UNITS[this.byId.get(id)?.t]?.dmg > 0)) {
      const friend = this.pickView(sx, sy, v => this.allies.has(v.o) && !v.b && !ids.includes(v.i));
      if (friend) {
        this.game.issue({ k: 'escort', p: me, ids, tgt: friend.i });
        audio.play('confirm'); audio.ack(this.dominantType(ids), 'move');
        this.markCmd(ids, friend.x, friend.z, false);
        return;
      }
    }
    const enemy = this.pickView(sx, sy, v => !this.allies.has(v.o));
    if (enemy) {
      this.game.issue({ k: 'attack', p: me, ids, tgt: enemy.i, x: enemy.x, z: enemy.z, q: queue });
      audio.ack(this.dominantType(ids), 'attack');
      this.markCmd(ids, enemy.x, enemy.z, true);
      this.recordWp(enemy.x, enemy.z, true, queue);
      return;
    }
    audio.ack(this.dominantType(ids), 'move');
    this.markCmd(ids, g.x, g.z, false);
    const cx = Math.floor(g.x), cz = Math.floor(g.z);
    if (this.game.map.inB(cx, cz) && this.game.map.ore[cz * W + cx] > 0) {
      this.game.issue({ k: 'harvest', p: me, ids, x: g.x, z: g.z, q: queue });
      this.recordWp(g.x, g.z, false, queue);
      return;
    }
    this.game.issue({ k: 'move', p: me, ids, x: g.x, z: g.z, q: queue, spd: this.groupSpd(ids) });
    this.recordWp(g.x, g.z, false, queue);
  }

  // slowest base speed among the moving units (2+) so a mixed group advances
  // together instead of fast units arriving alone; undefined for a lone unit
  private groupSpd(ids: number[]): number | undefined {
    let n = 0, mn = Infinity;
    for (const id of ids) { const v = this.byId.get(id); const s = v && !v.b ? (UNITS[v.t]?.speed || 0) : 0; if (s > 0) { mn = Math.min(mn, s); n++; } }
    return n > 1 ? mn : undefined;
  }

  // Distribute selected units evenly along the drawn path, assigning slots
  // in travel order to minimize crossing paths.
  private issueFormation(path: { x: number; z: number }[], queue: boolean) {
    const ids = this.myUnitIds();
    if (ids.length < 2) return;
    const segLen: number[] = [0];
    let L = 0;
    for (let i = 1; i < path.length; i++) {
      L += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      segLen.push(L);
    }
    if (L < 1.5) { // too short to be a line — treat as a normal move
      const end = path[path.length - 1];
      this.game.issue({ k: 'move', p: this.game.me, ids, x: end.x, z: end.z, q: queue, spd: this.groupSpd(ids) });
      audio.play('confirm');
      return;
    }
    const n = ids.length;
    const slots: { x: number; z: number }[] = [];
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const s = (L * i) / (n - 1);
      while (seg < path.length - 2 && segLen[seg + 1] < s) seg++;
      const t = (s - segLen[seg]) / Math.max(0.0001, segLen[seg + 1] - segLen[seg]);
      slots.push({
        x: path[seg].x + (path[seg + 1].x - path[seg].x) * Math.min(1, t),
        z: path[seg].z + (path[seg + 1].z - path[seg].z) * Math.min(1, t),
      });
    }
    // sort units by their projection on the line's main axis, pair with slots in order
    let ax = path[path.length - 1].x - path[0].x, az = path[path.length - 1].z - path[0].z;
    const al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;
    const units = ids.map(id => this.byId.get(id)).filter(Boolean);
    units.sort((a, b) => (a.x * ax + a.z * az) - (b.x * ax + b.z * az));
    const ordered: number[] = [], xs: number[] = [], zs: number[] = [];
    units.forEach((u, i) => {
      ordered.push(u.i);
      xs.push(Math.round(slots[i].x * 100) / 100);
      zs.push(Math.round(slots[i].z * 100) / 100);
    });
    this.game.issue({ k: 'form', p: this.game.me, ids: ordered, xs, zs, q: queue, spd: this.groupSpd(ordered) });
    audio.play('confirm');
    audio.ack(this.dominantType(ordered), 'move');
  }

  private camQuad(): { x: number; z: number }[] {
    const pts = [[0.04, 0.08], [0.96, 0.08], [0.96, 0.92], [0.04, 0.92]];
    return pts.map(([nx, ny]) => this.renderer.groundPoint(nx, ny) || { x: this.renderer.camX, z: this.renderer.camZ });
  }

  // delayed hover tooltip: after the cursor rests on an entity (own OR enemy)
  // for ~0.4s, show its name and current HP near the pointer
  private updateEntTip(now: number) {
    if (!this.tipEl) {
      const el = document.createElement('div');
      el.id = 'entTip';
      el.style.cssText = 'position:fixed;pointer-events:none;z-index:30;display:none;padding:3px 7px;'
        + 'background:rgba(12,16,20,0.92);border:1px solid rgba(255,255,255,0.18);border-radius:4px;'
        + 'font:600 12px system-ui,sans-serif;color:#e8eef2;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.5)';
      document.body.appendChild(el);
      this.tipEl = el;
    }
    const blocked = this.ui.placing || this.patrolMode || this.terraMode || this.mouse.dragging
      || this.mouse.rDragging || this.mouse.x > window.innerWidth - 240;
    const v = blocked ? null : this.pickView(this.mouse.x, this.mouse.y, () => true);
    const id = v ? v.i : -1;
    if (id !== this.tipEntId) { this.tipEntId = id; this.tipSince = now; this.tipEl.style.display = 'none'; return; }
    if (id < 0) { this.tipEl.style.display = 'none'; return; }
    if (now - this.tipSince < 420) return; // dwell delay before it appears
    const def: any = UNITS[v.t] || BUILDINGS[v.t];
    const name = def?.name || v.t;
    const hp = Math.max(0, Math.round(v.h)), max = Math.round(v.m);
    const mine = v.o === this.game.me, ally = this.allies.has(v.o), neutral = v.ne === 1;
    const owner = this.game.players()[v.o]?.n || '';
    const col = mine ? '#7ee787' : neutral ? '#9fe3b0' : ally ? '#79c0ff' : '#ff7b72';
    // identify the owner: "Neutral (garrison)" for capturable city buildings, the
    // player's name + ally/enemy tag otherwise
    const who = mine ? '' : neutral ? ` · Neutral${v.gar ? ' (garrison)' : ''}` : ` · ${owner} (${ally ? 'ally' : 'enemy'})`;
    let label = `<span style="color:${col}">${name}</span>${who} · ${hp}/${max} HP`;
    if (v.b && v.pr < 1) label += ` · ${Math.round(v.pr * 100)}% built`;
    // buildings get a 2nd line: upgrade level + power (generated or consumed)
    if (v.b) {
      const bd: any = BUILDINGS[v.t];
      const lvl = v.lv || 1;
      const pw = bd?.power || 0;
      const pwTxt = pw > 0 ? `generates ${pw}⚡` : pw < 0 ? `uses ${-pw}⚡` : 'no power draw';
      label += `<br><span style="color:#9fb3c2;font-weight:500">Level ${lvl} · ${pwTxt}</span>`;
    }
    this.tipEl.innerHTML = label;
    this.tipEl.style.left = (this.mouse.x + 14) + 'px';
    this.tipEl.style.top = (this.mouse.y + 16) + 'px';
    this.tipEl.style.display = 'block';
  }

  // surrender: scuttle our forces — a defeat. The end screen with stats appears
  // right away (no spectating; matches can be rewatched from Replays instead).
  surrender() {
    if (this.over) return;
    this.surrendered = true; // reveal the map + show a "view report" button instead of jumping to stats
    this.game.issue({ k: 'surrender', p: this.game.me });
    audio.play('cancel');
  }
  // surrendered: the end block revealed the map; the player views the battle report
  // when they're ready (button in the HUD)
  viewReport() {
    document.getElementById('reportBanner')?.classList.add('hidden');
    this.onEnd(this.pendingWon, this.pendingWinner);
  }

  // reflect each toggleable command's state on its quickbar button: lit when the
  // whole selection has it set (Hold Position, Hold Fire, Patrol, Fortify), plus
  // the global Show-Ranges toggle
  private updateCmdToggles() {
    const vs = this.myUnitIds().map(id => this.byId.get(id)).filter(Boolean) as any[];
    const all = (pred: (v: any) => boolean) => vs.length > 0 && vs.every(pred);
    const set = (act: string, on: boolean) => {
      const b = document.querySelector(`#touchBar [data-act="${act}"]`);
      if (b) b.classList.toggle('on', !!on);
    };
    set('hold', all(v => v.st === 1));
    set('holdfire', all(v => v.hf === 1));
    set('patrol', this.patrolMode || all(v => v.pa === 1));
    set('fortify', all(v => v.fo === 1));
    set('ranges', this.showRanges);
    // "Set Primary" shows only for a single selected production building, lit when it
    // is already the primary (its produced units roll out from here)
    const pb = this.selectedProdBuilding();
    const primBtn = document.querySelector('#touchBar [data-act="primary"]') as HTMLElement | null;
    if (primBtn) { primBtn.style.display = pb ? '' : 'none'; primBtn.classList.toggle('on', !!(pb && pb.pm)); }
  }

  private loop = (t: number) => {
    this.raf = requestAnimationFrame(this.loop);
    this.lastRaf = performance.now();   // heartbeat watchdog: rAF is alive
    const dt = Math.min(0.1, (t - this.lastT) / 1000 || 0.016);
    this.lastT = t;
    const _w0 = this.perfOn ? performance.now() : 0;
    // TRUE frame rate: count frames over a wall-clock window and divide, refreshed
    // ~3x/sec. (The old per-frame 1/dt EMA jumped around with rAF timestamp jitter
    // even when the actual frame work was steady — the FPS number looked unstable.)
    this.fpsAccN++; this.fpsAccT += dt;
    if (this.fpsAccT >= 0.33) { this.fps = this.fpsAccN / this.fpsAccT; this.fpsAccN = 0; this.fpsAccT = 0; }
    // while the GUI is hidden, log the true average FPS to the console every 10s
    if (this.guiHidden) {
      this.fpsLogT += dt; this.fpsLogFrames++;
      if (this.fpsLogT >= 10) {
        console.log(`[perf] avg FPS (GUI hidden, last ${this.fpsLogT.toFixed(1)}s): ${(this.fpsLogFrames / this.fpsLogT).toFixed(1)}`);
        this.fpsLogT = 0; this.fpsLogFrames = 0;
      }
    }
    // top-bar FPS + (multiplayer) server ping readout, refreshed twice a second
    if (this.frame % 30 === 0 && !this.guiHidden) this.updateTopStat();

    const _u0 = this.perfOn ? performance.now() : 0;
    // once the match is decided, PAUSE the sim — don't keep advancing it (units would
    // otherwise keep moving/fighting behind the report banner and rubberband).
    if (!this.over) { prof.begin('sim.update'); this.game.update(dt * 1000); prof.end('sim.update'); }
    if (this.perfOn) this.updateMs += (performance.now() - _u0 - this.updateMs) * 0.2;
    this.checkNetStall();   // surface a pause popup if we're frozen waiting on a peer

    // camera: keys + edge pan + rotation
    const pan = 22 * (this.renderer.dist / 28) * dt;
    let dx = 0, dz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) dz += pan;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) dz -= pan;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) dx -= pan;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) dx += pan;
    if (this.mouse.in && !this.mouse.dragging && !this.mouse.rDragging) {
      if (this.mouse.x < 8) dx -= pan;
      if (this.mouse.x > window.innerWidth - 8) dx += pan;
      if (this.mouse.y < 8) dz += pan;
      if (this.mouse.y > window.innerHeight - 8) dz -= pan;
    }
    if (dx || dz) this.renderer.moveCam(dx, dz);
    if (this.keys.has('KeyQ')) this.renderer.rotate(1.6 * dt);
    if (this.keys.has('KeyE')) this.renderer.rotate(-1.6 * dt);

    // a selected building's stored patrol route shows as a standing yellow line
    const drawingNow = (this.patrolMode && this.patrolDraw && this.mouse.lDown) ||
      (this.mouse.rDragging && this.rMode === 'form');
    if (!drawingNow) {
      const pb = this.selectedProdBuilding();
      if (pb && pb.pp && pb.pp.length >= 2) this.renderer.setFormationPath(pb.pp, 0xffd24a);
      else this.renderer.setFormationPath(null);
    }

    // patrol route drawing (P + left-drag)
    if (this.patrolMode && this.patrolDraw && this.mouse.lDown && this.mouse.dragging) {
      const g = this.renderer.groundPoint(this.mouse.x / window.innerWidth, this.mouse.y / window.innerHeight);
      if (g) {
        const last = this.patrolDraw[this.patrolDraw.length - 1];
        if (!last || Math.hypot(g.x - last.x, g.z - last.z) >= 0.75) {
          if (this.patrolDraw.length < 120) this.patrolDraw.push(g);
        }
      }
      this.renderer.setFormationPath(this.patrolDraw, 0xffd24a);
    }

    // --- terraform: rectangle draw, then mouse-up/down height pick ---
    const terraHint = document.getElementById('terraHint');
    if (this.terraMode === 'draw' && this.terraRect && this.mouse.lDown) {
      const g = this.renderer.groundPoint(this.mouse.x / window.innerWidth, this.mouse.y / window.innerHeight);
      if (g) { this.terraRect.x1 = g.x; this.terraRect.z1 = g.z; }
      const r = this.terraRect;
      // anchor the rectangle preview to the BULLDOZER'S ground height, so the
      // selection slab sits level with the dozer instead of floating at the area's
      // own (possibly very different) terrain height
      const dz = this.myUnitIds().map(id => this.byId.get(id)).find(v => v && UNITS[v.t]?.terra);
      const dh = dz ? this.game.map.heightAt(dz.x, dz.z) : this.game.map.heightAt((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
      this.renderer.setTerraPreview({ x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, h: dh, base: dh - 0.1 });
      if (terraHint) { terraHint.textContent = 'TERRAFORM — drag the area, release to set its height'; terraHint.classList.remove('hidden'); }
    } else if (this.terraMode === 'height' && this.terraRect) {
      // moving the mouse UP raises the target, DOWN lowers it
      this.terraTargetH = Math.max(-1.2, Math.min(8, this.terraBaseH + (this.terraAnchorY - this.mouse.y) * 0.03));
      const r = this.terraRect;
      this.renderer.setTerraPreview({ x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, h: this.terraTargetH, base: this.terraBaseH });
      if (terraHint) {
        const rel = (this.terraTargetH - this.terraBaseH).toFixed(1);
        const tag = this.terraTargetH < SEA ? ' (underwater)' : '';
        const auto = Math.abs(this.terraTargetH - this.terraBaseH) < 0.15;
        terraHint.textContent = auto
          ? 'TERRAFORM — click now to auto-bridge a land path across the gap · move up/down to set a fixed height instead · Esc cancels'
          : `TERRAFORM height ${rel >= '0' ? '+' : ''}${rel}${tag} — move mouse up/down, click to build · Esc cancels`;
        terraHint.classList.remove('hidden');
      }
    } else if (terraHint && !terraHint.classList.contains('hidden')) {
      terraHint.classList.add('hidden');
    }

    // right-drag: grab-the-world pan, or formation line drawing
    if (this.mouse.rDragging) {
      if (this.rMode === 'rotate') {
        // Ctrl+right-drag: horizontal = spin (yaw), vertical = tilt (pitch)
        const dx = this.mouse.x - this.rotLast.x, dy = this.mouse.y - this.rotLast.y;
        this.renderer.rotate(dx * 0.005);
        this.renderer.tiltBy(dy * 0.004);
        this.rotLast = { x: this.mouse.x, y: this.mouse.y };
      } else if (this.rMode === 'pan' && this.grab) {
        const g = this.renderer.groundPoint(this.mouse.x / window.innerWidth, this.mouse.y / window.innerHeight);
        if (g) this.renderer.jumpCam(
          this.renderer.camX + (this.grab.x - g.x),
          this.renderer.camZ + (this.grab.z - g.z),
        );
      } else if (this.rMode === 'form' && this.formPath) {
        const g = this.renderer.groundPoint(this.mouse.x / window.innerWidth, this.mouse.y / window.innerHeight);
        if (g) {
          const last = this.formPath[this.formPath.length - 1];
          if (!last || Math.hypot(g.x - last.x, g.z - last.z) >= 0.75) {
            if (this.formPath.length < 120) this.formPath.push(g);
          }
        }
        this.renderer.setFormationPath(this.formPath);
      } else if ((this.rMode === 'aatk' || this.rMode === 'silo' || this.rMode === 'reparea' || this.rMode === 'harvarea' || this.rMode === 'barrage') && this.areaDrag) {
        // attack / strike / repair-zone / harvest-zone / barrage circle grows with the drag
        const g = this.renderer.groundPoint(this.mouse.x / window.innerWidth, this.mouse.y / window.innerHeight);
        if (g) this.areaDrag.r = Math.min(this.rMode === 'silo' ? 20 : (this.rMode === 'reparea' || this.rMode === 'harvarea') ? 24 : 14, Math.hypot(g.x - this.areaDrag.cx, g.z - this.areaDrag.cz));
      }
    }

    const allViews = this.game.views();
    // game over: the sim is paused, so clear each unit's "moving" flag this frame —
    // otherwise a unit frozen mid-stride keeps playing its walk/drive animation in
    // place (the jitter). With mv off they settle into their idle pose.
    if (this.over) for (const v of allViews) if (!v.b) v.mv = 0;
    // who's on my team (allies share vision and stay always-visible)
    const plList = this.game.players?.() || [];
    const myTeam = plList[this.game.me]?.tm;
    this.allies.clear();
    plList.forEach((pl: any, i: number) => { if (pl && pl.tm === myTeam) this.allies.add(i); });
    this.allies.add(this.game.me);
    // fog of war for human players (spectator/replay modes see everything;
    // disabled when the player unchecked it on the start screen)
    let views = allViews;
    if (!(this.game as any).isSim && fogEnabled && !this.over) {
      if (!this.fog) this.fog = new Uint8Array(W * H);
      if (this.frame % 3 === 0) { prof.begin('fog'); this.updateFog(allViews); prof.end('fog'); }
      // Spy Satellite: full-map visibility — but only while it's online (powered
      // and a Research Lab still stands); if it goes dark, fog returns
      if (plList[this.game.me]?.satOk) this.fog.fill(2);
      // enemy TEWS jamming strips radar/satellite intel inside its bubble (run
      // AFTER the satellite fill so it can claw that vision back)
      this.applyJamming(allViews);
      const f = this.fog;
      views = allViews.filter(v => {
        if (this.allies.has(v.o)) return true;
        const fv = f[Math.floor(v.z) * W + Math.floor(v.x)] || 0;
        return v.b ? fv >= 1 : fv === 2; // buildings stay on the map once scouted
      });
      if (this.frame % 6 === 0) { this.renderer.setFog(f); this.renderer.setTreeFog(f); }
    }
    if (!(this.game as any).isSim && this.frame % 6 === 0) this.scanRadar(allViews);
    this.lastViews = views;
    this.byId.clear();
    for (const v of views) this.byId.set(v.i, v);
    for (const id of this.selection) if (!this.byId.has(id)) this.selection.delete(id);

    // terraforming edited the heightfield → rebuild the terrain mesh (throttled)
    if (this.game.map.heightDirty && this.frame % 6 === 0) {
      this.renderer.refreshTerrain();
      this.game.map.heightDirty = false;
    }
    // players whose stored battery is low (< 50, same threshold as the minimap):
    // their buildings' animations freeze (radar dish stops, etc.) as a brownout cue
    const lowPowerOwners = new Set<number>();
    const pls = this.game.players();
    for (let i = 0; i < pls.length; i++) if (((pls[i]?.pwr) ?? 999) < 50) lowPowerOwners.add(i);
    prof.begin('render.scene'); this.renderer.updateViews(views, this.selection, dt, lowPowerOwners); prof.end('render.scene');
    const evs = this.game.drainEvents();
    this.renderer.addEvents(evs);
    for (const ev of evs) {
      if (ev.e === 'boom' && ev.big) this.ui.ping(ev.x, ev.z);
      if (ev.e === 'surrender') {
        const who = this.game.players?.()[ev.p]?.n || 'Enemy';
        const msg = ev.reason === 'left' ? 'has left the battle — resigned.' : 'We surrender! The region is yours.';
        this.appendChat({ name: who, to: 'all', msg });
        if (ev.p !== this.game.me) { audio.play('surrender'); if (this.soundOff) this.notify(`⚑ ${who} surrendered`, '#c8a6ff'); }
      }
      if (ev.e === 'sdtick' && ev.owner === this.game.me) audio.play('sdbeep');
      if (ev.e === 'tech' && ev.tech === 'satellite') {
        // ANY player's satellite launch gets a one-time cue (per player)
        if (!this.satCued.has(ev.p)) { this.satCued.add(ev.p); audio.play('satup'); if (this.soundOff) this.notify('🛰 Spy satellite launched', '#7df0c0'); }
        if (this.allies.has(ev.p)) {
          // an allied satellite goes up: dramatic rocket launch + permanent map reveal
          this.renderer.launchSatellite(ev.x ?? W / 2, ev.z ?? H / 2);
          if (ev.p === this.game.me) { this.flashBanner('🛰  SATELLITE ONLINE — full map visibility'); }
        }
      }
      audio.event(ev, this.renderer.camX, this.renderer.camZ, this.game.me);
    }
    prof.begin('audioCues'); this.updateAudioCues(views); prof.end('audioCues');
    // chat messages + expiry
    for (const m of (this.game.drainChat?.() || [])) { this.appendChat(m); audio.play('click'); }
    // collapse the expanded chat back to 2 lines, 3s after it was opened
    if (this.chatExpanded && performance.now() - this.chatExpandT > 3000) { this.chatExpanded = false; this.renderChat(); }
    if (this.frame % 30 === 0) {
      // age out old lines so they fade away — but always KEEP the last 10
      // (they stay on screen after the chat closes), and never prune while typing
      const typing = !document.getElementById('chatBar')!.classList.contains('hidden');
      if (!typing && this.chatHistory.length > 10) {
        const now = performance.now();
        const before = this.chatHistory.length;
        const cutoff = this.chatHistory.length - 10; // indices below this may age out
        this.chatHistory = this.chatHistory.filter((m, i) => i >= cutoff || now - m.t < 20000);
        if (this.chatHistory.length !== before) this.renderChat();
      }
    }

    // building ghost (single) or wall/barrier drag-line preview
    if (this.ui.placing && this.lineStart) {
      const gh = this.ghostAt(this.mouse.x, this.mouse.y);
      const end = gh ? { cx: gh.cx, cz: gh.cz } : this.lineStart;
      this.lineCells = this.computeLine(this.ui.placing, this.lineStart, end);
      this.renderer.setGhost(false, this.ui.placing, 0, 0, false); // hide the single ghost
      this.lastGhost = null;
    } else if (this.ui.placing) {
      const gh = this.ghostAt(this.mouse.x, this.mouse.y);
      if (gh) { this.lastGhost = gh; this.renderer.setGhost(true, this.ui.placing, gh.cx, gh.cz, gh.ok); }
    } else if (this.oilHover && this.oilCell) {
      // engineer hovering a claimable oil well → preview the Oil Rig footprint there
      this.lineCells = [];
      this.lineStart = null;
      this.lastGhost = null;
      this.renderer.setGhost(true, 'oilrig', this.oilCell.cx, this.oilCell.cz, true);
    } else {
      this.lineCells = [];
      this.lineStart = null;
      this.lastGhost = null;
      this.renderer.setGhost(false);
    }

    const _r0 = this.perfOn ? performance.now() : 0;
    prof.begin('render.3d'); this.renderer.render(dt); prof.end('render.3d');
    if (this.perfOn) this.renderMs += (performance.now() - _r0 - this.renderMs) * 0.2;

    const players = this.game.players();
    // The sidebar/build-menu DOM update is one of the heaviest per-frame costs but
    // doesn't need 60 Hz — throttle it to ~12 Hz. Refresh IMMEDIATELY whenever the
    // selection changes so clicking a unit/building still feels instant, and force
    // one update on the very first frame. (World 3D + overlay still render every frame.)
    if (!this.guiHidden) {
      let selSig = this.selection.size;
      for (const id of this.selection) selSig = (selSig * 31 + id) | 0;
      const now = performance.now();
      if (selSig !== this.lastSelSig || now - this.lastUiUpdate >= 80) {
        prof.begin('ui.update'); this.ui.update(this.game.me, players, views, this.game.tickN, this.selection); prof.end('ui.update');
        this.lastUiUpdate = now; this.lastSelSig = selSig;
      }
    }
    this.frame++;
    // minimap redraws once per second (it's a cheap-to-skip overview, not the
    // live battlefield) — pass the real elapsed time so flash-fades stay correct
    const nowMs = performance.now();
    if (!this.guiHidden && nowMs - this.lastMinimap >= 1000) {
      const elapsed = (nowMs - this.lastMinimap) / 1000;
      this.lastMinimap = nowMs;
      const fogFn = (!(this.game as any).isSim && fogEnabled && this.fog) ? (cx: number, cz: number) => this.renderer.fogValue(cx, cz) : undefined;
      // radar-detected threats show on the minimap even through fog
      const mmViews = this.radarBlips.length ? views.concat(this.radarBlips) : views;
      // the minimap needs spare power AND a Radar Dome (or a spy satellite) to
      // display. LOW POWER = spare generation (made - used) under 50 → it takes
      // precedence; otherwise NO RADAR if none built. Spectator/replay show all.
      let gate: 'ok' | 'noradar' | 'lowpower' = 'ok';
      if (!(this.game as any).isSim) {
        const meId = this.game.me;
        const pl = this.game.players()[meId];
        const lowPower = pl ? (pl.pwr ?? 0) < 50 : false; // stored battery under 50 = low (matches the HUD meter)
        if (lowPower) gate = 'lowpower';
        else if (!pl?.satOk) {
          let built = false;
          for (const v of mmViews) if (v.b && v.o === meId && v.t === 'radar' && (v.pr ?? 1) >= 1) { built = true; break; }
          if (!built) gate = 'noradar';
        }
      }
      prof.begin('minimap'); this.ui.minimap(this.game.map, mmViews, this.camQuad(), elapsed, fogFn, gate); prof.end('minimap');
    }
    // no selection box while drawing a patrol route or drag-placing a structure
    // line (walls / tank barriers) — those drags aren't a selection
    const dragRect = this.mouse.dragging && !this.patrolMode && !this.ui.placing && !this.terraMode
      ? { x0: this.mouse.downX, y0: this.mouse.downY, x1: this.mouse.x, y1: this.mouse.y }
      : null;

    // hovering an enemy with combat units selected → attack indicator. Persist
    // the last result between the throttled recomputes, but CLEAR it the moment
    // hovering no longer applies (no selection, dragging, placing) — otherwise a
    // stale value flickered the reticle/cursor every other frame.
    const canvas3 = document.getElementById('three') as HTMLCanvasElement;
    const canHover = !this.ui.placing && !this.patrolMode && !this.mouse.dragging
      && !this.mouse.rDragging && this.myUnitIds().length > 0;
    let hover = this.lastHover;
    if (!canHover) { hover = null; this.lastHover = null; this.loadHover = false; this.garrisonHover = false; this.oilHover = false; }
    else if (this.frame % 2 === 0) {
      hover = null;
      const enemy = this.pickView(this.mouse.x, this.mouse.y, v => !this.allies.has(v.o));
      if (enemy) {
        const ed = UNITS[enemy.t];
        const p = (!enemy.b && ed?.fly)
          ? this.renderer.projectY(enemy.x, this.renderer.flyY(enemy.x, enemy.z, ed.alt || 2.3), enemy.z)
          : this.renderer.project(enemy.x, enemy.z, enemy.b ? 1 : 0.5);
        if (p.ok) hover = { x: p.x, y: p.y };
      }
      this.lastHover = hover;
      // hovering MY carrier (transport ship or IFV) with loadable units selected →
      // show the loading cursor (only if the carrier can actually take their kind)
      const me = this.game.me;
      const selInf = this.myUnitIds().some(id => UNITS[this.byId.get(id)?.t]?.kind === 'inf');
      const selVeh = this.myUnitIds().some(id => UNITS[this.byId.get(id)?.t]?.kind === 'veh');
      const carrier = (selInf || selVeh) ? this.pickView(this.mouse.x, this.mouse.y, v => v.o === me && v.b !== 1 && UNITS[v.t]?.carrier
        && ((selInf && (UNITS[v.t].carryInf ?? 30) > 0) || (selVeh && (UNITS[v.t].carryVeh ?? 10) > 0))) : null;
      this.loadHover = !!carrier;
      // hovering a garrisonable building (neutral or ours, with room) while infantry
      // are selected → show the enter cursor; suppress the attack reticle on it
      const hasInf = this.myUnitIds().some(id => UNITS[this.byId.get(id)?.t]?.kind === 'inf');
      const garrB = hasInf ? this.pickView(this.mouse.x, this.mouse.y, v => v.b === 1 && v.gar === 1 && (v.ne === 1 || v.o === me) && (v.cu || 0) < (v.gcap || 0)) : null;
      this.garrisonHover = !!garrB;
      if (garrB) { hover = null; this.lastHover = null; }
      // hovering a claimable oil well with an Engineer selected → show the oil-rig
      // cursor (right-click builds an Oil Rig there). Mirrors the right-click rule:
      // an Engineer is repair+road, the cell is an unoccupied oil well.
      const hasEng = this.myUnitIds().some(id => { const d = UNITS[this.byId.get(id)?.t]; return d?.repair && d?.road; });
      let oilH = false;
      if (hasEng) {
        const gp = this.renderer.groundPoint(this.mouse.x / window.innerWidth, this.mouse.y / window.innerHeight);
        if (gp) { // groundPoint returns {x,z}|null — there is no .ok field (the old gp.ok check was always false, so the ghost never showed)
          const ocx = Math.floor(gp.x), ocz = Math.floor(gp.z), m = this.game.map;
          if (m.inB(ocx, ocz) && m.oil[ocz * W + ocx] === 1 && m.occ[ocz * W + ocx] === 0) { oilH = true; this.oilCell = { cx: ocx, cz: ocz }; }
        }
      }
      if (!oilH) this.oilCell = null;
      this.oilHover = oilH;
      if (oilH) { hover = null; this.lastHover = null; }
    }
    // delayed name + HP tooltip for whatever entity sits under the cursor
    this.updateEntTip(t);
    if (this.frame % 4 === 0) this.updateCmdToggles(); // command-button toggle states

    // a selected missile silo turns the whole map into a strike-target reticle
    const siloAiming = this.selection.size === 1 && this.byId.get([...this.selection][0])?.t === 'silo'
      && this.byId.get([...this.selection][0])?.o === this.game.me;
    // only assign when it changes — re-setting a data-URI cursor every frame
    // makes Chrome re-decode the image and flicker
    const wantCursor = this.terraMode ? TERRA_CURSOR : siloAiming ? SILO_CURSOR : this.loadHover ? LOAD_CURSOR : this.garrisonHover ? GARRISON_CURSOR : this.oilHover ? OIL_CURSOR : hover ? 'crosshair' : '';
    if (wantCursor !== this.lastCursor) { canvas3.style.cursor = wantCursor; this.lastCursor = wantCursor; }

    // range/detection circles for the current selection
    const circles: { x: number; z: number; r: number; atk: boolean }[] = [];
    if (this.showRanges) {
      for (const id of this.selection) {
        const v = this.byId.get(id);
        if (!v) continue;
        let r = 0;
        if (v.b) { const a = BUILDINGS[v.t]?.attack; if (a) r = a.range + 0.8 * ((v.lv || 1) - 1); }
        else { const d = UNITS[v.t]; if (d && d.dmg > 0) r = d.range * (v.fo ? 1.2 : 1); } // dug-in units reach 20% farther
        if (r > 0) circles.push({ x: v.x, z: v.z, r, atk: true });
        // sonar-capable ships (Destroyer / Sub Hunter) show their detection
        // bubble as a separate blue circle
        const sd = !v.b ? UNITS[v.t]?.sonar : 0;
        if (sd) circles.push({ x: v.x, z: v.z, r: sd, atk: false, kind: 'sonar' } as any);
      }
    }
    // while placing a defensive structure, preview its FULLY-UPGRADED max range
    // (green) so you can position it before committing
    if (this.ui.placing && this.lastGhost) {
      const def = BUILDINGS[this.ui.placing];
      let r = 0;
      if (def.attack) r = def.attack.range + 0.8 * (UPG_MAX - 1);
      else if (def.intercept) r = def.intercept.range;
      if (r > 0) {
        const cx = this.lastGhost.cx + def.size / 2, cz = this.lastGhost.cz + def.size / 2;
        circles.push({ x: cx, z: cz, r, atk: false, kind: 'place' } as any);
      }
    }
    // live attack/strike-circle while dragging
    if (this.mouse.rDragging && (this.rMode === 'aatk' || this.rMode === 'silo' || this.rMode === 'barrage') && this.areaDrag && this.areaDrag.r > 0.5)
      circles.push({ x: this.areaDrag.cx, z: this.areaDrag.cz, r: this.areaDrag.r, atk: true, fill: true } as any);
    // live engineer repair-zone / harvester work-area circle while dragging (green)
    if (this.mouse.rDragging && (this.rMode === 'reparea' || this.rMode === 'harvarea') && this.areaDrag && this.areaDrag.r > 0.5)
      circles.push({ x: this.areaDrag.cx, z: this.areaDrag.cz, r: this.areaDrag.r, atk: false, kind: 'place' } as any);
    // standing repair zones on my selected engineers (green)
    for (const v of views) if (v.rzr && v.o === this.game.me && this.selection.has(v.i))
      circles.push({ x: v.rzx, z: v.rzz, r: v.rzr, atk: false, kind: 'place' } as any);
    // standing harvester work areas on my selected harvesters (green)
    for (const v of views) if (v.hzr && v.o === this.game.me && this.selection.has(v.i))
      circles.push({ x: v.hzx, z: v.hzz, r: v.hzr, atk: false, kind: 'place' } as any);
    // standing missile-strike zones on my silos (red)
    for (const v of views) if (v.kr && v.o === this.game.me)
      circles.push({ x: v.kx, z: v.kz, r: v.kr, atk: true, fill: true } as any);
    // selected units holding a ground force-fire order: keep the red marker on the
    // ground (a filled barrage circle if it's a Sperrfeuer area, a small ring if a point)
    for (const v of views) if (v.fax !== undefined && v.o === this.game.me && this.selection.has(v.i))
      circles.push({ x: v.fax, z: v.faz, r: v.far || 0.8, atk: true, fill: !!v.far } as any);
    // selected silo: amber preview of the target area under the cursor
    if (siloAiming && !this.mouse.rDragging && this.mouse.x < window.innerWidth - 250) {
      const g = this.renderer.groundPoint(this.mouse.x / window.innerWidth, this.mouse.y / window.innerHeight);
      if (g) circles.push({ x: g.x, z: g.z, r: 4, atk: true, fill: true, preview: true } as any);
    }
    // age out command effects
    for (const f of this.cmdFx) f.t -= dt;
    this.cmdFx = this.cmdFx.filter(f => f.t > 0);

    if (!this.guiHidden) {
      prof.begin('overlay.2d');
      this.ui.overlay(this.overlayCtx, this.renderer.project.bind(this.renderer), this.renderer.projectY.bind(this.renderer), views, this.game.me, this.selection, dragRect, hover, circles, this.cmdFx);
      prof.end('overlay.2d');
    }

    // Neutral garrison buildings are permanently tagged "Neutral" so you can see
    // they're capturable. Owner names for OTHER players' units/buildings are NOT
    // drawn permanently (that cluttered the screen in 3+ player games) — they show
    // on mouseover via the entity tooltip instead.
    if (!this.guiHidden) {
      const ctxL = this.overlayCtx;
      let drawn = 0;
      for (const v of views) {
        if (!(v.b && v.ne === 1) || drawn > 40) continue; // neutral capturable buildings only
        const p = this.renderer.project(v.x, v.z, 3.0);
        if (!p.ok) continue;
        this.ui.worldLabel(ctxL, 'Neutral', '#9fe3b0', p.x, p.y);
        drawn++;
      }
    }

    // wall/barrier drag-line preview (drawn over the overlay)
    if (this.lineStart && this.lineCells.length) {
      const ctx = this.overlayCtx;
      for (const c of this.lineCells) {
        const p = this.renderer.project(c.cx + 0.5, c.cz + 0.5, 0.2);
        if (!p.ok) continue;
        ctx.fillStyle = c.ok ? 'rgba(90,220,120,0.5)' : 'rgba(220,70,60,0.5)';
        ctx.strokeStyle = c.ok ? 'rgba(150,255,170,0.9)' : 'rgba(255,120,110,0.9)';
        ctx.lineWidth = 1.5;
        ctx.fillRect(p.x - 9, p.y - 9, 18, 18);
        ctx.strokeRect(p.x - 9, p.y - 9, 18, 18);
      }
    }

    // shift-queued waypoint trail: a dotted chain through the queued points so
    // the player can see the route their selection will follow, in click order
    // waypoint paths overlay. While SHIFT is held, every selected unit shows its
    // REMAINING route (re-derived from its live orders), with a closed amber loop
    // when repeat is on. Otherwise the freshly-issued chain flashes briefly.
    type WP = { x: number; z: number; atk: boolean };
    const ctxW = this.overlayCtx;
    const drawPath = (anchor: WP | null, pts: WP[], loop: boolean) => {
      if (!pts.length) return;
      const proj = pts.map(w => ({ w, p: this.renderer.project(w.x, w.z, 0.3) }));
      const a = anchor ? this.renderer.project(anchor.x, anchor.z, 0.3) : null;
      ctxW.strokeStyle = loop ? 'rgba(255,200,90,0.6)' : 'rgba(120,210,255,0.55)';
      ctxW.lineWidth = 2; ctxW.setLineDash(loop ? [4, 4] : [6, 5]);
      ctxW.beginPath();
      if (a && a.ok) ctxW.moveTo(a.x, a.y);
      proj.forEach((q, i) => { if (!q.p.ok) return; (i === 0 && !(a && a.ok)) ? ctxW.moveTo(q.p.x, q.p.y) : ctxW.lineTo(q.p.x, q.p.y); });
      if (loop && a && a.ok) ctxW.lineTo(a.x, a.y); // close the loop back to the unit
      ctxW.stroke(); ctxW.setLineDash([]);
      proj.forEach((q, i) => {
        if (!q.p.ok) return;
        ctxW.fillStyle = q.w.atk ? 'rgba(255,90,70,0.92)' : loop ? 'rgba(255,200,90,0.95)' : 'rgba(120,210,255,0.92)';
        ctxW.beginPath(); ctxW.arc(q.p.x, q.p.y, 7, 0, Math.PI * 2); ctxW.fill();
        ctxW.fillStyle = '#06121a'; ctxW.font = 'bold 10px system-ui'; ctxW.textAlign = 'center'; ctxW.textBaseline = 'middle';
        ctxW.fillText(String(i + 1), q.p.x, q.p.y + 0.5);
      });
    };
    const shiftHeld = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    if (shiftHeld && this.myUnitIds().length) {
      for (const id of this.myUnitIds()) {
        const v = this.byId.get(id);
        if (v && v.wp && v.wp.length) drawPath({ x: v.x, z: v.z, atk: false }, v.wp.map((w: any) => ({ x: w.x, z: w.z, atk: w.a === 1 })), !!v.lp);
      }
    } else if (this.wpTrail.length) {
      if (performance.now() - this.wpT > 12000 || !this.myUnitIds().length) this.wpTrail = [];
      else {
        let sx = 0, sz = 0, n = 0;
        for (const id of this.myUnitIds()) { const v = this.byId.get(id); if (v) { sx += v.x; sz += v.z; n++; } }
        drawPath(n ? { x: sx / n, z: sz / n, atk: false } : null, this.wpTrail.slice(), false);
      }
    }

    const st = this.game.status();
    // with multiple AIs the sim runs until ONE side remains; if the human is
    // wiped out first, call defeat immediately instead of forcing them to
    // spectate the survivors fight it out
    const meDead = !(this.game as any).isSim && players[this.game.me] && players[this.game.me].a === false;
    if ((st.over || meDead) && !this.over) {
      this.over = true;
      // the battle is decided — lift the fog so the whole map is revealed
      if (this.fog) { this.fog.fill(2); this.renderer.setFog(this.fog); this.renderer.setTreeFog(this.fog); }
      const wn = st.over && st.winner >= 0 && players[st.winner] ? players[st.winner].n
        : meDead ? (players.find((p: any, i: number) => i !== this.game.me && p.a)?.n || 'The enemy') : 'Nobody';
      const won = !meDead && st.winner === this.game.me;
      if ((this.game as any).isSim || (this.game as any).isReplay) {
        // AI-vs-AI spectate / replay: no player perspective to survey — go straight to the summary
        this.onEnd(won, wn);
      } else {
        // EVERY played game ends by revealing the map; the player surveys the
        // battlefield, then clicks the banner button to open the battle report
        this.pendingWon = won; this.pendingWinner = wn;
        const msg = document.getElementById('reportMsg');
        if (msg) msg.textContent = this.surrendered ? '⚑ You surrendered — battlefield revealed.'
          : won ? '🏆 Victory — battlefield revealed.' : '💥 Defeat — battlefield revealed.';
        document.getElementById('reportBanner')?.classList.remove('hidden');
      }
    }

    prof.frame(); // fold this frame's profiler zones into the smoothed averages
    if (this.perfOn) { this.workMs += (performance.now() - _w0 - this.workMs) * 0.2; if (this.frame % 6 === 0) this.updatePerfHud(); }
    else if (this.perfEl) { this.perfEl.style.display = 'none'; }
  };

  // Multiplayer desync pause: when our lockstep sim has been frozen waiting on a
  // peer's input for >3s, show a pause popup with live network stats. The match
  // is already effectively paused (lockstep can't advance without every player's
  // input); this just surfaces it instead of a silent freeze, and auto-resumes
  // the moment sync recovers. "Keep waiting" snoozes the popup; "Quit" surrenders.
  private stallSnoozeUntil = 0;
  // "Keep waiting": hide the popup for a bit; it re-shows if we're still frozen.
  snoozeStall() { this.stallSnoozeUntil = performance.now() + 15000; }
  private checkNetStall() {
    const el = document.getElementById('netStall');
    if (!el) return;
    const fn = (this.game as any).stalledMs;
    const shown = !el.classList.contains('hidden');
    if (this.over || typeof fn !== 'function') { if (shown) el.classList.add('hidden'); return; }
    const ms = (this.game as any).stalledMs() as number;
    if (shown) {
      if (ms < 600) { el.classList.add('hidden'); return; }   // recovered → resume
      this.renderStallStats(ms);
    } else if (ms > 3000 && performance.now() > this.stallSnoozeUntil) {
      this.renderStallStats(ms);
      el.classList.remove('hidden');
    }
  }
  private renderStallStats(ms: number) {
    const stats = document.getElementById('netStallStats');
    if (!stats) return;
    const ns: any = (this.game as any).netStats ? (this.game as any).netStats() : null;
    const peers = ns?.rtc ? `${ns.rtc.n}/${ns.rtc.of} connected (P2P)` : 'server relay';
    const ping = ns && ns.ping ? `${Math.round(ns.ping)} ms` : '—';
    stats.innerHTML =
      `Frozen for <b style="color:#ffd27d">${(ms / 1000).toFixed(1)} s</b>`
      + `<br>Your ping: ${ping}`
      + `<br>Total stalls: ${ns?.stalls ?? '—'}`
      + `<br>Peers: ${peers}`
      + `<br>Sim tick: ${ns?.tick ?? this.game.tickN}`;
  }

  // when sound is off, the audio-only event cues are surfaced as on-screen text
  // instead, so a muted player still gets the engine notifications.
  private get soundOff() { return audio.muted || audio.sfxVol <= 0; }
  private toastEl: HTMLDivElement | null = null;
  notify(msg: string, color = '#8fd0ff') {
    if (!this.toastEl) {
      const el = document.createElement('div');
      el.id = 'gameToasts';
      el.style.cssText = 'position:fixed;top:48px;left:50%;transform:translateX(-50%);z-index:40;'
        + 'display:flex;flex-direction:column;gap:4px;align-items:center;pointer-events:none';
      document.body.appendChild(el);
      this.toastEl = el;
    }
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `background:rgba(10,14,18,0.9);border:1px solid #2c3e50;border-left:3px solid ${color};`
      + `border-radius:5px;padding:5px 12px;font:600 13px 'Segoe UI',sans-serif;color:#e8eef3;`
      + `box-shadow:0 2px 8px rgba(0,0,0,.5);opacity:0;transition:opacity .2s`;
    this.toastEl.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    while (this.toastEl.children.length > 5) this.toastEl.removeChild(this.toastEl.firstChild!);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 4200);
  }

  // F3 perf overlay: frame rate + where each frame's time goes, plus (for a
  // multiplayer match) the snapshot stream — rate, size and arrival latency.
  // rate-limited audio feedback cues (power state, under-attack, silo, satellite).
  // Each cue fires at most once per 30s, and the power cues only on a threshold
  // CROSSING into a worse state so a steady brownout doesn't nag repeatedly. When
  // sound is off the same cues show as text toasts via notify().
  private updateAudioCues(views: any[]) {
    const now = performance.now();
    const cue = (k: string, snd: string, gap = 30000, text?: string, color?: string) => {
      // a never-fired cue (cueT[k] undefined) ALWAYS fires — don't gate the very
      // first one on performance.now() >= gap (that silenced cues for 30s after load).
      if (this.cueT[k] === undefined || now - this.cueT[k] >= gap) {
        this.cueT[k] = now; audio.play(snd);
        if (text && this.soundOff) this.notify(text, color);
      }
    };
    const me = this.game.players?.()[this.game.me];
    if (me && me.a !== false) {
      // Drive the power cues off the stored battery (what the HUD meter shows) and
      // load-shedding — NOT pu>pm (powerUsed is capped to the sustainable load by
      // shedding, and once the battery drains the base recharges with pu<pm, so that
      // never fired even at ~0% battery).
      //   INSUFFICIENT = buildings are actually being shed (v.po) for lack of power,
      //   LOW          = the stored battery reserve has dropped below 50 (HUD meter).
      // The warning REPEATS every 30s (the cue() throttle) until power is restored —
      // not just on the crossing — so a persistent brownout keeps nagging.
      let shed = 0;
      for (const v of views) if (v.b && v.o === this.game.me && v.po) shed++;
      const st = shed > 0 ? 2 : ((me.pwr ?? 0) < 50 ? 1 : 0);
      if (st === 2) cue('pwrout', 'pwrout', 30000, '⚡ Power insufficient — buildings shutting down', '#ff5043');
      else if (st === 1) cue('pwrlow', 'pwrlow', 30000, '⚡ Power running low', '#ffc940');
      this.pwrState = st;
    }
    // an ENEMY missile silo finished — announce once per session (our own silo is
    // no threat, so building one ourselves never triggers the warning)
    if (!this.siloCued && views.some(v => v.b && v.t === 'silo' && v.o !== this.game.me && (v.pr ?? 1) >= 1)) {
      this.siloCued = true; audio.play('siloup');
      if (this.soundOff) this.notify('☢ Enemy missile silo online', '#ff8a5a');
    }
    // my units / buildings taking fire — separate cues, 30s apart each
    for (const v of views) {
      if (v.o !== this.game.me) continue;
      const prev = this.hpPrev.get(v.i);
      if (prev !== undefined && v.h < prev - 0.5)
        cue(v.b ? 'bldgattack' : 'unitattack', v.b ? 'bldgattack' : 'underattack', 30000,
          v.b ? '⚠ Building under attack' : '⚠ Unit under attack', '#ff7a6a');
    }
    this.hpPrev.clear();
    for (const v of views) if (v.o === this.game.me) this.hpPrev.set(v.i, v.h);
  }

  // This is what diagnoses "performance got bad": a low FPS with high render
  // time is the client GPU/CPU; healthy FPS but stale snapshots is the network
  // or a server tick falling behind.
  private updatePerfHud() {
    if (!this.perfEl) {
      const el = document.createElement('div');
      el.id = 'perfHud';
      el.style.cssText = 'position:fixed;top:60px;left:10px;z-index:30;background:rgba(6,10,14,0.82);'
        + 'border:1px solid #2c3e50;border-radius:6px;padding:7px 10px;font:11px/1.5 ui-monospace,monospace;'
        + 'color:#bfe3c8;white-space:pre;pointer-events:none;text-shadow:0 1px 2px #000';
      document.body.appendChild(el);
      this.perfEl = el;
    }
    this.perfEl.style.display = 'block';
    const ents = this.lastViews.length;
    const fpsCol = this.fps < 30 ? '#ff6b5e' : this.fps < 50 ? '#ffc940' : '#7be08a';
    // GPU geometry submitted last frame: triangles + draw calls (WebGL renderer.info)
    const ri = (this.renderer as any).three?.info?.render;
    const tris = ri ? (ri.triangles >= 1e6 ? (ri.triangles / 1e6).toFixed(2) + 'M' : ri.triangles >= 1e3 ? (ri.triangles / 1e3).toFixed(0) + 'k' : String(ri.triangles)) : '?';
    const draws = ri ? ri.calls : '?';
    let s = `<span style="color:${fpsCol}">FPS ${this.fps.toFixed(0)}</span>  frame ${this.workMs.toFixed(1)}ms\n`
      + `render ${this.renderMs.toFixed(1)}ms  sim ${this.updateMs.toFixed(1)}ms\n`
      + `entities ${ents}  selected ${this.selection.size}\n`
      + `tris ${tris}  draws ${draws}`;
    // active GPU: green = discrete (good), red = software, amber = integrated/unknown.
    // If this isn't your RTX, the browser is on the wrong GPU (see graphics settings).
    const gpu = (this.renderer as any).gpuName || 'unknown';
    const soft = /swiftshader|llvmpipe|basic render|software|microsoft basic/i.test(gpu);
    const disc = /nvidia|geforce|rtx|gtx|radeon|\bamd\b/i.test(gpu);
    const gpuCol = soft ? '#ff6b5e' : disc ? '#7be08a' : '#ffc940';
    s += `\n<span style="color:${gpuCol}">GPU ${String(gpu).slice(0, 46)}</span>`;
    const ns = (this.game as any).netStats?.();
    if (ns) {
      const now = performance.now();
      if (!this.perfRx.t) this.perfRx = { bytes: ns.bytes, t: now };
      const win = (now - this.perfRx.t) / 1000;
      const kbps = win > 0.5 ? ((ns.bytes - this.perfRx.bytes) / 1024 / win) : 0;
      if (win > 1) this.perfRx = { bytes: ns.bytes, t: now };
      const ping = Math.round(ns.ping || 0);
      const pCol = ping > 200 ? '#ff6b5e' : ping > 120 ? '#ffc940' : '#7bdcff';
      s += `\n<span style="color:${pCol}">ping ${ping}ms</span>  ${kbps.toFixed(0)}KB/s  ${ns.msgs || 0} msgs`;
      if (ns.interpSpan !== undefined) {            // snapshot game
        const snapRate = ns.interpSpan > 0 ? (1000 / ns.interpSpan) : 0;
        const stale = ns.sinceSnap;
        const staleCol = stale > 400 ? '#ff6b5e' : stale > 200 ? '#ffc940' : '#7bdcff';
        s += `\n<span style="color:#7bdcff">net</span>  ${snapRate.toFixed(1)} snap/s  ${(ns.lastSize / 1024).toFixed(1)}KB`
          + `\n<span style="color:${staleCol}">last snap ${stale.toFixed(0)}ms ago</span>`;
      } else if (ns.stalls !== undefined) {          // lockstep game
        const stCol = ns.stalls > 50 ? '#ffc940' : '#7be08a';
        // transport: P2P (WebRTC, no head-of-line blocking) once every peer's
        // DataChannel is open, otherwise the TCP relay fallback
        let trans = '';
        if (ns.rtc) {
          const p2p = ns.rtc.of > 0 && ns.rtc.n >= ns.rtc.of;
          trans = p2p
            ? `  <span style="color:#7be08a">P2P ${ns.rtc.n}/${ns.rtc.of}</span>`
            : `  <span style="color:#ffc940">relay (P2P ${ns.rtc.n}/${ns.rtc.of})</span>`;
        }
        s += `\n<span style="color:#7bdcff">lockstep</span>  tick ${ns.tick}  delay ${ns.delay}${trans}`
          + `\n<span style="color:${stCol}">stalls ${ns.stalls}</span>`;
        // per-player input lead: how many ticks ahead each player's input is buffered.
        // The player whose lead sits near 0 is the one starving the lockstep.
        if (Array.isArray(ns.leads)) {
          const parts = ns.leads.map((lead: number, p: number) => {
            if (p === this.me) return null; // our own input is always far ahead
            const nm = (ns.roster?.[p]?.name || `P${p}`).slice(0, 8);
            const col = lead < 1 ? '#ff6b5e' : lead < 3 ? '#ffc940' : '#7be08a';
            return `<span style="color:${col}">${nm} ${lead >= 0 ? '+' : ''}${lead}</span>`;
          }).filter(Boolean);
          if (parts.length) s += `\n<span style="color:#8aa0b2">lead</span> ${parts.join('  ')}`;
        }
      }
    }
    // deep profiler breakdown: per-section avg ms/frame (sorted), %, calls/frame
    if (prof.enabled) {
      const rows = prof.table();
      const total = rows.reduce((a, r) => a + r.ms, 0) || 1;
      s += `\n<span style="color:#c8b6ff">— profiler (Shift+\`) —</span>`;
      for (const r of rows) {
        const pct = (r.ms / total) * 100;
        const col = r.ms > 4 ? '#ff6b5e' : r.ms > 1.5 ? '#ffc940' : '#9fb3c8';
        s += `\n<span style="color:${col}">${r.ms.toFixed(2)}ms</span> ${pct.toFixed(0).padStart(2)}%  ${r.label}${r.n > 1.5 ? '  ×' + r.n : ''}`;
      }
    }
    this.perfEl.innerHTML = s;
  }

  togglePerf() { this.perfOn = !this.perfOn; if (!this.perfOn && this.perfEl) this.perfEl.style.display = 'none'; }
  // V: hide/show the whole GUI. Hiding also makes the loop skip the HUD, minimap
  // and 2D-overlay draws, so the FPS difference reveals the GUI's render cost.
  toggleGui() {
    this.guiHidden = !this.guiHidden;
    const hud = document.getElementById('hud');
    const ov = document.getElementById('overlay');
    if (hud) hud.style.visibility = this.guiHidden ? 'hidden' : '';
    if (ov) ov.style.visibility = this.guiHidden ? 'hidden' : '';
    this.fpsLogT = 0; this.fpsLogFrames = 0;
    console.log(this.guiHidden
      ? '[perf] GUI hidden (clean screen) — average FPS logged every 10s. Press V to restore.'
      : '[perf] GUI restored.');
  }

  // compact top-bar readout: frame rate always, plus server ping in multiplayer
  private updateTopStat() {
    const el = document.getElementById('perfStat');
    if (!el) return;
    const fps = Math.round(this.fps);
    const fpsCol = fps < 30 ? '#ff6b5e' : fps < 50 ? '#ffc940' : '#7be08a';
    let html = `<span style="color:${fpsCol}">${fps} fps</span>`;
    const ns = (this.game as any).netStats?.();
    if (ns) {
      const ping = Math.round(ns.ping || 0);
      const pCol = ping > 200 ? '#ff6b5e' : ping > 120 ? '#ffc940' : '#7bdcff';
      html += `  <span style="color:${pCol}">${ping} ms</span>`;
    }
    el.innerHTML = html;
    // hover the top-bar faction name → full player list (faction · team · human/AI,
    // plus your own ping). Native title tooltip; refreshed here with the live state.
    const fn = document.getElementById('facName');
    if (fn) {
      const myPing = ns ? Math.round(ns.ping || 0) : null;
      const lines = this.game.players().map((p: any, i: number) => {
        if (!p || p.tm === -99) return null; // skip the neutral player
        const fac = FACTIONS[p.f]?.name || p.f;
        const kind = i === this.game.me ? 'You' : (p.ai ? 'AI' : 'Human');
        const ping = i === this.game.me && myPing != null ? ` · ${myPing}ms` : '';
        const dead = p.a === false ? ' · defeated' : '';
        return `${p.n} — ${fac} · Team ${p.tm} · ${kind}${ping}${dead}`;
      }).filter(Boolean);
      fn.setAttribute('title', 'Players:\n' + lines.join('\n'));
    }
  }
}

// ---------------- Menus ----------------
const $ = (id: string) => document.getElementById(id)!;

// red target reticle shown over the map while a missile silo is selected
const SILO_CURSOR = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='34' height='34'%3E%3Cg fill='none' stroke='%23ff4030' stroke-width='2'%3E%3Ccircle cx='17' cy='17' r='10'/%3E%3Cpath d='M17 1v9M17 24v9M1 17h9M24 17h9'/%3E%3C/g%3E%3Ccircle cx='17' cy='17' r='1.6' fill='%23ff4030'/%3E%3C/svg%3E\") 17 17, crosshair";
// green leveling icon shown while a bulldozer is terraforming (area + up/down arrows)
const TERRA_CURSOR = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cg fill='none' stroke='%234ade6a' stroke-width='2'%3E%3Crect x='5' y='13' width='22' height='14' rx='1'/%3E%3Cpath d='M16 2v8M12 6l4-4 4 4'/%3E%3C/g%3E%3C/svg%3E\") 16 20, crosshair";
// loading cursor: a crate descending into an open box (shown over your transport)
const LOAD_CURSOR = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='34' height='34'%3E%3Cg fill='none' stroke='%2340c4ff' stroke-width='2'%3E%3Cpath d='M6 20v8h22v-8'/%3E%3Crect x='12' y='10' width='10' height='10' rx='1'/%3E%3Cpath d='M17 1v6M14 4l3-3 3 3'/%3E%3C/g%3E%3C/svg%3E\") 17 17, crosshair";
// garrison cursor: a green building with a door and an arrow entering it
const GARRISON_CURSOR = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='34' height='34'%3E%3Cg fill='none' stroke='%234ade6a' stroke-width='2'%3E%3Crect x='8' y='9' width='18' height='20' rx='1'/%3E%3Crect x='14' y='18' width='6' height='11'/%3E%3Cpath d='M17 1v9M13 6l4 4 4-4'/%3E%3C/g%3E%3C/svg%3E\") 17 17, crosshair";
// oil-rig cursor: an amber derrick tower — shown when an Engineer hovers a
// claimable oil well (right-click to build an Oil Rig there)
const OIL_CURSOR = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='34' height='34'%3E%3Cg fill='none' stroke='%23ffb02e' stroke-width='2' stroke-linejoin='round'%3E%3Cpath d='M9 29 L17 5 L25 29'/%3E%3Cpath d='M12 21 H22 M14 14 H20 M6 29 H28'/%3E%3C/g%3E%3C/svg%3E\") 17 17, crosshair";
let selFaction = 'usa';
let selDiff = 1;
let selDiff2 = 2;
let selSize = 112;
let fogEnabled = true; // start-screen checkbox; spectator/replay always show all
let islandsEnabled = false; // map-type selector: 2-4 island map split by water
let urbanEnabled = false;   // map-type selector: flat urban map (roads, river, bridges, buildings)
let flatEnabled = false;    // map-type selector: completely flat city (roads + buildings only)
let steelEnabled = false;   // map-type selector: bare metallic arena, all rich ore
let metalEnabled = false;   // map-type selector: flat metallic-grey slab, no textures
let oreLevelSel = 0;        // ore/oil abundance: 0 normal, 1 sparse, 2 rich (rides seed bits 24-25)
// skirmish AI roster: add each AI as an enemy or partner with its own level +
// team. You are always team 1; team 1 = ally/partner, teams 2-4 = enemy sides.
// Max 4 players total (3 AI). Default: one Normal enemy.
let aiList: { lvl: number; team: number }[] = [{ lvl: 1, team: 2 }];
let client: GameClient | null = null;
let net: Net | null = null;
let tutCtl: TutorialController | null = null;
// player preference: hide the enemy AI's radio taunts (they eat chat space, esp. on mobile)
let hideTaunts = (() => { try { return safeLS.getItem('fe_hideTaunts') === '1'; } catch { return false; } })();
// per-match play-time tracking for the account stats (minutes + match counts).
// matchMode is 'ai' for a skirmish vs AI, 'mp' for a multiplayer match, null for
// sim/replay/tutorial (not counted). Reported once per match to /auth/playstat.
let matchStartT = 0;
let matchMode: 'ai' | 'mp' | null = null;
let matchReported = true;
function reportPlaystat() {
  if (!matchMode || matchReported) return;
  matchReported = true;
  let token: string | null = null;
  try { token = safeLS.getItem('fe_token'); } catch { /* no storage */ }
  if (!token) return;
  const minutes = (Date.now() - matchStartT) / 60000;
  fetch('/auth/playstat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, mode: matchMode, minutes }), keepalive: true, // survives tab close
  }).catch(() => { /* offline — stats are best-effort */ });
}
let endReturnsToLobby = false; // a finished multiplayer match sends players back to the lobby
let lastRoomCode = ''; // remember the current room so "back to lobby" can rejoin it after a match

// One guided step. `target` is a CSS selector to spotlight; `done` is an optional
// predicate over the live game that auto-advances when satisfied — every step
// also has a manual Next button so the learner can never get stuck.
interface TutStep {
  text: string;
  target?: string;                                  // element to highlight (spotlight)
  done?: (g: LocalGame, c: GameClient, base: number) => boolean;
  snap?: (g: LocalGame, c: GameClient) => number;   // baseline captured on entry (for "count grew")
}

// counts living combat units (anything mobile that isn't a harvester/MCV)
function ownCombatUnits(g: LocalGame): number {
  let n = 0;
  for (const e of g.sim.ents.values())
    if (!e.b && e.owner === 0 && e.hp > 0 && e.type !== 'harv' && e.type !== 'mcv') n++;
  return n;
}
function ownsBuilding(g: LocalGame, type: string): boolean {
  for (const e of g.sim.ents.values()) if (e.b && e.owner === 0 && e.type === type && e.hp > 0) return true;
  return false;
}

const TUT_STEPS: TutStep[] = [
  { text: 'Welcome, Commander! This short tutorial walks you through the basics on a calm map — your enemy stays put so you can practise, and you start with a big treasury. Click <b>Next</b> to begin.' },
  { text: 'First, the camera. Pan with <b>W A S D</b> or by pushing the mouse to the screen edges, <b>zoom</b> with the mouse wheel, and <b>rotate</b> with <b>Q</b> / <b>E</b>. Have a quick look around your base, then click Next.' },
  { text: 'Up top is your <b>Credits</b> balance — the money behind everything you build — and your <b>Power</b> meter. You already have a <b>Power Plant</b> making energy and an <b>Ore Refinery</b> whose <b>Harvester</b> is mining ore into credits. That is your economy at work.', target: '#topbar' },
  { text: 'Now you build. On the right is the <b>build menu</b>. Under <b>Structures</b>, click <b>Barracks</b>, then click a spot near your base to place it. It lets you train infantry.', target: '#sidebar', done: g => ownsBuilding(g, 'barracks') },
  { text: 'Nicely done. Build a <b>War Factory</b> the same way — it unlocks tanks and other vehicles. Bigger structures need prerequisites; yours are already met.', target: '#sidebar', done: g => ownsBuilding(g, 'factory') },
  { text: 'Scroll down to the <b>Units</b> section and click <b>Rifle Squad</b> to train one. Trained units roll out of the building that makes them.', target: '#sidebar', snap: g => ownCombatUnits(g), done: (g, _c, base) => ownCombatUnits(g) > base },
  { text: 'Select units by <b>left-clicking</b> one, or <b>drag a box</b> around several. Then <b>right-click</b> the ground to move them. Select one of your units now.', done: (_g, c) => c.selection.size >= 1 },
  { text: 'With units selected, these buttons command them: <b>Hold Position</b>, <b>Hold Fire</b>, <b>Patrol</b> and <b>Fortify</b>. To attack, right-click an enemy. Click Next when ready.', target: '#touchBar' },
  { text: 'The <b>minimap</b> shows the whole battlefield. Click it to jump the camera — your enemy base is out there waiting.', target: '#minimapWrap' },
  { text: "That's the core loop: <b>economy → production → army</b>. Build up a force and destroy the enemy base to win, or click <b>✕</b> (top-right) to leave anytime. Good luck, Commander!" },
];

class TutorialController {
  private i = -1;
  private base = 0;
  private raf = 0;
  private stopped = false;
  constructor(private client: GameClient, private game: LocalGame) {
    $('tutOverlay').classList.remove('hidden');
    $('tutNext').onclick = () => this.advance();
    $('tutSkip').onclick = () => this.stop();
    this.advance();
    const loop = () => {
      if (this.stopped) return;
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  private advance() {
    this.i++;
    if (this.i >= TUT_STEPS.length) { this.stop(); return; }
    const s = TUT_STEPS[this.i];
    this.base = s.snap ? s.snap(this.game, this.client) : 0;
    $('tutText').innerHTML = s.text;
    $('tutProgress').textContent = `Step ${this.i + 1} / ${TUT_STEPS.length}`;
    ($('tutNext') as HTMLButtonElement).textContent = this.i === TUT_STEPS.length - 1 ? 'Finish' : 'Next ▶';
  }
  private tick() {
    // the game ended (or the player left) — tear the overlay down
    if ((this.client as any).over) { this.stop(); return; }
    const s = TUT_STEPS[this.i];
    // keep the spotlight glued to its (possibly moving) target element
    const hl = $('tutHighlight');
    if (s?.target) {
      const el = document.querySelector(s.target) as HTMLElement | null;
      const r = el?.getBoundingClientRect();
      if (r && r.width) {
        const pad = 6;
        hl.style.display = 'block';
        hl.style.left = (r.left - pad) + 'px';
        hl.style.top = (r.top - pad) + 'px';
        hl.style.width = (r.width + pad * 2) + 'px';
        hl.style.height = (r.height + pad * 2) + 'px';
      } else hl.style.display = 'none';
    } else hl.style.display = 'none';
    // auto-advance once the step's goal is met
    if (s?.done && s.done(this.game, this.client, this.base)) { audio.play('confirm'); this.advance(); }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    $('tutOverlay').classList.add('hidden');
    $('tutHighlight').style.display = 'none';
    if (tutCtl === this) tutCtl = null;
  }
}

function buildOptionRow(rowId: string, opts: { label: string; v: number }[], get: () => number, set: (v: number) => void) {
  const row = $(rowId);
  row.innerHTML = '';
  for (const o of opts) {
    const b = document.createElement('div');
    b.className = 'optbtn' + (get() === o.v ? ' sel' : '');
    b.textContent = o.label;
    b.addEventListener('click', () => { set(o.v); buildOptionRow(rowId, opts, get, set); });
    row.appendChild(b);
  }
}

// team colours (team 1 = you). Players sharing a team are allies.
const TEAM_TINT = ['#3da5ff', '#ff5043', '#57d977', '#ffc940'];
const MAX_AI = 3; // 4 players total
// render the AI roster: one row per AI with a level + team picker and a remove
// button, plus the live add buttons. Team 1 = your side (partner); 2-4 = enemies.
function renderAiList() {
  const list = $('aiList');
  if (!list) return;
  const selStyle = 'background:#1a2430;color:#cfe0ee;border:1px solid #2c3e50;border-radius:4px;padding:4px;font-size:12px';
  list.innerHTML = aiList.map((ai, i) => {
    const dot = `<span style="width:10px;height:10px;border-radius:50%;flex:0 0 auto;background:${TEAM_TINT[(ai.team - 1) % 4]}"></span>`;
    const lvl = `<select data-i="${i}" class="aiLvl" style="${selStyle};flex:1">` +
      AI_DIFF_NAMES.map((n, v) => `<option value="${v}" ${v === ai.lvl ? 'selected' : ''}>${n}</option>`).join('') + '</select>';
    const team = `<select data-i="${i}" class="aiTeam" style="${selStyle};flex:1">` +
      [1, 2, 3, 4].map(t => `<option value="${t}" ${t === ai.team ? 'selected' : ''}>${t === 1 ? '🤝 Your team' : '⚔ Enemy ' + t}</option>`).join('') + '</select>';
    return `<div style="display:flex;gap:6px;align-items:center">${dot}` +
      `<span style="flex:0 0 auto;font-size:12px;color:#9fb3c8;min-width:30px">AI ${i + 1}</span>${lvl}${team}` +
      `<button type="button" data-i="${i}" class="aiDel" title="Remove" style="background:#2a1d1d;border:1px solid #5a3030;color:#ff9a8a;border-radius:4px;padding:3px 8px;cursor:pointer">✕</button></div>`;
  }).join('') || '<div style="color:#5f7384;font-size:12px">No AI — add an enemy or partner.</div>';
  list.querySelectorAll<HTMLSelectElement>('.aiLvl').forEach(s => s.addEventListener('change', () => { aiList[+s.dataset.i!].lvl = +s.value; }));
  list.querySelectorAll<HTMLSelectElement>('.aiTeam').forEach(s => s.addEventListener('change', () => { aiList[+s.dataset.i!].team = +s.value; renderAiList(); }));
  list.querySelectorAll<HTMLButtonElement>('.aiDel').forEach(b => b.addEventListener('click', () => { aiList.splice(+b.dataset.i!, 1); renderAiList(); }));
  const full = aiList.length >= MAX_AI;
  for (const id of ['btnAddEnemy', 'btnAddPartner']) {
    const b = $(id) as HTMLButtonElement;
    b.disabled = full; b.style.opacity = full ? '0.4' : '1'; b.style.cursor = full ? 'not-allowed' : 'pointer';
  }
  const enemies = aiList.filter(a => a.team !== 1).length;
  $('aiHint').textContent = full ? 'Maximum 4 players (you + 3 AI).'
    : enemies === 0 ? '⚠ Add at least one enemy AI to play.' : '';
}
function addAI(enemy: boolean) {
  if (aiList.length >= MAX_AI) return;
  let team = 1;
  if (enemy) { const used = new Set(aiList.map(a => a.team)); team = [2, 3, 4].find(t => !used.has(t)) ?? 2; }
  aiList.push({ lvl: selDiff, team });
  renderAiList();
}

function show(id: string) {
  for (const s of ['menu', 'lobby', 'endScreen', 'features']) $(s).classList.toggle('hidden', s !== id);
  if (id === 'menu') { rollCallsign(); renderAiIntel(); } // fresh name + AI study readout
}

// decode the AI's study profile into a human-readable intel panel on the menu
const KIND_NAMES: Record<string, string> = { inf: 'infantry', veh: 'vehicles', air: 'aircraft', sea: 'ships' };
function renderAiIntel() {
  const el = document.getElementById('aiIntel');
  if (!el) return;
  let p: any = null;
  try { p = JSON.parse(safeLS.getItem('ae_aiprofile') || 'null'); } catch { /* none */ }
  const totalGames = (p?.games || 0) + (p?.simGames || 0);
  if (!p || !totalGames) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows: string[] = [];
  rows.push(`<b style="color:#d3e1ee">ENEMY AI INTEL</b> — ${p.games || 0} vs you · ${p.simGames || 0} observed AI battles ` +
    `<a href="#" id="aiIntelReset" style="float:right;color:#5d7891">forget all</a>`);
  if (p.games) {
    const losses = p.games - (p.aiWins || 0);
    rows.push(`Record vs you: ${p.aiWins || 0}W–${losses}L` +
      ((p.lossStreak || 0) >= 2 ? ` · <span style="color:#ffc940">escalating after ${p.lossStreak} straight losses</span>` : ''));
  }
  const d = p.dmg || {};
  const tot = (d.inf || 0) + (d.veh || 0) + (d.air || 0) + (d.sea || 0);
  if (tot > 0) {
    const fav = Object.keys(KIND_NAMES).sort((a, b) => (d[b] || 0) - (d[a] || 0))[0];
    rows.push(`Your style on file: ${Math.round((d[fav] || 0) / tot * 100)}% of your damage comes from ${KIND_NAMES[fav]} — it stocks counters to that`);
  }
  const rushes: number[] = p.rushTimes || [];
  if (rushes.length) {
    const med = [...rushes].sort((a, b) => a - b)[rushes.length >> 1];
    rows.push(`Expects your first strike around ${med}s${med < 240 ? ' — digs in early against your rushes' : ''}`);
  }
  const eff = p.eff || {};
  const bestK = Object.keys(KIND_NAMES).sort((a, b) => (eff[b] || 0) - (eff[a] || 0))[0];
  if (eff[bestK] > 0) rows.push(`Its most profitable arm vs you: ${KIND_NAMES[bestK]} (payoff ${eff[bestK]}) — it leans into that`);
  if ((p.harvLost || 0) >= 2) rows.push(`Remembers losing harvesters to you — guards its economy harder`);
  if (p.lessons?.length) {
    rows.push(`<b style="color:#b9a5e3">Claude's lessons:</b>`);
    for (const l of p.lessons) rows.push(`· <i>${esc(String(l))}</i>`);
  }
  el.innerHTML = rows.join('<br>');
  document.getElementById('aiIntelReset')?.addEventListener('click', e => {
    e.preventDefault();
    safeLS.removeItem('ae_aiprofile');
    renderAiIntel();
  });
}

// pre-fill the name box with a new random callsign whenever the menu appears —
// but never clobber a name the player typed themselves
function rollCallsign() {
  const inp = $('nameInput') as HTMLInputElement;
  // a name the player saved on a previous visit wins over a random callsign
  let saved = ''; try { saved = (safeLS.getItem('fe_name') || '').trim(); } catch { /* no storage */ }
  if (saved) { inp.value = saved; return; }
  const cur = (inp.value || '').trim();
  if (cur && !FUNNY_NAMES.includes(cur)) return;
  let pick = FUNNY_NAMES[Math.floor(Math.random() * FUNNY_NAMES.length)];
  if (pick === cur) pick = FUNNY_NAMES[(FUNNY_NAMES.indexOf(pick) + 1) % FUNNY_NAMES.length];
  inp.value = pick;
}
function hideAll() {
  for (const s of ['menu', 'lobby', 'endScreen', 'features']) $(s).classList.add('hidden');
}

function buildFactionCards() {
  const wrap = $('factionCards');
  wrap.innerHTML = '';
  for (const f of Object.values(FACTIONS)) {
    const c = document.createElement('div');
    c.className = 'fcard' + (f.id === selFaction ? ' sel' : '');
    c.innerHTML = `<div class="flag">${twemojify(f.flag)}</div><div class="fname">${f.name}</div><div class="fperk">${f.perk}</div>`;
    c.addEventListener('click', () => { selFaction = f.id; buildFactionCards(); if (net && !client) net.send({ t: 'hello', name: playerName(), faction: selFaction }); });
    wrap.appendChild(c);
  }
}

// ---------------- Claude strategist (optional) ----------------
// With an Anthropic API key, Claude periodically reads a battlefield report
// and issues a high-level stance to the enemy AI (rush/defend/expand/air/tech).
// The scripted AI remains the tactical layer; without a key nothing changes.
class ClaudeAdvisor {
  private t1: any = null;
  private t2: any = null;
  private fails = 0;
  private announced = false;
  // key may be '' — then the game server's /advisor proxy is used (the server
  // holds its own key; testers need no key of their own)
  constructor(private game: LocalGame, private key: string, private onTaunt: (s: string) => void) {}
  start() {
    this.t1 = setTimeout(() => this.consult(), 25000);      // first read ~25s in
    this.t2 = setInterval(() => this.consult(), 50000);     // then every 50s
  }
  stop() { clearTimeout(this.t1); clearInterval(this.t2); }
  private summary(): string {
    const sim = this.game.sim;
    const side = (p: number) => {
      const b: Record<string, number> = {}, u: Record<string, number> = {};
      for (const e of sim.ents.values()) {
        if (e.owner !== p) continue;
        const m = e.b ? b : u;
        m[e.type] = (m[e.type] || 0) + 1;
      }
      return { buildings: b, units: u, credits: Math.round(sim.players[p].credits) };
    };
    let lessons = '';
    try {
      const p = JSON.parse(safeLS.getItem('ae_aiprofile') || 'null');
      if (p?.lessons?.length) lessons = '\nLessons you learned from previous matches (apply them): ' + p.lessons.join(' | ');
    } catch { /* none */ }
    return JSON.stringify({
      minute: Math.round(sim.tickN / 600),
      you: side(1),                 // the AI Claude commands
      enemy: side(0),               // the human
      island: sim.aiMem[1]?.landOk === false,
      currentStance: sim.aiDirective?.stance || 'none',
    }) + lessons;
  }
  private async consult() {
    if (this.game.sim.done) { this.stop(); return; }
    try {
      let stance = '', taunt = '';
      if (this.key) {
        // personal key: call the Anthropic API directly from the browser
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.key,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            system: 'You command an army in a C&C-style RTS. You receive a JSON battlefield report '
              + '(your side, the enemy, game minute). Pick ONE stance for the next minute: '
              + '"rush" (mass attack now), "defend" (fortify), "expand" (economy), "air" (build air power), '
              + '"tech" (research superweapons). Counter what the enemy is doing. '
              + 'Reply ONLY with JSON: {"stance":"...","taunt":"one short in-character radio line to your enemy"}',
            messages: [{ role: 'user', content: this.summary() }],
          }),
        });
        if (!res.ok) { this.fail(); return; }
        const j = await res.json();
        const text = j.content?.[0]?.text || '';
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) return;
        const d = JSON.parse(m[0]);
        stance = String(d.stance || '').toLowerCase(); taunt = String(d.taunt || '');
      } else {
        // no personal key: the game server's proxy holds one (deployed box)
        const res = await fetch('/advisor', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ summary: this.summary() }),
        });
        if (!res.ok) { if (res.status !== 429) this.fail(); return; }
        const d = await res.json();
        stance = String(d.stance || '').toLowerCase(); taunt = String(d.taunt || '');
      }
      this.fails = 0;
      if (['rush', 'defend', 'expand', 'air', 'tech'].includes(stance)) {
        if (!this.announced) { this.announced = true; this.onTaunt('Claude has assumed command of this army.'); }
        this.game.sim.aiDirective = { stance };
        if (taunt) this.onTaunt(taunt.slice(0, 140));
      }
    } catch { this.fail(); }
  }
  private fail() {
    if (++this.fails >= 2) this.stop(); // no key anywhere / offline — stay scripted
  }
}
let advisor: ClaudeAdvisor | null = null;
// back-to-back AI-vs-AI simulation runs (count chosen by the user at start)
let simQueue: { left: number; total: number; speed: number } | null = null;
function updateSpeedInd(speed: number) {
  const el = document.getElementById('speedInd');
  if (el) {
    el.textContent = speed === 0 ? '⏸ PAUSED' : speed + '× SPEED';
    el.classList.toggle('hidden', speed === 1);
  }
}

// ---- post-game battle report: production/kill/loss table + time-series chart ----
function renderEndStats(game: GameLike) {
  const box = document.getElementById('endStats')!;
  // skirmish/replay carry a local sim; a multiplayer NetGame gets its final
  // stats bundle from the server instead
  const sim: any = (game as any).sim || (game as any).endData;
  if (!sim || !sim.stats || !sim.stats.series || !sim.players) { box.classList.add('hidden'); return; }
  const players: any[] = sim.players;
  const s = sim.stats;
  const colorOf = (i: number) => '#' + PLAYER_COLORS[i % PLAYER_COLORS.length].toString(16).padStart(6, '0');
  const nameOf = (i: number) => (players[i]?.name || ('Player ' + (i + 1))) + (players[i]?.fac?.flag ? ' ' + twemojify(players[i].fac.flag) : '');

  // ---- table: built / killed / lost per faction ----
  const cols = ['Faction', 'Units Built', 'Bldgs Built', 'Units Killed', 'Bldgs Killed', 'Units Lost', 'Bldgs Lost'];
  let html = '<tr>' + cols.map((c, i) => `<th${i === 0 ? " style='text-align:left'" : ''}>${c}</th>`).join('') + '</tr>';
  players.forEach((_p, i) => {
    const cells = [s.builtU[i] || 0, s.builtB[i] || 0, s.destU[i] || 0, s.destB[i] || 0, s.lostU[i] || 0, s.lostB[i] || 0];
    html += `<tr><td class="name"><span class="dot" style="background:${colorOf(i)}"></span>${nameOf(i)}</td>` +
      cells.map(v => `<td>${v}</td>`).join('') + '</tr>';
  });
  (document.getElementById('statsTable') as HTMLElement).innerHTML = html;

  // ---- interactive chart: units / buildings / credits over time ----
  const metrics = [{ key: 'u', label: 'Units' }, { key: 'b', label: 'Buildings' }, { key: 'c', label: 'Credits' }];
  let metric = 'u';
  const ctrls = document.getElementById('chartControls')!;
  ctrls.innerHTML = metrics.map(m => `<button class="chartBtn${m.key === metric ? ' sel' : ''}" data-k="${m.key}">${m.label}</button>`).join('');
  const canvas = document.getElementById('statsChart') as HTMLCanvasElement;
  const hint = document.getElementById('chartHint')!;
  const series = s.series as { t: number; u: number[]; b: number[]; c: number[] }[];
  let hoverX = -1;

  const draw = () => {
    const ctx = canvas.getContext('2d')!;
    const W2 = canvas.width, H2 = canvas.height;
    ctx.clearRect(0, 0, W2, H2);
    const padL = 50, padR = 14, padT = 14, padB = 26;
    const plotW = W2 - padL - padR, plotH = H2 - padT - padB;
    if (!series.length) { hint.textContent = 'No time-series data recorded.'; return; }
    const vals = (smp: any) => smp[metric] as number[];
    let maxV = 1; const maxT = series[series.length - 1].t || 1;
    for (const smp of series) for (const v of vals(smp)) if (v > maxV) maxV = v;
    maxV = Math.ceil(maxV * 1.1);
    const xOf = (t: number) => padL + (t / maxT) * plotW;
    const yOf = (v: number) => padT + plotH - (v / maxV) * plotH;
    ctx.strokeStyle = '#1d2730'; ctx.lineWidth = 1; ctx.fillStyle = '#5f7480'; ctx.font = '11px system-ui';
    for (let g = 0; g <= 4; g++) {
      const yy = padT + (plotH * g) / 4;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W2 - padR, yy); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText(String(Math.round(maxV * (1 - g / 4))), padL - 6, yy + 4);
    }
    ctx.textAlign = 'center';
    for (let g = 0; g <= 4; g++) ctx.fillText(Math.round((maxT * g) / 4 / 60) + 'm', padL + (plotW * g) / 4, H2 - 8);
    players.forEach((_p, i) => {
      ctx.strokeStyle = colorOf(i); ctx.lineWidth = 2; ctx.beginPath();
      series.forEach((smp, idx) => { const x = xOf(smp.t), y = yOf(vals(smp)[i] || 0); idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
      ctx.stroke();
    });
    if (hoverX >= 0) {
      const t = ((hoverX - padL) / plotW) * maxT;
      let bi = 0, bd = 1e9;
      series.forEach((smp, idx) => { const d = Math.abs(smp.t - t); if (d < bd) { bd = d; bi = idx; } });
      const smp = series[bi], hx = xOf(smp.t);
      ctx.strokeStyle = '#3a4a56'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + plotH); ctx.stroke();
      players.forEach((_p, i) => { const y = yOf(vals(smp)[i] || 0); ctx.fillStyle = colorOf(i); ctx.beginPath(); ctx.arc(hx, y, 3, 0, 7); ctx.fill(); });
      const mm = Math.floor(smp.t / 60), ss = Math.round(smp.t % 60).toString().padStart(2, '0');
      hint.innerHTML = `${mm}:${ss} — ` + players.map((_p, i) => `<span style="color:${colorOf(i)}">${vals(smp)[i] || 0}</span>`).join(' · ');
    } else hint.textContent = 'Hover the chart to read values over time.';
  };

  ctrls.querySelectorAll('.chartBtn').forEach(btn => btn.addEventListener('click', () => {
    metric = (btn as HTMLElement).getAttribute('data-k')!;
    ctrls.querySelectorAll('.chartBtn').forEach(b => b.classList.toggle('sel', b === btn));
    draw();
  }));
  canvas.onmousemove = (e: MouseEvent) => { const r = canvas.getBoundingClientRect(); hoverX = (e.clientX - r.left) * (canvas.width / r.width); draw(); };
  canvas.onmouseleave = () => { hoverX = -1; draw(); };
  box.classList.remove('hidden');
  draw();
}

// --- Back-button / accidental-exit guard ---------------------------------
// A mouse "back" button (or Backspace/swipe) navigates the browser back, which
// unloads the page and dumps the player out of a live match. While a game is
// running we (1) trap history Back via a pushed dummy state — pressing Back fires
// popstate instead of leaving, and we re-anchor + surface the in-game exit menu —
// and (2) arm beforeunload so reload / tab-close / a real unload still asks first.
// Both are active ONLY during a match, so the menu never nags.
let exitGuardActive = false;
function beforeUnloadGuard(e: BeforeUnloadEvent) {
  if (!exitGuardActive) return;
  reportPlaystat(); // flush play time before the tab unloads (keepalive request)
  // Browsers show their own generic wording (custom text is ignored), but a
  // non-empty returnValue + preventDefault is the most compatible way to make the
  // "Leave site?" prompt appear across Chrome and Firefox.
  e.preventDefault();
  e.returnValue = 'You are in a match — leave the game?';
  return e.returnValue;
}
function popstateGuard() {
  if (!exitGuardActive) return;
  // Back was pressed (e.g. the mouse back button). Stay on the page by re-pushing
  // our anchor, then show the friendly exit menu instead of silently leaving.
  history.pushState({ feGame: true }, '', location.href);
  const em = document.getElementById('exitMenu');
  if (em && client) em.classList.remove('hidden');
}
function enableExitGuard() {
  if (exitGuardActive) return;
  exitGuardActive = true;
  try { history.pushState({ feGame: true }, '', location.href); } catch { /* history blocked */ }
  window.addEventListener('beforeunload', beforeUnloadGuard);
  window.addEventListener('popstate', popstateGuard);
}
function disableExitGuard() {
  if (!exitGuardActive) return;
  exitGuardActive = false;
  window.removeEventListener('beforeunload', beforeUnloadGuard);
  window.removeEventListener('popstate', popstateGuard);
}

function startGame(game: GameLike) {
  // first game: preload all models behind the loading screen, then start (the
  // menu loads instantly; models are fetched only once a game is actually starting)
  if (!modelsReady) { startWithModels(() => startGame(game)); return; }
  reportPlaystat(); // flush any prior match's play time before starting a new one
  // count real matches only: skirmish vs AI ('ai') or multiplayer ('mp'); skip
  // AI-vs-AI spectate, replays and the tutorial
  matchMode = (game as any).isNet ? 'mp'
    : (game instanceof LocalGame && !(game as any).isSim && !(game as any).isReplay && !game.tutorial) ? 'ai' : null;
  matchStartT = Date.now();
  matchReported = !matchMode;
  if (client) { client.destroy(); client = null; }
  if (advisor) { advisor.stop(); advisor = null; }
  if (tutCtl) { tutCtl.stop(); tutCtl = null; }
  hideAll();
  audio.init();
  client = new GameClient(game, (won, winnerName) => {
    reportPlaystat();    // match decided — log play time + match count to the account
    disableExitGuard();  // match decided — the end screen / Back should work normally
    const isSim = (game as any).isSim;
    audio.play(won || isSim ? 'win' : 'lose');
    renderEndStats(game); // battle report table + chart (skirmish/sim/replay)
    endReturnsToLobby = false; $('btnAgain').textContent = 'BACK TO MENU'; // default; net path overrides
    if ((game as any).isReplay) {
      $('endTitle').textContent = 'REPLAY OVER';
      ($('endTitle') as HTMLElement).style.color = '#ffc940';
      $('endSub').textContent = `${winnerName || 'Nobody'} won this match. Asking Claude for a critical review…`;
      show('endScreen');
      // critical review: match report + everything the server AI already knows
      fetch('/advisor', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'analyze', summary: JSON.stringify((game as any).meta || {}) }),
      }).then(r => r.ok ? r.json() : null).then(j => {
        if (j?.critique) $('endSub').textContent = `${winnerName || 'Nobody'} won. Claude's review: ${j.critique}` +
          (j.lesson ? ` → Doctrine for next time: ${j.lesson}` : '');
        else $('endSub').textContent = `${winnerName || 'Nobody'} won this match.`;
      }).catch(() => { $('endSub').textContent = `${winnerName || 'Nobody'} won this match.`; });
      return;
    }
    if (isSim) {
      $('endTitle').textContent = 'SIMULATION OVER';
      ($('endTitle') as HTMLElement).style.color = '#ffc940';
      let sub = `${winnerName} wins.`;
      try {
        const prof = JSON.parse(safeLS.getItem('ae_aiprofile') || 'null');
        const n = (prof?.games || 0) + (prof?.simGames || 0);
        if (n) sub += ` Match studied — ${n} game${n > 1 ? 's' : ''} in the AI's memory.`;
      } catch { /* no profile */ }
      // queued simulation runs: auto-start the next match
      if (simQueue && simQueue.left > 1) {
        simQueue.left--;
        sub += ` Next match starting… (${simQueue.total - simQueue.left + 1}/${simQueue.total})`;
        setTimeout(() => {
          if (!simQueue) return; // user exited to menu meanwhile
          const g2 = new LocalGame('', '', selDiff, selSize, selDiff2);
          g2.speed = simQueue.speed;
          startGame(g2);
          updateSpeedInd(g2.speed);
        }, 3000);
      } else simQueue = null;
      $('endSub').textContent = sub;
      show('endScreen');
      return;
    }
    $('endTitle').textContent = won ? 'VICTORY' : 'DEFEAT';
    ($('endTitle') as HTMLElement).style.color = won ? '#57d977' : '#ff5043';
    let sub = won ? 'All enemy structures destroyed.' : `${winnerName} controls the region.`;
    // a multiplayer match (started from the lobby) returns everyone to the lobby
    endReturnsToLobby = !!(game as any).isNet;
    $('btnAgain').textContent = endReturnsToLobby ? 'BACK TO LOBBY' : 'BACK TO MENU';
    if (!endReturnsToLobby) {
      try {
        const prof = JSON.parse(safeLS.getItem('ae_aiprofile') || 'null');
        if (prof?.games) sub += ` The AI studied this match — ${prof.games} game${prof.games > 1 ? 's' : ''} learned.`;
      } catch { /* no profile */ }
    }
    $('endSub').textContent = sub;
    show('endScreen');
  });
  // Claude strategist: local skirmish only (a shared directive would steer
  // BOTH sides of a simulation, and the tutorial wants a quiet enemy). Personal
  // key if entered, else the proxy.
  if (game instanceof LocalGame && !game.isSim && !game.tutorial) {
    const key = (safeLS.getItem('ae_claude_key') || '').trim();
    advisor = new ClaudeAdvisor(game, key, taunt => client?.aiSays(taunt));
    advisor.start();
  }
  // guided first game: overlay the step-by-step coach on top of the HUD
  if (game instanceof LocalGame && game.tutorial && client) tutCtl = new TutorialController(client, game);
  // arm the Back-button / accidental-exit guard for the duration of the match
  enableExitGuard();
}

// a fresh ridiculous callsign every game when no name is entered
const FUNNY_NAMES = [
  'General Confusion', 'Major Disaster', 'Colonel Popcorn', 'Captain Chaos',
  'Sergeant Snacks', 'Commander Cuddles', 'Admiral Awkward', 'Baron von Boom',
  'Major Mayhem', 'Private Pancake', 'Colonel Panic', 'General Error',
  'Captain Kaboom', 'Atomic Hamster', 'Tiny Napoleon', 'Marshal Mallow',
  'The Ore Baron', 'Warlord Waffles', 'Duke of Dirt', 'Sir Kaboomski',
  'Major Glitch', 'Corporal Crumbs', 'Doctor Boomling', 'Lady Lazerbeam',
  'General Giggles', 'Madam Mayhem', 'Captain Obvious', 'Count Cratersson',
];
function playerName(): string {
  const typed = (($('nameInput') as HTMLInputElement).value || '').trim();
  // a name the player chose (not a random funny one) is remembered for next time
  if (typed && !FUNNY_NAMES.includes(typed)) { try { safeLS.setItem('fe_name', typed.slice(0, 18)); } catch { /* no storage */ } }
  return (typed || FUNNY_NAMES[Math.floor(Math.random() * FUNNY_NAMES.length)]).slice(0, 18);
}

// rolling AI study profile: outcome streaks, the player's rush timing and
// favourite weapon classes — read by the AI at the start of the next game
// server is the PRIMARY intelligence store: every report also flows there,
// and the richer of (server, local) profile is used at game start
let serverIntel: any = null;
function syncIntelFromServer() {
  fetch('/intel').then(r => r.ok ? r.json() : null).then(j => { if (j) serverIntel = j; }).catch(() => { /* offline */ });
}
function pushIntelToServer(r: any) {
  fetch('/intel', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ report: r }),
  }).then(res => res.ok ? res.json() : null).then(j => { if (j) serverIntel = j; }).catch(() => { /* offline */ });
}
function mergedProfile(): any {
  let local: any = null;
  try { local = JSON.parse(safeLS.getItem('ae_aiprofile') || 'null'); } catch { /* none */ }
  const sv = serverIntel;
  if (!sv && !local) return null;
  if (!sv) return local;
  if (!local) return sv;
  // server primary: take the profile with more total study, union the lessons
  const weight = (p: any) => (p.games || 0) + (p.simGames || 0);
  const base = { ...(weight(sv) >= weight(local) ? sv : local) };
  const lessons = [...new Set([...(sv.lessons || []), ...(local.lessons || [])])];
  if (lessons.length) base.lessons = lessons.slice(-5);
  return base;
}

function saveAiReport(r: any) {
  pushIntelToServer(r); // fire-and-forget: the server brain learns too
  try {
    const p = JSON.parse(safeLS.getItem('ae_aiprofile') || '{}');
    if (r.simMatch) {
      // spectated AI-vs-AI match: absorb the winner's doctrine payoffs, but
      // don't touch the vs-you record (wins, rush timing, your weapon style)
      p.simGames = (p.simGames || 0) + 1;
      const eff = p.eff || {};
      for (const k of ['inf', 'veh', 'air', 'sea']) {
        const e = (r.dealt?.[k] || 0) / ((r.lost?.[k] || 0) + 1);
        eff[k] = Math.round(((eff[k] || 0) * 0.7 + e * 0.3) * 10) / 10;
      }
      p.eff = eff;
      safeLS.setItem('ae_aiprofile', JSON.stringify(p));
      return;
    }
    p.games = (p.games || 0) + 1;
    if (r.aiWon) { p.aiWins = (p.aiWins || 0) + 1; p.lossStreak = 0; }
    else p.lossStreak = (p.lossStreak || 0) + 1;
    if (r.rushSec) p.rushTimes = [...(p.rushTimes || []), r.rushSec].slice(-7);
    const d = p.dmg || { inf: 0, veh: 0, air: 0, sea: 0 };
    for (const k of ['inf', 'veh', 'air', 'sea'])
      d[k] = Math.round((d[k] || 0) * 0.7 + (r.dmg?.[k] || 0)); // recency-weighted
    p.dmg = d;
    // payoff per weapon class: damage dealt per unit lost — the AI leans into
    // what worked last time and away from what died for nothing
    const eff = p.eff || {};
    for (const k of ['inf', 'veh', 'air', 'sea']) {
      const e = (r.dealt?.[k] || 0) / ((r.lost?.[k] || 0) + 1);
      eff[k] = Math.round(((eff[k] || 0) * 0.6 + e * 0.4) * 10) / 10;
    }
    p.eff = eff;
    p.harvLost = Math.round(((p.harvLost || 0) * 0.6 + (r.harvLost || 0) * 0.4) * 10) / 10;
    safeLS.setItem('ae_aiprofile', JSON.stringify(p));
  } catch { /* storage unavailable */ }
}

// post-mortem: ask Claude for ONE tactical lesson from this match; the lessons
// journal is fed back into the strategist's prompts in future games
async function requestLesson(r: any) {
  try {
    const key = (safeLS.getItem('ae_claude_key') || '').trim();
    const report = JSON.stringify(r);
    let lesson = '';
    if (key) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-api-key': key,
          'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', max_tokens: 120,
          system: 'You are the AI commander after an RTS match. aiWon says if you won. dealt/lost show '
            + 'damage done and units lost per weapon class. Write ONE concise tactical lesson for your '
            + 'next match. Reply ONLY JSON: {"lesson":"max 25 words"}',
          messages: [{ role: 'user', content: report }],
        }),
      });
      if (!res.ok) return;
      const j = await res.json();
      const m = (j.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
      lesson = m ? String(JSON.parse(m[0]).lesson || '') : '';
    } else {
      const res = await fetch('/advisor', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ summary: report, mode: 'lesson' }),
      });
      if (!res.ok) return;
      lesson = String((await res.json()).lesson || '');
    }
    if (!lesson) return;
    const p = JSON.parse(safeLS.getItem('ae_aiprofile') || '{}');
    p.lessons = [...(p.lessons || []), lesson.slice(0, 160)].slice(-5);
    safeLS.setItem('ae_aiprofile', JSON.stringify(p));
  } catch { /* offline — no lesson this time */ }
}

// render the global lobby: who's online and which games can be joined
function renderMpLobby(m: any) {
  const users = m.users || [], games = m.games || [];
  $('mpUserCount').textContent = String(users.length);
  $('mpUsers').innerHTML = users.length
    ? users.map((u: any) => `<div style="display:flex;align-items:center;gap:6px">` +
      `<span style="flex:1;min-width:0">${twemojify(FACTIONS[u.faction]?.flag || '🏳')} ${escapeHtml(u.name)}` +
      `${u.inGame ? ' <span style="color:#5f7384">· in game</span>' : ''}</span>${pingBadge(u.ping)}</div>`).join('')
    : '<div style="color:#5f7384">No one else online yet</div>';
  const sizes: Record<number, string> = { 112: 'Medium', 136: 'Large', 160: 'Huge', 72: 'Small', 96: 'Medium', 128: 'Large' };
  const diffs = AI_DIFF_NAMES;
  $('mpGames').innerHTML = games.length
    ? games.map((g: any) => `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid #243240">` +
      `<span style="flex:1;min-width:0">${escapeHtml(g.host)}'s game · ${g.players}/${g.max} · ${sizes[g.size] || g.size} · ${diffs[g.diff] || ''}</span>` +
      `<button class="mbtn" data-join="${g.code}" style="padding:4px 10px;font-size:12px;width:auto">JOIN</button></div>`).join('')
    : '<div style="color:#5f7384">No open games — create one!</div>';
  $('mpGames').querySelectorAll('[data-join]').forEach(b =>
    b.addEventListener('click', () => {
      $('mpErr').textContent = '';
      net?.send({ t: 'join', code: (b as HTMLElement).getAttribute('data-join'), name: playerName(), faction: selFaction });
    }));
  renderLobbyChat(m.chat);
}
function escapeHtml(s: string) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// ---- global lobby chat ----
function lobbyChatLine(m: any): string {
  if (m.sys) return `<div style="color:#ffc940">${escapeHtml(m.msg)}</div>`;
  return `<div><span style="color:var(--accent);font-weight:600">${escapeHtml(m.name)}:</span> ${escapeHtml(m.msg)}</div>`;
}
// the lobby chat appears on BOTH the global lobby and the room/waiting screen —
// render to every .lobbyChatLog so players can chat while waiting to start too.
// This re-renders on every lobby broadcast (~3s), so DON'T yank the view to the
// bottom each time — only auto-scroll when a NEW message actually arrived, or
// when the reader was already pinned to the bottom. Otherwise leave their scroll
// position alone so they can read back through the history.
let lastLobbyChatLen = 0;
function renderLobbyChat(chat: any[]) {
  const arr = (chat || []) as any[];
  const grew = arr.length > lastLobbyChatLen;
  lastLobbyChatLen = arr.length;
  const html = arr.length
    ? arr.slice(-30).map(lobbyChatLine).join('')
    : '<div style="color:#5f7384">No messages yet — say hello!</div>';
  document.querySelectorAll('.lobbyChatLog').forEach(log => {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    const prevTop = log.scrollTop;
    log.innerHTML = html;
    if (grew || atBottom) log.scrollTop = log.scrollHeight;
    else log.scrollTop = prevTop;
  });
}
function appendLobbyChat(m: any) {
  document.querySelectorAll('.lobbyChatLog').forEach(log => {
    if (!log.querySelector('span,div[style*="ffc940"]')) log.innerHTML = ''; // clear the placeholder
    log.insertAdjacentHTML('beforeend', lobbyChatLine(m));
    while (log.children.length > 60) log.removeChild(log.firstChild!);
    log.scrollTop = log.scrollHeight;
  });
  // alert the player to a new lobby message they'd otherwise miss: only when the
  // tab is backgrounded or unfocused, and only if they haven't muted the alert
  if (!notifyMuted() && (document.hidden || !document.hasFocus())) audio.play('notify');
}
// per-browser preference: sound alert for new lobby messages while the tab is in
// the background. Persisted so it sticks across sessions; toggled from the lobby.
function notifyMuted(): boolean { return safeLS.getItem('feNotifyMuted') === '1'; }
function syncNotifyToggles() {
  const muted = notifyMuted();
  document.querySelectorAll('.lobbyNotifyToggle').forEach(b => {
    (b as HTMLElement).textContent = muted ? '🔕 Alert: off' : '🔔 Alert: on';
  });
}
function wireNotifyToggles() {
  document.querySelectorAll('.lobbyNotifyToggle').forEach(b => b.addEventListener('click', () => {
    safeLS.setItem('feNotifyMuted', notifyMuted() ? '0' : '1');
    syncNotifyToggles();
    if (!notifyMuted()) audio.play('notify'); // preview the sound when turning it back on
  }));
  syncNotifyToggles();
}
// small coloured ping pill (green/amber/red) — blank until a round-trip lands
function pingBadge(ping: number | null | undefined): string {
  if (ping == null) return '';
  const col = ping > 200 ? '#ff6b5e' : ping > 120 ? '#ffc940' : '#7be08a';
  return `<span style="color:${col};font-size:11px;font-variant-numeric:tabular-nums">${ping}ms</span>`;
}

// ---- multiplayer lobby (waiting room): player list with host team pickers, plus
// host-only game setup (map size/type, fog, AI fill). Edits go to the server via
// roomcfg; the server echoes the authoritative room state back to everyone. ----
let lobbyIsHost = false;
let lastRoomSig = '';
const lobbyCfg: { size: number; mapType: string; fog: boolean; oreLevel: number; ai: { lvl: number; team: number }[]; teams: number[] } =
  { size: 96, mapType: 'continent', fog: true, oreLevel: 0, ai: [], teams: [] };
const LOBBY_SIZES: [number, string][] = [[96, 'Medium'], [128, 'Large'], [160, 'Huge'], [192, 'Giant']];
const ORE_LEVELS: [number, string][] = [[0, 'Normal'], [2, 'Rich'], [1, 'Sparse']];
const LOBBY_MAPS: [string, string][] = [['continent', 'Continent'], ['islands', 'Islands'], ['urban', 'Urban'], ['flat', 'Flat City'], ['steel', 'Steel Arena'], ['metal', 'Metal Plain']];
// single source of truth for AI difficulty labels (index = aiLvl). Bomber Baron is lvl 4.
// every difficulty dropdown / label reads this so adding a level can't desync the menus.
const AI_DIFF_NAMES = ['Easy', 'Normal', 'Hard', 'Brutal', 'Bomber Baron'];
function sendRoomCfg() {
  if (net && lobbyIsHost) net.send({ t: 'roomcfg', size: lobbyCfg.size, mapType: lobbyCfg.mapType, fog: lobbyCfg.fog, oreLevel: lobbyCfg.oreLevel, ai: lobbyCfg.ai, teams: lobbyCfg.teams });
}
function renderRoom(m: any) {
  // skip ping-only refreshes (the server rebroadcasts every ~3s) so an open
  // dropdown the host is using isn't reset out from under them
  const sig = JSON.stringify([m.code, m.you, m.size, m.mapType, m.fog, m.ai, m.players.map((p: any) => [p.name, p.faction, p.team])]);
  if (sig === lastRoomSig) return;
  lastRoomSig = sig;
  $('roomCode').textContent = m.code;
  lobbyIsHost = m.you === 0;
  lobbyCfg.size = m.size || 96; lobbyCfg.mapType = m.mapType || 'continent'; lobbyCfg.fog = m.fog !== false; lobbyCfg.oreLevel = (m.oreLevel | 0) & 3;
  lobbyCfg.ai = (m.ai || []).map((a: any) => ({ lvl: a.lvl | 0, team: a.team | 0 }));
  lobbyCfg.teams = m.players.map((p: any, i: number) => p.team ?? (i + 1));
  const selStyle = 'background:#1a2430;color:#cfe0ee;border:1px solid #2c3e50;border-radius:4px;padding:3px;font-size:11px';
  const list = $('lobbyPlayers'); list.innerHTML = '';
  m.players.forEach((p: any, i: number) => {
    const team = p.team ?? (i + 1);
    const teamCtl = lobbyIsHost
      ? `<select class="lpTeam" data-i="${i}" style="${selStyle}">${[1, 2, 3, 4].map(t => `<option value="${t}" ${t === team ? 'selected' : ''}>Team ${t}</option>`).join('')}</select>`
      : `<span style="font-size:11px;color:${TEAM_TINT[(team - 1) % 4]}">Team ${team}</span>`;
    const row = document.createElement('div'); row.className = 'lpRow';
    row.innerHTML = `<div class="lpDot" style="background:${TEAM_TINT[(team - 1) % 4]}"></div>` +
      `<span style="flex:1">${twemojify(FACTIONS[p.faction]?.flag || '')} ${escapeHtml(p.name)}</span>` +
      `${pingBadge(p.ping)} ${teamCtl}` +
      `<span style="color:#78909c;font-size:12px;margin-left:6px">${i === 0 ? 'HOST' : ''}</span>`;
    list.appendChild(row);
  });
  if (lobbyIsHost) list.querySelectorAll<HTMLSelectElement>('.lpTeam').forEach(s =>
    s.addEventListener('change', () => { lobbyCfg.teams[+s.dataset.i!] = +s.value; sendRoomCfg(); }));
  $('btnStart').classList.toggle('hidden', !lobbyIsHost);
  renderLobbyCfg();
}
function renderLobbyCfg() {
  const cfg = $('lobbyCfg'); if (!cfg) return;
  const sel = 'background:#1a2430;color:#cfe0ee;border:1px solid #2c3e50;border-radius:4px;padding:5px;font-size:12px';
  if (!lobbyIsHost) {
    const mapL = (LOBBY_MAPS.find(x => x[0] === lobbyCfg.mapType) || ['', lobbyCfg.mapType])[1];
    const sizeL = (LOBBY_SIZES.find(x => x[0] === lobbyCfg.size) || [0, String(lobbyCfg.size)])[1];
    const oreL = (ORE_LEVELS.find(x => x[0] === lobbyCfg.oreLevel) || [0, 'Normal'])[1];
    cfg.innerHTML = `<div style="font-size:12px;color:#9fb3c8;background:rgba(20,28,38,0.7);border:1px solid #2c3a44;border-radius:6px;padding:8px 10px">Map: <b>${mapL}</b> · ${sizeL} · ${oreL} ore · Fog ${lobbyCfg.fog ? 'on' : 'off'} · ${lobbyCfg.ai.length} AI — <span style="color:#5f7384">set by host</span></div>`;
    return;
  }
  cfg.innerHTML =
    `<div style="font-size:11px;color:#9fb3c8;letter-spacing:0.06em;margin-bottom:4px">GAME SETUP</div>` +
    `<div class="optrow"><span class="optlabel">Map Size</span><select id="lcSize" style="${sel};flex:1">${LOBBY_SIZES.map(([v, l]) => `<option value="${v}" ${v === lobbyCfg.size ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` +
    `<div class="optrow"><span class="optlabel">Map Type</span><select id="lcMap" style="${sel};flex:1">${LOBBY_MAPS.map(([v, l]) => `<option value="${v}" ${v === lobbyCfg.mapType ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` +
    `<div class="optrow"><span class="optlabel">Ore / Oil</span><select id="lcOre" style="${sel};flex:1">${ORE_LEVELS.map(([v, l]) => `<option value="${v}" ${v === lobbyCfg.oreLevel ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` +
    `<label class="optrow" style="cursor:pointer"><span class="optlabel">Fog of War</span><span style="flex:1;display:flex;align-items:center;gap:8px;color:#9fb3c8;font-size:13px"><input type="checkbox" id="lcFog" ${lobbyCfg.fog ? 'checked' : ''} style="width:16px;height:16px;accent-color:#ffc940">Hide unexplored</span></label>` +
    `<div class="optrow" style="align-items:flex-start"><span class="optlabel">AI Players</span><div style="flex:1"><div id="lcAi"></div>` +
    `<div style="display:flex;gap:8px;margin-top:6px"><button type="button" class="mbtn" id="lcAddEnemy" style="flex:1;font-size:12px;padding:6px 4px">⚔ Add Enemy AI</button><button type="button" class="mbtn" id="lcAddPartner" style="flex:1;font-size:12px;padding:6px 4px">🤝 Add Partner AI</button></div></div></div>`;
  ($('lcSize') as HTMLSelectElement).onchange = e => { lobbyCfg.size = +(e.target as HTMLSelectElement).value; sendRoomCfg(); };
  ($('lcMap') as HTMLSelectElement).onchange = e => { lobbyCfg.mapType = (e.target as HTMLSelectElement).value; sendRoomCfg(); };
  ($('lcOre') as HTMLSelectElement).onchange = e => { lobbyCfg.oreLevel = (+(e.target as HTMLSelectElement).value | 0) & 3; sendRoomCfg(); };
  ($('lcFog') as HTMLInputElement).onchange = e => { lobbyCfg.fog = (e.target as HTMLInputElement).checked; sendRoomCfg(); };
  ($('lcAddEnemy') as HTMLButtonElement).onclick = () => { if (lobbyCfg.ai.length < 3) { const used = new Set([...lobbyCfg.teams, ...lobbyCfg.ai.map(a => a.team)]); const t = [2, 3, 4, 5, 6].find(x => !used.has(x)) ?? 2; lobbyCfg.ai.push({ lvl: 1, team: t }); sendRoomCfg(); } };
  ($('lcAddPartner') as HTMLButtonElement).onclick = () => { if (lobbyCfg.ai.length < 3) { lobbyCfg.ai.push({ lvl: 1, team: lobbyCfg.teams[0] || 1 }); sendRoomCfg(); } };
  renderLcAi();
}
function renderLcAi() {
  const el = $('lcAi'); if (!el) return;
  const sel = 'background:#1a2430;color:#cfe0ee;border:1px solid #2c3e50;border-radius:4px;padding:4px;font-size:12px';
  el.innerHTML = lobbyCfg.ai.map((a, i) => {
    const dot = `<span style="width:10px;height:10px;border-radius:50%;flex:0 0 auto;background:${TEAM_TINT[(a.team - 1) % 4]}"></span>`;
    const lvl = `<select data-i="${i}" class="lcLvl" style="${sel};flex:1">${AI_DIFF_NAMES.map((n, v) => `<option value="${v}" ${v === a.lvl ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    const team = `<select data-i="${i}" class="lcTeam" style="${sel};flex:1">${[1, 2, 3, 4, 5, 6].map(t => `<option value="${t}" ${t === a.team ? 'selected' : ''}>Team ${t}</option>`).join('')}</select>`;
    return `<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">${dot}<span style="flex:0 0 auto;font-size:12px;color:#9fb3c8;min-width:30px">AI ${i + 1}</span>${lvl}${team}<button type="button" data-i="${i}" class="lcDel" title="Remove" style="background:#2a1d1d;border:1px solid #5a3030;color:#ff9a8a;border-radius:4px;padding:3px 8px;cursor:pointer">✕</button></div>`;
  }).join('') || '<div style="color:#5f7384;font-size:12px">No AI — one enemy is added if you start solo.</div>';
  el.querySelectorAll<HTMLSelectElement>('.lcLvl').forEach(s => s.onchange = () => { lobbyCfg.ai[+s.dataset.i!].lvl = +s.value; sendRoomCfg(); });
  el.querySelectorAll<HTMLSelectElement>('.lcTeam').forEach(s => s.onchange = () => { lobbyCfg.ai[+s.dataset.i!].team = +s.value; sendRoomCfg(); });
  el.querySelectorAll<HTMLButtonElement>('.lcDel').forEach(b => b.onclick = () => { lobbyCfg.ai.splice(+b.dataset.i!, 1); sendRoomCfg(); });
}

async function connectNet(): Promise<Net> {
  const n = new Net();
  await n.connect();
  n.on('room', (m: any) => { if (m.code) lastRoomCode = m.code; renderRoom(m); show('lobby'); });
  n.on('start', (m: any) => {
    setMapSize(m.size || 96);
    if (typeof m.fog === 'boolean') fogEnabled = m.fog; // host's lobby fog choice applies to all
    // lockstep rooms run a local deterministic sim driven by relayed inputs;
    // snapshot rooms render server-authoritative snapshots
    const g = m.lockstep ? new NetLockstepGame(n, m) : new NetGame(n, m.seed, m.players.length, m.you, m.players, m.iceServers);
    startGame(g);
  });
  n.on('lobby', (m: any) => renderMpLobby(m));
  n.on('lobbymsg', (m: any) => appendLobbyChat(m));
  n.on('err', (m: any) => { $('mpErr').textContent = m.msg || 'Server error'; });
  n.on('_close', () => {
    net = null;
    if (!client) {
      // back on the menu: just reflect "offline" inline; Skirmish still works
      const st = document.getElementById('mpConnState');
      if (st) { st.textContent = 'offline — tap CREATE/JOIN to retry'; st.style.color = '#ff6b5e'; }
    }
  });
  return n;
}

// connect to the shared lobby and register presence; reflect status inline on the
// main page. Safe to call repeatedly (no-op if already connected).
async function goOnline(): Promise<boolean> {
  const st = document.getElementById('mpConnState');
  try {
    if (!net) net = await connectNet();
    net.send({ t: 'hello', name: playerName(), faction: selFaction });
    if (st) { st.textContent = '● online'; st.style.color = '#7be08a'; }
    return true;
  } catch {
    net = null;
    if (st) { st.textContent = 'offline — server unreachable'; st.style.color = '#ff6b5e'; }
    const u = document.getElementById('mpUsers'), g = document.getElementById('mpGames');
    if (u) u.innerHTML = '<div style="color:#5f7384">Server offline — Skirmish still works.</div>';
    if (g) g.innerHTML = '<div style="color:#5f7384">—</div>';
    return false;
  }
}

// remember the start-screen selections between games (faction, size, map type,
// ore level, fog, AI roster) so the player doesn't reselect every time
function saveMenuPrefs() {
  try {
    safeLS.setItem('fe_menu', JSON.stringify({
      faction: selFaction, size: selSize,
      mapType: ($('mapType') as HTMLSelectElement)?.value || 'continent',
      ore: oreLevelSel, fog: fogEnabled, ai: aiList,
    }));
  } catch { /* no storage */ }
}
function loadMenuPrefs() {
  let p: any = null;
  try { p = JSON.parse(safeLS.getItem('fe_menu') || 'null'); } catch { /* none */ }
  if (!p) return;
  if (typeof p.faction === 'string') selFaction = p.faction;
  if (typeof p.size === 'number') selSize = p.size;
  if (typeof p.ore === 'number') oreLevelSel = p.ore & 3;
  if (typeof p.fog === 'boolean') fogEnabled = p.fog;
  if (Array.isArray(p.ai) && p.ai.length)
    aiList = p.ai.filter((a: any) => typeof a?.lvl === 'number' && typeof a?.team === 'number').map((a: any) => ({ lvl: a.lvl, team: a.team }));
  const mt = $('mapType') as HTMLSelectElement | null;
  if (mt && typeof p.mapType === 'string' && [...mt.options].some(o => o.value === p.mapType)) mt.value = p.mapType;
  const oa = $('oreAmt') as HTMLSelectElement | null; if (oa) oa.value = String(oreLevelSel);
  const fc = $('fogChk') as HTMLInputElement | null; if (fc) fc.checked = fogEnabled;
}

function initMenus() {
  loadMenuPrefs();   // restore the player's last start-screen choices
  buildFactionCards();
  // audio must be unlocked by a user gesture; init is idempotent
  document.addEventListener('pointerdown', () => audio.init());
  const muteBtn = $('muteBtn');
  const muteIcon = () => { muteBtn.textContent = audio.muted ? '\u{1F507}' : '\u{1F50A}'; };
  muteIcon();
  muteBtn.addEventListener('click', () => { audio.init(); audio.setMuted(!audio.muted); muteIcon(); syncVol(); });
  // 🤖 enemy-AI-taunt toggle: hide the AI radio lines to reclaim chat space (esp. mobile)
  const tauntBtn = $('tauntBtn');
  const tauntIcon = () => { tauntBtn.classList.toggle('off', hideTaunts); tauntBtn.title = hideTaunts ? 'Enemy AI taunts hidden — click to show' : 'Enemy AI taunts shown — click to hide'; };
  tauntIcon();
  tauntBtn.addEventListener('click', () => { hideTaunts = !hideTaunts; try { safeLS.setItem('fe_hideTaunts', hideTaunts ? '1' : '0'); } catch { /* no storage */ } tauntIcon(); client?.redrawChat(); });
  // in-game master volume slider (top bar) — drives the overall volume live
  const volSlider = $('volSlider') as HTMLInputElement | null;
  const syncVol = () => { if (volSlider) volSlider.value = String(Math.round((audio.muted ? 0 : audio.masterVol) * 100)); };
  if (volSlider) {
    syncVol();
    volSlider.addEventListener('input', () => { audio.init(); audio.setMasterVol((+volSlider.value) / 100); muteIcon(); });
  }
  // in-game music swap: cycle the track on click and flash the name
  const musBtn = $('musBtn'), musLabel = $('musLabel');
  const MUS_STYLES = ['iron', 'golden', 'frozen', 'enemies', 'playlist', 'off']; // in-game 🎵 cycle
  const MUS_NAMES: Record<string, string> = { playlist: 'Play All Tracks', battle: 'Battle', hellmarch: 'Hell March', iron: 'Iron Directive', golden: 'Golden Dreams', frozen: 'Frozen Flower', enemies: 'Love for Enemies', march: 'Military March', ambient: 'Ambient', off: 'Off' };
  let musLabelTimer: any;
  const flashMus = () => {
    musBtn.title = 'Music: ' + (MUS_NAMES[audio.musicStyle] || audio.musicStyle) + ' — click to change';
    musLabel.textContent = MUS_NAMES[audio.musicStyle] || audio.musicStyle;
    musLabel.style.opacity = '1';
    clearTimeout(musLabelTimer);
    musLabelTimer = setTimeout(() => { musLabel.style.opacity = '0'; }, 1800);
  };
  musBtn.addEventListener('click', () => {
    audio.init();
    const i = MUS_STYLES.indexOf(audio.musicStyle);
    audio.setMusicStyle(MUS_STYLES[(i + 1) % MUS_STYLES.length]);
    try { ($('musStyle') as HTMLSelectElement).value = audio.musicStyle; } catch { /* menu not present */ }
    flashMus();
  });
  // AI roster: add enemies/partners, each with its own level + team
  renderAiList();
  $('btnAddEnemy').addEventListener('click', () => addAI(true));
  $('btnAddPartner').addEventListener('click', () => addAI(false));
  // audio settings: music style + volume sliders
  const musSel = $('musStyle') as HTMLSelectElement;
  musSel.value = audio.musicStyle;
  musSel.addEventListener('change', () => { audio.init(); audio.setMusicStyle(musSel.value); });
  const gfxSel = $('gfxQual') as HTMLSelectElement;
  gfxSel.value = gfxQuality();
  gfxSel.addEventListener('change', () => {
    try { safeLS.setItem('fe_quality', gfxSel.value); } catch { /* no storage */ }
    if (client) client.renderer.setQuality(gfxSel.value); // apply live if a match is running
  });
  const mv = $('musVol') as HTMLInputElement, sv = $('sfxVol') as HTMLInputElement;
  mv.value = String(Math.round(audio.musicVol * 100));
  sv.value = String(Math.round(audio.sfxVol * 100));
  mv.addEventListener('input', () => { audio.init(); audio.setMusicVol(+mv.value / 100); });
  sv.addEventListener('input', () => { audio.init(); audio.setSfxVol(+sv.value / 100); });
  buildOptionRow('sizeRow',
    [{ label: 'Medium', v: 112 }, { label: 'Large', v: 136 }, { label: 'Huge', v: 160 }, { label: 'Giant', v: 192 }],
    () => selSize, v => { selSize = v; });
  $('btnSkirmish').addEventListener('click', () => {
    const key = (($('claudeKey') as HTMLInputElement).value || '').trim();
    try { safeLS.setItem('ae_claude_key', key); } catch { /* no storage */ }
    fogEnabled = ($('fogChk') as HTMLInputElement)?.checked ?? true;
    const mt = ($('mapType') as HTMLSelectElement)?.value || 'continent';
    islandsEnabled = mt === 'islands';
    urbanEnabled = mt === 'urban';
    flatEnabled = mt === 'flat';
    steelEnabled = mt === 'steel';
    metalEnabled = mt === 'metal';
    oreLevelSel = (+($('oreAmt') as HTMLSelectElement)?.value || 0) & 3;
    if (!aiList.length || !aiList.some(a => a.team !== 1)) {
      $('menuErr').textContent = 'Add at least one enemy AI to play.';
      return;
    }
    $('menuErr').textContent = '';
    saveMenuPrefs();                                 // remember these choices for next time
    const levels = aiList.map(a => a.lvl);          // each AI's difficulty
    const teams = [1, ...aiList.map(a => a.team)];   // you are team 1; AIs follow
    startGame(new LocalGame(playerName(), selFaction, selDiff, selSize, null, levels, teams));
  });
  $('btnTutorial').addEventListener('click', () => {
    // guided first game: one passive enemy, fog on so the minimap step makes
    // sense, a fat treasury and the scripted coach (set up in startGame)
    fogEnabled = true;
    startGame(new LocalGame(playerName(), selFaction, 0, 112, null, [0], [], true));
  });
  $('btnSimulate').addEventListener('click', () => {
    // spectate AI (level 1 row) vs AI 2 (level 2 row); +/- adjusts speed to 32×
    const nRaw = window.prompt('How many AI vs AI matches should run back-to-back?\n(Each match teaches the AI — speed carries over, +/- up to 32×)', '1');
    if (nRaw === null) return;
    const n = Math.max(1, Math.min(20, parseInt(nRaw, 10) || 1));
    simQueue = { left: n, total: n, speed: 1 };
    startGame(new LocalGame('', '', selDiff, selSize, selDiff2));
  });
  $('btnReplays').addEventListener('click', async () => {
    const list = $('replayList');
    if (!list.classList.contains('hidden')) { list.classList.add('hidden'); return; }
    list.classList.remove('hidden');
    list.innerHTML = 'Loading…';
    try {
      const res = await fetch('/replays');
      if (!res.ok) throw new Error('no server');
      const idx = await res.json();
      if (!idx.length) { list.innerHTML = 'No matches recorded on this server yet.'; return; }
      list.innerHTML = idx.slice(0, 20).map((m: any) =>
        `<div class="replayRow" data-id="${m.id}" style="cursor:pointer">▶ ${new Date(m.date).toLocaleString()} — ` +
        `${(m.players || []).map((pl: any) => pl.name).join(' vs ')} · ` +
        `${m.winnerName ? m.winnerName + ' won' : 'abandoned'} · ${Math.round((m.lenSec || 0) / 60)}min</div>`).join('');
      list.querySelectorAll('.replayRow').forEach(row => row.addEventListener('click', async () => {
        try {
          const data = await (await fetch('/replays/' + row.getAttribute('data-id'))).json();
          // a replay only reproduces on the same sim/map version it was recorded
          // on — refuse incompatible ones instead of showing a garbled match
          if ((data.ver || 0) !== SIM_VERSION) {
            list.innerHTML = 'This replay was recorded on an older game version and can no longer be played back. New matches will record compatible replays.';
            return;
          }
          startGame(new ReplayGame(data));
        } catch { list.innerHTML = 'Replay could not be loaded.'; }
      }));
    } catch { list.innerHTML = 'Replays live on the game server — open the deployed site to browse them.'; }
  });
  // Multiplayer presence lives inline on the main page: connect on load so the
  // online-players and open-games lists populate live. Skirmish works regardless,
  // so a server that's down just shows "offline" here.
  goOnline();
  // FEATURE REQUESTS: a public suggestion box (stored server-side, human-reviewed)
  const loadFeatures = async () => {
    const list = $('frList'), count = $('frCount');
    try {
      const res = await fetch('/features');
      const items: any[] = res.ok ? await res.json() : [];
      count.textContent = String(items.length);
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      list.innerHTML = items.length
        ? items.slice().reverse().slice(0, 100).map(it => {
            const done = !!it.done;
            const badge = done ? ' <span style="color:#57d977;font-size:10px">✓ DELIVERED</span>' : '';
            const note = done && it.note ? `<br><span style="color:#57d977;font-size:10px">↳ ${esc(String(it.note))}</span>` : '';
            return `<div style="padding:4px 0;border-bottom:1px solid #1d2935${done ? ';opacity:0.7' : ''}"><span style="color:#7bdcff">${esc(String(it.name || 'Anonymous'))}</span> ` +
              `<span style="color:#5f7384;font-size:10px">${new Date(it.date).toLocaleDateString()}</span>${badge}<br>${esc(String(it.text || ''))}${note}</div>`;
          }).join('')
        : '<span style="color:#5f7384">No requests yet — be the first!</span>';
    } catch { list.innerHTML = '<span style="color:#5f7384">Feature requests live on the game server — open the deployed site.</span>'; }
  };
  const frWhoNote = () => {
    const cs = safeLS.getItem('fe_callsign');
    const who = $('frWho');
    if (who) who.innerHTML = cs
      ? `Posting as <b style="color:#cdeef6">${escapeHtml(cs)}</b>`
      : `<span style="color:#ffc940">Log in to submit a request.</span>`;
  };
  $('btnFeatures').addEventListener('click', () => { $('frErr').textContent = ''; frWhoNote(); show('features'); loadFeatures(); });
  $('frBack').addEventListener('click', () => show('menu'));
  $('frSubmit').addEventListener('click', async () => {
    const text = ($('frText') as HTMLTextAreaElement).value.trim();
    const err = $('frErr');
    if (!text) { err.textContent = 'Type a request first.'; return; }
    const token = safeLS.getItem('fe_token');
    if (!token) { err.textContent = 'Please log in to submit a feature request.'; document.getElementById('lgAuthWrap')?.classList.remove('hidden'); return; }
    err.textContent = '';
    try {
      const res = await fetch('/features', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, token }) });
      if (!res.ok) { err.textContent = res.status === 401 ? 'Please log in to submit.' : res.status === 429 ? 'Slow down a moment, then try again.' : 'Could not submit — try again.'; return; }
      ($('frText') as HTMLTextAreaElement).value = '';
      err.textContent = '✓ Thanks! Your request was saved.';
      loadFeatures();
    } catch { err.textContent = 'Feature requests need the deployed game server.'; }
  });
  // create a game others can see and join — uses the map/size options above
  $('btnMpCreate').addEventListener('click', async () => {
    $('mpErr').textContent = '';
    fogEnabled = ($('fogChk') as HTMLInputElement)?.checked ?? true;
    if (!net && !(await goOnline())) { $('mpErr').textContent = 'Server unreachable'; return; }
    const mt = ($('mapType') as HTMLSelectElement)?.value;
    net?.send({ t: 'create', name: playerName(), faction: selFaction, size: selSize, diff: selDiff, islands: mt === 'islands', urban: mt === 'urban', flat: mt === 'flat', steel: mt === 'steel', metal: mt === 'metal', lockstep: ($('lockstepChk') as HTMLInputElement)?.checked ?? false });
  });
  $('btnMpJoinCode').addEventListener('click', async () => {
    $('mpErr').textContent = '';
    const code = ($('mpJoinCode') as HTMLInputElement).value.trim().toUpperCase();
    if (code.length !== 4) { $('mpErr').textContent = 'Enter a 4-letter room code'; return; }
    if (!net && !(await goOnline())) { $('mpErr').textContent = 'Server unreachable'; return; }
    net?.send({ t: 'join', code, name: playerName(), faction: selFaction });
  });
  // lobby chat: same chat shown on the global lobby AND the room waiting screen
  const sendLobbyChat = (inputId: string) => {
    const inp = $(inputId) as HTMLInputElement;
    const msg = inp.value.trim();
    if (msg && net) { net.send({ t: 'lobbychat', msg }); inp.value = ''; }
  };
  const wireLobbyChat = (inputId: string, btnId: string) => {
    $(btnId).addEventListener('click', () => sendLobbyChat(inputId));
    $(inputId).addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); sendLobbyChat(inputId); } });
  };
  wireLobbyChat('lobbyChatInput', 'lobbyChatSend');
  wireLobbyChat('roomChatInput', 'roomChatSend');
  wireNotifyToggles();
  $('btnStart').addEventListener('click', () => net?.send({ t: 'start' }));
  // LEAVE a room's waiting screen returns to the main page (stay connected so the
  // online/open-games lists keep updating there)
  $('btnLeave').addEventListener('click', () => {
    if (net) net.send({ t: 'leaveRoom' });
    show('menu');
  });
  // leave the room and return to the landing/home page
  $('btnLobbyHome').addEventListener('click', () => {
    if (net) net.send({ t: 'leaveRoom' });
    show('menu');
    document.getElementById('landing')?.classList.remove('hidden');
  });
  // after a match: multiplayer players return to the lobby (reconnect for a clean
  // socket + fresh handlers); single-player/replay just reloads to the menu
  $('btnAgain').addEventListener('click', async () => {
    if (endReturnsToLobby) {
      // multiplayer: ask the server to reset the room to a fresh lobby, then reconnect
      // (for a clean socket + handlers) and REJOIN the same room — players land back in
      // the lobby together and can immediately start another match
      endReturnsToLobby = false;
      try { net?.send({ t: 'backToLobby' }); } catch { /* socket already gone */ }
      if (client) { client.destroy(); client = null; } // closes the old socket
      show('menu'); // transient; the 'room' event switches to the lobby on rejoin
      try {
        net = await connectNet();
        net.send({ t: 'hello', name: playerName(), faction: selFaction });
        if (lastRoomCode) net.send({ t: 'join', code: lastRoomCode });
      } catch { location.reload(); }
    } else {
      // single-player / replay: tear down and return to the game MENU — NOT a full page
      // reload, which would drop the player back on the landing page
      if (client) { client.destroy(); client = null; }
      simQueue = null;
      if (tutCtl) { tutCtl.stop(); tutCtl = null; }
      show('menu');
    }
  });
  // Exit → choice popup: Surrender (a defeat), Just Exit (no result), or Cancel
  const exitMenu = $('exitMenu');
  const closeExitMenu = () => exitMenu.classList.add('hidden');
  $('exitBtn').addEventListener('click', () => { if (client) exitMenu.classList.remove('hidden'); });
  $('exMenuCancel').addEventListener('click', closeExitMenu);
  $('exMenuJustExit').addEventListener('click', () => {
    closeExitMenu();
    reportPlaystat(); // log the play time even when leaving without a result
    // leave with no result: a human teammate inherits the forces (server side),
    // and the game ends if no human remains. No stats, not counted as a defeat.
    if (net) { net.send({ t: 'leave' }); net.close(); net = null; }
    simQueue = null;
    if (tutCtl) { tutCtl.stop(); tutCtl = null; }
    if (client) { client.destroy(); client = null; }
    show('menu');
  });
  $('exMenuSurrender').addEventListener('click', () => {
    closeExitMenu();
    if (client) client.surrender();
  });
  // after surrendering, the revealed-map banner's button opens the battle report
  $('reportBtn').addEventListener('click', () => client?.viewReport());
  // Multiplayer desync pause popup: keep waiting (snooze the popup; it auto-shows
  // again if still stalled after the snooze) or quit the match back to the menu.
  $('netStallContinue').addEventListener('click', () => {
    $('netStall').classList.add('hidden');
    if (client) client.snoozeStall();
  });
  $('netStallQuit').addEventListener('click', () => {
    $('netStall').classList.add('hidden');
    reportPlaystat(); // log the play time for the quit MP match
    if (net) { net.send({ t: 'leave' }); net.close(); net = null; }
    simQueue = null;
    if (tutCtl) { tutCtl.stop(); tutCtl = null; }
    if (client) { client.destroy(); client = null; }
    show('menu');
  });
}

// ---- Landing page: hero CTA + email/password accounts so a chosen callsign
// follows the player across devices. The landing covers the menu on first load;
// PLAY reveals the game. Accounts hit /auth/* on the game server (hashed). ----
function initLanding() {
  const landing = document.getElementById('landing');
  if (!landing) return;
  const el = (id: string) => document.getElementById(id)!;
  // swap the CSS-art hero for /hero.jpg the moment that image exists (404 = keep art)
  const bg = el('lgBg');
  const probe = new Image();
  probe.onload = () => { bg.style.backgroundImage = 'url(/hero.jpg)'; bg.classList.add('hasImg'); };
  probe.src = '/hero.jpg';
  // PLAY → reveal the game menu underneath
  el('lgPlay').addEventListener('click', () => { audio.init(); landing.classList.add('hidden'); });

  const wrap = el('lgAuthWrap');
  const openAuth = (e?: Event) => { e?.preventDefault(); wrap.classList.remove('hidden'); (el('lgEmail') as HTMLInputElement).focus(); };
  const closeAuth = () => wrap.classList.add('hidden');
  el('lgShowAuth').addEventListener('click', openAuth);
  el('lgNavAuth').addEventListener('click', openAuth);
  el('lgAuthClose').addEventListener('click', closeAuth);
  el('lgGuest').addEventListener('click', closeAuth);
  wrap.addEventListener('click', e => { if (e.target === wrap) closeAuth(); });

  let mode: 'login' | 'register' = 'login';
  const tabL = el('lgTabLogin'), tabR = el('lgTabRegister'), cs = el('lgCallsign') as HTMLInputElement;
  const submit = el('lgAuthSubmit') as HTMLButtonElement, errEl = el('lgAuthErr'), msgEl = el('lgAuthMsg');
  const setMode = (m: 'login' | 'register') => {
    mode = m;
    tabL.classList.toggle('on', m === 'login'); tabR.classList.toggle('on', m === 'register');
    cs.classList.toggle('hidden', m !== 'register');
    submit.textContent = m === 'login' ? 'Log in' : 'Create account';
    (el('lgPassword') as HTMLInputElement).autocomplete = m === 'login' ? 'current-password' : 'new-password';
    errEl.textContent = ''; msgEl.classList.add('hidden');
  };
  tabL.addEventListener('click', () => setMode('login'));
  tabR.addEventListener('click', () => setMode('register'));
  // seed the register callsign from whatever's in the name box
  cs.value = ((document.getElementById('nameInput') as HTMLInputElement)?.value || '').trim();

  // offline-play (PWA) entitlement: register a caching service worker for granted users
  // so Skirmish vs AI launches with no network; revoked/guest → tear it down.
  const applyOffline = (on: boolean) => {
    if (!('serviceWorker' in navigator)) return;
    if (on) { navigator.serviceWorker.register('/sw.js').catch(() => {}); return; }
    navigator.serviceWorker.getRegistrations?.().then(rs => rs.forEach(r => {
      try { r.active?.postMessage('fe-offline-off'); } catch { /* ignore */ }
      r.unregister();
    })).catch(() => {});
  };
  const setLoggedIn = (callsign: string) => {
    if (!callsign) return;
    try { safeLS.setItem('fe_callsign', callsign); safeLS.setItem('fe_name', callsign.slice(0, 18)); } catch { /* no storage */ }
    const nm = document.getElementById('nameInput') as HTMLInputElement | null;
    if (nm) nm.value = callsign;
    const label = '◉ ' + callsign;
    const a = document.getElementById('lgNavAuth'); if (a) a.textContent = label;
    const b = document.getElementById('lgShowAuth'); if (b) b.textContent = label;
    el('lgLogout').classList.remove('hidden'); // offer logout once signed in
  };
  const setLoggedOut = () => {
    try { safeLS.removeItem('fe_token'); safeLS.removeItem('fe_callsign'); } catch { /* no storage */ }
    applyOffline(false); // drop the offline cache/SW on logout
    const a = document.getElementById('lgNavAuth'); if (a) a.textContent = 'Log in';
    const b = document.getElementById('lgShowAuth'); if (b) b.textContent = 'Log in / Sign up';
    el('lgLogout').classList.add('hidden');
  };
  el('lgLogout').addEventListener('click', () => { setLoggedOut(); errEl.textContent = ''; msgEl.textContent = 'Logged out.'; msgEl.classList.remove('hidden'); });

  const doSubmit = async () => {
    const email = (el('lgEmail') as HTMLInputElement).value.trim();
    const password = (el('lgPassword') as HTMLInputElement).value;
    const callsign = cs.value.trim();
    errEl.textContent = ''; msgEl.classList.add('hidden');
    submit.disabled = true;
    try {
      const r = await fetch('/auth/' + mode, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, callsign }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { errEl.textContent = j.error || 'Something went wrong'; return; }
      try { safeLS.setItem('fe_token', j.token); } catch { /* no storage */ }
      setLoggedIn(j.callsign);
      applyOffline(!!j.offline); // admin-granted offline play → install the caching SW
      msgEl.textContent = mode === 'register' ? 'Account created — you’re logged in!' : 'Welcome back, ' + j.callsign + '!';
      msgEl.classList.remove('hidden');
      setTimeout(closeAuth, 800);
    } catch { errEl.textContent = 'Server unreachable — you can still play as guest.'; }
    finally { submit.disabled = false; submit.textContent = mode === 'login' ? 'Log in' : 'Create account'; }
  };
  submit.addEventListener('click', doSubmit);
  el('lgEmail').addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Enter') doSubmit(); });
  el('lgPassword').addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Enter') doSubmit(); });
  cs.addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Enter') doSubmit(); });

  // restore a saved session: prefill instantly from the cached callsign, then
  // confirm the token is still valid against the server
  try {
    const savedCs = safeLS.getItem('fe_callsign');
    if (savedCs) setLoggedIn(savedCs);
    const tok = safeLS.getItem('fe_token');
    if (tok) {
      fetch('/auth/me', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok }) })
        .then(r => r.ok ? r.json() : null).then(j => { if (j && j.callsign) { setLoggedIn(j.callsign); applyOffline(!!j.offline); } }).catch(() => { /* offline — a previously-installed SW still serves the cached game */ });
    }
  } catch { /* no storage */ }
}

// WebGL2 support gate (all modern browsers: Chrome/Edge 56+, Firefox 51+, Safari 15+)
// suppress the browser's right-click menu everywhere — right-click is a game
// control, and the Chrome dropdown sometimes popped up over the minimap/HUD.
// (inputs still work; we only stop the context menu.)
window.addEventListener('contextmenu', e => e.preventDefault());
// the middle mouse button triggers Chrome's autoscroll "compass" overlay —
// suppress it page-wide (it isn't a game control and looked broken on the map)
window.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
window.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });

const glOk = !!document.createElement('canvas').getContext('webgl2');
if (!glOk) {
  document.body.innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#ff5043;font-size:18px;text-align:center;padding:20px">' +
    'This game needs WebGL2.<br>Please use a current version of Chrome, Edge, Firefox, or Safari.</div>';
} else {
  initMenus();
  rollCallsign();
  renderAiIntel();
  syncIntelFromServer();
  showBuildInfo();
  // swap every static emoji in the page (menu buttons, command bar, audio toggles,
  // faction flags) for bundled Twemoji SVGs so icons render on browsers/OSes whose
  // system emoji fonts are missing or monochrome (dynamic UI is converted at source)
  twemojiParse(document.body);
  // remember a name the player types (skip the random funny placeholders)
  try {
    const nm = $('nameInput') as HTMLInputElement;
    nm.addEventListener('change', () => {
      const v = (nm.value || '').trim();
      try { if (v && !FUNNY_NAMES.includes(v)) safeLS.setItem('fe_name', v.slice(0, 18)); } catch { /* no storage */ }
    });
  } catch { /* no input */ }
  try { ($('claudeKey') as HTMLInputElement).value = safeLS.getItem('ae_claude_key') || ''; } catch { /* no storage */ }
  initLanding();   // hero + accounts; restores a saved session and prefills the callsign
  (window as any).__prof = prof;   // console access: __prof.table(), __prof.enabled = true
  // tell the startup-diagnostic in index.html that the app booted cleanly (so it
  // won't show the "code did not start" banner)
  (window as any).__feBooted = true;
}

// Preload every 3D model behind the loading screen, then run start(). Models are
// cached after the first call, so this is only slow the first time a game starts —
// the menu itself appears instantly (we no longer preload at app boot).
let modelsReady = false;
function startWithModels(start: () => void) {
  if (modelsReady) { start(); return; }
  const pre = document.getElementById('preload');
  const bar = document.getElementById('preloadBar');
  const txt = document.getElementById('preloadTxt');
  if (pre) pre.style.display = 'flex';
  const done = () => { modelsReady = true; start(); if (pre) pre.style.display = 'none'; }; // hide AFTER the game renders (no menu flash)
  let finished = false;
  const finish = () => { if (finished) return; finished = true; done(); };
  preloadModels((d, t) => {
    if (bar) bar.style.width = Math.round((d / t) * 100) + '%';
    if (txt) txt.textContent = `Loading models… ${d}/${t}`;
  }).catch(() => {}).finally(finish);
  setTimeout(finish, 25000); // safety net: never trap the player on the loading screen
}

// version stamp on the menu: revision auto-increments with every commit; the
// hash links the running build to its exact source on GitHub
function showBuildInfo() {
  const el = document.getElementById('buildInfo');
  if (!el) return;
  const rev = (typeof __APP_REV__ !== 'undefined' && __APP_REV__) || '0';
  const hash = (typeof __APP_HASH__ !== 'undefined' && __APP_HASH__) || 'dev';
  let date = '';
  try { date = new Date(__BUILD_TIME__).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { /* ignore */ }
  const repo = 'https://github.com/alikeiri/AlisEarth';
  const link = hash === 'dev' ? `${repo}/commits/main` : `${repo}/commit/${hash}`;
  el.innerHTML = `v${rev} · <a href="${link}" target="_blank" rel="noopener" style="color:#7392a8;text-decoration:none">${hash}</a>${date ? ' · ' + date : ''}`;
}
