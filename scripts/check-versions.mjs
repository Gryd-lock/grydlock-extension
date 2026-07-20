import { readFile } from 'node:fs/promises'
import { assertMatchingVersions, assertTagMatchesVersion } from './versioning.mjs'

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

const [{ version: packageVersion }, { version: manifestVersion }] = await Promise.all([
  readJson(new URL('../package.json', import.meta.url)),
  readJson(new URL('../manifest.json', import.meta.url)),
])

assertMatchingVersions(packageVersion, manifestVersion)

const releaseTag = process.env.RELEASE_TAG
if (releaseTag) {
  assertTagMatchesVersion(releaseTag, packageVersion)
}

console.log(`Version check passed: ${packageVersion}`)
