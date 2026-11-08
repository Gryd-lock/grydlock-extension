import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { execSync } from 'node:child_process'

const FREIGHTER_VERSION = '5.42.1'
const REPO_URL = `https://github.com/stellar/freighter/releases/download/${FREIGHTER_VERSION}/build-${FREIGHTER_VERSION}.zip`
const FIXTURES_DIR = path.resolve(process.cwd(), 'fixtures/wallets')
const EXTENSION_DIR = path.join(FIXTURES_DIR, 'freighter')
const ZIP_PATH = path.join(FIXTURES_DIR, 'freighter.zip')

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return downloadFile(res.headers.location, dest).then(resolve).catch(reject)
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download: HTTP ${res.statusCode} from ${url}`))
          return
        }
        const file = fs.createWriteStream(dest)
        res.pipe(file)
        file.on('finish', () => file.close(resolve))
      })
      .on('error', reject)
  })
}

async function setup() {
  if (fs.existsSync(EXTENSION_DIR)) {
    console.log(`Freighter v${FREIGHTER_VERSION} is already cached.`)
    return
  }

  fs.mkdirSync(FIXTURES_DIR, { recursive: true })
  console.log(`Downloading Freighter v${FREIGHTER_VERSION}...`)

  try {
    await downloadFile(REPO_URL, ZIP_PATH)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }

  console.log('Extracting extension...')
  fs.mkdirSync(EXTENSION_DIR, { recursive: true })

  try {
    execSync(`unzip -q ${ZIP_PATH} -d ${EXTENSION_DIR}`)
    fs.rmSync(ZIP_PATH)
    console.log('Freighter fixture ready.')
  } catch (error) {
    console.error('Failed to extract zip. The file might be corrupted.')
    fs.rmSync(ZIP_PATH, { force: true })
    process.exit(1)
  }
}

setup().catch(console.error)
