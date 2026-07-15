#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { pageAnalysisReport, readAnalysisReport, writeAnalysisReport } from './reports.js'
import { analyzeAnchoredActionSegments, analyzeFeatureStream } from './streaming.js'
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

const server = new McpServer(
  { name: 'frameloop-mcp', version: '0.1.0' },
  {
    instructions: '先用 inspect_video 获取媒体信息，再用 analyze_video_loop 自动检测多段动作并生成段首闭环与段内周期核心候选。随后调用 review_video_action_segments，让多模态 AI 根据动作概览和六帧接缝选择最早完整闭环；写出帧前应向用户说明目标路径、export_start_frame 与 export_end_exclusive 并确认，再调用 export_reviewed_action。所有路径均为运行 MCP 进程所在机器的本地绝对或相对路径。',
  },
)

const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
})

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
    })
    const actionSegments = await analyzeAnchoredActionSegments(
      streamAnalysisFeatures(path, fps, { signal: extra.signal }),
      analysis.sceneCuts.map((cut) => cut.frame),
      {
        minFrames,
        maxFrames: maxFrames ?? windowFrames,
        topKPerSegment: Math.min(top_k, 5),
        motionWindow: 3,
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
    })
    const actionSegments = await analyzeAnchoredActionSegments(
      streamImageFeatures(frame_paths, fps, { signal: extra.signal }),
      analysis.sceneCuts.map((cut) => cut.frame),
      {
        minFrames: min_loop_frames,
        maxFrames: max_loop_frames ?? windowFrames,
        topKPerSegment: Math.min(top_k, 5),
        motionWindow: 3,
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
  async ({ path, output_directory, fps, start_time, end_time }) => textResult({
    files: await exportVideoFrames({ inputPath: path, outputDirectory: output_directory, fps, startTime: start_time, endTime: end_time }),
  }),
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
  async ({ report_id, action_index, export_start_frame, export_end_exclusive, output_directory, action_name, end_frame_duplicates_start, ai_confidence, ai_reason }) => {
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
  async ({ frame_paths, output_path, columns, padding }) => textResult(
    await createSpriteSheetFile({ framePaths: frame_paths, outputPath: output_path, columns, padding }),
  ),
)

const transport = new StdioServerTransport()
await server.connect(transport)
