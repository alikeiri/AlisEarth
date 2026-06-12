// Worker: runs an assigned slice of AI-vs-AI games and reports partial stats.
import { parentPort, workerData } from 'worker_threads';
const mod = await import('./.sim-bundle.mjs');
const { Sim, aiTick, FACTIONS, setMapSize, UNITS, BUILDINGS } = mod;

const { seeds, SIZE, DIFF, MAX_TICKS } = workerData;
const facIds = Object.keys(FACTIONS);
const part = {
  elim: 0, draws: 0,
  winByFaction: {}, playByFaction: {},
  unitsBuilt: {}, buildingsBuilt: {},
  winnerArmyPeak: [], gameLenSec: [], firstBloodSec: [], survivorTurrets: [], done: 0,
};
for (const f of facIds) { part.winByFaction[f] = 0; part.playByFaction[f] = 0; }

for (const seed of seeds) {
  setMapSize(SIZE);
  const fa = facIds[seed % facIds.length];
  const fb = facIds[(seed * 7 + 3) % facIds.length];
  const sim = new Sim(seed, [
    { name: 'A', faction: fa, isAI: true, aiLvl: DIFF },
    { name: 'B', faction: fb, isAI: true, aiLvl: DIFF },
  ]);
  part.playByFaction[fa]++; part.playByFaction[fb]++;
  const built = [{}, {}];
  const seen = new Set();
  let firstBlood = -1;
  const peakArmy = [0, 0];

  while (!sim.done && sim.tickN < MAX_TICKS) {
    const cmds = [];
    for (let p = 0; p < 2; p++) cmds.push(...aiTick(sim, p));
    sim.tick(cmds);
    for (const e of sim.ents.values()) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (built[e.owner]) built[e.owner][e.type] = (built[e.owner][e.type] || 0) + 1;
    }
    if (firstBlood < 0 && sim.dmgLog.length) firstBlood = sim.tickN;
    if (sim.tickN % 100 === 0)
      for (let p = 0; p < 2; p++) {
        let a = 0;
        for (const e of sim.ents.values()) if (!e.b && e.owner === p && UNITS[e.type]?.dmg > 0) a++;
        peakArmy[p] = Math.max(peakArmy[p], a);
      }
  }

  part.gameLenSec.push(Math.round(sim.tickN / 10));
  if (firstBlood >= 0) part.firstBloodSec.push(Math.round(firstBlood / 10));
  for (let p = 0; p < 2; p++)
    for (const t in built[p]) {
      const tgt = BUILDINGS[t] ? part.buildingsBuilt : part.unitsBuilt;
      tgt[t] = (tgt[t] || 0) + built[p][t];
    }
  if (sim.winner >= 0) {
    part.elim++;
    part.winByFaction[sim.players[sim.winner].faction]++;
    part.winnerArmyPeak.push(peakArmy[sim.winner]);
    let tur = 0;
    for (const e of sim.ents.values())
      if (e.b && e.owner === sim.winner && (e.type === 'turret' || e.type === 'sam')) tur++;
    part.survivorTurrets.push(tur);
  } else part.draws++;
  part.done++;
  parentPort.postMessage({ tick: true });
}
parentPort.postMessage({ result: part });
