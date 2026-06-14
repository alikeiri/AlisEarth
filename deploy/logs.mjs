// Fetch the running container's logs from the Vultr box (read-only; touches nothing).
import { Client } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

let local = {};
try {
  const f = join(process.cwd(), 'deploy', 'secrets.local.json');
  if (existsSync(f)) local = JSON.parse(readFileSync(f, 'utf8'));
} catch { /* ignore */ }

const HOST = process.env.DEPLOY_HOST || local.DEPLOY_HOST;
const USER = process.env.DEPLOY_USER || local.DEPLOY_USER || 'root';
const PASS = process.env.DEPLOY_PASS || local.DEPLOY_PASS;
const TAIL = process.argv[2] || '500';

const conn = new Client();
const exec = cmd => new Promise((res, rej) => {
  conn.exec(cmd, (err, stream) => {
    if (err) return rej(err);
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('close', code => res({ code, out }));
  });
});

conn.on('ready', async () => {
  try {
    const logs = await exec(`docker logs --tail ${TAIL} fractured-earth 2>&1`);
    console.log('===== docker logs (tail ' + TAIL + ') =====');
    console.log(logs.out);
    const ps = await exec(`docker ps -a --filter name=fractured-earth --format '{{.Status}}'`);
    console.log('===== container status =====');
    console.log(ps.out.trim());
    const restarts = await exec(`docker inspect -f '{{.RestartCount}} restarts; started {{.State.StartedAt}}; oomkilled={{.State.OOMKilled}}; exitcode={{.State.ExitCode}}' fractured-earth 2>&1`);
    console.log('===== container health =====');
    console.log(restarts.out.trim());
  } catch (e) {
    console.error('ERR:', e.message);
  } finally {
    conn.end();
  }
}).on('error', e => { console.error('SSH ERROR:', e.message); process.exit(1); })
  .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 });
