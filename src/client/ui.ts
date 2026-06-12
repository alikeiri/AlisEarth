// DOM HUD: top bar, build sidebar, minimap, overlay (health bars, drag box).

import { UNITS, BUILDINGS, FACTIONS, PLAYER_COLORS, AIRFIELD_CAP, UPG_MAX, upgCost, TECHS, dmgMul } from '../sim/data';
import { GameMap, W, H, SEA } from '../sim/map';

const B_ICONS: Record<string, string> = {
  power: '⚡', refinery: '⛏️', barracks: '\u{1F396}️', factory: '\u{1F3ED}', turret: '\u{1F5FC}',
  dronefac: '\u{1F4E1}', sam: '\u{1F3AF}', shipyard: '⚓', airforce: '\u{2708}️', airfield: '\u{1F6EB}', lab: '\u{1F9EA}',
  silo: '\u{1F687}', radar: '\u{1F4F6}', wall: '\u{1F9F1}', barrier: '\u{1F6A7}',
};
const U_ICONS: Record<string, string> = {
  rifle: '\u{1FA96}', rocket: '\u{1F680}', tank: '\u{1F699}', heavy: '\u{1F69B}', ifv: '\u{1F6FB}', aatank: '\u{1F3AF}', flak: '\u{1F4A5}', harv: '\u{1F69C}', engineer: '\u{1F527}',
  fueltruck: '\u{1F6E2}️', cmissile: '\u{1F680}', bbmissile: '\u{1F4A3}', chemissile: '\u{2623}️',
  hive: '\u{1F41D}', recon: '\u{1F6F8}', strike: '\u{1F6F0}️', msldrone: '☄️', mlrs: '\u{1F9E8}',
  chemtrooper: '\u{2623}️', chemtank: '\u{2623}️', chemdrone: '\u{2623}️',
  biotrooper: '\u{2622}️', biotank: '\u{2622}️', biodrone: '\u{2622}️', stealthtank: '\u{1F977}',
  gunboat: '\u{1F6A4}', destroyer: '\u{1F6F3}️', sub: '\u{1F93F}', navdrone: '\u{1F6F6}',
  fighter: '\u{1F6E9}️', bomber: '\u{1F4A3}', dbomber: '\u{1F916}', heli: '\u{1F681}', helidrone: '\u{1FA81}',
};
export const B_LIST = ['power', 'refinery', 'radar', 'barracks', 'factory', 'turret', 'sam', 'wall', 'barrier', 'dronefac', 'shipyard', 'airforce', 'airfield', 'lab', 'silo'];

// what each building gains per upgrade level (mirrors the sim's effects)
const UPG_INFO: Record<string, string> = {
  power: '+50% power output',
  refinery: '+10% delivery income',
  turret: '+25% damage, +0.8 range',
  sam: '+25% damage, +0.8 range',
  airfield: '+2 aircraft capacity',
  barracks: '+25% production speed',
  factory: '+25% production speed',
  dronefac: '+25% production speed',
  airforce: '+25% production speed',
  shipyard: '+25% production speed',
};
export const U_LIST = ['rifle', 'rocket', 'hive', 'tank', 'heavy', 'ifv', 'aatank', 'flak', 'fueltruck', 'harv', 'engineer', 'mlrs', 'recon', 'strike', 'msldrone',
  'chemtrooper', 'chemtank', 'chemdrone', 'biotrooper', 'biotank', 'biodrone', 'stealthtank',
  'gunboat', 'destroyer', 'sub', 'navdrone', 'fighter', 'bomber', 'dbomber', 'heli', 'helidrone',
  'cmissile', 'bbmissile', 'chemissile'];

// strengths/weaknesses tooltip, derived from the live damage matrix so it can
// never drift out of sync with balance changes
// hand-written notes where the auto-derived categories can't tell the story
const TIP_NOTES: Record<string, string> = {
  flak: 'Excellent vs drones, poor vs airplanes',
  aatank: 'Dedicated anti-air missiles',
  mlrs: 'Cannot engage aircraft',
  turret: 'Cannot engage aircraft',
  fueltruck: 'Suicide truck: huge fireball, sets buildings ablaze (burn damage over time)',
  cmissile: 'Silo weapon — select the silo, right-click anywhere to launch',
  bbmissile: 'Silo weapon vs structures — select the silo, right-click to launch',
  chemissile: 'Silo weapon vs infantry — select the silo, right-click to launch',
  silo: 'Builds missiles; select with an armed missile and right-click a target to launch',
  radar: 'Detects incoming enemy units near your base (through fog) and sounds an alert. Needs power.',
  wall: 'Cheap, tough wall segment that blocks all movement. Chain them into defensive lines.',
  barrier: 'Tank barrier: blocks ground vehicles and infantry, cheaper than a wall.',
};
export function counterTip(t: string): string {
  const d = UNITS[t] || BUILDINGS[t];
  if (!d) return '';
  const lines: string[] = [];
  if (TIP_NOTES[t]) lines.push(TIP_NOTES[t]);
  const dmg = (d as any).dmg ?? (d as any).attack?.dmg ?? 0;
  if (dmg > 0) {
    const cats: [string, boolean, string][] = [
      ['infantry', false, 'inf'], ['vehicles', false, 'veh'], ['aircraft', false, 'air'],
      ['ships', false, 'sea'], ['buildings', true, 'b'],
    ];
    const strong: string[] = [], weak: string[] = [];
    for (const [label, isB, kind] of cats) {
      const m = dmgMul(t, isB, kind);
      if (m >= 1.3) strong.push(label);
      else if (m <= 0.7) weak.push(label);
    }
    if ((d as any).kamikaze) lines.push('One-way suicide drone');
    if (strong.length) lines.push('Strong vs ' + strong.join(', '));
    if (weak.length) lines.push('Weak vs ' + weak.join(', '));
    if (!strong.length && !weak.length) lines.push('All-round weapon');
  } else if ((d as any).cargo) lines.push('Collects ore — no weapons');
  else if ((d as any).repair) lines.push('Repairs units, builds roads — no weapons');
  else if ((d as any).emits) lines.push('Fortifies, then launches suicide drones');
  return lines.join('\n');
}

export class UI {
  private btns: Record<string, HTMLElement> = {};
  private mmCtx: CanvasRenderingContext2D;
  private terrainCache: HTMLCanvasElement | null = null;
  private pings: { x: number; z: number; t: number }[] = [];
  placing: string | null = null;

  private upgBtn: HTMLElement;
  private upgTarget = -1;
  private selSummary = '';
  private selTargetBid = -1;
  private rptBtn: HTMLElement;
  private rptTarget = -1;
  private rptState = false;

  constructor(
    private onBuild: (t: string) => void,
    private onTrain: (t: string) => void,
    private onMinimapJump: (x: number, z: number) => void,
    private onCancelTrain: (t: string) => void = () => {},
    private onUpgrade: (bid: number) => void = () => {},
    private onRepeat: (bid: number, on: boolean) => void = () => {},
    private onFilterType: (t: string) => void = () => {},
    private onResearch: (bid: number, tech: string) => void = () => {},
  ) {
    this.mmCtx = (document.getElementById('minimap') as HTMLCanvasElement).getContext('2d')!;
    const sidebar = document.getElementById('sidebar')!;
    let ub = document.getElementById('upgBtn');
    if (!ub) {
      ub = document.createElement('div');
      ub.id = 'upgBtn';
      sidebar.insertBefore(ub, sidebar.firstChild);
    }
    this.upgBtn = ub;
    this.upgBtn.classList.add('hidden');
    const upgClick = () => { if (this.upgTarget >= 0) this.onUpgrade(this.upgTarget); };
    this.upgBtn.addEventListener('click', upgClick);
    this.cleanups.push(() => this.upgBtn.removeEventListener('click', upgClick));
    let rb = document.getElementById('rptBtn');
    if (!rb) {
      rb = document.createElement('div');
      rb.id = 'rptBtn';
      sidebar.insertBefore(rb, ub.nextSibling);
    }
    this.rptBtn = rb;
    this.rptBtn.classList.add('hidden');
    const rptClick = () => { if (this.rptTarget >= 0) this.onRepeat(this.rptTarget, !this.rptState); };
    this.rptBtn.addEventListener('click', rptClick);
    this.cleanups.push(() => this.rptBtn.removeEventListener('click', rptClick));
    let rp = document.getElementById('researchPanel');
    if (!rp) { rp = document.createElement('div'); rp.id = 'researchPanel'; document.body.appendChild(rp); }
    this.researchPanel = rp;
    this.researchPanel.classList.add('hidden');
    // mousedown, not click: the panel re-renders while researching, and a
    // click never fires if the pressed element was replaced before mouseup
    const rpClick = (e: Event) => {
      const el = (e.target as HTMLElement).closest('.rpBtn') as HTMLElement | null;
      if (el && !el.classList.contains('done') && !el.classList.contains('dis') && this.selTargetBid >= 0)
        this.onResearch(this.selTargetBid, el.getAttribute('data-tech')!);
    };
    rp.addEventListener('mousedown', rpClick);
    this.cleanups.push(() => rp!.removeEventListener('mousedown', rpClick));
    // selection overview: click a chip to filter the selection to that type
    const sp = document.getElementById('selPanel')!;
    const chipClick = (e: Event) => {
      const t = (e.target as HTMLElement).closest('.selChip')?.getAttribute('data-type');
      if (t) this.onFilterType(t);
    };
    sp.addEventListener('click', chipClick);
    this.cleanups.push(() => sp.removeEventListener('click', chipClick));
    const gb = document.getElementById('gridB')!, gu = document.getElementById('gridU')!;
    gb.innerHTML = ''; gu.innerHTML = '';   // a fresh game rebuilds the sidebar
    for (const t of B_LIST) {
      gb.appendChild(this.makeBtn(t, BUILDINGS[t].name, B_ICONS[t], () => this.onBuild(t)));
      const tip = counterTip(t);
      if (tip) this.btns[t].title = tip;
    }
    for (const t of U_LIST) {
      gu.appendChild(this.makeBtn(t, UNITS[t].name, U_ICONS[t], () => this.onTrain(t), () => this.onCancelTrain(t)));
      const tip = counterTip(t);
      if (tip) this.btns[t].title = tip;
    }
    const sb = document.getElementById('sidebar')!;
    const noMenu = (e: Event) => e.preventDefault();
    sb.addEventListener('contextmenu', noMenu);
    this.cleanups.push(() => sb.removeEventListener('contextmenu', noMenu));
    const mm = document.getElementById('minimap')!;
    let mmDown = false;
    const jump = (ev: MouseEvent) => {
      const r = mm.getBoundingClientRect();
      // minimap is flipped on BOTH axes to match the camera's ground orientation
      this.onMinimapJump((1 - (ev.clientX - r.left) / r.width) * W, (1 - (ev.clientY - r.top) / r.height) * H);
    };
    const onDown = (e: MouseEvent) => { if (e.button === 0) { mmDown = true; jump(e); } };
    const onMove = (e: MouseEvent) => { if (mmDown) jump(e); };
    const onUp = () => { mmDown = false; };
    mm.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    this.cleanups.push(() => {
      mm.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    });
  }

  private cleanups: (() => void)[] = [];
  destroy() { for (const c of this.cleanups) c(); }

  private makeBtn(key: string, name: string, icon: string, fn: () => void, ctxFn?: () => void): HTMLElement {
    const b = document.createElement('div');
    b.className = 'bbtn';
    b.id = 'btn_' + key;
    b.innerHTML = `<span class="ico">${icon}</span>${name}<span class="cost"></span><span class="badge hidden"></span><div class="prog"></div>`;
    b.addEventListener('click', fn);
    if (ctxFn) b.addEventListener('contextmenu', e => { e.preventDefault(); ctxFn(); });
    this.btns[key] = b;
    return b;
  }

  setHudVisible(v: boolean) {
    document.getElementById('hud')!.classList.toggle('hidden', !v);
    if (!v) {
      document.getElementById('cmdHints')?.classList.add('hidden');
      document.getElementById('selPanel')?.classList.add('hidden');
    }
  }

  setPlacing(t: string | null) {
    this.placing = t;
    for (const k of B_LIST) this.btns[k].classList.toggle('placing', k === t);
  }

  update(me: number, players: any[], views: any[], tickN: number, selection?: Set<number>) {
    const pl = players[me];
    if (!pl) return;
    const fac = FACTIONS[pl.f] || FACTIONS.usa;

    // upgrade panel: one own, completed, upgradable building selected
    this.upgTarget = -1;
    if (selection && selection.size === 1) {
      const id = [...selection][0];
      const v = views.find(x => x.i === id);
      if (v && v.b && v.o === me && v.pr >= 1 && v.t !== 'conyard' && (v.lv || 1) < UPG_MAX) {
        const cost = upgCost(v.t, v.lv || 1, fac.costMul);
        this.upgTarget = id;
        const gain = UPG_INFO[v.t] || 'improved performance';
        this.upgBtn.innerHTML =
          `⬆ Upgrade ${BUILDINGS[v.t].name} → Lv${(v.lv || 1) + 1}  $${cost}` +
          `<span class="upgInfo">${gain} · +20% HP</span>`;
        this.upgBtn.classList.toggle('noafford', pl.c < cost);
      }
    }
    this.upgBtn.classList.toggle('hidden', this.upgTarget < 0);

    // track single selected building (for the research panel)
    this.selTargetBid = -1;
    if (selection && selection.size === 1) {
      const id = [...selection][0];
      const v = views.find(x => x.i === id);
      if (v && v.b && v.o === me) this.selTargetBid = id;
    }

    // repeat-production toggle for the selected production building
    this.rptTarget = -1;
    if (selection && selection.size === 1) {
      const id = [...selection][0];
      const v = views.find(x => x.i === id);
      if (v && v.b && v.o === me && v.pr >= 1 &&
        ['barracks', 'factory', 'dronefac', 'airforce', 'shipyard'].includes(v.t)) {
        this.rptTarget = id;
        this.rptState = !!v.rp;
        this.rptBtn.textContent = `⟳ Repeat production: ${this.rptState ? 'ON' : 'OFF'}`;
        this.rptBtn.classList.toggle('on', this.rptState);
      }
    }
    this.rptBtn.classList.toggle('hidden', this.rptTarget < 0);

    // selection overview: "3× Rifle Squad · 4× Battle Tank" chips
    const sp = document.getElementById('selPanel')!;
    if (!selection || selection.size < 2) {
      sp.classList.add('hidden');
      this.selSummary = '';
    } else {
      const counts: Record<string, number> = {};
      const hp: Record<string, { h: number; m: number }> = {};
      for (const v of views) {
        if (!selection.has(v.i)) continue;
        const key = v.b ? BUILDINGS[v.t]?.name : UNITS[v.t]?.name;
        if (!key) continue;
        counts[v.t] = (counts[v.t] || 0) + 1;
        const rec = hp[v.t] || { h: 0, m: 0 };
        rec.h += v.h; rec.m += v.m;
        hp[v.t] = rec;
      }
      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const summary = entries.map(([t, n]) => t + n).join('|');
      if (summary !== this.selSummary) {
        this.selSummary = summary;
        sp.innerHTML = entries.map(([t, n]) => {
          const name = UNITS[t]?.name || BUILDINGS[t]?.name || t;
          const icon = U_ICONS[t] || B_ICONS[t] || '';
          const tip = counterTip(t);
          return `<div class="selChip" data-type="${t}" title="${(tip ? tip + '\n' : '')}Click to select only ${name}">${icon} <span class="n">${n}×</span> ${name}` +
            `<div class="chipHp"><div class="chipHpFill"></div></div></div>`;
        }).join('');
      }
      // live aggregate health bar per type (triage which group to pull back)
      for (const chip of sp.children) {
        const t = (chip as HTMLElement).getAttribute('data-type')!;
        const rec = hp[t];
        const fill = (chip as HTMLElement).querySelector('.chipHpFill') as HTMLElement | null;
        if (fill && rec) {
          const f = Math.max(0, Math.min(1, rec.h / Math.max(1, rec.m)));
          fill.style.width = (f * 100).toFixed(0) + '%';
          fill.style.background = f > 0.5 ? 'var(--good)' : f > 0.25 ? 'var(--accent)' : 'var(--bad)';
        }
      }
      sp.classList.toggle('hidden', entries.length === 0);
    }

    // contextual keyboard/mouse hints for the current selection
    const ch = document.getElementById('cmdHints')!;
    if (!selection || selection.size === 0) ch.classList.add('hidden');
    else {
      const sel = views.filter(v => selection.has(v.i));
      const units = sel.filter(v => !v.b);
      const parts: string[] = [];
      const kbd = (k: string, label: string) => `<span class="kbd">${k}</span>${label}`;
      if (units.length) {
        parts.push(kbd('RMB', 'move / attack' + (units.some(u => u.t === 'harv') ? ' / harvest' : '')));
        if (units.some(u => u.t === 'engineer')) parts.push(kbd('RMB', 'repair') + ' · ' + kbd('B', 'build road'));
        if (units.some(u => u.t === 'hive')) parts.push(kbd('F', 'fortify / deploy'));
        parts.push(kbd('P', 'patrol'));
        const holding = units.some(u => u.st);
        parts.push(kbd('G', holding ? 'hold: ON' : 'hold position'));
        if (units.length >= 2) parts.push(kbd('RMB-drag', 'formation'));
        parts.push(kbd('H', 'stop') + ' · ' + kbd('C', 'ranges'));
        parts.push(kbd('Ctrl+#', 'group'));
      } else if (sel.length === 1 && sel[0].b && sel[0].o === me) {
        parts.push(kbd('RMB', 'set rally point'));
        if (['barracks', 'factory', 'dronefac', 'airforce', 'shipyard'].includes(sel[0].t))
          parts.push(kbd('2×LMB', sel[0].pm ? 'primary ✓' : 'set primary'));
        if (['barracks', 'factory', 'dronefac', 'airforce', 'shipyard'].includes(sel[0].t)) {
          parts.push(kbd('P', 'patrol route for produced units'));
          parts.push(kbd('R', 'repeat production'));
        }
        if (this.upgTarget >= 0) parts.push(kbd('⬆', 'upgrade (sidebar button)'));
      }
      if (parts.length) {
        ch.innerHTML = parts.join('<span class="sep">·</span>');
        ch.classList.remove('hidden');
      } else ch.classList.add('hidden');
    }
    document.getElementById('credits')!.textContent = String(pl.c);
    document.getElementById('facFlag')!.textContent = fac.flag;
    document.getElementById('facName')!.textContent = fac.name;
    const secs = Math.floor(tickN / 10);
    document.getElementById('gameClock')!.textContent =
      `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    const bar = document.getElementById('powerbar')! as HTMLElement;
    const ratio = pl.pm > 0 ? pl.pu / pl.pm : 1;
    bar.style.width = Math.min(100, ratio * 100) + '%';
    bar.style.background = ratio > 1 ? 'var(--bad)' : ratio > 0.8 ? 'var(--accent)' : 'var(--good)';
    document.getElementById('powerTxt')!.textContent = `${pl.pu}/${pl.pm}`;

    // my completed buildings by type + unit queue info + airfield capacity
    const myDone: Record<string, number> = {};
    const queueByUnit: Record<string, { n: number; prog: number }> = {};
    let padHave = 0, padCap = 0;
    for (const v of views) {
      if (v.o !== me) continue;
      if (!v.b) { if (UNITS[v.t]?.pad) padHave++; continue; }
      if (v.pr >= 1) {
        myDone[v.t] = (myDone[v.t] || 0) + 1;
        if (v.t === 'airfield') padCap += AIRFIELD_CAP(v.lv || 1);
      }
      if (v.qn > 0 && v.qq) {
        v.qq.forEach((ty: string, qi: number) => {
          if (UNITS[ty]?.pad) padHave++;
          const q = queueByUnit[ty] || { n: 0, prog: 0 };
          q.n++;
          if (qi === 0) q.prog = Math.max(q.prog, v.qt || 0); // only the head item is in production
          queueByUnit[ty] = q;
        });
      }
    }
    const credits = pl.c;
    for (const t of B_LIST) {
      const def = BUILDINGS[t];
      const cost = Math.round(def.cost * fac.costMul);
      const ok = (myDone['conyard'] || 0) > 0 && (!def.prereq || (myDone[def.prereq] || 0) > 0);
      this.styleBtn(t, ok, credits >= cost, cost, 0, 0);
    }
    const myTech: Record<string, boolean> = {};
    for (const tch of (pl.tech || [])) myTech[tch] = true;
    for (const t of U_LIST) {
      const def = UNITS[t];
      const cost = Math.round(def.cost * fac.costMul);
      let ok = (myDone[def.builtAt] || 0) > 0;
      if (ok && def.pad && padHave >= padCap) ok = false; // airfields full
      if (def.tech && !myTech[def.tech]) ok = false;      // not yet researched
      // hide tech-gated buttons entirely until the tech exists
      this.btns[t].classList.toggle('hidden', !!def.tech && !myTech[def.tech]);
      const q = queueByUnit[t];
      this.styleBtn(t, ok, credits >= cost, cost, q?.n || 0, q?.prog || 0);
      if (def.pad) {
        const tip = counterTip(t);
        this.btns[t].title = `Airfield capacity ${padHave}/${padCap}` + (tip ? '\n' + tip : '');
      }
    }
    this.updateResearchPanel(views, me, pl, fac, myTech);
  }

  private researchPanel: HTMLElement | null = null;
  private rpSig = '';
  private updateResearchPanel(views: any[], me: number, pl: any, fac: any, myTech: Record<string, boolean>) {
    let lab: any = null;
    if (this.selTargetBid >= 0) lab = views.find(v => v.i === this.selTargetBid && v.t === 'lab');
    const panel = this.researchPanel!;
    if (!lab || lab.o !== me || lab.pr < 1) { panel.classList.add('hidden'); this.rpSig = ''; return; }
    panel.classList.remove('hidden');
    const busy = !!lab.rs;
    let html = `<div class="rpTitle">Research Lab</div>`;
    if (busy) {
      const tname = TECHS[lab.rs]?.name || lab.rs;
      html += `<div class="rpBusy">Researching ${tname}… ${Math.round((lab.rsf || 0) * 100)}%</div>`;
    }
    let sig = `${lab.i}|${lab.rs || ''}|${busy ? Math.round((lab.rsf || 0) * 50) : ''}`;
    for (const id of Object.keys(TECHS)) {
      const tch = TECHS[id];
      const done = myTech[id];
      const cost = Math.round(tch.cost * fac.costMul);
      const dis = done || busy || pl.c < cost;
      sig += `|${id}:${done ? 'd' : dis ? 'x' : 'o'}`;
      html += `<div class="rpBtn${done ? ' done' : ''}${dis && !done ? ' dis' : ''}" data-tech="${id}">` +
        `${tch.name} ${done ? '✓' : '$' + cost}<span class="rpDesc">${tch.desc}</span></div>`;
    }
    // only touch the DOM when something actually changed — rewriting innerHTML
    // every frame replaced the buttons mid-press, eating every click
    if (sig !== this.rpSig) { this.rpSig = sig; panel.innerHTML = html; }
  }

  private styleBtn(t: string, enabled: boolean, afford: boolean, cost: number, badge: number, prog: number) {
    const b = this.btns[t];
    b.classList.toggle('disabled', !enabled);
    b.classList.toggle('noafford', enabled && !afford);
    (b.querySelector('.cost') as HTMLElement).textContent = '$' + cost;
    const bd = b.querySelector('.badge') as HTMLElement;
    bd.classList.toggle('hidden', badge <= 0);
    bd.textContent = String(badge);
    (b.querySelector('.prog') as HTMLElement).style.width = (prog * 100) + '%';
  }

  ping(x: number, z: number) { this.pings.push({ x, z, t: 1.2 }); }

  minimap(map: GameMap, views: any[], camQuad: { x: number; z: number }[] | null, dt: number, fog?: (cx: number, cz: number) => number) {
    const ctx = this.mmCtx;
    if (!this.terrainCache) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const tc = c.getContext('2d')!;
      const img = tc.createImageData(W, H);
      for (let cz = 0; cz < H; cz++) {
        for (let cx = 0; cx < W; cx++) {
          // flip both axes so the minimap matches the camera view's orientation
          // (the camera's ground basis is mirrored relative to raw world axes)
          const i = ((H - 1 - cz) * W + (W - 1 - cx)) * 4;
          const h = map.cellH(cx, cz);
          let r = 70, g = 110, b = 60;
          if (h < SEA + 0.05) { r = 28; g = 60; b = 92; }
          else if (map.forest[cz * W + cx]) { r = 34; g = 66; b = 36; }
          else if (map.tBlocked[cz * W + cx]) { r = 105; g = 102; b = 95; }
          else if (h > 5.5) { r = 110; g = 120; b = 85; }
          const shade = 0.85 + Math.min(0.3, Math.max(0, h - SEA) * 0.04);
          img.data[i] = r * shade; img.data[i + 1] = g * shade; img.data[i + 2] = b * shade; img.data[i + 3] = 255;
        }
      }
      tc.putImageData(img, 0, 0);
      this.terrainCache = c;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.terrainCache, 0, 0, 200, 200);
    const sx = 200 / W, sz = 200 / H;
    const mx = (x: number) => (W - x) * sx; // both axes flipped to match the view
    const my = (z: number) => (H - z) * sz;
    // ore (gold) and crystal fields (cyan)
    for (let cz = 0; cz < H; cz++)
      for (let cx = 0; cx < W; cx++)
        if (map.ore[cz * W + cx] > 0) {
          ctx.fillStyle = map.gem[cz * W + cx] === 1 ? '#3ee8e0' : '#d9a520';
          ctx.fillRect(mx(cx + 1), my(cz + 1), 1.6, 1.6);
        }
    // fog overlay (drawn over terrain+ore, under entities the player can see)
    if (fog) {
      for (let cz = 0; cz < H; cz++) for (let cx = 0; cx < W; cx++) {
        const fv = fog(cx, cz);
        if (fv === 2) continue;
        ctx.fillStyle = fv === 1 ? 'rgba(5,8,12,0.45)' : 'rgba(5,8,12,0.92)';
        ctx.fillRect(mx(cx + 1), my(cz + 1), sx + 1, sz + 1);
      }
    }
    // entities (already fog-filtered by the caller's view list)
    for (const v of views) {
      ctx.fillStyle = '#' + (PLAYER_COLORS[v.o] ?? 0xffffff).toString(16).padStart(6, '0');
      const s = v.b ? 4 : 2.2;
      ctx.fillRect(mx(v.x) - s / 2, my(v.z) - s / 2, s, s);
    }
    // pings
    this.pings = this.pings.filter(p => (p.t -= dt) > 0);
    for (const p of this.pings) {
      ctx.strokeStyle = `rgba(255,80,60,${p.t / 1.2})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(mx(p.x), my(p.z), (1.2 - p.t) * 14 + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    // camera quad
    if (camQuad) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      camQuad.forEach((p, i) => {
        const px = mx(p.x), pz = my(p.z);
        i === 0 ? ctx.moveTo(px, pz) : ctx.lineTo(px, pz);
      });
      ctx.closePath();
      ctx.stroke();
    }
  }

  overlay(
    ctx: CanvasRenderingContext2D,
    project: (x: number, z: number, yOff?: number) => { x: number; y: number; ok: boolean },
    views: any[], me: number, selection: Set<number>,
    dragRect: { x0: number; y0: number; x1: number; y1: number } | null,
    hover?: { x: number; y: number } | null,
    circles?: { x: number; z: number; r: number; atk: boolean }[],
    cmdFx?: { fx: number; fz: number; tx: number; tz: number; t: number; atk: boolean }[],
  ) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    // range/detection circles: project 28 ground points into a polygon
    if (circles) {
      for (const c of circles) {
        ctx.beginPath();
        let started = false, anyOk = false;
        for (let a = 0; a <= 28; a++) {
          const ang = (a / 28) * Math.PI * 2;
          const p = project(c.x + Math.cos(ang) * c.r, c.z + Math.sin(ang) * c.r, 0.2);
          if (!p.ok) { started = false; continue; }
          anyOk = true;
          if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
        }
        if (anyOk) {
          if ((c as any).fill) { // area-attack circle: filled for visibility
            ctx.closePath();
            ctx.fillStyle = 'rgba(255,90,70,0.18)';
            ctx.fill();
          }
          ctx.strokeStyle = 'rgba(255,90,70,0.5)';
          ctx.lineWidth = (c as any).fill ? 2 : 1.4;
          ctx.setLineDash([5, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // transient move/attack destination markers + lines
    if (cmdFx) {
      for (const f of cmdFx) {
        const a = f.t;
        const pf = project(f.fx, f.fz, 0.3), pt = project(f.tx, f.tz, 0.3);
        if (!pt.ok) continue;
        const col = f.atk ? `rgba(255,70,50,${a * 0.7})` : `rgba(106,255,106,${a * 0.7})`;
        if (pf.ok) {
          ctx.strokeStyle = col; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(pf.x, pf.y); ctx.lineTo(pt.x, pt.y); ctx.stroke();
        }
        const r = 5 + (1 - a) * 8;
        ctx.strokeStyle = f.atk ? `rgba(255,70,50,${a})` : `rgba(106,255,106,${a})`;
        ctx.lineWidth = 2;
        if (f.atk) { // X for attack, ring for move
          ctx.beginPath();
          ctx.moveTo(pt.x - r, pt.y - r); ctx.lineTo(pt.x + r, pt.y + r);
          ctx.moveTo(pt.x + r, pt.y - r); ctx.lineTo(pt.x - r, pt.y + r);
          ctx.stroke();
        } else { ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2); ctx.stroke(); }
      }
    }

    // single selected unit → floating name label
    if (selection.size === 1) {
      const v = views.find(x => selection.has(x.i));
      if (v && !v.b) {
        const name = UNITS[v.t]?.name;
        if (name) {
          const p = project(v.x, v.z, 1.5);
          if (p.ok) {
            ctx.font = '12px "Segoe UI", sans-serif';
            ctx.textAlign = 'center';
            const w = ctx.measureText(name).width + 12;
            ctx.fillStyle = 'rgba(10,14,18,0.8)';
            ctx.fillRect(p.x - w / 2, p.y - 26, w, 16);
            ctx.fillStyle = '#eceff1';
            ctx.fillText(name, p.x, p.y - 14);
            ctx.textAlign = 'left';
          }
        }
      }
    }
    // self-destruct countdown over arming units
    for (const v of views) {
      if (v.b || !v.sd) continue;
      const p = project(v.x, v.z, 1.7);
      if (!p.ok) continue;
      const blink = (performance.now() / 250 | 0) % 2 === 0;
      ctx.font = 'bold 17px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = blink ? '#ff3b30' : '#ffb0a0';
      ctx.fillText('☠ ' + v.sd, p.x, p.y - 16);
      ctx.textAlign = 'left';
    }
    // attack indicator: pulsing bullseye over the hovered enemy
    if (hover) {
      const t = performance.now() / 1000;
      const r = 14 + Math.sin(t * 6) * 2.5;
      ctx.strokeStyle = 'rgba(255,70,50,0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hover.x, hover.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(hover.x, hover.y, r * 0.45, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.moveTo(hover.x + dx * (r - 4), hover.y + dy * (r - 4));
        ctx.lineTo(hover.x + dx * (r + 6), hover.y + dy * (r + 6));
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,70,50,0.95)';
      ctx.beginPath(); ctx.arc(hover.x, hover.y, 2, 0, Math.PI * 2); ctx.fill();
    }
    for (const v of views) {
      const damaged = v.h < v.m;
      const constructing = v.b && v.pr < 1;
      if (!damaged && !constructing && !selection.has(v.i)) continue;
      const p = project(v.x, v.z, v.b ? 2.4 : 1.25);
      if (!p.ok) continue;
      const w = v.b ? 36 : 22;
      const frac = Math.max(0, v.h / v.m);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(p.x - w / 2 - 1, p.y - 4, w + 2, 5);
      ctx.fillStyle = frac > 0.5 ? '#57d977' : frac > 0.25 ? '#ffc940' : '#ff5043';
      ctx.fillRect(p.x - w / 2, p.y - 3, w * frac, 3);
      if (constructing) {
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(p.x - w / 2 - 1, p.y + 2, w + 2, 4);
        ctx.fillStyle = '#3da5ff';
        ctx.fillRect(p.x - w / 2, p.y + 3, w * Math.min(1, v.pr), 2);
      }
    }
    if (dragRect) {
      ctx.strokeStyle = 'rgba(106,255,106,0.9)';
      ctx.fillStyle = 'rgba(106,255,106,0.08)';
      ctx.lineWidth = 1;
      const x = Math.min(dragRect.x0, dragRect.x1), y = Math.min(dragRect.y0, dragRect.y1);
      const w = Math.abs(dragRect.x1 - dragRect.x0), h = Math.abs(dragRect.y1 - dragRect.y0);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
  }
}
