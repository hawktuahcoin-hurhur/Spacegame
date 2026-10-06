# Spacegame

A 3D space exploration & commerce sim in Three.js: No Man's Sky-style procedural exploration meets Starsector-style fleets, fitting and a living faction economy.

See **[docs/SUPERPLAN.md](docs/SUPERPLAN.md)** for the full design and phased roadmap. **Phases 1–4 are playable:**
- a procedural galaxy of about 670 star systems you can chart and jump between,
- a fleet of procedurally built ships you can buy, refit and fly in formation,
- real-time fleet battles against pirates, with a tactical command view, salvage and recovery.

## Run
You need **Node.js 20.19+ or 22.12+**. Check with `node -v`, and get the LTS from [nodejs.org](https://nodejs.org) if yours is older.

```bash
git clone https://github.com/hawktuahcoin-hurhur/spacegame.git
cd spacegame
git checkout claude/vigilant-cannon-prg4tz   # the branch with the game
npm install        # once: downloads Vite, Three.js etc. into node_modules
npm run dev        # then open http://localhost:5173
```

Other commands: `npm test` (unit tests), `npm run build` (typecheck + production build), `npm run preview` (serve the build).

**Troubleshooting**
- **`'vite' is not recognized…` / `vite: not found`:** you haven't run `npm install` in this folder yet. `npm run dev` now detects this and tells you.
- **`Missing script: "dev"` or `ENOENT … package.json`:** you're in the wrong folder or on a branch without the game. `cd` into the project and check out the branch above.
- **Syntax errors from inside `node_modules`:** your Node.js is too old. Upgrade it, then delete `node_modules` and run `npm install` again.

URL options:
- `?galaxy=1337` pre-fills the galaxy seed on the title screen.
- `?new=1` skips the title and starts a new expedition.
- `?battle=1` drops you straight into the five-on-five demo battle.
- `?q=low|medium|high` sets the graphics quality (cycle in-game with **F4**).

## Controls
| Key | Action |
|---|---|
| Click | Capture mouse (take the helm) |
| Mouse | Look: the ship turns and flies wherever you point |
| Right mouse (hold) | Free look without turning the ship |
| W / S, X | Throttle up / down, cut throttle |
| Q / E | Roll |
| A / D, Space / Ctrl | Strafe (fine manoeuvring, e.g. near stations) |
| Shift | Boost: sprint at 10× top speed |
| J | Supercruise: charge & engage / drop, target or not. **With a reachable system targeted: hyperjump** (from supercruise, when lined up with it) |
| T, [ / ] | Target what's ahead (including neighbouring stars), cycle targets |
| G | Auto-align to target |
| M | System map (click to select, **Set target**) |
| N | Galaxy map (search, **Plot route**) |
| R | Dock when near a station: refit, shipyard, refuel |
| F | Fleet & refit screen (view-only until docked) |
| C | Camera distance |
| F5 / F9 | Quicksave / quickload |
| Esc | Pause menu (save, load, settings) |
| H, F3, F4, F6 | Help, FPS, graphics quality, mute |

**In combat** the flight controls stay the same (boost is off), plus:

| Key | Action |
|---|---|
| Left mouse | Fire the selected weapon group at the crosshair |
| Right mouse | Raise / lower shields (omni shields face the crosshair) |
| 1–5 | Select weapon group (main guns, missiles, point defence) |
| Shift + 1–5 | Toggle autofire for a group |
| F | Ship system (Burn Drive, Damper Field, Phase Skimmer…) |
| V | Vent flux: dump it fast, defenceless while venting |
| T / R | Target the enemy under the crosshair / cycle by distance |
| Tab | Tactical view: pause and give your fleet orders |
| J | Disengage into supercruise, once no hostile is within 8 km |

Prefer the old virtual-joystick steering, inverted Y or a different mouse sensitivity? Change them under **Esc → Settings**; they're remembered per browser.

**Travelling between stars:**
1. Open the galaxy map (**N**), pick a system and choose **Plot route**. The first hop becomes your hyperspace target.
2. Fly clear of planets and stations (mass lock), then press **J**.
3. Line the reticle up with the target (or press **G**) during the 5 s charge.
4. You exit in supercruise next to the new star, with the next hop already targeted.

**Building a fleet:**
1. Dock at a station with **R**.
2. In **Shipyard**, buy hulls (you start with ¢250,000).
3. In **Fleet & Refit**, click a slot marker on the 3D ship or a slot in the list, then pick a weapon. Hovering a weapon previews the stat changes.
4. Add hullmods, balance flux with vents, or hit **Autofit**.
5. **Make flagship** changes the ship you fly. The rest of the fleet escorts you.

Bigger fleets carry more fuel and cargo but burn more per jump, and they jump only as far as their shortest-ranged drive.

**Running low on fuel?** Skim a star's corona to scoop, or press **R** at any station.

**Fighting:**
- **Interdiction.** Pirates haunt frontier and fringe systems. In supercruise they may interdict you: a 5 s warning, then you're pulled out with them about 4 km ahead. Space near stations is patrolled and safe.
- **Flux is everything.**
  - Firing builds soft flux.
  - Damage your shield blocks becomes hard flux, which only drains with shields down.
  - At full flux you overload: shields and weapons go offline for a few seconds.
  - Back off, drop shields, or press **V** to vent.
- **Damage types.**
  - Kinetic breaks shields.
  - High explosive cracks armour.
  - Energy is all-round.
  - Frag shreds bare hull and missiles.
  - Armour is a grid around the hull, so keep hitting the side you've already stripped.
- **Tactical view (Tab).**
  - Pauses the battle.
  - Select ships, or drag to box-select.
  - Right-click empty space to **move**, an enemy to **attack**, or a friend to **escort**.
  - **H** holds position, **X** retreats, **C** clears orders.
- **Losing your flagship.** If it's disabled, you take command of your strongest surviving ship.
- **After a win.**
  - You salvage credits, fuel and supplies.
  - You can recover disabled hulls, both yours and theirs. They come back battered, with permanent **d-mods**.
  - Survivors keep their hull damage and lose some combat readiness (CR). CR recovers a little each jump.
  - At a station, **Services** offers full repairs, d-mod restoration, and a **combat simulator** for testing fits risk-free.

**Inside a system:** supercruise speed scales with your distance from the nearest surface, so you slow down automatically as you approach. With a target set, the ship drops out on arrival.

## Debugging
`window.game.debug` exposes helpers, for example:
```js
game.debug.anchors()                                         // list bodies
game.debug.goto('Yolisheo III', 2500, { view: 0.95 })        // altitude in metres; view 0 = look down, 1 = horizon
game.debug.lookAt('Yolisheo IV')
game.debug.supercruise()
game.debug.state()                                           // system, fuel, route, jump phase…
game.debug.neighbours()                                      // systems within jump range
game.debug.plot('Haitrex'); game.debug.alignToSystem()       // then press J
game.debug.warp(42)                                          // arrive instantly in system #42
game.debug.fight(1.2)                                        // pirates at 1.2× your fleet strength
game.debug.battle()                                          // the 5v5 demo battle
game.debug.spectate("Widow's Grin", [300, 150, 300])         // watch a combat ship; spectate() returns to chase
```
