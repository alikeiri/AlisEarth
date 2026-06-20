// Game server: serves the built client (dist/) over HTTP and hosts
// authoritative multiplayer rooms over WebSockets on the same port.
// Run with: node server.mjs   (PORT env var optional, default 8080)

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, scryptSync, createHmac, timingSafeEqual } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { performance } from 'perf_hooks';
import { Sim } from '../sim/sim';
import { aiTick } from '../sim/ai';
import { FACTIONS, SIM_VERSION } from '../sim/data';
import { setMapSize } from '../sim/map';

const PORT = Number(process.env.PORT) || 8080;
const DIST = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');

// persistent crash/error log on the mounted volume (survives container restarts)
// so a freeze or exception during a live match can be inspected afterwards.
const ERR_LOG = join(fileURLToPath(new URL('.', import.meta.url)), 'server-error.log');
import { appendFileSync } from 'fs';
function logErr(where: string, e: any) {
  const line = `[${new Date().toISOString()}] ${where}: ${e?.stack || e?.message || e}\n`;
  try { appendFileSync(ERR_LOG, line); } catch { /* read-only fs */ }
  try { console.error(line.trimEnd()); } catch { /* noop */ }
}
process.on('uncaughtException', e => logErr('uncaughtException', e));
process.on('unhandledRejection', e => logErr('unhandledRejection', e));

// performance telemetry: goes to stdout (so `docker logs` / deploy/logs.mjs
// can read it after a match) and a persistent file on the mounted volume
const PERF_LOG = join(fileURLToPath(new URL('.', import.meta.url)), 'server-perf.log');
function perfLog(msg: string) {
  const line = `[${new Date().toISOString()}] [PERF] ${msg}`;
  try { console.log(line); } catch { /* noop */ }
  try { appendFileSync(PERF_LOG, line + '\n'); } catch { /* read-only fs */ }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.map': 'application/json',
};

// Claude strategist proxy: the API key stays on the server (ADVISOR_KEY env
// var); clients POST a battlefield summary and get back {stance, taunt}. The
// system prompt and token budget are fixed HERE so the endpoint can't be
// abused as a general LLM proxy. Per-IP cooldown keeps costs bounded.
const ADVISOR_KEY = process.env.ADVISOR_KEY || '';
const ADVISOR_SYS = 'You command an army in a C&C-style RTS. You receive a JSON battlefield report '
  + '(your side, the enemy, game minute). Pick ONE stance for the next minute: '
  + '"rush" (mass attack now), "defend" (fortify), "expand" (economy), "air" (build air power), '
  + '"tech" (research superweapons). Counter what the enemy is doing. '
  + 'Reply ONLY with JSON: {"stance":"...","taunt":"one short in-character radio line to your enemy"}';
const LESSON_SYS = 'You are the AI commander after an RTS match. aiWon says if you won. dealt/lost show '
  + 'damage done and units lost per weapon class. Write ONE concise tactical lesson for your next match. '
  + 'Reply ONLY JSON: {"lesson":"max 25 words"}';
const ANALYZE_SYS = 'You are the RTS AI commander critically reviewing a finished match. You receive the '
  + 'match report plus your accumulated knowledge from all previous games. Analyze what the loser did '
  + 'wrong, what won the game, and state the strategy you will adopt in future matches given everything '
  + 'you know. Reply ONLY JSON: {"critique":"3-5 sentences","lesson":"max 25 words"}';
const advisorLast = new Map<string, number>();
async function handleAdvisor(req: any, res: any) {
  if (!ADVISOR_KEY) { res.writeHead(404); res.end(); return; }
  const ip = String(req.socket.remoteAddress || '?');
  const now = Date.now();
  if (now - (advisorLast.get(ip) || 0) < 20000) { res.writeHead(429); res.end(); return; }
  advisorLast.set(ip, now);
  if (advisorLast.size > 500) advisorLast.clear(); // crude GC
  let raw = '';
  req.on('data', (c: Buffer) => { raw += c; if (raw.length > 4096) req.destroy(); });
  req.on('end', async () => {
    try {
      const parsed = JSON.parse(raw);
      let summary = String(parsed.summary || '').slice(0, 2000);
      const mode = parsed.mode === 'lesson' ? 'lesson' : parsed.mode === 'analyze' ? 'analyze' : 'stance';
      if (mode === 'analyze') {
        // critical review uses EVERYTHING the AI already knows (server profile)
        try { summary += '\nYour accumulated knowledge: ' + readFileSync(AI_PROFILE_FILE, 'utf8').slice(0, 1200); } catch { /* none */ }
      }
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ADVISOR_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', max_tokens: mode === 'stance' ? 200 : mode === 'lesson' ? 120 : 350,
          system: mode === 'lesson' ? LESSON_SYS : mode === 'analyze' ? ANALYZE_SYS : ADVISOR_SYS,
          messages: [{ role: 'user', content: summary }],
        }),
      });
      if (!r.ok) { res.writeHead(502); res.end(); return; }
      const j: any = await r.json();
      const text = j.content?.[0]?.text || '';
      const m = text.match(/\{[\s\S]*\}/);
      const d = m ? JSON.parse(m[0]) : {};
      // lessons from post-mortems and replay reviews enter the SERVER's brain
      if ((mode === 'lesson' || mode === 'analyze') && d.lesson) mergeServerLesson(String(d.lesson));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(mode === 'lesson' ? JSON.stringify({ lesson: d.lesson || null })
        : mode === 'analyze' ? JSON.stringify({ critique: d.critique || null, lesson: d.lesson || null })
        : JSON.stringify({ stance: d.stance || null, taunt: d.taunt || null }));
    } catch { res.writeHead(500); res.end(); }
  });
}

// shared AI intelligence: GET serves the server's profile (clients merge it in
// before each game), POST absorbs a client's post-game report. Server is the
// primary store; localStorage is the per-browser cache.
function handleIntel(req: any, res: any) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readProfile()));
    return;
  }
  let raw = '';
  req.on('data', (c: Buffer) => { raw += c; if (raw.length > 8192) req.destroy(); });
  req.on('end', () => {
    try {
      const r = JSON.parse(raw).report;
      if (r && typeof r === 'object') saveAiReport(r);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readProfile()));
    } catch { res.writeHead(400); res.end(); }
  });
}

// ---- feature requests: a public suggestion box. Anyone can submit; everything
// is appended and persisted. This is a STORE ONLY — submissions are data, never
// executed or auto-deployed; a human reviews them before anything is built. ----
const FEATURES_FILE = join(fileURLToPath(new URL('.', import.meta.url)), 'feature-requests.json');
function readFeatures(): any[] { try { return JSON.parse(readFileSync(FEATURES_FILE, 'utf8')); } catch { return []; } }
const featLast = new Map<string, number>();
function handleFeatures(req: any, res: any) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readFeatures().slice(-300)));
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  const ip = (req.socket?.remoteAddress || '') as string;
  const now = Date.now();
  if (now - (featLast.get(ip) || 0) < 4000) { res.writeHead(429); res.end(); return; } // anti-spam
  let raw = '';
  req.on('data', (c: Buffer) => { raw += c; if (raw.length > 4096) req.destroy(); });
  req.on('end', () => {
    try {
      const j = JSON.parse(raw);
      const text = String(j.text || '').trim().slice(0, 600);
      const name = (String(j.name || '').trim().slice(0, 40)) || 'Anonymous';
      if (!text) { res.writeHead(400); res.end(); return; }
      featLast.set(ip, now);
      const list = readFeatures();
      list.push({ text, name, date: now });
      while (list.length > 1000) list.shift(); // bounded
      writeFileSync(FEATURES_FILE, JSON.stringify(list));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: list.length }));
    } catch { res.writeHead(400); res.end(); }
  });
}

// operator-only: mark request(s) delivered (by date), gated by the server secret
// so random visitors can't flip the status. Submissions stay data either way.
function handleFeatureComplete(req: any, res: any) {
  let raw = '';
  req.on('data', (c: Buffer) => { raw += c; if (raw.length > 2048) req.destroy(); });
  req.on('end', () => {
    try {
      const j = JSON.parse(raw);
      if (!ADVISOR_KEY || j.key !== ADVISOR_KEY) { res.writeHead(403); res.end(); return; }
      const dates: number[] = Array.isArray(j.dates) ? j.dates : (j.date != null ? [j.date] : []);
      const list = readFeatures();
      let n = 0;
      for (const it of list) if (dates.includes(it.date)) { it.done = true; if (j.note) it.note = String(j.note).slice(0, 200); n++; }
      writeFileSync(FEATURES_FILE, JSON.stringify(list));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, marked: n }));
    } catch { res.writeHead(400); res.end(); }
  });
}

// ---- player accounts: email + password (scrypt-hashed) so a player's chosen
// callsign follows them across devices. Stored as JSON on the mounted volume
// (/app) so accounts survive redeploys. Passwords are NEVER stored in plaintext;
// sessions are stateless HMAC-signed tokens. ----
const USERS_FILE = join(fileURLToPath(new URL('.', import.meta.url)), 'users.json');
function readUsers(): Record<string, any> { try { return JSON.parse(readFileSync(USERS_FILE, 'utf8')); } catch { return {}; } }
function writeUsers(u: Record<string, any>) { try { writeFileSync(USERS_FILE, JSON.stringify(u)); } catch (e) { logErr('writeUsers', e); } }
// token-signing secret, persisted so sessions survive restarts (seeded from the
// advisor key + random bytes); kept out of git on the volume
const SECRET_FILE = join(fileURLToPath(new URL('.', import.meta.url)), 'auth-secret');
function authSecret(): string {
  try { const s = readFileSync(SECRET_FILE, 'utf8'); if (s) return s; } catch { /* generate below */ }
  const s = (process.env.ADVISOR_KEY || 'fe') + ':' + randomBytes(24).toString('hex');
  try { writeFileSync(SECRET_FILE, s); } catch (e) { logErr('authSecret', e); }
  return s;
}
const AUTH_SECRET = authSecret();
function signToken(payload: any): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(tok: any): any | null {
  if (typeof tok !== 'string' || !tok.includes('.')) return null;
  const [body, sig] = tok.split('.');
  const exp = createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  try { if (sig.length !== exp.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null; } catch { return null; }
  let p: any; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!p || (p.exp && Date.now() > p.exp)) return null;
  return p;
}
const hashPw = (pw: string, salt: string) => scryptSync(pw, salt, 32).toString('hex');
const validEmail = (e: any) => typeof e === 'string' && e.length <= 120 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const cleanCallsign = (c: any) => String(c || '').trim().replace(/[<>]/g, '').slice(0, 18);
const authLast = new Map<string, number>();
function readJsonBody(req: any): Promise<any> {
  return new Promise(resolve => {
    let raw = ''; req.on('data', (c: Buffer) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
  });
}
const TOKEN_TTL = 1000 * 60 * 60 * 24 * 180; // 180 days
async function handleAuth(req: any, res: any, kind: 'register' | 'login' | 'me') {
  const json = (code: number, obj: any) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const ip = (req.socket?.remoteAddress || '') as string;
  const now = Date.now();
  if (kind !== 'me') {
    if (now - (authLast.get(ip) || 0) < 800) return json(429, { error: 'Too many attempts — slow down' });
    authLast.set(ip, now);
  }
  const b = await readJsonBody(req);
  if (!b) return json(400, { error: 'Bad request' });
  if (kind === 'me') {
    const p = verifyToken(b.token);
    return p ? json(200, { email: p.email, callsign: p.callsign }) : json(401, { error: 'Invalid session' });
  }
  const email = String(b.email || '').trim().toLowerCase();
  const pw = String(b.password || '');
  if (!validEmail(email)) return json(400, { error: 'Enter a valid email address' });
  if (pw.length < 6) return json(400, { error: 'Password must be at least 6 characters' });
  const users = readUsers();
  if (kind === 'register') {
    if (users[email]) return json(409, { error: 'An account with that email already exists' });
    const callsign = cleanCallsign(b.callsign) || email.split('@')[0].slice(0, 18);
    const salt = randomBytes(16).toString('hex');
    users[email] = { salt, hash: hashPw(pw, salt), callsign, created: now };
    writeUsers(users);
    return json(200, { token: signToken({ email, callsign, exp: now + TOKEN_TTL }), callsign, email });
  }
  // login
  const u = users[email];
  if (!u) return json(401, { error: 'No account found for that email' });
  let ok = false;
  try { ok = timingSafeEqual(Buffer.from(hashPw(pw, u.salt), 'hex'), Buffer.from(u.hash, 'hex')); } catch { ok = false; }
  if (!ok) return json(401, { error: 'Incorrect password' });
  const cs = cleanCallsign(b.callsign);
  if (cs && cs !== u.callsign) { u.callsign = cs; writeUsers(users); } // let the player update their callsign on login
  return json(200, { token: signToken({ email, callsign: u.callsign, exp: now + TOKEN_TTL }), callsign: u.callsign, email });
}

const http = createServer(async (req, res) => {
  try {
    let p = (req.url || '/').split('?')[0];
    if (req.method === 'POST' && p === '/auth/register') { handleAuth(req, res, 'register'); return; }
    if (req.method === 'POST' && p === '/auth/login') { handleAuth(req, res, 'login'); return; }
    if (req.method === 'POST' && p === '/auth/me') { handleAuth(req, res, 'me'); return; }
    if (req.method === 'POST' && p === '/advisor') { handleAdvisor(req, res); return; }
    if (p === '/intel') { handleIntel(req, res); return; }
    if (req.method === 'POST' && p === '/features/complete') { handleFeatureComplete(req, res); return; }
    if (p === '/features') { handleFeatures(req, res); return; }
    if (req.method === 'GET' && p === '/replays') {
      let idx = '[]';
      try { idx = readFileSync(REPLAY_INDEX, 'utf8'); } catch { /* none yet */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(idx);
      return;
    }
    if (req.method === 'POST' && p === '/replays') { handleReplayUpload(req, res); return; }
    if (req.method === 'GET' && /^\/replays\/[a-z0-9]+$/.test(p)) {
      try {
        const body = readFileSync(join(REPLAY_DIR, p.slice('/replays/'.length) + '.json'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
      return;
    }
    if (p === '/') p = '/index.html';
    const file = normalize(join(DIST, p));
    if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
    let body: Buffer;
    try { body = await readFile(file); }
    catch { body = await readFile(join(DIST, 'index.html')); p = '/index.html'; }
    // Cache policy that kills stale builds: index.html is ALWAYS revalidated, so a
    // reload always picks up the current build, which references the current
    // content-hashed JS/CSS in /assets (those are immutable — safe to cache for a
    // year). Other fixed-name assets (models/textures/audio) get a short cache.
    const ext = extname(p);
    const cache = ext === '.html'
      ? 'no-cache, must-revalidate'
      : p.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=600';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(body);
  } catch {
    res.writeHead(500); res.end('server error');
  }
});

interface Client { ws: WebSocket; name: string; faction: string; slot: number; lastChat?: number; room?: Room | null; ping?: number; lastLsin?: number }
interface Room {
  code: string; clients: Client[]; started: boolean;
  sim: Sim | null; timer: ReturnType<typeof setInterval> | null; cmdQ: any[];
  aiSlots: number[]; size: number; diff: number; islands?: boolean; urban?: boolean; flat?: boolean; steel?: boolean; metal?: boolean; lockstep?: boolean;
  dropVote?: { player: number; votes: Map<number, number> }; // lockstep: drop-tick consensus
  rec?: { seed: number; size: number; players: any[]; cmds: { k: number; c: any[] }[] };
  lastReport?: any; replaySaved?: boolean;
}
const rooms = new Map<string, Room>();
// valid map types (mirrors the client's Map Type dropdown). The client actually
// sends per-type booleans (islands/urban/flat/steel/metal); mapType is accepted
// too for forward-compat, validated against this list.
const MAP_TYPES = ['continent', 'islands', 'urban', 'flat', 'steel', 'metal'];
// every connected client that has entered the multiplayer lobby (whether idle in
// the lobby or inside a room) — drives the shared presence + open-games browser
const online = new Set<Client>();

// global lobby chat: a small rolling history so anyone entering (or returning
// from a match) sees the recent conversation and match results
const lobbyChat: { name: string; msg: string; sys?: boolean }[] = [];
function pushLobbyChat(name: string, msg: string, sys = false) {
  const m = { name: String(name).slice(0, 14), msg: String(msg).slice(0, 160), sys };
  lobbyChat.push(m);
  if (lobbyChat.length > 30) lobbyChat.shift();
  const s = JSON.stringify({ t: 'lobbymsg', ...m });
  for (const c of online)
    if ((!c.room || !c.room.started) && c.ws.readyState === WebSocket.OPEN) c.ws.send(s);
}

// games that can still be joined: not yet started and with a free slot
function openGames() {
  return [...rooms.values()]
    .filter(r => !r.started && r.clients.length < 4)
    .map(r => ({ code: r.code, host: r.clients[0]?.name || '?', players: r.clients.length, max: 4, size: r.size, diff: r.diff }));
}
// drop any presence whose socket is no longer open. The 'close' handler normally
// removes a client, but a half-open / proxied socket can linger; without this the
// lobby "keeps adding names" that aren't actually online. Returns the live list.
function pruneOnline(): Client[] {
  for (const c of [...online]) if (c.ws.readyState !== WebSocket.OPEN) online.delete(c);
  return [...online];
}
function lobbyState() {
  return {
    t: 'lobby',
    users: pruneOnline().map(c => ({ name: c.name, faction: c.faction, inGame: !!(c.room && c.room.started), ping: c.ping ?? null })),
    games: openGames(),
    chat: lobbyChat,
  };
}
// push the latest presence + open-games list to everyone NOT currently in a match
// (clients in a started game are busy playing and ignore lobby updates anyway)
function broadcastLobby() {
  const s = JSON.stringify(lobbyState());
  for (const c of online)
    if ((!c.room || !c.room.started) && c.ws.readyState === WebSocket.OPEN) c.ws.send(s);
}

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
function readProfile(): any {
  try { return JSON.parse(readFileSync(AI_PROFILE_FILE, 'utf8')); } catch { return {}; }
}
function saveAiReport(r: any) {
  try {
    const p = readProfile();
    if (r.simMatch) {
      // AI-vs-AI match: absorb the winner's doctrine payoffs only
      p.simGames = (p.simGames || 0) + 1;
      const eff = p.eff || {};
      for (const k of ['inf', 'veh', 'air', 'sea']) {
        const e = (r.dealt?.[k] || 0) / ((r.lost?.[k] || 0) + 1);
        eff[k] = Math.round(((eff[k] || 0) * 0.7 + e * 0.3) * 10) / 10;
      }
      p.eff = eff;
      writeFileSync(AI_PROFILE_FILE, JSON.stringify(p));
      return;
    }
    p.games = (p.games || 0) + 1;
    if (r.aiWon) { p.aiWins = (p.aiWins || 0) + 1; p.lossStreak = 0; }
    else p.lossStreak = (p.lossStreak || 0) + 1;
    if (r.rushSec) p.rushTimes = [...(p.rushTimes || []), r.rushSec].slice(-7);
    const d = p.dmg || { inf: 0, veh: 0, air: 0, sea: 0 };
    for (const k of ['inf', 'veh', 'air', 'sea'])
      d[k] = Math.round((d[k] || 0) * 0.7 + (r.dmg?.[k] || 0));
    p.dmg = d;
    const eff = p.eff || {};
    for (const k of ['inf', 'veh', 'air', 'sea']) {
      const e = (r.dealt?.[k] || 0) / ((r.lost?.[k] || 0) + 1);
      eff[k] = Math.round(((eff[k] || 0) * 0.6 + e * 0.4) * 10) / 10;
    }
    p.eff = eff;
    p.harvLost = Math.round(((p.harvLost || 0) * 0.6 + (r.harvLost || 0) * 0.4) * 10) / 10;
    writeFileSync(AI_PROFILE_FILE, JSON.stringify(p));
  } catch { /* read-only fs — learning disabled */ }
}
function mergeServerLesson(lesson: string) {
  try {
    const p = readProfile();
    p.lessons = [...(p.lessons || []), lesson.slice(0, 160)].slice(-5);
    writeFileSync(AI_PROFILE_FILE, JSON.stringify(p));
  } catch { /* read-only fs */ }
}

// ---- replays: every server game is recorded (seed + command stream = exact
// deterministic playback) and can be re-watched by anyone ----
const REPLAY_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'replays');
const REPLAY_INDEX = join(REPLAY_DIR, 'index.json');
try { mkdirSync(REPLAY_DIR, { recursive: true }); } catch { /* exists */ }
function saveReplay(room: Room) {
  if (!room.rec || room.replaySaved || !room.sim) return;
  room.replaySaved = true;
  try {
    const sim = room.sim;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const meta = {
      id, date: Date.now(),
      players: room.rec.players,
      winner: sim.winner,
      winnerName: sim.winner >= 0 ? room.rec.players[sim.winner]?.name : null,
      lenSec: Math.round(sim.tickN / 10),
      done: sim.done,
      report: room.lastReport || null,
    };
    writeFileSync(join(REPLAY_DIR, id + '.json'),
      JSON.stringify({ meta, ver: SIM_VERSION, seed: room.rec.seed, size: room.rec.size, cmds: room.rec.cmds }));
    let idx: any[] = [];
    try { idx = JSON.parse(readFileSync(REPLAY_INDEX, 'utf8')); } catch { /* first replay */ }
    idx.unshift(meta);
    for (const old of idx.slice(40)) { // keep the latest 40
      try { unlinkSync(join(REPLAY_DIR, old.id + '.json')); } catch { /* gone */ }
    }
    writeFileSync(REPLAY_INDEX, JSON.stringify(idx.slice(0, 40)));
  } catch { /* disk trouble — skip */ }
}

// accept a client-recorded replay (skirmish games run in the browser, so they
// upload their seed + command stream here to be watchable like server matches)
function handleReplayUpload(req: any, res: any) {
  let raw = '';
  req.on('data', (c: Buffer) => { raw += c; if (raw.length > 4_000_000) req.destroy(); });
  req.on('end', () => {
    try {
      const d = JSON.parse(raw);
      if (typeof d.seed !== 'number' || !Array.isArray(d.cmds) || !d.meta) { res.writeHead(400); res.end(); return; }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const meta = { id, date: Date.now(), source: 'skirmish', ...d.meta };
      writeFileSync(join(REPLAY_DIR, id + '.json'), JSON.stringify({ meta, seed: d.seed, size: d.size || 96, cmds: d.cmds }));
      let idx: any[] = [];
      try { idx = JSON.parse(readFileSync(REPLAY_INDEX, 'utf8')); } catch { /* first */ }
      idx.unshift(meta);
      for (const old of idx.slice(40)) { try { unlinkSync(join(REPLAY_DIR, old.id + '.json')); } catch { /* gone */ } }
      writeFileSync(REPLAY_INDEX, JSON.stringify(idx.slice(0, 40)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
    } catch { res.writeHead(500); res.end(); }
  });
}

function broadcast(room: Room, obj: any) {
  const s = JSON.stringify(obj);
  for (const c of room.clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(s);
}
function roomState(room: Room) {
  return { t: 'room', code: room.code, players: room.clients.map(c => ({ name: c.name, faction: c.faction, ping: c.ping ?? null })) };
}
function sendRoom(room: Room) {
  room.clients.forEach((c, i) => send(c.ws, { ...roomState(room), you: i }));
}

// a human left an in-progress match (Just Exit button, or simply disconnected).
// it's NOT a defeat: if an allied human is still connected we hand them the
// leaver's whole army; if no human remains at all the match is over; otherwise
// the leaver simply vanishes and their forces disband. `me` is already spliced
// out of room.clients by the caller, so room.clients == the players still here.
function departMidGame(room: Room, leaverSlot: number) {
  const sim = room.sim;
  if (!room.started || !sim || sim.done) return;
  // no humans left watching at all -> end the match (don't run AI-vs-AI forever)
  if (!room.clients.length) return; // ws.close path handles room teardown
  const team = sim.players[leaverSlot]?.team;
  const ally = room.clients.find(c =>
    c.slot !== leaverSlot && sim.players[c.slot]?.alive && sim.players[c.slot]?.team === team);
  if (ally) {
    sim.transferOwnership(leaverSlot, ally.slot);
  } else {
    // no allied human to inherit: the leaver is simply gone, disband their forces
    sim.transferOwnership(leaverSlot, leaverSlot); // marks left + alive=false
    for (const e of sim.ents.values()) if (e.owner === leaverSlot) e.hp = 0;
  }
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
  // map type rides in seed bits: islands 0x40000000, urban 0x20000000, flatCity 0x10000000, steel 0x08000000, metal 0x04000000
  let seed = ((Math.random() * 0x7fffffff) | 0) & ~0x7c000000;
  if (room.islands) seed |= 0x40000000;
  if (room.urban) seed |= 0x20000000;
  if (room.flat) seed |= 0x10000000;
  if (room.steel) seed |= 0x08000000;
  if (room.metal) seed |= 0x04000000;

  // LOCKSTEP mode: the server runs NO sim and sends NO snapshots — each client
  // runs its own deterministic sim and the server only relays input messages.
  // The host (slot 0) drives any AI slots. Bandwidth = O(inputs), not O(units).
  if (room.lockstep) {
    // adaptive input delay: size the buffer to the WORST player's ping so a distant
    // peer's latency + frame freezes are absorbed instead of stalling everyone. All
    // clients get the SAME value (sent here), so the lockstep stays deterministic.
    // ~6 ticks (0.6s) for a LAN-ish game up to 18 (1.8s) for a far peer.
    const maxPing = Math.max(0, ...room.clients.map(c => c.ping || 0));
    const lsDelay = Math.max(6, Math.min(18, Math.round(maxPing / 30)));
    room.clients.forEach((c, i) => send(c.ws, {
      t: 'start', lockstep: true, seed, size: room.size, you: i, aiSlots: room.aiSlots, delay: lsDelay,
      players: specs.map(s => ({ name: s.name, faction: s.faction, isAI: !!s.isAI })),
    }));
    return;
  }

  setMapSize(room.size);
  room.sim = new Sim(seed, specs);
  room.rec = { seed, size: room.size, players: specs.map(s => ({ ...s })), cmds: [] };
  try { room.sim.aiProfile = JSON.parse(readFileSync(AI_PROFILE_FILE, 'utf8')); } catch { /* fresh AI */ }
  room.clients.forEach((c, i) =>
    send(c.ws, { t: 'start', seed, size: room.size, you: i, players: specs.map(s => ({ name: s.name, faction: s.faction, isAI: !!s.isAI })) }));

  let tickErrs = 0;
  // --- performance monitoring: time each tick's work and watch for the loop
  // falling behind, so a future "performance got bad" report can be traced to
  // a server-side sim/broadcast hotspot vs. a client-side one ---
  let lastFire = performance.now();
  let pSum = 0, pMax = 0, pN = 0, slow50 = 0, slow100 = 0, driftMax = 0, lastSlow = 0, lastSummary = 0;
  room.timer = setInterval(() => {
    const fireT = performance.now();
    const drift = fireT - lastFire - 100; // how late this tick fired vs its 100ms slot
    lastFire = fireT;
    if (drift > driftMax) driftMax = drift;
    try {
      const sim = room.sim!;
      const cmds = room.cmdQ;
      room.cmdQ = [];
      for (const slot of room.aiSlots) cmds.push(...aiTick(sim, slot));
      if (cmds.length && room.rec) room.rec.cmds.push({ k: sim.tickN, c: cmds }); // replay: full cmd stream incl. AI
      const tSim = performance.now();
      sim.tick(cmds);
      const simMs = performance.now() - tSim;
      for (const ev of sim.events) if (ev.e === 'aiReport') { room.lastReport = ev.r; if (!ev.r.cheated) saveAiReport(ev.r); }
      const snap = sim.snapshot();
      const tBc = performance.now();
      broadcast(room, { t: 'snap', ...snap });
      const bcMs = performance.now() - tBc;
      const total = performance.now() - fireT;
      // roll up the window
      pSum += total; pN++; if (total > pMax) pMax = total;
      if (total > 50) slow50++; if (total > 100) slow100++;
      // a single slow tick (over ~60% of the 100ms budget): log it now, throttled
      if (total > 60 && fireT - lastSlow > 1000) {
        lastSlow = fireT;
        const kb = (JSON.stringify(snap).length / 1024).toFixed(1);
        perfLog(`room ${room.code} SLOW tick #${sim.tickN} ${total.toFixed(0)}ms (sim ${simMs.toFixed(0)}, bcast ${bcMs.toFixed(0)}, fired ${drift.toFixed(0)}ms late) ents=${sim.ents.size} clients=${room.clients.length} snap=${kb}KB`);
      }
      // baseline summary every ~30s so a healthy match still leaves a trail
      if (sim.tickN - lastSummary >= 300) {
        lastSummary = sim.tickN;
        const kb = (JSON.stringify(snap).length / 1024).toFixed(1);
        const rssMb = (process.memoryUsage().rss / 1048576).toFixed(0); // vs the 300MB container cap
        perfLog(`room ${room.code} @#${sim.tickN} avg ${(pSum / Math.max(1, pN)).toFixed(1)}ms max ${pMax.toFixed(0)}ms slow>50:${slow50} >100:${slow100} driftMax ${driftMax.toFixed(0)}ms ents=${sim.ents.size} snap=${kb}KB rss=${rssMb}MB clients=${room.clients.length}`);
        pSum = pN = pMax = slow50 = slow100 = driftMax = 0;
      }
      if (sim.done) {
        // send the final battle report with the end signal so each client can
        // render the post-game stats (NetGame has no local sim to read them from)
        broadcast(room, {
          t: 'end', winner: sim.winner, stats: sim.stats,
          players: sim.players.map(p => ({ name: p.name, fac: { flag: p.fac.flag } })),
        });
        // announce the result in the lobby so it greets players on their return
        const wn = sim.winner >= 0 ? (room.rec?.players[sim.winner]?.name || 'Someone') : 'Nobody';
        const roster = (room.rec?.players || []).filter((p: any) => !p.isAI).map((p: any) => p.name).join(' vs ') || 'players';
        pushLobbyChat('', `🏁 ${wn} won — ${roster} (${Math.round(sim.tickN / 600)}m)`, true);
        clearInterval(room.timer!);
        room.timer = null;
        if (!sim.cheated) saveReplay(room);
        // room stays so players can read the result; it dies when they disconnect
      }
    } catch (e) {
      // a sim exception must NOT silently freeze the match: log it (persistently)
      // and tell the clients instead of leaving them staring at a frozen field
      logErr(`room ${room.code} tick ${room.sim?.tickN}`, e);
      if (++tickErrs >= 5) {
        broadcast(room, { t: 'end', winner: -1 });
        if (room.timer) { clearInterval(room.timer); room.timer = null; }
      }
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

    if (m.t === 'ping') {
      // echo for the client's RTT measurement; remember its reported ping so we
      // can show it to others in the lobby / room
      send(ws, { t: 'pong', ts: m.ts });
      if (me && typeof m.rtt === 'number') me.ping = Math.max(0, Math.round(m.rtt));
      // ping doubles as a liveness signal: a P2P client sends its input over a
      // DataChannel (not 'lsin'), so the stall watchdog must count pings too or it
      // would wrongly drop a perfectly healthy peer-to-peer player. (A still-loading
      // client hasn't pinged in-room yet, so lastLsin stays unset and it's never a
      // drop candidate until it's actually live.)
      if (me && me.room && me.room.started && me.room.lockstep) me.lastLsin = Date.now();
      return;
    }
    if (m.t === 'hello') {
      // enter the global lobby: register presence and send the current snapshot
      if (!me) me = { ws, name: String(m.name || 'Player').slice(0, 14), faction: String(m.faction || 'usa'), slot: -1, room: null };
      else { me.name = String(m.name || me.name).slice(0, 14); me.faction = String(m.faction || me.faction); }
      online.add(me);
      send(ws, lobbyState());
      broadcastLobby();
    } else if (m.t === 'lobbychat') {
      if (!me) return;
      const now = Date.now();
      if (me.lastChat && now - me.lastChat < 400) return; // flood guard
      me.lastChat = now;
      const msg = String(m.msg || '').slice(0, 160).trim();
      if (msg) pushLobbyChat(me.name, msg);
    } else if (m.t === 'create') {
      const code = makeCode();
      if (!me) me = { ws, name: String(m.name || 'Host').slice(0, 14), faction: String(m.faction || 'usa'), slot: 0, room: null };
      me.slot = 0; me.name = String(m.name || me.name).slice(0, 14); me.faction = String(m.faction || me.faction);
      online.add(me);
      room = {
        code, clients: [me], started: false, sim: null, timer: null, cmdQ: [], aiSlots: [],
        size: [72, 96, 128].includes(m.size) ? m.size : 96,
        diff: Number.isInteger(m.diff) && m.diff >= 0 && m.diff <= 3 ? m.diff : 1,
        islands: !!m.islands,
        urban: !!m.urban,
        flat: !!m.flat,
        steel: !!m.steel,
        metal: !!m.metal,
        lockstep: !!m.lockstep,
        mapType: MAP_TYPES.includes(m.mapType) ? m.mapType
          : m.islands ? 'islands' : m.urban ? 'urban' : m.flat ? 'flat' : m.steel ? 'steel' : m.metal ? 'metal' : 'continent',
        ai: [], teams: [0], // host starts on team 0 (FFA); host edits teams/AI via roomcfg
      };
      me.room = room;
      rooms.set(code, room);
      sendRoom(room);
      broadcastLobby();
    } else if (m.t === 'join') {
      const r = rooms.get(String(m.code || '').toUpperCase());
      if (!r) { send(ws, { t: 'err', msg: 'Room not found' }); return; }
      if (r.started) { send(ws, { t: 'err', msg: 'Game already started' }); return; }
      if (r.clients.length >= 4) { send(ws, { t: 'err', msg: 'Room is full' }); return; }
      if (!me) me = { ws, name: String(m.name || 'Player').slice(0, 14), faction: String(m.faction || 'usa'), slot: 0, room: null };
      me.slot = r.clients.length; me.name = String(m.name || me.name).slice(0, 14); me.faction = String(m.faction || me.faction);
      online.add(me);
      r.clients.push(me);
      room = r; me.room = r;
      sendRoom(r);
      broadcastLobby();
    } else if (m.t === 'leaveRoom') {
      // back out of a room lobby to the global lobby (only before the game starts)
      if (room && me && !room.started) {
        const idx = room.clients.indexOf(me);
        if (idx >= 0) room.clients.splice(idx, 1);
        if (!room.clients.length) { if (room.timer) clearInterval(room.timer); rooms.delete(room.code); }
        else { room.clients.forEach((c, i) => { c.slot = i; }); sendRoom(room); }
        me.room = null; room = null;
        send(ws, lobbyState());
        broadcastLobby();
      }
    } else if (m.t === 'start') {
      if (room && me && me.slot === 0) { startRoom(room); broadcastLobby(); }
    } else if (m.t === 'chat') {
      if (!room || !me) return;
      const now = Date.now();
      if (me.lastChat && now - me.lastChat < 400) return; // flood guard
      me.lastChat = now;
      const msg = String(m.msg || '').slice(0, 120).trim();
      if (!msg) return;
      const payload = { t: 'chat', from: me.slot, name: me.name, to: m.to, msg };
      // the sender shows their own line locally (instant, latency-proof), so we
      // only deliver to the OTHER players here — no self-echo (avoids both the
      // "my message never came back" failure and double-printing)
      if (typeof m.to === 'number') {
        const dest = room.clients.find(c2 => c2.slot === m.to);
        if (dest && dest !== me) send(dest.ws, payload);
      } else {
        for (const c of room.clients) if (c !== me && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(payload));
      }
    } else if (m.t === 'cmd') {
      if (room && room.started && room.sim && me && m.cmd && m.cmd.p === me.slot) {
        if (room.cmdQ.length < 400) room.cmdQ.push(m.cmd);
      }
    } else if (m.t === 'lsin') {
      // LOCKSTEP: relay this client's input frames to the room's other clients.
      // The server is a dumb relay — it never inspects or runs the sim.
      if (room && room.started && room.lockstep && me && Array.isArray(m.frames)) {
        me.lastLsin = Date.now();               // liveness: this client is still feeding the lockstep
        const payload = JSON.stringify({ t: 'lsin', player: me.slot, frames: m.frames });
        for (const c of room.clients) if (c !== me && c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
      }
    } else if (m.t === 'rtc') {
      // WebRTC signaling relay: forward an SDP offer/answer or ICE candidate to the
      // target slot in this room, tagging it with the sender's slot. The server only
      // shuttles signaling — the media (lockstep input) flows peer-to-peer.
      if (room && room.lockstep && me && typeof m.to === 'number') {
        const dest = room.clients.find(c => c.slot === m.to);
        if (dest && dest.ws.readyState === WebSocket.OPEN)
          dest.ws.send(JSON.stringify({ t: 'rtc', from: me.slot, kind: m.kind, data: m.data }));
      }
    } else if (m.t === 'lslast') {
      // LOCKSTEP drop consensus: a client reports the last tick it holds input for
      // the dropped player; once all survivors report, the server broadcasts the
      // agreed drop tick (the min) so everyone switches that player to AI together.
      if (room && room.lockstep && me && room.dropVote && typeof m.tick === 'number' && m.player === room.dropVote.player) {
        room.dropVote.votes.set(me.slot, m.tick);
        if (room.dropVote.votes.size >= room.clients.length) {
          const at = Math.min(...room.dropVote.votes.values());
          const pl = room.dropVote.player;
          for (const c of room.clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ t: 'lsdrop', player: pl, tick: at }));
          room.dropVote = undefined;
        }
      }
    }
  });

  ws.on('close', () => {
    if (me) online.delete(me);                  // drop from the presence list
    if (!room || !me) { broadcastLobby(); return; }
    const leaverSlot = me.slot;
    const idx = room.clients.indexOf(me);
    if (idx >= 0) room.clients.splice(idx, 1);
    if (!room.clients.length) {
      if (room.timer) clearInterval(room.timer);
      // last human gone mid-game: end the match (no AI-vs-AI grind), keep replay
      if (room.started && room.sim && !room.sim.done) {
        if (room.sim.tickN > 600 && !room.sim.cheated) saveReplay(room);
      }
      rooms.delete(room.code);
    } else if (!room.started) {
      // still in the lobby: compact the slots so the remaining players reindex
      room.clients.forEach((c, i) => { c.slot = i; });
      sendRoom(room);
    } else if (room.lockstep) {
      // lockstep: no server sim to reassign. Start drop consensus — survivors
      // report the last tick they hold the leaver's input for, and the server
      // broadcasts the agreed (min) drop tick so everyone switches that player
      // to local AI at the SAME tick, preserving determinism.
      room.dropVote = { player: leaverSlot, votes: new Map() };
      for (const c of room.clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ t: 'lsdropvote', player: leaverSlot }));
    } else {
      // a human left an in-progress match: transfer their army to an allied
      // human if one is still here, otherwise disband it — never a team defeat
      departMidGame(room, leaverSlot);
    }
    broadcastLobby();                           // open-games list may have changed
  });
});

// refresh presence views every few seconds so live ping values keep updating in
// the global lobby and in any waiting room (cheap — only idle/lobby clients)
setInterval(() => {
  if (online.size) broadcastLobby();
  for (const r of rooms.values()) if (!r.started && r.clients.length) sendRoom(r);
}, 3000);

// lockstep liveness watchdog: a peer whose tab froze / backgrounded / went to a
// half-open socket keeps the connection alive but stops sending inputs, which
// stalls the WHOLE match for everyone (the sim can't advance without its input).
// If a previously-active client (lastLsin set) goes silent past the threshold,
// close its socket — the normal disconnect path then runs the drop-vote consensus
// so all survivors switch it to AI at the same tick and the game resumes.
const STALL_DROP_MS = 8000;
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (!r.started || !r.lockstep || r.dropVote || r.clients.length < 2) continue;
    for (const c of r.clients) {
      if (c.lastLsin !== undefined && now - c.lastLsin > STALL_DROP_MS && c.ws.readyState === WebSocket.OPEN) {
        try { c.ws.close(); } catch { /* already gone */ }
        break; // one drop per sweep; its close handler starts the consensus vote
      }
    }
  }
}, 2000);

http.listen(PORT, () => {
  console.log(`INFINITE GREED server: http://localhost:${PORT} (HTTP + WebSocket)`);
  console.log(`Serving client from: ${DIST}`);
});
