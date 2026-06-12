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
  private pending: any[] = [];
  private acc = 0;
  private evQ: any[] = [];
  private reportSaved = false;

  constructor(name: string, faction: string, aiLvl = 1, size = 96) {
    setMapSize(size);
    const aiFacs = Object.keys(FACTIONS).filter(f => f !== faction);
    const aiFac = aiFacs[Math.floor(Math.random() * aiFacs.length)];
    const seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
    const lvlName = ['Easy', 'Normal', 'Hard', 'Brutal'][aiLvl] || 'Normal';
    this.sim = new Sim(seed, [
      { name, faction },
      { name: `AI ${FACTIONS[aiFac].name} (${lvlName})`, faction: aiFac, isAI: true, aiLvl },
    ]);
    // the AI studies past games against this player and adapts its strategy
    try { this.sim.aiProfile = JSON.parse(localStorage.getItem('ae_aiprofile') || 'null'); } catch { /* fresh AI */ }
  }
  get map() { return this.sim.map; }
  get tickN() { return this.sim.tickN; }
  issue(cmd: any) { this.pending.push(cmd); }
  update(dtMs: number) {
    this.acc += dtMs;
    let guard = 0;
    while (this.acc >= 100 && guard < 6) {
      this.acc -= 100; guard++;
      const cmds = this.pending; this.pending = [];
      this.sim.players.forEach((pl, i) => { if (pl.isAI) cmds.push(...aiTick(this.sim, i)); });
      this.sim.tick(cmds);
      for (const ev of this.sim.events) {
        if (ev.e === 'aiReport' && !this.reportSaved) { this.reportSaved = true; saveAiReport(ev.r); }
      }
      this.evQ.push(...this.sim.events);
    }
    if (guard >= 6) this.acc = 0; // tab was backgrounded — drop the backlog
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
      } else {
        if (e.stance) v.st = e.stance;
        if (e.fortified) v.fo = 1;
        if (UNITS[e.t]?.cloak || UNITS[e.type]?.cloak) v.ck = 1;
        if (e.cd > 0 && UNITS[e.type]?.dmg > 0) {
          v.fr = 1; // firing — drives infantry aim pose
          if (e.aimX !== undefined) { v.ax = e.aimX; v.az = e.aimZ; } // turn toward the target
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
  status() { return this.sim.done ? { over: true, winner: this.sim.winner } : { over: false, winner: -2 }; }
  leave() {}
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
  const s = BUILDINGS[type].size;
  for (let z = cz; z < cz + s; z++)
    for (let x = cx; x < cx + s; x++)
      if (!map.inB(x, z) || map.tBlocked[z * W + x]) return false;
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
  private rMode: 'pan' | 'form' | 'aatk' = 'pan';
  private formPath: { x: number; z: number }[] | null = null;
  private areaDrag: { cx: number; cz: number; r: number } | null = null;
  private patrolMode = false;
  private patrolDraw: { x: number; z: number }[] | null = null;
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
    on(canvas, 'wheel', (e: WheelEvent) => { e.preventDefault(); this.renderer.zoomBy(e.deltaY > 0 ? 1.12 : 0.89); }, { passive: false });
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
      // C: toggle range/detection circles on selected units & buildings
      if (e.code === 'KeyC') this.showRanges = !this.showRanges;
      // F: fortify / unfortify selected Drone Hives
      if (e.code === 'KeyF') {
        const hives = this.myUnitIds().filter(id => this.byId.get(id)?.t === 'hive');
        if (hives.length) { this.game.issue({ k: 'fortify', p: this.game.me, ids: hives }); audio.play('confirm'); }
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

    this.sizeOverlay();
    this.lastT = performance.now();
    (window as any).__fe = this; // debug/testing handle
    this.loop(this.lastT);
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

  private onDown(e: MouseEvent) {
    if (e.button === 0) {
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
      if (this.ui.placing) { this.ui.setPlacing(null); return; }
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

    if (this.patrolMode) {
      this.mouse.dragging = false;
      let pts = this.patrolDraw || [];
      this.patrolDraw = null;
      this.patrolMode = false;
      this.renderer.setFormationPath(null);
      const g = this.renderer.groundPoint(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
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
        audio.play('confirm');
        audio.ack(this.dominantType(ids), 'move');
      } else if (pts.length) {
        // no units selected: assign the route to the selected production building
        const pb = this.selectedProdBuilding();
        if (pb) {
          this.game.issue({ k: 'bpatrol', p: me, bid: pb.i, pts: rounded });
          audio.play('confirm');
        }
      }
      return;
    }

    if (this.mouse.dragging) {
      this.mouse.dragging = false;
      const x0 = Math.min(this.mouse.downX, e.clientX), x1 = Math.max(this.mouse.downX, e.clientX);
      const y0 = Math.min(this.mouse.downY, e.clientY), y1 = Math.max(this.mouse.downY, e.clientY);
      if (!e.shiftKey) this.selection.clear();
      const boxed: any[] = [];
      for (const v of this.lastViews) {
        if (v.b || v.o !== me) continue;
        const p = this.renderer.project(v.x, v.z, 0.5);
        if (p.ok && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) boxed.push(v);
      }
      // mixed box-select drops harvesters; harvesters select only among themselves
      const combat = boxed.filter(v => v.t !== 'harv');
      for (const v of (combat.length ? combat : boxed)) this.selection.add(v.i);
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

    // single selected production building → rally point
    const sel = [...this.selection].map(id => this.byId.get(id)).filter(Boolean);
    if (sel.length === 1 && sel[0].b && sel[0].o === me) {
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

    const views = this.game.views();
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

    // building ghost
    if (this.ui.placing) {
      const g = this.renderer.groundPoint(this.mouse.x / window.innerWidth, this.mouse.y / window.innerHeight);
      if (g) {
        const s = BUILDINGS[this.ui.placing].size;
        const cx = Math.max(0, Math.min(W - s, Math.round(g.x - s / 2)));
        const cz = Math.max(0, Math.min(H - s, Math.round(g.z - s / 2)));
        const ok = canPlaceClient(this.game.map, views, this.game.me, this.ui.placing, cx, cz);
        this.lastGhost = { cx, cz, ok };
        this.renderer.setGhost(true, this.ui.placing, cx, cz, ok);
      }
    } else {
      this.lastGhost = null;
      this.renderer.setGhost(false);
    }

    this.renderer.render(dt);

    const players = this.game.players();
    this.ui.update(this.game.me, players, views, this.game.tickN, this.selection);
    if (this.frame++ % 3 === 0) this.ui.minimap(this.game.map, views, this.camQuad(), dt * 3);
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
      circles.push({ x: this.areaDrag.cx, z: this.areaDrag.cz, r: this.areaDrag.r, atk: true });
    // age out command effects
    for (const f of this.cmdFx) f.t -= dt;
    this.cmdFx = this.cmdFx.filter(f => f.t > 0);

    this.ui.overlay(this.overlayCtx, this.renderer.project.bind(this.renderer), views, this.game.me, this.selection, dragRect, hover, circles, this.cmdFx);

    const st = this.game.status();
    if (st.over && !this.over) {
      this.over = true;
      const wn = st.winner >= 0 && players[st.winner] ? players[st.winner].n : 'Nobody';
      this.onEnd(st.winner === this.game.me, wn);
    }
  };
}

// ---------------- Menus ----------------
const $ = (id: string) => document.getElementById(id)!;
let selFaction = 'usa';
let selDiff = 1;
let selSize = 96;
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
  if (id === 'menu') rollCallsign(); // fresh funny name for the next game
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

function startGame(game: GameLike) {
  if (client) { client.destroy(); client = null; }
  hideAll();
  audio.init();
  client = new GameClient(game, (won, winnerName) => {
    audio.play(won ? 'win' : 'lose');
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
function saveAiReport(r: any) {
  try {
    const p = JSON.parse(localStorage.getItem('ae_aiprofile') || '{}');
    p.games = (p.games || 0) + 1;
    if (r.aiWon) { p.aiWins = (p.aiWins || 0) + 1; p.lossStreak = 0; }
    else p.lossStreak = (p.lossStreak || 0) + 1;
    if (r.rushSec) p.rushTimes = [...(p.rushTimes || []), r.rushSec].slice(-7);
    const d = p.dmg || { inf: 0, veh: 0, air: 0, sea: 0 };
    for (const k of ['inf', 'veh', 'air', 'sea'])
      d[k] = Math.round((d[k] || 0) * 0.7 + (r.dmg?.[k] || 0)); // recency-weighted
    p.dmg = d;
    localStorage.setItem('ae_aiprofile', JSON.stringify(p));
  } catch { /* storage unavailable */ }
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
  buildOptionRow('sizeRow',
    [{ label: 'Small', v: 72 }, { label: 'Medium', v: 96 }, { label: 'Large', v: 128 }],
    () => selSize, v => { selSize = v; });
  $('btnSkirmish').addEventListener('click', () => {
    startGame(new LocalGame(playerName(), selFaction, selDiff, selSize));
  });
  $('btnCreate').addEventListener('click', async () => {
    $('menuErr').textContent = '';
    try {
      net = await connectNet();
      net.send({ t: 'create', name: playerName(), faction: selFaction, size: selSize, diff: selDiff });
    } catch (e: any) { $('menuErr').textContent = e.message + ' — is the Node server running?'; }
  });
  $('btnJoin').addEventListener('click', async () => {
    $('menuErr').textContent = '';
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
}
