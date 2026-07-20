import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { releaseArchiveName } from './versioning.mjs'

const version = process.env.RELEASE_VERSION

if (!version) {
  throw new Error('RELEASE_VERSION is required to package a release archive.')
}

const releaseDir = new URL('../release/', import.meta.url)
await mkdir(releaseDir, { recursive: true })

const archivePath = new URL(`../release/${releaseArchiveName(version)}`, import.meta.url)

await new Promise((resolve, reject) => {
  const child = spawn('zip', ['-r', archivePath.pathname, '.'], {
    cwd: new URL('../dist/', import.meta.url).pathname,
    stdio: 'inherit',
  })

  child.on('error', reject)
  child.on('exit', (code) => {
    if (code === 0) resolve()
    else reject(new Error(`zip exited with code ${code}`))
  })
})

console.log(archivePath.pathname)
