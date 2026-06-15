// Deterministic math for the sim path (lockstep fork).
//
// IEEE-754 mandates correctly-rounded +, -, *, /, and sqrt, so any function
// built only from those is bit-identical across compliant JS engines. Math.hypot
// and Math.sin/cos are NOT mandated correctly-rounded and DO differ across
// engines (proven by the determinism canary) — so the sim must avoid them and
// use these instead. Rendering can keep native Math; only the simulation needs
// to agree across machines.

// 2-D length — replaces Math.hypot(a,b). sqrt is correctly-rounded everywhere.
export function hyp(a: number, b: number): number { return Math.sqrt(a * a + b * b); }

const PI = 3.141592653589793;        // Math.PI's bits, written literally for clarity
const HALF_PI = 1.5707963267948966;
const TWO_PI = 6.283185307179586;

// sin via deterministic range reduction + a Taylor/Horner polynomial (only
// +,-,*,/ and Math.round, which is exact/spec-defined). Accurate to ~1e-6 on
// the reduced range — ample for headings/formation offsets, and identical on
// every engine. The sim uses trig in only a handful of non-critical spots.
export function dsin(x: number): number {
  let t = x - Math.round(x / TWO_PI) * TWO_PI;      // reduce to [-PI, PI]
  if (t > HALF_PI) t = PI - t;                       // fold to [-PI/2, PI/2]
  else if (t < -HALF_PI) t = -PI - t;
  const t2 = t * t;
  return t * (1 + t2 * (-1 / 6 + t2 * (1 / 120 + t2 * (-1 / 5040 + t2 * (1 / 362880)))));
}
export function dcos(x: number): number { return dsin(x + HALF_PI); }
