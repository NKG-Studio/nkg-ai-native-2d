export type SpriteBackgroundMode = 'auto' | 'alpha' | 'edge-color'
export type SpriteLayoutMode = 'grid' | 'components'
export type SpriteBoundsMode = 'axis_aligned' | 'oriented' | 'polygon'

export interface SpriteDetectionPoint { x: number; y: number }
export interface SpriteDetectionRect { x: number; y: number; w: number; h: number }

export interface SpriteOrientedRect {
  cx: number
  cy: number
  w: number
  h: number
  angleDegrees: number
}

export interface SpriteDetectionOptions {
  backgroundMode?: SpriteBackgroundMode
  alphaThreshold?: number
  backgroundTolerance?: number
  minArea?: number
  mergeGap?: number
  maxComponents?: number
  maxGridAxis?: number
}

export interface DetectedSpriteRegion {
  id: number
  labelIds: number[]
  area: number
  bounds: SpriteDetectionRect
  orientedBounds: SpriteOrientedRect
  polygon: SpriteDetectionPoint[]
  solidity: number
  rotationSavings: number
}

export interface SpriteGridCandidate {
  columns: number
  rows: number
  frameCount: number
  cellWidth: number
  cellHeight: number
  confidence: number
  cutRatio: number
  emptyRatio: number
  areaVariation: number
}

export interface SpriteSheetDetection {
  width: number
  height: number
  foregroundMask: Uint8Array
  labels: Int32Array
  foregroundPixels: number
  background: {
    mode: Exclude<SpriteBackgroundMode, 'auto'>
    color: { r: number; g: number; b: number } | null
  }
  sprites: DetectedSpriteRegion[]
  gridCandidate: SpriteGridCandidate | null
  recommendation: {
    layout: SpriteLayoutMode
    bounds: SpriteBoundsMode
    confidence: number
    reasons: string[]
  }
  warnings: string[]
}

interface RawComponent {
  labelId: number
  area: number
  bounds: SpriteDetectionRect
  boundary: SpriteDetectionPoint[]
}

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

function dominantBorderColor(rgba: ArrayLike<number>, width: number, height: number) {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>()
  const add = (x: number, y: number) => {
    const offset = (y * width + x) * 4
    if ((rgba[offset + 3] ?? 0) === 0) return
    const r = rgba[offset] ?? 0
    const g = rgba[offset + 1] ?? 0
    const b = rgba[offset + 2] ?? 0
    const key = (Math.round(r / 16) << 8) | (Math.round(g / 16) << 4) | Math.round(b / 16)
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
    bucket.count += 1
    bucket.r += r
    bucket.g += g
    bucket.b += b
    buckets.set(key, bucket)
  }
  for (let x = 0; x < width; x += 1) {
    add(x, 0)
    if (height > 1) add(x, height - 1)
  }
  for (let y = 1; y < height - 1; y += 1) {
    add(0, y)
    if (width > 1) add(width - 1, y)
  }
  const winner = [...buckets.values()].sort((a, b) => b.count - a.count)[0]
  return winner
    ? { r: winner.r / winner.count, g: winner.g / winner.count, b: winner.b / winner.count }
    : { r: 0, g: 0, b: 0 }
}

function createForegroundMask(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  options: SpriteDetectionOptions,
) {
  const alphaThreshold = clampByte(options.alphaThreshold ?? 1)
  let transparent = 0
  for (let index = 3; index < width * height * 4; index += 4) {
    if ((rgba[index] ?? 0) < alphaThreshold) transparent += 1
  }
  const transparentRatio = transparent / Math.max(1, width * height)
  const mode = options.backgroundMode === 'auto' || options.backgroundMode === undefined
    ? (transparentRatio >= 0.002 ? 'alpha' : 'edge-color')
    : options.backgroundMode
  const background = mode === 'edge-color' ? dominantBorderColor(rgba, width, height) : null
  const tolerance = Math.max(0, options.backgroundTolerance ?? 36)
  const toleranceSquared = tolerance * tolerance
  const mask = new Uint8Array(width * height)
  let foregroundPixels = 0
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    const alpha = rgba[offset + 3] ?? 0
    let foreground = alpha >= alphaThreshold
    if (foreground && background) {
      const dr = (rgba[offset] ?? 0) - background.r
      const dg = (rgba[offset + 1] ?? 0) - background.g
      const db = (rgba[offset + 2] ?? 0) - background.b
      foreground = dr * dr + dg * dg + db * db > toleranceSquared
    }
    if (foreground) {
      mask[index] = 1
      foregroundPixels += 1
    }
  }
  return { mask, foregroundPixels, mode, background, transparentRatio }
}

function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
  maxComponents: number,
) {
  const labels = new Int32Array(mask.length)
  const queue = new Int32Array(mask.length)
  const components: RawComponent[] = []
  let nextLabel = 0
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue
    nextLabel += 1
    let head = 0
    let tail = 1
    queue[0] = start
    labels[start] = nextLabel
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    const boundary: SpriteDetectionPoint[] = []
    while (head < tail) {
      const pixel = queue[head++]!
      const x = pixel % width
      const y = Math.floor(pixel / width)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      let isBoundary = false
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            if (dx === 0 || dy === 0) isBoundary = true
            continue
          }
          const neighbor = ny * width + nx
          if (!mask[neighbor]) {
            if (dx === 0 || dy === 0) isBoundary = true
          } else if (!labels[neighbor]) {
            labels[neighbor] = nextLabel
            queue[tail++] = neighbor
          }
        }
      }
      if (isBoundary) {
        boundary.push(
          { x, y }, { x: x + 1, y }, { x: x + 1, y: y + 1 }, { x, y: y + 1 },
        )
      }
    }
    if (tail < minArea) {
      for (let index = 0; index < tail; index += 1) labels[queue[index]!] = 0
      continue
    }
    components.push({
      labelId: nextLabel,
      area: tail,
      bounds: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      boundary,
    })
    if (components.length > maxComponents) throw new Error(`检测区域超过上限 ${maxComponents}，请提高最小面积或先清理背景`)
  }
  return { labels, components }
}

function rectDistance(a: SpriteDetectionRect, b: SpriteDetectionRect) {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w))
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h))
  return Math.hypot(dx, dy)
}

function groupComponents(components: RawComponent[], mergeGap: number) {
  const parent = components.map((_, index) => index)
  const find = (value: number): number => parent[value] === value
    ? value
    : (parent[value] = find(parent[value]!))
  const union = (a: number, b: number) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[rootB] = rootA
  }
  if (mergeGap > 0) {
    for (let left = 0; left < components.length; left += 1) {
      for (let right = left + 1; right < components.length; right += 1) {
        if (rectDistance(components[left]!.bounds, components[right]!.bounds) <= mergeGap) union(left, right)
      }
    }
  }
  const groups = new Map<number, RawComponent[]>()
  components.forEach((component, index) => {
    const root = find(index)
    groups.set(root, [...(groups.get(root) ?? []), component])
  })
  return [...groups.values()]
}

function cross(origin: SpriteDetectionPoint, a: SpriteDetectionPoint, b: SpriteDetectionPoint) {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
}

export function convexHull(points: SpriteDetectionPoint[]) {
  const unique = [...new Map(points.map((point) => [`${point.x}:${point.y}`, point])).values()]
    .sort((a, b) => a.x - b.x || a.y - b.y)
  if (unique.length <= 2) return unique
  const lower: SpriteDetectionPoint[] = []
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop()
    lower.push(point)
  }
  const upper: SpriteDetectionPoint[] = []
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index]!
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop()
    upper.push(point)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

function polygonArea(points: SpriteDetectionPoint[]) {
  if (points.length < 3) return 0
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    sum += current.x * next.y - next.x * current.y
  }
  return Math.abs(sum) / 2
}

export function minimumAreaRectangle(points: SpriteDetectionPoint[]): SpriteOrientedRect {
  if (points.length === 0) return { cx: 0.5, cy: 0.5, w: 1, h: 1, angleDegrees: 0 }
  if (points.length === 1) return { cx: points[0]!.x, cy: points[0]!.y, w: 1, h: 1, angleDegrees: 0 }
  let best: { area: number; minU: number; maxU: number; minV: number; maxV: number; angle: number } | null = null
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    const angle = Math.atan2(next.y - current.y, next.x - current.x)
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    let minU = Number.POSITIVE_INFINITY
    let maxU = Number.NEGATIVE_INFINITY
    let minV = Number.POSITIVE_INFINITY
    let maxV = Number.NEGATIVE_INFINITY
    for (const point of points) {
      const u = point.x * cos + point.y * sin
      const v = -point.x * sin + point.y * cos
      minU = Math.min(minU, u)
      maxU = Math.max(maxU, u)
      minV = Math.min(minV, v)
      maxV = Math.max(maxV, v)
    }
    const area = (maxU - minU) * (maxV - minV)
    if (!best || area < best.area) best = { area, minU, maxU, minV, maxV, angle }
  }
  const result = best!
  let w = Math.max(1, result.maxU - result.minU)
  let h = Math.max(1, result.maxV - result.minV)
  let angleDegrees = result.angle * 180 / Math.PI
  if (angleDegrees > 45) {
    angleDegrees -= 90
    ;[w, h] = [h, w]
  } else if (angleDegrees <= -45) {
    angleDegrees += 90
    ;[w, h] = [h, w]
  }
  const angle = result.angle
  const centerU = (result.minU + result.maxU) / 2
  const centerV = (result.minV + result.maxV) / 2
  return {
    cx: centerU * Math.cos(angle) - centerV * Math.sin(angle),
    cy: centerU * Math.sin(angle) + centerV * Math.cos(angle),
    w,
    h,
    angleDegrees,
  }
}

function inferRegularGrid(
  mask: Uint8Array,
  width: number,
  height: number,
  foregroundPixels: number,
  componentCount: number,
  maxGridAxis: number,
) {
  if (foregroundPixels === 0) return null
  let best: SpriteGridCandidate | null = null
  for (let columns = 1; columns <= Math.min(maxGridAxis, width); columns += 1) {
    if (width % columns !== 0) continue
    for (let rows = 1; rows <= Math.min(maxGridAxis, height); rows += 1) {
      if (height % rows !== 0 || columns * rows <= 1 || columns * rows > 256) continue
      const cellWidth = width / columns
      const cellHeight = height / rows
      const areas = new Array(columns * rows).fill(0) as number[]
      let cutPixels = 0
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (!mask[y * width + x]) continue
          const column = Math.min(columns - 1, Math.floor(x / cellWidth))
          const row = Math.min(rows - 1, Math.floor(y / cellHeight))
          const cell = row * columns + column
          areas[cell] = (areas[cell] ?? 0) + 1
          if ((x > 0 && x % cellWidth === 0) || (y > 0 && y % cellHeight === 0)) cutPixels += 1
        }
      }
      let frameCount = 0
      for (let index = areas.length - 1; index >= 0; index -= 1) {
        if (areas[index]! > 0) {
          frameCount = index + 1
          break
        }
      }
      // Be deliberately conservative: when fewer cells than connected regions are
      // visible, a grid would silently group unrelated sprites. A multimodal MCP
      // client can still override this when one sprite intentionally has parts.
      if (frameCount < 2 || frameCount < componentCount || frameCount > Math.max(2, componentCount * 6)) continue
      const used = areas.slice(0, frameCount)
      const emptyRatio = used.filter((area) => area === 0).length / frameCount
      const nonempty = used.filter((area) => area > 0)
      const mean = nonempty.reduce((sum, area) => sum + area, 0) / Math.max(1, nonempty.length)
      const variance = nonempty.reduce((sum, area) => sum + (area - mean) ** 2, 0) / Math.max(1, nonempty.length)
      const areaVariation = mean > 0 ? Math.sqrt(variance) / mean : 1
      const cutRatio = cutPixels / foregroundPixels
      const confidence = Math.max(0, Math.min(1,
        0.5 * (1 - Math.min(1, cutRatio * 80))
        + 0.25 * (1 - emptyRatio)
        + 0.15 * (1 - Math.min(1, areaVariation))
        + 0.1 * Math.min(1, Math.log2(frameCount) / 4),
      ))
      const candidate = {
        columns, rows, frameCount, cellWidth, cellHeight, confidence, cutRatio, emptyRatio, areaVariation,
      }
      if (!best || candidate.confidence > best.confidence
        || (candidate.confidence === best.confidence && candidate.frameCount > best.frameCount)) best = candidate
    }
  }
  return best
}

export function analyzeSpriteSheet(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  options: SpriteDetectionOptions = {},
): SpriteSheetDetection {
  if (width < 1 || height < 1 || rgba.length < width * height * 4) throw new Error('无效的 RGBA 图像数据')
  const foreground = createForegroundMask(rgba, width, height, options)
  const minArea = Math.max(1, Math.round(options.minArea ?? Math.max(2, width * height * 0.00001)))
  const { labels, components } = connectedComponents(
    foreground.mask,
    width,
    height,
    minArea,
    Math.max(1, Math.round(options.maxComponents ?? 2000)),
  )
  const groups = groupComponents(components, Math.max(0, options.mergeGap ?? 0))
  const sprites = groups.map((group, index): DetectedSpriteRegion => {
    const minX = Math.min(...group.map((component) => component.bounds.x))
    const minY = Math.min(...group.map((component) => component.bounds.y))
    const maxX = Math.max(...group.map((component) => component.bounds.x + component.bounds.w))
    const maxY = Math.max(...group.map((component) => component.bounds.y + component.bounds.h))
    const bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    const polygon = convexHull(group.flatMap((component) => component.boundary))
    const orientedBounds = minimumAreaRectangle(polygon)
    const area = group.reduce((sum, component) => sum + component.area, 0)
    const hullArea = Math.max(1, polygonArea(polygon))
    const axisArea = Math.max(1, bounds.w * bounds.h)
    return {
      id: index,
      labelIds: group.map((component) => component.labelId),
      area,
      bounds,
      orientedBounds,
      polygon,
      solidity: Math.max(0, Math.min(1, area / hullArea)),
      rotationSavings: Math.max(0, Math.min(1, 1 - orientedBounds.w * orientedBounds.h / axisArea)),
    }
  }).sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)
    .map((sprite, index) => ({ ...sprite, id: index }))
  const gridCandidate = inferRegularGrid(
    foreground.mask,
    width,
    height,
    foreground.foregroundPixels,
    components.length,
    Math.max(2, Math.round(options.maxGridAxis ?? 16)),
  )
  const rotated = sprites.filter((sprite) =>
    Math.abs(sprite.orientedBounds.angleDegrees) >= 3 && sprite.rotationSavings >= 0.08)
  const meanSolidity = sprites.reduce((sum, sprite) => sum + sprite.solidity, 0) / Math.max(1, sprites.length)
  const layout: SpriteLayoutMode = gridCandidate && gridCandidate.confidence >= 0.78 ? 'grid' : 'components'
  const bounds: SpriteBoundsMode = rotated.length > 0
    ? 'oriented'
    : meanSolidity < 0.72 ? 'polygon' : 'axis_aligned'
  const confidence = layout === 'grid'
    ? gridCandidate!.confidence
    : Math.max(0, Math.min(1, sprites.length > 0 ? 0.86 - Math.min(0.25, sprites.length / 10000) : 0))
  const reasons = layout === 'grid'
    ? [`检测到 ${gridCandidate!.columns}×${gridCandidate!.rows} 的低穿切规则边界`]
    : [`检测到 ${sprites.length} 个独立前景区域，规则网格证据不足`]
  if (bounds === 'oriented') reasons.push(`${rotated.length} 个区域使用旋转矩形可明显减少空白`)
  else if (bounds === 'polygon') reasons.push('前景轮廓较不规则，建议保留多边形 Mask')
  else reasons.push('水平最小矩形已足够紧凑')
  const warnings: string[] = []
  if (foreground.mode === 'edge-color') warnings.push('图像没有可靠透明背景，已按边缘主色估计背景；复杂背景需要人工复核')
  if (sprites.length === 0) warnings.push('没有检测到超过最小面积阈值的 Sprite')
  if (components.length !== sprites.length) warnings.push(`按 merge_gap 将 ${components.length} 个部件合并为 ${sprites.length} 个候选`)
  if (sprites.length > 200) warnings.push('候选数量较多，可能包含背景噪点；建议提高 min_area')
  return {
    width,
    height,
    foregroundMask: foreground.mask,
    labels,
    foregroundPixels: foreground.foregroundPixels,
    background: { mode: foreground.mode, color: foreground.background },
    sprites,
    gridCandidate,
    recommendation: { layout, bounds, confidence, reasons },
    warnings,
  }
}
