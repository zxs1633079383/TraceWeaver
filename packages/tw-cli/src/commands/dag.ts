import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function dagCommand(): Command {
  return new Command('dag')
    .description('Visualize entity dependency DAG')
    .argument('[entity-id]', 'Root entity ID (defaults to all)')
    .action(async (entityId) => {
      try {
        await ensureDaemon()
        const res = await sendIpc({ method: 'get_dag', params: { root_id: entityId } })
        if (res.ok) {
          const { nodes, edges } = (res as any).data
          console.log(`Nodes: ${nodes.length}, Edges: ${edges.length}`)
          for (const edge of edges) {
            console.log(`  ${edge.from} → ${edge.to}`)
          }
        } else { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })
}
