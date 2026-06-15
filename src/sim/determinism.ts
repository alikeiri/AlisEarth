// Determinism harness — the GATE for the deterministic-lockstep fork.
//
// Lockstep only works if every client's sim produces byte-identical state from
// the same seed + input stream. The replay system proves that WITHIN one JS
// engine, but NOT across engines: IEEE-754 does not mandate correctly-rounded
// results for Math.sin/cos/tan/atan2/exp/log/pow/hypot, so V8 (Chrome/Node),
// SpiderMonkey (Firefox) and JavaScriptCore (Safari) can disagree in the last
// bit — and those tiny diffs compound into a full desync.
//
// This module runs an AI-vs-AI game (a deterministic input stream) and hashes
// the EXACT float bits of the sim state at intervals. Run it in two engines and
// diff the hashes: first differing tick = where (and how fast) they diverge.
import { Sim } from './sim';
import { aiTick } from './ai';
import { setMapSize } from './map';
import { hyp, dsin, dcos } from './dmath';

// FNV-1a (32-bit) over a byte stream. Math.imul keeps the multiply integer and
// identical across engines, so the hash itself never introduces divergence.
class Hasher {
  h = 0x811c9dc5;
  private buf = new ArrayBuffer(8);
  private dv = new DataView(this.buf);
  byte(n: number) { this.h = Math.imul(this.h ^ (n & 0xff), 0x01000193); }
  u32(n: number) { this.byte(n); this.byte(n >>> 8); this.byte(n >>> 16); this.byte(n >>> 24); }
  // hash the raw IEEE-754 bits so a 1-ULP divergence flips the digest
  f64(v: number) { this.dv.setFloat64(0, v); this.u32(this.dv.getUint32(0)); this.u32(this.dv.getUint32(4)); }
  str(s: string) { for (let i = 0; i < s.length; i++) this.u32(s.charCodeAt(i)); }
  hex() { return (this.h >>> 0).toString(16).padStart(8, '0'); }
}

function hashState(sim: any): string {
  const h = new Hasher();
  const ents = [...sim.ents.values()].sort((a: any, b: any) => a.id - b.id);
  h.u32(ents.length);
  for (const e of ents) {
    h.u32(e.id); h.byte(e.owner); h.str(e.type);
    h.f64(e.x); h.f64(e.z); h.f64(e.hp); h.f64(e.cd || 0);
    h.f64(e.aimX || 0); h.f64(e.aimZ || 0);
    h.u32(e.orders ? e.orders.length : 0);
  }
  return h.hex();
}

export interface DetSample { tick: number; hash: string; ents: number }
export interface DetResult { seed: number; size: number; ticks: number; samples: DetSample[]; final: string }

// Deterministic AI-vs-AI run; samples a state hash every `sampleEvery` ticks.
export function runDeterminismProbe(seed: number, size = 112, ticks = 3000, sampleEvery = 100): DetResult {
  setMapSize(size);
  const sim: any = new Sim(seed, [
    { name: 'A', faction: 'usa', isAI: true, aiLvl: 2 },
    { name: 'B', faction: 'china', isAI: true, aiLvl: 2 },
  ]);
  const samples: DetSample[] = [];
  while (!sim.done && sim.tickN < ticks) {
    const cmds: any[] = [];
    for (let p = 0; p < 2; p++) cmds.push(...aiTick(sim, p));
    sim.tick(cmds);
    if (sim.tickN % sampleEvery === 0) samples.push({ tick: sim.tickN, hash: hashState(sim), ents: sim.ents.size });
  }
  return { seed, size, ticks: sim.tickN, samples, final: hashState(sim) };
}

// Isolated canary for ONLY the transcendentals the sim actually uses on its
// state path (hypot, sin, cos, atan2; sqrt is IEEE-mandated correctly-rounded
// so it's a control). A fast first signal that doesn't need a whole game — if
// THIS digest differs across engines, every distance/heading in the sim is
// suspect and must be made deterministic before lockstep can work. Inputs span
// small headings up to large arguments (where libm range-reduction differs).
export function mathCanary(): string {
  const h = new Hasher();
  for (let i = 1; i <= 2000; i++) {
    const x = i * 0.123456789, y = (i % 37) + 0.5;
    h.f64(Math.sin(x)); h.f64(Math.cos(x));
    h.f64(Math.atan2(y, x)); h.f64(Math.atan2(x, y));
    h.f64(Math.hypot(x, y)); h.f64(Math.hypot(x - y, y * 0.3));
    h.f64(Math.sqrt(x * y)); // control: should match everywhere
  }
  return h.hex();
}

// The same battery through the sim's DETERMINISTIC replacements (dmath). Built
// only from +,-,*,/,sqrt,round, so this digest MUST be identical on every
// engine. If __detmath() differs across engines but __detmathDet() matches,
// the deterministic-math migration is working.
export function detMathCanary(): string {
  const h = new Hasher();
  for (let i = 1; i <= 2000; i++) {
    const x = i * 0.123456789, y = (i % 37) + 0.5;
    h.f64(dsin(x)); h.f64(dcos(x));
    h.f64(hyp(x, y)); h.f64(hyp(x - y, y * 0.3));
    h.f64(Math.sqrt(x * y));
  }
  return h.hex();
}
