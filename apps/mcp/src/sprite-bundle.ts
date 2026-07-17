import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { createSpriteLayout, createTightSpriteLayout } from '@frameloop/core'
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
