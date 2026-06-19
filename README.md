# FRACTURED EARTH — a C&C-style RTS for the browser

A Command & Conquer–style real-time strategy game set in a procedurally
generated version of today's world. 16 real-nation factions with equalized,
asymmetric balance — superpowers are not automatically the strongest.

- **Single-player skirmish** vs an adaptive AI that builds its economy,
  expands toward ore, launches escalating siege-led attack waves — and
  **studies every game you play against it** to counter your habits.
- **Multiplayer (2–4 players)** — server-authoritative simulation over
  WebSockets, lobby with 4-letter join codes, in-game chat. Starting a
  room solo adds an AI opponent.
- Runs in any modern browser (WebGL2: Chrome/Edge, Firefox, Safari 15+).
- ~10 MB total download (≈208 KB gzipped code, then models/textures),
  ~5,900 lines of TypeScript.

## Factions (balanced odds)

| Faction | Perk |
|---|---|
| 🇺🇸 United States | Durable hardware: +18% HP, +10% cost |
| 🇪🇺 European Union | Union industry: +10% build speed, +2% income |
| 🇷🇺 Russia | Heavy armor doctrine: +12% HP, −6% speed |
| 🇮🇷 Iran | Asymmetric warfare: −7% cost, +5% speed, −8% HP |
| 🇹🇷 Turkey | Drone exports: +8% speed, +4% build speed |
| 🇵🇰 Pakistan | Lean force: −10% cost, −10% HP |
| 🇮🇳 India | Scale economy: +6% income, −2% cost |
| 🇸🇦 Gulf States | Petrodollars: +10% income, +8% power, +8% cost |
| 🌍 African Union | Mass mobilization: −12% cost, −12% HP |
| 🇨🇳 China | Mass production: −15% cost, −10% HP |
| 🇰🇷 South Korea | Chaebol industry: +18% build speed |
| 🇹🇼 Taiwan | Silicon shield: +12% build speed, +4% income, −8% HP |
| 🇦🇺 Australia | Resource wealth: +8% HP, +4% income |
| 🇧🇷 Brazil | Jungle corps: +10% speed, −5% cost |
| 🇦🇷 Argentina | Expeditionary: −8% cost, +5% speed, −5% HP |
| 🇨🇦 Canada | Arctic engineering: +10% HP, +6% build speed |

## Gameplay

Classic C&C loop: Construction Yard → Power Plants → Ore Refinery (free
harvester included) → Barracks / War Factory / Drone Works / Shipyard /
Aircraft Plant → army → destroy every enemy structure. Power shortages slow
production and turret fire. Ore depletes and slowly regrows (Red Alert
style); crystal fields pay triple — expand or starve.

**Hard counters** (hover any unit button for its strengths/weaknesses —
tooltips are generated from the live damage matrix):
rifles shred infantry but bounce off armor · rockets crack armor ·
IFV autocannons mow down infantry · tanks duel tanks · MLRS artillery
out-ranges everything but can't touch aircraft · gun turrets can't engage
air (SAMs and the mobile AA pair can: AA Vehicle vs airplanes, Flak Gun vs
drones) · bombers fly over the target and carpet-release once with splash
damage, then return to rearm · mini drones are one-way suicide weapons
(1 kills a tank, 3–4 crack a turret) · vehicles crush infantry.

**Tech & specials:** Research Lab unlocks chemical / biological / stealth
units · Drone Hive digs in and launches autonomous suicide drones ·
Engineers repair, build roads (extends build range) · harvesters auto-mine,
flee attackers, and deliver to the nearest refinery.

**Adaptive AI:** every human-vs-AI game is recorded (browser localStorage
in skirmish, `ai-profile.json` server-side). The AI escalates after losses,
shortens its peace window against habitual rushers, stocks SAMs/interceptors
against air players and rockets/artillery against armor or infantry spam.
A hopelessly beaten AI surrenders instead of dragging the game out.
Stranded on an island, it pivots to drones, aircraft and ships.

**Simulation mode:** WATCH AI VS AI pits two AIs of chosen difficulty
against each other while you spectate (+/- adjusts speed up to 8×). The
winner's doctrine — damage dealt per unit lost, by weapon class — feeds the
same study profile, so spectated matches make the AI smarter against you.

**Claude as enemy commander (optional):** paste an Anthropic API key into
the menu and Claude (Haiku) reads a battlefield report every ~50 s and sets
the enemy AI's strategic stance (rush / defend / expand / air / tech) —
with in-character radio taunts in the chat log. The key stays in your
browser's localStorage and calls go directly to the Anthropic API; without
a key the scripted AI plays unchanged.

**Controls:** left-click select · drag box-select · right-click move /
attack / harvest · **right-press an enemy + drag = area attack circle**
(everything inside gets targeted) · right-drag on ground = formation draw ·
double-click select same type on screen · Shift queue orders ·
Ctrl/Alt+1-9 assign group, 1-9 recall · P patrol (click or draw a route) ·
G hold position · H stop · C show ranges · F fortify (Hive) · B build road
(Engineer) · R repeat production · wheel zoom · **Ctrl+wheel tilt camera** ·
Q/E rotate · WASD / edge pan · right-click with a production building
selected sets its rally point (double-click sets it primary) · Enter chat
(multiplayer) · Esc cancel. Leave the callsign box alone for a fresh funny
commander name every game.

## Develop

```sh
npm install
npm run dev        # vite dev server on :5173 (game UI)
node server.mjs    # multiplayer server on :8080 (run `npm run build` first)
```

In dev mode the client automatically connects to ws://localhost:8080 for
multiplayer.

### Headless balance harness

```sh
node sim-batch.mjs 100   # parallel AI-vs-AI batch, telemetry in batch-progress.txt
```

## Build & deploy to your own server

```sh
npm run build      # produces dist/ (static client) + server.mjs (Node server)
npm start          # serves dist/ over HTTP and hosts multiplayer WS on :8080
```

Deployment = copy `dist/`, `server.mjs`, `package.json`, and `node_modules`
(or run `npm install --omit=dev` on the box; the only runtime dependency is
`ws`) to your server and run `node server.mjs`. One process serves both the
static client and the WebSocket multiplayer on the same port (`PORT` env
var to change it).

Behind nginx/Caddy, proxy both HTTP and WebSocket upgrades to the port.
Single-player works from any static file host — the Node server is only
needed for multiplayer.

The `deploy/` scripts automate this over SSH into a Docker container
(server address and credentials via `DEPLOY_HOST` / `DEPLOY_USER` /
`DEPLOY_PASS` env vars, never committed):

```powershell
npm run build
node deploy\deploy.mjs        # upload + restart container + health check
node deploy\probe-remote.mjs  # end-to-end multiplayer probe
node deploy\check-chat.mjs    # verify co-hosted services are still healthy
```

## Architecture

- `src/sim/` — deterministic fixed-timestep (10 Hz) simulation. No DOM/Three
  imports; the exact same code runs in the browser (skirmish) and in Node
  (authoritative multiplayer). Map generation uses integer-hash noise so
  server and clients build identical worlds from a shared seed. All commands
  are server-validated; the damage matrix, AI, and pathfinding live here.
- `src/client/` — Three.js renderer: instanced rendering for every unit,
  CC0/CC-BY GLB models (see CREDITS.md) auto-oriented by geometry analysis,
  skeletal poses baked to static frames for animated infantry (rest / aim /
  4-frame run cycle), spinning rotors and props, photo-real terrain splatting
  (Poly Haven), shadows, ACES tonemapping. DOM HUD, input, snapshot
  interpolation for multiplayer.
- `src/server/` — Node HTTP + WebSocket server: static hosting, lobby rooms,
  10 Hz authoritative tick, JSON snapshot broadcast, AI study profile
  persistence.
