// Parallel AI-vs-AI batch: bundles the sim once, fans games across worker
// threads (one per core), aggregates balance telemetry. Observable via
// batch-progress.txt.
import { build } from 'esbuild';
import { Worker } from 'worker_threads';
import { writeFileSync, appendFileSync } from 'fs';
import os from 'os';

const N = Number(process.argv[2] || 100);
const SIZE = 128, DIFF = 3, MAX_TICKS = 15 * 60 * 10; // 15 in-game min cap (stalemate = draw)
const WORKERS = Math.max(2, Math.min(os.cpus().length - 1, 12));
const PROG = 'batch-progress.txt';

// bundle the sim once to a file the workers import
const res = await build({ entryPoints: ['src/sim/headless-entry.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
writeFileSync('.sim-bundle.mjs', res.outputFiles[0].text);
writeFileSync(PROG, `parallel batch: ${N} games, Brutal, ${SIZE} map, ${WORKERS} workers\n`);

const facIds = ['usa', 'eu', 'russia', 'iran', 'turkey', 'pakistan', 'india', 'gulf', 'au', 'china', 'korea', 'taiwan', 'australia', 'brazil', 'argentina', 'canada'];
const seeds = Array.from({ length: N }, (_, i) => 0x1000 + i * 101);
const slices = Array.from({ length: WORKERS }, () => []);
seeds.forEach((s, i) => slices[i % WORKERS].push(s));

const agg = {
  elim: 0, draws: 0, winByFaction: {}, playByFaction: {},
  unitsBuilt: {}, buildingsBuilt: {},
  winnerArmyPeak: [], gameLenSec: [], firstBloodSec: [], survivorTurrets: [],
};
for (const f of facIds) { agg.winByFaction[f] = 0; agg.playByFaction[f] = 0; }
const merge = (dst, src) => { for (const k in src) dst[k] = (dst[k] || 0) + src[k]; };

const t0 = Date.now();
let done = 0;
await Promise.all(slices.map(slice => new Promise((resolve, reject) => {
  const w = new Worker('./sim-worker.mjs', { workerData: { seeds: slice, SIZE, DIFF, MAX_TICKS } });
  w.on('message', m => {
    if (m.tick) { done++; if (done % 5 === 0) appendFileSync(PROG, `  ${done}/${N} games (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`); return; }
    if (m.result) {
      const r = m.result;
      agg.elim += r.elim; agg.draws += r.draws;
      merge(agg.winByFaction, r.winByFaction); merge(agg.playByFaction, r.playByFaction);
      merge(agg.unitsBuilt, r.unitsBuilt); merge(agg.buildingsBuilt, r.buildingsBuilt);
      agg.winnerArmyPeak.push(...r.winnerArmyPeak);
      agg.gameLenSec.push(...r.gameLenSec);
      agg.firstBloodSec.push(...r.firstBloodSec);
      agg.survivorTurrets.push(...r.survivorTurrets);
    }
  });
  w.on('error', reject);
  w.on('exit', resolve);
})));

const med = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
const games = agg.elim + agg.draws;
let out = `\n===== RESULTS (${games} games, Brutal, ${SIZE} map, ${((Date.now() - t0) / 1000).toFixed(0)}s) =====\n`;
out += `eliminations: ${agg.elim} | draws/timeouts: ${agg.draws}\n`;
out += `median game length: ${med(agg.gameLenSec)}s | median first-blood: ${med(agg.firstBloodSec)}s\n`;
out += `avg winner army peak: ${avg(agg.winnerArmyPeak)} | median survivor turrets+SAMs: ${med(agg.survivorTurrets)}\n`;
out += `\nFACTION WIN RATE:\n`;
for (const f of facIds) {
  const w = agg.winByFaction[f], pl = agg.playByFaction[f];
  out += `  ${f.padEnd(9)} ${String(w).padStart(3)}/${String(pl).padStart(3)}  ${pl ? (w / pl * 100).toFixed(1) : '0'}%\n`;
}
out += `\nUNITS BUILT (total):\n`;
for (const [t, n] of Object.entries(agg.unitsBuilt).sort((a, b) => b[1] - a[1])) out += `  ${t.padEnd(10)} ${n}\n`;
out += `\nBUILDINGS BUILT (total):\n`;
for (const [t, n] of Object.entries(agg.buildingsBuilt).sort((a, b) => b[1] - a[1])) out += `  ${t.padEnd(10)} ${n}\n`;
appendFileSync(PROG, out);
writeFileSync('batch-results.json', JSON.stringify(agg, null, 2));
console.log(out);
