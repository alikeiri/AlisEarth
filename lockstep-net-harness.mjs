// Step 3b/3c — networked lockstep over the REAL WebSocket server.
//
//   node lockstep-net-harness.mjs [wsUrl] [nClients] [ticks] [--drop]
//
// Connects N clients to the running server, creates a lockstep room, and runs a
// LockstepEngine per client over the actual WS transport (server = dumb input
// relay, no server sim). Verifies every client executes byte-identical state.
// With --drop, the last client disconnects mid-game to exercise the 3c drop
// consensus (survivors switch it to AI at the server-agreed tick and stay synced).
//
// NOTE: the target server must be running the lockstep build (restart the
// preview after building so server.mjs has the relay).
import { build } from 'esbuild';
import { writeFileSync } from 'fs';
import { WebSocket } from 'ws';

const res = await build({ entryPoints: ['src/sim/headless-entry.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
writeFileSync('.sim-bundle.mjs', res.outputFiles[0].text);
const { Sim, LockstepEngine, aiTick, setMapSize } = await import('./.sim-bundle.mjs?' + Date.now());

const URL = process.argv[2] || 'ws://localhost:8080';
const N = Number(process.argv[3] || 2);
const TICKS = Number(process.argv[4] || 500);
const DROP = process.argv.includes('--drop');
const FACS = ['usa', 'china', 'russia', 'eu'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Client {
  constructor(idx) {
    this.idx = idx; this.you = -1; this.engine = null; this.started = false; this.code = null; this.alive = true;
    this.ws = new WebSocket(URL);
    this.ws.on('message', raw => { let m; try { m = JSON.parse(String(raw)); } catch { return; } this.handle(m); });
  }
  open() { return new Promise(res => this.ws.readyState === 1 ? res() : this.ws.on('open', res)); }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  handle(m) {
    if (m.t === 'room') this.code = m.code;
    else if (m.t === 'start') this.onStart(m);
    else if (m.t === 'lsin') { this.engine?.receive({ player: m.player, frames: m.frames }); this.engine?.pump(TICKS); }
    else if (m.t === 'lsdropvote') this.send({ t: 'lslast', player: m.player, tick: this.engine.lastInputTickFor(m.player) });
    else if (m.t === 'lsdrop') { this.engine.dropToAI(m.player, m.tick); this.engine.pump(TICKS); }
  }
  onStart(m) {
    if (!m.lockstep) { console.error('FAIL: server did not start a LOCKSTEP room (is it running the lockstep build?)'); process.exit(1); }
    setMapSize(m.size);
    this.you = m.you; this.nP = m.players.length;
    this.sim = new Sim(m.seed, m.players.map(p => ({ ...p })));
    this.engine = new LockstepEngine(this.sim, this.you, this.nP, { delay: 6, redundancy: 16 });
    this.engine.localInput = s => aiTick(s, this.you);
    this.engine.aiFor = (s, p) => aiTick(s, p);
    this.engine.send = msg => this.send({ t: 'lsin', frames: msg.frames });
    this.started = true;
  }
  pump() { this.engine?.pump(TICKS); }
}

const clients = [];
for (let i = 0; i < N; i++) { clients.push(new Client(i)); await clients[i].open(); }
// host creates the lockstep room
clients[0].send({ t: 'create', name: 'P0', faction: FACS[0], size: 112, lockstep: true });
await sleep(300);
for (let i = 1; i < N; i++) { clients[i].send({ t: 'join', code: clients[0].code, name: 'P' + i, faction: FACS[i % FACS.length] }); await sleep(150); }
await sleep(300);
clients[0].send({ t: 'start' });
await sleep(400);
if (!clients.every(c => c.started)) { console.error('FAIL: not all clients started'); process.exit(1); }
console.log(`engine: node ${process.version}  clients=${N} ticks=${TICKS}${DROP ? ' (+drop)' : ''}`);

// drive: keep pumping every client until all surviving sims reach TICKS
const target = TICKS;
let dropped = false;
const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  for (const c of clients) if (c.alive) c.pump();
  if (DROP && !dropped && clients[N - 1].sim && clients[N - 1].sim.tickN >= Math.floor(target / 2)) {
    dropped = true; clients[N - 1].alive = false; clients[N - 1].ws.close();
    console.log(`-- dropped client ${N - 1} at ~tick ${clients[N - 1].sim.tickN}`);
  }
  const survivors = clients.filter(c => c.alive);
  if (survivors.every(c => c.sim && c.sim.tickN >= target)) break;
  await sleep(8);
}

// verify: all surviving clients agree on every common executed tick
const survivors = clients.filter(c => c.alive);
let inSync = true, firstDiverge = null, upto = Math.min(...survivors.map(c => c.sim.tickN));
for (let t = 1; t <= upto && inSync; t++) {
  const h0 = survivors[0].engine.hashes.get(t);
  for (const c of survivors) if (c.engine.hashes.get(t) !== h0) { inSync = false; firstDiverge = t; break; }
}
console.log(`survivors=${survivors.length} reachedTick=${upto} inSync=${inSync}` + (firstDiverge ? ` DIVERGED@${firstDiverge}` : ''));
console.log(survivors.map(c => `  client${c.idx} tick=${c.sim.tickN} stalls=${c.engine.stalls} hash@${upto}=${c.engine.hashes.get(upto)}`).join('\n'));
console.log(inSync && upto >= target - 12 ? '\nPASS — networked lockstep stayed in sync' : '\nFAIL');
process.exit(inSync && upto >= target - 12 ? 0 : 1);
