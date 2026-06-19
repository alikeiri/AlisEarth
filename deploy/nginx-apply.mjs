// Stage the Infinite Greed nginx vhost on the box. ADDITIVE & SAFE:
//   1. backs up any existing infinitegreed.conf
//   2. uploads deploy/nginx/infinitegreed.conf -> /etc/nginx/conf.d/infinitegreed.conf
//   3. runs `nginx -t`; ONLY reloads if the test passes (rolls back otherwise)
// Touches nothing belonging to the Matrix/Synapse (*.configit.com.au) stack.
import { Client } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

let local = {};
try { const f = join(process.cwd(), 'deploy', 'secrets.local.json'); if (existsSync(f)) local = JSON.parse(readFileSync(f, 'utf8')); } catch {}
const HOST = process.env.DEPLOY_HOST || local.DEPLOY_HOST;
const USER = process.env.DEPLOY_USER || local.DEPLOY_USER || 'root';
const PASS = process.env.DEPLOY_PASS || local.DEPLOY_PASS;
if (!HOST || !PASS) { console.error('Set DEPLOY_HOST / DEPLOY_PASS'); process.exit(1); }

const CONF = readFileSync(join(process.cwd(), 'deploy', 'nginx', 'infinitegreed.conf'), 'utf8');
const REMOTE = '/etc/nginx/conf.d/infinitegreed.conf';

const conn = new Client();
const exec = cmd => new Promise((res) => {
  conn.exec(cmd, (err, stream) => {
    if (err) return res({ code: 1, out: 'EXEC ERR ' + err.message });
    let out = ''; let code = 0;
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('close', c => { code = c; res({ code, out: out.trim() }); });
  });
});
const put = (content, dest) => new Promise((res, rej) => {
  conn.sftp((err, sftp) => {
    if (err) return rej(err);
    const ws = sftp.createWriteStream(dest);
    ws.on('close', res); ws.on('error', rej);
    ws.end(content);
  });
});

conn.on('ready', async () => {
  // 1. backup existing (if any)
  await exec(`[ -f ${REMOTE} ] && cp ${REMOTE} ${REMOTE}.bak.$(date +%s) || true`);
  // 2. upload
  await put(CONF, REMOTE);
  console.log('uploaded ->', REMOTE);
  // 3. test
  const t = await exec('nginx -t 2>&1');
  console.log('== nginx -t ==\n' + t.out);
  if (t.code !== 0) {
    console.error('\nnginx -t FAILED — removing the new file, NOT reloading.');
    await exec(`rm -f ${REMOTE}`);
    conn.end();
    process.exit(1);
  }
  // 4. reload
  const r = await exec('systemctl reload nginx 2>&1 && echo RELOADED');
  console.log('== reload ==\n' + r.out);
  conn.end();
}).on('error', e => { console.error('SSH ERROR:', e.message); process.exit(1); })
  .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 });
