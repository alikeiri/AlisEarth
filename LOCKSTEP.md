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

## Step 2 — make the sim cross-engine deterministic ✅ DONE (pending Firefox/Safari confirmation)

The sim path now uses only IEEE-mandated ops (`+ - * / sqrt round`) via
`src/sim/dmath.ts`:
- `Math.hypot(a,b)` → `hyp(a,b)` = `Math.sqrt(a*a + b*b)` (26 sites).
- `x ** 2` → `x * x` (~40 sites; avoids `pow`).
- `Math.sin/cos` → `dsin/dcos` (range-reduced Taylor polynomial; 3 sites).
  `atan2` had zero sim uses. Rendering keeps native `Math`.

Verification (`node det-harness.mjs`, and `__detmath()` / `__detmathDet()` /
`__detsim()` in the browser console):
- `__detmath()` (native Math) still DIFFERS across V8 versions — `b8a24999`
  (Node) vs `3e95c2d5` (Chrome) — confirming native trig/hypot is engine-sensitive.
- `__detmathDet()` (the dmath replacements) MATCHES: `a9925333` on both.
- `__detsim(12345,1500).final` MATCHES: `df56b2f1` on both, and is same-engine stable.

**CONFIRMED cross-engine (Jun 15 2026).** Firefox (SpiderMonkey) results:
- `__detmathDet()` = `a9925333` ✅ (== V8)
- `__detsim(12345,1500).final` = `df56b2f1` ✅ (== V8)
- `__detmath()` (native) = `fe92c1ef` — a THIRD distinct value vs Node `b8a24999`
  and Chrome `3e95c2d5`, proving native Math is engine-specific.

Verdict: the sim is bit-identical across V8 (Chrome/Node) and SpiderMonkey
(Firefox). **The determinism gate is PASSED — deterministic lockstep is viable.**

## Step 3 — the lockstep loop (after the cross-engine gate passes)

- Input-delay buffer: ~300 ms+ at 500 ms ping (classic RTS, acceptable).
- Stalled-client policy: buffer + AI-substitute a lagging player, never freeze-all.
- Transport: WebTransport (HTTP/3 datagrams) or WebRTC DataChannel (unreliable),
  sending a **redundant rolling window** of recent inputs per packet so packet
  loss never stalls (per gafferongames "Deterministic Lockstep"). TCP/WebSocket
  head-of-line blocking is the current stall cause at high ping.

The live 5-server fleet keeps running the snapshot build (`main`) while this fork
(`lockstep` branch) is developed and gated.
