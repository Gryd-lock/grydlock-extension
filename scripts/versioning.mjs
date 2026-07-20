export function normalizeTagVersion(tag) {
  return tag.startsWith('v') ? tag.slice(1) : tag
}

export function assertMatchingVersions(packageVersion, manifestVersion) {
  if (packageVersion !== manifestVersion) {
    throw new Error(
      `Version mismatch: package.json is ${packageVersion} but manifest.json is ${manifestVersion}.`,
    )
  }
}

export function assertTagMatchesVersion(tag, version) {
  const normalized = normalizeTagVersion(tag)
  if (normalized !== version) {
    throw new Error(`Release tag ${tag} does not match project version ${version}.`)
  }
}

export function releaseArchiveName(version) {
  return `grydlock-extension-v${version}.zip`
}
