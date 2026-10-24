import type { DeployState, Deployment, PackageCounts, PackageLines } from '../types'

type ComposerAudit = { advisories?: Record<string, unknown> | unknown[] }
type ComposerOutdated = { locked?: Array<{ name: string }>; installed?: Array<{ name: string }> }
type NpmAudit = { vulnerabilities?: Record<string, unknown> }
type NpmOutdated = Record<string, { type?: string }>

export type CloudDeployment = {
  status?: string
  commitHash?: string | null
  commitMessage?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  failureReason?: string | null
}

const DEPENDENCY_CHANGE = /\b(?:npm|pnpm|yarn)\s+(?:install|i|add|uninstall|remove|rm|update|up|upgrade|ci|audit\s+fix)\b|\bcomposer\s+(?:require|remove|update|upgrade|bump|install)\b/

/** Whether `command` changes the installed packages, so the dependency counts need refreshing. */
export function changesDependencies(command: string): boolean {
  return DEPENDENCY_CHANGE.test(command)
}

/**
 * Reads `composer audit --format=json` and `composer outdated --direct --format=json`, each run once
 * whole and once with `--no-dev`: what the `--no-dev` run reports ships to production, the rest is dev.
 */
export function composerCounts(audit: { all: string; production: string }, outdated: { all: string; production: string }): PackageLines {
  const advisories = (json: string): string[] => {
    const parsed = parseJson<ComposerAudit>(json, 'composer audit').advisories

    return Array.isArray(parsed) ? [] : Object.keys(parsed ?? {})
  }
  const updates = (json: string): string[] => {
    const parsed = parseJson<ComposerOutdated>(json, 'composer outdated')

    return (parsed.locked ?? parsed.installed ?? []).map(item => item.name)
  }
  const productionUpdates = updates(outdated.production)

  return splitLines(
    { all: advisories(audit.all), production: advisories(audit.production) },
    updates(outdated.all).map(name => ({ name, isDev: !productionUpdates.includes(name) })),
  )
}

/**
 * Reads `npm audit --json`, run once whole and once with `--omit=dev`, and `npm outdated --json --long`,
 * whose `type` names the section of package.json each package is in. The latter prints nothing when all is current.
 */
export function npmCounts(audit: { all: string; production: string }, outdatedJson: string): PackageLines {
  const advisories = (json: string): string[] => Object.keys(parseJson<NpmAudit>(json, 'npm audit').vulnerabilities ?? {})
  const outdated = outdatedJson.trim() === '' ? {} : parseJson<NpmOutdated>(outdatedJson, 'npm outdated')

  return splitLines(
    { all: advisories(audit.all), production: advisories(audit.production) },
    Object.entries(outdated).map(([name, item]) => ({ name, isDev: item.type === 'devDependencies' })),
  )
}

/** Splits advised and outdated packages into production and dev, counting an advised package as a security update only. */
function splitLines(advised: { all: string[]; production: string[] }, outdated: Array<{ name: string; isDev: boolean }>): PackageLines {
  const devAdvisories = advised.all.filter(name => !advised.production.includes(name))
  const others = (isDev: boolean): number => outdated
    .filter(item => item.isDev === isDev && !advised.all.includes(item.name))
    .length
  const line = (advisories: string[], isDev: boolean): PackageCounts => ({ security: advisories.length, other: others(isDev), advisories })

  return { production: line(advised.production, false), dev: line(devAdvisories, true) }
}

/** Production packages with an advisory, as `composer laravel/framework`, across both package managers. */
export function productionAdvisories(lines: { composer?: PackageLines; npm?: PackageLines }): string[] {
  return (['composer', 'npm'] as const).flatMap(manager => (lines[manager]?.production.advisories ?? []).map(name => `${manager} ${name}`))
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
