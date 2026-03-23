// packages/tw-daemon/src/core/fs-store/store.ts
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import type { Entity, EntityType } from '@traceweaver/types'

export class FsStore {
  constructor(private readonly root: string) {}

  private entityPath(id: string, type: EntityType): string {
    // Phase 1 layout (flat by type):
    //   usecases/UC-001/usecase.yaml
    //   plans/FE-PLAN/plan.yaml
    //   tasks/BE-001/task.yaml
    //
    // NOTE: This diverges from the spec's nested layout
    // (plans/tasks nested under their parent usecase directory).
    // The nested layout will be adopted in Phase 4 when FS Watcher
    // needs to watch specific parent paths. For Phase 1, flat-by-type
    // is simpler and the functional behavior is identical.
    const dir = type === 'usecase' ? 'usecases' : type === 'plan' ? 'plans' : 'tasks'
    return join(this.root, dir, id, `${type}.yaml`)
  }

  async writeEntity(entity: Entity): Promise<void> {
    const path = this.entityPath(entity.id, entity.entity_type)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, yaml.dump(entity), 'utf8')
  }

  async readEntity(id: string, type: EntityType): Promise<Entity | null> {
    const path = this.entityPath(id, type)
    if (!existsSync(path)) return null
    const raw = await readFile(path, 'utf8')
    return yaml.load(raw) as Entity
  }

  async listEntities(type: EntityType): Promise<Entity[]> {
    const dir = type === 'usecase' ? 'usecases' : type === 'plan' ? 'plans' : 'tasks'
    const base = join(this.root, dir)
    if (!existsSync(base)) return []
    const entries = await readdir(base, { withFileTypes: true })
    const results: Entity[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const entity = await this.readEntity(entry.name, type)
      if (entity) results.push(entity)
    }
    return results
  }

  async deleteEntity(id: string, type: EntityType): Promise<void> {
    const path = this.entityPath(id, type)
    if (existsSync(path)) await rm(path)
  }
}
