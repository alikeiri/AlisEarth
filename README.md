# FRACTURED EARTH — a C&C-style RTS for the browser

A Command & Conquer–style real-time strategy game set in a procedurally
generated version of today's world. Real-nation factions with equalized,
asymmetric balance — superpowers are not automatically the strongest.

- **Single-player skirmish** vs an AI that builds its own economy, expands,
  and launches escalating attack waves.
- **Multiplayer (2–4 players)** — server-authoritative simulation over
  WebSockets, lobby with 4-letter join codes. Starting a room solo adds an AI.
- Runs in any modern browser (WebGL2: Chrome/Edge, Firefox, Safari 15+).

## Factions (balanced odds)

| Faction | Perk |
|---|---|
| 🇺🇸 United States | Durable hardware: +18% HP, +10% cost |
| 🇨🇳 China | Mass production: −15% cost, −10% HP |
| 🇻🇳 Vietnam | Guerrilla doctrine: +18% speed, −15% HP |
| 🇪🇪 Estonia | e-State: +30% build speed, +10% income |

## Gameplay

Classic C&C loop: Construction Yard → Power Plants → Ore Refinery (free
harvester included) → Barracks / War Factory → army → destroy every enemy
structure. Power shortages slow production and turret fire. Ore fields
deplete; expand to contested central fields.

**Controls:** left-click select · drag box-select · right-click move /
attack / harvest · double-click select same type · Shift queue orders ·
WASD / arrows / screen-edge pan · wheel zoom · Q/E rotate · H stop ·
right-click with a production building selected sets its rally point ·
minimap click jumps the camera.

## Develop

```sh
npm install
npm run dev        # vite dev server on :5173 (game UI)
node server.mjs    # multiplayer server on :8080 (run `npm run build` first)
```

In dev mode the client automatically connects to ws://localhost:8080 for
multiplayer.

## Live deployment

Deploys as the `fractured-earth` Docker container (`node:20-alpine`,
`--restart unless-stopped`, app files in `/opt/fractured-earth`, ufw rule
for the game port). Other services on the same box are untouched.

Redeploy after changes (server address and credentials via env vars,
never committed):

```powershell
npm run build
$env:DEPLOY_HOST='<server-ip>'; $env:DEPLOY_USER='root'; $env:DEPLOY_PASS='...'
node deploy\deploy.mjs        # upload + restart container + health check
node deploy\probe-remote.mjs  # end-to-end multiplayer probe
node deploy\check-chat.mjs    # verify co-hosted services are still healthy
```

## Build & deploy to your own server

```sh
npm run build      # produces dist/ (static client) + server.mjs (Node server)
npm start          # serves dist/ over HTTP and hosts multiplayer WS on :8080
```

Deployment = copy `dist/`, `server.mjs`, `package.json`, and `node_modules`
(or run `npm install --omit=dev` on the box; the only runtime dependency is
`ws`) to your server and run `node server.mjs`. One process serves both the
static client and the WebSocket multiplayer on the same port (`PORT` env var
to change it).

Behind nginx/Caddy, proxy both HTTP and WebSocket upgrades to the port.
Single-player works from any static file host — the Node server is only
needed for multiplayer.

## Architecture

- `src/sim/` — deterministic fixed-timestep (10 Hz) simulation. No DOM/Three
  imports; the exact same code runs in the browser (skirmish) and in Node
  (authoritative multiplayer). Map generation uses integer-hash noise so
  server and clients build identical worlds from a shared seed.
- `src/client/` — Three.js renderer (instanced units, baked-vertex-color
  terrain, shadows, ACES tonemapping), DOM HUD, input, snapshot
  interpolation for multiplayer.
- `src/server/` — Node HTTP + WebSocket server: static hosting, lobby rooms,
  10 Hz authoritative tick, JSON snapshot broadcast.
