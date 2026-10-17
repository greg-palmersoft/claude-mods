import type { DeployState, Deployment, PackageCounts } from '../types'

type ComposerAudit = { advisories?: Record<string, unknown> | unknown[] }
type ComposerOutdated = { locked?: Array<{ name: string }>; installed?: Array<{ name: string }> }
type NpmAudit = { metadata?: { vulnerabilities?: { total?: number } }; vulnerabilities?: Record<string, unknown> }

export type CloudDeployment = {
  status?: string
  commitHash?: string | null
  commitMessage?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  failureReason?: string | null
}

/** Reads `composer audit --format=json` and `composer outdated --direct --format=json`. */
export function composerCounts(auditJson: string, outdatedJson: string): PackageCounts {
  const audit = parseJson<ComposerAudit>(auditJson, 'composer audit')
  const outdated = parseJson<ComposerOutdated>(outdatedJson, 'composer outdated')
  const vulnerable = Array.isArray(audit.advisories) ? [] : Object.keys(audit.advisories ?? {})
  const updates = outdated.locked ?? outdated.installed ?? []

  return { security: vulnerable.length, other: updates.filter(item => !vulnerable.includes(item.name)).length }
}

/** Reads `npm audit --json` and `npm outdated --json`; the latter prints nothing when all is current. */
export function npmCounts(auditJson: string, outdatedJson: string): PackageCounts {
  const audit = parseJson<NpmAudit>(auditJson, 'npm audit')
  const outdated = outdatedJson.trim() === '' ? {} : parseJson<Record<string, unknown>>(outdatedJson, 'npm outdated')
  const vulnerable = Object.keys(audit.vulnerabilities ?? {})

  return {
    security: audit.metadata?.vulnerabilities?.total ?? vulnerable.length,
    other: Object.keys(outdated).filter(name => !vulnerable.includes(name)).length,
  }
}

/** The state of a Laravel Cloud deployment, from its status and whether it finished. */
export function deployState(status: string | undefined, finishedAt: string | null | undefined): DeployState {
  const value = status ?? ''

  if (/fail|error/i.test(value)) {
    return 'failed'
  }

  if (/cancel/i.test(value)) {
    return 'cancelled'
  }

  if (/succeed|success/i.test(value)) {
    return 'succeeded'
  }

  return finishedAt ? 'succeeded' : 'running'
}

/** The latest deployment of `environment` from `cloud deployment:list --json`, newest first. */
export function latestDeployment(environment: string, json: string): Deployment | undefined {
  const [latest] = parseJson<CloudDeployment[]>(json, 'cloud deployment:list')

  if (latest === undefined) {
    return undefined
  }

  return {
    environment,
    state: deployState(latest.status, latest.finishedAt),
    commit: (latest.commitHash ?? '').slice(0, 8),
    message: (latest.commitMessage ?? '').split('\n')[0],
    startedAt: latest.startedAt ?? undefined,
    finishedAt: latest.finishedAt ?? undefined,
    failureReason: latest.failureReason ?? undefined,
  }
}

/** Deployments that finished since `previous` was read, as notices to raise. */
export function finishedSince(previous: Deployment[], current: Deployment[]): Deployment[] {
  return current.filter(deployment => {
    const before = previous.find(one => one.environment === deployment.environment)

    return deployment.state !== 'running'
      && before !== undefined
      && (before.state === 'running' || before.commit !== deployment.commit || before.startedAt !== deployment.startedAt)
  })
}

/** Formats how long ago `iso` was as `5m`, `3h` or `2d`. */
export function ago(iso: string | undefined, now: number): string {
  if (iso === undefined) {
    return ''
  }

  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))

  if (Number.isNaN(minutes)) {
    return ''
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  return minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`
}

function parseJson<T>(text: string, source: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${source} did not return JSON`)
  }
}
