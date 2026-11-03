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
  checksAgreed,
  readyToClose,
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
} from "../lib/sharedReviewDb";
import type { SharedReview } from "../lib/sharedReviewDb";
import { discordFetch, discordJson } from "./rest";
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

export async function reviewPayload(env: Env, idea: IdeaRow, r: SharedReview) {
  const draft: ReviewDraft = JSON.parse(r.draft),
    result = draftResult(draft);
  const stale = r.idea_content !== contentOf(idea),
    votes = stale ? [] : await agreements(env, r);
  const closed = r.status === "published",
    busy = r.status === "publishing";
  const cid = (op: string) => `review:${op}:${idea.id}:${r.revision}`;
  const fields = CRITERIA.map((c) => ({
    name: `${c.name}${c.weight === 2 ? " ×2" : ""}`,
    value:
      draft.scores[c.id] === null
        ? "Not assessed"
        : `**${draft.scores[c.id]}/5** · ${c.levels[draft.scores[c.id]! - 1]}\n${escape(draft.reasons[c.id] || "").slice(0, 650)}`,
    inline: false,
  }));
  fields.push({
    name: "Issues requiring action",
    value: result.flags.length
      ? result.flags.map((c) => `• ${c.name}`).join("\n") +
        "\n" +
        escape(draft.issueReason).slice(0, 1000)
      : "None selected — checks pass by default.",
    inline: false,
  });
  fields.push({
    name: "Selected checks — one second",
    value: !draft.issues.length
      ? "Pass by default; no second needed."
      : stale
        ? "Idea changed — re-assess the checks."
        : r.checks_proposer_id
          ? `Selected by ${escape(r.checks_proposer_name || "Council")}` +
            (checksAgreed(draft, r.checks_proposer_id, r.checks_seconder_id)
              ? ` · Seconded by ${escape(r.checks_seconder_name || "Council")}`
              : " · Awaiting a second")
          : "Imported draft — propose the complete selection before another member seconds it.",
    inline: false,
  });
  fields.push({
    name: "Final-score agreement",
    value: stale
      ? "The idea changed. Revise this draft to assess the updated idea; old agreements no longer count."
      : `${votes.length}/${AGREEMENTS_REQUIRED} Council members${votes.length ? "\n" + votes.map((a) => escape(a.name)).join(", ") : ""}`,
    inline: false,
  });
  if (draft.note)
    fields.push({
      name: "Internal Council note",
      value: escape(draft.note).slice(0, 1000),
      inline: false,
    });
  fields.push({
    name: "Assessment editor",
    value: r.author_id
      ? `${escape(r.author_name || "Council")} · Others can request changes using the score, checks or note controls.`
      : "Not started. Any Council member can start this assessment.",
    inline: false,
  });
  const requests = await reviewChanges(env, idea.id);
  if (requests.length)
    fields.push({
      name: "Change requests",
      value: requests
        .map(
          (
            q,
          ) => `#${q.id} · ${escape(q.proposer_name)} · ${requestCurrent(q, r, idea) ? "Awaiting author acceptance or one other backer" : q.status === "pending" ? "Outdated" : q.status}
${escape(q.reason).slice(0, 160)}`,
        )
        .join("\n\n"),
      inline: false,
    });
  const status = closed
    ? "Closed — recorded in the private Council thread"
    : busy
      ? "Publication in progress — retry if the previous attempt failed"
      : stale
        ? "Idea changed — reassessment required"
        : result.flags.length
          ? "Further action required"
          : result.band
            ? `${result.band.name} · ${result.total}/20`
            : "Scores incomplete";
  return {
    content: "",
    embeds: [
      {
        title: `Council assessment · Idea #${idea.id}`,
        description: `**${escape(idea.title)}**\n${status}\nRevision ${r.revision} · ${closed ? "Final" : "Draft"}\nSelected checks need one second as a group. Final scores need three agreements. Refresh to see other reviewers’ changes. Change requests never overwrite the draft until accepted or backed.`,
        color: result.flags.length ? 0xd39a31 : 0x5865f2,
        fields,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: cid("issues"),
            placeholder: "Issues requiring action (none = pass)",
            min_values: 0,
            max_values: 6,
            disabled: closed || busy || !r.author_id,
            options: CHECKS.map((c) => ({
              label: c.name,
              value: c.id,
              default: draft.issues.includes(c.id),
            })),
          },
        ],
      },
      {
        type: 1,
        components: [
          ...CRITERIA.map((c) =>
            button(
              c.name + (c.weight === 2 ? " ×2" : ""),
              cid(`score-${c.id}`),
              2,
              closed || busy || !r.author_id,
            ),
          ),
          button(
            "Internal note",
            cid("note"),
            2,
            closed || busy || !r.author_id,
          ),
          button("Refresh", cid("refresh")),
        ],
      },
      {
        type: 1,
        components: [
          button(
            closed ? "Reopen assessment" : "Start assessment",
            cid(closed ? "reopen" : "start"),
            1,
            busy || (!closed && !!r.author_id),
          ),
          button("View change requests", cid("changes")),
          button("Preview internal summary", cid("preview")),
        ],
      },
      {
        type: 1,
        components: [
          button(
            "Second",
            cid("secondchecks"),
            1,
            closed ||
              busy ||
              stale ||
              !draft.issues.length ||
              !r.checks_proposer_id ||
              !!r.checks_seconder_id,
          ),
          button(
            "Agree with final scores",
            cid("agree"),
            1,
            closed || busy || stale || result.total === null,
          ),
          button(
            "Withdraw score agreement",
            cid("withdraw"),
            2,
            closed || busy || stale,
          ),
          button(
            "Withdraw my second",
            cid("withdrawchecks"),
            2,
            closed || busy || stale || !r.checks_seconder_id,
          ),
          button(
            busy ? "Retry internal recording" : "Close and record internally",
            cid("publish"),
            1,
            closed ||
              stale ||
              !readyToClose(
                draft,
                votes.length,
                r.checks_proposer_id,
                r.checks_seconder_id,
              ),
          ),
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
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
    return {
      content: "No change requests.",
      embeds: [],
      components: [{ type: 1, components: navigation }],
      allowed_mentions: { parse: [] },
    };
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
  fields.push({
    name: "Internal note",
    value: escape(d.note).slice(0, 1000) || "None",
  });
  return {
    content: "",
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
    op = parts[1],
    id = Number(parts[2]),
    rev = Number(parts[3]);
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
  const criterion = CRITERIA.find((c) => op === `score-${c.id}`);
  const openModal =
    i.type === 3 && (!!criterion || op === "note" || op === "issues");
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
      if (criterion)
        return modal(
          `review:savescore:${id}:${rev}:${criterion.id}`,
          `${proposing ? "Request" : "Edit"}: ${criterion.name}`,
          [
            {
              type: 18,
              label: `${criterion.name}${criterion.weight === 2 ? " (counts twice)" : ""}`,
              component: {
                type: 3,
                custom_id: "score",
                placeholder: "Choose a score from 1 to 5",
                min_values: 1,
                max_values: 1,
                required: true,
                options: criterion.levels.map((level, j) => ({
                  label: String(j + 1),
                  value: String(j + 1),
                  description: level,
                  default: d.scores[criterion.id] === j + 1,
                })),
              },
            },
            textInput(
              "reason",
              "Explanation for this score",
              d.reasons[criterion.id] || "",
              500,
            ),
            textInput(
              "why",
              proposing
                ? "Why are you requesting this change?"
                : "Why are you changing this score?",
              "",
              500,
            ),
          ],
        );
      if (op === "note")
        return modal(
          `review:savenote:${id}:${rev}`,
          proposing ? "Request: internal note" : "Edit internal note",
          [
            textInput(
              "note",
              "Internal note / response guidance",
              d.note,
              1000,
              false,
            ),
            textInput(
              "why",
              proposing
                ? "Why are you requesting this change?"
                : "Why are you changing this note?",
              "",
              500,
            ),
          ],
        );
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
        const readOnly = ["open", "refresh", "preview", "changes"].includes(op);
        if (!readOnly && (r.revision !== rev || idea.status === "resolved"))
          throw Error(
            "Assessment changed or idea resolved. Refresh or reopen the idea.",
          );
        if (op === "savescore" && i.type === 5) {
          const c = CRITERIA.find((c) => c.id === parts[4]);
          if (!c) throw Error("Unknown scoring criterion.");
          const selection = fieldsOf(i).find(
            (c) => c.custom_id === "score",
          )?.values;
          if (
            !Array.isArray(selection) ||
            selection.length !== 1 ||
            !/^[1-5]$/.test(selection[0])
          )
            throw Error("Choose one score from 1 to 5.");
          const values = inputs(i),
            d: ReviewDraft = JSON.parse(r.draft);
          d.scores[c.id] = Number(selection[0]);
          d.reasons[c.id] = values.reason ?? "";
          await saveOrRequestChange(env, r, idea, d, actor, values.why ?? "");
        } else if (op === "savenote" && i.type === 5) {
          const values = inputs(i),
            d: ReviewDraft = JSON.parse(r.draft);
          d.note = values.note ?? "";
          await saveOrRequestChange(env, r, idea, d, actor, values.why ?? "");
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
        const payload = await reviewPayload(env, idea, r);
        if (op === "preview") {
          const text = feedbackFor(idea, JSON.parse(r.draft));
          payload.embeds = [];
          for (let n = 0; n < text.length; n += 3500)
            payload.embeds.push({
              title:
                n === 0
                  ? "Internal summary preview — not recorded"
                  : "Continued",
              description: text.slice(n, n + 3500),
              color: 0x5865f2,
              fields: [],
            });
        }
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
          body: {
            content:
              (e as Error).message ||
              "Assessment failed. Refresh and try again.",
            embeds: [],
            components: [
              {
                type: 1,
                components: [
                  button("Refresh assessment", `review:refresh:${id}:0`),
                ],
              },
            ],
            allowed_mentions: { parse: [] },
          },
        }).catch(() => {});
      }
    })(),
  );
  return response({ type: 5, data: { flags: EPHEMERAL } });
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
