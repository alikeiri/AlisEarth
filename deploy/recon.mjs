// Read-only recon of the Vultr server: what's running, which ports are taken,
// is node present. Changes NOTHING.
import { Client } from 'ssh2';

const HOST = process.env.DEPLOY_HOST;
const USER = process.env.DEPLOY_USER || 'root';
const PASS = process.env.DEPLOY_PASS;
if (!HOST || !PASS) { console.error('Set DEPLOY_HOST / DEPLOY_PASS'); process.exit(1); }

const CMDS = [
  ['os', 'cat /etc/os-release | head -2'],
  ['node', 'node -v 2>&1 || echo NO_NODE'],
  ['ports', 'ss -tlnp 2>/dev/null | tail -n +2'],
  ['services', 'systemctl list-units --type=service --state=running --no-pager --no-legend | awk "{print \\$1}" | grep -v -E "^(ssh|cron|rsyslog|systemd|dbus|networkd|polkit|unattended|getty|qemu|chrony|multipath|irqbalance|packagekit|snapd|udisks)" || true'],
  ['opt', 'ls -la /opt 2>/dev/null'],
  ['www', 'ls /var/www 2>/dev/null || true'],
  ['nginx', 'systemctl is-active nginx 2>/dev/null; systemctl is-active apache2 2>/dev/null; systemctl is-active caddy 2>/dev/null'],
  ['ufw', 'ufw status 2>/dev/null || echo NO_UFW'],
  ['mem', 'free -m | head -2'],
  ['disk', 'df -h / | tail -1'],
  ['pm2', 'pm2 ls 2>/dev/null || echo NO_PM2'],
];

const conn = new Client();
conn.on('ready', async () => {
  for (const [label, cmd] of CMDS) {
    await new Promise(res => {
      conn.exec(cmd, (err, stream) => {
        if (err) { console.log(`== ${label} ==\nEXEC ERR ${err.message}`); return res(null); }
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
