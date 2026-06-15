# Deterministic-lockstep fork

Goal: scale netcode to **4 players × ≥500 units (worst case ~2000 moving objects)** across
high-latency, lossy, cross-world links. The current model broadcasts full state
snapshots — bandwidth is `O(objects × clients)` and is already at its limit at 2
players / ~150 objects. Deterministic lockstep makes bandwidth `O(inputs)` —
independent of unit count — which is the only thing that reaches 2000 units.

The sim is already deterministic from `(seed, command-stream)` — the replay
system proves it. The open question is whether it's deterministic **across JS
engines**, which lockstep requires.

## Step 1 — the determinism gate (this is where we are)

IEEE-754 does **not** mandate correctly-rounded `Math.sin/cos/tan/atan2/exp/log/pow/hypot`.
V8 (Chrome/Node), SpiderMonkey (Firefox) and JavaScriptCore (Safari) can differ
in the last bit, and in lockstep those tiny diffs compound into a full desync.
`grep` shows the sim uses `Math.hypot`, `Math.sin/cos`, `Math.atan2` and `**`
on the gameplay hot path — so cross-engine divergence is likely.

Harness: `src/sim/determinism.ts` — hashes the exact float bits of sim state from
an AI-vs-AI run (a deterministic input stream).

**Run the gate:**

1. Node (V8) baseline + same-engine stability check:
   ```
   node det-harness.mjs
   ```
   `sameEngineStable=true` for every seed confirms the harness is sound.

2. Browser: open the app, then in the console of **two different browsers**
   (e.g. Chrome and Firefox — different engines):
   ```js
   __detmath()            // transcendental-layer canary (fast first signal)
   __detsim(12345, 3000)  // full AI-vs-AI run → {samples:[{tick,hash}], final}
   ```
   - Same `__detmath()` digest across engines → the math layer is fine.
   - Same `final` and per-tick `hash` across engines → **gate passed**, lockstep is viable.
   - First differing `tick` = where divergence starts → points at the offending math.

## Step 2 — if it diverges, make the sim cross-engine deterministic

In rough order of likely impact:
- `Math.hypot(a,b)` → `Math.sqrt(a*a + b*b)` (`sqrt` *is* IEEE-mandated correctly-rounded).
- `x ** 2` → `x * x` (avoid `pow` for integer powers).
- `Math.sin/cos/atan2` on the sim path → deterministic fixed-point trig or a
  shared integer lookup table (only sim/movement headings; rendering can keep native Math).
- Re-run the gate after each change until cross-engine digests match.

## Step 3 — the lockstep loop (only after the gate passes)

- Input-delay buffer: ~300 ms+ at 500 ms ping (classic RTS, acceptable).
- Stalled-client policy: buffer + AI-substitute a lagging player, never freeze-all.
- Transport: WebTransport (HTTP/3 datagrams) or WebRTC DataChannel (unreliable),
  sending a **redundant rolling window** of recent inputs per packet so packet
  loss never stalls (per gafferongames "Deterministic Lockstep"). TCP/WebSocket
  head-of-line blocking is the current stall cause at high ping.

The live 5-server fleet keeps running the snapshot build (`main`) while this fork
(`lockstep` branch) is developed and gated.
