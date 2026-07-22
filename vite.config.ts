import { defineConfig } from 'vite'
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
})

export default config
