// Scripted AI with difficulty levels (0 easy, 1 normal, 2 hard, 3 brutal).
// Macro loop: expand refineries toward unclaimed ore (creeping power nodes when
// the frontier is out of build range), keep multiple production buildings
// running, garrison turrets/SAMs, then apply constant pressure after the peace
// window: harassment raids on harvesters plus massed siege-led assault waves.

import { Sim, Entity, Cmd } from './sim';
import { UNITS, BUILDINGS, TICKS_PER_SEC } from './data';
import { W, H } from './map';

interface AiMem {
  nextWave: number; waveSize: number; tog: number; defCd: number;
  peaceUntil: number; peaceBroken: boolean; nextRaid: number;
}

const LVL = [
  { cad: 4.0, peace: 360, waveEvery: 110, w0: 6,  wInc: 3, cap: 18, turrets: 2, sams: 0, harv: 2, barracks: 1, factories: 1, refs: 2, air: false, siege: 0, raid: 0 },
  { cad: 2.0, peace: 240, waveEvery: 60,  w0: 10, wInc: 4, cap: 32, turrets: 3, sams: 1, harv: 3, barracks: 2, factories: 1, refs: 2, air: false, siege: 1, raid: 0 },
  { cad: 1.0, peace: 150, waveEvery: 40,  w0: 16, wInc: 6, cap: 48, turrets: 4, sams: 2, harv: 4, barracks: 2, factories: 2, refs: 3, air: true,  siege: 2, raid: 45 },
  { cad: 1.0, peace: 90,  waveEvery: 30,  w0: 22, wInc: 8, cap: 70, turrets: 5, sams: 3, harv: 5, barracks: 3, factories: 2, refs: 3, air: true,  siege: 3, raid: 35 },
];

export function aiTick(sim: Sim, p: number): Cmd[] {
  const pl = sim.players[p];
  if (!pl || !pl.alive || sim.done) return [];
  const cmds: Cmd[] = [];
  const L = LVL[Math.max(0, Math.min(3, pl.aiLvl ?? 1))];
  let mem: AiMem = sim.aiMem[p];
  if (!mem) {
    mem = sim.aiMem[p] = {
      nextWave: L.peace * TICKS_PER_SEC, waveSize: L.w0, tog: 0, defCd: 0,
      peaceUntil: L.peace * TICKS_PER_SEC, peaceBroken: false, nextRaid: L.peace * TICKS_PER_SEC,
    };
  }
  if (mem.nextRaid === undefined) mem.nextRaid = mem.peaceUntil;

  // --- defense reaction + peace-breaking check (every tick, cheap) ---
  if (mem.defCd > 0) mem.defCd--;
  for (const d of sim.dmgLog) {
    if (d.vOwner !== p) continue;
    const attacker = sim.ents.get(d.by);
    if (!attacker) continue;
    if (!mem.peaceBroken && !sim.players[attacker.owner]?.isAI) {
      mem.peaceBroken = true;
      mem.nextWave = Math.min(mem.nextWave, sim.tickN + 12 * TICKS_PER_SEC);
      mem.nextRaid = Math.min(mem.nextRaid, sim.tickN + 20 * TICKS_PER_SEC);
    }
    if (d.b && mem.defCd <= 0) {
      const army = armyOf(sim, p, true);
      if (army.length) {
        cmds.push({ k: 'attack', p, ids: army.map(u => u.id), tgt: attacker.id, x: attacker.x, z: attacker.z });
        mem.defCd = 8 * TICKS_PER_SEC;
      }
    }
    break;
  }

  // --- macro cadence ---
  if (sim.tickN % Math.max(1, Math.round(L.cad * TICKS_PER_SEC)) !== p) return cmds;

  const myB: Record<string, Entity[]> = {};
  const myU: Record<string, Entity[]> = {};
  for (const e of sim.ents.values()) {
    if (e.owner !== p) continue;
    (e.b ? myB : myU)[e.type] ??= [];
    (e.b ? myB : myU)[e.type].push(e);
  }
  const nB = (t: string) => (myB[t] || []).length;
  const nU = (t: string) => (myU[t] || []).length;
  const cost = (t: string) => Math.round(BUILDINGS[t].cost * pl.fac.costMul * pl.bonusCost);
  const surplus = pl.powerMade - pl.powerUsed;

  // build order — economy, production breadth, then defense depth
  let want: string | null = null;
  if (surplus < 25) want = 'power';
  else if (!nB('refinery')) want = 'refinery';
  else if (!nB('barracks')) want = 'barracks';
  // expand the economy early — a 2nd refinery toward the ore frontier before
  // committing to a deep army (the tester's AI stalled on one refinery)
  else if (nB('refinery') < 2 && pl.credits > 1500) want = 'refinery';
  else if (!nB('factory') && pl.credits > cost('factory') * 1.1) want = 'factory';
  else if (nB('turret') < L.turrets && nB('barracks')) want = 'turret';
  else if (nB('refinery') < L.refs && pl.credits > 1900) want = 'refinery';
  else if (nB('barracks') < L.barracks && pl.credits > 1200) want = 'barracks';
  else if (nB('factory') < L.factories && pl.credits > 2400) want = 'factory';
  else if (!nB('dronefac') && nB('factory') && pl.credits > 2400) want = 'dronefac';
  else if (nB('sam') < L.sams && nB('factory') && pl.credits > 2200) want = 'sam';
  else if (L.air && !nB('airforce') && nB('factory') && pl.credits > 3000) want = 'airforce';
  else if (L.air && nB('airforce') && nB('airfield') < 2 && pl.credits > 1600) want = 'airfield';
  else if (pl.aiLvl >= 2 && !nB('lab') && nB('factory') && pl.credits > 3000) want = 'lab';
  else if (nB('turret') < L.turrets + 1 && pl.credits > 2600) want = 'turret';
  else if (surplus < 60 && pl.credits > 2400) want = 'power';

  if (want && nB('conyard')) {
    const def = BUILDINGS[want];
    const ok = !def.prereq || nB(def.prereq) > 0;
    if (ok && pl.credits >= cost(want)) {
      const enemy = nearestEnemyBuilding(sim, p);
      let toward: { x: number; z: number } | null = null;
      if (want === 'refinery') toward = oreFrontier(sim, p);
      else if (want === 'turret' || want === 'sam') toward = enemy;
      let spot = findSpot(sim, p, want, toward);
      // expansion creep: if the ore frontier is beyond build range, push a
      // cheap power node toward it to extend the base footprint
      if (want === 'refinery' && toward && spot &&
        Math.hypot(spot.x - toward.x, spot.z - toward.z) > 11 &&
        pl.credits > cost('power') + 1200) {
        const creep = findSpot(sim, p, 'power', toward);
        if (creep) { cmds.push({ k: 'place', p, type: 'power', cx: creep.x, cz: creep.z }); spot = null; }
      }
      if (spot) cmds.push({ k: 'place', p, type: want, cx: spot.x, cz: spot.z });
    }
  }

  // training — keep every production building busy
  const armyCount = nU('rifle') + nU('rocket') + nU('tank') + nU('heavy') + nU('mlrs')
    + nU('recon') + nU('strike') + nU('msldrone') + nU('fighter') + nU('heli') + nU('helidrone');
  for (const bks of (myB['barracks'] || [])) {
    if (bks.progress < bks.total || bks.queue.length >= 2) continue;
    if (armyCount < L.cap && pl.credits > 500) {
      const t = mem.tog++ % 3 === 2 ? 'rocket' : 'rifle';
      cmds.push({ k: 'train', p, bid: bks.id, type: t });
    }
  }
  for (const fac of (myB['factory'] || [])) {
    if (fac.progress < fac.total || fac.queue.length >= 2) continue;
    if (nU('harv') < L.harv && pl.credits > 1500) cmds.push({ k: 'train', p, bid: fac.id, type: 'harv' });
    else if (nU('engineer') < 1 && pl.aiLvl >= 1 && pl.credits > 1800) cmds.push({ k: 'train', p, bid: fac.id, type: 'engineer' });
    else if (armyCount < L.cap && pl.credits > 1700) {
      const r = sim.rng.next();
      const t = nU('mlrs') < L.siege ? 'mlrs'
        : r < 0.30 ? 'mlrs'
        : (pl.credits > 3400 && r < 0.45) ? 'heavy'
        : 'tank';
      cmds.push({ k: 'train', p, bid: fac.id, type: t });
    }
  }
  const dro = (myB['dronefac'] || []).find(b => b.progress >= b.total && b.queue.length < 2);
  if (dro && armyCount < L.cap && pl.credits > 1400) {
    const r = sim.rng.next();
    const t = pl.credits > 3000 && r < 0.35 ? 'msldrone' : pl.credits > 2600 && r < 0.65 ? 'strike' : 'recon';
    cmds.push({ k: 'train', p, bid: dro.id, type: t });
  }
  const af = (myB['airforce'] || []).find(b => b.progress >= b.total && b.queue.length < 2);
  if (af && armyCount < L.cap && pl.credits > 2200) {
    const r = sim.rng.next();
    const t = r < 0.4 ? 'fighter' : r < 0.7 ? 'heli' : 'helidrone';
    cmds.push({ k: 'train', p, bid: af.id, type: t });
  }

  // research a tech when a lab is idle and we're flush
  const lab = (myB['lab'] || []).find(b => b.progress >= b.total && !b.research);
  if (lab && pl.credits > 3500) {
    const t = !pl.tech['chem'] ? 'chem' : !pl.tech['bio'] ? 'bio' : !pl.tech['stealth'] ? 'stealth' : null;
    if (t) cmds.push({ k: 'research', p, bid: lab.id, tech: t });
  }
  // a fortified Drone Hive anchors the base defense
  const bkForHive = (myB['barracks'] || []).find(b => b.progress >= b.total && b.queue.length < 1);
  if (bkForHive && pl.aiLvl >= 2 && nU('hive') < 1 && pl.credits > 2200)
    cmds.push({ k: 'train', p, bid: bkForHive.id, type: 'hive' });
  for (const h of (myU['hive'] || []))
    if (!h.fortified && !h.orders.length) cmds.push({ k: 'fortify', p, ids: [h.id] }); // dig in at base

  // upgrade something when rich
  if (pl.credits > 4500) {
    const upgradable = [...(myB['power'] || []), ...(myB['turret'] || []), ...(myB['airfield'] || []), ...(myB['refinery'] || [])]
      .find(b => b.progress >= b.total && b.lvl < 3);
    if (upgradable) cmds.push({ k: 'upg', p, bid: upgradable.id });
  }

  // hostilities only after the build-up peace (or once a human breaks it)
  const atWar = sim.tickN >= mem.peaceUntil || mem.peaceBroken;
  if (!atWar) return cmds;

  // harassment raids: a few fast units hit enemy harvesters between waves
  if (L.raid && sim.tickN >= mem.nextRaid) {
    const fast = armyOf(sim, p, true).filter(u => UNITS[u.type].speed >= 2.6 || u.type === 'recon').slice(0, 4);
    if (fast.length >= 3) {
      const tgt = enemyHarvester(sim, p) || bestStrikeTarget(sim, p);
      if (tgt) {
        cmds.push({ k: 'attack', p, ids: fast.map(u => u.id), tgt: tgt.id, x: tgt.x, z: tgt.z });
        mem.nextRaid = sim.tickN + L.raid * TICKS_PER_SEC;
      } else mem.nextRaid = sim.tickN + 15 * TICKS_PER_SEC;
    } else mem.nextRaid = sim.tickN + 15 * TICKS_PER_SEC;
  }

  // assault waves: mass with a siege core, hit the softest flank, repeat
  if (sim.tickN >= mem.nextWave) {
    const army = armyOf(sim, p, true);
    if (army.length < mem.waveSize) {
      mem.nextWave = sim.tickN + 12 * TICKS_PER_SEC; // not massed yet
    } else {
      const siege = army.filter(u => u.type === 'mlrs' || u.type === 'bomber' || u.type === 'dbomber').length;
      // if only siege is missing, hold position but let the 30s fallback clock
      // run (don't reset nextWave, or the fallback never fires)
      if (L.siege === 0 || siege >= 1 || sim.tickN > mem.nextWave + 30 * TICKS_PER_SEC) {
        const tgt = bestStrikeTarget(sim, p);
        if (tgt) {
          cmds.push({ k: 'attack', p, ids: army.map(u => u.id), tgt: tgt.id, x: tgt.x, z: tgt.z });
          mem.nextWave = sim.tickN + L.waveEvery * TICKS_PER_SEC;
          mem.waveSize = Math.min(L.cap - 6, mem.waveSize + L.wInc);
        } else mem.nextWave = sim.tickN + 8 * TICKS_PER_SEC;
      }
    }
  }

  return cmds;
}

function armyOf(sim: Sim, p: number, idleOnly: boolean): Entity[] {
  const out: Entity[] = [];
  for (const e of sim.ents.values()) {
    if (e.b || e.owner !== p) continue;
    const d = UNITS[e.type];
    if (!d || d.dmg <= 0 || d.move === 'sea') continue;
    if (idleOnly && e.orders.length && e.orders[0].k !== 'attack') continue;
    out.push(e);
  }
  return out;
}

// nearest ore cell not already served by one of our refineries
function oreFrontier(sim: Sim, p: number): { x: number; z: number } | null {
  const refs: Entity[] = [];
  let base: Entity | null = null;
  for (const e of sim.ents.values()) {
    if (!e.b || e.owner !== p) continue;
    if (e.type === 'refinery') refs.push(e);
    if (e.type === 'conyard') base = e;
  }
  const from = base || refs[0];
  if (!from) return null;
  let best: { x: number; z: number } | null = null, bd = 1e9;
  for (let cz = 0; cz < H; cz += 2) {
    for (let cx = 0; cx < W; cx += 2) {
      if (sim.map.ore[cz * W + cx] <= 0) continue;
      let served = false;
      for (const r of refs) if ((r.x - cx) ** 2 + (r.z - cz) ** 2 < 10 * 10) { served = true; break; }
      if (served) continue;
      const d = (from.x - cx) ** 2 + (from.z - cz) ** 2;
      if (d < bd) { bd = d; best = { x: cx, z: cz }; }
    }
  }
  return best;
}

function enemyHarvester(sim: Sim, p: number): Entity | null {
  const s = sim.players[p].spawn;
  let best: Entity | null = null, bd = 1e9;
  for (const e of sim.ents.values()) {
    if (e.b || e.owner === p || e.type !== 'harv' || !sim.players[e.owner].alive) continue;
    const d = (e.x - s.x) ** 2 + (e.z - s.z) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// enemy building with the fewest defenses nearby — hit the soft flank
function bestStrikeTarget(sim: Sim, p: number): Entity | null {
  const enemyB: Entity[] = [], defenders: Entity[] = [];
  for (const e of sim.ents.values()) {
    if (!e.b || e.owner === p || !sim.players[e.owner].alive) continue;
    enemyB.push(e);
    if (e.type === 'turret' || e.type === 'sam') defenders.push(e);
  }
  if (!enemyB.length) return null;
  let best: Entity | null = null, bestScore = 1e9;
  for (const e of enemyB) {
    let near = 0;
    for (const d of defenders) if ((d.x - e.x) ** 2 + (d.z - e.z) ** 2 < 12 * 12) near++;
    const priority = e.type === 'refinery' || e.type === 'power' || e.type === 'conyard' ? -1.5 : 0;
    const score = near + priority;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}

function nearestEnemyBuilding(sim: Sim, p: number): Entity | null {
  const s = sim.players[p].spawn;
  let best: Entity | null = null, bd = 1e9;
  for (const e of sim.ents.values()) {
    if (!e.b || e.owner === p || !sim.players[e.owner].alive) continue;
    const d = (e.x - s.x) ** 2 + (e.z - s.z) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// candidate spots ringed around our buildings; optional bias point pulls the
// placement toward it (ore frontier for refineries, the enemy for defenses)
function findSpot(sim: Sim, p: number, type: string, toward?: { x: number; z: number } | null): { x: number; z: number } | null {
  const bases: Entity[] = [];
  for (const e of sim.ents.values()) if (e.b && e.owner === p) bases.push(e);
  if (!bases.length) return null;
  // when creeping toward a point, ring-search from the buildings nearest it
  if (toward) bases.sort((a, b) =>
    ((a.x - toward.x) ** 2 + (a.z - toward.z) ** 2) - ((b.x - toward.x) ** 2 + (b.z - toward.z) ** 2));
  const candidates: { x: number; z: number; score: number }[] = [];
  for (const base of bases.slice(0, 4)) {
    for (let r = 3; r <= 10; r++) {
      for (let k = 0; k < 8; k++) {
        const cx = Math.round(base.x + sim.rng.range(-r, r));
        const cz = Math.round(base.z + sim.rng.range(-r, r));
        if (!sim.canPlace(p, type, cx, cz)) continue;
        let score = sim.rng.next();
        if (toward) score -= Math.sqrt((cx - toward.x) ** 2 + (cz - toward.z) ** 2) * 0.08;
        candidates.push({ x: cx, z: cz, score });
      }
      if (candidates.length >= 28) break;
    }
    if (candidates.length >= 28) break;
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}
