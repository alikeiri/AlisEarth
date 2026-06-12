// End-to-end multiplayer probe against the deployed server:
// create a room, start a game vs AI, count snapshots.
import WebSocket from 'ws';

const URL = process.argv[2]
  || (process.env.DEPLOY_HOST && `ws://${process.env.DEPLOY_HOST}:8085`)
  || (() => { console.error('usage: node probe-remote.mjs ws://<host>:<port>  (or set DEPLOY_HOST)'); process.exit(1); })();
const ws = new WebSocket(URL);
let snaps = 0, last = null;

ws.on('open', () => ws.send(JSON.stringify({ t: 'create', name: 'DeployProbe', faction: 'estonia' })));
ws.on('message', raw => {
  const m = JSON.parse(String(raw));
  if (m.t === 'room') { console.log('ROOM', m.code); ws.send(JSON.stringify({ t: 'start' })); }
  else if (m.t === 'start') console.log('START players=', m.players.map(p => p.name).join(' vs '));
  else if (m.t === 'snap') { snaps++; last = m; }
});
ws.on('error', e => { console.log('WS ERROR', e.message); process.exit(1); });

setTimeout(() => {
  console.log('snapshots in 4s:', snaps);
  if (last) console.log('tick', last.k, '| entities', last.e.length, '| players', JSON.stringify(last.p.map(p => [p.n, p.c])));
  process.exit(0);
}, 4000);
