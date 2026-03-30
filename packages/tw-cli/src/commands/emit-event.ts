import { Command } from 'commander'
import { IpcClient } from '../ipc-client.js'
import { getSocketPath } from '../daemon-manager.js'

export function emitEventCommand(): Command {
  const cmd = new Command('emit-event')
  cmd.description('Emit a custom event to entity span (appears in Jaeger + EventLog)')
  cmd.requiredOption('--entity-id <id>', 'Entity to attach event to')
  cmd.requiredOption('--event <name>', 'Event name (e.g. harness.evolution)')
  cmd.option('--attr <kv...>', 'Attributes as key=value pairs')
  cmd.option('--json', 'JSON output')
  cmd.action(async (opts: { entityId: string; event: string; attr?: string[]; json?: boolean }) => {
    try {
      const attributes: Record<string, string> = {}
      if (opts.attr) {
        for (const kv of opts.attr) {
          const eqIdx = kv.indexOf('=')
          if (eqIdx > 0) {
            attributes[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1)
          }
        }
      }

      const client = new IpcClient(getSocketPath(), 3000)
      const res = await client.send({
        method: 'emit_event',
        params: {
          entity_id: opts.entityId,
          event: opts.event,
          attributes,
        },
      })

      if (!res.ok) {
        console.error(`[tw] emit-event failed: ${res.error?.message ?? 'unknown'}`)
        process.exit(1)
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2))
      } else {
        console.log(`✓ Event "${opts.event}" emitted to ${opts.entityId}`)
      }
    } catch (err: any) {
      console.error(`[tw] ${err.message}`)
      process.exit(1)
    }
  })
  return cmd
}
