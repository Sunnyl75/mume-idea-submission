// Independent approvals: one second for checks; three agreements on final scores.
import { CRITERIA, CHECKS, BANDS } from "./rubric";
import type { IdeaRow } from "../types";
export const AGREEMENTS_REQUIRED = 3;
export interface ReviewDraft {
  scores: Record<string, number | null>;
  reasons: Record<string, string>;
  issues: string[];
  issueReason: string;
  note: string;
}
export interface Reviewer {
  id: string;
  name: string;
}
export const emptyDraft = (): ReviewDraft => ({
  scores: { usefulness: null, feasibility: null, interest: null },
  reasons: {},
  issues: [],
  issueReason: "",
  note: "",
});
export function contentOf(
  idea: Pick<IdeaRow, "title" | "answers" | "schema_version">,
): string {
  return JSON.stringify([idea.title, idea.answers, idea.schema_version]);
}
export function scoreSignature(d: ReviewDraft): string {
  return JSON.stringify(
    CRITERIA.map((c) => [c.id, d.scores[c.id], d.reasons[c.id] ?? ""]),
  );
}
export function checksSignature(d: ReviewDraft): string {
  return JSON.stringify([
    CHECKS.filter((c) => d.issues.includes(c.id)).map((c) => c.id),
    d.issues.length ? d.issueReason : "",
  ]);
}
export function checksAgreed(
  d: ReviewDraft,
  proposer: string | null,
  seconder: string | null,
): boolean {
  return !d.issues.length || !!(proposer && seconder && proposer !== seconder);
}
export function readyToClose(
  d: ReviewDraft,
  scoreVotes: number,
  proposer: string | null,
  seconder: string | null,
): boolean {
  const result = draftResult(d);
  if (result.flags.length)
    return (
      result.total !== null &&
      result.ready &&
      checksAgreed(d, proposer, seconder)
    );
  return result.total !== null && scoreVotes >= AGREEMENTS_REQUIRED;
}
export function validateDraft(d: ReviewDraft): void {
  if (!d || !d.scores || !d.reasons || !Array.isArray(d.issues))
    throw Error("Invalid assessment.");
  for (const c of CRITERIA) {
    const v = d.scores[c.id];
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > 5))
      throw Error("Scores must be 1–5, or blank.");
    if (
      d.reasons[c.id] !== undefined &&
      (typeof d.reasons[c.id] !== "string" || d.reasons[c.id].length > 500)
    )
      throw Error("Score explanations must be at most 500 characters.");
  }
  if (
    d.issues.length > CHECKS.length ||
    new Set(d.issues).size !== d.issues.length ||
    d.issues.some((id) => !CHECKS.some((c) => c.id === id))
  )
    throw Error("Unknown or duplicate issue.");
  if (
    typeof d.issueReason !== "string" ||
    d.issueReason.length > 1000 ||
    (d.issues.length && !d.issueReason.trim())
  )
    throw Error("Explain the selected issues (up to 1000 characters).");
  if (typeof d.note !== "string" || d.note.length > 1000)
    throw Error("Feedback must be at most 1000 characters.");
}
export function draftResult(d: ReviewDraft) {
  const flags = CHECKS.filter((c) => d.issues.includes(c.id));
  const complete = CRITERIA.every((c) => Number.isInteger(d.scores[c.id]));
  const total = complete
    ? CRITERIA.reduce((n, c) => n + d.scores[c.id]! * c.weight, 0)
    : null;
  return {
    flags,
    total,
    band:
      !flags.length && total !== null
        ? BANDS.find((b) => total <= b.max)!
        : null,
    ready: flags.length ? !!d.issueReason.trim() : complete,
  };
}
export function feedbackFor(
  idea: Pick<IdeaRow, "id" | "title">,
  d: ReviewDraft,
): string {
  const r = draftResult(d);
  const lines = [`Idea #${idea.id} — ${idea.title}`];
  if (r.flags.length) {
    lines.push("Further action required");
    for (const c of r.flags) lines.push(`${c.action}: ${c.feedback}`);
  } else if (r.band) {
    lines.push(`${r.band.name} · ${r.total}/20`, r.band.feedback);
  } else lines.push("Draft — scores incomplete.");
  for (const c of CRITERIA) {
    const score = d.scores[c.id];
    lines.push(
      score === null
        ? `${c.name}: not assessed`
        : `${c.name}: ${score}/5${c.weight === 2 ? " (×2)" : ""}\n${c.levels[score - 1]}`,
    );
  }
  const notes = CRITERIA.filter((c) => d.reasons[c.id]?.trim()).map(
    (c) => `${c.name}: ${d.reasons[c.id].trim()}`,
  );
  if (d.issues.length && d.issueReason.trim())
    notes.push(`Checks: ${d.issueReason.trim()}`);
  if (d.note.trim()) notes.push(d.note.trim());
  if (notes.length) lines.push("Council notes:\n" + notes.join("\n"));
  lines.push("A recommendation does not guarantee implementation.");
  return lines.join("\n\n");
}
