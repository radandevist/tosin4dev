// defineConfig comes from vitest/config, not vite, so the `test` block below is
// typed. Keeping the test config HERE rather than in a separate vitest.config.ts
// is deliberate: vitest prefers vitest.config.ts and does not merge vite.config.ts
// into it, so a split file would silently drop the resolver and plugins below.
import { defineConfig } from 'vitest/config'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    // Bind so the dev server is reachable from the SSH Windows client
    // (192.168.0.248 → host 192.168.0.68). DEV_HOST=0.0.0.0 by default
    // (listen on all interfaces); set a hostname slug in .env to override.
    host: process.env.DEV_HOST ?? true,
    port: 3141,
    strictPort: true,
  },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
  test: {
    // The server smoke tests each connect a MongoClient and spawn git
    // subprocesses. Run files serially and allow 60s: under the default
    // parallel forks + 10s hookTimeout the suite failed nondeterministically
    // (13/4/10 files across three consecutive runs) purely from contention.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
})

export default config
