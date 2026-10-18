import { memo } from 'react'
import { characterDesigns, characterVariant, spriteSeed, type GarmentStyle, type HairStyle, type HatStyle, type PropStyle } from './pixel-characters'
import type { PersonKind } from './types'
interface PixelSpriteProps { seed: string; kind?: PersonKind; size?: number; variant?: number }
const INK = '#304c44', CREAM = '#eee8cb'
const COLORS = ['#729381', '#a5755e', '#c19b58', '#778aa0', '#9b879a', '#8c9865', '#678783', '#c18c79', '#728d98', '#9d9771', '#917b65', '#7d879d']
function Hair({ style, color }: { style: HairStyle; color: string }) {
  const shapes: Record<HairStyle, string> = {
    crop: 'M5 2h6v1h2v5H3V4h2Z', side: 'M5 2h6v1h2v5h-2V6H8v1H4v2H3V4h2Z',
    bob: 'M5 2h6v1h2v10h-3V8H6v5H3V4h2Z', long: 'M5 2h6v1h2v13h-3V8H6v8H3V4h2Z',
    curly: 'M4 2h2V1h4v1h2v2h2v6h-3V7H5v3H2V4h2Z', bun: 'M6 0h4v3h2v1h1v5H3V4h2V3h1Z',
    'double-bun': 'M1 2h4v2h6V2h4v4h-2v4h-2V7H5v3H3V6H1Z', spiky: 'M3 4h2V2h2v1h1V1h2v2h2v1h1v5h-2V7H5v2H3Z',
    braid: 'M5 2h6v1h2v7h-2V7H5v5H3V4h2ZM3 12h2v2H3Zm1 2h2v2H4Zm-1 2h2v2H3Z',
    ponytail: 'M5 2h6v1h2v1h2v9h-2V7h-2V6H5v3H3V4h2Z', wave: 'M4 3h2V2h5v1h2v11h-2v-4h-1V7H6v4H4v3H2V7h1V4h1Z',
    beard: 'M5 2h6v1h2v6h-2V6H5v3H3V4h2Z',
  }
  return <path d={shapes[style]} fill={color} />
}
function Hat({ style, color }: { style: HatStyle; color: string }) {
  switch (style) {
    case 'cap': return <><path d="M4 2h8v3h2v1H3V4h1Z" fill={color} /><rect x="4" y="4" width="8" height="1" fill={INK} /><rect x="7" y="2" width="2" height="1" fill={CREAM} /></>
    case 'brim': return <><path d="M5 0h6v3h4v2H1V3h4Z" fill="#c9ac73" /><rect x="5" y="2" width="6" height="1" fill={color} /></>
    case 'hood': return <><path d="M5 1h6v1h2v2h1v7h-2V5h-1V4H5v1H4v6H2V4h1V2h2Z" fill={color} /><path d="M4 11h2v2H4Zm6 0h2v2h-2Z" fill={CREAM} /></>
    case 'headphones': return <><path d="M4 2h8v1h1v3h1v4h-2V6h-1V3H5v3H4v4H2V6h1V3h1Z" fill={INK} /><path d="M2 7h1v2H2Zm11 0h1v2h-1Z" fill={color} /></>
    case 'beret': return <><path d="M5 1h6v1h2v3H3V3H2V2h3Z" fill={color} /><rect x="8" y="0" width="1" height="1" fill={INK} /><rect x="4" y="4" width="8" height="1" fill={INK} /></>
    case 'beanie': return <><path d="M5 1h6v1h1v2h1v2H3V4h1V2h1Z" fill={color} /><rect x="3" y="4" width="10" height="2" fill={CREAM} /><rect x="7" y="0" width="2" height="1" fill={color} /></>
    case 'newsboy': return <><path d="M4 1h8v1h2v3H2V3h1V2h1Z" fill={color} /><path d="M4 5h10v1H4Z" fill={INK} /><rect x="7" y="1" width="1" height="3" fill={CREAM} /></>
    case 'chef': return <><path d="M3 1h3V0h4v1h3v3h-1v2H4V4H3Z" fill={CREAM} /><path d="M4 4h8v1H4Z" fill={color} /></>
    case 'tophat': return <><path d="M5 0h6v5h3v1H2V5h3Z" fill={INK} /><rect x="5" y="3" width="6" height="1" fill={color} /></>
    case 'bonnet': return <><path d="M4 1h8v1h1v4h-2V3H5v3H3V2h1Z" fill={CREAM} /><path d="M3 6h2v5H3Zm8 0h2v5h-2Z" fill={color} /></>
    default: return null
  }
}
function Garment({ style, color }: { style: GarmentStyle; color: string }) {
  return <>
    <path d={style === 'coat' || style === 'raincoat' || style === 'dress' ? 'M5 12h6v1h2v6h-1v3H4v-3H3v-6h2Z' : 'M5 12h6v1h2v7H3v-7h2Z'} fill={INK} />
    <path d={style === 'coat' || style === 'raincoat' || style === 'dress' ? 'M5 13h6v1h1v5h-1v2H5v-2H4v-5h1Z' : 'M5 13h6v1h1v5H4v-5h1Z'} fill={color} />
    {style === 'jacket' && <><path d="M5 13h2v2H5Zm4 0h2v2H9Z" fill={CREAM} /><rect x="7" y="15" width="2" height="4" fill={INK} /></>}
    {style === 'overalls' && <><path d="M5 13h1v3h4v-3h1v7H5Z" fill="#778e96" /><rect x="7" y="16" width="2" height="2" fill={CREAM} /></>}
    {style === 'vest' && <><path d="M4 14h2v5H4Zm6 0h2v5h-2ZM7 13h2v6H7Z" fill={CREAM} /><rect x="8" y="15" width="1" height="1" fill={INK} /><rect x="8" y="17" width="1" height="1" fill={INK} /></>}
    {style === 'coat' && <><path d="M5 13h2l1 3 1-3h2l-3 5Z" fill={CREAM} /><rect x="8" y="18" width="1" height="3" fill={INK} /><path d="M5 18h2v1H5Zm5 0h1v1h-1Z" fill={INK} /></>}
    {style === 'stripes' && <path d="M5 14h6v1H5Zm-1 3h8v1H4Z" fill={CREAM} />}
    {style === 'apron' && <><path d="M6 13h1v2h2v-2h1v2h1v5H5v-5h1Z" fill={CREAM} /><rect x="7" y="17" width="2" height="2" fill={color} /></>}
    {style === 'sport' && <><path d="M4 14h2v2H4Zm6 0h2v2h-2ZM7 13h2v6H7Z" fill={CREAM} /><rect x="8" y="14" width="1" height="4" fill={color} /></>}
    {style === 'sweater' && <><path d="M5 13h2v1h2v-1h2v2H5Z" fill={CREAM} /><rect x="4" y="18" width="8" height="1" fill={CREAM} /><path d="M7 16h2v1H7Z" fill={INK} /></>}
    {style === 'dress' && <><path d="M5 13h2v2H5Zm4 0h2v2H9ZM5 17h6v1H5Z" fill={CREAM} /><rect x="7" y="17" width="2" height="2" fill={INK} /></>}
    {style === 'raincoat' && <><rect x="7" y="13" width="2" height="8" fill={CREAM} /><path d="M5 17h1v2H5Zm5 0h1v2h-1Z" fill={INK} /></>}
  </>
}
function Prop({ style, color }: { style: PropStyle; color: string }) {
  switch (style) {
    case 'bag': return <><path d="M4 13h1v2h1v2H5v-1H3v-2h1Z" fill={INK} /><rect x="1" y="16" width="5" height="5" fill="#ac8561" /><path d="M2 17h3v1H2Z" fill={CREAM} /></>
    case 'plant': return <><path d="M13 16h1v4h-1ZM12 15h2v2h-2Zm2-2h2v3h-2Z" fill="#77976b" /><path d="M12 20h4v2h-1v1h-2v-1h-1Z" fill="#b5896c" /></>
    case 'book': return <><rect x="10" y="16" width="5" height="6" fill={INK} /><rect x="11" y="17" width="3" height="4" fill={CREAM} /><rect x="11" y="17" width="1" height="4" fill={color} /></>
    case 'map': return <><path d="M1 15h2v1h3v5H4v-1H1Z" fill={CREAM} /><path d="M3 16h1v2H3Zm1 3h1v1H4Z" fill="#9a9671" /></>
    case 'record': return <><rect x="10" y="16" width="5" height="5" fill={CREAM} /><path d="M11 17h3v3h-3Z" fill={INK} /><rect x="12" y="18" width="1" height="1" fill={color} /></>
    case 'palette': return <><path d="M12 16h3v1h1v3h-1v1h-3v-1h-1v-3h1Z" fill="#b89b72" /><rect x="12" y="17" width="1" height="1" fill="#a96f61" /><rect x="14" y="18" width="1" height="1" fill="#7d9b93" /><path d="M1 12h1v8H1Z" fill={INK} /></>
    case 'cup': return <><path d="M11 16h4v1h1v2h-1v2h-4Z" fill={CREAM} /><path d="M12 16h2v1h-2Zm3 1h1v2h-1Z" fill="#8f6c50" /><rect x="12" y="13" width="1" height="2" fill="#adc0ae" /></>
    case 'camera': return <><path d="M5 12h1v4h5v-4h1v7H5Z" fill={INK} /><rect x="6" y="16" width="6" height="4" fill="#566b62" /><rect x="8" y="17" width="2" height="2" fill={CREAM} /><rect x="6" y="16" width="1" height="1" fill={CREAM} /></>
    case 'staff': return <><path d="M14 10h1v13h-1Z" fill={INK} /><path d="M13 10h3v2h-3Z" fill="#bca478" /></>
    case 'backpack': return <><path d="M3 13h2v6H3Zm8 0h2v6h-2Z" fill="#b69c72" /><path d="M5 13h1v5H5Zm5 0h1v5h-1Z" fill={CREAM} /><rect x="7" y="17" width="2" height="2" fill={INK} /></>
    case 'newspaper': return <><rect x="11" y="14" width="4" height="8" fill={CREAM} /><path d="M12 15h2v1h-2Zm0 2h1v3h-1Zm2 0h1v4h-1Z" fill="#82907d" /></>
    case 'umbrella': return <><path d="M12 10h2V9h1v1h1v4h-5v-3h1Z" fill={color} /><path d="M13 14h1v8h-2v-1h1Z" fill={INK} /></>
    case 'wrench': return <><path d="M13 13h1v2h1v-2h1v4h-1v5h-2v-5h-1v-4h1Z" fill="#9caeaa" /><rect x="13" y="20" width="1" height="1" fill={INK} /></>
    case 'flowers': return <><path d="M13 16h1v6h-1Zm-1 2h3v1h-3Z" fill="#77976b" /><path d="M12 14h3v3h-3Z" fill="#c2939c" /><rect x="13" y="15" width="1" height="1" fill={CREAM} /></>
    case 'sketchbook': return <><rect x="1" y="16" width="5" height="6" fill="#c6ba9a" /><path d="M1 17h1v1H1Zm0 2h1v1H1Zm0 2h1v1H1Z" fill={INK} /><path d="M3 18h1v2H3Zm1 1h1v1H4Z" fill={color} /></>
    case 'starbag': return <><path d="M11 14h1v3h2v4h-4v-4h1Z" fill={color} /><path d="M11 18h1v-1h1v1h1v1h-1v1h-1v-1h-1Z" fill={CREAM} /></>
    case 'rod': return <><path d="M13 7h1v16h-1Zm1 0h2v1h-2Zm1 1h1v9h-1Z" fill={INK} /><path d="M14 17h2v2h-2Z" fill="#a4b7ad" /></>
    case 'bread': return <><path d="M11 16h3v1h1v4h-5v-4h1Z" fill="#c6a371" /><path d="M11 17h1v2h-1Zm2 1h1v2h-1Z" fill={CREAM} /></>
    case 'bouquet': return <><path d="M11 18h5l-2 5h-1Z" fill={CREAM} /><path d="M13 16h1v5h-1Z" fill="#77976b" /><path d="M11 14h2v3h-2Zm3 1h2v3h-2Z" fill="#bd8795" /><rect x="13" y="13" width="2" height="3" fill="#bba873" /></>
    case 'telescope': return <><path d="M11 14h3v2h-1v1h-2Z" fill="#a9b8ad" /><path d="M13 12h2v3h-2Z" fill={INK} /><path d="M12 17h1v5h-1Zm-1 5h1v1h-1Zm2 0h1v1h-1Z" fill={INK} /></>
    case 'guitar': return <><path d="M13 12h1v6h1v1h1v3h-1v1h-3v-1h-1v-3h1v-1h1Z" fill="#b58b61" /><path d="M13 13h1v8h-1Z" fill={CREAM} /><rect x="12" y="20" width="2" height="1" fill={INK} /></>
    case 'raindrop': return <><path d="M1 10h2V9h1v1h2v1h1v3H0v-3h1Z" fill="#7c9d9b" /><path d="M3 14h1v8H2v-1h1Z" fill={INK} /><path d="M14 14h1v1h1v2h-3v-2h1Z" fill="#a6c0b8" /></>
    case 'mask': return <><path d="M11 15h5v5h-1v1h-3v-1h-1Z" fill={CREAM} /><path d="M12 16h1v1h-1Zm2 0h1v1h-1Zm-1 3h1v1h-1Z" fill={INK} /></>
    case 'lantern': return <><path d="M12 14h3v2h1v5h-5v-5h1Z" fill={INK} /><rect x="12" y="17" width="3" height="3" fill="#d5bb7a" /><rect x="13" y="14" width="1" height="2" fill={CREAM} /></>
  }
}
/** 200 original 16 x 24 drawings. Appearance is decorative, never inferred from chats. */
function PixelSpriteView({ seed, kind = 'person', size = 42, variant }: PixelSpriteProps) {
  const value = spriteSeed(seed), model = characterVariant(seed, variant), design = characterDesigns[model]
  const outfit = COLORS[design.color], hair = ['#393c36', '#63523e', '#91846a', '#70504a'][Math.floor(value / 16) % 4]
  const skin = ['#dbb48d', '#b68d69', '#e9c9a4', '#986f53'][Math.floor(value / 64) % 4]
  return <svg xmlns="http://www.w3.org/2000/svg" className="cb-pixel-sprite" data-character={model} width={size} height={size * 1.5} viewBox="0 0 16 24" shapeRendering="crispEdges" aria-hidden="true" focusable="false" style={{ imageRendering: 'pixelated', flexShrink: 0 }}>
    <rect x="2" y="23" width="12" height="1" fill="#628778" opacity=".3" />
    {kind === 'group' ? <>
      <path d={value % 2 ? 'M1 9h2V6h3V3h4v3h3v3h2v13H1Z' : 'M1 8h14v14H1Z'} fill={INK} /><rect x="2" y="10" width="12" height="11" fill={outfit} /><path d="M2 9V8h2V6h3V4h2v2h3v2h2v1Z" fill="#91ac95" /><path d="M3 11h3v3H3Zm7 0h3v3h-3ZM3 16h3v3H3Zm7 0h3v3h-3Z" fill={CREAM} /><rect x="7" y="16" width="2" height="6" fill={INK} />
      {value % 3 === 0 && <><rect x="0" y="14" width="16" height="2" fill="#c9a174" /><path d="M3 14h2v2H3Zm4 0h2v2H7Zm4 0h2v2h-2Z" fill={CREAM} /></>}{value % 3 === 1 && <><rect x="6" y="8" width="4" height="3" fill={CREAM} /><rect x="7" y="8" width="1" height="2" fill={INK} /></>}{value % 3 === 2 && <><rect x="11" y="2" width="2" height="5" fill={INK} /><rect x="12" y="0" width="2" height="1" fill="#91ac95" /></>}
    </> : <>
      <Hair style={design.hair} color={hair} />
      <Garment style={design.garment} color={outfit} />
      <path d="M5 20h3v3H4v-1h1Zm4 0h2v2h1v1H9Z" fill={INK} />
      <rect x="5" y="6" width="6" height="6" fill={skin} /><path d="M4 7h1v3H4Zm7 0h1v3h-1Z" fill={skin} /><rect x="7" y="12" width="2" height="2" fill={skin} /><path d="M3 16h1v3H3Zm9 0h1v3h-1Z" fill={skin} />
      <path d="M6 8h1v1H6Zm4 0h1v1h-1Z" fill={INK} /><rect x="8" y="10" width="2" height="1" fill="#a57461" />
      {design.hair === 'beard' && <path d="M5 10h2v1h3v-1h1v2h-1v1H6v-1H5Z" fill={hair} />}
      {design.hair === 'side' && <path d="M5 5h5v1H8v1H5Z" fill={hair} />}
      {design.hair === 'curly' && <path d="M4 5h2v2H4Zm3 0h2v1H7Zm3 0h2v2h-2Z" fill={hair} />}
      <Hat style={design.hat} color={outfit} />
      {design.edition === 1 && <><path d="M5 12h6v2H5Zm5 1h2v4h-2Z" fill="#d1b382" /><rect x="11" y="16" width="1" height="2" fill={CREAM} /></>}
      {design.edition === 2 && <><path d="M5 8h3v2H5Zm4 0h3v2H9ZM8 8h1v1H8Z" fill={INK} /><path d="M4 14h1v5H4Zm7 0h1v5h-1Z" fill={CREAM} /></>}
      {design.edition === 3 && <><path d="M6 12h4v1H9v4H7v-4H6Z" fill={INK} /><path d="M4 18h3v2H4Zm6 0h2v2h-2Z" fill={CREAM} /></>}
      {design.edition === 4 && <><path d="M5 12h6v1H9v1H7v-1H5ZM5 14h1v2h1v2h1v2H7v-1H6v-2H5Z" fill={CREAM} /><rect x="10" y="14" width="2" height="2" fill={INK} /></>}
      {design.edition === 5 && <><path d="M5 14h6v1H5ZM4 17h8v2H4Z" fill={INK} /><path d="M5 17h2v1H5Zm4 0h2v1H9Z" fill={CREAM} /><rect x="1" y="5" width="1" height="2" fill={CREAM} /></>}
      {design.edition === 6 && <><path d="M11 3h3v1h1v2h-1v1h-3V6h-1V4h1Z" fill="#c2939c" /><rect x="12" y="4" width="1" height="1" fill={CREAM} /><path d="M5 15h1v1h1v1H6v1H5Z" fill={CREAM} /></>}
      {design.edition === 7 && <><path d="M2 12h3v1H4v7H2Zm10 0h2v8h-2Z" fill={outfit} /><path d="M4 20h8v1H4Zm2-6h4v1H6Z" fill={CREAM} /><rect x="8" y="16" width="1" height="3" fill={INK} /></>}
      {design.edition === 8 && <><path d="M3 12h2v6H3Zm8 0h2v6h-2Z" fill={CREAM} /><path d="M6 15h4v4H6Z" fill="#b89b72" /><path d="M7 16h2v1H7Z" fill={INK} /><rect x="1" y="21" width="3" height="2" fill={INK} /></>}
      <Prop style={design.prop} color={outfit} />
      {kind === 'self' && <><rect x="13" y="0" width="2" height="4" fill="#b69b50" /><rect x="12" y="1" width="4" height="2" fill="#b69b50" /></>}
    </>}
  </svg>
}
export const PixelSprite = memo(PixelSpriteView)
export default PixelSprite
