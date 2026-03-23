// packages/tw-daemon/src/harness/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessLoader } from './loader.js'

const HARNESS_A = `---
id: test-coverage
applies_to:
  - task
trigger_on:
  - review
---
# Test Coverage

All tasks must have test files.
`

const HARNESS_B = `---
id: api-docs
applies_to:
  - usecase
  - plan
trigger_on:
  - completed
---
# API Documentation

Usecases and plans must have linked documentation.
`

const HARNESS_MALFORMED = `not valid yaml frontmatter`

describe('HarnessLoader', () => {
  let harnessDir: string
  let loader: HarnessLoader

  beforeEach(() => {
    harnessDir = mkdtempSync(join(tmpdir(), 'tw-harness-'))
    writeFileSync(join(harnessDir, 'test-coverage.md'), HARNESS_A)
    writeFileSync(join(harnessDir, 'api-docs.md'), HARNESS_B)
    loader = new HarnessLoader(harnessDir)
  })
  afterEach(() => rmSync(harnessDir, { recursive: true }))

  it('scans and loads all harness files', async () => {
    const entries = await loader.scan()
    expect(entries).toHaveLength(2)
  })

  it('parses id, applies_to, trigger_on from frontmatter', async () => {
    await loader.scan()
    const entry = loader.get('test-coverage')
    expect(entry).toBeDefined()
    expect(entry!.id).toBe('test-coverage')
    expect(entry!.applies_to).toContain('task')
    expect(entry!.trigger_on).toContain('review')
  })

  it('content contains body without frontmatter', async () => {
    await loader.scan()
    const entry = loader.get('test-coverage')
    expect(entry!.content).toContain('All tasks must have test files')
    expect(entry!.content).not.toContain('applies_to')
  })

  it('list returns all loaded entries', async () => {
    await loader.scan()
    expect(loader.list()).toHaveLength(2)
  })

  it('get returns undefined for unknown id', async () => {
    await loader.scan()
    expect(loader.get('nonexistent')).toBeUndefined()
  })

  it('skips malformed files gracefully', async () => {
    writeFileSync(join(harnessDir, 'bad.md'), HARNESS_MALFORMED)
    await expect(loader.scan()).resolves.not.toThrow()
    // Still loads the 2 valid files
    expect(loader.list()).toHaveLength(2)
  })

  it('returns empty list when harness dir does not exist', async () => {
    const emptyLoader = new HarnessLoader('/nonexistent/path')
    const entries = await emptyLoader.scan()
    expect(entries).toEqual([])
  })
})
