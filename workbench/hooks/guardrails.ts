/** A rule an action tripped: held for the person's approval, or refused outright. */
export type Hold = { rule: string; reason: string; isHardBlock?: true }

/** What a Bash rule needs to know beyond the command, found only when the command asks for it. */
export type BashContext = { isWorkingTreeDirty?: boolean; isPhpTestRunActive?: boolean }

/** Parallel test workers above this exhaust Postgres' lock table during teardown. */
export const MAX_TEST_PROCESSES = 6

const LEGACY_PEER_DEPS = /--legacy-peer-deps\b/
const DEPENDENCY_CHANGE = /\b(?:npm|pnpm|yarn)\s+(?:install|i|add|uninstall|remove|rm|update|up|upgrade|audit\s+fix)\b|\bcomposer\s+(?:require|remove|update|upgrade|bump)\b/
const PRODUCTION_BUILD = /\bnpm\s+run\s+build\b|\b(?:npx\s+)?vite\s+build\b/
const DESTRUCTIVE_DATABASE = /\bartisan\s+(migrate:fresh|migrate:refresh|migrate:reset|db:wipe)\b/
const WORK_DISCARDING_GIT = /\bgit\s+(?:checkout|switch|restore|reset\s+--hard|clean\s+-\w*f|stash\s+(?:drop|clear))\b/
const BRANCH_CREATION = /\bgit\s+(?:checkout\s+-[bB]|switch\s+-[cC])\b/
const PHP_TEST_RUN = /\b(?:artisan\s+test|vendor\/bin\/(?:pest|phpunit|paratest))\b/
const TEST_PROCESSES = /--processes[=\s]+(\d+)/

const ENV_FILE = /(?:^|\/)\.env(?:\.[^/]+)?$/
const ENV_EXAMPLE = /(?:^|\/)\.env\.example$/
const DEPENDENCY_MANIFEST = /(?:^|\/)(?:composer\.(?:json|lock)|package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml)$/
const MIGRATION_FILE = /(?:^|\/)database\/migrations\/[^/]+\.php$/

/** Whether the Bash rules need the working tree's state to judge `command`. */
export function needsDirtyCheck(command: string): boolean {
  return WORK_DISCARDING_GIT.test(command) && !BRANCH_CREATION.test(command)
}

/** Whether the Bash rules need to know if a PHP test run is already going. */
export function isPhpTestRun(command: string): boolean {
  return PHP_TEST_RUN.test(command)
}

/** Whether `command` changes the dependency tree, so the dependency counts need refreshing. */
export function changesDependencies(command: string): boolean {
  return DEPENDENCY_CHANGE.test(command) || /\b(?:npm\s+ci|composer\s+install)\b/.test(command)
}

/** The first rule `command` trips, most serious first. */
export function checkBash(command: string, context: BashContext = {}): Hold | undefined {
  if (LEGACY_PEER_DEPS.test(command)) {
    return { rule: 'legacy-peer-deps', reason: '--legacy-peer-deps breaks peer resolution and is never used.', isHardBlock: true }
  }

  if (DEPENDENCY_CHANGE.test(command)) {
    return { rule: 'dependencies', reason: 'This changes the dependency tree.' }
  }

  if (PRODUCTION_BUILD.test(command)) {
    return { rule: 'build', reason: 'This runs a production build; npm run dev is normally running.' }
  }

  const destructive = DESTRUCTIVE_DATABASE.exec(command)
  if (destructive !== null) {
    return { rule: 'database', reason: `${destructive[1]} destroys the database's data.` }
  }

  if (needsDirtyCheck(command) && context.isWorkingTreeDirty === true) {
    return { rule: 'git', reason: 'The working tree has uncommitted changes this could discard.' }
  }

  const processes = TEST_PROCESSES.exec(command)
  if (processes !== null && Number(processes[1]) > MAX_TEST_PROCESSES) {
    return { rule: 'test-workers', reason: `${processes[1]} test workers exhausts Postgres' locks; use ${MAX_TEST_PROCESSES} or fewer.` }
  }

  if (isPhpTestRun(command) && context.isPhpTestRunActive === true) {
    return { rule: 'concurrent-tests', reason: 'Another PHP test run is going; two runs wipe each other\'s database.' }
  }

  return undefined
}

/** The rule an edit to `path` trips; `isShippedMigration` says the file is on the default branch. */
export function checkFile(path: string, isShippedMigration = false): Hold | undefined {
  if (ENV_FILE.test(path) && !ENV_EXAMPLE.test(path)) {
    return { rule: 'env', reason: `${basename(path)} holds environment configuration.` }
  }

  if (DEPENDENCY_MANIFEST.test(path)) {
    return { rule: 'dependencies', reason: `${basename(path)} is a dependency manifest.` }
  }

  if (MIGRATION_FILE.test(path) && isShippedMigration) {
    return { rule: 'migration', reason: `${basename(path)} has shipped; production never re-runs an edited migration.` }
  }

  return undefined
}

export function isMigrationFile(path: string): boolean {
  return MIGRATION_FILE.test(path)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
