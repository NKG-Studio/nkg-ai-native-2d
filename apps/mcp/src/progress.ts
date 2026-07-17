export interface ProgressNotificationExtra {
  _meta?: { progressToken?: string | number }
  sendNotification: (notification: {
    method: 'notifications/progress'
    params: {
      progressToken: string | number
      progress: number
      total?: number
      message?: string
    }
  }) => Promise<void>
}

export interface ProgressUpdate {
  progress: number
  total?: number
  message?: string
  force?: boolean
}

/**
 * MCP progress values must increase monotonically. This helper also throttles
 * frame-level updates so long videos do not flood the stdio transport.
 */
export function createProgressReporter(extra: ProgressNotificationExtra, minimumIntervalMs = 200) {
  const token = extra._meta?.progressToken
  let lastProgress = -1
  let lastSentAt = 0

  return async ({ progress, total, message, force = false }: ProgressUpdate) => {
    if (token === undefined) return
    const next = Number.isFinite(progress) ? Math.max(0, progress) : 0
    if (next <= lastProgress) return
    const now = Date.now()
    if (!force && lastProgress >= 0 && now - lastSentAt < minimumIntervalMs) return
    lastProgress = next
    lastSentAt = now
    await extra.sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken: token,
        progress: next,
        ...(total !== undefined ? { total: Math.max(next, total) } : {}),
        ...(message ? { message } : {}),
      },
    })
  }
}
