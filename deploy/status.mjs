// Quick health/resource check on the Vultr box: memory, disk, and the game
// containers (prod + test). Read-only — runs a handful of shell commands.
//   node deploy/status.mjs
import { Client } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

let local = {};
try { const f = join(process.cwd(), 'deploy', 'secrets.local.json'); if (existsSync(f)) local = JSON.parse(readFileSync(f, 'utf8')); } catch {}
const HOST = process.env.DEPLOY_HOST || local.DEPLOY_HOST;
const USER = process.env.DEPLOY_USER || local.DEPLOY_USER || 'root';
const PASS = process.env.DEPLOY_PASS || local.DEPLOY_PASS;
if (!HOST || !PASS) { console.error('Set DEPLOY_HOST / DEPLOY_PASS (env or deploy/secrets.local.json)'); process.exit(1); }

const conn = new Client();
const exec = cmd => new Promise((res) => conn.exec(cmd, (err, stream) => {
  if (err) return res({ code: 1, out: String(err) });
  let out = ''; stream.on('data', d => out += d); stream.stderr.on('data', d => out += d);
  stream.on('close', code => res({ code, out: out.trim() }));
}));

conn.on('ready', async () => {
  try {
    const mem = await exec('free -m | awk \'NR<=2\'');
    console.log('--- memory (MB) ---\n' + mem.out);
    const disk = await exec("df -h / | awk 'NR<=2'");
    console.log('\n--- disk (/) ---\n' + disk.out);
    const ps = await exec("docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'NAMES|fractured' || echo '(no fractured containers)'");
    console.log('\n--- game containers ---\n' + ps.out);
    const stats = await exec("docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' | grep -E 'NAME|fractured' || true");
    console.log('\n--- container usage ---\n' + stats.out);
    for (const [name, port] of [['fractured-earth', 8085], ['fractured-earth-test', 8086]]) {
      const h = await exec(`curl -s -o /dev/null -w '%{http_code}' http://localhost:${port}/ || echo down`);
      console.log(`\n${name} (:${port}) -> HTTP ${h.out}`);
    }
  } finally { conn.end(); }
}).on('error', e => { console.error('SSH ERROR:', e.message); process.exit(1); })
  .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 });
