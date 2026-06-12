// Post-deploy safety check: confirm the existing Matrix stack is untouched.
import { Client } from 'ssh2';

const conn = new Client();
const CMDS = [
  ['synapse', 'systemctl is-active matrix-synapse'],
  ['synapse-health', 'curl -s http://localhost:8008/health'],
  ['nginx', 'systemctl is-active nginx && nginx -t 2>&1 | tail -1'],
  ['coturn', 'systemctl is-active coturn'],
  ['postgres', 'systemctl is-active postgresql@14-main'],
  ['docker-containers', 'docker ps --format "{{.Names}} {{.Status}}"'],
  ['mem', 'free -m | head -2'],
];
conn.on('ready', async () => {
  for (const [label, cmd] of CMDS) {
    await new Promise(res => conn.exec(cmd, (err, stream) => {
      if (err) { console.log(`${label}: EXEC ERR`); return res(null); }
      let out = '';
      stream.on('data', d => out += d);
      stream.stderr.on('data', d => out += d);
      stream.on('close', () => { console.log(`== ${label} ==\n${out.trim()}\n`); res(null); });
    }));
  }
  conn.end();
}).on('error', e => { console.error('SSH ERROR:', e.message); process.exit(1); })
  .connect({
    host: process.env.DEPLOY_HOST, port: 22,
    username: process.env.DEPLOY_USER || 'root', password: process.env.DEPLOY_PASS,
    readyTimeout: 20000,
  });
