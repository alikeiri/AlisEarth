// Thin WebSocket wrapper. In dev (vite :5173) the game server runs on :8080.

export class Net {
  ws: WebSocket | null = null;
  private handlers = new Map<string, ((m: any) => void)[]>();

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
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error('Cannot reach the game server'));
      ws.onmessage = ev => {
        let m: any;
        try { m = JSON.parse(ev.data); } catch { return; }
        for (const fn of this.handlers.get(m.t) || []) fn(m);
      };
      ws.onclose = () => { for (const fn of this.handlers.get('_close') || []) fn({}); };
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

  close() { this.ws?.close(); this.ws = null; this.handlers.clear(); }
}
