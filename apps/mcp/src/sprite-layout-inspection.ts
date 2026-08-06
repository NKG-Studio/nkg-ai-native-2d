import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  analyzeSpriteSheet,
  type SpriteDetectionOptions,
  type SpriteDetectionPoint,
  type SpriteOrientedRect,
} from '@frameloop/core'
import sharp from 'sharp'

function orientedCorners(rect: SpriteOrientedRect) {
  const angle = rect.angleDegrees * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [
    { x: -rect.w / 2, y: -rect.h / 2 },
    { x: rect.w / 2, y: -rect.h / 2 },
    { x: rect.w / 2, y: rect.h / 2 },
    { x: -rect.w / 2, y: rect.h / 2 },
  ].map((point) => ({
    x: rect.cx + point.x * cos - point.y * sin,
    y: rect.cy + point.x * sin + point.y * cos,
  }))
}

function sampledPolygon(points: SpriteDetectionPoint[], limit = 64) {
  if (points.length <= limit) return points
  const step = points.length / limit
  return Array.from({ length: limit }, (_, index) => points[Math.floor(index * step)]!)
}

function checkerboard(width: number, height: number) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><pattern id="c" width="24" height="24" patternUnits="userSpaceOnUse">
      <rect width="24" height="24" fill="#171a16"/><rect width="12" height="12" fill="#292e26"/>
      <rect x="12" y="12" width="12" height="12" fill="#292e26"/>
    </pattern></defs><rect width="100%" height="100%" fill="url(#c)"/>
  </svg>`)
}

export async function inspectSpriteSheetLayout(options: {
  atlasPath: string
  detection?: SpriteDetectionOptions
  maxPreviewSize?: number
}) {
  const atlasPath = resolve(options.atlasPath)
  await access(atlasPath)
  const source = sharp(atlasPath).ensureAlpha()
  const { data, info } = await source.clone().raw().toBuffer({ resolveWithObject: true })
  const analysis = analyzeSpriteSheet(data, info.width, info.height, options.detection)
  const maxPreviewSize = Math.max(256, Math.min(4096, Math.round(options.maxPreviewSize ?? 1600)))
  const scale = Math.min(1, maxPreviewSize / Math.max(info.width, info.height))
  const previewWidth = Math.max(1, Math.round(info.width * scale))
  const previewHeight = Math.max(1, Math.round(info.height * scale))
  const base = sharp({
    create: {
      width: previewWidth,
      height: previewHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([
    { input: checkerboard(previewWidth, previewHeight), left: 0, top: 0 },
    { input: await source.clone().resize(previewWidth, previewHeight, { fit: 'fill' }).png().toBuffer(), left: 0, top: 0 },
  ])
  const originalPreview = await base.clone().png().toBuffer()
  const grid = analysis.gridCandidate
  const gridLines = grid ? [
    ...Array.from({ length: grid.columns - 1 }, (_, index) => {
      const x = (index + 1) * grid.cellWidth * scale
      return `<line x1="${x}" y1="0" x2="${x}" y2="${previewHeight}"/>`
    }),
    ...Array.from({ length: grid.rows - 1 }, (_, index) => {
      const y = (index + 1) * grid.cellHeight * scale
      return `<line x1="0" y1="${y}" x2="${previewWidth}" y2="${y}"/>`
    }),
  ].join('') : ''
  const candidates = analysis.sprites.slice(0, 300)
  const overlays = candidates.map((sprite) => {
    const bounds = sprite.bounds
    const polygon = sampledPolygon(sprite.polygon)
      .map((point) => `${point.x * scale},${point.y * scale}`).join(' ')
    const oriented = orientedCorners(sprite.orientedBounds)
      .map((point) => `${point.x * scale},${point.y * scale}`).join(' ')
    const labelX = Math.max(10, bounds.x * scale + 3)
    const labelY = Math.max(14, bounds.y * scale + 14)
    return `<g>
      <rect x="${bounds.x * scale}" y="${bounds.y * scale}" width="${bounds.w * scale}" height="${bounds.h * scale}"/>
      <polygon class="hull" points="${polygon}"/><polygon class="oriented" points="${oriented}"/>
      <text x="${labelX}" y="${labelY}">${sprite.id}</text>
    </g>`
  }).join('')
  const overlaySvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${previewWidth}" height="${previewHeight}">
    <style>
      rect{fill:none;stroke:#c7f36a;stroke-width:2} .hull{fill:rgba(88,207,255,.12);stroke:#58cfff;stroke-width:1}
      .oriented{fill:none;stroke:#ff8a50;stroke-width:2;stroke-dasharray:5 3} text{font:700 13px monospace;fill:#111;stroke:#fff;stroke-width:3;paint-order:stroke}
      .grid{stroke:#f7dd5c;stroke-width:2;stroke-dasharray:8 5}
    </style><g class="grid">${gridLines}</g>${overlays}
  </svg>`)
  const annotatedPreview = await base.clone().composite([{ input: overlaySvg, left: 0, top: 0 }]).png().toBuffer()
  const result = {
    atlasPath,
    width: info.width,
    height: info.height,
    channels: info.channels,
    previewScale: scale,
    foreground: {
      mode: analysis.background.mode,
      estimatedBackgroundColor: analysis.background.color,
      pixels: analysis.foregroundPixels,
      coverage: analysis.foregroundPixels / (info.width * info.height),
    },
    componentCandidates: analysis.sprites.map((sprite) => ({
      id: sprite.id,
      area: sprite.area,
      bounds: sprite.bounds,
      orientedBounds: sprite.orientedBounds,
      polygon: sampledPolygon(sprite.polygon),
      solidity: sprite.solidity,
      rotationSavings: sprite.rotationSavings,
      sourceLabelIds: sprite.labelIds,
    })),
    gridCandidate: analysis.gridCandidate,
    heuristicSuggestion: analysis.recommendation,
    warnings: analysis.warnings,
    imageOrder: [
      '原图预览（透明区域使用棋盘格）',
      '候选叠加图：绿色=水平矩形，蓝色=凸包，橙色=旋转最小矩形，黄色虚线=规则网格候选',
    ],
    aiReviewTask: {
      goal: '观察原图与候选叠加图，选择不会误合并、误拆分主体的切图模式。启发式建议只作为证据，不是最终决定。',
      chooseOne: [
        'grid：规则行列；返回 columns、rows、padding、frame_count、bounds',
        'components：透明或单色背景下的独立连通区域；返回 bounds、min_area、merge_gap、背景参数',
        'regions：候选误分时返回人工确认的 rect、rotated_rect 或 polygon 区域列表',
      ],
      boundsOptions: ['axis_aligned', 'oriented', 'polygon'],
      requiredReturnFields: ['mode', 'bounds', 'confidence', 'reason'],
      nextTool: 'slice_sprite_sheet',
    },
  }
  return { result, originalPreview, annotatedPreview }
}
