import { describe, expect, it } from 'vitest'
import { createAsepriteManifest, createGodotSpriteFrames, createUnityManifest } from './exporters'
import type { SpriteSheetManifest } from './sprite'

const manifest: SpriteSheetManifest = {
  version: 2,
  image: 'idle.png',
  animation: { name: 'idle', loop: true, frameCount: 1, duration: 83 },
  trimMode: 'tight',
  alphaThreshold: 1,
  frameSize: { width: 64, height: 64 },
  sheetSize: { width: 100, height: 120 },
  columns: 1,
  rows: 1,
  padding: 0,
  frames: [{
    index: 0,
    sourceFrameId: 12,
    filename: 'idle_000',
    frame: { x: 10, y: 20, w: 30, h: 40 },
    rotated: false,
    trimmed: true,
    empty: false,
    spriteSourceSize: { x: 5, y: 7, w: 30, h: 40 },
    sourceSize: { w: 64, h: 64 },
    pivot: { x: 0.5, y: 1 },
    duration: 83,
  }],
}

describe('engine export presets', () => {
  it('creates Aseprite-compatible frame timing, tag and pivot metadata', () => {
    const result = createAsepriteManifest(manifest)
    expect(result.frames.idle_000!.duration).toBe(83)
    expect(result.meta.frameTags[0]).toMatchObject({ name: 'idle', from: 0, to: 0 })
    expect(result.meta.slices[0]?.keys[0]?.pivot).toEqual({ x: 32, y: 64 })
  })

  it('reconstructs the original source canvas through Godot AtlasTexture margins', () => {
    const result = createGodotSpriteFrames(manifest)
    expect(result).toContain('region = Rect2(10, 20, 30, 40)')
    expect(result).toContain('margin = Rect2(5, 7, 34, 24)')
    expect(result).toContain('"speed": 1000.0')
  })

  it('converts atlas coordinates and pivot to Unity bottom-left space', () => {
    const result = createUnityManifest(manifest, 32)
    expect(result.pixelsPerUnit).toBe(32)
    expect(result.frames[0]?.rect).toEqual({ x: 10, y: 60, w: 30, h: 40 })
    expect(result.frames[0]?.pivot).toEqual({ x: 0.9, y: -0.425 })
  })
})
