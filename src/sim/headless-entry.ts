// Re-exports for the headless batch runner (pure sim, no client imports).
export { Sim } from './sim';
export { aiTick } from './ai';
export { FACTIONS, UNITS, BUILDINGS } from './data';
export { setMapSize } from './map';
export { runDeterminismProbe, mathCanary, detMathCanary } from './determinism';
export { runNetlessLockstep, LockstepEngine } from './lockstep';
