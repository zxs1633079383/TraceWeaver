// packages/tw-cli/src/index.ts
import { Command } from 'commander'
import { registerCommand } from './commands/register.js'
import { updateCommand }   from './commands/update.js'
import { statusCommand }   from './commands/status.js'
import { daemonCommand }   from './commands/daemon.js'
import { syncCommand }     from './commands/sync.js'
import { inboxCommand }    from './commands/inbox.js'
import { eventsCommand }   from './commands/events.js'
import { dagCommand }      from './commands/dag.js'
import { impactCommand }   from './commands/impact.js'
import { logCommand }      from './commands/log.js'
import { metricsCommand }  from './commands/metrics.js'
import { harnessCommand }  from './commands/harness.js'
import { watchCommand }    from './commands/watch.js'
import { feedbackCommand }    from './commands/feedback.js'
import { taskmasterCommand } from './commands/taskmaster.js'
import { diagnoseCommand }   from './commands/diagnose.js'
import { traceCommand }     from './commands/trace.js'
import { reportCommand }    from './commands/report.js'

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
program.addCommand(inboxCommand())
program.addCommand(eventsCommand())
program.addCommand(dagCommand())
program.addCommand(impactCommand())
program.addCommand(logCommand())
program.addCommand(metricsCommand())
program.addCommand(harnessCommand())
program.addCommand(watchCommand())
program.addCommand(feedbackCommand())
program.addCommand(taskmasterCommand())
program.addCommand(diagnoseCommand())
program.addCommand(traceCommand())
program.addCommand(reportCommand())

program.parseAsync(process.argv).catch(e => { console.error(e); process.exit(1) })
