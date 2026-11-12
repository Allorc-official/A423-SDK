# A423 visual guides

Each subject uses a format suited to the question being answered. The diagrams use a fixed grid, aligned text and short straight connectors. Exceptions and eligibility rules stay in tables rather than crossing the main process with branch lines.

| Image | Format | Question answered |
|---|---|---|
| [Architecture PNG](./architecture.png) / [SVG](./architecture.svg) | Layered capability map | What does each part of the stack do? |
| [Job process PNG](./job-lifecycle.png) / [SVG](./job-lifecycle.svg) | Four process phases plus exception matrix | What is the normal path, and what changes in an exception? |
| [Cancellation PNG](./cancellation.png) / [SVG](./cancellation.svg) | Responsibility swimlane | What do the parties, SDK and contract do at each phase? |
| [Reopening PNG](./reopening.png) / [SVG](./reopening.svg) | Decision table plus fresh-agreement steps | Who must approve, and when is reopening prohibited? |

The architecture is a capability map, not a literal call sequence. The process view groups primary job states; the [README action tables](../../README.md) and implementation define exact roles, deadlines, generation/revision guards and pending-operation restrictions. The cancellation swimlane depicts the staged dual-signature path, not the legacy counterparty shortcut. A final receipt requires confirmed transfer evidence.

## Editing and regeneration

Edit the matching `.json` content source. Layouts are defined in [render.mjs](./render.mjs), which produces self-contained SVG and 2200-pixel-wide PNG images. The renderer uses explicit coordinates and aligned tables; there is no automatic graph routing, browser or chain connection.

```sh
# Documentation tool only; do not change SDK runtime dependencies or the lockfile.
npm install --no-save --package-lock=false --ignore-scripts @resvg/resvg-js@2.6.2
node docs/diagrams/render.mjs
```

Use DejaVu Sans or an appropriate installed sans-serif font. Check text widths, row/card padding and all four PNGs after changes. Keep captions concise; put detailed guard conditions in the README tables instead of adding more connectors. Never let a diagram imply that acceptance, a pending operation or a broadcast hash proves payment.

Reading the guide needs no Mermaid support or JavaScript. PNGs work in ordinary Markdown/image viewers, and SVGs remain sharp when zoomed. The main README embeds hosted PNG URLs and also links local PNG/SVG files. Push images and README together before expecting public URLs to update; use the local links for offline reading.
