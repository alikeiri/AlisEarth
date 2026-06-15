// Deterministic lockstep — the netcode model that scales to thousands of units
// (bandwidth = O(inputs), independent of unit count). Each client runs its own
// Sim; clients exchange only INPUTS (commands), and every client applies the
// same input set on the same tick. The determinism gate (see determinism.ts /
// LOCKSTEP.md) proved the sim is bit-identical across engines, so all clients
// stay in perfect sync.
//
// This module is transport-agnostic: LockstepEngine emits/consumes InputMsgs via
// callbacks. Step 3a wires two engines through a FakeLink in one process to
// validate the MODEL (input-delay scheduling, redundant-window loss recovery,
// stall-and-catch-up) with no real network. Step 3b swaps FakeLink for
// WebTransport/WebRTC — the engine is unchanged.
import { Sim } from './sim';
import { RNG } from './rng';
import { aiTick } from './ai';
import { setMapSize } from './map';
import { hashSim } from './determinism';

export type Cmd = any;
export interface Frame { tick: number; cmds: Cmd[] }
// a player's input message carries a redundant window of recent frames so a
// dropped packet is recovered by the next one without any retransmit round-trip
export interface InputMsg { player: number; frames: Frame[] }

export interface LockstepOpts {
  delay?: number;        // input delay in ticks (must exceed peak one-way latency)
  redundancy?: number;   // recent local frames resent per message (>= delay + loss margin)
}

// One client's lockstep loop around a single Sim.
export class LockstepEngine {
  readonly sim: Sim;
  readonly localPlayer: number;
  readonly nPlayers: number;
  readonly delay: number;
  readonly redundancy: number;
  send: (msg: InputMsg) => void = () => {};        // wired to the transport
  localInput: (sim: Sim) => Cmd[] = () => [];      // produces this client's commands for the current tick
  aiFor: (sim: Sim, player: number) => Cmd[] = () => []; // input for a dropped (now AI-run) player
  onTick: () => void = () => {};                    // called after each executed tick (drain events, etc.)
  recordHashes = true;                              // hash state per tick (for verification; off in real play)
  // inputs[tick] = per-player command lists (undefined = not yet known)
  private inputs = new Map<number, (Cmd[] | undefined)[]>();
  private localHistory: Frame[] = [];
  private produced = new Set<number>();            // ticks we've already generated local input for
  private lastInput: number[];                      // highest tick we hold input for, per player
  private droppedFrom = new Map<number, number>();  // player -> first tick they're AI-controlled
  stalls = 0;                                       // diagnostics: how often we waited on a peer
  hashes = new Map<number, string>();              // executed-tick -> state digest (for verification)

  constructor(sim: Sim, localPlayer: number, nPlayers: number, opts: LockstepOpts = {}) {
    this.sim = sim;
    this.localPlayer = localPlayer;
    this.nPlayers = nPlayers;
    this.delay = opts.delay ?? 4;
    this.redundancy = opts.redundancy ?? 12;
    this.lastInput = new Array(nPlayers).fill(this.delay - 1);
    // the first `delay` ticks have no real input — everyone agrees they're empty,
    // which lets the sims start while the first real inputs propagate
    for (let t = 0; t < this.delay; t++) this.inputs.set(t, new Array(nPlayers).fill([]));
  }

  // a peer disconnected: from `fromTick` on, this client computes that player's
  // input locally via the (deterministic) AI. Every surviving client does the
  // same from the SAME server-agreed tick, so the sims stay identical.
  dropToAI(player: number, fromTick: number) { this.droppedFrom.set(player, fromTick); }
  // the last tick we hold this player's input for (for the server's drop vote)
  lastInputTickFor(player: number): number { return this.lastInput[player]; }

  private slot(tick: number): (Cmd[] | undefined)[] {
    let s = this.inputs.get(tick);
    if (!s) { s = new Array(this.nPlayers).fill(undefined); this.inputs.set(tick, s); }
    return s;
  }

  // a peer's inputs arrived — record any frames we don't already have (idempotent;
  // first value wins, so duplicates from the redundant window are harmless)
  receive(msg: InputMsg) {
    for (const f of msg.frames) {
      const s = this.slot(f.tick);
      if (s[msg.player] === undefined) s[msg.player] = f.cmds;
      if (f.tick > this.lastInput[msg.player]) this.lastInput[msg.player] = f.tick;
    }
  }

  // is player p's input for tick T available (or supplied by AI because p was dropped)?
  private have(p: number, s: (Cmd[] | undefined)[], tick: number): boolean {
    if (s[p] !== undefined) return true;
    const from = this.droppedFrom.get(p);
    return from !== undefined && tick >= from;
  }
  private ready(): boolean {
    const s = this.inputs.get(this.sim.tickN);
    if (!s) return false;
    for (let p = 0; p < this.nPlayers; p++) if (!this.have(p, s, this.sim.tickN)) return false;
    return true;
  }

  // generate-and-broadcast local input for the current tick, then execute as many
  // ticks as we have everyone's input for. Call once per wall tick.
  pump(maxTick = Infinity) {
    for (;;) {
      // schedule this client's input for (now + delay), based on the state we can
      // "see" right now — exactly what a player does when they click
      if (!this.produced.has(this.sim.tickN)) {
        this.produced.add(this.sim.tickN);
        const cmds = this.localInput(this.sim) || [];
        const tick = this.sim.tickN + this.delay;
        this.slot(tick)[this.localPlayer] = cmds;
        if (tick > this.lastInput[this.localPlayer]) this.lastInput[this.localPlayer] = tick;
        this.localHistory.push({ tick, cmds });
        while (this.localHistory.length > this.redundancy) this.localHistory.shift();
        this.send({ player: this.localPlayer, frames: this.localHistory.slice() });
      }
      if (this.sim.tickN >= maxTick) return;
      if (!this.ready()) { this.stalls++; return; }    // waiting on a peer's input
      const s = this.inputs.get(this.sim.tickN)!;
      const merged: Cmd[] = [];
      for (let p = 0; p < this.nPlayers; p++) {
        // a dropped player's missing input is regenerated locally by the AI —
        // deterministic, so every surviving client produces the identical command
        const cmds = s[p] !== undefined ? s[p]! : this.aiFor(this.sim, p) || [];
        merged.push(...cmds);
      }
      const executed = this.sim.tickN;
      this.sim.tick(merged);
      this.inputs.delete(executed);                    // gc consumed inputs
      if (this.recordHashes) this.hashes.set(this.sim.tickN, hashSim(this.sim));
      this.onTick();                                   // let the host drain per-tick events
    }
  }
}

// ---- Step 3a: in-process two-client harness (no real network) ----

// a fake transport with configurable latency / jitter / packet loss, driven by a
// seeded RNG so every run is reproducible. Messages are delivered in "rounds"
// (≈ wall ticks); the redundant window must recover dropped frames.
class FakeLink {
  private q: { at: number; to: 0 | 1; msg: InputMsg }[] = [];
  private now = 0;
  constructor(
    private a: LockstepEngine, private b: LockstepEngine,
    private rng: RNG, private latency: number, private jitter: number, private drop: number,
  ) {
    a.send = m => this.queue(1, m);
    b.send = m => this.queue(0, m);
  }
  private queue(to: 0 | 1, msg: InputMsg) {
    if (this.rng.next() < this.drop) return;           // packet lost (redundant window will recover)
    const lat = this.latency + Math.floor(this.rng.next() * (this.jitter + 1));
    this.q.push({ at: this.now + lat, to, msg });
  }
  pump() {
    this.now++;
    const due = this.q.filter(m => m.at <= this.now);
    this.q = this.q.filter(m => m.at > this.now);
    for (const m of due) (m.to === 0 ? this.a : this.b).receive(m.msg);
  }
  inFlight() { return this.q.length; }
}

export interface NetlessResult {
  ticks: number; inSync: boolean; firstDivergeTick: number | null;
  stallsA: number; stallsB: number; finalA: string; finalB: string;
  delay: number; latency: number; jitter: number; drop: number;
}

// Run two lockstep clients (each driving its own player's AI as "input") through
// the fake link for `ticks` ticks, then verify both executed identical state at
// every tick. Returns the verdict + diagnostics.
export function runNetlessLockstep(
  seed: number, ticks: number,
  opts: { size?: number; delay?: number; redundancy?: number; latency?: number; jitter?: number; drop?: number } = {},
): NetlessResult {
  const size = opts.size ?? 112, delay = opts.delay ?? 6, redundancy = opts.redundancy ?? 16;
  const latency = opts.latency ?? 2, jitter = opts.jitter ?? 1, drop = opts.drop ?? 0;
  setMapSize(size);
  const specs = [
    { name: 'A', faction: 'usa', isAI: true, aiLvl: 2 },
    { name: 'B', faction: 'china', isAI: true, aiLvl: 2 },
  ];
  const simA = new Sim(seed, specs.map(s => ({ ...s })));
  const simB = new Sim(seed, specs.map(s => ({ ...s })));
  const A = new LockstepEngine(simA, 0, 2, { delay, redundancy });
  const B = new LockstepEngine(simB, 1, 2, { delay, redundancy });
  A.localInput = s => aiTick(s, 0);
  B.localInput = s => aiTick(s, 1);
  const link = new FakeLink(A, B, new RNG((seed ^ 0xa5a5a5a5) >>> 0), latency, jitter, drop);

  let guard = 0, firstDiverge: number | null = null;
  while ((simA.tickN < ticks || simB.tickN < ticks) && guard++ < ticks * 20) {
    A.pump(ticks); B.pump(ticks);
    link.pump();
    // compare every tick both have executed but not yet checked
    const common = Math.min(simA.tickN, simB.tickN);
    for (let t = 1; t <= common; t++) {
      const ha = A.hashes.get(t), hb = B.hashes.get(t);
      if (ha && hb && ha !== hb && firstDiverge === null) { firstDiverge = t; break; }
    }
    if (firstDiverge !== null) break;
  }

  let inSync = firstDiverge === null;
  // final cross-check over the full executed range
  const upto = Math.min(simA.tickN, simB.tickN);
  for (let t = 1; t <= upto && inSync; t++) if (A.hashes.get(t) !== B.hashes.get(t)) { inSync = false; firstDiverge = t; }

  return {
    ticks: upto, inSync, firstDivergeTick: firstDiverge,
    stallsA: A.stalls, stallsB: B.stalls,
    finalA: A.hashes.get(upto) || '-', finalB: B.hashes.get(upto) || '-',
    delay, latency, jitter, drop,
  };
}
