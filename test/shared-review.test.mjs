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
} from "../src/lib/sharedReviewDb.ts";
import { updateIdeaAnswers, updateStatus } from "../src/lib/db.ts";
import {
  handleReviewInteraction,
  reviewPayload,
  reviewButton,
} from "../src/discord/review.ts";
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
    assert.equal((await agreements(env, r)).length, 0);
    assert.match(
      (
        await env.DB.prepare(
          "SELECT snapshot FROM council_review_events WHERE action IN ('revise','apply_change') ORDER BY id DESC LIMIT 1",
        ).first()
      ).snapshot,
      /Final feedback changed/,
    );
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
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
    assert.equal(p.components[0].components[0].min_values, 0);
    assert.equal(p.components[0].components[0].max_values, 6);
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
    assert.deepEqual(posted.allowed_mentions, { parse: [] });
    assert.equal(posted.enforce_nonce, true);
    assert.ok(posted.nonce.length <= 25);
    r = await getReview(env, idea);
    assert.equal(r.status, "published");
    assert.match(
      shown.embeds[0].description,
      /Closed — recorded in the private Council thread/,
    );
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
    assert.equal((await agreements(env, r)).length, 0);
    assert.equal(
      r.checks_seconder_id,
      B.id,
      "Score change must retain the checks second",
    );
    await agreeReview(env, r, A);
    await agreeReview(env, r, B);
    await agreeReview(env, r, C);
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
test("selected checks can be recorded with one second, without voting on unfinished scores", async () => {
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
    const buttons = payload.components.flatMap((row) => row.components);
    assert.equal(
      buttons.find((b) => b.custom_id?.includes(":agree:")).disabled,
      true,
    );
    assert.equal(
      buttons.find((b) => b.custom_id?.includes(":publish:")).disabled,
      false,
    );
    assert.ok(payload.components.length <= 5);
    assert.ok(payload.components.every((row) => row.components.length <= 5));
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
    assert.equal((await agreements(env, r)).length, 0);
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

test("native score modals use a 1–5 select with separate explanations; non-editors create visible requests", async () => {
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
    assert.equal((await ack.json()).type, 5);
    await pending;
    return delivered;
  };
  const fields = (score, reason = "Benefit", why = "Discussed") => [
    { type: 18, component: { type: 3, custom_id: "score", values: score } },
    { type: 18, component: { type: 4, custom_id: "reason", value: reason } },
    { type: 18, component: { type: 4, custom_id: "why", value: why } },
  ];
  try {
    let r = await getReview(env, idea);
    await startReview(env, r, A);
    r = await getReview(env, idea);
    const modal = await handleReviewInteraction(
      env,
      {
        waitUntil() {
          throw Error("Modal needs immediate ACK");
        },
      },
      interaction("score-usefulness", r.revision),
    );
    const body = await modal.json();
    assert.equal(body.type, 9);
    assert.equal(body.data.components.length, 3);
    const select = body.data.components[0].component;
    assert.equal(select.type, 3);
    assert.deepEqual(
      select.options.map((o) => o.value),
      ["1", "2", "3", "4", "5"],
    );
    assert.ok(select.options.every((o) => o.description.length <= 100));
    assert.equal(body.data.components[1].component.custom_id, "reason");
    for (const invalid of [[], ["6"], ["1", "2"], ["3 | reason"], ["03"]]) {
      // Explicitly construct the criterion suffix after the revision.
      const i = interaction("savescore", r.revision, A, fields(invalid), 5);
      i.data.custom_id += ":usefulness";
      assert.match((await submit(i)).content, /Choose one score/);
      assert.equal((await getReview(env, idea)).revision, r.revision);
    }
    for (const score of ["1", "2", "3", "4", "5"]) {
      const i = interaction("savescore", r.revision, A, fields([score]), 5);
      i.data.custom_id += ":usefulness";
      await submit(i);
      r = await getReview(env, idea);
      assert.equal(JSON.parse(r.draft).scores.usefulness, Number(score));
    }
    const missingReason = interaction(
      "savescore",
      r.revision,
      A,
      fields(["4"], ""),
      5,
    );
    missingReason.data.custom_id += ":usefulness";
    assert.match((await submit(missingReason)).content, /Explain each score/);
    const proposal = interaction(
      "savescore",
      r.revision,
      B,
      fields(["2"], "Less useful", "Narrow case"),
      5,
    );
    proposal.data.custom_id += ":usefulness";
    const panel = await submit(proposal);
    assert.equal((await getReview(env, idea)).revision, r.revision);
    assert.equal((await reviewChanges(env, idea.id))[0].proposer_id, B.id);
    assert.ok(
      panel.embeds[0].fields.some(
        (f) => f.name === "Change requests" && f.value.includes("Bob"),
      ),
    );
    assert.ok(panel.components.length <= 5);
    for (const row of panel.components) assert.ok(row.components.length <= 5);
    const card = await submit(interaction("changes", r.revision));
    assert.match(card.embeds[0].description, /Bob/);
    assert.equal(card.embeds[0].fields[0].value.startsWith("2/5"), true);
    const request = (await reviewChanges(env, idea.id))[0];
    const backing = interaction("backchange", r.revision, C);
    backing.data.custom_id += `:${request.id}`;
    await submit(backing);
    r = await getReview(env, idea);
    assert.equal(r.author_id, B.id);
    assert.equal(JSON.parse(r.draft).scores.usefulness, 2);
    assert.equal((await agreements(env, r)).length, 0);
    const stale = interaction("savescore", r.revision - 1, A, fields(["5"]), 5);
    stale.data.custom_id += ":usefulness";
    assert.match((await submit(stale)).content, /changed/);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});
