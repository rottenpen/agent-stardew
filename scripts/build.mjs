import { build } from 'esbuild'
import { chmod, cp, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const declarations = spawnSync(process.execPath, [tsc, '--project', 'tsconfig.build.json'], { stdio: 'inherit' })
if (declarations.status !== 0) throw new Error('类型声明生成失败。')

for (const name of ['protocol', 'cli', 'dsh-plugin']) {
  await cp(`work/types/${name}/src`, `packages/${name}/dist/types`, { recursive: true })
  await build({
    entryPoints: [`packages/${name}/src/${name === 'cli' ? 'bin' : 'index'}.ts`],
    outdir: `packages/${name}/dist`,
    bundle: true, packages: 'external', external: ['@agent-stardew/protocol'], platform: 'node', format: 'esm', target: 'node22',
    sourcemap: true,
  })
}
await chmod('packages/cli/dist/bin.js', 0o755)
// dsh 浏览器插件复用宿主的 React 和 UI 组件，通过模块工厂注册。
await build({
  entryPoints: ['packages/dsh-plugin/src/client/index.tsx'], outfile: 'packages/dsh-plugin/dist/client.js',
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', sourcemap: true,
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'], loader: { '.css': 'text' },
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-stardew", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
})
await mkdir('packages/dsh-plugin/ui/assets', { recursive: true })
for (const file of ['welcome-farm-day-v1.png', 'agent-farmer-idle-v1.png', 'app-icon-chicken-whale-v1.png']) {
  await cp(`assets/visual/${file}`, `packages/dsh-plugin/ui/assets/${file}`)
}
