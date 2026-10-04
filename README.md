# Spacegame

A 3D space exploration & commerce sim in Three.js: No Man's Sky-style procedural exploration meets Starsector-style fleets, fitting and a living faction economy.

See **[docs/SUPERPLAN.md](docs/SUPERPLAN.md)** for the full design and phased roadmap. **Phase 1 (a fully procedural star system) is playable.**

## Run
```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest
npm run build    # typecheck + production build
```

URL options: `?seed=60` picks a different star system, and `?q=low|medium|high` sets the graphics quality (cycle in-game with **F4**).

## Controls
| Key | Action |
|---|---|
| Click | Capture mouse (take the helm) |
| Mouse | Steer (virtual stick, eases back to centre) |
| W / S, X | Throttle up / down, cut throttle |
| A / D, Space / Ctrl | Strafe left / right, up / down |
| Q / E | Roll |
| Shift | Boost |
| J | Supercruise: charge & engage / drop |
| T, [ / ] | Target what's ahead, cycle targets |
| G | Auto-align to target |
| M | System map (click to select, **Set target**) |
| C | Camera distance |
| H, F3, F4 | Help, FPS, graphics quality |

Supercruise speed scales with your distance from the nearest surface, so you slow down automatically as you approach. With a target set, the ship drops out on arrival. Near planets and stations you are mass-locked; fly a few km clear first.

## Debugging
`window.game.debug` exposes helpers, for example:
```js
game.debug.anchors()                                         // list bodies
game.debug.goto('Yolisheo III', 2500, { view: 0.95 })        // altitude in metres; view 0 = look down, 1 = horizon
game.debug.lookAt('Yolisheo IV')
game.debug.supercruise()
```
