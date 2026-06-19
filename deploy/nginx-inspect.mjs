// READ-ONLY inspection of the box's nginx setup. Changes NOTHING.
import { Client } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

let local = {};
try { const f = join(process.cwd(), 'deploy', 'secrets.local.json'); if (existsSync(f)) local = JSON.parse(readFileSync(f, 'utf8')); } catch {}
const HOST = process.env.DEPLOY_HOST || local.DEPLOY_HOST;
const USER = process.env.DEPLOY_USER || local.DEPLOY_USER || 'root';
const PASS = process.env.DEPLOY_PASS || local.DEPLOY_PASS;
if (!HOST || !PASS) { console.error('Set DEPLOY_HOST / DEPLOY_PASS'); process.exit(1); }

const CMDS = [
  ['nginx-active', 'systemctl is-active nginx 2>&1'],
  ['nginx-v', 'nginx -v 2>&1'],
  ['certbot', 'which certbot 2>&1 || echo NO_CERTBOT; certbot --version 2>&1 || true'],
  ['sites-available', 'ls -la /etc/nginx/sites-available/ 2>&1'],
  ['sites-enabled', 'ls -la /etc/nginx/sites-enabled/ 2>&1'],
  ['conf.d', 'ls -la /etc/nginx/conf.d/ 2>&1'],
  ['server_names', 'grep -rEn "server_name|listen " /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | head -80'],
  ['existing-certs', 'ls -la /etc/letsencrypt/live/ 2>&1 || echo NO_LE'],
  ['nginx-test', 'nginx -t 2>&1'],
  ['game-up', 'curl -s -o /dev/null -w "localhost:8085 -> %{http_code}\\n" http://localhost:8085/ 2>&1 || echo CURL_FAIL'],
  ['port80', 'ss -tlnp 2>/dev/null | grep -E ":80 |:443 " || echo none'],
];

const conn = new Client();
conn.on('ready', async () => {
  for (const [label, cmd] of CMDS) {
    await new Promise(res => {
      conn.exec(cmd, (err, stream) => {
        if (err) { console.log(`== ${label} ==\nEXEC ERR ${err.message}\n`); return res(null); }
        let out = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => out += d);
        stream.on('close', () => { console.log(`== ${label} ==\n${out.trim()}\n`); res(null); });
      });
    });
  }
  conn.end();
}).on('error', e => { console.error('SSH ERROR:', e.message); process.exit(1); })
  .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 });
