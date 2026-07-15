import type { FrameFeature } from '@frameloop/core'

export interface CapturedFrame {
  index: number
  timestamp: number
  canvas: HTMLCanvasElement
  previewUrl: string
  feature: FrameFeature
}
export interface ExtractionProgress {
  phase?: 'scanning' | 'capturing'
  current: number
  total: number
}
