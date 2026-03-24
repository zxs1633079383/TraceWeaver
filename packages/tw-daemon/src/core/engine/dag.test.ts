// packages/tw-daemon/src/core/engine/dag.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { Dag } from './dag.js'

let dag: Dag

beforeEach(() => { dag = new Dag() })

describe('addNode / addEdge', () => {
  it('adds nodes and edges', () => {
    dag.addNode('A')
    dag.addNode('B')
    dag.addEdge('B', 'A') // B depends on A
    expect(dag.getDependencies('B')).toContain('A')
  })

  it('addNode is idempotent — does not clobber existing edges', () => {
    dag.addNode('A')
    dag.addNode('B')
    dag.addEdge('B', 'A')
    dag.addNode('B') // re-add should not reset edges
    expect(dag.getDependencies('B')).toContain('A')
  })
})

describe('getDependencies on unknown node', () => {
  it('returns empty array for unknown node', () => {
    expect(dag.getDependencies('UNKNOWN')).toEqual([])
  })
})

describe('getDependents', () => {
  it('returns all nodes that depend on given node', () => {
    dag.addNode('A')
    dag.addNode('B')
    dag.addNode('C')
    dag.addEdge('B', 'A')
    dag.addEdge('C', 'A')
    expect(dag.getDependents('A').sort()).toEqual(['B', 'C'])
  })
})

describe('isReady', () => {
  it('returns true when all dependencies are in completed states', () => {
    const states = new Map([['A', 'completed'], ['B', 'pending']])
    dag.addNode('A')
    dag.addNode('B')
    dag.addEdge('B', 'A')
    expect(dag.isReady('B', states)).toBe(true)
  })

  it('returns false when a dependency is not completed', () => {
    const states = new Map([['A', 'in_progress'], ['B', 'pending']])
    dag.addNode('A')
    dag.addNode('B')
    dag.addEdge('B', 'A')
    expect(dag.isReady('B', states)).toBe(false)
  })
})

describe('detectCycle', () => {
  it('detects circular dependency', () => {
    dag.addNode('A')
    dag.addNode('B')
    dag.addEdge('A', 'B')
    expect(() => dag.addEdge('B', 'A')).toThrow('CYCLE_DETECTED')
  })
})

describe('removeNode', () => {
  it('removes node and its edges', () => {
    dag.addNode('A')
    dag.addNode('B')
    dag.addEdge('B', 'A')
    dag.removeNode('A')
    expect(dag.getDependencies('B')).toHaveLength(0)
  })
})

describe('getTransitiveDependents', () => {
  // DAG 边约定：from depends ON to（child → parent）
  // getTransitiveDependents(id) 返回所有依赖链可达 id 的节点（即 id 的"下游"）

  it('returns direct dependents', () => {
    dag.addNode('uc')
    dag.addNode('plan-fe')
    dag.addNode('plan-be')
    dag.addEdge('plan-fe', 'uc') // plan-fe depends on uc
    dag.addEdge('plan-be', 'uc')
    expect(dag.getTransitiveDependents('uc').sort()).toEqual(['plan-be', 'plan-fe'])
  })

  it('returns transitive dependents across multiple levels', () => {
    dag.addNode('uc')
    dag.addNode('plan')
    dag.addNode('task-1')
    dag.addNode('task-2')
    dag.addEdge('plan', 'uc')
    dag.addEdge('task-1', 'plan')
    dag.addEdge('task-2', 'plan')
    const result = dag.getTransitiveDependents('uc').sort()
    expect(result).toEqual(['plan', 'task-1', 'task-2'])
  })

  it('returns empty array for leaf node with no dependents', () => {
    dag.addNode('task-leaf')
    expect(dag.getTransitiveDependents('task-leaf')).toEqual([])
  })

  it('returns empty array for unknown node', () => {
    expect(dag.getTransitiveDependents('UNKNOWN')).toEqual([])
  })

  it('does not include the node itself', () => {
    dag.addNode('uc')
    dag.addNode('plan')
    dag.addEdge('plan', 'uc')
    expect(dag.getTransitiveDependents('uc')).not.toContain('uc')
  })
})
