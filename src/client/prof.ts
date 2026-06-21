// Activatable high-precision frame profiler. Zero cost when disabled. Wrap hot
// sections with prof.begin(label)/prof.end(label) (properly nested) or
// prof.wrap(label, fn). When enabled it accumulates time + call counts per label
// per frame; prof.frame() folds each frame's totals into a smoothed average that
// the perf overlay renders as a sorted "where the time goes" table.
//
// Toggle in-game with Shift+` (backtick). Inspect from the console any time:
//   __prof.table()   -> sorted [{label, ms, n}]   (ms = avg per frame)
//   __prof.enabled = true
class Profiler {
  enabled = false;
  private cur: Record<string, { ms: number; n: number }> = {};
  private avg: Record<string, { ms: number; n: number }> = {};
  private stack: { t: number }[] = [];

  begin(_label: string) { if (this.enabled) this.stack.push({ t: performance.now() }); }
  // end() pops the most recent begin() (LIFO) and credits the elapsed time to
  // `label`; begin/end must be properly nested.
  end(label: string) {
    if (!this.enabled) return;
    const e = this.stack.pop();
    if (!e) return;
    const dt = performance.now() - e.t;
    const z = this.cur[label] || (this.cur[label] = { ms: 0, n: 0 });
    z.ms += dt; z.n++;
  }
  wrap<T>(label: string, fn: () => T): T {
    if (!this.enabled) return fn();
    this.begin(label);
    try { return fn(); } finally { this.end(label); }
  }
  // call once per frame: smooth this frame's per-label totals into the running avg
  frame() {
    if (!this.enabled) { if (this.stack.length) this.stack = []; return; }
    for (const k in this.cur) {
      const c = this.cur[k];
      const a = this.avg[k] || (this.avg[k] = { ms: 0, n: 0 });
      a.ms += (c.ms - a.ms) * 0.12;
      a.n += (c.n - a.n) * 0.12;
    }
    // decay labels that stopped firing so stale rows fade out
    for (const k in this.avg) if (!this.cur[k]) { this.avg[k].ms *= 0.9; if (this.avg[k].ms < 0.004) delete this.avg[k]; }
    this.cur = {};
    this.stack = [];
  }
  // sorted breakdown (ms = smoothed average per frame, n = calls/frame)
  table(top = 18): { label: string; ms: number; n: number }[] {
    return Object.entries(this.avg)
      .map(([label, v]) => ({ label, ms: v.ms, n: Math.round(v.n * 10) / 10 }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, top);
  }
  reset() { this.cur = {}; this.avg = {}; this.stack = []; }
}
export const prof = new Profiler();
