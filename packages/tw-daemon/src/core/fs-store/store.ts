// packages/tw-daemon/src/core/fs-store/store.ts
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import type { Entity, EntityType } from '@traceweaver/types'

export class FsStore {
  constructor(private readonly root: string) {}

  private typeToDir(type: EntityType): string {
    return type === 'usecase' ? 'usecases' : type === 'plan' ? 'plans' : 'tasks'
  }

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
    return join(this.root, this.typeToDir(type), id, `${type}.yaml`)
  }

  async writeEntity(entity: Entity): Promise<void> {
    const path = this.entityPath(entity.id, entity.entity_type)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, yaml.dump(entity), 'utf8')
  }

  async readEntity(id: string, type: EntityType): Promise<Entity | null> {
    const path = this.entityPath(id, type)
    try {
      const raw = await readFile(path, 'utf8')
      const loaded = yaml.load(raw)
      if (!loaded || typeof loaded !== 'object' || !('id' in loaded)) return null
      return loaded as Entity
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async listEntities(type: EntityType): Promise<Entity[]> {
    const base = join(this.root, this.typeToDir(type))
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
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
    try {
      await rm(path)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
  }
}
