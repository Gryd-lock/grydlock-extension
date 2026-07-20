import { build } from 'esbuild'
import { stat, appendFile } from 'node:fs/promises'

const entries = [
  { entry: 'src/intercept/mainWorldEntry.ts', outfile: 'dist/mainWorld.js' },
  { entry: 'src/intercept/bridgeEntry.ts', outfile: 'dist/bridge.js' },
  { entry: 'src/background/background.ts', outfile: 'dist/background.js' },
]

const sizeBudgets = [
  { outfile: 'dist/mainWorld.js', budgetBytes: 5 * 1024, label: 'mainWorld.js' },
  { outfile: 'dist/bridge.js', budgetBytes: 3 * 1024, label: 'bridge.js' },
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
      .map((result) => `${result.label} is ${formatBytes(result.size)} (budget ${formatBytes(result.budgetBytes)})`)
      .join(', ')}`,
  )
}
