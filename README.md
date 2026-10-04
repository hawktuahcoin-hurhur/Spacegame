# Spacegame

A 3D space exploration & commerce sim in Three.js: No Man's Sky-style procedural exploration meets Starsector-style fleets, fitting and a living faction economy.

See **[docs/SUPERPLAN.md](docs/SUPERPLAN.md)** for the full design and phased roadmap. **Phases 1–2 are playable:** a procedural galaxy of about 670 star systems you can chart, jump between, and save your progress in.

## Run
```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest
npm run build    # typecheck + production build
```

URL options: `?galaxy=1337` pre-fills the galaxy seed on the title screen, `?new=1` skips the title and starts a new expedition, and `?q=low|medium|high` sets the graphics quality (cycle in-game with **F4**).

## Controls
| Key | Action |
|---|---|
| Click | Capture mouse (take the helm) |
| Mouse | Steer (virtual stick, eases back to centre) |
| W / S, X | Throttle up / down, cut throttle |
| A / D, Space / Ctrl | Strafe left / right, up / down |
| Q / E | Roll |
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
