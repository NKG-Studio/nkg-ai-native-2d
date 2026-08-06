import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import {
  analyzeSpriteSheet,
  createSpriteLayout,
  createTightSpriteLayout,
  type SpriteBackgroundMode,
  type SpriteBoundsMode,
  type SpriteDetectionPoint,
} from '@frameloop/core'
import sharp from 'sharp'

export type SpriteBundlePreset = 'generic' | 'aseprite' | 'godot' | 'unity'
export type SpriteTrimMode = 'grid' | 'tight'
export type BundleConflictPolicy = 'fail' | 'replace'

export interface SpriteBundleAnimationInput {
  name: string
  framePaths: string[]
  durations?: number[]
  sourceFrameIds?: number[]
}

interface Rect { x: number; y: number; w: number; h: number }

export interface SpriteBundleFrame {
  index: number
  animation: string
  animationFrame: number
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

export interface SpriteBundleManifest {
  version: 3
  image: string
  preset: SpriteBundlePreset
  trimMode: SpriteTrimMode
  alphaThreshold: number
  sheetSize: { width: number; height: number }
  columns: number
  rows: number
  padding: number
  animations: Array<{
    name: string
    loop: true
    from: number
    to: number
    frameCount: number
    duration: number
  }>
  frames: SpriteBundleFrame[]
}

export interface SpriteSliceManifest {
  format: 'frameloop-sprite-slices-v1'
  image: string
  sourceManifest: string | null
  alphaThreshold: number
  frameCount: number
  frames: Array<{
    index: number
    filename: string
    sourceFrameId: number
    animation?: string
    animationFrame?: number
    file: string
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
  }>
}

export type SpriteCustomRegion = {
  type: 'rect'
  name?: string
  x: number
  y: number
  w: number
  h: number
} | {
  type: 'rotated_rect'
  name?: string
  cx: number
  cy: number
  w: number
  h: number
  angleDegrees: number
} | {
  type: 'polygon'
  name?: string
  points: SpriteDetectionPoint[]
  angleDegrees?: number
}

interface PreparedFrame {
  path: string
  animation: string
  animationFrame: number
  sourceFrameId: number
  duration: number
  width: number
  height: number
  trim: Rect & { empty: boolean }
}

const safeName = (value: string) => value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-') || 'animation'

function opaqueBounds(data: Buffer, width: number, height: number, threshold: number) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) < threshold) continue
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

async function prepareFrames(animations: SpriteBundleAnimationInput[], trimMode: SpriteTrimMode, alphaThreshold: number) {
  const names = new Set<string>()
  const frames: PreparedFrame[] = []
  for (const animation of animations) {
    const name = safeName(animation.name)
    if (names.has(name)) throw new Error(`动画名称冲突：${name}`)
    names.add(name)
    if (animation.framePaths.length === 0) throw new Error(`${name} 没有可导出的帧`)
    if (animation.durations && animation.durations.length !== animation.framePaths.length) {
      throw new Error(`${name} 的 durations 数量必须与 frame_paths 一致`)
    }
    if (animation.sourceFrameIds && animation.sourceFrameIds.length !== animation.framePaths.length) {
      throw new Error(`${name} 的 source_frame_ids 数量必须与 frame_paths 一致`)
    }
    for (let index = 0; index < animation.framePaths.length; index += 1) {
      const path = resolve(animation.framePaths[index]!)
      await access(path)
      const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const trim = trimMode === 'tight'
        ? opaqueBounds(data, info.width, info.height, alphaThreshold)
        : { x: 0, y: 0, w: info.width, h: info.height, empty: false }
      frames.push({
        path,
        animation: name,
        animationFrame: index,
        sourceFrameId: animation.sourceFrameIds?.[index] ?? index,
        duration: Math.max(1, Math.round(animation.durations?.[index] ?? 100)),
        width: info.width,
        height: info.height,
        trim,
      })
    }
  }
  return frames
}

function asepriteManifest(manifest: SpriteBundleManifest) {
  return {
    frames: Object.fromEntries(manifest.frames.map((item) => [item.filename, {
      frame: item.frame,
      rotated: false,
      trimmed: item.trimmed,
      spriteSourceSize: item.spriteSourceSize,
      sourceSize: item.sourceSize,
      duration: item.duration,
    }])),
    meta: {
      app: 'FrameLoop Studio',
      version: String(manifest.version),
      image: manifest.image,
      format: 'RGBA8888',
      size: { w: manifest.sheetSize.width, h: manifest.sheetSize.height },
      scale: '1',
      frameTags: manifest.animations.map((item) => ({
        name: item.name, from: item.from, to: item.to, direction: 'forward',
      })),
      slices: manifest.frames.length > 0 ? [{
        name: 'pivot',
        color: '#c7f36a',
        keys: manifest.frames.map((item) => ({
          frame: item.index,
          bounds: { x: 0, y: 0, w: item.sourceSize.w, h: item.sourceSize.h },
          pivot: {
            x: Math.round(item.pivot.x * item.sourceSize.w),
            y: Math.round(item.pivot.y * item.sourceSize.h),
          },
        })),
      }] : [],
    },
  }
}

function godotManifest(manifest: SpriteBundleManifest) {
  const resources = manifest.frames.map((frame) => {
    const id = `AtlasTexture_${String(frame.index).padStart(4, '0')}`
    const missingWidth = Math.max(0, frame.sourceSize.w - frame.spriteSourceSize.w)
    const missingHeight = Math.max(0, frame.sourceSize.h - frame.spriteSourceSize.h)
    return `[sub_resource type="AtlasTexture" id="${id}"]\n`
      + 'atlas = ExtResource("1_sheet")\n'
      + `region = Rect2(${frame.frame.x}, ${frame.frame.y}, ${frame.frame.w}, ${frame.frame.h})\n`
      + `margin = Rect2(${frame.spriteSourceSize.x}, ${frame.spriteSourceSize.y}, ${missingWidth}, ${missingHeight})\n`
      + 'filter_clip = true'
  })
  const animations = manifest.animations.map((animation) => {
    const frames = manifest.frames.slice(animation.from, animation.to + 1)
      .map((frame) => `{"duration": ${frame.duration}, "texture": SubResource("AtlasTexture_${String(frame.index).padStart(4, '0')}")}`)
      .join(', ')
    return `{"frames": [${frames}], "loop": true, "name": &${JSON.stringify(animation.name)}, "speed": 1000.0}`
  }).join(', ')
  return `[gd_resource type="SpriteFrames" load_steps=${resources.length + 2} format=3]\n\n`
    + `[ext_resource type="Texture2D" path="res://${manifest.image}" id="1_sheet"]\n\n`
    + `${resources.join('\n\n')}\n\n[resource]\nanimations = [${animations}]\n`
}

function unityManifest(manifest: SpriteBundleManifest, pixelsPerUnit: number) {
  return {
    format: 'frameloop-unity-sprite-v2',
    image: manifest.image,
    animations: manifest.animations,
    pixelsPerUnit: Math.max(1, Math.round(pixelsPerUnit)),
    coordinateSystem: 'bottom-left',
    frames: manifest.frames.map((item) => ({
      name: item.filename,
      animation: item.animation,
      animationFrame: item.animationFrame,
      sourceFrameId: item.sourceFrameId,
      rect: {
        x: item.frame.x,
        y: manifest.sheetSize.height - item.frame.y - item.frame.h,
        w: item.frame.w,
        h: item.frame.h,
      },
      pivot: {
        x: (item.pivot.x * item.sourceSize.w - item.spriteSourceSize.x) / item.spriteSourceSize.w,
        y: 1 - (item.pivot.y * item.sourceSize.h - item.spriteSourceSize.y) / item.spriteSourceSize.h,
      },
      duration: item.duration,
      sourceSize: item.sourceSize,
      spriteSourceSize: item.spriteSourceSize,
      empty: item.empty,
    })),
  }
}

export async function exportSpriteBundle(options: {
  animations: SpriteBundleAnimationInput[]
  outputPath: string
  preset?: SpriteBundlePreset
  trimMode?: SpriteTrimMode
  columns?: number
  padding?: number
  alphaThreshold?: number
  pivot?: { x: number; y: number }
  pixelsPerUnit?: number
  conflictPolicy?: BundleConflictPolicy
  onProgress?: (completed: number, total: number, message: string) => void | Promise<void>
}) {
  if (options.animations.length === 0) throw new Error('animations 不能为空')
  const outputPath = resolve(options.outputPath)
  if (extname(outputPath).toLowerCase() !== '.png') throw new Error('output_path 必须以 .png 结尾')
  const manifestPath = `${outputPath}.json`
  const preset = options.preset ?? 'generic'
  const trimMode = options.trimMode ?? 'grid'
  const alphaThreshold = Math.max(0, Math.min(255, Math.round(options.alphaThreshold ?? 1)))
  const padding = Math.max(0, Math.round(options.padding ?? 0))
  const conflictPolicy = options.conflictPolicy ?? 'fail'
  const companions = preset === 'generic'
    ? []
    : [preset === 'godot' ? outputPath.replace(/\.png$/i, '.tres') : `${outputPath}.${preset}.json`]
  const outputs = [outputPath, manifestPath, ...companions]
  const allGeneratedOutputs = [
    outputPath,
    manifestPath,
    outputPath.replace(/\.png$/i, '.tres'),
    `${outputPath}.aseprite.json`,
    `${outputPath}.unity.json`,
  ]
  const existing: string[] = []
  for (const path of outputs) {
    if (await access(path).then(() => true).catch(() => false)) existing.push(path)
  }
  if (existing.length > 0 && conflictPolicy === 'fail') throw new Error(`目标文件已存在：${existing.join(', ')}`)
  if (conflictPolicy === 'replace') await Promise.all(allGeneratedOutputs.map((path) => rm(path, { force: true })))

  const frames = await prepareFrames(options.animations, trimMode, alphaThreshold)
  await options.onProgress?.(1, 4, `已检查 ${frames.length} 帧`)
  const sourceWidth = Math.max(...frames.map((frame) => frame.width))
  const sourceHeight = Math.max(...frames.map((frame) => frame.height))
  const columns = Math.max(1, Math.round(options.columns ?? Math.ceil(Math.sqrt(frames.length))))
  const layout = trimMode === 'tight'
    ? createTightSpriteLayout({ frames: frames.map((frame) => frame.trim), columns, padding })
    : createSpriteLayout({
        frameWidth: sourceWidth,
        frameHeight: sourceHeight,
        frameCount: frames.length,
        columns,
        padding,
      })
  const composites = await Promise.all(frames.map(async (frame, index) => {
    const slot = layout.frames[index]!
    if (frame.trim.empty) return null
    const image = trimMode === 'tight'
      ? sharp(frame.path).ensureAlpha().extract({
          left: frame.trim.x, top: frame.trim.y, width: frame.trim.w, height: frame.trim.h,
        })
      : sharp(frame.path).ensureAlpha()
    return { input: await image.png().toBuffer(), left: slot.x, top: slot.y }
  }))
  await mkdir(dirname(outputPath), { recursive: true })
  await sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(composites.filter((item): item is NonNullable<typeof item> => item !== null)).png().toFile(outputPath)
  await options.onProgress?.(2, 4, '已合成 Atlas')

  const pivot = {
    x: Math.max(0, Math.min(1, options.pivot?.x ?? 0.5)),
    y: Math.max(0, Math.min(1, options.pivot?.y ?? 1)),
  }
  const manifestFrames: SpriteBundleFrame[] = frames.map((source, index) => {
    const slot = layout.frames[index]!
    return {
      index,
      animation: source.animation,
      animationFrame: source.animationFrame,
      sourceFrameId: source.sourceFrameId,
      filename: `${source.animation}_${String(source.animationFrame).padStart(3, '0')}`,
      frame: { x: slot.x, y: slot.y, w: slot.w, h: slot.h },
      rotated: false,
      trimmed: trimMode === 'tight'
        && (source.trim.x !== 0 || source.trim.y !== 0 || source.trim.w !== source.width || source.trim.h !== source.height),
      empty: source.trim.empty,
      spriteSourceSize: source.trim,
      sourceSize: { w: source.width, h: source.height },
      pivot,
      duration: source.duration,
    }
  })
  let offset = 0
  const animations = options.animations.map((input) => {
    const name = safeName(input.name)
    const animationFrames = manifestFrames.slice(offset, offset + input.framePaths.length)
    const result = {
      name,
      loop: true as const,
      from: offset,
      to: offset + input.framePaths.length - 1,
      frameCount: input.framePaths.length,
      duration: animationFrames.reduce((sum, frame) => sum + frame.duration, 0),
    }
    offset += input.framePaths.length
    return result
  })
  const manifest: SpriteBundleManifest = {
    version: 3,
    image: basename(outputPath),
    preset,
    trimMode,
    alphaThreshold,
    sheetSize: { width: layout.width, height: layout.height },
    columns: layout.columns,
    rows: layout.rows,
    padding,
    animations,
    frames: manifestFrames,
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  await options.onProgress?.(3, 4, '已写入通用 Manifest')
  let companionPath: string | null = null
  if (preset !== 'generic') {
    companionPath = companions[0]!
    const content = preset === 'aseprite'
      ? JSON.stringify(asepriteManifest(manifest), null, 2)
      : preset === 'godot'
        ? godotManifest(manifest)
        : JSON.stringify(unityManifest(manifest, options.pixelsPerUnit ?? 100), null, 2)
    await writeFile(companionPath, content, 'utf8')
  }
  await options.onProgress?.(4, 4, 'Sprite Bundle 已完成')
  return {
    outputPath,
    manifestPath,
    companionPath,
    preset,
    width: layout.width,
    height: layout.height,
    frameCount: frames.length,
    animationCount: animations.length,
  }
}

interface IrregularSlicePlan {
  name: string
  sourceBounds: Rect
  polygon: SpriteDetectionPoint[]
  labelIds?: number[]
  rotationDegrees: number
}

function rotatedRectPoints(region: Extract<SpriteCustomRegion, { type: 'rotated_rect' }>) {
  const angle = region.angleDegrees * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [
    { x: -region.w / 2, y: -region.h / 2 },
    { x: region.w / 2, y: -region.h / 2 },
    { x: region.w / 2, y: region.h / 2 },
    { x: -region.w / 2, y: region.h / 2 },
  ].map((point) => ({
    x: region.cx + point.x * cos - point.y * sin,
    y: region.cy + point.x * sin + point.y * cos,
  }))
}

function polygonBounds(points: SpriteDetectionPoint[]) {
  if (points.length < 3) throw new Error('polygon 至少需要 3 个点')
  const minX = Math.floor(Math.min(...points.map((point) => point.x)))
  const minY = Math.floor(Math.min(...points.map((point) => point.y)))
  const maxX = Math.ceil(Math.max(...points.map((point) => point.x)))
  const maxY = Math.ceil(Math.max(...points.map((point) => point.y)))
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

function pointInPolygon(x: number, y: number, polygon: SpriteDetectionPoint[]) {
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current]!
    const b = polygon[previous]!
    if ((a.y > y) !== (b.y > y)
      && x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || Number.EPSILON) + a.x) inside = !inside
  }
  return inside
}

async function sliceIrregularSpriteSheet(options: {
  atlasPath: string
  outputDirectory?: string
  mode: 'components' | 'regions'
  boundsMode: SpriteBoundsMode
  regions?: SpriteCustomRegion[]
  backgroundMode?: SpriteBackgroundMode
  alphaThreshold?: number
  backgroundTolerance?: number
  minArea?: number
  mergeGap?: number
  removeBackground?: boolean
  conflictPolicy?: BundleConflictPolicy
  onProgress?: (completed: number, total: number, message: string) => void | Promise<void>
}) {
  const imagePath = resolve(options.atlasPath)
  const { data, info } = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const alphaThreshold = Math.max(0, Math.min(255, Math.round(options.alphaThreshold ?? 1)))
  const analysis = analyzeSpriteSheet(data, info.width, info.height, {
    backgroundMode: options.backgroundMode ?? 'auto',
    alphaThreshold,
    backgroundTolerance: options.backgroundTolerance,
    minArea: options.minArea,
    mergeGap: options.mergeGap,
  })
  let plans: IrregularSlicePlan[]
  if (options.mode === 'components') {
    if (analysis.sprites.length === 0) throw new Error('没有检测到可切出的 Sprite 区域')
    plans = analysis.sprites.map((sprite, index) => ({
      name: `sprite_${String(index).padStart(3, '0')}`,
      sourceBounds: sprite.bounds,
      polygon: sprite.polygon,
      labelIds: sprite.labelIds,
      rotationDegrees: options.boundsMode === 'oriented' ? sprite.orientedBounds.angleDegrees : 0,
    }))
  } else {
    if (!options.regions?.length) throw new Error('regions 模式必须提供至少一个区域')
    plans = options.regions.map((region, index) => {
      const name = safeName(region.name ?? `sprite_${String(index).padStart(3, '0')}`)
      if (region.type === 'rect') {
        const sourceBounds = {
          x: Math.round(region.x), y: Math.round(region.y),
          w: Math.max(1, Math.round(region.w)), h: Math.max(1, Math.round(region.h)),
        }
        return {
          name,
          sourceBounds,
          polygon: [
            { x: sourceBounds.x, y: sourceBounds.y },
            { x: sourceBounds.x + sourceBounds.w, y: sourceBounds.y },
            { x: sourceBounds.x + sourceBounds.w, y: sourceBounds.y + sourceBounds.h },
            { x: sourceBounds.x, y: sourceBounds.y + sourceBounds.h },
          ],
          rotationDegrees: 0,
        }
      }
      const polygon = region.type === 'rotated_rect' ? rotatedRectPoints(region) : region.points
      return {
        name,
        sourceBounds: polygonBounds(polygon),
        polygon,
        rotationDegrees: region.type === 'rotated_rect'
          ? region.angleDegrees
          : (options.boundsMode === 'oriented' ? (region.angleDegrees ?? 0) : 0),
      }
    })
  }
  const names = plans.map((plan) => safeName(plan.name))
  if (new Set(names).size !== names.length) throw new Error('切图文件名冲突')
  for (const plan of plans) {
    const bounds = plan.sourceBounds
    if (bounds.x < 0 || bounds.y < 0 || bounds.w < 1 || bounds.h < 1
      || bounds.x + bounds.w > info.width || bounds.y + bounds.h > info.height) {
      throw new Error(`区域越出 Atlas：${plan.name}`)
    }
  }
  const outputDirectory = resolve(options.outputDirectory
    ?? `${imagePath.slice(0, imagePath.length - extname(imagePath).length)}-sprites`)
  const manifestPath = resolve(outputDirectory, 'sprites.json')
  const files = names.map((name) => resolve(outputDirectory, `${name}.png`))
  const existing: string[] = []
  for (const path of [...files, manifestPath]) {
    if (await access(path).then(() => true).catch(() => false)) existing.push(path)
  }
  const conflictPolicy = options.conflictPolicy ?? 'fail'
  if (existing.length > 0 && conflictPolicy === 'fail') throw new Error(`目标文件已存在：${existing.join(', ')}`)
  if (conflictPolicy === 'replace') await Promise.all([...files, manifestPath].map((path) => rm(path, { force: true })))
  await mkdir(outputDirectory, { recursive: true })
  const manifestFrames: SpriteSliceManifest['frames'] = []
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]!
    const labelIds = plan.labelIds ? new Set(plan.labelIds) : null
    const bounds = plan.sourceBounds
    const crop = Buffer.alloc(bounds.w * bounds.h * 4)
    for (let localY = 0; localY < bounds.h; localY += 1) {
      for (let localX = 0; localX < bounds.w; localX += 1) {
        const sourceX = bounds.x + localX
        const sourceY = bounds.y + localY
        const sourcePixel = sourceY * info.width + sourceX
        const inShape = labelIds
          ? labelIds.has(analysis.labels[sourcePixel] ?? 0)
          : pointInPolygon(sourceX + 0.5, sourceY + 0.5, plan.polygon)
        if (!inShape || (options.removeBackground !== false && !analysis.foregroundMask[sourcePixel])) continue
        const sourceOffset = sourcePixel * 4
        const targetOffset = (localY * bounds.w + localX) * 4
        data.copy(crop, targetOffset, sourceOffset, sourceOffset + 4)
      }
    }
    let processed = await sharp(crop, { raw: { width: bounds.w, height: bounds.h, channels: 4 } })
      .rotate(-plan.rotationDegrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .raw().toBuffer({ resolveWithObject: true })
    const trim = opaqueBounds(processed.data, processed.info.width, processed.info.height, alphaThreshold)
    const outputPath = files[index]!
    if (trim.empty) {
      await sharp({
        create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      }).png().toFile(outputPath)
    } else {
      await sharp(processed.data, {
        raw: { width: processed.info.width, height: processed.info.height, channels: processed.info.channels },
      }).extract({ left: trim.x, top: trim.y, width: trim.w, height: trim.h }).png().toFile(outputPath)
    }
    manifestFrames.push({
      index,
      filename: names[index]!,
      sourceFrameId: index,
      file: basename(outputPath),
      width: trim.w,
      height: trim.h,
      empty: trim.empty,
      sourceBounds: bounds,
      sourceSize: { w: info.width, h: info.height },
      pivot: { x: 0.5, y: 1 },
      duration: 100,
      boundsMode: options.boundsMode,
      sourceRotationDegrees: plan.rotationDegrees,
      sourcePolygon: plan.polygon,
    })
    await options.onProgress?.(index + 1, plans.length, `已切出 ${index + 1}/${plans.length} 张`)
  }
  const manifest: SpriteSliceManifest & { mode: 'components' | 'regions'; heuristicDiagnostics?: unknown } = {
    format: 'frameloop-sprite-slices-v1',
    image: basename(imagePath),
    sourceManifest: null,
    alphaThreshold,
    frameCount: manifestFrames.length,
    mode: options.mode,
    frames: manifestFrames,
    heuristicDiagnostics: options.mode === 'components' ? {
      background: analysis.background,
      gridCandidate: analysis.gridCandidate,
      suggestion: analysis.recommendation,
      warnings: analysis.warnings,
    } : undefined,
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  return {
    outputDirectory,
    manifestPath,
    frameCount: manifestFrames.length,
    emptyFrameCount: manifestFrames.filter((frame) => frame.empty).length,
    files,
    mode: options.mode,
    boundsMode: options.boundsMode,
  }
}

export async function sliceSpriteSheet(options: {
  manifestPath?: string
  atlasPath?: string
  outputDirectory?: string
  columns?: number
  rows?: number
  padding?: number
  frameCount?: number
  mode?: 'grid' | 'components' | 'regions'
  boundsMode?: SpriteBoundsMode
  regions?: SpriteCustomRegion[]
  backgroundMode?: SpriteBackgroundMode
  backgroundTolerance?: number
  minArea?: number
  mergeGap?: number
  removeBackground?: boolean
  alphaThreshold?: number
  conflictPolicy?: BundleConflictPolicy
  onProgress?: (completed: number, total: number, message: string) => void | Promise<void>
}) {
  if (Boolean(options.manifestPath) === Boolean(options.atlasPath)) {
    throw new Error('manifest_path 与 atlas_path 必须且只能提供一个')
  }
  const sourceManifestPath = options.manifestPath ? resolve(options.manifestPath) : null
  const requestedMode = options.mode ?? (options.regions?.length ? 'regions' : options.columns || options.rows ? 'grid' : 'components')
  if (!sourceManifestPath && requestedMode !== 'grid') {
    return sliceIrregularSpriteSheet({
      atlasPath: options.atlasPath!,
      outputDirectory: options.outputDirectory,
      mode: requestedMode,
      boundsMode: options.boundsMode ?? 'axis_aligned',
      regions: options.regions,
      backgroundMode: options.backgroundMode,
      alphaThreshold: options.alphaThreshold,
      backgroundTolerance: options.backgroundTolerance,
      minArea: options.minArea,
      mergeGap: options.mergeGap,
      removeBackground: options.removeBackground,
      conflictPolicy: options.conflictPolicy,
      onProgress: options.onProgress,
    })
  }
  let manifest: SpriteBundleManifest
  let imagePath: string
  if (sourceManifestPath) {
    manifest = JSON.parse(await readFile(sourceManifestPath, 'utf8')) as SpriteBundleManifest
    if (![2, 3].includes(manifest.version) || !manifest.image || !Array.isArray(manifest.frames)) {
      throw new Error('不支持的 Sprite Manifest')
    }
    imagePath = resolve(dirname(sourceManifestPath), manifest.image)
  } else {
    imagePath = resolve(options.atlasPath!)
    const metadata = await sharp(imagePath).metadata()
    if (!metadata.width || !metadata.height) throw new Error('无法读取 Atlas 尺寸')
    const columns = Math.max(1, Math.round(options.columns ?? 1))
    const rows = Math.max(1, Math.round(options.rows ?? 1))
    const padding = Math.max(0, Math.round(options.padding ?? 0))
    const availableWidth = metadata.width - Math.max(0, columns - 1) * padding
    const availableHeight = metadata.height - Math.max(0, rows - 1) * padding
    if (availableWidth < columns || availableHeight < rows
      || availableWidth % columns !== 0 || availableHeight % rows !== 0) {
      throw new Error('Atlas 尺寸无法按指定行列与间距整除')
    }
    const frameWidth = availableWidth / columns
    const frameHeight = availableHeight / rows
    const slotCount = columns * rows
    const frameCount = Math.round(options.frameCount ?? slotCount)
    if (frameCount < 1 || frameCount > slotCount) throw new Error(`frame_count 必须在 1 到 ${slotCount} 之间`)
    manifest = {
      version: 3,
      image: basename(imagePath),
      preset: 'generic',
      trimMode: 'grid',
      alphaThreshold: options.alphaThreshold ?? 1,
      sheetSize: { width: metadata.width, height: metadata.height },
      columns,
      rows,
      padding,
      animations: [{
        name: 'sprite', loop: true, from: 0, to: frameCount - 1, frameCount, duration: frameCount * 100,
      }],
      frames: Array.from({ length: frameCount }, (_, index) => ({
        index,
        animation: 'sprite',
        animationFrame: index,
        sourceFrameId: index,
        filename: `sprite_${String(index).padStart(3, '0')}`,
        frame: {
          x: (index % columns) * (frameWidth + padding),
          y: Math.floor(index / columns) * (frameHeight + padding),
          w: frameWidth,
          h: frameHeight,
        },
        rotated: false,
        trimmed: false,
        empty: false,
        spriteSourceSize: { x: 0, y: 0, w: frameWidth, h: frameHeight },
        sourceSize: { w: frameWidth, h: frameHeight },
        pivot: { x: 0.5, y: 1 },
        duration: 100,
      })),
    }
  }
  const metadata = await sharp(imagePath).metadata()
  if (!metadata.width || !metadata.height) throw new Error('无法读取 Atlas 尺寸')
  const outputDirectory = resolve(options.outputDirectory
    ?? `${imagePath.slice(0, imagePath.length - extname(imagePath).length)}-sprites`)
  const sliceManifestPath = resolve(outputDirectory, 'sprites.json')
  const alphaThreshold = Math.max(0, Math.min(255, Math.round(
    options.alphaThreshold ?? manifest.alphaThreshold ?? 1,
  )))
  const conflictPolicy = options.conflictPolicy ?? 'fail'
  const plannedFiles = manifest.frames.map((frame) => resolve(outputDirectory, `${safeName(frame.filename)}.png`))
  if (new Set(plannedFiles).size !== plannedFiles.length) throw new Error('切图文件名冲突')
  const existing: string[] = []
  for (const path of [...plannedFiles, sliceManifestPath]) {
    if (await access(path).then(() => true).catch(() => false)) existing.push(path)
  }
  if (existing.length > 0 && conflictPolicy === 'fail') {
    throw new Error(`目标文件已存在：${existing.join(', ')}`)
  }
  if (conflictPolicy === 'replace') {
    await Promise.all([...plannedFiles, sliceManifestPath].map((path) => rm(path, { force: true })))
  }

  await mkdir(outputDirectory, { recursive: true })
  const slices: SpriteSliceManifest['frames'] = []
  for (let index = 0; index < manifest.frames.length; index += 1) {
    const frame = manifest.frames[index]!
    if (frame.frame.x < 0 || frame.frame.y < 0 || frame.frame.w < 1 || frame.frame.h < 1
      || frame.frame.x + frame.frame.w > metadata.width
      || frame.frame.y + frame.frame.h > metadata.height) {
      throw new Error(`帧越出 Atlas：${frame.filename}`)
    }
    const atlasFrame = sharp(imagePath).extract({
      left: frame.frame.x,
      top: frame.frame.y,
      width: frame.frame.w,
      height: frame.frame.h,
    }).ensureAlpha()
    const { data, info } = await atlasFrame.clone().raw().toBuffer({ resolveWithObject: true })
    const bounds = opaqueBounds(data, info.width, info.height, alphaThreshold)
    const outputPath = plannedFiles[index]!
    if (bounds.empty) {
      await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      }).png().toFile(outputPath)
    } else {
      await atlasFrame.extract({
        left: bounds.x,
        top: bounds.y,
        width: bounds.w,
        height: bounds.h,
      }).png().toFile(outputPath)
    }
    slices.push({
      index: frame.index,
      filename: frame.filename,
      sourceFrameId: frame.sourceFrameId,
      animation: frame.animation,
      animationFrame: frame.animationFrame,
      file: basename(outputPath),
      width: bounds.w,
      height: bounds.h,
      empty: bounds.empty,
      sourceBounds: {
        x: frame.spriteSourceSize.x + bounds.x,
        y: frame.spriteSourceSize.y + bounds.y,
        w: bounds.w,
        h: bounds.h,
      },
      sourceSize: frame.sourceSize,
      pivot: frame.pivot,
      duration: frame.duration,
    })
    await options.onProgress?.(index + 1, manifest.frames.length, `已切出 ${index + 1}/${manifest.frames.length} 张`)
  }
  const sliceManifest: SpriteSliceManifest = {
    format: 'frameloop-sprite-slices-v1',
    image: basename(imagePath),
    sourceManifest: sourceManifestPath ? basename(sourceManifestPath) : null,
    alphaThreshold,
    frameCount: slices.length,
    frames: slices,
  }
  await writeFile(sliceManifestPath, JSON.stringify(sliceManifest, null, 2), 'utf8')
  return {
    outputDirectory,
    manifestPath: sliceManifestPath,
    frameCount: slices.length,
    emptyFrameCount: slices.filter((frame) => frame.empty).length,
    files: plannedFiles,
  }
}

async function reconstructFrame(imagePath: string, frame: SpriteBundleFrame) {
  const source = Buffer.alloc(frame.sourceSize.w * frame.sourceSize.h * 4)
  if (frame.empty) return source
  const cropWidth = Math.min(frame.frame.w, frame.spriteSourceSize.w)
  const cropHeight = Math.min(frame.frame.h, frame.spriteSourceSize.h)
  const crop = await sharp(imagePath).extract({
    left: frame.frame.x,
    top: frame.frame.y,
    width: cropWidth,
    height: cropHeight,
  }).ensureAlpha().raw().toBuffer()
  for (let y = 0; y < cropHeight; y += 1) {
    const sourceOffset = y * cropWidth * 4
    const targetOffset = ((frame.spriteSourceSize.y + y) * frame.sourceSize.w + frame.spriteSourceSize.x) * 4
    crop.copy(source, targetOffset, sourceOffset, sourceOffset + cropWidth * 4)
  }
  return source
}

function difference(a: Buffer, b: Buffer, alphaOnly = false) {
  if (a.length !== b.length || a.length === 0) return null
  let total = 0
  let samples = 0
  for (let index = alphaOnly ? 3 : 0; index < a.length; index += alphaOnly ? 4 : 1) {
    total += Math.abs((a[index] ?? 0) - (b[index] ?? 0)) / 255
    samples += 1
  }
  return samples ? total / samples : 0
}

export async function validateSpriteBundle(manifestFile: string, duplicateThreshold = 0.005) {
  const manifestPath = resolve(manifestFile)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SpriteBundleManifest
  const errors: string[] = []
  const warnings: string[] = []
  if (manifest.version !== 3 || !Array.isArray(manifest.frames) || !Array.isArray(manifest.animations)) {
    throw new Error('不支持的 Sprite Bundle Manifest')
  }
  const imagePath = resolve(dirname(manifestPath), manifest.image)
  const metadata = await sharp(imagePath).metadata()
  if (metadata.width !== manifest.sheetSize.width || metadata.height !== manifest.sheetSize.height) {
    errors.push('Atlas 实际尺寸与 Manifest 不一致')
  }
  const names = new Set<string>()
  for (const frame of manifest.frames) {
    if (names.has(frame.filename)) errors.push(`帧名称重复：${frame.filename}`)
    names.add(frame.filename)
    if (frame.frame.x < 0 || frame.frame.y < 0
      || frame.frame.x + frame.frame.w > manifest.sheetSize.width
      || frame.frame.y + frame.frame.h > manifest.sheetSize.height) {
      errors.push(`帧越出 Atlas：${frame.filename}`)
    }
  }
  const animationDiagnostics = []
  for (const animation of manifest.animations) {
    const frames = manifest.frames.slice(animation.from, animation.to + 1)
    if (frames.length !== animation.frameCount) errors.push(`${animation.name} 的帧数与 Manifest 不一致`)
    const images = await Promise.all(frames.map((frame) => reconstructFrame(imagePath, frame)))
    const compatible = frames.every((frame) =>
      frame.sourceSize.w === frames[0]?.sourceSize.w && frame.sourceSize.h === frames[0]?.sourceSize.h)
    let seamDifference: number | null = null
    let seamAlphaDifference: number | null = null
    let meanAlphaFlicker: number | null = null
    let duplicateEndpoint = false
    if (compatible && images.length > 1) {
      seamDifference = difference(images[0]!, images.at(-1)!)
      seamAlphaDifference = difference(images[0]!, images.at(-1)!, true)
      const alphaDifferences = images.slice(1).map((image, index) => difference(images[index]!, image, true) ?? 0)
      meanAlphaFlicker = alphaDifferences.reduce((sum, value) => sum + value, 0) / alphaDifferences.length
      duplicateEndpoint = seamDifference !== null && seamDifference <= duplicateThreshold
      if (duplicateEndpoint) warnings.push(`${animation.name} 的末帧疑似重复首帧`)
    } else if (images.length > 1) {
      warnings.push(`${animation.name} 的源帧尺寸不一致，跳过接缝像素比较`)
    }
    animationDiagnostics.push({
      name: animation.name,
      frameCount: frames.length,
      seamDifference,
      seamAlphaDifference,
      meanAlphaFlicker,
      duplicateEndpoint,
    })
  }
  let companionPath: string | null = null
  if (manifest.preset !== 'generic') {
    companionPath = manifest.preset === 'godot'
      ? imagePath.replace(/\.png$/i, '.tres')
      : `${imagePath}.${manifest.preset}.json`
    if (!await access(companionPath).then(() => true).catch(() => false)) {
      errors.push(`缺少 ${manifest.preset} 配套文件`)
    } else if (manifest.preset === 'aseprite' || manifest.preset === 'unity') {
      try {
        const companion = JSON.parse(await readFile(companionPath, 'utf8')) as {
          frames?: unknown[] | Record<string, unknown>
          animations?: unknown[]
          meta?: { image?: string; frameTags?: unknown[] }
        }
        const frameCount = Array.isArray(companion.frames)
          ? companion.frames.length
          : companion.frames ? Object.keys(companion.frames).length : 0
        if (frameCount !== manifest.frames.length) errors.push(`${manifest.preset} 配套文件帧数不一致`)
        if (manifest.preset === 'aseprite') {
          if (companion.meta?.image !== manifest.image) errors.push('Aseprite 配套文件引用了错误的 Atlas')
          if (companion.meta?.frameTags?.length !== manifest.animations.length) errors.push('Aseprite 动画标签数量不一致')
        } else if (companion.animations?.length !== manifest.animations.length) {
          errors.push('Unity 动画数量不一致')
        }
      } catch (cause) {
        errors.push(`${manifest.preset} 配套文件无法解析：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    } else {
      const content = await readFile(companionPath, 'utf8')
      if (!content.includes(`res://${manifest.image}`)) errors.push('Godot 配套文件引用了错误的 Atlas')
      for (const animation of manifest.animations) {
        if (!content.includes(JSON.stringify(animation.name))) errors.push(`Godot 配套文件缺少动画：${animation.name}`)
      }
    }
  }
  return {
    valid: errors.length === 0,
    manifestPath,
    imagePath,
    companionPath,
    errors,
    warnings,
    animationDiagnostics,
    summary: {
      animations: manifest.animations.length,
      frames: manifest.frames.length,
      sheetSize: manifest.sheetSize,
      preset: manifest.preset,
    },
  }
}
