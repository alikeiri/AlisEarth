// DOM HUD: top bar, build sidebar, minimap, overlay (health bars, drag box).

import { UNITS, BUILDINGS, FACTIONS, PLAYER_COLORS, AIRFIELD_HELI, AIRFIELD_PLANE, airSlotClass, UPG_MAX, upgCost, TECHS, dmgMul } from '../sim/data';
import { GameMap, W, H, SEA } from '../sim/map';
import { twemojify } from './twemoji';

// Range-ring geometry: a unit circle sampled once. Drawing a range ring then
// costs just 3 ground projections (centre + the two ground axes) and an affine
// sweep through this table, instead of projecting all 28 vertices every frame —
// so showing hundreds of ranges at once stays cheap (was the dominant overlay cost).
const RING_SEG = 28;
const RING_COS: number[] = [];
const RING_SIN: number[] = [];
for (let a = 0; a <= RING_SEG; a++) { const t = (a / RING_SEG) * Math.PI * 2; RING_COS.push(Math.cos(t)); RING_SIN.push(Math.sin(t)); }

const B_ICONS: Record<string, string> = {
  power: '⚡', refinery: '⛏️', barracks: '\u{1F396}️', factory: '\u{1F3ED}', turret: '\u{1F5FC}',
  dronefac: '\u{1F4E1}', sam: '\u{1F3AF}', shipyard: '⚓', airforce: '\u{2708}️', airfield: '\u{1F6EB}', lab: '\u{1F9EA}',
  silo: '\u{1F687}', radar: '\u{1F4F6}', wall: '\u{1F9F1}', barrier: '\u{1F6A7}',
  cannon: '\u{1F4A5}', tesla: '⚡', irondome: '\u{1F6E1}️',
};
const U_ICONS: Record<string, string> = {
  rifle: '\u{1FA96}', rocket: '\u{1F680}', melody: '\u{1F483}', tank: '\u{1F699}', heavy: '\u{1F69B}', ifv: '\u{1F6FB}', aatank: '\u{1F3AF}', flak: '\u{1F4A5}', harv: '\u{1F69C}', engineer: '\u{1F527}',
  fueltruck: '\u{1F6E2}️', cmissile: '\u{1F680}', bbmissile: '\u{1F4A3}', chemissile: '\u{2623}️',
  hive: '\u{1F41D}', recon: '\u{1F6F8}', strike: '\u{1F6F0}️', msldrone: '☄️', mlrs: '\u{1F9E8}',
  chemtrooper: '\u{2623}️', chemtank: '\u{2623}️', chemdrone: '\u{2623}️',
  biotrooper: '\u{2622}️', biotank: '\u{2622}️', biodrone: '\u{2622}️', stealthtank: '\u{1F977}',
  gunboat: '\u{1F6A4}', destroyer: '\u{1F6F3}️', sub: '\u{1F93F}', navdrone: '\u{1F6F6}',
  subhunter: '\u{1F42C}', mslcruiser: '\u{1F6A2}', flakship: '\u{1F387}', transport: '\u{26F4}️',
  fighter: '\u{1F6E9}️', bomber: '\u{1F4A3}', dbomber: '\u{1F916}', heli: '\u{1F681}', helidrone: '\u{1FA81}',
  mcv: '\u{1F3D7}️', dozer: '\u{1F69C}', patriot: '\u{1F6F0}️',
  tews: '\u{1F4E1}', navengineer: '\u{1F6E0}️', shahed: '\u{1F6F8}',
  mortar: '\u{1F4A3}', mortartrack: '\u{1F4A3}', fieldgun: '\u{1F4A5}', artillery: '\u{1F4A5}', artyship: '\u{1F4A5}', airtransport: '\u{1F681}',
  // faction signature units
  apoc: '\u{2620}️', shaheen: '\u{1F680}', brahmos: '\u{2604}️', gunship: '\u{1F4B0}',
  technical: '\u{1F3CE}️', mech: '\u{1F916}', silicondrone: '\u{1F4BB}', jungleraider: '\u{1F33F}',
  marine: '\u{2693}', hovertank: '\u{2744}️',
};
export const B_LIST = ['power', 'refinery', 'radar', 'barracks', 'factory', 'turret', 'sam', 'cannon', 'tesla', 'irondome', 'wall', 'barrier', 'dronefac', 'shipyard', 'airforce', 'airfield', 'lab', 'silo'];

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
export const U_LIST = ['rifle', 'rocket', 'mortar', 'fieldgun', 'melody', 'hive', 'tank', 'heavy', 'ifv', 'aatank', 'flak', 'patriot', 'fueltruck', 'harv', 'engineer', 'mcv', 'dozer', 'mortartrack', 'mlrs', 'artillery', 'recon', 'strike', 'msldrone', 'shahed',
  'tews', 'chemtrooper', 'chemtank', 'chemdrone', 'biotrooper', 'biotank', 'biodrone', 'stealthtank',
  'apoc', 'brahmos', 'gunship', 'technical', 'mech', 'silicondrone', 'jungleraider', 'marine', 'hovertank', 'shaheen',
  'gunboat', 'destroyer', 'artyship', 'sub', 'subhunter', 'mslcruiser', 'flakship', 'navdrone', 'navengineer', 'transport', 'airtransport', 'fighter', 'bomber', 'dbomber', 'heli', 'helidrone',
  'cmissile', 'bbmissile', 'chemissile'];

// strengths/weaknesses tooltip, derived from the live damage matrix so it can
// never drift out of sync with balance changes
// hand-written notes where the auto-derived categories can't tell the story
const TIP_NOTES: Record<string, string> = {
  flak: 'Excellent vs drones, poor vs airplanes',
  aatank: 'Dedicated anti-air missiles',
  mlrs: 'Cannot engage aircraft',
  mortar: 'Mortar Team (infantry): area splash that shreds massed infantry. Cheap, from the Barracks. Fragile, slow, no air defence.',
  mortartrack: 'Mortar Carrier (vehicle): a mobile, armoured self-propelled mortar — same anti-infantry splash as the Mortar Team but tougher and faster. From the War Factory. No air defence.',
  fieldgun: 'Field Gun (infantry): a towed howitzer crew — long-range siege splash from the Barracks, cheaper than the Artillery vehicle. Very fragile and slow. No air defence.',
  artillery: 'Artillery (vehicle): long-range siege gun with big area splash — breaks up clumped pushes and flattens bases. Fragile; outrange the enemy or get overrun. No air defence.',
  artyship: 'Artillery Cruiser: long-range naval bombardment with wide area splash. Shell coastal pushes and bases from offshore. No air defence.',
  turret: 'Cannot engage aircraft',
  fueltruck: 'Suicide truck: huge fireball, sets buildings ablaze (burn damage over time)',
  cmissile: 'Silo weapon — select the silo, right-click anywhere to launch',
  bbmissile: 'Silo weapon vs structures — select the silo, right-click to launch',
  chemissile: 'Silo weapon vs infantry — select the silo, right-click to launch',
  silo: 'Builds missiles. Select it, then right-click an area (or right-drag a circle) to bombard it — it keeps building & firing until the zone is clear. Right-click the silo to stop.',
  radar: 'Detects incoming enemy units near your base (through fog) and sounds an alert. Needs power.',
  wall: 'Cheap, tough wall that blocks movement. Click-drag on the map to lay a whole line at once.',
  barrier: 'Tank barrier: blocks vehicles and infantry. Click-drag to place a line of them.',
  cannon: 'Heavy Cannon: long-range, hard-hitting anti-armor emplacement. Outranges most attackers; cannot hit aircraft.',
  tesla: 'Tesla Coil: high-damage bolt that briefly EMP-freezes the unit it hits. Power-hungry; needs a Research Lab.',
  irondome: 'Iron Dome: shoots down incoming silo missiles aimed inside its shield. One kill per reload — a heavy salvo can still overwhelm a single dome. Needs a Radar Dome.',
  patriot: 'Patriot SAM: long-range air defence — shreds fighters, bombers and large drones, AND intercepts incoming silo missiles. Weak vs ground. Fortify (F) to dig in and deploy its own radar: wide vision + early-warning detection of incoming enemies.',
  engineer: 'Repairs units, builds roads, and lays proximity mines (press F to lay one from its stock of 4). Right-click an oil well to build an Oil Rig there (consumes the engineer) for steady passive income.',
  destroyer: 'Armored gun ship: duels other warships and bombards the coast. Its sonar also detects and depth-charges submarines.',
  sub: 'Submarine: cloaked until a sonar ship (Destroyer / Sub Hunter) pings it or you get very close. Devastating ambush torpedoes, but a thin hull.',
  subhunter: 'Sub Hunter: fast sonar escort that reveals and depth-charges submarines. Weak against everything else.',
  mslcruiser: 'Missile Cruiser: long-range shore bombardment — flattens coastal bases. Fragile hull; keep it screened.',
  flakship: 'Flak Cruiser: dedicated fleet air-defence. Shreds aircraft and drones, useless against ships.',
};
// plain-language descriptions for everything without a hand-written TIP_NOTE,
// so every build button has a real explanation (not just strong/weak lines)
const DESCRIPTIONS: Record<string, string> = {
  // buildings
  power: 'Power Plant: supplies power to the base. Build more as the power bar fills.',
  refinery: 'Ore Refinery: harvesters drop ore here for credits. Comes with a free harvester.',
  barracks: 'Barracks: trains infantry. Unlocks walls, barriers and defensive turrets.',
  factory: 'War Factory: builds vehicles — tanks, artillery, support, MCV.',
  turret: 'Defense Turret: anti-ground gun emplacement.',
  sam: 'Missile Battery: anti-air defense — downs planes and drones; weak vs ground.',
  dronefac: 'Drone Works: builds aerial drones (recon, strike, missile).',
  shipyard: 'Ship Factory: builds naval units. Place on the coast (needs water nearby).',
  airforce: 'Aircraft Plant: builds aircraft. Each plane needs an Airfield slot.',
  airfield: 'Airfield: parks and rearms aircraft; each one adds aircraft capacity.',
  lab: 'Research Lab: unlocks technologies (chem, bio, stealth) and the Missile Silo.',
  // units
  rifle: 'Rifle Squad: cheap infantry, strong vs other infantry. Can fortify (F).',
  rocket: 'Rocket Team: anti-armor infantry — cracks tanks and buildings, weak vs infantry.',
  melody: 'Melody: elite operative (one at a time). Sniper one-shots infantry at long range; right-click a vehicle to launch a homing drone at it; right-click a building to plant demolition charges. 25% faster than other infantry.',
  hive: 'Drone Hive: fortifies into a tower that launches swarms of suicide mini-drones.',
  tank: 'Battle Tank: the workhorse armored unit; duels other vehicles.',
  heavy: 'Heavy Tank: slow, heavily armored bruiser with big guns.',
  ifv: 'IFV: fast autocannon carrier — shreds infantry, can pepper aircraft.',
  harv: 'Harvester: gathers ore and returns it to a refinery. Unarmed.',
  shahed: 'Shahed (Iran): cheap one-way suicide drones, built in volleys of 5. They dive into the target and detonate — fragile, so send the swarm.',
  navengineer: 'Naval Engineer: repairs friendly ships (and coastal structures) out on the water. Unarmed. Right-click a damaged ship to repair; right-drag to set an auto-repair zone.',
  airtransport: 'Air Transport: carries up to 10 infantry (Melody included) over any terrain. Right-click it with infantry selected to load; press U to drop them. Unarmed — cloaks once Stealth Systems is researched.',
  tews: 'TEWS: jams enemy Radar Dome + Spy Satellite vision in a bubble (their units’ own eyes and Patriots still see). Pulses an area EMP that only damages drones.',
  mcv: 'Construction Vehicle: deploys (F) into a new Construction Yard for a forward base.',
  dozer: 'Bulldozer: reshapes terrain (T) — raise/lower ground, build land bridges.',
  recon: 'Recon Drone: cheap, fast scout with a light weapon and good vision.',
  strike: 'Strike Drone: anti-vehicle attack drone.',
  msldrone: 'Missile Drone: long-range anti-armor attack drone.',
  chemtrooper: 'Chem Trooper: gas infantry, devastating vs infantry.',
  chemtank: 'Chem Tank: sprays corrosive gas — strong vs infantry and buildings.',
  chemdrone: 'Chem Drone: airborne gas attacker.',
  biotrooper: 'Bio Trooper: viral infantry, brutal against other infantry.',
  biotank: 'Bio Tank: spreads bio-agents — strong vs infantry and buildings.',
  biodrone: 'Bio Drone: airborne bio attacker.',
  stealthtank: 'Stealth Tank: cloaked raider, invisible until it fires or you get close.',
  gunboat: 'Gunboat: cheap, fast warship for skirmishing and scouting the coast.',
  navdrone: 'Naval Drone: cheap, expendable sea drone.',
  fighter: 'Fighter: multi-role jet — owns the skies (hunts drones, aircraft and bombers) and can strafe ground units (infantry and light vehicles). Weak vs heavy armour and buildings; leave sieging to bombers.',
  bomber: 'Bomber: heavy payload vs buildings — flies over, drops its stick, returns to rearm.',
  dbomber: 'Drone Bomber: unmanned heavy bomber with a large payload.',
  heli: 'Helicopter: versatile gunship — rockets vs armor, guns vs infantry.',
  helidrone: 'Helidrone: cheap, light attack helicopter.',
  // faction signature units
  apoc: 'Apocalypse Tank (Russia): super-heavy twin-cannon tank — devastating against armor and buildings, brutally tough. Very slow and costly; screen it from aircraft and infantry.',
  shaheen: 'Shaheen Missile (Pakistan): a faction-exclusive ballistic missile — the heaviest warhead and widest blast in the game. Built and launched from the Missile Silo: select the silo and right-click a target.',
  brahmos: 'BrahMos Launcher (India): supersonic cruise-missile vehicle with extreme range and area splash — flattens bases and outranges all artillery. Fragile, slow, no air defence.',
  gunship: 'Mercenary Gunship (Gulf): premium hired attack helicopter — strong against vehicles and infantry. Expensive but hits hard. Uses an Airfield slot.',
  technical: 'Technical (African Union): dirt-cheap, very fast gun-truck — shreds infantry in swarms. Fragile and weak against armor; win with numbers.',
  mech: 'Combat Mech (South Korea): bipedal assault walker — tough, hits hard against vehicles and buildings. A durable spearhead.',
  silicondrone: 'Silicon Drone (Taiwan): cheap networked attack drones built three at a time — a flexible light swarm. Flak shreds them, so keep them moving.',
  jungleraider: 'Jungle Raider (Brazil): fast, cloaked ambush infantry — invisible until it strikes, lethal to other infantry. Weak against armor.',
  marine: 'Marine Raider (Argentina): amphibious assault infantry — crosses water on its own to land behind enemy lines. Strong vs infantry, no transport needed.',
  hovertank: 'Arctic Hover-Tank (Canada): amphibious hover tank — drives over land and water alike, tough and reliable. A mobile MBT that ignores shorelines.',
};

// flag-derived special-ability lines for a unit
function unitAbilities(u: any): string[] {
  const a: string[] = [];
  if (u.amphibious) a.push('Amphibious (crosses water)');
  if (u.fly) a.push('Flies over terrain');
  if (u.cloak) a.push('Cloaked / stealth');
  if (u.sonar) a.push(`Sonar ${u.sonar} (reveals submarines)`);
  if (u.siegeRange) a.push(`Cruise missiles vs buildings (range ${u.siegeRange})`);
  if (u.deploys) a.push(`Deploys (F) into a ${BUILDINGS[u.deploys]?.name || u.deploys}`);
  if (u.terra) a.push('Terraforms terrain (T)');
  if (u.repair) a.push('Repairs units & builds roads');
  if (u.lays) a.push(`Lays proximity mines (F, carries ${u.mines || 0})`);
  if (u.emits) a.push('Fortifies (F) → launches suicide drones');
  else if (u.fortify) a.push('Can fortify / dig in (F)');
  if (u.intercept) a.push('Intercepts incoming silo missiles');
  if (u.kamikaze || u.bombTruck) a.push('One-way: explodes on contact');
  if (u.payload) a.push(`Limited sorties (${u.payload}) — rearms at an airfield`);
  else if (u.pad) a.push('Needs an Airfield slot');
  if (u.cargo) a.push('Collects ore');
  if (u.tech) a.push(`Requires ${u.tech} research`);
  return a;
}

export function counterTip(t: string): string {
  const u = UNITS[t], b = BUILDINGS[t];
  const d: any = u || b;
  if (!d) return '';
  const lines: string[] = [];
  // 1. description
  if (TIP_NOTES[t]) lines.push(TIP_NOTES[t]);
  else if (DESCRIPTIONS[t]) lines.push(DESCRIPTIONS[t]);
  // 2. core stats
  if (u) {
    const s = [`HP ${u.hp}`];
    if (u.dmg > 0) s.push(`DMG ${u.dmg}`);
    if (u.range > 0) s.push(`Range ${u.range}`);
    if (u.speed) s.push(`Speed ${u.speed}`);
    lines.push(s.join(' · '));
    const ab = unitAbilities(u);
    if (ab.length) lines.push(ab.join(' · '));
  } else if (b) {
    const s = [`HP ${b.hp}`];
    if (b.attack) s.push(`DMG ${b.attack.dmg} · Range ${b.attack.range}`);
    if (b.intercept) s.push(`Intercept range ${b.intercept.range}`);
    s.push(b.power > 0 ? `+${b.power} power` : b.power < 0 ? `${b.power} power` : 'no power draw');
    lines.push(s.join(' · '));
    if (b.prereq) lines.push(`Requires: ${BUILDINGS[b.prereq]?.name || b.prereq}`);
  }
  // 3. strong / weak matrix (damage dealers only)
  const dmg = u ? (u.dmg || 0) : (b?.attack?.dmg || 0);
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
    if (strong.length) lines.push('Strong vs ' + strong.join(', '));
    if (weak.length) lines.push('Weak vs ' + weak.join(', '));
  }
  return lines.join('\n');
}

export class UI {
  private btns: Record<string, HTMLElement> = {};
  private mmCtx: CanvasRenderingContext2D;
  private terrainCache: HTMLCanvasElement | null = null;
  private terrainCacheVer = -1;                 // map.terraVersion the cache was built at
  private mmHp = new Map<number, number>();      // entity hp last minimap frame
  private mmFlash = new Map<number, number>();   // entity id -> flash time remaining (under attack)
  private pings: { x: number; z: number; t: number }[] = [];
  placing: string | null = null;

  private upgBtn: HTMLElement;
  private upgTarget = -1;
  private upgLastHtml = ''; // only rewrite the upgrade button when its text changes (per-frame innerHTML churn ate clicks)
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
    b.innerHTML = `<span class="ico">${twemojify(icon)}</span>${name}<span class="cost"></span><span class="badge hidden"></span><div class="prog"></div>`;
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

    // upgrade panel: one own, completed building selected (shows progress while
    // an upgrade is running, the upgrade button otherwise)
    this.upgTarget = -1;
    let upgShown = false, upgHtml = '';
    if (selection && selection.size === 1) {
      const id = [...selection][0];
      const v = views.find(x => x.i === id);
      if (v && v.b && v.o === me && v.t !== 'conyard' && v.t !== 'wall' && v.t !== 'barrier' && v.t !== 'oilrig') {
        if (v.up !== undefined) {
          // upgrade in progress — show a progress bar, no click (upgTarget stays -1)
          const pct = Math.round(v.up * 100);
          upgHtml = `⬆ Upgrading ${BUILDINGS[v.t].name}… ${pct}%<div class="prog" style="width:${pct}%"></div>`;
          this.upgBtn.classList.remove('noafford');
          upgShown = true;
        } else if (v.pr >= 1 && (v.lv || 1) < UPG_MAX) {
          const cost = upgCost(v.t, v.lv || 1, fac.costMul);
          this.upgTarget = id;
          const gain = UPG_INFO[v.t] || 'improved performance';
          upgHtml =
            `⬆ Upgrade ${BUILDINGS[v.t].name} → Lv${(v.lv || 1) + 1}  $${cost}` +
            `<span class="upgInfo">${gain} · +20% HP</span>`;
          this.upgBtn.classList.toggle('noafford', pl.c < cost);
          upgShown = true;
        }
      }
    }
    // only touch innerHTML when the text actually changes — rebuilding the button's
    // child nodes every frame was destroying clicks mid-press (needed re-clicking)
    if (upgHtml !== this.upgLastHtml) { this.upgBtn.innerHTML = upgHtml; this.upgLastHtml = upgHtml; }
    this.upgBtn.classList.toggle('hidden', !upgShown);

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
        ['barracks', 'factory', 'dronefac', 'airforce', 'shipyard', 'silo'].includes(v.t)) {
        this.rptTarget = id;
        this.rptState = !!v.rp;
        const label = v.t === 'silo' ? 'Auto-build missiles' : 'Repeat production';
        this.rptBtn.textContent = `⟳ ${label}: ${this.rptState ? 'ON' : 'OFF'}`;
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
          return `<div class="selChip" data-type="${t}" title="${(tip ? tip + '\n' : '')}Click to select only ${name}">${twemojify(icon)} <span class="n">${n}×</span> ${name}` +
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
        if (units.some(u => UNITS[u.t]?.repair)) parts.push(kbd('RMB', 'repair') + (units.some(u => UNITS[u.t]?.road) ? ' · ' + kbd('B', 'build road') : ''));
        if (units.some(u => u.t === 'hive')) parts.push(kbd('F', 'fortify / deploy'));
        if (units.some(u => u.t === 'mcv')) parts.push(kbd('F', 'deploy forward base'));
        if (units.some(u => u.t === 'dozer')) parts.push(kbd('T', 'terraform (drag an area, then mouse up/down sets height, click to build)'));
        const carrier = units.find(u => UNITS[u.t]?.carrier);
        if (carrier) parts.push(kbd('RMB', 'right-click units onto it to load') + ' · ' + kbd('U', `unload${carrier.cu ? ` (${carrier.cu} aboard)` : ''}`));
        parts.push(kbd('P', 'patrol'));
        const holding = units.some(u => u.st);
        parts.push(kbd('G', holding ? 'hold: ON' : 'hold position'));
        const looping = units.some(u => u.lp);
        parts.push(kbd('Shift+RMB', 'queue waypoints') + ' · ' + kbd('R', looping ? 'repeat: ON' : 'repeat route') + ' · ' + kbd('Shift', 'show route'));
        if (units.length >= 2) parts.push(kbd('RMB-drag', 'formation'));
        parts.push(kbd('X', 'stop') + ' · ' + kbd('C', 'ranges'));
        parts.push(kbd('Ctrl+#', 'group'));
      } else if (sel.length === 1 && sel[0].b && sel[0].o === me) {
        if (sel[0].t === 'silo') {
          const n = sel[0].msn || (sel[0].ms ? 1 : 0);
          parts.push(`<span class="kbd">${n}</span>missiles ready`);
          parts.push(kbd('RMB', 'launch / bombard area'));
          parts.push(kbd('R', sel[0].rp ? 'auto-build: ON' : 'auto-build missiles'));
        } else if (sel[0].gar) {
          parts.push(`<span class="kbd">${sel[0].cu || 0}/${sel[0].gcap || 0}</span>occupants`);
          if ((sel[0].cu || 0) > 0) parts.push(kbd('U', 'evacuate'));
        } else {
          if (['barracks', 'factory', 'dronefac', 'airforce', 'shipyard'].includes(sel[0].t)) {
            parts.push(kbd('RMB', 'set rally point'));
            parts.push(kbd('2×LMB', sel[0].pm ? 'primary ✓' : 'set primary'));
            parts.push(kbd('P', 'patrol route for produced units'));
            parts.push(kbd('R', 'repeat production'));
          }
          if (BUILDINGS[sel[0].t]?.attack) {
            parts.push(kbd('H', sel[0].hf ? 'hold fire: ON' : 'hold fire'));
            parts.push(kbd('Ctrl+RMB', 'force fire'));
          }
        }
        if (this.upgTarget >= 0) parts.push(kbd('⬆', 'upgrade (sidebar button)'));
      }
      if (parts.length) {
        ch.innerHTML = parts.join('<span class="sep">·</span>');
        ch.classList.remove('hidden');
      } else ch.classList.add('hidden');
    }
    document.getElementById('credits')!.textContent = String(pl.c);
    document.getElementById('facFlag')!.innerHTML = twemojify(fac.flag);
    document.getElementById('facName')!.textContent = fac.name;
    const secs = Math.floor(tickN / 10);
    document.getElementById('gameClock')!.textContent =
      `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    // power is a stored battery now: the bar fills with stored power out of the max
    // storage; the max is shown as the value to the right. Amber while draining
    // (draw exceeds generation), red when the store is empty.
    const bar = document.getElementById('powerbar')! as HTMLElement;
    const stored = (pl as any).pwr ?? 0, max = (pl as any).pmax ?? 0;
    bar.style.width = (max > 0 ? Math.min(100, (stored / max) * 100) : 0) + '%';
    bar.style.background = stored <= 0 ? 'var(--bad)' : pl.pu > pl.pm ? 'var(--accent)' : 'var(--good)';
    document.getElementById('powerTxt')!.textContent = `${stored} / ${max}`;

    // my completed buildings by type + unit queue info + airfield capacity
    const myDone: Record<string, number> = {};
    const queueByUnit: Record<string, { n: number; prog: number }> = {};
    const padHave: Record<string, number> = { heli: 0, plane: 0 };
    let airfields = 0;
    for (const v of views) {
      if (v.o !== me) continue;
      if (!v.b) { const c = airSlotClass(v.t); if (c === 'heli' || c === 'plane') padHave[c]++; continue; }
      if (v.pr >= 1) {
        myDone[v.t] = (myDone[v.t] || 0) + 1;
        if (v.t === 'airfield') airfields++;
      }
      if (v.qn > 0 && v.qq) {
        v.qq.forEach((ty: string, qi: number) => {
          const c = airSlotClass(ty); if (c === 'heli' || c === 'plane') padHave[c]++;
          const q = queueByUnit[ty] || { n: 0, prog: 0 };
          q.n++;
          if (qi === 0) q.prog = Math.max(q.prog, v.qt || 0); // only the head item is in production
          queueByUnit[ty] = q;
        });
      }
    }
    const credits = pl.c;
    const padCap: Record<string, number> = { heli: airfields * AIRFIELD_HELI, plane: airfields * AIRFIELD_PLANE };

    // When a single finished production building of mine is selected, focus the
    // sidebar on just that building's units: hide the Structures section and show
    // only units it can make. Picking a unit then queues it on THAT building, so
    // twin factories can each build something different. No selection → full menu.
    let prodFilter: string | null = null;
    if (selection && selection.size === 1) {
      const v = views.find(x => x.i === [...selection][0]);
      if (v && v.b && v.o === me && v.pr >= 1 &&
        ['barracks', 'factory', 'dronefac', 'airforce', 'shipyard', 'silo'].includes(v.t))
        prodFilter = v.t;
    }
    const hdrB = document.getElementById('hdrB'), gridB = document.getElementById('gridB');
    const hdrU = document.getElementById('hdrU');
    hdrB?.classList.toggle('hidden', !!prodFilter);
    gridB?.classList.toggle('hidden', !!prodFilter);
    if (hdrU) hdrU.textContent = prodFilter ? BUILDINGS[prodFilter].name : 'Units';

    for (const t of B_LIST) {
      const def = BUILDINGS[t];
      const cost = Math.round(def.cost * fac.costMul);
      const ok = (myDone['conyard'] || 0) > 0 && (!def.prereq || (myDone[def.prereq] || 0) > 0);
      this.styleBtn(t, ok, credits >= cost, cost, 0, 0);
    }
    const god = !!(pl as any).god; // godmode cheat: unlock every unit regardless of tech
    const myTech: Record<string, boolean> = {};
    for (const tch of (pl.tech || [])) myTech[tch] = true;
    // tally my live units so one-per-player heroes/uniques can grey out
    const aliveByUnit: Record<string, number> = {};
    for (const v of views) if (!v.b && v.o === me) aliveByUnit[v.t] = (aliveByUnit[v.t] || 0) + 1;
    for (const t of U_LIST) {
      const def = UNITS[t];
      const cost = Math.round(def.cost * fac.costMul);
      let ok = (myDone[def.builtAt] || 0) > 0 || (def.altBuiltAt ? (myDone[def.altBuiltAt] || 0) > 0 : false);
      const padCls = airSlotClass(t);
      if (ok && (padCls === 'heli' || padCls === 'plane') && padHave[padCls] >= padCap[padCls]) ok = false; // that class's airfield slots are full
      let uniqueBlocked = false;
      if (ok && (def.unique || def.commando) && ((aliveByUnit[t] || 0) + (queueByUnit[t]?.n || 0)) >= 1) { ok = false; uniqueBlocked = true; } // one per player
      if (def.tech && !myTech[def.tech] && !god) ok = false;      // not yet researched (godmode unlocks all)
      if (def.faction && def.faction !== pl.f && !god) ok = false; // another faction's signature unit
      // hide tech-gated / wrong-faction buttons, and (when a production building
      // is selected) any unit that building can't make
      const techHidden = !!def.tech && !myTech[def.tech] && !god;
      const facHidden = !!def.faction && def.faction !== pl.f && !god;
      const filtHidden = !!prodFilter && def.builtAt !== prodFilter && def.altBuiltAt !== prodFilter;
      this.btns[t].classList.toggle('hidden', techHidden || facHidden || filtHidden);
      const q = queueByUnit[t];
      this.styleBtn(t, ok, credits >= cost, cost, q?.n || 0, q?.prog || 0);
      if (def.pad) {
        const tip = counterTip(t);
        const capStr = (padCls === 'heli' || padCls === 'plane')
          ? `Airfield ${padCls} slots ${padHave[padCls]}/${padCap[padCls]}`
          : 'Unlimited — no airfield slot';
        this.btns[t].title = capStr + (tip ? '\n' + tip : '');
      } else if (uniqueBlocked) {
        this.btns[t].title = `${def.name}: only one per player at a time`;
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
      const labLow = !!tch.minLab && (lab.lv || 1) < tch.minLab;   // lab not upgraded enough
      const dis = done || busy || pl.c < cost || labLow;
      sig += `|${id}:${done ? 'd' : dis ? 'x' : 'o'}${labLow ? 'L' : ''}`;
      const note = labLow ? ` <span style="color:#ff9a6a">(needs L${tch.minLab} lab)</span>` : '';
      html += `<div class="rpBtn${done ? ' done' : ''}${dis && !done ? ' dis' : ''}" data-tech="${id}">` +
        `${tch.name} ${done ? '✓' : '$' + cost}${note}<span class="rpDesc">${tch.desc}</span></div>`;
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
    // rebuild the cached terrain image when bulldozing has reshaped the ground
    if (this.terrainCache && map.terraVersion !== this.terrainCacheVer) this.terrainCache = null;
    this.terrainCacheVer = map.terraVersion;
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
          ctx.fillStyle = map.oil[cz * W + cx] === 1 ? '#2a2a33' : map.gem[cz * W + cx] === 1 ? '#3ee8e0' : '#d9a520';
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
    // detect entities that just took damage → flash them on the minimap
    const newHp = new Map<number, number>();
    for (const v of views) {
      const prev = this.mmHp.get(v.i);
      if (prev !== undefined && v.h < prev - 0.5) this.mmFlash.set(v.i, 1.0); // 1s flash
      newHp.set(v.i, v.h);
    }
    this.mmHp = newHp;
    for (const [id, t] of this.mmFlash) { const nt = t - dt; if (nt <= 0) this.mmFlash.delete(id); else this.mmFlash.set(id, nt); }
    // entities (already fog-filtered by the caller's view list)
    for (const v of views) {
      ctx.fillStyle = '#' + (PLAYER_COLORS[v.o] ?? 0xffffff).toString(16).padStart(6, '0');
      const s = v.b ? 4 : 2.2;
      ctx.fillRect(mx(v.x) - s / 2, my(v.z) - s / 2, s, s);
      // under-attack flash: a pulsing red marker over the unit/building
      const fl = this.mmFlash.get(v.i);
      if (fl !== undefined) {
        const pulse = 0.35 + 0.55 * Math.abs(Math.sin(fl * 14));
        ctx.fillStyle = `rgba(255,70,55,${pulse})`;
        const s2 = (v.b ? 6 : 4);
        ctx.fillRect(mx(v.x) - s2 / 2, my(v.z) - s2 / 2, s2, s2);
      }
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

    // range/detection circles: a ground circle projects to an ellipse, which we
    // approximate from the centre and the two ground-axis directions (3 projects
    // per ring instead of one per vertex) — cheap enough for hundreds at once
    if (circles) {
      for (const c of circles) {
        const ctr = project(c.x, c.z, 0.2);
        const pu = project(c.x + 1, c.z, 0.2); // +1 along ground X
        const pv = project(c.x, c.z + 1, 0.2); // +1 along ground Z
        const anyOk = ctr.ok && pu.ok && pv.ok;
        if (anyOk) {
          // screen vectors for one ground unit, scaled to the ring radius
          const axx = (pu.x - ctr.x) * c.r, axy = (pu.y - ctr.y) * c.r;
          const azx = (pv.x - ctr.x) * c.r, azy = (pv.y - ctr.y) * c.r;
          ctx.beginPath();
          for (let a = 0; a <= RING_SEG; a++) {
            const x = ctr.x + RING_COS[a] * axx + RING_SIN[a] * azx;
            const y = ctr.y + RING_COS[a] * axy + RING_SIN[a] * azy;
            if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          const prev = (c as any).preview;
          const kind = (c as any).kind;
          if ((c as any).fill) { // area-attack / strike circle: filled for visibility
            ctx.closePath();
            ctx.fillStyle = prev ? 'rgba(255,200,60,0.14)' : 'rgba(255,90,70,0.18)';
            ctx.fill();
          }
          // sonar bubble = blue, placement max-range preview = green, else red attack
          ctx.strokeStyle = kind === 'sonar' ? 'rgba(80,170,255,0.7)'
            : kind === 'place' ? 'rgba(110,230,140,0.9)'
            : prev ? 'rgba(255,200,60,0.85)' : 'rgba(255,90,70,0.5)';
          ctx.lineWidth = (c as any).fill ? 2 : 1.4;
          ctx.setLineDash([5, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
          // crosshair at the centre so the aim point is unmistakable
          if (prev || (c as any).fill) {
            {
              ctx.strokeStyle = prev ? 'rgba(255,210,90,0.95)' : 'rgba(255,110,90,0.9)';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(ctr.x - 8, ctr.y); ctx.lineTo(ctr.x + 8, ctr.y);
              ctx.moveTo(ctr.x, ctr.y - 8); ctx.lineTo(ctr.x, ctr.y + 8);
              ctx.stroke();
            }
          }
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
      // walls and tank barriers only ever show a bar while actually damaged —
      // no clutter from selecting them or their (brief) construction
      if (v.t === 'wall' || v.t === 'barrier') { if (!damaged) continue; }
      else if (!damaged && !constructing && !selection.has(v.i)) continue;
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
    // cargo progress bar above my harvesters / oil miners while they're working —
    // fills (gold) as they gather, turns green when full, empties on unload
    for (const v of views) {
      if (v.cg === undefined || v.o !== me) continue;
      if (!v.hv && v.cg <= 0) continue;          // only while harvesting / carrying
      const p = project(v.x, v.z, 1.7);
      if (!p.ok) continue;
      const w = 22, frac = Math.max(0, Math.min(1, v.cg));
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(p.x - w / 2 - 1, p.y - 4, w + 2, 5);
      ctx.fillStyle = frac >= 1 ? '#57d977' : '#e0ad28';
      ctx.fillRect(p.x - w / 2, p.y - 3, w * frac, 3);
    }
    // garrison indicator: a marker above any building infantry can move into, so
    // garrisonable structures are easy to spot. Green = open, grey = full.
    for (const v of views) {
      if (!v.gar) continue;
      const enterable = v.ne === 1 || v.o === me;   // neutral/open or already ours
      if (!enterable) continue;
      const p = project(v.x, v.z, (v.sz || 2) >= 3 ? 4.4 : 3.4);
      if (!p.ok) continue;
      const cu = v.cu || 0, cap = v.gcap || 0, full = cu >= cap;
      const label = `${cu}/${cap}`;
      ctx.font = '700 11px system-ui,sans-serif';
      const tw = Math.ceil(ctx.measureText(label).width) + 18;
      const x0 = p.x - tw / 2, y0 = p.y - 16, h = 15;
      ctx.fillStyle = full ? 'rgba(60,66,72,0.9)' : 'rgba(28,120,52,0.92)';
      ctx.beginPath();
      (ctx as any).roundRect ? (ctx as any).roundRect(x0, y0, tw, h, 4) : ctx.rect(x0, y0, tw, h);
      ctx.fill();
      // a little doorway glyph on the left
      ctx.fillStyle = full ? '#aab2ba' : '#cdfdd9';
      ctx.fillRect(x0 + 4, y0 + 3, 6, 9);
      ctx.fillStyle = full ? 'rgba(60,66,72,0.92)' : 'rgba(28,120,52,0.95)';
      ctx.fillRect(x0 + 6, y0 + 6, 3, 6);
      // count text
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, p.x + 5, y0 + h / 2 + 0.5);
      // pin pointing down at the building
      ctx.fillStyle = full ? 'rgba(60,66,72,0.9)' : 'rgba(28,120,52,0.92)';
      ctx.beginPath(); ctx.moveTo(p.x - 4, y0 + h); ctx.lineTo(p.x + 4, y0 + h); ctx.lineTo(p.x, y0 + h + 5); ctx.closePath(); ctx.fill();
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    // "packing up" indicator: a pulsing amber up-chevron above any unit that is
    // un-fortifying (pulling up stakes), so it reads clearly as leaving its dig-in
    {
      const pulse = (0.5 + 0.5 * Math.abs(Math.sin(performance.now() / 280))).toFixed(2);
      for (const v of views) {
        if (v.ft !== 2) continue;
        const p = project(v.x, v.z, 1.7);
        if (!p.ok) continue;
        ctx.strokeStyle = `rgba(255,190,70,${pulse})`;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(p.x - 6, p.y + 1); ctx.lineTo(p.x, p.y - 5); ctx.lineTo(p.x + 6, p.y + 1);
        ctx.moveTo(p.x - 6, p.y + 6); ctx.lineTo(p.x, p.y); ctx.lineTo(p.x + 6, p.y + 6);
        ctx.stroke();
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
