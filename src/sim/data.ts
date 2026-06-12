// Static game data: units, buildings, factions. Pure data, no imports.

export const TICK = 0.1;            // seconds per sim tick (10 Hz)
export const TICKS_PER_SEC = 10;
export const ORE_VALUE = 0.8;      // credits per ore unit (economy pacing)
export const START_CREDITS = 3000;
export const ORE_REGEN = 2;       // ore regrown per field cell per second...
export const ORE_REGEN_CAP = 0.35; // ...up to this fraction of the original amount
// (tester: one small patch must NOT sustain a war economy forever)

export interface UnitDef {
  name: string; cost: number; hp: number; speed: number;
  range: number; dmg: number; rof: number;       // rof = seconds between shots
  builtAt: string; buildTime: number; kind: 'inf' | 'veh' | 'air' | 'sea';
  cargo?: number;
  fly?: boolean;                                 // flies: ignores terrain, moves straight
  move?: 'sea';                                  // ships: navigate water only
  alt?: number;                                  // flight altitude (render)
  pad?: boolean;                                 // aircraft: needs airfield capacity
  repair?: boolean;                              // engineer: heals units, repairs buildings
  payload?: number;                              // bombers: shots per sortie before returning to rearm
  road?: boolean;                                // engineer: can lay roads
  fortify?: boolean;                             // drone hive: can dig in and emit drones
  emits?: string;                                // fortified emitter: unit type it spawns
  ephemeral?: number;                            // self-destructs after N seconds (mini drones)
  tech?: string;                                 // requires this researched technology
  cloak?: boolean;                               // stealth: low detection range to the enemy
  internal?: boolean;                            // not buildable from a sidebar
  kamikaze?: boolean;                            // one-way: explodes on contact (dmg = blast)
}

export const UNITS: Record<string, UnitDef> = {
  rifle:  { name: 'Rifle Squad',  cost: 100,  hp: 90,  speed: 2.0, range: 4.0, dmg: 7,  rof: 0.8, builtAt: 'barracks', buildTime: 5,  kind: 'inf' },
  rocket: { name: 'Rocket Team',  cost: 300,  hp: 80,  speed: 1.8, range: 5.5, dmg: 24, rof: 2.2, builtAt: 'barracks', buildTime: 8,  kind: 'inf' },
  tank:   { name: 'Battle Tank',  cost: 800,  hp: 340, speed: 2.6, range: 5.5, dmg: 34, rof: 1.6, builtAt: 'factory',  buildTime: 12, kind: 'veh' },
  heavy:  { name: 'Heavy Tank',   cost: 1250, hp: 640, speed: 2.0, range: 6.0, dmg: 58, rof: 2.2, builtAt: 'factory',  buildTime: 17, kind: 'veh' },
  harv:   { name: 'Harvester',    cost: 900,  hp: 450, speed: 1.6, range: 0,   dmg: 0,  rof: 1,   builtAt: 'factory',  buildTime: 14, kind: 'veh', cargo: 400 },
  recon:  { name: 'Recon Drone',  cost: 400,  hp: 70,  speed: 3.4, range: 4.0, dmg: 6,  rof: 0.6, builtAt: 'dronefac', buildTime: 7,  kind: 'air', fly: true },
  strike: { name: 'Strike Drone', cost: 1100, hp: 150, speed: 2.8, range: 5.0, dmg: 32, rof: 1.8, builtAt: 'dronefac', buildTime: 13, kind: 'air', fly: true },
  msldrone: { name: 'Missile Drone', cost: 1500, hp: 120, speed: 2.4, range: 7.0, dmg: 45, rof: 3.0, builtAt: 'dronefac', buildTime: 15, kind: 'air', fly: true },
  mlrs:   { name: 'MLRS',         cost: 1600, hp: 220, speed: 1.6, range: 13.0, dmg: 74, rof: 3.6, builtAt: 'factory',  buildTime: 16, kind: 'veh' },
  // the anti-infantry vehicle: autocannon IFV — shreds infantry, loses to tanks
  ifv:    { name: 'IFV',          cost: 700,  hp: 300, speed: 3.4, range: 5.0, dmg: 24, rof: 0.8, builtAt: 'factory',  buildTime: 9,  kind: 'veh' },
  // mobile anti-air pair: missile AA hunts airplanes, flak shreds drone swarms
  aatank: { name: 'AA Vehicle',   cost: 950,  hp: 280, speed: 3.0, range: 8.0, dmg: 42, rof: 1.6, builtAt: 'factory',  buildTime: 11, kind: 'veh' },
  flak:   { name: 'Flak Gun',     cost: 650,  hp: 240, speed: 2.6, range: 6.5, dmg: 16, rof: 0.45, builtAt: 'factory', buildTime: 9,  kind: 'veh' },
  engineer: { name: 'Engineer',   cost: 600,  hp: 200, speed: 2.2, range: 0,   dmg: 0,  rof: 1,   builtAt: 'factory',  buildTime: 10, kind: 'veh', repair: true, road: true },
  hive:    { name: 'Drone Hive',  cost: 1500, hp: 900, speed: 1.1, range: 0,   dmg: 0,  rof: 1,   builtAt: 'barracks', buildTime: 16, kind: 'inf', fortify: true, emits: 'minidrone' },
  minidrone: { name: 'Mini Drone', cost: 0,   hp: 40,  speed: 4.2, range: 4.0, dmg: 200, rof: 1, builtAt: '',         buildTime: 0,  kind: 'air', fly: true, alt: 1.6, ephemeral: 26, internal: true, kamikaze: true },
  // naval (Ship Factory, water only)
  gunboat:   { name: 'Gunboat',     cost: 700,  hp: 300, speed: 2.8, range: 5.5, dmg: 22, rof: 1.2, builtAt: 'shipyard', buildTime: 10, kind: 'sea', move: 'sea' },
  destroyer: { name: 'Destroyer',   cost: 1500, hp: 550, speed: 2.2, range: 7.0, dmg: 45, rof: 2.2, builtAt: 'shipyard', buildTime: 16, kind: 'sea', move: 'sea' },
  sub:       { name: 'Submarine',   cost: 1400, hp: 320, speed: 2.0, range: 6.0, dmg: 70, rof: 3.0, builtAt: 'shipyard', buildTime: 15, kind: 'sea', move: 'sea' },
  navdrone:  { name: 'Naval Drone', cost: 500,  hp: 90,  speed: 3.6, range: 4.0, dmg: 18, rof: 1.0, builtAt: 'shipyard', buildTime: 7,  kind: 'sea', move: 'sea' },
  // aircraft (Aircraft Plant; require Airfield capacity)
  // ---- tech-gated units (require a Research Lab + the named research) ----
  chemtrooper: { name: 'Chem Trooper', cost: 500,  hp: 110, speed: 1.9, range: 4.2, dmg: 16, rof: 0.8, builtAt: 'barracks', buildTime: 7,  kind: 'inf', tech: 'chem' },
  chemtank:    { name: 'Chem Tank',    cost: 1000, hp: 360, speed: 2.4, range: 5.0, dmg: 30, rof: 1.4, builtAt: 'factory',  buildTime: 13, kind: 'veh', tech: 'chem' },
  chemdrone:   { name: 'Chem Drone',   cost: 900,  hp: 140, speed: 3.0, range: 4.5, dmg: 24, rof: 1.6, builtAt: 'dronefac', buildTime: 11, kind: 'air', fly: true, alt: 2.7, tech: 'chem' },
  biotrooper:  { name: 'Bio Trooper',  cost: 550,  hp: 120, speed: 1.9, range: 4.2, dmg: 14, rof: 0.7, builtAt: 'barracks', buildTime: 7,  kind: 'inf', tech: 'bio' },
  biotank:     { name: 'Bio Tank',     cost: 1100, hp: 400, speed: 2.2, range: 5.2, dmg: 34, rof: 1.6, builtAt: 'factory',  buildTime: 14, kind: 'veh', tech: 'bio' },
  biodrone:    { name: 'Bio Drone',    cost: 950,  hp: 150, speed: 3.0, range: 4.5, dmg: 26, rof: 1.7, builtAt: 'dronefac', buildTime: 12, kind: 'air', fly: true, alt: 2.7, tech: 'bio' },
  stealthtank: { name: 'Stealth Tank', cost: 1300, hp: 300, speed: 3.0, range: 5.5, dmg: 46, rof: 1.8, builtAt: 'factory',  buildTime: 15, kind: 'veh', tech: 'stealth', cloak: true },
  fighter:   { name: 'Fighter',      cost: 1200, hp: 180, speed: 4.2, range: 5.0, dmg: 30,  rof: 1.0, builtAt: 'airforce', buildTime: 12, kind: 'air', fly: true, alt: 3.4, pad: true },
  bomber:    { name: 'Bomber',       cost: 2000, hp: 320, speed: 2.6, range: 3.0, dmg: 120, rof: 5.0, builtAt: 'airforce', buildTime: 18, kind: 'air', fly: true, alt: 3.4, pad: true, payload: 2 },
  dbomber:   { name: 'Drone Bomber', cost: 2600, hp: 280, speed: 3.0, range: 4.0, dmg: 90,  rof: 4.0, builtAt: 'airforce', buildTime: 20, kind: 'air', fly: true, alt: 3.4, pad: true, payload: 3 },
  heli:      { name: 'Helicopter',   cost: 1600, hp: 260, speed: 3.2, range: 5.5, dmg: 40,  rof: 1.4, builtAt: 'airforce', buildTime: 14, kind: 'air', fly: true, alt: 2.7, pad: true },
  helidrone: { name: 'Helidrone',    cost: 800,  hp: 120, speed: 3.6, range: 4.5, dmg: 20,  rof: 0.9, builtAt: 'airforce', buildTime: 9,  kind: 'air', fly: true, alt: 2.7, pad: true },
};

export const AIRFIELD_CAP = (lvl: number) => 2 + 2 * lvl; // capacity per airfield level
export const UPG_MAX = 3;
export const upgCost = (type: string, lvl: number, costMul: number) =>
  Math.round(BUILDINGS[type].cost * 0.6 * lvl * costMul);

export interface BuildingDef {
  name: string; cost: number; hp: number; power: number;  // power: + makes, - uses
  buildTime: number; size: number;                        // size in cells (square)
  attack?: { range: number; dmg: number; rof: number };
  prereq?: string;
}

export const BUILDINGS: Record<string, BuildingDef> = {
  conyard:  { name: 'Construction Yard', cost: 3000, hp: 1600, power: 10,   buildTime: 0,  size: 3 },
  power:    { name: 'Power Plant',       cost: 350,  hp: 650,  power: 100,  buildTime: 6,  size: 2 },
  refinery: { name: 'Ore Refinery',      cost: 1600, hp: 950,  power: -30,  buildTime: 12, size: 3, prereq: 'power' },
  barracks: { name: 'Barracks',          cost: 450,  hp: 750,  power: -20,  buildTime: 7,  size: 2, prereq: 'power' },
  factory:  { name: 'War Factory',       cost: 1900, hp: 1100, power: -40,  buildTime: 14, size: 3, prereq: 'refinery' },
  turret:   { name: 'Defense Turret',    cost: 650,  hp: 560,  power: -25,  buildTime: 8,  size: 1, prereq: 'barracks',
              attack: { range: 7.5, dmg: 26, rof: 1.0 } },
  dronefac: { name: 'Drone Works',       cost: 1500, hp: 850,  power: -35,  buildTime: 11, size: 2, prereq: 'factory' },
  sam:      { name: 'Missile Battery',   cost: 900,  hp: 700,  power: -30,  buildTime: 9,  size: 1, prereq: 'factory',
              attack: { range: 7, dmg: 50, rof: 2.5 } },
  shipyard: { name: 'Ship Factory',      cost: 1700, hp: 1000, power: -35,  buildTime: 13, size: 3, prereq: 'refinery' },
  airforce: { name: 'Aircraft Plant',    cost: 2200, hp: 1000, power: -45,  buildTime: 15, size: 3, prereq: 'factory' },
  airfield: { name: 'Airfield',          cost: 800,  hp: 600,  power: -15,  buildTime: 8,  size: 2, prereq: 'airforce' },
  lab:      { name: 'Research Lab',       cost: 2000, hp: 850,  power: -50,  buildTime: 14, size: 2, prereq: 'factory' },
};

// Researchable technologies (at the Research Lab). Each unlocks tech-gated units.
export interface TechDef { id: string; name: string; cost: number; time: number; desc: string }
export const TECHS: Record<string, TechDef> = {
  chem:    { id: 'chem',    name: 'Chemical Weapons',  cost: 1500, time: 30, desc: 'Unlocks Chem Trooper, Chem Tank, Chem Drone' },
  bio:     { id: 'bio',     name: 'Biological Weapons', cost: 1800, time: 35, desc: 'Unlocks Bio Trooper, Bio Tank, Bio Drone' },
  stealth: { id: 'stealth', name: 'Stealth Systems',   cost: 2000, time: 38, desc: 'Unlocks the cloaked Stealth Tank' },
};

// Faction balance philosophy: nobody is strictly strongest. Superpowers get
// durable/expensive or cheap/fragile; small nations get speed or production tech.
export interface Faction {
  id: string; name: string; flag: string;
  costMul: number; hpMul: number; speedMul: number;
  incomeMul: number; buildMul: number; powerMul: number;
  perk: string;
}

// 16 world powers, asymmetric but equalized — multipliers stay inside the
// ranges validated by the 100-game balance batch (cost .85-1.1, hp .85-1.18).
export const FACTIONS: Record<string, Faction> = {
  usa:    { id: 'usa',    name: 'United States', flag: '\u{1F1FA}\u{1F1F8}',
            costMul: 1.10, hpMul: 1.18, speedMul: 1.0, incomeMul: 1.0, buildMul: 1.0, powerMul: 1.0,
            perk: 'Durable hardware: +18% HP, +10% cost' },
  eu:     { id: 'eu',     name: 'European Union', flag: '\u{1F1EA}\u{1F1FA}',
            costMul: 1.0, hpMul: 1.02, speedMul: 1.0, incomeMul: 1.02, buildMul: 1.10, powerMul: 1.0,
            perk: 'Union industry: +10% build speed, +2% income' },
  russia: { id: 'russia', name: 'Russia', flag: '\u{1F1F7}\u{1F1FA}',
            costMul: 1.0, hpMul: 1.12, speedMul: 0.94, incomeMul: 1.0, buildMul: 1.0, powerMul: 1.05,
            perk: 'Heavy armor doctrine: +12% HP, -6% speed' },
  iran:   { id: 'iran',   name: 'Iran', flag: '\u{1F1EE}\u{1F1F7}',
            costMul: 0.93, hpMul: 0.92, speedMul: 1.05, incomeMul: 1.0, buildMul: 1.0, powerMul: 1.0,
            perk: 'Asymmetric warfare: -7% cost, +5% speed, -8% HP' },
  turkey: { id: 'turkey', name: 'Turkey', flag: '\u{1F1F9}\u{1F1F7}',
            costMul: 0.97, hpMul: 0.97, speedMul: 1.08, incomeMul: 1.0, buildMul: 1.04, powerMul: 1.0,
            perk: 'Drone exports: +8% speed, +4% build speed' },
  pakistan: { id: 'pakistan', name: 'Pakistan', flag: '\u{1F1F5}\u{1F1F0}',
            costMul: 0.90, hpMul: 0.90, speedMul: 1.02, incomeMul: 1.0, buildMul: 1.0, powerMul: 1.0,
            perk: 'Lean force: -10% cost, -10% HP' },
  india:  { id: 'india',  name: 'India', flag: '\u{1F1EE}\u{1F1F3}',
            costMul: 0.98, hpMul: 1.0, speedMul: 1.0, incomeMul: 1.06, buildMul: 1.02, powerMul: 1.0,
            perk: 'Scale economy: +6% income, -2% cost' },
  gulf:   { id: 'gulf',   name: 'Gulf Countries', flag: '\u{1F1F8}\u{1F1E6}',
            costMul: 1.08, hpMul: 1.0, speedMul: 1.0, incomeMul: 1.10, buildMul: 1.0, powerMul: 1.08,
            perk: 'Petrodollars: +10% income, +8% power, +8% cost' },
  au:     { id: 'au',     name: 'African Union', flag: '\u{1F30D}',
            costMul: 0.88, hpMul: 0.88, speedMul: 1.04, incomeMul: 1.0, buildMul: 1.04, powerMul: 1.0,
            perk: 'Mass mobilization: -12% cost, -12% HP' },
  china:  { id: 'china',  name: 'China', flag: '\u{1F1E8}\u{1F1F3}',
            costMul: 0.85, hpMul: 0.90, speedMul: 0.95, incomeMul: 1.0, buildMul: 1.0, powerMul: 1.0,
            perk: 'Mass production: -15% cost, -10% HP' },
  korea:  { id: 'korea',  name: 'South Korea', flag: '\u{1F1F0}\u{1F1F7}',
            costMul: 1.02, hpMul: 0.98, speedMul: 1.0, incomeMul: 1.0, buildMul: 1.18, powerMul: 1.0,
            perk: 'Chaebol industry: +18% build speed' },
  taiwan: { id: 'taiwan', name: 'Taiwan', flag: '\u{1F1F9}\u{1F1FC}',
            costMul: 1.0, hpMul: 0.92, speedMul: 1.0, incomeMul: 1.04, buildMul: 1.12, powerMul: 1.04,
            perk: 'Silicon shield: +12% build speed, +4% income, -8% HP' },
  australia: { id: 'australia', name: 'Australia', flag: '\u{1F1E6}\u{1F1FA}',
            costMul: 1.02, hpMul: 1.08, speedMul: 1.0, incomeMul: 1.04, buildMul: 1.0, powerMul: 1.0,
            perk: 'Resource wealth: +8% HP, +4% income' },
  brazil: { id: 'brazil', name: 'Brazil', flag: '\u{1F1E7}\u{1F1F7}',
            costMul: 0.95, hpMul: 0.96, speedMul: 1.10, incomeMul: 1.0, buildMul: 1.0, powerMul: 1.0,
            perk: 'Jungle corps: +10% speed, -5% cost' },
  argentina: { id: 'argentina', name: 'Argentina', flag: '\u{1F1E6}\u{1F1F7}',
            costMul: 0.92, hpMul: 0.95, speedMul: 1.05, incomeMul: 1.0, buildMul: 1.0, powerMul: 1.0,
            perk: 'Expeditionary: -8% cost, +5% speed, -5% HP' },
  canada: { id: 'canada', name: 'Canada', flag: '\u{1F1E8}\u{1F1E6}',
            costMul: 1.0, hpMul: 1.10, speedMul: 0.98, incomeMul: 1.0, buildMul: 1.06, powerMul: 1.02,
            perk: 'Arctic engineering: +10% HP, +6% build speed' },
};

export const PLAYER_COLORS = [0x3da5ff, 0xff5043, 0x57d977, 0xffc940];

// drone-class flyers: flak shreds these, but airplanes shrug it off
export const DRONE_TYPES = new Set(['recon', 'strike', 'msldrone', 'helidrone', 'minidrone', 'chemdrone', 'biodrone', 'dbomber', 'navdrone']);

// Damage matrix: attacker type vs target class (tgtType refines air targets).
export function dmgMul(attType: string, tgtIsBuilding: boolean, tgtKind: string, tgtType?: string): number {
  if (tgtKind === 'air') {
    if (attType === 'fighter') return 2.2;       // interceptor
    if (attType === 'sam') return 2.2;
    if (attType === 'aatank') return 2.3;        // dedicated mobile AA
    if (attType === 'flak') return tgtType && DRONE_TYPES.has(tgtType) ? 2.4 : 0.5; // drone shredder
    if (attType === 'rocket') return 1.8;
    if (attType === 'destroyer') return 1.5;
    if (attType === 'rifle') return 1.2;
    if (attType === 'ifv') return 0.8;           // autocannon can pepper aircraft
    if (attType === 'turret') return 0;          // gun turret can't elevate (defensive AA = SAM)
    if (attType === 'mlrs') return 0;            // artillery cannot engage aircraft
    if (attType === 'tank' || attType === 'heavy') return 0.4;
    if (attType === 'bomber') return 0.1;
    if (attType === 'sub') return 0.15;
    return 1.0;
  }
  if (tgtKind === 'sea') {
    if (attType === 'sub') return 1.8;           // torpedoes
    if (attType === 'rocket') return 1.4;
    if (attType === 'strike' || attType === 'heli' || attType === 'msldrone') return 1.3;
    if (attType === 'rifle') return 0.5;
    return 1.0;
  }
  // chem/bio weapons devastate infantry, hurt buildings; minidrone hits both
  if (attType === 'chemtrooper' || attType === 'biotrooper')
    return tgtIsBuilding ? 0.7 : (tgtKind === 'inf' ? 2.0 : 0.8);
  if (attType === 'chemtank' || attType === 'biotank' || attType === 'chemdrone' || attType === 'biodrone')
    return tgtIsBuilding ? 1.3 : (tgtKind === 'inf' ? 1.8 : 1.1);
  if (attType === 'stealthtank') return tgtIsBuilding ? 1.3 : 1.2;
  // kamikaze blast: 1-2 drones kill a tank, 3-4 crack a fortification
  if (attType === 'minidrone') return tgtIsBuilding ? 0.9 : (tgtKind === 'veh' ? 1.7 : 1.2);
  // pronounced rock-paper-scissors: rifles shred infantry but bounce off armor,
  // rockets crack armor but whiff on infantry, tanks duel tanks, artillery
  // flattens structures but loses to anything that closes the distance.
  if (attType === 'sam')    return 0.5; // AA battery is weak vs ground
  if (attType === 'fighter') return 0.45; // interceptor — near-useless vs ground
  if (attType === 'bomber') return tgtIsBuilding ? 2.4 : (tgtKind === 'inf' ? 1.3 : 1.0);
  if (attType === 'dbomber') return tgtIsBuilding ? 1.8 : 1.0;
  if (attType === 'heli')   return tgtKind === 'veh' ? 1.8 : 1.25; // rockets vs armor, guns vs inf
  if (attType === 'sub')    return tgtIsBuilding ? 0.7 : 0.8;
  if (attType === 'mlrs')   return tgtIsBuilding ? 2.0 : (tgtKind === 'inf' ? 1.5 : 0.7);
  if (attType === 'msldrone') return tgtIsBuilding ? 1.5 : (tgtKind === 'veh' ? 1.8 : 0.5);
  if (attType === 'recon')  return tgtIsBuilding ? 0.4 : (tgtKind === 'inf' ? 1.2 : 0.5);
  if (attType === 'strike') return tgtIsBuilding ? 1.2 : (tgtKind === 'veh' ? 1.8 : 0.55);
  if (attType === 'rocket') return tgtIsBuilding ? 1.8 : (tgtKind === 'veh' ? 2.2 : 0.45);
  if (attType === 'rifle')  return tgtIsBuilding ? 0.35 : (tgtKind === 'veh' ? 0.35 : 1.35);
  if (attType === 'ifv')    return tgtIsBuilding ? 0.5 : (tgtKind === 'inf' ? 2.2 : 0.5);
  if (attType === 'aatank') return 0.25; // AA missiles are wasted on ground targets
  if (attType === 'flak')   return tgtIsBuilding ? 0.3 : (tgtKind === 'inf' ? 0.9 : 0.4);
  if (attType === 'tank' || attType === 'heavy') return tgtIsBuilding ? 1.3 : (tgtKind === 'inf' ? 0.5 : 1.35);
  if (attType === 'turret') return tgtIsBuilding ? 0.8 : (tgtKind === 'veh' ? 0.6 : 1.1); // armor shrugs off turret fire
  return 1.0; // gunboat / destroyer guns
}
