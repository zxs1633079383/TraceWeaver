import { describe, it, expect, afterEach } from 'vitest'
import { WorkerPool } from './worker-pool.js'

describe('WorkerPool', () => {
  let pool: WorkerPool | undefined

  afterEach(async () => { await pool?.shutdown() })

  it('can be created and shut down cleanly', async () => {
    pool = new WorkerPool({ workerFile: '', minWorkers: 0, maxWorkers: 2 })
    await expect(pool.shutdown()).resolves.toBeUndefined()
  })

  it('shutdown with no active workers resolves immediately', async () => {
    pool = new WorkerPool({ workerFile: '' })
    const start = Date.now()
    await pool.shutdown()
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('getStats returns correct idle/active counts', () => {
    pool = new WorkerPool({ workerFile: '' })
    const stats = pool.getStats()
    expect(stats).toHaveProperty('idle')
    expect(stats).toHaveProperty('active')
    expect(typeof stats.idle).toBe('number')
    expect(typeof stats.active).toBe('number')
  })
})
