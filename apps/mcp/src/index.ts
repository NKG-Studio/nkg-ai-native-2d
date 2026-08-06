#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { pageAnalysisReport, readAnalysisReport, writeAnalysisReport } from './reports.js'
import { analyzeAnchoredActionSegments, analyzeFeatureStream } from './streaming.js'
import { createProgressReporter } from './progress.js'
import {
  createActionExportPlan,
  executeActionExportPlan,
  readActionExportPlan,
} from './export-plans.js'
import { exportSpriteBundle, sliceSpriteSheet, validateSpriteBundle } from './sprite-bundle.js'
import { applyAiMatteBatch, applyChromaKeyBatch } from './matting.js'
import { analyzeMatteQuality, refineMatteBatch } from './matte-refinement.js'
import { inspectSpriteSheetLayout } from './sprite-layout-inspection.js'
import {
  createSpriteSheetFile,
  exportVideoFrames,
  probeVideo,
  renderActionSegmentReviewSheet,
  renderImageLoopContactSheet,
  renderLoopContactSheet,
  streamAnalysisFeatures,
  streamImageFeatures,
} from './video.js'

export const server = new McpServer(
  { name: 'frameloop-mcp', version: '0.1.0' },
  {
    instructions: '先用 inspect_video 获取媒体信息，再用 analyze_video_loop 自动检测多段动作并生成段首闭环与段内周期核心候选。随后调用 review_video_action_segments，让多模态 AI 根据动作概览和六帧接缝选择最早完整闭环。单动作可在确认路径和边界后调用 export_reviewed_action；多动作应先调用 create_action_export_plan 展示完整计划，由用户确认后再调用 export_action_batch。透明背景先使用 apply_chroma_key_batch 或 apply_ai_matte_batch，再用 analyze_matte_quality 定位孤立像素、孔洞和半透明边缘；需要修复时调用 refine_matte_batch，并再次诊断确认。最终用 export_sprite_bundle 合并并用 validate_sprite_bundle 验证。对外部图集切图时，先调用 inspect_sprite_sheet_layout 获取原图和候选叠加图，由多模态 AI 选择 grid、components 或 regions，再调用 slice_sprite_sheet 执行。所有路径均为运行 MCP 进程所在机器的本地绝对或相对路径。',
  },
)

const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
})

const actionReviewSchema = z.object({
  action_index: z.number().int().nonnegative(),
  action_name: z.string().min(1),
  export_start_frame: z.number().int().nonnegative().optional(),
  export_end_exclusive: z.number().int().positive(),
  end_frame_duplicates_start: z.boolean(),
  ai_confidence: z.number().min(0).max(1).optional(),
  ai_reason: z.string().optional(),
})

const bundleAnimationSchema = z.object({
  name: z.string().min(1),
  frame_paths: z.array(z.string().min(1)).min(1),
  durations: z.array(z.number().int().positive()).optional(),
  source_frame_ids: z.array(z.number().int().nonnegative()).optional(),
})

const spritePointSchema = z.object({ x: z.number(), y: z.number() })
const spriteRegionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('rect'),
    name: z.string().min(1).optional(),
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    w: z.number().positive(),
    h: z.number().positive(),
  }),
  z.object({
    type: z.literal('rotated_rect'),
    name: z.string().min(1).optional(),
    cx: z.number(),
    cy: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    angle_degrees: z.number().min(-180).max(180),
  }),
  z.object({
    type: z.literal('polygon'),
    name: z.string().min(1).optional(),
    points: z.array(spritePointSchema).min(3).max(10000),
    angle_degrees: z.number().min(-180).max(180).optional(),
  }),
])

const matteCorrectionSchema = z.object({
  frame_index: z.number().int().nonnegative().describe('从 0 开始的帧序号'),
  mode: z.enum(['remove', 'restore']).describe('移除背景残点，或从源帧恢复主体像素'),
  diameter_pixels: z.number().min(1).max(4096).describe('笔刷直径，最小可精确到 1 像素'),
  coordinate_space: z.enum(['pixel', 'normalized']).default('pixel').describe('像素坐标，或 0 到 1 的归一化坐标'),
  points: z.array(z.object({
    x: z.number(),
    y: z.number(),
  })).min(1).max(10000).describe('按顺序连接的笔画点；单点可修正一个像素'),
})

server.registerTool(
  'inspect_sprite_sheet_layout',
  {
    title: '向多模态 AI 展示图集布局候选',
    description: '读取外部 Sprite Sheet，返回原图预览、候选叠加图、规则网格与连通区域诊断，供 Codex、Claude Code 等外部多模态 Agent 选择切图模式；本工具不替 AI 作最终决定。',
    inputSchema: {
      atlas_path: z.string().min(1),
      background_mode: z.enum(['auto', 'alpha', 'edge-color']).default('auto'),
      alpha_threshold: z.number().int().min(0).max(255).default(1),
      background_tolerance: z.number().min(0).max(441).default(36),
      min_area: z.number().int().min(1).optional(),
      merge_gap: z.number().min(0).max(4096).default(0),
      max_preview_size: z.number().int().min(256).max(4096).default(1600),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ atlas_path, background_mode, alpha_threshold, background_tolerance, min_area, merge_gap, max_preview_size }) => {
    const inspection = await inspectSpriteSheetLayout({
      atlasPath: atlas_path,
      detection: {
        backgroundMode: background_mode,
        alphaThreshold: alpha_threshold,
        backgroundTolerance: background_tolerance,
        minArea: min_area,
        mergeGap: merge_gap,
      },
      maxPreviewSize: max_preview_size,
    })
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(inspection.result, null, 2) },
        { type: 'image' as const, data: inspection.originalPreview.toString('base64'), mimeType: 'image/png' as const },
        { type: 'image' as const, data: inspection.annotatedPreview.toString('base64'), mimeType: 'image/png' as const },
      ],
    }
  },
)

server.registerTool(
  'inspect_video',
  {
    title: '读取视频元信息',
    description: '读取本地视频的时长、分辨率、帧率、编码和容器格式。',
    inputSchema: { path: z.string().min(1).describe('本地视频路径') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ path }) => textResult(await probeVideo(path)),
)

server.registerTool(
  'analyze_video_loop',
  {
    title: '分析视频循环区间',
    description: '流式采样任意长度的本地视频，以局部突变检测硬切动作段；每段同时筛选从段首闭环和段内稳定周期两类候选。不写用户目录，仅保存可分页读取的临时报告。',
    inputSchema: {
      path: z.string().min(1).describe('本地视频路径'),
      fps: z.number().positive().default(12).describe('分析采样帧率；没有硬上限，应按动作速度和算力选择'),
      min_loop_seconds: z.number().min(0.1).default(0.5),
      max_loop_seconds: z.number().min(0.2).optional(),
      analysis_window_seconds: z.number().positive().default(20).describe('单个分析窗口长度，不限制视频总长度'),
      window_overlap_seconds: z.number().nonnegative().optional().describe('相邻窗口重叠；未指定时根据最大循环长度自动选择'),
      top_k: z.number().int().min(1).max(12).default(5).describe('每个动作段沿时间分布保留的候选数'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ path, fps, min_loop_seconds, max_loop_seconds, analysis_window_seconds, window_overlap_seconds, top_k }, extra) => {
    const info = await probeVideo(path)
    const expectedFrames = Math.max(1, Math.ceil(info.duration * fps))
    const progressTotal = expectedFrames * 2 + 3
    const reportProgress = createProgressReporter(extra)
    await reportProgress({ progress: 0, total: progressTotal, message: '准备视频分析', force: true })
    const minFrames = Math.max(2, Math.round(min_loop_seconds * fps))
    const maxFrames = max_loop_seconds ? Math.max(minFrames, Math.round(max_loop_seconds * fps)) : undefined
    const requestedWindowFrames = Math.max(minFrames, Math.round(analysis_window_seconds * fps))
    const windowFrames = maxFrames ? Math.max(requestedWindowFrames, maxFrames * 2) : requestedWindowFrames
    const overlapFrames = window_overlap_seconds === undefined
      ? maxFrames ?? Math.floor(windowFrames / 4)
      : Math.round(window_overlap_seconds * fps)
    const analysis = await analyzeFeatureStream(streamAnalysisFeatures(path, fps, { signal: extra.signal }), {
      minFrames,
      maxFrames,
      windowFrames,
      overlapFrames,
      topKPerSegment: top_k,
      motionWindow: 3,
      onProgress: (sampled, windows) => reportProgress({
        progress: Math.min(expectedFrames, sampled),
        total: progressTotal,
        message: `已扫描 ${sampled} 帧 · ${windows} 个窗口`,
      }),
    })
    const actionSegments = await analyzeAnchoredActionSegments(
      streamAnalysisFeatures(path, fps, { signal: extra.signal }),
      analysis.sceneCuts.map((cut) => cut.frame),
      {
        minFrames,
        maxFrames: maxFrames ?? windowFrames,
        topKPerSegment: Math.min(top_k, 5),
        motionWindow: 3,
        onProgress: (sampled, segments) => reportProgress({
          progress: expectedFrames + Math.min(expectedFrames, sampled),
          total: progressTotal,
          message: `已复核 ${sampled} 帧 · ${segments} 个动作段`,
        }),
      },
    )
    analysis.actionSegments = actionSegments
    analysis.candidates = actionSegments.flatMap((segment) => segment.candidates)
    const report = await writeAnalysisReport(info.path, fps, analysis)
    const firstPage = pageAnalysisReport(report, {
      windowOffset: 0,
      windowLimit: 12,
      candidateOffset: 0,
      candidateLimit: top_k,
    })
    const candidates = firstPage.candidatePage.items
    const result = {
      video: info,
      report: {
        id: report.id,
        createdAt: report.createdAt,
        windows: analysis.windows.length,
        candidates: analysis.candidates.length,
        actions: actionSegments.length,
        nextTool: 'read_analysis_report',
        nextReviewTool: 'review_video_action_segments',
      },
      sampling: {
        fps,
        sampledFrames: analysis.sampledFrames,
        windowsAnalyzed: analysis.windowsAnalyzed,
        peakBufferedFrames: analysis.peakBufferedFrames,
        analysisWindowSeconds: windowFrames / fps,
        windowOverlapSeconds: Math.min(windowFrames - 1, overlapFrames) / fps,
      },
      candidates: candidates.map((candidate) => ({
        ...candidate,
        suggestedEndExclusive: Math.min(info.duration, (candidate.endFrame + 1) / fps),
      })),
      actions: actionSegments,
      sequence: {
        dominantPeriods: analysis.dominantPeriods,
        duplicateGroups: analysis.duplicateGroups,
        sceneCuts: analysis.sceneCuts,
        windowPage: firstPage.windowPage,
      },
      note: '视频已完整流式扫描并按局部硬切分成动作段；候选同时包含 segment_anchor 段首闭环和 periodic_core 段内稳定周期。前两张图片是动作概览与接缝候选，其余动作请调用 review_video_action_segments。confidence 是启发式相对置信度，不是语义正确概率。',
    }
    const initialActionSheets = await Promise.all(actionSegments.slice(0, 2).map((segment) =>
      renderActionSegmentReviewSheet(path, segment, fps, Math.min(3, top_k))))
    await reportProgress({
      progress: progressTotal,
      total: progressTotal,
      message: '视频分析与初始复核图已完成',
      force: true,
    })
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ...initialActionSheets.map((sheet) => ({
          type: 'image' as const,
          data: sheet.toString('base64'),
          mimeType: 'image/png' as const,
        })),
      ],
    }
  },
)

server.registerTool(
  'read_analysis_report',
  {
    title: '分页读取流式分析报告',
    description: '按窗口和候选分页读取视频或图片序列的完整临时报告，避免任意长度输入撑爆单次 MCP 响应。',
    inputSchema: {
      report_id: z.string().uuid(),
      window_offset: z.number().int().nonnegative().default(0),
      window_limit: z.number().int().positive().default(12),
      candidate_offset: z.number().int().nonnegative().default(0),
      candidate_limit: z.number().int().positive().default(24),
      action_offset: z.number().int().nonnegative().default(0),
      action_limit: z.number().int().positive().default(12),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ report_id, window_offset, window_limit, candidate_offset, candidate_limit, action_offset, action_limit }) => textResult(
    pageAnalysisReport(await readAnalysisReport(report_id), {
      windowOffset: window_offset,
      windowLimit: window_limit,
      candidateOffset: candidate_offset,
      candidateLimit: candidate_limit,
      actionOffset: action_offset,
      actionLimit: action_limit,
    }),
  ),
)

server.registerTool(
  'review_video_loop_candidates',
  {
    title: '回传候选循环首尾帧',
    description: '从长视频分析报告中按页提取候选循环的首尾帧接缝图，供多模态 AI 判断动作语义和候选质量。',
    inputSchema: {
      report_id: z.string().uuid(),
      candidate_offset: z.number().int().nonnegative().default(0),
      candidate_limit: z.number().int().min(1).max(12).default(6),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ report_id, candidate_offset, candidate_limit }) => {
    const report = await readAnalysisReport(report_id)
    if (report.sourceKind !== 'video') throw new Error('该报告来自图片序列，请使用 analyze_sprite_sequence 返回的接缝图')
    const candidates = report.analysis.candidates.slice(candidate_offset, candidate_offset + candidate_limit)
    const contactSheet = await renderLoopContactSheet(report.videoPath, candidates, report.fps)
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({
          reportId: report.id,
          offset: candidate_offset,
          limit: candidate_limit,
          hasMore: candidate_offset + candidate_limit < report.analysis.candidates.length,
          candidates,
        }, null, 2) },
        { type: 'image' as const, data: contactSheet.toString('base64'), mimeType: 'image/png' },
      ],
    }
  },
)

server.registerTool(
  'review_video_action_segments',
  {
    title: '回传动作分段概览与循环接缝帧',
    description: '按动作段回传全段八帧概览，以及每个候选的 END-2/END-1/END/START/START+1/START+2 接缝帧，供多模态 AI 判断动作语义、完整性和最早有效循环终点。',
    inputSchema: {
      report_id: z.string().uuid(),
      action_offset: z.number().int().nonnegative().default(0),
      action_limit: z.number().int().min(1).max(4).default(2),
      candidates_per_action: z.number().int().min(1).max(5).default(3),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ report_id, action_offset, action_limit, candidates_per_action }) => {
    const report = await readAnalysisReport(report_id)
    if (report.sourceKind !== 'video') throw new Error('动作分段多帧复核当前仅支持视频报告')
    const actions = report.analysis.actionSegments.slice(action_offset, action_offset + action_limit)
    const sheets = await Promise.all(actions.map((action) =>
      renderActionSegmentReviewSheet(report.videoPath, action, report.fps, candidates_per_action)))
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({
          reportId: report.id,
          offset: action_offset,
          limit: action_limit,
          hasMore: action_offset + action_limit < report.analysis.actionSegments.length,
          actions,
          aiReviewTask: {
            goal: '为每个动作选择最早且完整、接缝自然的循环终点；不要仅因特效微循环而截断主体动作。',
            returnFields: [
              'action_index',
              'action_name',
              'action_complete',
              'seam_is_smooth',
              'earliest_valid_start_frame',
              'earliest_valid_end_frame',
              'end_frame_duplicates_start',
              'export_end_exclusive',
              'confidence',
              'reason',
            ],
          },
        }, null, 2) },
        ...sheets.map((sheet) => ({ type: 'image' as const, data: sheet.toString('base64'), mimeType: 'image/png' as const })),
      ],
    }
  },
)

server.registerTool(
  'analyze_sprite_sequence',
  {
    title: '分析现有序列帧',
    description: '流式分析任意长度的 PNG/JPEG/WebP 序列，返回循环候选、主周期、重复帧和镜头切换；不写用户目录，仅保存可分页读取的临时报告。',
    inputSchema: {
      frame_paths: z.array(z.string().min(1)).min(3).describe('按播放顺序排列的本地图片路径；流式读取，不限制序列长度'),
      fps: z.number().positive().default(12),
      min_loop_frames: z.number().int().min(2).default(6),
      max_loop_frames: z.number().int().min(3).optional(),
      analysis_window_frames: z.number().int().positive().default(240),
      window_overlap_frames: z.number().int().nonnegative().optional(),
      top_k: z.number().int().min(1).max(12).default(5).describe('每个镜头分段保留的候选数'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ frame_paths, fps, min_loop_frames, max_loop_frames, analysis_window_frames, window_overlap_frames, top_k }, extra) => {
    const expectedFrames = frame_paths.length
    const progressTotal = expectedFrames * 2 + 2
    const reportProgress = createProgressReporter(extra)
    await reportProgress({ progress: 0, total: progressTotal, message: '准备分析图片序列', force: true })
    const windowFrames = max_loop_frames
      ? Math.max(analysis_window_frames, max_loop_frames * 2)
      : Math.max(analysis_window_frames, min_loop_frames)
    const overlapFrames = window_overlap_frames ?? max_loop_frames ?? Math.floor(windowFrames / 4)
    const analysis = await analyzeFeatureStream(streamImageFeatures(frame_paths, fps, { signal: extra.signal }), {
      minFrames: min_loop_frames,
      maxFrames: max_loop_frames,
      windowFrames,
      overlapFrames,
      topKPerSegment: top_k,
      motionWindow: 3,
      onProgress: (sampled, windows) => reportProgress({
        progress: Math.min(expectedFrames, sampled),
        total: progressTotal,
        message: `已分析 ${sampled}/${expectedFrames} 帧 · ${windows} 个窗口`,
      }),
    })
    const actionSegments = await analyzeAnchoredActionSegments(
      streamImageFeatures(frame_paths, fps, { signal: extra.signal }),
      analysis.sceneCuts.map((cut) => cut.frame),
      {
        minFrames: min_loop_frames,
        maxFrames: max_loop_frames ?? windowFrames,
        topKPerSegment: Math.min(top_k, 5),
        motionWindow: 3,
        onProgress: (sampled, segments) => reportProgress({
          progress: expectedFrames + Math.min(expectedFrames, sampled),
          total: progressTotal,
          message: `已复核 ${sampled}/${expectedFrames} 帧 · ${segments} 个动作段`,
        }),
      },
    )
    analysis.actionSegments = actionSegments
    analysis.candidates = actionSegments.flatMap((segment) => segment.candidates)
    const report = await writeAnalysisReport(frame_paths[0]!, fps, analysis, 'image_sequence')
    const firstPage = pageAnalysisReport(report, {
      windowOffset: 0,
      windowLimit: 12,
      candidateOffset: 0,
      candidateLimit: top_k,
    })
    const candidates = firstPage.candidatePage.items
    const contactSheet = await renderImageLoopContactSheet(frame_paths, candidates)
    await reportProgress({
      progress: progressTotal,
      total: progressTotal,
      message: '图片序列分析已完成',
      force: true,
    })
    const result = {
      frameCount: analysis.sampledFrames,
      fps,
      report: {
        id: report.id,
        windows: analysis.windows.length,
        candidates: analysis.candidates.length,
        nextTool: 'read_analysis_report',
      },
      candidates,
      actions: actionSegments,
      sequence: {
        dominantPeriods: analysis.dominantPeriods,
        duplicateGroups: analysis.duplicateGroups,
        sceneCuts: analysis.sceneCuts,
        windowPage: firstPage.windowPage,
      },
    }
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        { type: 'image' as const, data: contactSheet.toString('base64'), mimeType: 'image/png' },
      ],
    }
  },
)

server.registerTool(
  'export_loop_frames',
  {
    title: '导出循环序列帧',
    description: '把指定时间区间按 FPS 导出为连续 PNG 文件。会创建或写入 output_directory。',
    inputSchema: {
      path: z.string().min(1).describe('本地视频路径'),
      output_directory: z.string().min(1).describe('序列帧输出目录'),
      fps: z.number().positive().default(12),
      start_time: z.number().min(0),
      end_time: z.number().positive(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ path, output_directory, fps, start_time, end_time }, extra) => {
    const progress = createProgressReporter(extra)
    await progress({ progress: 0, total: 1, message: '开始导出循环帧', force: true })
    const files = await exportVideoFrames({
      inputPath: path, outputDirectory: output_directory, fps, startTime: start_time, endTime: end_time,
    })
    await progress({ progress: 1, total: 1, message: `已导出 ${files.length} 帧`, force: true })
    return textResult({ files })
  },
)

server.registerTool(
  'export_reviewed_action',
  {
    title: '导出 AI 复核后的动作循环',
    description: '根据分析报告中的动作起点和 AI 选择的全局排他结束帧导出最终序列，并写入包含动作边界与 AI 判断的清单。调用前应由用户确认输出目录和所选边界。',
    inputSchema: {
      report_id: z.string().uuid(),
      action_index: z.number().int().nonnegative(),
      export_start_frame: z.number().int().nonnegative().optional().describe('全局采样帧编号；省略时使用动作硬切段首帧'),
      export_end_exclusive: z.number().int().positive().describe('全局采样帧编号，排他；用于明确是否删除与起始帧重复的末帧'),
      output_directory: z.string().min(1),
      action_name: z.string().min(1).optional(),
      end_frame_duplicates_start: z.boolean(),
      ai_confidence: z.number().min(0).max(1).optional(),
      ai_reason: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ report_id, action_index, export_start_frame, export_end_exclusive, output_directory, action_name, end_frame_duplicates_start, ai_confidence, ai_reason }, extra) => {
    const progress = createProgressReporter(extra)
    await progress({ progress: 0, total: 2, message: '验证动作导出边界', force: true })
    const report = await readAnalysisReport(report_id)
    if (report.sourceKind !== 'video') throw new Error('该导出工具当前仅支持视频分析报告')
    const action = report.analysis.actionSegments[action_index]
    if (!action) throw new Error(`动作段 ${action_index} 不存在`)
    const selectedStartFrame = export_start_frame ?? action.startFrame
    if (selectedStartFrame < action.startFrame || selectedStartFrame > action.endFrame) {
      throw new Error(`export_start_frame 必须位于 ${action.startFrame}..${action.endFrame}`)
    }
    if (export_end_exclusive <= selectedStartFrame || export_end_exclusive > action.endFrame + 1) {
      throw new Error(`export_end_exclusive 必须位于 ${selectedStartFrame + 1}..${action.endFrame + 1}`)
    }
    const files = await exportVideoFrames({
      inputPath: report.videoPath,
      outputDirectory: output_directory,
      fps: report.fps,
      startTime: selectedStartFrame / report.fps,
      endTime: export_end_exclusive / report.fps,
    })
    await progress({ progress: 1, total: 2, message: `已导出 ${files.length} 帧`, force: true })
    const manifest = {
      version: 1,
      reportId: report.id,
      sourcePath: report.videoPath,
      fps: report.fps,
      actionIndex: action.index,
      actionName: action_name ?? null,
      sourceSegment: { startFrame: action.startFrame, endFrame: action.endFrame },
      selectedLoop: {
        startFrame: selectedStartFrame,
        exportEndExclusive: export_end_exclusive,
        frameCount: export_end_exclusive - selectedStartFrame,
        endFrameDuplicatesStart: end_frame_duplicates_start,
      },
      aiReview: { confidence: ai_confidence ?? null, reason: ai_reason ?? null },
      exportedFiles: files,
    }
    const manifestPath = join(resolve(output_directory), 'frameloop-action.json')
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    await progress({ progress: 2, total: 2, message: '动作清单已写入', force: true })
    return textResult({ manifestPath, ...manifest })
  },
)

server.registerTool(
  'compose_sprite_sheet',
  {
    title: '合成 Sprite Sheet',
    description: '把本地 PNG/JPEG 序列帧合成为透明 Sprite Sheet，并在旁边生成 JSON 索引。',
    inputSchema: {
      frame_paths: z.array(z.string().min(1)).min(1).max(1000),
      output_path: z.string().min(1).describe('输出 PNG 路径'),
      columns: z.number().int().min(1).max(100).default(8),
      padding: z.number().int().min(0).max(128).default(0),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ frame_paths, output_path, columns, padding }, extra) => {
    const progress = createProgressReporter(extra)
    await progress({ progress: 0, total: 1, message: '开始合成 Sprite Sheet', force: true })
    const result = await createSpriteSheetFile({ framePaths: frame_paths, outputPath: output_path, columns, padding })
    await progress({ progress: 1, total: 1, message: 'Sprite Sheet 已完成', force: true })
    return textResult(result)
  },
)

server.registerTool(
  'create_action_export_plan',
  {
    title: '创建批量动作导出计划',
    description: '验证多个动作的复核边界、名称、目标冲突、预计文件数和磁盘空间；只写临时计划，不写用户输出目录。',
    inputSchema: {
      report_id: z.string().uuid(),
      output_root: z.string().min(1),
      reviews: z.array(actionReviewSchema).min(1).max(100),
      conflict_policy: z.enum(['fail', 'skip', 'replace']).default('fail'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ report_id, output_root, reviews, conflict_policy }) => {
    const report = await readAnalysisReport(report_id)
    const info = await probeVideo(report.videoPath)
    const plan = await createActionExportPlan({
      report,
      outputRoot: output_root,
      conflictPolicy: conflict_policy,
      sourceWidth: info.width,
      sourceHeight: info.height,
      reviews: reviews.map((review) => ({
        actionIndex: review.action_index,
        actionName: review.action_name,
        exportStartFrame: review.export_start_frame,
        exportEndExclusive: review.export_end_exclusive,
        endFrameDuplicatesStart: review.end_frame_duplicates_start,
        aiConfidence: review.ai_confidence,
        aiReason: review.ai_reason,
      })),
    })
    return textResult({ ...plan, nextTool: 'export_action_batch' })
  },
)

server.registerTool(
  'export_action_batch',
  {
    title: '执行批量动作导出',
    description: '执行已验证的动作导出计划，逐动作返回成功、跳过或失败结果。计划必须由 create_action_export_plan 创建。',
    inputSchema: { plan_id: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ plan_id }, extra) => {
    const plan = await readActionExportPlan(plan_id)
    const report = await readAnalysisReport(plan.reportId)
    const progress = createProgressReporter(extra)
    await progress({ progress: 0, total: plan.items.length, message: '开始批量导出动作', force: true })
    const result = await executeActionExportPlan(plan, report, {
      onProgress: (completed, total, message) => progress({
        progress: completed, total, message, force: completed === total,
      }),
    })
    return textResult(result)
  },
)

server.registerTool(
  'export_sprite_bundle',
  {
    title: '导出完整 Sprite Bundle',
    description: '把一个或多个动画合并为 Atlas，并输出 Tight Trim、Pivot、逐帧时长以及 Generic/Aseprite/Godot/Unity 数据。',
    inputSchema: {
      animations: z.array(bundleAnimationSchema).min(1).max(100),
      output_path: z.string().min(1),
      preset: z.enum(['generic', 'aseprite', 'godot', 'unity']).default('generic'),
      trim_mode: z.enum(['grid', 'tight']).default('tight'),
      columns: z.number().int().min(1).max(100).optional(),
      padding: z.number().int().min(0).max(128).default(0),
      alpha_threshold: z.number().int().min(0).max(255).default(1),
      pivot_x: z.number().min(0).max(1).default(0.5),
      pivot_y: z.number().min(0).max(1).default(1),
      pixels_per_unit: z.number().positive().default(100),
      conflict_policy: z.enum(['fail', 'replace']).default('fail'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ animations, output_path, preset, trim_mode, columns, padding, alpha_threshold, pivot_x, pivot_y, pixels_per_unit, conflict_policy }, extra) => {
    const progress = createProgressReporter(extra)
    await progress({ progress: 0, total: 4, message: '准备 Sprite Bundle', force: true })
    const result = await exportSpriteBundle({
      animations: animations.map((animation) => ({
        name: animation.name,
        framePaths: animation.frame_paths,
        durations: animation.durations,
        sourceFrameIds: animation.source_frame_ids,
      })),
      outputPath: output_path,
      preset,
      trimMode: trim_mode,
      columns,
      padding,
      alphaThreshold: alpha_threshold,
      pivot: { x: pivot_x, y: pivot_y },
      pixelsPerUnit: pixels_per_unit,
      conflictPolicy: conflict_policy,
      onProgress: (completed, total, message) => progress({
        progress: completed, total, message, force: completed === total,
      }),
    })
    return textResult({ ...result, nextTool: 'validate_sprite_bundle' })
  },
)

server.registerTool(
  'validate_sprite_bundle',
  {
    title: '验证 Sprite Bundle',
    description: '检查 Atlas 与 Manifest 尺寸、帧坐标、动画范围、配套引擎文件、重复首尾帧、接缝差异和 Alpha 抖动。',
    inputSchema: {
      manifest_path: z.string().min(1),
      duplicate_threshold: z.number().min(0).max(1).default(0.005),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ manifest_path, duplicate_threshold }) => textResult(
    await validateSpriteBundle(manifest_path, duplicate_threshold),
  ),
)

server.registerTool(
  'slice_sprite_sheet',
  {
    title: '切出独立 Sprite PNG',
    description: '执行外部多模态 Agent 已确认的切图方案：支持 Manifest、规则网格、连通区域，以及自定义水平矩形、旋转矩形和多边形；输出最小透明 PNG 与可审计清单。建议先调用 inspect_sprite_sheet_layout。',
    inputSchema: {
      manifest_path: z.string().min(1).optional().describe('FrameLoop Sprite Manifest 路径；与 atlas_path 二选一'),
      atlas_path: z.string().min(1).optional().describe('独立图集路径；与 manifest_path 二选一'),
      output_directory: z.string().min(1).optional().describe('默认输出到 Atlas 同目录下的 <名称>-sprites 文件夹'),
      columns: z.number().int().min(1).max(1000).optional().describe('无 Manifest 时的网格列数'),
      rows: z.number().int().min(1).max(1000).optional().describe('无 Manifest 时的网格行数'),
      padding: z.number().int().min(0).max(4096).default(0).describe('无 Manifest 时相邻网格间距'),
      frame_count: z.number().int().min(1).optional().describe('无 Manifest 时实际帧数；默认使用全部网格'),
      mode: z.enum(['grid', 'components', 'regions']).optional().describe('无 Manifest 时的执行模式；不传时根据 regions 或网格参数推断'),
      bounds: z.enum(['axis_aligned', 'oriented', 'polygon']).default('axis_aligned'),
      regions: z.array(spriteRegionSchema).min(1).max(2000).optional().describe('regions 模式下由多模态 AI 确认的区域'),
      background_mode: z.enum(['auto', 'alpha', 'edge-color']).default('auto'),
      background_tolerance: z.number().min(0).max(441).default(36),
      min_area: z.number().int().min(1).optional(),
      merge_gap: z.number().min(0).max(4096).default(0),
      remove_background: z.boolean().default(true),
      alpha_threshold: z.number().int().min(0).max(255).optional().describe('默认沿用 Manifest 的透明度阈值'),
      conflict_policy: z.enum(['fail', 'replace']).default('fail'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ manifest_path, atlas_path, output_directory, columns, rows, padding, frame_count, mode, bounds, regions, background_mode, background_tolerance, min_area, merge_gap, remove_background, alpha_threshold, conflict_policy }, extra) => {
    const progress = createProgressReporter(extra)
    await progress({ progress: 0, total: 1, message: '准备切分 Sprite Sheet', force: true })
    const result = await sliceSpriteSheet({
      manifestPath: manifest_path,
      atlasPath: atlas_path,
      outputDirectory: output_directory,
      columns,
      rows,
      padding,
      frameCount: frame_count,
      mode,
      boundsMode: bounds,
      regions: regions?.map((region) => region.type === 'rotated_rect'
        ? { ...region, angleDegrees: region.angle_degrees }
        : region.type === 'polygon'
          ? { ...region, angleDegrees: region.angle_degrees }
          : region),
      backgroundMode: background_mode,
      backgroundTolerance: background_tolerance,
      minArea: min_area,
      mergeGap: merge_gap,
      removeBackground: remove_background,
      alphaThreshold: alpha_threshold,
      conflictPolicy: conflict_policy,
      onProgress: (completed, total, message) => progress({
        progress: completed,
        total,
        message,
        force: completed === total,
      }),
    })
    return textResult(result)
  },
)

server.registerTool(
  'apply_chroma_key_batch',
  {
    title: '批量色度键抠图',
    description: '对图片序列执行任意背景色色度键、三帧 Alpha 时序稳定和边缘去色溢出，输出透明 PNG。',
    inputSchema: {
      frame_paths: z.array(z.string().min(1)).min(1).max(2000),
      output_directory: z.string().min(1),
      key_color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#00ff00'),
      tolerance: z.number().min(0).max(441).default(72),
      feather: z.number().min(1).max(441).default(28),
      temporal_consistency: z.number().min(0).max(1).default(0.7),
      despill_strength: z.number().min(0).max(1).default(1),
      conflict_policy: z.enum(['fail', 'replace']).default('fail'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ frame_paths, output_directory, key_color, tolerance, feather, temporal_consistency, despill_strength, conflict_policy }, extra) => {
    const progress = createProgressReporter(extra)
    await progress({ progress: 0, total: frame_paths.length, message: '开始批量色度键', force: true })
    return textResult(await applyChromaKeyBatch({
      framePaths: frame_paths,
      outputDirectory: output_directory,
      keyColor: key_color,
      tolerance,
      feather,
      temporalConsistency: temporal_consistency,
      despillStrength: despill_strength,
      conflictPolicy: conflict_policy,
      onProgress: (completed, total, message) => progress({
        progress: completed, total, message, force: completed === total,
      }),
    }))
  },
)

server.registerTool(
  'apply_ai_matte_batch',
  {
    title: '批量本地 AI 抠图',
    description: '在 MCP 进程本地使用 Transformers.js 背景移除模型批量生成透明 PNG；首次调用会下载模型。',
    inputSchema: {
      frame_paths: z.array(z.string().min(1)).min(1).max(1000),
      output_directory: z.string().min(1),
      model: z.string().min(1).default('onnx-community/BEN2-ONNX'),
      conflict_policy: z.enum(['fail', 'replace']).default('fail'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ frame_paths, output_directory, model, conflict_policy }, extra) => {
    const progress = createProgressReporter(extra)
    const total = 100 + frame_paths.length
    await progress({ progress: 0, total, message: '准备加载 AI 抠图模型', force: true })
    return textResult(await applyAiMatteBatch({
      framePaths: frame_paths,
      outputDirectory: output_directory,
      model,
      conflictPolicy: conflict_policy,
      onModelProgress: (message, ratio) => ratio === undefined
        ? undefined
        : progress({ progress: Math.min(100, Math.max(0.01, ratio * 100)), total, message }),
      onProgress: (completed, frameTotal, message) => progress({
        progress: 100 + completed,
        total,
        message,
        force: completed === frameTotal,
      }),
    }))
  },
)

server.registerTool(
  'analyze_matte_quality',
  {
    title: '诊断蒙版质量',
    description: '逐帧检查透明 PNG，定位疑似背景残点、主体孔洞和半透明边缘，并返回面积、边界框和中心坐标。只读，不修改文件。',
    inputSchema: {
      matte_paths: z.array(z.string().min(1)).min(1).max(1000).describe('待诊断的透明 PNG 路径，顺序即帧序号'),
      alpha_threshold: z.number().int().min(1).max(255).default(128).describe('区分前景与背景的透明度阈值'),
      detached_area_threshold: z.number().int().min(0).max(1000000).default(64).describe('不超过此面积的非主体连通块视为疑似背景残点'),
      hole_area_threshold: z.number().int().min(0).max(1000000).default(64).describe('不超过此面积的封闭透明区视为疑似主体孔洞'),
      max_regions_per_frame: z.number().int().min(1).max(100).default(20).describe('每帧每类最多返回的可疑区域数'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ matte_paths, alpha_threshold, detached_area_threshold, hole_area_threshold, max_regions_per_frame }, extra) => {
    const progress = createProgressReporter(extra)
    await progress({ progress: 0, total: matte_paths.length, message: '开始诊断蒙版质量', force: true })
    return textResult(await analyzeMatteQuality({
      mattePaths: matte_paths,
      alphaThreshold: alpha_threshold,
      detachedAreaThreshold: detached_area_threshold,
      holeAreaThreshold: hole_area_threshold,
      maxRegionsPerFrame: max_regions_per_frame,
      onProgress: (completed, total, message) => progress({
        progress: completed, total, message, force: completed === total,
      }),
    }))
  },
)

server.registerTool(
  'refine_matte_batch',
  {
    title: '批量精修蒙版',
    description: '按 AI 给出的逐帧笔画精确移除或恢复像素，也可按面积自动清理孤立残点和填补孔洞；输出新 PNG 和可审计清单，不覆盖输入文件。',
    inputSchema: {
      source_frame_paths: z.array(z.string().min(1)).min(1).max(1000).describe('未抠图源帧，用于恢复被误删的主体像素'),
      matte_paths: z.array(z.string().min(1)).min(1).max(1000).describe('待精修的透明 PNG，与源帧一一对应'),
      output_directory: z.string().min(1).describe('精修结果输出目录'),
      corrections: z.array(matteCorrectionSchema).max(10000).default([]).describe('AI 指定的逐帧移除或恢复笔画'),
      alpha_threshold: z.number().int().min(1).max(255).default(128).describe('自动清理时区分前景与背景的透明度阈值'),
      remove_islands_below: z.number().int().min(0).max(1000000).default(0).describe('自动移除不超过此面积的孤立前景；0 表示关闭'),
      fill_holes_below: z.number().int().min(0).max(1000000).default(0).describe('自动填补不超过此面积的主体孔洞；0 表示关闭'),
      conflict_policy: z.enum(['fail', 'replace']).default('fail').describe('目标已存在时失败，或替换旧结果'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ source_frame_paths, matte_paths, output_directory, corrections, alpha_threshold, remove_islands_below, fill_holes_below, conflict_policy }, extra) => {
    const progress = createProgressReporter(extra)
    await progress({ progress: 0, total: matte_paths.length, message: '开始批量精修蒙版', force: true })
    const result = await refineMatteBatch({
      sourceFramePaths: source_frame_paths,
      mattePaths: matte_paths,
      outputDirectory: output_directory,
      corrections: corrections.map((correction) => ({
        frameIndex: correction.frame_index,
        mode: correction.mode,
        diameterPixels: correction.diameter_pixels,
        coordinateSpace: correction.coordinate_space,
        points: correction.points,
      })),
      alphaThreshold: alpha_threshold,
      removeIslandsBelow: remove_islands_below,
      fillHolesBelow: fill_holes_below,
      conflictPolicy: conflict_policy,
      onProgress: (completed, total, message) => progress({
        progress: completed, total, message, force: completed === total,
      }),
    })
    return textResult({ ...result, nextTool: 'analyze_matte_quality' })
  },
)

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
