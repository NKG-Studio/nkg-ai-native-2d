#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { analyzeSequence, detectLoopCandidates } from '@frameloop/core'
import { z } from 'zod'
import {
  createSpriteSheetFile,
  exportVideoFrames,
  extractAnalysisFeatures,
  extractImageFeatures,
  probeVideo,
  renderImageLoopContactSheet,
  renderLoopContactSheet,
} from './video.js'

const server = new McpServer(
  { name: 'frameloop-mcp', version: '0.1.0' },
  {
    instructions: '先用 inspect_video 获取媒体信息，再用 analyze_video_loop 生成候选循环。循环候选是视觉启发式结果；写出帧或 Sprite Sheet 前应向用户说明目标路径并确认所选区间。所有路径均为运行 MCP 进程所在机器的本地绝对或相对路径。',
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
    description: '按指定 FPS 采样本地视频，通过视觉闭合、运动连续性和静止惩罚给出 Top K 循环候选。不会写文件。',
    inputSchema: {
      path: z.string().min(1).describe('本地视频路径'),
      fps: z.number().min(1).max(30).default(12),
      min_loop_seconds: z.number().min(0.1).default(0.5),
      max_loop_seconds: z.number().min(0.2).optional(),
      max_frames: z.number().int().min(12).max(600).default(240),
      top_k: z.number().int().min(1).max(12).default(5),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ path, fps, min_loop_seconds, max_loop_seconds, max_frames, top_k }) => {
    const info = await probeVideo(path)
    const features = await extractAnalysisFeatures(path, fps, max_frames)
    const candidates = detectLoopCandidates(features, {
      minFrames: Math.max(2, Math.round(min_loop_seconds * fps)),
      maxFrames: max_loop_seconds ? Math.max(2, Math.round(max_loop_seconds * fps)) : features.length,
      topK: top_k,
      motionWindow: 3,
    })
    const sequence = analyzeSequence(features, {
      minFrames: Math.max(2, Math.round(min_loop_seconds * fps)),
      maxFrames: max_loop_seconds ? Math.max(2, Math.round(max_loop_seconds * fps)) : features.length,
    })
    const result = {
      video: info,
      sampling: { fps, sampledFrames: features.length },
      candidates: candidates.map((candidate) => ({
        ...candidate,
        suggestedEndExclusive: Math.min(info.duration, (candidate.endFrame + 1) / fps),
      })),
      sequence: {
        dominantPeriods: sequence.dominantPeriods,
        duplicateGroups: sequence.duplicateGroups,
        sceneCuts: sequence.transitions.filter((transition) => transition.isSceneCut),
        transitions: sequence.transitions,
      },
      note: 'confidence 是启发式相对置信度。建议由多模态模型查看候选首尾帧或在网页循环预览中复核。',
    }
    const contactSheet = await renderLoopContactSheet(path, candidates, fps)
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        { type: 'image' as const, data: contactSheet.toString('base64'), mimeType: 'image/png' },
      ],
    }
  },
)

server.registerTool(
  'analyze_sprite_sequence',
  {
    title: '分析现有序列帧',
    description: '分析已有 PNG/JPEG/WebP 序列的循环候选、主周期、重复帧和镜头切换，并返回候选首尾帧对比图。不会写文件。',
    inputSchema: {
      frame_paths: z.array(z.string().min(1)).min(3).max(1000).describe('按播放顺序排列的本地图片路径'),
      fps: z.number().min(1).max(60).default(12),
      min_loop_frames: z.number().int().min(2).default(6),
      max_loop_frames: z.number().int().min(3).optional(),
      top_k: z.number().int().min(1).max(12).default(5),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ frame_paths, fps, min_loop_frames, max_loop_frames, top_k }) => {
    const features = await extractImageFeatures(frame_paths, fps)
    const options = {
      minFrames: Math.min(min_loop_frames, features.length),
      maxFrames: Math.min(max_loop_frames ?? features.length, features.length),
      topK: top_k,
      motionWindow: 3,
    }
    const candidates = detectLoopCandidates(features, options)
    const sequence = analyzeSequence(features, options)
    const contactSheet = await renderImageLoopContactSheet(frame_paths, candidates)
    const result = {
      frameCount: features.length,
      fps,
      candidates,
      sequence: {
        dominantPeriods: sequence.dominantPeriods,
        duplicateGroups: sequence.duplicateGroups,
        sceneCuts: sequence.transitions.filter((transition) => transition.isSceneCut),
        transitions: sequence.transitions,
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
      fps: z.number().min(1).max(60).default(12),
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
