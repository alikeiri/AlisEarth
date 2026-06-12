// Procedural audio: WebAudio-synthesized sound effects and a generative
// ambient score. No audio files — everything is synthesized at runtime.

class AudioMan {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxG!: GainNode;
  private musG!: GainNode;
  private delay!: DelayNode;
  private noiseBuf: AudioBuffer | null = null;
  private last: Record<string, number> = {};
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private eighth = 0;
  private nextT = 0;
  muted = false;

  constructor() {
    try { this.muted = localStorage.getItem('fe_mute') === '1'; } catch {}
  }

  // Must be called from a user gesture (autoplay policy). Idempotent.
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC() as AudioContext;
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    this.master.connect(this.ctx.destination);
    this.sfxG = this.ctx.createGain();
    this.sfxG.gain.value = 1;
    this.sfxG.connect(this.master);
    this.musG = this.ctx.createGain();
    this.musG.gain.value = 0.4;
    this.musG.connect(this.master);
    // echo bus for the music arpeggio
    this.delay = this.ctx.createDelay(1);
    this.delay.delayTime.value = 0.34;
    const fb = this.ctx.createGain(); fb.gain.value = 0.32;
    this.delay.connect(fb); fb.connect(this.delay);
    this.delay.connect(this.musG);
    // shared white-noise buffer
    const n = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = n;
    this.startMusic();
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem('fe_mute', m ? '1' : '0'); } catch {}
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.6, this.ctx.currentTime, 0.05);
  }

  // ---------- synth primitives ----------
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, at = 0, dest?: AudioNode) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || this.sfxG);
    o.start(t); o.stop(t + dur + 0.05);
  }

  private burst(dur: number, type: BiquadFilterType, f0: number, f1: number, peak: number, at = 0, q = 1) {
    if (!this.ctx || !this.noiseBuf) return;
    const t = this.ctx.currentTime + at;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.sfxG);
    s.start(t); s.stop(t + dur + 0.05);
  }

  // ---------- sound effects ----------
  play(name: string, vol = 1) {
    if (!this.ctx || this.muted || vol <= 0.02) return;
    const now = performance.now();
    const gap: Record<string, number> = { mg: 50, cn: 80, rkt: 90, zap: 60, salvo: 200, boomS: 70, boomB: 140, cash: 120, crush: 90 };
    if (gap[name] && now - (this.last[name] || 0) < gap[name]) return;
    this.last[name] = now;
    const v = Math.min(1, vol);
    switch (name) {
      case 'mg':
        this.burst(0.07, 'bandpass', 1700, 900, 0.22 * v, 0, 2);
        break;
      case 'cn':
        // tank cannon: sharp crack + deep muzzle thump + body
        this.burst(0.045, 'highpass', 1600, 1600, 0.3 * v);
        this.tone('sine', 115, 34, 0.3, 0.62 * v);
        this.burst(0.24, 'lowpass', 650, 140, 0.38 * v);
        break;
      case 'rkt':
        this.burst(0.32, 'bandpass', 650, 190, 0.3 * v, 0, 1.5);
        break;
      case 'zap':
        this.tone('square', 950, 480, 0.07, 0.1 * v);
        this.tone('sine', 1500, 700, 0.05, 0.06 * v, 0.012);
        break;
      case 'salvo':
        for (let i = 0; i < 3; i++) this.burst(0.26, 'bandpass', 700, 210, 0.22 * v, i * 0.09, 1.5);
        this.tone('sine', 80, 40, 0.3, 0.25 * v, 0.05);
        break;
      case 'boomS':
        this.burst(0.4, 'lowpass', 900, 120, 0.45 * v);
        this.tone('sine', 90, 35, 0.3, 0.3 * v);
        break;
      case 'boomB':
        this.burst(0.85, 'lowpass', 700, 60, 0.7 * v);
        this.tone('sine', 70, 24, 0.7, 0.55 * v);
        this.burst(0.3, 'highpass', 2500, 2500, 0.1 * v, 0.02);
        break;
      case 'done':
        this.tone('sine', 660, 660, 0.1, 0.16 * v);
        this.tone('sine', 990, 990, 0.14, 0.14 * v, 0.09);
        break;
      case 'ready':
        this.tone('triangle', 520, 520, 0.07, 0.16 * v);
        this.tone('triangle', 780, 780, 0.1, 0.14 * v, 0.07);
        break;
      case 'cash':
        this.tone('triangle', 1250, 1250, 0.05, 0.12 * v);
        this.tone('triangle', 1660, 1660, 0.06, 0.1 * v, 0.05);
        break;
      case 'click':
        this.tone('square', 850, 850, 0.025, 0.07 * v);
        break;
      case 'confirm':
        this.tone('sine', 440, 540, 0.07, 0.12 * v);
        break;
      case 'place':
        this.tone('sine', 150, 70, 0.16, 0.3 * v);
        this.burst(0.1, 'lowpass', 400, 200, 0.2 * v);
        break;
      case 'cancel':
        this.tone('sine', 520, 300, 0.1, 0.12 * v);
        break;
      case 'crush':
        // bone crack: two sharp snaps + a wet low crunch
        this.burst(0.025, 'highpass', 2400, 2400, 0.4 * v);
        this.burst(0.03, 'highpass', 1800, 1800, 0.35 * v, 0.045);
        this.burst(0.12, 'lowpass', 500, 160, 0.3 * v, 0.02);
        this.tone('sine', 95, 45, 0.12, 0.25 * v, 0.02);
        break;
      case 'radio':
        this.burst(0.035, 'highpass', 2600, 2600, 0.06 * v);
        break;
      case 'ackBeep':
        this.tone('square', 920, 920, 0.05, 0.09 * v);
        this.tone('square', 1240, 1240, 0.07, 0.08 * v, 0.07);
        break;
      case 'alert': // radar threat klaxon: two-tone descending warble
        this.tone('sawtooth', 740, 560, 0.22, 0.12 * v);
        this.tone('sawtooth', 560, 740, 0.22, 0.10 * v, 0.24);
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this.tone('triangle', f, f, 0.35, 0.2, i * 0.16));
        break;
      case 'lose':
        [440, 349, 294, 220].forEach((f, i) => this.tone('triangle', f, f, 0.4, 0.2, i * 0.2));
        break;
    }
  }

  // World event → positional sfx, attenuated by distance to the camera.
  event(ev: any, camX: number, camZ: number, me: number) {
    if (!this.ctx || this.muted) return;
    if (ev.e === 'ready') { if (ev.p === me) this.play('ready'); return; }
    const d = ev.x !== undefined ? Math.hypot(ev.x - camX, ev.z - camZ) : 0;
    if (d > 55) return;
    const vol = 1 / (1 + d * 0.06);
    if (ev.e === 'shot') this.play(ev.w === 0 ? 'mg' : ev.w === 1 ? 'rkt' : ev.w === 3 ? 'zap' : ev.w === 4 ? 'salvo' : 'cn', vol);
    else if (ev.e === 'boom') this.play(ev.big ? 'boomB' : 'boomS', Math.max(0.25, vol));
    else if (ev.e === 'crush') this.play('crush', vol);
    else if (ev.e === 'done') this.play('done', 0.8);
    else if (ev.e === 'cash') this.play('cash', Math.min(0.5, vol));
  }

  // ---------- unit voice acknowledgments ----------
  private lastAck = 0;
  private static VOICE: Record<string, { move: string[]; attack: string[]; pitch: number; rate: number }> = {
    inf:  { move: ['Moving out!', 'On my way.', 'Yes sir!'], attack: ['Engaging!', 'Open fire!', 'Attacking!'], pitch: 1.15, rate: 1.15 },
    tank: { move: ['Rolling out.', 'Tank moving.', 'Convoy underway.'], attack: ['Target acquired.', 'Firing main gun!', 'Engaging armor!'], pitch: 0.65, rate: 0.95 },
    harv: { move: ['Harvester rolling.', 'Back to work.'], attack: ['Harvester rolling.'], pitch: 0.8, rate: 1.0 },
    eng:  { move: ['Repairs on the way.', 'Engineering, moving.'], attack: ['Engineering, moving.'], pitch: 1.05, rate: 1.1 },
    air:  { move: ['Airborne.', 'Vector confirmed.', 'Copy that.'], attack: ['Weapons hot!', 'Beginning attack run!'], pitch: 1.0, rate: 1.2 },
    sea:  { move: ['Aye aye!', 'Setting course.', 'Anchors aweigh.'], attack: ['All guns, fire!', 'Target sighted!'], pitch: 0.75, rate: 1.0 },
  };

  // Per-class synthesized voice via the browser speech engine; drones answer
  // with a robotic two-tone beep instead.
  ack(unitType: string, action: 'move' | 'attack') {
    if (!this.ctx || this.muted) return;
    const now = performance.now();
    if (now - this.lastAck < 700) return;
    this.lastAck = now;
    const droneTypes = ['recon', 'strike', 'msldrone', 'helidrone', 'navdrone'];
    if (droneTypes.includes(unitType)) { this.play('ackBeep'); return; }
    const grp = unitType === 'rifle' || unitType === 'rocket' ? 'inf'
      : unitType === 'tank' || unitType === 'heavy' || unitType === 'mlrs' ? 'tank'
      : unitType === 'harv' ? 'harv'
      : unitType === 'engineer' ? 'eng'
      : unitType === 'fighter' || unitType === 'bomber' || unitType === 'dbomber' || unitType === 'heli' ? 'air'
      : unitType === 'gunboat' || unitType === 'destroyer' || unitType === 'sub' ? 'sea'
      : 'inf';
    const vc = AudioMan.VOICE[grp];
    const phrases = vc[action] || vc.move;
    this.play('radio');
    try {
      if (!('speechSynthesis' in window)) { this.play('confirm'); return; }
      window.speechSynthesis.cancel(); // don't queue up a backlog
      const u = new SpeechSynthesisUtterance(phrases[(Math.random() * phrases.length) | 0]);
      u.volume = 0.5;
      u.pitch = vc.pitch;
      u.rate = vc.rate;
      window.speechSynthesis.speak(u);
    } catch { this.play('confirm'); }
  }

  // ---------- generative music ----------
  // Slow minor progression: Am — F — C — G, with a bass drone, soft pad,
  // echoing pentatonic arpeggio, and sparse kick/hat.
  private chords = [
    [57, 60, 64], // A3 C4 E4
    [53, 57, 60], // F3 A3 C4
    [48, 52, 55], // C3 E3 G3
    [55, 59, 62], // G3 B3 D4
  ];
  private midi(n: number) { return 440 * Math.pow(2, (n - 69) / 12); }

  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    const spe = 60 / 84 / 2; // seconds per eighth note at 84 BPM
    this.nextT = this.ctx.currentTime + 0.15;
    this.musicTimer = setInterval(() => {
      if (!this.ctx || this.muted) return;
      while (this.nextT < this.ctx.currentTime + 0.7) {
        this.scheduleEighth(this.nextT, this.eighth++, spe);
        this.nextT += spe;
      }
    }, 250);
  }

  stopMusic() {
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
  }

  private musTone(type: OscillatorType, freq: number, t: number, atk: number, dur: number, peak: number, lpf: number, echo = false) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = lpf;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); f.connect(g); g.connect(this.musG);
    if (echo) g.connect(this.delay);
    o.start(t); o.stop(t + dur + 0.1);
  }

  private scheduleEighth(t: number, e: number, spe: number) {
    const bar = Math.floor(e / 8) % 4;
    const pos = e % 8;
    const ch = this.chords[bar];
    if (pos === 0) {
      // pad chord (two detuned voices per note) + bass
      for (const n of ch) {
        const f = this.midi(n);
        this.musTone('triangle', f, t, 1.1, spe * 8 * 0.95, 0.035, 900);
        this.musTone('triangle', f * 1.004, t, 1.3, spe * 8 * 0.95, 0.028, 700);
      }
      this.musTone('sawtooth', this.midi(ch[0] - 24), t, 0.25, spe * 8 * 0.9, 0.05, 240);
    }
    // sparse percussion
    if (pos % 4 === 0) this.musTone('sine', 95, t, 0.004, 0.12, 0.12, 400); // kick-ish
    if (pos % 2 === 1 && Math.random() < 0.7 && this.noiseBuf && this.ctx) {     // hat
      const s = this.ctx.createBufferSource();
      s.buffer = this.noiseBuf; s.loop = true;
      const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.015, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
      s.connect(f); f.connect(g); g.connect(this.musG);
      s.start(t); s.stop(t + 0.06);
    }
    // wandering arpeggio with echo
    if (Math.random() < 0.5) {
      const n = ch[(Math.random() * ch.length) | 0] + 12 * (Math.random() < 0.25 ? 2 : 1);
      this.musTone('triangle', this.midi(n), t, 0.01, spe * 0.9, 0.05, 2200, true);
    }
  }
}

export const audio = new AudioMan();
