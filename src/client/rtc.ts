// WebRTC transport for lockstep INPUT. WebSocket (TCP) is fine for the lobby and
// control messages, but for the per-tick input stream a single dropped packet on
// a lossy link stalls the whole TCP stream for seconds (head-of-line blocking) —
// which in lockstep freezes the sim until the gap is retransmitted. DataChannels
// in UNRELIABLE + UNORDERED mode behave like UDP: a lost frame is simply skipped,
// and the lockstep engine's redundant window (it resends the last N frames every
// message) recovers it on the very next packet with no retransmit round-trip.
//
// Signaling (SDP offer/answer + ICE) rides the existing WebSocket relay. If WebRTC
// is unavailable (hardened browser) or P2P can't be established (symmetric NAT,
// no TURN), the channel simply never opens and the caller falls back to the WS
// relay — so there is never a regression, only an upgrade when P2P is possible.

interface PeerState {
  slot: number;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  open: boolean;
  remoteSet: boolean;          // remote description applied yet?
  pendingIce: RTCIceCandidateInit[]; // ICE that arrived before the remote description
  audioSender: RTCRtpSender | null;  // voice chat: this peer's outbound mic track slot
}

// STUN finds the public address for a direct P2P path. TURN relays the media when a
// direct path is impossible (symmetric NAT / restrictive firewalls) — required for
// voice (and P2P input) to work between players on arbitrary networks worldwide. The
// real TURN (with short-lived credentials) is supplied by the server per match via
// the 'start' message; this static default is the STUN-only fallback.
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export class RtcMesh {
  private peers = new Map<number, PeerState>();
  private micTrack: MediaStreamTrack | null = null; // shared mic track once voice is on
  private micTargets: Set<number> | null = null;    // which peer slots receive it (null = all)
  onFrame: (player: number, frames: any[]) => void = () => {};
  onState: () => void = () => {}; // connectivity changed (drives the transport HUD)
  onAudio: (slot: number, stream: MediaStream) => void = () => {}; // remote voice arrived

  private rtcConfig: RTCConfiguration;
  constructor(
    private signal: (msg: any) => void, // send a signaling message over the WS
    private localSlot: number,
    peerSlots: number[],
    iceServers?: RTCIceServer[],        // server-supplied STUN/TURN (with TURN creds); falls back to STUN-only
  ) {
    this.rtcConfig = iceServers && iceServers.length ? { iceServers } : RTC_CONFIG;
    for (const slot of peerSlots) this.addPeer(slot);
  }

  private addPeer(slot: number) {
    let pc: RTCPeerConnection;
    try { pc = new RTCPeerConnection(this.rtcConfig); }
    catch { return; } // WebRTC blocked/unavailable → this peer stays on the WS fallback
    const st: PeerState = { slot, pc, dc: null, open: false, remoteSet: false, pendingIce: [], audioSender: null };
    this.peers.set(slot, st);
    pc.onicecandidate = e => { if (e.candidate) this.signal({ t: 'rtc', to: slot, kind: 'ice', data: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        if (st.open) { st.open = false; this.onState(); }
      }
    };
    // voice chat: a remote mic track arrived — hand its stream to the app to play
    pc.ontrack = e => { try { this.onAudio(slot, e.streams[0] || new MediaStream([e.track])); } catch { /* ignore */ } };
    // deterministic initiator (avoids offer glare): the lower slot makes the offer
    if (this.localSlot < slot) {
      this.bindChannel(st, pc.createDataChannel('ls', { ordered: false, maxRetransmits: 0 }));
      // negotiate a 2-way audio m-line UP FRONT (track filled later via replaceTrack,
      // which needs no renegotiation) so enabling voice mid-game just works
      try { st.audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender; if (this.micTrack) st.audioSender.replaceTrack(this.micFor(slot)); } catch { /* no audio support */ }
      pc.createOffer()
        .then(o => pc.setLocalDescription(o))
        .then(() => this.signal({ t: 'rtc', to: slot, kind: 'offer', data: pc.localDescription }))
        .catch(() => { /* fall back to WS */ });
    } else {
      pc.ondatachannel = e => this.bindChannel(st, e.channel);
    }
  }

  private bindChannel(st: PeerState, dc: RTCDataChannel) {
    st.dc = dc;
    dc.onopen = () => { st.open = true; this.onState(); };
    dc.onclose = () => { if (st.open) { st.open = false; this.onState(); } };
    dc.onmessage = ev => {
      // attribute frames to the AUTHENTICATED peer (st.slot, fixed when the channel
      // was negotiated via the server-relayed signaling) — NOT a client-claimed
      // m.player, which a malicious peer could set to spoof another player's inputs.
      try { const m = JSON.parse(ev.data); this.onFrame(st.slot, m.frames); } catch { /* ignore garbage */ }
    };
  }

  // an incoming signaling message relayed by the server (carries the sender's slot)
  async onSignal(msg: any) {
    const st = this.peers.get(msg.from);
    if (!st) return;
    const pc = st.pc;
    try {
      if (msg.kind === 'offer') {
        await pc.setRemoteDescription(msg.data);
        st.remoteSet = true;
        await this.flushIce(st);
        // voice: the offer's audio m-line created a transceiver — claim its sender so
        // we can send our mic back, and attach the mic if voice is already on
        if (!st.audioSender) {
          const tx = pc.getTransceivers().find(t => t.receiver?.track?.kind === 'audio');
          st.audioSender = tx ? tx.sender : null;
          if (st.audioSender && this.micTrack) { try { await st.audioSender.replaceTrack(this.micFor(st.slot)); } catch { /* */ } }
        }
        const a = await pc.createAnswer();
        await pc.setLocalDescription(a);
        this.signal({ t: 'rtc', to: msg.from, kind: 'answer', data: pc.localDescription });
      } else if (msg.kind === 'answer') {
        await pc.setRemoteDescription(msg.data);
        st.remoteSet = true;
        await this.flushIce(st);
      } else if (msg.kind === 'ice') {
        if (st.remoteSet) await pc.addIceCandidate(msg.data);
        else st.pendingIce.push(msg.data); // queue until the remote description lands
      }
    } catch { /* signaling hiccup → WS fallback keeps the game running */ }
  }

  private async flushIce(st: PeerState) {
    const q = st.pendingIce; st.pendingIce = [];
    for (const c of q) { try { await st.pc.addIceCandidate(c); } catch { /* skip */ } }
  }

  // true only when EVERY peer's channel is open — so the caller knows it can drop
  // the WS relay entirely (for a 2-player game that's just the one peer)
  allConnected(): boolean {
    if (!this.peers.size) return false;
    for (const st of this.peers.values()) if (!st.open) return false;
    return true;
  }
  // push one input message to every connected peer over its DataChannel
  send(frames: any[], player: number) {
    const payload = JSON.stringify({ player, frames });
    for (const st of this.peers.values()) if (st.open && st.dc) { try { st.dc.send(payload); } catch { /* drop */ } }
  }
  // voice chat: route a mic track to the chosen peers (targetSlots = null → everyone)
  // and null to the rest, so the player can talk to their team / one ally / everyone.
  // Uses replaceTrack on the pre-negotiated audio m-line — no renegotiation.
  setMicTrack(track: MediaStreamTrack | null, targetSlots?: Set<number> | null) {
    this.micTrack = track;
    this.micTargets = targetSlots || null;
    for (const st of this.peers.values()) { try { st.audioSender?.replaceTrack(this.micFor(st.slot)); } catch { /* peer not ready */ } }
  }
  private micFor(slot: number): MediaStreamTrack | null {
    if (!this.micTrack) return null;
    return (!this.micTargets || this.micTargets.has(slot)) ? this.micTrack : null;
  }
  hasVoice(): boolean { return !!this.micTrack; }
  connectedCount(): number { let n = 0; for (const st of this.peers.values()) if (st.open) n++; return n; }
  peerCount(): number { return this.peers.size; }
  peerSlotList(): number[] { return [...this.peers.keys()]; }
  close() {
    for (const st of this.peers.values()) { try { st.dc?.close(); } catch { /* */ } try { st.pc.close(); } catch { /* */ } }
    this.peers.clear();
  }
}

// Voice chat over an RtcMesh's audio m-lines: mic capture, mute toggle, and playing
// each peer's incoming stream. Works on ANY mesh — the lockstep input mesh OR a
// voice-only mesh — so both multiplayer modes (lockstep + snapshot) share this.
export class VoiceController {
  private micStream: MediaStream | null = null;
  private muted = true;
  private target: 'all' | 'team' | number = 'all'; // who hears me: everyone / my team / one player
  private audioEls = new Map<number, HTMLAudioElement>();
  constructor(private mesh: RtcMesh, private opts: { myTeam?: number; teamOf?: (slot: number) => number | undefined } = {}) {
    mesh.onAudio = (slot, stream) => {
      let el = this.audioEls.get(slot);
      if (!el) { el = new Audio(); el.autoplay = true; (el as any).playsInline = true; this.audioEls.set(slot, el); }
      el.srcObject = stream;
      el.play?.().catch(() => { /* autoplay gate; the Voice button is the user gesture */ });
    };
  }
  available(): boolean { return this.mesh.peerCount() > 0; }
  state(): 'off' | 'live' | 'muted' { return !this.micStream ? 'off' : this.muted ? 'muted' : 'live'; }
  getTarget(): 'all' | 'team' | number { return this.target; }
  setTarget(t: 'all' | 'team' | number) { this.target = t; if (this.micStream) this.route(); }
  // which peer slots should hear me (null = everyone)
  private targetSlots(): Set<number> | null {
    if (this.target === 'all') return null;
    if (typeof this.target === 'number') return new Set([this.target]);
    return new Set(this.mesh.peerSlotList().filter(s => this.opts.teamOf?.(s) === this.opts.myTeam)); // 'team'
  }
  private route() {
    const tr = this.micStream?.getAudioTracks()[0] || null;
    if (tr) tr.enabled = !this.muted;
    this.mesh.setMicTrack(this.muted ? null : tr, this.targetSlots());
  }
  // first call asks for the mic and goes live; later calls toggle mute
  async toggle(): Promise<'off' | 'live' | 'muted'> {
    if (!this.micStream) {
      try { this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
      catch { this.micStream = null; return 'off'; } // denied / no mic
      this.muted = false; this.route();
      return 'live';
    }
    this.muted = !this.muted; this.route();
    return this.muted ? 'muted' : 'live';
  }
  dispose() {
    this.micStream?.getTracks().forEach(t => t.stop()); this.micStream = null;
    for (const el of this.audioEls.values()) { try { el.srcObject = null; el.pause?.(); } catch { /* */ } }
    this.audioEls.clear();
  }
}
