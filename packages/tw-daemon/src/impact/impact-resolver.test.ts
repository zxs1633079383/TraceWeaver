// packages/tw-daemon/src/impact/impact-resolver.test.ts
import { describe, it, expect } from 'vitest'
import { ImpactResolver } from './impact-resolver.js'
import type { Entity } from '@traceweaver/types'

function e(id: string, artifactPaths: string[], dependsOn: string[] = []): Entity {
  return {
    id,
    entity_type: 'task',
    state: 'pending',
    artifact_refs: artifactPaths.map(p => ({ type: 'code', path: p })),
    depends_on: dependsOn,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

describe('ImpactResolver', () => {
  it('returns directly affected entities for a matching artifact path', () => {
    const entities = [
      e('task-a', ['src/auth.ts']),
      e('task-b', ['src/auth.ts', 'src/db.ts']),
      e('task-c', ['src/db.ts']),
    ]
    const resolver = new ImpactResolver()
    resolver.index(entities)
    const result = resolver.resolve('src/auth.ts')
    const directIds = result.directly_affected.map(e => e.id).sort()
    expect(directIds).toEqual(['task-a', 'task-b'])
  })

  it('returns transitively affected entities via depends_on', () => {
    const entities = [
      e('task-a', ['src/auth.ts']),
      e('task-b', [], ['task-a']),
      e('task-c', [], []),
    ]
    const resolver = new ImpactResolver()
    resolver.index(entities)
    const result = resolver.resolve('src/auth.ts')
    const directIds = result.directly_affected.map(e => e.id)
    const transitiveIds = result.transitively_affected.map(e => e.id)
    expect(directIds).toContain('task-a')
    expect(transitiveIds).toContain('task-b')
    expect(transitiveIds).not.toContain('task-a')
  })

  it('matches section-filtered paths', () => {
    const entities = [e('task-a', ['docs/prd.md'])]
    const resolver = new ImpactResolver()
    resolver.index(entities)
    expect(resolver.resolve('docs/prd.md').directly_affected).toHaveLength(1)
    expect(resolver.resolve('docs/prd.md', 'section-1').directly_affected).toHaveLength(1)
  })

  it('returns empty when no entity references the file', () => {
    const entities = [e('task-a', ['src/other.ts'])]
    const resolver = new ImpactResolver()
    resolver.index(entities)
    const result = resolver.resolve('src/auth.ts')
    expect(result.directly_affected).toHaveLength(0)
    expect(result.transitively_affected).toHaveLength(0)
  })
})
