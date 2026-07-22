import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useChatSession, useSendChatMessage } from "../../../../queries/chat";
import type { ChatSessionDTO } from "../../../../server/chat";

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
          sessionId={sessionId}
          session={session.data}
        />
      )}
    </main>
  );
}

function ChatBody({
  sessionId,
  session,
}: {
  sessionId: string;
  session: ChatSessionDTO;
}) {
  const queryClient = useQueryClient();
  const send = useSendChatMessage();
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
          <p className="text-sm text-zinc-400">Describe what you want to build.</p>
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
        <button
          type="submit"
          disabled={pending || text.trim().length === 0 || send.isPending}
          className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-50"
        >
          Send
        </button>
      </form>
      {send.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {send.error.message}
        </p>
      ) : null}
    </div>
  );
}
