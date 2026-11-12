// Forum channel operations (build spec §8, §9, §10).

import type { Env, FormConfig, IdeaRow, Status } from "../types";
import { reviewButton, withReviewSummary } from "./review";
import { DISCORD_API, KV, STATUSES, TAG_NAME, VOTE_EMOJIS } from "../constants";
import { DiscordRestError, discordFetch, discordJson } from "./rest";
import { buildEmbed, buildIdeaComponents, ideaThreadName } from "./embed";

const AUTO_ARCHIVE = 10080; // 7 days, the max

// Open the native Council assessment from its private review copy.
// Only added to the private review copies, never the public post.
function withAssessButton(_env: Env, ideaId: number, components: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...components, reviewButton(ideaId)];
}

interface ForumTag {
  id?: string;
  name: string;
  moderated?: boolean;
  emoji_id?: string | null;
  emoji_name?: string | null;
}
interface ForumChannel {
  available_tags: ForumTag[];
}

interface ThreadCreateResponse {
  id: string; // thread id (also the channel id, and the first message id for forum posts)
  message?: { id: string };
}

// Resolve the status tag ids by name, cached in KV. Best-effort: if the bot
// can't create missing tags (no Manage Channels on the forum), it returns
// whatever tags exist — a missing tag just means the post carries no tag chip,
// never a failure. The status is always shown in the embed badge regardless.
export async function resolveTagIds(env: Env): Promise<Partial<Record<Status, string>>> {
  const cached = await env.CONFIG.get(KV.tagIds);
  if (cached) return JSON.parse(cached) as Partial<Record<Status, string>>;

  let channel = await discordJson<ForumChannel>(env, `/channels/${env.FORUM_CHANNEL_ID}`);
  let byName = new Map(channel.available_tags.map((t) => [t.name, t.id as string]));

  const missing = STATUSES.filter((s) => !byName.has(TAG_NAME[s]));
  if (missing.length) {
    try {
      const tags = channel.available_tags.concat(missing.map((s) => ({ name: TAG_NAME[s], moderated: false })));
      channel = await discordJson<ForumChannel>(env, `/channels/${env.FORUM_CHANNEL_ID}`, {
        method: "PATCH",
        body: { available_tags: tags },
      });
      byName = new Map(channel.available_tags.map((t) => [t.name, t.id as string]));
    } catch (e) {
      console.error("could not create forum tags (bot lacks Manage Channels here) — posting without tags", e);
    }
  }

  const ids: Partial<Record<Status, string>> = {};
  for (const s of STATUSES) {
    const id = byName.get(TAG_NAME[s]);
    if (id) ids[s] = id;
  }
  await env.CONFIG.put(KV.tagIds, JSON.stringify(ids));
  return ids;
}

// Post a message (content/embeds via `payload`) with a file attachment.
export async function postFile(
  env: Env,
  channelId: string,
  filename: string,
  fileContent: string,
  payload: Record<string, unknown>,
  mimetype = "text/csv",
): Promise<void> {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  form.append("files[0]", new Blob([fileContent], { type: mimetype }), filename);
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    body: form,
  });
  if (!res.ok) throw new DiscordRestError(res.status, await res.text().catch(() => ""), `POST ${channelId} file`);
}

// Create the forum post for a freshly inserted idea. Returns thread + message ids.
export async function createIdeaPost(
  env: Env,
  idea: IdeaRow,
  config: FormConfig,
): Promise<{ threadId: string; messageId: string }> {
  const tags = await resolveTagIds(env);
  const tagId = tags[idea.status];
  const res = await discordJson<ThreadCreateResponse>(env, `/channels/${env.FORUM_CHANNEL_ID}/threads`, {
    method: "POST",
    body: {
      name: ideaThreadName(idea.id, idea.title),
      auto_archive_duration: AUTO_ARCHIVE,
      applied_tags: tagId ? [tagId] : [],
      message: {
        embeds: [buildEmbed(idea, config)],
        components: buildIdeaComponents(idea.id),
      },
    },
  });
  // For a forum post the thread id doubles as the channel id, and the first
  // message id equals the thread id when not returned explicitly.
  return { threadId: res.id, messageId: res.message?.id ?? res.id };
}

// Create the private review-forum copy (submitted-ideas) carrying the working
// controls. No tags — the badge shows status, and the review forum may not grant
// the bot tag permissions either.
export async function createReviewPost(
  env: Env,
  idea: IdeaRow,
  config: FormConfig,
): Promise<{ threadId: string; messageId: string }> {
  const res = await discordJson<ThreadCreateResponse>(env, `/channels/${env.SUBMITTED_CHANNEL_ID}/threads`, {
    method: "POST",
    body: {
      name: ideaThreadName(idea.id, idea.title),
      auto_archive_duration: AUTO_ARCHIVE,
      message: {
        embeds: await withReviewSummary(env, idea, [buildEmbed(idea, config)]),
        components: withAssessButton(env, idea.id, buildIdeaComponents(idea.id)),
      },
    },
  });
  return { threadId: res.id, messageId: res.message?.id ?? res.id };
}

interface MessageReaction {
  count: number;
  me: boolean; // whether THIS bot reacted — i.e. one of its seeded 👍/👎
  emoji: { id: string | null; name: string | null; animated?: boolean };
}

// Render one reaction emoji for a plain-text line: unicode passes through, custom
// emoji become the <:name:id> tag Discord renders inline.
function formatReactionEmoji(e: MessageReaction["emoji"]): string {
  if (e.id) return `<${e.animated ? "a" : ""}:${e.name || "emoji"}:${e.id}>`;
  return e.name || "❓";
}

// Snapshot the public post's community reactions and drop a one-line summary as the
// first comment in the review thread. The bot's own seeded 👍/👎 are removed via each
// reaction's `me` flag (count - 1), so only real member votes are carried over.
// Best-effort: any failure is logged and never blocks the submission flow.
export async function carryReactionsToReview(
  env: Env,
  sourceChannelId: string,
  sourceMessageId: string,
  reviewThreadId: string,
): Promise<void> {
  try {
    const msg = await discordJson<{ reactions?: MessageReaction[] }>(
      env,
      `/channels/${sourceChannelId}/messages/${sourceMessageId}`,
    );
    const parts: string[] = [];
    for (const r of msg.reactions ?? []) {
      const net = r.count - (r.me ? 1 : 0); // subtract the bot's own seeded +1
      if (net > 0) parts.push(`${formatReactionEmoji(r.emoji)} ${net}`);
    }
    const content = parts.length
      ? `**Reactions carried from the public post** — ${parts.join(" · ")}`
      : `**Reactions carried from the public post** — none yet.`;
    await discordFetch(env, `/channels/${reviewThreadId}/messages`, {
      method: "POST",
      body: { content },
    });
  } catch (e) {
    console.error("carry reactions to review failed", e);
  }
}

// Seed the fixed vote reactions in order (👍 then 👎). Sequential so Discord keeps
// them in that order; each is best-effort so one failing never blocks the other.
export async function addVoteReaction(env: Env, threadId: string, messageId: string): Promise<void> {
  for (const e of VOTE_EMOJIS) {
    const emoji = encodeURIComponent(e);
    await discordFetch(env, `/channels/${threadId}/messages/${messageId}/reactions/${emoji}/@me`, {
      method: "PUT",
    }).catch((err) => console.error(`seed reaction ${e} failed`, err));
  }
}

// Re-render an idea's post(s) after its content changes (edit). Updates the public
// thread and, if it exists, the private review copy — keeping the public one a
// read-only record (no controls) once a review copy is present.
export async function refreshIdeaPost(env: Env, idea: IdeaRow, config: FormConfig): Promise<void> {
  const embed = buildEmbed(idea, config);
  const name = ideaThreadName(idea.id, idea.title);
  const hasReview = !!idea.review_thread_id;

  if (idea.thread_id && idea.message_id) {
    await discordFetch(env, `/channels/${idea.thread_id}/messages/${idea.message_id}`, {
      method: "PATCH",
      body: { embeds: [embed], components: hasReview ? [] : buildIdeaComponents(idea.id) },
    }).catch((e) => console.error("public refresh failed", e));
    await discordFetch(env, `/channels/${idea.thread_id}`, { method: "PATCH", body: { name } }).catch(() => {});
  }
  if (idea.review_thread_id && idea.review_message_id) {
    await discordFetch(env, `/channels/${idea.review_thread_id}/messages/${idea.review_message_id}`, {
      method: "PATCH",
      body: { embeds: await withReviewSummary(env, idea, [embed]), components: withAssessButton(env, idea.id, buildIdeaComponents(idea.id)) },
    }).catch((e) => console.error("review refresh failed", e));
    await discordFetch(env, `/channels/${idea.review_thread_id}`, { method: "PATCH", body: { name } }).catch(() => {});
  }
}

export async function applyTag(env: Env, threadId: string, status: Status): Promise<void> {
  const tags = await resolveTagIds(env);
  const tagId = tags[status];
  if (!tagId) return; // no tag for this status (couldn't be created) — skip, harmless
  await discordFetch(env, `/channels/${threadId}`, { method: "PATCH", body: { applied_tags: [tagId] } });
}

export async function postThreadLine(env: Env, threadId: string, content: string): Promise<void> {
  await discordFetch(env, `/channels/${threadId}/messages`, { method: "POST", body: { content } });
}

// Post a message in a thread that pings the White Council role. `message` is the
// text; the role mention is appended and explicitly allowed so it actually
// notifies. Falls back to a plain post when the role is the "everyone" sentinel.
export async function postCouncilPing(env: Env, threadId: string, message: string): Promise<void> {
  const role = env.COUNCIL_ROLE_ID;
  const body =
    role && role !== "everyone"
      ? { content: `${message} <@&${role}>`, allowed_mentions: { roles: [role] } }
      : { content: message };
  await discordFetch(env, `/channels/${threadId}/messages`, { method: "POST", body });
}

// Add a member to a thread, which makes it appear in their sidebar and follow it.
export async function addThreadMember(env: Env, threadId: string, userId: string): Promise<void> {
  await discordFetch(env, `/channels/${threadId}/thread-members/${userId}`, { method: "PUT" });
}

// Auto-follow a new idea thread and notify the Council. Only the author is added
// to the thread (one tidy "added X" line, so it shows in their sidebar). The
// White Council is notified with a single @role ping rather than by adding every
// member individually — which would post one "added X" system line per member.
export async function autoFollow(env: Env, threadId: string, authorId: string): Promise<void> {
  await addThreadMember(env, threadId, authorId).catch((e) => console.error(`auto-follow ${authorId} failed`, e));

  if (env.COUNCIL_ROLE_ID && env.COUNCIL_ROLE_ID !== "everyone") {
    await postCouncilPing(env, threadId, "💡 New idea for review —").catch((e) =>
      console.error("council ping failed", e),
    );
  }
}

export async function lockThread(env: Env, threadId: string): Promise<void> {
  // Lock, not archive: stays readable, reactions intact, only Manage Threads can post.
  await discordFetch(env, `/channels/${threadId}`, { method: "PATCH", body: { locked: true } });
}

export async function unlockThread(env: Env, threadId: string): Promise<void> {
  await discordFetch(env, `/channels/${threadId}`, { method: "PATCH", body: { locked: false } });
}

export async function unarchiveThread(env: Env, threadId: string): Promise<void> {
  await discordFetch(env, `/channels/${threadId}`, { method: "PATCH", body: { archived: false } });
}

export async function deleteThread(env: Env, threadId: string): Promise<void> {
  await discordFetch(env, `/channels/${threadId}`, { method: "DELETE" });
}

// Post (or repair) the "Submit an idea" button message in the dedicated submit
// TEXT channel. Activities cannot launch from a forum channel, so the button
// lives in a normal text channel; the idea posts still land in the forum.
// Idempotent via KV.
export async function ensureSubmitButtonMessage(env: Env): Promise<string> {
  const existing = await env.CONFIG.get(KV.pinnedSubmit);
  if (existing) return existing;

  const msg = await discordJson<{ id: string }>(env, `/channels/${env.SUBMIT_CHANNEL_ID}/messages`, {
    method: "POST",
    body: {
      content:
        "**Submit an idea for MUME**\n" +
        "Click the button below to open the submission form. One distinct idea per submission. " +
        "Submitting does not imply acceptance. You can also type **/idea** in any channel.",
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 1, label: "Submit an idea", custom_id: "idea:new" }],
        },
      ],
    },
  });

  // Pin the message (text-channel pin, not a thread flag).
  await discordFetch(env, `/channels/${env.SUBMIT_CHANNEL_ID}/pins/${msg.id}`, { method: "PUT" }).catch(() => {});
  await env.CONFIG.put(KV.pinnedSubmit, msg.id);
  return msg.id;
}
