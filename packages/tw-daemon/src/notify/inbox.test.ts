import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InboxAdapter } from './inbox.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('InboxAdapter', () => {
  let tmpDir: string
  let inbox: InboxAdapter

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'tw-inbox-'))
    inbox = new InboxAdapter(path.join(tmpDir, 'inbox'))
  })

  afterEach(() => rm(tmpDir, { recursive: true, force: true }))

  it('writes notification to inbox directory', async () => {
    const item = await inbox.write({
      event_type: 'entity.state_changed',
      entity_id: 'T-1',
      message: 'Task T-1 rejected'
    })
    expect(item.id).toBeDefined()
    expect(item.acked).toBe(false)
  })

  it('list returns all inbox items', async () => {
    await inbox.write({ event_type: 'entity.registered', entity_id: 'UC-1', message: 'UseCase UC-1 registered' })
    await inbox.write({ event_type: 'entity.state_changed', entity_id: 'T-2', message: 'Task T-2 completed' })
    const items = await inbox.list()
    expect(items).toHaveLength(2)
  })

  it('ack marks item as read', async () => {
    const item = await inbox.write({ event_type: 'git.commit', message: 'commit abc123' })
    await inbox.ack(item.id)
    const items = await inbox.list()
    expect(items.find(i => i.id === item.id)?.acked).toBe(true)
  })

  it('list with unackedOnly=true filters acked items', async () => {
    const i1 = await inbox.write({ event_type: 'git.commit', message: 'commit 1' })
    await inbox.write({ event_type: 'git.commit', message: 'commit 2' })
    await inbox.ack(i1.id)
    const unacked = await inbox.list({ unackedOnly: true })
    expect(unacked).toHaveLength(1)
  })

  it('list returns empty array for nonexistent directory', async () => {
    const emptyInbox = new InboxAdapter('/tmp/tw-nonexistent-inbox-xyz')
    expect(await emptyInbox.list()).toEqual([])
  })
})
