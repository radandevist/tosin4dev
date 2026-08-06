import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Board } from "../domain/schemas";
import { useBoards, useCreateBoard } from "../queries/boards";
import { useBrowse } from "../queries/browse";

export const Route = createFileRoute("/")({ component: Home });

export const DEFAULT_BOARD: Board = {
  slug: "",
  name: "",
  repoPath: "",
  defaultBaseBranch: "develop",
  checks: [],
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
                    {board.repoPath}
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
  const [form, setForm] = useState<Board>(DEFAULT_BOARD);
  const [pickerOpen, setPickerOpen] = useState(false);

  const set = <K extends keyof Board>(key: K, value: Board[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    createBoard.mutate(form, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: useBoards.getKey() });
        setForm(DEFAULT_BOARD);
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
        <Field
          label="Repo path"
          htmlFor="board-repo"
          hint="absolute host path"
        >
          <div className="flex gap-2">
            <input
              id="board-repo"
              required
              value={form.repoPath}
              onChange={(e) => set("repoPath", e.target.value)}
              placeholder="/home/radan/Projects/PublyApp"
              className={`${inputClass} font-mono`}
            />
            <button
              type="button"
              aria-expanded={pickerOpen}
              aria-controls="repo-path-picker"
              onClick={() => setPickerOpen((open) => !open)}
              className="shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
            >
              {pickerOpen ? "Close" : "Browse"}
            </button>
          </div>
          {pickerOpen ? (
            <RepoPathPicker onPick={(path) => set("repoPath", path)} />
          ) : null}
        </Field>
        <Field label="Default base branch" htmlFor="board-branch">
          <input
            id="board-branch"
            required
            value={form.defaultBaseBranch}
            onChange={(e) => set("defaultBaseBranch", e.target.value)}
            placeholder="develop"
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

// The inline file explorer for the repo path field. The free-text input stays
// usable even when this errors, so a failed read degrades to typing the path
// rather than blocking board creation. Navigating into a directory and picking
// it are deliberately separate actions: a row click moves you down a level, and
// only "Pick this folder" writes the path — otherwise there would be no way to
// select a folder that also has children.
function RepoPathPicker({ onPick }: { onPick: (path: string) => void }) {
  const [current, setCurrent] = useState<string | undefined>(undefined);
  // The picker lists the current directory. `current` is deliberately NOT
  // derived from `value`: the free-text field and the picker navigate
  // independently, and only an explicit pick copies the picker's location into
  // the field. react-query-kit builds the query key as [queryKey, variables],
  // so changing `current` changes the key and TanStack refetches automatically.
  const browse = useBrowse({ variables: { path: current } });

  const isRoot = browse.data ? browse.data.parent === null : false;

  const pick = () => {
    if (browse.data) onPick(browse.data.path);
  };

  const navigate = (path: string) => {
    setCurrent(path);
  };

  return (
    <div
      id="repo-path-picker"
      className="mt-2 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs text-zinc-600">
          {browse.data ? browse.data.path : current ?? "…"}
        </span>
        <div className="flex shrink-0 gap-2">
          {isRoot ? null : (
            <button
              type="button"
              onClick={() => browse.data?.parent && navigate(browse.data.parent)}
              className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
            >
              Up
            </button>
          )}
          <button
            type="button"
            disabled={!browse.data || browse.isPending}
            onClick={pick}
            className="rounded-lg bg-zinc-900 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Pick this folder
          </button>
        </div>
      </div>

      {browse.isPending ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : browse.isError ? (
        // A failed read must not render as an empty directory — the two are
        // indistinguishable to the operator otherwise, and the free-text field
        // above remains the escape hatch.
        <p role="alert" className="text-sm text-rose-600">
          Could not browse: {browse.error.message}
        </p>
      ) : browse.data.entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-400">
          No subdirectories
        </p>
      ) : (
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {browse.data.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => navigate(entry.path)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm text-zinc-800 transition-colors hover:bg-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
              >
                <span className="truncate font-mono">{entry.name}</span>
                {entry.isGitRepo ? (
                  <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                    git
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
