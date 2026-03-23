import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function impactCommand(): Command {
  return new Command('impact')
    .description('Analyze impact of artifact changes on entities')
    .argument('<artifact-ref>', 'Artifact path, optionally with section (e.g. ./prd.md#section-3)')
    .action(async (ref) => {
      try {
        await ensureDaemon()
        const [artifactPath, section] = ref.split('#')
        const res = await sendIpc({ method: 'resolve_impact', params: { artifact_path: artifactPath, section } })
        if (res.ok) {
          const { affected } = (res as any).data as { affected: Array<{ id: string; entity_type: string; state: string }> }
          if (affected.length === 0) { console.log('No affected entities'); return }
          console.log(`Affected entities (${affected.length}):`)
          for (const e of affected) {
            console.log(`  ${e.entity_type.padEnd(8)} ${e.id.padEnd(20)} ${e.state}`)
          }
        } else { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })
}
