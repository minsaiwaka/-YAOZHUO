/*
 * Original SHIJI demo illustrations, drawn on an integer pixel grid.
 * Rebuild: node scripts/caseboard-demo-art.cjs
 * No downloaded images, fonts, game sprites, or other external art are used.
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const sharp = require('sharp')

const colors = {
  ink: '#2b1211', dark: '#493426', brown: '#705338', wood: '#9a7750',
  rust: '#9a4b20', clay: '#b37d50', gold: '#b88612', ochre: '#b29b62',
  paper: '#d7cdb5', cream: '#e4d8b8', beige: '#c7b895',
  green: '#727a57', sage: '#9b9f7b', pine: '#4f5d49', shadow: '#8b8066',
}

function canvas(width, height, background) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">`]
  const rect = (x, y, w, h, color) => parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${colors[color] || color}"/>`)
  const shape = (d, color) => parts.push(`<path d="${d}" fill="${colors[color] || color}"/>`)
  const checker = (x, y, w, h, color, gap = 4) => {
    for (let row = 0; row < h; row += gap) for (let col = 0; col < w; col += gap) {
      if (((row / gap) + (col / gap)) % 2 === 0) rect(x + col, y + row, 1, 1, color)
    }
  }
  rect(0, 0, width, height, background)
  return { rect, shape, checker, finish: () => Buffer.from(parts.join('') + '</svg>') }
}

const alphabet = {
  B: ['110', '101', '110', '101', '110'], O: ['010', '101', '101', '101', '010'],
  K: ['101', '101', '110', '101', '101'], S: ['011', '100', '010', '001', '110'],
}
function pixelWord(scene, word, x, y, color) {
  [...word].forEach((letter, index) => {
    const rows = alphabet[letter]
    if (!rows) return
    rows.forEach((row, cy) => [...row].forEach((pixel, cx) => { if (pixel === '1') scene.rect(x + index * 4 + cx, y + cy, 1, 1, color) }))
  })
}

function bookshop() {
  const art = canvas(96, 72, 'paper')
  const { rect, shape, checker } = art
  checker(0, 0, 96, 65, '#b9ad8b', 6)
  rect(0, 65, 96, 7, '#b7ad92')
  rect(0, 66, 96, 1, '#8b8066')
  rect(17, 67, 70, 2, '#97886c')
  rect(19, 69, 73, 1, '#aaa084')
  rect(16, 9, 65, 56, 'dark')
  rect(18, 10, 61, 53, '#b29d75')
  rect(73, 10, 6, 53, '#967e59')
  rect(14, 7, 69, 3, 'brown')
  rect(17, 5, 63, 2, 'dark')
  rect(19, 4, 59, 1, '#9b8661')
  rect(18, 10, 61, 1, '#c4ad7e')
  rect(27, 13, 44, 10, 'dark')
  rect(28, 14, 42, 8, '#59452e')
  rect(29, 15, 1, 6, 'ochre')
  rect(68, 15, 1, 6, 'ochre')
  pixelWord(art, 'BOOKS', 39, 16, 'cream')
  rect(18, 24, 61, 2, 'dark')
  for (let index = 0; index < 9; index++) {
    rect(13 + index * 8, 26, 8, 4, index % 2 ? '#c8b382' : 'rust')
    rect(13 + index * 8, 30, 8, 3, index % 2 ? '#b7a073' : '#73391f')
    rect(14 + index * 8, 33, 6, 1, index % 2 ? '#a58c60' : '#622d1e')
  }
  rect(20, 35, 28, 27, 'brown')
  rect(22, 36, 24, 23, 'pine')
  rect(23, 37, 22, 8, '#747b59')
  rect(23, 46, 22, 11, '#535e46')
  rect(23, 44, 22, 2, '#a58c5b')
  rect(23, 56, 22, 2, '#a58c5b')
  const books = [
    [24, 39, 3, 5, '#a98649'], [28, 38, 2, 6, '#bdab7e'], [31, 40, 3, 4, '#8f5636'],
    [35, 38, 2, 6, '#c6b68b'], [38, 39, 3, 5, '#8a7550'], [42, 37, 2, 7, '#9c6b3b'],
    [24, 49, 3, 7, '#a96236'], [28, 50, 2, 6, '#ba9b58'], [31, 48, 3, 8, '#b4ae80'],
    [35, 51, 4, 5, '#876340'], [40, 49, 3, 7, '#b09c6f'],
  ]
  for (const book of books) { rect(...book); rect(book[0], book[1] + 2, book[2], 1, '#c6b996') }
  rect(33, 36, 1, 22, '#aa986c')
  rect(22, 36, 1, 23, '#c5b388')
  rect(23, 59, 23, 2, '#8f7650')
  rect(50, 34, 21, 30, 'dark')
  rect(52, 35, 17, 28, '#886a43')
  rect(54, 37, 13, 17, 'dark')
  rect(55, 38, 11, 15, '#6e795e')
  rect(56, 39, 2, 6, '#a0a27c')
  rect(59, 38, 1, 15, '#9f8c60')
  rect(55, 46, 11, 1, '#9f8c60')
  rect(64, 56, 2, 3, 'gold')
  rect(54, 57, 8, 4, '#a07e4b')
  rect(48, 64, 25, 2, '#7a6a50')
  rect(50, 63, 21, 1, '#c4b18b')
  rect(74, 36, 4, 11, 'cream')
  rect(75, 38, 2, 1, 'rust')
  rect(75, 41, 2, 1, 'shadow')
  rect(75, 43, 1, 1, 'shadow')
  for (const [x, y] of [[20, 17], [75, 19], [21, 48], [76, 54], [43, 12], [19, 58], [72, 60]]) rect(x, y, 2, 1, '#9d855f')
  shape('M8 59v-9H5v-5h4v3h2V39h3v7h4v4h-5v9Z', 'pine')
  rect(10, 44, 3, 15, 'green')
  rect(5, 45, 2, 3, 'sage')
  rect(14, 46, 3, 2, 'sage')
  rect(7, 58, 10, 3, 'rust')
  rect(8, 61, 8, 4, '#89502d')
  rect(9, 61, 1, 3, '#bc8050')
  rect(85, 55, 1, 10, '#7b684d')
  shape('M82 54h8v-9h-8Zm1-1v-7h6v7Z', 'brown')
  rect(83, 46, 6, 7, '#b99e63')
  rect(84, 48, 4, 1, 'cream')
  rect(84, 50, 3, 1, 'cream')
  checker(1, 68, 95, 4, '#8d8268', 5)
  return art.finish()
}

function cat() {
  const art = canvas(48, 48, 'paper')
  const { rect, shape, checker } = art
  checker(2, 2, 44, 44, '#c3b797', 5)
  rect(5, 6, 2, 2, 'ochre')
  rect(4, 7, 4, 1, 'ochre')
  rect(6, 5, 1, 4, 'ochre')
  rect(8, 43, 33, 2, '#b4a582')
  shape('M9 18V9h2V6h5v3h3v5h11V9h3V6h5v3h2v9h3v4h2v13h-3v5h-4v4H11v-3H7v-5H4V23h2v-5Z', 'dark')
  shape('M10 19V10h2V8h3v3h3v5h14v-5h3V8h2v3h2v9h3v4h1v10h-3v5h-4v3H12v-3H8v-5H6V24h2v-5Z', '#a97645')
  rect(11, 13, 3, 6, '#c68b6b')
  rect(12, 11, 1, 2, '#c68b6b')
  rect(35, 12, 2, 7, '#c68b6b')
  rect(34, 14, 1, 3, '#c68b6b')
  shape('M15 17h18v2h6v4h2v9h-3v6h-5v3H15v-3h-5v-7H8v-8h3v-4h4Z', '#bb8b56')
  rect(22, 16, 2, 6, '#805630')
  rect(27, 16, 2, 5, '#805630')
  rect(17, 17, 2, 4, '#805630')
  shape('M17 29h14v2h4v4h-3v3H17v-2h-3v-5h3Z', '#d8bb86')
  rect(14, 25, 5, 4, 'dark')
  rect(15, 24, 3, 1, 'dark')
  rect(30, 25, 5, 4, 'dark')
  rect(31, 24, 3, 1, 'dark')
  rect(15, 25, 1, 1, 'cream')
  rect(31, 25, 1, 1, 'cream')
  rect(11, 30, 3, 2, '#bc8263')
  rect(35, 30, 3, 2, '#bc8263')
  rect(23, 30, 4, 2, '#805036')
  rect(24, 32, 2, 2, '#805036')
  rect(20, 34, 4, 1, '#805036')
  rect(26, 34, 4, 1, '#805036')
  rect(19, 33, 1, 1, '#805036')
  rect(30, 33, 1, 1, '#805036')
  rect(4, 29, 7, 1, 'brown')
  rect(5, 33, 6, 1, 'brown')
  rect(38, 29, 7, 1, 'brown')
  rect(38, 33, 6, 1, 'brown')
  rect(13, 40, 23, 4, 'pine')
  rect(14, 40, 21, 2, 'green')
  rect(29, 42, 5, 6, 'pine')
  rect(30, 43, 3, 4, 'green')
  rect(30, 45, 3, 1, 'sage')
  rect(18, 40, 2, 2, 'sage')
  rect(40, 12, 2, 2, 'ochre')
  rect(41, 11, 1, 4, 'ochre')
  rect(39, 13, 4, 1, 'ochre')
  return art.finish()
}

function coffee() {
  const art = canvas(96, 72, '#cdc1a3')
  const { rect, shape, checker } = art
  checker(0, 0, 96, 29, '#baad8d', 5)
  rect(0, 23, 96, 3, '#9f8c68')
  shape('M0 30h16v-2h30v-2h27v-2h23v48H0Z', '#ac8c5f')
  shape('M0 36h16v-2h30v-2h27v-2h23v3H75v2H48v2H19v2H0Z', '#bd9d6c')
  shape('M0 62h22v-2h27v-2h27v-2h20v2H78v2H51v2H24v2H0Z', '#96734d')
  rect(0, 46, 96, 1, '#9c7c53')
  rect(14, 47, 1, 14, '#b99a67')
  rect(89, 34, 1, 10, '#b99a67')
  checker(1, 63, 94, 8, '#96734d', 6)
  rect(11, 30, 18, 2, '#8d7958')
  rect(15, 25, 12, 5, 'dark')
  rect(16, 25, 10, 4, '#9a4b20')
  rect(17, 29, 8, 2, '#7f4e2e')
  rect(18, 17, 5, 9, 'pine')
  rect(19, 12, 3, 6, 'green')
  rect(15, 16, 4, 3, 'pine')
  rect(14, 14, 3, 3, 'sage')
  rect(22, 17, 4, 3, 'green')
  rect(24, 14, 3, 4, 'sage')
  rect(20, 20, 1, 5, 'sage')
  shape('M10 44h16v-2h17v18H28v2H10Z', '#7f7651')
  shape('M12 42h13v1h3v-1h14v15H29v2H12Z', 'brown')
  shape('M13 43h12v1h2v13h-3v-1H13Z', '#e0d2a8')
  shape('M28 44h3v-1h10v13H30v1h-2Z', '#cebd91')
  rect(26, 45, 1, 11, '#ad9767')
  rect(15, 46, 8, 1, '#b9a575')
  rect(15, 49, 8, 1, '#b9a575')
  rect(15, 52, 6, 1, '#b9a575')
  rect(31, 46, 7, 1, '#ac9668')
  rect(31, 49, 7, 1, '#ac9668')
  rect(31, 52, 5, 1, '#ac9668')
  rect(34, 43, 2, 7, '#9a4b20')
  rect(34, 50, 1, 1, '#9a4b20')
  shape('M51 44h5v-4h21v3h6v4h4v10h-4v4H56v-3h-6v-4h-3v-6h4Z', '#8a714e')
  shape('M52 44h6v-3h17v3h7v4h3v7h-5v4H58v-3h-6v-3h-3v-5h3Z', '#cdbd93')
  shape('M56 46h3v-2h16v3h5v7h-4v3H59v-2h-4v-6h1Z', '#e1d2ab')
  rect(76, 37, 8, 12, 'dark')
  rect(78, 39, 4, 8, '#cdbd93')
  rect(78, 41, 2, 4, '#9a7750')
  shape('M57 36h3v-2h14v2h4v15h-3v4H61v-3h-4Z', 'dark')
  shape('M59 37h2v-1h12v1h3v13h-3v3H62v-3h-3Z', '#d7c8a0')
  rect(59, 37, 17, 6, '#ad9b72')
  rect(61, 37, 13, 5, '#58402b')
  rect(62, 38, 10, 2, '#6e4b2b')
  rect(62, 38, 4, 1, '#bf9a61')
  rect(60, 44, 2, 5, '#ede0bc')
  rect(63, 51, 10, 1, '#b8a176')
  shape('M64 31v-4h2v-4h-2v-4h2v4h2v4h-2v4Z', '#e0d5b6')
  shape('M71 30v-3h2v-4h-2v-3h2v3h2v4h-2v3Z', '#dbd0b1')
  shape('M50 59h2v3h2v3h2v3h-2v-2h-2v-3h-2Z', 'dark')
  rect(50, 59, 2, 2, 'gold')
  rect(55, 67, 1, 2, 'cream')
  rect(87, 61, 2, 2, '#c4a675')
  rect(82, 65, 1, 1, '#c4a675')
  return art.finish()
}

async function main() {
  const outputDirectory = path.resolve(__dirname, '..', 'public', 'caseboard')
  await fs.mkdir(outputDirectory, { recursive: true })
  const artworks = [['demo-book.png', bookshop()], ['demo-cat.png', cat()], ['demo-coffee.png', coffee()]]
  for (const [name, source] of artworks) {
    const output = path.join(outputDirectory, name)
    await sharp(source).png({ compressionLevel: 9, palette: true }).toFile(output)
    process.stdout.write(`Created ${path.relative(process.cwd(), output)}\n`)
  }
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 })
