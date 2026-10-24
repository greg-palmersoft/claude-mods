import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-17T10:00:00Z')

const PANE = {
  component: 'Pane',
  requestId: 'workbench',
  props: { placement: 'dock', bodyColumns: 48, bodyRows: 40, scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const CONTEXT = { tokens: 150_000, window: 200_000, percent: 75 }

const PEST_OUTPUT = '  ..⨯.\n\n  FAILED  Tests\\Feature\\InvoiceTest > it soft deletes   ExpectationFailedException\n\n  Tests:    1 failed, 3 passed (9 assertions)\n'

type World = { commands: string[]; files: Record<string, string>; toasts: string[]; settle: () => Promise<void> }

const PROJECT_FILES = ['/composer.lock', '/package-lock.json', '/.cloud/config.json']

/** The engine beneath the plugin: by default a project with a lock file each, on Laravel Cloud, and a clean tree. */
function world(on: On, projectFiles: string[] = PROJECT_FILES): World {
  const clock = mock.clock(on, { now: NOW })
  const state: World = { commands: [], files: {}, toasts: [], settle: () => clock.settle() }

  on('session.usage', () => ({ value: { startedAt: NOW, context: { ...CONTEXT }, rateLimits: [] } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({
    value: projectFiles.some(name => e.path.endsWith(name)) || e.path in state.files,
  }))
  on('fs.read', (_$, e) => ({ value: state.files[e.path] ?? '' }))
  on('process.run', (_$, e) => {
    const line = e.argv.join(' ')
    const isProduction = line.includes('--no-dev') || line.includes('--omit=dev')
    const stdout = line.startsWith('composer audit')
      ? JSON.stringify({ advisories: isProduction ? { 'laravel/framework': [{}] } : { 'laravel/framework': [{}], 'phpunit/phpunit': [{}] } })
      : line.startsWith('composer outdated')
        ? JSON.stringify({ locked: [{ name: 'laravel/framework' }, { name: 'guzzlehttp/guzzle' }, ...(isProduction ? [] : [{ name: 'pestphp/pest' }])] })
        : line.startsWith('npm audit')
          ? JSON.stringify({ vulnerabilities: isProduction ? {} : { vite: {} } })
          : line.startsWith('npm outdated')
            ? JSON.stringify({ vite: { type: 'devDependencies' }, tailwindcss: { type: 'devDependencies' }, vue: { type: 'dependencies' }, pinia: { type: 'dependencies' } })
            : line.startsWith('cloud environment:list')
              ? JSON.stringify([{ id: 'env-1', name: 'staging' }])
              : line.startsWith('cloud deployment:list')
                ? JSON.stringify([{ status: 'deployment.succeeded', commitHash: '3f4febc9ff', commitMessage: 'Ship it', startedAt: '2026-10-17T09:00:00Z', finishedAt: '2026-10-17T09:04:00Z' }])
                : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    state.commands.push(e.command)
    const saved = /tee (\S+) \)$/.exec(e.command)?.[1]

    if (saved !== undefined) {
      state.files[saved] = PEST_OUTPUT
    }

    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  on('ui.render', { component: 'Pane' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box key="engine" />
  })

  return state
}

describe('commands', () => {
  test('run straight through, with nothing held for approval', async ($, on) => {
    const state = world(on)
    on('tool.call', { tool: 'AskUserQuestion' }, () => {
      throw new Error('no question should be asked')
    })

    const ran = await $.tool.call({ tool: 'Bash', command: 'npm install lodash' })

    expect(ran.deny).toBeUndefined()
    expect(state.commands).toEqual(['npm install lodash'])
  })
})

describe('test runs', () => {
  test('saves a Pest run\'s output to /tmp and reads its result', async ($, on) => {
    const state = world(on)

    await $.tool.call({ tool: 'Bash', command: 'php artisan test --compact' })
    await state.settle()

    expect(state.commands[0]).toMatch(/^\( set -o pipefail; \( php artisan test --compact\n\) 2>&1 \| tee \/tmp\/test-output-pest-\d+\.txt \)$/)

    const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /✗ Pest 3 passed · 1 failed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /InvoiceTest > it soft deletes/ })).toBeDefined()
    await ui.unmount()
  })

  test('keeps a command that already saves its output as it is', async ($, on) => {
    const state = world(on)

    await $.tool.call({ tool: 'Bash', command: 'php artisan test > /tmp/test-output-mine.txt 2>&1' })

    expect(state.commands).toEqual(['php artisan test > /tmp/test-output-mine.txt 2>&1'])
  })
})

describe('the sidebar', () => {
  test('shows usage, dependency counts and deploys once checked', async ($, on) => {
    const state = world(on)

    await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })
    await state.settle()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'workbench', surface, ...PANE })

      expect(await ui.find({ type: 'Text', text: /^ctx .*75%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Dependencies' })).toBeDefined()
      expect(await ui.find({ key: 'production-security' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'composer laravel/framework' })).toBeDefined()
      expect(await ui.find({ key: 'composer-prod' })).toBeDefined()
      expect(await ui.find({ key: 'composer-dev' })).toBeDefined()
      expect(await ui.find({ key: 'npm-prod' })).toBeDefined()
      expect((await ui.findAll({ type: 'Text', text: '1 security' })).length).toBe(3)
      expect((await ui.findAll({ type: 'Text', text: '1 other' })).length).toBe(3)
      expect(await ui.find({ type: 'Text', text: '2 other' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /✓ staging/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /3f4febc9/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('shows the dependencies and deploys sections, with their buttons, before anything is checked', async ($, on) => {
    world(on)

    const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...PANE })

    expect(await ui.find({ type: 'Text', text: 'Dependencies' })).toBeDefined()
    expect(await ui.find({ key: 'refresh-dependencies' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Deploys' })).toBeDefined()
    expect(await ui.find({ key: 'refresh-deploys' })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: 'Not checked yet' })).toHaveLength(2)
    await ui.unmount()
  })

  test('says so when the project has no lock file or Laravel Cloud project', async ($, on) => {
    const state = world(on, [])

    await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })
    await state.settle()

    const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...PANE })

    expect(await ui.find({ type: 'Text', text: 'No composer.lock or package-lock.json here' })).toBeDefined()
    expect(await ui.find({ key: 'refresh-dependencies' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No Laravel Cloud project here (.cloud/config.json)' })).toBeDefined()
    expect(await ui.find({ key: 'refresh-deploys' })).toBeDefined()
    await ui.unmount()
  })

  test('flags production security updates once each, and not dev ones', async ($, on) => {
    const state = world(on)

    await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })
    await state.settle()
    expect(state.toasts.filter(text => text.includes('Production security'))).toEqual(['⚠ Production security update: composer laravel/framework'])

    await $.command.run({ command: 'workbench', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await state.settle()
    expect(state.toasts.filter(text => text.includes('Production security')).length).toBe(1)
  })
})

describe('the band', () => {
  const BAND = {
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 160, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  } as const

  test('stands in for the sidebar while it is not shown, and steps aside once it is', async ($, on) => {
    const state = world(on)
    let panes: Array<{ id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }> = []
    on('ui.panes', () => ({ value: panes }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box } = $.ui.resolve(e)

      return <Box key="engine" />
    })

    await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })
    await state.settle()

    const band = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...BAND })
    expect(await band.find({ type: 'Text', text: 'prod deps 1⚠' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'dev deps 2⚠' })).toBeDefined()
    expect(await band.find({ key: 'sidebar' })).toBeDefined()
    await band.unmount()

    panes = [{ id: 'workbench', title: 'Workbench', isShown: true, isFocused: false, isPlaced: true }]
    const hidden = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...BAND })
    expect(await hidden.find({ key: 'sidebar' })).toBeUndefined()
    expect(await hidden.find({ key: 'engine' })).toBeDefined()
    await hidden.unmount()
  })
})
