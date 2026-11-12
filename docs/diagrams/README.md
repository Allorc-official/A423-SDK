# A423 diagram images

These are pre-rendered documentation images. Reading the main README needs no Mermaid renderer, JavaScript or diagram dependency. PNGs work in ordinary Markdown/image viewers; SVGs remain sharp when zoomed.

| Image | Explains |
|---|---|
| [Architecture PNG](./architecture.png) / [SVG](./architecture.svg) | Application backend, SDK, private policy/storage, RPC and escrow custody |
| [Job lifecycle PNG](./job-lifecycle.png) / [SVG](./job-lifecycle.svg) | Primary job states, funding, completion, dispute, closing and refund paths |
| [Cancellation PNG](./cancellation.png) / [SVG](./cancellation.svg) | Counteroffers, signed acceptance, saved JSON, execution, confirmation and receipts |
| [Reopening PNG](./reopening.png) / [SVG](./reopening.svg) | Pre-funding eligibility, required approvals, fresh generation and agreement |

The state chart shows primary paths; the [README action tables](../../README.md) and implementation define exact roles, deadlines, generation/revision guards and pending-operation restrictions. The cancellation diagram shows the staged dual-signature path, not the legacy direct-counterparty shortcut. A receipt follows actual confirmed transfers, not mere acceptance or broadcast.

## Editing and regeneration

Edit the matching `.dot` source, then regenerate the SVG and PNG together. These rendering packages are documentation tools, not SDK runtime dependencies:

```sh
# From the source repository. Keep these tools out of package.json/package-lock.json.
npm install --no-save --package-lock=false --ignore-scripts @viz-js/viz@3.31.0 @resvg/resvg-js@2.6.2
node docs/diagrams/render.mjs
```

The renderer uses Graphviz's CPU/WASM layout and a local SVG-to-PNG renderer; it needs no browser or chain connection. Use DejaVu Sans or an appropriate installed sans-serif font. Inspect every PNG after changing labels or routes. PNG width is 2200 pixels; SVG retains vector text/paths.

The main README embeds absolute `raw.githubusercontent.com` PNG URLs for hosted Markdown readers and also links local PNG/SVG files. Push these assets and the README together before expecting those public URLs to load. For offline reading, use the local image links. A package installation does not publish images to GitHub.
