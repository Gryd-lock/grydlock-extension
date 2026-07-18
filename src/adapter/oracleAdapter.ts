import { DEFAULT_GET_SCORE_TIMEOUT_MS } from './config';

/**
 * Retrieves a risk score for a destination with a configurable timeout.
 * If the operation exceeds the timeout, it resolves with a fallback score of -1.
 *
 * @param destination The destination address to score.
 * @param options Optional configuration: timeoutMs overrides the default timeout,
 *                signal allows external cancellation.
 */
export async function getScore(
  destination: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<number> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GET_SCORE_TIMEOUT_MS;
  const controller = new AbortController();
  const signal = options?.signal ?? controller.signal;

  // Create a timeout promise that aborts after the specified duration.
  const timeoutPromise = new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      // Abort any ongoing work and resolve with fallback.
      controller.abort();
      reject(new Error('Timeout'));
    }, timeoutMs);
    // Ensure timeout cleared if operation finishes first.
    signal.addEventListener('abort', () => clearTimeout(id));
  });

  // The actual score computation (stub) wrapped in a promise.
  const scorePromise = (async () => {
    // Simulate async work (the existing stub delay).
    await new Promise((resolve) => setTimeout(resolve, 150));
    return stubScoreFor(destination);
  })();

  try {
    const result = await Promise.race([scorePromise, timeoutPromise]);
    return result as number;
  } catch (e) {
    // On timeout, return fallback score.
    console.warn('getScore timeout for destination', destination);
    return -1; // fallback indicating unknown score
  }
}

function stubScoreFor(destination: string): number {
  let hash = 0
  for (let i = 0; i < destination.length; i++) {
    hash = (hash * 31 + destination.charCodeAt(i)) >>> 0
  }
  return hash % 101
}
