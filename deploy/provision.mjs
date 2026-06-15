// One-time host provisioning for a fresh Vultr Ubuntu box: installs Docker so
// deploy.mjs (which runs the game as a Docker container) works. Idempotent —
// safe to re-run. Host/credentials come from env vars or deploy/secrets.local.json,
// exactly like deploy.mjs, so you can target a new box with:
//   DEPLOY_HOST=<ip> DEPLOY_PASS=<pass> node deploy/provision.mjs
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
if (!HOST || !PASS) { console.error('Set DEPLOY_HOST / DEPLOY_PASS (env or deploy/secrets.local.json)'); process.exit(1); }

const conn = new Client();
const exec = cmd => new Promise((res, rej) => {
  conn.exec(cmd, (err, stream) => {
    if (err) return rej(err);
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('close', code => res({ code, out: out.trim() }));
  });
});

conn.on('ready', async () => {
  try {
    console.log('connected to', HOST);
    const has = await exec('command -v docker >/dev/null 2>&1 && echo yes || echo no');
    if (has.out.endsWith('yes')) {
      console.log('docker already installed');
    } else {
      console.log('installing docker via get.docker.com (this takes ~1-2 min)...');
      const r = await exec('curl -fsSL https://get.docker.com | sh');
      console.log(r.out.slice(-400));
    }
    await exec('systemctl enable --now docker 2>&1 || true');
    const v = await exec('docker --version; systemctl is-active docker');
    console.log('result:', v.out);
    console.log(v.out.includes('Docker version') ? 'PROVISION OK' : 'PROVISION FAILED');
  } catch (e) {
    console.error('PROVISION ERROR:', e.message);
  } finally {
    conn.end();
  }
}).on('error', e => { console.error('SSH ERROR:', e.message); process.exit(1); })
  .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 30000 });
