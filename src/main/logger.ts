export function logInfo(scope: string, message: string): void {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  safeWrite(process.stdout, `[${timestamp}] [${scope}] ${message}\n`)
}

export function logError(scope: string, message: string, error?: unknown): void {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const errorText = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error || '')
  safeWrite(process.stderr, `[${timestamp}] [${scope}] ${message} ${errorText}\n`)
}

export function installPipeErrorGuards(): void {
  process.stdout.on('error', ignoreBrokenPipe)
  process.stderr.on('error', ignoreBrokenPipe)
}

function safeWrite(stream: NodeJS.WriteStream, message: string): void {
  try {
    if (!stream.destroyed && stream.writable) {
      stream.write(message)
    }
  } catch (e: any) {
    if (e?.code !== 'EPIPE') {
      throw e
    }
  }
}

function ignoreBrokenPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== 'EPIPE') {
    throw error
  }
}
