export type LimitReading = { kind: string; percentUsed: number; resetsAt?: string }

export type UsageSnapshot = {
  limits: LimitReading[]
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  autoCompactThreshold?: number
}

/** When the main thread's prompt cache was last written or read, and the keep-warm pings since. */
export type CacheState = {
  lastCachedAt?: number
  idlePings: number
  pingError?: string
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { snapshot: UsageSnapshot | null; isHidden: boolean; cache: CacheState; tick: number }
  }
}
