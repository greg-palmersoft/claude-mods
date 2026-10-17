import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { CacheState, UsageSnapshot } from '../types'
import { LIMIT_LABELS, bar, cacheAge, compactAdvice, formatTokens, isPingDue, meterColour, orderLimits, untilReset } from './format'

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)
const cache = atom({ plugin: 'usage-band', key: 'cache' } as const, { idlePings: 0 } as CacheState)
const tick = atom({ plugin: 'usage-band', key: 'tick' } as const, 0)

const TICK_MS = 60_000
const PING_PROMPT = 'Keep-alive ping to refresh the prompt cache. Reply with OK and nothing else.'

let isPinging = false

/** Marks the cache as just used by the person's own turn, which ends any idle stretch. */
async function touchCache($: EngineInterface): Promise<void> {
  const now = await $.clock.now()

  await update($, cache, () => ({ lastCachedAt: now, idlePings: 0 }))
}

/**
 * Re-sends the main thread's last request through a fork once the cache has
 * idled long enough, so the read renews the cache's lifetime.
 */
async function keepWarm($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, tick, () => now)

  if (isPinging || !isPingDue(await read($, cache), now)) {
    return
  }

  isPinging = true

  try {
    const reply = await $.model.fork({ prompt: PING_PROMPT })
    const at = await $.clock.now()

    if (reply.isAnswered) {
      await update($, cache, current => ({ lastCachedAt: at, idlePings: current.idlePings + 1 }))
    } else if (reply.reason === 'nothing-to-fork') {
      await update($, cache, () => ({ idlePings: 0 }))
    } else {
      const pingError = reply.reason === 'api-error' ? `ping failed (${reply.status ?? reply.error})` : `ping ${reply.reason}`
      await update($, cache, current => ({ ...current, idlePings: current.idlePings + 1, pingError }))
    }
  } finally {
    isPinging = false
  }
}

/** Reads the auto-compact threshold from a local estimate, which sends no requests. */
async function autoCompactThreshold($: EngineInterface): Promise<number | undefined> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })

    return context.breakdown?.isAutoCompactEnabled ? context.breakdown.autoCompactThreshold : undefined
  } catch {
    return undefined
  }
}

async function record(
  $: EngineInterface,
  figures: { context: SessionContextUsage; rateLimits: SessionRateLimit[] },
  isContextChanged: boolean,
): Promise<void> {
  const previous = await read($, snapshot)
  const threshold = isContextChanged || previous === null
    ? await autoCompactThreshold($)
    : previous.autoCompactThreshold

  const next: UsageSnapshot = {
    limits: figures.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    contextTokens: figures.context.tokens,
    contextWindow: figures.context.window,
    contextPercent: figures.context.percent,
    autoCompactThreshold: threshold,
  }

  await update($, snapshot, () => next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await record($, await $.session.usage(), true)
    $.clock.every(TICK_MS, () => {
      void keepWarm($)
    })

    return result
  })

  on('session.measure', async ($, e, next) => {
    await record($, e, e.changed.includes('context'))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined && e.usage !== undefined) {
      await touchCache($)
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const figures = await read($, snapshot)
    await read($, tick)

    if (e.props.hasSurvey || figures === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const advice = compactAdvice(figures)
    const contextPercent = figures.contextPercent ?? 0
    const contextColour = meterColour('context')
    const cacheState = await read($, cache)
    const age = cacheAge(cacheState, now)

    return (
      <Box>
        {orderLimits(figures.limits).map(limit => {
          const resets = untilReset(limit.resetsAt, now)
          const colour = meterColour(limit.kind)

          return (
            <Box key={limit.kind} marginRight={2}>
              <Text color={colour}>
                {LIMIT_LABELS[limit.kind] ?? limit.kind} {bar(limit.percentUsed)} {Math.round(limit.percentUsed)}%
              </Text>
              {resets !== undefined && <Text color={colour} dimColor> {resets}</Text>}
            </Box>
          )
        })}
        <Box key="context" marginRight={2}>
          <Text color={contextColour}>
            ctx {bar(contextPercent)} {figures.contextPercent ?? '–'}%
          </Text>
          {figures.contextTokens !== undefined && (
            <Text color={contextColour} dimColor> {formatTokens(figures.contextTokens)}/{formatTokens(figures.contextWindow)}</Text>
          )}
        </Box>
        {age !== undefined && (
          <Box key="cache" marginRight={2}>
            <Text color={age.tone}>{age.text}</Text>
            {cacheState.idlePings > 0 && <Text color={age.tone} dimColor> ×{cacheState.idlePings} kept warm</Text>}
            {cacheState.pingError !== undefined && <Text color="error"> {cacheState.pingError}</Text>}
          </Box>
        )}
        {advice?.tone !== 'success' && (
          <Box key="advice" flexShrink={1}>
            <Text color={advice?.tone ?? 'subtle'} wrap="truncate">{advice?.text ?? 'awaiting reading'} </Text>
          </Box>
        )}
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
