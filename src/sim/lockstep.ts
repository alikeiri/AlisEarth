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
  private nextProduce = 0;                          // next tick we'll generate local input for (advanced
                                                    // by a free-running wall clock, NOT sim ticks)
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
    this.nextProduce = this.delay; // first real local input is for tick `delay`
    // the first `delay` ticks have no real input — everyone agrees they're empty,
    // which lets the sims start while the first real inputs propagate
    for (let t = 0; t < this.delay; t++) this.inputs.set(t, new Array(nPlayers).fill([]));
  }

  // a peer disconnected: from `fromTick` on, this client computes that player's
  // input locally via the (deterministic) AI. Every surviving client does the
  // same from the SAME server-agreed tick, so the sims stay identical.
  dropToAI(player: number, fromTick: number) { this.droppedFrom.set(player, fromTick); }
  // a peer disconnected (left or lost connection): RESIGN them — every client
  // injects the same surrender at the same agreed tick, scuttling their forces so
  // the game continues (and ends if only one team is left) instead of freezing.
  dropToResign(player: number, fromTick: number) { this.resignFrom.set(player, fromTick); }
  private resignFrom = new Map<number, number>(); // player -> earliest tick they may resign
  private resignDone = new Set<number>();          // players whose one-time surrender has been injected
  // the last tick we hold this player's input for (for the server's drop vote)
  lastInputTickFor(player: number): number { return this.lastInput[player]; }
  // per-player input "lead": how many ticks ahead of our current sim tick we have
  // this player's input buffered. A healthy peer sits near `delay`+; a peer near 0
  // is the one starving the lockstep (the bottleneck behind stalls).
  inputLeads(): number[] { return this.lastInput.map(t => t - this.sim.tickN); }

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
    const ai = this.droppedFrom.get(p);
    if (ai !== undefined && tick >= ai) return true;
    const rf = this.resignFrom.get(p);
    return rf !== undefined && tick >= rf;          // resigned: input is "known" (surrender then nothing)
  }
  private ready(): boolean {
    const s = this.inputs.get(this.sim.tickN);
    if (!s) return false;
    for (let p = 0; p < this.nPlayers; p++) if (!this.have(p, s, this.sim.tickN)) return false;
    return true;
  }

  // Generate + broadcast this client's input for every tick up to `frontier`,
  // based on the state the player can "see" right now. CRUCIAL: this is driven by
  // a free-running wall clock, not by sim advancement — so when our sim stalls
  // waiting on a peer we KEEP feeding the peer our future inputs. Tying production
  // to sim ticks (the old behaviour) made a single stall cascade into a
  // one-tick-per-round-trip crawl, because neither side could send ahead while
  // waiting on the other. Idempotent: only ticks past nextProduce are emitted.
  produceTo(frontier: number) {
    let any = false;
    while (this.nextProduce <= frontier) {
      const tick = this.nextProduce++;
      const cmds = this.localInput(this.sim) || [];
      this.slot(tick)[this.localPlayer] = cmds;
      if (tick > this.lastInput[this.localPlayer]) this.lastInput[this.localPlayer] = tick;
      this.localHistory.push({ tick, cmds });
      while (this.localHistory.length > this.redundancy) this.localHistory.shift();
      any = true;
    }
    if (any) this.send({ player: this.localPlayer, frames: this.localHistory.slice() }); // redundant window
  }

  // Execute as many ticks as we have everyone's input for, up to maxTick. The live
  // client also calls produceTo() on a wall clock; the default here keeps production
  // at least at the sim frontier so the in-process harness still works standalone.
  pump(maxTick = Infinity) {
    this.produceTo(this.sim.tickN + this.delay);
    while (this.sim.tickN < maxTick) {
      if (!this.ready()) { this.stalls++; return; }    // waiting on a peer's input
      const s = this.inputs.get(this.sim.tickN)!;
      const merged: Cmd[] = [];
      for (let p = 0; p < this.nPlayers; p++) {
        let cmds: Cmd[];
        if (s[p] !== undefined) cmds = s[p]!;
        else if (this.resignFrom.has(p)) {
          // a disconnected player resigns: inject the surrender ONCE, on the first
          // tick we lack their real input (the resume point is identical on every
          // client once the redundant window has converged), then no more input
          if (!this.resignDone.has(p)) { this.resignDone.add(p); cmds = [{ k: 'surrender', p, reason: 'left' }]; }
          else cmds = [];
        } else {
          // a dropped player's missing input is regenerated locally by the AI —
          // deterministic, so every surviving client produces the identical command
          cmds = this.aiFor(this.sim, p) || [];
        }
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

// ---- Realtime harness: two clients on INDEPENDENT wall clocks over a latency
// link. The synchronous harness above pumps both engines in lockstep each round,
// so it can't expose the failure where a stall freezes input production. This one
// frames each client on its own ms clock and delivers messages with real latency
// + jitter. mode 'wall' = produce input on the wall clock (the fix); mode 'sim' =
// produce only at the sim frontier (the old behaviour) — for an apples-to-apples
// stall comparison. Returns whether the two sims stayed bit-identical + stalls.
export interface RealtimeResult {
  mode: string; targetTicks: number; reachedA: number; reachedB: number;
  inSync: boolean; firstDiverge: number | null; stallsA: number; stallsB: number;
  rttMs: number; jitterMs: number; wallMs: number;
}

export function runRealtimeLockstep(
  seed: number, targetTicks: number,
  opts: { mode?: 'wall' | 'sim'; size?: number; delay?: number; redundancy?: number;
          rttMs?: number; jitterMs?: number; drop?: number;
          hitchEveryMs?: number; hitchMs?: number } = {},
): RealtimeResult {
  const mode = opts.mode ?? 'wall';
  const size = opts.size ?? 96, delay = opts.delay ?? 6, redundancy = opts.redundancy ?? 16;
  const rttMs = opts.rttMs ?? 132, jitterMs = opts.jitterMs ?? 20, drop = opts.drop ?? 0;
  // peer B periodically "hitches" (stops framing) — models a janky/slow/backgrounded peer
  const hitchEveryMs = opts.hitchEveryMs ?? 0, hitchMs = opts.hitchMs ?? 0;
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
  const rng = new RNG((seed ^ 0x1234abcd) >>> 0);

  let now = 0; // ms
  const q: { at: number; to: LockstepEngine; msg: InputMsg }[] = [];
  const oneWay = rttMs / 2;
  const sendVia = (to: LockstepEngine) => (msg: InputMsg) => {
    if (drop > 0 && rng.next() < drop) return;          // lost — redundant window recovers it
    q.push({ at: now + oneWay + Math.floor(rng.next() * (jitterMs + 1)), to, msg });
  };
  A.send = sendVia(B); B.send = sendVia(A);

  // per-client independent frame clock; each can use a different production mode
  // and frame interval (e.g. a low-FPS peer)
  const modeA = (opts as any).modeA ?? mode, modeB = (opts as any).modeB ?? mode;
  const fpsMsA = (opts as any).fpsMsA ?? 16, fpsMsB = (opts as any).fpsMsB ?? 16;
  const cl = {
    a: { e: A, sim: simA, next: 0, prodAcc: 0, prodTick: 0, last: 0, mode: modeA, fps: fpsMsA },
    b: { e: B, sim: simB, next: 8, prodAcc: 0, prodTick: 0, last: 0, mode: modeB, fps: fpsMsB },
  };
  const frame = (c: typeof cl.a) => {
    const dt = now - c.last; c.last = now;
    c.prodAcc += dt;
    while (c.prodAcc >= 100) { c.prodAcc -= 100; c.prodTick++; }
    if (c.mode === 'wall') c.e.produceTo(c.prodTick + delay); // the fix: wall-clock production
    c.e.pump(Math.min(targetTicks, c.prodTick));              // execute toward real time
  };

  const cap = targetTicks * 100 * 6; // generous wall-time budget
  let guard = 0;
  while ((simA.tickN < targetTicks || simB.tickN < targetTicks) && now < cap && guard++ < 50_000_000) {
    now++;
    if (q.length) {
      for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= now) { q[i].to.receive(q[i].msg); q.splice(i, 1); }
    }
    if (now >= cl.a.next) { cl.a.next += cl.a.fps; frame(cl.a); }
    // peer B is frozen during its hitch window, then catches up in a burst on
    // resume (its frame dt spans the whole hitch) — like a throttled/janky tab
    const bHitched = hitchEveryMs > 0 && (now % hitchEveryMs) < hitchMs;
    if (now >= cl.b.next) { cl.b.next += 16; if (!bHitched) frame(cl.b); }
  }

  let firstDiverge: number | null = null;
  const upto = Math.min(simA.tickN, simB.tickN);
  for (let t = 1; t <= upto; t++) { const ha = A.hashes.get(t), hb = B.hashes.get(t); if (ha && hb && ha !== hb) { firstDiverge = t; break; } }
  return {
    mode, targetTicks, reachedA: simA.tickN, reachedB: simB.tickN,
    inSync: firstDiverge === null, firstDiverge, stallsA: A.stalls, stallsB: B.stalls,
    rttMs, jitterMs, wallMs: now,
  };
}
