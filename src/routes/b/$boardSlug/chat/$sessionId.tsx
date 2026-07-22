import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RISK_LABELS, TYPE_LABELS } from "../../../../components/TicketCard";
import {
  useChatSession,
  useCreateTicketFromChat,
  useDraftSpecFromChat,
  useSendChatMessage,
} from "../../../../queries/chat";
import { useTickets } from "../../../../queries/tickets";
import type { ChatSessionDTO } from "../../../../server/chat";

const RUNNER_LABELS: Record<"claude" | "codex", string> = {
  claude: "Claude",
  codex: "Codex",
};

export const Route = createFileRoute("/b/$boardSlug/chat/$sessionId")({
  component: ChatPage,
});

function ChatPage() {
  const { boardSlug, sessionId } = Route.useParams();
  const session = useChatSession({ variables: { sessionId } });

  return (
    <main className="mx-auto flex h-dvh max-w-4xl flex-col p-4 sm:p-6">
      <header className="mb-4 flex items-center justify-between gap-3">
        <Link
          to="/b/$boardSlug"
          params={{ boardSlug }}
          className="text-xs text-zinc-500 hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
        >
          ← Board
        </Link>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
          Brainstorm
        </h1>
        <span className="w-16" />
      </header>

      {session.isPending ? (
        <p className="text-sm text-zinc-500">Loading chat…</p>
      ) : session.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {session.error.message}
        </p>
      ) : (
        <ChatBody
          boardSlug={boardSlug}
          sessionId={sessionId}
          session={session.data}
        />
      )}
    </main>
  );
}

function ChatBody({
  boardSlug,
  sessionId,
  session,
}: {
  boardSlug: string;
  sessionId: string;
  session: ChatSessionDTO;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const send = useSendChatMessage();
  const draft = useDraftSpecFromChat();
  const create = useCreateTicketFromChat();
  const [text, setText] = useState("");

  const pending = session.turnStatus === "pending";
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: useChatSession.getKey({ sessionId }),
    });

  const submit = () => {
    const trimmed = text.trim();
    if (pending || trimmed.length === 0 || send.isPending) return;
    send.mutate(
      { sessionId, text: trimmed },
      {
        onSuccess: () => {
          setText("");
          void refresh();
        },
      },
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4">
        {session.messages.length === 0 ? (
          <p className="text-sm text-zinc-400">
            Describe what you want to build. When ready, draft a spec.
          </p>
        ) : (
          session.messages.map((message, index) => (
            <div
              key={index}
              className={
                message.role === "user"
                  ? "ml-auto max-w-[80%] rounded-2xl bg-zinc-900 px-3 py-2 text-sm text-white"
                  : "mr-auto max-w-[80%] rounded-2xl bg-zinc-100 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-800"
              }
            >
              {message.text}
            </div>
          ))
        )}
        {pending ? (
          <p role="status" className="text-sm text-zinc-400">
            Assistant is thinking…
          </p>
        ) : null}
        {session.turnStatus === "error" && session.turnError ? (
          <p role="alert" className="text-sm text-rose-600">
            {session.turnError}
          </p>
        ) : null}
      </div>

      {session.proposedSpec ? (
        <ProposedSpecCard
          draft={session.proposedSpec}
          creating={create.isPending}
          error={create.isError ? create.error.message : null}
          onCreate={() =>
            create.mutate(
              { sessionId },
              {
                onSuccess: ({ seq }) => {
                  void Promise.all([
                    queryClient.invalidateQueries({
                      queryKey: useChatSession.getKey({ sessionId }),
                    }),
                    queryClient.invalidateQueries({
                      queryKey: useTickets.getKey({
                        boardId: session.boardId,
                      }),
                    }),
                  ]);
                  navigate({
                    to: "/b/$boardSlug/t/$ticketSeq",
                    params: { boardSlug, ticketSeq: String(seq) },
                  });
                },
              },
            )
          }
        />
      ) : null}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          aria-label="Message"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={2}
          disabled={pending}
          placeholder="Message the assistant…"
          className="min-h-11 flex-1 resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none disabled:bg-zinc-50"
        />
        <div className="flex flex-col gap-2">
          <button
            type="submit"
            disabled={pending || text.trim().length === 0 || send.isPending}
            className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-50"
          >
            Send
          </button>
          <button
            type="button"
            disabled={
              pending || session.messages.length === 0 || draft.isPending
            }
            onClick={() =>
              draft.mutate(
                { sessionId },
                { onSuccess: () => void refresh() },
              )
            }
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
          >
            Draft spec from this chat
          </button>
        </div>
      </form>
      {send.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {send.error.message}
        </p>
      ) : null}
    </div>
  );
}

function ProposedSpecCard({
  draft,
  creating,
  error,
  onCreate,
}: {
  draft: ChatSessionDTO["proposedSpec"] & object;
  creating: boolean;
  error: string | null;
  onCreate: () => void;
}) {
  return (
    <section className="space-y-2 rounded-xl border border-zinc-300 bg-zinc-50 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          Proposed ticket
        </p>
        <button
          type="button"
          disabled={creating}
          onClick={onCreate}
          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create ticket"}
        </button>
      </div>
      <p className="text-sm font-medium text-zinc-900">{draft.title}</p>
      <p className="text-xs text-zinc-500">
        {TYPE_LABELS[draft.type]} · {RISK_LABELS[draft.spec.risk]} ·{" "}
        {RUNNER_LABELS[draft.runner]}
      </p>
      <dl className="space-y-1 text-sm text-zinc-700">
        <div>
          <dt className="inline font-medium">Intent: </dt>
          <dd className="inline">{draft.spec.intent}</dd>
        </div>
        {draft.spec.scope ? (
          <div>
            <dt className="inline font-medium">Scope: </dt>
            <dd className="inline">{draft.spec.scope}</dd>
          </div>
        ) : null}
        {draft.spec.nonGoals ? (
          <div>
            <dt className="inline font-medium">Non-goals: </dt>
            <dd className="inline">{draft.spec.nonGoals}</dd>
          </div>
        ) : null}
        {draft.spec.acceptance.length > 0 ? (
          <div>
            <dt className="font-medium">Acceptance:</dt>
            <dd>
              <ul className="list-disc pl-5">
                {draft.spec.acceptance.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        {draft.spec.links.length > 0 ? (
          <div>
            <dt className="font-medium">Links:</dt>
            <dd>
              <ul className="list-disc pl-5">
                {draft.spec.links.map((link, index) => (
                  <li key={index}>{link}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
      {error ? (
        <p role="alert" className="text-sm text-rose-600">
          {error}
        </p>
      ) : null}
    </section>
  );
}
