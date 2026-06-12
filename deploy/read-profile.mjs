// Read the server-side AI study profile (ai-profile.json) from the game box.
import { Client } from 'ssh2';

const HOST = process.env.DEPLOY_HOST, USER = process.env.DEPLOY_USER || 'root', PASS = process.env.DEPLOY_PASS;
if (!HOST || !PASS) { console.error('Set DEPLOY_HOST / DEPLOY_PASS'); process.exit(1); }

const conn = new Client();
conn.on('ready', () => {
  conn.exec('cat /opt/fractured-earth/ai-profile.json 2>/dev/null || echo NO_PROFILE_FILE', (err, stream) => {
    if (err) { console.error(err.message); process.exit(1); }
    let out = '';
    stream.on('data', (d) => out += d);
    stream.on('close', () => { console.log(out.trim()); conn.end(); });
  });
}).connect({ host: HOST, username: USER, password: PASS });
