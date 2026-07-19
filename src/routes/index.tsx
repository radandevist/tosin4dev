import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Board } from "../domain/schemas";
import { useBoards, useCreateBoard } from "../queries/boards";

export const Route = createFileRoute("/")({ component: Home });

const EMPTY_FORM: Board = {
  slug: "",
  name: "",
  repoPath: "",
  defaultBaseBranch: "main",
};

function Home() {
  return (
    <main className="mx-auto max-w-3xl p-6 sm:p-8">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
          tosin4dev
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          The OS I need for dev — pick a board or create one.
        </p>
      </header>

      <CreateBoardForm />
      <BoardList />
    </main>
  );
}

function BoardList() {
  const boards = useBoards();

  return (
    <section className="mt-10" aria-labelledby="boards-heading">
      <h2
        id="boards-heading"
        className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase"
      >
        Boards
      </h2>

      {boards.isPending ? (
        <p className="text-sm text-zinc-500">Loading boards…</p>
      ) : boards.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          Could not load boards: {boards.error.message}
        </p>
      ) : boards.data.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">
          No boards yet. Create your first board above.
        </p>
      ) : (
        <ul className="space-y-2">
          {boards.data.map((board) => (
            <li key={board._id}>
              <Link
                to="/b/$boardSlug"
                params={{ boardSlug: board.slug }}
                className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
              >
                <span>
                  <span className="block font-medium text-zinc-900">
                    {board.name}
                  </span>
                  <span className="block font-mono text-xs text-zinc-400">
                    {board.slug}
                  </span>
                </span>
                <span className="font-mono text-xs text-zinc-500">
                  {board.defaultBaseBranch}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateBoardForm() {
  const queryClient = useQueryClient();
  const createBoard = useCreateBoard();
  const [form, setForm] = useState<Board>(EMPTY_FORM);

  const set = <K extends keyof Board>(key: K, value: Board[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    createBoard.mutate(form, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: useBoards.getKey() });
        setForm(EMPTY_FORM);
      },
    });
  };

  return (
    <section aria-labelledby="create-board-heading">
      <h2
        id="create-board-heading"
        className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase"
      >
        New board
      </h2>
      <form
        onSubmit={handleSubmit}
        className="grid gap-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm sm:grid-cols-2"
      >
        <Field label="Name" htmlFor="board-name">
          <input
            id="board-name"
            required
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Publy App"
            className={inputClass}
          />
        </Field>
        <Field
          label="Slug"
          htmlFor="board-slug"
          hint="lowercase letters, digits, hyphens"
        >
          <input
            id="board-slug"
            required
            pattern="[a-z0-9\-]+"
            value={form.slug}
            onChange={(e) => set("slug", e.target.value)}
            placeholder="publy-app"
            className={`${inputClass} font-mono`}
          />
        </Field>
        <Field label="Repo path" htmlFor="board-repo" hint="absolute host path">
          <input
            id="board-repo"
            required
            value={form.repoPath}
            onChange={(e) => set("repoPath", e.target.value)}
            placeholder="/home/radan/Projects/PublyApp"
            className={`${inputClass} font-mono`}
          />
        </Field>
        <Field label="Default base branch" htmlFor="board-branch">
          <input
            id="board-branch"
            required
            value={form.defaultBaseBranch}
            onChange={(e) => set("defaultBaseBranch", e.target.value)}
            placeholder="main"
            className={`${inputClass} font-mono`}
          />
        </Field>

        <div className="flex items-center gap-3 sm:col-span-2">
          <button
            type="submit"
            disabled={createBoard.isPending}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {createBoard.isPending ? "Creating…" : "Create board"}
          </button>
          {createBoard.isError ? (
            <p role="alert" className="text-sm text-rose-600">
              {createBoard.error.message}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900";

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block space-y-1">
      <span className="block text-sm font-medium text-zinc-700">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-zinc-400">{hint}</span> : null}
    </label>
  );
}
