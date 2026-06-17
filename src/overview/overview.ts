// Standalone "Unit Overview" reference page: Buildings + Units tables (with a
// faction filter) and a Unit-vs-Unit counter matrix. Pulls straight from the
// shared game data (src/sim/data) so it never drifts from the live balance.
import { UNITS, BUILDINGS, FACTIONS, dmgMul } from '../sim/data';

const F = (id?: string) => (id && (FACTIONS as any)[id]?.name) || 'All';
const KIND: Record<string, string> = { inf: 'Infantry', veh: 'Vehicle', air: 'Aircraft', sea: 'Naval' };

// --- generated plain-language descriptions (kept in sync with the data) ----
function unitDesc(d: any): string {
  const b: string[] = [KIND[d.kind] || ''];
  if (d.dmg > 0) b.push(`dmg ${d.dmg}`, `range ${d.range}`, `rof ${d.rof}s`);
  if (d.splash) b.push(`splash ${d.splash}`);
  if (d.cargo) b.push('harvester');
  if (d.oilMiner) b.push('oil miner');
  if (d.repair) b.push('engineer');
  if (d.terra) b.push('terraformer');
  if (d.deploys) b.push('deploys base');
  if (d.cloak) b.push('cloaked');
  if (d.fly) b.push('flies');
  if (d.kamikaze) b.push('kamikaze');
  if (d.volley) b.push(`volley of ${d.volley}`);
  if (d.carrier) b.push('transport');
  if (d.jam) b.push('jams radar');
  if (d.intercept) b.push('intercepts missiles');
  if (d.commando) b.push('commando');
  if (d.sonar) b.push('sonar');
  if (d.fortify) b.push('can fortify');
  if (d.tech) b.push(`tech: ${d.tech}`);
  return b.filter(Boolean).join(' · ');
}
function bldgDesc(d: any): string {
  const b: string[] = [];
  if (d.attack) b.push(`Defense · dmg ${d.attack.dmg} · range ${d.attack.range}`);
  if (d.power > 0) b.push(`+${d.power} power`);
  if (d.power < 0) b.push(`uses ${-d.power} power`);
  if (d.income) b.push(`+${d.income} credits/s`);
  if (d.intercept) b.push('shoots down missiles');
  if (d.sight) b.push(`reveals fog (sight ${d.sight})`);
  if (d.garrison) b.push('garrisonable');
  if (d.prereq) b.push(`needs ${BUILDINGS[d.prereq]?.name || d.prereq}`);
  if (!b.length) b.push('Structure');
  return b.join(' · ');
}

// ---- combat roster for the matrix: anything that can fight ----
type Combatant = { key: string; name: string; isB: boolean; def: any };
const matrixUnits: Combatant[] = Object.keys(UNITS)
  .filter(t => { const d = UNITS[t]; return d.dmg > 0 && !d.internal && !d.missile; })
  .map(t => ({ key: t, name: UNITS[t].name, isB: false, def: UNITS[t] }));
const matrixBuildings: Combatant[] = Object.keys(BUILDINGS)
  .filter(t => (BUILDINGS[t] as any).attack)
  .map(t => ({ key: t, name: BUILDINGS[t].name, isB: true, def: BUILDINGS[t] }));
const combatants: Combatant[] = [...matrixUnits, ...matrixBuildings];

const hpOf = (c: Combatant) => c.def.hp;
const atkOf = (c: Combatant) => (c.isB ? c.def.attack : c.def); // {dmg,range,rof}
const kindOf = (c: Combatant) => (c.isB ? 'building' : c.def.kind);

// effective DPS of attacker `a` against defender `d` (0 if it can't hurt it)
function dps(a: Combatant, d: Combatant): number {
  const at = atkOf(a); if (!at || !at.dmg) return 0;
  const mul = dmgMul(a.key, d.isB, kindOf(d), d.key);
  if (mul <= 0) return 0;
  return (at.dmg * mul) / Math.max(0.1, at.rof);
}

// How many of `a` are needed to kill ONE `d`, modelled with the Lanchester square
// law for concentrated fire (defender focuses one attacker at a time): attackers
// win once N > sqrt( Hd·Dd / (Ha·Da) ). A range edge gives a small discount/penalty
// (a longer-reaching attacker lands free hits before the target closes). Returns
// null when the attacker simply cannot damage the defender ("X").
function countToKill(a: Combatant, d: Combatant): number | null {
  const Da = dps(a, d); if (Da <= 0) return null;
  const Dd = dps(d, a);
  const Ha = hpOf(a), Hd = hpOf(d);
  if (Dd <= 0) return 1; // defender can't hit back → a single attacker grinds it down
  let ratio = (Hd * Dd) / (Ha * Da);
  // range advantage: attacker out-ranging the target shifts the exchange in its favour
  const ar = atkOf(a)?.range || 0, dr = atkOf(d)?.range || 0;
  if (ar > 0 && dr > 0) ratio *= Math.min(2, Math.max(0.4, dr / ar));
  return Math.max(1, Math.ceil(Math.sqrt(ratio)));
}

const costOf = (c: Combatant) => c.def.cost || 0;

// ---------- render ----------
function el(html: string): HTMLElement { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild as HTMLElement; }

function tableRows(items: { key: string; isB: boolean }[], faction: string): string {
  return items.filter(({ key, isB }) => {
    const d = isB ? BUILDINGS[key] : UNITS[key];
    const f = (d as any).faction;
    return faction === 'all' || !f || f === faction; // universal (no faction) always shows
  }).map(({ key, isB }) => {
    const d: any = isB ? BUILDINGS[key] : UNITS[key];
    const fac = F(d.faction);
    const facCls = d.faction ? 'fac sig' : 'fac';
    if (isB) {
      return `<tr><td class="nm">${d.name}</td><td class="${facCls}">${fac}</td><td class="num">${d.cost || 0}</td>` +
        `<td class="num">${d.hp}</td><td class="num">${d.power > 0 ? '+' + d.power : d.power}</td><td class="desc">${bldgDesc(d)}</td></tr>`;
    }
    return `<tr><td class="nm">${d.name}</td><td class="${facCls}">${fac}</td><td class="num">${d.cost}</td>` +
      `<td class="num">${d.hp}</td><td class="num">${d.dmg || '–'}</td><td class="num">${d.range || '–'}</td>` +
      `<td class="num">${d.speed || '–'}</td><td class="desc">${unitDesc(d)}</td></tr>`;
  }).join('');
}

function buildTables(faction: string) {
  const bList = Object.keys(BUILDINGS).filter(t => !(BUILDINGS[t] as any).neutral).map(key => ({ key, isB: true }));
  const uList = Object.keys(UNITS).filter(t => !(UNITS[t] as any).internal).map(key => ({ key, isB: false }));
  document.getElementById('bldgBody')!.innerHTML = tableRows(bList, faction);
  document.getElementById('unitBody')!.innerHTML = tableRows(uList, faction);
}

function cellColor(n: number | null): string {
  if (n === null) return 'var(--x)';
  if (n <= 1) return '#1f7a3a';
  if (n <= 2) return '#3f8f2e';
  if (n <= 4) return '#8a8b2c';
  if (n <= 7) return '#9a6b22';
  if (n <= 12) return '#a23f2a';
  return '#7a2222';
}

function buildMatrix() {
  const head = ['<th class="corner">atk ↓ \\ def →</th>', ...combatants.map(c =>
    `<th class="ch"${c.isB ? ' style="opacity:.85"' : ''}>${c.name}${c.isB ? ' 🏢' : ''}</th>`)].join('');
  const rows = combatants.map(a => {
    const cells = combatants.map(d => {
      if (a.key === d.key && a.isB === d.isB) return `<td class="self">—</td>`;
      const n = countToKill(a, d);
      if (n === null) return `<td class="x" style="background:${cellColor(null)}">×</td>`;
      const cost = n * costOf(a);
      return `<td style="background:${cellColor(n)}" title="${n}× ${a.name} to kill one ${d.name} (≈ ${cost} cr)">${n}<span class="cost">${cost}</span></td>`;
    }).join('');
    return `<tr><th class="rh"${a.isB ? ' style="opacity:.85"' : ''}>${a.name}${a.isB ? ' 🏢' : ''}</th>${cells}</tr>`;
  }).join('');
  document.getElementById('matrix')!.innerHTML = `<table class="mtx"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

// faction filter dropdown
const sel = document.getElementById('facFilter') as HTMLSelectElement;
sel.innerHTML = `<option value="all">All factions</option>` +
  Object.keys(FACTIONS).map(id => `<option value="${id}">${(FACTIONS as any)[id].name}</option>`).join('');
sel.addEventListener('change', () => buildTables(sel.value));

buildTables('all');
buildMatrix();
