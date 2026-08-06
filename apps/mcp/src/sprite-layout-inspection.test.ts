import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectSpriteSheetLayout } from './sprite-layout-inspection.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('sprite sheet layout inspection', () => {
  it('returns multimodal previews and auditable component candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-layout-inspection-'))
    temporaryDirectories.push(root)
    const atlasPath = join(root, 'atlas.png')
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
    const inspection = await inspectSpriteSheetLayout({ atlasPath, maxPreviewSize: 512 })
    expect(inspection.result.componentCandidates).toHaveLength(3)
    expect(inspection.result.aiReviewTask.nextTool).toBe('slice_sprite_sheet')
    expect((await sharp(inspection.originalPreview).metadata()).format).toBe('png')
    expect((await sharp(inspection.annotatedPreview).metadata()).format).toBe('png')
  })
})
