import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function impactCommand(): Command {
  return new Command('impact')
    .description('Analyze impact of artifact changes on entities')
    .argument('<artifact-ref>', 'Artifact path, optionally with section (e.g. ./prd.md#section-3)')
    .option('--json', 'Output as JSON')
    .action(async (ref, opts) => {
      try {
        await ensureDaemon()
        const [artifactPath, section] = ref.split('#')
        const res = await sendIpc({ method: 'resolve_impact', params: { artifact_path: artifactPath, section } })
        if (res.ok) {
          const result = (res as any).data as { directly_affected: Array<{ id: string; entity_type: string; state: string }>; transitively_affected: Array<{ id: string; entity_type: string; state: string }> }
          if (opts.json) { console.log(JSON.stringify(result, null, 2)); return }
          const directly = result.directly_affected ?? []
          const transitively = result.transitively_affected ?? []
          if (directly.length === 0 && transitively.length === 0) { console.log('No affected entities'); return }
          if (directly.length > 0) {
            console.log(`Directly affected (${directly.length}):`)
            for (const e of directly) {
              console.log(`  ${e.entity_type.padEnd(8)} ${e.id.padEnd(20)} ${e.state}`)
            }
          }
          if (transitively.length > 0) {
            console.log(`Transitively affected (${transitively.length}):`)
            for (const e of transitively) {
              console.log(`  ${e.entity_type.padEnd(8)} ${e.id.padEnd(20)} ${e.state}`)
            }
          }
        } else { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })
}
