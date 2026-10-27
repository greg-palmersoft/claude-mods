import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, ToolCallResult } from 'claude-code'

import type { CacheState, DependencyReport, DeployReport, Deployment, PackageLines, TestRun, TestRunner, UsageSnapshot } from '../types'
import { changesDependencies, composerCounts, finishedSince, latestDeployment, npmCounts, productionAdvisories } from './reports'
import { Sidebar, bandChips } from './sidebar'
import type { WorkbenchData } from './sidebar'
import { detectRunner, outputPathFor, savedOutputPath, tallyOutput, withSavedOutput } from './testRuns'
import { LIMIT_LABELS, bar, cacheAge, compactAdvice, formatTokens, isPingDue, meterColour, orderLimits, untilReset } from './usage'

const snapshot = atom({ plugin: 'workbench', key: 'snapshot' } as const, null)
const cache = atom({ plugin: 'workbench', key: 'cache' } as const, { idlePings: 0 } as CacheState)
const tick = atom({ plugin: 'workbench', key: 'tick' } as const, 0)
const testRun = atom({ plugin: 'workbench', key: 'testRun' } as const, null as TestRun | null)
// Change the tag when the report's fields change: it declines what an earlier version stored.
const dependencies = atom({ plugin: 'workbench', key: 'dependencies' } as const, { isChecking: false, errors: [] } as DependencyReport, {
  shape: 'dependencies-2',
})
const deploys = atom({ plugin: 'workbench', key: 'deploys' } as const, { isAvailable: false, deployments: [] } as DeployReport)
const isBandHidden = atom({ plugin: 'workbench', key: 'isBandHidden' } as const, false)

const PANE = 'workbench'
const TICK_MS = 60_000
const TEST_POLL_MS = 2_000
const BACKGROUND_RUN_LIMIT_MS = 30 * 60_000
const DEPENDENCY_CHECK_MS = 6 * 60 * 60_000
const DEPLOY_CHECK_MS = 10 * 60_000
const DEPLOY_POLL_MS = 30_000
const DEPLOY_WATCH_MS = 20 * 60_000
const PING_PROMPT = 'Keep-alive ping to refresh the prompt cache. Reply with OK and nothing else.'
const DEPLOY_FIELDS = '--fields=status,commitHash,commitMessage,startedAt,finishedAt,failureReason'

let isPinging = false
let isCheckingDeploys = false
let stopTestPolling: (() => void) | undefined
let cloudEnvironments: Array<{ id: string; name: string }> | undefined

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs work nobody awaits, so a failure (or a reload part-way) is logged rather than left unhandled. */
function inBackground($: EngineInterface, work: Promise<void>): void {
  work.catch(error => {
    try {
      $.ui.log(`workbench: ${messageOf(error)}`, { to: 'debug' })
    } catch {
      // The module was unloaded while the work ran.
    }
  })
}

async function run($: EngineInterface, argv: string[], timeoutMs = 120_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return $.process.run(argv, { timeoutMs })
}

/* Usage, context and the prompt cache */

/** Reads the auto-compact threshold from a local estimate, which sends no requests. */
async function autoCompactThreshold($: EngineInterface): Promise<number | undefined> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })

    return context.breakdown?.isAutoCompactEnabled ? context.breakdown.autoCompactThreshold : undefined
  } catch {
    return undefined
  }
}

async function recordUsage(
  $: EngineInterface,
  figures: { context: SessionContextUsage; rateLimits: SessionRateLimit[] },
  isContextChanged: boolean,
): Promise<void> {
  const previous = await read($, snapshot)
  const threshold = isContextChanged || previous === null ? await autoCompactThreshold($) : previous.autoCompactThreshold
  const next: UsageSnapshot = {
    limits: figures.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    contextTokens: figures.context.tokens,
    contextWindow: figures.context.window,
    contextPercent: figures.context.percent,
    autoCompactThreshold: threshold,
  }

  await update($, snapshot, () => next)
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

/* Test runs */

async function refreshTestRun($: EngineInterface, isFinal: boolean, hasFailed = false): Promise<void> {
  const current = await read($, testRun)

  if (current === null || current.status !== 'running') {
    return
  }

  const now = await $.clock.now()
  const output = (await $.fs.exists(current.outputPath)) ? await $.fs.read(current.outputPath) : ''
  const tally = tallyOutput(output, current.runner)
  const isOverdue = now - current.startedAt > BACKGROUND_RUN_LIMIT_MS
  const isDone = tally.isComplete || isFinal || isOverdue
  const status = tally.isComplete
    ? (tally.failed > 0 ? 'failed' : 'passed')
    : (isFinal && hasFailed ? 'failed' : isDone ? 'unknown' : 'running')

  await update($, testRun, () => ({
    ...current,
    passed: tally.passed,
    failed: tally.failed,
    skipped: tally.skipped,
    failures: tally.failures,
    warnings: tally.warnings,
    status,
    finishedAt: isDone ? now : undefined,
  }))

  if (isDone) {
    stopTestPolling?.()
    stopTestPolling = undefined
  }
}

async function startTestRun($: EngineInterface, runner: TestRunner, outputPath: string): Promise<void> {
  stopTestPolling?.()
  const startedAt = await $.clock.now()
  await update($, testRun, () => ({
    runner, outputPath, startedAt, status: 'running', passed: 0, failed: 0, skipped: 0, failures: [], warnings: [],
  }))
  const timer = $.clock.every(TEST_POLL_MS, () => {
    inBackground($, refreshTestRun($, false))
  })
  stopTestPolling = () => timer.cancel()
}

/* Dependencies */

async function checkDependencies($: EngineInterface): Promise<void> {
  if ((await read($, dependencies)).isChecking) {
    return
  }

  const [hasComposer, hasNpm] = await Promise.all([$.fs.exists('composer.lock'), $.fs.exists('package-lock.json')])

  if (!hasComposer && !hasNpm) {
    const checkedAt = await $.clock.now()
    await update($, dependencies, () => ({ isChecking: false, checkedAt, errors: [] }))

    return
  }

  const previous = await read($, dependencies)
  await update($, dependencies, current => ({ ...current, isChecking: true }))
  const errors: string[] = []
  let composer: PackageLines | undefined
  let npm: PackageLines | undefined

  if (hasComposer) {
    try {
      const [audit, productionAudit, outdated, productionOutdated] = await Promise.all([
        run($, ['composer', 'audit', '--format=json', '--locked', '--no-interaction']),
        run($, ['composer', 'audit', '--format=json', '--locked', '--no-dev', '--no-interaction']),
        run($, ['composer', 'outdated', '--direct', '--locked', '--format=json', '--no-interaction']),
        run($, ['composer', 'outdated', '--direct', '--locked', '--no-dev', '--format=json', '--no-interaction']),
      ])
      composer = composerCounts(
        { all: audit.stdout, production: productionAudit.stdout },
        { all: outdated.stdout, production: productionOutdated.stdout },
      )
    } catch (error) {
      errors.push(`composer: ${messageOf(error)}`)
    }
  }

  if (hasNpm) {
    try {
      const [audit, productionAudit, outdated] = await Promise.all([
        run($, ['npm', 'audit', '--json']),
        run($, ['npm', 'audit', '--omit=dev', '--json']),
        run($, ['npm', 'outdated', '--json', '--long']),
      ])
      npm = npmCounts({ all: audit.stdout, production: productionAudit.stdout }, outdated.stdout)
    } catch (error) {
      errors.push(`npm: ${messageOf(error)}`)
    }
  }

  const checkedAt = await $.clock.now()
  await update($, dependencies, () => ({ isChecking: false, checkedAt, composer, npm, errors }))

  const seen = productionAdvisories(previous)
  const raised = productionAdvisories({ composer, npm }).filter(name => !seen.includes(name))
  if (raised.length > 0) {
    $.ui.toast(`⚠ Production security update${raised.length === 1 ? '' : 's'}: ${raised.join(', ')}`, { timeoutMs: 15_000 })
  }
}

/* Laravel Cloud deploys */

async function notifyFinished($: EngineInterface, deployment: Deployment): Promise<void> {
  const text = `${deployment.environment} deploy ${deployment.state}: ${deployment.commit} ${deployment.message}`.trim()
  $.ui.toast(text, { timeoutMs: 8000 })

  try {
    await $.ui.notify(text, { title: 'Laravel Cloud' })
  } catch {
    // The toast has already shown it.
  }
}

async function checkDeploys($: EngineInterface): Promise<void> {
  if (isCheckingDeploys) {
    return
  }

  if (!(await $.fs.exists('.cloud/config.json'))) {
    const checkedAt = await $.clock.now()
    await update($, deploys, current => ({ ...current, isAvailable: false, checkedAt, deployments: [], error: undefined }))

    return
  }

  isCheckingDeploys = true

  try {
    if (cloudEnvironments === undefined) {
      const listed = await run($, ['cloud', 'environment:list', '--json', '--fields=id,name', '--no-interaction'], 60_000)
      cloudEnvironments = JSON.parse(listed.stdout) as Array<{ id: string; name: string }>
    }

    const found = await Promise.all(cloudEnvironments.map(async environment => {
      const listed = await run($, ['cloud', 'deployment:list', environment.id, '--json', DEPLOY_FIELDS, '--no-interaction'], 60_000)

      return latestDeployment(environment.name, listed.stdout)
    }))
    const deployments = found.filter((one): one is Deployment => one !== undefined)
    const previous = await read($, deploys)
    const checkedAt = await $.clock.now()

    await update($, deploys, current => ({ ...current, isAvailable: true, checkedAt, deployments, error: undefined }))

    for (const deployment of finishedSince(previous.deployments, deployments)) {
      await notifyFinished($, deployment)
    }
  } catch (error) {
    const checkedAt = await $.clock.now()
    await update($, deploys, current => ({ ...current, isAvailable: true, checkedAt, error: `cloud: ${messageOf(error)}` }))
  } finally {
    isCheckingDeploys = false
  }
}

async function pollDeploys($: EngineInterface): Promise<void> {
  const report = await read($, deploys)
  const now = await $.clock.now()
  const isWatching = report.watchUntil !== undefined && report.watchUntil > now
  const isRunning = report.deployments.some(deployment => deployment.state === 'running')
  const isStale = report.checkedAt === undefined || now - report.checkedAt >= DEPLOY_CHECK_MS

  if (report.isAvailable && (isWatching || isRunning || isStale)) {
    await checkDeploys($)
  }
}

/** Bookkeeping once a command has run: never part of deciding whether it runs. */
async function afterCommand($: EngineInterface, command: string, ran: ToolCallResult, isForegroundTestRun: boolean): Promise<void> {
  const hasFailed = ran.deny !== undefined || ran.isError === true

  if (isForegroundTestRun) {
    await refreshTestRun($, true, hasFailed)
  }

  if (hasFailed) {
    return
  }

  if (changesDependencies(command)) {
    inBackground($, checkDependencies($))
  }

  if (/\bgit\s+push\b/.test(command)) {
    const now = await $.clock.now()
    await update($, deploys, current => ({ ...current, watchUntil: now + DEPLOY_WATCH_MS }))
    inBackground($, checkDeploys($))
  }
}

/* The sidebar and the band */

async function openSidebar($: EngineInterface): Promise<void> {
  try {
    const opened = await $.ui.open({ id: PANE, title: 'Workbench' })

    if (!opened.isPlaced) {
      $.ui.log(`workbench: the sidebar is waiting to be placed: ${opened.reason}`)
    }
  } catch (error) {
    $.ui.log(`workbench: the sidebar could not open: ${messageOf(error)}`)
  }
}

async function readData($: EngineInterface): Promise<WorkbenchData> {
  await read($, tick)

  return {
    snapshot: await read($, snapshot),
    cache: await read($, cache),
    testRun: await read($, testRun),
    dependencies: await read($, dependencies),
    deploys: await read($, deploys),
    now: await $.clock.now(),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await recordUsage($, await $.session.usage(), true)
    await $.command.register({ name: 'workbench', description: 'Open the Workbench sidebar and refresh its checks' })
    inBackground($, openSidebar($))

    $.clock.every(TICK_MS, () => {
      inBackground($, keepWarm($))
    })
    $.clock.every(DEPLOY_POLL_MS, () => {
      inBackground($, pollDeploys($))
    })
    $.clock.every(DEPENDENCY_CHECK_MS, () => {
      inBackground($, checkDependencies($))
    })
    inBackground($, checkDependencies($))
    inBackground($, checkDeploys($))

    return result
  })

  on('command.run', { command: 'workbench' }, async $ => {
    await openSidebar($)
    inBackground($, checkDependencies($))
    inBackground($, checkDeploys($))

    return { text: 'Workbench sidebar opened; refreshing dependencies and deploys.' }
  })

  on('session.measure', async ($, e, next) => {
    await recordUsage($, e, e.changed.includes('context'))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined && e.usage !== undefined) {
      const now = await $.clock.now()
      await update($, cache, () => ({ lastCachedAt: now, idlePings: 0 }))
    }

    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const runner = detectRunner(e.command)
    let command = e.command

    if (runner !== undefined) {
      const saved = savedOutputPath(e.command)
      const outputPath = saved ?? outputPathFor(runner, await $.clock.now())
      command = saved === undefined ? withSavedOutput(e.command, outputPath) : e.command
      await startTestRun($, runner, outputPath)
    }

    const ran: ToolCallResult = await next({ ...e, command })
    inBackground($, afterCommand($, e.command, ran, runner !== undefined && e.run_in_background !== true))

    return ran
  }).catch(($, e, next) => {
    $.ui.log(`workbench: test-run tracking failed (${next.error.message ?? next.error.kind}); the command ran as given.`, { to: 'debug' })

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const data = await readData($)

    return (
      <Sidebar
        ui={ui}
        data={data}
        actions={{ refreshDependencies: () => inBackground($, checkDependencies($)), refreshDeploys: () => inBackground($, checkDeploys($)) }}
      />
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const panes = await $.ui.panes()
    const sidebar = panes.find(pane => pane.id === PANE)
    const data = await readData($)

    if (e.props.hasSurvey || data.snapshot === null || (sidebar?.isPlaced === true && sidebar.isShown) || (await read($, isBandHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const figures = data.snapshot
    const advice = compactAdvice(figures)
    const age = cacheAge(data.cache, data.now)
    const contextColour = meterColour('context')

    return (
      <Box>
        {orderLimits(figures.limits).map(limit => {
          const resets = untilReset(limit.resetsAt, data.now)
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
          <Text color={contextColour}>ctx {bar(figures.contextPercent ?? 0)} {figures.contextPercent ?? '–'}%</Text>
          {figures.contextTokens !== undefined && (
            <Text color={contextColour} dimColor> {formatTokens(figures.contextTokens)}/{formatTokens(figures.contextWindow)}</Text>
          )}
        </Box>
        {age !== undefined && (
          <Box key="cache" marginRight={2}>
            <Text color={age.tone}>{age.text}</Text>
            {data.cache.idlePings > 0 && <Text color={age.tone} dimColor> ×{data.cache.idlePings}</Text>}
          </Box>
        )}
        {bandChips(data).map(chip => (
          <Box key={chip.key} marginRight={2}>
            <Text color={chip.tone}>{chip.text}</Text>
          </Box>
        ))}
        {advice !== undefined && advice.tone !== 'success' && (
          <Box key="advice" flexShrink={1} marginRight={1}>
            <Text color={advice.tone} wrap="truncate">{advice.text}</Text>
          </Box>
        )}
        <Button key="sidebar" label="Sidebar" onPress={() => inBackground($, openSidebar($))} />
        <Button key="hide" label="Hide" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })
}
