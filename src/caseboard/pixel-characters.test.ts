import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import PixelSprite from './PixelSprite'
import { characterDesigns, characterVariant } from './pixel-characters'

test('200 位人物都能繪製，去除顏色和編號後仍有 200 種不同圖形', () => {
  assert.equal(characterDesigns.length, 200)
  assert.equal(new Set(characterDesigns.map(design => design.name)).size, 200)
  const drawings = characterDesigns.map(design => renderToStaticMarkup(createElement(PixelSprite, { seed: 'same-catalogue-skin-and-hair', variant: design.id })))
  assert.equal(new Set(drawings.map(svg => svg.replace(/fill="[^"]*"/g, 'fill="color"').replace(/data-character="\d+"/g, 'data-character="index"'))).size, 200)
  assert.ok(drawings.every(svg => svg.includes('xmlns="http://www.w3.org/2000/svg"') && svg.includes('viewBox="0 0 16 24"') && !svg.includes('undefined') && !svg.includes('NaN')))
  assert.equal(characterVariant('same', -1), 199)
  assert.equal(characterVariant('same', 200), 0)
  assert.equal(characterVariant('same', NaN), characterVariant('same'))
})
