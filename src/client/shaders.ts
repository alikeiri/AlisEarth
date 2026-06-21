// GLSL shader sources for the renderer, kept out of render.ts so the shader code
// lives in one place. Plain strings injected into THREE.ShaderMaterial (water, sky)
// or spliced into a MeshLambert material via onBeforeCompile (terrain splatting).

// ---- Water: a live surface. Layered moving directional waves drive an analytic
// normal that feeds a fresnel sky-reflection blend (deep teal looking straight
// down, lighter/sky toward grazing angles), animated sun glints, and whitecap
// foam on steep crests. No geometry is displaced — it's all in the fragment. ----
export const WATER_VERT = `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const WATER_FRAG = `
  precision highp float;
  varying vec3 vWorld;
  uniform float uTime, uOpacity;
  uniform vec3 uDeep, uShallow, uSky, uSunDir, uSunCol, uFoam;
  void main() {
    vec2 p = vWorld.xz;
    // slow domain warp so the wave field churns instead of sliding rigidly
    p += 0.5 * vec2(sin(p.y * 0.18 + uTime * 0.35), cos(p.x * 0.16 + uTime * 0.28));
    // sum layered moving waves; accumulate height (for foam) AND the analytic
    // gradient (for the surface normal) — no geometry is displaced
    float h = 0.0; vec2 g = vec2(0.0);
    #define WAVE(dx,dy,fr,sp,am) { vec2 d = vec2(dx,dy); float ph = dot(p,d)*fr + uTime*sp; h += (am)*sin(ph); g += (am)*cos(ph)*(fr)*d; }
    WAVE( 0.85,  0.52, 0.45, 1.10, 0.55)
    WAVE(-0.45,  0.89, 0.90, 0.85, 0.32)
    WAVE( 0.30, -0.95, 1.70, 1.50, 0.18)
    WAVE(-0.92, -0.38, 2.90, 2.10, 0.10)
    WAVE( 0.70, -0.71, 5.30, 2.80, 0.05)
    WAVE(-0.20,  0.98, 8.40, 3.40, 0.028)
    vec3 N = normalize(vec3(-g.x * 0.6, 1.0, -g.y * 0.6));
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 L = normalize(uSunDir);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 3.0);
    vec3 water = mix(uDeep, uShallow, ndv);                 // deeper looking straight down
    water += uShallow * 0.12 * smoothstep(0.2, 0.9, h * 0.5 + 0.5); // subsurface shimmer
    vec3 col = mix(water, uSky, fres * 0.65);               // sky reflection at grazing angles
    // sun glints — a broad sheen plus a tight sparkle
    float nh = max(dot(N, normalize(L + V)), 0.0);
    col += uSunCol * (pow(nh, 90.0) * 0.7 + pow(nh, 800.0) * 1.2);
    // whitecap foam on the steep wave crests
    float crest = smoothstep(0.62, 0.95, h * 0.6 + 0.5);
    float foam = clamp(crest * (0.8 + smoothstep(0.10, 0.45, length(g))), 0.0, 1.0);
    col = mix(col, uFoam, foam * 0.6);
    gl_FragColor = vec4(col, mix(uOpacity, 1.0, fres));
  }
`;

// ---- Terrain splatting: spliced into a MeshLambert material via onBeforeCompile.
// SPLAT_UNIFORMS is prepended to the fragment shader; SPLAT_MAP_FRAGMENT replaces
// the built-in `#include <map_fragment>` so the base colour becomes a 4-layer
// tiled blend (grass/rock/sand/dirt) weighted per-cell by the weight map. ----
export const SPLAT_UNIFORMS = 'uniform sampler2D tGrass, tRock, tSand, tDirt, wMap; uniform float tileRep;\n';

export const SPLAT_MAP_FRAGMENT = `
  vec4 wv = texture2D( wMap, vMapUv );
  float ws = wv.r + wv.g + wv.b + wv.a; if (ws < 1e-3) ws = 1.0;
  vec2 tuv = vMapUv * tileRep;
  vec3 splat = ( texture2D(tGrass, tuv).rgb * wv.r
               + texture2D(tRock, tuv * 0.6).rgb * wv.g
               + texture2D(tSand, tuv).rgb * wv.b
               + texture2D(tDirt, tuv * 0.85).rgb * wv.a ) / ws;
  diffuseColor.rgb *= splat;
`;

// ---- Sky dome: vertical gradient (horizon -> mid -> zenith). ----
export const SKY_VERT = 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

export const SKY_FRAG = `varying vec3 vP; uniform vec3 top, mid, bot;
  void main(){
    float t = normalize(vP).y;
    vec3 c = t > 0.22 ? mix(mid, top, smoothstep(0.22, 0.85, t)) : mix(bot, mid, smoothstep(-0.04, 0.22, t));
    gl_FragColor = vec4(c, 1.0);
  }`;
