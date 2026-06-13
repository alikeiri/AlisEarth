// Scripted AI with difficulty levels (0 easy, 1 normal, 2 hard, 3 brutal).
// Macro loop: expand refineries toward unclaimed ore (creeping power nodes when
// the frontier is out of build range), keep multiple production buildings
// running, garrison turrets/SAMs, then apply constant pressure after the peace
// window: harassment raids on harvesters plus massed siege-led assault waves.

import { Sim, Entity, Cmd } from './sim';
import { UNITS, BUILDINGS, TICKS_PER_SEC } from './data';
import { W, H, nearestPassable } from './map';
import { findPath } from './path';

interface AiMem {
  nextWave: number; waveSize: number; tog: number; defCd: number;
  peaceUntil: number; peaceBroken: boolean; nextRaid: number;
  landOk?: boolean; landCheckT?: number; // island detection (cached pathfind)
  waterRel?: boolean; // navy worth building (island or water-heavy map)
  threatX?: number; threatZ?: number; threatN?: number; // where attacks come from
  hiveCd?: number; // pace hive production
  seenAir?: number; // decaying count of enemy air spotted (reactive AA)
  enemyAA?: number; // live count of enemy anti-air (units + batteries)
  enemyCombat?: number; // live count of enemy fighting units
  enemyBuildings?: number; // live count of enemy structures (walls excluded)
  lastHurtT?: number; // last tick a building of ours took damage (posture)
  defenders?: number[]; // infantry designated to the fortified defense line
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
  let antiArmor = false, antiInf = false, antiAir = false, prefAir = false;
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
    // lean into what paid off last games: if air damage-per-loss beat ground,
    // shift toward air power; bleeding harvesters earns an extra eco turret
    const eff = prof.eff || null;
    if (eff && prof.games >= 2 && (eff.air || 0) > ((eff.veh || 0) + (eff.inf || 0)) * 1.2) prefAir = true;
    if ((prof.harvLost || 0) >= 2) turrets++;
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
    // learn the enemy's attack corridor: a rolling average of where the
    // attackers come from. After a few attacks this points down their route.
    mem.threatX = (mem.threatX ?? attacker.x) * 0.9 + attacker.x * 0.1;
    mem.threatZ = (mem.threatZ ?? attacker.z) * 0.9 + attacker.z * 0.1;
    mem.threatN = (mem.threatN || 0) + 1;
    if (d.b) mem.lastHurtT = sim.tickN; // base under fire → tighten the posture
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

  // is a navy worth the investment? always on islands, and on any map with a
  // sizable navigable sea (sampled once) — so the AI contests the water instead
  // of ignoring it on mixed land/sea maps
  if (mem.waterRel === undefined) {
    let sea = 0, tot = 0;
    for (let z = 2; z < H - 2; z += 4) for (let x = 2; x < W - 2; x += 4) { tot++; if (sim.map.passableSea(x, z)) sea++; }
    mem.waterRel = tot > 0 && sea / tot >= 0.12;
  }
  const waterRel = island || !!mem.waterRel;

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

  // --- live recon: react to the army the enemy is actually fielding now ---
  // (a brief sighting biases production for a while via a decaying counter)
  let eAir = 0, eAA = 0, eCombat = 0, eBuildings = 0;
  for (const e of sim.ents.values()) {
    if (!sim.foe(e.owner, p) || e.hp <= 0 || !sim.players[e.owner]?.alive) continue;
    const ed = UNITS[e.type];
    if (e.b) {
      if (e.type !== 'wall' && e.type !== 'barrier') eBuildings++;
      if (e.type === 'sam') eAA++; // anti-air structure
    } else if (ed && !ed.internal) {
      if (ed.kind === 'air' && ed.fly && !ed.missile) eAir++;
      if (ed.dmg > 0) eCombat++;
      if (e.type === 'aatank' || e.type === 'flak' || e.type === 'sam') eAA++; // mobile AA
    }
  }
  mem.seenAir = Math.max((mem.seenAir || 0) * 0.96, eAir);
  mem.enemyAA = eAA;                 // live anti-air the enemy can bring to bear
  mem.enemyCombat = eCombat;         // standing enemy army (for the bomber-rush call)
  mem.enemyBuildings = eBuildings;
  if ((mem.seenAir || 0) >= 1) { antiAir = true; sams = Math.max(sams, (mem.seenAir || 0) >= 4 ? 3 : 2); }

  // --- dynamic posture: turtle when poor or pressured, press when rich/safe ---
  const underAttack = sim.tickN - (mem.lastHurtT ?? -1e9) < 15 * TICKS_PER_SEC;
  if (underAttack) turrets += 1;                                  // shore up the line under fire
  if (pl.credits > 6000) { cap = Math.min(90, cap + 8); waveEvery = Math.max(18, waveEvery - 6); } // flush: attack
  if (pl.credits < 1200 && underAttack) mem.nextWave = Math.max(mem.nextWave, sim.tickN + 10 * TICKS_PER_SEC); // hold

  // once a solid ground force and a defensive line stand, every AI graduates to
  // drones and aircraft (not just the top difficulties) — air is the follow-up
  // punch, so it comes AFTER the ground core, not instead of it
  const groundForce = nU('tank') + nU('heavy') + nU('ifv') + nU('mlrs') + nU('rocket') + nU('rifle') + nU('aatank') + nU('flak');
  const groundCore = nB('factory') >= 1 && nB('barracks') >= 1 && groundForce >= 12 && nB('turret') >= 2;
  const goAir = L.air || island || dirAir || prefAir || groundCore;

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
  else if (pl.aiLvl >= 1 && !nB('radar') && nB('factory') && pl.credits > 1400) want = 'radar';
  else if (nB('turret') < turrets) want = 'turret';
  else if (nB('barracks') < (island ? 1 : L.barracks) && pl.credits > 1200) want = 'barracks';
  // stranded on an island: drone works, air force and shipyard come early
  else if (island && !nB('dronefac') && nB('factory') && pl.credits > 1600) want = 'dronefac';
  else if (island && !nB('airforce') && nB('factory') && pl.credits > 2000) want = 'airforce';
  else if (island && nB('airforce') && nB('airfield') < 3 && pl.credits > 1100) want = 'airfield';
  else if (island && !nB('shipyard') && pl.credits > 2000) want = 'shipyard';
  // contest the water on mixed maps too: a shipyard once the land economy stands
  else if (!island && waterRel && !nB('shipyard') && nB('factory') && nB('refinery') >= 2 && pl.credits > 2600) want = 'shipyard';
  else if (!nB('dronefac') && nB('factory') && pl.credits > 2400) want = 'dronefac';
  else if (nB('sam') < sams && nB('factory') && pl.credits > (antiAir ? 1400 : 2200)) want = 'sam';
  else if (goAir && !nB('airforce') && nB('factory') && pl.credits > (dirAir || prefAir ? 2400 : 3000)) want = 'airforce';
  else if (goAir && nB('airforce') && nB('airfield') < 2 && pl.credits > 1600) want = 'airfield';
  else if ((pl.aiLvl >= 2 || dirTech) && !nB('lab') && nB('factory') && pl.credits > (dirTech ? 2400 : 3000)) want = 'lab';
  else if (pl.aiLvl >= 2 && nB('lab') && !nB('silo') && pl.credits > 3200) want = 'silo';
  else if (nB('turret') < turrets + 1 && pl.credits > 2600) want = 'turret';
  // heavy cannon emplacements anchor the line against armor (and outrange MLRS)
  else if (nB('factory') && nB('cannon') < (pl.aiLvl >= 2 ? 2 : 1) && pl.credits > 2200) want = 'cannon';
  // tech defenses once a lab stands: tesla zappers, then an Iron Dome to swat
  // incoming silo missiles (high difficulty / when the enemy has gone nuclear)
  else if (pl.aiLvl >= 2 && nB('lab') && nB('tesla') < 1 && pl.credits > 2600) want = 'tesla';
  else if (pl.aiLvl >= 2 && nB('radar') && !nB('irondome') && enemyHasSilo(sim, p) && pl.credits > 2800) want = 'irondome';
  else if (surplus < 60 && pl.credits > 2400) want = 'power';

  if (want && nB('conyard')) {
    const def = BUILDINGS[want];
    const ok = !def.prereq || nB(def.prereq) > 0;
    if (ok && pl.credits >= cost(want)) {
      // defensive structures: spread across the enemy-facing front so their
      // ranges tile the approach instead of clumping on one spot
      if (want === 'turret' || want === 'sam' || want === 'cannon' || want === 'tesla' || want === 'irondome') {
        const spot = defenseSpot(sim, p, want, basePos(sim, p), defenseDir(sim, p, mem))
          || findSpot(sim, p, want, null);
        if (spot) cmds.push({ k: 'place', p, type: want, cx: spot.x, cz: spot.z });
      } else {
        let toward: { x: number; z: number } | null = null;
        if (want === 'refinery') toward = oreFrontier(sim, p);
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
  // safety net: down to the last 1-2 harvesters, or one being shot at → the
  // economy is about to collapse, so cancel other builds and rush a replacement
  const harvUnderFire = (myU['harv'] || []).some(h => sim.tickN - h.lastHitT < 40);
  const harvEmergency = hasFac && (nU('harv') <= 2 || (harvUnderFire && nU('harv') <= 3));
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
  // anti-air demand scales with the air the enemy is actually fielding now
  const airSeen = mem.seenAir || 0;
  const aaTarget = airSeen >= 1 ? Math.min(8, 2 + Math.ceil(airSeen)) : (antiAir ? 4 : 0);
  const aaPrio = airSeen >= 1 ? 0.6 : 0.35;
  for (const fac of (myB['factory'] || [])) {
    if (fac.progress < fac.total) continue;
    // emergency: scrap whatever this factory is building and slot a harvester
    if (harvEmergency && fac.queue.length && fac.queue[fac.queue.length - 1].type !== 'harv')
      cmds.push({ k: 'cancel', p, bid: fac.id, type: fac.queue[fac.queue.length - 1].type });
    if (fac.queue.length >= 2 && !harvEmergency) continue;
    if (harvEmergency && nU('harv') < harvTarget + 1 && pl.credits > 300) cmds.push({ k: 'train', p, bid: fac.id, type: 'harv' });
    else if (fac.queue.length >= 2) continue;
    else if (nU('harv') < harvTarget && pl.credits > 1000) cmds.push({ k: 'train', p, bid: fac.id, type: 'harv' });
    else if (nU('engineer') < 1 && pl.aiLvl >= 1 && pl.credits > 1500) cmds.push({ k: 'train', p, bid: fac.id, type: 'engineer' });
    // reactive AA is a NEED, not surplus: build to the target even at army cap
    // so an air assault always gets answered (user: "if air seen, build AA/flak")
    else if (airSeen >= 1 && nU('aatank') + nU('flak') < aaTarget && pl.credits > 700) {
      cmds.push({ k: 'train', p, bid: fac.id, type: sim.rng.next() < 0.5 ? 'aatank' : 'flak' });
    }
    else if (armyCount < cap && pl.credits > (ecoShort ? 2200 : 1000)) {
      // islanders keep only a small home guard of vehicles
      const groundArmy = nU('tank') + nU('heavy') + nU('ifv') + nU('mlrs') + nU('aatank') + nU('flak');
      if (island && groundArmy >= 8) continue;
      const r = sim.rng.next();
      const t = nU('mlrs') < L.siege ? 'mlrs'
        : (nU('aatank') + nU('flak') < aaTarget && r < aaPrio) ? (r < aaPrio * 0.5 ? 'aatank' : 'flak')
        : r < (antiInf ? 0.4 : 0.25) ? 'mlrs' // artillery shreds infantry masses
        : r < (antiInf ? 0.7 : 0.42) ? 'ifv'  // autocannons mop up the rest
        : r < (antiInf ? 0.76 : 0.47) && pl.credits > 1600 ? 'fueltruck' // breach charge
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
  if (af && armyCount < cap && pl.credits > (island || dirAir || prefAir ? 1800 : 2000)) {
    const r = sim.rng.next();
    // once the enemy army is broken (but buildings remain), switch to bombers to
    // level the base; vs an air-heavy enemy build interceptors; else a mix
    const enemyCrippled = (mem.enemyCombat ?? 99) <= 3 && (mem.enemyBuildings ?? 0) > 0;
    const t = (enemyCrippled && pl.credits > 2000) ? (r < 0.6 ? 'bomber' : r < 0.85 ? 'dbomber' : 'heli')
      : antiAir ? (r < 0.6 ? 'fighter' : r < 0.85 ? 'heli' : 'helidrone')
      : island && r < 0.35 ? 'bomber'
      : r < 0.4 ? 'fighter' : r < 0.7 ? 'heli' : 'helidrone';
    cmds.push({ k: 'train', p, bid: af.id, type: t });
  }
  // navy: a balanced fleet — gun destroyers to fight ships and shell the coast,
  // a missile cruiser for bombardment, a flak cruiser if the enemy flies, a sub
  // for ambushes, and a sub hunter once enemy subs are about
  const sy = (myB['shipyard'] || []).find(b => b.progress >= b.total && b.queue.length < 2);
  if (sy && waterRel) {
    const seaN = nU('gunboat') + nU('destroyer') + nU('sub') + nU('navdrone') + nU('mslcruiser') + nU('flakship') + nU('subhunter');
    const fleetCap = island ? 6 : 4;
    if (seaN < fleetCap && pl.credits > (ecoShort ? 2600 : 1500)) {
      const enemySubs = countEnemyType(sim, p, 'sub');
      let t: string;
      if (enemySubs > 0 && nU('subhunter') < 2 && sim.rng.next() < 0.5) t = 'subhunter';
      else if (antiAir && nU('flakship') < 2 && sim.rng.next() < 0.4) t = 'flakship'; // screen the fleet from air
      else {
        const r = sim.rng.next();
        t = r < 0.4 ? 'destroyer' : r < 0.6 ? 'mslcruiser' : r < 0.78 ? 'gunboat' : r < 0.92 ? 'sub' : 'flakship';
      }
      cmds.push({ k: 'train', p, bid: sy.id, type: t });
    }
  }

  // missile silo: keep one warhead cooking, launch at the best target when armed
  const silo = (myB['silo'] || []).find(b => b.progress >= b.total);
  if (silo && !silo.storedMissile && !silo.queue.length && pl.credits > 2400) {
    const t = pl.tech['chem'] && sim.rng.next() < 0.4 ? 'chemissile' : 'cmissile';
    cmds.push({ k: 'train', p, bid: silo.id, type: t });
  }
  if (silo && silo.storedMissile && (sim.tickN >= mem.peaceUntil || mem.peaceBroken)) {
    const tgt = bestStrikeTarget(sim, p);
    if (tgt) cmds.push({ k: 'launch', p, bid: silo.id, x: tgt.x, z: tgt.z });
  }

  // research a tech when a lab is idle and we're flush
  const lab = (myB['lab'] || []).find(b => b.progress >= b.total && !b.research);
  if (lab && pl.credits > (dirTech ? 2500 : 3500)) {
    const t = !pl.tech['chem'] ? 'chem' : !pl.tech['bio'] ? 'bio' : !pl.tech['stealth'] ? 'stealth' : null;
    if (t) cmds.push({ k: 'research', p, bid: lab.id, tech: t });
  }
  // === defensive garrison: fortified drone hives + an infantry line, both
  // spread across the enemy-facing front (the learned corridor) and dug in ===
  if (pl.aiLvl >= 1) {
    const base = basePos(sim, p);
    const ddir = defenseDir(sim, p, mem);

    // drone hives: build toward a target, then fan out and fortify the front.
    // the oldest hive anchors home; the rest secure the approach corridor.
    const hives = myU['hive'] || [];
    const hiveTarget = pl.aiLvl >= 3 ? 4 : pl.aiLvl >= 2 ? 3 : 2;
    const bkForHive = (myB['barracks'] || []).find(b => b.progress >= b.total && b.queue.length < 1);
    if (bkForHive && hives.length < hiveTarget && pl.credits > 2200 && (mem.hiveCd || 0) <= sim.tickN) {
      cmds.push({ k: 'train', p, bid: bkForHive.id, type: 'hive' });
      mem.hiveCd = sim.tickN + 22 * TICKS_PER_SEC;
    }
    const sortedH = [...hives].sort((a, b) => a.id - b.id);
    const hPosts = frontPosts(sim, base, ddir, Math.max(1, hives.length), 7, 11);
    sortedH.forEach((h, i) => deployFortify(cmds, p, h, i === 0 ? base : hPosts[i]));

    // fortified infantry line: cheap, dense, dug in behind sandbags. Designate a
    // capped slice of idle riflemen/rockets as defenders (don't gut the army);
    // fortified/marching defenders are auto-excluded from offensive waves.
    const defTarget = island ? 2 : pl.aiLvl >= 3 ? 8 : pl.aiLvl >= 2 ? 6 : 4;
    mem.defenders = (mem.defenders || []).filter(id => { const u = sim.ents.get(id); return !!u && u.hp > 0; });
    if (mem.defenders.length < defTarget) {
      const pool = [...(myU['rifle'] || []), ...(myU['rocket'] || []), ...(myU['chemtrooper'] || []), ...(myU['biotrooper'] || [])];
      for (const u of pool) {
        if (mem.defenders.length >= defTarget) break;
        if (u.fortified || u.fortT > 0 || mem.defenders.includes(u.id)) continue;
        if (u.orders.length && u.orders[0].k === 'attack') continue; // don't recall attackers
        mem.defenders.push(u.id);
      }
    }
    if (mem.defenders.length) {
      const dPosts = frontPosts(sim, base, ddir, mem.defenders.length, 3, 6);
      mem.defenders.forEach((id, i) => { const u = sim.ents.get(id); if (u) deployFortify(cmds, p, u, dPosts[i]); });
    }
  }

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
        // air doctrine: never feed aircraft into live SAM/flak coverage. While
        // the enemy keeps meaningful AA, the GROUND force goes in first and
        // makes the air defences its target; aircraft only commit once the AA
        // is broken (or when we have overwhelming air numbers).
        const airUnits = army.filter(u => UNITS[u.type].fly);
        const ground = army.filter(u => !UNITS[u.type].fly);
        const enemyAA = mem.enemyAA || 0;
        const airSafe = enemyAA === 0 || airUnits.length >= enemyAA * 3;
        const tgt = (enemyAA > 0 && !airSafe ? airDefenseTarget(sim, p) : null) || bestStrikeTarget(sim, p);
        if (tgt) {
          const strikers = airSafe ? army : ground; // hold air back until AA falls
          if (strikers.length) cmds.push({ k: 'attack', p, ids: strikers.map(u => u.id), tgt: tgt.id, x: tgt.x, z: tgt.z });
          mem.nextWave = sim.tickN + waveEvery * TICKS_PER_SEC;
          mem.waveSize = Math.min(cap - 6, mem.waveSize + L.wInc);
        } else mem.nextWave = sim.tickN + 8 * TICKS_PER_SEC;
      }
    }
  }

  return cmds;
}

// how many enemy units of a given type are on the field (gates reactive builds)
function countEnemyType(sim: Sim, p: number, type: string): number {
  let n = 0;
  for (const e of sim.ents.values())
    if (!e.b && e.type === type && e.hp > 0 && sim.foe(e.owner, p) && sim.players[e.owner].alive) n++;
  return n;
}

// does any foe field a finished missile silo? (gates the Iron Dome investment)
function enemyHasSilo(sim: Sim, p: number): boolean {
  for (const e of sim.ents.values())
    if (e.b && e.type === 'silo' && e.progress >= e.total && sim.foe(e.owner, p) && sim.players[e.owner].alive) return true;
  return false;
}

// the player's home reference point: its construction yard, else its spawn
function basePos(sim: Sim, p: number): { x: number; z: number } {
  for (const e of sim.ents.values()) if (e.b && e.owner === p && e.type === 'conyard') return { x: e.x, z: e.z };
  return { ...sim.players[p].spawn };
}

// the direction the base should be facing: the learned attack corridor once a
// few raids have revealed it, otherwise the nearest enemy base, else map centre
function defenseDir(sim: Sim, p: number, mem: AiMem): { x: number; z: number } {
  const b = basePos(sim, p);
  let tx: number, tz: number;
  if ((mem.threatN || 0) >= 3 && mem.threatX !== undefined) { tx = mem.threatX; tz = mem.threatZ!; }
  else { const en = nearestEnemyBuilding(sim, p); if (en) { tx = en.x; tz = en.z; } else { tx = W / 2; tz = H / 2; } }
  const dx = tx - b.x, dz = tz - b.z; const dl = Math.hypot(dx, dz) || 1;
  return { x: dx / dl, z: dz / dl };
}

// pick the best NEW spot for a defensive structure: spread it across the
// enemy-facing front so the weapon ranges tile the approach instead of stacking
// on one spot. Each call fills the widest gap in the current screen.
function defenseSpot(sim: Sim, p: number, type: string, base: { x: number; z: number }, dir: { x: number; z: number }): { x: number; z: number } | null {
  const range = BUILDINGS[type]?.attack?.range || 7;
  const perp = { x: -dir.z, z: dir.x };
  const isAA = type === 'sam';
  const mine: Entity[] = [];
  for (const e of sim.ents.values()) {
    if (!e.b || e.owner !== p) continue;
    if ((e.type === 'turret' || e.type === 'sam') && (e.type === 'sam') === isAA) mine.push(e);
  }
  let best: { x: number; z: number } | null = null, bestScore = -1e9;
  const frontDepth = 7; // sit a little ahead of the base centroid
  for (let along = 3; along <= 12; along++) {
    for (let lat = -14; lat <= 14; lat++) {
      const cx = Math.round(base.x + dir.x * along + perp.x * lat);
      const cz = Math.round(base.z + dir.z * along + perp.z * lat);
      if (!sim.canPlace(p, type, cx, cz)) continue;
      let score = -Math.abs(along - frontDepth) * 0.25; // hug the front line
      let near = Infinity;
      for (const d of mine) near = Math.min(near, Math.hypot(d.x - cx, d.z - cz));
      if (!mine.length) score -= Math.abs(lat) * 0.15;             // first one: centre the front
      else if (near < range * 0.6) score -= (range * 0.6 - near) * 1.5; // too clumped
      else score += Math.min(near, range * 1.3) * 0.4;             // spread ~range apart, tiled coverage
      score += sim.rng.next() * 0.2;
      if (score > bestScore) { bestScore = score; best = { x: cx, z: cz }; }
    }
  }
  return best;
}

// evenly spaced fortify posts fanned across the enemy-facing front, set a
// little ahead of the base; each snapped to the nearest passable cell
function frontPosts(sim: Sim, base: { x: number; z: number }, dir: { x: number; z: number }, n: number, spread: number, depth: number): { x: number; z: number }[] {
  const perp = { x: -dir.z, z: dir.x };
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const lat = (i - (n - 1) / 2) * spread;
    const px = base.x + dir.x * depth + perp.x * lat;
    const pz = base.z + dir.z * depth + perp.z * lat;
    const cp = nearestPassable(sim.map, Math.round(px), Math.round(pz), 8);
    out.push(cp ? { x: cp.x + 0.5, z: cp.z + 0.5 } : { x: base.x, z: base.z });
  }
  return out;
}

// move a fortifiable unit (hive / infantry) to its post and dig in on arrival
function deployFortify(cmds: Cmd[], p: number, u: Entity, post: { x: number; z: number }): void {
  if (u.fortified || u.fortT > 0) return;                       // already dug in / mid-deploy
  if (u.orders.length && u.orders[0].k === 'move') return;      // already marching to a post
  if (Math.hypot(u.x - post.x, u.z - post.z) <= 2.5) cmds.push({ k: 'fortify', p, ids: [u.id] });
  else cmds.push({ k: 'move', p, ids: [u.id], x: post.x, z: post.z });
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
    if (e.b || !sim.foe(e.owner, p) || e.type !== 'harv' || !sim.players[e.owner].alive) continue;
    const d = (e.x - s.x) ** 2 + (e.z - s.z) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// pick the NEAREST soft enemy building — peel the base from its facing edge.
// (Scoring only by "fewest defenses" sent whole armies driving through the
// player's entire base toward the naked rear power plant.)
function bestStrikeTarget(sim: Sim, p: number): Entity | null {
  const s = sim.players[p].spawn;
  const enemyB: Entity[] = [], defenders: Entity[] = [];
  for (const e of sim.ents.values()) {
    if (!e.b || !sim.foe(e.owner, p) || !sim.players[e.owner].alive) continue;
    if (e.type === 'wall' || e.type === 'barrier') continue; // not worth a wave — route around
    enemyB.push(e);
    if (e.type === 'turret' || e.type === 'sam') defenders.push(e);
  }
  if (!enemyB.length) return null;
  let best: Entity | null = null, bestScore = 1e9;
  for (const e of enemyB) {
    let near = 0;
    for (const d of defenders) if ((d.x - e.x) ** 2 + (d.z - e.z) ** 2 < 12 * 12) near++;
    const dHome = Math.hypot(e.x - s.x, e.z - s.z);
    const priority = e.type === 'refinery' || e.type === 'power' || e.type === 'conyard' ? -1.2 : 0;
    const score = near * 1.2 + dHome * 0.1 + priority;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}

// nearest enemy anti-air (battery or mobile AA) — the ground force clears these
// before the AI commits aircraft, so planes never fly into a SAM net
function airDefenseTarget(sim: Sim, p: number): Entity | null {
  const s = sim.players[p].spawn;
  let best: Entity | null = null, bd = 1e9;
  for (const e of sim.ents.values()) {
    if (!sim.foe(e.owner, p) || e.hp <= 0 || !sim.players[e.owner].alive) continue;
    if (e.type !== 'sam' && e.type !== 'aatank' && e.type !== 'flak') continue;
    const d = (e.x - s.x) ** 2 + (e.z - s.z) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function nearestEnemyBuilding(sim: Sim, p: number): Entity | null {
  const s = sim.players[p].spawn;
  let best: Entity | null = null, bd = 1e9;
  for (const e of sim.ents.values()) {
    if (!e.b || !sim.foe(e.owner, p) || !sim.players[e.owner].alive) continue;
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
