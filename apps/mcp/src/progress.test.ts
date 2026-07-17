import { describe, expect, it, vi } from 'vitest'
import { createProgressReporter } from './progress.js'

describe('createProgressReporter', () => {
  it('emits monotonic MCP progress and ignores missing tokens', async () => {
    const sendNotification = vi.fn(async () => undefined)
    const report = createProgressReporter({
      _meta: { progressToken: 'job-1' },
      sendNotification,
    }, 0)
    await report({ progress: 1, total: 3, message: 'first' })
    await report({ progress: 1, total: 3, message: 'duplicate' })
    await report({ progress: 2, total: 3 })
    expect(sendNotification).toHaveBeenCalledTimes(2)
    expect(sendNotification).toHaveBeenLastCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 'job-1', progress: 2, total: 3 },
    })

    const silent = vi.fn(async () => undefined)
    const noToken = createProgressReporter({ sendNotification: silent }, 0)
    await noToken({ progress: 1 })
    expect(silent).not.toHaveBeenCalled()
  })
})
