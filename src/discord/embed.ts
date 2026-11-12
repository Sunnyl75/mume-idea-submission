// Render an idea into a Discord embed + status select (build spec §8).
// Labels are always resolved against the config version stamped on the row,
// never the live config.

import type { Answers, Field, FormConfig, IdeaRow, Status } from "../types";
import {
  STATUS_COLOR,
  STATUS_DESCRIPTION,
  STATUS_DOT,
  STATUS_LABEL,
  STATUSES,
} from "../constants";
import { fieldById } from "../lib/config";

const TITLE_MAX = 100; // thread name / embed title cap
const DESC_MAX = 3500; // embed description hard limit is 4096; leave headroom
const FIELD_VALUE_MAX = 1024; // Discord hard limit on a single embed field value
const EMBED_TOTAL_MAX = 6000; // Discord hard limit on total chars across an embed
const MAX_FIELDS = 25; // Discord hard limit on fields per embed
const CONT_NAME = "​"; // zero-width space: a "continuation" field with no visible label
const DIVIDER = "────────────────────────────";

export function truncate(s: string, max: number, tail = "…"): string {
  if (s.length <= max) return s;
  return s.slice(0, max - tail.length).trimEnd() + tail;
}

// Split a long value into <=max-char pieces, preferring to break on a blank line,
// then a newline, then a space, so a field never cuts mid-word. Used to spread a
// long-form answer across several embed fields instead of losing everything past
// Discord's 1024-char-per-field limit.
export function chunkValue(s: string, max = FIELD_VALUE_MAX): string[] {
  const out: string[] = [];
  let rest = s.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max; // no good boundary (e.g. one long token) — hard cut
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

// Resolve a stored answer to display text using the stamped config's field.
export function answerText(
  field: Field,
  value: string | string[] | undefined,
): string {
  if (value === undefined) return "—";
  if (field.type === "radio") {
    const opt = (field.options ?? []).find((o) => o.value === value);
    return opt?.label ?? String(value);
  }
  if (field.type === "checkbox") {
    const arr = Array.isArray(value) ? value : [value];
    const labels = arr.map(
      (v) => (field.options ?? []).find((o) => o.value === v)?.label ?? v,
    );
    return labels.length ? labels.join(", ") : "—";
  }
  const str = Array.isArray(value) ? value.join(", ") : String(value);
  return str.trim() === "" ? "—" : str;
}

export function ideaThreadName(id: number, title: string): string {
  return truncate(`Idea ${id} · ${title}`, TITLE_MAX);
}

export function buildEmbed(
  idea: IdeaRow,
  config: FormConfig,
): Record<string, unknown> {
  const answers = JSON.parse(idea.answers) as Answers;
  const status = idea.status;

  const bodyField = fieldById(config, config.embed.bodyField);
  const bodyRaw = bodyField ? answerText(bodyField, answers[bodyField.id]) : "";
  // Description leads the card: a header label (smaller than h2 so it doesn't
  // dwarf the body), the proposal, then a divider before the summary fields.
  const description = `### Description\n${truncate(bodyRaw || "—", DESC_MAX)}\n\n${DIVIDER}`;

  const author = {
    name: `${STATUS_DOT[status]}  ${STATUS_LABEL[status].toUpperCase()}`,
  };
  const title = ideaThreadName(idea.id, idea.title);
  const footer = { text: `Idea ${idea.id} · react to vote · reply to discuss` };

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Submitted by", value: idea.author_name, inline: true },
  ];

  for (const fid of config.embed.summaryFields) {
    const field = fieldById(config, fid);
    if (!field) continue;
    fields.push({
      name: field.embedLabel ?? field.label,
      value: truncate(answerText(field, answers[fid]), 256),
      inline: true,
    });
  }

  // Status is shown at the top of the card (embed author), not buried in the grid.

  // Remaining room within Discord's 6000-char whole-embed cap, after the fixed
  // parts and the summary grid. Long-form fields are chunked into this budget so a
  // long idea shows in full (across several fields) instead of being cut at 1024,
  // and can never overflow the embed (which would make Discord reject the post).
  const fixedLen =
    title.length + description.length + footer.text.length + author.name.length;
  let budget =
    EMBED_TOTAL_MAX -
    fixedLen -
    fields.reduce((n, f) => n + f.name.length + f.value.length, 0);

  // Long-form fields (outcome, extra) full-width, so reviewers see the whole idea.
  outer: for (const fid of config.embed.detailFields ?? []) {
    const field = fieldById(config, fid);
    if (!field) continue;
    const value = answerText(field, answers[fid]);
    if (!value || value === "—") continue; // skip empty (e.g. optional extra)

    const pieces = chunkValue(value);
    for (let i = 0; i < pieces.length; i++) {
      if (fields.length >= MAX_FIELDS) break outer;
      const name = i === 0 ? (field.embedLabel ?? field.label) : CONT_NAME;
      let piece = pieces[i];
      if (name.length + piece.length > budget) {
        // Not enough room for the rest — fit what we can with a clear marker, then stop.
        const room = budget - name.length - 12; // headroom for the marker
        if (room > 40)
          fields.push({
            name,
            value: truncate(piece, room) + "\n*…truncated*",
            inline: false,
          });
        break outer;
      }
      fields.push({ name, value: piece, inline: false });
      budget -= name.length + piece.length;
    }
  }

  return {
    author,
    title,
    description,
    color: STATUS_COLOR[status],
    fields,
    footer,
  };
}

// The action rows under an idea post: the status select, plus an Edit button
// (opens a native modal — works inside forum threads, where Activities can't).
export function buildIdeaComponents(ideaId: number): Record<string, unknown>[] {
  return [
    buildStatusSelect(ideaId),
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "Edit idea",
          custom_id: `idea:edit:${ideaId}`,
        },
      ],
    },
  ];
}

// String select for changing status. The idea id lives in the custom_id so the
// handler stays stateless long after the interaction token expires.
export function buildStatusSelect(
  ideaId: number,
  disabled = false,
): Record<string, unknown> {
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: `idea:status:${ideaId}`,
        placeholder: "Change status",
        disabled,
        options: STATUSES.map((s: Status) => ({
          label: STATUS_LABEL[s],
          value: s,
          description: STATUS_DESCRIPTION[s],
          default: false,
        })),
      },
    ],
  };
}

// Discord's 6000-character budget is shared by every embed in one message.
// Preserve the full stored idea; shorten only its displayed card when a Council
// summary needs room underneath it. Public posts retain their original rendering.
export function withSummaryEmbed(
  ideaEmbeds: Record<string, unknown>[],
  summary: Record<string, unknown>,
): Record<string, unknown>[] {
  type Card = {
    title?: string;
    description?: string;
    footer?: { text?: string };
    author?: { name?: string };
    fields?: Array<{ name: string; value: string }>;
  };
  const originals = structuredClone(ideaEmbeds) as Card[];
  const length = (e: Card) =>
    (e.title?.length || 0) +
    (e.description?.length || 0) +
    (e.footer?.text?.length || 0) +
    (e.author?.name?.length || 0) +
    (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
  let overflow =
    originals.reduce((n, e) => n + length(e), 0) +
    length(summary as Card) -
    EMBED_TOTAL_MAX;
  for (const e of originals) {
    if (overflow <= 0) break;
    if (e.description) {
      const remove = Math.min(
        overflow,
        Math.max(0, e.description.length - 200),
      );
      e.description = truncate(e.description, e.description.length - remove);
      overflow -= remove;
    }
    for (const f of [...(e.fields || [])].reverse()) {
      if (overflow <= 0) break;
      const remove = Math.min(overflow, Math.max(0, f.value.length - 60));
      f.value = truncate(f.value, f.value.length - remove);
      overflow -= remove;
    }
    while (overflow > 0 && e.fields?.length) {
      const f = e.fields.pop()!;
      overflow -= f.name.length + f.value.length;
    }
  }
  if (overflow > 0)
    throw Error(
      "The idea and assessment summary exceed Discord's message budget.",
    );
  return [...(originals as Record<string, unknown>[]), summary];
}
