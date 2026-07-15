import { describe, expect, it } from 'vitest'
import { isSupportedVideoFile } from './upload'

describe('isSupportedVideoFile', () => {
  it('accepts the video formats advertised by the drop zone', () => {
    expect(isSupportedVideoFile({ name: 'action.mp4', type: 'video/mp4' })).toBe(true)
    expect(isSupportedVideoFile({ name: 'action.mov', type: 'video/quicktime' })).toBe(true)
    expect(isSupportedVideoFile({ name: 'action.webm', type: 'video/webm' })).toBe(true)
  })

  it('falls back to the extension when drag-and-drop omits the MIME type', () => {
    expect(isSupportedVideoFile({ name: 'ACTION.MP4', type: '' })).toBe(true)
    expect(isSupportedVideoFile({ name: 'action.mov', type: 'application/octet-stream' })).toBe(true)
  })

  it('rejects unrelated files', () => {
    expect(isSupportedVideoFile({ name: 'sprite.png', type: 'image/png' })).toBe(false)
  })
})
