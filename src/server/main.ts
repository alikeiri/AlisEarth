// Game server: serves the built client (dist/) over HTTP and hosts
// authoritative multiplayer rooms over WebSockets on the same port.
// Run with: node server.mjs   (PORT env var optional, default 8080)

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { readFileSync, writeFileSync } from 'fs';
import { extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { Sim } from '../sim/sim';
import { aiTick } from '../sim/ai';
import { FACTIONS } from '../sim/data';
import { setMapSize } from '../sim/map';

const PORT = Number(process.env.PORT) || 8080;
const DIST = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.map': 'application/json',
};

const http = createServer(async (req, res) => {
  try {
    let p = (req.url || '/').split('?')[0];
    if (p === '/') p = '/index.html';
    const file = normalize(join(DIST, p));
    if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
    let body: Buffer;
    try { body = await readFile(file); }
    catch { body = await readFile(join(DIST, 'index.html')); p = '/index.html'; }
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(500); res.end('server error');
  }
});

interface Client { ws: WebSocket; name: string; faction: string; slot: number; lastChat?: number }
interface Room {
  code: string; clients: Client[]; started: boolean;
  sim: Sim | null; timer: ReturnType<typeof setInterval> | null; cmdQ: any[];
  aiSlots: number[]; size: number; diff: number;
}
const rooms = new Map<string, Room>();

function makeCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c = '';
  do { c = Array.from({ length: 4 }, () => A[(Math.random() * A.length) | 0]).join(''); }
  while (rooms.has(c));
  return c;
}

function send(ws: WebSocket, obj: any) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
// rolling study profile of human-vs-AI games (mirrors the client's localStorage
// version) — the AI reads it at game start and adapts strategy and unit mix
const AI_PROFILE_FILE = join(fileURLToPath(new URL('.', import.meta.url)), 'ai-profile.json');
function saveAiReport(r: any) {
  try {
    let p: any = {};
    try { p = JSON.parse(readFileSync(AI_PROFILE_FILE, 'utf8')); } catch { /* first game */ }
    p.games = (p.games || 0) + 1;
    if (r.aiWon) { p.aiWins = (p.aiWins || 0) + 1; p.lossStreak = 0; }
    else p.lossStreak = (p.lossStreak || 0) + 1;
    if (r.rushSec) p.rushTimes = [...(p.rushTimes || []), r.rushSec].slice(-7);
    const d = p.dmg || { inf: 0, veh: 0, air: 0, sea: 0 };
    for (const k of ['inf', 'veh', 'air', 'sea'])
      d[k] = Math.round((d[k] || 0) * 0.7 + (r.dmg?.[k] || 0));
    p.dmg = d;
    writeFileSync(AI_PROFILE_FILE, JSON.stringify(p));
  } catch { /* read-only fs — learning disabled */ }
}

function broadcast(room: Room, obj: any) {
  const s = JSON.stringify(obj);
  for (const c of room.clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(s);
}
function roomState(room: Room) {
  return { t: 'room', code: room.code, players: room.clients.map(c => ({ name: c.name, faction: c.faction })) };
}
function sendRoom(room: Room) {
  room.clients.forEach((c, i) => send(c.ws, { ...roomState(room), you: i }));
}

function startRoom(room: Room) {
  if (room.started || !room.clients.length) return;
  room.started = true;
  const specs: { name: string; faction: string; isAI?: boolean; aiLvl?: number }[] =
    room.clients.map(c => ({ name: c.name, faction: c.faction }));
  room.aiSlots = [];
  if (specs.length < 2) {
    const facs = Object.keys(FACTIONS);
    const f = facs[(Math.random() * facs.length) | 0];
    const lvlName = ['Easy', 'Normal', 'Hard', 'Brutal'][room.diff] || 'Normal';
    room.aiSlots.push(specs.length);
    specs.push({ name: `AI ${FACTIONS[f].name} (${lvlName})`, faction: f, isAI: true, aiLvl: room.diff });
  }
  const seed = (Math.random() * 0x7fffffff) | 0;
  setMapSize(room.size);
  room.sim = new Sim(seed, specs);
  try { room.sim.aiProfile = JSON.parse(readFileSync(AI_PROFILE_FILE, 'utf8')); } catch { /* fresh AI */ }
  room.clients.forEach((c, i) =>
    send(c.ws, { t: 'start', seed, size: room.size, you: i, players: specs.map(s => ({ name: s.name, faction: s.faction, isAI: !!s.isAI })) }));

  room.timer = setInterval(() => {
    const sim = room.sim!;
    const cmds = room.cmdQ;
    room.cmdQ = [];
    for (const slot of room.aiSlots) cmds.push(...aiTick(sim, slot));
    sim.tick(cmds);
    for (const ev of sim.events) if (ev.e === 'aiReport') saveAiReport(ev.r);
    broadcast(room, { t: 'snap', ...sim.snapshot() });
    if (sim.done) {
      broadcast(room, { t: 'end', winner: sim.winner });
      clearInterval(room.timer!);
      room.timer = null;
      // room stays so players can read the result; it dies when they disconnect
    }
  }, 100);
}

const wss = new WebSocketServer({ server: http });
wss.on('connection', ws => {
  let room: Room | null = null;
  let me: Client | null = null;

  ws.on('message', raw => {
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { return; }

    if (m.t === 'create') {
      const code = makeCode();
      me = { ws, name: String(m.name || 'Host').slice(0, 14), faction: String(m.faction || 'usa'), slot: 0 };
      room = {
        code, clients: [me], started: false, sim: null, timer: null, cmdQ: [], aiSlots: [],
        size: [72, 96, 128].includes(m.size) ? m.size : 96,
        diff: Number.isInteger(m.diff) && m.diff >= 0 && m.diff <= 3 ? m.diff : 1,
      };
      rooms.set(code, room);
      sendRoom(room);
    } else if (m.t === 'join') {
      const r = rooms.get(String(m.code || '').toUpperCase());
      if (!r) { send(ws, { t: 'err', msg: 'Room not found' }); return; }
      if (r.started) { send(ws, { t: 'err', msg: 'Game already started' }); return; }
      if (r.clients.length >= 4) { send(ws, { t: 'err', msg: 'Room is full' }); return; }
      me = { ws, name: String(m.name || 'Player').slice(0, 14), faction: String(m.faction || 'usa'), slot: r.clients.length };
      r.clients.push(me);
      room = r;
      sendRoom(r);
    } else if (m.t === 'start') {
      if (room && me && me.slot === 0) startRoom(room);
    } else if (m.t === 'chat') {
      if (!room || !me) return;
      const now = Date.now();
      if (me.lastChat && now - me.lastChat < 400) return; // flood guard
      me.lastChat = now;
      const msg = String(m.msg || '').slice(0, 120).trim();
      if (!msg) return;
      const payload = { t: 'chat', from: me.slot, name: me.name, to: m.to, msg };
      if (typeof m.to === 'number') {
        const dest = room.clients.find(c2 => c2.slot === m.to);
        if (dest) send(dest.ws, payload);
        send(me.ws, payload); // echo to sender
      } else {
        // 'all' and 'allies' both reach every human in the room (AI can't read)
        broadcast(room, payload);
      }
    } else if (m.t === 'cmd') {
      if (room && room.started && room.sim && me && m.cmd && m.cmd.p === me.slot) {
        if (room.cmdQ.length < 400) room.cmdQ.push(m.cmd);
      }
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    const idx = room.clients.indexOf(me);
    if (idx >= 0) room.clients.splice(idx, 1);
    if (!room.clients.length) {
      if (room.timer) clearInterval(room.timer);
      rooms.delete(room.code);
    } else if (!room.started) {
      room.clients.forEach((c, i) => { c.slot = i; });
      sendRoom(room);
    }
  });
});

http.listen(PORT, () => {
  console.log(`ALI'S EARTH server: http://localhost:${PORT} (HTTP + WebSocket)`);
  console.log(`Serving client from: ${DIST}`);
});
