// Pure-logic tests. Run with `npm test` (node --test). Node strips the TS types
// on import, so these exercise the real source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decideTransition } from "../src/lib/transitions.ts";
import { validateAnswers } from "../src/lib/validate.ts";
import { mintSession, verifySession } from "../src/lib/session.ts";
import { assertValidConfig } from "../src/lib/config.ts";
import { answerText, truncate } from "../src/discord/embed.ts";
import { computeResult, CRITERIA, CHECKS, BANDS, isValidValue } from "../src/lib/rubric.ts";

// Helper: build an assignments map, everything seconded by default.
function agree(values) {
  const a = {};
  for (const [id, value] of Object.entries(values)) {
    a[id] = { value, reason: "x", proposerId: "A", proposerName: "A", seconderId: "B", seconderName: "B", revision: 1 };
  }
  return a;
}

test("rubric: 125 score combinations give the weighted total and correct band", () => {
  for (let u = 1; u <= 5; u++)
    for (let f = 1; f <= 5; f++)
      for (let i = 1; i <= 5; i++) {
        const a = agree({ clarity: 0, evidence: 0, split: 0, exists: 0, duplicate: 0, dependency: 0, usefulness: u, feasibility: f, interest: i });
        const r = computeResult(a);
        assert.equal(r.status, "Assessment agreed");
        assert.equal(r.total, u + 2 * f + i);
        const expected = r.total <= 7 ? "Low priority" : r.total <= 10 ? "Worth retaining" : r.total <= 13 ? "Worth considering" : r.total <= 16 ? "Recommended" : "Strongly recommended";
        assert.equal(r.band.name, expected);
      }
});

test("rubric: a seconded yes-check suppresses the score and returns the idea", () => {
  const a = agree({ clarity: 1, evidence: 0, split: 0, exists: 0, duplicate: 0, dependency: 0, usefulness: 5, feasibility: 5, interest: 5 });
  const r = computeResult(a);
  assert.equal(r.status, "Checks Failed");
  assert.equal(r.total, null);
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].id, "clarity");
});

test("rubric: an unseconded item keeps the result pending", () => {
  const a = agree({ clarity: 0, evidence: 0, split: 0, exists: 0, duplicate: 0, dependency: 0, usefulness: 3, feasibility: 3 });
  // interest never assessed
  const r = computeResult(a);
  assert.equal(r.status, "Assessment in progress");
  assert.equal(r.total, null);
  assert.ok(r.pendingIds.includes("interest"));
});

test("rubric: value validation (criteria 1-5, checks 0/1)", () => {
  assert.equal(isValidValue("usefulness", 0), false);
  assert.equal(isValidValue("usefulness", 5), true);
  assert.equal(isValidValue("clarity", 1), true);
  assert.equal(isValidValue("clarity", 2), false);
  assert.equal(isValidValue("nope", 1), false);
});

// cwd is the project root under `npm test` (paths survive the esbuild bundle move).
const config = JSON.parse(readFileSync(join(process.cwd(), "seed/form-config.v1.json"), "utf8"));

test("seed config passes shape validation", () => {
  assert.doesNotThrow(() => assertValidConfig(config));
});

test("transitions: author can move in_proposal -> final_draft and back", () => {
  assert.equal(decideTransition("in_proposal", "final_draft", { isCouncil: false, isAuthor: true }).ok, true);
  assert.equal(decideTransition("final_draft", "in_proposal", { isCouncil: false, isAuthor: true }).ok, true);
});

test("transitions: only council can submit", () => {
  assert.equal(decideTransition("final_draft", "submitted", { isCouncil: false, isAuthor: true }).ok, false);
  assert.equal(decideTransition("final_draft", "submitted", { isCouncil: true, isAuthor: false }).ok, true);
});

test("transitions: stranger cannot change someone else's idea", () => {
  const d = decideTransition("in_proposal", "final_draft", { isCouncil: false, isAuthor: false });
  assert.equal(d.ok, false);
});

test("transitions: council can reopen a submitted idea", () => {
  assert.equal(decideTransition("submitted", "final_draft", { isCouncil: true, isAuthor: false }).ok, true);
  assert.equal(decideTransition("submitted", "in_proposal", { isCouncil: false, isAuthor: true }).ok, false);
});

test("transitions: only council approves, and only from submitted", () => {
  assert.equal(decideTransition("submitted", "approved", { isCouncil: true, isAuthor: false }).ok, true);
  assert.equal(decideTransition("submitted", "approved", { isCouncil: false, isAuthor: true }).ok, false);
  assert.equal(decideTransition("final_draft", "approved", { isCouncil: true, isAuthor: false }).ok, false);
});

test("transitions: only council can reopen an approved idea", () => {
  assert.equal(decideTransition("approved", "submitted", { isCouncil: true, isAuthor: false }).ok, true);
  assert.equal(decideTransition("approved", "in_proposal", { isCouncil: false, isAuthor: true }).ok, false);
});

test("transitions: only council can resolve, from any stage", () => {
  assert.equal(decideTransition("in_proposal", "resolved", { isCouncil: true, isAuthor: false }).ok, true);
  assert.equal(decideTransition("approved", "resolved", { isCouncil: true, isAuthor: false }).ok, true);
  // author (non-council) cannot resolve, even their own idea
  assert.equal(decideTransition("final_draft", "resolved", { isCouncil: false, isAuthor: true }).ok, false);
});

test("transitions: only council can reopen a resolved idea", () => {
  assert.equal(decideTransition("resolved", "in_proposal", { isCouncil: true, isAuthor: false }).ok, true);
  assert.equal(decideTransition("resolved", "submitted", { isCouncil: false, isAuthor: true }).ok, false);
});

test("validate: missing required fields are reported", () => {
  const r = validateAnswers(config, {});
  assert.equal(r.ok, false);
  for (const id of ["title", "purpose", "proposal", "outcome", "affected", "systems", "impact"]) {
    assert.ok(r.errors[id], `expected error for ${id}`);
  }
  assert.ok(!r.errors.extra, "extra is optional");
});

test("validate: rejects an option value not in the config", () => {
  const r = validateAnswers(config, {
    title: "x",
    purpose: "not-a-real-option",
    proposal: "y",
    outcome: "z",
    affected: ["solo"],
    systems: ["mobs"],
    impact: "limited",
  });
  assert.ok(r.errors.purpose, "unknown radio value should be rejected");
});

test("validate: clean answers pass and are normalised", () => {
  const r = validateAnswers(config, {
    title: "  Stablehands  ",
    purpose: "qol",
    proposal: "A proposal",
    outcome: "Better",
    affected: ["solo", "pve", "solo"],
    systems: ["mobs"],
    impact: "limited",
    extra: "",
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.clean.title, "Stablehands");
  assert.deepEqual(r.clean.affected, ["solo", "pve"]); // de-duped, option order
  assert.equal(r.clean.extra, undefined);
});

test("validate: enforces maxLength", () => {
  const long = "a".repeat(101);
  const r = validateAnswers(config, {
    title: long,
    purpose: "qol",
    proposal: "p",
    outcome: "o",
    affected: ["solo"],
    systems: ["mobs"],
    impact: "limited",
  });
  assert.ok(r.errors.title);
});

test("session: round-trips and rejects tampering / expiry", async () => {
  const secret = "test-secret-please-ignore";
  const token = await mintSession({ u: "123", n: "Khófur", g: "999" }, secret);
  const ok = await verifySession(token, secret);
  assert.ok(ok);
  assert.equal(ok.u, "123");
  assert.equal(ok.g, "999");

  // tampered signature
  assert.equal(await verifySession(token.slice(0, -2) + "xx", secret), null);
  // wrong secret
  assert.equal(await verifySession(token, "other-secret"), null);
  // expired
  const past = Math.floor(Date.now() / 1000) + 4000; // check far in the future
  assert.equal(await verifySession(token, secret, past), null);
});

test("embed: truncate and answerText resolve labels", () => {
  assert.equal(truncate("hello world", 8), "hello w…");
  const purpose = config.pages[0].fields.find((f) => f.id === "purpose");
  assert.equal(answerText(purpose, "qol"), "Improve quality of life");
  const affected = config.pages[1].fields.find((f) => f.id === "affected");
  assert.equal(answerText(affected, ["solo", "pve"]), "Solo players, PvE-focused players");
});
