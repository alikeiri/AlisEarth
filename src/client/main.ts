// Client entry: menus, game loop, input. Two game modes share one interface:
// LocalGame (sim + AI in-browser) and NetGame (server-authoritative snapshots).

import { Sim } from '../sim/sim';
import { aiTick } from '../sim/ai';
import { FACTIONS, BUILDINGS, UNITS } from '../sim/data';
import { GameMap, genMap, setMapSize, W, H } from '../sim/map';
import { Renderer } from './render';
import { UI } from './ui';
import { Net } from './net';
import { audio } from './audio';

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
}

// ---------------- Local skirmish ----------------
class LocalGame implements GameLike {
  sim: Sim;
  me = 0;
  speed = 1; // 0.5×–8× sim speed (+/- keys); multiplayer has no such field
  isSim = false; // spectator simulation: AI vs AI, no human player
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
  constructor(name: string, faction: string, aiLvl = 1, size = 96, simLvl2: number | null = null, enemyLevels: number[] = [1]) {
    setMapSize(size);
    const seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
    const LVL_NAMES = ['Easy', 'Normal', 'Hard', 'Brutal'];
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
      const specs: any[] = [{ name, faction }];
      lvls.forEach((lv, i) =>
        specs.push({ name: `AI ${FACTIONS[facs[i]].name} (${LVL_NAMES[lv] || 'Normal'})`, faction: facs[i], isAI: true, aiLvl: lv }));
      this.sim = new Sim(seed, specs);
      this.recSeed = seed; this.recSize = size; this.recPlayers = specs.map(s => ({ ...s }));
    }
    // the AI studies past games and adapts: server intelligence is primary,
    // the browser's own profile fills in when the server is unreachable
    this.sim.aiProfile = mergedProfile();
  }
  get map() { return this.sim.map; }
  get tickN() { return this.sim.tickN; }
  issue(cmd: any) { this.pending.push(cmd); }
  // send the finished skirmish to the server's replay store so it's watchable
  private uploadReplay() {
    if (!this.recPlayers.length) return;
    const meta = {
      players: this.recPlayers.map(p => ({ name: p.name, faction: p.faction, isAI: !!p.isAI })),
      winner: this.sim.winner, winnerName: this.sim.winner >= 0 ? this.recPlayers[this.sim.winner]?.name : null,
      lenSec: Math.round(this.sim.tickN / 10), done: true,
    };
    fetch('/replays', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meta, seed: this.recSeed, size: this.recSize, cmds: this.recCmds }),
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
          saveAiReport(ev.r);
          requestLesson(ev.r); // fire-and-forget post-mortem
        }
      }
      if (this.sim.done && !this.recSaved && !this.isSim) { this.recSaved = true; this.uploadReplay(); }
      this.evQ.push(...this.sim.events);
    }
    if (guard >= gMax) this.acc = 0; // tab was backgrounded — drop the backlog
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
        if (e.queue.length) {
          v.qt = 1 - e.queue[0].t / e.queue[0].t0;
          v.qy = e.queue[0].type;
          v.qq = e.queue.map(q => q.type);
        }
        if (e.rallyX >= 0) { v.rx = e.rallyX; v.rz = e.rallyZ; }
        if (e.patPts) v.pp = e.patPts;
        if (e.rpt) v.rp = 1;
        if (e.primary) v.pm = 1;
        if (e.research) { v.rs = e.research.tech; v.rsf = 1 - e.research.t / e.research.t0; }
        if (e.storedMissile) v.ms = e.storedMissile;
        if (e.burnT && e.burnT > 0) v.bn = 1;
      } else {
        if (e.stance) v.st = e.stance;
        if (e.fortified) v.fo = 1;
        if (e.fortT > 0) v.ft = 1; // deploying / packing
        if (UNITS[e.t]?.cloak || UNITS[e.type]?.cloak) v.ck = 1;
        if (e.cd > 0 && UNITS[e.type]?.dmg > 0) {
          v.fr = 1; // firing — drives infantry aim pose
          if (e.aimX !== undefined) { v.ax = e.aimX; v.az = e.aimZ; } // turn toward the target
        }
        if (e.sd > 0) v.sd = Math.ceil(e.sd); // self-destruct countdown
      }
      out.push(v);
    }
    return out;
  }
  players(): any[] {
    return this.sim.players.map(pl => ({
      c: Math.floor(pl.credits), a: pl.alive, pm: Math.round(pl.powerMade), pu: Math.round(pl.powerUsed),
      n: pl.name, f: pl.faction, tech: Object.keys(pl.tech).filter(k => pl.tech[k]),
    }));
  }
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
      } else {
        if (e.fortified) v.fo = 1;
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
      n: pl.name, f: pl.faction, tech: Object.keys(pl.tech).filter(k => pl.tech[k]),
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
  private chatQ: any[] = [];
  private roster: { name: string; isAI: boolean }[] = [];

  constructor(private net: Net, seed: number, nPlayers: number, me: number, roster?: any[]) {
    this.map = genMap(seed, nPlayers);
    this.me = me;
    this.roster = roster || [];
    net.on('snap', m => this.onSnap(m));
    net.on('end', m => { this.end = { over: true, winner: m.winner }; });
    net.on('chat', m => { if (this.chatQ.length < 50) this.chatQ.push(m); });
  }

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
  leave() { this.net.close(); }
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
    }
  // prerequisite building must exist and be finished (else placement fails server-side)
  if (def.prereq && !views.some(v => v.b && v.o === me && v.t === def.prereq && (v.pr ?? 1) >= 1)) return false;
  let near = false;
  for (const v of views) {
    if (!v.b) continue;
    if (v.cx < cx + s && v.cx + v.sz > cx && v.cz < cz + s && v.cz + v.sz > cz) return false;
    if (v.o === me) {
      const d = Math.sqrt((v.x - (cx + s / 2)) ** 2 + (v.z - (cz + s / 2)) ** 2);
      if (d <= 11) near = true;
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
  private rMode: 'pan' | 'form' | 'aatk' = 'pan';
  private formPath: { x: number; z: number }[] | null = null;
  private areaDrag: { cx: number; cz: number; r: number } | null = null;
  private patrolMode = false;
  private patrolDraw: { x: number; z: number }[] | null = null;
  // drag-line placement for walls/barriers
  private lineStart: { cx: number; cz: number } | null = null;
  private lineCells: { cx: number; cz: number; ok: boolean }[] = [];
  private cheatBuf = '';
  private groups: Record<number, number[]> = {};
  private lastGroupTap = { n: 0, t: 0 };
  private lastHover: { x: number; y: number } | null = null;
  private showRanges = true;
  private cmdFx: { fx: number; fz: number; tx: number; tz: number; t: number; atk: boolean }[] = [];
  private lastClick = { t: 0, x: 0, y: 0 };
  private lastGhost: { cx: number; cz: number; ok: boolean } | null = null;
  private raf = 0;
  private lastT = 0;
  private frame = 0;
  private over = false;
  private overlayCtx: CanvasRenderingContext2D;
  private cleanups: (() => void)[] = [];

  // fog of war: 0 never seen, 1 explored, 2 currently visible — client-side
  // per-player view masking (spectator modes see everything)
  private fog: Uint8Array | null = null;
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
      t => this.train(t),
      (x, z) => this.renderer.jumpCam(x, z),
      t => { this.game.issue({ k: 'cancel', p: this.game.me, type: t }); audio.play('cancel'); },
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
      else this.renderer.zoomBy(e.deltaY > 0 ? 1.12 : 0.89);
    }, { passive: false });
    on(window, 'keydown', (e: KeyboardEvent) => {
      // typing in the chat input (or any form field) must not trigger hotkeys
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Enter' && this.game.isNet) { this.openChat(); e.preventDefault(); return; }
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
        this.renderer.setFormationPath(null);
      }
      if (e.code === 'KeyH') this.issueToUnits({ k: 'stop' });
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
        }
      }
      if (e.code === 'KeyP' && (this.myUnitIds().length || this.selectedProdBuilding())) {
        this.patrolMode = !this.patrolMode;
        this.patrolDraw = null;
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
        const ids = this.myUnitIds().filter(id => UNITS[this.byId.get(id)?.t]?.fortify);
        if (ids.length) { this.game.issue({ k: 'fortify', p: this.game.me, ids }); audio.play('confirm'); }
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
          this.game.sendChat(/^\d+$/.test(raw) ? parseInt(raw, 10) : raw, msg);
        }
        this.closeChat();
      } else if (e.code === 'Escape') this.closeChat();
    };
    chatInp.addEventListener('keydown', chatKeys);
    this.cleanups.push(() => chatInp.removeEventListener('keydown', chatKeys));

    this.setupTouchBar(on);
    this.sizeOverlay();
    this.lastT = performance.now();
    (window as any).__fe = this; // debug/testing handle
    this.loop(this.lastT);
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
    }
    const bar = document.getElementById('touchBar');
    if (!bar) return;
    // show on touch devices or narrow screens; re-check when the window changes
    const refresh = () => {
      const show = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window || window.innerWidth <= 820;
      bar.classList.toggle('hidden', !show);
    };
    refresh();
    on(window, 'resize', refresh);
    const tap = (act: string, btn: HTMLElement) => {
      const ids = this.myUnitIds();
      if (act === 'box') { this.touch.boxToggle = !this.touch.boxToggle; btn.classList.toggle('on', this.touch.boxToggle); }
      else if (act === 'stop') this.issueToUnits({ k: 'stop' });
      else if (act === 'hold') { if (ids.length) { const anyAgg = ids.some(id => !this.byId.get(id)?.st); this.game.issue({ k: 'stance', p: this.game.me, ids, stance: anyAgg ? 1 : 0 }); } }
      else if (act === 'patrol') { if (ids.length || this.selectedProdBuilding()) { this.patrolMode = !this.patrolMode; this.patrolDraw = null; } }
      else if (act === 'fortify') { const f = ids.filter(id => UNITS[this.byId.get(id)?.t]?.fortify); if (f.length) this.game.issue({ k: 'fortify', p: this.game.me, ids: f }); }
      else if (act === 'ranges') { this.showRanges = !this.showRanges; btn.classList.toggle('on', this.showRanges); }
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
    // minimap: tap/drag to jump the camera (touch)
    const mm = document.getElementById('minimap');
    if (mm) {
      const jump = (cx: number, cy: number) => {
        const r = mm.getBoundingClientRect();
        // both axes flipped to match the camera's ground orientation
        this.renderer.jumpCam((1 - (cx - r.left) / r.width) * W, (1 - (cy - r.top) / r.height) * H);
      };
      const mh = (e: TouchEvent) => { e.preventDefault(); const t = e.touches[0]; if (t) jump(t.clientX, t.clientY); };
      on(mm, 'touchstart', mh, { passive: false });
      on(mm, 'touchmove', mh, { passive: false });
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
    setTimeout(() => inp.focus(), 0);
  }

  private closeChat() {
    document.getElementById('chatBar')!.classList.add('hidden');
    (document.getElementById('chatInput') as HTMLInputElement).blur();
  }

  // radio line from the enemy AI commander (Claude strategist taunts)
  aiSays(msg: string) {
    const who = this.game.players?.()[1]?.n || 'Enemy AI';
    this.appendChat({ name: who, to: 'all', msg });
    audio.play('click');
  }

  private appendChat(m: any) {
    const log = document.getElementById('chatLog')!;
    const div = document.createElement('div');
    const dm = typeof m.to === 'number';
    div.className = 'chatMsg' + (dm ? ' dm' : '');
    const chan = dm ? 'DM' : m.to === 'allies' ? 'ALLY' : 'ALL';
    div.innerHTML = `<span class="chan">[${chan}]</span><span class="who">${m.name}:</span> ${String(m.msg)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')}`;
    (div as any).dataset.t = String(performance.now());
    log.appendChild(div);
    while (log.children.length > 8) log.removeChild(log.firstChild!);
  }

  private sizeOverlay() {
    const o = document.getElementById('overlay') as HTMLCanvasElement;
    o.width = window.innerWidth; o.height = window.innerHeight;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    for (const c of this.cleanups) c();
    this.ui.destroy();
    this.ui.setHudVisible(false);
    this.closeChat();
    document.getElementById('chatLog')!.innerHTML = '';
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

  private train(type: string) {
    const def = UNITS[type];
    if (!def) return;
    // a primary building (set via double-click) always wins; else shortest queue
    let primary: any = null, best: any = null;
    for (const v of this.lastViews) {
      if (!v.b || v.o !== this.game.me || v.t !== def.builtAt || v.pr < 1) continue;
      if (v.pm) primary = v;
      if (!best || (v.qn || 0) < (best.qn || 0)) best = v;
    }
    const tgt = primary || best;
    if (tgt) { this.game.issue({ k: 'train', p: this.game.me, bid: tgt.i, type }); audio.play('click'); }
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

  // select all own units inside a screen rectangle (shared by mouse + touch)
  private boxSelect(x0: number, y0: number, x1: number, y1: number, additive: boolean) {
    const me = this.game.me;
    const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
    const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
    if (!additive) this.selection.clear();
    const boxed: any[] = [];
    for (const v of this.lastViews) {
      if (v.b || v.o !== me) continue;
      const p = this.renderer.project(v.x, v.z, 0.5);
      if (p.ok && p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y) boxed.push(v);
    }
    const combat = boxed.filter(v => v.t !== 'harv');
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
    if (dbl && ownHit && !ownHit.b) { // double-tap own unit → all same type on screen
      this.selection.clear();
      for (const v of this.lastViews) if (!v.b && v.o === me && v.t === ownHit.t && this.renderer.project(v.x, v.z, 0.5).ok) this.selection.add(v.i);
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
      const p = this.renderer.project(v.x, v.z, v.b ? 1 : 0.5);
      if (!p.ok) continue;
      const d = Math.hypot(p.x - sx, p.y - sy);
      const r = v.b ? 14 + (v.sz || 1) * 7 : 16;
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
        ? this.pickView(e.clientX, e.clientY, v => v.o !== this.game.me) : null;
      if (enemyUnder) {
        const g = this.renderer.groundPoint(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
        this.rMode = 'aatk';
        this.areaDrag = g ? { cx: g.x, cz: g.z, r: 0 } : null;
      } else {
        // 2+ units selected: right-drag draws a formation line; otherwise it pans
        this.rMode = this.myUnitIds().length >= 2 ? 'form' : 'pan';
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
      if (!wasDrag) this.contextCommand(e.clientX, e.clientY, e.shiftKey); // quick right-click = order
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
      else if (this.rMode === 'form' && path && path.length >= 2) this.issueFormation(path, e.shiftKey);
      return;
    }
    if (e.button !== 0 || !this.mouse.lDown) return;
    this.mouse.lDown = false;
    const me = this.game.me;

    // commit a wall/barrier drag-line
    if (this.lineStart) { this.commitLine(e.shiftKey); return; }

    if (this.patrolMode) { this.finishPatrol(e.clientX, e.clientY); return; }

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

    if (dbl && hit && !hit.b) {
      // select all same-type on screen
      this.selection.clear();
      for (const v of this.lastViews) {
        if (v.b || v.o !== me || v.t !== hit.t) continue;
        if (this.renderer.project(v.x, v.z, 0.5).ok) this.selection.add(v.i);
      }
      return;
    }
    if (dbl && hit && hit.b && ['barracks', 'factory', 'dronefac', 'airforce', 'shipyard'].includes(hit.t)) {
      // double-click a production building → set it primary for its type
      this.game.issue({ k: 'primary', p: me, bid: hit.i });
      this.selection.clear(); this.selection.add(hit.i);
      audio.play('confirm');
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
  private updateFog(allViews: any[]) {
    const f = this.fog!;
    for (let i = 0; i < f.length; i++) if (f[i] === 2) f[i] = 1;
    for (const v of allViews) {
      if (v.o !== this.game.me) continue;
      const def = (UNITS as any)[v.t] || (BUILDINGS as any)[v.t];
      const sight = v.b ? 7 : Math.max(5, (def?.range || 4) + 3);
      const cx = Math.floor(v.x), cz = Math.floor(v.z), r = Math.ceil(sight);
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > sight * sight) continue;
        const x = cx + dx, z = cz + dz;
        if (x >= 0 && z >= 0 && x < W && z < H) f[z * W + x] = 2;
      }
    }
  }

  // radar threat detection: with a powered Radar Dome, scan for enemy combat
  // units near the base (through fog) and warn — banner + minimap ping + klaxon
  private scanRadar(allViews: any[]) {
    const me = this.game.me;
    const players = this.game.players?.() || [];
    const myBuildings = allViews.filter(v => v.b && v.o === me);
    const hasRadar = myBuildings.some(v => v.t === 'radar' && (v.pr ?? 1) >= 1);
    const powered = !players[me] || (players[me].pm ?? 1) >= (players[me].pu ?? 0); // radar needs power
    const warn = document.getElementById('radarWarn');
    if (!hasRadar || !powered || !myBuildings.length) {
      this.radarBlips = [];
      if (warn && !warn.classList.contains('hidden')) warn.classList.add('hidden');
      return;
    }
    const RANGE = 24, RANGE2 = RANGE * RANGE;
    const threats: any[] = [];
    for (const v of allViews) {
      if (v.o === me || v.b) continue;
      if (!(UNITS[v.t]?.dmg > 0) && v.t !== 'fueltruck') continue; // only attackers
      let near = false;
      for (const b of myBuildings) if ((b.x - v.x) ** 2 + (b.z - v.z) ** 2 < RANGE2) { near = true; break; }
      if (near) threats.push(v);
    }
    this.radarBlips = threats;
    if (!threats.length) { if (warn && !warn.classList.contains('hidden')) warn.classList.add('hidden'); return; }
    // base centroid → bearing to the threat cluster, for a compass hint
    let bx = 0, bz = 0; for (const b of myBuildings) { bx += b.x; bz += b.z; }
    bx /= myBuildings.length; bz /= myBuildings.length;
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
    const S = g.isSim ? [0.5, 1, 2, 4, 8, 16, 32] : [0.5, 1, 2, 4, 8];
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

  private contextCommand(sx: number, sy: number, queue: boolean) {
    const me = this.game.me;
    const g = this.renderer.groundPoint(sx / window.innerWidth, sy / window.innerHeight);
    if (!g) return;

    // single selected production building → rally point (armed silo → LAUNCH)
    const sel = [...this.selection].map(id => this.byId.get(id)).filter(Boolean);
    if (sel.length === 1 && sel[0].b && sel[0].o === me) {
      if (sel[0].t === 'silo' && sel[0].ms) {
        this.game.issue({ k: 'launch', p: me, bid: sel[0].i, x: Math.round(g.x * 10) / 10, z: Math.round(g.z * 10) / 10 });
        audio.play('confirm');
        this.markCmd([sel[0].i], g.x, g.z, true);
        return;
      }
      this.game.issue({ k: 'rally', p: me, bid: sel[0].i, x: g.x, z: g.z });
      return;
    }
    const ids = this.myUnitIds();
    if (!ids.length) return;

    audio.play('confirm');
    // engineers: right-click a damaged friendly unit/building to repair it
    const hasEngineer = ids.some(id => this.byId.get(id)?.t === 'engineer');
    if (hasEngineer) {
      const friendly = this.pickView(sx, sy, v => v.o === me && v.h < v.m && !ids.includes(v.i));
      if (friendly) {
        this.game.issue({ k: 'repair', p: me, ids, tgt: friendly.i, q: queue });
        audio.ack('engineer', 'move');
        return;
      }
    }
    const enemy = this.pickView(sx, sy, v => v.o !== me);
    if (enemy) {
      this.game.issue({ k: 'attack', p: me, ids, tgt: enemy.i, x: enemy.x, z: enemy.z, q: queue });
      audio.ack(this.dominantType(ids), 'attack');
      this.markCmd(ids, enemy.x, enemy.z, true);
      return;
    }
    audio.ack(this.dominantType(ids), 'move');
    this.markCmd(ids, g.x, g.z, false);
    const cx = Math.floor(g.x), cz = Math.floor(g.z);
    if (this.game.map.inB(cx, cz) && this.game.map.ore[cz * W + cx] > 0) {
      this.game.issue({ k: 'harvest', p: me, ids, x: g.x, z: g.z, q: queue });
      return;
    }
    this.game.issue({ k: 'move', p: me, ids, x: g.x, z: g.z, q: queue });
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
      this.game.issue({ k: 'move', p: this.game.me, ids, x: end.x, z: end.z, q: queue });
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
    this.game.issue({ k: 'form', p: this.game.me, ids: ordered, xs, zs, q: queue });
    audio.play('confirm');
    audio.ack(this.dominantType(ordered), 'move');
  }

  private camQuad(): { x: number; z: number }[] {
    const pts = [[0.04, 0.08], [0.96, 0.08], [0.96, 0.92], [0.04, 0.92]];
    return pts.map(([nx, ny]) => this.renderer.groundPoint(nx, ny) || { x: this.renderer.camX, z: this.renderer.camZ });
  }

  private loop = (t: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (t - this.lastT) / 1000 || 0.016);
    this.lastT = t;

    this.game.update(dt * 1000);

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

    // right-drag: grab-the-world pan, or formation line drawing
    if (this.mouse.rDragging) {
      if (this.rMode === 'pan' && this.grab) {
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
      } else if (this.rMode === 'aatk' && this.areaDrag) {
        // attack circle grows with the drag
        const g = this.renderer.groundPoint(this.mouse.x / window.innerWidth, this.mouse.y / window.innerHeight);
        if (g) this.areaDrag.r = Math.min(14, Math.hypot(g.x - this.areaDrag.cx, g.z - this.areaDrag.cz));
      }
    }

    const allViews = this.game.views();
    // fog of war for human players (spectator/replay modes see everything;
    // disabled when the player unchecked it on the start screen)
    let views = allViews;
    if (!(this.game as any).isSim && fogEnabled) {
      if (!this.fog) this.fog = new Uint8Array(W * H);
      if (this.frame % 3 === 0) this.updateFog(allViews);
      const f = this.fog;
      views = allViews.filter(v => {
        if (v.o === this.game.me) return true;
        const fv = f[Math.floor(v.z) * W + Math.floor(v.x)] || 0;
        return v.b ? fv >= 1 : fv === 2; // buildings stay on the map once scouted
      });
      if (this.frame % 6 === 0) this.renderer.setFog(f);
    }
    if (!(this.game as any).isSim && this.frame % 6 === 0) this.scanRadar(allViews);
    this.lastViews = views;
    this.byId.clear();
    for (const v of views) this.byId.set(v.i, v);
    for (const id of this.selection) if (!this.byId.has(id)) this.selection.delete(id);

    this.renderer.updateViews(views, this.selection, dt);
    const evs = this.game.drainEvents();
    this.renderer.addEvents(evs);
    for (const ev of evs) {
      if (ev.e === 'boom' && ev.big) this.ui.ping(ev.x, ev.z);
      if (ev.e === 'surrender') {
        const who = this.game.players?.()[ev.p]?.n || 'Enemy';
        this.appendChat({ name: who, to: 'all', msg: 'We surrender! The region is yours.' });
      }
      if (ev.e === 'sdtick' && ev.owner === this.game.me) audio.play('sdbeep');
      audio.event(ev, this.renderer.camX, this.renderer.camZ, this.game.me);
    }
    // chat messages + expiry
    for (const m of (this.game.drainChat?.() || [])) { this.appendChat(m); audio.play('click'); }
    if (this.frame % 30 === 0) {
      const log = document.getElementById('chatLog')!;
      const now = performance.now();
      while (log.firstChild && now - Number((log.firstChild as any).dataset.t || 0) > 20000)
        log.removeChild(log.firstChild);
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
    } else {
      this.lineCells = [];
      this.lineStart = null;
      this.lastGhost = null;
      this.renderer.setGhost(false);
    }

    this.renderer.render(dt);

    const players = this.game.players();
    this.ui.update(this.game.me, players, views, this.game.tickN, this.selection);
    if (this.frame++ % 3 === 0) {
      const fogFn = (!(this.game as any).isSim && fogEnabled && this.fog) ? (cx: number, cz: number) => this.renderer.fogValue(cx, cz) : undefined;
      // radar-detected threats show on the minimap even through fog
      const mmViews = this.radarBlips.length ? views.concat(this.radarBlips) : views;
      this.ui.minimap(this.game.map, mmViews, this.camQuad(), dt * 3, fogFn);
    }
    const dragRect = this.mouse.dragging && !this.patrolMode // no selection box while drawing a patrol route
      ? { x0: this.mouse.downX, y0: this.mouse.downY, x1: this.mouse.x, y1: this.mouse.y }
      : null;

    // hovering an enemy with combat units selected → attack indicator
    let hover: { x: number; y: number } | null = null;
    const canvas3 = document.getElementById('three') as HTMLCanvasElement;
    if (!this.ui.placing && !this.patrolMode && !this.mouse.dragging && !this.mouse.rDragging
      && this.myUnitIds().length && this.frame % 2 === 0) {
      const enemy = this.pickView(this.mouse.x, this.mouse.y, v => v.o !== this.game.me);
      if (enemy) {
        const p = this.renderer.project(enemy.x, enemy.z, enemy.b ? 1 : 0.5);
        if (p.ok) hover = { x: p.x, y: p.y };
      }
      this.lastHover = hover;
    } else if (this.frame % 2 === 1) hover = this.lastHover;
    canvas3.style.cursor = hover ? 'crosshair' : '';

    // range/detection circles for the current selection
    const circles: { x: number; z: number; r: number; atk: boolean }[] = [];
    if (this.showRanges) {
      for (const id of this.selection) {
        const v = this.byId.get(id);
        if (!v) continue;
        let r = 0;
        if (v.b) { const a = BUILDINGS[v.t]?.attack; if (a) r = a.range + 0.8 * ((v.lv || 1) - 1); }
        else { const d = UNITS[v.t]; if (d && d.dmg > 0) r = d.range; }
        if (r > 0) circles.push({ x: v.x, z: v.z, r, atk: true });
      }
    }
    // live attack-circle while dragging an area target
    if (this.mouse.rDragging && this.rMode === 'aatk' && this.areaDrag && this.areaDrag.r > 0.5)
      circles.push({ x: this.areaDrag.cx, z: this.areaDrag.cz, r: this.areaDrag.r, atk: true, fill: true } as any);
    // age out command effects
    for (const f of this.cmdFx) f.t -= dt;
    this.cmdFx = this.cmdFx.filter(f => f.t > 0);

    this.ui.overlay(this.overlayCtx, this.renderer.project.bind(this.renderer), views, this.game.me, this.selection, dragRect, hover, circles, this.cmdFx);

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

    const st = this.game.status();
    // with multiple AIs the sim runs until ONE side remains; if the human is
    // wiped out first, call defeat immediately instead of forcing them to
    // spectate the survivors fight it out
    const meDead = !(this.game as any).isSim && players[this.game.me] && players[this.game.me].a === false;
    if ((st.over || meDead) && !this.over) {
      this.over = true;
      const wn = st.over && st.winner >= 0 && players[st.winner] ? players[st.winner].n
        : meDead ? (players.find((p: any, i: number) => i !== this.game.me && p.a)?.n || 'The enemy') : 'Nobody';
      this.onEnd(!meDead && st.winner === this.game.me, wn);
    }
  };
}

// ---------------- Menus ----------------
const $ = (id: string) => document.getElementById(id)!;
let selFaction = 'usa';
let selDiff = 1;
let selDiff2 = 2;
let selSize = 96;
let fogEnabled = true; // start-screen checkbox; spectator/replay always show all
let selEnemies = 1; // 1-3 AI opponents in skirmish
let selDiff3 = 2;   // third enemy's difficulty
let client: GameClient | null = null;
let net: Net | null = null;

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

function show(id: string) {
  for (const s of ['menu', 'lobby', 'endScreen']) $(s).classList.toggle('hidden', s !== id);
  if (id === 'menu') { rollCallsign(); renderAiIntel(); } // fresh name + AI study readout
}

// decode the AI's study profile into a human-readable intel panel on the menu
const KIND_NAMES: Record<string, string> = { inf: 'infantry', veh: 'vehicles', air: 'aircraft', sea: 'ships' };
function renderAiIntel() {
  const el = document.getElementById('aiIntel');
  if (!el) return;
  let p: any = null;
  try { p = JSON.parse(localStorage.getItem('ae_aiprofile') || 'null'); } catch { /* none */ }
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
    localStorage.removeItem('ae_aiprofile');
    renderAiIntel();
  });
}

// pre-fill the name box with a new random callsign whenever the menu appears —
// but never clobber a name the player typed themselves
function rollCallsign() {
  const inp = $('nameInput') as HTMLInputElement;
  const cur = (inp.value || '').trim();
  if (cur && !FUNNY_NAMES.includes(cur)) return;
  let pick = FUNNY_NAMES[Math.floor(Math.random() * FUNNY_NAMES.length)];
  if (pick === cur) pick = FUNNY_NAMES[(FUNNY_NAMES.indexOf(pick) + 1) % FUNNY_NAMES.length];
  inp.value = pick;
}
function hideAll() {
  for (const s of ['menu', 'lobby', 'endScreen']) $(s).classList.add('hidden');
}

function buildFactionCards() {
  const wrap = $('factionCards');
  wrap.innerHTML = '';
  for (const f of Object.values(FACTIONS)) {
    const c = document.createElement('div');
    c.className = 'fcard' + (f.id === selFaction ? ' sel' : '');
    c.innerHTML = `<div class="flag">${f.flag}</div><div class="fname">${f.name}</div><div class="fperk">${f.perk}</div>`;
    c.addEventListener('click', () => { selFaction = f.id; buildFactionCards(); });
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
      const p = JSON.parse(localStorage.getItem('ae_aiprofile') || 'null');
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
    el.textContent = speed + '× SPEED';
    el.classList.toggle('hidden', speed === 1);
  }
}

function startGame(game: GameLike) {
  if (client) { client.destroy(); client = null; }
  if (advisor) { advisor.stop(); advisor = null; }
  hideAll();
  audio.init();
  client = new GameClient(game, (won, winnerName) => {
    const isSim = (game as any).isSim;
    audio.play(won || isSim ? 'win' : 'lose');
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
        const prof = JSON.parse(localStorage.getItem('ae_aiprofile') || 'null');
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
    try {
      const prof = JSON.parse(localStorage.getItem('ae_aiprofile') || 'null');
      if (prof?.games) sub += ` The AI studied this match — ${prof.games} game${prof.games > 1 ? 's' : ''} learned.`;
    } catch { /* no profile */ }
    $('endSub').textContent = sub;
    show('endScreen');
  });
  // Claude strategist: local skirmish only (a shared directive would steer
  // BOTH sides of a simulation). Personal key if entered, else the proxy.
  if (game instanceof LocalGame && !game.isSim) {
    const key = (localStorage.getItem('ae_claude_key') || '').trim();
    advisor = new ClaudeAdvisor(game, key, taunt => client?.aiSays(taunt));
    advisor.start();
  }
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
  try { local = JSON.parse(localStorage.getItem('ae_aiprofile') || 'null'); } catch { /* none */ }
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
    const p = JSON.parse(localStorage.getItem('ae_aiprofile') || '{}');
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
      localStorage.setItem('ae_aiprofile', JSON.stringify(p));
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
    localStorage.setItem('ae_aiprofile', JSON.stringify(p));
  } catch { /* storage unavailable */ }
}

// post-mortem: ask Claude for ONE tactical lesson from this match; the lessons
// journal is fed back into the strategist's prompts in future games
async function requestLesson(r: any) {
  try {
    const key = (localStorage.getItem('ae_claude_key') || '').trim();
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
    const p = JSON.parse(localStorage.getItem('ae_aiprofile') || '{}');
    p.lessons = [...(p.lessons || []), lesson.slice(0, 160)].slice(-5);
    localStorage.setItem('ae_aiprofile', JSON.stringify(p));
  } catch { /* offline — no lesson this time */ }
}

async function connectNet(): Promise<Net> {
  const n = new Net();
  await n.connect();
  n.on('room', (m: any) => {
    $('roomCode').textContent = m.code;
    const list = $('lobbyPlayers');
    list.innerHTML = '';
    m.players.forEach((p: any, i: number) => {
      const colors = ['#3da5ff', '#ff5043', '#57d977', '#ffc940'];
      const row = document.createElement('div');
      row.className = 'lpRow';
      row.innerHTML = `<div class="lpDot" style="background:${colors[i]}"></div>
        <span>${FACTIONS[p.faction]?.flag || ''} ${p.name}</span>
        <span style="color:#78909c;font-size:12px">${i === 0 ? 'HOST' : ''}</span>`;
      list.appendChild(row);
    });
    $('btnStart').classList.toggle('hidden', m.you !== 0);
    show('lobby');
  });
  n.on('start', (m: any) => {
    setMapSize(m.size || 96);
    const g = new NetGame(n, m.seed, m.players.length, m.you, m.players);
    startGame(g);
  });
  n.on('err', (m: any) => { $('menuErr').textContent = m.msg || 'Server error'; show('menu'); });
  n.on('_close', () => {
    if (!client) { $('menuErr').textContent = 'Connection lost'; show('menu'); }
  });
  return n;
}

function initMenus() {
  buildFactionCards();
  // audio must be unlocked by a user gesture; init is idempotent
  document.addEventListener('pointerdown', () => audio.init());
  const muteBtn = $('muteBtn');
  const muteIcon = () => { muteBtn.textContent = audio.muted ? '\u{1F507}' : '\u{1F50A}'; };
  muteIcon();
  muteBtn.addEventListener('click', () => { audio.init(); audio.setMuted(!audio.muted); muteIcon(); });
  buildOptionRow('diffRow',
    [{ label: 'Easy', v: 0 }, { label: 'Normal', v: 1 }, { label: 'Hard', v: 2 }, { label: 'Brutal', v: 3 }],
    () => selDiff, v => { selDiff = v; });
  const LVLS = [{ label: 'Easy', v: 0 }, { label: 'Normal', v: 1 }, { label: 'Hard', v: 2 }, { label: 'Brutal', v: 3 }];
  buildOptionRow('enemyRow',
    [{ label: '1', v: 1 }, { label: '2', v: 2 }, { label: '3', v: 3 }],
    () => selEnemies, v => {
      selEnemies = v;
      $('diffRow2Wrap').classList.toggle('hidden', v < 2);
      $('diffRow3Wrap').classList.toggle('hidden', v < 3);
    });
  $('diffRow2Wrap').classList.toggle('hidden', selEnemies < 2);
  buildOptionRow('diffRow2', LVLS, () => selDiff2, v => { selDiff2 = v; });
  buildOptionRow('diffRow3', LVLS, () => selDiff3, v => { selDiff3 = v; });
  // audio settings: music style + volume sliders
  const musSel = $('musStyle') as HTMLSelectElement;
  musSel.value = audio.musicStyle;
  musSel.addEventListener('change', () => { audio.init(); audio.setMusicStyle(musSel.value); });
  const mv = $('musVol') as HTMLInputElement, sv = $('sfxVol') as HTMLInputElement;
  mv.value = String(Math.round(audio.musicVol * 100));
  sv.value = String(Math.round(audio.sfxVol * 100));
  mv.addEventListener('input', () => { audio.init(); audio.setMusicVol(+mv.value / 100); });
  sv.addEventListener('input', () => { audio.init(); audio.setSfxVol(+sv.value / 100); });
  buildOptionRow('sizeRow',
    [{ label: 'Small', v: 72 }, { label: 'Medium', v: 96 }, { label: 'Large', v: 128 }],
    () => selSize, v => { selSize = v; });
  $('btnSkirmish').addEventListener('click', () => {
    const key = (($('claudeKey') as HTMLInputElement).value || '').trim();
    try { localStorage.setItem('ae_claude_key', key); } catch { /* no storage */ }
    fogEnabled = ($('fogChk') as HTMLInputElement)?.checked ?? true;
    const levels = [selDiff, selDiff2, selDiff3].slice(0, selEnemies);
    startGame(new LocalGame(playerName(), selFaction, selDiff, selSize, null, levels));
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
          startGame(new ReplayGame(data));
        } catch { list.innerHTML = 'Replay could not be loaded.'; }
      }));
    } catch { list.innerHTML = 'Replays live on the game server — open the deployed site to browse them.'; }
  });
  $('btnCreate').addEventListener('click', async () => {
    $('menuErr').textContent = '';
    fogEnabled = ($('fogChk') as HTMLInputElement)?.checked ?? true; // per-client visual choice
    try {
      net = await connectNet();
      net.send({ t: 'create', name: playerName(), faction: selFaction, size: selSize, diff: selDiff });
    } catch (e: any) { $('menuErr').textContent = e.message + ' — is the Node server running?'; }
  });
  $('btnJoin').addEventListener('click', async () => {
    $('menuErr').textContent = '';
    fogEnabled = ($('fogChk') as HTMLInputElement)?.checked ?? true;
    const code = ($('joinCode') as HTMLInputElement).value.trim().toUpperCase();
    if (code.length !== 4) { $('menuErr').textContent = 'Enter a 4-letter room code'; return; }
    try {
      net = await connectNet();
      net.send({ t: 'join', code, name: playerName(), faction: selFaction });
    } catch (e: any) { $('menuErr').textContent = e.message + ' — is the Node server running?'; }
  });
  $('btnStart').addEventListener('click', () => net?.send({ t: 'start' }));
  $('btnLeave').addEventListener('click', () => { net?.close(); net = null; show('menu'); });
  $('btnAgain').addEventListener('click', () => location.reload());
  $('exitBtn').addEventListener('click', () => {
    if (!client) return;
    if (!confirm('Exit to main menu? The current game will end.')) return;
    simQueue = null; // cancel any queued simulation runs
    client.destroy(); client = null;
    if (net) { net.close(); net = null; }
    show('menu');
  });
}

// WebGL2 support gate (all modern browsers: Chrome/Edge 56+, Firefox 51+, Safari 15+)
const glOk = !!document.createElement('canvas').getContext('webgl2');
if (!glOk) {
  document.body.innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#ff5043;font-size:18px;text-align:center;padding:20px">' +
    'This game needs WebGL2.<br>Please use a current version of Chrome, Edge, Firefox, or Safari.</div>';
} else {
  initMenus();
  rollCallsign();
  renderAiIntel();
  syncIntelFromServer();
  try { ($('claudeKey') as HTMLInputElement).value = localStorage.getItem('ae_claude_key') || ''; } catch { /* no storage */ }
}
