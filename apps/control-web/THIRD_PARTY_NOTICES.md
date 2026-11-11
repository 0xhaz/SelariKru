# Third-party notices

## jsm-hq (MIT)

Parts of this app's screen layout, its UI building blocks and the office canvas engine are adapted from the jsm-hq project, which is published under the MIT licence. Each file that still contains adapted code starts with a header comment saying "Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md", which names the part that is adapted where only part is. The adapted code was rewritten to run on SelariKru's own data sources and state; SelariKru is not affiliated with or endorsed by the authors of jsm-hq.

Since H7 (11 Nov 2026) the look is SelariKru's own: the palette, the panel style, the worker robots, the office room (a kedai shophouse studio), its props and its live drawing are redrawn. No hex colour from anywhere in the reference's src remains in this app's `src` (`src/theme/palette.test.ts`), and every file under `src/office` and `src/theme` without the header shares at most two code lines with the reference (`src/office/originality.test.ts`; both checks re-read the reference when a checkout of it is present). What stays adapted is the screen layout pattern (top bar, team cards, activity feed, right-side drawers, Action items, the Settings modal) and the office engine.

Files that still contain adapted code:

- `src/index.css` (the names of the panel, button, chip, field, kbd and led building blocks, and the Pixel/Clean/Mono font switch; their look and the motion rules are SelariKru's)
- `src/theme/fonts.ts` (the font switch)
- `src/office/engine/camera.ts`, `font.ts`, `path.ts`, `pen.ts`, `random.ts` (camera, 3×5 bitmap font, path finding, pixel pen, seeded random)
- `src/office/layout/layout.ts` (the room-module tile layout; the rooftop deck and its stair are SelariKru's)
- `src/office/OfficeScene.ts`, `src/office/OfficeCanvas.tsx`, `src/office/sceneInput.ts` (scene loop, canvas host, pointer input; the event dispatch is SelariKru's)
- `src/office/actors/bots.ts` (walking and the idle kopi-and-wander errands; the event-driven errands and the roof route are SelariKru's), `effects.ts` (floating text, burst pixels and the envelope flight; the tiffin fly-back is SelariKru's), `parcels.ts` (parcels on the lane), `planNotes.ts` (plan notes and their glide)
- `src/office/draw/overlay.ts` (only which emote a robot shows for its state, and the name tag on hover)
- `src/shell/AppShell.tsx` (the app's composition and keyboard handling, from the reference's App.tsx), `src/shell/ui-store.ts`, `src/shell/shortcuts.ts`
- `src/shell/hud/TopBar.tsx`, `ActivityFeed.tsx`, `ConnectionBanner.tsx`, `Tooltip.tsx`, `ViewDrawer.tsx`, `Portrait.tsx`, `DebugPanel.tsx`
- `src/features/settings/SettingsPage.tsx` (the settings tab layout)
- `src/features/team/TeamPanel.tsx` (the floating agent-card column; the panel's data and wording are SelariKru's)

SelariKru's own, with no adapted code: `src/theme/tokens.ts`, `src/office/engine/palette.ts`, `src/office/draw/robots.ts`, `static.ts`, `furniture.ts` and `live.ts`, `src/office/events.ts`, `src/office/actors/errands.ts`, `src/shell/playback.ts`, the top bar's mark, the office's data model (`src/office/model.ts`), the activity feed's model (`src/shell/hud/activity.ts`) and the office screen's text panel (`src/shell/hud/OfficeHome.tsx`).

```
MIT License

Copyright (c) 2026 JavaScript Mastery

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts (SIL Open Font License 1.1)

Pixelify Sans, VT323, Inter and JetBrains Mono are bundled from the `@fontsource` packages, each under the SIL Open Font License 1.1. Their licence texts ship in each package's `LICENSE` file.
