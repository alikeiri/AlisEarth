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
  // pre-recorded music tracks (mp3) that play instead of the synth, keyed by style
  private trackSrc: Record<string, string> = { iron: './audio/iron_directive.mp3' };
  private trackBuf: Record<string, AudioBuffer> = {};
  private trackNode: AudioBufferSourceNode | null = null;
  private trackLoading = '';
  muted = false;
  musicVol = 0.4;   // 0..1, music bus
  sfxVol = 1.0;     // 0..1, sound effects + unit voices
  // Only the Iron Directive mp3 plays for now — the synth tracks (battle,
  // hellmarch, march, ambient) and the cycling playlist are temporarily disabled
  // (see ENABLED). Default = the mp3 on loop.
  musicStyle = 'iron';
  // styles the player may actually select right now; anything else is coerced to
  // 'iron'. Re-add the synth styles / 'playlist' here to bring them back.
  static ENABLED = ['iron', 'off'];
  private static PLAYLIST = ['iron'];
  private plIdx = 0;                 // position within the playlist
  private plTimer: ReturnType<typeof setTimeout> | null = null; // advance timer for synth styles
  // the actual style sounding right now (resolves 'playlist' to its current song)
  private curStyle() { return this.musicStyle === 'playlist' ? AudioMan.PLAYLIST[this.plIdx % AudioMan.PLAYLIST.length] : this.musicStyle; }

  constructor() {
    try {
      this.muted = localStorage.getItem('fe_mute') === '1';
      const mv = localStorage.getItem('fe_musvol'); if (mv !== null) this.musicVol = +mv;
      const sv = localStorage.getItem('fe_sfxvol'); if (sv !== null) this.sfxVol = +sv;
      const ms = localStorage.getItem('fe_musstyle'); if (ms) this.musicStyle = ms;
    } catch { /* no storage */ }
    // a saved choice for a now-disabled track (e.g. an old 'playlist'/'hellmarch')
    // falls back to the mp3 so nobody is stuck on a silent or disabled style
    if (!AudioMan.ENABLED.includes(this.musicStyle)) this.musicStyle = 'iron';
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
    this.sfxG.gain.value = this.sfxVol;
    this.sfxG.connect(this.master);
    this.musG = this.ctx.createGain();
    this.musG.gain.value = this.musicVol;
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
    if (this.musicStyle !== 'off') this.startMusic();
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem('fe_mute', m ? '1' : '0'); } catch {}
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.6, this.ctx.currentTime, 0.05);
  }
  setMusicVol(v: number) {
    this.musicVol = Math.max(0, Math.min(1, v));
    try { localStorage.setItem('fe_musvol', String(this.musicVol)); } catch {}
    if (this.musG && this.ctx) this.musG.gain.setTargetAtTime(this.musicVol, this.ctx.currentTime, 0.05);
  }
  setSfxVol(v: number) {
    this.sfxVol = Math.max(0, Math.min(1, v));
    try { localStorage.setItem('fe_sfxvol', String(this.sfxVol)); } catch {}
    if (this.sfxG && this.ctx) this.sfxG.gain.setTargetAtTime(this.sfxVol, this.ctx.currentTime, 0.05);
  }
  setMusicStyle(s: string) {
    if (!AudioMan.ENABLED.includes(s)) s = 'iron'; // disabled styles fall back to the mp3
    this.musicStyle = s;
    if (s === 'playlist') this.plIdx = 0; // restart the playlist from Iron Directive
    try { localStorage.setItem('fe_musstyle', s); } catch {}
    this.stopMusic();
    if (s !== 'off') this.startMusic();
  }
  // playlist mode: advance to the next song, wrapping back to the start (repeat)
  private advancePlaylist() {
    if (this.musicStyle !== 'off' && this.ctx) {
      this.plIdx = (this.plIdx + 1) % AudioMan.PLAYLIST.length;
      this.stopMusic();
      this.startMusic();
    }
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
    const gap: Record<string, number> = { mg: 45, cn: 80, rkt: 90, zap: 60, salvo: 200, flakgun: 55, hcannon: 110, boomS: 70, boomB: 140, cash: 120, crush: 90 };
    if (gap[name] && now - (this.last[name] || 0) < gap[name]) return;
    this.last[name] = now;
    const v = Math.min(1, vol);
    switch (name) {
      case 'mg':
        // rifle/autocannon: a snappy supersonic crack + body thwack + casing tick
        this.burst(0.014, 'highpass', 3200, 3200, 0.32 * v);            // crack
        this.burst(0.05, 'bandpass', 1500, 720, 0.24 * v, 0.002, 1.6);  // body
        this.tone('sine', 150, 60, 0.05, 0.18 * v, 0.001);              // low thump
        break;
      case 'cn':
        // tank cannon: sharp crack + deep muzzle thump + rolling body
        this.burst(0.04, 'highpass', 1800, 1800, 0.34 * v);
        this.tone('sine', 120, 32, 0.32, 0.66 * v);
        this.burst(0.26, 'lowpass', 700, 130, 0.4 * v);
        break;
      case 'hcannon':
        // heavy/naval gun: bigger, slower boom with a long tail
        this.burst(0.05, 'highpass', 1400, 1400, 0.34 * v);
        this.tone('sine', 95, 24, 0.55, 0.78 * v);
        this.burst(0.5, 'lowpass', 520, 80, 0.5 * v);
        this.tone('sine', 60, 30, 0.5, 0.3 * v, 0.04);
        break;
      case 'rkt':
        // rocket: ignition hiss + whoosh sweeping down + low rumble
        this.burst(0.06, 'highpass', 4000, 2200, 0.2 * v);
        this.burst(0.34, 'bandpass', 900, 170, 0.32 * v, 0.02, 1.2);
        this.tone('sine', 130, 55, 0.3, 0.22 * v, 0.02);
        break;
      case 'flakgun':
        // flak pom-pom: metallic double-thud with a ringing overtone
        this.tone('square', 220, 90, 0.07, 0.22 * v);
        this.burst(0.08, 'bandpass', 1100, 520, 0.24 * v, 0, 3);
        this.tone('triangle', 1700, 1500, 0.05, 0.08 * v, 0.01);
        break;
      case 'zap':
        this.tone('square', 950, 480, 0.07, 0.1 * v);
        this.tone('sine', 1500, 700, 0.05, 0.06 * v, 0.012);
        break;
      case 'salvo':
        for (let i = 0; i < 4; i++) this.burst(0.28, 'bandpass', 1000, 180, 0.2 * v, i * 0.08, 1.3);
        this.tone('sine', 80, 38, 0.35, 0.28 * v, 0.05);
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
      case 'notify': // new lobby message while the tab is backgrounded: gentle rising chime
        this.tone('triangle', 880, 880, 0.12, 0.18 * v);
        this.tone('triangle', 1175, 1175, 0.17, 0.16 * v, 0.10);
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
      case 'sdbeep': // self-destruct countdown tick
        this.tone('square', 1500, 1500, 0.06, 0.14 * v);
        break;
      case 'pwrlow': // power running low: soft falling two-tone warning
        this.tone('sine', 440, 392, 0.16, 0.16 * v);
        this.tone('sine', 392, 330, 0.2, 0.14 * v, 0.16);
        break;
      case 'pwrout': // power INSUFFICIENT: urgent low buzz
        this.tone('sawtooth', 220, 160, 0.3, 0.16 * v);
        this.tone('sawtooth', 160, 120, 0.34, 0.14 * v, 0.18);
        break;
      case 'underattack': // a unit of ours is taking fire: quick urgent triple beep
        for (let i = 0; i < 3; i++) this.tone('square', 880, 880, 0.05, 0.1 * v, i * 0.09);
        break;
      case 'bldgattack': // a building of ours is under attack: lower urgent double tone
        this.tone('square', 523, 523, 0.09, 0.13 * v);
        this.tone('square', 415, 415, 0.12, 0.12 * v, 0.1);
        break;
      case 'siloup': // a missile silo came online (anywhere): ominous rising swell
        this.tone('sawtooth', 110, 220, 0.5, 0.14 * v);
        this.tone('sine', 55, 110, 0.55, 0.12 * v, 0.02);
        break;
      case 'satup': // a spy satellite went up (anywhere): cool tech chime
        this.tone('triangle', 784, 784, 0.1, 0.13 * v);
        this.tone('triangle', 1047, 1047, 0.12, 0.12 * v, 0.09);
        this.tone('triangle', 1319, 1319, 0.16, 0.1 * v, 0.18);
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
    if (ev.e === 'shot') this.play(
      ev.w === 0 ? 'mg' : ev.w === 1 ? 'rkt' : ev.w === 3 ? 'zap' : ev.w === 4 ? 'salvo'
        : ev.w === 5 ? 'flakgun' : ev.w === 6 ? 'hcannon' : 'cn', vol);
    else if (ev.e === 'boom') this.play(ev.big ? 'boomB' : 'boomS', Math.max(0.25, vol));
    else if (ev.e === 'crush') this.play('crush', vol);
    else if (ev.e === 'done') this.play('done', 0.8);
    else if (ev.e === 'cash') this.play('cash', Math.min(0.5, vol));
  }

  // ---------- unit voice acknowledgments ----------
  private lastAck = 0;
  private static VOICE: Record<string, { move: string[]; attack: string[]; pitch: number; rate: number }> = {
    inf:  { move: ['Moving out!', 'On my way.', 'Yes sir!'], attack: ['Engaging!', 'Open fire!', 'Attacking!'], pitch: 1.15, rate: 1.15 },
    // Melody: elite operative, Aussie flavour (spoken in an en-AU voice)
    melody: { move: ['On me way, mate!', 'Too easy!', 'Righto, movin’!', 'No worries!'],
              attack: ['Let’s give ’em hell!', 'Have a go at this!', 'Lock and load, mate!', 'She’ll be right — fire!'],
              pitch: 1.25, rate: 1.05 },
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
    const grp = unitType === 'melody' ? 'melody'
      : unitType === 'rifle' || unitType === 'rocket' ? 'inf'
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
      // Melody speaks with an Australian accent: pin the locale and pick an
      // en-AU (preferably female) system voice when one is available
      if (grp === 'melody') {
        u.lang = 'en-AU';
        const av = this.ausVoice();
        if (av) u.voice = av;
      }
      window.speechSynthesis.speak(u);
    } catch { this.play('confirm'); }
  }

  // resolve (and cache) the best Australian voice the browser offers — voices
  // load asynchronously, so leave it unresolved until the list is populated
  private _ausVoice?: SpeechSynthesisVoice | null;
  private ausVoice(): SpeechSynthesisVoice | null {
    if (this._ausVoice !== undefined) return this._ausVoice;
    try {
      const vs = window.speechSynthesis.getVoices();
      if (!vs.length) return null; // not loaded yet — retry on the next ack
      const au = vs.filter(v => /en[-_]AU/i.test(v.lang) || /australia/i.test(v.name));
      const fem = au.find(v => /female|woman|karen|catherine|nicole|olivia|aria|zira/i.test(v.name));
      this._ausVoice = fem || au[0] || null;
      return this._ausVoice;
    } catch { return null; }
  }

  // ---------- generative music ----------
  // a pool of minor-key 4-bar progressions; the SONG sequences them into a
  // longer non-repeating structure so the track actually develops over time
  private PROGS = [
    [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], // Am F C G
    [[57, 60, 64], [55, 59, 62], [53, 57, 60], [55, 59, 62]], // Am G F G
    [[48, 52, 55], [55, 59, 62], [57, 60, 64], [53, 57, 60]], // C G Am F
    [[50, 53, 57], [48, 52, 55], [55, 59, 62], [57, 60, 64]], // Dm C G Am
    [[53, 57, 60], [55, 59, 62], [57, 60, 64], [52, 56, 59]], // F G Am E
  ];
  // phrase order (each entry = one 4-bar progression) and its section feel
  private SONG = [0, 0, 1, 2, 0, 3, 4, 2, 1, 3];
  private SECT = ['v', 'v', 'c', 'c', 'v', 'b', 'c', 'c', 'v', 'c'];
  // a few lead riffs (minor-pentatonic offsets) rotated per bar for variety
  private RIFFS = [
    [0, 7, 5, 7, 3, 5, 7, 12],
    [12, 10, 7, 5, 7, 5, 3, 0],
    [0, 3, 5, 7, 5, 3, 0, -2],
    [7, 7, 5, 3, 0, 3, 5, 7],
    [12, 12, 10, 7, 5, 7, 10, 12],
  ];
  private chords = this.PROGS[0]; // fallback used by the march/ambient styles
  private midi(n: number) { return 440 * Math.pow(2, (n - 69) / 12); }

  startMusic() {
    if (!this.ctx || this.musicStyle === 'off') return;
    const style = this.curStyle();
    // pre-recorded tracks (e.g. Iron Directive) play an mp3 instead of synth
    if (this.trackSrc[style]) { this.startTrack(style); return; }
    if (this.musicTimer) return;
    const bpm = style === 'ambient' ? 60 : style === 'march' ? 104
      : style === 'hellmarch' ? 142 : 124;
    const spe = 60 / bpm / 2; // seconds per eighth note
    this.nextT = this.ctx.currentTime + 0.15;
    this.musicTimer = setInterval(() => {
      if (!this.ctx || this.muted || this.musicStyle === 'off') return;
      while (this.nextT < this.ctx.currentTime + 0.7) {
        this.scheduleEighth(this.nextT, this.eighth++, spe);
        this.nextT += spe;
      }
    }, 250);
    // generative styles never "end"; in playlist mode move on after ~2.75 min
    if (this.musicStyle === 'playlist') this.plTimer = setTimeout(() => this.advancePlaylist(), 165000);
  }

  stopMusic() {
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
    if (this.plTimer) { clearTimeout(this.plTimer); this.plTimer = null; }
    this.stopTrack();
  }

  // looped playback of a pre-recorded track through the music bus (respects the
  // music-volume slider and global mute). The decoded buffer is cached so
  // switching back to it is instant.
  private async startTrack(style: string) {
    if (!this.ctx) return;
    const url = this.trackSrc[style];
    if (!url) return;
    if (!this.trackBuf[style]) {
      if (this.trackLoading === style) return; // already fetching
      this.trackLoading = style;
      try {
        const res = await fetch(url);
        const arr = await res.arrayBuffer();
        this.trackBuf[style] = await this.ctx.decodeAudioData(arr);
      } catch { this.trackLoading = ''; return; }
      this.trackLoading = '';
      if (this.curStyle() !== style) return; // switched away (or playlist advanced) while it loaded
    }
    this.playTrack(style);
  }
  private playTrack(style: string) {
    if (!this.ctx || !this.trackBuf[style]) return;
    this.stopTrack();
    const src = this.ctx.createBufferSource();
    src.buffer = this.trackBuf[style];
    // single-song mode loops the track; in the playlist it plays once then the
    // next song follows (then the list repeats)
    src.loop = this.musicStyle !== 'playlist';
    if (this.musicStyle === 'playlist') src.onended = () => this.advancePlaylist();
    src.connect(this.musG);
    src.start();
    this.trackNode = src;
  }
  private stopTrack() {
    if (this.trackNode) { this.trackNode.onended = null; try { this.trackNode.stop(); } catch { /* already stopped */ } this.trackNode.disconnect(); this.trackNode = null; }
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

  // distorted electric-guitar voice: TWO detuned sawtooths driven hard into a
  // hard-clip waveshaper (heavy overdrive) → bright tone → SUSTAINED envelope.
  // The detune + heavy clip + held sustain read as a buzzy guitar, not a piano.
  private guitarCurve: Float32Array | null = null;
  private guitar(freq: number, t: number, dur: number, peak: number, palm = false, echo = false, hot = false) {
    if (!this.ctx) return;
    if (!this.guitarCurve) {
      const n = 1024, c = new Float32Array(n), amt = 22;       // hard clip = lots of grit
      for (let i = 0; i < n; i++) { const x = (i / n) * 2 - 1; c[i] = Math.tanh(amt * x); }
      this.guitarCurve = c;
    }
    for (const det of [0.996, 1.004]) {                         // thick double-tracked tone
      const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq * det;
      const pre = this.ctx.createGain(); pre.gain.value = hot ? 3.0 : 1.6;  // extra saturation when hot
      const sh = this.ctx.createWaveShaper(); sh.curve = this.guitarCurve; sh.oversample = '4x';
      const tone = this.ctx.createBiquadFilter(); tone.type = 'lowpass';
      tone.frequency.value = palm ? (hot ? 2600 : 2000) : (hot ? 5200 : 4200); tone.Q.value = 1.2;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak * 0.5, t + 0.003);    // fast pick attack
      g.gain.setValueAtTime(peak * 0.45, t + dur * 0.7);             // HOLD (ringing sustain)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);          // release
      o.connect(pre); pre.connect(sh); sh.connect(tone); tone.connect(g); g.connect(this.musG);
      if (echo) g.connect(this.delay);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }

  private scheduleEighth(t: number, e: number, spe: number) {
    const pos = e % 8;
    const barAbs = Math.floor(e / 8);
    const bar = barAbs % 4;
    const style = this.curStyle();
    // walk the song: each phrase is 4 bars; the chord + feel come from it
    const phrase = Math.floor(barAbs / 4);
    const si = phrase % this.SONG.length;
    const ch = this.PROGS[this.SONG[si]][bar]; // all styles walk the song for variety
    const sect = this.SECT[si];           // 'v' verse, 'c' chorus, 'b' breakdown
    const lastBar = bar === 3;            // last bar of the phrase → fill

    // ===== BATTLE: a developing electric-guitar rock track =====
    if (style === 'battle') {
      const root = this.midi(ch[0]);
      const fifth = this.midi(ch[0] + 7);
      const noise = this.noiseBuf && this.ctx;
      if (pos === 0) {
        // ringing power chord (root + fifth + octave) held most of the bar
        this.guitar(root, t, spe * 8 * 0.92, 0.11);
        this.guitar(fifth, t, spe * 8 * 0.92, 0.085);
        this.guitar(root * 2, t, spe * 8 * 0.92, 0.06);
        this.guitar(this.midi(ch[0] - 12), t, spe * 8 * 0.9, 0.12, true); // bass
        // crash cymbal at the top of each phrase to mark the section change
        if (bar === 0 && noise) {
          const s = this.ctx!.createBufferSource(); s.buffer = this.noiseBuf!; s.loop = true;
          const f = this.ctx!.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000;
          const g = this.ctx!.createGain(); g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
          s.connect(f); f.connect(g); g.connect(this.musG); s.start(t); s.stop(t + 0.55);
        }
      } else if (pos % 2 === 0) {
        // palm-muted offbeat chugs to keep the momentum
        this.guitar(root, t, spe * 0.8, 0.09, true);
        this.guitar(fifth, t, spe * 0.8, 0.07, true);
      }
      // lead riff: rotate the pattern per bar; verse plays it sparse, chorus
      // doubles it up an octave, breakdown drops the lead for chugging tension
      if (sect !== 'b') {
        const riff = this.RIFFS[(phrase + bar) % this.RIFFS.length];
        const oct = sect === 'c' ? 24 : 12;
        const play = sect === 'c' ? true : pos % 2 === 0; // chorus dense, verse sparse
        if (play && riff[pos] !== undefined) {
          this.guitar(this.midi(ch[0] + oct + riff[pos]), t, spe * 1.4, sect === 'c' ? 0.06 : 0.05, false, true);
        }
      }
      // drums: four-on-the-floor kick, snare backbeat, hats; a tom fill closes
      // the phrase so the loop point doesn't feel mechanical
      if (pos % 2 === 0) this.musTone('sine', 100, t, 0.003, 0.13, 0.2, 380); // kick
      if (pos === 4 && noise) {                                               // snare on 3
        const s = this.ctx!.createBufferSource(); s.buffer = this.noiseBuf!; s.loop = true;
        const f = this.ctx!.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.7;
        const g = this.ctx!.createGain(); g.gain.setValueAtTime(0.07, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        s.connect(f); f.connect(g); g.connect(this.musG); s.start(t); s.stop(t + 0.16);
      }
      if (lastBar && pos >= 4) {                                              // tom fill
        this.musTone('sine', 220 - (pos - 4) * 26, t, 0.004, 0.14, 0.16, 600);
      }
      if (pos % 2 === 1 && !(lastBar && pos >= 5) && noise) {                 // hats
        const s = this.ctx!.createBufferSource(); s.buffer = this.noiseBuf!; s.loop = true;
        const f = this.ctx!.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 8000;
        const g = this.ctx!.createGain(); g.gain.setValueAtTime(0.02, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
        s.connect(f); f.connect(g); g.connect(this.musG); s.start(t); s.stop(t + 0.06);
      }
      return;
    }

    // ===== HELL MARCH: a brutal E-minor industrial war-march =====
    // (an original homage to the C&C Red Alert vibe, not a copy): a relentless
    // 16th-note palm-muted gallop with a sub-octave, savage power-chord stabs, a
    // screaming octave-doubled lead, double-kick and a hammering snare cadence.
    if (style === 'hellmarch') {
      const noise = this.noiseBuf && this.ctx;
      const planRoot = [52, 52, 48, 50][bar];        // Em Em C D
      const bassRoot = planRoot - 12, sub = bassRoot - 12;
      const half = spe / 2;                           // the 16th in between
      // the engine: a chugging 16th-note gallop, hot-overdriven, with a sub-bass
      this.guitar(this.midi(bassRoot), t, half * 0.92, 0.16, true, false, true);
      this.guitar(this.midi(bassRoot), t + half, half * 0.92, 0.13, true, false, true);
      if (pos % 2 === 0) this.guitar(this.midi(sub), t, spe * 0.9, 0.1, true);  // sub weight on the beat
      // savage power-chord stabs (root+fifth+octave) on beats 1 and 3
      if (pos % 4 === 0) {
        this.guitar(this.midi(planRoot), t, spe * 3.6, 0.12, false, false, true);
        this.guitar(this.midi(planRoot + 7), t, spe * 3.6, 0.09, false, false, true);
        this.guitar(this.midi(planRoot + 12), t, spe * 3.6, 0.06, false, false, true);
      }
      // the hook: a 2-bar descending minor lead, doubled an octave up, screaming
      const MOTIF = [0, -2, -3, -2, -3, -5, -3, -2, 0, 3, 5, 3, 2, 0, -2, 0];
      const mi = (barAbs % 2) * 8 + pos;
      if (sect !== 'b' && MOTIF[mi] !== undefined) {
        const ln = this.midi(planRoot + 12 + MOTIF[mi]);
        this.guitar(ln, t, spe * 1.2, 0.08, false, true, true);
        this.guitar(ln * 2, t, spe * 1.2, 0.05, false, true, true);   // octave-up scream
      }
      // drums: DOUBLE kick (every eighth), hammering backbeat snare + ghost 16ths
      this.musTone('sine', 88, t, 0.002, 0.12, 0.26, 380);
      const snareHit = (peak: number, dur: number, at = t) => {
        if (!noise) return;
        const s = this.ctx!.createBufferSource(); s.buffer = this.noiseBuf!; s.loop = true;
        const f = this.ctx!.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2100; f.Q.value = 0.8;
        const g = this.ctx!.createGain(); g.gain.setValueAtTime(peak, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        s.connect(f); f.connect(g); g.connect(this.musG); s.start(at); s.stop(at + dur + 0.02);
      };
      if (pos === 4) { snareHit(0.11, 0.16); snareHit(0.05, 0.06, t + half); } // cracking backbeat + flam
      else if (pos % 2 === 1) snareHit(0.03, 0.05);                            // driving ghost rolls
      if (bar === 0 && pos === 0 && noise) {                                   // crash at phrase top
        const s = this.ctx!.createBufferSource(); s.buffer = this.noiseBuf!; s.loop = true;
        const f = this.ctx!.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 5000;
        const g = this.ctx!.createGain(); g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
        s.connect(f); f.connect(g); g.connect(this.musG); s.start(t); s.stop(t + 0.75);
      }
      return;
    }

    if (pos === 0) {
      // pad chord (two detuned voices per note) + bass
      for (const n of ch) {
        const f = this.midi(n);
        this.musTone('triangle', f, t, 1.1, spe * 8 * 0.95, 0.035, 900);
        this.musTone('triangle', f * 1.004, t, 1.3, spe * 8 * 0.95, 0.028, 700);
      }
      this.musTone(style === 'march' ? 'square' : 'sawtooth', this.midi(ch[0] - 24), t, 0.2, spe * 8 * 0.9, 0.05, 240);
    }
    if (style === 'ambient') {
      // ambient: no drums, just a slow echoing arpeggio and occasional shimmer
      if (Math.random() < 0.35) {
        const n = ch[(Math.random() * ch.length) | 0] + 12 * (Math.random() < 0.4 ? 1 : 2);
        this.musTone('sine', this.midi(n), t, 0.05, spe * 4, 0.045, 1800, true);
      }
      return;
    }
    // percussion — march drives a steadier, harder beat
    if (pos % 4 === 0) this.musTone('sine', style === 'march' ? 110 : 95, t, 0.004, 0.12, style === 'march' ? 0.18 : 0.12, 400); // kick
    if (style === 'march' && pos % 4 === 2) this.musTone('sine', 90, t, 0.004, 0.12, 0.14, 350); // backbeat kick
    const hatRate = style === 'march' ? 0.95 : 0.7;
    if (pos % 2 === 1 && Math.random() < hatRate && this.noiseBuf && this.ctx) {     // hat
      const s = this.ctx.createBufferSource();
      s.buffer = this.noiseBuf; s.loop = true;
      const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(style === 'march' ? 0.022 : 0.015, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
      s.connect(f); f.connect(g); g.connect(this.musG);
      s.start(t); s.stop(t + 0.06);
    }
    // snare on the march backbeat
    if (style === 'march' && pos === 4 && this.noiseBuf && this.ctx) {
      const s = this.ctx.createBufferSource();
      s.buffer = this.noiseBuf; s.loop = true;
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.8;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.05, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      s.connect(f); f.connect(g); g.connect(this.musG);
      s.start(t); s.stop(t + 0.14);
    }
    // wandering arpeggio with echo
    if (Math.random() < (style === 'march' ? 0.6 : 0.5)) {
      const n = ch[(Math.random() * ch.length) | 0] + 12 * (Math.random() < 0.25 ? 2 : 1);
      this.musTone('triangle', this.midi(n), t, 0.01, spe * 0.9, 0.05, 2200, true);
    }
  }
}

export const audio = new AudioMan();
