/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
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
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
  },
})
