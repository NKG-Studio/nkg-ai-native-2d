import type { FrameEditorSnapshot } from './editor'
import type { FrameMasks } from './mask'
import type { ExportPreset } from './exporters'
import type { TrimMode } from './sprite'

export const PROJECT_SCHEMA_VERSION = 1
const DATABASE_NAME = 'frameloop-studio'
const STORE_NAME = 'projects'
const LATEST_PROJECT_ID = 'latest'

export type ProjectSource =
  | { kind: 'demo'; period: number; repeats: number }
  | { kind: 'video'; name: string; type: string; lastModified: number; blob: Blob }

export interface StoredAutoMatte {
  frameId: number
  png: Blob
}

export interface ProjectSnapshot {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  savedAt: string
  source: ProjectSource
  capture: {
    fps: number
    maxLoopSeconds?: number
    /** 旧版“分析窗口”字段，迁移后按最长循环时长处理。 */
    analysisWindowSeconds?: number
    /** 旧版项目字段，仅用于迁移。 */
    maxFrames?: number
    minLoopFrames: number
  }
  editor: FrameEditorSnapshot
  loop: {
    startFrame: number
    endFrame: number
  }
  matte: {
    mode: 'original' | 'chroma' | 'ai'
    backend: 'webgpu' | 'wasm' | null
    keyColor: string
    tolerance: number
    feather: number
    temporalConsistency: number
    manualMasks: FrameMasks
    automaticMattes: StoredAutoMatte[]
  }
  sprite: {
    columns: number
    padding: number
    trimMode?: TrimMode
    alphaThreshold?: number
    pivotX?: number
    pivotY?: number
    animationName?: string
    defaultFrameDuration?: number
    durationOverrides?: Record<number, number>
    exportPreset?: ExportPreset
    pixelsPerUnit?: number
  }
  stage: 'loop' | 'matte' | 'export'
}

interface StoredProject extends ProjectSnapshot {
  id: typeof LATEST_PROJECT_ID
}

export function isProjectSnapshot(value: unknown): value is ProjectSnapshot {
  if (!value || typeof value !== 'object') return false
  const project = value as Partial<ProjectSnapshot>
  if (project.schemaVersion !== PROJECT_SCHEMA_VERSION || typeof project.savedAt !== 'string') return false
  if (!project.source || !['demo', 'video'].includes(project.source.kind)) return false
  if (!project.capture || !Number.isFinite(project.capture.fps) || !Number.isFinite(project.capture.minLoopFrames)) return false
  if (!Number.isFinite(project.capture.maxLoopSeconds)
    && !Number.isFinite(project.capture.analysisWindowSeconds)
    && !Number.isFinite(project.capture.maxFrames)) return false
  if (!project.editor || !Array.isArray(project.editor.order) || !Array.isArray(project.editor.hidden)) return false
  if (!project.loop || !Number.isFinite(project.loop.startFrame) || !Number.isFinite(project.loop.endFrame)) return false
  if (!project.matte || !['original', 'chroma', 'ai'].includes(project.matte.mode)) return false
  if (!project.sprite || !Number.isFinite(project.sprite.columns) || !Number.isFinite(project.sprite.padding)) return false
  return ['loop', 'matte', 'export'].includes(project.stage ?? '')
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务已中止'))
  })
}

async function openDatabase() {
  const request = indexedDB.open(DATABASE_NAME, PROJECT_SCHEMA_VERSION)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
  }
  return requestResult(request)
}

export async function saveLatestProject(project: ProjectSnapshot) {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put({ ...project, id: LATEST_PROJECT_ID } satisfies StoredProject)
    await transactionDone(transaction)
  } finally {
    database.close()
  }
}

export async function loadLatestProject() {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const stored = await requestResult(transaction.objectStore(STORE_NAME).get(LATEST_PROJECT_ID))
    await transactionDone(transaction)
    if (!stored) return null
    const { id: _id, ...project } = stored as StoredProject
    if (!isProjectSnapshot(project)) throw new Error('本地项目格式无效或版本不兼容')
    return project
  } finally {
    database.close()
  }
}

export async function deleteLatestProject() {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).delete(LATEST_PROJECT_ID)
    await transactionDone(transaction)
  } finally {
    database.close()
  }
}

export function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法编码自动蒙版 PNG')), 'image/png')
  })
}

export async function pngBlobToCanvas(blob: Blob) {
  const canvas = document.createElement('canvas')
  if ('createImageBitmap' in window) {
    const bitmap = await createImageBitmap(blob)
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    bitmap.close()
    return canvas
  }

  const url = URL.createObjectURL(blob)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('无法解码自动蒙版 PNG'))
      element.src = url
    })
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    canvas.getContext('2d')!.drawImage(image, 0, 0)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}
