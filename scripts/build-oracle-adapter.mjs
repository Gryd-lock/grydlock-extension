/* global console, process */
/**
 * Builds the `grydlock-oracle-adapter` dependency in place after install.
 *
 * The adapter is installed from a commit-pinned GitHub source tarball (see
 * package.json). Its repository does not commit `dist/` and its `prepare`
 * script only installs git hooks, so a plain `github:` install yields an
 * empty package. This mirrors the adapter's own `scripts/build.mjs`
 * (esbuild bundle + tsc declarations) using this repo's toolchain, so the
 * extension imports the package through its normal `exports` map.
 *
 * Remove this script once the adapter publishes built artifacts.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve('node_modules/grydlock-oracle-adapter')
const entry = path.join(root, 'src/index.ts')

if (!existsSync(entry)) {
  console.warn(`[build-oracle-adapter] ${entry} not found; skipping (package not installed?)`)
  process.exit(0)
}

rmSync(path.join(root, 'dist'), { recursive: true, force: true })

const shared = {
  entryPoints: [entry],
  bundle: true,
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  external: ['@stellar/stellar-sdk'],
  logLevel: 'warning',
}

await Promise.all([
  build({ ...shared, format: 'esm', outfile: path.join(root, 'dist/esm/index.js') }),
  build({ ...shared, format: 'cjs', outfile: path.join(root, 'dist/cjs/index.js') }),
])

mkdirSync(path.join(root, 'dist/esm'), { recursive: true })
mkdirSync(path.join(root, 'dist/cjs'), { recursive: true })
writeFileSync(path.join(root, 'dist/esm/package.json'), '{ "type": "module" }\n')
writeFileSync(path.join(root, 'dist/cjs/package.json'), '{ "type": "commonjs" }\n')

const require = createRequire(import.meta.url)
const tsc = require.resolve('typescript/bin/tsc')
execFileSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.types.json')], {
  stdio: 'inherit',
})

console.log('[build-oracle-adapter] built node_modules/grydlock-oracle-adapter/dist')
