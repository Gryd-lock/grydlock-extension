/**
 * Stand-in for the grydlock-oracle-adapter package's getScore(destination).
 * The popup only depends on this function's signature — swap the body for
 * the real import once the adapter package is available.
 */
export async function getScore(destination: string): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 150))
  return stubScoreFor(destination)
}

function stubScoreFor(destination: string): number {
  let hash = 0
  for (let i = 0; i < destination.length; i++) {
    hash = (hash * 31 + destination.charCodeAt(i)) >>> 0
  }
  return hash % 101
}
