import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import sharp from 'sharp'
import type { MatteConflictPolicy } from './matting.js'

export interface MattePoint {
  x: number
  y: number
}

export interface MatteCorrectionStroke {
  frameIndex: number
  mode: 'remove' | 'restore'
  diameterPixels: number
  coordinateSpace?: 'pixel' | 'normalized'
  points: MattePoint[]
}

export interface MatteRegion {
  area: number
  bounds: { x: number; y: number; width: number; height: number }
  center: { x: number; y: number }
}

export interface MatteQualityFrame {
  frameIndex: number
  path: string
  width: number
  height: number
  foregroundPixels: number
  transparentPixels: number
  partiallyTransparentPixels: number
  foregroundComponents: number
  suspiciousDetachedComponents: MatteRegion[]
  suspiciousHoles: MatteRegion[]
}

interface LoadedRgba {
  data: Buffer
  width: number
  height: number
}

interface Component extends MatteRegion {
  pixels?: number[]
  touchesBorder: boolean
}

async function loadRgba(path: string): Promise<LoadedRgba> {
  const absolute = resolve(path)
  await access(absolute)
  const { data, info } = await sharp(absolute).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

function alphaAt(data: Buffer, index: number) {
  return data[index * 4 + 3] ?? 0
}

function connectedComponents(
  data: Buffer,
  width: number,
  height: number,
  foreground: boolean,
  alphaThreshold: number,
  collectPixels = false,
) {
  const pixelCount = width * height
  const visited = new Uint8Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  const components: Component[] = []
  const matches = (index: number) => foreground
    ? alphaAt(data, index) >= alphaThreshold
    : alphaAt(data, index) < alphaThreshold

  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] || !matches(start)) continue
    let head = 0
    let tail = 0
    queue[tail++] = start
    visited[start] = 1
    const pixels = collectPixels ? [] as number[] : undefined
    let area = 0
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    let touchesBorder = false

    while (head < tail) {
      const index = queue[head++]!
      area += 1
      pixels?.push(index)
      const x = index % width
      const y = Math.floor(index / width)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true

      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1,
      ]
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor] || !matches(neighbor)) continue
        visited[neighbor] = 1
        queue[tail++] = neighbor
      }
    }

    components.push({
      area,
      bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      pixels,
      touchesBorder,
    })
  }
  return components.sort((a, b) => b.area - a.area)
}

function publicRegion(component: Component): MatteRegion {
  return { area: component.area, bounds: component.bounds, center: component.center }
}

function analyzeLoadedMatte(
  loaded: LoadedRgba,
  frameIndex: number,
  path: string,
  options: { alphaThreshold: number; detachedAreaThreshold: number; holeAreaThreshold: number; maxRegions: number },
): MatteQualityFrame {
  let foregroundPixels = 0
  let transparentPixels = 0
  let partiallyTransparentPixels = 0
  for (let index = 0; index < loaded.width * loaded.height; index += 1) {
    const alpha = alphaAt(loaded.data, index)
    if (alpha >= options.alphaThreshold) foregroundPixels += 1
    else transparentPixels += 1
    if (alpha > 0 && alpha < 255) partiallyTransparentPixels += 1
  }
  const foreground = connectedComponents(loaded.data, loaded.width, loaded.height, true, options.alphaThreshold)
  const background = connectedComponents(loaded.data, loaded.width, loaded.height, false, options.alphaThreshold)
  const detached = foreground.slice(1)
    .filter((region) => region.area <= options.detachedAreaThreshold)
    .slice(0, options.maxRegions)
    .map(publicRegion)
  const holes = background
    .filter((region) => !region.touchesBorder && region.area <= options.holeAreaThreshold)
    .slice(0, options.maxRegions)
    .map(publicRegion)
  return {
    frameIndex,
    path: resolve(path),
    width: loaded.width,
    height: loaded.height,
    foregroundPixels,
    transparentPixels,
    partiallyTransparentPixels,
    foregroundComponents: foreground.length,
    suspiciousDetachedComponents: detached,
    suspiciousHoles: holes,
  }
}

export async function analyzeMatteQuality(options: {
  mattePaths: string[]
  alphaThreshold?: number
  detachedAreaThreshold?: number
  holeAreaThreshold?: number
  maxRegionsPerFrame?: number
  onProgress?: (completed: number, total: number, message: string) => void | Promise<void>
}) {
  if (options.mattePaths.length === 0) throw new Error('matte_paths 不能为空')
  const settings = {
    alphaThreshold: options.alphaThreshold ?? 128,
    detachedAreaThreshold: options.detachedAreaThreshold ?? 64,
    holeAreaThreshold: options.holeAreaThreshold ?? 64,
    maxRegions: options.maxRegionsPerFrame ?? 20,
  }
  const frames: MatteQualityFrame[] = []
  for (let index = 0; index < options.mattePaths.length; index += 1) {
    const path = options.mattePaths[index]!
    frames.push(analyzeLoadedMatte(await loadRgba(path), index, path, settings))
    await options.onProgress?.(index + 1, options.mattePaths.length, `已诊断蒙版帧 ${index + 1}`)
  }
  return {
    frameCount: frames.length,
    settings: {
      alphaThreshold: settings.alphaThreshold,
      detachedAreaThreshold: settings.detachedAreaThreshold,
      holeAreaThreshold: settings.holeAreaThreshold,
      maxRegionsPerFrame: settings.maxRegions,
    },
    summary: {
      suspiciousDetachedComponents: frames.reduce((sum, frame) => sum + frame.suspiciousDetachedComponents.length, 0),
      suspiciousHoles: frames.reduce((sum, frame) => sum + frame.suspiciousHoles.length, 0),
      partiallyTransparentPixels: frames.reduce((sum, frame) => sum + frame.partiallyTransparentPixels, 0),
    },
    frames,
  }
}

function stampCircle(
  target: Set<number>,
  centerX: number,
  centerY: number,
  radius: number,
  width: number,
  height: number,
) {
  const minX = Math.max(0, Math.floor(centerX - radius))
  const maxX = Math.min(width - 1, Math.ceil(centerX + radius))
  const minY = Math.max(0, Math.floor(centerY - radius))
  const maxY = Math.min(height - 1, Math.ceil(centerY + radius))
  const radiusSquared = radius * radius
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - centerX
      const dy = y - centerY
      if (dx * dx + dy * dy <= radiusSquared) target.add(y * width + x)
    }
  }
}

function strokePixels(stroke: MatteCorrectionStroke, width: number, height: number) {
  const pixels = new Set<number>()
  const scalePoint = (point: MattePoint) => stroke.coordinateSpace === 'normalized'
    ? { x: point.x * (width - 1), y: point.y * (height - 1) }
    : point
  const points = stroke.points.map(scalePoint)
  const radius = Math.max(0.5, stroke.diameterPixels / 2)
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]!
    const end = points[index + 1] ?? start
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y))))
    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps
      stampCircle(
        pixels,
        start.x + (end.x - start.x) * ratio,
        start.y + (end.y - start.y) * ratio,
        radius,
        width,
        height,
      )
    }
  }
  return pixels
}

function restorePixel(output: Buffer, source: Buffer, pixelIndex: number) {
  const offset = pixelIndex * 4
  output[offset] = source[offset] ?? 0
  output[offset + 1] = source[offset + 1] ?? 0
  output[offset + 2] = source[offset + 2] ?? 0
  output[offset + 3] = source[offset + 3] ?? 255
}

function removePixel(output: Buffer, pixelIndex: number) {
  const offset = pixelIndex * 4
  output[offset] = 0
  output[offset + 1] = 0
  output[offset + 2] = 0
  output[offset + 3] = 0
}

async function prepareOutputs(outputDirectory: string, mattePaths: string[], policy: MatteConflictPolicy) {
  const directory = resolve(outputDirectory)
  const paths = mattePaths.map((path, index) => {
    const stem = basename(path, extname(path)).replace(/[^\p{L}\p{N}_-]+/gu, '-')
    return join(directory, `${String(index + 1).padStart(6, '0')}_${stem || 'frame'}.png`)
  })
  const manifestPath = join(directory, 'matte-refinement-manifest.json')
  const existing: string[] = []
  for (const path of [...paths, manifestPath]) {
    if (await access(path).then(() => true).catch(() => false)) existing.push(path)
  }
  if (existing.length > 0 && policy === 'fail') throw new Error(`目标文件已存在：${existing[0]}`)
  await mkdir(directory, { recursive: true })
  if (policy === 'replace') await Promise.all([...paths, manifestPath].map((path) => rm(path, { force: true })))
  return { directory, paths, manifestPath }
}

export async function refineMatteBatch(options: {
  sourceFramePaths: string[]
  mattePaths: string[]
  outputDirectory: string
  corrections?: MatteCorrectionStroke[]
  alphaThreshold?: number
  removeIslandsBelow?: number
  fillHolesBelow?: number
  conflictPolicy?: MatteConflictPolicy
  onProgress?: (completed: number, total: number, message: string) => void | Promise<void>
}) {
  if (options.mattePaths.length === 0) throw new Error('matte_paths 不能为空')
  if (options.sourceFramePaths.length !== options.mattePaths.length) {
    throw new Error('source_frame_paths 与 matte_paths 数量必须一致')
  }
  const alphaThreshold = options.alphaThreshold ?? 128
  const removeIslandsBelow = Math.max(0, options.removeIslandsBelow ?? 0)
  const fillHolesBelow = Math.max(0, options.fillHolesBelow ?? 0)
  const corrections = options.corrections ?? []
  for (const correction of corrections) {
    if (correction.frameIndex < 0 || correction.frameIndex >= options.mattePaths.length) {
      throw new Error(`修正笔画 frame_index 越界：${correction.frameIndex}`)
    }
    if (correction.points.length === 0) throw new Error('修正笔画 points 不能为空')
    if (correction.coordinateSpace === 'normalized' && correction.points.some((point) => (
      point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1
    ))) {
      throw new Error('归一化坐标必须位于 0 到 1 之间')
    }
  }
  const outputs = await prepareOutputs(
    options.outputDirectory,
    options.mattePaths,
    options.conflictPolicy ?? 'fail',
  )
  const frameReports: Array<{
    frameIndex: number
    sourcePath: string
    mattePath: string
    outputPath: string
    removedIslandPixels: number
    filledHolePixels: number
    explicitStrokePixels: number
    correctionStrokes: number
  }> = []

  for (let index = 0; index < options.mattePaths.length; index += 1) {
    const source = await loadRgba(options.sourceFramePaths[index]!)
    const matte = await loadRgba(options.mattePaths[index]!)
    if (source.width !== matte.width || source.height !== matte.height) {
      throw new Error(`源帧与蒙版尺寸不一致：第 ${index + 1} 帧`)
    }
    const output = Buffer.from(matte.data)
    let removedIslandPixels = 0
    let filledHolePixels = 0
    if (removeIslandsBelow > 0) {
      const components = connectedComponents(output, matte.width, matte.height, true, alphaThreshold, true)
      for (const component of components.slice(1).filter((item) => item.area <= removeIslandsBelow)) {
        for (const pixel of component.pixels ?? []) removePixel(output, pixel)
        removedIslandPixels += component.area
      }
    }
    if (fillHolesBelow > 0) {
      const holes = connectedComponents(output, matte.width, matte.height, false, alphaThreshold, true)
        .filter((component) => !component.touchesBorder && component.area <= fillHolesBelow)
      for (const hole of holes) {
        for (const pixel of hole.pixels ?? []) restorePixel(output, source.data, pixel)
        filledHolePixels += hole.area
      }
    }

    const frameCorrections = corrections.filter((correction) => correction.frameIndex === index)
    const changedByStrokes = new Set<number>()
    for (const correction of frameCorrections) {
      for (const pixel of strokePixels(correction, matte.width, matte.height)) {
        if (correction.mode === 'remove') removePixel(output, pixel)
        else restorePixel(output, source.data, pixel)
        changedByStrokes.add(pixel)
      }
    }
    await sharp(output, { raw: { width: matte.width, height: matte.height, channels: 4 } })
      .png()
      .toFile(outputs.paths[index]!)
    frameReports.push({
      frameIndex: index,
      sourcePath: resolve(options.sourceFramePaths[index]!),
      mattePath: resolve(options.mattePaths[index]!),
      outputPath: outputs.paths[index]!,
      removedIslandPixels,
      filledHolePixels,
      explicitStrokePixels: changedByStrokes.size,
      correctionStrokes: frameCorrections.length,
    })
    await options.onProgress?.(index + 1, options.mattePaths.length, `已精修蒙版帧 ${index + 1}`)
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    outputDirectory: outputs.directory,
    settings: { alphaThreshold, removeIslandsBelow, fillHolesBelow },
    summary: {
      frameCount: frameReports.length,
      correctionStrokes: corrections.length,
      removedIslandPixels: frameReports.reduce((sum, frame) => sum + frame.removedIslandPixels, 0),
      filledHolePixels: frameReports.reduce((sum, frame) => sum + frame.filledHolePixels, 0),
      explicitStrokePixels: frameReports.reduce((sum, frame) => sum + frame.explicitStrokePixels, 0),
    },
    frames: frameReports,
  }
  await writeFile(outputs.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { ...manifest, manifestPath: outputs.manifestPath, files: outputs.paths }
}
