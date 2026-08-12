import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import * as React from 'react'

import { login, logout, sessionStatus } from '../server/auth'
import { unwrapResult } from '../server/result'
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
          <AuthenticationGate>{children}</AuthenticationGate>
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

function AuthenticationGate({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const session = useQuery({
    queryKey: ['auth', 'session'],
    queryFn: () => sessionStatus().then(unwrapResult),
    retry: false,
  })
  const unlock = useMutation({
    mutationFn: (secret: string) => login({ data: { secret } }).then(unwrapResult),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['auth', 'session'] }),
  })
  const lock = useMutation({
    mutationFn: () => logout({ data: {} }).then(unwrapResult),
    onSuccess: () => queryClient.removeQueries({ queryKey: ['auth', 'session'] }),
  })

  if (session.isSuccess) {
    return (
      <>
        <div className="flex justify-end border-b border-zinc-200 bg-white px-6 py-2 sm:px-8">
          <button
            type="button"
            onClick={() => lock.mutate()}
            disabled={lock.isPending}
            className="text-sm font-medium text-zinc-600 hover:text-zinc-950 disabled:opacity-50"
          >
            {lock.isPending ? 'Locking…' : 'Lock'}
          </button>
        </div>
        {children}
      </>
    )
  }

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const secret = new FormData(form).get('secret')
    form.reset()
    if (typeof secret === 'string') unlock.mutate(secret)
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center p-6">
      <form
        onSubmit={submit}
        className="w-full space-y-5 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
            Unlock Tosin4dev
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Enter the local console secret to continue.
          </p>
        </div>
        <label className="block text-sm font-medium text-zinc-700" htmlFor="auth-secret">
          Secret
          <input
            id="auth-secret"
            name="secret"
            type="password"
            autoComplete="current-password"
            required
            className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={unlock.isPending || session.isPending}
          className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {unlock.isPending ? 'Unlocking…' : 'Unlock'}
        </button>
        {unlock.isError ? (
          <p role="alert" className="text-sm text-rose-600">
            {unlock.error.message}
          </p>
        ) : null}
      </form>
    </main>
  )
}
