import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzeMatteQuality, refineMatteBatch } from './matte-refinement.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function writeRgba(path: string, data: Buffer, width = 7, height = 7) {
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(path)
}

function sourcePixels() {
  const data = Buffer.alloc(7 * 7 * 4)
  for (let index = 0; index < 49; index += 1) {
    const offset = index * 4
    data[offset] = 220
    data[offset + 1] = 80
    data[offset + 2] = 40
    data[offset + 3] = 255
  }
  return data
}

function damagedMatte() {
  const data = Buffer.alloc(7 * 7 * 4)
  const setForeground = (x: number, y: number) => {
    const offset = (y * 7 + x) * 4
    data[offset] = 220
    data[offset + 1] = 80
    data[offset + 2] = 40
    data[offset + 3] = 255
  }
  for (let y = 2; y <= 4; y += 1) {
    for (let x = 2; x <= 4; x += 1) setForeground(x, y)
  }
  data[(3 * 7 + 3) * 4 + 3] = 0
  setForeground(0, 0)
  return data
}

describe('MCP matte refinement', () => {
  it('reports detached foreground pixels and enclosed holes with coordinates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-matte-quality-'))
    temporaryDirectories.push(root)
    const matte = join(root, 'matte.png')
    await writeRgba(matte, damagedMatte())

    const report = await analyzeMatteQuality({
      mattePaths: [matte], detachedAreaThreshold: 4, holeAreaThreshold: 4,
    })
    expect(report.summary.suspiciousDetachedComponents).toBe(1)
    expect(report.summary.suspiciousHoles).toBe(1)
    expect(report.frames[0]!.suspiciousDetachedComponents[0]!.center).toEqual({ x: 0, y: 0 })
    expect(report.frames[0]!.suspiciousHoles[0]!.center).toEqual({ x: 3, y: 3 })
  })

  it('auto-cleans small defects and applies one-pixel AI correction strokes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-matte-refine-'))
    temporaryDirectories.push(root)
    const source = join(root, 'source.png')
    const matte = join(root, 'matte.png')
    await writeRgba(source, sourcePixels())
    await writeRgba(matte, damagedMatte())

    const result = await refineMatteBatch({
      sourceFramePaths: [source],
      mattePaths: [matte],
      outputDirectory: join(root, 'out'),
      removeIslandsBelow: 2,
      fillHolesBelow: 2,
      corrections: [{
        frameIndex: 0,
        mode: 'remove',
        diameterPixels: 1,
        coordinateSpace: 'pixel',
        points: [{ x: 4, y: 4 }],
      }],
    })
    const { data } = await sharp(result.files[0]!).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(data[(0 * 7 + 0) * 4 + 3]).toBe(0)
    expect(data[(3 * 7 + 3) * 4 + 3]).toBe(255)
    expect(data[(4 * 7 + 4) * 4 + 3]).toBe(0)
    expect(result.summary).toMatchObject({
      correctionStrokes: 1,
      removedIslandPixels: 1,
      filledHolePixels: 1,
      explicitStrokePixels: 1,
    })
  })

  it('supports normalized coordinates and rejects mismatched frame counts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-matte-normalized-'))
    temporaryDirectories.push(root)
    const source = join(root, 'source.png')
    const matte = join(root, 'matte.png')
    await writeRgba(source, sourcePixels())
    await writeRgba(matte, sourcePixels())
    const result = await refineMatteBatch({
      sourceFramePaths: [source], mattePaths: [matte], outputDirectory: join(root, 'out'),
      corrections: [{
        frameIndex: 0, mode: 'remove', diameterPixels: 1, coordinateSpace: 'normalized',
        points: [{ x: 0.5, y: 0.5 }],
      }],
    })
    const { data } = await sharp(result.files[0]!).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(data[(3 * 7 + 3) * 4 + 3]).toBe(0)
    await expect(refineMatteBatch({
      sourceFramePaths: [], mattePaths: [matte], outputDirectory: join(root, 'bad'),
    })).rejects.toThrow('数量必须一致')
  })
})
