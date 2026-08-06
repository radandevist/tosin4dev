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
    // Loopback by default, deliberately. There is no auth anywhere in this app
    // and a server function can point a board at any absolute path and spawn a
    // workspace-write agent against it, so an open bind hands every host on the
    // LAN the ability to run code here. Reach it from the Windows client through
    // the SSH session instead of over the network:
    //   ssh -L 3141:localhost:3141 radan@192.168.0.68   → http://localhost:3141
    // DEV_HOST still overrides for the cases that genuinely need a wider bind.
    host: process.env.DEV_HOST ?? "127.0.0.1",
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
