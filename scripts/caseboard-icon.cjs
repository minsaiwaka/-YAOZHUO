// Original 32×32 jade-green pixel symbol, enlarged with nearest-neighbour sampling.
// Rebuild the 512px app icon: node scripts/caseboard-icon.cjs
// Uses no font, downloaded asset, or game artwork.
const fs = require('node:fs/promises')
const path = require('node:path')
const sharp = require('sharp')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" shape-rendering="crispEdges">
  <rect width="32" height="32" fill="#c1d9cd"/>
  <path d="M4 1h24v1h2v2h1v24h-1v2h-2v1H4v-1H2v-2H1V4h1V2h2Z" fill="#7eaf96"/>
  <path d="M4 3h24v1h1v24h-1v1H4v-1H3V4h1Z" fill="#c1d9cd"/>
  <path d="M4 3h9v1H4Zm23 1h1v8h-1ZM4 21h1v6H4Zm16 7h8v1h-8Z" fill="#234b43"/>
  <path d="M8 10h3v3h3v3h4v-3h3v-3h3v4h-3v3h-3v8h-4v-8h-3v-3H8Z" fill="#234b43"/>
  <path d="M10 13h1v2h3v2h1v6h-1v-5h-2v-2h-2Zm12 0h2v2h-2Z" fill="#7eaf96"/>
  <path d="M6 6h6v1h1v5h-1v1H6v-1H5V7h1Zm15 0h6v1h1v5h-1v1h-6v-1h-1V7h1Z" fill="#234b43"/>
  <rect x="7" y="8" width="4" height="3" fill="#c1d9cd"/>
  <rect x="22" y="8" width="4" height="3" fill="#c1d9cd"/>
  <rect x="8" y="9" width="2" height="1" fill="#7eaf96"/>
  <rect x="23" y="9" width="2" height="1" fill="#7eaf96"/>
  <path d="M13 23h6v1h1v5h-1v1h-6v-1h-1v-5h1Z" fill="#234b43"/>
  <rect x="14" y="25" width="4" height="3" fill="#c1d9cd"/>
  <rect x="15" y="26" width="2" height="1" fill="#7eaf96"/>
  <rect x="15" y="16" width="2" height="2" fill="#c1d9cd"/>
  <path d="M6 18h2v1H6Zm0 3h2v1H6Zm18-4h2v1h-2Zm0 3h2v1h-2Zm-1 4h3v1h-3Z" fill="#7eaf96"/>
  <rect x="8" y="26" width="1" height="1" fill="#7eaf96"/>
  <rect x="23" y="27" width="1" height="1" fill="#7eaf96"/>
</svg>`

async function main() {
  const output = path.resolve(__dirname, '..', 'public', 'caseboard', 'icon.png')
  await fs.mkdir(path.dirname(output), { recursive: true })
  await sharp(Buffer.from(svg)).resize(512, 512, { kernel: 'nearest' }).png({ compressionLevel: 9, palette: true }).toFile(output)
  process.stdout.write(`Created ${path.relative(process.cwd(), output)} (512×512)\n`)
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 })
