import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyAiMatteBatch, applyChromaKeyBatch } from './matting.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function sourceFrame(path: string) {
  const pixels = Buffer.alloc(6 * 6 * 4)
  for (let index = 0; index < 36; index += 1) {
    const offset = index * 4
    pixels[offset + 1] = 255
    pixels[offset + 3] = 255
  }
  for (let y = 2; y < 4; y += 1) {
    for (let x = 2; x < 4; x += 1) {
      const offset = (y * 6 + x) * 4
      pixels[offset] = 255
      pixels[offset + 1] = 0
    }
  }
  await sharp(pixels, { raw: { width: 6, height: 6, channels: 4 } }).png().toFile(path)
}

describe('MCP batch matting', () => {
  it('removes a solid background while preserving the subject', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-chroma-test-'))
    temporaryDirectories.push(root)
    const input = join(root, 'input.png')
    await sourceFrame(input)
    const result = await applyChromaKeyBatch({
      framePaths: [input], outputDirectory: join(root, 'out'), keyColor: '#00ff00',
      tolerance: 20, feather: 10,
    })
    const { data } = await sharp(result.files[0]!).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(data[3]).toBe(0)
    expect(data[(2 * 6 + 2) * 4 + 3]).toBe(255)
  })

  it('writes AI matte output through an injectable local segmenter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-ai-matte-test-'))
    temporaryDirectories.push(root)
    const input = join(root, 'input.png')
    await sourceFrame(input)
    const dispose = vi.fn(async () => undefined)
    const result = await applyAiMatteBatch({
      framePaths: [input], outputDirectory: join(root, 'out'),
      factory: async () => ({
        segment: async () => ({ data: new Uint8ClampedArray(4 * 4 * 4).fill(255), width: 4, height: 4, channels: 4 }),
        dispose,
      }),
    })
    expect(result.frameCount).toBe(1)
    expect(dispose).toHaveBeenCalledOnce()
    expect((await sharp(result.files[0]!).metadata()).width).toBe(4)
  })
})
