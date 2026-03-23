import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'

export interface WorkerPoolOptions {
  workerFile: string
  minWorkers?: number
  maxWorkers?: number
}

export interface WorkerStats {
  idle: number
  active: number
}

export class WorkerPool {
  private readonly workerFile: string
  private readonly maxWorkers: number
  private readonly activeWorkers: Set<Worker> = new Set()
  private isShutdown = false

  constructor(opts: WorkerPoolOptions) {
    this.workerFile = opts.workerFile
    this.maxWorkers = opts.maxWorkers ?? Math.max(1, cpus().length - 1)
  }

  async run<I, O>(input: I): Promise<O> {
    if (this.isShutdown) throw new Error('WorkerPool is shut down')
    if (!this.workerFile) throw new Error('No worker file configured')

    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerFile, { workerData: input })
      this.activeWorkers.add(worker)

      worker.once('message', (result: O) => {
        this.activeWorkers.delete(worker)
        resolve(result)
      })

      worker.once('error', (err) => {
        this.activeWorkers.delete(worker)
        reject(err)
      })

      worker.once('exit', (code) => {
        this.activeWorkers.delete(worker)
        if (code !== 0) reject(new Error(`Worker exited with code ${code}`))
      })
    })
  }

  getStats(): WorkerStats {
    return { idle: 0, active: this.activeWorkers.size }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true
    await Promise.all([...this.activeWorkers].map(w => w.terminate()))
    this.activeWorkers.clear()
  }
}
