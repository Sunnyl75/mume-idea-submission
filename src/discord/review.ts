// Native Discord assessment: personal ephemeral controls over a shared D1 draft.
import type { Env, IdeaRow } from "../types";
import { EPHEMERAL } from "../constants";
import { holdsCouncil } from "../lib/council";
import { getIdea } from "../lib/db";
import { CRITERIA, CHECKS } from "../lib/rubric";
import {
  contentOf,
  draftResult,
  feedbackFor,
  AGREEMENTS_REQUIRED,
  emptyDraft,
  checksAgreed,
  readyToClose,
  scoreSignature,
} from "../lib/sharedReview";
import type { ReviewDraft, Reviewer } from "../lib/sharedReview";
import {
  getReview,
  agreements,
  agreeReview,
  withdrawAgreement,
  reservePublish,
  finishPublish,
  secondChecks,
  withdrawChecksSecond,
  startReview,
  reviewChanges,
  saveOrRequestChange,
  applyReviewChange,
  withdrawReviewChange,
  assessmentHistory,
  assessmentEvent,
  hasSubmittedScores,
  submitReviewScores,
  pendingReviewChanges,
} from "../lib/sharedReviewDb";
import type { SharedReview, ReviewEvent } from "../lib/sharedReviewDb";
import { discordFetch, discordJson } from "./rest";
import { withSummaryEmbed } from "./embed";
interface ModalField {
  type?: number;
  custom_id?: string;
  value?: string;
  values?: string[];
  component?: ModalField;
  components?: ModalField[];
}
export interface ReviewInteraction {
  type: number;
  guild_id?: string;
  channel_id?: string;
  token: string;
  application_id: string;
  message?: { id?: string; flags?: number };
  member?: {
    roles: string[];
    user: { id: string; username: string; global_name?: string | null };
  };
  data?: {
    custom_id?: string;
    values?: string[];
    components?: ModalField[];
  };
}
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
const escape = (s: string) =>
  s.replace(/([\\*_`~|>])/g, "\\$1").replace(/@/g, "＠");
const button = (label: string, id: string, style = 2, disabled = false) => ({
  type: 2,
  label,
  custom_id: id,
  style,
  disabled,
});
export function reviewButton(ideaId: number): Record<string, unknown> {
  return {
    type: 1,
    components: [button("Assess idea", `review:open:${ideaId}:0`, 1)],
  };
}
const textInput = (
  id: string,
  label: string,
  value: string,
  max: number,
  required = true,
) => ({
  type: 18,
  label,
  component: {
    type: 4,
    custom_id: id,
    style: 2,
    value,
    max_length: max,
    required,
  },
});
const requestCurrent = (
  q: import("../lib/sharedReviewDb").ReviewChange,
  r: SharedReview,
  idea: IdeaRow,
) =>
  q.status === "pending" &&
  q.base_revision === r.revision &&
  q.idea_content === contentOf(idea);

const COMPONENTS_V2 = 1 << 15;
const text = (content: string) => ({ type: 10, content });
const row = (...components: unknown[]) => ({ type: 1, components });
const box = (...components: unknown[]) => ({ type: 17, components });
function panel(components: unknown[]) {
  // Explicitly clear legacy content/embeds when upgrading an existing panel.
  return {
    flags: COMPONENTS_V2,
    content: null,
    embeds: [],
    components,
    allowed_mentions: { parse: [] },
  };
}
function summaryPanel(title: string, body: string, controls: unknown[]) {
  const blocks = [text(`### ${title}`)];
  for (let n = 0; n < body.length; n += 3500)
    blocks.push(text(body.slice(n, n + 3500)));
  return panel([box(...blocks), ...controls]);
}
const SUMMARY_MARKER = "Current Council assessment";
export async function assessmentSummaryEmbed(
  env: Env,
  idea: IdeaRow,
  review?: SharedReview,
) {
  const r = review || (await getReview(env, idea)),
    d: ReviewDraft = JSON.parse(r.draft);
  const stale = r.idea_content !== contentOf(idea),
    votes = stale ? [] : await agreements(env, r);
  const pending = stale ? [] : await pendingReviewChanges(env, r);
  const scoreRequests = pending.filter(
    (q) => scoreSignature(JSON.parse(q.draft)) !== scoreSignature(d),
  );
  const result = draftResult(d);
  const approvedChecks =
    !stale && checksAgreed(d, r.checks_proposer_id, r.checks_seconder_id);
  const fields = [
    {
      name: "Response guidance",
      value: result.flags.length
        ? CHECKS.filter((c) => d.issues.includes(c.id))
            .map((c) => `${c.action}: ${c.feedback}`)
            .join("\n")
        : result.band
          ? result.band.feedback
          : "Complete the scores to produce response guidance.",
    },
    {
      name: "Current scores and rubric",
      value:
        CRITERIA.map(
          (c) =>
            `${c.name}${c.weight === 2 ? " ×2" : ""}: **${d.scores[c.id] === null ? "not scored" : d.scores[c.id] + "/5"}**${d.scores[c.id] === null ? "" : "\n" + c.levels[d.scores[c.id]! - 1]}`,
        ).join("\n\n") +
        (result.total === null
          ? ""
          : `\n**Total: ${result.total}/20**${result.band ? " · " + result.band.name : ""}`),
    },
    {
      name: "Reasons the idea cannot go forward",
      value: d.issues.length
        ? CHECKS.filter((c) => d.issues.includes(c.id))
            .map((c) => `• ${c.name}`)
            .join("\n") +
          "\n" +
          escape(d.issueReason).slice(0, 700)
        : "None selected.",
    },
    {
      name: "Approval still needed",
      value: stale
        ? "The idea changed. Reassess it before any approvals count."
        : `${result.total === null ? "Please score all categories, or cancel.\n" : ""}${d.issues.length ? (approvedChecks ? `Checks seconded by ${escape(r.checks_seconder_name || "Council")}.` : "Selected checks need one other Council member to Second.") : "Checks pass; no Second required."}\nScores: ${votes.length}/${AGREEMENTS_REQUIRED} agreements${votes.length < AGREEMENTS_REQUIRED ? ` — ${AGREEMENTS_REQUIRED - votes.length} more required` : " — agreed"}.${
            votes.length
              ? "\n" +
                votes
                  .map((v) => escape(v.name))
                  .join(", ")
                  .slice(0, 600)
              : ""
          }`,
    },
    {
      name: "Changes awaiting review",
      value: pending.length
        ? `${scoreRequests.length} score change request(s); ${pending.length} change request(s) in total.\n${pending
            .slice(0, 3)
            .map((q) => `#${q.id} by ${escape(q.proposer_name)}`)
            .join(
              " · ",
            )}${pending.length > 3 ? " · more…" : ""}\nAwaiting editor acceptance or one other backer. Current scores stay in force meanwhile.`
        : "No changes awaiting review.",
    },
  ];
  return {
    title: "Current assessment",
    description:
      r.status === "published"
        ? "Assessment submitted and recorded privately."
        : r.status === "publishing"
          ? "Submitting assessment…"
          : "Assessment in progress",
    color:
      !stale &&
      readyToClose(d, votes.length, r.checks_proposer_id, r.checks_seconder_id)
        ? 0x2d7d46
        : 0x5865f2,
    fields,
    footer: { text: SUMMARY_MARKER },
  };
}
export async function withReviewSummary(
  env: Env,
  idea: IdeaRow,
  embeds: Record<string, unknown>[],
) {
  return withSummaryEmbed(embeds, await assessmentSummaryEmbed(env, idea));
}
export async function syncAssessmentSummary(env: Env, idea: IdeaRow) {
  // Only edit the private review starter. Never add assessment data to public posts.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await getIdea(env, idea.id);
    if (
      !current?.review_thread_id ||
      !current.review_message_id ||
      current.review_thread_id === current.thread_id
    )
      return;
    const generation = async () =>
      (await env.DB.prepare(
        "SELECT COALESCE(MAX(id),0) AS id FROM council_review_events WHERE idea_id=?",
      )
        .bind(idea.id)
        .first<{ id: number }>())!.id;
    const before = await generation();
    const summary = await assessmentSummaryEmbed(env, current);
    const route = `/channels/${current.review_thread_id}/messages/${current.review_message_id}`;
    const message = await discordJson<{
      embeds?: Array<{ footer?: { text?: string } }>;
    }>(env, route);
    await discordFetch(env, route, {
      method: "PATCH",
      body: {
        embeds: withSummaryEmbed(
          (message.embeds || []).filter(
            (e) => e.footer?.text !== SUMMARY_MARKER,
          ),
          summary,
        ),
        allowed_mentions: { parse: [] },
      },
    });
    const latest = await getIdea(env, idea.id);
    if (
      before === (await generation()) &&
      latest &&
      contentOf(latest) === contentOf(current) &&
      latest.status === current.status
    )
      return;
  }
  console.error("Assessment summary changed repeatedly; reload to refresh it.");
}
export async function reviewPayload(
  env: Env,
  idea: IdeaRow,
  r: SharedReview,
  viewerId?: string,
) {
  const draft: ReviewDraft = JSON.parse(r.draft),
    result = draftResult(draft);
  const stale = r.idea_content !== contentOf(idea),
    votes = stale ? [] : await agreements(env, r);
  const closed = r.status === "published",
    busy = r.status === "publishing";
  const cid = (op: string) => `review:${op}:${idea.id}:${r.revision}`;
  const locked = closed || busy || !r.author_id;
  const scoredBefore = await hasSubmittedScores(env, r);
  const mine = votes.some((v) => v.id === viewerId);
  const checksStatus = !draft.issues.length
    ? "No issues selected — checks pass."
    : stale
      ? "Idea changed — reassess the checks."
      : checksAgreed(draft, r.checks_proposer_id, r.checks_seconder_id)
        ? `Seconded by ${escape(r.checks_seconder_name || "Council")}.`
        : "Selected checks need one other member to second them.";
  const scores = CRITERIA.map(
    (c) =>
      `${c.name}${c.weight === 2 ? " ×2" : ""}: **${draft.scores[c.id] === null ? "—" : draft.scores[c.id] + "/5"}**`,
  ).join(" · ");
  const resultLine = stale
    ? "Idea changed — score agreements no longer count."
    : result.total === null
      ? "Choose scores to calculate the recommendation."
      : result.flags.length
        ? `**${result.total}/20** · Selected checks take priority.`
        : `**${result.total}/20 · ${result.band!.name}**`;
  const requests = await reviewChanges(env, idea.id);
  const pending = await pendingReviewChanges(env, r);
  const state = closed
    ? "Closed — recorded privately"
    : busy
      ? "Recording assessment…"
      : r.author_id
        ? "Assessment in Progress"
        : "Assessment not started";
  const extraOptions = [
    {
      label: "Review summary",
      value: "preview",
      description: "Read the scores, explanations and proposed feedback",
    },
    ...(requests.length
      ? [
          {
            label: "Change requests",
            value: "changes",
            description: "Read, accept or back proposed changes",
          },
        ]
      : []),
    {
      label: "Reload latest assessment",
      value: "refresh",
      description: "Show any changes made by other Council members",
    },
  ];
  return panel([
    text(`## Assessment · Idea #${idea.id}\n**${escape(idea.title)}**`),
    box(
      text(
        `**Current state**\n${scores}\n${resultLine}\n${
          draft.issues.length
            ? "Checks: " +
              CHECKS.filter((c) => draft.issues.includes(c.id))
                .map((c) => c.name)
                .join(" · ")
            : "Checks pass."
        }\n${checksStatus}\nScore agreements: ${votes.length}/${AGREEMENTS_REQUIRED}.${pending.length ? "\n" + pending.length + " change request(s) awaiting review." : " No changes awaiting review."}`,
      ),
    ),
    box(
      text(
        `### Scores\n${scores}\n${resultLine}\n${result.band ? result.band.feedback + "\n" : ""}${CRITERIA.filter(
          (c) => draft.scores[c.id] !== null,
        )
          .map((c) => `**${c.name}:** ${c.levels[draft.scores[c.id]! - 1]}`)
          .join("\n")}\n**${votes.length}/${AGREEMENTS_REQUIRED} agreements**${
          votes.length
            ? " · " +
              votes
                .map((v) => escape(v.name))
                .join(", ")
                .slice(0, 700)
            : ""
        }`,
      ),
      row(
        button("Score", cid("scores"), 1, locked || scoredBefore),
        ...(scoredBefore
          ? [button("Submit changed scores", cid("changescores"), 1, locked)]
          : []),
      ),
      row(
        button(
          "Agree with final scores",
          cid("agree"),
          2,
          closed || busy || stale || result.total === null || mine,
        ),
        button(
          "Withdraw score agreement",
          cid("withdraw"),
          2,
          closed || busy || stale || (!!viewerId && !mine),
        ),
      ),
    ),
    box(
      text(
        `### Checks\n${checksStatus}${
          draft.issues.length
            ? "\n" +
              CHECKS.filter((c) => draft.issues.includes(c.id))
                .map((c) => c.name)
                .join(" · ") +
              "\n" +
              escape(draft.issueReason).slice(0, 1000)
            : ""
        }`,
      ),
      row({
        type: 3,
        custom_id: cid("issues"),
        placeholder: "Select issues, or leave empty to pass",
        min_values: 0,
        max_values: 6,
        disabled: locked,
        options: CHECKS.map((c) => ({
          label: c.name,
          value: c.id,
          default: draft.issues.includes(c.id),
        })),
      }),
      row(
        button(
          "Second",
          cid("secondchecks"),
          2,
          closed ||
            busy ||
            stale ||
            !draft.issues.length ||
            !r.checks_proposer_id ||
            !!r.checks_seconder_id ||
            r.checks_proposer_id === viewerId,
        ),
        button(
          "Withdraw my Second",
          cid("withdrawchecks"),
          2,
          closed ||
            busy ||
            stale ||
            !r.checks_seconder_id ||
            (!!viewerId && r.checks_seconder_id !== viewerId),
        ),
      ),
    ),
    box(
      text(
        `**${state}**${r.author_id ? " · Editor: " + escape(r.author_name || "Council") : ""}${pending.length ? "\nChange requests: " + pending.map((q) => `#${q.id} by ${escape(q.proposer_name)}`).join(", ") : ""}`,
      ),
      row(
        button(
          closed
            ? "Reopen assessment"
            : r.author_id
              ? "Assessment in Progress"
              : "Start assessment",
          cid(closed ? "reopen" : "start"),
          2,
          busy || (!closed && !!r.author_id),
        ),
        button(
          busy ? "Retry submission" : "Submit Assessment",
          cid("publish"),
          3,
          closed ||
            stale ||
            !readyToClose(
              draft,
              votes.length,
              r.checks_proposer_id,
              r.checks_seconder_id,
            ),
        ),
      ),
      row(button("Assessment history", cid("history"))),
      row({
        type: 3,
        custom_id: cid("menu"),
        placeholder: "More options",
        min_values: 1,
        max_values: 1,
        options: extraOptions,
      }),
    ),
  ]);
}
function modal(id: string, title: string, components: unknown[]) {
  return response({ type: 9, data: { custom_id: id, title, components } });
}
function fieldsOf(i: ReviewInteraction): ModalField[] {
  const fields: ModalField[] = [];
  const visit = (c: ModalField) => {
    if (c.custom_id) fields.push(c);
    if (c.component) visit(c.component);
    for (const child of c.components ?? []) visit(child);
  };
  for (const c of i.data?.components ?? []) visit(c);
  if (new Set(fields.map((c) => c.custom_id)).size !== fields.length)
    throw Error("Duplicate form fields.");
  return fields;
}
function inputs(i: ReviewInteraction) {
  return Object.fromEntries(
    fieldsOf(i)
      .filter((c) => typeof c.value === "string")
      .map((c) => [c.custom_id!, c.value!]),
  );
}
function historyAction(action: string): string {
  const labels: Record<string, string> = {
    start: "Started the assessment",
    revise: "Changed the assessment",
    agree_scores: "Agreed with final scores",
    withdraw_scores: "Withdrew score agreement",
    second_checks: "Seconded the selected checks",
    withdraw_checks_second: "Withdrew their checks second",
    request_change: "Requested a change",
    withdraw_change: "Withdrew a change request",
    apply_change: "Accepted / backed and applied a change",
    publish: "Closed and recorded the assessment",
    reopen: "Reopened the assessment",
    agree: "Agreed with the assessment (earlier workflow)",
    withdraw: "Withdrew assessment agreement (earlier workflow)",
  };
  return labels[action] || action.replace(/_/g, " ");
}
function scoreLine(d: ReviewDraft): string {
  return CRITERIA.map(
    (c) =>
      `${c.name}${c.weight === 2 ? " ×2" : ""}: ${d.scores[c.id] === null ? "not assessed" : d.scores[c.id] + "/5"}`,
  ).join(" · ");
}
function eventSummary(e: ReviewEvent): string {
  const d: ReviewDraft = JSON.parse(e.snapshot);
  const previous: ReviewDraft = e.previous_snapshot
    ? JSON.parse(e.previous_snapshot)
    : emptyDraft();
  const details: string[] = [];
  if (["revise", "apply_change", "request_change"].includes(e.action)) {
    for (const c of CRITERIA) {
      const old = previous.scores[c.id],
        next = d.scores[c.id];
      if (old !== next)
        details.push(
          `${c.name}: ${old === null ? "not assessed" : old + "/5"} → ${next === null ? "not assessed" : next + "/5"}`,
        );
      else if ((previous.reasons[c.id] || "") !== (d.reasons[c.id] || ""))
        details.push(`${c.name}: explanation changed`);
    }
    const checks = (draft: ReviewDraft) =>
      CHECKS.filter((c) => draft.issues.includes(c.id))
        .map((c) => c.name)
        .join(", ") || "none";
    if (checks(previous) !== checks(d))
      details.push(`Checks: ${checks(previous)} → ${checks(d)}`);
    else if (previous.issueReason !== d.issueReason)
      details.push("Checks explanation changed");
    if (previous.note !== d.note) details.push("Response guidance changed");
  } else if (
    ["agree_scores", "withdraw_scores", "agree", "withdraw"].includes(e.action)
  ) {
    const total = draftResult(d).total;
    details.push(scoreLine(d) + (total === null ? "" : ` · ${total}/20`));
  } else if (["second_checks", "withdraw_checks_second"].includes(e.action)) {
    details.push(
      CHECKS.filter((c) => d.issues.includes(c.id))
        .map((c) => c.name)
        .join(", ") || "No selected checks",
    );
  }
  const reason =
    e.reason && e.action !== "publish"
      ? `\nReason: ${escape(e.reason).slice(0, 500)}${e.reason.length > 500 ? "…" : ""}`
      : "";
  return `**${escape(e.actor_name)}** · ${historyAction(e.action)}\n<t:${e.at}:f> · Revision ${e.revision}${details.length ? "\n" + escape(details.join("\n")).slice(0, 1200) : ""}${reason}`;
}
async function historyPayload(
  env: Env,
  idea: IdeaRow,
  r: SharedReview,
  page: number,
  anchor: number,
) {
  const history = await assessmentHistory(env, idea.id, page, anchor);
  const cid = (op: string, targetPage = page) =>
    `review:${op}:${idea.id}:${r.revision}:${targetPage}:${history.anchor}`;
  const controls = [
    ...(history.events.length
      ? [
          row({
            type: 3,
            custom_id: cid("historyevent"),
            placeholder: "View full assessment at an event",
            min_values: 1,
            max_values: 1,
            options: history.events.map((e) => ({
              label: `${e.actor_name} · ${historyAction(e.action)}`.slice(
                0,
                100,
              ),
              value: String(e.id),
              description: `Event #${e.id} · Revision ${e.revision}`,
            })),
          }),
        ]
      : []),
    row(
      button("Newer", cid("history", Math.max(0, page - 1)), 2, page === 0),
      button("Older", cid("history", page + 1), 2, !history.hasNext),
      button("Back to assessment", `review:refresh:${idea.id}:0`),
    ),
  ];
  return panel([
    text(
      `## Assessment history · Idea #${idea.id}\nNewest first · Page ${page + 1} · Read-only`,
    ),
    ...(history.events.length
      ? history.events.map((e) => {
          const summary = eventSummary(e);
          return box(
            text(
              summary.length > 600
                ? summary.slice(0, 540) +
                    "…\nSelect this event for full details."
                : summary,
            ),
          );
        })
      : [text("No assessment history has been recorded yet.")]),
    ...controls,
  ]);
}
async function historyEventPayload(
  env: Env,
  idea: IdeaRow,
  r: SharedReview,
  eventId: number,
  page: number,
  anchor: number,
  part = 0,
) {
  const e = await assessmentEvent(env, idea.id, eventId);
  if (!e || (anchor && eventId > anchor))
    throw Error("This history entry is unavailable for this idea.");
  const d: ReviewDraft = JSON.parse(e.snapshot);
  const details = CRITERIA.map(
    (c) =>
      `**${c.name}${c.weight === 2 ? " ×2" : ""}: ${d.scores[c.id] === null ? "not assessed" : d.scores[c.id] + "/5"}**\n${escape(d.reasons[c.id] || "No explanation recorded")}`,
  ).join("\n\n");
  const checks =
    CHECKS.filter((c) => d.issues.includes(c.id))
      .map((c) => c.name)
      .join(", ") || "None";
  const body = `**${historyAction(e.action)}** by **${escape(e.actor_name)}**\nMember ID: ${escape(e.actor_id)}\n<t:${e.at}:f> · Revision ${e.revision} · Event #${e.id}\n${["request_change", "withdraw_change"].includes(e.action) ? "Proposed snapshot — this event does not apply it to the assessment." : "Assessment snapshot at this event."}\n\n${details}\n\n**Checks:** ${checks}\n${escape(d.issueReason)}${d.note ? "\n\n**Previous response guidance**\n" + escape(d.note) : ""}\n\n**Recorded reason:** ${escape(e.reason || "None")}`;
  const chunks = Math.max(1, Math.ceil(body.length / 3000));
  if (!Number.isSafeInteger(part) || part < 0 || part >= chunks)
    throw Error("Invalid snapshot page.");
  const partId = (n: number) =>
    `review:historysnapshot:${idea.id}:${r.revision}:${page}:${anchor}:${eventId}:${n}`;
  return summaryPanel(
    `Assessment history — full snapshot${chunks > 1 ? ` · Part ${part + 1}/${chunks}` : ""}`,
    body.slice(part * 3000, (part + 1) * 3000),
    [
      ...(chunks > 1
        ? [
            row(
              button(
                "Previous part",
                partId(Math.max(0, part - 1)),
                2,
                part === 0,
              ),
              button("Next part", partId(part + 1), 2, part + 1 >= chunks),
            ),
          ]
        : []),
      row(
        button(
          "Back to history",
          `review:history:${idea.id}:${r.revision}:${page}:${anchor}`,
        ),
        button("Back to assessment", `review:refresh:${idea.id}:0`),
      ),
    ],
  );
}
async function changePayload(
  env: Env,
  idea: IdeaRow,
  r: SharedReview,
  page = 0,
) {
  const [q] = await reviewChanges(env, idea.id, 1, page);
  const cid = (op: string, value: number) =>
    `review:${op}:${idea.id}:${r.revision}:${value}`;
  const navigation = [
    button(
      "Previous request",
      cid("changes", Math.max(0, page - 1)),
      2,
      page === 0,
    ),
    button(
      "Next request",
      cid("changes", page + 1),
      2,
      !(await reviewChanges(env, idea.id, 1, page + 1)).length,
    ),
    button("Back to assessment", `review:refresh:${idea.id}:0`),
  ];
  if (!q)
    return panel([
      text("No change requests."),
      { type: 1, components: navigation },
    ]);
  const d: ReviewDraft = JSON.parse(q.draft);
  const current =
    requestCurrent(q, r, idea) &&
    r.status === "open" &&
    idea.status !== "resolved";
  const fields = CRITERIA.map((c) => ({
    name: c.name + (c.weight === 2 ? " ×2" : ""),
    value:
      d.scores[c.id] === null
        ? "Not assessed"
        : `${d.scores[c.id]}/5 · ${c.levels[d.scores[c.id]! - 1]}\n${escape(d.reasons[c.id] || "").slice(0, 500)}`,
  }));
  fields.push({
    name: "Selected checks",
    value: d.issues.length
      ? CHECKS.filter((c) => d.issues.includes(c.id))
          .map((c) => c.name)
          .join(", ") +
        "\n" +
        escape(d.issueReason).slice(0, 1000)
      : "None — pass by default",
  });
  const detail = {
    embeds: [
      {
        title: `Change request #${q.id} · Idea #${idea.id}`,
        description: `By **${escape(q.proposer_name)}** against revision ${q.base_revision}. ${current ? "Pending" : q.status === "pending" ? "Outdated — submit a fresh request" : q.status}\n${escape(q.reason).slice(0, 1000)}\n\nThis is the exact proposed replacement. The editor can accept it, or one other Council member can back it. Applying transfers editing to the proposer; it does not second checks or agree to scores.`,
        fields,
        color: 0x5865f2,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          button(
            "Accept / back and apply",
            cid("backchange", q.id),
            1,
            !current,
          ),
          button(
            "Withdraw my request",
            cid("withdrawchange", q.id),
            2,
            q.status !== "pending" || r.status !== "open",
          ),
        ],
      },
      { type: 1, components: navigation },
    ],
    allowed_mentions: { parse: [] },
  };
  const e = detail.embeds[0];
  return summaryPanel(
    e.title,
    e.description +
      "\n\n" +
      e.fields.map((f) => `**${f.name}**\n${f.value}`).join("\n\n"),
    detail.components,
  );
}
async function publish(
  env: Env,
  idea: IdeaRow,
  r: SharedReview,
  actor: Reviewer,
) {
  if (!idea.review_thread_id)
    throw Error(
      "The idea has no private Council thread to record the assessment.",
    );
  await reservePublish(env, r);
  // A stable nonce prevents duplicate messages during short-term retries. If a
  // retry is needed later, find the durable marker in message history first.
  const marker = `Internal Council assessment #${idea.id} · revision ${r.revision}`;
  let message: { id: string } | undefined;
  let before: string | undefined;
  const bot = await discordJson<{ id: string }>(env, "/users/@me");
  for (;;) {
    const rows = await discordJson<
      Array<{
        id: string;
        content?: string;
        author?: { id: string; bot?: boolean };
      }>
    >(
      env,
      `/channels/${idea.review_thread_id}/messages?limit=100${before ? "&before=" + before : ""}`,
    );
    // Match our bot author, not merely a user quoting the marker.
    message = rows.find(
      (m) => m.author?.id === bot.id && m.content?.startsWith(`**${marker}**`),
    );
    if (message || rows.length < 100) break;
    before = rows[rows.length - 1].id;
  }
  if (!message) {
    const text = feedbackFor(idea, JSON.parse(r.draft));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(marker),
    );
    const nonce = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 24);
    // Use a file-free embed split into bounded chunks for long Council reasons.
    const chunks: string[] = [];
    for (let n = 0; n < text.length; n += 3500)
      chunks.push(text.slice(n, n + 3500));
    message = await discordJson<{ id: string }>(
      env,
      `/channels/${idea.review_thread_id}/messages`,
      {
        method: "POST",
        body: {
          content: `**${marker}**`,
          embeds: chunks.map((description) => ({
            description,
            color: 0x5865f2,
          })),
          allowed_mentions: { parse: [] },
          nonce,
          enforce_nonce: true,
        },
      },
    );
  }
  await finishPublish(env, r, message.id, actor);
}
export async function handleReviewInteraction(
  env: Env,
  ctx: ExecutionContext,
  i: ReviewInteraction,
): Promise<Response> {
  const fail = (text: string) =>
    response({
      type: 4,
      data: {
        content: text,
        flags: EPHEMERAL,
        allowed_mentions: { parse: [] },
      },
    });
  if (
    i.guild_id !== env.DISCORD_GUILD_ID ||
    !i.member?.user.id ||
    !holdsCouncil(env, i.member.roles)
  )
    return fail("Only White Council members can assess ideas.");
  const parts = (i.data?.custom_id ?? "").split(":"),
    id = Number(parts[2]),
    rev = Number(parts[3]);
  let op = parts[1];
  if (op === "menu") {
    const chosen = i.data?.values;
    if (
      i.type !== 3 ||
      chosen?.length !== 1 ||
      !["preview", "changes", "refresh"].includes(chosen[0])
    )
      return fail("Unknown assessment option.");
    op = chosen[0];
  }
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !Number.isSafeInteger(rev) ||
    rev < 0
  )
    return fail("Invalid assessment control.");
  const actor = {
    id: i.member.user.id,
    name: i.member.user.global_name || i.member.user.username,
  };
  // Modal openings need an immediate response. Other operations are deferred
  // before touching D1 or Discord so rate limits cannot exhaust Discord's ACK.
  const openModal =
    i.type === 3 &&
    (op === "scores" || op === "changescores" || op === "issues");
  if (openModal) {
    try {
      const idea = await getIdea(env, id);
      if (!idea || idea.status === "resolved")
        return fail("Reopen the idea before changing its assessment.");
      if (!idea.review_thread_id || i.channel_id !== idea.review_thread_id)
        return fail("Use the private review thread.");
      const r = await getReview(env, idea);
      if (r.revision !== rev || r.status !== "open")
        return fail("This assessment changed or closed. Refresh it.");
      const d: ReviewDraft = JSON.parse(r.draft);
      if (!r.author_id) return fail("Click Start assessment first.");
      const proposing = r.author_id !== actor.id;
      if (op === "scores" || op === "changescores") {
        const prior = await hasSubmittedScores(env, r);
        if (prior && op === "scores")
          return fail(
            "Scores have already been submitted. Use Submit changed scores.",
          );
        return modal(
          `review:savescores:${id}:${rev}`,
          prior
            ? proposing
              ? "Propose changed scores"
              : "Submit changed scores"
            : "Submit initial scores",
          [
            text(
              "Please score all categories, or cancel. " +
                (prior
                  ? "Current scores are preselected. Changed scores need an explanation."
                  : "Initial scores need no explanation and count as your agreement."),
            ),
            ...CRITERIA.map((c) => ({
              type: 18,
              label: c.name + (c.weight === 2 ? " (counts twice)" : ""),
              component: {
                type: 3,
                custom_id: c.id,
                placeholder: "Please select a score from 1 to 5",
                min_values: 1,
                max_values: 1,
                required: true,
                options: c.levels.map((level, j) => ({
                  label: String(j + 1),
                  value: String(j + 1),
                  description:
                    level.length > 100 ? level.slice(0, 99) + "…" : level,
                  default: d.scores[c.id] === j + 1,
                })),
              },
            })),
            ...(prior
              ? [
                  {
                    ...textInput(
                      "reason",
                      "Reason for changed scores",
                      "",
                      500,
                      false,
                    ),
                    description:
                      "Required only if you change the submitted scores.",
                  },
                ]
              : []),
          ],
        );
      }
      const chosen = i.data?.values ?? [];
      if (
        chosen.some((x) => !CHECKS.some((c) => c.id === x)) ||
        new Set(chosen).size !== chosen.length
      )
        return fail("Invalid issues.");
      // Encode the finite selection as a six-bit mask, never free-form client text.
      const mask = CHECKS.reduce(
        (n, c, j) => n + (chosen.includes(c.id) ? 2 ** j : 0),
        0,
      );
      return modal(
        `review:setissues:${id}:${rev}:${mask}`,
        "Issues requiring action",
        [
          textInput(
            "reason",
            "Explain selected issues (or their removal)",
            d.issueReason,
            1000,
            true,
          ),
        ],
      );
    } catch (e) {
      console.error("review modal", e);
      return fail("Could not open assessment. Try again.");
    }
  }
  ctx.waitUntil(
    (async () => {
      const webhook = `https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`;
      try {
        const idea = await getIdea(env, id);
        if (!idea) throw Error("Unknown idea.");
        if (!idea.review_thread_id || i.channel_id !== idea.review_thread_id)
          throw Error("Use the private Council review thread.");
        let r = await getReview(env, idea);
        const readOnly = [
          "open",
          "refresh",
          "preview",
          "changes",
          "history",
          "historyevent",
          "historysnapshot",
        ].includes(op);
        if (!readOnly && (r.revision !== rev || idea.status === "resolved"))
          throw Error(
            "Assessment changed or idea resolved. Refresh or reopen the idea.",
          );
        if (op === "savescores" && i.type === 5) {
          const submitted = fieldsOf(i),
            values = inputs(i),
            scores: Record<string, number> = {};
          for (const c of CRITERIA) {
            const selection = submitted.find(
              (f) => f.custom_id === c.id,
            )?.values;
            if (
              !Array.isArray(selection) ||
              selection.length !== 1 ||
              !/^[1-5]$/.test(selection[0])
            )
              throw Error("Please score all categories, or cancel.");
            scores[c.id] = Number(selection[0]);
          }
          await submitReviewScores(
            env,
            r,
            idea,
            scores,
            actor,
            values.reason ?? "",
          );
        } else if (op === "setissues" && i.type === 5) {
          const mask = Number(parts[4]);
          if (!Number.isInteger(mask) || mask < 0 || mask > 63)
            throw Error("Invalid selection.");
          const values = inputs(i),
            d: ReviewDraft = JSON.parse(r.draft);
          d.issues = CHECKS.filter((_, j) => mask & (2 ** j)).map((c) => c.id);
          d.issueReason = d.issues.length ? (values.reason ?? "") : "";
          await saveOrRequestChange(
            env,
            r,
            idea,
            d,
            actor,
            values.reason ?? "",
          );
        } else if (op === "start" && i.type === 3)
          await startReview(env, r, actor);
        else if (
          (op === "backchange" || op === "withdrawchange") &&
          i.type === 3
        ) {
          const requestId = Number(parts[4]);
          if (!Number.isSafeInteger(requestId) || requestId <= 0)
            throw Error("Invalid change request.");
          if (op === "backchange")
            await applyReviewChange(env, r, idea, requestId, actor);
          else await withdrawReviewChange(env, r, requestId, actor);
        } else if (op === "agree" && i.type === 3)
          await agreeReview(env, r, actor);
        else if (op === "secondchecks" && i.type === 3)
          await secondChecks(env, r, actor);
        else if (op === "withdrawchecks" && i.type === 3)
          await withdrawChecksSecond(env, r, actor);
        else if (op === "withdraw" && i.type === 3)
          await withdrawAgreement(env, r, actor);
        else if (op === "publish" && i.type === 3)
          await publish(env, idea, r, actor);
        else if (op === "reopen" && i.type === 3) {
          if (r.status !== "published")
            throw Error("Only closed assessments can be reopened.");
          await reopen(env, r, idea, actor);
        } else if (!readOnly) throw Error("Unknown assessment action.");
        r = await getReview(env, idea);
        if (
          ![
            "history",
            "historyevent",
            "historysnapshot",
            "preview",
            "changes",
          ].includes(op)
        ) {
          await syncAssessmentSummary(env, idea).catch((e) =>
            console.error("assessment summary refresh", e),
          );
          r = await getReview(env, idea);
        }
        if (["history", "historyevent", "historysnapshot"].includes(op)) {
          const page = Number(parts[4] ?? 0),
            anchor = Number(parts[5] ?? 0);
          if (
            !Number.isSafeInteger(page) ||
            page < 0 ||
            page > 1_000_000 ||
            !Number.isSafeInteger(anchor) ||
            anchor < 0
          )
            throw Error("Invalid history page.");
          const selected = i.data?.values;
          if (
            op === "historyevent" &&
            (i.type !== 3 ||
              selected?.length !== 1 ||
              !/^[1-9][0-9]*$/.test(selected[0]))
          )
            throw Error("Choose one history entry.");
          const payload =
            op === "history"
              ? await historyPayload(env, idea, r, page, anchor)
              : await historyEventPayload(
                  env,
                  idea,
                  r,
                  Number(op === "historysnapshot" ? parts[6] : selected![0]),
                  page,
                  anchor,
                  Number(op === "historysnapshot" ? parts[7] : 0),
                );
          await discordFetch(env, webhook, {
            method: "PATCH",
            unauthenticated: true,
            body: payload,
          });
          return;
        }
        if (op === "changes") {
          const page = Number(parts[4] ?? 0);
          if (!Number.isSafeInteger(page) || page < 0)
            throw Error("Invalid request page.");
          await discordFetch(env, webhook, {
            method: "PATCH",
            unauthenticated: true,
            body: await changePayload(env, idea, r, page),
          });
          return;
        }
        const payload =
          op === "preview"
            ? summaryPanel(
                "Assessment summary — not recorded",
                feedbackFor(idea, JSON.parse(r.draft)),
                [row(button("Back to assessment", `review:refresh:${id}:0`))],
              )
            : await reviewPayload(env, idea, r, actor.id);
        await discordFetch(env, webhook, {
          method: "PATCH",
          unauthenticated: true,
          body: payload,
        });
      } catch (e) {
        console.error("native review", e);
        await discordFetch(env, webhook, {
          method: "PATCH",
          unauthenticated: true,
          body: summaryPanel(
            "Assessment",
            (e as Error).message || "Assessment failed. Try again.",
            [row(button("Back to assessment", `review:refresh:${id}:0`))],
          ),
        }).catch(() => {});
      }
    })(),
  );
  // Update the private panel that supplied this button/modal. Only opening from
  // the thread's public Assess button creates a new private response.
  return i.message && (i.message.flags ?? 0) & EPHEMERAL
    ? response({ type: 6 })
    : response({ type: 5, data: { flags: EPHEMERAL } });
}
async function reopen(
  env: Env,
  r: SharedReview,
  idea: IdeaRow,
  actor: Reviewer,
) {
  // Reopening is an explicit change, not an accidental edit of a final result.
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE council_reviews SET status='open',author_id=NULL,author_name=NULL,revision=revision+1,score_revision=score_revision+1,checks_revision=checks_revision+1,checks_seconder_id=NULL,checks_seconder_name=NULL,checks_proposer_id=?,checks_proposer_name=?,idea_content=?,record_message_id=NULL WHERE idea_id=? AND revision=? AND status='published'`,
    ).bind(
      JSON.parse(r.draft).issues.length ? actor.id : null,
      JSON.parse(r.draft).issues.length ? actor.name : null,
      contentOf(idea),
      idea.id,
      r.revision,
    ),
    env.DB.prepare(
      `INSERT INTO council_review_events(idea_id,revision,action,actor_id,actor_name,snapshot,reason,at) SELECT idea_id,revision,'reopen',?,?,draft,'Reopened for discussion',? FROM council_reviews WHERE idea_id=? AND revision=? AND changes()=1`,
    ).bind(
      actor.id,
      actor.name,
      Math.floor(Date.now() / 1000),
      idea.id,
      r.revision + 1,
    ),
  ]);
  if (!result[0].meta.changes) throw Error("Assessment changed. Refresh it.");
}
