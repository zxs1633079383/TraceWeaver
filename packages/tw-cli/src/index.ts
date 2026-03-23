// packages/tw-cli/src/index.ts
import { Command } from 'commander'
import { registerCommand } from './commands/register.js'
import { updateCommand }   from './commands/update.js'
import { statusCommand }   from './commands/status.js'
import { daemonCommand }   from './commands/daemon.js'
import { syncCommand }     from './commands/sync.js'

const program = new Command()
program
  .name('tw')
  .description('TraceWeaver — research process observability engine')
  .version('0.1.0')

registerCommand(program)
updateCommand(program)
statusCommand(program)
daemonCommand(program)
syncCommand(program)

program.parseAsync(process.argv).catch(e => { console.error(e); process.exit(1) })
