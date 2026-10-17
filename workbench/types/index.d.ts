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

export type TestRunner = 'pest' | 'vitest'

export type TestStatus = 'running' | 'passed' | 'failed' | 'unknown'

/** The latest test run Claude started, read from the file its output is saved to. */
export type TestRun = {
  runner: TestRunner
  outputPath: string
  startedAt: number
  finishedAt?: number
  status: TestStatus
  passed: number
  failed: number
  skipped: number
  failures: string[]
  warnings: string[]
}

/** Packages with a security advisory, and outdated packages that have none. */
export type PackageCounts = { security: number; other: number }

export type DependencyReport = {
  isChecking: boolean
  checkedAt?: number
  composer?: PackageCounts
  npm?: PackageCounts
  errors: string[]
}

export type DeployState = 'running' | 'succeeded' | 'failed' | 'cancelled'

export type Deployment = {
  environment: string
  state: DeployState
  commit: string
  message: string
  startedAt?: string
  finishedAt?: string
  failureReason?: string
}

export type DeployReport = {
  isAvailable: boolean
  watchUntil?: number
  checkedAt?: number
  deployments: Deployment[]
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    workbench: {
      snapshot: UsageSnapshot | null
      cache: CacheState
      tick: number
      testRun: TestRun | null
      dependencies: DependencyReport
      deploys: DeployReport
      isBandHidden: boolean
    }
  }
}
