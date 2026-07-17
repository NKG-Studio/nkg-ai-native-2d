import { refineAutomaticMatte } from './chroma'

export type MatteBackend = 'webgpu' | 'wasm'

export interface MatteLoadProgress {
  status: string
  file?: string
  loaded?: number
  total?: number
  progress?: number
}

export interface MattePipeline {
  segment(source: HTMLCanvasElement): Promise<HTMLCanvasElement>
  dispose(): Promise<void>
}

export type MattePipelineFactory = (
  backend: MatteBackend,
  onProgress?: (progress: MatteLoadProgress) => void,
) => Promise<MattePipeline>

export interface BrowserMatteEngineOptions {
  factory: MattePipelineFactory
  preferWebGpu?: boolean
  webgpuAvailable?: boolean
  onBackendChange?: (backend: MatteBackend) => void
  onProgress?: (progress: MatteLoadProgress) => void
}

export const DEFAULT_MATTE_MODEL = 'onnx-community/BEN2-ONNX'
export const DEFAULT_MATTE_MODEL_LICENSE = 'MIT'

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

export class BrowserMatteEngine {
  private pipeline: MattePipeline
  private factory: MattePipelineFactory
  private onProgress?: (progress: MatteLoadProgress) => void
  private onBackendChange?: (backend: MatteBackend) => void
  backend: MatteBackend
  fallbackReason: string | null

  private constructor(
    backend: MatteBackend,
    pipeline: MattePipeline,
    options: BrowserMatteEngineOptions,
    fallbackReason: string | null,
  ) {
    this.backend = backend
    this.pipeline = pipeline
    this.factory = options.factory
    this.onProgress = options.onProgress
    this.onBackendChange = options.onBackendChange
    this.fallbackReason = fallbackReason
  }

  static async create(options: BrowserMatteEngineOptions) {
    const preferWebGpu = options.preferWebGpu ?? true
    const webgpuAvailable = options.webgpuAvailable
      ?? (typeof navigator !== 'undefined' && 'gpu' in navigator)
    const backends: MatteBackend[] = preferWebGpu && webgpuAvailable
      ? ['webgpu', 'wasm']
      : ['wasm']
    let fallbackReason: string | null = null

    for (const backend of backends) {
      try {
        const pipeline = await options.factory(backend, options.onProgress)
        options.onBackendChange?.(backend)
        return new BrowserMatteEngine(backend, pipeline, options, fallbackReason)
      } catch (cause) {
        if (backend === 'wasm') throw cause
        fallbackReason = `WebGPU 初始化失败：${messageFrom(cause)}`
      }
    }
    throw new Error('没有可用的浏览器推理后端')
  }

  async segment(source: HTMLCanvasElement) {
    try {
      return await this.pipeline.segment(source)
    } catch (cause) {
      if (this.backend !== 'webgpu') throw cause
      const webgpuError = messageFrom(cause)
      await this.pipeline.dispose().catch(() => undefined)
      this.pipeline = await this.factory('wasm', this.onProgress)
      this.backend = 'wasm'
      this.fallbackReason = `WebGPU 推理失败：${webgpuError}`
      this.onBackendChange?.('wasm')
      return this.pipeline.segment(source)
    }
  }

  async dispose() {
    await this.pipeline.dispose()
  }
}

export async function createTransformersMattePipeline(
  backend: MatteBackend,
  onProgress?: (progress: MatteLoadProgress) => void,
): Promise<MattePipeline> {
  const { pipeline } = await import('@huggingface/transformers')
  const segmenter = await pipeline('background-removal', DEFAULT_MATTE_MODEL, {
    device: backend,
    // BEN2-ONNX currently ships model_fp16.onnx; both browser backends must
    // request that published artifact instead of a non-existent q8 variant.
    dtype: 'fp16',
    progress_callback: (progress) => onProgress?.(progress as MatteLoadProgress),
  })

  return {
    async segment(source) {
      const result = await segmenter(source)
      const matte = Array.isArray(result) ? result[0] : result
      const output = matte?.toCanvas() as CanvasImageSource & { width: number; height: number }
      if (!output?.width || !output?.height) throw new Error('分割模型没有返回可用的 Canvas 蒙版')
      return refineAutomaticMatte(source, output)
    },
    dispose: () => segmenter.dispose(),
  }
}
