# SUPERPLAN — Untitled Space Exploration & Commerce Sim

> A browser-based 3D game built with Three.js that fuses **No Man's Sky's** procedural exploration and sense of wonder with **Starsector's** fleet-based combat, ship fitting, and living faction economy.

---

## 0. Locked Design Decisions

| Area | Decision | Implication |
|---|---|---|
| Combat | **Hybrid**: pilot the flagship in 3rd-person 3D; fleet takes orders via a tactical overlay (pause + command). Battles are resolved on a **soft combat plane** (ships may deviate ±Y, but AI reasons in 2D). | Keeps fleet AI tractable (2D steering, Starsector-style), while flight still feels 3D. |
| Planets | **Orbit + landing scenes**: planets are rendered spheres in-system; landing transitions to a separate procedurally generated surface scene. | No seamless LOD terrain. Surface is a bounded chunked heightfield (~2×2 km). |
| Economy | **Living simulation**: per-market supply/demand, production chains, NPC trade convoys, faction wars, player colonies. | Needs a deterministic background sim tick decoupled from rendering. |
| Platform | **Single-player web**: Vite + TypeScript + Three.js, IndexedDB saves, no server. | Everything client-side; heavy sim goes in a Web Worker. |
| Art | **Stylized low-poly** with flat/toon shading, bloom, vivid nebulae. All procedural. | No asset pipeline required for MVP; ships built from procedural parts. |
| Ships | **Hulls + slots**: hull classes with weapon mounts (size/type/arc), hullmods, ordnance points (OP). Multi-ship fleets. | Data-driven hull/weapon definitions (JSON). |

---

## 1. Game Pillars

1. **Wonder** — every system is unique, seeded, and beautiful; scanning and discovery pay off.
2. **Commerce** — a readable but deep economy where you can get rich by trading, hauling, mining, or building colonies.
3. **Command** — you're a captain of a fleet, not just a pilot. Fitting and fleet composition matter.
4. **Consequence** — factions remember you; wars shift borders; markets react to blockades and your actions.

### Core Loop
```
Explore (jump to system, scan, discover) ──► Gather (salvage, mine, surface resources, missions)
      ▲                                                   │
      │                                                   ▼
Expand (bigger fleet, colonies, faction standing) ◄── Trade & Fight (markets, contracts, combat)
```

---

## 2. Technical Architecture

### 2.1 Stack
- **Three.js r186+** (WebGL2 renderer; WebGPU renderer evaluated in Phase 9)
- **TypeScript** (strict), **Vite** (dev server + build)
- **postprocessing** effects: UnrealBloom, FXAA/SMAA, tone mapping (three/examples `EffectComposer` to start)
- **UI**: HTML/CSS overlay layer (Preact or vanilla TS components) — not in-canvas. Keeps menus, markets and fitting screens fast to build.
- **Noise**: `simplex-noise` (or own impl) for terrain/planet textures
- **RNG**: seeded PRNG (mulberry32 / sfc32) — **every** procedural generator takes a seed
- **Persistence**: IndexedDB (via `idb-keyval`), versioned save schema with migrations
- **Worker**: economy/faction sim runs in a Web Worker; communicates via structured messages
- **Testing**: Vitest for sim/econ/procgen determinism; Playwright smoke tests for boot & scene transitions

### 2.2 Layered Architecture
```
┌──────────────────────────────────────────────────────────────────┐
│ UI Layer (HTML overlay): HUD, galaxy map, market, fitting, comms │
├──────────────────────────────────────────────────────────────────┤
│ Scene Layer (Three.js): GalaxyMapScene, SystemScene,             │
│   CombatScene (mode of SystemScene), SurfaceScene                │
├──────────────────────────────────────────────────────────────────┤
│ Game Layer: ECS-lite entities, controllers, AI, physics-lite     │
├──────────────────────────────────────────────────────────────────┤
│ Simulation Layer (Worker): economy, factions, NPC fleets, time   │
├──────────────────────────────────────────────────────────────────┤
│ Data Layer: content defs (JSON), procgen, save/load              │
└──────────────────────────────────────────────────────────────────┘
```

### 2.3 Directory Layout
```
src/
  main.ts                 # bootstrap
  core/                   # Game loop, time, events, input, RNG, math utils
  render/                 # renderer, post-fx, materials, shaders, starfield
  scenes/                 # SceneManager + individual scenes
  ecs/                    # entity/component/system primitives
  ships/                  # hull defs, fitting, procedural ship mesh builder
  combat/                 # weapons, projectiles, damage, shields, flux, AI
  galaxy/                 # galaxy & star system generation
  planets/                # planet sphere gen, surface scene gen, biomes
  economy/                # commodities, markets, production, pricing
  factions/               # factions, relations, wars, territory
  sim/                    # worker entry + sim tick orchestration
  ui/                     # HUD + screens
  save/                   # serialization, migrations
  content/                # JSON: hulls, weapons, hullmods, commodities, factions
tests/
docs/
```

### 2.4 Coordinates & Scale (critical for Three.js)
Float32 precision breaks down at large distances. Strategy:
- **Galaxy space**: abstract 2D/3D coordinates in light-years — never rendered at true scale; galaxy map is its own scene.
- **System space** *(implemented in Phase 1)*: each star system is its own scene. **1 unit = 1 metre**, with a compressed system scale: rocky worlds 12–55 km radius, gas giants 120–260 km, stars 240–2400 km, orbits ~3–300 Mm.
- **Camera-relative rendering** *(implemented)*: the camera always sits at the render origin. All sim positions are float64 (JS numbers); every frame each object's render position is `simPos − cameraPos`, so precision is always highest where the player is looking.
- **Reference frames** *(implemented)*: the ship's position and velocity are stored relative to the body or station whose sphere of influence it is in, so orbiting planets and stations carry the player with them. Frames switch automatically at SOI boundaries.
- **Logarithmic depth buffer** with float depth texture; analytic shaders write log depth themselves.
- **Travel**: in-system "supercruise" whose speed cap scales with distance to the nearest surface (Elite-style), from 2 km/s to 3 Mm/s, so crossing a system takes about a minute.

### 2.5 Simulation Time
- **Real-time** in flight/combat; **pause-able** (tactical pause).
- **Campaign time**: 1 in-game day ≈ 10 real seconds while traveling in hyperspace/galaxy map; markets & factions tick per in-game day.
- The worker holds the authoritative campaign state; main thread holds a mirror + issues commands. On save, both sides serialize.

### 2.6 Determinism & Seeds
`galaxySeed → systemSeed(i) → planetSeed(i,j) → surfaceSeed(i,j,k)`. Generated content is **never saved**, only seeds + deltas (what the player changed: mined deposits, discovered POIs, colonies, etc.). Keeps saves tiny.

---

## 3. Game Systems Design

### 3.1 Galaxy
- 300–1,000 star systems in a spiral/elliptical distribution, generated in the worker.
- Hyperlane graph (Delaunay → pruned) OR free jump with fuel range. **Choice: free jump with range + fuel**, with nebulae/storms as slowdowns (closer to Starsector's hyperspace).
- Star types (O–M, white dwarf, neutron, black hole) weight planet generation and hazards.
- Regions: **Core** (faction-dense, safe, low prices for manufactured goods), **Frontier** (sparse, contested), **Fringe** (unclaimed, ruins, derelicts, high reward).

### 3.2 Star Systems
- Contents: star(s), 0–12 planets, moons, asteroid belts, stations, jump points, derelicts, anomalies.
- Visuals: emissive star shader + corona sprite + lens flare; skybox from galaxy position (procedural nebula cube map baked at load).
- POIs discovered by **scanning** (pulse scan reveals signatures within radius; deep-scan targets).

### 3.3 Planets
- **Orbital view**: icosphere + procedural shader (layered noise → biome color ramp, clouds layer, atmosphere rim/fresnel shader, rings optional).
- Planet types: Barren, Lava, Ice, Desert, Terran, Ocean, Toxic, Gas Giant (no landing), Exotic.
- Attributes: gravity, atmosphere, temperature, hazard, resources (ore, volatiles, organics, rare metals), ruins rating.
- **Landing scene**: chunked heightfield (e.g. 8×8 chunks of 128² verts), biome-driven flora (instanced low-poly), resource nodes, POIs (ruins, crashed ships, outposts), weather/hazard. On-foot (FPS/3rd-person) + optional rover. Return to ship to take off.

### 3.4 Ships
**Hull sizes**: Frigate, Destroyer, Cruiser, Capital (+ Fighters/Drones as wings).

**HullDef (data)**:
```ts
interface HullDef {
  id: string; name: string; size: 'frigate'|'destroyer'|'cruiser'|'capital';
  hitpoints: number; armor: number; fluxCapacity: number; fluxDissipation: number;
  shield?: { arc: number; efficiency: number; upkeep: number };
  maxSpeed: number; accel: number; turnRate: number;
  ordnancePoints: number;
  slots: WeaponSlot[];               // position, facing, arc, size (S/M/L), type (ballistic/energy/missile/universal)
  builtInMods: string[];
  cargo: number; fuel: number; crew: { min: number; max: number };
  supplyPerMonth: number; fuelPerLY: number;
  shipSystem?: string;               // e.g. "burn_drive", "phase_skimmer"
  mesh: ProceduralShipRecipe;        // seed + part grammar
}
```
- **Fitting**: weapons + hullmods cost OP; vents/capacitors convert leftover OP into flux stats (Starsector).
- **Flux system**: firing/shields generate flux; overload at cap; vent to dump. This is the heart of combat depth.
- **Damage types**: Kinetic (good vs shields), High-Explosive (good vs armor), Energy (neutral), Fragmentation (vs hull/missiles).
- **Armor grid**: per-ship armor cells (Starsector-style) → localized damage; rendered as decal/damage glow.
- **CR / Readiness**: combat readiness drains in fights and with poor supply; affects performance.
- **Procedural mesh builder**: hull built from a grammar of low-poly parts (spine, wings, engine pods, bridge, greebles) with faction palette + seed → instantly unique-but-coherent ships.

### 3.5 Combat (Hybrid)
- Triggered when hostile fleets intercept in-system (or player engages). Transition: camera pulls out, slow-mo, fleets deploy from edge → **combat mode** of SystemScene (no scene reload).
- **Player control**: 3rd-person chase camera on flagship; WASD + mouse aim; weapon groups (1–5); shield toggle (RMB); ship system (F); vent (V); target cycle (R/T).
- **Tactical overlay** (Tab / Space = pause): top-down camera over the combat plane; drag-select ships; issue orders (move, attack, escort, hold, retreat, capture objective). Orders persist when unpaused.
- **Combat plane**: AI steering is 2D on XZ; Y used for visual layering and soft separation; player may move in Y within a slab (±300 u).
- **AI**: per-ship behavior tree — threat assessment, flux management (raise/lower shields, back off when high flux), weapon arc awareness, formation keeping; fleet-level commander allocates targets.
- **Weapons**: projectile (pooled InstancedMesh), beams (shader quads), missiles (homing, PD-targetable), fighters (boids).
- **Resolution**: win/lose/retreat → salvage screen (loot, recover disabled hulls with d-mods), CR/hull repairs cost supplies.

### 3.6 Economy (Living Sim)
- **Commodities** (~16): Food, Water, Organics, Ore, Rare Ore, Volatiles, Metals, Rare Metals, Fuel, Supplies, Heavy Machinery, Domestic Goods, Luxury Goods, Drugs (illegal), Weapons (restricted), AI Cores (rare), plus Crew/Marines as tradeable "goods".
- **Markets**: each colony/station has population size (1–10), industries, stockpiles, accessibility, stability, faction, legality rules.
- **Industries** (production chains): Farming, Mining, Refining, Heavy Industry, Light Industry, Fuel Production, Spaceport, Military Base, Commerce. Each has inputs/outputs scaled by pop & conditions.
- **Pricing**: `price = basePrice * f(stock / targetStock)` with smoothing; buy/sell spread by accessibility + tariff; player transactions shift stock (no infinite arbitrage).
- **Flows**: daily tick — produce → consume → compute surplus/deficit → NPC trade convoys spawn to move surplus to deficit markets (real fleets that travel the map and can be raided/escorted).
- **Events**: shortages, blights, pirate raids, blockades, booms. Player sees them in the "Intel" feed.
- **Player colonies**: survey planet → establish outpost (costs supplies + crew + machinery) → build industries → grows pop → sells to markets; needs defense (pirate/faction raids).

### 3.7 Factions
- 6–8 factions: e.g. **Hegemony Directorate** (authoritarian core), **Free Trade League** (merchants), **Tri-Corp** (megacorp), **Ascendant Path** (zealots), **Pirates** (raiders), **Independents**, **Remnant Machines** (hostile AI in fringe), **Precursors** (dead; ruins & tech).
- **Relations**: faction↔faction matrix and faction↔player reputation (−100..100), with thresholds (Vengeful … Cooperative).
- **Territory**: systems owned via colonies; influence radiates.
- **Strategic AI** (daily/weekly tick): evaluate threats & opportunities → declare war/peace, send patrols, expeditions, raids, invasions. Lightweight utility AI, not real-time.
- **Commissions**: player can join a faction for pay + access to military hulls/weapons; makes enemies of rivals.
- **Bounties/contracts** generated from faction needs.

### 3.8 Missions & Content
- Procedural mission templates: Delivery, Smuggling, Bounty, Survey, Salvage Recovery, Escort Convoy, Raid, Patrol, Exploration (scan anomaly), Colony Supply.
- Hand-authored **story arcs** (later): Precursor mystery chain leading to the galactic core, faction storylines.
- **Discovery rewards**: "Codex" entries (fauna, flora, ruins, anomalies) sold as data to factions — a No Man's Sky-style exploration economy.

### 3.9 Progression
- **Credits**, **ships/fleet**, **blueprints** (to build ships/weapons at owned colonies), **skills** (Captain: Piloting/Combat/Leadership/Industry/Exploration trees), **officers** (hire for fleet ships, have personalities and skills), **reputation**.

### 3.10 Exploration Mechanics
- Fuel & supply logistics constrain range (Starsector-style).
- Scanner tiers; anomalies; derelicts (salvageable, sometimes with defenses); ancient gates (late-game fast travel).
- Surface: resource gathering (multi-tool-style mining beam), POIs, flora/fauna scanning, hazards (temperature/radiation shield gauge).

---

## 4. UI / UX Screens
1. **Main menu** / new game (seed, difficulty, starting faction & ship)
2. **Flight HUD**: speed, flux bar, hull/armor, shields, weapon groups, target info, minimap/radar, nav markers, supercruise indicator
3. **Tactical combat overlay**
4. **System map** (orbit view, click-to-navigate)
5. **Galaxy map** (jump plotting, fuel range ring, faction territory, intel overlays)
6. **Station/Colony screen**: Market, Refit, Shipyard, Bar (missions/officers), Contacts, Storage
7. **Fleet & Refit screen**: ship list, fitting (drag weapons into slots, live OP + stats readout), hullmods
8. **Cargo/Inventory**
9. **Intel & Codex**
10. **Colony management**
11. **Save/Load/Settings** (graphics quality, keybinds, audio)

---

## 5. Rendering & Visual Plan
- **Flat/toon shaded** `MeshToonMaterial` / custom `ShaderMaterial`s; faction color palettes.
- **Bloom** on emissives (engines, weapons, stars, shields).
- **Starfield**: 3 parallax layers of `Points` + procedural nebula skybox (raymarched or FBM baked to cube map once per system).
- **Planets**: shader-based surface (no huge textures), atmosphere scattering approximation, cloud layer.
- **VFX**: engine trails (ribbon geometry), shield bubble (fresnel + hit ripple via uniform array), explosions (GPU particles), beam weapons, warp tunnel effect.
- **Performance budget**: 60 FPS @ 1080p on integrated GPU-class hardware for exploration; 45+ in large fights (target ≤ 60 ships + 2,000 projectiles). Instancing + object pooling everywhere; frustum culling; LOD for ships at distance (impostors/sprites).

## 6. Audio
- WebAudio via Three's `AudioListener`; positional SFX for weapons/engines; ambient generative synth pads per system (procedural music driven by star type), combat music layer crossfade.

---

## 7. Phased Roadmap

Each phase ends with a **playable build** and a demo goal.

### Phase 0 — Foundation (Week 1)  ✅ *done*
- Vite + TS + Three.js project, strict TS, lint/format, Vitest
- Game loop (fixed-step sim, variable render), input manager, seeded RNG
- Renderer + bloom composer, starfield, flyable placeholder ship with chase camera
- **Demo**: fly a ship around a starfield with bloom.

### Phase 1 — A Star System (Weeks 2–3)  ✅ *done*
- System generator (star, planets, moons, belts) from seed
- Planet shaders (type-based), star shader, atmospheres, orbits
- Floating origin, log depth buffer, supercruise
- System map overlay & nav markers
- **Demo**: fly across a procedurally generated system and approach planets.

**As built:**
- **Generator** (`src/galaxy/`): 7 spectral classes; 4–8 orbit slots spaced geometrically from a habitable zone; 9 world types picked by temperature; moons, rings, asteroid belts and one trade station per system. Spheres of influence never overlap. Every value derives from the seed (see the determinism tests).
- **Planets** (`src/render/shaders/planet.ts`): each planet is a ray-traced analytic sphere drawn on a proxy cube, so silhouettes are exact at any distance. Surfaces are baked into cube maps on the GPU, with domain-warped FBM, ridged mountains, craters, biomes, ice caps, cyclonic clouds and gas-giant bands with vortex storms. Bakes are 256 px at load; a progressive 1024 px bake streams in strips as the player approaches. Runtime detail noise covers close range. The surface shader also does ocean sun-glint and Fresnel, lava with crust and emissive cracks, bioluminescent seas, cloud shadows, ring shadows, differential flow on gas giants, and sun reddening at the terminator.
- **Atmospheres** (`src/render/shaders/post.ts`): Rayleigh + Mie single scattering runs as a screen-space pass that reads the scene depth. Haze wraps everything, the sky turns blue from inside, and daylight washes out the stars.
- **Star**: granulation (Worley), limb darkening, sunspots, an animated corona, and a depth-tested lens flare.
- **Pipeline**: HDR scene with MSAA → atmosphere → physically based bloom (Jimenez downsample/upsample) → ACES tonemapping, vignette, dither and a supercruise radial blur.
- **Skybox**: a nebula and galactic band baked per system, plus HDR twinkling stars. The PMREM environment provides ship reflections.
- **Flight** (`src/ships/flight.ts`): virtual-joystick mouse, throttle, strafe, boost and flight assist; supercruise charges up, is mass-locked near bodies, and drops automatically on arrival; auto-align to target.
- **World**: a rotating ring station, instanced asteroid fields generated around the player, belt dust, collisions, sun shadowing on the ship from planets, and coloured planetshine.
- **UI**: nav markers with brackets and an off-screen target arrow, a target panel with ETA, the system map (log-scaled orbits, textured globes, info panel, set target) and a help overlay.
- **Debug**: `window.game.debug` (`goto`, `lookAt`, `target`, `supercruise`, `map`, `anchors`).

### Phase 2 — Galaxy & Travel (Weeks 4–5)  ✅ *done*
- Galaxy generator in worker; galaxy map scene with jump plotting
- Fuel/supply logistics, hyperspace transition effect
- Save/load (seed + deltas) to IndexedDB
- **Demo**: jump between systems; save and reload.

**As built:**
- **Galaxy** (`src/galaxy/galaxyGen.ts`): about 670 stars per galaxy seed in a log-spiral disc (2–4 arms, central bulge, field stars), with a minimum 3.2 ly spacing.
  - "Bridge" stars stitch isolated clusters into one jump network, so 95%+ of stars are reachable at 12 ly.
  - Each galaxy has 6–10 nebulae along the arms and core/frontier/fringe regions.
  - Each star's name and class come from its system's own seed header, so the map always matches the system you arrive in (tested).
  - The start system is a well-connected frontier system with a station and a living world.
- **Routing** (`src/galaxy/route.ts`): A* over a jump graph, minimising jumps first and fuel second (tested against BFS). Fuel cost is `1 + 0.6·ly`, ×1.4 for entering a nebula.
- **Worker** (`src/sim/`): galaxy generation and route plotting run in a Web Worker behind a typed promise RPC (`SimClient`). The same `SimHost` handler runs in-thread as a fallback. Phase 5's economy tick plugs in here.
- **Galaxy map** (`src/ui/galaxyMap.ts`):
  - Visuals: a procedural spiral-arm glow disc matching the generator, a haze of 30k unresolved stars, nebula billboards and HDR star points.
  - Navigation overlays: jump-range and fuel-range rings, a polar grid with drop lines, and an animated route tube.
  - Interaction: search, hover tooltips, an info panel for explored or unexplored systems, a route panel with fuel-shortfall warnings, and label collision culling.
- **Sky**: system axes are aligned with the galaxy, so every other system appears in its true direction and brightness. Your hyperspace target is literally a star you can point at. The galactic band and bulge follow the real galactic plane and core; systems inside a nebula get its colours.
- **Hyperjump**: a system target plus **J** gives a 5 s charge with countdown, an alignment requirement (within 9°, auto-align works), mass-lock checks, and fuel and supplies checks. The witch-space tunnel (a swirling FBM vortex tinted by the destination star and nebula) hides the next system's generation and baking. You exit in supercruise beside the new star, the route advances, and the next hop is targeted automatically. A jump takes 1 in-game day.
- **Logistics** (`src/player.ts`): a 40 t fuel tank; fuel scooping in a star's corona (rate rises toward the surface); 80 supplies with 2 used per jump; refuel and resupply at stations with **R** (free until the Phase 5 economy). Every system has a station and a star, so the player can never get stranded.
- **Saves** (`src/save/`): versioned `SaveData` (seed + deltas: system, frame-relative ship state, fuel and supplies, visited systems, route, target) with a migration hook and strict validation of untrusted JSON. Stored in IndexedDB with a localStorage fallback. Slots are autosave (on arrival, every 5 min, and on tab hide), quicksave (F5/F9) and 3 manual slots, with export/import as JSON files.
- **Menus** (`src/ui/menu.ts`): title screen (Continue, New expedition with galaxy seed, Load, Settings); pause on Esc or when the pointer is released (Resume, Save, Load, Settings, Exit).
- **Audio** (`src/audio/audio.ts`): fully synthesised WebAudio (engine rumble tied to throttle, supercruise drone, frame-shift charge whine, hyperspace roar, arrival boom, scoop hiss, UI blips), with no asset files. This pulls part of the Phase 9 audio work forward.

### Phase 3 — Ships & Fitting (Weeks 6–8)
- Content defs (JSON): 12 hulls (3 per size), 20 weapons, 15 hullmods
- Procedural ship mesh builder with faction styles
- Refit screen with OP budgeting, live stats
- Fleet roster
- **Demo**: own multiple ships, refit them, see visual weapons mounted.

### Phase 4 — Combat (Weeks 9–13)  ⚠ highest-risk phase
- Weapons/projectiles/beams/missiles with pooling
- Flux, shields, armor grid, hull, overloads, venting
- Player flagship control + weapon groups
- Ship AI (behavior trees) + fleet commander AI
- Tactical pause overlay & orders
- Encounters (pirates), post-combat salvage & recovery
- **Demo**: 5v5 fleet battle with tactical orders that feels good.

### Phase 5 — Economy Core (Weeks 14–17)
- Commodities, markets, industries, daily production tick in worker
- Dynamic pricing, legality, tariffs; market UI
- NPC trade convoys as real fleets in galaxy sim
- **Demo**: profitable trade route that dries up if you over-exploit it.

### Phase 6 — Factions & Missions (Weeks 18–21)
- Faction defs, relations, reputation, commissions
- Strategic AI: patrols, raids, wars, territory shifts
- Procedural missions & bar/contact system; Intel feed
- **Demo**: a war breaks out, prices spike, player profits from smuggling or takes a commission.

### Phase 7 — Planet Surfaces (Weeks 22–26)
- Landing transition (orbit → atmospheric entry → surface scene)
- Chunked heightfield terrain, biomes, instanced flora, simple fauna
- On-foot controller + mining tool + scanner; POIs (ruins, crash sites)
- Codex/discovery data economy
- **Demo**: land, explore, mine, discover ruins, sell data.

### Phase 8 — Colonies & Endgame (Weeks 27–31)
- Survey → outpost → colony; industries; growth; defenses
- Blueprints & ship production at owned colonies
- Remnant/Precursor fringe content, ancient gates
- **Demo**: own a thriving colony, defend it from a raid.

### Phase 9 — Polish & Content (Weeks 32+)
- Officers & skills, story arcs, audio pass, tutorial
- Performance pass (WebGPU renderer eval, worker offloads), settings, accessibility, keybinds
- Balance tooling (sim-run headless economy for 10 in-game years, graph prices)

---

## 8. Data / Content Pipeline
- All content in `src/content/*.json` validated by TypeScript types + a zod schema at load.
- Hot-reload content in dev (Vite HMR).
- Debug panel (`lil-gui`) for tuning ship stats, spawning fleets, warping, adding credits, fast-forwarding sim.

## 9. Save System
```ts
interface SaveGame {
  version: number; galaxySeed: number; timeDays: number;
  player: { credits, fleet: ShipInstance[], cargo, reputation, skills, location };
  deltas: { discovered: Set<id>, depleted: Record<id, amt>, colonies: Colony[], destroyedStations: id[] };
  sim: { markets: MarketState[], factions: FactionState[], fleets: NpcFleetState[] };
}
```
Autosave on dock/jump; 3 manual slots; export/import as JSON file.

## 10. Testing Strategy
- **Determinism tests**: same seed → identical galaxy/system/planet output (snapshot hashes).
- **Economy tests**: headless N-day sim stays within price bounds; no runaway stock; no infinite-money loops.
- **Combat unit tests**: damage-type math, flux, armor grid distribution.
- **Smoke E2E**: boot → new game → jump → dock → land → save → load.

## 11. Risks & Mitigations
| Risk | Mitigation |
|---|---|
| Scope explosion | Strict phase gates; every phase shippable; cut Phase 7/8 scope before cutting combat feel. |
| Float precision / huge scales | Floating origin + per-system scenes + log depth from Phase 1. |
| Combat AI quality | 2D combat plane; behavior trees with debug visualization; dedicated tuning time. |
| Browser perf in big fights | InstancedMesh + pooling, cap ship counts by settings, profile early (Phase 4). |
| Economy degenerate states | Headless sim tests + balance graphs from day one of Phase 5. |
| Main-thread jank from sim | Worker-hosted sim; main thread only renders + inputs. |

## 12. Definition of Done for v1.0
- 500+ system galaxy, 8 factions, 16 commodities, 24 hulls, 40 weapons, 25 hullmods
- Hybrid fleet combat with tactical pause, salvage, recovery
- Living economy + faction wars running in background
- Landable planets with surfaces, POIs, mining, codex
- Player colonies & ship production
- Save/load, settings, tutorial, 60 FPS on mid-range hardware

---

## 13. Open Questions (to decide later)
1. Game title & lore tone (serious hard-ish sci-fi vs. pulpy).
2. Permadeath / ironman mode option?
3. Should the player be able to leave their ship and board other ships/stations on foot (interior scenes)?
4. Modding support (load external content JSON)?
5. Gamepad support priority?
