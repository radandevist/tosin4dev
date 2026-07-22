import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import type { TicketDTO } from "../../server/tickets";
import { useBoard } from "../../queries/boards";
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
      { boardId },
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
              <button
                type="button"
                disabled={createChat.isPending}
                onClick={startBrainstorm}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-50"
              >
                {createChat.isPending ? "Starting…" : "Brainstorm"}
              </button>
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
        <BoardColumns
          boardSlug={boardSlug}
          pending={tickets.isPending}
          error={tickets.isError ? tickets.error.message : null}
          tickets={tickets.data ?? []}
        />
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
