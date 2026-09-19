import { build } from 'esbuild'
import { run } from './environment.mjs'
await run(process.execPath, ['scripts/build.mjs'])
await build({ entryPoints: ['tests/support/mock-server.ts'], outfile: 'work/test-support/mock-server.mjs', bundle: true, external: ['ws'], platform: 'node', format: 'esm', target: 'node22' })
await run(process.execPath, ['--test', '--test-timeout=30000', 'tests/dsh/runtime.test.mjs'], { env: { ...process.env, NODE_OPTIONS: '' } })
