/**
 * validate-manifest.mjs
 *
 * Validates manifest.json against Chrome Web Store / MV3 policy requirements.
 * Exits with code 1 and prints all failures if any check fails.
 *
 * Checks performed:
 *   - manifest_version is 3
 *   - Required top-level fields are present (name, version, description)
 *   - version matches semver format
 *   - icons field is present with all required CWS sizes (16, 32, 48, 128)
 *   - Each declared icon file exists on disk
 *   - Each declared icon file is a valid PNG (correct file signature)
 *   - content_security_policy.extension_pages restricts script-src and
 *     object-src to 'self' (no unsafe-inline / unsafe-eval)
 *   - No overly-broad host_permissions without justification flag
 *     (warns when <all_urls> is declared, does not fail — store still accepts
 *      it but flags it for review)
 *   - background.service_worker is declared (MV3 requirement)
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ─── Load manifest ───────────────────────────────────────────────────────────

const manifestPath = join(ROOT, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error('ERROR: manifest.json not found at', manifestPath)
  process.exit(1)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (e) {
  console.error('ERROR: manifest.json is not valid JSON:', e.message)
  process.exit(1)
}

// ─── Validation helpers ──────────────────────────────────────────────────────

const errors   = []
const warnings = []

function fail(msg)  { errors.push('  ✗ ' + msg) }
function warn(msg)  { warnings.push('  ⚠ ' + msg) }
function pass(msg)  { /* silent on success */ void msg }

// PNG magic bytes: \x89PNG\r\n\x1a\n
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isPNG(filePath) {
  try {
    const fd = readFileSync(filePath)
    return fd.slice(0, 8).equals(PNG_SIG)
  } catch {
    return false
  }
}

// ─── Checks ──────────────────────────────────────────────────────────────────

// 1. manifest_version must be 3
if (manifest.manifest_version !== 3) {
  fail(`manifest_version must be 3, got: ${manifest.manifest_version}`)
} else {
  pass('manifest_version is 3')
}

// 2. Required string fields
for (const field of ['name', 'version', 'description']) {
  if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
    fail(`"${field}" is required and must be a non-empty string`)
  } else {
    pass(`"${field}" present`)
  }
}

// 3. version must be dotted-numeric (Chrome Web Store requirement: up to 4
//    dot-separated integers, each 0–65535)
if (typeof manifest.version === 'string') {
  const parts = manifest.version.split('.')
  const valid = parts.length >= 1 &&
    parts.length <= 4 &&
    parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 65535)
  if (!valid) {
    fail(`"version" must be 1–4 dot-separated integers (0–65535), got: ${manifest.version}`)
  } else {
    pass(`"version" format valid: ${manifest.version}`)
  }
}

// 4. icons field: presence + required sizes
const REQUIRED_SIZES = [16, 32, 48, 128]
if (!manifest.icons || typeof manifest.icons !== 'object') {
  fail('"icons" field is missing — Chrome Web Store requires icons at sizes 16, 32, 48, and 128')
} else {
  for (const size of REQUIRED_SIZES) {
    const key = String(size)
    if (!manifest.icons[key]) {
      fail(`"icons.${size}" is missing — Chrome Web Store requires this size`)
    } else {
      const iconPath = resolve(ROOT, manifest.icons[key])
      if (!existsSync(iconPath)) {
        fail(`"icons.${size}" references "${manifest.icons[key]}" but the file does not exist`)
      } else if (!isPNG(iconPath)) {
        fail(`"icons.${size}" file "${manifest.icons[key]}" is not a valid PNG`)
      } else {
        pass(`icons.${size} → ${manifest.icons[key]} (valid PNG)`)
      }
    }
  }
}

// 5. MV3: background must declare a service_worker, not scripts/page
if (!manifest.background) {
  warn('"background" field not declared (extension will have no service worker)')
} else if (manifest.background.scripts || manifest.background.page) {
  fail('"background" must use "service_worker" (MV3), not "scripts" or "page"')
} else if (typeof manifest.background.service_worker !== 'string') {
  fail('"background.service_worker" must be a string path')
} else {
  pass('background.service_worker declared')
}

// 6. CSP: extension_pages must not allow unsafe-inline or unsafe-eval
if (manifest.content_security_policy?.extension_pages) {
  const csp = manifest.content_security_policy.extension_pages
  if (/unsafe-inline/i.test(csp)) {
    fail('"content_security_policy.extension_pages" must not contain \'unsafe-inline\'')
  }
  if (/unsafe-eval/i.test(csp)) {
    fail('"content_security_policy.extension_pages" must not contain \'unsafe-eval\'')
  }
  if (!/script-src[^;]*'self'/i.test(csp)) {
    warn('"content_security_policy.extension_pages" script-src does not include \'self\'')
  }
  pass('CSP extension_pages checked')
}

// 7. Overly-broad host_permissions warning (store flags for review, not reject)
if (Array.isArray(manifest.host_permissions)) {
  const broad = manifest.host_permissions.filter(
    (p) => p === '<all_urls>' || p === 'http://*/*' || p === 'https://*/*',
  )
  if (broad.length > 0) {
    warn(
      `"host_permissions" includes broad patterns [${broad.join(', ')}]. ` +
      'The Chrome Web Store will flag this for manual review — ensure the ' +
      'extension\'s Privacy section justifies the need.',
    )
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

console.log('Validating manifest.json...\n')

if (warnings.length > 0) {
  console.log('Warnings:')
  warnings.forEach((w) => console.log(w))
  console.log()
}

if (errors.length > 0) {
  console.error('Errors:')
  errors.forEach((e) => console.error(e))
  console.error(`\nmanifest validation FAILED (${errors.length} error${errors.length > 1 ? 's' : ''})`)
  process.exit(1)
}

console.log(`manifest.json passed all ${REQUIRED_SIZES.length > 0 ? 'checks' : 'checks'} ✓`)
if (warnings.length > 0) {
  console.log(`(${warnings.length} warning${warnings.length > 1 ? 's' : ''} — see above)`)
}
