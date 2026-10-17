import { describe, expect, mock, test } from 'claude-code/testing'

import { MAX_IDLE_PINGS, bar, cacheAge, compactAdvice, isPingDue, meterColour, untilReset } from '../hooks/usage'

const NOW = Date.parse('2026-10-12T10:00:00Z')

const PANE = {
  component: 'Pane',
  requestId: 'workbench',
  props: { placement: 'dock', bodyColumns: 48, bodyRows: 40, scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const MEASURE = {
  context: { tokens: 150_000, window: 200_000, percent: 75 },
  rateLimits: [
    { kind: 'seven_day', percentUsed: 41.5, resetsAt: '2026-10-15T14:00:00Z' },
    { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-12T12:14:00Z' },
  ],
  changed: ['context', 'rateLimits'],
} as const

describe('format helpers', () => {
  test('bars fill in proportion and clamp', async () => {
    expect(bar(50, 10)).toBe('█████░░░░░')
    expect(bar(140, 4)).toBe('████')
    expect(bar(-5, 4)).toBe('░░░░')
  })

  test('reset times read as days, hours or minutes', async () => {
    expect(untilReset('2026-10-12T12:14:00Z', NOW)).toBe('2h14m')
    expect(untilReset('2026-10-15T14:00:00Z', NOW)).toBe('3d4h')
    expect(untilReset('2026-10-12T10:09:00Z', NOW)).toBe('9m')
    expect(untilReset(undefined, NOW)).toBeUndefined()
  })

  test('compact advice escalates against the auto-compact threshold', async () => {
    const at = (tokens: number) => compactAdvice({ limits: [], contextTokens: tokens, contextWindow: 200_000, autoCompactThreshold: 160_000 })

    expect(at(40_000)?.tone).toBe('success')
    expect(at(90_000)?.text).toMatch(/next break/)
    expect(at(120_000)?.text).toMatch(/Compact soon/)
    expect(at(140_000)?.text).toMatch(/Compact now/)
    expect(compactAdvice({ limits: [], contextWindow: 200_000 })).toBeUndefined()
  })

  test('each meter has its own colour', async () => {
    const colours = ['five_hour', 'seven_day', 'context'].map(meterColour)

    expect(new Set(colours).size).toBe(3)
  })

  test('a large context suggests compacting even with room to spare', async () => {
    expect(compactAdvice({ limits: [], contextTokens: 450_000, contextWindow: 1_000_000 })?.text).toMatch(/next break/)
  })
})

const MINUTE = 60_000

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 100_000,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
}

const FORK_REPLY = {
  isAnswered: true,
  text: 'OK',
  usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 },
} as const

describe('cache helpers', () => {
  test('the age reads in minutes and tones toward lapsing', async () => {
    expect(cacheAge({ idlePings: 0 }, NOW)).toBeUndefined()
    expect(cacheAge({ lastCachedAt: NOW - 12 * MINUTE, idlePings: 0 }, NOW)).toEqual({ tone: 'success', text: 'cache 12m' })
    expect(cacheAge({ lastCachedAt: NOW - 45 * MINUTE, idlePings: 0 }, NOW)).toEqual({ tone: 'warning', text: 'cache 45m' })
    expect(cacheAge({ lastCachedAt: NOW - 61 * MINUTE, idlePings: 0 }, NOW)).toEqual({ tone: 'error', text: 'cache cold' })
  })

  test('a ping is due between thirty minutes and the lapse, up to the cap', async () => {
    expect(isPingDue({ lastCachedAt: NOW - 29 * MINUTE, idlePings: 0 }, NOW)).toBe(false)
    expect(isPingDue({ lastCachedAt: NOW - 30 * MINUTE, idlePings: 0 }, NOW)).toBe(true)
    expect(isPingDue({ lastCachedAt: NOW - 60 * MINUTE, idlePings: 0 }, NOW)).toBe(false)
    expect(isPingDue({ lastCachedAt: NOW - 30 * MINUTE, idlePings: MAX_IDLE_PINGS }, NOW)).toBe(false)
    expect(isPingDue({ idlePings: 0 }, NOW)).toBe(false)
  })
})

describe('keeping the cache warm', () => {
  test('pings an idle cache through a fork, then stops at the cap', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const forks: string[] = []
    on('session.usage', () => ({ value: { startedAt: NOW, context: { ...MEASURE.context }, rateLimits: [] } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('fs.exists', () => ({ value: false }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('model.fork', (_$, e) => {
      forks.push(e.prompt)

      return { value: FORK_REPLY }
    })
    on('ui.render', { component: 'Pane' }, ($, e) => {
      const { Box } = $.ui.resolve(e)

      return <Box key="engine" />
    })

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', usage: USAGE })

    await clock.advance(29 * MINUTE)
    expect(forks).toHaveLength(0)

    const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'cache 29m' })).toBeDefined()

    await clock.advance(MINUTE)
    expect(forks).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: 'cache 0m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' ×1 kept warm' })).toBeDefined()

    await clock.advance(10 * 30 * MINUTE)
    expect(forks).toHaveLength(MAX_IDLE_PINGS)
    expect(await ui.find({ type: 'Text', text: 'cache cold' })).toBeDefined()

    await $.turn.complete({ answer: 'back', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer', usage: USAGE })
    expect(await ui.find({ type: 'Text', text: /kept warm/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a subagent turn does not count as the cache being used', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    on('session.usage', () => ({ value: { startedAt: NOW, context: { ...MEASURE.context }, rateLimits: [] } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('fs.exists', () => ({ value: false }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('ui.render', { component: 'Pane' }, ($, e) => {
      const { Box } = $.ui.resolve(e)

      return <Box key="engine" />
    })

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', usage: USAGE })
    await clock.advance(20 * MINUTE)
    await $.turn.complete({ answer: 'sub', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer', usage: USAGE, agentId: 'a1' })

    const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'cache 20m' })).toBeDefined()
    await ui.unmount()
  })
})

