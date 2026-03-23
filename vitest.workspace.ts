import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/tw-daemon/vitest.config.ts',
  'packages/tw-types/vitest.config.ts',
  'packages/tw-cli/vitest.config.ts',
])
