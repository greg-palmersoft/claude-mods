import type { ThemeKey } from 'claude-code'

import type { CacheState, LimitReading, UsageSnapshot } from '../types'

export type Tone = 'success' | 'warning' | 'error'

export type Advice = { tone: Tone; text: string }

const BAR_WIDTH = 8
const LARGE_CONTEXT_TOKENS = 400_000

/** The session's prompt cache lives an hour from its last write or read. */
export const CACHE_TTL_MS = 60 * 60_000

/** An idle cache is pinged once it is this old, well inside its lifetime. */
export const KEEP_WARM_AFTER_MS = 30 * 60_000

/** Pings per idle stretch, so a session left overnight stops spending on itself. */
export const MAX_IDLE_PINGS = 4

export const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'Spend',
}

/** Fills a fixed-width bar in proportion to `percent`, clamped to 0..100. */
export function bar(percent: number, width: number = BAR_WIDTH): string {
  const clamped = Math.min(100, Math.max(0, percent))
  const filled = Math.round((clamped / 100) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Each meter keeps one theme colour for its label, bar and figures. */
export const METER_COLOURS: Record<string, ThemeKey> = {
  five_hour: 'suggestion',
  seven_day: 'claude',
  spend_limit: 'warning',
  context: 'planMode',
}

export function meterColour(kind: string): ThemeKey {
  return METER_COLOURS[kind] ?? 'text'
}

/** Formats the time until `resetsAt` as `2h14m`, `3d4h` or `12m`. */
export function untilReset(resetsAt: string | undefined, now: number): string | undefined {
  if (resetsAt === undefined) {
    return undefined
  }

  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60_000))

  if (Number.isNaN(minutes)) {
    return undefined
  }

  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60

  if (days > 0) {
    return `${days}d${hours}h`
  }

  return hours > 0 ? `${hours}h${mins}m` : `${mins}m`
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
  }

  return `${Math.round(tokens / 1000)}k`
}

/** Orders the windows 5-hour, 7-day, then anything else the account reports. */
export function orderLimits(limits: LimitReading[]): LimitReading[] {
  const rank = (kind: string): number => Object.keys(LIMIT_LABELS).indexOf(kind) >>> 0

  return [...limits].sort((a, b) => rank(a.kind) - rank(b.kind))
}

/**
 * Advice on compacting, measured against the auto-compact threshold where
 * auto-compaction is on, otherwise against the whole window.
 */
export function compactAdvice(snapshot: UsageSnapshot): Advice | undefined {
  const tokens = snapshot.contextTokens

  if (tokens === undefined) {
    return undefined
  }

  const limit = snapshot.autoCompactThreshold ?? snapshot.contextWindow
  const fill = limit > 0 ? tokens / limit : 0
  if (fill >= 0.85) {
    return { tone: 'error', text: 'Compact now' }
  }

  if (fill >= 0.7) {
    return { tone: 'warning', text: 'Compact soon' }
  }

  if (fill >= 0.5 || tokens >= LARGE_CONTEXT_TOKENS) {
    return { tone: 'warning', text: 'Compact at next break' }
  }

  return { tone: 'success', text: 'No need to compact' }
}

/** Formats a duration in minutes as `2h14m` or `12m`. */
function minutesLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60)

  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`
}

/** The cache's age, toned by how close it is to lapsing, or undefined before the first response. */
export function cacheAge(cache: CacheState, now: number): Advice | undefined {
  if (cache.lastCachedAt === undefined) {
    return undefined
  }

  const ageMs = Math.max(0, now - cache.lastCachedAt)

  if (ageMs >= CACHE_TTL_MS) {
    return { tone: 'error', text: 'cache cold' }
  }

  const text = `cache ${minutesLabel(Math.floor(ageMs / 60_000))}`

  return { tone: ageMs >= KEEP_WARM_AFTER_MS ? 'warning' : 'success', text }
}

/** Whether an idle cache is due a keep-warm ping. */
export function isPingDue(cache: CacheState, now: number): boolean {
  if (cache.lastCachedAt === undefined || cache.idlePings >= MAX_IDLE_PINGS) {
    return false
  }

  const ageMs = now - cache.lastCachedAt

  return ageMs >= KEEP_WARM_AFTER_MS && ageMs < CACHE_TTL_MS
}
