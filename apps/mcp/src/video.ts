import { execFile, spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import ffprobe from 'ffprobe-static'
import sharp from 'sharp'
import type { FrameFeature } from '@frameloop/core'
import type { LoopCandidate } from '@frameloop/core'
import type { ActionLoopSegment } from './streaming.js'

export interface VideoInfo {
  path: string
  duration: number
  width: number
  height: number
  fps: number | null
  codec: string | null
  format: string | null
}

interface FfprobeData {
  streams?: Array<{ width?: number; height?: number; codec_name?: string; avg_frame_rate?: string }>
  format?: { duration?: string; format_name?: string }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) resolvePromise(stdout)
      else reject(new Error(`${basename(command)} 执行失败：${stderr.slice(-2000) || error.message}`, { cause: error }))
    })
  })
}

function parseRate(value?: string): number | null {
  if (!value) return null
  const parts = value.split('/')
  const numerator = Number(parts[0])
  const denominator = Number(parts[1] ?? 1)
  if (!numerator || !denominator) return null
  return numerator / denominator
}

function parseFfprobeOutput(output: string): FfprobeData {
  let json = output.trim()
  let parseError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return JSON.parse(json) as FfprobeData
    } catch (error) {
      // ffprobe-static 的旧 Windows 构建偶尔会漏写最外层闭合花括号。
      parseError = error
      json += '}'
    }
  }
  throw new Error(`FFprobe 返回了无效 JSON：${JSON.stringify(output)}`, { cause: parseError })
}

export async function probeVideo(inputPath: string): Promise<VideoInfo> {
  const path = resolve(inputPath)
  await access(path)
  const output = await run(ffprobe.path, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name,avg_frame_rate:format=duration,format_name',
    '-of', 'json',
    path,
  ])
  const data = parseFfprobeOutput(output)
  const stream = data.streams?.[0]
  if (!stream?.width || !stream.height) throw new Error('文件中没有可读取的视频流')
  return {
    path,
    duration: Number(data.format?.duration ?? 0),
    width: stream.width,
    height: stream.height,
    fps: parseRate(stream.avg_frame_rate),
    codec: stream.codec_name ?? null,
    format: data.format?.format_name ?? null,
  }
}

function computeFeature(
  pixels: Buffer,
  width: number,
  height: number,
  index: number,
  timestamp: number,
  channels = 3,
): FrameFeature {
  const luma = new Array<number>(width * height)
  let weightedX = 0
  let weightedY = 0
  let weight = 0
  let alphaCoverage = 0
  let hasTransparency = false
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels
      const alpha = channels >= 4 ? (pixels[offset + 3] ?? 255) / 255 : 1
      if (alpha < 0.995) hasTransparency = true
      alphaCoverage += alpha
      const value = ((pixels[offset] ?? 0) * 0.2126
        + (pixels[offset + 1] ?? 0) * 0.7152
        + (pixels[offset + 2] ?? 0) * 0.0722) / 255
      luma[y * width + x] = value
      const foregroundWeight = channels >= 4 ? alpha : Math.abs(value - (luma[0] ?? value))
      weightedX += x * foregroundWeight
      weightedY += y * foregroundWeight
      weight += foregroundWeight
    }
  }
  const edges = new Array<number>(luma.length).fill(0)
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = (dx: number, dy: number) => luma[(y + dy) * width + x + dx] ?? 0
      const gx = -at(-1, -1) + at(1, -1) - 2 * at(-1, 0) + 2 * at(1, 0) - at(-1, 1) + at(1, 1)
      const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1)
      edges[y * width + x] = Math.min(1, Math.hypot(gx, gy) / 4)
    }
  }
  return {
    index,
    timestamp,
    luma,
    edges,
    centroid: weight > 1e-6
      ? { x: weightedX / weight / (width - 1), y: weightedY / weight / (height - 1) }
      : { x: 0.5, y: 0.5 },
    coverage: Math.min(1, hasTransparency ? alphaCoverage / luma.length : weight / luma.length),
  }
}

export async function extractAnalysisFeatures(
  inputPath: string,
  fps: number,
  maxFrames?: number,
): Promise<FrameFeature[]> {
  const features: FrameFeature[] = []
  for await (const feature of streamAnalysisFeatures(inputPath, fps)) {
    features.push(feature)
    if (maxFrames !== undefined && features.length >= maxFrames) break
  }
  return features
}

let resolvedFfmpeg: Promise<string> | undefined

export function resolveFfmpegExecutable(): Promise<string> {
  resolvedFfmpeg ??= (async () => {
    const candidates = [
      process.env.FRAMELOOP_FFMPEG_PATH,
      process.env.FFMPEG_PATH,
      ffmpegPath,
      'ffmpeg',
    ].filter((candidate, index, values): candidate is string => Boolean(candidate) && values.indexOf(candidate) === index)
    const failures: string[] = []
    for (const candidate of candidates) {
      try {
        await run(candidate, ['-hide_banner', '-version'])
        return candidate
      } catch (cause) {
        failures.push(`${candidate}: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    throw new Error(`没有可用的 FFmpeg。可设置 FRAMELOOP_FFMPEG_PATH 指向有效二进制。\n${failures.join('\n')}`)
  })()
  return resolvedFfmpeg
}

export async function* streamAnalysisFeatures(
  inputPath: string,
  fps: number,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<FrameFeature> {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps 必须大于 0')
  const executable = await resolveFfmpegExecutable()
  const path = resolve(inputPath)
  await access(path)
  const width = 32
  const height = 32
  const channels = 3
  const frameBytes = width * height * channels
  const child = spawn(executable, [
    '-hide_banner', '-loglevel', 'error', '-i', path,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8000)
  })
  const completion = new Promise<{ code: number | null; error?: Error }>((resolveCompletion) => {
    child.once('error', (error) => resolveCompletion({ code: null, error }))
    child.once('close', (code) => resolveCompletion({ code }))
  })
  const abort = () => child.kill()
  options.signal?.addEventListener('abort', abort, { once: true })
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let index = 0
  let completedNaturally = false
  let completionResult: { code: number | null; error?: Error } | undefined
  try {
    for await (const chunk of child.stdout) {
      pending = pending.length === 0 ? chunk as Buffer : Buffer.concat([pending, chunk as Buffer])
      while (pending.length >= frameBytes) {
        const pixels = pending.subarray(0, frameBytes)
        pending = pending.subarray(frameBytes)
        yield computeFeature(pixels, width, height, index, index / fps, channels)
        index += 1
      }
      if (options.signal?.aborted) throw new Error('视频分析已取消')
    }
    completedNaturally = true
  } finally {
    options.signal?.removeEventListener('abort', abort)
    if (!completedNaturally && child.exitCode === null) child.kill()
    completionResult = await completion
  }
  const result = completionResult!
  if (result.error) throw new Error(`无法启动 FFmpeg：${result.error.message}`, { cause: result.error })
  if (result.code !== 0) throw new Error(`FFmpeg 流式解码失败：${stderr || `退出码 ${result.code}`}`)
  if (pending.length !== 0) throw new Error(`FFmpeg 返回了不完整的原始帧：剩余 ${pending.length} 字节`)
}

export async function extractImageFeatures(
  framePaths: string[],
  fps: number,
): Promise<FrameFeature[]> {
  const features: FrameFeature[] = []
  for await (const feature of streamImageFeatures(framePaths, fps)) features.push(feature)
  return features
}

export async function* streamImageFeatures(
  framePaths: string[],
  fps: number,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<FrameFeature> {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps 必须大于 0')
  const paths = framePaths.map((path) => resolve(path))
  for (let index = 0; index < paths.length; index += 1) {
    if (options.signal?.aborted) throw new Error('图片序列分析已取消')
    const path = paths[index]!
    await access(path)
    const { data, info } = await sharp(path)
      .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    yield computeFeature(data, info.width, info.height, index, index / fps, info.channels)
  }
}

export async function exportVideoFrames(options: {
  inputPath: string
  outputDirectory: string
  fps: number
  startTime: number
  endTime: number
}): Promise<string[]> {
  const executable = await resolveFfmpegExecutable()
  const inputPath = resolve(options.inputPath)
  const outputDirectory = resolve(options.outputDirectory)
  await access(inputPath)
  if (options.endTime <= options.startTime) throw new Error('end_time 必须大于 start_time')
  await mkdir(outputDirectory, { recursive: true })
  await run(executable, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(options.startTime), '-to', String(options.endTime),
    '-i', inputPath, '-vf', `fps=${options.fps}`,
    join(outputDirectory, 'frame_%06d.png'),
  ])
  return (await readdir(outputDirectory))
    .filter((name) => /^frame_\d+\.png$/.test(name))
    .sort()
    .map((name) => join(outputDirectory, name))
}

export async function createSpriteSheetFile(options: {
  framePaths: string[]
  outputPath: string
  columns: number
  padding: number
}): Promise<{ outputPath: string; width: number; height: number; frameCount: number; manifestPath: string }> {
  const { createSpriteLayout } = await import('@frameloop/core')
  if (options.framePaths.length === 0) throw new Error('frame_paths 不能为空')
  const paths = options.framePaths.map((path) => resolve(path))
  await Promise.all(paths.map((path) => access(path)))
  const metadata = await sharp(paths[0]!).metadata()
  if (!metadata.width || !metadata.height) throw new Error('无法读取第一帧尺寸')
  const layout = createSpriteLayout({
    frameWidth: metadata.width,
    frameHeight: metadata.height,
    frameCount: paths.length,
    columns: options.columns,
    padding: options.padding,
  })
  const outputPath = resolve(options.outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  const composites = await Promise.all(paths.map(async (path, index) => {
    const slot = layout.frames[index]!
    return { input: await sharp(path).resize(metadata.width!, metadata.height!, { fit: 'contain' }).png().toBuffer(), left: slot.x, top: slot.y }
  }))
  await sharp({ create: { width: layout.width, height: layout.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png()
    .toFile(outputPath)
  const manifestPath = `${outputPath}.json`
  const { writeFile } = await import('node:fs/promises')
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    image: basename(outputPath),
    frameSize: { width: metadata.width, height: metadata.height },
    sheetSize: { width: layout.width, height: layout.height },
    columns: layout.columns,
    rows: layout.rows,
    padding: options.padding,
    frames: layout.frames,
  }, null, 2))
  return { outputPath, width: layout.width, height: layout.height, frameCount: paths.length, manifestPath }
}

export async function renderLoopContactSheet(
  inputPath: string,
  candidates: LoopCandidate[],
  fps: number,
): Promise<Buffer> {
  const executable = await resolveFfmpegExecutable()
  const path = resolve(inputPath)
  const directory = await mkdtemp(join(tmpdir(), 'frameloop-review-'))
  const cellWidth = 240
  const cellHeight = 160
  const labelHeight = 30
  try {
    const rows = await Promise.all(candidates.map(async (candidate, index) => {
      const startPath = join(directory, `candidate_${index + 1}_start.png`)
      const endPath = join(directory, `candidate_${index + 1}_end.png`)
      const startTime = candidate.startFrame / fps
      const endTime = candidate.endFrame / fps
      await Promise.all([
        run(executable, ['-hide_banner', '-loglevel', 'error', '-ss', String(startTime), '-i', path, '-frames:v', '1', '-vf', `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2`, '-y', startPath]),
        run(executable, ['-hide_banner', '-loglevel', 'error', '-ss', String(endTime), '-i', path, '-frames:v', '1', '-vf', `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2`, '-y', endPath]),
      ])
      return { candidate, startPath, endPath }
    }))

    const width = cellWidth * 2
    const rowHeight = cellHeight + labelHeight
    const height = Math.max(1, rows.length) * rowHeight
    const composites: sharp.OverlayOptions[] = []
    rows.forEach(({ candidate, startPath, endPath }, index) => {
      const top = index * rowHeight
      composites.push({ input: startPath, left: 0, top })
      composites.push({ input: endPath, left: cellWidth, top })
      const label = Buffer.from(`<svg width="${width}" height="${labelHeight}">
        <rect width="100%" height="100%" fill="#151812"/>
        <text x="10" y="20" fill="#c7f36a" font-family="monospace" font-size="13">#${index + 1} START F${candidate.startFrame + 1} · ${(candidate.startTime).toFixed(2)}s</text>
        <text x="${cellWidth + 10}" y="20" fill="#c7f36a" font-family="monospace" font-size="13">END F${candidate.endFrame + 1} · ${(candidate.endTime).toFixed(2)}s · ${Math.round(candidate.confidence * 100)}%</text>
      </svg>`)
      composites.push({ input: label, left: 0, top: top + cellHeight })
    })
    return await sharp({
      create: { width, height, channels: 4, background: { r: 13, g: 15, b: 12, alpha: 1 } },
    }).composite(composites).png().toBuffer()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function renderActionSegmentReviewSheet(
  inputPath: string,
  segment: ActionLoopSegment,
  fps: number,
  candidateLimit = 3,
): Promise<Buffer> {
  const executable = await resolveFfmpegExecutable()
  const path = resolve(inputPath)
  const directory = await mkdtemp(join(tmpdir(), 'frameloop-action-review-'))
  const columns = 8
  const cellWidth = 140
  const cellHeight = 120
  const labelHeight = 28
  const rowHeight = cellHeight + labelHeight
  const candidates = segment.candidates.slice(0, Math.max(1, candidateLimit))
  const overviewFrames = Array.from({ length: columns }, (_, index) => Math.round(
    segment.startFrame + (segment.endFrame - segment.startFrame) * index / Math.max(1, columns - 1),
  ))
  const seamRows = candidates.map((candidate) => [
    candidate.endFrame - 2,
    candidate.endFrame - 1,
    candidate.endFrame,
    candidate.startFrame,
    candidate.startFrame + 1,
    candidate.startFrame + 2,
  ].map((frame) => Math.max(segment.startFrame, Math.min(segment.endFrame, frame))))
  const rows = [overviewFrames, ...seamRows]
  const uniqueFrames = [...new Set(rows.flat())]

  try {
    const framePaths = new Map<number, string>()
    for (let offset = 0; offset < uniqueFrames.length; offset += 6) {
      await Promise.all(uniqueFrames.slice(offset, offset + 6).map(async (frame) => {
        const output = join(directory, `frame_${frame}.png`)
        await run(executable, [
          '-hide_banner', '-loglevel', 'error', '-ss', String(frame / fps), '-i', path,
          '-frames:v', '1',
          '-vf', `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2`,
          '-y', output,
        ])
        framePaths.set(frame, output)
      }))
    }

    const width = columns * cellWidth
    const height = rows.length * rowHeight
    const composites: sharp.OverlayOptions[] = []
    rows.forEach((frames, rowIndex) => {
      const top = rowIndex * rowHeight
      frames.forEach((frame, column) => {
        const input = framePaths.get(frame)
        if (input) composites.push({ input, left: column * cellWidth, top })
      })
      const rowTitle = rowIndex === 0
        ? `ACTION ${segment.index + 1} OVERVIEW · F${segment.startFrame + 1}..F${segment.endFrame + 1}`
        : `CANDIDATE ${rowIndex} · ${candidates[rowIndex - 1]!.source.toUpperCase()} · F${candidates[rowIndex - 1]!.startFrame + 1}..F${candidates[rowIndex - 1]!.endFrame + 1} · ${Math.round(candidates[rowIndex - 1]!.confidence * 100)}% · END-2 END-1 END | START START+1 START+2`
      composites.push({
        input: Buffer.from(`<svg width="${width}" height="${labelHeight}">
          <rect width="100%" height="100%" fill="#151812"/>
          <text x="10" y="19" fill="#c7f36a" font-family="monospace" font-size="13">${rowTitle}</text>
        </svg>`),
        left: 0,
        top: top + cellHeight,
      })
    })
    return await sharp({
      create: { width, height, channels: 4, background: { r: 13, g: 15, b: 12, alpha: 1 } },
    }).composite(composites).png().toBuffer()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function renderImageLoopContactSheet(
  framePaths: string[],
  candidates: LoopCandidate[],
): Promise<Buffer> {
  const paths = framePaths.map((path) => resolve(path))
  const cellWidth = 240
  const cellHeight = 160
  const labelHeight = 30
  const width = cellWidth * 2
  const rowHeight = cellHeight + labelHeight
  const height = Math.max(1, candidates.length) * rowHeight
  const composites: sharp.OverlayOptions[] = []
  await Promise.all(candidates.map(async (candidate, index) => {
    const [start, end] = await Promise.all([
      sharp(paths[candidate.startFrame]!).resize(cellWidth, cellHeight, { fit: 'contain', background: '#080908' }).png().toBuffer(),
      sharp(paths[candidate.endFrame]!).resize(cellWidth, cellHeight, { fit: 'contain', background: '#080908' }).png().toBuffer(),
    ])
    const top = index * rowHeight
    composites.push({ input: start, left: 0, top })
    composites.push({ input: end, left: cellWidth, top })
    composites.push({
      input: Buffer.from(`<svg width="${width}" height="${labelHeight}">
        <rect width="100%" height="100%" fill="#151812"/>
        <text x="10" y="20" fill="#c7f36a" font-family="monospace" font-size="13">#${index + 1} START F${candidate.startFrame + 1}</text>
        <text x="${cellWidth + 10}" y="20" fill="#c7f36a" font-family="monospace" font-size="13">END F${candidate.endFrame + 1} · ${Math.round(candidate.confidence * 100)}%</text>
      </svg>`),
      left: 0,
      top: top + cellHeight,
    })
  }))
  return await sharp({
    create: { width, height, channels: 4, background: { r: 13, g: 15, b: 12, alpha: 1 } },
  }).composite(composites).png().toBuffer()
}
