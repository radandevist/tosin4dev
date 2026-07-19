import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { TicketDTO } from "../../../../server/tickets";
import { useBoard } from "../../../../queries/boards";
import { useTicket } from "../../../../queries/tickets";
import {
  RISK_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
} from "../../../../components/TicketCard";
import { GateButtons } from "../../../../components/GateButtons";
import { OverlayPanel } from "../new";

export const Route = createFileRoute("/b/$boardSlug/t/$ticketSeq")({
  component: TicketDetailPage,
});

// UTC ISO timestamps rendered as a stable "YYYY-MM-DD HH:MM" — deterministic
// across server and client so hydration never mismatches on locale/timezone.
function fmt(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

const RUNNER_LABELS: Record<TicketDTO["runner"], string> = {
  claude: "Claude",
  codex: "Codex",
};

function TicketDetailPage() {
  const { boardSlug, ticketSeq } = Route.useParams();
  const navigate = useNavigate();
  const board = useBoard({ variables: { slug: boardSlug } });

  const seq = Number(ticketSeq);
  const seqValid = Number.isInteger(seq) && seq > 0;
  const boardId = board.data?._id;

  const ticket = useTicket({
    variables: { boardId: boardId ?? "", seq },
    enabled: Boolean(boardId) && seqValid,
  });

  const close = () =>
    navigate({ to: "/b/$boardSlug", params: { boardSlug } });

  return (
    <OverlayPanel title={`Ticket #${ticketSeq}`} onClose={close}>
      {!seqValid ? (
        <p role="alert" className="text-sm text-rose-600">
          Invalid ticket number: {ticketSeq}
        </p>
      ) : board.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          Could not load board: {board.error.message}
        </p>
      ) : ticket.isPending ? (
        <p className="text-sm text-zinc-500">Loading ticket…</p>
      ) : ticket.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {ticket.error.message}
        </p>
      ) : (
        <TicketDetail ticket={ticket.data} />
      )}
    </OverlayPanel>
  );
}

function TicketDetail({ ticket }: { ticket: TicketDTO }) {
  // Activity is stored oldest-first (append order); the detail shows it
  // newest-first without mutating the cached array.
  const activity = [...ticket.activity].reverse();

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
            {STATUS_LABELS[ticket.status]}
          </span>
          <span className="font-mono text-xs text-zinc-400">#{ticket.seq}</span>
        </div>
        <h3 className="mt-2 text-xl font-semibold text-zinc-900">
          {ticket.title}
        </h3>
      </div>

      <GateButtons ticket={ticket} />

      <section aria-labelledby="detail-meta">
        <SectionHeading id="detail-meta">Metadata</SectionHeading>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Meta label="Type" value={TYPE_LABELS[ticket.type]} />
          <Meta label="Runner" value={RUNNER_LABELS[ticket.runner]} />
          <Meta label="Status" value={STATUS_LABELS[ticket.status]} />
          <Meta label="Risk" value={RISK_LABELS[ticket.spec.risk]} />
          <Meta label="Created" value={fmt(ticket.createdAt)} />
          <Meta label="Updated" value={fmt(ticket.updatedAt)} />
          <Meta
            label="Pull request"
            value={
              ticket.prUrl ? (
                <a
                  href={ticket.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-zinc-900 underline underline-offset-2 hover:text-zinc-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
                >
                  {ticket.prUrl}
                </a>
              ) : (
                <span className="text-zinc-400">None yet</span>
              )
            }
          />
        </dl>
      </section>

      <section aria-labelledby="detail-spec">
        <SectionHeading id="detail-spec">Spec</SectionHeading>
        <div className="space-y-4 text-sm">
          <SpecBlock label="Intent" text={ticket.spec.intent} />
          <SpecBlock label="Scope" text={ticket.spec.scope} />
          <SpecBlock label="Non-goals" text={ticket.spec.nonGoals} />
          <div>
            <p className="mb-1 text-xs font-medium tracking-wide text-zinc-500 uppercase">
              Acceptance
            </p>
            {ticket.spec.acceptance.length === 0 ? (
              <p className="text-zinc-400">None</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-zinc-800">
                {ticket.spec.acceptance.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            )}
          </div>
          {ticket.spec.links.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-medium tracking-wide text-zinc-500 uppercase">
                Links
              </p>
              <ul className="space-y-1">
                {ticket.spec.links.map((link, index) => (
                  <li key={index} className="break-all text-zinc-800">
                    {link}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="detail-approval">
        <SectionHeading id="detail-approval">Approval</SectionHeading>
        {ticket.spec.approvedBy ? (
          <p className="text-sm text-zinc-800">
            Approved by{" "}
            <span className="font-medium">{ticket.spec.approvedBy}</span>
            {ticket.spec.approvedAt ? (
              <> on {fmt(ticket.spec.approvedAt)}</>
            ) : null}
          </p>
        ) : (
          <p className="text-sm text-zinc-400">Not approved</p>
        )}
      </section>

      <section aria-labelledby="detail-activity">
        <SectionHeading id="detail-activity">Activity</SectionHeading>
        {activity.length === 0 ? (
          <p className="text-sm text-zinc-400">No activity yet.</p>
        ) : (
          <ol className="space-y-3">
            {activity.map((entry, index) => (
              <li key={index} className="flex gap-3 text-sm">
                <span className="w-32 shrink-0 font-mono text-xs text-zinc-400">
                  {fmt(entry.at)}
                </span>
                <span className="text-zinc-800">
                  <span className="mr-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
                    {entry.kind}
                  </span>
                  {entry.message}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function SectionHeading({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <h4
      id={id}
      className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase"
    >
      {children}
    </h4>
  );
}

function Meta({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-zinc-400">{label}</dt>
      <dd className="mt-0.5 text-zinc-800">{value}</dd>
    </div>
  );
}

function SpecBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium tracking-wide text-zinc-500 uppercase">
        {label}
      </p>
      {text.trim().length === 0 ? (
        <p className="text-zinc-400">None</p>
      ) : (
        <p className="whitespace-pre-wrap text-zinc-800">{text}</p>
      )}
    </div>
  );
}
