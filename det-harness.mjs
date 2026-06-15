// Determinism gate — Node (V8) baseline for the lockstep fork.
//
//   node det-harness.mjs
//
// Prints the math-canary digest and per-seed state-hash digests. Run this on
// the SAME engine twice → digests must be identical (proves the harness itself
// is deterministic). Then run __detmath()/__detsim() in a *different* browser
// engine (Firefox/Safari) and compare — see LOCKSTEP.md. Any mismatch is a
// cross-engine nondeterminism that must be fixed before lockstep can work.
import { build } from 'esbuild';
import { writeFileSync } from 'fs';

const res = await build({ entryPoints: ['src/sim/headless-entry.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
writeFileSync('.sim-bundle.mjs', res.outputFiles[0].text);
const { runDeterminismProbe, mathCanary } = await import('./.sim-bundle.mjs?' + Date.now());

const SEEDS = [12345, 0x1000, 777, 2026];
const TICKS = Number(process.argv[2] || 3000);

console.log(`engine: node ${process.version} (V8)`);
console.log(`mathCanary: ${mathCanary()}`);
for (const seed of SEEDS) {
  // run twice — same engine MUST agree, or the sim is nondeterministic even
  // within one engine (a bug to fix regardless of lockstep)
  const a = runDeterminismProbe(seed, 112, TICKS);
  const b = runDeterminismProbe(seed, 112, TICKS);
  const stable = a.final === b.final && a.samples.every((s, i) => s.hash === b.samples[i]?.hash);
  console.log(`seed ${seed}: ticks=${a.ticks} final=${a.final} ents=${a.samples.at(-1)?.ents ?? '-'} sameEngineStable=${stable}`);
}
