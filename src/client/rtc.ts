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
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export class RtcMesh {
  private peers = new Map<number, PeerState>();
  onFrame: (player: number, frames: any[]) => void = () => {};
  onState: () => void = () => {}; // connectivity changed (drives the transport HUD)

  constructor(
    private signal: (msg: any) => void, // send a signaling message over the WS
    private localSlot: number,
    peerSlots: number[],
  ) {
    for (const slot of peerSlots) this.addPeer(slot);
  }

  private addPeer(slot: number) {
    let pc: RTCPeerConnection;
    try { pc = new RTCPeerConnection(RTC_CONFIG); }
    catch { return; } // WebRTC blocked/unavailable → this peer stays on the WS fallback
    const st: PeerState = { slot, pc, dc: null, open: false, remoteSet: false, pendingIce: [] };
    this.peers.set(slot, st);
    pc.onicecandidate = e => { if (e.candidate) this.signal({ t: 'rtc', to: slot, kind: 'ice', data: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        if (st.open) { st.open = false; this.onState(); }
      }
    };
    // deterministic initiator (avoids offer glare): the lower slot makes the offer
    if (this.localSlot < slot) {
      this.bindChannel(st, pc.createDataChannel('ls', { ordered: false, maxRetransmits: 0 }));
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
  connectedCount(): number { let n = 0; for (const st of this.peers.values()) if (st.open) n++; return n; }
  peerCount(): number { return this.peers.size; }
  close() {
    for (const st of this.peers.values()) { try { st.dc?.close(); } catch { /* */ } try { st.pc.close(); } catch { /* */ } }
    this.peers.clear();
  }
}
