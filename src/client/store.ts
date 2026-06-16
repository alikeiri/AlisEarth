// Safe localStorage wrapper. A privacy-hardened browser (notably Firefox with
// site storage/cookies blocked) THROWS "SecurityError: The operation is insecure"
// the moment localStorage is touched — and an unguarded access during startup
// took the whole app down (worked in Chrome, dead in Firefox). This shim never
// throws: it probes storage once and, if unavailable, transparently falls back
// to an in-memory map so settings still work for the session (just don't persist).
// Its API mirrors localStorage, so call sites use `safeLS` exactly as before.
function makeSafeLS() {
  let ok = true;
  const mem: Record<string, string> = {};
  try {
    const k = '__fe_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
  } catch { ok = false; }
  return {
    getItem(k: string): string | null {
      if (ok) { try { return window.localStorage.getItem(k); } catch { ok = false; } }
      return k in mem ? mem[k] : null;
    },
    setItem(k: string, v: string): void {
      if (ok) { try { window.localStorage.setItem(k, v); return; } catch { ok = false; } }
      mem[k] = String(v);
    },
    removeItem(k: string): void {
      if (ok) { try { window.localStorage.removeItem(k); return; } catch { ok = false; } }
      delete mem[k];
    },
  };
}

export const safeLS = makeSafeLS();
