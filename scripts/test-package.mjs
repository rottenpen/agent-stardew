import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { root, run } from './environment.mjs'
await run(process.execPath, ['scripts/pack.mjs'])
await mkdir(join(root, 'work/tests'), { recursive: true })
const directory = await mkdtemp(join(root, 'work/tests/package-'))
const sdk = JSON.parse(await readFile(join(root, 'packages/dsh-plugin/package.json'), 'utf8')).devDependencies
const packages = { '@agent-stardew/protocol': 'agent-stardew-protocol-0.1.0.tgz', 'agent-stardew': 'agent-stardew-0.1.0.tgz', 'dsh-stardew': 'dsh-stardew-0.1.0.tgz' }
const dependencies = { ...sdk }
for (const [name, file] of Object.entries(packages)) dependencies[name] = `file:${join(root, 'work/release', file)}`
const overrides = { '@agent-stardew/protocol': dependencies['@agent-stardew/protocol'], 'agent-stardew': dependencies['agent-stardew'] }
await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies, overrides }, null, 2))
await run('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: directory, env: { ...process.env, NODE_OPTIONS: '' } })
// 确认运行时依赖只从隔离安装目录解析，不能回落到工作区的 node_modules。
const check = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const visited = new Set();
async function verify(file) {
  if (visited.has(file)) return; visited.add(file);
  assert.ok(file.startsWith(process.cwd() + '/node_modules/'), '依赖回落到工作区：' + file);
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/(?:from\\s*|import\\s*\\()(["'])((?:@deepseek-ai\\/|@agent-stardew\\/|agent-stardew)[^"']*)\\1/g)) await verify(createRequire(file).resolve(match[2]));
}
const pluginPath = require.resolve('dsh-stardew'); await verify(pluginPath);
const plugin = await import('dsh-stardew'); assert.equal(plugin.name, 'stardew');
assert.ok((await readFile(join(dirname(pluginPath), '../skills/stardew/SKILL.md'), 'utf8')).includes('stardew_snapshot'));
assert.ok((await readFile(join(dirname(pluginPath), 'types/index.d.ts'), 'utf8')).includes('apply'));
assert.ok((await readFile(join(dirname(pluginPath), '../ui/index.html'), 'utf8')).includes('/stardew/app.js'));
assert.ok((await readFile(join(dirname(pluginPath), '../ui/app.js'), 'utf8')).includes('/stardew/api/'));
assert.ok((await readFile(join(dirname(pluginPath), '../ui/style.css'), 'utf8')).includes('--wood'));
assert.ok((await readFile(join(dirname(pluginPath), '../ui/assets/welcome-farm-day-v1.png'))).length > 0);
const client = await readFile(require.resolve('dsh-stardew/client'), 'utf8');
assert.ok(client.includes('window.__ModuleLoader__.load'));
assert.ok(client.includes('conversation.session.header.utilities'));
assert.ok(client.includes('tool.call.toolview'));
console.log('发行包隔离加载、依赖闭包、类型声明、skill 与运行面板检查通过。');
`
await writeFile(join(directory, 'check.mjs'), check)
await run(process.execPath, ['check.mjs'], { cwd: directory, env: { ...process.env, NODE_OPTIONS: '' } })
await run(process.execPath, ['node_modules/agent-stardew/dist/bin.js', '--help'], { cwd: directory, env: { ...process.env, NODE_OPTIONS: '' } })
console.log(`隔离安装证据：${directory}`)
