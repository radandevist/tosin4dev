import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-3xl font-semibold tracking-tight">tosin4dev</h1>
      <p className="mt-2 text-zinc-500">
        The OS I need for dev — boards go here.
      </p>
    </main>
  )
}
