// Council idea-review rubric: gate checks + weighted scoring + recommendation
// bands, and the derived result. Pure and framework-free so it can be unit tested
// and is the single source of truth — the client never computes the outcome.
//
// Bump RUBRIC_VERSION if the criteria, checks or bands change; each assessment
// stamps the version it was made against so old results stay readable.

export const RUBRIC_VERSION = 1;

export interface Criterion {
  id: string;
  name: string;
  weight: number;
  levels: string[]; // index 0..4 => score 1..5
}
export interface Check {
  id: string;
  name: string;
  action: string;
  feedback: string;
}
export interface Band {
  max: number;
  name: string;
  feedback: string;
}

export const CRITERIA: Criterion[] = [
  {
    id: "usefulness",
    name: "Usefulness",
    weight: 1,
    levels: [
      "The practical benefit is limited or has not yet been demonstrated.",
      "This offers a modest benefit in a narrow set of circumstances.",
      "This would provide a worthwhile improvement for a defined group of players.",
      "This would provide a substantial improvement or address a recurring problem.",
      "This would address a major problem or provide substantial benefit across the game.",
    ],
  },
  {
    id: "feasibility",
    name: "Feasibility",
    weight: 2,
    levels: [
      "This would require a very large amount of work, with extensive changes across multiple systems.",
      "This would require substantial work, involving significant changes and considerable testing.",
      "This would require a moderate amount of work, with several changes and some testing.",
      "This would require relatively little work, with a small number of contained changes.",
      "This would require minimal work, such as a straightforward adjustment to existing content or behaviour.",
    ],
  },
  {
    id: "interest",
    name: "Interest",
    weight: 1,
    levels: [
      "There is little demonstrated interest so far.",
      "A small number of players have expressed interest.",
      "There is clear interest from a relevant group of players.",
      "There is strong interest across several groups of players.",
      "There is broad, sustained interest across the community.",
    ],
  },
];

export const CHECKS: Check[] = [
  {
    id: "clarity",
    name: "Needs more clarity",
    action: "Return for clarification",
    feedback: "Please clarify the problem and what the change would do.",
  },
  {
    id: "evidence",
    name: "Needs development or evidence",
    action: "Return for further work",
    feedback:
      "Needs more detail or examples before we can assess benefits and implications.",
  },
  {
    id: "split",
    name: "Several separable ideas",
    action: "Return to split",
    feedback: "Contains distinct changes; please submit them separately.",
  },
  {
    id: "exists",
    name: "Already exists",
    action: "Explain and close",
    feedback: "This is already supported; please explain any remaining gap.",
  },
  {
    id: "duplicate",
    name: "Duplicates a proposal",
    action: "Link and consolidate",
    feedback: "Overlaps an existing proposal; add your support there.",
  },
  {
    id: "dependency",
    name: "Depends on another change",
    action: "Defer and link",
    feedback: "Depends on another change being completed first.",
  },
];

export const BANDS: Band[] = [
  {
    max: 7,
    name: "Low priority",
    feedback:
      "Benefit and interest are limited relative to the effort. Other proposals take priority.",
  },
  {
    max: 10,
    name: "Worth retaining",
    feedback:
      "Some merit, but not a current priority. Keep for future consideration.",
  },
  {
    max: 13,
    name: "Worth considering",
    feedback:
      "A reasonable balance of benefit, interest and effort. Merits further consideration.",
  },
  {
    max: 16,
    name: "Recommended",
    feedback:
      "Scores well overall. We recommend considering it for implementation.",
  },
  {
    max: 20,
    name: "Strongly recommended",
    feedback:
      "A particularly favourable balance of benefit, interest and effort. High priority.",
  },
];

export const CRITERION_IDS = CRITERIA.map((c) => c.id);
export const CHECK_IDS = CHECKS.map((c) => c.id);
export const ITEM_IDS = [...CHECK_IDS, ...CRITERION_IDS];

export const isCriterion = (id: string): boolean => CRITERION_IDS.includes(id);
export const isCheck = (id: string): boolean => CHECK_IDS.includes(id);

// value: criteria 1..5, checks 0|1 (1 = "yes", which flags the idea for return).
export function isValidValue(itemId: string, value: number): boolean {
  if (isCriterion(itemId))
    return Number.isInteger(value) && value >= 1 && value <= 5;
  if (isCheck(itemId)) return value === 0 || value === 1;
  return false;
}

export interface Assignment {
  value: number;
  reason: string;
  proposerId: string;
  proposerName: string;
  seconderId: string | null;
  seconderName: string | null;
  revision: number;
}
export type Assignments = Record<string, Assignment>;

export interface ReviewResult {
  status:
    | "Assessment in progress"
    | "Further action required"
    | "Assessment agreed";
  flags: Check[];
  pendingIds: string[];
  total: number | null;
  band: Band | null;
  secondedCount: number;
}

// Derive the outcome. A seconded "yes" check overrides the score and returns the
// idea; otherwise, once every item is seconded, the weighted total gives a band.
export function computeResult(assignments: Assignments): ReviewResult {
  const agreed = (id: string): boolean => !!assignments[id]?.seconderId;
  const flags = CHECKS.filter(
    (c) => agreed(c.id) && assignments[c.id].value === 1,
  );
  const pendingIds = ITEM_IDS.filter((id) => !agreed(id));
  const secondedCount = ITEM_IDS.length - pendingIds.length;

  if (flags.length)
    return {
      status: "Further action required",
      flags,
      pendingIds,
      total: null,
      band: null,
      secondedCount,
    };
  if (pendingIds.length)
    return {
      status: "Assessment in progress",
      flags,
      pendingIds,
      total: null,
      band: null,
      secondedCount,
    };

  const total = CRITERIA.reduce(
    (sum, c) => sum + assignments[c.id].value * c.weight,
    0,
  );
  const band = BANDS.find((b) => total <= b.max) ?? BANDS[BANDS.length - 1];
  return {
    status: "Assessment agreed",
    flags,
    pendingIds: [],
    total,
    band,
    secondedCount,
  };
}

// The author-facing feedback text, built from the agreed assessment.
export function feedbackText(
  ideaRef: string,
  assignments: Assignments,
  councilNote: string,
): string {
  const r = computeResult(assignments);
  const lines: string[] = [ideaRef, r.status];
  if (r.flags.length) {
    for (const c of r.flags) {
      lines.push(`${c.action}: ${c.feedback}`);
      lines.push(`Note: ${assignments[c.id].reason}`);
    }
  } else if (r.total !== null && r.band) {
    lines.push(`${r.band.name} · ${r.total} / 20`);
    for (const c of CRITERIA) {
      const a = assignments[c.id];
      lines.push(`${c.name}: ${a.value}/5 — ${a.reason}`);
    }
    lines.push(r.band.feedback);
  } else {
    lines.push(
      "Final recommendation pending until every check and score is seconded.",
    );
  }
  if (councilNote.trim()) lines.push(councilNote.trim());
  return lines.join("\n\n");
}
