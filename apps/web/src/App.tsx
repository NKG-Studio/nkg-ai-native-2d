import { useEffect, useMemo, useReducer, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import {
  analyzeSequence,
  detectLoopCandidates,
  type LoopCandidate,
  type SequenceDiagnostics,
} from '@frameloop/core'
import {
  applyTemporalChromaKey,
  applyTemporalChromaKeyFrame,
  captureVideoFrames,
  createDemoFrames,
  measureAlphaFlicker,
  type AlphaFlickerDiagnostics,
} from './media'
import {
  composeSpriteSheet,
  downloadDataUrl,
  downloadJson,
  downloadText,
  type SpriteSheetManifest,
  type TrimMode,
} from './sprite'
import {
  createAsepriteManifest,
  createGodotSpriteFrames,
  createUnityManifest,
  type ExportPreset,
} from './exporters'
import { createFrameEditorState, frameEditorReducer, visibleFrameIds } from './editor'
import {
  applyMaskStrokes,
  createMaskEditorState,
  maskEditorReducer,
  pointInContainedImage,
  type MaskBrushMode,
  type MaskPoint,
  type MaskStroke,
} from './mask'
import {
  BrowserMatteEngine,
  createTransformersMattePipeline,
  DEFAULT_MATTE_MODEL,
  DEFAULT_MATTE_MODEL_LICENSE,
  type MatteBackend,
  type MatteLoadProgress,
} from './segmentation'
import {
  canvasToPngBlob,
  deleteLatestProject,
  loadLatestProject,
  pngBlobToCanvas,
  PROJECT_SCHEMA_VERSION,
  saveLatestProject,
  type ProjectSnapshot,
} from './project'
import type { CapturedFrame, ExtractionProgress } from './types'
import { isSupportedVideoFile } from './upload'

type Stage = 'source' | 'loop' | 'matte' | 'export'
type MatteMode = 'original' | 'chroma' | 'ai'
type ActiveMaskStroke = MaskStroke & { pointerId: number; frameId: number }

interface AiMatteJob {
  phase: 'idle' | 'loading' | 'segmenting' | 'ready' | 'cancelled' | 'error'
  current: number
  total: number
  percent: number
  message: string
}

const formatTime = (seconds: number) => `${seconds.toFixed(2)}s`
const percent = (value: number) => `${Math.round(value * 100)}%`
const safeFilename = (value: string) => value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-') || 'animation'

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [sourceKind, setSourceKind] = useState<'empty' | 'video' | 'demo'>('empty')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [fps, setFps] = useState(12)
  const [analysisWindowSeconds, setAnalysisWindowSeconds] = useState(20)
  const [minLoopFrames, setMinLoopFrames] = useState(8)
  const [frames, setFrames] = useState<CapturedFrame[]>([])
  const [editorState, dispatchEditor] = useReducer(frameEditorReducer, undefined, () => createFrameEditorState())
  const [maskState, dispatchMask] = useReducer(maskEditorReducer, undefined, createMaskEditorState)
  const [compareSlots, setCompareSlots] = useState<[number, number]>([0, 1])
  const [timelineZoom, setTimelineZoom] = useState(1)
  const [startFrame, setStartFrame] = useState(0)
  const [endFrame, setEndFrame] = useState(0)
  const [extracting, setExtracting] = useState(false)
  const [progress, setProgress] = useState<ExtractionProgress>({ current: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('source')
  const [playing, setPlaying] = useState(true)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [matteMode, setMatteMode] = useState<MatteMode>('original')
  const [keyColor, setKeyColor] = useState('#00ff00')
  const [tolerance, setTolerance] = useState(72)
  const [feather, setFeather] = useState(28)
  const [temporalConsistency, setTemporalConsistency] = useState(0.7)
  const [alphaDiagnostics, setAlphaDiagnostics] = useState<AlphaFlickerDiagnostics | null>(null)
  const [maskEditing, setMaskEditing] = useState(false)
  const [brushMode, setBrushMode] = useState<MaskBrushMode>('remove')
  const [brushSize, setBrushSize] = useState(24)
  const [activeMaskStroke, setActiveMaskStroke] = useState<ActiveMaskStroke | null>(null)
  const [autoMattes, setAutoMattes] = useState<Record<number, HTMLCanvasElement>>({})
  const [matteBackend, setMatteBackend] = useState<MatteBackend | null>(null)
  const [aiMatteJob, setAiMatteJob] = useState<AiMatteJob>({
    phase: 'idle', current: 0, total: 0, percent: 0, message: '模型尚未加载',
  })
  const [columns, setColumns] = useState(8)
  const [padding, setPadding] = useState(0)
  const [trimMode, setTrimMode] = useState<TrimMode>('grid')
  const [alphaThreshold, setAlphaThreshold] = useState(1)
  const [pivotX, setPivotX] = useState(0.5)
  const [pivotY, setPivotY] = useState(1)
  const [animationName, setAnimationName] = useState('idle')
  const [defaultFrameDuration, setDefaultFrameDuration] = useState(83)
  const [durationOverrides, setDurationOverrides] = useState<Record<number, number>>({})
  const [exportPreset, setExportPreset] = useState<ExportPreset>('generic')
  const [pixelsPerUnit, setPixelsPerUnit] = useState(100)
  const [exportPreview, setExportPreview] = useState<string | null>(null)
  const [exportManifest, setExportManifest] = useState<SpriteSheetManifest | null>(null)
  const [savedProjectAvailable, setSavedProjectAvailable] = useState(false)
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectMessage, setProjectMessage] = useState<string | null>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const activeMaskStrokeRef = useRef<ActiveMaskStroke | null>(null)
  const matteEngineRef = useRef<BrowserMatteEngine | null>(null)
  const cancelMattingRef = useRef(false)
  const captureAbortRef = useRef<AbortController | null>(null)
  const pendingProjectRangeRef = useRef<{ startFrame: number; endFrame: number } | null>(null)
  const dragDepthRef = useRef(0)

  useEffect(() => {
    if (!file) {
      setVideoUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setVideoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    void loadLatestProject()
      .then((project) => setSavedProjectAvailable(Boolean(project)))
      .catch(() => setSavedProjectAvailable(false))
  }, [])

  const frameById = useMemo(
    () => new Map(frames.map((frame) => [frame.index, frame])),
    [frames],
  )
  const editedFrames = useMemo(
    () => visibleFrameIds(editorState.present)
      .map((frameId) => frameById.get(frameId))
      .filter((frame): frame is CapturedFrame => Boolean(frame)),
    [editorState.present.order, editorState.present.hidden, frameById],
  )
  const analysisFeatures = useMemo(
    () => editedFrames.map((frame, index) => ({
      ...frame.feature,
      index,
      timestamp: index / Math.max(1, fps),
    })),
    [editedFrames, fps],
  )
  const candidates = useMemo(
    () => detectLoopCandidates(analysisFeatures, {
      minFrames: Math.min(minLoopFrames, analysisFeatures.length),
      topK: 6,
      motionWindow: 3,
    }),
    [analysisFeatures, minLoopFrames],
  )
  const selectedFrames = useMemo(
    () => editedFrames.slice(startFrame, endFrame + 1),
    [editedFrames, startFrame, endFrame],
  )
  const sequenceDiagnostics = useMemo(
    () => analyzeSequence(analysisFeatures, {
      minFrames: Math.min(minLoopFrames, analysisFeatures.length),
    }),
    [analysisFeatures, minLoopFrames],
  )
  const editorSelected = useMemo(() => new Set(editorState.present.selected), [editorState.present.selected])
  const previewFrame = selectedFrames[previewIndex]
  const currentMaskStrokes = previewFrame ? (maskState.present[previewFrame.index] ?? []) : []
  const selectedAutoMatteCount = selectedFrames.reduce(
    (count, frame) => count + (autoMattes[frame.index] ? 1 : 0),
    0,
  )
  const mattingBusy = aiMatteJob.phase === 'loading' || aiMatteJob.phase === 'segmenting'

  useEffect(() => {
    if (editedFrames.length === 0) return
    const restoredRange = pendingProjectRangeRef.current
    if (restoredRange) {
      setStartFrame(Math.min(restoredRange.startFrame, Math.max(0, editedFrames.length - 2)))
      setEndFrame(Math.min(Math.max(restoredRange.startFrame + 1, restoredRange.endFrame), editedFrames.length - 1))
      pendingProjectRangeRef.current = null
      setCompareSlots([0, Math.min(1, Math.max(0, candidates.length - 1))])
      setPreviewIndex(0)
      setExportPreview(null)
      setExportManifest(null)
      return
    }
    const best = candidates[0]
    setStartFrame(best?.startFrame ?? 0)
    setEndFrame(best?.endFrame ?? Math.max(0, editedFrames.length - 1))
    setCompareSlots([0, Math.min(1, Math.max(0, candidates.length - 1))])
    setPreviewIndex(0)
    setExportPreview(null)
    setExportManifest(null)
  }, [editedFrames, candidates])

  useEffect(() => {
    if (!playing || selectedFrames.length === 0) return
    const timer = window.setInterval(() => {
      setPreviewIndex((current) => (current + 1) % selectedFrames.length)
    }, 1000 / Math.max(1, fps))
    return () => window.clearInterval(timer)
  }, [playing, selectedFrames.length, fps])

  useEffect(() => {
    const source = previewFrame?.canvas
    const target = previewCanvasRef.current
    if (!source || !target) return
    target.width = source.width
    target.height = source.height
    const context = target.getContext('2d')!
    context.clearRect(0, 0, target.width, target.height)
    const aiMatte = autoMattes[previewFrame.index]
    const base = matteMode === 'chroma'
      ? applyTemporalChromaKeyFrame(
        source,
        selectedFrames[previewIndex - 1]?.canvas,
        selectedFrames[previewIndex + 1]?.canvas,
        keyColor,
        tolerance,
        feather,
        temporalConsistency,
      )
      : matteMode === 'ai' && aiMatte ? aiMatte : source
    const liveStroke = activeMaskStroke?.frameId === previewFrame.index ? activeMaskStroke : null
    const strokes = liveStroke ? [...currentMaskStrokes, liveStroke] : currentMaskStrokes
    context.drawImage(strokes.length ? applyMaskStrokes(base, source, strokes) : base, 0, 0)
  }, [selectedFrames, previewIndex, previewFrame, currentMaskStrokes, activeMaskStroke, matteMode, autoMattes, keyColor, tolerance, feather, temporalConsistency])

  useEffect(() => () => {
    void matteEngineRef.current?.dispose()
  }, [])

  useEffect(() => {
    setAlphaDiagnostics(null)
  }, [selectedFrames, keyColor, tolerance, feather, temporalConsistency])

  useEffect(() => {
    if (stage !== 'loop') return
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      const command = event.ctrlKey || event.metaKey
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        dispatchEditor({ type: event.shiftKey ? 'redo' : 'undo' })
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        dispatchEditor({ type: 'hide_selected' })
      } else if (event.key === 'Escape') {
        dispatchEditor({ type: 'clear_selection' })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [stage])

  const pickFile = (nextFile: File | null) => {
    captureAbortRef.current?.abort()
    setFile(nextFile)
    setSourceKind(nextFile ? 'video' : 'empty')
    setFrames([])
    dispatchEditor({ type: 'reset', frameIds: [] })
    dispatchMask({ type: 'reset' })
    setAutoMattes({})
    setMatteMode('original')
    setCompareSlots([0, 1])
    setStartFrame(0)
    setEndFrame(0)
    setExportPreview(null)
    setExportManifest(null)
    setAlphaDiagnostics(null)
    setError(null)
    setStage('source')
  }

  const acceptVideoFile = (nextFile: File | null) => {
    if (!nextFile) return
    if (!isSupportedVideoFile(nextFile)) {
      setError('仅支持 MP4、MOV 或 WEBM 视频文件')
      return
    }
    pickFile(nextFile)
  }

  const handleDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current += 1
    if (event.dataTransfer.types.includes('Files')) setDragActive(true)
  }

  const handleDragOver = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDragActive(false)
    acceptVideoFile(event.dataTransfer.files?.[0] ?? null)
  }

  const extract = async () => {
    if (!file) return
    setExtracting(true)
    setError(null)
    setProgress({ current: 0, total: 1 })
    const controller = new AbortController()
    captureAbortRef.current = controller
    try {
      const result = await captureVideoFrames(file, fps, minLoopFrames, analysisWindowSeconds, setProgress, controller.signal)
      acceptFrames(result.frames)
      setProjectMessage(`已流式扫描完整视频 · ${result.scan.sampledFrames} 个采样帧 · ${result.scan.windowsAnalyzed} 个窗口 · 仅载入最佳候选 ${result.frames.length} 帧`)
    } catch (cause) {
      if (controller.signal.aborted) setProjectMessage('已取消视频流式分析')
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (captureAbortRef.current === controller) captureAbortRef.current = null
      setExtracting(false)
    }
  }

  const acceptFrames = (nextFrames: CapturedFrame[]) => {
    setFrames(nextFrames)
    dispatchEditor({ type: 'reset', frameIds: nextFrames.map((frame) => frame.index) })
    dispatchMask({ type: 'reset' })
    setAutoMattes({})
    setMatteMode('original')
    setPreviewIndex(0)
    setStage('loop')
  }

  const loadDemo = () => {
    setFile(null)
    setSourceKind('demo')
    setError(null)
    setFps(12)
    setMinLoopFrames(6)
    acceptFrames(createDemoFrames(12, 8, 3))
  }

  const useCandidate = (candidate: LoopCandidate) => {
    setStartFrame(candidate.startFrame)
    setEndFrame(candidate.endFrame)
    setPreviewIndex(0)
  }

  const assignCompareSlot = (slot: 0 | 1, candidateIndex: number) => {
    setCompareSlots((current) => slot === 0
      ? [candidateIndex, current[1]]
      : [current[0], candidateIndex])
  }

  const renderExport = () => {
    const sources = selectedFrames.map((frame) => frame.canvas)
    const baseCanvases = matteMode === 'chroma'
      ? applyTemporalChromaKey(sources, keyColor, tolerance, feather, temporalConsistency)
      : sources.map((source, index) => {
        const frame = selectedFrames[index]
        return matteMode === 'ai' && frame ? (autoMattes[frame.index] ?? source) : source
      })
    const canvases = baseCanvases.map((canvas, index) => {
      const frame = selectedFrames[index]
      const source = sources[index]
      if (!frame || !source) return canvas
      const strokes = maskState.present[frame.index] ?? []
      return strokes.length ? applyMaskStrokes(canvas, source, strokes) : canvas
    })
    const basename = safeFilename(animationName)
    const result = composeSpriteSheet(canvases, {
      columns,
      padding,
      trimMode,
      alphaThreshold,
      pivot: { x: pivotX, y: pivotY },
      animationName,
      durations: selectedFrames.map((frame) => durationOverrides[frame.index] ?? defaultFrameDuration),
      sourceFrameIds: selectedFrames.map((frame) => frame.index),
      imageName: `${basename}.png`,
    })
    const dataUrl = result.canvas.toDataURL('image/png')
    setExportPreview(dataUrl)
    setExportManifest(result.manifest)
    return { ...result, dataUrl }
  }

  const analyzeMatteStability = () => {
    setAlphaDiagnostics(measureAlphaFlicker(
      selectedFrames.map((frame) => frame.canvas),
      keyColor,
      tolerance,
      feather,
      temporalConsistency,
    ))
  }

  const downloadSprite = () => {
    try {
      const result = renderExport()
      const basename = safeFilename(animationName)
      const genericManifest = {
        ...result.manifest,
        fps,
        loop: {
          sourceStartFrame: startFrame,
          sourceEndFrame: endFrame,
          frameCount: selectedFrames.length,
          sourceFrameOrder: selectedFrames.map((frame) => frame.index),
          hiddenSourceFrames: editorState.present.hidden,
          manualMaskCorrections: selectedFrames.reduce(
            (count, frame) => count + (maskState.present[frame.index]?.length ?? 0),
            0,
          ),
          matting: {
            mode: matteMode,
            model: matteMode === 'ai' ? DEFAULT_MATTE_MODEL : null,
            backend: matteMode === 'ai' ? matteBackend : null,
            automaticFrames: selectedFrames.filter((frame) => autoMattes[frame.index]).map((frame) => frame.index),
          },
        },
      }
      downloadDataUrl(result.dataUrl, `${basename}.png`)
      if (exportPreset === 'aseprite') {
        downloadJson(createAsepriteManifest(result.manifest), `${basename}.aseprite.json`)
      } else if (exportPreset === 'godot') {
        downloadText(createGodotSpriteFrames(result.manifest), `${basename}.tres`)
        downloadJson(genericManifest, `${basename}.json`)
      } else if (exportPreset === 'unity') {
        downloadJson(createUnityManifest(result.manifest, pixelsPerUnit), `${basename}.unity.json`)
      } else {
        downloadJson(genericManifest, `${basename}.json`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const activeCandidate = candidates.find((candidate) =>
    candidate.startFrame === startFrame && candidate.endFrame === endFrame)

  const maskPointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>): MaskPoint | null => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return pointInContainedImage(
      bounds,
      event.currentTarget.width,
      event.currentTarget.height,
      event.clientX,
      event.clientY,
    )
  }

  const beginMaskStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!maskEditing || !previewFrame) return
    const point = maskPointFromEvent(event)
    if (!point) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setPlaying(false)
    const stroke: ActiveMaskStroke = {
      pointerId: event.pointerId,
      frameId: previewFrame.index,
      mode: brushMode,
      size: brushSize,
      points: [point],
    }
    activeMaskStrokeRef.current = stroke
    setActiveMaskStroke(stroke)
  }

  const extendMaskStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = activeMaskStrokeRef.current
    if (!current || current.pointerId !== event.pointerId) return
    const point = maskPointFromEvent(event)
    if (!point) return
    event.preventDefault()
    const next = { ...current, points: [...current.points, point] }
    activeMaskStrokeRef.current = next
    setActiveMaskStroke(next)
  }

  const finishMaskStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = activeMaskStrokeRef.current
    if (!current || current.pointerId !== event.pointerId) return
    event.preventDefault()
    dispatchMask({ type: 'commit', frameId: current.frameId, stroke: current })
    activeMaskStrokeRef.current = null
    setActiveMaskStroke(null)
  }

  const copyMaskToNeighbors = () => {
    if (!previewFrame) return
    const targets = [selectedFrames[previewIndex - 1], selectedFrames[previewIndex + 1]]
      .filter((frame): frame is CapturedFrame => Boolean(frame))
      .map((frame) => frame.index)
    dispatchMask({ type: 'copy_to', sourceFrameId: previewFrame.index, targetFrameIds: targets })
  }

  const modelProgress = (progress: MatteLoadProgress) => {
    const ratio = typeof progress.progress === 'number'
      ? (progress.progress > 1 ? progress.progress / 100 : progress.progress)
      : progress.total && typeof progress.loaded === 'number' ? progress.loaded / progress.total : 0
    setAiMatteJob((current) => ({
      ...current,
      phase: 'loading',
      percent: Math.max(current.percent, Math.min(1, ratio)),
      message: progress.file ? `加载 ${progress.file}` : '正在加载本地推理模型',
    }))
  }

  const ensureMatteEngine = async () => {
    if (matteEngineRef.current) return matteEngineRef.current
    setAiMatteJob({ phase: 'loading', current: 0, total: 0, percent: 0, message: '正在选择 WebGPU / WASM 后端' })
    const engine = await BrowserMatteEngine.create({
      factory: createTransformersMattePipeline,
      preferWebGpu: true,
      onProgress: modelProgress,
      onBackendChange: setMatteBackend,
    })
    matteEngineRef.current = engine
    return engine
  }

  const runAutomaticMatting = async (targets: CapturedFrame[]) => {
    if (targets.length === 0 || mattingBusy) return
    setError(null)
    setPlaying(false)
    cancelMattingRef.current = false
    try {
      const engine = await ensureMatteEngine()
      for (let index = 0; index < targets.length; index += 1) {
        if (cancelMattingRef.current) {
          setAiMatteJob({
            phase: 'cancelled', current: index, total: targets.length,
            percent: index / targets.length, message: '已取消剩余帧',
          })
          return
        }
        const frame = targets[index]!
        setAiMatteJob({
          phase: 'segmenting', current: index, total: targets.length,
          percent: index / targets.length, message: `正在处理源帧 ${frame.index + 1}`,
        })
        const matte = await engine.segment(frame.canvas)
        setAutoMattes((current) => ({ ...current, [frame.index]: matte }))
        setAiMatteJob({
          phase: 'segmenting', current: index + 1, total: targets.length,
          percent: (index + 1) / targets.length, message: `已完成 ${index + 1} / ${targets.length} 帧`,
        })
      }
      setMatteMode('ai')
      setAiMatteJob({
        phase: 'ready', current: targets.length, total: targets.length, percent: 1,
        message: `已用 ${engine.backend.toUpperCase()} 完成 ${targets.length} 帧`,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setAiMatteJob({ phase: 'error', current: 0, total: targets.length, percent: 0, message })
      setError(`自动抠图失败：${message}`)
    }
  }

  const clearAutomaticMattes = () => {
    setAutoMattes({})
    if (matteMode === 'ai') setMatteMode('original')
    setAiMatteJob({
      phase: 'idle', current: 0, total: 0, percent: 0,
      message: '自动蒙版已清空，模型仍保留在浏览器缓存中',
    })
  }

  const saveProject = async () => {
    if (frames.length === 0 || sourceKind === 'empty' || projectBusy) return
    if (sourceKind === 'video' && !file) {
      setError('无法保存项目：源视频文件已不可用')
      return
    }
    setProjectBusy(true)
    setProjectMessage('正在编码自动蒙版并保存项目…')
    setError(null)
    try {
      const automaticMattes = await Promise.all(Object.entries(autoMattes).map(async ([frameId, canvas]) => ({
        frameId: Number(frameId),
        png: await canvasToPngBlob(canvas),
      })))
      const source: ProjectSnapshot['source'] = sourceKind === 'demo'
        ? { kind: 'demo', period: 8, repeats: 3 }
        : {
          kind: 'video', name: file!.name, type: file!.type,
          lastModified: file!.lastModified, blob: file!,
        }
      const snapshot: ProjectSnapshot = {
        schemaVersion: PROJECT_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        source,
        capture: { fps, analysisWindowSeconds, minLoopFrames },
        editor: {
          order: [...editorState.present.order],
          hidden: [...editorState.present.hidden],
          selected: [],
        },
        loop: { startFrame, endFrame },
        matte: {
          mode: matteMode,
          backend: matteBackend,
          keyColor,
          tolerance,
          feather,
          temporalConsistency,
          manualMasks: maskState.present,
          automaticMattes,
        },
        sprite: {
          columns,
          padding,
          trimMode,
          alphaThreshold,
          pivotX,
          pivotY,
          animationName,
          defaultFrameDuration,
          durationOverrides,
          exportPreset,
          pixelsPerUnit,
        },
        stage: stage === 'source' ? 'loop' : stage,
      }
      await saveLatestProject(snapshot)
      setSavedProjectAvailable(true)
      setProjectMessage(`项目已保存到本机 · ${automaticMattes.length} 张自动蒙版`)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(`保存项目失败：${message}`)
      setProjectMessage(null)
    } finally {
      setProjectBusy(false)
    }
  }

  const restoreProject = async () => {
    if (!savedProjectAvailable || projectBusy) return
    setProjectBusy(true)
    setProjectMessage('正在读取本地项目…')
    setError(null)
    try {
      const project = await loadLatestProject()
      if (!project) throw new Error('没有找到本地项目')
      setFps(project.capture.fps)
      const restoredWindowSeconds = project.capture.analysisWindowSeconds
        ?? Math.max(1, (project.capture.maxFrames ?? 240) / project.capture.fps)
      setAnalysisWindowSeconds(restoredWindowSeconds)
      setMinLoopFrames(project.capture.minLoopFrames)

      let nextFrames: CapturedFrame[]
      if (project.source.kind === 'demo') {
        setSourceKind('demo')
        setFile(null)
        nextFrames = createDemoFrames(project.capture.fps, project.source.period, project.source.repeats)
      } else {
        const nextFile = new File([project.source.blob], project.source.name, {
          type: project.source.type,
          lastModified: project.source.lastModified,
        })
        setSourceKind('video')
        setFile(nextFile)
        const restoredCapture = await captureVideoFrames(
          nextFile,
          project.capture.fps,
          project.capture.minLoopFrames,
          restoredWindowSeconds,
          ({ phase, current, total }) => {
            setProgress({ phase, current, total })
            setProjectMessage(`${phase === 'capturing' ? '正在载入候选原始帧' : '正在流式重扫完整视频'} ${current} / ${total}`)
          },
        )
        nextFrames = restoredCapture.frames
      }

      const validIds = new Set(nextFrames.map((frame) => frame.index))
      const order = project.editor.order.filter((frameId, index, values) =>
        validIds.has(frameId) && values.indexOf(frameId) === index)
      for (const frame of nextFrames) if (!order.includes(frame.index)) order.push(frame.index)
      let hidden = project.editor.hidden.filter((frameId) => validIds.has(frameId))
      if (order.length - hidden.length < 2) hidden = []
      const manualMasks = Object.fromEntries(Object.entries(project.matte.manualMasks)
        .filter(([frameId]) => validIds.has(Number(frameId))))
      const matteEntries = await Promise.all(project.matte.automaticMattes
        .filter((matte) => validIds.has(matte.frameId))
        .map(async (matte) => [matte.frameId, await pngBlobToCanvas(matte.png)] as const))
      const restoredMattes = Object.fromEntries(matteEntries)

      pendingProjectRangeRef.current = project.loop
      setFrames(nextFrames)
      dispatchEditor({ type: 'hydrate', snapshot: { order, hidden, selected: [] } })
      dispatchMask({ type: 'hydrate', masks: manualMasks })
      setAutoMattes(restoredMattes)
      setMatteBackend(project.matte.backend)
      setMatteMode(project.matte.mode === 'ai' && matteEntries.length === 0 ? 'original' : project.matte.mode)
      setKeyColor(project.matte.keyColor)
      setTolerance(project.matte.tolerance)
      setFeather(project.matte.feather)
      setTemporalConsistency(project.matte.temporalConsistency)
      setColumns(project.sprite.columns)
      setPadding(project.sprite.padding)
      setTrimMode(project.sprite.trimMode ?? 'grid')
      setAlphaThreshold(project.sprite.alphaThreshold ?? 1)
      setPivotX(project.sprite.pivotX ?? 0.5)
      setPivotY(project.sprite.pivotY ?? 1)
      setAnimationName(project.sprite.animationName ?? 'idle')
      setDefaultFrameDuration(project.sprite.defaultFrameDuration ?? Math.round(1000 / project.capture.fps))
      setDurationOverrides(project.sprite.durationOverrides ?? {})
      setExportPreset(project.sprite.exportPreset ?? 'generic')
      setPixelsPerUnit(project.sprite.pixelsPerUnit ?? 100)
      setStage(project.stage)
      setPlaying(false)
      setMaskEditing(false)
      setExportPreview(null)
      setExportManifest(null)
      setAlphaDiagnostics(null)
      setAiMatteJob(matteEntries.length > 0
        ? { phase: 'ready', current: matteEntries.length, total: matteEntries.length, percent: 1, message: `已恢复 ${matteEntries.length} 张自动蒙版` }
        : { phase: 'idle', current: 0, total: 0, percent: 0, message: '项目没有自动蒙版' })
      setProjectMessage(`项目已恢复 · ${nextFrames.length} 帧 · ${matteEntries.length} 张自动蒙版`)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(`恢复项目失败：${message}`)
      setProjectMessage(null)
    } finally {
      setProjectBusy(false)
    }
  }

  const clearSavedProject = async () => {
    if (!savedProjectAvailable || projectBusy) return
    if (!window.confirm('只删除浏览器中的本地项目存档，不会删除源视频或已导出的文件。继续吗？')) return
    setProjectBusy(true)
    try {
      await deleteLatestProject()
      setSavedProjectAvailable(false)
      setProjectMessage('本地项目存档已清除')
    } catch (cause) {
      setError(`清除项目失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setProjectBusy(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="FrameLoop Studio 首页">
          <span className="brand-mark">FL</span>
          <span>FrameLoop <em>Studio</em></span>
        </a>
        <div className="topbar-actions">
          <div className="project-controls" aria-label="本地项目">
            <button disabled={frames.length === 0 || sourceKind === 'empty' || projectBusy} onClick={() => void saveProject()}>{projectBusy ? '处理中…' : '保存项目'}</button>
            <button disabled={!savedProjectAvailable || projectBusy} onClick={() => void restoreProject()}>恢复项目</button>
            <button aria-label="清除本地项目存档" title="清除本地项目存档" disabled={!savedProjectAvailable || projectBusy} onClick={() => void clearSavedProject()}>×</button>
          </div>
          <div className="topbar-meta">
            <span className="status-dot" /> 本地处理 · 素材不上传
            <span className="version">ALPHA 0.2</span>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div>
            <p className="eyebrow">AI-NATIVE 2D ASSET PIPELINE</p>
            <h1>让动画自己找到<br /><span>完美循环。</span></h1>
            <p className="hero-copy">从视频抽帧、接缝分析、抠图到 Sprite Sheet。算法给出候选，创作者保留最后决定权。</p>
          </div>
          <div className="hero-visual" aria-hidden="true">
            <div className="orbit orbit-a" />
            <div className="orbit orbit-b" />
            <div className="frame-card frame-a">01</div>
            <div className="frame-card frame-b">08</div>
            <div className="loop-glyph">↻</div>
          </div>
        </section>

        <nav className="step-nav" aria-label="处理步骤">
          {([
            ['source', '01', '载入与抽帧'],
            ['loop', '02', '循环分析'],
            ['matte', '03', '抠图预览'],
            ['export', '04', '合成导出'],
          ] as Array<[Stage, string, string]>).map(([id, number, label]) => (
            <button key={id} className={stage === id ? 'active' : ''} disabled={id !== 'source' && frames.length === 0} onClick={() => setStage(id)}>
              <span>{number}</span>{label}
            </button>
          ))}
        </nav>

        {projectMessage && <div className="project-status" role="status">{projectMessage}</div>}

        {error && <div className="error-banner" role="alert">{error}</div>}

        {stage === 'source' && (
          <section className="workspace source-grid">
            <div className="panel upload-panel">
              <div className="panel-heading"><span>INPUT / SOURCE</span><small>MP4 · MOV · WEBM</small></div>
              <label
                className={`drop-zone ${dragActive ? 'drag-active' : ''}`}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                  onChange={(event) => {
                    acceptVideoFile(event.currentTarget.files?.[0] ?? null)
                    event.currentTarget.value = ''
                  }}
                />
                {videoUrl ? (
                  <video src={videoUrl} controls muted />
                ) : (
                  <>
                    <span className="upload-icon">＋</span>
                    <strong>拖入一段动作视频</strong>
                    <small>或点击选择本地文件</small>
                  </>
                )}
              </label>
              {file && <p className="file-line"><span>{file.name}</span><span>{(file.size / 1024 / 1024).toFixed(1)} MB</span></p>}
            </div>
            <div className="panel settings-panel">
              <div className="panel-heading"><span>CAPTURE / SAMPLE</span><small>BROWSER CANVAS</small></div>
              <Control label="采样帧率" value={`${fps} FPS`}>
                <input type="number" min="0.01" step="1" value={fps} onChange={(event) => setFps(Math.max(0.01, Number(event.target.value) || 0.01))} />
              </Control>
              <Control label="分析窗口" value={`${analysisWindowSeconds}s · 不截断视频`}>
                <input type="number" min="0.1" step="1" value={analysisWindowSeconds} onChange={(event) => setAnalysisWindowSeconds(Math.max(0.1, Number(event.target.value) || 0.1))} />
              </Control>
              <Control label="最短循环" value={`${minLoopFrames} 帧`}>
                <input type="number" min="2" step="1" value={minLoopFrames} onChange={(event) => setMinLoopFrames(Math.max(2, Math.floor(Number(event.target.value) || 2)))} />
              </Control>
              <button className="primary-action" disabled={!file || extracting} onClick={extract}>
                {extracting ? `正在${progress.phase === 'capturing' ? '载入候选帧' : '流式扫描'} ${progress.current}/${progress.total}` : '扫描完整视频并分析循环 →'}
              </button>
              {extracting && <button className="secondary-action" onClick={() => captureAbortRef.current?.abort()}>取消分析</button>}
              <button className="secondary-action demo-action" disabled={extracting} onClick={loadDemo}>载入内置循环演示</button>
              {extracting && <div className="progress"><i style={{ width: `${(progress.current / Math.max(1, progress.total)) * 100}%` }} /></div>}
            </div>
          </section>
        )}

        {stage === 'loop' && editedFrames.length > 0 && (
          <section className="workspace analysis-grid">
            <div className="panel timeline-panel">
              <div className="panel-heading"><span>LOOP / TIMELINE</span><small>{editedFrames.length} VISIBLE · {editorState.present.hidden.length} HIDDEN</small></div>
              <div className="timeline-toolbar">
                <span>帧差曲线</span>
                <label>缩放 <input aria-label="时间线缩放" type="range" min="0.65" max="1.8" step="0.05" value={timelineZoom} onChange={(event) => setTimelineZoom(Number(event.target.value))} /></label>
                <output>{Math.round(timelineZoom * 100)}%</output>
              </div>
              <TransitionChart diagnostics={sequenceDiagnostics} startFrame={startFrame} endFrame={endFrame} />
              <div className="timeline-legend">
                <span><i className="legend-selected" />当前区间</span>
                <span><i className="legend-duplicate" />重复帧</span>
                <span><i className="legend-cut" />疑似镜头切换</span>
              </div>
              <div className="edit-toolbar" aria-label="帧编辑工具栏">
                <span className="edit-count">已选 {editorState.present.selected.length}</span>
                <button onClick={() => dispatchEditor({ type: 'select_all_visible' })}>全选可见</button>
                <button disabled={editorState.present.selected.length === 0} onClick={() => dispatchEditor({ type: 'clear_selection' })}>清除选择</button>
                <button disabled={editorState.present.selected.length === 0} onClick={() => dispatchEditor({ type: 'move_selected', direction: -1 })}>← 左移</button>
                <button disabled={editorState.present.selected.length === 0} onClick={() => dispatchEditor({ type: 'move_selected', direction: 1 })}>右移 →</button>
                <button className="danger" disabled={editorState.present.selected.length === 0 || editedFrames.length <= 2} onClick={() => dispatchEditor({ type: 'hide_selected' })}>隐藏选中</button>
                <button disabled={editorState.past.length === 0} onClick={() => dispatchEditor({ type: 'undo' })}>撤销</button>
                <button disabled={editorState.future.length === 0} onClick={() => dispatchEditor({ type: 'redo' })}>重做</button>
                <button disabled={editorState.present.hidden.length === 0} onClick={() => dispatchEditor({ type: 'restore_all' })}>恢复隐藏 ({editorState.present.hidden.length})</button>
                <span className="edit-shortcuts">⌘/Ctrl+Z · Del · Esc</span>
              </div>
              <div className="filmstrip" style={{ '--timeline-zoom': timelineZoom } as React.CSSProperties}>
                {editedFrames.map((frame, position) => {
                  const transition = sequenceDiagnostics.transitions[position - 1]
                  return (
                  <div
                    key={frame.index}
                    className={[
                      'timeline-frame',
                      position >= startFrame && position <= endFrame ? 'range-selected' : '',
                      editorSelected.has(frame.index) ? 'edit-selected' : '',
                      transition?.isDuplicate ? 'duplicate-frame' : '',
                      transition?.isSceneCut ? 'scene-cut-frame' : '',
                    ].filter(Boolean).join(' ')}
                    title={transition ? `与前一帧差异 ${transition.distance.toFixed(4)}` : '序列首帧'}
                  >
                    <label className="edit-selector">
                      <input
                        type="checkbox"
                        aria-label={`选择帧 ${position + 1}`}
                        checked={editorSelected.has(frame.index)}
                        onChange={() => dispatchEditor({ type: 'toggle', frameId: frame.index, additive: true })}
                      />
                    </label>
                    <button
                      className="frame-range-button"
                      onClick={() => position < startFrame ? setStartFrame(position) : setEndFrame(position)}
                    >
                      <img src={frame.previewUrl} alt={`序列第 ${position + 1} 帧，源帧 ${frame.index + 1}`} />
                      <span>{String(position + 1).padStart(3, '0')} <small>SRC {String(frame.index + 1).padStart(3, '0')}</small> {transition?.isDuplicate ? 'DUP' : ''}</span>
                    </button>
                  </div>
                  )
                })}
              </div>
              <div className="range-row">
                <Control label="起始帧" value={String(startFrame + 1)}>
                  <input type="range" min="0" max={Math.max(0, endFrame - 1)} value={startFrame} onChange={(event) => { setStartFrame(Number(event.target.value)); setPreviewIndex(0) }} />
                </Control>
                <Control label="结束帧" value={String(endFrame + 1)}>
                  <input type="range" min={Math.min(editedFrames.length - 1, startFrame + 1)} max={editedFrames.length - 1} value={endFrame} onChange={(event) => { setEndFrame(Number(event.target.value)); setPreviewIndex(0) }} />
                </Control>
              </div>
              <div className="selection-summary">
                <strong>{selectedFrames.length} 帧</strong>
                <span>{formatTime(startFrame / fps)} — {formatTime(endFrame / fps)}</span>
                <span>{activeCandidate ? `算法置信度 ${percent(activeCandidate.confidence)}` : '手动区间'}</span>
                {activeCandidate?.suggestsDropLastFrame && (
                  <button className="drop-frame-action" onClick={() => setEndFrame((value) => Math.max(startFrame + 1, value - 1))}>删除重复末帧</button>
                )}
              </div>
              <CandidateComparison candidates={candidates} slots={compareSlots} frames={editedFrames} onUse={useCandidate} />
            </div>

            <div className="panel candidate-panel">
              <div className="panel-heading"><span>AI / CANDIDATES</span><small>LOWER SEAM SCORE IS BETTER</small></div>
              <div className="candidate-list">
                {candidates.map((candidate, index) => (
                  <div key={`${candidate.startFrame}-${candidate.endFrame}`} className={`candidate-row ${candidate === activeCandidate ? 'active' : ''}`}>
                    <button className="candidate-main" onClick={() => useCandidate(candidate)}>
                      <span className="rank">0{index + 1}</span>
                      <span><strong>{candidate.startFrame + 1} → {candidate.endFrame + 1}</strong><small>{candidate.frameCount} 帧 · 周期误差 {candidate.diagnostics.periodicityMismatch.toFixed(3)}</small></span>
                      <b>{percent(candidate.confidence)}</b>
                    </button>
                    <div className="compare-actions">
                      <button className={compareSlots[0] === index ? 'selected' : ''} onClick={() => assignCompareSlot(0, index)}>A</button>
                      <button className={compareSlots[1] === index ? 'selected' : ''} onClick={() => assignCompareSlot(1, index)}>B</button>
                    </div>
                    {candidate.suggestsDropLastFrame && <span className="candidate-warning">重复末帧</span>}
                  </div>
                ))}
              </div>
              <button className="primary-action" onClick={() => setStage('matte')}>确认循环区间 →</button>
            </div>
          </section>
        )}

        {(stage === 'matte' || stage === 'export') && frames.length > 0 && (
          <section className="workspace finish-grid">
            <div className="panel preview-panel">
              <div className="panel-heading"><span>LOOP / PREVIEW</span><small>{previewFrame ? `${previewFrame.canvas.width}×${previewFrame.canvas.height} · ` : ''}{selectedFrames.length} FRAMES · {fps} FPS</small></div>
              <div className={`checkerboard ${maskEditing ? 'mask-editing' : ''}`}>
                <canvas
                  ref={previewCanvasRef}
                  aria-label="循环与蒙版预览"
                  onPointerDown={beginMaskStroke}
                  onPointerMove={extendMaskStroke}
                  onPointerUp={finishMaskStroke}
                  onPointerCancel={finishMaskStroke}
                />
              </div>
              <div className="transport">
                <button onClick={() => setPlaying((value) => !value)}>{playing ? 'Ⅱ' : '▶'}</button>
                <span>{previewIndex + 1} / {selectedFrames.length}</span>
                <input type="range" min="0" max={Math.max(0, selectedFrames.length - 1)} value={previewIndex} onChange={(event) => { setPreviewIndex(Number(event.target.value)); setPlaying(false) }} />
              </div>
            </div>
            <div className="panel settings-panel">
              <div className="panel-heading"><span>{stage === 'matte' ? 'MATTE / AI + CHROMA' : 'EXPORT / SPRITE SHEET'}</span><small>NON-DESTRUCTIVE</small></div>
              {stage === 'matte' ? (
                <>
                  <div className="matte-mode-tabs" role="group" aria-label="基础抠图模式">
                    <button className={matteMode === 'original' ? 'active' : ''} onClick={() => setMatteMode('original')}>原图</button>
                    <button className={matteMode === 'ai' ? 'active' : ''} disabled={selectedAutoMatteCount === 0} onClick={() => setMatteMode('ai')}>AI 蒙版 {selectedAutoMatteCount}/{selectedFrames.length}</button>
                    <button className={matteMode === 'chroma' ? 'active' : ''} onClick={() => setMatteMode('chroma')}>色度键</button>
                  </div>
                  <div className="ai-matte-card">
                    <div className="ai-matte-heading">
                      <span>LOCAL AI / MODNET</span>
                      <small>{matteBackend?.toUpperCase() ?? 'NOT LOADED'}</small>
                    </div>
                    <p>{DEFAULT_MATTE_MODEL} · {DEFAULT_MATTE_MODEL_LICENSE} · 模型首次使用时下载，推理素材不上传。</p>
                    <div className="ai-matte-actions">
                      <button disabled={!previewFrame || mattingBusy} onClick={() => previewFrame && void runAutomaticMatting([previewFrame])}>自动抠图当前帧</button>
                      <button disabled={mattingBusy} onClick={() => void runAutomaticMatting(selectedFrames)}>批量处理循环 ({selectedFrames.length})</button>
                      {mattingBusy ? (
                        <button className="danger" onClick={() => { cancelMattingRef.current = true }}>取消剩余帧</button>
                      ) : (
                        <button disabled={selectedAutoMatteCount === 0} onClick={clearAutomaticMattes}>清空自动蒙版</button>
                      )}
                    </div>
                    <div className={`ai-matte-status ${aiMatteJob.phase}`} role="status">
                      <span>{aiMatteJob.message}</span>
                      <b>{Math.round(aiMatteJob.percent * 100)}%</b>
                      <i style={{ width: `${aiMatteJob.percent * 100}%` }} />
                    </div>
                    {matteEngineRef.current?.fallbackReason && <p className="backend-fallback">{matteEngineRef.current.fallbackReason}，已自动切换 WASM。</p>}
                    {matteMode === 'ai' && previewFrame && !autoMattes[previewFrame.index] && <p className="backend-fallback">当前帧还没有自动蒙版，预览暂时显示原图。</p>}
                  </div>
                  <div className={`chroma-controls ${matteMode === 'chroma' ? 'active' : ''}`}>
                    <div className="subsection-heading"><span>CHROMA / SOLID COLOR</span><small>{matteMode === 'chroma' ? 'ACTIVE' : 'INACTIVE'}</small></div>
                    <Control label="背景色" value={keyColor.toUpperCase()}>
                      <input className="color-input" type="color" value={keyColor} onChange={(event) => setKeyColor(event.target.value)} />
                    </Control>
                    <Control label="容差" value={String(tolerance)}>
                      <input type="range" min="0" max="220" value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} />
                    </Control>
                    <Control label="边缘羽化" value={String(feather)}>
                      <input type="range" min="1" max="100" value={feather} onChange={(event) => setFeather(Number(event.target.value))} />
                    </Control>
                    <Control label="时序稳定" value={percent(temporalConsistency)}>
                      <input type="range" min="0" max="1" step="0.05" value={temporalConsistency} onChange={(event) => setTemporalConsistency(Number(event.target.value))} />
                    </Control>
                  </div>
                  <div className="mask-tools">
                    <div className="mask-tools-heading">
                      <span>逐帧蒙版修正</span>
                      <small>当前帧 {currentMaskStrokes.length} 笔</small>
                    </div>
                    <button className={maskEditing ? 'active' : ''} onClick={() => setMaskEditing((value) => !value)}>
                      {maskEditing ? '结束笔刷编辑' : '开始笔刷编辑'}
                    </button>
                    <div className="brush-modes" role="group" aria-label="蒙版笔刷模式">
                      <button className={brushMode === 'remove' ? 'active' : ''} onClick={() => setBrushMode('remove')}>移除背景</button>
                      <button className={brushMode === 'restore' ? 'active' : ''} onClick={() => setBrushMode('restore')}>恢复主体</button>
                    </div>
                    <Control label="笔刷大小" value={String(brushSize)}>
                      <input type="range" min="4" max="80" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} />
                    </Control>
                    <div className="mask-history-actions">
                      <button disabled={maskState.past.length === 0} onClick={() => dispatchMask({ type: 'undo' })}>撤销笔刷</button>
                      <button disabled={maskState.future.length === 0} onClick={() => dispatchMask({ type: 'redo' })}>重做笔刷</button>
                      <button disabled={currentMaskStrokes.length === 0} onClick={copyMaskToNeighbors}>复制到相邻帧</button>
                      <button disabled={currentMaskStrokes.length === 0} onClick={() => previewFrame && dispatchMask({ type: 'clear_frame', frameId: previewFrame.index })}>清空当前帧</button>
                    </div>
                    <p>笔刷坐标按画面比例保存，可安全用于不同预览尺寸；所有修改在浏览器内完成。</p>
                  </div>
                  <button className="secondary-action" disabled={matteMode !== 'chroma'} onClick={analyzeMatteStability}>分析色度键 Alpha 抖动</button>
                  {alphaDiagnostics && (
                    <div className="matte-diagnostics">
                      <div><span>原始抖动</span><strong>{percent(alphaDiagnostics.raw)}</strong></div>
                      <div><span>稳定后</span><strong>{percent(alphaDiagnostics.stabilized)}</strong></div>
                      <div className="improvement"><span>改善率</span><strong>{percent(alphaDiagnostics.improvement)}</strong></div>
                      <small>基于 {alphaDiagnostics.sampledFrames} 帧低分辨率 Alpha 采样；数值越低越稳定。</small>
                    </div>
                  )}
                  <button className="primary-action" onClick={() => setStage('export')}>进入合成设置 →</button>
                </>
              ) : (
                <>
                  <div className="export-basics">
                    <label className="field-label">
                      <span>动画名称</span>
                      <input type="text" value={animationName} maxLength={64} onChange={(event) => setAnimationName(event.target.value)} />
                    </label>
                    <label className="field-label">
                      <span>导出预设</span>
                      <select value={exportPreset} onChange={(event) => setExportPreset(event.target.value as ExportPreset)}>
                        <option value="generic">通用 PNG + JSON</option>
                        <option value="aseprite">Aseprite JSON</option>
                        <option value="godot">Godot SpriteFrames</option>
                        <option value="unity">Unity JSON</option>
                      </select>
                    </label>
                  </div>
                  <div className="export-mode-tabs" role="group" aria-label="SpriteSheet 排布模式">
                    <button className={trimMode === 'grid' ? 'active' : ''} onClick={() => setTrimMode('grid')}>等距网格</button>
                    <button className={trimMode === 'tight' ? 'active' : ''} onClick={() => setTrimMode('tight')}>Tight Trim</button>
                  </div>
                  <Control label="列数" value={String(columns)}>
                    <input type="range" min="1" max={Math.max(1, Math.min(24, selectedFrames.length))} value={Math.min(columns, selectedFrames.length)} onChange={(event) => setColumns(Number(event.target.value))} />
                  </Control>
                  <Control label="帧间距" value={`${padding}px`}>
                    <input type="range" min="0" max="32" value={padding} onChange={(event) => setPadding(Number(event.target.value))} />
                  </Control>
                  {trimMode === 'tight' && (
                    <Control label="Alpha 裁切阈值" value={String(alphaThreshold)}>
                      <input type="range" min="1" max="255" value={alphaThreshold} onChange={(event) => setAlphaThreshold(Number(event.target.value))} />
                    </Control>
                  )}
                  <div className="export-subsection">
                    <div className="subsection-heading"><span>PIVOT / SOURCE SPACE</span><small>{pivotX.toFixed(2)}, {pivotY.toFixed(2)}</small></div>
                    <div className="pivot-presets">
                      <button onClick={() => { setPivotX(0.5); setPivotY(0.5) }}>中心</button>
                      <button onClick={() => { setPivotX(0.5); setPivotY(1) }}>底部中心</button>
                    </div>
                    <Control label="Pivot X" value={pivotX.toFixed(2)}>
                      <input type="range" min="0" max="1" step="0.01" value={pivotX} onChange={(event) => setPivotX(Number(event.target.value))} />
                    </Control>
                    <Control label="Pivot Y" value={pivotY.toFixed(2)}>
                      <input type="range" min="0" max="1" step="0.01" value={pivotY} onChange={(event) => setPivotY(Number(event.target.value))} />
                    </Control>
                  </div>
                  <div className="export-subsection duration-editor">
                    <div className="subsection-heading"><span>FRAME TIMING</span><small>{selectedFrames.length} FRAMES</small></div>
                    <label className="field-label compact">
                      <span>默认时长（ms）</span>
                      <input type="number" min="1" max="60000" value={defaultFrameDuration} onChange={(event) => setDefaultFrameDuration(Math.max(1, Number(event.target.value)))} />
                    </label>
                    <div className="duration-grid">
                      {selectedFrames.map((frame, index) => (
                        <label key={frame.index}>
                          <span>#{index + 1} <small>源 {frame.index}</small></span>
                          <input
                            type="number"
                            min="1"
                            max="60000"
                            value={durationOverrides[frame.index] ?? defaultFrameDuration}
                            onChange={(event) => setDurationOverrides((current) => ({
                              ...current,
                              [frame.index]: Math.max(1, Number(event.target.value)),
                            }))}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                  {exportPreset === 'unity' && (
                    <Control label="Pixels Per Unit" value={String(pixelsPerUnit)}>
                      <input type="range" min="1" max="512" value={pixelsPerUnit} onChange={(event) => setPixelsPerUnit(Number(event.target.value))} />
                    </Control>
                  )}
                  <button className="secondary-action" onClick={renderExport}>刷新合成预览</button>
                  {exportPreview && (
                    <>
                      <div className="sheet-preview checkerboard"><img src={exportPreview} alt="Sprite Sheet 预览" /></div>
                      {exportManifest && (
                        <div className="export-summary">
                          <span>{exportManifest.sheetSize.width} × {exportManifest.sheetSize.height}px</span>
                          <span>{exportManifest.animation.duration}ms</span>
                          <span>{exportManifest.trimMode === 'tight' ? 'Tight Trim' : 'Grid'}</span>
                        </div>
                      )}
                    </>
                  )}
                  <button className="primary-action" onClick={downloadSprite}>
                    下载 {exportPreset === 'godot' ? 'PNG + TRES + JSON' : 'PNG + 数据文件'}
                  </button>
                </>
              )}
            </div>
          </section>
        )}
      </main>

      <footer><span>FRAMELOOP STUDIO</span><span>Browser-first · MCP-ready · Open pipeline</span></footer>
    </div>
  )
}

function Control({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <label className="control">
      <span><b>{label}</b><output>{value}</output></span>
      {children}
    </label>
  )
}

function TransitionChart({
  diagnostics,
  startFrame,
  endFrame,
}: {
  diagnostics: SequenceDiagnostics
  startFrame: number
  endFrame: number
}) {
  const transitions = diagnostics.transitions
  if (transitions.length === 0) return <div className="transition-chart empty">至少需要两帧才能绘制差异曲线</div>
  const max = Math.max(0.001, ...transitions.map((item) => item.distance))
  const xFor = (frame: number) => frame / Math.max(1, transitions.length) * 1000
  const yFor = (distance: number) => 88 - distance / max * 72
  const points = transitions.map((item) => `${xFor(item.frame)},${yFor(item.distance)}`).join(' ')
  const selectedX = xFor(startFrame)
  const selectedWidth = Math.max(2, xFor(endFrame) - selectedX)

  return (
    <div className="transition-chart" aria-label="逐帧差异曲线">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img">
        <rect x={selectedX} y="0" width={selectedWidth} height="100" className="chart-selection" />
        <line x1="0" y1="88" x2="1000" y2="88" className="chart-baseline" />
        <polyline points={points} className="chart-line" />
        {transitions.filter((item) => item.isDuplicate || item.isSceneCut).map((item) => (
          <circle
            key={item.frame}
            cx={xFor(item.frame)}
            cy={yFor(item.distance)}
            r="5"
            className={item.isSceneCut ? 'chart-cut' : 'chart-duplicate'}
          />
        ))}
      </svg>
    </div>
  )
}

function CandidateComparison({
  candidates,
  slots,
  frames,
  onUse,
}: {
  candidates: LoopCandidate[]
  slots: [number, number]
  frames: CapturedFrame[]
  onUse: (candidate: LoopCandidate) => void
}) {
  if (candidates.length < 2) return null
  return (
    <section className="comparison-board">
      <div className="comparison-heading"><span>A/B LOOP REVIEW</span><small>首尾帧与诊断分项</small></div>
      <div className="comparison-columns">
        {slots.map((candidateIndex, slot) => {
          const candidate = candidates[candidateIndex]
          if (!candidate) return null
          const start = frames[candidate.startFrame]
          const end = frames[candidate.endFrame]
          return (
            <article key={`${slot}-${candidateIndex}`}>
              <header><b>{slot === 0 ? 'A' : 'B'}</b><span>候选 0{candidateIndex + 1}</span><strong>{percent(candidate.confidence)}</strong></header>
              <div className="seam-pair">
                <figure><img src={start?.previewUrl} alt={`候选 ${candidateIndex + 1} 起始帧`} /><figcaption>START {candidate.startFrame + 1}</figcaption></figure>
                <span>→</span>
                <figure><img src={end?.previewUrl} alt={`候选 ${candidateIndex + 1} 结束帧`} /><figcaption>END {candidate.endFrame + 1}</figcaption></figure>
              </div>
              <dl>
                <div><dt>闭合</dt><dd>{candidate.diagnostics.closure.toFixed(3)}</dd></div>
                <div><dt>运动</dt><dd>{candidate.diagnostics.motionMismatch.toFixed(3)}</dd></div>
                <div><dt>周期</dt><dd>{candidate.diagnostics.periodicityMismatch.toFixed(3)}</dd></div>
                <div><dt>静止惩罚</dt><dd>{candidate.diagnostics.staticPenalty.toFixed(3)}</dd></div>
              </dl>
              {candidate.suggestsDropLastFrame && <p className="comparison-alert">末帧疑似与首帧重复</p>}
              <button onClick={() => onUse(candidate)}>采用候选 {slot === 0 ? 'A' : 'B'}</button>
            </article>
          )
        })}
      </div>
    </section>
  )
}
