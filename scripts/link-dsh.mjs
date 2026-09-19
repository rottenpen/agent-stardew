import { mkdir, readFile, symlink, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.argv[2] ?? process.env.DSH_SOURCE
if (!root) throw new Error('用法：node scripts/link-dsh.mjs <本机 dsh 源码目录>')
const paths = ['vendor/cordis', 'vendor/schemastery', 'packages/core/tools', 'packages/subprocess/subprocess', 'packages/skill/skill']
for (const path of paths) {
  const source = resolve(root, path)
  const pkg = JSON.parse(await readFile(`${source}/package.json`, 'utf8'))
  const target = resolve('packages/dsh-plugin/node_modules', pkg.name)
  await mkdir(resolve(target, '..'), { recursive: true })
  try { await lstat(target); continue } catch (e) { if (e.code !== 'ENOENT') throw e }
  await symlink(source, target, 'dir')
  console.log(`已连接 ${pkg.name}@${pkg.version}`)
}
