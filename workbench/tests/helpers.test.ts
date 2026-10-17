import { describe, expect, test } from 'claude-code/testing'

import { changesDependencies, composerCounts, deployState, finishedSince, latestDeployment, npmCounts } from '../hooks/reports'
import { detectRunner, savedOutputPath, tallyOutput, withSavedOutput } from '../hooks/testRuns'

const PEST_PASSED = '\n  \u001b[90;1m.\u001b[39;22m\u001b[90;1m.\u001b[39;22m.\n\n  \u001b[90mTests:\u001b[39m    \u001b[32;1m990 passed\u001b[39;22m (4002 assertions)\n  Duration: 42.47s\n'
const PEST_FAILED = [
  '  ..⨯.s',
  '',
  '  FAILED  Tests\\Feature\\InvoiceTest > it soft deletes an invoice   ExpectationFailedException',
  '  SQLSTATE[53200]: Out of memory: out of shared memory',
  '',
  '  Tests:    1 failed, 3 passed, 1 skipped (9 assertions)',
].join('\n')
const VITEST_FAILED = ' FAIL  tests/js/Toggle.spec.js > Toggle > emits a boolean\n\n Test Files  1 failed | 9 passed (10)\n      Tests  2 failed | 118 passed (120)\n'

describe('dependency changes', () => {
  test('know which commands change the installed packages', async () => {
    expect(changesDependencies('npm ci')).toBe(true)
    expect(changesDependencies('npm install lodash')).toBe(true)
    expect(changesDependencies('composer update laravel/framework')).toBe(true)
    expect(changesDependencies('composer install')).toBe(true)
    expect(changesDependencies('npm run dev')).toBe(false)
  })
})

describe('test runs', () => {
  test('recognise the runners', async () => {
    expect(detectRunner('php artisan test --compact --filter=Invoice')).toBe('pest')
    expect(detectRunner('vendor/bin/pest tests/Unit')).toBe('pest')
    expect(detectRunner('npm run test:js')).toBe('vitest')
    expect(detectRunner('npx vitest run')).toBe('vitest')
    expect(detectRunner('npm run lint')).toBeUndefined()
  })

  test('find output a command already saves, and save it otherwise', async () => {
    expect(savedOutputPath('php artisan test > /tmp/test-output-1.txt 2>&1')).toBe('/tmp/test-output-1.txt')
    expect(savedOutputPath('php artisan test 2>&1 | tee /tmp/run.txt')).toBe('/tmp/run.txt')
    expect(savedOutputPath('php artisan test 2>/dev/null')).toBeUndefined()
    expect(withSavedOutput('php artisan test', '/tmp/x.txt')).toBe('( set -o pipefail; ( php artisan test\n) 2>&1 | tee /tmp/x.txt )')
  })

  test('tally Pest output, finished and in progress', async () => {
    expect(tallyOutput(PEST_PASSED, 'pest')).toMatchObject({ passed: 990, failed: 0, isComplete: true, failures: [] })

    const failed = tallyOutput(PEST_FAILED, 'pest')
    expect(failed).toMatchObject({ passed: 3, failed: 1, skipped: 1, isComplete: true })
    expect(failed.failures).toEqual(['Tests\\Feature\\InvoiceTest > it soft deletes an invoice'])
    expect(failed.warnings[0]).toMatch(/shared memory/)

    expect(tallyOutput('  ..⨯..\n', 'pest')).toMatchObject({ passed: 4, failed: 1, isComplete: false })
  })

  test('tally Vitest output', async () => {
    const tally = tallyOutput(VITEST_FAILED, 'vitest')

    expect(tally).toMatchObject({ passed: 118, failed: 2, isComplete: true })
    expect(tally.failures).toEqual(['tests/js/Toggle.spec.js > Toggle > emits a boolean'])
  })
})

describe('reports', () => {
  test('count composer packages with advisories apart from other updates', async () => {
    const audit = JSON.stringify({ advisories: { 'laravel/framework': [{}], 'symfony/yaml': [{}] }, abandoned: [] })
    const outdated = JSON.stringify({ locked: [{ name: 'laravel/framework' }, { name: 'altcha-org/altcha' }, { name: 'pestphp/pest' }] })

    expect(composerCounts(audit, outdated)).toEqual({ security: 2, other: 2 })
    expect(composerCounts(JSON.stringify({ advisories: [] }), JSON.stringify({ locked: [] }))).toEqual({ security: 0, other: 0 })
  })

  test('count npm packages with vulnerabilities apart from other updates', async () => {
    const audit = JSON.stringify({ vulnerabilities: { vite: {}, axios: {} }, metadata: { vulnerabilities: { total: 2 } } })
    const outdated = JSON.stringify({ vite: {}, vue: {}, pinia: {} })

    expect(npmCounts(audit, outdated)).toEqual({ security: 2, other: 2 })
    expect(npmCounts(JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }), '')).toEqual({ security: 0, other: 0 })
    expect(() => npmCounts('npm ERR!', '')).toThrow(/did not return JSON/)
  })

  test('read Laravel Cloud deployment states', async () => {
    expect(deployState('deployment.succeeded', '2026-10-15T09:38:26Z')).toBe('succeeded')
    expect(deployState('deployment.failed', '2026-10-15T09:38:26Z')).toBe('failed')
    expect(deployState('deployment.building', null)).toBe('running')

    const latest = latestDeployment('staging', JSON.stringify([
      { status: 'deployment.succeeded', commitHash: '3f4febc9aaaa', commitMessage: 'Fix it\n\nBody', startedAt: '2026-10-15T09:34:01Z', finishedAt: '2026-10-15T09:38:26Z' },
    ]))
    expect(latest).toMatchObject({ environment: 'staging', state: 'succeeded', commit: '3f4febc9', message: 'Fix it' })
  })

  test('notice deployments that finished since the last look', async () => {
    const running = { environment: 'staging', state: 'running', commit: 'aaaa', message: '', startedAt: 't1' } as const
    const done = { ...running, state: 'succeeded' } as const
    const older = { environment: 'production', state: 'succeeded', commit: 'bbbb', message: '', startedAt: 't0' } as const

    expect(finishedSince([running, older], [done, older])).toEqual([done])
    expect(finishedSince([], [done])).toEqual([])
  })
})
