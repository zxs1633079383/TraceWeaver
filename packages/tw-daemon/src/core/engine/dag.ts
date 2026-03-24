// packages/tw-daemon/src/core/engine/dag.ts

class DagError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DagError'
  }
}

export class Dag {
  // node → set of dependency node ids (what it depends ON)
  private readonly deps = new Map<string, Set<string>>()

  addNode(id: string): void {
    if (!this.deps.has(id)) this.deps.set(id, new Set())
  }

  addEdge(from: string, to: string): void {
    // from depends on to
    if (!this.deps.has(from)) this.addNode(from)
    if (!this.deps.has(to))   this.addNode(to)
    if (this.wouldCycle(from, to)) {
      throw new DagError('CYCLE_DETECTED', `CYCLE_DETECTED: Adding edge ${from}→${to} creates a cycle`)
    }
    this.deps.get(from)!.add(to)
  }

  removeNode(id: string): void {
    this.deps.delete(id)
    for (const deps of this.deps.values()) deps.delete(id)
  }

  getDependencies(id: string): string[] {
    return Array.from(this.deps.get(id) ?? [])
  }

  getDependents(id: string): string[] {
    const result: string[] = []
    for (const [node, deps] of this.deps) {
      if (deps.has(id)) result.push(node)
    }
    return result
  }

  /**
   * 沿反向边（被依赖方向）递归收集所有传递性依赖者。
   * 即：所有"依赖链最终到达 id"的节点集合。
   * 用于级联更新：当 UseCase 更新时，找出所有受影响的 Plan/Task。
   * DAG 边约定：from depends ON to（child → parent），
   * 因此本方法收集的是 id 的"下游"（所有可达 id 的节点）。
   */
  getTransitiveDependents(id: string): string[] {
    const result = new Set<string>()
    const queue = [id]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const [node, deps] of this.deps) {
        if (deps.has(current) && !result.has(node)) {
          result.add(node)
          queue.push(node)
        }
      }
    }
    return Array.from(result)
  }

  isReady(id: string, states: Map<string, string>): boolean {
    return this.getDependencies(id).every(dep => states.get(dep) === 'completed')
  }

  private wouldCycle(from: string, to: string): boolean {
    // BFS from `to` — if we can reach `from`, adding the edge creates a cycle
    const visited = new Set<string>()
    const queue = [to]
    while (queue.length > 0) {
      const node = queue.shift()!
      if (node === from) return true
      if (visited.has(node)) continue
      visited.add(node)
      for (const dep of this.deps.get(node) ?? []) queue.push(dep)
    }
    return false
  }
}
