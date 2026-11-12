// Interaction dispatch (build spec §7) and the status state machine (§9).

import type { Env, FormConfig, IdeaRow, Status } from "../types";
import { handleReviewInteraction, reviewButton, withReviewSummary } from "./review";
import { EPHEMERAL, InteractionResponseType as IRT, KV, STATUS_LABEL } from "../constants";
import { allFields, loadConfigVersion, loadLiveConfig } from "../lib/config";
import { attachReview, deleteIdea, getIdea, logStatus, updateIdeaAnswers, updateStatus } from "../lib/db";
import { decideTransition } from "../lib/transitions";
import { canMarkReviewed } from "../lib/sharedReviewDb";
import { holdsCouncil } from "../lib/council";
import { ideaToWordDoc } from "../lib/worddoc";
import { validateAnswers } from "../lib/validate";
import { buildEmbed, buildIdeaComponents } from "./embed";
import {
  applyTag,
  carryReactionsToReview,
  createReviewPost,
  deleteThread,
  ensureSubmitButtonMessage,
  lockThread,
  postFile,
  postThreadLine,
  refreshIdeaPost,
  unlockThread,
} from "./forum";
import { discordFetch } from "./rest";

interface InteractionMember {
  user: { id: string; username: string; global_name?: string | null };
  roles: string[];
}
interface Interaction {
  type: number;
  data?: {
    name?: string;
    custom_id?: string;
    values?: string[];
    options?: Array<{ name: string; value: unknown }>;
    // Modal submit: rows of text-input components.
    components?: Array<{ components?: Array<{ custom_id: string; value: string }> }>;
  };
  member?: InteractionMember;
  user?: { id: string; username: string };
  guild_id?: string;
  channel_id?: string;
  message?: { id: string };
  token: string;
  application_id: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function ephemeral(content: string): Response {
  return json({ type: IRT.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL } });
}

export async function handleInteraction(env: Env, ctx: ExecutionContext, interaction: Interaction): Promise<Response> {
  if ((interaction.type === 3 || interaction.type === 5) && interaction.data?.custom_id?.startsWith("review:")) {
    return handleReviewInteraction(env, ctx, interaction);
  }
  // PING
  if (interaction.type === 1) return json({ type: IRT.PONG });

  // Slash / entry-point commands
  if (interaction.type === 2) {
    const name = interaction.data?.name;
    if (name === "idea") return json({ type: IRT.LAUNCH_ACTIVITY });
    if (name === "idea-setup") return handleSetup(env, ctx, interaction);
    if (name === "idea-delete") return handleDelete(env, ctx, interaction);
    if (name === "idea-edit") return handleEditStart(env, interaction);
    return ephemeral("Unknown command.");
  }

  // Message components
  if (interaction.type === 3) {
    const cid = interaction.data?.custom_id ?? "";
    if (cid === "idea:new") return json({ type: IRT.LAUNCH_ACTIVITY });
    if (cid.startsWith("idea:status:")) return handleStatusChange(env, ctx, interaction);
    if (cid.startsWith("idea:edit:")) return handleEditButton(env, interaction);
    return ephemeral("Unknown control.");
  }

  // Modal submit (the in-thread text editor)
  if (interaction.type === 5) {
    const cid = interaction.data?.custom_id ?? "";
    if (cid.startsWith("idea:editmodal:")) return handleEditModal(env, ctx, interaction);
    return ephemeral("Unknown form.");
  }

  return ephemeral("Unsupported interaction.");
}

// Edit button on a post → open a native modal to edit the text fields in place.
// (Modals work inside forum threads; Activities don't.)
async function handleEditButton(env: Env, interaction: Interaction): Promise<Response> {
  const id = Number.parseInt((interaction.data?.custom_id ?? "").split(":")[2] ?? "", 10);
  const idea = await getIdea(env, id);
  if (!idea) return ephemeral("This idea is not tracked here.");

  const actorId = interaction.member?.user.id ?? "";
  const isCouncil = holdsCouncil(env, interaction.member?.roles);
  if (actorId !== idea.author_id && !isCouncil) {
    return ephemeral("You can only edit your own idea, unless you hold the White Council role.");
  }

  const config = await loadLiveConfig(env);
  const answers = JSON.parse(idea.answers) as Record<string, string | string[]>;
  // Discord modals are text-only and cap at 5 inputs.
  const textFields = allFields(config)
    .filter((f) => f.type === "text" || f.type === "textarea")
    .slice(0, 5);
  const components = textFields.map((f) => ({
    type: 1,
    components: [
      {
        type: 4,
        custom_id: f.id,
        label: f.label.slice(0, 45),
        style: f.type === "textarea" ? 2 : 1,
        value: String(answers[f.id] ?? ""),
        max_length: f.maxLength ?? 4000,
        required: !!f.required,
      },
    ],
  }));

  return json({
    type: 9,
    data: { custom_id: `idea:editmodal:${id}`, title: `Edit Idea ${id}`.slice(0, 45), components },
  });
}

async function handleEditModal(env: Env, ctx: ExecutionContext, interaction: Interaction): Promise<Response> {
  const id = Number.parseInt((interaction.data?.custom_id ?? "").split(":")[2] ?? "", 10);
  const idea = await getIdea(env, id);
  if (!idea) return ephemeral("This idea is not tracked here.");

  const actorId = interaction.member?.user.id ?? "";
  const isCouncil = holdsCouncil(env, interaction.member?.roles);
  if (actorId !== idea.author_id && !isCouncil) return ephemeral("This is not your idea to edit.");

  // Pull the submitted text values, merge over the existing answers (keeping the
  // dropdown selections), and validate the whole thing.
  const values: Record<string, string> = {};
  for (const row of interaction.data?.components ?? []) {
    for (const comp of row.components ?? []) values[comp.custom_id] = comp.value;
  }
  const config = await loadLiveConfig(env);
  const merged = { ...(JSON.parse(idea.answers) as Record<string, unknown>), ...values };
  const { ok, errors, clean } = validateAnswers(config, merged);
  if (!ok) {
    const first = Object.values(errors)[0] ?? "Please check your answers.";
    return ephemeral(`Couldn't save: ${first}`);
  }

  const title = String(clean[config.embed.titleField] ?? "").slice(0, 100) || idea.title;
  ctx.waitUntil(applyEdit(env, interaction, idea, title, clean, config, actorId));
  return json({ type: IRT.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `Saving your changes to Idea ${id}…`, flags: EPHEMERAL } });
}

async function applyEdit(
  env: Env,
  interaction: Interaction,
  idea: IdeaRow,
  title: string,
  clean: Record<string, string | string[]>,
  config: FormConfig,
  actorId: string,
): Promise<void> {
  const webhook = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const now = Math.floor(Date.now() / 1000);
  try {
    await updateIdeaAnswers(env, idea.id, title, clean, config.version, now);
    const updated: IdeaRow = { ...idea, title, answers: JSON.stringify(clean), schema_version: config.version, updated_at: now };
    await refreshIdeaPost(env, updated, config).catch((e) => console.error("post refresh failed", e));
    if (idea.thread_id) {
      await postThreadLine(env, idea.thread_id, `Idea ${idea.id} edited by <@${actorId}>`).catch(() => {});
    }
    await discordFetch(env, webhook, { method: "PATCH", unauthenticated: true, body: { content: `Idea ${idea.id} updated.` } }).catch(() => {});
  } catch (err) {
    console.error(`edit ${idea.id} failed`, err);
    await discordFetch(env, webhook, { method: "PATCH", unauthenticated: true, body: { content: "Something went wrong saving your changes." } }).catch(() => {});
  }
}

// /idea-setup — Council only, checked server side (spec §7).
function handleSetup(env: Env, ctx: ExecutionContext, interaction: Interaction): Response {
  const roles = interaction.member?.roles ?? [];
  if (!holdsCouncil(env, roles)) {
    return ephemeral("Only the White Council can run this.");
  }
  ctx.waitUntil(
    ensureSubmitButtonMessage(env).catch((err) => console.error("idea-setup failed", err)),
  );
  return ephemeral("Posting the Submit an idea button to the submit channel…");
}

function displayName(m?: InteractionMember): string {
  return m?.user.global_name || m?.user.username || "Someone";
}

// /idea-delete <number> — Council only. Removes the forum post and the record.
function handleDelete(env: Env, ctx: ExecutionContext, interaction: Interaction): Response {
  const roles = interaction.member?.roles ?? [];
  if (!holdsCouncil(env, roles)) {
    return ephemeral("Only the White Council can delete ideas.");
  }
  const opt = interaction.data?.options?.find((o) => o.name === "number");
  const id = typeof opt?.value === "number" ? opt.value : Number.parseInt(String(opt?.value ?? ""), 10);
  if (!id || Number.isNaN(id)) return ephemeral("Give a valid idea number, e.g. `/idea-delete number:247`.");

  ctx.waitUntil(doDelete(env, interaction, id));
  return json({ type: IRT.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `Deleting idea ${id}…`, flags: EPHEMERAL } });
}

// /idea-edit <number> — author or Council. Records a short-lived edit intent,
// then launches the form (which pre-fills from the idea and saves in place).
async function handleEditStart(env: Env, interaction: Interaction): Promise<Response> {
  const opt = interaction.data?.options?.find((o) => o.name === "number");
  const id = typeof opt?.value === "number" ? opt.value : Number.parseInt(String(opt?.value ?? ""), 10);
  if (!id || Number.isNaN(id)) return ephemeral("Give a valid idea number, e.g. `/idea-edit number:5`.");

  const idea = await getIdea(env, id);
  if (!idea) return ephemeral(`No idea numbered ${id} was found.`);

  const actorId = interaction.member?.user.id ?? "";
  const isCouncil = holdsCouncil(env, interaction.member?.roles);
  if (actorId !== idea.author_id && !isCouncil) {
    return ephemeral("You can only edit your own idea, unless you hold the White Council role.");
  }

  await env.CONFIG.put(KV.editIntent(actorId), JSON.stringify({ ideaId: id }), { expirationTtl: 900 });
  return json({ type: IRT.LAUNCH_ACTIVITY });
}

async function doDelete(env: Env, interaction: Interaction, id: number): Promise<void> {
  const webhook = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  let message: string;
  try {
    const idea = await getIdea(env, id);
    if (!idea) {
      message = `No idea numbered ${id} was found.`;
    } else {
      if (idea.thread_id) await deleteThread(env, idea.thread_id).catch((e) => console.error("thread delete failed", e));
      await deleteIdea(env, id);
      message = `Deleted **Idea ${id}**${idea.thread_id ? " and its forum post" : ""}.`;
    }
  } catch (err) {
    console.error(`idea-delete ${id} failed`, err);
    message = `Something went wrong deleting idea ${id}.`;
  }
  await discordFetch(env, webhook, { method: "PATCH", unauthenticated: true, body: { content: message } }).catch(
    (e) => console.error("delete edit failed", e),
  );
}

async function handleStatusChange(env: Env, ctx: ExecutionContext, interaction: Interaction): Promise<Response> {
  const ideaId = Number.parseInt((interaction.data?.custom_id ?? "").split(":")[2] ?? "", 10);
  const target = (interaction.data?.values?.[0] ?? "") as Status;

  const idea = await getIdea(env, ideaId);
  if (!idea) {
    // Post predates the bot, or was deleted. Reply and stop (spec §9.1).
    return ephemeral("This idea is not tracked by MUME Idea Submission, so its status can't be changed here.");
  }

  const member = interaction.member;
  const actorId = member?.user.id ?? "";
  const isCouncil = holdsCouncil(env, member?.roles);
  const isAuthor = actorId === idea.author_id;

  const decision = decideTransition(idea.status, target, { isCouncil, isAuthor });
  if (!decision.ok) {
    // Explain, then reset the select on the original message so it stops showing
    // the rejected choice (spec §9.4).
    ctx.waitUntil(resetSelect(env, interaction, idea).catch((e) => console.error("reset failed", e)));
    return ephemeral(decision.reason);
  }

  if (target === "approved" && !(await canMarkReviewed(env, idea))) {
    ctx.waitUntil(resetSelect(env, interaction, idea).catch((e) => console.error("reset failed", e)));
    return ephemeral("Before marking this idea Reviewed, three Council members must agree to its current final scores.");
  }

  // Deferred update; do the work after acking (spec §9.5).
  ctx.waitUntil(applyTransition(env, interaction, idea, target, actorId, displayName(member)));
  return json({ type: IRT.DEFERRED_UPDATE_MESSAGE });
}

async function resetSelect(env: Env, interaction: Interaction, idea: IdeaRow): Promise<void> {
  const config = await loadConfigVersion(env, idea.schema_version);
  if (!interaction.channel_id || !interaction.message) return;
  await discordFetch(env, `/channels/${interaction.channel_id}/messages/${interaction.message.id}`, {
    method: "PATCH",
    body: {
      embeds: idea.review_thread_id && interaction.channel_id === idea.review_thread_id
        ? await withReviewSummary(env, idea, [buildEmbed(idea, config)])
        : [buildEmbed(idea, config)],
      components: idea.review_thread_id && interaction.channel_id === idea.review_thread_id
        ? [...buildIdeaComponents(idea.id), reviewButton(idea.id)]
        : buildIdeaComponents(idea.id),
    },
  });
}

async function applyTransition(
  env: Env,
  interaction: Interaction,
  idea: IdeaRow,
  target: Status,
  actorId: string,
  actorName: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const from = idea.status;
  try {
    await updateStatus(env, idea.id, target, now);
    await logStatus(env, idea.id, from, target, actorId, actorName, now);

    const config = await loadConfigVersion(env, idea.schema_version);
    const updated: IdeaRow = { ...idea, status: target };

    // First time reaching Submitted: mirror a control copy into the private review
    // forum, and best-effort lock the public thread (needs Manage Threads — silently
    // skipped if the bot doesn't hold it).
    if (target === "submitted" && !idea.review_thread_id && env.SUBMITTED_CHANNEL_ID) {
      try {
        const review = await createReviewPost(env, updated, config);
        await attachReview(env, idea.id, review.threadId, review.messageId, now);
        updated.review_thread_id = review.threadId;
        updated.review_message_id = review.messageId;
        // Carry the public post's community reactions over as the first comment
        // (minus the bot's own seeded 👍/👎). Best-effort — never blocks submission.
        if (idea.thread_id && idea.message_id) {
          await carryReactionsToReview(env, idea.thread_id, idea.message_id, review.threadId);
        }
      } catch (e) {
        console.error("review copy creation failed", e);
      }
      if (idea.thread_id) {
        await lockThread(env, idea.thread_id).catch((e) =>
          console.error("public lock skipped (needs Manage Threads)", e),
        );
      }
    }

    // Resolved is terminal: lock the public thread. Any review copy is left unlocked
    // so the Council keeps a live control surface (e.g. to reopen it later).
    if (target === "resolved" && idea.thread_id) {
      await lockThread(env, idea.thread_id).catch((e) =>
        console.error("public lock (resolved) skipped (needs Manage Threads)", e),
      );
    }
    // Reopening from Resolved: unlock the public thread so it's live again.
    if (from === "resolved" && idea.thread_id) {
      await unlockThread(env, idea.thread_id).catch((e) =>
        console.error("public unlock (reopen) skipped (needs Manage Threads)", e),
      );
    }

    // Resolve the interaction and keep both copies (public record + review copy) in sync.
    await renderIdeaEverywhere(env, interaction, updated, config);

    if (idea.thread_id) {
      // Each thread op is independent so a hiccup on one never blocks the export.
      await applyTag(env, idea.thread_id, target).catch((e) => console.error("tag swap failed", e));
      await postThreadLine(env, idea.thread_id, `Status set to **${STATUS_LABEL[target]}** by <@${actorId}>`).catch(
        (e) => console.error("log line failed", e),
      );
      if (target === "approved") {
        await postThreadLine(env, idea.thread_id, `Idea ${idea.id} reviewed and exported.`).catch(() => {});
        await exportApproved(env, updated).catch((e) => console.error("reviewed export failed", e));
      }
    }
  } catch (err) {
    console.error(`transition ${idea.id} ${from}->${target} failed`, err);
    await discordFetch(env, `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`, {
      method: "POST", unauthenticated: true,
      body: { content: (err as Error).message || "The status change failed. Refresh and try again.", flags: EPHEMERAL, allowed_mentions: { parse: [] } },
    }).catch(() => {});
    await resetSelect(env, interaction, idea).catch(() => {});
  }
}

// Re-render an idea on the message the Council clicked (via the webhook, which
// resolves the interaction) and on its other copy (via the bot). Once a review
// copy exists, the public thread is a read-only record — its controls are stripped
// so all control lives on the private review copy.
async function renderIdeaEverywhere(
  env: Env,
  interaction: Interaction,
  idea: IdeaRow,
  config: FormConfig,
): Promise<void> {
  const embed = buildEmbed(idea, config);
  const hasReview = !!idea.review_thread_id;
  const publicComponents = hasReview ? [] : buildIdeaComponents(idea.id);
  const reviewComponents = [...buildIdeaComponents(idea.id), reviewButton(idea.id)];
  const clicked = interaction.message?.id;
  const clickedIsReview = !!idea.review_message_id && clicked === idea.review_message_id;
  const reviewEmbeds = hasReview ? await withReviewSummary(env, idea, [embed]) : [embed];

  const webhook = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  await discordFetch(env, webhook, {
    method: "PATCH",
    unauthenticated: true,
    body: { embeds: clickedIsReview ? reviewEmbeds : [embed], components: clickedIsReview ? reviewComponents : publicComponents },
  }).catch((e) => console.error("original edit failed", e));

  if (idea.thread_id && idea.message_id && idea.message_id !== clicked) {
    await discordFetch(env, `/channels/${idea.thread_id}/messages/${idea.message_id}`, {
      method: "PATCH",
      body: { embeds: [embed], components: publicComponents },
    }).catch((e) => console.error("public copy sync failed", e));
  }
  if (idea.review_thread_id && idea.review_message_id && idea.review_message_id !== clicked) {
    await discordFetch(env, `/channels/${idea.review_thread_id}/messages/${idea.review_message_id}`, {
      method: "PATCH",
      body: { embeds: reviewEmbeds, components: reviewComponents },
    }).catch((e) => console.error("review copy sync failed", e));
  }
}

// Post the newly approved idea to the export channel: the readable card (same
// embed as the forum post) AND the CSV file attached.
async function exportApproved(env: Env, idea: IdeaRow): Promise<void> {
  if (!env.EXPORT_CHANNEL_ID) return;
  const config = await loadConfigVersion(env, idea.schema_version);
  const threadUrl = idea.thread_id
    ? `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${idea.thread_id}`
    : null;
  const doc = ideaToWordDoc(idea, config, threadUrl);
  await postFile(
    env,
    env.EXPORT_CHANNEL_ID,
    `idea-${idea.id}-reviewed.rtf`,
    doc,
    {
      content: `✅ **Idea ${idea.id} reviewed**`,
      embeds: [buildEmbed(idea, config)],
    },
    "application/rtf",
  );
}
