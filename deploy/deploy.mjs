// Deploy FRACTURED EARTH to the Vultr box as a Docker container.
// Touches ONLY: /opt/fractured-earth, a 'fractured-earth' container, one ufw rule.
import { Client } from 'ssh2';
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, posix } from 'path';

// local fallback secrets (gitignored) so deploys work without exported env vars
let local = {};
try {
  const f = join(process.cwd(), 'deploy', 'secrets.local.json');
  if (existsSync(f)) local = JSON.parse(readFileSync(f, 'utf8'));
} catch { /* ignore malformed file — env vars still win */ }

const HOST = process.env.DEPLOY_HOST || local.DEPLOY_HOST;
const USER = process.env.DEPLOY_USER || local.DEPLOY_USER || 'root';
const PASS = process.env.DEPLOY_PASS || local.DEPLOY_PASS;
const ADVISOR_KEY = process.env.ADVISOR_KEY || local.ADVISOR_KEY;
if (!HOST || !PASS) { console.error('Set DEPLOY_HOST / DEPLOY_PASS (env or deploy/secrets.local.json)'); process.exit(1); }

const LOCAL = process.cwd();
const REMOTE = '/opt/fractured-earth';
const PORT = 8085;

const MINI_PKG = JSON.stringify({
  name: 'fractured-earth', private: true, type: 'module',
  dependencies: { ws: '^8.17.0' },
}, null, 2);

function listFiles(dir, base = dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

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
    console.log('connected.');
    // sanity: confirm the port is still free on the host (excluding our own container)
    const portCheck = await exec(`ss -tlnp | grep -E ':${PORT} ' | grep -v fractured || true`);
    if (portCheck.out && !portCheck.out.includes('docker-proxy')) {
      console.log('WARNING: port in use:\n' + portCheck.out);
    }

    await exec(`mkdir -p ${REMOTE}/dist/assets`);

    const sftp = await new Promise((res, rej) => conn.sftp((e, s) => e ? rej(e) : res(s)));
    const put = (local, remote) => new Promise((res, rej) =>
      sftp.fastPut(local, remote, e => e ? rej(e) : res(null)));
    const write = (remote, data) => new Promise((res, rej) => {
      const ws = sftp.createWriteStream(remote);
      ws.on('close', () => res(null)); ws.on('error', rej);
      ws.end(data);
    });

    for (const rel of listFiles(join(LOCAL, 'dist'))) {
      const remoteDir = posix.dirname(`${REMOTE}/dist/${rel}`);
      await exec(`mkdir -p ${remoteDir}`);
      await put(join(LOCAL, 'dist', rel), `${REMOTE}/dist/${rel}`);
      console.log('uploaded dist/' + rel);
    }
    await put(join(LOCAL, 'server.mjs'), `${REMOTE}/server.mjs`);
    console.log('uploaded server.mjs');
    await write(`${REMOTE}/package.json`, MINI_PKG);
    console.log('wrote package.json');

    console.log('starting container...');
    await exec('docker rm -f fractured-earth 2>/dev/null || true');
    // optional Claude strategist key: lives only in the container env, never in files
    const advisorEnv = ADVISOR_KEY ? `-e ADVISOR_KEY='${ADVISOR_KEY}' ` : '';
    const run = await exec(
      // publish ONLY on localhost so nginx (127.0.0.1) reaches it but the game port
      // isn't directly reachable from the internet (Docker's iptables bypasses ufw).
      `docker run -d --name fractured-earth --restart unless-stopped ` +
      `-p 127.0.0.1:${PORT}:8080 -v ${REMOTE}:/app -w /app -m 300m ${advisorEnv}node:20-alpine ` +
      `sh -c "[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund; exec node server.mjs"`
    );
    console.log('docker run:', run.out, '(exit', run.code + ')');

    const ufw = await exec(`ufw allow ${PORT}/tcp comment 'fractured-earth game' && ufw status | grep ${PORT}`);
    console.log('ufw:', ufw.out);

    // wait for npm install inside the container, then health-check
    let ok = false;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const h = await exec(`curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}/`);
      console.log(`health check ${i + 1}: HTTP ${h.out}`);
      if (h.out === '200') { ok = true; break; }
    }
    const logs = await exec('docker logs --tail 10 fractured-earth 2>&1');
    console.log('container logs:\n' + logs.out);
    console.log(ok ? 'DEPLOY OK' : 'DEPLOY FAILED - not serving 200');
  } catch (e) {
    console.error('DEPLOY ERROR:', e.message);
  } finally {
    conn.end();
  }
}).on('error', e => { console.error('SSH ERROR:', e.message); process.exit(1); })
  .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 });
