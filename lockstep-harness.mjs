// Step 3a — netless lockstep validation (no real network).
//
//   node lockstep-harness.mjs [ticks]
//
// Runs two independent Sim instances as lockstep clients through a fake link with
// varying latency / jitter / packet loss, and verifies both execute byte-identical
// state every tick. This proves the lockstep MODEL (input-delay scheduling,
// redundant-window loss recovery, stall-and-catch-up) before any transport is wired.
import { build } from 'esbuild';
import { writeFileSync } from 'fs';

const res = await build({ entryPoints: ['src/sim/headless-entry.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
writeFileSync('.sim-bundle.mjs', res.outputFiles[0].text);
const { runNetlessLockstep } = await import('./.sim-bundle.mjs?' + Date.now());

const TICKS = Number(process.argv[2] || 1200);
const SEED = 12345;

// each scenario stresses a different failure mode; all must stay in sync
const scenarios = [
  { name: 'ideal (no latency/loss)',        delay: 6,  latency: 0,  jitter: 0, drop: 0 },
  { name: 'latency < delay (smooth)',       delay: 6,  latency: 3,  jitter: 1, drop: 0 },
  { name: 'latency > delay (stall+catchup)', delay: 4,  latency: 9,  jitter: 3, drop: 0 },
  { name: '10% packet loss (redundancy)',   delay: 6,  latency: 3,  jitter: 2, drop: 0.10 },
  { name: '30% loss + high jitter',         delay: 8,  latency: 4,  jitter: 5, drop: 0.30 },
];

console.log(`engine: node ${process.version}  ticks: ${TICKS}\n`);
let allOk = true;
for (const sc of scenarios) {
  const r = runNetlessLockstep(SEED, TICKS, sc);
  const ok = r.inSync && r.ticks >= TICKS - sc.delay - 2; // reached the end and never diverged
  allOk = allOk && ok;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${sc.name.padEnd(30)} ` +
    `ticks=${r.ticks} inSync=${r.inSync}` +
    (r.firstDivergeTick !== null ? ` DIVERGED@${r.firstDivergeTick}` : '') +
    ` stalls(A/B)=${r.stallsA}/${r.stallsB} final=${r.finalA}${r.finalA === r.finalB ? '' : ' != ' + r.finalB}`,
  );
}
console.log(`\n${allOk ? 'ALL SCENARIOS PASS — lockstep model holds under latency/jitter/loss' : 'SOME SCENARIOS FAILED'}`);
