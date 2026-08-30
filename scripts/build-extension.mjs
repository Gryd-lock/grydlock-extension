import { build } from 'esbuild'
import { stat, appendFile } from 'node:fs/promises'

const entries = [
  { entry: 'src/intercept/mainWorldEntry.ts', outfile: 'dist/mainWorld.js' },
  { entry: 'src/intercept/albedoMainWorldEntry.ts', outfile: 'dist/albedoMainWorld.js' },
  { entry: 'src/intercept/bridgeEntry.ts', outfile: 'dist/bridge.js' },
  { entry: 'src/background/background.ts', outfile: 'dist/background.js' },
]

const sizeBudgets = [
  // Raised from 5.00 KB alongside the one-shot signing protocol: mainWorld.js now
  // shares requestOutcome.ts (adapter tag, page-side absolute deadline) instead of
  // an inlined helper. Still tight enough to catch an accidental SDK/page-library pull-in.
  { outfile: 'dist/mainWorld.js', budgetBytes: 5.5 * 1024, label: 'mainWorld.js' },
  // The Albedo entry includes the popup-specific interception implementation plus the
  // closed-set protection heartbeat. Keep the budget tight enough to detect SDK or
  // page-library regressions; the Stellar SDK must remain background-only.
  // Raised from 6.00 KB for the same shared requestOutcome.ts helper as mainWorld.js.
  { outfile: 'dist/albedoMainWorld.js', budgetBytes: 6.5 * 1024, label: 'albedoMainWorld.js' },
  // The isolated bridge owns the versioned handshake and strict message validation.
  // Raised from 4.00 KB: the bridge now runs the SIGN_REQUEST -> SIGN_ACK -> AWAIT_OUTCOME
  // resume/retry loop (awaitOutcome.ts) instead of a single blocking sendMessage callback,
  // so it can survive a worker restart mid-review. Still well under mainWorld's budget.
  { outfile: 'dist/bridge.js', budgetBytes: 5.5 * 1024, label: 'bridge.js' },
]

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`
}

await Promise.all(
  entries.map(({ entry, outfile }) =>
    build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'iife',
      target: 'chrome111',
      sourcemap: true,
      logLevel: 'info',
    }),
  ),
)

const budgetResults = await Promise.all(
  sizeBudgets.map(async ({ outfile, budgetBytes, label }) => {
    const { size } = await stat(outfile)
    return { label, size, budgetBytes, withinBudget: size <= budgetBytes }
  }),
)

console.log('\nContent script bundle size budgets:')
for (const result of budgetResults) {
  const status = result.withinBudget ? 'OK' : 'OVER BUDGET'
  console.log(
    `  ${status} ${result.label}: ${formatBytes(result.size)} / ${formatBytes(result.budgetBytes)}`,
  )
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = budgetResults
    .map(
      (result) =>
        `| ${result.label} | ${formatBytes(result.size)} | ${formatBytes(result.budgetBytes)} | ${
          result.withinBudget ? 'OK' : 'Over budget'
        } |`,
    )
    .join('\n')

  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### Content Script Bundle Sizes',
      '',
      '| Bundle | Size | Budget | Status |',
      '| --- | ---: | ---: | --- |',
      rows,
      '',
    ].join('\n'),
  )
}

const failures = budgetResults.filter((result) => !result.withinBudget)
if (failures.length > 0) {
  throw new Error(
    `Content script bundle size budget exceeded: ${failures
      .map(
        (result) =>
          `${result.label} is ${formatBytes(result.size)} (budget ${formatBytes(result.budgetBytes)})`,
      )
      .join(', ')}`,
  )
}
