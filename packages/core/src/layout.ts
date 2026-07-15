import type {
  SpriteLayout,
  SpriteLayoutOptions,
  TightSpriteLayout,
  TightSpriteLayoutOptions,
} from './types.js'

export function createSpriteLayout(options: SpriteLayoutOptions): SpriteLayout {
  const frameCount = Math.max(0, Math.floor(options.frameCount))
  const frameWidth = Math.max(1, Math.floor(options.frameWidth))
  const frameHeight = Math.max(1, Math.floor(options.frameHeight))
  const padding = Math.max(0, Math.floor(options.padding ?? 0))
  const columns = Math.max(
    1,
    Math.min(frameCount || 1, Math.floor(options.columns ?? Math.ceil(Math.sqrt(frameCount || 1)))),
  )
  const rows = Math.max(1, Math.ceil(frameCount / columns))
  const width = columns * frameWidth + Math.max(0, columns - 1) * padding
  const height = rows * frameHeight + Math.max(0, rows - 1) * padding

  return {
    columns,
    rows,
    width,
    height,
    frames: Array.from({ length: frameCount }, (_, index) => ({
      index,
      x: (index % columns) * (frameWidth + padding),
      y: Math.floor(index / columns) * (frameHeight + padding),
      w: frameWidth,
      h: frameHeight,
    })),
  }
}

/**
 * Deterministic row/shelf packing for already-trimmed frames. `columns` limits
 * the number of frames per row while each row adopts its tallest frame.
 */
export function createTightSpriteLayout(options: TightSpriteLayoutOptions): TightSpriteLayout {
  const frames = options.frames.map((frame) => ({
    w: Math.max(1, Math.floor(frame.w)),
    h: Math.max(1, Math.floor(frame.h)),
  }))
  const padding = Math.max(0, Math.floor(options.padding ?? 0))
  const columns = Math.max(
    1,
    Math.min(frames.length || 1, Math.floor(options.columns ?? Math.ceil(Math.sqrt(frames.length || 1)))),
  )
  const rows = Math.max(1, Math.ceil(frames.length / columns))
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    Math.max(1, ...frames.slice(row * columns, (row + 1) * columns).map((frame) => frame.h)))
  const rowWidths = Array.from({ length: rows }, (_, row) => {
    const items = frames.slice(row * columns, (row + 1) * columns)
    return items.reduce((sum, frame) => sum + frame.w, 0) + Math.max(0, items.length - 1) * padding
  })
  const rowY = rowHeights.map((_, row) =>
    rowHeights.slice(0, row).reduce((sum, height) => sum + height, 0) + row * padding)
  const placed = frames.map((frame, index) => {
    const row = Math.floor(index / columns)
    const rowStart = row * columns
    const x = frames.slice(rowStart, index).reduce((sum, item) => sum + item.w, 0)
      + Math.max(0, index - rowStart) * padding
    return { index, x, y: rowY[row] ?? 0, w: frame.w, h: frame.h }
  })
  return {
    columns,
    rows,
    width: Math.max(1, ...rowWidths),
    height: rowHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, rows - 1) * padding,
    frames: placed,
  }
}
