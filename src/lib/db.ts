// D1 access for ideas and status history.

import type { Answers, Env, IdeaRow, Status } from "../types";
import { AGREEMENTS_REQUIRED } from "./sharedReview";

export async function getIdea(env: Env, id: number): Promise<IdeaRow | null> {
  const row = await env.DB.prepare("SELECT * FROM ideas WHERE id = ?").bind(id).first<IdeaRow>();
  return row ?? null;
}

export interface NewIdea {
  guildId: string;
  authorId: string;
  authorName: string;
  title: string;
  schemaVersion: number;
  answers: Answers;
}

// Insert an idea and return the assigned id. Status defaults to in_proposal.
export async function insertIdea(env: Env, idea: NewIdea, now: number): Promise<IdeaRow> {
  const result = await env.DB.prepare(
    `INSERT INTO ideas (guild_id, author_id, author_name, title, status, schema_version, answers, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'in_proposal', ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(
      idea.guildId,
      idea.authorId,
      idea.authorName,
      idea.title,
      idea.schemaVersion,
      JSON.stringify(idea.answers),
      now,
      now,
    )
    .first<IdeaRow>();
  if (!result) throw new Error("insert failed");
  return result;
}

export async function attachThread(
  env: Env,
  ideaId: number,
  threadId: string,
  messageId: string,
  now: number,
): Promise<void> {
  await env.DB.prepare("UPDATE ideas SET thread_id = ?, message_id = ?, updated_at = ? WHERE id = ?")
    .bind(threadId, messageId, now, ideaId)
    .run();
}

// Overwrite an idea's answers/title when it is edited, re-stamping the config
// version the new answers were validated against.
export async function updateIdeaAnswers(
  env: Env,
  ideaId: number,
  title: string,
  answers: Answers,
  schemaVersion: number,
  now: number,
): Promise<void> {
  const result = await env.DB.prepare("UPDATE ideas SET title = ?, answers = ?, schema_version = ?, updated_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM council_reviews WHERE idea_id=ideas.id AND status='publishing')")
    .bind(title, JSON.stringify(answers), schemaVersion, now, ideaId)
    .run();
  if (!result.meta.changes) throw new Error("An assessment is being published. Retry the edit after publication completes.");
}

// Record the mirrored review-forum copy created when an idea is Submitted.
export async function attachReview(
  env: Env,
  ideaId: number,
  reviewThreadId: string,
  reviewMessageId: string,
  now: number,
): Promise<void> {
  await env.DB.prepare("UPDATE ideas SET review_thread_id = ?, review_message_id = ?, updated_at = ? WHERE id = ?")
    .bind(reviewThreadId, reviewMessageId, now, ideaId)
    .run();
}

export async function updateStatus(
  env: Env,
  ideaId: number,
  status: Status,
  now: number,
): Promise<void> {
  // Guard Reviewed at the write itself, not just the UI: approvals must match the
  // current score revision and the current idea content at the moment of update.
  const result = await env.DB.prepare(
    `UPDATE ideas SET status=?,updated_at=? WHERE id=?
    AND NOT EXISTS(SELECT 1 FROM council_reviews WHERE idea_id=ideas.id AND status='publishing')
    AND (?!='approved' OR EXISTS (
      SELECT 1 FROM council_reviews r WHERE r.idea_id=ideas.id
      AND r.idea_content=json_array(ideas.title,ideas.answers,ideas.schema_version)
      AND json_type(r.draft,'$.scores.usefulness')='integer'
      AND json_extract(r.draft,'$.scores.usefulness') BETWEEN 1 AND 5
      AND json_type(r.draft,'$.scores.feasibility')='integer'
      AND json_extract(r.draft,'$.scores.feasibility') BETWEEN 1 AND 5
      AND json_type(r.draft,'$.scores.interest')='integer'
      AND json_extract(r.draft,'$.scores.interest') BETWEEN 1 AND 5
      AND (SELECT COUNT(*) FROM council_score_agreements a WHERE a.idea_id=r.idea_id
        AND a.score_revision=r.score_revision)>=?
    ))`,
  )
    .bind(status, now, ideaId, status, AGREEMENTS_REQUIRED)
    .run();
  if (!result.meta.changes)
    throw new Error(
      status === "approved"
        ? "Reviewed requires three Council members to agree to the current final scores. Refresh after any changes."
        : "An assessment is being recorded. Retry the status change after recording completes.",
    );
}

export async function logStatus(
  env: Env,
  ideaId: number,
  from: Status | null,
  to: Status,
  actorId: string,
  actorName: string,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO status_log (idea_id, from_status, to_status, actor_id, actor_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(ideaId, from, to, actorId, actorName, now)
    .run();
}

// Delete an idea and its status history (the forum post is removed separately).
export async function deleteIdea(env: Env, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM status_log WHERE idea_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM ideas WHERE id = ?").bind(id).run();
}

// Ideas that committed but never got their forum post (cron retry, spec §10).
export async function ideasMissingThread(env: Env): Promise<IdeaRow[]> {
  const res = await env.DB.prepare("SELECT * FROM ideas WHERE thread_id IS NULL ORDER BY id ASC LIMIT 25").all<IdeaRow>();
  return res.results ?? [];
}

// Unsubmitted ideas (still In Proposal or Final Draft) posted on/before `cutoff`.
// Used by the 30-day "still open" nudge; a thread is required to post the notice.
export async function agingUnsubmittedIdeas(env: Env, cutoff: number): Promise<IdeaRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM ideas WHERE status IN ('in_proposal','final_draft') AND thread_id IS NOT NULL AND created_at <= ? ORDER BY id ASC",
  )
    .bind(cutoff)
    .all<IdeaRow>();
  return res.results ?? [];
}
