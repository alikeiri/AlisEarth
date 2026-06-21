// Initial developer-roadmap backlog. Used ONCE to seed roadmap.json on a fresh
// box (after that the admin panel is the source of truth). Each entry is just a
// category + title; the server stamps id/status/priority/timestamps on seed.
export const ROADMAP_SEED: { cat: string; title: string }[] = [
  // ---- Power System / Economy ----
  { cat: 'Power / Economy', title: 'Base defenses use a small amount of power for every shot' },
  { cat: 'Power / Economy', title: 'Unit-producing buildings consume more power while producing' },
  { cat: 'Power / Economy', title: 'Constructed Oil Rigs should consume power' },
  { cat: 'Power / Economy', title: 'Bring back offshore oilfields with the naval engineer' },

  // ---- Radar Rework ----
  { cat: 'Radar Rework', title: 'Radar/Sonar range shows only unit/building "blips"; only view range clears fog (except spy satellite). Advanced Radar shows unit type as a symbol' },

  // ---- Visuals ----
  { cat: 'Visuals', title: 'Ground decals / environment objects (grass, bushes, rocks, ruins, rubble)' },
  { cat: 'Visuals', title: 'Scarring & map deformation from certain weapons (complex)' },
  { cat: 'Visuals', title: 'Particle effects on units/buildings (muzzle smoke, factory chimney, buildings on fire, etc.)' },
  { cat: 'Visuals', title: 'Better, more diverse ordnance animations (explosions, smoke); maybe ballistic projectiles flying in an arc' },
  { cat: 'Visuals', title: 'Day/night cycle with sunset/dawn (units/buildings emit light)' },
  { cat: 'Visuals', title: 'Random weather/lightning (fog, rain, sand/thunderstorm, snow); distance fog beyond max zoom only' },
  { cat: 'Visuals', title: 'More realistic tree models; bulldozable; lower-density patches not solid to some units (at a movement cost)' },
  { cat: 'Visuals', title: 'Water layer extends past the map boundary — end it at the border, or extend the seafloor + a visible barrier' },
  { cat: 'Visuals', title: 'Sky improvements' },
  { cat: 'Visuals', title: 'Texture splatting & better materials' },
  { cat: 'Visuals', title: 'Water shader' },
  { cat: 'Visuals', title: 'Unit/building models (large task)' },

  // ---- Buildings ----
  { cat: 'Buildings', title: 'Buildings level the terrain below them when built; cannot be built on cliffs/mountains (except seaport & defense buildings)' },
  { cat: 'Buildings', title: 'During an upgrade show an icon indicating the building is upgrading' },
  { cat: 'Buildings', title: 'Hover tooltip: add upgrade level and power consumption on a 2nd line' },

  // ---- Unit AI ----
  { cat: 'Unit AI', title: 'Mixed selected group should move at the slowest unit’s speed (fast support units currently arrive first and die) — maybe only when grouped via Ctrl-1/2/3' },
  { cat: 'Unit AI', title: 'Engineers flee in battle, sometimes straight into enemy lines' },

  // ---- Unit Improvements ----
  { cat: 'Unit Improvements', title: 'Bulldozer terraforming submenu (circle area, level to surroundings, 2-point bridges, clear obstacles)' },
  { cat: 'Unit Improvements', title: 'Bulldozer terraforming should cost more and be restricted around existing buildings (maybe only in base range)' },
  { cat: 'Unit Improvements', title: 'Give the bulldozer an amphibious model, or share the role with a special ship' },
  { cat: 'Unit Improvements', title: 'Show a ghost building when targeting an oil well with the engineer/naval engineer' },
  { cat: 'Unit Improvements', title: 'Bombers show an ammo indicator (dots/squares) below HP; also engineer minelayers, maybe harvesters (instead of the 2nd bar)' },

  // ---- New Units / Reworks / Buildings ----
  { cat: 'New Units / Reworks', title: 'Extend signature units/buildings for the factions?' },
  { cat: 'New Units / Reworks', title: 'Are we keeping both AA/Flak vehicles?' },
  { cat: 'New Units / Reworks', title: 'MRLS stays a signature unit only? Maybe a single-rocket RLS for all factions' },
  { cat: 'New Units / Reworks', title: 'Light amphibious unit (hovercraft)' },
  { cat: 'New Units / Reworks', title: 'Tank with camo net (looks like a tree/bush/rock while not moving/firing)' },
  { cat: 'New Units / Reworks', title: 'Dedicated land/water minelayers (instead of the engineer)' },
  { cat: 'New Units / Reworks', title: 'Naval engineer lays sea mines; naval/land engineer replenish mines over time' },
  { cat: 'New Units / Reworks', title: 'Field Medic (repairs infantry only; boosts morale = attack bonus in range)' },
  { cat: 'New Units / Reworks', title: 'Commando (expensive infantry: can bury himself, lay booby traps / IEDs)' },
  { cat: 'New Units / Reworks', title: 'Small slow land drone (detects/removes mines, no weapon, can self-explode)' },
  { cat: 'New Units / Reworks', title: 'Pop-up base defense building (maybe flamethrower)' },
  { cat: 'New Units / Reworks', title: 'Decoy buildings / units' },
  { cat: 'New Units / Reworks', title: 'Energy storage building' },
  { cat: 'New Units / Reworks', title: 'Energy-to-credits converter building' },
  { cat: 'New Units / Reworks', title: 'TEWS shouldn’t spread fog of war — full rework; maybe it slows drones instead of attacking them' },
  { cat: 'New Units / Reworks', title: 'Jamming / EWS / countermeasures field around units/buildings (fiber-optic drones, EWS infantry)' },
  { cat: 'New Units / Reworks', title: 'Laser flak tech for ships, units & base defenses (vs drones/missiles)' },
  { cat: 'New Units / Reworks', title: 'Patriot/SAM is the only mobile radar + only missile-silo counter, but you wouldn’t take it into battle — rethink' },
  { cat: 'New Units / Reworks', title: 'Rebalance submarine, maybe split into 2 versions; one can transport a small infantry team' },
  { cat: 'New Units / Reworks', title: 'Aircraft carrier?' },

  // ---- Unit/Building modifications (future, major) ----
  { cat: 'Mods / Deck Building (future)', title: 'Rule-based "deck building": modify unit/building params at a cost, multiple decks per account, balanced via rules, allow extremes, name units, pick visuals by class (tint/texture), publish decks, create your own faction. Separate ladder.' },

  // ---- Map Generator / Settings ----
  { cat: 'Map Generator / Settings', title: 'Option to raise/lower the amount of ore/oil on the map' },
  { cat: 'Map Generator / Settings', title: 'Option to raise/lower powerplant power production' },
  { cat: 'Map Generator / Settings', title: 'Option to set garrison-building density on maps that use them' },
  { cat: 'Map Generator / Settings', title: 'Add an even larger map (maybe drop Small and shift the rest up)' },
  { cat: 'Map Generator / Settings', title: 'Option to set the number of continents on the island map (2–8)' },
  { cat: 'Map Generator / Settings', title: 'Add a few tiny islands (sandbanks) on larger bodies of water' },
  { cat: 'Map Generator / Settings', title: 'More hills/mountains on larger landmasses (maybe configurable)' },
  { cat: 'Map Generator / Settings', title: 'Show the upcoming map seed on the lobby page; allow entering it manually' },
  { cat: 'Map Generator / Settings', title: 'Preview minimap on lobby/at game start; let players pick start positions, AI fills the rest' },
  { cat: 'Map Generator / Settings', title: 'Load static predefined or user-created maps' },
  { cat: 'Map Generator / Settings', title: 'Map editor + publish your own maps' },

  // ---- Gamemodes ----
  { cat: 'Gamemodes', title: 'Free for all' },
  { cat: 'Gamemodes', title: 'Capture the flag (construction yard)' },
  { cat: 'Gamemodes', title: 'Survive a timeframe' },
  { cat: 'Gamemodes', title: 'Last man standing (teams disband when only 2 factions remain)' },

  // ---- Research ----
  { cat: 'Research', title: 'Full research rework after adding signature units' },

  // ---- Audio Feedback / Chat ----
  { cat: 'Audio / Chat', title: 'Option to disable AI taunts; limit them to what the AI can actually see; larger random delay between messages' },
  { cat: 'Audio / Chat', title: 'Game-engine notifications as text (when sound is off)' },
  { cat: 'Audio / Chat', title: 'Audio cue when any player/AI surrenders' },
  { cat: 'Audio / Chat', title: 'Audio cue on low power (once per threshold crossing, hard limit 30s)' },
  { cat: 'Audio / Chat', title: 'Audio cue on insufficient power (once per threshold crossing, hard limit 30s)' },
  { cat: 'Audio / Chat', title: 'Audio cue when a unit is under attack (once, hard limit 30s)' },
  { cat: 'Audio / Chat', title: 'Audio cue when buildings are attacked (once, hard limit 30s)' },
  { cat: 'Audio / Chat', title: 'Audio cue when any player builds a missile silo (once per session)' },
  { cat: 'Audio / Chat', title: 'Audio cue when any player researches the spy satellite (once per player)' },
  { cat: 'Audio / Chat', title: 'Unit firing/command sounds (different accents/languages for immersion?)' },

  // ---- Copyrights ----
  { cat: 'Copyrights', title: 'Verify all assets are CC0 / public domain (otherwise attribution/restrictions; may not be allowed to redistribute the assets)' },
];
