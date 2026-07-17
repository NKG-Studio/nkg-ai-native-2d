import { access, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

export type MatteConflictPolicy = 'fail' | 'replace'

interface LoadedFrame {
  data: Buffer
  width: number
  height: number
  alpha: Uint8ClampedArray
}

interface RawImageLike {
  data: Uint8Array | Uint8ClampedArray
  width: number
  height: number
  channels: 1 | 2 | 3 | 4
}

export interface AiMatteSegmenter {
  segment(path: string): Promise<RawImageLike>
  dispose(): Promise<void>
}

export type AiMatteFactory = (
  model: string,
  onModelProgress?: (message: string, ratio?: number) => void | Promise<void>,
) => Promise<AiMatteSegmenter>

const parseColor = (value: string): [number, number, number] => {
  const normalized = value.trim().replace(/^#/, '')
  if (!/^[a-f\d]{6}$/i.test(normalized)) throw new Error('key_color 必须是 #RRGGBB')
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ]
}

function calculateAlpha(data: Buffer, key: readonly number[], tolerance: number, feather: number) {
  const alpha = new Uint8ClampedArray(data.length / 4)
  const hard = Math.max(0, tolerance)
  const soft = Math.max(1, feather)
  for (let index = 0; index < alpha.length; index += 1) {
    const offset = index * 4
    const distance = Math.hypot(
      (data[offset] ?? 0) - key[0]!,
      (data[offset + 1] ?? 0) - key[1]!,
      (data[offset + 2] ?? 0) - key[2]!,
    )
    const keyed = distance <= hard ? 0 : Math.min(1, (distance - hard) / soft)
    alpha[index] = Math.round((data[offset + 3] ?? 255) * keyed)
  }
  return alpha
}

function stabilizeAlpha(
  previous: Uint8ClampedArray | undefined,
  current: Uint8ClampedArray,
  next: Uint8ClampedArray | undefined,
  consistency: number,
) {
  if (!previous && !next) return current
  const amount = Math.max(0, Math.min(1, consistency))
  const result = new Uint8ClampedArray(current.length)
  for (let index = 0; index < current.length; index += 1) {
    const a = previous?.[index] ?? current[index] ?? 255
    const b = current[index] ?? 255
    const c = next?.[index] ?? b
    const median = a + b + c - Math.min(a, b, c) - Math.max(a, b, c)
    result[index] = Math.round(b * (1 - amount) + median * amount)
  }
  return result
}

function renderChroma(
  data: Buffer,
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  key: readonly number[],
  despill: number,
) {
  const output = Buffer.from(data)
  const strength = Math.max(0, Math.min(1, despill))
  const dominant = key[1]! >= key[0]! && key[1]! >= key[2]! ? 1
    : key[2]! >= key[0]! ? 2 : 0
  for (let index = 0; index < alpha.length; index += 1) {
    const offset = index * 4
    const opacity = alpha[index] ?? 0
    output[offset + 3] = opacity
    if (opacity === 0) {
      output[offset] = 0
      output[offset + 1] = 0
      output[offset + 2] = 0
      continue
    }
    if (strength === 0) continue
    const x = index % width
    const boundary = opacity < 250 || [
      x > 0 ? index - 1 : -1,
      x + 1 < width ? index + 1 : -1,
      index >= width ? index - width : -1,
      index + width < width * height ? index + width : -1,
    ].some((neighbor) => neighbor >= 0 && (alpha[neighbor] ?? 255) < 250)
    if (!boundary) continue
    const other = dominant === 0
      ? Math.max(output[offset + 1] ?? 0, output[offset + 2] ?? 0)
      : dominant === 1
        ? Math.max(output[offset] ?? 0, output[offset + 2] ?? 0)
        : Math.max(output[offset] ?? 0, output[offset + 1] ?? 0)
    const channelOffset = offset + dominant
    const corrected = Math.min(output[channelOffset] ?? 0, other)
    output[channelOffset] = Math.round((output[channelOffset] ?? 0) * (1 - strength) + corrected * strength)
  }
  return output
}

async function loadFrame(path: string, key: readonly number[], tolerance: number, feather: number): Promise<LoadedFrame> {
  await access(path)
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return {
    data,
    width: info.width,
    height: info.height,
    alpha: calculateAlpha(data, key, tolerance, feather),
  }
}

async function prepareOutputs(outputDirectory: string, count: number, policy: MatteConflictPolicy) {
  const directory = resolve(outputDirectory)
  const paths = Array.from({ length: count }, (_, index) =>
    join(directory, `frame_${String(index + 1).padStart(6, '0')}.png`))
  const existing: string[] = []
  for (const path of paths) {
    if (await access(path).then(() => true).catch(() => false)) existing.push(path)
  }
  if (existing.length > 0 && policy === 'fail') throw new Error(`目标帧已存在：${existing[0]}`)
  await mkdir(directory, { recursive: true })
  if (policy === 'replace') await Promise.all(paths.map((path) => rm(path, { force: true })))
  return paths
}

export async function applyChromaKeyBatch(options: {
  framePaths: string[]
  outputDirectory: string
  keyColor: string
  tolerance?: number
  feather?: number
  temporalConsistency?: number
  despillStrength?: number
  conflictPolicy?: MatteConflictPolicy
  onProgress?: (completed: number, total: number, message: string) => void | Promise<void>
}) {
  if (options.framePaths.length === 0) throw new Error('frame_paths 不能为空')
  const key = parseColor(options.keyColor)
  const tolerance = options.tolerance ?? 72
  const feather = options.feather ?? 28
  const consistency = options.temporalConsistency ?? 0.7
  const despill = options.despillStrength ?? 1
  const outputs = await prepareOutputs(
    options.outputDirectory,
    options.framePaths.length,
    options.conflictPolicy ?? 'fail',
  )
  let previousAlpha: Uint8ClampedArray | undefined
  let current = await loadFrame(resolve(options.framePaths[0]!), key, tolerance, feather)
  let next = options.framePaths[1]
    ? await loadFrame(resolve(options.framePaths[1]), key, tolerance, feather)
    : undefined
  const width = current.width
  const height = current.height

  for (let index = 0; index < options.framePaths.length; index += 1) {
    if (current.width !== width || current.height !== height
      || (next && (next.width !== width || next.height !== height))) {
      throw new Error('批量色度键要求所有帧尺寸一致')
    }
    const alpha = stabilizeAlpha(previousAlpha, current.alpha, next?.alpha, consistency)
    const output = renderChroma(current.data, alpha, width, height, key, despill)
    await sharp(output, { raw: { width, height, channels: 4 } }).png().toFile(outputs[index]!)
    await options.onProgress?.(index + 1, options.framePaths.length, `已处理色度键帧 ${index + 1}`)
    previousAlpha = current.alpha
    current = next ?? current
    next = options.framePaths[index + 2]
      ? await loadFrame(resolve(options.framePaths[index + 2]!), key, tolerance, feather)
      : undefined
  }
  return {
    mode: 'chroma_key' as const,
    outputDirectory: resolve(options.outputDirectory),
    frameCount: outputs.length,
    files: outputs,
    settings: { keyColor: options.keyColor, tolerance, feather, temporalConsistency: consistency, despillStrength: despill },
  }
}

async function defaultAiFactory(
  model: string,
  onModelProgress?: (message: string, ratio?: number) => void | Promise<void>,
): Promise<AiMatteSegmenter> {
  const { pipeline } = await import('@huggingface/transformers')
  const segmenter = await pipeline('background-removal', model, {
    device: 'cpu',
    // BEN2-ONNX currently publishes model_fp16.onnx only. Requesting q8 makes
    // Transformers.js look for a non-existent model_quantized.onnx file.
    dtype: 'fp16',
    progress_callback: (progress) => {
      const value = progress as { file?: string; progress?: number; loaded?: number; total?: number }
      const ratio = typeof value.progress === 'number'
        ? (value.progress > 1 ? value.progress / 100 : value.progress)
        : value.total && typeof value.loaded === 'number' ? value.loaded / value.total : undefined
      void onModelProgress?.(value.file ? `加载 ${value.file}` : '加载 AI 抠图模型', ratio)
    },
  })
  return {
    async segment(path) {
      const output = await segmenter(path)
      if (Array.isArray(output)) throw new Error('AI 抠图返回了意外的批量结果')
      return output
    },
    dispose: () => segmenter.dispose(),
  }
}

export async function applyAiMatteBatch(options: {
  framePaths: string[]
  outputDirectory: string
  model?: string
  conflictPolicy?: MatteConflictPolicy
  onProgress?: (completed: number, total: number, message: string) => void | Promise<void>
  onModelProgress?: (message: string, ratio?: number) => void | Promise<void>
  factory?: AiMatteFactory
}) {
  if (options.framePaths.length === 0) throw new Error('frame_paths 不能为空')
  const model = options.model ?? 'onnx-community/BEN2-ONNX'
  const outputs = await prepareOutputs(
    options.outputDirectory,
    options.framePaths.length,
    options.conflictPolicy ?? 'fail',
  )
  const segmenter = await (options.factory ?? defaultAiFactory)(model, options.onModelProgress)
  try {
    for (let index = 0; index < options.framePaths.length; index += 1) {
      const path = resolve(options.framePaths[index]!)
      await access(path)
      const output = await segmenter.segment(path)
      if (!output.width || !output.height || ![1, 2, 3, 4].includes(output.channels)) {
        throw new Error(`AI 抠图没有返回可用图像：${path}`)
      }
      await sharp(Buffer.from(output.data), {
        raw: { width: output.width, height: output.height, channels: output.channels },
      }).png().toFile(outputs[index]!)
      await options.onProgress?.(index + 1, options.framePaths.length, `已完成 AI 抠图帧 ${index + 1}`)
    }
  } finally {
    await segmenter.dispose()
  }
  return {
    mode: 'ai_matte' as const,
    model,
    backend: 'cpu-fp16',
    outputDirectory: resolve(options.outputDirectory),
    frameCount: outputs.length,
    files: outputs,
  }
}
