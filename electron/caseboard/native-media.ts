import { createDecipheriv } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isInside } from './native-discovery'
import type { Evidence } from '../../src/caseboard/types'

const MAX_IMAGE = 10 * 1024 * 1024
function mime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  if (bytes[0] === 66 && bytes[1] === 77 && bytes.length > 26) return 'image/bmp'
  if (bytes.subarray(4, 8).toString() === 'ftyp' && ['avif', 'avis'].includes(bytes.subarray(8, 12).toString())) return 'image/avif'
  return undefined
}

/** Original implementation of the local .dat layouts documented in upstream's JS fallback. */
export function decodeLocalImage(input: Buffer, options: { imageKey?: string; xorKey?: number } = {}): { dataUrl: string } {
  if (!input.length || input.length > MAX_IMAGE) throw new Error('图片为空或超过 10 MB')
  let decoded = input
  if (!mime(input)) {
    const version = input.subarray(0, 6).toString('hex')
    if (version === '070856320807' || version === '070856310807') {
      if (input.length < 31) throw new Error('图片数据不完整')
      const supplied = options.imageKey || ''
      let key: Buffer
      if (/^[\da-f]{32}$/i.test(supplied)) key = Buffer.from(supplied, 'hex')
      else if (Buffer.byteLength(supplied, 'ascii') === 16 && /^[\x20-\x7e]{16}$/.test(supplied)) key = Buffer.from(supplied, 'ascii')
      else throw new Error('此图片需要单独的图片 AES 密钥，请在读取设置的高级选项中填写')
      const aesLength = input.readUInt32LE(6), xorLength = input.readUInt32LE(10)
      const paddedLength = aesLength + 16 - aesLength % 16
      if (paddedLength > input.length - 15 || xorLength > input.length - 15 - paddedLength) throw new Error('图片分段长度无效')
      const cipher = createDecipheriv('aes-128-ecb', key, null)
      let plain: Buffer
      try { plain = Buffer.concat([cipher.update(input.subarray(15, 15 + paddedLength)), cipher.final()]) }
      catch { throw new Error('图片 AES 密钥不匹配或文件已损坏') }
      if (plain.length !== aesLength) throw new Error('图片解密结果长度不匹配')
      const remainder = Buffer.from(input.subarray(15 + paddedLength))
      if (xorLength && !Number.isInteger(options.xorKey)) throw new Error('此图片需要图片 XOR 参数，请在高级选项填写 0–255 的整数')
      for (let index = remainder.length - xorLength; index < remainder.length; index++) remainder[index] ^= options.xorKey || 0
      decoded = Buffer.concat([plain, remainder])
    } else {
      const candidates = Number.isInteger(options.xorKey) ? [options.xorKey!] : [input[0] ^ 137, input[0] ^ 255, input[0] ^ 71, input[0] ^ 82, input[0] ^ 66]
      let matched: Buffer | undefined
      for (const key of candidates) {
        const output = Buffer.from(input)
        for (let index = 0; index < output.length; index++) output[index] ^= key
        if (mime(output)) { matched = output; break }
      }
      if (!matched) throw new Error('暂不支持此媒体格式，或图片密钥不匹配；请使用本地图片钉板')
      decoded = matched
    }
  }
  const type = mime(decoded)
  if (!type) throw new Error('解密结果不是受支持的图片；WXGF/实况容器需要专门解码器')
  return { dataUrl: `data:${type};base64,${decoded.toString('base64')}` }
}

export class LocalMediaReader {
  private index: Map<string, string[]> | null = null
  constructor(private root: string, private options: { imageKey?: string; xorKey?: number }) {}
  private async buildIndex(): Promise<Map<string, string[]>> {
    const index = new Map<string, string[]>()
    let visited = 0
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 9) return
      let entries
      try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (++visited > 150_000) throw new Error('媒体目录过大，请将所需图片手动钉到线索板')
        if (entry.isSymbolicLink()) continue
        const file = join(directory, entry.name)
        if (entry.isDirectory() && !/^(?:db_storage|node_modules|\.git|logs|backup|backupfiles)$/i.test(entry.name)) await walk(file, depth + 1)
        else if (entry.isFile() && /\.(?:dat|png|jpe?g|gif|webp|bmp|avif)$/i.test(entry.name)) {
          const match = entry.name.match(/^([\da-f]{32})(?:[^\da-f].*)?\.(?:dat|png|jpe?g|gif|webp|bmp|avif)$/i)
          if (match) { const hash = match[1].toLowerCase(); index.set(hash, [...(index.get(hash) || []), file]) }
        }
      }
    }
    await walk(this.root, 0)
    this.index = index
    return index
  }
  async read(evidence: Evidence): Promise<{ dataUrl: string }> {
    const hash = /^(?:(?:image|emoji):)?([\da-f]{32})$/i.exec(evidence.mediaKey || '')?.[1]
    if (!['image', 'emoji'].includes(evidence.kind) || !hash) throw new Error('此条消息没有可定位的本地图片标识')
    const index = this.index || await this.buildIndex()
    const files = [...(index.get(hash.toLowerCase()) || [])].sort((a, b) => Number(/(?:_t|thumb)/i.test(a)) - Number(/(?:_t|thumb)/i.test(b)))
    if (!files.length) throw new Error('本地没有找到此图片；请先在微信中下载图片，再重新读取资料，或手动添加图片')
    let failure = '无法读取本地图片'
    for (const file of files) {
      try {
        const actual = await realpath(file)
        if (!isInside(this.root, actual)) continue
        const info = await stat(actual)
        if (!info.isFile() || info.size > MAX_IMAGE) continue
        return decodeLocalImage(await readFile(actual), this.options)
      } catch (error) { failure = error instanceof Error ? error.message : failure }
    }
    throw new Error(failure)
  }
  close(): void { this.index = null; this.options = {} }
}
