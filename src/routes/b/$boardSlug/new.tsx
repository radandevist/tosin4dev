import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CreateTicketInput } from "../../../domain/schemas";
import { useBoard } from "../../../queries/boards";
import { useCreateTicket, useTickets } from "../../../queries/tickets";

export const Route = createFileRoute("/b/$boardSlug/new")({
  component: NewTicketPage,
});

const TYPE_OPTIONS = [
  ["research", "Research"],
  ["spec", "Spec"],
  ["implement", "Implement"],
  ["bugfix", "Bugfix"],
  ["review", "Review"],
] as const satisfies readonly [CreateTicketInput["type"], string][];

const RUNNER_OPTIONS = [
  ["claude", "Claude"],
  ["codex", "Codex"],
] as const satisfies readonly [CreateTicketInput["runner"], string][];

const RISK_OPTIONS = [
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
] as const satisfies readonly [CreateTicketInput["spec"]["risk"], string][];

// Split an acceptance textarea into one criterion per non-blank line. Pure and
// exported so the parsing (trim + drop blanks) is unit-tested without a DOM.
export function parseAcceptanceLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

type FormState = {
  title: string;
  type: CreateTicketInput["type"];
  runner: CreateTicketInput["runner"];
  intent: string;
  scope: string;
  nonGoals: string;
  acceptance: string;
  risk: CreateTicketInput["spec"]["risk"];
};

const EMPTY_FORM: FormState = {
  title: "",
  type: "implement",
  runner: "claude",
  intent: "",
  scope: "",
  nonGoals: "",
  acceptance: "",
  risk: "low",
};

function NewTicketPage() {
  const { boardSlug } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const board = useBoard({ variables: { slug: boardSlug } });
  const createTicket = useCreateTicket();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const close = () =>
    navigate({ to: "/b/$boardSlug", params: { boardSlug } });

  const boardId = board.data?._id;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!boardId) return;
    const input: CreateTicketInput = {
      boardId,
      title: form.title,
      type: form.type,
      runner: form.runner,
      spec: {
        intent: form.intent,
        scope: form.scope,
        nonGoals: form.nonGoals,
        acceptance: parseAcceptanceLines(form.acceptance),
        links: [],
        risk: form.risk,
      },
    };
    createTicket.mutate(input, {
      onSuccess: ({ seq }) => {
        queryClient.invalidateQueries({
          queryKey: useTickets.getKey({ boardId }),
        });
        navigate({
          to: "/b/$boardSlug/t/$ticketSeq",
          params: { boardSlug, ticketSeq: String(seq) },
        });
      },
    });
  };

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <OverlayPanel title="New ticket" onClose={close}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Title" htmlFor="ticket-title">
          <input
            id="ticket-title"
            required
            autoFocus
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Type" htmlFor="ticket-type">
            <select
              id="ticket-type"
              value={form.type}
              onChange={(e) =>
                set("type", e.target.value as FormState["type"])
              }
              className={inputClass}
            >
              {TYPE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Runner" htmlFor="ticket-runner">
            <select
              id="ticket-runner"
              value={form.runner}
              onChange={(e) =>
                set("runner", e.target.value as FormState["runner"])
              }
              className={inputClass}
            >
              {RUNNER_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Intent" htmlFor="ticket-intent" hint="required">
          <textarea
            id="ticket-intent"
            required
            rows={2}
            value={form.intent}
            onChange={(e) => set("intent", e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Scope" htmlFor="ticket-scope">
          <textarea
            id="ticket-scope"
            rows={2}
            value={form.scope}
            onChange={(e) => set("scope", e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Non-goals" htmlFor="ticket-nongoals">
          <textarea
            id="ticket-nongoals"
            rows={2}
            value={form.nonGoals}
            onChange={(e) => set("nonGoals", e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field
          label="Acceptance"
          htmlFor="ticket-acceptance"
          hint="one criterion per line"
        >
          <textarea
            id="ticket-acceptance"
            rows={4}
            value={form.acceptance}
            onChange={(e) => set("acceptance", e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Risk" htmlFor="ticket-risk">
          <select
            id="ticket-risk"
            value={form.risk}
            onChange={(e) => set("risk", e.target.value as FormState["risk"])}
            className={inputClass}
          >
            {RISK_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={createTicket.isPending || !boardId}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {createTicket.isPending ? "Creating…" : "Create ticket"}
          </button>
          <button
            type="button"
            onClick={close}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            Cancel
          </button>
          {createTicket.isError ? (
            <p role="alert" className="text-sm text-rose-600">
              {createTicket.error.message}
            </p>
          ) : null}
        </div>
      </form>
    </OverlayPanel>
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
      <span className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-zinc-700">{label}</span>
        {hint ? <span className="text-xs text-zinc-400">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

// A right-side slide-over dialog. Board content stays visible behind the
// backdrop; Escape or a backdrop click closes back to the board. Not a full
// focus trap — deep focus polish is deferred to Task 9.
export function OverlayPanel({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-zinc-900/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l border-zinc-200 bg-white shadow-xl"
      >
        <header className="sticky top-0 flex items-center justify-between border-b border-zinc-200 bg-white/90 px-6 py-4 backdrop-blur">
          <h2 className="text-lg font-semibold text-zinc-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            Close
          </button>
        </header>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
