import { useState } from "react";
import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Board, BoardCheck } from "../../domain/schemas";
import type { TicketDTO } from "../../server/tickets";
import { useBoard, useUpdateBoardChecks } from "../../queries/boards";
import { useCreateChatSession } from "../../queries/chat";
import { useTickets } from "../../queries/tickets";
import {
  BOARD_COLUMNS,
  groupTicketsByStatus,
  TicketCard,
} from "../../components/TicketCard";

export const Route = createFileRoute("/b/$boardSlug")({ component: BoardPage });

function BoardPage() {
  const { boardSlug } = Route.useParams();
  const board = useBoard({ variables: { slug: boardSlug } });
  const navigate = useNavigate();
  const createChat = useCreateChatSession();
  const [chatProvider, setChatProvider] = useState<"claude" | "codex">(
    "claude",
  );

  // The ticket list depends on the board's id, which only exists once the board
  // query resolves. `enabled` gates the dependent query until then and the typed
  // `boardId` is only read inside a `board.data` guard, so it is never undefined.
  const boardId = board.data?._id;
  const tickets = useTickets({
    variables: { boardId: boardId ?? "" },
    enabled: Boolean(boardId),
  });
  const startBrainstorm = () => {
    if (!boardId || createChat.isPending) return;
    createChat.mutate(
      { boardId, provider: chatProvider },
      {
        onSuccess: ({ id }) =>
          navigate({
            to: "/b/$boardSlug/chat/$sessionId",
            params: { boardSlug, sessionId: id },
          }),
      },
    );
  };

  return (
    <main className="mx-auto max-w-[100rem] p-4 sm:p-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            to="/"
            className="text-xs text-zinc-500 hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            ← All boards
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">
            {board.data ? board.data.name : boardSlug}
          </h1>
        </div>
        {board.data ? (
          <div className="flex gap-2">
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <select
                  aria-label="Brainstorm provider"
                  value={chatProvider}
                  disabled={createChat.isPending}
                  onChange={(event) =>
                    setChatProvider(event.target.value as "claude" | "codex")
                  }
                  className="rounded-lg border border-zinc-300 bg-white px-2 py-2 text-sm text-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-50"
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
                <button
                  type="button"
                  disabled={createChat.isPending}
                  onClick={startBrainstorm}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-50"
                >
                  {createChat.isPending ? "Starting…" : "Brainstorm"}
                </button>
              </div>
              {createChat.isError ? (
                <p role="alert" className="text-sm text-rose-600">
                  {createChat.error.message}
                </p>
              ) : null}
            </div>
            <Link
              to="/b/$boardSlug/new"
              params={{ boardSlug }}
              className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
            >
              New ticket
            </Link>
          </div>
        ) : null}
      </header>

      {board.isPending ? (
        <p className="text-sm text-zinc-500">Loading board…</p>
      ) : board.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          Could not load board: {board.error.message}
        </p>
      ) : (
        <>
          <BoardColumns
            boardSlug={boardSlug}
            pending={tickets.isPending}
            error={tickets.isError ? tickets.error.message : null}
            tickets={tickets.data ?? []}
          />
          <ChecksEditor board={board.data} />
        </>
      )}

      <Outlet />
    </main>
  );
}

function BoardColumns({
  boardSlug,
  pending,
  error,
  tickets,
}: {
  boardSlug: string;
  pending: boolean;
  error: string | null;
  tickets: readonly TicketDTO[];
}) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-rose-600">
        Could not load tickets: {error}
      </p>
    );
  }

  const grouped = groupTicketsByStatus(tickets);

  return (
    <div className="flex snap-x gap-3 overflow-x-auto pb-4">
      {BOARD_COLUMNS.map((column) => {
        const columnTickets = grouped[column.key];
        return (
          <section
            key={column.key}
            className="flex w-72 shrink-0 snap-start flex-col gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-2"
            aria-label={column.label}
          >
            <header className="flex items-center justify-between px-1.5 py-1">
              <span className="text-xs font-semibold text-zinc-700">
                {column.label}
              </span>
              <span className="rounded-full bg-zinc-200 px-1.5 text-[10px] font-medium text-zinc-600">
                {columnTickets.length}
              </span>
            </header>

            <div className="flex flex-col gap-2">
              {pending ? (
                <p className="px-1.5 text-xs text-zinc-400">Loading…</p>
              ) : columnTickets.length === 0 ? (
                <p className="px-1.5 py-6 text-center text-xs text-zinc-400">
                  Empty
                </p>
              ) : (
                columnTickets.map((ticket) => (
                  <TicketCard
                    key={ticket._id}
                    ticket={ticket}
                    boardSlug={boardSlug}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// Draft check row, kept separately from BoardCheck so the editor can hold a
// partially-typed check that the save button validates against. `commandText`
// holds the raw textarea (NOT a split argv) so a mid-edit trailing newline
// round-trips instead of being silently dropped on the next keystroke; the
// argv is derived at save time. `key` is a stable React identity for the row's
// inputs and doubles as the check's identity once saved — the schema rejects
// duplicate keys, and the "add argument" re-key on rename would break
// text-selection mid-typing, so rows get a plain running integer.
type DraftCheck = {
  key: string;
  label: string;
  commandText: string;
  timeoutMs: string;
};

const emptyDraft = (): DraftCheck => ({
  key: "",
  label: "",
  commandText: "",
  timeoutMs: "120000",
});

const draftFromCheck = (check: BoardCheck): DraftCheck => ({
  key: check.key,
  label: check.label,
  commandText: check.command.join("\n"),
  timeoutMs: String(check.timeoutMs),
});

// One non-blank line is one argv element. Blank lines carry no argument (a
// trailing newline — the natural way a textarea ends — must not silently become
// an empty-string argument that the schema rejects). Same shape as
// parseAcceptanceLines in the new-ticket form.
const commandFromLines = (text: string): string[] =>
  text.split("\n").filter((line) => line.length > 0);

function ChecksEditor({ board }: { board: Board & { _id: string } }) {
  const queryClient = useQueryClient();
  const updateChecks = useUpdateBoardChecks();
  // null means "no local edits": render straight from the server's checks so a
  // refetch (e.g. right after save) is reflected without manual syncing. Any
  // edit materializes a draft that shadows the server state until saved or
  // discarded.
  const [draft, setDraft] = useState<DraftCheck[] | null>(null);
  const rows = draft ?? board.checks.map(draftFromCheck);

  // A save fails validation or the write itself; the board query is refetched
  // by invalidate on success, then the draft is cleared so the editor renders
  // the freshly-persisted checks (which also drops any empty-command row that
  // the filter below excluded from the payload).
  const handleSave = () => {
    const checks: BoardCheck[] = rows
      .filter((r) => commandFromLines(r.commandText).length > 0)
      .map((r) => ({
        key: r.key,
        label: r.label,
        command: commandFromLines(r.commandText),
        timeoutMs: Number(r.timeoutMs),
      }));
    updateChecks.mutate(
      { slug: board.slug, checks },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: useBoard.getKey({ slug: board.slug }),
          });
          setDraft(null);
        },
      },
    );
  };

  const patch = (index: number, next: Partial<DraftCheck>) => {
    setDraft((prev) => {
      const base = prev ?? board.checks.map(draftFromCheck);
      return base.map((row, i) => (i === index ? { ...row, ...next } : row));
    });
  };

  const removeRow = (index: number) => {
    setDraft((prev) => {
      const base = prev ?? board.checks.map(draftFromCheck);
      return base.filter((_, i) => i !== index);
    });
  };

  return (
    <section
      aria-labelledby="checks-heading"
      className="mt-8 rounded-2xl border border-zinc-200 bg-white p-4"
    >
      <header className="mb-2 flex items-center justify-between gap-3">
        <h2
          id="checks-heading"
          className="text-xs font-semibold tracking-wide text-zinc-500 uppercase"
        >
          Acceptance checks
        </h2>
        <button
          type="button"
          onClick={() =>
            setDraft((prev) => {
              const base = prev ?? board.checks.map(draftFromCheck);
              return [...base, emptyDraft()];
            })
          }
          className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
        >
          + Add check
        </button>
      </header>

      <p className="mb-4 text-xs text-zinc-400">
        Each check runs in the run's fresh git worktree, so commands run against
        the agent's committed work. One argument per line — a line containing a
        space is a single argument, never split. The command is executed with no
        shell.
      </p>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-400">
          No checks — every run verifies only that a commit exists.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row, index) => (
            <li
              key={index}
              className="grid gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 sm:grid-cols-2 lg:grid-cols-12"
            >
              <Field
                label="Key"
                htmlFor={`check-key-${index}`}
                hint="lowercase, digits, - _"
              >
                <input
                  id={`check-key-${index}`}
                  required
                  value={row.key}
                  onChange={(e) => patch(index, { key: e.target.value })}
                  className={`${inputClass} font-mono`}
                />
              </Field>
              <Field
                label="Label"
                htmlFor={`check-label-${index}`}
                className="sm:col-span-1 lg:col-span-3"
              >
                <input
                  id={`check-label-${index}`}
                  required
                  value={row.label}
                  onChange={(e) => patch(index, { label: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Timeout (ms)"
                htmlFor={`check-timeout-${index}`}
                className="lg:col-span-2"
              >
                <input
                  id={`check-timeout-${index}`}
                  type="number"
                  min={1}
                  value={row.timeoutMs}
                  onChange={(e) => patch(index, { timeoutMs: e.target.value })}
                  className={`${inputClass} font-mono`}
                />
              </Field>

              <div className="sm:col-span-2 lg:col-span-6">
                <label className="block space-y-1">
                  <span className="flex items-baseline justify-between">
                    <span className="text-sm font-medium text-zinc-700">
                      Command
                    </span>
                    <span className="text-xs text-zinc-400">
                      one argument per line
                    </span>
                  </span>
                  <textarea
                    rows={2}
                    value={row.commandText}
                    onChange={(e) =>
                      patch(index, { commandText: e.target.value })
                    }
                    placeholder={"git\nrev-parse\n--verify\nHEAD"}
                    className={`${inputClass} resize-y font-mono`}
                  />
                </label>
              </div>

              <div className="flex items-end justify-end sm:col-span-2 lg:col-span-12">
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={updateChecks.isPending}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {updateChecks.isPending ? "Saving…" : "Save checks"}
        </button>
        <button
          type="button"
          disabled={updateChecks.isPending}
          onClick={() => setDraft(null)}
          className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Discard
        </button>
        {draft ? (
          <span className="text-xs text-zinc-400">Unsaved changes</span>
        ) : null}
        {updateChecks.isError ? (
          <p role="alert" className="text-sm text-rose-600">
            Could not save checks: {updateChecks.error.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900";

function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className={`block space-y-1 ${className ?? ""}`}>
      <span className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-zinc-700">{label}</span>
        {hint ? <span className="text-xs text-zinc-400">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}
