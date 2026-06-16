// Self-hosted Twemoji icons. System color-emoji fonts are missing on some
// browsers/OSes (e.g. ungoogled-chromium on Linux) and Windows ships no flag
// emoji at all, so the build menu, unit icons and faction flags fell back to
// colorless tofu. We map the exact emoji the UI uses to bundled Twemoji SVGs
// (under /twemoji) and swap them in, so every icon renders identically anywhere.
// Twemoji is CC-BY 4.0 (graphics). To add a new icon: drop its SVG (named by
// codepoint, e.g. 1f680.svg) into public/twemoji/ and add an entry to MAP below.
const MAP: Record<string, string> = {
  "🇺🇸": "1f1fa-1f1f8",
  "🇪🇺": "1f1ea-1f1fa",
  "🇷🇺": "1f1f7-1f1fa",
  "🇮🇷": "1f1ee-1f1f7",
  "🇹🇷": "1f1f9-1f1f7",
  "🇵🇰": "1f1f5-1f1f0",
  "🇮🇳": "1f1ee-1f1f3",
  "🇸🇦": "1f1f8-1f1e6",
  "🌍": "1f30d",
  "🇨🇳": "1f1e8-1f1f3",
  "🇰🇷": "1f1f0-1f1f7",
  "🇹🇼": "1f1f9-1f1fc",
  "🇦🇺": "1f1e6-1f1fa",
  "🇧🇷": "1f1e7-1f1f7",
  "🇦🇷": "1f1e6-1f1f7",
  "🇨🇦": "1f1e8-1f1e6",
  "↔": "2194",
  "☄️": "2604",
  "☠": "2620",
  "☢️": "2622",
  "☣️": "2623",
  "⚓": "2693",
  "✈️": "2708",
  "⚡": "26a1",
  "⛏️": "26cf",
  "🎖️": "1f396",
  "🏭": "1f3ed",
  "🗼": "1f5fc",
  "📡": "1f4e1",
  "🎯": "1f3af",
  "🛫": "1f6eb",
  "🧪": "1f9ea",
  "🚇": "1f687",
  "📶": "1f4f6",
  "🧱": "1f9f1",
  "🚧": "1f6a7",
  "💥": "1f4a5",
  "🛡": "1f6e1",
  "🪖": "1fa96",
  "🚀": "1f680",
  "💃": "1f483",
  "🚙": "1f699",
  "🚛": "1f69b",
  "🛻": "1f6fb",
  "🚜": "1f69c",
  "🔧": "1f527",
  "🛢️": "1f6e2",
  "💣": "1f4a3",
  "🐝": "1f41d",
  "🛸": "1f6f8",
  "🛰": "1f6f0",
  "🧨": "1f9e8",
  "🥷": "1f977",
  "🚤": "1f6a4",
  "🛳️": "1f6f3",
  "🤿": "1f93f",
  "🛶": "1f6f6",
  "🐬": "1f42c",
  "🚢": "1f6a2",
  "🎇": "1f387",
  "⛴️": "26f4",
  "🛩️": "1f6e9",
  "🤖": "1f916",
  "🚁": "1f681",
  "🪁": "1fa81",
  "🏗️": "1f3d7",
  "🛠️": "1f6e0",
  "⬆": "2b06",
  "⚠": "26a0",
  "▶": "25b6",
  "⏸": "23f8",
  "🏳": "1f3f3",
  "🔕": "1f515",
  "🔔": "1f514",
  "🔇": "1f507",
  "🔊": "1f50a",
  "🎵": "1f3b5",
  "✋": "270b",
  "🚫": "1f6ab",
  "🔀": "1f500",
  "🎓": "1f393",
  "🌐": "1f310",
  "📝": "1f4dd",
};
// also match the variation-selector-free form of any FE0F emoji
for (const k of Object.keys(MAP)) {
  const bare = k.replace(/️/g, "");
  if (bare !== k && !(bare in MAP)) MAP[bare] = MAP[k];
}
const KEYS = Object.keys(MAP).sort((a, b) => b.length - a.length);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RE = () => new RegExp(KEYS.map(esc).join("|"), "g");
const img = (e: string) => {
  const f = MAP[e];
  return f ? `<img class="twemoji" src="twemoji/${f}.svg" alt="${e}" draggable="false">` : e;
};
// replace known emoji in a string with <img> tags (for innerHTML we build in JS)
export function twemojify(s: string): string {
  return s ? s.replace(RE(), m => img(m)) : s;
}
// walk an existing DOM subtree and swap emoji in its text nodes (for static HTML)
export function twemojiParse(root: HTMLElement | null): void {
  if (!root) return;
  const re = RE();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const todo: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const v = n.nodeValue || "";
    re.lastIndex = 0;
    if (re.test(v)) todo.push(n as Text);
  }
  for (const t of todo) {
    const span = document.createElement("span");
    span.innerHTML = twemojify(t.nodeValue || "");
    t.replaceWith(...Array.from(span.childNodes));
  }
}
