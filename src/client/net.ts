// Thin WebSocket wrapper. In dev (vite :5173) the game server runs on :8080.

export class Net {
  ws: WebSocket | null = null;
  private handlers = new Map<string, ((m: any) => void)[]>();
  // lightweight receive telemetry for the perf overlay (bytes are UTF-16 string
  // length — fine as a relative measure of bandwidth and snapshot growth)
  stats = { bytes: 0, msgs: 0, lastT: 0, lastSize: 0, snapBytes: 0, snaps: 0, ping: 0 };
  private pingTimer: any = null;

  static url(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const host = location.port === '5173' ? `${location.hostname}:8080` : location.host;
    return `${proto}://${host}`;
  }

  connect(): Promise<void> {
    return new Promise((res, rej) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return res();
      const ws = new WebSocket(Net.url());
      this.ws = ws;
      ws.onopen = () => {
        res();
        // round-trip ping every 2s; we piggyback our last measured RTT so the
        // server can show each player's ping in the lobby
        const beat = () => this.send({ t: 'ping', ts: performance.now(), rtt: Math.round(this.stats.ping) });
        beat();
        this.pingTimer = setInterval(beat, 2000);
      };
      ws.onerror = () => rej(new Error('Cannot reach the game server'));
      ws.onmessage = ev => {
        const sz = typeof ev.data === 'string' ? ev.data.length : 0;
        this.stats.bytes += sz; this.stats.msgs++;
        this.stats.lastT = performance.now(); this.stats.lastSize = sz;
        let m: any;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'pong') { // RTT measurement — smoothed
          const rtt = performance.now() - m.ts;
          this.stats.ping = this.stats.ping ? this.stats.ping * 0.6 + rtt * 0.4 : rtt;
          return;
        }
        if (m.t === 'snap') { this.stats.snapBytes += sz; this.stats.snaps++; }
        for (const fn of this.handlers.get(m.t) || []) fn(m);
      };
      ws.onclose = () => { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } for (const fn of this.handlers.get('_close') || []) fn({}); };
    });
  }

  on(type: string, fn: (m: any) => void) {
    const arr = this.handlers.get(type) || [];
    arr.push(fn);
    this.handlers.set(type, arr);
  }

  send(obj: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } this.ws?.close(); this.ws = null; this.handlers.clear(); }
}
