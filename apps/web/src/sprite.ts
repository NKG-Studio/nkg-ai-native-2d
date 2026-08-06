import {
  createSpriteLayout,
  createTightSpriteLayout,
  type SpriteBoundsMode,
  type SpriteDetectionPoint,
  type SpriteSheetDetection,
} from '@frameloop/core'
import { strToU8, zipSync } from 'fflate'

export type TrimMode = 'grid' | 'tight'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface SpriteFrameManifest {
  index: number
  sourceFrameId: number
  filename: string
  frame: Rect
  rotated: false
  trimmed: boolean
  empty: boolean
  spriteSourceSize: Rect
  sourceSize: { w: number; h: number }
  pivot: { x: number; y: number }
  duration: number
}

export interface SpriteSheetManifest {
  version: 2
  image: string
  animation: { name: string; loop: true; frameCount: number; duration: number }
  trimMode: TrimMode
  alphaThreshold: number
  frameSize: { width: number; height: number }
  sheetSize: { width: number; height: number }
  columns: number
  rows: number
  padding: number
  frames: SpriteFrameManifest[]
}

export interface SpriteSheetOptions {
  columns: number
  padding: number
  trimMode?: TrimMode
  alphaThreshold?: number
  pivot?: { x: number; y: number }
  animationName?: string
  durations?: number[]
  sourceFrameIds?: number[]
  imageName?: string
}

export interface SpriteExportResult {
  canvas: HTMLCanvasElement
  manifest: SpriteSheetManifest
}

export interface SpriteSliceRegion {
  index: number
  filename: string
  frame: Rect
  sourceFrameId?: number
  sourceOffset?: { x: number; y: number }
  sourceSize?: { w: number; h: number }
  pivot?: { x: number; y: number }
  duration?: number
}

export interface SpriteSlice {
  canvas: HTMLCanvasElement
  index: number
  filename: string
  sourceFrameId: number
  width: number
  height: number
  empty: boolean
  sourceBounds: Rect
  sourceSize: { w: number; h: number }
  pivot: { x: number; y: number }
  duration: number
  boundsMode?: SpriteBoundsMode
  sourceRotationDegrees?: number
  sourcePolygon?: SpriteDetectionPoint[]
}

export interface GridSliceOptions {
  columns: number
  rows: number
  padding?: number
  frameCount?: number
}

interface TrimBounds extends Rect {
  empty: boolean
}

export function findOpaqueBounds(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  alphaThreshold = 1,
): TrimBounds {
  const threshold = Math.max(0, Math.min(255, Math.round(alphaThreshold)))
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((rgba[(y * width + x) * 4 + 3] ?? 0) < threshold) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  return maxX < minX || maxY < minY
    ? { x: 0, y: 0, w: 1, h: 1, empty: true }
    : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, empty: false }
}

function trimBounds(canvas: HTMLCanvasElement, mode: TrimMode, threshold: number): TrimBounds {
  if (mode === 'grid') return { x: 0, y: 0, w: canvas.width, h: canvas.height, empty: false }
  const image = canvas.getContext('2d', { willReadFrequently: true })!
    .getImageData(0, 0, canvas.width, canvas.height)
  return findOpaqueBounds(image.data, canvas.width, canvas.height, threshold)
}

export function composeSpriteSheet(
  frames: HTMLCanvasElement[],
  options: SpriteSheetOptions,
): SpriteExportResult {
  if (frames.length === 0) throw new Error('没有可导出的帧')
  const trimMode = options.trimMode ?? 'grid'
  const alphaThreshold = Math.max(0, Math.min(255, Math.round(options.alphaThreshold ?? 1)))
  const padding = Math.max(0, Math.round(options.padding))
  const columns = Math.max(1, Math.round(options.columns))
  const sourceWidth = Math.max(...frames.map((frame) => frame.width))
  const sourceHeight = Math.max(...frames.map((frame) => frame.height))
  const trims = frames.map((frame) => trimBounds(frame, trimMode, alphaThreshold))
  const layout = trimMode === 'tight'
    ? createTightSpriteLayout({ frames: trims, columns, padding })
    : createSpriteLayout({
      frameWidth: sourceWidth,
      frameHeight: sourceHeight,
      frameCount: frames.length,
      columns,
      padding,
    })
  const canvas = document.createElement('canvas')
  canvas.width = layout.width
  canvas.height = layout.height
  const context = canvas.getContext('2d')!
  context.clearRect(0, 0, canvas.width, canvas.height)
  layout.frames.forEach((slot, index) => {
    const frame = frames[index]!
    const trim = trims[index]!
    if (!trim.empty) {
      context.drawImage(frame, trim.x, trim.y, trim.w, trim.h, slot.x, slot.y, trim.w, trim.h)
    }
  })
  const pivot = {
    x: Math.max(0, Math.min(1, options.pivot?.x ?? 0.5)),
    y: Math.max(0, Math.min(1, options.pivot?.y ?? 0.5)),
  }
  const animationName = options.animationName?.trim() || 'animation'
  const imageName = options.imageName?.trim() || 'sprite.png'
  const manifestFrames: SpriteFrameManifest[] = layout.frames.map((slot, index) => {
    const source = frames[index]!
    const trim = trims[index]!
    const duration = Math.max(1, Math.round(options.durations?.[index] ?? 100))
    return {
      index,
      sourceFrameId: options.sourceFrameIds?.[index] ?? index,
      filename: `${animationName}_${String(index).padStart(3, '0')}`,
      frame: { x: slot.x, y: slot.y, w: slot.w, h: slot.h },
      rotated: false,
      trimmed: trimMode === 'tight' && (trim.x !== 0 || trim.y !== 0 || trim.w !== source.width || trim.h !== source.height),
      empty: trim.empty,
      spriteSourceSize: { x: trim.x, y: trim.y, w: trim.w, h: trim.h },
      sourceSize: { w: source.width, h: source.height },
      pivot,
      duration,
    }
  })
  return {
    canvas,
    manifest: {
      version: 2,
      image: imageName,
      animation: {
        name: animationName,
        loop: true,
        frameCount: frames.length,
        duration: manifestFrames.reduce((sum, frame) => sum + frame.duration, 0),
      },
      trimMode,
      alphaThreshold,
      frameSize: { width: sourceWidth, height: sourceHeight },
      sheetSize: { width: layout.width, height: layout.height },
      columns: layout.columns,
      rows: layout.rows,
      padding,
      frames: manifestFrames,
    },
  }
}

export function createGridSliceRegions(
  sheetWidth: number,
  sheetHeight: number,
  options: GridSliceOptions,
): SpriteSliceRegion[] {
  const columns = Math.max(1, Math.round(options.columns))
  const rows = Math.max(1, Math.round(options.rows))
  const padding = Math.max(0, Math.round(options.padding ?? 0))
  const availableWidth = sheetWidth - Math.max(0, columns - 1) * padding
  const availableHeight = sheetHeight - Math.max(0, rows - 1) * padding
  if (availableWidth < columns || availableHeight < rows
    || availableWidth % columns !== 0 || availableHeight % rows !== 0) {
    throw new Error('图集尺寸无法按当前行列与间距整除')
  }
  const frameWidth = availableWidth / columns
  const frameHeight = availableHeight / rows
  const slotCount = columns * rows
  const frameCount = Math.round(options.frameCount ?? slotCount)
  if (frameCount < 1 || frameCount > slotCount) throw new Error(`实际 Sprite 数必须在 1 到 ${slotCount} 之间`)
  return Array.from({ length: frameCount }, (_, index) => ({
    index,
    filename: `sprite_${String(index).padStart(3, '0')}`,
    frame: {
      x: (index % columns) * (frameWidth + padding),
      y: Math.floor(index / columns) * (frameHeight + padding),
      w: frameWidth,
      h: frameHeight,
    },
    sourceFrameId: index,
    sourceOffset: { x: 0, y: 0 },
    sourceSize: { w: frameWidth, h: frameHeight },
    pivot: { x: 0.5, y: 1 },
    duration: 100,
  }))
}

export function sliceSpriteRegions(
  sheet: HTMLCanvasElement,
  regions: SpriteSliceRegion[],
  alphaThreshold = 1,
): SpriteSlice[] {
  const context = sheet.getContext('2d', { willReadFrequently: true })!
  return regions.map((region) => {
    if (region.frame.x < 0 || region.frame.y < 0 || region.frame.w < 1 || region.frame.h < 1
      || region.frame.x + region.frame.w > sheet.width
      || region.frame.y + region.frame.h > sheet.height) {
      throw new Error(`Sprite 区域越出图集：${region.filename}`)
    }
    const image = context.getImageData(region.frame.x, region.frame.y, region.frame.w, region.frame.h)
    const bounds = findOpaqueBounds(image.data, region.frame.w, region.frame.h, alphaThreshold)
    const canvas = document.createElement('canvas')
    canvas.width = bounds.w
    canvas.height = bounds.h
    if (!bounds.empty) {
      canvas.getContext('2d')!.drawImage(
        sheet,
        region.frame.x + bounds.x,
        region.frame.y + bounds.y,
        bounds.w,
        bounds.h,
        0,
        0,
        bounds.w,
        bounds.h,
      )
    }
    const sourceOffset = region.sourceOffset ?? { x: 0, y: 0 }
    return {
      canvas,
      index: region.index,
      filename: region.filename,
      sourceFrameId: region.sourceFrameId ?? region.index,
      width: bounds.w,
      height: bounds.h,
      empty: bounds.empty,
      sourceBounds: {
        x: sourceOffset.x + bounds.x,
        y: sourceOffset.y + bounds.y,
        w: bounds.w,
        h: bounds.h,
      },
      sourceSize: region.sourceSize ?? { w: region.frame.w, h: region.frame.h },
      pivot: region.pivot ?? { x: 0.5, y: 1 },
      duration: region.duration ?? 100,
    }
  })
}

function trimCanvas(canvas: HTMLCanvasElement, alphaThreshold: number) {
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const bounds = findOpaqueBounds(image.data, canvas.width, canvas.height, alphaThreshold)
  const trimmed = document.createElement('canvas')
  trimmed.width = bounds.w
  trimmed.height = bounds.h
  if (!bounds.empty) {
    trimmed.getContext('2d')!.drawImage(
      canvas, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h,
    )
  }
  return { canvas: trimmed, bounds }
}

export function sliceDetectedSpriteRegions(
  sheet: HTMLCanvasElement,
  analysis: SpriteSheetDetection,
  boundsMode: SpriteBoundsMode,
  alphaThreshold = 1,
): SpriteSlice[] {
  const sourceContext = sheet.getContext('2d', { willReadFrequently: true })!
  const source = sourceContext.getImageData(0, 0, sheet.width, sheet.height)
  return analysis.sprites.map((sprite, index) => {
    const bounds = sprite.bounds
    const labels = new Set(sprite.labelIds)
    const local = document.createElement('canvas')
    local.width = bounds.w
    local.height = bounds.h
    const localContext = local.getContext('2d')!
    const isolated = localContext.createImageData(bounds.w, bounds.h)
    for (let y = 0; y < bounds.h; y += 1) {
      for (let x = 0; x < bounds.w; x += 1) {
        const sourcePixel = (bounds.y + y) * sheet.width + bounds.x + x
        if (!labels.has(analysis.labels[sourcePixel] ?? 0)) continue
        const sourceOffset = sourcePixel * 4
        const targetOffset = (y * bounds.w + x) * 4
        isolated.data[targetOffset] = source.data[sourceOffset]!
        isolated.data[targetOffset + 1] = source.data[sourceOffset + 1]!
        isolated.data[targetOffset + 2] = source.data[sourceOffset + 2]!
        isolated.data[targetOffset + 3] = source.data[sourceOffset + 3]!
      }
    }
    localContext.putImageData(isolated, 0, 0)
    const rotation = boundsMode === 'oriented' ? sprite.orientedBounds.angleDegrees : 0
    let prepared = local
    if (Math.abs(rotation) > 0.01) {
      const size = Math.max(1, Math.ceil(Math.hypot(bounds.w, bounds.h)) + 4)
      const rotated = document.createElement('canvas')
      rotated.width = size
      rotated.height = size
      const context = rotated.getContext('2d')!
      context.translate(size / 2, size / 2)
      context.rotate(-rotation * Math.PI / 180)
      context.drawImage(local, -bounds.w / 2, -bounds.h / 2)
      prepared = rotated
    }
    const trimmed = trimCanvas(prepared, alphaThreshold)
    return {
      canvas: trimmed.canvas,
      index,
      filename: `sprite_${String(index).padStart(3, '0')}`,
      sourceFrameId: index,
      width: trimmed.bounds.w,
      height: trimmed.bounds.h,
      empty: trimmed.bounds.empty,
      sourceBounds: bounds,
      sourceSize: { w: sheet.width, h: sheet.height },
      pivot: { x: 0.5, y: 1 },
      duration: 100,
      boundsMode,
      sourceRotationDegrees: rotation,
      sourcePolygon: sprite.polygon,
    }
  })
}

function orientedCorners(sprite: SpriteSheetDetection['sprites'][number]) {
  const rect = sprite.orientedBounds
  const angle = rect.angleDegrees * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [
    { x: -rect.w / 2, y: -rect.h / 2 },
    { x: rect.w / 2, y: -rect.h / 2 },
    { x: rect.w / 2, y: rect.h / 2 },
    { x: -rect.w / 2, y: rect.h / 2 },
  ].map((point) => ({
    x: rect.cx + point.x * cos - point.y * sin,
    y: rect.cy + point.x * sin + point.y * cos,
  }))
}

export function renderSpriteDetectionOverlay(
  sheet: HTMLCanvasElement,
  analysis: SpriteSheetDetection,
) {
  const canvas = document.createElement('canvas')
  canvas.width = sheet.width
  canvas.height = sheet.height
  const context = canvas.getContext('2d')!
  context.drawImage(sheet, 0, 0)
  const scale = Math.max(1, Math.max(sheet.width, sheet.height) / 900)
  context.lineWidth = 2 * scale
  context.font = `700 ${12 * scale}px monospace`
  const grid = analysis.gridCandidate
  if (grid) {
    context.save()
    context.strokeStyle = '#f7dd5c'
    context.setLineDash([7 * scale, 5 * scale])
    for (let column = 1; column < grid.columns; column += 1) {
      const x = column * grid.cellWidth
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, sheet.height); context.stroke()
    }
    for (let row = 1; row < grid.rows; row += 1) {
      const y = row * grid.cellHeight
      context.beginPath(); context.moveTo(0, y); context.lineTo(sheet.width, y); context.stroke()
    }
    context.restore()
  }
  analysis.sprites.forEach((sprite) => {
    context.strokeStyle = '#c7f36a'
    context.setLineDash([])
    context.strokeRect(sprite.bounds.x, sprite.bounds.y, sprite.bounds.w, sprite.bounds.h)
    context.strokeStyle = '#58cfff'
    context.beginPath()
    sprite.polygon.forEach((point, index) => index === 0
      ? context.moveTo(point.x, point.y)
      : context.lineTo(point.x, point.y))
    context.closePath(); context.stroke()
    context.strokeStyle = '#ff8a50'
    context.setLineDash([5 * scale, 3 * scale])
    context.beginPath()
    orientedCorners(sprite).forEach((point, index) => index === 0
      ? context.moveTo(point.x, point.y)
      : context.lineTo(point.x, point.y))
    context.closePath(); context.stroke()
    context.setLineDash([])
    context.lineWidth = 3 * scale
    context.strokeStyle = '#ffffff'
    context.strokeText(String(sprite.id), sprite.bounds.x + 3 * scale, sprite.bounds.y + 13 * scale)
    context.fillStyle = '#111111'
    context.fillText(String(sprite.id), sprite.bounds.x + 3 * scale, sprite.bounds.y + 13 * scale)
    context.lineWidth = 2 * scale
  })
  return canvas
}

const canvasPngBytes = (canvas: HTMLCanvasElement) => new Promise<Uint8Array>((resolve, reject) => {
  canvas.toBlob((blob) => {
    if (!blob) {
      reject(new Error('无法编码 Sprite PNG'))
      return
    }
    void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
  }, 'image/png')
})

export async function downloadSpriteSlicesZip(
  slices: SpriteSlice[],
  basename: string,
  source: { image: string; alphaThreshold: number },
) {
  const folder = `${basename}-sprites`
  const files: Record<string, Uint8Array> = {}
  await Promise.all(slices.map(async (slice) => {
    files[`${folder}/${slice.filename}.png`] = await canvasPngBytes(slice.canvas)
  }))
  files[`${folder}/sprites.json`] = strToU8(JSON.stringify({
    format: 'frameloop-sprite-slices-v1',
    image: source.image,
    alphaThreshold: source.alphaThreshold,
    frameCount: slices.length,
    frames: slices.map(({ canvas: _canvas, ...slice }) => ({
      ...slice,
      file: `${slice.filename}.png`,
    })),
  }, null, 2))
  const url = URL.createObjectURL(new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }))
  downloadDataUrl(url, `${folder}.zip`)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  link.click()
}

export function downloadText(content: string, filename: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  downloadDataUrl(url, filename)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function downloadJson(data: unknown, filename: string): void {
  downloadText(JSON.stringify(data, null, 2), filename, 'application/json')
}
