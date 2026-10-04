# Spacegame

A 3D space exploration & commerce sim in Three.js: No Man's Sky-style procedural exploration meets Starsector-style fleets, fitting and a living faction economy.

See **[docs/SUPERPLAN.md](docs/SUPERPLAN.md)** for the full design and phased roadmap. **Phases 1–2 are playable:** a procedural galaxy of about 670 star systems you can chart, jump between, and save your progress in.

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

URL options: `?galaxy=1337` pre-fills the galaxy seed on the title screen, `?new=1` skips the title and starts a new expedition, and `?q=low|medium|high` sets the graphics quality (cycle in-game with **F4**).

## Controls
| Key | Action |
|---|---|
| Click | Capture mouse (take the helm) |
| Mouse | Look: the ship turns and flies wherever you point |
| Right mouse (hold) | Free look without turning the ship |
| W / S, X | Throttle up / down, cut throttle |
| Q / E | Roll |
| A / D, Space / Ctrl | Strafe (fine manoeuvring, e.g. near stations) |
| Shift | Boost |
| J | Supercruise: charge & engage / drop. **With a system targeted: hyperjump** |
| T, [ / ] | Target what's ahead (including neighbouring stars), cycle targets |
| G | Auto-align to target |
| M | System map (click to select, **Set target**) |
| N | Galaxy map (search, **Plot route**) |
| R | Refuel & resupply when near a station |
| C | Camera distance |
| F5 / F9 | Quicksave / quickload |
| Esc | Pause menu (save, load, settings) |
| H, F3, F4, F6 | Help, FPS, graphics quality, mute |

Prefer the old virtual-joystick steering, inverted Y or a different mouse sensitivity? Change them under **Esc → Settings**; they're remembered per browser.

**Travelling between stars:**
1. Open the galaxy map (**N**), pick a system and choose **Plot route**. The first hop becomes your hyperspace target.
2. Fly clear of planets and stations (mass lock), then press **J**.
3. Line the reticle up with the target (or press **G**) during the 5 s charge.
4. You exit in supercruise next to the new star, with the next hop already targeted.

**Running low on fuel?** Skim a star's corona to scoop, or press **R** at any station.

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
```
