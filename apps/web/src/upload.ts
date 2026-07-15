const SUPPORTED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
])

const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm']

export interface VideoFileDescriptor {
  name: string
  type: string
}

export function isSupportedVideoFile(file: VideoFileDescriptor) {
  const normalizedType = file.type.toLowerCase()
  if (SUPPORTED_VIDEO_MIME_TYPES.has(normalizedType)) return true
  if (normalizedType && normalizedType !== 'application/octet-stream') return false
  const normalizedName = file.name.toLowerCase()
  return SUPPORTED_VIDEO_EXTENSIONS.some((extension) => normalizedName.endsWith(extension))
}
