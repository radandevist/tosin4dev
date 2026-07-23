import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TicketSchema, type HandoffBrief, type Run } from "../domain/schemas";
import { db, ObjectId } from "./db";
import { redactSecrets } from "./redact";
import { ServerResultError } from "./result";
import { projectExchanges } from "./runExchanges";

export const RUN_CONTEXT_CHAR_BUDGET = 48_000;

const execFileAsync = promisify(execFile);

type ContextRun = Omit<Run, "exchanges"> & { exchanges?: unknown };
type Section = { header: string; body: string };

function renderSection(section: Section): string {
  return `## ${section.header}\n${section.body}\n\n`;
}

function redactSection(section: Section): string | null {
  try {
    return redactSecrets(renderSection(section));
  } catch {
    return null;
  }
}

function list(label: string, values: string[]): string {
  return `${label}:\n${
    values.length === 0
      ? "- None"
      : values.map((value) => `- ${value}`).join("\n")
  }`;
}

function specSection(ticket: ReturnType<typeof TicketSchema.parse>): Section {
  return {
    header: "Locked spec",
    body: [
      `Ticket: #${ticket.seq} ${ticket.title}`,
      `Intent: ${ticket.spec.intent}`,
      `Scope: ${ticket.spec.scope || "None"}`,
      `Non-goals: ${ticket.spec.nonGoals || "None"}`,
      list("Acceptance", ticket.spec.acceptance),
    ].join("\n"),
  };
}

function exchangeSections(
  raw: unknown,
  awaitingQuestion: string | null,
): {
  sections: Section[];
  openHandoff: HandoffBrief | null;
} {
  const { exchanges, dropped } = projectExchanges(raw);
  const sections: Section[] = [];
  if (dropped > 0) {
    sections.push({
      header: "Exchange history gap",
      body: `${dropped} earlier exchange(s) omitted`,
    });
  }
  const open = exchanges
    .slice()
    .reverse()
    .find((exchange) => exchange.answer === null);
  if (!open && awaitingQuestion) {
    sections.push({
      header: "Open question",
      body: `Question: ${awaitingQuestion}`,
    });
  }
  sections.push(
    ...exchanges
      .slice()
      .reverse()
      .map((exchange) => ({
        header: "Exchange",
        body: [
          `Asked: ${exchange.at}`,
          `Question: ${exchange.question}`,
          exchange.answer === null
            ? "Answer: Awaiting owner input"
            : `Answer: ${exchange.answer}`,
          exchange.answeredAt === null
            ? null
            : `Answered: ${exchange.answeredAt}`,
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      })),
  );
  return { sections, openHandoff: open?.handoff ?? null };
}

function handoffSection(handoff: HandoffBrief): Section {
  return {
    header: "Open exchange handoff",
    body: [
      `Work done: ${handoff.workDone || "None"}`,
      list("Files touched", handoff.filesTouched),
      list("Commands run", handoff.commandsRun),
      `Decision needed: ${handoff.decision || "None"}`,
      list("Options", handoff.options),
      `Risk: ${handoff.risk || "None"}`,
    ].join("\n"),
  };
}

async function worktreeSection(run: ContextRun): Promise<Section> {
  try {
    if (!run.baseSha || !/^[0-9a-f]{7,40}$/.test(run.baseSha)) {
      throw new Error("invalid base SHA");
    }
    const [{ stdout: status }, { stdout: log }] = await Promise.all([
      execFileAsync("git", ["status", "--porcelain"], {
        cwd: run.workDir,
        encoding: "utf8",
        timeout: 10_000,
      }),
      execFileAsync("git", ["log", "--oneline", `${run.baseSha}..HEAD`], {
        cwd: run.workDir,
        encoding: "utf8",
        timeout: 10_000,
      }),
    ]);
    return {
      header: "Objective worktree facts",
      body: [
        `Branch: ${run.branch ?? "None"}`,
        `Base SHA: ${run.baseSha}`,
        `Git status:\n${status.trim() || "(clean)"}`,
        `Commits:\n${log.trim() || "(none)"}`,
      ].join("\n"),
    };
  } catch {
    return {
      header: "Objective worktree facts",
      body: "Git worktree facts unavailable.",
    };
  }
}

export async function buildRunContext(
  runId: string,
): Promise<{ text: string }> {
  const database = await db();
  let objectId: ObjectId;
  try {
    objectId = new ObjectId(runId);
  } catch {
    throw new ServerResultError("not_found", `run not found: ${runId}`);
  }
  const run = await database
    .collection<ContextRun>("runs")
    .findOne({ _id: objectId });
  if (!run) {
    throw new ServerResultError("not_found", `run not found: ${runId}`);
  }
  const ticketDoc = await database
    .collection("tickets")
    .findOne({ _id: new ObjectId(run.ticketId) });
  if (!ticketDoc) {
    throw new ServerResultError(
      "not_found",
      `ticket not found: ${run.ticketId}`,
    );
  }
  const {
    _id: _ticketId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...raw
  } = ticketDoc;
  const parsedTicket = TicketSchema.safeParse(raw);
  if (!parsedTicket.success) {
    throw new ServerResultError(
      "invalid_state",
      `stored ticket is invalid: ${run.ticketId}`,
    );
  }
  const ticket = parsedTicket.data;

  let text = redactSection(specSection(ticket)) ?? "";
  let budgetedLength = 0;
  const { sections: exchanges, openHandoff } = exchangeSections(
    run.exchanges,
    run.awaitingQuestion,
  );
  const sections = [
    ...exchanges,
    ...(openHandoff ? [handoffSection(openHandoff)] : []),
    await worktreeSection(run),
  ];

  for (const section of sections) {
    const redacted = redactSection(section);
    if (
      redacted === null ||
      budgetedLength + redacted.length > RUN_CONTEXT_CHAR_BUDGET
    ) {
      break;
    }
    text += redacted;
    budgetedLength += redacted.length;
  }
  return { text };
}
