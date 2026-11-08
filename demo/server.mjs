/* global console, process */
/**
 * Local test dApp for Gryd Lock. Serves demo/index.html plus the
 * grydlock-testkit transaction fixtures, so the extension can be exercised
 * against real testnet XDR without a wallet or network access.
 *
 *   npm run demo   ->   http://127.0.0.1:5174
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const testkitIndex = require.resolve('grydlock-testkit/transactions/index.json')
const testkitDir = path.dirname(testkitIndex)

const FIXTURES = new Set(['payment', 'path_payment', 'change_trust', 'fee_bump_payment'])

async function route(url) {
  if (url === '/' || url === '/index.html') {
    return { type: 'text/html; charset=utf-8', body: await readFile(path.join(here, 'index.html')) }
  }
  if (url === '/fixtures/index.json') {
    return { type: 'application/json', body: await readFile(testkitIndex) }
  }
  const match = /^\/fixtures\/([a-z_]+)\.xdr$/.exec(url)
  if (match && FIXTURES.has(match[1])) {
    return {
      type: 'text/plain; charset=utf-8',
      body: (await readFile(path.join(testkitDir, `${match[1]}.xdr`), 'utf8')).trim(),
    }
  }
  return null
}

export async function startDemoServer({ port = 5174, host = '127.0.0.1' } = {}) {
  const server = createServer((request, response) => {
    route(new URL(request.url ?? '/', 'http://x').pathname)
      .then((found) => {
        if (!found) {
          response.writeHead(404).end('not found')
          return
        }
        response.writeHead(200, { 'content-type': found.type, 'cache-control': 'no-store' })
        response.end(found.body)
      })
      .catch(() => response.writeHead(500).end('error'))
  })
  await new Promise((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await startDemoServer({ port: Number(process.env.PORT ?? 5174) })
  console.log(`Gryd Lock demo dApp: ${url}`)
}
