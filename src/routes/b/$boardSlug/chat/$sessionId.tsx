import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RISK_LABELS, TYPE_LABELS } from "../../../../components/TicketCard";
import type { BundleMember } from "../../../../domain/schemas";
import {
  useChatSession,
  useProposeBundleFromChat,
  useSendChatMessage,
} from "../../../../queries/chat";
import {
  useBundle,
  useDropBundleMember,
  useLockBundle,
  useReorderBundle,
  useUpdateBundleMember,
} from "../../../../queries/specBundles";
import { useTickets } from "../../../../queries/tickets";
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
  const propose = useProposeBundleFromChat();
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

  const proposeTickets = () => {
    if (pending || propose.isPending) return;
    propose.mutate(
      { sessionId },
      {
        onSuccess: () => {
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
            Describe what you want to build.
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
        {session.bundleId ? (
          <SpecBundleReview
            bundleId={session.bundleId}
            boardId={session.boardId}
            sessionId={sessionId}
            onLocked={() =>
              navigate({ to: "/b/$boardSlug", params: { boardSlug } })
            }
          />
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
            disabled={pending || propose.isPending}
            onClick={proposeTickets}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium whitespace-nowrap text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-50"
          >
            {propose.isPending ? "Proposing…" : "Propose tickets"}
          </button>
        </div>
      </form>
      {send.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {send.error.message}
        </p>
      ) : null}
      {propose.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {propose.error.message}
        </p>
      ) : null}
    </div>
  );
}

const TYPE_OPTIONS = Object.entries(TYPE_LABELS) as [
  BundleMember["type"],
  string,
][];
const RISK_OPTIONS = Object.entries(RISK_LABELS) as [
  BundleMember["spec"]["risk"],
  string,
][];
const RUNNER_OPTIONS = [
  ["claude", "Claude"],
  ["codex", "Codex"],
] as const satisfies readonly [BundleMember["runner"], string][];

const compactInputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900";

function SpecBundleReview({
  bundleId,
  boardId,
  sessionId,
  onLocked,
}: {
  bundleId: string;
  boardId: string;
  sessionId: string;
  onLocked: () => void;
}) {
  const queryClient = useQueryClient();
  const bundle = useBundle({ variables: { bundleId } });
  const lock = useLockBundle();

  if (bundle.isPending) {
    return <p className="text-sm text-zinc-500">Loading proposed tickets…</p>;
  }
  if (bundle.isError) {
    return (
      <p role="alert" className="text-sm text-rose-600">
        {bundle.error.message}
      </p>
    );
  }

  const members = bundle.data.members;
  const refreshBundle = () =>
    queryClient.invalidateQueries({
      queryKey: useBundle.getKey({ bundleId }),
    });

  const lockAll = () => {
    lock.mutate(
      { bundleId },
      {
        onSuccess: async () => {
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: useTickets.getKey({ boardId }),
            }),
            queryClient.invalidateQueries({
              queryKey: useChatSession.getKey({ sessionId }),
            }),
          ]);
          onLocked();
        },
      },
    );
  };

  return (
    <section className="mt-5 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-zinc-900">
            Proposed tickets
          </h2>
          <p className="mt-1 text-sm whitespace-pre-wrap text-zinc-600">
            {bundle.data.rationale}
          </p>
        </div>
        <span className="rounded-md bg-white px-2 py-1 text-xs text-zinc-500 capitalize">
          {bundle.data.status}
        </span>
      </div>

      {members.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-400">No tickets in this bundle.</p>
      ) : (
        <ol className="mt-4 space-y-3">
          {members.map((member, index) => (
            <li key={member.localKey}>
              <BundleMemberCard
                bundleId={bundleId}
                member={member}
                members={members}
                index={index}
                refreshBundle={refreshBundle}
              />
            </li>
          ))}
        </ol>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={lock.isPending || members.length === 0}
          onClick={lockAll}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {lock.isPending ? "Locking…" : `Lock all ${members.length} tickets`}
        </button>
        {lock.isError ? (
          <p role="alert" className="text-sm text-rose-600">
            {lock.error.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function BundleMemberCard({
  bundleId,
  member,
  members,
  index,
  refreshBundle,
}: {
  bundleId: string;
  member: BundleMember;
  members: BundleMember[];
  index: number;
  refreshBundle: () => Promise<unknown>;
}) {
  const update = useUpdateBundleMember();
  const drop = useDropBundleMember();
  const reorder = useReorderBundle();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(member);

  const set = <K extends keyof BundleMember>(key: K, value: BundleMember[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setSpec = <K extends keyof BundleMember["spec"]>(
    key: K,
    value: BundleMember["spec"][K],
  ) =>
    setDraft((current) => ({
      ...current,
      spec: { ...current.spec, [key]: value },
    }));

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    update.mutate(
      {
        bundleId,
        localKey: member.localKey,
        patch: {
          title: draft.title,
          type: draft.type,
          runner: draft.runner,
          spec: draft.spec,
          dependsOn: draft.dependsOn,
        },
      },
      {
        onSuccess: () => {
          setEditing(false);
          void refreshBundle();
        },
      },
    );
  };

  const dropMember = () => {
    drop.mutate(
      { bundleId, localKey: member.localKey },
      { onSuccess: () => void refreshBundle() },
    );
  };

  const move = (offset: -1 | 1) => {
    const swapWith = index + offset;
    if (swapWith < 0 || swapWith >= members.length) return;
    const orderedLocalKeys = members.map((item) => item.localKey);
    [orderedLocalKeys[index], orderedLocalKeys[swapWith]] = [
      orderedLocalKeys[swapWith],
      orderedLocalKeys[index],
    ];
    reorder.mutate(
      { bundleId, orderedLocalKeys },
      { onSuccess: () => void refreshBundle() },
    );
  };

  const mutationPending =
    update.isPending || drop.isPending || reorder.isPending;

  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-3">
      {editing ? (
        <form onSubmit={save} className="space-y-3">
          <label className="block space-y-1 text-xs font-medium text-zinc-600">
            <span>Title</span>
            <input
              required
              value={draft.title}
              onChange={(event) => set("title", event.target.value)}
              className={compactInputClass}
            />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <CompactSelect
              label="Type"
              value={draft.type}
              options={TYPE_OPTIONS}
              onChange={(value) => set("type", value as BundleMember["type"])}
            />
            <CompactSelect
              label="Runner"
              value={draft.runner}
              options={RUNNER_OPTIONS}
              onChange={(value) =>
                set("runner", value as BundleMember["runner"])
              }
            />
            <CompactSelect
              label="Risk"
              value={draft.spec.risk}
              options={RISK_OPTIONS}
              onChange={(value) =>
                setSpec("risk", value as BundleMember["spec"]["risk"])
              }
            />
          </div>
          <label className="block space-y-1 text-xs font-medium text-zinc-600">
            <span>Intent</span>
            <textarea
              required
              rows={3}
              value={draft.spec.intent}
              onChange={(event) => setSpec("intent", event.target.value)}
              className={compactInputClass}
            />
          </label>
          {members.length > 1 ? (
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-zinc-600">
                Depends on
              </legend>
              <div className="flex flex-wrap gap-2">
                {members
                  .filter((item) => item.localKey !== member.localKey)
                  .map((item) => (
                    <label
                      key={item.localKey}
                      className="inline-flex items-center gap-1 text-xs text-zinc-600"
                    >
                      <input
                        type="checkbox"
                        checked={draft.dependsOn.includes(item.localKey)}
                        onChange={(event) =>
                          set(
                            "dependsOn",
                            event.target.checked
                              ? [...draft.dependsOn, item.localKey]
                              : draft.dependsOn.filter(
                                  (key) => key !== item.localKey,
                                ),
                          )
                        }
                      />
                      {item.localKey}
                    </label>
                  ))}
              </div>
            </fieldset>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={update.isPending}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {update.isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(member);
                setEditing(false);
                update.reset();
              }}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600"
            >
              Cancel
            </button>
          </div>
          {update.isError ? (
            <p role="alert" className="text-sm text-rose-600">
              {update.error.message}
            </p>
          ) : null}
        </form>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-zinc-900">{member.title}</p>
              <p className="mt-1 text-xs text-zinc-500">
                {TYPE_LABELS[member.type]} · {RISK_LABELS[member.spec.risk]} ·{" "}
                {RUNNER_OPTIONS.find(([value]) => value === member.runner)?.[1]}
              </p>
            </div>
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
              {member.localKey}
            </span>
          </div>
          <p className="mt-3 text-sm whitespace-pre-wrap text-zinc-700">
            {member.spec.intent}
          </p>
          {member.dependsOn.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-zinc-400">Depends on</span>
              {member.dependsOn.map((localKey) => (
                <span
                  key={localKey}
                  className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[10px] text-zinc-600"
                >
                  {localKey}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <SmallButton
              onClick={() => setEditing(true)}
              disabled={mutationPending}
            >
              Edit
            </SmallButton>
            <SmallButton onClick={dropMember} disabled={mutationPending}>
              {drop.isPending ? "Dropping…" : "Drop"}
            </SmallButton>
            <SmallButton
              onClick={() => move(-1)}
              disabled={mutationPending || index === 0}
            >
              Move up
            </SmallButton>
            <SmallButton
              onClick={() => move(1)}
              disabled={mutationPending || index === members.length - 1}
            >
              Move down
            </SmallButton>
          </div>
          {drop.isError ? (
            <p role="alert" className="mt-2 text-sm text-rose-600">
              {drop.error.message}
            </p>
          ) : null}
          {reorder.isError ? (
            <p role="alert" className="mt-2 text-sm text-rose-600">
              {reorder.error.message}
            </p>
          ) : null}
        </>
      )}
    </article>
  );
}

function CompactSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1 text-xs font-medium text-zinc-600">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={compactInputClass}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function SmallButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
    >
      {children}
    </button>
  );
}
