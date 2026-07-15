import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamingLoopAnalysisResult } from './streaming.js'

const REPORT_VERSION = 3
const REPORT_DIRECTORY = join(tmpdir(), 'frameloop-analysis-reports')
const REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface StoredAnalysisReport {
  version: number
  id: string
  createdAt: string
  videoPath: string
  sourceKind: 'video' | 'image_sequence'
  fps: number
  analysis: StreamingLoopAnalysisResult
}

function reportPath(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('无效的分析报告 ID')
  return join(REPORT_DIRECTORY, `${id}.json`)
}

async function cleanupStaleReports() {
  const now = Date.now()
  const files = await readdir(REPORT_DIRECTORY).catch(() => [])
  await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
    const path = join(REPORT_DIRECTORY, file)
    const metadata = await stat(path).catch(() => null)
    if (metadata && now - metadata.mtimeMs > REPORT_MAX_AGE_MS) await rm(path, { force: true })
  }))
}

export async function writeAnalysisReport(
  videoPath: string,
  fps: number,
  analysis: StreamingLoopAnalysisResult,
  sourceKind: StoredAnalysisReport['sourceKind'] = 'video',
): Promise<StoredAnalysisReport> {
  const report: StoredAnalysisReport = {
    version: REPORT_VERSION,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    videoPath,
    sourceKind,
    fps,
    analysis,
  }
  await mkdir(REPORT_DIRECTORY, { recursive: true })
  await cleanupStaleReports()
  await writeFile(reportPath(report.id), JSON.stringify(report))
  return report
}

export async function readAnalysisReport(id: string): Promise<StoredAnalysisReport> {
  const report = JSON.parse(await readFile(reportPath(id), 'utf8')) as StoredAnalysisReport
  if (report.version !== REPORT_VERSION || report.id !== id || !report.analysis) {
    throw new Error('分析报告格式不受支持或已损坏')
  }
  return report
}

export function pageAnalysisReport(
  report: StoredAnalysisReport,
  options: {
    windowOffset: number
    windowLimit: number
    candidateOffset: number
    candidateLimit: number
    actionOffset?: number
    actionLimit?: number
  },
) {
  const windowOffset = Math.max(0, Math.floor(options.windowOffset))
  const windowLimit = Math.max(1, Math.floor(options.windowLimit))
  const candidateOffset = Math.max(0, Math.floor(options.candidateOffset))
  const candidateLimit = Math.max(1, Math.floor(options.candidateLimit))
  const actionOffset = Math.max(0, Math.floor(options.actionOffset ?? 0))
  const actionLimit = Math.max(1, Math.floor(options.actionLimit ?? 12))
  return {
    report: {
      id: report.id,
      createdAt: report.createdAt,
      videoPath: report.videoPath,
      sourceKind: report.sourceKind,
      fps: report.fps,
    },
    totals: {
      sampledFrames: report.analysis.sampledFrames,
      windows: report.analysis.windows.length,
      candidates: report.analysis.candidates.length,
      sceneCuts: report.analysis.sceneCuts.length,
      duplicateGroups: report.analysis.duplicateGroups.length,
      actions: report.analysis.actionSegments.length,
    },
    windowPage: {
      offset: windowOffset,
      limit: windowLimit,
      hasMore: windowOffset + windowLimit < report.analysis.windows.length,
      items: report.analysis.windows.slice(windowOffset, windowOffset + windowLimit),
    },
    candidatePage: {
      offset: candidateOffset,
      limit: candidateLimit,
      hasMore: candidateOffset + candidateLimit < report.analysis.candidates.length,
      items: report.analysis.candidates.slice(candidateOffset, candidateOffset + candidateLimit),
    },
    actionPage: {
      offset: actionOffset,
      limit: actionLimit,
      hasMore: actionOffset + actionLimit < report.analysis.actionSegments.length,
      items: report.analysis.actionSegments.slice(actionOffset, actionOffset + actionLimit),
    },
    dominantPeriods: report.analysis.dominantPeriods,
    sceneCuts: report.analysis.sceneCuts,
    duplicateGroups: report.analysis.duplicateGroups,
  }
}
