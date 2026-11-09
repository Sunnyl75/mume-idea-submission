import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  emptyDraft,
  draftResult,
  validateDraft,
  feedbackFor,
  contentOf,
} from "../src/lib/sharedReview.ts";
import {
  getReview,
  editReview as directEditReview,
  startReview,
  saveOrRequestChange,
  reviewChanges,
  applyReviewChange,
  withdrawReviewChange,
  agreeReview,
  agreements,
  withdrawAgreement,
  reservePublish,
  finishPublish,
  secondChecks,
  withdrawChecksSecond,
  canMarkReviewed,
  assessmentHistory,
  assessmentEvent,
  submitReviewScores,
  hasSubmittedScores,
} from "../src/lib/sharedReviewDb.ts";
import { updateIdeaAnswers, updateStatus } from "../src/lib/db.ts";
import {
  handleReviewInteraction,
  reviewPayload,
  reviewButton,
  assessmentSummaryEmbed,
  syncAssessmentSummary,
} from "../src/discord/review.ts";
function nodes(payload) {
  const out = [];
  function visit(c) {
    out.push(c);
    for (const child of c.components ?? []) visit(child);
    if (c.component) visit(c.component);
  }
  for (const c of payload.components ?? []) visit(c);
  return out;
}
const panelText = (p) =>
  nodes(p)
    .filter((c) => c.type === 10)
    .map((c) => c.content)
    .join("\n");
import { CRITERIA, BANDS } from "../src/lib/rubric.ts";
const A = { id: "A", name: "Alice" },
  B = { id: "B", name: "Bob" },
  C = { id: "C", name: "Carol" };
// Multi-actor regression scenarios now go through a change request and editor
// acceptance. Separate governance tests below exercise the direct-write guard.
async function editReview(env, r, idea, draft, actor, reason) {
  if (!r.author_id || r.author_id === actor.id)
    return directEditReview(env, r, idea, draft, actor, reason);
  await saveOrRequestChange(env, r, idea, draft, actor, reason);
  const [request] = await reviewChanges(env, idea.id);
  await applyReviewChange(env, r, idea, request.id, {
    id: r.author_id,
    name: r.author_name,
  });
}
const complete = () => ({
  ...emptyDraft(),
  scores: { usefulness: 4, feasibility: 3, interest: 4 },
  reasons: {
    usefulness: "Useful",
    feasibility: "Moderate work",
    interest: "Strong support",
  },
});
async function fixture() {
  // Run the production SQL against SQLite with the D1 prepare/bind/batch shape.
  const sqlite = new DatabaseSync(":memory:");
  const mf = { dispose: async () => sqlite.close() };
  const DB = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...args) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args) };
        },
        async run() {
          const r = sqlite.prepare(sql).run(...args);
          return { meta: { changes: Number(r.changes) } };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  for (const name of [
    "0001_init.sql",
    "0002_review_copy.sql",
    "0003_assessments.sql",
    "0004_shared_council_review.sql",
    "0005_separate_checks_and_scores.sql",
    "0006_assessment_change_requests.sql",
  ]) {
    // Execute schema statements separately; SQL comments can include semicolons.
    const sql = readFileSync("migrations/" + name, "utf8").replace(
      /--[^\n]*/g,
      "",
    );
    for (const statement of sql.split(";").filter((x) => x.trim()))
      await DB.prepare(statement).run();
  }
  const idea = {
    id: 1,
    title: 'Help "navigation" — MUME',
    answers: JSON.stringify({ proposal: "line\nnew line" }),
    schema_version: 1,
    status: "submitted",
    thread_id: "public",
    review_thread_id: "private",
  };
  await DB.prepare(
    "INSERT INTO ideas(id,guild_id,author_id,author_name,title,status,schema_version,answers,created_at,updated_at,thread_id,review_thread_id) VALUES(1,?,?,?,?,?,?,?,0,0,?,?)",
  )
    .bind(
      "guild",
      "author",
      "Author",
      idea.title,
      idea.status,
      1,
      idea.answers,
      "public",
      "private",
    )
    .run();
  return {
    mf,
    env: { DB, DISCORD_GUILD_ID: "guild", COUNCIL_ROLE_ID: "council" },
    idea,
  };
}
test("new rubric: defaults, all 125 totals, flag precedence and input bounds", () => {
  assert.equal(draftResult(emptyDraft()).ready, false);
  for (let u = 1; u <= 5; u++)
    for (let f = 1; f <= 5; f++)
      for (let i = 1; i <= 5; i++) {
        const d = complete();
        d.scores = { usefulness: u, feasibility: f, interest: i };
        validateDraft(d);
        const r = draftResult(d);
        assert.equal(r.total, u + 2 * f + i);
        assert.ok(r.band);
      }
  const d = emptyDraft();
  d.issues = ["clarity"];
  d.issueReason = "Clarify";
  validateDraft(d);
  assert.equal(draftResult(d).ready, true);
  assert.equal(draftResult(d).band, null);
  assert.throws(() => validateDraft({ ...complete(), issues: ["unknown"] }));
  assert.throws(() =>
    validateDraft({ ...complete(), scores: { usefulness: 0 } }),
  );
  assert.match(feedbackFor({ id: 1, title: "Help" }, complete()), /14\/20/);
});
test("D1: three distinct final-score agreements, revisions, audit, stale ideas, publication", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea);
    assert.deepEqual(JSON.parse(r.draft).issues, []);
    await assert.rejects(agreeReview(env, r, A));
    await editReview(env, r, idea, complete(), A, "Initial assessment");
    const stale = r;
    r = await getReview(env, idea);
    await assert.rejects(
      editReview(env, stale, idea, complete(), B, "Stale change"),
    );
    assert.equal(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM council_review_events",
        ).first()
      ).n,
      1,
    );
    await agreeReview(env, r, A);
    await assert.rejects(agreeReview(env, r, A));
    await agreeReview(env, r, B);
    assert.equal((await agreements(env, r)).length, 2);
    await assert.rejects(reservePublish(env, r));
    await agreeReview(env, r, C);
    await withdrawAgreement(env, r, C);
    await assert.rejects(reservePublish(env, r));
    await agreeReview(env, r, C);
    const revised = complete();
    revised.note = "Final feedback changed";
    revised.scores.usefulness = 5;
    await editReview(env, r, idea, revised, B, "Updated feedback");
    r = await getReview(env, idea);
    assert.deepEqual(
      (await agreements(env, r)).map((v) => v.id),
      [B.id],
    );
    assert.match(
      (
        await env.DB.prepare(
          "SELECT snapshot FROM council_review_events WHERE action IN ('revise','apply_change') ORDER BY id DESC LIMIT 1",
        ).first()
      ).snapshot,
      /Final feedback changed/,
    );
    await agreeReview(env, r, A);
    await assert.rejects(agreeReview(env, r, B));
    await agreeReview(env, r, C);
    await updateIdeaAnswers(
      env,
      1,
      "Changed idea",
      { proposal: "different" },
      1,
      1,
    );
    await assert.rejects(reservePublish(env, r));
    await assert.rejects(agreeReview(env, r, { id: "D", name: "Dan" }));
    const changed = {
      ...idea,
      title: "Changed idea",
      answers: JSON.stringify({ proposal: "different" }),
    };
    await editReview(env, r, changed, revised, B, "Reassessed changed idea");
    r = await getReview(env, changed);
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
    await agreeReview(env, r, C);
    await reservePublish(env, r);
    await assert.rejects(
      editReview(env, r, changed, complete(), A, "During publication"),
    );
    await assert.rejects(withdrawAgreement(env, r, A));
    await assert.rejects(
      updateIdeaAnswers(env, 1, "Another", { proposal: "x" }, 1, 2),
    );
    await assert.rejects(updateStatus(env, 1, "resolved", 2));
    await finishPublish(env, r, "message123", A);
    r = await getReview(env, changed);
    assert.equal(r.status, "published");
    assert.equal(r.record_message_id, "message123");
    await assert.rejects(editReview(env, r, changed, complete(), A, "Closed"));
    await assert.rejects(reservePublish(env, r));
  } finally {
    await mf.dispose();
  }
});
test("D1: overlapping stale revisions accept one winner, preserve distinct revisions and history", async () => {
  const { mf, env, idea } = await fixture();
  try {
    const r = await getReview(env, idea);
    const results = [];
    for (const actor of [A, B]) {
      try {
        await editReview(env, r, idea, complete(), actor, actor.name + " edit");
        results.push({ status: "fulfilled" });
      } catch {
        results.push({ status: "rejected" });
      }
    }
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    const current = await getReview(env, idea);
    assert.equal(current.revision, 2);
    assert.equal(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM council_review_events",
        ).first()
      ).n,
      1,
    );
  } finally {
    await mf.dispose();
  }
});
test("native controls: role/guild guard, early deferred ACK, component limits, unknown values", async () => {
  const base = {
    type: 3,
    guild_id: "guild",
    channel_id: "private",
    application_id: "app",
    token: "token",
    member: { roles: [], user: { id: "A", username: "Alice" } },
    data: { custom_id: "review:open:1:0" },
  };
  const env = { DISCORD_GUILD_ID: "guild", COUNCIL_ROLE_ID: "council" };
  const denied = await handleReviewInteraction(
    env,
    {
      waitUntil() {
        throw Error("Must not queue unauthorized work");
      },
    },
    base,
  );
  assert.match((await denied.json()).data.content, /Only White Council/);
  const { mf, env: dbEnv, idea } = await fixture();
  try {
    let r = await getReview(dbEnv, idea);
    await editReview(dbEnv, r, idea, complete(), A, "Initial");
    r = await getReview(dbEnv, idea);
    const p = await reviewPayload(dbEnv, idea, r);
    assert.ok(p.components.length <= 5);
    assert.equal(
      nodes(p).find((c) => c.custom_id?.includes(":issues:")).min_values,
      0,
    );
    assert.equal(
      nodes(p).find((c) => c.custom_id?.includes(":issues:")).max_values,
      6,
    );
    assert.equal(reviewButton(1).components[0].custom_id, "review:open:1:0");
    let pending;
    const ack = await handleReviewInteraction(
      dbEnv,
      {
        waitUntil(p) {
          pending = p;
        },
      },
      { ...base, member: { ...base.member, roles: ["council"] } },
    );
    assert.equal((await ack.json()).type, 5);
    // Stub Discord network only for the queued response, retaining real D1.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}");
    try {
      await pending;
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await mf.dispose();
  }
});
test("native recording: private Council summary, frozen result, retry without duplicate posting", async () => {
  const { mf, env, idea } = await fixture();
  const originalFetch = globalThis.fetch;
  try {
    let r = await getReview(env, idea);
    await editReview(env, r, idea, complete(), A, "Initial assessment");
    r = await getReview(env, idea);
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
    await agreeReview(env, r, C);
    let posts = 0,
      posted,
      shown;
    globalThis.fetch = async (url, init) => {
      assert.ok(
        !url.includes("/channels/public/"),
        "Assessment recording must never access the public board",
      );
      if (url.endsWith("/users/@me")) return Response.json({ id: "bot" });
      if (url.includes("/channels/private/messages?")) return Response.json([]);
      if (
        url.endsWith("/channels/private/messages") &&
        init.method === "POST"
      ) {
        posts++;
        posted = JSON.parse(init.body);
        return Response.json({ id: "published-message" });
      }
      if (url.includes("/webhooks/")) {
        shown = JSON.parse(init.body);
        return Response.json({});
      }
      throw Error("Unexpected Discord request " + url);
    };
    const interaction = {
      type: 3,
      guild_id: "guild",
      channel_id: "private",
      application_id: "app",
      token: "token",
      member: { roles: ["council"], user: { id: A.id, username: A.name } },
      data: { custom_id: `review:publish:1:${r.revision}` },
    };
    let pending;
    await handleReviewInteraction(
      env,
      {
        waitUntil(p) {
          pending = p;
        },
      },
      interaction,
    );
    await pending;
    assert.equal(posts, 1);
    assert.match(posted.embeds[0].description, /Recommended · 14\/20/);
    for (const c of CRITERIA)
      assert.ok(
        posted.embeds[0].description.includes(
          c.levels[complete().scores[c.id] - 1],
        ),
        "Recorded summary includes the selected rubric wording",
      );
    assert.deepEqual(posted.allowed_mentions, { parse: [] });
    assert.equal(posted.enforce_nonce, true);
    assert.ok(posted.nonce.length <= 25);
    r = await getReview(env, idea);
    assert.equal(r.status, "published");
    assert.match(panelText(shown), /Closed — recorded privately/);
    // Retrying an already completed operation must not emit a second internal message.
    await handleReviewInteraction(
      env,
      {
        waitUntil(p) {
          pending = p;
        },
      },
      interaction,
    );
    await pending;
    assert.equal(posts, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});
test("native publication recovery reuses a previously delivered bot message", async () => {
  const { mf, env, idea } = await fixture();
  const originalFetch = globalThis.fetch;
  try {
    let r = await getReview(env, idea);
    await editReview(env, r, idea, complete(), A, "Initial");
    r = await getReview(env, idea);
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
    await agreeReview(env, r, C);
    await reservePublish(env, r);
    let posts = 0;
    globalThis.fetch = async (url, init) => {
      assert.ok(
        !url.includes("/channels/public/"),
        "Assessment recording must never access the public board",
      );
      if (url.endsWith("/users/@me")) return Response.json({ id: "bot" });
      if (url.includes("/channels/private/messages?"))
        return Response.json([
          {
            id: "already-delivered",
            author: { id: "bot" },
            content: `**Internal Council assessment #1 · revision ${r.revision}**`,
          },
        ]);
      if (
        url.endsWith("/channels/private/messages") &&
        init.method === "POST"
      ) {
        posts++;
        return Response.json({ id: "duplicate" });
      }
      if (url.includes("/webhooks/")) return Response.json({});
      throw Error("Unexpected request");
    };
    let pending;
    await handleReviewInteraction(
      env,
      {
        waitUntil(p) {
          pending = p;
        },
      },
      {
        type: 3,
        guild_id: "guild",
        channel_id: "private",
        application_id: "app",
        token: "token",
        member: { roles: ["council"], user: { id: A.id, username: A.name } },
        data: { custom_id: `review:publish:1:${r.revision}` },
      },
    );
    await pending;
    assert.equal(posts, 0);
    r = await getReview(env, idea);
    assert.equal(r.record_message_id, "already-delivered");
    assert.equal(r.status, "published");
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});
test("checks: one second endorses the whole selection; approvals remain independent", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea),
      d = complete();
    await editReview(env, r, idea, d, A, "Initial scores");
    r = await getReview(env, idea);
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
    await agreeReview(env, r, C);
    d.issues = ["clarity", "evidence"];
    d.issueReason = "Clarify the commands and provide examples.";
    await editReview(env, r, idea, d, A, "Flag both checks");
    r = await getReview(env, idea);
    assert.equal(
      (await agreements(env, r)).length,
      3,
      "Checks must not reset score votes",
    );
    await assert.rejects(reservePublish(env, r), /second/);
    await assert.rejects(secondChecks(env, r, A), /different member/);
    await secondChecks(env, r, B);
    r = await getReview(env, idea);
    assert.equal(r.checks_proposer_id, A.id);
    assert.equal(r.checks_seconder_id, B.id);
    await assert.rejects(secondChecks(env, r, C), /already/);
    assert.equal(
      JSON.parse(r.draft).issues.length,
      2,
      "One second covers both issues",
    );
    const oldScoreRevision = r.score_revision;
    d.scores.usefulness = 5;
    await editReview(env, r, idea, d, C, "More useful than first thought");
    r = await getReview(env, idea);
    assert.equal(r.score_revision, oldScoreRevision + 1);
    assert.deepEqual(
      (await agreements(env, r)).map((v) => v.id),
      [C.id],
    );
    assert.equal(
      r.checks_seconder_id,
      B.id,
      "Score change must retain the checks second",
    );
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
    await assert.rejects(agreeReview(env, r, C));
    d.note = "Internal response guidance";
    await editReview(env, r, idea, d, A, "Council note");
    r = await getReview(env, idea);
    assert.equal((await agreements(env, r)).length, 3);
    assert.equal(r.checks_seconder_id, B.id);
    d.issueReason = "Revised explanation";
    await editReview(env, r, idea, d, C, "Clarified checks");
    r = await getReview(env, idea);
    assert.equal(r.checks_seconder_id, null);
    assert.equal(r.checks_proposer_id, C.id);
    assert.equal((await agreements(env, r)).length, 3);
    await assert.rejects(secondChecks(env, r, C));
    await secondChecks(env, r, B);
    r = await getReview(env, idea);
    await assert.rejects(withdrawChecksSecond(env, r, A));
    await withdrawChecksSecond(env, r, B);
    r = await getReview(env, idea);
    assert.equal(r.checks_seconder_id, null);
    await assert.rejects(reservePublish(env, r));
    await secondChecks(env, r, A);
    r = await getReview(env, idea);
    d.issues = [];
    d.issueReason = "";
    await editReview(env, r, idea, d, B, "Checks resolved");
    r = await getReview(env, idea);
    assert.equal(r.checks_proposer_id, null);
    assert.equal(r.checks_seconder_id, null);
    assert.equal((await agreements(env, r)).length, 3);
    await reservePublish(env, r);
  } finally {
    await mf.dispose();
  }
});
test("selected checks still need complete scores before assessment submission", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea);
    const d = emptyDraft();
    d.issues = ["split", "clarity"];
    d.issueReason = "Two separate proposals; clarify each.";
    await editReview(env, r, idea, d, A, "Triage");
    r = await getReview(env, idea);
    await assert.rejects(agreeReview(env, r, A), /all three scores/);
    await assert.rejects(reservePublish(env, r));
    await secondChecks(env, r, B);
    r = await getReview(env, idea);
    assert.equal((await agreements(env, r)).length, 0);
    const payload = await reviewPayload(env, idea, r);
    const buttons = nodes(payload).filter((c) => c.type === 2);
    assert.equal(
      buttons.find((b) => b.custom_id?.includes(":agree:")).disabled,
      true,
    );
    assert.equal(
      buttons.find((b) => b.custom_id?.includes(":publish:")).disabled,
      true,
    );
    assert.ok(payload.components.length <= 5);
    assert.ok(
      nodes(payload)
        .filter((c) => c.type === 1)
        .every((row) => row.components.length <= 5),
    );
    await assert.rejects(reservePublish(env, r), /score all categories/);
    await submitReviewScores(env, r, idea, complete().scores, A, "");
    r = await getReview(env, idea);
    assert.equal((await agreements(env, r)).length, 1);
    await reservePublish(env, r);
    await finishPublish(env, r, "internal-record", B);
    r = await getReview(env, idea);
    assert.equal(r.status, "published");
  } finally {
    await mf.dispose();
  }
});
test("Reviewed status is blocked until three members agree to the current final scores", async () => {
  const { mf, env, idea } = await fixture();
  try {
    assert.equal(await canMarkReviewed(env, idea), false);
    await assert.rejects(
      updateStatus(env, 1, "approved", 1),
      /three Council members/,
    );
    let r = await getReview(env, idea),
      d = complete();
    await editReview(env, r, idea, d, A, "Initial scores");
    r = await getReview(env, idea);
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
    assert.equal(await canMarkReviewed(env, idea), false);
    await assert.rejects(updateStatus(env, 1, "approved", 2));
    await agreeReview(env, r, C);
    assert.equal(await canMarkReviewed(env, idea), true);
    // A withdrawal after a successful preflight must still block the actual write.
    await withdrawAgreement(env, r, C);
    await assert.rejects(updateStatus(env, 1, "approved", 3));
    await agreeReview(env, r, C);
    // A score change after preflight is also caught by the atomic SQL condition.
    d.scores.interest = 5;
    await editReview(env, r, idea, d, A, "More interest");
    await assert.rejects(updateStatus(env, 1, "approved", 4));
    r = await getReview(env, idea);
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
    await agreeReview(env, r, C);
    await updateIdeaAnswers(
      env,
      1,
      "Rewritten",
      { proposal: "new content" },
      1,
      5,
    );
    await assert.rejects(updateStatus(env, 1, "approved", 6));
    const changed = {
      ...idea,
      title: "Rewritten",
      answers: JSON.stringify({ proposal: "new content" }),
    };
    assert.equal(await canMarkReviewed(env, changed), false);
    await editReview(env, r, changed, d, A, "Reassess new content");
    r = await getReview(env, changed);
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
    await agreeReview(env, r, C);
    await updateStatus(env, 1, "approved", 7);
    assert.equal(
      (await env.DB.prepare("SELECT status FROM ideas WHERE id=1").first())
        .status,
      "approved",
    );
  } finally {
    await mf.dispose();
  }
});

test("editor lock: requests preserve the draft; author acceptance applies the exact snapshot and transfers editing", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea);
    const unclaimed = r;
    await startReview(env, r, A);
    await assert.rejects(startReview(env, unclaimed, B));
    r = await getReview(env, idea);
    assert.equal(r.author_id, A.id);
    await directEditReview(env, r, idea, complete(), A, "Initial scores");
    r = await getReview(env, idea);
    const d = JSON.parse(r.draft);
    d.issues = ["clarity"];
    d.issueReason = "Clarify the problem";
    await directEditReview(env, r, idea, d, A, "Triage");
    r = await getReview(env, idea);
    await secondChecks(env, r, C);
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
    await agreeReview(env, r, C);
    const candidate = JSON.parse(r.draft);
    candidate.scores.feasibility = 5;
    candidate.reasons.feasibility = "Existing command already supports this";
    await assert.rejects(
      directEditReview(env, r, idea, candidate, B, "Overwrite"),
    );
    // Even a caller lying about the editor cannot defeat the SQL guard.
    await assert.rejects(
      directEditReview(
        env,
        { ...r, author_id: B.id },
        idea,
        candidate,
        B,
        "Forged overwrite",
      ),
    );
    await saveOrRequestChange(
      env,
      r,
      idea,
      candidate,
      B,
      "A smaller adjustment is sufficient",
    );
    const [request] = await reviewChanges(env, idea.id);
    assert.equal(request.proposer_id, B.id);
    assert.equal((await getReview(env, idea)).draft, r.draft);
    assert.equal((await agreements(env, r)).length, 3);
    await assert.rejects(
      applyReviewChange(env, r, idea, request.id, B),
      /different/,
    );
    await applyReviewChange(env, r, idea, request.id, A);
    r = await getReview(env, idea);
    assert.deepEqual(JSON.parse(r.draft), candidate);
    assert.equal(r.author_id, B.id);
    assert.equal(r.checks_seconder_id, C.id);
    assert.deepEqual(
      (await agreements(env, r)).map((v) => v.id),
      [B.id],
    );
    assert.equal((await reviewChanges(env, idea.id))[0].applied_by_id, A.id);
    await assert.rejects(applyReviewChange(env, r, idea, request.id, C));
    const event = await env.DB.prepare(
      "SELECT * FROM council_review_events WHERE action='request_change'",
    ).first();
    assert.equal(event.actor_id, B.id);
    assert.deepEqual(JSON.parse(event.snapshot), candidate);
    assert.equal(event.reason, request.reason);
  } finally {
    await mf.dispose();
  }
});

test("one backer applies while the editor is absent; competing requests become stale; requests remain auditable", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea);
    await directEditReview(env, r, idea, complete(), A, "Initial");
    r = await getReview(env, idea);
    const candidate = JSON.parse(r.draft);
    candidate.note = "Suggested response";
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
    await agreeReview(env, r, C);
    await saveOrRequestChange(env, r, idea, candidate, B, "Proposed wording");
    const [first] = await reviewChanges(env, idea.id);
    const alternative = { ...candidate, note: "Alternative wording" };
    await saveOrRequestChange(
      env,
      r,
      idea,
      alternative,
      C,
      "Alternative request",
    );
    const [other] = await reviewChanges(env, idea.id);
    await applyReviewChange(env, r, idea, first.id, C);
    r = await getReview(env, idea);
    assert.equal(r.author_id, B.id);
    assert.equal(JSON.parse(r.draft).note, candidate.note);
    assert.equal(
      (await agreements(env, r)).length,
      3,
      "Note-only application preserves score agreements",
    );
    await assert.rejects(
      applyReviewChange(env, r, idea, other.id, A),
      /outdated/,
    );
    assert.equal((await reviewChanges(env, idea.id)).length, 2);
    assert.equal(
      (await reviewChanges(env, idea.id))[0].draft,
      JSON.stringify(alternative),
    );
    await assert.rejects(withdrawReviewChange(env, r, other.id, A));
    await withdrawReviewChange(env, r, other.id, C);
    assert.equal((await reviewChanges(env, idea.id))[0].status, "withdrawn");
    const third = JSON.parse(r.draft);
    third.issues = ["evidence"];
    third.issueReason = "Need test examples";
    await saveOrRequestChange(env, r, idea, third, A, "Evidence needed");
    const [checks] = await reviewChanges(env, idea.id);
    await applyReviewChange(env, r, idea, checks.id, C);
    r = await getReview(env, idea);
    assert.equal(r.checks_proposer_id, A.id);
    assert.equal(r.checks_seconder_id, null, "Backing is not a checks second");
    assert.equal(
      (await agreements(env, r)).length,
      3,
      "Check changes preserve score agreements",
    );
    await assert.rejects(reservePublish(env, r), /second/);
    await secondChecks(env, r, C);
    r = await getReview(env, idea);
    await reservePublish(env, r);
    await assert.rejects(
      saveOrRequestChange(env, r, idea, candidate, B, "While frozen"),
    );
    await assert.rejects(applyReviewChange(env, r, idea, checks.id, B));
  } finally {
    await mf.dispose();
  }
});

test("idea changes and concurrent author edits prevent applying outdated proposals", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea);
    await directEditReview(env, r, idea, complete(), A, "Initial");
    r = await getReview(env, idea);
    const candidate = { ...JSON.parse(r.draft), note: "Suggestion" };
    await saveOrRequestChange(env, r, idea, candidate, B, "Request");
    const [request] = await reviewChanges(env, idea.id);
    const edited = { ...JSON.parse(r.draft), note: "Author revision" };
    await directEditReview(env, r, idea, edited, A, "Revise");
    await assert.rejects(applyReviewChange(env, r, idea, request.id, C));
    r = await getReview(env, idea);
    await saveOrRequestChange(env, r, idea, candidate, B, "New request");
    const [fresh] = await reviewChanges(env, idea.id);
    await updateIdeaAnswers(
      env,
      1,
      "Changed",
      { proposal: "New content" },
      1,
      1,
    );
    await assert.rejects(
      applyReviewChange(env, r, idea, fresh.id, C),
      /another editor|changed/,
    );
    const changed = {
      ...idea,
      title: "Changed",
      answers: JSON.stringify({ proposal: "New content" }),
    };
    await assert.rejects(
      applyReviewChange(env, r, changed, fresh.id, C),
      /outdated/,
    );
    assert.equal((await getReview(env, changed)).draft, r.draft);
  } finally {
    await mf.dispose();
  }
});

test("one Score modal edits all criteria; unchanged scores require no reason and preserve agreements", async () => {
  const { mf, env, idea } = await fixture();
  const originalFetch = globalThis.fetch;
  let delivered;
  globalThis.fetch = async (_url, options) => {
    delivered = JSON.parse(options.body);
    return new Response("{}");
  };
  const interaction = (op, rev, actor = A, fields = [], type = 3) => ({
    type,
    guild_id: "guild",
    channel_id: "private",
    application_id: "app",
    token: "token",
    message: { id: "personal-panel", flags: 64 | 32768 },
    member: {
      roles: ["council"],
      user: { id: actor.id, username: actor.name },
    },
    data: { custom_id: `review:${op}:1:${rev}`, components: fields },
  });
  const submit = async (i) => {
    let pending;
    const ack = await handleReviewInteraction(
      env,
      {
        waitUntil(p) {
          pending = p;
        },
      },
      i,
    );
    assert.equal(
      (await ack.json()).type,
      6,
      "Update the existing private panel",
    );
    await pending;
    return delivered;
  };
  const fields = (u, f = ["3"], interest = ["4"], reason = "Benefit") => [
    ...[
      ["usefulness", u],
      ["feasibility", f],
      ["interest", interest],
    ].map(([id, values]) => ({
      type: 18,
      component: { type: 3, custom_id: id, values },
    })),
    { type: 18, component: { type: 4, custom_id: "reason", value: reason } },
  ];
  try {
    let r = await getReview(env, idea);
    await directEditReview(env, r, idea, complete(), A, "Initial");
    r = await getReview(env, idea);
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
    await agreeReview(env, r, C);
    const modal = await handleReviewInteraction(
      env,
      {
        waitUntil() {
          throw Error("Modal needs immediate ACK");
        },
      },
      interaction("changescores", r.revision),
    );
    const body = await modal.json();
    assert.equal(body.type, 9);
    assert.equal(body.data.components.length, 5);
    for (const label of body.data.components.slice(1, 4)) {
      const select = label.component;
      assert.equal(select.type, 3);
      assert.deepEqual(
        select.options.map((o) => o.value),
        ["1", "2", "3", "4", "5"],
      );
      assert.ok(select.options.every((o) => o.description.length <= 100));
      assert.equal(select.options.filter((o) => o.default).length, 1);
    }
    assert.equal(body.data.components[4].component.required, false);
    await submit(
      interaction(
        "savescores",
        r.revision,
        A,
        fields(["4"], ["3"], ["4"], ""),
        5,
      ),
    );
    assert.equal((await getReview(env, idea)).revision, r.revision);
    assert.equal((await agreements(env, r)).length, 3);
    for (const invalid of [["6"], ["1", "2"], ["3 | reason"], ["03"]]) {
      assert.match(
        panelText(
          await submit(
            interaction("savescores", r.revision, A, fields(invalid), 5),
          ),
        ),
        /score all categories/,
      );
      assert.equal((await getReview(env, idea)).revision, r.revision);
    }
    assert.match(
      panelText(
        await submit(
          interaction(
            "savescores",
            r.revision,
            A,
            fields(["2"], ["3"], ["4"], ""),
            5,
          ),
        ),
      ),
      /changing the submitted scores/,
    );
    assert.equal((await agreements(env, r)).length, 3);
    for (const score of ["1", "2", "3", "4", "5"]) {
      await submit(
        interaction("savescores", r.revision, A, fields([score]), 5),
      );
      r = await getReview(env, idea);
      assert.equal(JSON.parse(r.draft).scores.usefulness, Number(score));
      assert.equal(
        JSON.parse(r.draft).reasons.feasibility,
        "Moderate work",
        "Unchanged explanations are preserved",
      );
    }
    await submit(
      interaction(
        "savescores",
        r.revision,
        A,
        fields([], ["3"], ["4"], "Not enough evidence to rate"),
        5,
      ),
    );
    r = await getReview(env, idea);
    assert.equal(
      JSON.parse(r.draft).scores.usefulness,
      5,
      "Incomplete input must not clear a saved score",
    );
    const proposal = await submit(
      interaction(
        "savescores",
        r.revision,
        B,
        fields(["2"], ["5"], ["4"], "Less work and a narrower benefit"),
        5,
      ),
    );
    assert.equal((await getReview(env, idea)).revision, r.revision);
    assert.match(panelText(proposal), /Change requests:.*Bob/);
    const request = (await reviewChanges(env, idea.id))[0];
    assert.equal(JSON.parse(request.draft).scores.feasibility, 5);
    const card = await submit(interaction("changes", r.revision));
    assert.match(panelText(card), /Bob/);
    assert.match(panelText(card), /2\/5/);
    const backing = interaction("backchange", r.revision, C);
    backing.data.custom_id += `:${request.id}`;
    await submit(backing);
    r = await getReview(env, idea);
    assert.equal(r.author_id, B.id);
    assert.deepEqual(
      (await agreements(env, r)).map((v) => v.id),
      [B.id],
    );
    assert.match(
      panelText(
        await submit(
          interaction("savescores", r.revision - 1, A, fields(["5"]), 5),
        ),
      ),
      /changed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("compact panel uses bordered sections, adjacent approval pairs and no Internal note or standalone Refresh", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea);
    let p = await reviewPayload(env, idea, r, A.id);
    assert.equal(p.flags, 32768);
    assert.deepEqual(p.embeds, []);
    assert.equal(p.components.filter((c) => c.type === 17).length, 4);
    assert.ok(nodes(p).length <= 40);
    assert.equal(
      nodes(p).filter((c) => c.type === 2 && c.label === "Score").length,
      1,
    );
    assert.ok(
      nodes(p).some((c) => c.label === "Start assessment" && !c.disabled),
    );
    await startReview(env, r, A);
    r = await getReview(env, idea);
    p = await reviewPayload(env, idea, r, A.id);
    assert.ok(
      nodes(p).some((c) => c.label === "Assessment in Progress" && c.disabled),
    );
    assert.ok(
      !nodes(p).some((c) =>
        [
          "Start assessment",
          "Internal note",
          "Refresh",
          "Usefulness",
          "Interest",
        ].includes(c.label),
      ),
    );
    const rows = nodes(p).filter((c) => c.type === 1);
    assert.ok(
      rows.some(
        (row) =>
          row.components.map((c) => c.label).join("|") ===
          "Second|Withdraw my Second",
      ),
    );
    assert.ok(
      rows.some(
        (row) =>
          row.components.map((c) => c.label).join("|") ===
          "Agree with final scores|Withdraw score agreement",
      ),
    );
    assert.ok(
      nodes(p).some((c) =>
        c.options?.some(
          (o) =>
            o.label === "Reload latest assessment" &&
            o.description.includes("other Council"),
        ),
      ),
    );
  } finally {
    await mf.dispose();
  }
});

test("opening from the thread creates one private response; private controls and component modals update that response", async () => {
  const { mf, env, idea } = await fixture();
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response("{}");
  };
  const base = {
    type: 3,
    guild_id: "guild",
    channel_id: "private",
    application_id: "app",
    token: "token",
    member: { roles: ["council"], user: { id: A.id, username: A.name } },
    data: { custom_id: "review:open:1:0" },
  };
  async function run(i, expected) {
    let pending;
    const ack = await handleReviewInteraction(
      env,
      {
        waitUntil(p) {
          pending = p;
        },
      },
      i,
    );
    assert.equal((await ack.json()).type, expected);
    await pending;
  }
  try {
    await run(base, 5);
    const privateMessage = { id: "personal-panel", flags: 64 | 32768 };
    await run(
      {
        ...base,
        message: privateMessage,
        data: { custom_id: "review:refresh:1:0" },
      },
      6,
    );
    await run(
      {
        ...base,
        message: privateMessage,
        data: { custom_id: "review:menu:1:0", values: ["preview"] },
      },
      6,
    );
    assert.match(panelText(sent.at(-1).body), /Assessment summary/);
    assert.equal(
      nodes(sent.at(-1).body).filter((c) => c.type === 2).length,
      1,
      "Summary view has only a Back button",
    );
    await run(
      {
        ...base,
        message: privateMessage,
        data: { custom_id: "review:menu:1:0", values: ["refresh"] },
      },
      6,
    );
    assert.ok(sent.every((r) => r.url.endsWith("/messages/@original")));
    assert.ok(sent.every((r) => r.body.flags === 32768));
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("history queries isolate ideas and keep pagination stable as new votes arrive", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea);
    await directEditReview(env, r, idea, complete(), A, "Initial scores");
    r = await getReview(env, idea);
    for (const member of [A, B, C]) {
      await agreeReview(env, r, member);
      await withdrawAgreement(env, r, member);
    }
    const first = await assessmentHistory(env, 1);
    assert.equal(first.events.length, 5);
    assert.equal(first.hasNext, true);
    assert.ok(first.events.some((e) => e.action === "withdraw_scores"));
    await agreeReview(env, r, A);
    const anchored = await assessmentHistory(env, 1, 0, first.anchor);
    assert.deepEqual(
      anchored.events.map((e) => e.id),
      first.events.map((e) => e.id),
    );
    const second = await assessmentHistory(env, 1, 1, first.anchor);
    assert.equal(second.events.length, 2);
    assert.ok(second.events.every((e) => e.id < first.events.at(-1).id));
    assert.equal(second.hasNext, false);
    const empty = await assessmentHistory(env, 2);
    assert.equal(empty.events.length, 0);
    assert.equal(await assessmentEvent(env, 2, first.events[0].id), null);
    await assert.rejects(assessmentHistory(env, 1, -1));
    await assert.rejects(assessmentHistory(env, 1, 0, NaN));
  } finally {
    await mf.dispose();
  }
});

test("history button shows votes, checks seconds and withdrawals in the same private panel without writing", async () => {
  const { mf, env, idea } = await fixture();
  const originalFetch = globalThis.fetch;
  let delivered;
  globalThis.fetch = async (url, init) => {
    assert.ok(
      url.includes("/webhooks/") && url.endsWith("/messages/@original"),
    );
    assert.equal(init.method, "PATCH");
    delivered = JSON.parse(init.body);
    return new Response("{}");
  };
  const input = (id, roles = ["council"], channel = "private", values) => ({
    type: 3,
    guild_id: "guild",
    channel_id: channel,
    application_id: "app",
    token: "token",
    message: { id: "personal-panel", flags: 64 | 32768 },
    member: { roles, user: { id: A.id, username: A.name } },
    data: { custom_id: id, values },
  });
  async function run(i) {
    let pending;
    const ack = await handleReviewInteraction(
      env,
      {
        waitUntil(p) {
          pending = p;
        },
      },
      i,
    );
    const body = await ack.json();
    if (pending) await pending;
    return { ack: body, payload: delivered };
  }
  try {
    let r = await getReview(env, idea);
    await directEditReview(env, r, idea, complete(), A, "Initial");
    r = await getReview(env, idea);
    const d = JSON.parse(r.draft);
    d.issues = ["clarity"];
    d.issueReason = "Clarify this";
    await directEditReview(env, r, idea, d, A, "Flag clarity");
    r = await getReview(env, idea);
    await secondChecks(env, r, B);
    await withdrawChecksSecond(env, r, B);
    await agreeReview(env, r, C);
    await withdrawAgreement(env, r, C);
    const before = await getReview(env, idea);
    const eventCount = await env.DB.prepare(
      "SELECT COUNT(*) n FROM council_review_events",
    ).first();
    const panel = await reviewPayload(env, idea, r, A.id);
    assert.equal(
      nodes(panel).filter((c) => c.label === "Assessment history").length,
      1,
    );
    const { ack, payload } = await run(input(`review:history:1:${r.revision}`));
    assert.equal(ack.type, 6);
    const history = panelText(payload);
    assert.match(history, /Carol.*Withdrew score agreement/);
    assert.match(history, /Carol.*Agreed with final scores/);
    assert.match(history, /Bob.*Withdrew their checks second/);
    assert.match(history, /Bob.*Seconded the selected checks/);
    assert.match(history, /<t:\d+:f>/);
    assert.match(history, /14\/20/);
    assert.ok(nodes(payload).length <= 40);
    assert.ok(history.length < 4000);
    const selector = nodes(payload).find((c) =>
      c.custom_id?.includes(":historyevent:"),
    );
    const details = (
      await run(
        input(selector.custom_id, ["council"], "private", [
          selector.options[0].value,
        ]),
      )
    ).payload;
    assert.match(panelText(details), /full snapshot/);
    assert.match(panelText(details), /Useful/);
    assert.deepEqual(await getReview(env, idea), before);
    assert.deepEqual(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM council_review_events",
      ).first(),
      eventCount,
    );
    assert.equal((await agreements(env, r)).length, 0);
    const denied = await run(input(`review:history:1:${r.revision}`, []));
    assert.match(denied.ack.data.content, /Only White Council/);
    const wrongThread = await run(
      input(`review:history:1:${r.revision}`, ["council"], "public"),
    );
    assert.match(panelText(wrongThread.payload), /private Council/);
    const older = nodes(payload).find((c) => c.label === "Older");
    const oldPage = (await run(input(older.custom_id))).payload;
    assert.match(panelText(oldPage), /not assessed → 4\/5/);
    // History remains readable after closing/resolving and from an older panel.
    await env.DB.prepare("UPDATE ideas SET status='resolved' WHERE id=1").run();
    await env.DB.prepare(
      "UPDATE council_reviews SET status='published' WHERE idea_id=1",
    ).run();
    assert.match(
      panelText((await run(input("review:history:1:0"))).payload),
      /Assessment history/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("proposal history compares against applied snapshots and long event details are paginated without losing text", async () => {
  const { mf, env, idea } = await fixture();
  const originalFetch = globalThis.fetch;
  let delivered;
  globalThis.fetch = async (_url, init) => {
    delivered = JSON.parse(init.body);
    return new Response("{}");
  };
  async function run(id, values) {
    let pending;
    await handleReviewInteraction(
      env,
      {
        waitUntil(p) {
          pending = p;
        },
      },
      {
        type: 3,
        guild_id: "guild",
        channel_id: "private",
        application_id: "app",
        token: "token",
        message: { flags: 64 | 32768 },
        member: { roles: ["council"], user: { id: A.id, username: A.name } },
        data: { custom_id: id, values },
      },
    );
    await pending;
    return delivered;
  }
  try {
    let r = await getReview(env, idea);
    await directEditReview(env, r, idea, complete(), A, "Initial");
    r = await getReview(env, idea);
    const proposed = JSON.parse(r.draft);
    proposed.scores.usefulness = 5;
    await saveOrRequestChange(env, r, idea, proposed, B, "First proposal");
    const [request] = await reviewChanges(env, 1);
    const competing = JSON.parse(r.draft);
    competing.scores.usefulness = 2;
    await saveOrRequestChange(env, r, idea, competing, C, "Competing proposal");
    const history = await run(`review:history:1:${r.revision}`);
    const select = nodes(history).find((c) =>
      c.custom_id?.includes(":historyevent:"),
    );
    const snapshot = await run(select.custom_id, [select.options[0].value]);
    assert.match(panelText(snapshot), /Proposed snapshot/);
    await applyReviewChange(env, r, idea, request.id, A);
    r = await getReview(env, idea);
    const applied = (await assessmentHistory(env, 1)).events.find(
      (e) => e.action === "apply_change",
    );
    assert.equal(
      JSON.parse(applied.previous_snapshot).scores.usefulness,
      4,
      "Pending proposals are not the applied baseline",
    );
    assert.match(
      panelText(await run(`review:history:1:${r.revision}`)),
      /Usefulness: 4\/5 → 5\/5/,
    );
    const large = complete();
    for (const key of Object.keys(large.reasons))
      large.reasons[key] = "R".repeat(500);
    large.issues = ["clarity"];
    large.issueReason = "I".repeat(1000);
    large.note = "N".repeat(1000);
    await directEditReview(env, r, idea, large, B, "Z".repeat(1000));
    r = await getReview(env, idea);
    const listing = await run(`review:history:1:${r.revision}`);
    assert.ok(panelText(listing).length < 4000);
    const options = nodes(listing).find((c) =>
      c.custom_id?.includes(":historyevent:"),
    );
    const first = await run(options.custom_id, [options.options[0].value]);
    assert.match(panelText(first), /Part 1\/2/);
    const next = nodes(first).find((c) => c.label === "Next part");
    const second = await run(next.custom_id);
    assert.match(panelText(second), /Part 2\/2/);
    assert.ok(
      panelText(first).length < 4000 && panelText(second).length < 4000,
    );
    const all = panelText(first) + panelText(second);
    assert.ok(
      all.includes("Z".repeat(1000)),
      "The full audit reason remains readable",
    );
    assert.deepEqual(first.allowed_mentions, { parse: [] });
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("initial complete scoring needs no explanation and counts its submitter once; two more members reach quorum", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea);
    await startReview(env, r, A);
    r = await getReview(env, idea);
    await assert.rejects(
      submitReviewScores(
        env,
        r,
        idea,
        { usefulness: 4, feasibility: 3 },
        A,
        "",
      ),
      /score all categories/,
    );
    assert.equal((await getReview(env, idea)).revision, r.revision);
    await submitReviewScores(env, r, idea, complete().scores, A, "");
    r = await getReview(env, idea);
    assert.deepEqual(JSON.parse(r.draft).reasons, {});
    assert.deepEqual(
      (await agreements(env, r)).map((v) => v.id),
      [A.id],
    );
    await assert.rejects(agreeReview(env, r, A));
    await assert.rejects(reservePublish(env, r));
    await agreeReview(env, r, B);
    await assert.rejects(reservePublish(env, r));
    await agreeReview(env, r, C);
    assert.equal(await canMarkReviewed(env, idea), true);
    await reservePublish(env, r);
  } finally {
    await mf.dispose();
  }
});

test("changes require explanations; requests do not vote until applied and seed the proposer, not the backer", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea);
    await startReview(env, r, A);
    r = await getReview(env, idea);
    await submitReviewScores(env, r, idea, complete().scores, A, "");
    r = await getReview(env, idea);
    await agreeReview(env, r, B);
    await agreeReview(env, r, C);
    const changed = { ...complete().scores, feasibility: 5 };
    await assert.rejects(
      submitReviewScores(env, r, idea, changed, A, ""),
      /Explain why/,
    );
    await assert.rejects(
      submitReviewScores(env, r, idea, changed, B, ""),
      /Explain why/,
    );
    await submitReviewScores(env, r, idea, complete().scores, A, "");
    assert.equal(
      (await agreements(env, r)).length,
      3,
      "No-op submission must not reset votes",
    );
    await submitReviewScores(
      env,
      r,
      idea,
      changed,
      B,
      "This only changes one command",
    );
    const [request] = await reviewChanges(env, idea.id);
    assert.equal((await agreements(env, r)).length, 3);
    const summary = await assessmentSummaryEmbed(env, idea, r);
    assert.match(
      summary.fields.find((f) => f.name === "Changes awaiting review").value,
      /1 score change.*Bob/s,
    );
    assert.match(
      summary.fields.find((f) => f.name === "Current scores and rubric").value,
      /Feasibility ×2: \*\*3\/5/,
    );
    await applyReviewChange(env, r, idea, request.id, C);
    r = await getReview(env, idea);
    assert.deepEqual(
      (await agreements(env, r)).map((v) => v.id),
      [B.id],
    );
    const automatic = (await assessmentHistory(env, idea.id)).events.find(
      (e) => e.action === "agree_scores",
    );
    assert.equal(automatic.actor_id, B.id);
    await withdrawAgreement(env, r, B);
    await assessmentSummaryEmbed(env, idea, r);
    assert.equal(
      (await agreements(env, r)).length,
      0,
      "Reading must not reinstate a withdrawn agreement",
    );
    await assert.rejects(
      submitReviewScores(env, r, idea, { ...changed, interest: 2 }, B, ""),
      /Explain why/,
    );
    await submitReviewScores(
      env,
      r,
      idea,
      { ...changed, interest: 2 },
      B,
      "Less community support",
    );
    r = await getReview(env, idea);
    assert.deepEqual(
      (await agreements(env, r)).map((v) => v.id),
      [B.id],
    );
  } finally {
    await mf.dispose();
  }
});

test("scoring modal distinguishes initial and changed scoring, requires all dropdowns and preserves selected values", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea);
    await startReview(env, r, A);
    r = await getReview(env, idea);
    const i = (op) => ({
      type: 3,
      guild_id: "guild",
      channel_id: "private",
      application_id: "app",
      token: "token",
      member: { roles: ["council"], user: { id: A.id, username: A.name } },
      data: { custom_id: `review:${op}:1:${r.revision}` },
    });
    const ctx = {
      waitUntil() {
        throw Error("Modal must ACK immediately");
      },
    };
    let modal = await (
      await handleReviewInteraction(env, ctx, i("scores"))
    ).json();
    assert.equal(modal.type, 9);
    assert.equal(modal.data.title, "Submit initial scores");
    assert.match(
      modal.data.components[0].content,
      /Please score all categories, or cancel/,
    );
    assert.equal(modal.data.components.length, 4);
    assert.ok(
      !modal.data.components.some((c) => c.component?.custom_id === "reason"),
    );
    for (const c of modal.data.components.slice(1)) {
      assert.equal(c.component.required, true);
      assert.equal(c.component.min_values, 1);
    }
    await submitReviewScores(env, r, idea, complete().scores, A, "");
    r = await getReview(env, idea);
    modal = await (
      await handleReviewInteraction(env, ctx, i("changescores"))
    ).json();
    assert.equal(modal.data.title, "Submit changed scores");
    for (const c of modal.data.components.slice(1, 4))
      assert.equal(
        Number(c.component.options.find((o) => o.default).value),
        complete().scores[c.component.custom_id],
      );
    const p = await reviewPayload(env, idea, r, A.id);
    assert.ok(nodes(p).find((c) => c.label === "Score").disabled);
    assert.ok(
      !nodes(p).find((c) => c.label === "Submit changed scores").disabled,
    );
    const headings = nodes(p)
      .filter((c) => c.type === 10)
      .map((c) => c.content);
    assert.ok(
      headings.findIndex((t) => t.startsWith("### Scores")) <
        headings.findIndex((t) => t.startsWith("### Checks")),
    );
    const submit = nodes(p).find((c) => c.label === "Submit Assessment");
    assert.equal(submit.style, 3);
    assert.equal(submit.disabled, true);
    await agreeReview(env, r, B);
    await agreeReview(env, r, C);
    assert.equal(
      nodes(await reviewPayload(env, idea, r, A.id)).find(
        (c) => c.label === "Submit Assessment",
      ).disabled,
      false,
    );
    assert.equal(nodes(p).length <= 40, true);
  } finally {
    await mf.dispose();
  }
});

test("stable summary edits only the private starter, preserves the idea card and retries concurrent votes", async () => {
  const { mf, env, idea } = await fixture();
  const originalFetch = globalThis.fetch;
  const writes = [];
  let extraVote = false;
  try {
    await env.DB.prepare(
      "UPDATE ideas SET review_message_id='starter' WHERE id=1",
    ).run();
    let r = await getReview(env, idea);
    await startReview(env, r, A);
    r = await getReview(env, idea);
    await submitReviewScores(env, r, idea, complete().scores, A, "");
    r = await getReview(env, idea);
    globalThis.fetch = async (url, init) => {
      assert.equal(
        url,
        "https://discord.com/api/v10/channels/private/messages/starter",
      );
      if (init.method === "GET")
        return Response.json({
          embeds: [
            { title: "Original idea", description: "Do not replace me" },
            {
              title: "Outdated",
              footer: { text: "Current Council assessment" },
            },
          ],
        });
      assert.equal(init.method, "PATCH");
      const body = JSON.parse(init.body);
      writes.push(body);
      assert.equal(
        body.components,
        undefined,
        "Do not alter existing idea controls",
      );
      if (!extraVote) {
        extraVote = true;
        await agreeReview(env, r, B);
      }
      return Response.json({});
    };
    await syncAssessmentSummary(env, idea);
    assert.equal(writes.length, 2);
    const last = writes.at(-1);
    assert.equal(last.embeds.length, 2);
    assert.equal(last.embeds[0].title, "Original idea");
    assert.match(
      last.embeds[1].fields.find((f) => f.name === "Approval still needed")
        .value,
      /2\/3 agreements.*1 more required/s,
    );
    await syncAssessmentSummary(env, idea);
    assert.equal(
      writes.at(-1).embeds.length,
      2,
      "Reuse the same summary rather than appending new ones",
    );
    assert.deepEqual(last.allowed_mentions, { parse: [] });
    await env.DB.prepare(
      "UPDATE ideas SET review_thread_id=thread_id WHERE id=1",
    ).run();
    const count = writes.length;
    await syncAssessmentSummary(env, idea);
    assert.equal(
      writes.length,
      count,
      "Never put assessment data on the public post",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("private creation and refresh keep the summary under the idea while public embeds stay idea-only", async () => {
  const { mf, env, idea } = await fixture();
  const originalFetch = globalThis.fetch;
  const calls = [];
  const { createReviewPost, refreshIdeaPost } = await import(
    "../src/discord/forum.ts"
  );
  const config = JSON.parse(readFileSync("seed/form-config.v1.json", "utf8"));
  env.SUBMITTED_CHANNEL_ID = "review-forum";
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json({ id: "new-review", message: { id: "starter" } });
  };
  try {
    await createReviewPost(env, { ...idea, author_name: "Author" }, config);
    assert.equal(calls[0].body.message.embeds.length, 2);
    assert.equal(calls[0].body.message.embeds[1].title, "Current assessment");
    calls.length = 0;
    await refreshIdeaPost(
      env,
      {
        ...idea,
        author_name: "Author",
        message_id: "public-starter",
        review_message_id: "starter",
      },
      config,
    );
    assert.equal(
      calls.find((c) =>
        c.url.endsWith("/channels/public/messages/public-starter"),
      ).body.embeds.length,
      1,
    );
    assert.equal(
      calls.find((c) => c.url.endsWith("/channels/private/messages/starter"))
        .body.embeds.length,
      2,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("long ideas and the stable assessment share Discord's 6000-character message budget", async () => {
  const { withSummaryEmbed } = await import("../src/discord/embed.ts");
  const original = {
    title: "A long idea",
    description: "D".repeat(3500),
    fields: [
      { name: "Details", value: "V".repeat(1024) },
      { name: "More", value: "W".repeat(1024) },
    ],
  };
  const summary = {
    title: "Current assessment",
    fields: [{ name: "State", value: "S".repeat(1000) }],
  };
  const count = (e) =>
    (e.title?.length || 0) +
    (e.description?.length || 0) +
    (e.footer?.text?.length || 0) +
    (e.author?.name?.length || 0) +
    (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
  const combined = withSummaryEmbed([original], summary);
  assert.ok(combined.reduce((n, e) => n + count(e), 0) <= 6000);
  assert.equal(
    original.description.length,
    3500,
    "The source idea is not modified",
  );
  assert.equal(combined[1], summary);
});

test("failed or stale score submissions cannot leave a new agreement or overwrite the winning scores", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea);
    await startReview(env, r, A);
    r = await getReview(env, idea);
    await submitReviewScores(env, r, idea, complete().scores, A, "");
    const current = await getReview(env, idea);
    await assert.rejects(
      submitReviewScores(
        env,
        r,
        idea,
        { ...complete().scores, interest: 5 },
        A,
        "Stale submission",
      ),
    );
    assert.deepEqual(
      (await agreements(env, current)).map((v) => v.id),
      [A.id],
    );
    assert.equal((await getReview(env, idea)).draft, current.draft);
    await agreeReview(env, current, B);
    await agreeReview(env, current, C);
    await reservePublish(env, current);
    await assert.rejects(
      submitReviewScores(
        env,
        current,
        idea,
        { ...complete().scores, interest: 5 },
        A,
        "During submission",
      ),
    );
    assert.equal((await agreements(env, current)).length, 3);
    assert.equal((await getReview(env, idea)).draft, current.draft);
  } finally {
    await mf.dispose();
  }
});

test("response guidance leads with the recommendation, includes the selected rubric and separates reviewer notes", () => {
  const d = complete();
  d.scores = { usefulness: 3, feasibility: 4, interest: 4 };
  d.reasons = {
    usefulness: "sdfgyhu",
    feasibility: "awsedrfghj",
    interest: "sdfghj",
  };
  const text = feedbackFor({ id: 1, title: "Example" }, d);
  assert.match(text, /Recommended · 15\/20/);
  const main =
    "Scores well overall. We recommend considering it for implementation.";
  assert.ok(text.indexOf(main) < text.indexOf("Usefulness: 3/5"));
  assert.match(
    text,
    /Usefulness: 3\/5\nThis would provide a worthwhile improvement for a defined group of players\./,
  );
  assert.match(
    text,
    /Feasibility: 4\/5 \(×2\)\nThis would require relatively little work, with a small number of contained changes\./,
  );
  assert.match(
    text,
    /Interest: 4\/5\nThere is strong interest across several groups of players\./,
  );
  assert.ok(
    text.indexOf("Council notes:") > text.indexOf(CRITERIA[2].levels[3]),
  );
  assert.ok(text.indexOf("sdfgyhu") > text.indexOf("Council notes:"));
  const untouched = JSON.stringify(d);
  for (let u = 1; u <= 5; u++)
    for (let f = 1; f <= 5; f++)
      for (let i = 1; i <= 5; i++) {
        const draft = {
          ...emptyDraft(),
          scores: { usefulness: u, feasibility: f, interest: i },
        };
        const output = feedbackFor({ id: 1, title: "All score levels" }, draft);
        for (const c of CRITERIA)
          assert.ok(output.includes(c.levels[draft.scores[c.id] - 1]));
        assert.ok(
          !output.includes("Council notes:"),
          "No invented explanations for initial scores",
        );
      }
  assert.equal(
    JSON.stringify(d),
    untouched,
    "Generating feedback must not rewrite recorded assessment data",
  );
  d.issues = ["clarity"];
  d.issueReason = "Clarify the proposal";
  const blocked = feedbackFor({ id: 1, title: "Blocked" }, d);
  assert.match(blocked, /Further action required/);
  assert.ok(
    blocked.includes(CRITERIA[0].levels[2]),
    "Rubric context remains visible with blocking checks",
  );
  assert.ok(
    !blocked.includes("Recommended ·"),
    "Checks override the recommendation",
  );
});

test("the permanent assessment box and scoring panel both include response guidance and selected rubric wording", async () => {
  const { mf, env, idea } = await fixture();
  try {
    let r = await getReview(env, idea);
    await directEditReview(env, r, idea, complete(), A, "Initial");
    r = await getReview(env, idea);
    const summary = await assessmentSummaryEmbed(env, idea, r);
    assert.equal(
      summary.fields.find((f) => f.name === "Response guidance").value,
      BANDS.find((b) => b.max === 16).feedback,
    );
    const wording = summary.fields.find(
      (f) => f.name === "Current scores and rubric",
    ).value;
    const panel = panelText(await reviewPayload(env, idea, r, A.id));
    for (const c of CRITERIA) {
      const level = c.levels[complete().scores[c.id] - 1];
      assert.ok(wording.includes(level));
      assert.ok(panel.includes(level));
    }
    for (const field of summary.fields) assert.ok(field.value.length <= 1024);
  } finally {
    await mf.dispose();
  }
});
