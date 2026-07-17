import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoredAnalysisReport } from './reports.js'
import { createActionExportPlan, executeActionExportPlan } from './export-plans.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function report(): StoredAnalysisReport {
  return {
    version: 3,
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: new Date().toISOString(),
    videoPath: 'source.mp4',
    sourceKind: 'video',
    fps: 10,
    analysis: {
      sampledFrames: 20,
      windowsAnalyzed: 1,
      peakBufferedFrames: 20,
      candidates: [], windows: [], dominantPeriods: [], sceneCuts: [], duplicateGroups: [],
      actionSegments: [{
        index: 0, startFrame: 0, endFrame: 9, startTime: 0, endTime: 0.9,
        sampledFrames: 10, evidenceFrames: 10, evidenceTruncated: false,
        candidates: [], bestScoringCandidate: null,
      }],
    },
  }
}

describe('action export plans', () => {
  it('validates a review and exports an auditable action directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-plan-test-'))
    temporaryDirectories.push(root)
    const plan = await createActionExportPlan({
      report: report(), outputRoot: root, sourceWidth: 16, sourceHeight: 16,
      reviews: [{ actionIndex: 0, actionName: 'idle', exportEndExclusive: 4, endFrameDuplicatesStart: false }],
    })
    expect(plan.ready).toBe(true)
    expect(plan.estimatedFiles).toBe(5)
    const exporter = vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
      await mkdir(outputDirectory, { recursive: true })
      const files = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
        const path = join(outputDirectory, `frame_${String(index + 1).padStart(6, '0')}.png`)
        await writeFile(path, 'frame')
        return path
      }))
      return files
    })
    const result = await executeActionExportPlan(plan, report(), { exporter: exporter as never })
    expect(result.exported).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.results[0]?.manifestPath).toContain('frameloop-action.json')
  })

  it('refuses conflicting output in fail mode before invoking the exporter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-plan-conflict-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'idle'))
    await writeFile(join(root, 'idle', 'frame_000001.png'), 'existing')
    const plan = await createActionExportPlan({
      report: report(), outputRoot: root, sourceWidth: 16, sourceHeight: 16,
      reviews: [{ actionIndex: 0, actionName: 'idle', exportEndExclusive: 4, endFrameDuplicatesStart: false }],
      conflictPolicy: 'fail',
    })
    expect(plan.ready).toBe(false)
    const exporter = vi.fn()
    await expect(executeActionExportPlan(plan, report(), { exporter: exporter as never }))
      .rejects.toThrow('已有导出文件')
    expect(exporter).not.toHaveBeenCalled()
  })
})
