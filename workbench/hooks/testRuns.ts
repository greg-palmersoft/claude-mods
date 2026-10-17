import type { TestRunner } from '../types'

export type TestTally = {
  passed: number
  failed: number
  skipped: number
  failures: string[]
  warnings: string[]
  isComplete: boolean
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const PEST = /\b(?:artisan\s+test|vendor\/bin\/(?:pest|paratest|phpunit))\b/
const VITEST = /\b(?:vitest|npm\s+(?:run\s+)?test(?::\w+)?)\b/
const SAVED_OUTPUT = /(?:\btee\s+(?:-a\s+)?|(?:^|[^0-9&])>>?\s*)((?:\/private)?\/tmp\/[^\s;|&)]+)/
const COMPACT_PROGRESS = /^[.⨯!sdit]+$/

/** Environment trouble that shows in a run's output, and what it usually means. */
const ENVIRONMENT_SIGNS: Array<[RegExp, string]> = [
  [/SQLSTATE\[53200\]/, 'Postgres ran out of shared memory: use 6 or fewer workers'],
  [/Base table or view not found|relation "[^"]+" does not exist/, 'Tables vanished mid-run: another test run may have reset the database'],
  [/Unable to locate file in Vite manifest|ViteException/, 'Vite manifest error: the test needs withoutVite(), or npm run dev is down'],
  [/Allowed memory size of \d+ bytes exhausted/, 'Out of memory: run the suite with --parallel'],
]

export function detectRunner(command: string): TestRunner | undefined {
  if (PEST.test(command)) {
    return 'pest'
  }

  return VITEST.test(command) ? 'vitest' : undefined
}

/** The /tmp file the command already saves its output to, if it does. */
export function savedOutputPath(command: string): string | undefined {
  return SAVED_OUTPUT.exec(command)?.[1]
}

/** Wraps `command` so its output is also saved to `path`, keeping its exit status. */
export function withSavedOutput(command: string, path: string): string {
  return `( set -o pipefail; ( ${command}\n) 2>&1 | tee ${path} )`
}

export function outputPathFor(runner: TestRunner, now: number): string {
  return `/tmp/test-output-${runner}-${now}.txt`
}

/** Reads a run's output so far: its counts, failing tests and environment warnings. */
export function tallyOutput(raw: string, runner: TestRunner): TestTally {
  const text = raw.replace(ANSI, '')
  const tally = runner === 'pest' ? tallyPest(text) : tallyVitest(text)
  const warnings = ENVIRONMENT_SIGNS.filter(([sign]) => sign.test(text)).map(([, warning]) => warning)

  return { ...tally, warnings }
}

function tallyPest(text: string): Omit<TestTally, 'warnings'> {
  const failures = [...text.matchAll(/^\s*(?:FAILED|ERROR)\s+(.+?)(?:\s{2,}\S.*)?$/gm)].map(match => match[1].trim())
  const summary = /^\s*Tests:\s+(.+)$/m.exec(text)

  if (summary !== null) {
    return { ...countParts(summary[1].split(',')), failures, isComplete: true }
  }

  let passed = 0
  let failed = 0
  let skipped = 0

  for (const line of text.split('\n')) {
    const trimmed = line.trim()

    if (COMPACT_PROGRESS.test(trimmed)) {
      for (const mark of trimmed) {
        passed += mark === '.' ? 1 : 0
        failed += mark === '⨯' ? 1 : 0
        skipped += mark === 's' ? 1 : 0
      }
    } else if (trimmed.startsWith('✓')) {
      passed += 1
    } else if (trimmed.startsWith('⨯')) {
      failed += 1
    }
  }

  return { passed, failed, skipped, failures, isComplete: false }
}

function tallyVitest(text: string): Omit<TestTally, 'warnings'> {
  const failures = [...text.matchAll(/^\s*FAIL\s+(.+)$/gm)].map(match => match[1].trim())
  const summary = /^\s*Tests\s+(.+?)\s*\(\d+\)\s*$/m.exec(text)

  if (summary !== null) {
    return { ...countParts(summary[1].split('|')), failures, isComplete: true }
  }

  return { passed: 0, failed: 0, skipped: 0, failures, isComplete: false }
}

function countParts(parts: string[]): Pick<TestTally, 'passed' | 'failed' | 'skipped'> {
  const count = (word: RegExp): number => parts
    .map(part => new RegExp(`(\\d+)\\s+${word.source}`).exec(part))
    .reduce((sum, match) => sum + (match === null ? 0 : Number(match[1])), 0)

  return { passed: count(/passed/), failed: count(/(?:failed|errors?)/), skipped: count(/(?:skipped|todos?|incomplete)/) }
}
