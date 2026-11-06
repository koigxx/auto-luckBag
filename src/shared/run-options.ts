export const DEFAULT_BACKGROUND_RUN = false

export interface AutoRunOptions {
  sourceUrl?: string
  scanIntervalSeconds?: number
  stopAfterMinutes?: number
  enterBeforeSeconds?: number
  candidatePoolLimit?: number
  background?: boolean
}
