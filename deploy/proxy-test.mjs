// Set up an ADDITIVE nginx vhost + Let's Encrypt cert for test.infinitegreed.com
// proxying to the test container on :8086. Mirrors the prod vhost
// (/etc/nginx/conf.d/infinitegreed.conf) so the game's WebSockets work, and uses
// a UNIQUELY-NAMED upgrade map ($igtest_connection_upgrade) so it can never
// collide with the prod game's map or the Matrix/Synapse stack's. Writes ONLY its
// own conf.d file; never edits any other vhost.
//
//   node deploy/proxy-test.mjs inspect   -> read-only: show prod vhost + DNS state
//   node deploy/proxy-test.mjs apply     -> write test vhost, nginx -t, reload, certbot
import { Client } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

let local = {};
try { const f = join(process.cwd(), 'deploy', 'secrets.local.json'); if (existsSync(f)) local = JSON.parse(readFileSync(f, 'utf8')); } catch {}
const HOST = process.env.DEPLOY_HOST || local.DEPLOY_HOST;
const USER = process.env.DEPLOY_USER || local.DEPLOY_USER || 'root';
const PASS = process.env.DEPLOY_PASS || local.DEPLOY_PASS;
const LE_EMAIL = process.env.LE_EMAIL || local.LE_EMAIL;
if (!HOST || !PASS) { console.error('Set DEPLOY_HOST / DEPLOY_PASS'); process.exit(1); }

const MODE = process.argv[2] === 'apply' ? 'apply' : 'inspect';
const DOMAIN = 'test.infinitegreed.com';
const CONF = `/etc/nginx/conf.d/infinitegreed-test.conf`;

const conn = new Client();
const exec = cmd => new Promise((res) => conn.exec(cmd, (err, stream) => {
  if (err) return res({ code: 1, out: String(err) });
  let out = ''; stream.on('data', d => out += d); stream.stderr.on('data', d => out += d);
  stream.on('close', code => res({ code, out: out.trim() }));
}));

// http-only vhost + its own uniquely-named upgrade map; certbot --nginx rewrites
// this same file to add the 443 server + http->https redirect.
const VHOST = `# test.infinitegreed.com -> test game container (:8086). Additive; mirrors prod.
# Uniquely-named map so it can never collide with another $..._connection_upgrade.
map $http_upgrade $igtest_connection_upgrade {
    default upgrade;
    ''      close;
}
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:8086;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $igtest_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
`;

conn.on('ready', async () => {
  try {
    const ip = (await exec(`getent hosts ${DOMAIN} | awk '{print $1}' | head -1`)).out;
    const myip = (await exec(`curl -s -4 ifconfig.me || hostname -I | awk '{print $1}'`)).out;
    console.log(`DNS ${DOMAIN} -> ${ip || '(unresolved)'}\nbox public IP -> ${myip}`);

    if (MODE === 'inspect') {
      const exists = await exec(`cat ${CONF} 2>/dev/null || echo '(test vhost not yet created)'`);
      console.log(`\n--- ${CONF} ---\n` + exists.out);
      console.log('\nInspect only. Re-run with "apply" once DNS points at the box.');
      return;
    }

    // ---- apply (DNS-guarded) ----
    if (!ip) { console.log(`\nABORT: ${DOMAIN} does not resolve yet. Add an A record -> ${myip}, wait for propagation, then re-run apply.`); return; }
    if (myip && ip !== myip) { console.log(`\nABORT: ${DOMAIN} resolves to ${ip}, not this box (${myip}).`); return; }

    await exec(`printf '%s' ${JSON.stringify(VHOST)} > ${CONF}`);
    console.log('wrote ' + CONF);
    const test = await exec('nginx -t 2>&1');
    console.log('nginx -t:\n' + test.out);
    if (test.code !== 0) { console.log('ABORT: nginx config test failed — leaving as-is, not reloading.'); return; }
    await exec('systemctl reload nginx');
    console.log('nginx reloaded (HTTP vhost live).');

    const emailArg = LE_EMAIL ? `-m ${LE_EMAIL}` : '--register-unsafely-without-email';
    const cb = await exec(`certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos ${emailArg} --redirect 2>&1`);
    console.log('\n--- certbot ---\n' + cb.out);
    const https = await exec(`curl -s -o /dev/null -w '%{http_code}' https://${DOMAIN}/ || echo fail`);
    console.log(`\nhttps://${DOMAIN}/ -> HTTP ${https.out}`);
  } finally { conn.end(); }
}).on('error', e => { console.error('SSH ERROR:', e.message); process.exit(1); })
  .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 });
