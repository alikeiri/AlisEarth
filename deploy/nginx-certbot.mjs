// Obtain Let's Encrypt TLS for the Infinite Greed domains via the certbot nginx
// plugin. Run ONLY after DNS for the requested names points at this box.
//
//   node deploy/nginx-certbot.mjs                 # default: both apexes + www
//   node deploy/nginx-certbot.mjs infinitegreed.de www.infinitegreed.de
//
// certbot --nginx edits ONLY the server block whose server_name matches; it
// adds the :443 listener + HTTP->HTTPS redirect. It will not touch the
// *.configit.com.au vhosts. The script first verifies each name resolves to
// this box and skips any that don't (a name that doesn't resolve fails the
// whole cert request).
import { Client } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

let local = {};
try { const f = join(process.cwd(), 'deploy', 'secrets.local.json'); if (existsSync(f)) local = JSON.parse(readFileSync(f, 'utf8')); } catch {}
const HOST = process.env.DEPLOY_HOST || local.DEPLOY_HOST;
const USER = process.env.DEPLOY_USER || local.DEPLOY_USER || 'root';
const PASS = process.env.DEPLOY_PASS || local.DEPLOY_PASS;
const EMAIL = process.env.LE_EMAIL || local.LE_EMAIL || 'alikeiri@gmail.com';
if (!HOST || !PASS) { console.error('Set DEPLOY_HOST / DEPLOY_PASS'); process.exit(1); }

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['infinitegreed.com', 'www.infinitegreed.com', 'infinitegreed.de', 'www.infinitegreed.de'];

const conn = new Client();
const exec = cmd => new Promise((res) => {
  conn.exec(cmd, (err, stream) => {
    if (err) return res({ code: 1, out: 'EXEC ERR ' + err.message });
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('close', c => res({ code: c, out: out.trim() }));
  });
});

conn.on('ready', async () => {
  // Resolve each candidate FROM the box and keep only those pointing here.
  const myip = (await exec(`curl -s https://api.ipify.org || hostname -I | awk '{print $1}'`)).out.trim();
  console.log('box public IP:', myip);
  const good = [];
  for (const name of CANDIDATES) {
    const r = await exec(`getent hosts ${name} | awk '{print $1}' | head -1`);
    const ip = r.out.trim();
    const ok = ip && (ip === myip);
    console.log(`  ${name} -> ${ip || '(no record)'} ${ok ? 'OK' : 'SKIP'}`);
    if (ok) good.push(name);
  }
  if (!good.length) {
    console.error('\nNo candidate names resolve to this box yet. Set DNS A records first.');
    conn.end(); process.exit(1);
  }
  const dflags = good.map(n => `-d ${n}`).join(' ');
  const cmd = `certbot --nginx ${dflags} --non-interactive --agree-tos -m ${EMAIL} --redirect 2>&1`;
  console.log('\n== certbot ==\n' + cmd + '\n');
  const c = await exec(cmd);
  console.log(c.out);
  console.log('\n== nginx -t (post) ==');
  console.log((await exec('nginx -t 2>&1')).out);
  conn.end();
}).on('error', e => { console.error('SSH ERROR:', e.message); process.exit(1); })
  .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 });
