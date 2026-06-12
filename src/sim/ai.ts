// Scripted AI with difficulty levels (0 easy, 1 normal, 2 hard, 3 brutal).
// Macro loop: expand refineries toward unclaimed ore (creeping power nodes when
// the frontier is out of build range), keep multiple production buildings
// running, garrison turrets/SAMs, then apply constant pressure after the peace
// window: harassment raids on harvesters plus massed siege-led assault waves.

import { Sim, Entity, Cmd } from './sim';
import { UNITS, BUILDINGS, TICKS_PER_SEC } from './data';
import { W, H } from './map';
import { findPath } from './path';

interface AiMem {
  nextWave: number; waveSize: number; tog: number; defCd: number;
  peaceUntil: number; peaceBroken: boolean; nextRaid: number;
  landOk?: boolean; landCheckT?: number; // island detection (cached pathfind)
}

const LVL = [
  { cad: 4.0, peace: 360, waveEvery: 110, w0: 6,  wInc: 3, cap: 18, turrets: 2, sams: 0, harv: 3, barracks: 1, factories: 1, refs: 2, air: false, siege: 0, raid: 0 },
  { cad: 2.0, peace: 240, waveEvery: 60,  w0: 10, wInc: 4, cap: 32, turrets: 3, sams: 1, harv: 4, barracks: 1, factories: 2, refs: 3, air: false, siege: 1, raid: 0 },
  { cad: 1.0, peace: 150, waveEvery: 40,  w0: 16, wInc: 6, cap: 48, turrets: 4, sams: 2, harv: 5, barracks: 2, factories: 2, refs: 4, air: true,  siege: 2, raid: 45 },
  { cad: 1.0, peace: 90,  waveEvery: 30,  w0: 22, wInc: 8, cap: 70, turrets: 5, sams: 3, harv: 6, barracks: 2, factories: 3, refs: 4, air: true,  siege: 3, raid: 35 },
];

export function aiTick(sim: Sim, p: number): Cmd[] {
  const pl = sim.players[p];
  if (!pl || !pl.alive || sim.done) return [];
  const cmds: Cmd[] = [];
  const L = LVL[Math.max(0, Math.min(3, pl.aiLvl ?? 1))];

  // --- adaptive strategy: study the human's past games and counter them ---
  // escalate after losses, pre-empt habitual rushes, stock counters to the
  // weapon classes the player leans on
  let cap = L.cap, waveEvery = L.waveEvery, peaceSec = L.peace;
  let turrets = L.turrets, sams = L.sams, refs = L.refs;
  let antiArmor = false, antiInf = false, antiAir = false;
  const prof = sim.aiProfile;
  if (prof && prof.games > 0) {
    const esc = Math.min(4, prof.lossStreak || 0);
    cap = Math.min(90, Math.round(cap * (1 + 0.15 * esc)));
    waveEvery = Math.max(20, Math.round(waveEvery * (1 - 0.08 * esc)));
    if (esc >= 2) refs = Math.min(5, refs + 1);
    const rushes: number[] = prof.rushTimes || [];
    if (rushes.length) {
      const med = [...rushes].sort((a, b) => a - b)[rushes.length >> 1];
      if (med < peaceSec) { peaceSec = Math.max(60, Math.round(med * 0.8)); turrets++; } // they rush — dig in early
    }
    const d = prof.dmg || {};
    const tot = (d.inf || 0) + (d.veh || 0) + (d.air || 0) + (d.sea || 0);
    if (tot > 0) {
      antiAir = (d.air || 0) / tot > 0.25;
      antiArmor = (d.veh || 0) / tot > 0.5;
      antiInf = (d.inf || 0) / tot > 0.45;
    }
    if (antiAir) sams = Math.max(2, sams + 1);
  }

  let mem: AiMem = sim.aiMem[p];
  if (!mem) {
    mem = sim.aiMem[p] = {
      nextWave: peaceSec * TICKS_PER_SEC, waveSize: L.w0, tog: 0, defCd: 0,
      peaceUntil: peaceSec * TICKS_PER_SEC, peaceBroken: false, nextRaid: peaceSec * TICKS_PER_SEC,
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

  // island doctrine: when no land route reaches the enemy, ground armies are
  // useless — pivot to drones, aircraft and ships. The pathfind is cached and
  // rechecked occasionally (bridges of rubble can open up).
  if (mem.landCheckT === undefined || sim.tickN >= mem.landCheckT) {
    mem.landCheckT = sim.tickN + 45 * TICKS_PER_SEC;
    const en = nearestEnemyBuilding(sim, p);
    mem.landOk = !en || !!findPath(sim.map, pl.spawn.x, pl.spawn.z, en.x, en.z, 16000, false);
  }
  const island = mem.landOk === false;
  if (island) refs = Math.min(refs, 2); // a small island can't feed 3+ refineries

  // optional LLM strategist (Claude API, set by the host): a high-level stance
  // that bends the scripted knobs — the script stays the tactical layer
  const dirStance: string | null = sim.aiDirective?.stance || null;
  let dirAir = false, dirTech = false;
  if (dirStance === 'rush') {
    waveEvery = Math.max(18, Math.round(waveEvery * 0.6));
    mem.peaceUntil = Math.min(mem.peaceUntil, sim.tickN + 15 * TICKS_PER_SEC);
    mem.nextWave = Math.min(mem.nextWave, sim.tickN + 25 * TICKS_PER_SEC);
  } else if (dirStance === 'defend') { turrets = Math.min(6, turrets + 2); sams = Math.max(2, sams); }
  else if (dirStance === 'expand') { refs = Math.min(6, refs + 1); }
  else if (dirStance === 'air') dirAir = true;
  else if (dirStance === 'tech') dirTech = true;

  // hopeless position: no conyard (can't build), no production buildings and
  // no fighting units left — wave the white flag instead of dragging it out
  const production = nB('barracks') + nB('factory') + nB('dronefac') + nB('airforce') + nB('shipyard');
  let combat = 0;
  for (const t in myU) if ((UNITS[t]?.dmg ?? 0) > 0 || UNITS[t]?.emits) combat += myU[t].length;
  if (!nB('conyard') && production === 0 && combat === 0) {
    cmds.push({ k: 'surrender', p });
    return cmds;
  }
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
  // a couple of turrets for safety, then SPREAD: refineries toward the ore
  // frontier take priority over deep defense (tester: "AI not spreading out")
  else if (nB('turret') < Math.min(2, turrets) && nB('barracks')) want = 'turret';
  else if (nB('refinery') < refs && pl.credits > 1200) want = 'refinery';
  // vehicle throughput beats deep turret lines — factories before turret #3+
  // (islanders keep ONE factory and ONE barracks: ground forces can't leave)
  else if (nB('factory') < (island ? 1 : L.factories) && pl.credits > 1900) want = 'factory';
  else if (nB('turret') < turrets) want = 'turret';
  else if (nB('barracks') < (island ? 1 : L.barracks) && pl.credits > 1200) want = 'barracks';
  // stranded on an island: drone works, air force and shipyard come early
  else if (island && !nB('dronefac') && nB('factory') && pl.credits > 1600) want = 'dronefac';
  else if (island && !nB('airforce') && nB('factory') && pl.credits > 2000) want = 'airforce';
  else if (island && nB('airforce') && nB('airfield') < 3 && pl.credits > 1100) want = 'airfield';
  else if (island && !nB('shipyard') && pl.credits > 2000) want = 'shipyard';
  else if (!nB('dronefac') && nB('factory') && pl.credits > 2400) want = 'dronefac';
  else if (nB('sam') < sams && nB('factory') && pl.credits > (antiAir ? 1400 : 2200)) want = 'sam';
  else if ((L.air || island || dirAir) && !nB('airforce') && nB('factory') && pl.credits > (dirAir ? 2400 : 3000)) want = 'airforce';
  else if ((L.air || island || dirAir) && nB('airforce') && nB('airfield') < 2 && pl.credits > 1600) want = 'airfield';
  else if ((pl.aiLvl >= 2 || dirTech) && !nB('lab') && nB('factory') && pl.credits > (dirTech ? 2400 : 3000)) want = 'lab';
  else if (nB('turret') < turrets + 1 && pl.credits > 2600) want = 'turret';
  else if (surplus < 60 && pl.credits > 2400) want = 'power';

  if (want && nB('conyard')) {
    const def = BUILDINGS[want];
    const ok = !def.prereq || nB(def.prereq) > 0;
    if (ok && pl.credits >= cost(want)) {
      const enemy = nearestEnemyBuilding(sim, p);
      let toward: { x: number; z: number } | null = null;
      if (want === 'refinery') toward = oreFrontier(sim, p);
      else if (want === 'turret' || want === 'sam') {
        // guard the base perimeter facing the enemy — NOT a picket line
        // strung out toward the enemy base (it gets picked off piecemeal)
        if (enemy) {
          let cx = 0, cz = 0, n = 0;
          for (const e of sim.ents.values()) if (e.b && e.owner === p) { cx += e.x; cz += e.z; n++; }
          cx /= n || 1; cz /= n || 1;
          const dl = Math.hypot(enemy.x - cx, enemy.z - cz) || 1;
          toward = { x: cx + ((enemy.x - cx) / dl) * 6, z: cz + ((enemy.z - cz) / dl) * 6 };
        }
      }
      let spot = findSpot(sim, p, want, toward);
      // expansion creep: if the ore frontier is beyond build range, push a
      // cheap power node toward it to extend the base footprint
      if (want === 'refinery' && toward && spot &&
        Math.hypot(spot.x - toward.x, spot.z - toward.z) > 11 &&
        pl.credits > cost('power') + 500) {
        const creep = findSpot(sim, p, 'power', toward);
        if (creep) { cmds.push({ k: 'place', p, type: 'power', cx: creep.x, cz: creep.z }); spot = null; }
      }
      if (spot) cmds.push({ k: 'place', p, type: want, cx: spot.x, cz: spot.z });
    }
  }

  // training — keep every production building busy, but build a MIXED army:
  // infantry is the cheap screen, vehicles the core (tester: "AI only builds
  // infantry"). Once a factory stands, infantry is capped at ~45% of the army
  // and the factory gets first claim on credits.
  const armyCount = nU('rifle') + nU('rocket') + nU('tank') + nU('heavy') + nU('ifv') + nU('aatank') + nU('flak') + nU('mlrs')
    + nU('recon') + nU('strike') + nU('msldrone') + nU('fighter') + nU('heli') + nU('helidrone');
  const infCount = nU('rifle') + nU('rocket') + nU('chemtrooper') + nU('biotrooper');
  const hasFac = (myB['factory'] || []).some(b => b.progress >= b.total);
  // economy first: saturate every refinery with ~2 harvesters before army
  // spending — cheap units must not starve the harvester budget
  const harvTarget = Math.max(L.harv, nB('refinery') * 2);
  const ecoShort = hasFac && nU('harv') < harvTarget;
  for (const bks of (myB['barracks'] || [])) {
    if (bks.progress < bks.total || bks.queue.length >= 2) continue;
    if (armyCount >= cap) continue;
    if (ecoShort && pl.credits < 2200) continue; // harvesters get first claim
    if (island && infCount >= 4) continue; // infantry can't swim — token garrison only
    if (hasFac && infCount >= Math.max(3, armyCount * 0.35)) continue; // leave credits for vehicles
    if (pl.credits > (hasFac ? 900 : 500)) {
      // vs an armor-heavy player every 2nd squad is rockets, else every 3rd
      const rk = antiArmor ? 2 : 3;
      const t = mem.tog++ % rk === rk - 1 ? 'rocket' : 'rifle';
      cmds.push({ k: 'train', p, bid: bks.id, type: t });
    }
  }
  for (const fac of (myB['factory'] || [])) {
    if (fac.progress < fac.total || fac.queue.length >= 2) continue;
    if (nU('harv') < harvTarget && pl.credits > 1000) cmds.push({ k: 'train', p, bid: fac.id, type: 'harv' });
    else if (nU('engineer') < 1 && pl.aiLvl >= 1 && pl.credits > 1500) cmds.push({ k: 'train', p, bid: fac.id, type: 'engineer' });
    else if (armyCount < cap && pl.credits > (ecoShort ? 2200 : 1000)) {
      // islanders keep only a small home guard of vehicles
      const groundArmy = nU('tank') + nU('heavy') + nU('ifv') + nU('mlrs') + nU('aatank') + nU('flak');
      if (island && groundArmy >= 8) continue;
      const r = sim.rng.next();
      const t = nU('mlrs') < L.siege ? 'mlrs'
        : (antiAir && nU('aatank') + nU('flak') < 4 && r < 0.35) ? (r < 0.18 ? 'aatank' : 'flak')
        : r < (antiInf ? 0.4 : 0.25) ? 'mlrs' // artillery shreds infantry masses
        : r < (antiInf ? 0.7 : 0.42) ? 'ifv'  // autocannons mop up the rest
        : (pl.credits > 2000 && r < 0.6) ? 'heavy'
        : 'tank';
      cmds.push({ k: 'train', p, bid: fac.id, type: t });
    }
  }
  const dro = (myB['dronefac'] || []).find(b => b.progress >= b.total && b.queue.length < 2);
  if (dro && armyCount < cap && pl.credits > (ecoShort ? 2400 : 1100)) {
    const r = sim.rng.next();
    const t = pl.credits > 3000 && r < 0.35 ? 'msldrone' : pl.credits > 2600 && r < 0.65 ? 'strike' : 'recon';
    cmds.push({ k: 'train', p, bid: dro.id, type: t });
  }
  const af = (myB['airforce'] || []).find(b => b.progress >= b.total && b.queue.length < 2);
  if (af && armyCount < cap && pl.credits > (island || dirAir ? 1800 : 2200)) {
    const r = sim.rng.next();
    // vs an air-heavy player, prioritize interceptors; islanders love bombers
    const t = island && r < 0.35 ? 'bomber'
      : r < (antiAir ? 0.7 : 0.4) ? 'fighter' : r < 0.7 ? 'heli' : 'helidrone';
    cmds.push({ k: 'train', p, bid: af.id, type: t });
  }
  // island navy: gunboats and destroyers shell the enemy coast
  const sy = (myB['shipyard'] || []).find(b => b.progress >= b.total && b.queue.length < 2);
  if (sy && island) {
    const seaN = nU('gunboat') + nU('destroyer') + nU('sub') + nU('navdrone');
    if (seaN < 6 && pl.credits > (ecoShort ? 2600 : 1500)) {
      const r = sim.rng.next();
      cmds.push({ k: 'train', p, bid: sy.id, type: r < 0.5 ? 'gunboat' : r < 0.85 ? 'destroyer' : 'sub' });
    }
  }

  // research a tech when a lab is idle and we're flush
  const lab = (myB['lab'] || []).find(b => b.progress >= b.total && !b.research);
  if (lab && pl.credits > (dirTech ? 2500 : 3500)) {
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
          mem.nextWave = sim.tickN + waveEvery * TICKS_PER_SEC;
          mem.waveSize = Math.min(cap - 6, mem.waveSize + L.wInc);
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
  const sz = BUILDINGS[type]?.size || 2;
  for (const base of bases.slice(0, 4)) {
    for (let r = 3; r <= 12; r++) {
      for (let k = 0; k < 8; k++) {
        const cx = Math.round(base.x + sim.rng.range(-r, r));
        const cz = Math.round(base.z + sim.rng.range(-r, r));
        if (!sim.canPlace(p, type, cx, cz)) continue;
        let score = sim.rng.next();
        if (toward) score -= Math.sqrt((cx - toward.x) ** 2 + (cz - toward.z) ** 2) * 0.08;
        // breathing room: wall-to-wall placement traps harvesters and units —
        // penalize spots that touch an existing building
        const mx = cx + sz / 2, mz = cz + sz / 2;
        for (const b of bases) {
          const gap = Math.max(Math.abs(b.x - mx), Math.abs(b.z - mz)) - (b.size + sz) / 2;
          if (gap < 1) { score -= 0.55; break; }
        }
        candidates.push({ x: cx, z: cz, score });
      }
      if (candidates.length >= 36) break;
    }
    if (candidates.length >= 36) break;
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}
