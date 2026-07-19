import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'

import appCss from '../styles.css?url'

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      // A short default staleness keeps the local console from refetching on
      // every focus while still picking up supervisor-driven changes promptly.
      queries: { staleTime: 5_000 },
    },
  })
}

// Per-server-render vs. per-browser client. On the server we must never share a
// QueryClient across requests (one user's data would leak into another's), so a
// fresh client is made each render. In the browser we keep a single module-level
// singleton so cache survives re-renders and HMR.
let browserQueryClient: QueryClient | undefined
function getQueryClient() {
  if (typeof window === 'undefined') return makeQueryClient()
  if (!browserQueryClient) browserQueryClient = makeQueryClient()
  return browserQueryClient
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'tosin4dev',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  // useState initialiser runs once per component instance: one client per
  // browser tab, one per server render — never recreated on re-render.
  const [queryClient] = React.useState(getQueryClient)
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
