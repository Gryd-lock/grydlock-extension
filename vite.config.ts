import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [{ src: 'manifest.json', dest: '.' }],
    }),
  ],
  build: {
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
        history: 'src/history/index.html',
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    exclude: [...configDefaults.exclude, 'tests/visual/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/setupTests.ts',
        'src/vite-env.d.ts',
        'src/popup/main.tsx',
        'src/intercept/protocol.ts',
        'src/intercept/mainWorldEntry.ts',
        'src/intercept/bridgeEntry.ts',
        'src/background/background.ts',
      ],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 80,
        lines: 90,
      },
    },
  },
})
