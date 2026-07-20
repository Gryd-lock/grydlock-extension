import { describe, it, expect, vi, beforeEach } from 'vitest';

import { resolveOutcome } from '../../intercept/resolveOutcome';
import { addTrustedAddress } from '../../utils/storageHelper';

// Mock chrome.storage
global.chrome = {
  storage: {
    local: {
      get: vi.fn((keys, callback) => {
        const result: any = {};
        if (keys.includes('trustedAddresses')) {
          result['trustedAddresses'] = [];
        }
        callback(result);
      }),
      set: vi.fn((obj, cb) => cb && cb()),
    },
  },
} as any;

describe('resolveOutcome', () => {
  const deps = {
    extractDestination: (xdr: string) => ({ destination: '0xABC', asset: undefined }),
    getScore: vi.fn().mockResolvedValue(42),
    requestDecision: vi.fn().mockResolvedValue('proceed' as any),
  };

  beforeEach(() => {
    (global.chrome.storage.local.get as any).mockClear();
    (global.chrome.storage.local.set as any).mockClear();
    deps.getScore.mockClear();
    deps.requestDecision.mockClear();
  });

  it('should allow when destination is trusted', async () => {
    await addTrustedAddress('0xABC');
    const outcome = await resolveOutcome('dummyXDR', deps);
    expect(outcome).toBe('allow');
    expect(deps.requestDecision).not.toHaveBeenCalled();
  });

  it('should request decision when destination is not trusted', async () => {
    const outcome = await resolveOutcome('dummyXDR', deps);
    expect(outcome).toBe('proceed');
    expect(deps.requestDecision).toHaveBeenCalledWith({
      destination: '0xABC',
      asset: undefined,
      score: 42,
    });
  });
});
