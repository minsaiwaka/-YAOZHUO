import { createDecipheriv } from 'node:crypto'
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isInside } from './native-discovery'

export interface ImageParameters { imageKey: string; xorKey?: number }
export interface ImageDiscovery { configuration?: ImageParameters; tested: number; encryptedSamples: number; limited: boolean }
const validAes = (value: unknown): value is string => typeof value === 'string' && (/^[a-f\d]{32}$/i.test(value) || /^[\x20-\x7e]{16}$/.test(value))
const validXor = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
function check(signal: AbortSignal) { if (signal.aborted) throw new Error('自動識別已取消') }

/** A candidate is accepted only after AES padding + image signature and the
 * encrypted tail agree. Image AES and database keys are never interchangeable. */
export function verifyImageCandidate(input: Buffer, candidate: ImageParameters): ImageParameters | undefined {
  if (!validAes(candidate.imageKey) || input.length < 31 || input.length > 10 * 1024 * 1024 || !['070856320807', '070856310807'].includes(input.subarray(0, 6).toString('hex'))) return
  const aesLength = input.readUInt32LE(6), xorLength = input.readUInt32LE(10), padded = aesLength + 16 - aesLength % 16
  if (aesLength < 12 || padded > input.length - 15 || xorLength > input.length - 15 - padded) return
  const key = /^[a-f\d]{32}$/i.test(candidate.imageKey) ? Buffer.from(candidate.imageKey, 'hex') : Buffer.from(candidate.imageKey, 'ascii')
  let plain: Buffer | undefined
  try {
    const cipher = createDecipheriv('aes-128-ecb', key, null)
    plain = Buffer.concat([cipher.update(input.subarray(15, 15 + padded)), cipher.final()])
    if (plain.length !== aesLength) return
    const jpeg = plain.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    const png = plain.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const gif = /^GIF8[79]a$/.test(plain.subarray(0, 6).toString('ascii'))
    if (!jpeg && !png && !gif) return
    if (!xorLength) return { imageKey: candidate.imageKey, ...(validXor(candidate.xorKey) ? { xorKey: candidate.xorKey } : {}) }
    // Use a complete known trailer, not a guessed single-byte image header.
    const trailer = jpeg ? Buffer.from([255, 217]) : png ? Buffer.from('0000000049454e44ae426082', 'hex') : undefined
    if (!trailer || xorLength < trailer.length) return
    const tail = input.subarray(-trailer.length)
    const xor = tail[0] ^ trailer[0]
    if (validXor(candidate.xorKey) && candidate.xorKey !== xor) return
    if (!trailer.every((byte, index) => (tail[index] ^ xor) === byte)) return
    return { imageKey: candidate.imageKey, xorKey: xor }
  } catch { return }
  finally { key.fill(0); plain?.fill(0) }
}

/** Bounded read of the selected account only. Never follows symlinks or writes media. */
export async function discoverImageKeys(root: string, supplied: ImageParameters[], signal: AbortSignal): Promise<ImageDiscovery> {
  const candidates = supplied.filter(value => validAes(value.imageKey)).slice(0, 32)
  for (const name of ['image_keys.json', 'image_key.json', 'key_info.json']) {
    check(signal)
    try {
      const file = await realpath(join(root, name))
      if (!isInside(root, file) || (await stat(file)).size > 64 * 1024) continue
      const value = JSON.parse(await readFile(file, 'utf8'))
      const imageKey = value.imageAesKey ?? value.imageKey ?? value.aesKey
      const xorKey = value.imageXorKey ?? value.xorKey
      if (validAes(imageKey)) candidates.push({ imageKey, ...(validXor(xorKey) ? { xorKey } : {}) })
    } catch { check(signal) }
  }
  const result: ImageDiscovery = { tested: 0, encryptedSamples: 0, limited: false }
  if (!candidates.length) return result
  let visited = 0
  const started = performance.now()
  const walk = async (directory: string, depth: number): Promise<void> => {
    check(signal)
    if (depth > 9 || result.configuration || result.encryptedSamples >= 8) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    // Look in media trees before unrelated directories; enumeration is capped.
    entries.sort((a, b) => Number(!/^(?:msg|image|img|attach|attachment|cache)/i.test(a.name)) - Number(!/^(?:msg|image|img|attach|attachment|cache)/i.test(b.name)))
    for (const entry of entries) {
      check(signal)
      if (result.configuration || result.encryptedSamples >= 8) return
      if (++visited > 12000 || performance.now() - started > 4000) { result.limited = true; return }
      if (entry.isSymbolicLink()) continue
      const file = join(directory, entry.name)
      if (entry.isDirectory() && !/^(?:db_storage|node_modules|\.git|logs|backup|backupfiles)$/i.test(entry.name)) await walk(file, depth + 1)
      else if (entry.isFile() && /\.dat$/i.test(entry.name)) {
        try {
          const actual = await realpath(file)
          if (!isInside(root, actual)) continue
          const handle = await open(actual, 'r')
          let bytes: Buffer | undefined
          try {
            const info = await handle.stat()
            if (!info.isFile() || info.size < 31 || info.size > 10 * 1024 * 1024) continue
            const header = Buffer.alloc(6)
            await handle.read(header, 0, 6, 0)
            if (!['070856320807', '070856310807'].includes(header.toString('hex'))) continue
            bytes = await handle.readFile()
            result.encryptedSamples++
            for (const candidate of candidates.slice(0, 36)) {
              check(signal); result.tested++
              const configuration = verifyImageCandidate(bytes, candidate)
              if (configuration) { result.configuration = configuration; return }
            }
          } finally { bytes?.fill(0); await handle.close() }
        } catch { check(signal) }
      }
    }
  }
  await walk(root, 0)
  return result
}
