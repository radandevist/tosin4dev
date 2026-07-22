import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDispatch, useLogTail, useRuns } from "../queries/runs";
import {
  useProvideInput,
  useTicket,
  useTickets,
} from "../queries/tickets";
import type { RunDTO } from "../server/runs";
import type { TicketDTO } from "../server/tickets";
import {
  dispatchActionForTicket,
  formatRunTimestamp,
  isTerminalRunStatus,
  shouldPollLog,
} from "./runsUi";

const EMPTY_RUN_ID = "000000000000000000000000";
const POLL_INTERVAL_MS = 2_000;

export function RunsSection({ ticket }: { ticket: TicketDTO }) {
  const queryClient = useQueryClient();
  const dispatchRun = useDispatch();
  const provideInput = useProvideInput();
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");

  const runs = useRuns({
    variables: { ticketId: ticket._id },
    refetchInterval: (query) => {
      if (ticket.activeRunId === null) return false;
      const activeRun = query.state.data?.find(
        (run) => run._id === ticket.activeRunId,
      );
      return activeRun && isTerminalRunStatus(activeRun.status)
        ? false
        : POLL_INTERVAL_MS;
    },
  });

  const parkedRun =
    ticket.status === "needs_input"
      ? runs.data?.find(
          (run) =>
            run._id === ticket.activeRunId && run.status === "awaiting_input",
        )
      : undefined;
  const selectedRun = runs.data?.find((run) => run._id === openRunId);
  const log = useLogTail({
    variables: { runId: openRunId ?? EMPTY_RUN_ID },
    enabled: openRunId !== null,
    refetchInterval: shouldPollLog(openRunId, selectedRun?.status)
      ? POLL_INTERVAL_MS
      : false,
  });

  useEffect(() => {
    const activeRunId = ticket.activeRunId;
    if (activeRunId === null) return;

    const activeRun = runs.data?.find((run) => run._id === activeRunId);
    if (!activeRun || !isTerminalRunStatus(activeRun.status)) return;

    void Promise.all([
      queryClient.invalidateQueries({
        queryKey: useTicket.getKey({ boardId: ticket.boardId, seq: ticket.seq }),
      }),
      queryClient.invalidateQueries({
        queryKey: useTickets.getKey({ boardId: ticket.boardId }),
      }),
      ...(openRunId === activeRunId
        ? [
            queryClient.invalidateQueries({
              queryKey: useLogTail.getKey({ runId: activeRunId }),
            }),
          ]
        : []),
    ]);
  }, [
    openRunId,
    queryClient,
    runs.data,
    ticket.activeRunId,
    ticket.boardId,
    ticket.seq,
  ]);

  const action = dispatchActionForTicket(
    ticket.status,
    ticket.runner,
    ticket.activeRunId,
  );

  const refreshTicketAndRuns = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: useTicket.getKey({ boardId: ticket.boardId, seq: ticket.seq }),
      }),
      queryClient.invalidateQueries({
        queryKey: useRuns.getKey({ ticketId: ticket._id }),
      }),
    ]);

  const dispatch = () => {
    if (!action || dispatchRun.isPending) return;
    dispatchRun.mutate(
      { ticketId: ticket._id, phase: action.phase },
      {
        onSuccess: ({ runId }) => {
          setOpenRunId(runId);
          void Promise.all([
            queryClient.invalidateQueries({
              queryKey: useRuns.getKey({ ticketId: ticket._id }),
            }),
            queryClient.invalidateQueries({
              queryKey: useTicket.getKey({
                boardId: ticket.boardId,
                seq: ticket.seq,
              }),
            }),
            queryClient.invalidateQueries({
              queryKey: useTickets.getKey({ boardId: ticket.boardId }),
            }),
          ]);
        },
        onSettled: () => {
          void refreshTicketAndRuns();
        },
      },
    );
  };

  const submitInput = () => {
    const trimmedAnswer = answer.trim();
    if (provideInput.isPending || trimmedAnswer.length === 0) return;
    provideInput.mutate(
      { ticketId: ticket._id, answer: trimmedAnswer },
      {
        onSuccess: () => {
          setAnswer("");
          void Promise.all([
            queryClient.invalidateQueries({
              queryKey: useRuns.getKey({ ticketId: ticket._id }),
            }),
            queryClient.invalidateQueries({
              queryKey: useTicket.getKey({
                boardId: ticket.boardId,
                seq: ticket.seq,
              }),
            }),
            queryClient.invalidateQueries({
              queryKey: useTickets.getKey({ boardId: ticket.boardId }),
            }),
          ]);
        },
      },
    );
  };

  return (
    <section aria-labelledby="ticket-runs-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4
          id="ticket-runs-heading"
          className="text-xs font-semibold tracking-wide text-zinc-500 uppercase"
        >
          Runs
        </h4>
        {action ? (
          <button
            type="button"
            disabled={dispatchRun.isPending}
            onClick={dispatch}
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {dispatchRun.isPending ? "Dispatching…" : action.label}
          </button>
        ) : null}
      </div>

      {dispatchRun.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          Could not dispatch run: {dispatchRun.error.message}
        </p>
      ) : null}

      {parkedRun ? (
        <form
          className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            submitInput();
          }}
        >
          <div className="space-y-1">
            <p className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">
              Input needed
            </p>
            <p className="text-sm text-zinc-800">
              {parkedRun.awaitingQuestion}
            </p>
          </div>
          <label
            htmlFor={`run-answer-${parkedRun._id}`}
            className="block text-xs font-medium text-zinc-600"
          >
            Your answer
          </label>
          <textarea
            id={`run-answer-${parkedRun._id}`}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            rows={3}
            className="block w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={provideInput.isPending || answer.trim().length === 0}
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {provideInput.isPending ? "Submitting…" : "Provide input"}
          </button>
          {provideInput.isError ? (
            <p role="alert" className="text-sm text-rose-600">
              Could not provide input: {provideInput.error.message}
            </p>
          ) : null}
        </form>
      ) : null}

      {runs.isPending ? (
        <p role="status" className="text-sm text-zinc-500">
          Loading runs…
        </p>
      ) : runs.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          Could not load runs: {runs.error.message}
        </p>
      ) : runs.data.length === 0 ? (
        <p className="text-sm text-zinc-400">No runs yet.</p>
      ) : (
        <ul className="space-y-2">
          {runs.data.map((run) => (
            <RunRow
              key={run._id}
              run={run}
              open={openRunId === run._id}
              onToggle={() =>
                setOpenRunId(openRunId === run._id ? null : run._id)
              }
            />
          ))}
        </ul>
      )}

      {openRunId !== null ? (
        <div id={`run-log-${openRunId}`} className="space-y-2">
          {log.isPending ? (
            <p role="status" className="text-sm text-zinc-500">
              Loading log…
            </p>
          ) : log.isError ? (
            <p role="alert" className="text-sm text-rose-600">
              Could not load log: {log.error.message}
            </p>
          ) : log.data.text.length === 0 ? (
            <p className="text-sm text-zinc-400">No log output yet.</p>
          ) : (
            <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs whitespace-pre-wrap text-zinc-100">
              {log.data.text}
            </pre>
          )}
        </div>
      ) : null}
    </section>
  );
}

function RunRow({
  run,
  open,
  onToggle,
}: {
  run: RunDTO;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-2 text-sm">
      <span className="font-mono text-xs text-zinc-700">{run.phase}</span>
      <span className="text-zinc-700">{run.status}</span>
      <time
        dateTime={run.startedAt ?? run.queuedAt}
        className="text-xs text-zinc-400"
      >
        {formatRunTimestamp(run.startedAt ?? run.queuedAt)}
      </time>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`run-log-${run._id}`}
        onClick={onToggle}
        className="ml-auto text-xs font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
      >
        {open ? "Hide log" : "View log"}
      </button>
    </li>
  );
}
