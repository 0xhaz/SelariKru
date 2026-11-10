# Third-party notices

## jsm-hq (MIT)

Parts of this app's layout, pixel theme and office canvas are adapted from the jsm-hq project, which is published under the MIT licence. Each adapted file carries the header comment "Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md". The adapted code was rewritten to run on SelariKru's own data sources and state; SelariKru is not affiliated with or endorsed by the authors of jsm-hq.

Adapted files:

- `src/theme/tokens.ts`, `src/theme/fonts.ts`
- `src/index.css` (the pixel panel, button, chip, field and font-switch rules)
- `src/office/**` except `src/office/model.ts` (engine, layout, drawing, actors, scene, input; drawn on a 2D canvas instead of PixiJS)
- `src/shell/ui-store.ts`, `src/shell/shortcuts.ts`
- `src/shell/hud/TopBar.tsx`, `ActivityFeed.tsx`, `ConnectionBanner.tsx`, `Tooltip.tsx`, `ViewDrawer.tsx`, `Portrait.tsx`
- `src/features/settings/SettingsPage.tsx` (the settings tab layout)

The office's data model (`src/office/model.ts`), the activity feed's model (`src/shell/hud/activity.ts`) and the office screen's text panel (`src/shell/hud/OfficeHome.tsx`) are SelariKru's own.

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
