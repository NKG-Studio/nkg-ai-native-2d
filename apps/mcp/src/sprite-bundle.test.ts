import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { exportSpriteBundle, validateSpriteBundle } from './sprite-bundle.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function frame(path: string, x: number) {
  const pixels = Buffer.alloc(8 * 8 * 4)
  for (let y = 2; y < 6; y += 1) {
    for (let px = x; px < Math.min(8, x + 3); px += 1) {
      const offset = (y * 8 + px) * 4
      pixels[offset] = 255
      pixels[offset + 3] = 255
    }
  }
  await sharp(pixels, { raw: { width: 8, height: 8, channels: 4 } }).png().toFile(path)
}

describe('sprite bundle export', () => {
  it('packs multiple animations with tight trim and validates the result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-bundle-test-'))
    temporaryDirectories.push(root)
    const paths = [join(root, 'a.png'), join(root, 'b.png'), join(root, 'c.png')]
    await frame(paths[0]!, 1)
    await frame(paths[1]!, 3)
    await frame(paths[2]!, 1)
    const result = await exportSpriteBundle({
      animations: [
        { name: 'idle', framePaths: [paths[0]!, paths[0]!] },
        { name: 'run', framePaths: [paths[1]!, paths[2]!] },
      ],
      outputPath: join(root, 'bundle.png'),
      preset: 'unity',
      trimMode: 'tight',
      columns: 2,
    })
    expect(result.animationCount).toBe(2)
    expect(result.frameCount).toBe(4)
    const validation = await validateSpriteBundle(result.manifestPath)
    expect(validation.valid).toBe(true)
    expect(validation.animationDiagnostics[0]?.duplicateEndpoint).toBe(true)
    expect(validation.warnings).toContain('idle 的末帧疑似重复首帧')
  })
})
