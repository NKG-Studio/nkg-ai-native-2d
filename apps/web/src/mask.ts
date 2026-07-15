export type MaskBrushMode = 'remove' | 'restore'

export interface MaskPoint {
  x: number
  y: number
}

export interface ContainedImageBox {
  left: number
  top: number
  width: number
  height: number
}

export function pointInContainedImage(
  box: ContainedImageBox,
  sourceWidth: number,
  sourceHeight: number,
  clientX: number,
  clientY: number,
): MaskPoint | null {
  if (box.width <= 0 || box.height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return null
  const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight)
  const renderedWidth = sourceWidth * scale
  const renderedHeight = sourceHeight * scale
  const renderedLeft = box.left + (box.width - renderedWidth) / 2
  const renderedTop = box.top + (box.height - renderedHeight) / 2
  const x = (clientX - renderedLeft) / renderedWidth
  const y = (clientY - renderedTop) / renderedHeight
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}

export interface MaskStroke {
  mode: MaskBrushMode
  size: number
  points: MaskPoint[]
}

export type FrameMasks = Record<number, MaskStroke[]>

export interface MaskEditorState {
  past: FrameMasks[]
  present: FrameMasks
  future: FrameMasks[]
}

export type MaskEditorAction =
  | { type: 'reset' }
  | { type: 'hydrate'; masks: FrameMasks }
  | { type: 'commit'; frameId: number; stroke: MaskStroke }
  | { type: 'clear_frame'; frameId: number }
  | { type: 'copy_to'; sourceFrameId: number; targetFrameIds: number[] }
  | { type: 'undo' }
  | { type: 'redo' }

const HISTORY_LIMIT = 50

export const createMaskEditorState = (): MaskEditorState => ({
  past: [],
  present: {},
  future: [],
})

const normalizeStroke = (stroke: MaskStroke): MaskStroke => ({
  mode: stroke.mode,
  size: Math.max(1, stroke.size),
  points: stroke.points.map((point) => ({
    x: Math.max(0, Math.min(1, point.x)),
    y: Math.max(0, Math.min(1, point.y)),
  })),
})

const pushHistory = (state: MaskEditorState, next: FrameMasks): MaskEditorState => ({
  past: [...state.past, state.present].slice(-HISTORY_LIMIT),
  present: next,
  future: [],
})

export function maskEditorReducer(state: MaskEditorState, action: MaskEditorAction): MaskEditorState {
  switch (action.type) {
    case 'reset':
      return createMaskEditorState()
    case 'hydrate':
      return {
        past: [],
        present: Object.fromEntries(Object.entries(action.masks).map(([frameId, strokes]) => [
          Number(frameId),
          strokes.map(normalizeStroke),
        ])),
        future: [],
      }
    case 'commit': {
      if (action.stroke.points.length === 0) return state
      const strokes = [...(state.present[action.frameId] ?? []), normalizeStroke(action.stroke)]
      return pushHistory(state, { ...state.present, [action.frameId]: strokes })
    }
    case 'clear_frame': {
      if (!state.present[action.frameId]?.length) return state
      const next = { ...state.present }
      delete next[action.frameId]
      return pushHistory(state, next)
    }
    case 'copy_to': {
      const source = state.present[action.sourceFrameId] ?? []
      const targets = [...new Set(action.targetFrameIds)].filter((frameId) => frameId !== action.sourceFrameId)
      if (source.length === 0 || targets.length === 0) return state
      const next = { ...state.present }
      for (const frameId of targets) {
        next[frameId] = source.map(normalizeStroke)
      }
      return pushHistory(state, next)
    }
    case 'undo': {
      const previous = state.past.at(-1)
      if (!previous) return state
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
      }
    }
    case 'redo': {
      const next = state.future[0]
      if (!next) return state
      return {
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next,
        future: state.future.slice(1),
      }
    }
  }
}

function traceStroke(context: CanvasRenderingContext2D, stroke: MaskStroke, width: number, height: number) {
  if (stroke.points.length === 0) return
  const radius = Math.max(1, stroke.size * Math.min(width, height) / 200)
  const points = stroke.points.map((point) => ({ x: point.x * width, y: point.y * height }))
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = radius * 2
  const first = points[0]!
  context.beginPath()
  context.moveTo(first.x, first.y)
  for (const point of points.slice(1)) context.lineTo(point.x, point.y)
  context.stroke()
  context.beginPath()
  context.arc(first.x, first.y, radius, 0, Math.PI * 2)
  context.fill()
}

export function applyMaskStrokes(
  base: HTMLCanvasElement,
  source: HTMLCanvasElement,
  strokes: MaskStroke[],
) {
  const canvas = document.createElement('canvas')
  canvas.width = base.width
  canvas.height = base.height
  const context = canvas.getContext('2d')!
  context.drawImage(base, 0, 0)

  for (const stroke of strokes) {
    context.save()
    if (stroke.mode === 'remove') {
      context.globalCompositeOperation = 'destination-out'
      context.strokeStyle = '#000'
      context.fillStyle = '#000'
      traceStroke(context, stroke, canvas.width, canvas.height)
    } else {
      const mask = document.createElement('canvas')
      mask.width = canvas.width
      mask.height = canvas.height
      const maskContext = mask.getContext('2d')!
      maskContext.strokeStyle = '#fff'
      maskContext.fillStyle = '#fff'
      traceStroke(maskContext, stroke, canvas.width, canvas.height)
      const restored = document.createElement('canvas')
      restored.width = canvas.width
      restored.height = canvas.height
      const restoredContext = restored.getContext('2d')!
      restoredContext.drawImage(source, 0, 0)
      restoredContext.globalCompositeOperation = 'destination-in'
      restoredContext.drawImage(mask, 0, 0)
      context.globalCompositeOperation = 'source-over'
      context.drawImage(restored, 0, 0)
    }
    context.restore()
  }
  return canvas
}
