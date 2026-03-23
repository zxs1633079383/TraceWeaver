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
