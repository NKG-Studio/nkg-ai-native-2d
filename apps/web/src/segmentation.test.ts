import { describe, expect, it, vi } from 'vitest'
import { BrowserMatteEngine, type MatteBackend, type MattePipelineFactory } from './segmentation'

const canvas = {} as HTMLCanvasElement

describe('BrowserMatteEngine', () => {
  it('uses WASM directly when WebGPU is unavailable', async () => {
    const calls: MatteBackend[] = []
    const factory: MattePipelineFactory = async (backend) => {
      calls.push(backend)
      return { segment: async () => canvas, dispose: async () => undefined }
    }
    const engine = await BrowserMatteEngine.create({ factory, webgpuAvailable: false })
    expect(calls).toEqual(['wasm'])
    expect(engine.backend).toBe('wasm')
    expect(await engine.segment(canvas)).toBe(canvas)
  })

  it('falls back to WASM when WebGPU initialization fails', async () => {
    const calls: MatteBackend[] = []
    const factory: MattePipelineFactory = async (backend) => {
      calls.push(backend)
      if (backend === 'webgpu') throw new Error('adapter unavailable')
      return { segment: async () => canvas, dispose: async () => undefined }
    }
    const engine = await BrowserMatteEngine.create({ factory, webgpuAvailable: true })
    expect(calls).toEqual(['webgpu', 'wasm'])
    expect(engine.backend).toBe('wasm')
    expect(engine.fallbackReason).toContain('adapter unavailable')
  })

  it('recreates the pipeline on WASM when WebGPU inference fails', async () => {
    const calls: MatteBackend[] = []
    const disposed = vi.fn(async () => undefined)
    const onBackendChange = vi.fn()
    const factory: MattePipelineFactory = async (backend) => {
      calls.push(backend)
      return backend === 'webgpu'
        ? { segment: async () => { throw new Error('unsupported op') }, dispose: disposed }
        : { segment: async () => canvas, dispose: async () => undefined }
    }
    const engine = await BrowserMatteEngine.create({ factory, webgpuAvailable: true, onBackendChange })
    expect(await engine.segment(canvas)).toBe(canvas)
    expect(calls).toEqual(['webgpu', 'wasm'])
    expect(disposed).toHaveBeenCalledOnce()
    expect(engine.backend).toBe('wasm')
    expect(engine.fallbackReason).toContain('unsupported op')
    expect(onBackendChange).toHaveBeenLastCalledWith('wasm')
  })
})
