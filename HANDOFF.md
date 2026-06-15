# Ali's Earth (a.k.a. "Fractured Earth") — Project Handoff

A self-contained brief for picking up this project in a fresh session.

## What it is
A Command & Conquer–style **3D browser RTS**, multiplayer-first, in `C:\CND`.
Real-world-ish factions, deployed as a Docker container to the user's own Vultr
server(s). Work is **feedback-driven, shipped in small verified rounds**.

## Tech & architecture
- **Deterministic fixed-timestep sim** at **10 Hz** (`TICK=0.1`) in `src/sim/`.
  The *same* `Sim` class runs in-browser (`LocalGame`) and on the Node server
  (`NetGame`). Determinism is real — replays = `seed + command stream`.
- **Rendering:** Three.js, `InstancedMesh`. Terrain mesh at 2× sim grid; fog is a
  terrain-draped alpha plane. Most unit models are **procedural** geometry (some
  load GLBs from `dist/models/`).
- **Multiplayer:** **server-authoritative state-snapshot** model. Server runs the
  sim and broadcasts a **full snapshot every 100 ms** (`setInterval(...,100)`);
  clients interpolate between snapshots. Commands flow client→server.
- **Build stamping:** `vite.config.ts` injects `__APP_REV__/__APP_HASH__/__BUILD_TIME__`
  from git → version footer. So the deploy flow is
  **build → commit → REBUILD (restamp) → deploy → push**.

## Key files
- `src/sim/sim.ts` — core sim: entities, `applyCmd` (place/train/move/attack/
  deploy/surrender/holdfire/escort/upg/…), `tickUnit`/`tickBuilding`,
  `snapshot()`, `checkEnd()`, `transferOwnership()`, `canHarm()` (sub-combat rules).
- `src/sim/data.ts` — all UNITS/BUILDINGS/FACTIONS stats + `dmgMul()` matrix +
  `SIM_VERSION` (currently **3**; bump only when sim/map changes break replay
  reproduction).
- `src/sim/ai.ts` — per-player AI (`aiTick`), difficulty `LVL[]`, wall-breaching,
  sub-countering, `passive` (tutorial) flag.
- `src/sim/map.ts` / `path.ts` — map gen + A* (no corner-cutting).
- `src/client/main.ts` — **huge**: `LocalGame`, `NetGame`, `ReplayGame`,
  `GameClient` (render+input loop), menus, lobby, end screen.
- `src/client/render.ts`, `ui.ts`, `audio.ts`, `net.ts`.
- `src/server/main.ts` — HTTP static serve + WebSocket rooms + global lobby +
  replay store + perf logging.
- `index.html` — all HUD/menu DOM + CSS (single file).
- `deploy/deploy.mjs` (deploy game), `deploy/provision.mjs` (install Docker on a
  fresh box), `deploy/logs.mjs` (read-only: docker logs + mem + perf log). All
  read host/creds from **env vars first**, then `deploy/secrets.local.json`.

## Build / deploy workflow (exact)
```bash
npm run build                       # vite build + esbuild server.mjs
node deploy/deploy.mjs              # ssh2 -> uploads dist+server.mjs, runs container, ufw 8085, health-check
git push origin main
```
- Container: name `fractured-earth`, `node:20-alpine`, `-p 8085:8080`,
  `-m 300m` (300 MB cap!), `-v /opt/fractured-earth:/app`. `docker rm -f` each
  deploy (wipes prior docker logs).
- Target a different box without touching secrets:
  `DEPLOY_HOST=<ip> DEPLOY_PASS=<pw> node deploy/deploy.mjs`.
- Commit messages: **plain ASCII via bash heredoc** (PowerShell breaks on special
  chars), end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Servers (live)
- **US:** `http://207.148.121.138:8085`
- **Germany:** `http://192.248.189.137:8085` (Frankfurt, vc2-1c-1gb, ~$5/mo).
  Each server has its **own lobby/games** — players must be on the same box. The
  DE box was a fresh Ubuntu; Docker installed via `provision.mjs`.

## Hard constraints (do not break)
- The Vultr box co-hosts a **Matrix Synapse** stack — deploy **only additively**
  (own container + `/opt/fractured-earth` + `ufw 8085`). Never touch other services.
- **Credentials only** in `deploy/secrets.local.json` (gitignored):
  `DEPLOY_HOST/USER/PASS`, `ADVISOR_KEY`. Never commit them.
- **Godmode must never train the AI.** Cheated/tutorial games don't upload replays
  or feed AI learning.

## Verifying changes (workflow)
- Preview server runs the **built dist** via `node server.mjs` — **rebuild +
  reload** for client changes. To test multiplayer/server changes, **restart the
  preview server**.
- Drive/inspect at runtime via `window.__fe` (the `GameClient`): `__fe.game.sim`,
  `sim.snapshot()`, `__fe.renderer`, `__fe.selection`. Two-client MP is tested
  with a raw `WebSocket` as the 2nd player.
- The **screenshot tool tends to hang** (WebGL) — rely on runtime `eval`/DOM
  inspection. Headless preview throttles rAF, so use wall-clock `sleep` then re-check.

## Current feature state
Multiplayer **global lobby** (presence + open-games + create/join) and
**room/waiting lobby**; **lobby chat** on both lobby screens + in-game chat
(sender echoes **locally/instantly**, server relays to others only); match end →
**stats screen + "Back to Lobby"** + result posted to lobby chat. **Ping + FPS**
in top bar; **ping pills** in lobby. **Perf monitoring:** client overlay toggled
with **backtick (`` ` ``)** (FPS/render/sim ms, entity count, snapshot
rate/size/latency) + server `[PERF]` logs (slow-tick warnings + 30 s summaries
incl. RSS) to stdout and `server-perf.log`. Hero unit **Melody** (female commando,
Aussie TTS voice, one-at-a-time: sniper vs infantry, anti-vehicle drone, plants C4
on buildings, 25% faster). Guided **tutorial**. Surrender/Just-Exit exit popup;
team transfer on leave. Walls seal corners; AI proactively breaches walls.
Waypoints (Shift+click), minimap right-click move, MLRS range +30%, speed 0.25x/pause.

## Open / discussed (not done)
- **Netcode perf:** current model sends full positions 10x/s. Options — **delta
  snapshots + dead-reckoning** (low risk, recommended first) or **deterministic
  lockstep** (feasible since sim is deterministic, but desync/global-stall risk).
  **Decide via the perf overlay/logs first** (network vs client-GPU). Raising tick
  rate would *worsen* bandwidth.
- A clean two-target (US+DE) deploy config could be added.
- 300 MB container cap is tight on long matches — watch RSS in `[PERF]`.

## Memory
Persistent notes live in `C:\Users\alikh\.claude\projects\C--CND\memory\`
(index: `MEMORY.md`).
