import { Command } from 'commander'
import { IpcClient } from '../ipc-client.js'
import { ensureDaemonRunning, getSocketPath } from '../daemon-manager.js'

export function usecaseCommand(): Command {
  const cmd = new Command('usecase')
  cmd.description('UseCase lifecycle management')

  cmd.command('mutate')
    .description('Insert new downstream entities or update UseCase (triggering drain)')
    .requiredOption('--id <id>', 'UseCase id')
    .requiredOption('--type <type>', 'Mutation type: insert | update')
    .option('--context <text>', 'New context/requirements (for update)')
    .option('--entities <json>', 'JSON array of entities to register (for insert)')
    .option('--json', 'JSON output')
    .action(async (opts: any) => {
      try {
        await ensureDaemonRunning()
        const client = new IpcClient(getSocketPath())
        const params: Record<string, unknown> = {
          id: opts.id,
          mutation_type: opts.type,
        }
        if (opts.context) params.context = opts.context
        if (opts.entities) params.entities = JSON.parse(opts.entities)

        const res = await client.send({ method: 'usecase_mutate', params })
        if (res.ok) {
          if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }
          console.log(`UseCase ${opts.id} mutation (${opts.type}) applied.`)
          if ((res.data as any)?.registered_count) {
            console.log(`Registered ${(res.data as any).registered_count} new entities.`)
          }
        } else {
          console.error(res.error.message)
          process.exit(1)
        }
      } catch (e: any) {
        console.error(e.message)
        process.exit(1)
      }
    })

  cmd.command('replace')
    .description('Supersede entities and register new ones')
    .requiredOption('--id <id>', 'UseCase id')
    .requiredOption('--supersede <ids...>', 'Entity ids to supersede')
    .option('--new-entities <json>', 'JSON array of new entities to register')
    .option('--json', 'JSON output')
    .action(async (opts: any) => {
      try {
        await ensureDaemonRunning()
        const client = new IpcClient(getSocketPath())
        const params: Record<string, unknown> = {
          id: opts.id,
          supersede: opts.supersede,
        }
        if (opts.newEntities) params.new_entities = JSON.parse(opts.newEntities)

        const res = await client.send({ method: 'usecase_replace', params })
        if (res.ok) {
          if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }
          const data = res.data as any
          console.log(`Superseded ${data.superseded_count} entities, registered ${data.registered_count} new entities.`)
        } else {
          console.error(res.error.message)
          process.exit(1)
        }
      } catch (e: any) {
        console.error(e.message)
        process.exit(1)
      }
    })

  return cmd
}
