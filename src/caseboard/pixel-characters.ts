export type HairStyle = 'crop' | 'side' | 'bob' | 'long' | 'curly' | 'bun' | 'double-bun' | 'spiky' | 'braid' | 'ponytail' | 'wave' | 'beard'
export type HatStyle = 'none' | 'cap' | 'brim' | 'hood' | 'headphones' | 'beret' | 'beanie' | 'newsboy' | 'chef' | 'tophat' | 'bonnet'
export type GarmentStyle = 'jacket' | 'overalls' | 'vest' | 'coat' | 'stripes' | 'apron' | 'sport' | 'sweater' | 'dress' | 'raincoat'
export type PropStyle = 'bag' | 'plant' | 'book' | 'map' | 'record' | 'palette' | 'cup' | 'camera' | 'staff' | 'backpack' | 'newspaper' | 'umbrella' | 'wrench' | 'flowers' | 'sketchbook' | 'starbag' | 'rod' | 'bread' | 'bouquet' | 'telescope' | 'guitar' | 'raindrop' | 'mask' | 'lantern'
export interface CharacterDesign { id: number; name: string; hair: HairStyle; hat: HatStyle; garment: GarmentStyle; prop: PropStyle; edition: number; color: number }
type BaseDesign = readonly [string, HairStyle, HatStyle, GarmentStyle, PropStyle]
const bases: readonly BaseDesign[] = [
  ['郵差', 'crop', 'cap', 'jacket', 'bag'], ['園丁', 'bob', 'brim', 'overalls', 'plant'],
  ['書店店員', 'side', 'none', 'vest', 'book'], ['旅人', 'long', 'hood', 'coat', 'map'],
  ['唱片收藏者', 'crop', 'headphones', 'stripes', 'record'], ['畫家', 'curly', 'beret', 'apron', 'palette'],
  ['咖啡師', 'bun', 'none', 'apron', 'cup'], ['攝影師', 'spiky', 'none', 'jacket', 'camera'],
  ['登山客', 'crop', 'beanie', 'sport', 'staff'], ['學生', 'side', 'none', 'sweater', 'backpack'],
  ['報童', 'crop', 'newsboy', 'vest', 'newspaper'], ['圍巾客', 'bob', 'none', 'coat', 'umbrella'],
  ['修理工', 'crop', 'cap', 'overalls', 'wrench'], ['長髮客', 'long', 'none', 'dress', 'flowers'],
  ['捲髮客', 'curly', 'none', 'stripes', 'sketchbook'], ['雙髻客', 'double-bun', 'none', 'dress', 'starbag'],
  ['漁人', 'beard', 'brim', 'vest', 'rod'], ['烘焙師', 'bun', 'chef', 'apron', 'bread'],
  ['花店店員', 'braid', 'none', 'apron', 'bouquet'], ['觀星者', 'side', 'beanie', 'coat', 'telescope'],
  ['街頭樂手', 'spiky', 'beret', 'jacket', 'guitar'], ['雨天旅人', 'ponytail', 'hood', 'raincoat', 'raindrop'],
  ['劇場演員', 'wave', 'tophat', 'coat', 'mask'], ['夜班守望者', 'beard', 'cap', 'coat', 'lantern'],
]
const lightHair: Record<HairStyle, HairStyle> = { crop: 'side', side: 'spiky', bob: 'ponytail', long: 'braid', curly: 'wave', bun: 'bob', 'double-bun': 'bun', spiky: 'crop', braid: 'long', ponytail: 'double-bun', wave: 'curly', beard: 'side' }
const warmHair: Record<HairStyle, HairStyle> = { crop: 'curly', side: 'wave', bob: 'long', long: 'ponytail', curly: 'crop', bun: 'braid', 'double-bun': 'ponytail', spiky: 'side', braid: 'double-bun', ponytail: 'bob', wave: 'long', beard: 'beard' }
const lightHat: Record<HatStyle, HatStyle> = { none: 'beret', cap: 'none', brim: 'bonnet', hood: 'cap', headphones: 'none', beret: 'none', beanie: 'cap', newsboy: 'none', chef: 'chef', tophat: 'beret', bonnet: 'none' }
const warmHat: Record<HatStyle, HatStyle> = { none: 'beanie', cap: 'hood', brim: 'cap', hood: 'brim', headphones: 'beanie', beret: 'brim', beanie: 'hood', newsboy: 'beanie', chef: 'bonnet', tophat: 'tophat', bonnet: 'hood' }
const lightGarment: Record<GarmentStyle, GarmentStyle> = { jacket: 'vest', overalls: 'apron', vest: 'sweater', coat: 'jacket', stripes: 'vest', apron: 'overalls', sport: 'stripes', sweater: 'sport', dress: 'apron', raincoat: 'vest' }
const warmGarment: Record<GarmentStyle, GarmentStyle> = { jacket: 'coat', overalls: 'jacket', vest: 'coat', coat: 'raincoat', stripes: 'sweater', apron: 'coat', sport: 'jacket', sweater: 'coat', dress: 'dress', raincoat: 'coat' }
const editionNames = ['', '輕裝・', '暖衣・', '工坊・', '週末・', '夜遊・', '花日・', '雨季・', '遠行・']
/** Preserve the first 72 catalog IDs; extend to 200 with different shapes and accessories. */
export const characterDesigns: readonly CharacterDesign[] = Array.from({ length: 9 }, (_, index) => index).flatMap(edition => bases.map(([name, hair, hat, garment, prop], index) => ({
  id: edition * bases.length + index,
  name: `${editionNames[edition]}${name}`,
  hair: edition % 3 === 1 ? lightHair[hair] : edition % 3 === 2 ? warmHair[hair] : hair,
  hat: edition % 3 === 1 ? lightHat[hat] : edition % 3 === 2 ? warmHat[hat] : hat,
  garment: edition % 3 === 1 ? lightGarment[garment] : edition % 3 === 2 ? warmGarment[garment] : garment,
  prop, edition, color: (index + edition * 3) % 12,
}))).slice(0, 200)
export const characterNames = characterDesigns.map(design => design.name)
export function spriteSeed(seed: string): number {
  let value = 2166136261
  for (let index = 0; index < seed.length; index++) value = Math.imul(value ^ seed.charCodeAt(index), 16777619)
  return value >>> 0
}
export function characterVariant(seed: string, variant?: number): number { return variant === undefined || !Number.isFinite(variant) ? spriteSeed(seed) % characterNames.length : ((Math.trunc(variant) % characterNames.length) + characterNames.length) % characterNames.length }
/** A bounded logarithmic scale keeps sparse and busy connections legible. */
export function relationWidth(strength: number): number { return 1.1 + Math.min(6, Math.log2(1 + Math.max(0, Number.isFinite(strength) ? strength : 0)) * .7) }
