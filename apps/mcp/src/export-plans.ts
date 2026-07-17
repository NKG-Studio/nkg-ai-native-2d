import { randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import type { StoredAnalysisReport } from './reports.js'
import { exportVideoFrames } from './video.js'

const PLAN_VERSION = 1
const PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000
const PLAN_DIRECTORY = join(tmpdir(), 'frameloop-export-plans')

export type ExportConflictPolicy = 'fail' | 'skip' | 'replace'

export interface ActionExportReview {
  actionIndex: number
  actionName: string
  exportStartFrame?: number
  exportEndExclusive: number
  endFrameDuplicatesStart: boolean
  aiConfidence?: number
  aiReason?: string
}

export interface ActionExportPlanItem {
  actionIndex: number
  actionName: string
  outputDirectory: string
  exportStartFrame: number
  exportEndExclusive: number
  frameCount: number
  sourceSegment: { startFrame: number; endFrame: number }
  endFrameDuplicatesStart: boolean
  aiConfidence: number | null
  aiReason: string | null
  estimatedBytes: number
  collisions: string[]
}

export interface ActionExportPlan {
  version: typeof PLAN_VERSION
  id: string
  createdAt: string
  reportId: string
  sourcePath: string
  fps: number
  outputRoot: string
  conflictPolicy: ExportConflictPolicy
  estimatedFiles: number
  estimatedBytes: number
  availableBytes: number | null
  ready: boolean
  items: ActionExportPlanItem[]
}

export interface ActionExportResult {
  actionIndex: number
  actionName: string
  outputDirectory: string
  status: 'exported' | 'skipped' | 'failed'
  frameCount: number
  files: string[]
  manifestPath: string | null
  error: string | null
}

const safeActionName = (value: string, index: number) => {
  const safe = value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe || `action-${String(index).padStart(2, '0')}`
}

function planPath(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('无效的导出计划 ID')
  return join(PLAN_DIRECTORY, `${id}.json`)
}

async function cleanupStalePlans() {
  const now = Date.now()
  const names = await readdir(PLAN_DIRECTORY).catch(() => [])
  await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
    const path = join(PLAN_DIRECTORY, name)
    const metadata = await stat(path).catch(() => null)
    if (metadata && now - metadata.mtimeMs > PLAN_MAX_AGE_MS) await rm(path, { force: true })
  }))
}

async function listCollisions(outputDirectory: string) {
  return (await readdir(outputDirectory).catch(() => []))
    .filter((name) => /^frame_\d+\.png$/i.test(name) || name === 'frameloop-action.json')
    .sort()
}

async function availableBytesFor(path: string): Promise<number | null> {
  let current = resolve(path)
  const root = parse(current).root
  while (true) {
    try {
      await access(current)
      const info = await statfs(current)
      return Number(info.bavail) * Number(info.bsize)
    } catch {
      if (current === root) return null
      current = dirname(current)
    }
  }
}

export async function createActionExportPlan(options: {
  report: StoredAnalysisReport
  outputRoot: string
  reviews: ActionExportReview[]
  conflictPolicy?: ExportConflictPolicy
  sourceWidth: number
  sourceHeight: number
}) {
  const { report } = options
  if (report.sourceKind !== 'video') throw new Error('批量动作导出仅支持视频分析报告')
  if (options.reviews.length === 0) throw new Error('至少需要一个动作复核结果')
  const outputRoot = resolve(options.outputRoot)
  const conflictPolicy = options.conflictPolicy ?? 'fail'
  const usedNames = new Set<string>()
  const items: ActionExportPlanItem[] = []

  for (const review of options.reviews) {
    const action = report.analysis.actionSegments[review.actionIndex]
    if (!action) throw new Error(`动作段 ${review.actionIndex} 不存在`)
    const actionName = safeActionName(review.actionName, review.actionIndex)
    if (usedNames.has(actionName)) throw new Error(`动作名称冲突：${actionName}`)
    usedNames.add(actionName)
    const exportStartFrame = review.exportStartFrame ?? action.startFrame
    if (exportStartFrame < action.startFrame || exportStartFrame > action.endFrame) {
      throw new Error(`${actionName} 的 export_start_frame 必须位于 ${action.startFrame}..${action.endFrame}`)
    }
    if (review.exportEndExclusive <= exportStartFrame || review.exportEndExclusive > action.endFrame + 1) {
      throw new Error(`${actionName} 的 export_end_exclusive 必须位于 ${exportStartFrame + 1}..${action.endFrame + 1}`)
    }
    const frameCount = review.exportEndExclusive - exportStartFrame
    const outputDirectory = join(outputRoot, actionName)
    const estimatedBytes = Math.ceil(options.sourceWidth * options.sourceHeight * 4 * frameCount * 1.1)
    items.push({
      actionIndex: action.index,
      actionName,
      outputDirectory,
      exportStartFrame,
      exportEndExclusive: review.exportEndExclusive,
      frameCount,
      sourceSegment: { startFrame: action.startFrame, endFrame: action.endFrame },
      endFrameDuplicatesStart: review.endFrameDuplicatesStart,
      aiConfidence: review.aiConfidence ?? null,
      aiReason: review.aiReason ?? null,
      estimatedBytes,
      collisions: await listCollisions(outputDirectory),
    })
  }

  const estimatedBytes = items.reduce((sum, item) => sum + item.estimatedBytes, 0)
  const availableBytes = await availableBytesFor(outputRoot)
  const ready = (conflictPolicy !== 'fail' || items.every((item) => item.collisions.length === 0))
    && (availableBytes === null || availableBytes >= estimatedBytes)
  const plan: ActionExportPlan = {
    version: PLAN_VERSION,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    reportId: report.id,
    sourcePath: report.videoPath,
    fps: report.fps,
    outputRoot,
    conflictPolicy,
    estimatedFiles: items.reduce((sum, item) => sum + item.frameCount + 1, 0),
    estimatedBytes,
    availableBytes,
    ready,
    items,
  }
  await mkdir(PLAN_DIRECTORY, { recursive: true })
  await cleanupStalePlans()
  await writeFile(planPath(plan.id), JSON.stringify(plan), 'utf8')
  return plan
}

export async function readActionExportPlan(id: string): Promise<ActionExportPlan> {
  const plan = JSON.parse(await readFile(planPath(id), 'utf8')) as ActionExportPlan
  if (plan.version !== PLAN_VERSION || plan.id !== id || !Array.isArray(plan.items)) {
    throw new Error('导出计划格式无效或版本不兼容')
  }
  if (Date.now() - Date.parse(plan.createdAt) > PLAN_MAX_AGE_MS) throw new Error('导出计划已过期，请重新创建')
  return plan
}

async function clearGeneratedActionFiles(outputDirectory: string) {
  const names = await listCollisions(outputDirectory)
  await Promise.all(names.map((name) => rm(join(outputDirectory, name), { force: true })))
}

type FrameExporter = typeof exportVideoFrames

export async function executeActionExportPlan(
  plan: ActionExportPlan,
  report: StoredAnalysisReport,
  options: {
    exporter?: FrameExporter
    onProgress?: (completed: number, total: number, message: string) => void | Promise<void>
  } = {},
) {
  if (plan.reportId !== report.id || plan.sourcePath !== report.videoPath) {
    throw new Error('导出计划与分析报告不匹配')
  }
  if (plan.availableBytes !== null && plan.availableBytes < plan.estimatedBytes) {
    throw new Error(`磁盘空间不足：预计需要 ${plan.estimatedBytes} 字节，可用 ${plan.availableBytes} 字节`)
  }
  const currentCollisions = await Promise.all(plan.items.map((item) => listCollisions(item.outputDirectory)))
  if (plan.conflictPolicy === 'fail') {
    const conflict = plan.items.find((_, index) => currentCollisions[index]!.length > 0)
    if (conflict) throw new Error(`目标目录已有导出文件：${conflict.outputDirectory}`)
  }

  const exporter = options.exporter ?? exportVideoFrames
  const results: ActionExportResult[] = []
  for (let index = 0; index < plan.items.length; index += 1) {
    const item = plan.items[index]!
    const collisions = currentCollisions[index]!
    if (collisions.length > 0 && plan.conflictPolicy === 'skip') {
      results.push({
        actionIndex: item.actionIndex,
        actionName: item.actionName,
        outputDirectory: item.outputDirectory,
        status: 'skipped',
        frameCount: 0,
        files: [],
        manifestPath: null,
        error: `跳过已有文件：${collisions.join(', ')}`,
      })
      await options.onProgress?.(index + 1, plan.items.length, `已跳过 ${item.actionName}`)
      continue
    }
    try {
      if (plan.conflictPolicy === 'replace') await clearGeneratedActionFiles(item.outputDirectory)
      const files = await exporter({
        inputPath: report.videoPath,
        outputDirectory: item.outputDirectory,
        fps: report.fps,
        startTime: item.exportStartFrame / report.fps,
        endTime: item.exportEndExclusive / report.fps,
      })
      if (files.length !== item.frameCount) {
        throw new Error(`导出帧数不一致：计划 ${item.frameCount}，实际 ${files.length}`)
      }
      const manifestPath = join(item.outputDirectory, 'frameloop-action.json')
      await writeFile(manifestPath, JSON.stringify({
        version: 2,
        planId: plan.id,
        reportId: report.id,
        sourcePath: report.videoPath,
        fps: report.fps,
        actionIndex: item.actionIndex,
        actionName: item.actionName,
        sourceSegment: item.sourceSegment,
        selectedLoop: {
          startFrame: item.exportStartFrame,
          exportEndExclusive: item.exportEndExclusive,
          frameCount: item.frameCount,
          endFrameDuplicatesStart: item.endFrameDuplicatesStart,
        },
        aiReview: { confidence: item.aiConfidence, reason: item.aiReason },
        exportedFiles: files,
      }, null, 2), 'utf8')
      results.push({
        actionIndex: item.actionIndex,
        actionName: item.actionName,
        outputDirectory: item.outputDirectory,
        status: 'exported',
        frameCount: files.length,
        files,
        manifestPath,
        error: null,
      })
    } catch (cause) {
      results.push({
        actionIndex: item.actionIndex,
        actionName: item.actionName,
        outputDirectory: item.outputDirectory,
        status: 'failed',
        frameCount: 0,
        files: [],
        manifestPath: null,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
    await options.onProgress?.(index + 1, plan.items.length, `已处理 ${item.actionName}`)
  }
  return {
    planId: plan.id,
    outputRoot: plan.outputRoot,
    exported: results.filter((item) => item.status === 'exported').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    results,
  }
}
