import type { Env, IdeaRow } from "../types";
import {
  contentOf,
  emptyDraft,
  validateDraft,
  draftResult,
  AGREEMENTS_REQUIRED,
  scoreSignature,
  checksSignature,
} from "./sharedReview";
import type { ReviewDraft, Reviewer } from "./sharedReview";
export interface SharedReview {
  idea_id: number;
  revision: number;
  rubric_version: number;
  idea_content: string;
  draft: string;
  status: string;
  record_message_id: string | null;
  score_revision: number;
  checks_revision: number;
  checks_proposer_id: string | null;
  checks_proposer_name: string | null;
  checks_seconder_id: string | null;
  checks_seconder_name: string | null;
  author_id: string | null;
  author_name: string | null;
}
const now = () => Math.floor(Date.now() / 1000);
export async function getReview(
  env: Env,
  idea: IdeaRow,
): Promise<SharedReview> {
  const old = await env.DB.prepare(
    "SELECT * FROM council_reviews WHERE idea_id=?",
  )
    .bind(idea.id)
    .first<SharedReview>();
  if (old) return old;
  // Import v1 values as an unagreed draft; old seconds are not whole-review votes.
  const draft = emptyDraft();
  const legacy = await env.DB.prepare(
    `SELECT i.* FROM assessment_items i JOIN assessments a ON a.id=i.assessment_id WHERE a.idea_id=?`,
  )
    .bind(idea.id)
    .all<any>();
  for (const i of legacy.results ?? []) {
    if (i.item_id in draft.scores) {
      draft.scores[i.item_id] = i.value;
      draft.reasons[i.item_id] = i.reason;
    } else if (i.value === 1) {
      draft.issues.push(i.item_id);
      draft.issueReason += `${i.item_id}: ${i.reason}\n`;
    }
  }
  // Legacy reasons may exceed the new form limits. Preserve them in old tables;
  // truncate only this editable import to match native Discord inputs.
  Object.keys(draft.reasons).forEach(
    (k) => (draft.reasons[k] = draft.reasons[k].slice(0, 500)),
  );
  draft.issueReason = draft.issueReason.slice(0, 1000);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO council_reviews(idea_id,idea_content,draft,updated_at) VALUES(?,?,?,?)`,
  )
    .bind(idea.id, contentOf(idea), JSON.stringify(draft), now())
    .run();
  return (await env.DB.prepare("SELECT * FROM council_reviews WHERE idea_id=?")
    .bind(idea.id)
    .first<SharedReview>())!;
}
// Dialogs must be returned within Discord's initial-response deadline. Read the
// existing review, private-thread guard and scoring history in one round trip.
// Unlike getReview this never imports/creates a draft on the modal-opening path.
export async function reviewModalState(
  env: Env,
  ideaId: number,
  scoring: boolean,
) {
  return env.DB.prepare(
    `SELECT r.*, i.status AS idea_status, i.review_thread_id,
    EXISTS(SELECT 1 FROM council_review_events e WHERE ? AND e.idea_id=r.idea_id
      AND e.action NOT IN ('request_change','withdraw_change')
      AND json_type(e.snapshot,'$.scores.usefulness')='integer' AND json_extract(e.snapshot,'$.scores.usefulness') BETWEEN 1 AND 5
      AND json_type(e.snapshot,'$.scores.feasibility')='integer' AND json_extract(e.snapshot,'$.scores.feasibility') BETWEEN 1 AND 5
      AND json_type(e.snapshot,'$.scores.interest')='integer' AND json_extract(e.snapshot,'$.scores.interest') BETWEEN 1 AND 5 LIMIT 1) AS previously_scored
    FROM council_reviews r JOIN ideas i ON i.id=r.idea_id WHERE r.idea_id=?`,
  )
    .bind(Number(scoring), ideaId)
    .first<
      SharedReview & {
        idea_status: string;
        review_thread_id: string | null;
        previously_scored: number;
      }
    >();
}
export async function agreements(
  env: Env,
  r: SharedReview,
): Promise<Reviewer[]> {
  const res = await env.DB.prepare(
    "SELECT actor_id AS id, actor_name AS name FROM council_score_agreements WHERE idea_id=? AND score_revision=? ORDER BY at,actor_id",
  )
    .bind(r.idea_id, r.score_revision)
    .all<Reviewer>();
  return res.results ?? [];
}
function event(
  env: Env,
  r: SharedReview,
  action: string,
  actor: Reviewer,
  reason: string,
) {
  return env.DB.prepare(
    `INSERT INTO council_review_events(idea_id,revision,action,actor_id,actor_name,snapshot,reason,at)
    SELECT idea_id,revision,?, ?, ?,draft,?,? FROM council_reviews WHERE idea_id=? AND revision=? AND changes()=1`,
  ).bind(action, actor.id, actor.name, reason, now(), r.idea_id, r.revision);
}
function liveContentSql() {
  return `idea_content=(SELECT json_array(title,answers,schema_version) FROM ideas WHERE id=council_reviews.idea_id)`;
}
// SQL JSON uses the same serialized array as contentOf for these fields.
export async function editReview(
  env: Env,
  r: SharedReview,
  idea: IdeaRow,
  draft: ReviewDraft,
  actor: Reviewer,
  reason: string,
): Promise<void> {
  return commitRevision(env, r, idea, draft, actor, reason);
}
async function commitRevision(
  env: Env,
  r: SharedReview,
  idea: IdeaRow,
  draft: ReviewDraft,
  actor: Reviewer,
  reason: string,
  request?: ReviewChange,
  submitScores = false,
): Promise<void> {
  validateDraft(draft);
  if (!reason.trim() || reason.length > 1000)
    throw Error("Explain the revision (up to 1000 characters).");
  const previous: ReviewDraft = JSON.parse(r.draft);
  const contentChanged = r.idea_content !== contentOf(idea);
  const scoresChanged =
    contentChanged || scoreSignature(previous) !== scoreSignature(draft);
  const checksChanged =
    contentChanged ||
    checksSignature(previous) !== checksSignature(draft) ||
    (draft.issues.length > 0 && !r.checks_proposer_id);
  if (r.draft === JSON.stringify(draft) && !contentChanged && !checksChanged)
    throw Error("No assessment changes to save.");
  const next = { ...r, revision: r.revision + 1 };
  const editor = request
    ? { id: request.proposer_id, name: request.proposer_name }
    : actor;
  const permission = request
    ? `EXISTS(SELECT 1 FROM council_review_changes q WHERE q.id=? AND q.idea_id=council_reviews.idea_id AND q.base_revision=council_reviews.revision AND q.idea_content=council_reviews.idea_content AND q.status='pending' AND q.proposer_id!=?)`
    : `(author_id IS NULL OR author_id=?)`;
  const permissionArgs = request ? [request.id, actor.id] : [actor.id];
  const autoAgree =
    (submitScores || (!!request && scoresChanged)) &&
    draftResult(draft).total !== null;
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE council_reviews SET draft=?,idea_content=?,revision=revision+1,
       score_revision=score_revision+?,checks_revision=checks_revision+?,
       checks_proposer_id=CASE WHEN ? THEN ? ELSE checks_proposer_id END,
       checks_proposer_name=CASE WHEN ? THEN ? ELSE checks_proposer_name END,
       checks_seconder_id=CASE WHEN ? THEN NULL ELSE checks_seconder_id END,
       checks_seconder_name=CASE WHEN ? THEN NULL ELSE checks_seconder_name END,
       status='open',record_message_id=NULL,updated_at=?,author_id=?,author_name=?
       WHERE idea_id=? AND revision=? AND status='open'
       AND (SELECT status FROM ideas WHERE id=?)!='resolved'
       AND (SELECT json_array(title,answers,schema_version) FROM ideas WHERE id=?)=?
       AND ${permission}`,
    ).bind(
      JSON.stringify(draft),
      contentOf(idea),
      Number(scoresChanged),
      Number(checksChanged),
      Number(checksChanged),
      draft.issues.length ? editor.id : null,
      Number(checksChanged),
      draft.issues.length ? editor.name : null,
      Number(checksChanged),
      Number(checksChanged),
      now(),
      editor.id,
      editor.name,
      r.idea_id,
      r.revision,
      r.idea_id,
      r.idea_id,
      contentOf(idea),
      ...permissionArgs,
    ),
    event(
      env,
      next,
      request ? "apply_change" : "revise",
      actor,
      request
        ? `Request #${request.id} by ${request.proposer_name}: ${reason}`
        : reason,
    ),
    ...(request
      ? [
          env.DB.prepare(
            `UPDATE council_review_changes SET status='applied',applied_by_id=?,applied_by_name=? WHERE id=? AND changes()=1`,
          ).bind(actor.id, actor.name, request.id),
        ]
      : []),
    ...(autoAgree
      ? [
          env.DB.prepare(
            `INSERT OR IGNORE INTO council_score_agreements(idea_id,score_revision,actor_id,actor_name,at)
        SELECT idea_id,score_revision,?,?,? FROM council_reviews WHERE idea_id=? AND revision=? AND status='open' AND changes()=1`,
          ).bind(editor.id, editor.name, now(), r.idea_id, next.revision),
          event(
            env,
            next,
            "agree_scores",
            editor,
            "Submitted the current scores; counts as the first agreement",
          ),
        ]
      : []),
  ]);
  if (!res[0].meta.changes)
    throw Error(
      "Assessment changed, is closed, or has another editor. Refresh and request a change.",
    );
}
export async function agreeReview(
  env: Env,
  r: SharedReview,
  actor: Reviewer,
): Promise<void> {
  validateDraft(JSON.parse(r.draft));
  if (draftResult(JSON.parse(r.draft)).total === null)
    throw Error(
      "Complete all three scores before agreeing to the final scores.",
    );
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO council_score_agreements(idea_id,score_revision,actor_id,actor_name,at)
      SELECT idea_id,score_revision,?,?,? FROM council_reviews WHERE idea_id=? AND revision=? AND status='open' AND ${liveContentSql()} AND (SELECT status FROM ideas WHERE id=?)!='resolved'`,
    ).bind(actor.id, actor.name, now(), r.idea_id, r.revision, r.idea_id),
    env.DB.prepare(
      `INSERT INTO council_review_events(idea_id,revision,action,actor_id,actor_name,snapshot,reason,at)
      SELECT r.idea_id,r.revision,'agree_scores',?,?,r.draft,'',? FROM council_reviews r
      WHERE r.idea_id=? AND r.revision=? AND r.status='open' AND changes()=1 AND EXISTS(SELECT 1 FROM council_score_agreements a WHERE a.idea_id=r.idea_id AND a.score_revision=r.score_revision AND a.actor_id=?)`,
    ).bind(actor.id, actor.name, now(), r.idea_id, r.revision, actor.id),
  ]);
  if (!res[0].meta.changes)
    throw Error("Already agreed, or the idea/assessment changed. Refresh it.");
}
export async function withdrawAgreement(
  env: Env,
  r: SharedReview,
  actor: Reviewer,
): Promise<void> {
  const res = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM council_score_agreements WHERE idea_id=? AND score_revision=? AND actor_id=? AND EXISTS(SELECT 1 FROM council_reviews WHERE idea_id=? AND revision=? AND status='open')`,
    ).bind(r.idea_id, r.score_revision, actor.id, r.idea_id, r.revision),
    event(env, r, "withdraw_scores", actor, ""),
  ]);
  if (!res[0].meta.changes)
    throw Error("No current agreement to withdraw, or assessment closed.");
}
export async function secondChecks(
  env: Env,
  r: SharedReview,
  actor: Reviewer,
): Promise<void> {
  const draft: ReviewDraft = JSON.parse(r.draft);
  if (!draft.issues.length)
    throw Error("No checks selected; they pass by default.");
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE council_reviews SET checks_seconder_id=?,checks_seconder_name=?,updated_at=?
      WHERE idea_id=? AND revision=? AND status='open' AND checks_proposer_id IS NOT NULL
      AND checks_proposer_id!=? AND checks_seconder_id IS NULL AND ${liveContentSql()}
      AND (SELECT status FROM ideas WHERE id=?)!='resolved'`,
    ).bind(
      actor.id,
      actor.name,
      now(),
      r.idea_id,
      r.revision,
      actor.id,
      r.idea_id,
    ),
    event(
      env,
      r,
      "second_checks",
      actor,
      "Seconded all selected checks and their explanation",
    ),
  ]);
  if (!res[0].meta.changes)
    throw Error(
      "A different member must second the current checks. They may already be seconded or have changed.",
    );
}
export async function withdrawChecksSecond(
  env: Env,
  r: SharedReview,
  actor: Reviewer,
): Promise<void> {
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE council_reviews SET checks_seconder_id=NULL,checks_seconder_name=NULL,updated_at=?
      WHERE idea_id=? AND revision=? AND status='open' AND checks_seconder_id=?`,
    ).bind(now(), r.idea_id, r.revision, actor.id),
    event(env, r, "withdraw_checks_second", actor, ""),
  ]);
  if (!res[0].meta.changes)
    throw Error(
      "You have no current second to withdraw, or the assessment is closed.",
    );
}
export async function reservePublish(env: Env, r: SharedReview): Promise<void> {
  validateDraft(JSON.parse(r.draft));
  if (
    !draftResult(JSON.parse(r.draft)).ready ||
    draftResult(JSON.parse(r.draft)).total === null
  )
    throw Error("Please score all categories, or cancel.");
  const res = await env.DB.prepare(
    `UPDATE council_reviews SET status='publishing',updated_at=?
    WHERE idea_id=? AND revision=? AND status IN ('open','publishing') AND ${liveContentSql()}
    AND (SELECT status FROM ideas WHERE id=?)!='resolved'
    AND json_type(draft,'$.scores.usefulness')='integer' AND json_extract(draft,'$.scores.usefulness') BETWEEN 1 AND 5
    AND json_type(draft,'$.scores.feasibility')='integer' AND json_extract(draft,'$.scores.feasibility') BETWEEN 1 AND 5
    AND json_type(draft,'$.scores.interest')='integer' AND json_extract(draft,'$.scores.interest') BETWEEN 1 AND 5
    AND (
      (json_array_length(json_extract(draft,'$.issues'))>0 AND checks_proposer_id IS NOT NULL
       AND checks_seconder_id IS NOT NULL AND checks_proposer_id!=checks_seconder_id)
      OR (json_array_length(json_extract(draft,'$.issues'))=0
       AND (SELECT COUNT(*) FROM council_score_agreements WHERE idea_id=council_reviews.idea_id
         AND score_revision=council_reviews.score_revision)>=?)
    )`,
  )
    .bind(now(), r.idea_id, r.revision, r.idea_id, AGREEMENTS_REQUIRED)
    .run();
  if (!res.meta.changes)
    throw Error(
      "Selected checks need a second; final scores need three agreements. Refresh if the idea or assessment changed.",
    );
}
export async function finishPublish(
  env: Env,
  r: SharedReview,
  messageId: string,
  actor: Reviewer,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE council_reviews SET status='published',record_message_id=?,updated_at=? WHERE idea_id=? AND revision=? AND status='publishing'`,
    ).bind(messageId, now(), r.idea_id, r.revision),
    event(env, r, "publish", actor, messageId),
  ]);
}

// Friendly preflight for the Discord status selector. updateStatus repeats this
// condition atomically so a concurrent edit/withdrawal cannot slip past it.
export async function canMarkReviewed(
  env: Env,
  idea: IdeaRow,
): Promise<boolean> {
  const r = await env.DB.prepare(
    "SELECT * FROM council_reviews WHERE idea_id=?",
  )
    .bind(idea.id)
    .first<SharedReview>();
  if (!r || r.idea_content !== contentOf(idea)) return false;
  const draft: ReviewDraft = JSON.parse(r.draft);
  validateDraft(draft);
  return (
    draftResult(draft).total !== null &&
    (await agreements(env, r)).length >= AGREEMENTS_REQUIRED
  );
}

export interface ReviewChange {
  id: number;
  idea_id: number;
  base_revision: number;
  idea_content: string;
  proposer_id: string;
  proposer_name: string;
  draft: string;
  reason: string;
  status: string;
  applied_by_id: string | null;
  applied_by_name: string | null;
}
export async function startReview(env: Env, r: SharedReview, actor: Reviewer) {
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE council_reviews SET author_id=?,author_name=?,revision=revision+1,updated_at=?
      WHERE idea_id=? AND revision=? AND author_id IS NULL AND status='open'
      AND (SELECT status FROM ideas WHERE id=?)!='resolved'`,
    ).bind(actor.id, actor.name, now(), r.idea_id, r.revision, r.idea_id),
    event(
      env,
      { ...r, revision: r.revision + 1 },
      "start",
      actor,
      "Started assessment",
    ),
  ]);
  if (!result[0].meta.changes)
    throw Error("Assessment already started or changed. Refresh it.");
}
export async function reviewChanges(
  env: Env,
  ideaId: number,
  limit = 3,
  offset = 0,
) {
  const rows = await env.DB.prepare(
    "SELECT * FROM council_review_changes WHERE idea_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
  )
    .bind(ideaId, limit, offset)
    .all<ReviewChange>();
  return rows.results ?? [];
}
export async function saveOrRequestChange(
  env: Env,
  r: SharedReview,
  idea: IdeaRow,
  draft: ReviewDraft,
  actor: Reviewer,
  reason: string,
  submitScores = false,
) {
  if (!r.author_id) throw Error("Click Start assessment first.");
  if (r.author_id === actor.id)
    return commitRevision(
      env,
      r,
      idea,
      draft,
      actor,
      reason,
      undefined,
      submitScores,
    );
  validateDraft(draft);
  if (!reason.trim() || reason.length > 1000)
    throw Error("Explain the requested change.");
  if (r.idea_content !== contentOf(idea))
    throw Error("The idea changed; the editor must reassess it first.");
  if (r.draft === JSON.stringify(draft)) throw Error("No changes to request.");
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO council_review_changes(idea_id,base_revision,idea_content,proposer_id,proposer_name,draft,reason,created_at)
      SELECT idea_id,revision,idea_content,?,?,?,?,? FROM council_reviews
      WHERE idea_id=? AND revision=? AND status='open' AND author_id IS NOT NULL AND author_id!=?
      AND ${liveContentSql()} AND (SELECT status FROM ideas WHERE id=?)!='resolved'`,
    ).bind(
      actor.id,
      actor.name,
      JSON.stringify(draft),
      reason.trim(),
      now(),
      r.idea_id,
      r.revision,
      actor.id,
      r.idea_id,
    ),
    env.DB
      .prepare(`INSERT INTO council_review_events(idea_id,revision,action,actor_id,actor_name,snapshot,reason,at)
      SELECT idea_id,base_revision,'request_change',proposer_id,proposer_name,draft,reason,created_at
      FROM council_review_changes WHERE id=last_insert_rowid() AND changes()=1`),
  ]);
  if (!result[0].meta.changes)
    throw Error(
      "Assessment changed or closed. Refresh before requesting a change.",
    );
}
export async function applyReviewChange(
  env: Env,
  r: SharedReview,
  idea: IdeaRow,
  requestId: number,
  actor: Reviewer,
) {
  const q = await env.DB.prepare(
    "SELECT * FROM council_review_changes WHERE id=? AND idea_id=?",
  )
    .bind(requestId, r.idea_id)
    .first<ReviewChange>();
  if (
    !q ||
    q.status !== "pending" ||
    q.base_revision !== r.revision ||
    q.idea_content !== contentOf(idea)
  )
    throw Error(
      "This change request is outdated or no longer pending. Refresh it.",
    );
  if (q.proposer_id === actor.id)
    throw Error("A different Council member must back your request.");
  // Author acceptance and one other backer have the same effect. Applying never
  // creates a checks second or final-score vote. The proposer becomes the editor.
  await commitRevision(env, r, idea, JSON.parse(q.draft), actor, q.reason, q);
}
export async function withdrawReviewChange(
  env: Env,
  r: SharedReview,
  requestId: number,
  actor: Reviewer,
) {
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE council_review_changes SET status='withdrawn'
      WHERE id=? AND idea_id=? AND proposer_id=? AND status='pending'
      AND EXISTS(SELECT 1 FROM council_reviews WHERE idea_id=? AND status='open')`,
    ).bind(requestId, r.idea_id, actor.id, r.idea_id),
    env.DB.prepare(
      `INSERT INTO council_review_events(idea_id,revision,action,actor_id,actor_name,snapshot,reason,at)
      SELECT idea_id,base_revision,'withdraw_change',?,?,draft,reason,? FROM council_review_changes WHERE id=? AND changes()=1`,
    ).bind(actor.id, actor.name, now(), requestId),
  ]);
  if (!result[0].meta.changes)
    throw Error(
      "Only the proposer can withdraw a pending request while the assessment is open.",
    );
}

export interface ReviewEvent {
  id: number;
  idea_id: number;
  revision: number;
  action: string;
  actor_id: string;
  actor_name: string;
  snapshot: string;
  reason: string;
  at: number;
  previous_snapshot: string | null;
}
export const HISTORY_PAGE_SIZE = 5;
export async function assessmentHistory(
  env: Env,
  ideaId: number,
  page = 0,
  anchor = 0,
) {
  if (
    !Number.isSafeInteger(page) ||
    page < 0 ||
    page > 1_000_000 ||
    !Number.isSafeInteger(anchor) ||
    anchor < 0
  )
    throw Error("Invalid history page.");
  // Freeze the upper event id for stable navigation while other members vote.
  const max = await env.DB.prepare(
    "SELECT COALESCE(MAX(id),0) AS id FROM council_review_events WHERE idea_id=?",
  )
    .bind(ideaId)
    .first<{ id: number }>();
  const upper = anchor || max!.id;
  const result = await env.DB.prepare(
    `SELECT e.*,
    (SELECT p.snapshot FROM council_review_events p WHERE p.idea_id=e.idea_id AND p.id<e.id
      AND p.action NOT IN ('request_change','withdraw_change') ORDER BY p.id DESC LIMIT 1) AS previous_snapshot
    FROM council_review_events e WHERE e.idea_id=? AND e.id<=? ORDER BY e.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(ideaId, upper, HISTORY_PAGE_SIZE + 1, page * HISTORY_PAGE_SIZE)
    .all<ReviewEvent>();
  const rows = result.results ?? [];
  return {
    events: rows.slice(0, HISTORY_PAGE_SIZE),
    hasNext: rows.length > HISTORY_PAGE_SIZE,
    anchor: upper,
  };
}
export async function assessmentEvent(
  env: Env,
  ideaId: number,
  eventId: number,
) {
  if (!Number.isSafeInteger(eventId) || eventId <= 0)
    throw Error("Invalid history entry.");
  return env.DB.prepare(
    "SELECT * FROM council_review_events WHERE idea_id=? AND id=?",
  )
    .bind(ideaId, eventId)
    .first<ReviewEvent>();
}

// A completed historical assessment remains a prior submission after reopening.
export async function hasSubmittedScores(
  env: Env,
  r: SharedReview,
): Promise<boolean> {
  if (draftResult(JSON.parse(r.draft)).total !== null) return true;
  const row = await env.DB.prepare(
    `SELECT 1 AS found FROM council_review_events WHERE idea_id=?
    AND action NOT IN ('request_change','withdraw_change')
    AND json_type(snapshot,'$.scores.usefulness')='integer' AND json_extract(snapshot,'$.scores.usefulness') BETWEEN 1 AND 5
    AND json_type(snapshot,'$.scores.feasibility')='integer' AND json_extract(snapshot,'$.scores.feasibility') BETWEEN 1 AND 5
    AND json_type(snapshot,'$.scores.interest')='integer' AND json_extract(snapshot,'$.scores.interest') BETWEEN 1 AND 5 LIMIT 1`,
  )
    .bind(r.idea_id)
    .first();
  return !!row;
}
export async function submitReviewScores(
  env: Env,
  r: SharedReview,
  idea: IdeaRow,
  scores: Record<string, number>,
  actor: Reviewer,
  explanation: string,
  summary?: string,
) {
  const draft: ReviewDraft = JSON.parse(r.draft);
  for (const id of ["usefulness", "feasibility", "interest"])
    if (!Number.isInteger(scores[id]) || scores[id] < 1 || scores[id] > 5)
      throw Error("Please score all categories, or cancel.");
  const changed = Object.keys(draft.scores).filter(
    (id) => scores[id] !== draft.scores[id],
  );
  const summaryChanged = summary !== undefined && summary.trim() !== draft.note;
  if (!changed.length && !summaryChanged) {
    if (explanation.trim())
      throw Error(
        "No scores changed. Put response wording in Summary instead.",
      );
    return;
  }
  if (summary !== undefined) draft.note = summary.trim();
  const prior = await hasSubmittedScores(env, r);
  if (explanation.length > 500)
    throw Error("The reason must be at most 500 characters.");
  const reason = explanation.trim();
  if (prior && changed.length && !reason)
    throw Error("Explain why you are changing the submitted scores.");
  for (const id of changed) {
    draft.scores[id] = scores[id];
    if (reason) draft.reasons[id] = reason;
    else delete draft.reasons[id];
  }
  await saveOrRequestChange(
    env,
    r,
    idea,
    draft,
    actor,
    reason ||
      (changed.length
        ? "Initial scores submitted"
        : "Updated response summary"),
    changed.length > 0,
  );
}
export async function pendingReviewChanges(
  env: Env,
  r: SharedReview,
): Promise<ReviewChange[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM council_review_changes WHERE idea_id=? AND base_revision=? AND idea_content=? AND status='pending' ORDER BY id",
  )
    .bind(r.idea_id, r.revision, r.idea_content)
    .all<ReviewChange>();
  return rows.results ?? [];
}
