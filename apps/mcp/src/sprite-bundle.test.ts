import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { exportSpriteBundle, sliceSpriteSheet, validateSpriteBundle } from './sprite-bundle.js'

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

  it('slices grid atlas frames into minimum alpha-bounded PNG files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-slices-test-'))
    temporaryDirectories.push(root)
    const paths = [join(root, 'a.png'), join(root, 'b.png')]
    await frame(paths[0]!, 1)
    await frame(paths[1]!, 3)
    const bundle = await exportSpriteBundle({
      animations: [{ name: 'run', framePaths: paths, sourceFrameIds: [11, 12] }],
      outputPath: join(root, 'bundle.png'),
      trimMode: 'grid',
      columns: 2,
    })
    const result = await sliceSpriteSheet({ manifestPath: bundle.manifestPath })
    expect(result.frameCount).toBe(2)
    const first = await sharp(result.files[0]!).metadata()
    const second = await sharp(result.files[1]!).metadata()
    expect({ width: first.width, height: first.height }).toEqual({ width: 3, height: 4 })
    expect({ width: second.width, height: second.height }).toEqual({ width: 3, height: 4 })
    const slices = JSON.parse(await import('node:fs/promises').then(({ readFile }) =>
      readFile(result.manifestPath, 'utf8')))
    expect(slices.frames.map((item: { sourceFrameId: number }) => item.sourceFrameId)).toEqual([11, 12])
    expect(slices.frames[0].sourceBounds).toEqual({ x: 1, y: 2, w: 3, h: 4 })
    expect(slices.frames[1].sourceBounds).toEqual({ x: 3, y: 2, w: 3, h: 4 })
  })

  it('slices a standalone atlas without a manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-standalone-slices-test-'))
    temporaryDirectories.push(root)
    const frames = [join(root, 'a.png'), join(root, 'b.png')]
    await frame(frames[0]!, 1)
    await frame(frames[1]!, 3)
    const atlasPath = join(root, 'standalone.png')
    await sharp({
      create: { width: 17, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([
      { input: frames[0]!, left: 0, top: 0 },
      { input: frames[1]!, left: 9, top: 0 },
    ]).png().toFile(atlasPath)
    const result = await sliceSpriteSheet({
      atlasPath,
      columns: 2,
      rows: 1,
      padding: 1,
    })
    expect(result.frameCount).toBe(2)
    expect(await Promise.all(result.files.map(async (path) => {
      const metadata = await sharp(path).metadata()
      return [metadata.width, metadata.height]
    }))).toEqual([[3, 4], [3, 4]])
  })

  it('isolates irregular connected components with different sizes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-component-slices-test-'))
    temporaryDirectories.push(root)
    const atlasPath = join(root, 'irregular.png')
    const pixels = Buffer.alloc(24 * 16 * 4)
    const rectangles: Array<[number, number, number, number]> = [[1, 1, 4, 5], [12, 2, 8, 3], [7, 10, 3, 5]]
    for (const [left, top, width, height] of rectangles) {
      for (let y = top; y < top + height; y += 1) {
        for (let x = left; x < left + width; x += 1) {
          const offset = (y * 24 + x) * 4
          pixels[offset] = 255
          pixels[offset + 3] = 255
        }
      }
    }
    await sharp(pixels, { raw: { width: 24, height: 16, channels: 4 } }).png().toFile(atlasPath)
    const result = await sliceSpriteSheet({ atlasPath, mode: 'components', boundsMode: 'polygon' })
    expect('mode' in result ? result.mode : null).toBe('components')
    expect(await Promise.all(result.files.map(async (path) => {
      const metadata = await sharp(path).metadata()
      return [metadata.width, metadata.height]
    }))).toEqual([[4, 5], [8, 3], [3, 5]])
  })

  it('deskews diagonal components with oriented bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-oriented-slices-test-'))
    temporaryDirectories.push(root)
    const atlasPath = join(root, 'diagonal.png')
    const pixels = Buffer.alloc(20 * 20 * 4)
    for (let step = 0; step < 12; step += 1) {
      const points: Array<[number, number]> = [[3 + step, 3 + step], [4 + step, 3 + step], [3 + step, 4 + step]]
      for (const [x, y] of points) {
        const offset = (y * 20 + x) * 4
        pixels[offset + 1] = 255
        pixels[offset + 3] = 255
      }
    }
    await sharp(pixels, { raw: { width: 20, height: 20, channels: 4 } }).png().toFile(atlasPath)
    const result = await sliceSpriteSheet({ atlasPath, mode: 'components', boundsMode: 'oriented' })
    const metadata = await sharp(result.files[0]!).metadata()
    expect(Math.max(metadata.width!, metadata.height!)).toBeGreaterThan(12)
    expect(Math.min(metadata.width!, metadata.height!)).toBeLessThan(6)
    const manifest = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(result.manifestPath, 'utf8')))
    expect(Math.abs(manifest.frames[0].sourceRotationDegrees)).toBeGreaterThan(20)
  })

  it('executes an AI-confirmed polygon region with transparent pixels outside the shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-polygon-slices-test-'))
    temporaryDirectories.push(root)
    const atlasPath = join(root, 'opaque.png')
    await sharp({
      create: { width: 12, height: 12, channels: 4, background: { r: 220, g: 80, b: 40, alpha: 1 } },
    }).png().toFile(atlasPath)
    const result = await sliceSpriteSheet({
      atlasPath,
      mode: 'regions',
      boundsMode: 'polygon',
      removeBackground: false,
      regions: [{
        type: 'polygon',
        name: 'triangle',
        points: [{ x: 1, y: 1 }, { x: 10, y: 1 }, { x: 1, y: 10 }],
      }],
    })
    const { data, info } = await sharp(result.files[0]!).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const alphas = Array.from({ length: info.width * info.height }, (_, index) => data[index * 4 + 3]!)
    expect(Math.min(...alphas)).toBe(0)
    expect(Math.max(...alphas)).toBe(255)
  })
})
