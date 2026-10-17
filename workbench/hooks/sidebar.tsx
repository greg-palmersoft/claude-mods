import type { EngineInterface } from 'claude-code'

import type { CacheState, DependencyReport, DeployReport, Deployment, GuardrailEvent, PackageCounts, TestRun, UsageSnapshot } from '../types'
import { ago } from './reports'
import { LIMIT_LABELS, bar, cacheAge, compactAdvice, formatTokens, meterColour, orderLimits, untilReset } from './usage'

type Ui = ReturnType<EngineInterface['ui']['resolve']>

export type WorkbenchData = {
  snapshot: UsageSnapshot | null
  cache: CacheState
  testRun: TestRun | null
  guardrails: GuardrailEvent[]
  dependencies: DependencyReport
  deploys: DeployReport
  now: number
}

export type SidebarActions = {
  refreshDependencies: () => void
  refreshDeploys: () => void
}

const DEPLOY_MARKS: Record<Deployment['state'], { mark: string; tone: 'success' | 'warning' | 'error' | 'subtle' }> = {
  running: { mark: '●', tone: 'warning' },
  succeeded: { mark: '✓', tone: 'success' },
  failed: { mark: '✗', tone: 'error' },
  cancelled: { mark: '–', tone: 'subtle' },
}

const RUNNER_LABELS: Record<TestRun['runner'], string> = { pest: 'Pest', vitest: 'Vitest' }

function clockTime(at: number): string {
  const date = new Date(at)

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function seconds(from: number, to: number): string {
  const total = Math.max(0, Math.round((to - from) / 1000))

  return total >= 60 ? `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s` : `${total}s`
}

function Heading({ ui, title, children }: { ui: Ui; title: string; children?: unknown }) {
  const { Box, Text } = ui

  return (
    <Box key={`heading-${title}`} marginTop={1} justifyContent="space-between">
      <Text bold>{title}</Text>
      {children}
    </Box>
  )
}

function UsageSection({ ui, data }: { ui: Ui; data: WorkbenchData }) {
  const { Box, Text } = ui
  const { snapshot, cache, now } = data

  if (snapshot === null) {
    return <Text key="usage-waiting" dimColor>Awaiting the first reading.</Text>
  }

  const advice = compactAdvice(snapshot)
  const age = cacheAge(cache, now)
  const contextColour = meterColour('context')

  return (
    <Box key="usage" flexDirection="column">
      {orderLimits(snapshot.limits).map(limit => {
        const resets = untilReset(limit.resetsAt, now)
        const colour = meterColour(limit.kind)

        return (
          <Box key={limit.kind}>
            <Text color={colour}>
              {(LIMIT_LABELS[limit.kind] ?? limit.kind).padEnd(4)}{bar(limit.percentUsed)} {Math.round(limit.percentUsed)}%
            </Text>
            {resets !== undefined && <Text color={colour} dimColor> {resets}</Text>}
          </Box>
        )
      })}
      <Box key="context">
        <Text color={contextColour}>ctx {bar(snapshot.contextPercent ?? 0)} {snapshot.contextPercent ?? '–'}%</Text>
        {snapshot.contextTokens !== undefined && (
          <Text color={contextColour} dimColor> {formatTokens(snapshot.contextTokens)}/{formatTokens(snapshot.contextWindow)}</Text>
        )}
      </Box>
      {age !== undefined && (
        <Box key="cache">
          <Text color={age.tone}>{age.text}</Text>
          {cache.idlePings > 0 && <Text color={age.tone} dimColor> ×{cache.idlePings} kept warm</Text>}
          {cache.pingError !== undefined && <Text color="error"> {cache.pingError}</Text>}
        </Box>
      )}
      {advice !== undefined && advice.tone !== 'success' && <Text key="advice" color={advice.tone}>{advice.text}</Text>}
    </Box>
  )
}

function TestsSection({ ui, data }: { ui: Ui; data: WorkbenchData }) {
  const { Box, Text } = ui
  const run = data.testRun

  if (run === null) {
    return <Text key="tests-none" dimColor>No test run this session.</Text>
  }

  const tone = run.status === 'passed' ? 'success' : run.status === 'failed' ? 'error' : run.status === 'running' ? 'warning' : 'subtle'
  const mark = run.status === 'passed' ? '✓' : run.status === 'failed' ? '✗' : run.status === 'running' ? '●' : '?'
  const counts = [
    run.passed > 0 ? `${run.passed} passed` : undefined,
    run.failed > 0 ? `${run.failed} failed` : undefined,
    run.skipped > 0 ? `${run.skipped} skipped` : undefined,
  ].filter(part => part !== undefined)

  return (
    <Box key="tests" flexDirection="column">
      <Box key="tests-summary">
        <Text color={tone}>{mark} {RUNNER_LABELS[run.runner]} {counts.join(' · ') || run.status}</Text>
        <Text dimColor> {seconds(run.startedAt, run.finishedAt ?? data.now)}</Text>
      </Box>
      <Text key="tests-output" dimColor wrap="truncate-start">{run.outputPath}</Text>
      {run.failures.slice(0, 8).map((failure, index) => (
        <Text key={`failure-${index}`} color="error" wrap="truncate">✗ {failure}</Text>
      ))}
      {run.failures.length > 8 && <Text key="failures-more" dimColor>…and {run.failures.length - 8} more</Text>}
      {run.warnings.map((warning, index) => (
        <Text key={`warning-${index}`} color="warning" wrap="wrap">⚠ {warning}</Text>
      ))}
    </Box>
  )
}

function PackageRow({ ui, name, counts }: { ui: Ui; name: string; counts: PackageCounts }) {
  const { Box, Text } = ui

  return (
    <Box key={name}>
      <Text>{name.padEnd(9)}</Text>
      <Text color={counts.security > 0 ? 'error' : 'success'}>{counts.security} security</Text>
      <Text dimColor> · </Text>
      <Text color={counts.other > 0 ? 'warning' : 'success'}>{counts.other} other</Text>
    </Box>
  )
}

function DependenciesSection({ ui, data }: { ui: Ui; data: WorkbenchData }) {
  const { Box, Text } = ui
  const report = data.dependencies

  return (
    <Box key="dependencies" flexDirection="column">
      {report.composer !== undefined && <PackageRow ui={ui} name="composer" counts={report.composer} />}
      {report.npm !== undefined && <PackageRow ui={ui} name="npm" counts={report.npm} />}
      {report.errors.map((error, index) => <Text key={`dependency-error-${index}`} color="error" wrap="wrap">{error}</Text>)}
      <Text key="dependencies-checked" dimColor>
        {report.isChecking ? 'Checking…' : report.checkedAt !== undefined ? `Checked ${clockTime(report.checkedAt)}` : 'Not checked yet'}
      </Text>
    </Box>
  )
}

function DeploysSection({ ui, data }: { ui: Ui; data: WorkbenchData }) {
  const { Box, Text } = ui
  const report = data.deploys
  const isWatching = report.watchUntil !== undefined && report.watchUntil > data.now

  return (
    <Box key="deploys" flexDirection="column">
      {report.deployments.map(deployment => {
        const { mark, tone } = DEPLOY_MARKS[deployment.state]

        return (
          <Box key={deployment.environment} flexDirection="column">
            <Box key="deploy-line">
              <Text color={tone}>{mark} {deployment.environment.padEnd(11)}</Text>
              <Text dimColor>{deployment.commit} {ago(deployment.finishedAt ?? deployment.startedAt, data.now)}</Text>
            </Box>
            {deployment.state === 'failed' && deployment.failureReason !== undefined && (
              <Text key="deploy-failure" color="error" wrap="wrap">  {deployment.failureReason}</Text>
            )}
          </Box>
        )
      })}
      {report.error !== undefined && <Text key="deploys-error" color="error" wrap="wrap">{report.error}</Text>}
      <Text key="deploys-checked" dimColor>
        {isWatching ? 'Watching after a push' : report.checkedAt !== undefined ? `Checked ${clockTime(report.checkedAt)}` : 'Not checked yet'}
      </Text>
    </Box>
  )
}

function GuardrailsSection({ ui, data }: { ui: Ui; data: WorkbenchData }) {
  const { Box, Text } = ui

  if (data.guardrails.length === 0) {
    return <Text key="guardrails-none" dimColor>Nothing held this session.</Text>
  }

  return (
    <Box key="guardrails" flexDirection="column">
      {data.guardrails.slice(-6).reverse().map((event, index) => (
        <Text key={`guardrail-${index}`} color={event.outcome === 'allowed' ? 'warning' : 'error'} wrap="truncate">
          {clockTime(event.at)} {event.outcome} · {event.reason}
        </Text>
      ))}
    </Box>
  )
}

/** The sidebar: one section per concern, each hidden where the project has nothing to show. */
export function Sidebar({ ui, data, actions }: { ui: Ui; data: WorkbenchData; actions: SidebarActions }) {
  const { Box, Button } = ui
  const hasDependencies = data.dependencies.composer !== undefined || data.dependencies.npm !== undefined
    || data.dependencies.errors.length > 0 || data.dependencies.isChecking

  return (
    <Box flexDirection="column">
      <Heading ui={ui} title="Usage" />
      <UsageSection ui={ui} data={data} />
      <Heading ui={ui} title="Tests" />
      <TestsSection ui={ui} data={data} />
      {hasDependencies && (
        <Heading ui={ui} title="Dependencies">
          <Button key="refresh-dependencies" label="Refresh" onPress={actions.refreshDependencies} />
        </Heading>
      )}
      {hasDependencies && <DependenciesSection ui={ui} data={data} />}
      {data.deploys.isAvailable && (
        <Heading ui={ui} title="Deploys">
          <Button key="refresh-deploys" label="Check" onPress={actions.refreshDeploys} />
        </Heading>
      )}
      {data.deploys.isAvailable && <DeploysSection ui={ui} data={data} />}
      <Heading ui={ui} title="Guardrails" />
      <GuardrailsSection ui={ui} data={data} />
    </Box>
  )
}

/** One-word states for the band shown while the sidebar is not. */
export function bandChips(data: WorkbenchData): Array<{ key: string; text: string; tone: 'success' | 'warning' | 'error' }> {
  const chips: Array<{ key: string; text: string; tone: 'success' | 'warning' | 'error' }> = []
  const run = data.testRun

  if (run !== null) {
    const isFailed = run.status === 'failed'
    chips.push({
      key: 'chip-tests',
      text: run.status === 'running' ? 'tests …' : isFailed ? `tests ✗${run.failed}` : `tests ✓${run.passed}`,
      tone: run.status === 'running' ? 'warning' : isFailed ? 'error' : 'success',
    })
  }

  const security = (data.dependencies.composer?.security ?? 0) + (data.dependencies.npm?.security ?? 0)
  if (security > 0) {
    chips.push({ key: 'chip-dependencies', text: `deps ${security}⚠`, tone: 'error' })
  }

  const deploy = data.deploys.deployments.find(one => one.state === 'running')
    ?? data.deploys.deployments.find(one => one.state === 'failed')
  if (deploy !== undefined) {
    chips.push({
      key: 'chip-deploy',
      text: `${deploy.environment} ${DEPLOY_MARKS[deploy.state].mark}`,
      tone: deploy.state === 'running' ? 'warning' : 'error',
    })
  }

  return chips
}
