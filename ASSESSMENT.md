# Council assessment in Discord

This replaces the per-item propose/second workflow from PR #1 with a fluid shared
assessment, one second on the complete selected checks, and three agreements on
the final scores.

## Review flow

1. In the private Council review thread, click **Assess idea**, then **Start
   assessment**. Any Council member can start. Their name is shown as the editor;
   merely opening a panel does not claim the assessment. Existing drafts keep their
   scores, checks and history and start with no assigned editor after migration 0006.
2. Click **Usefulness**, **Feasibility ×2** or **Interest**. Each opens a form with
   a **1–5 dropdown**, the rubric description beside each option, a separate score
   explanation, and a reason for the edit. No `number | explanation` syntax is used.
   Use **Internal note** for response guidance. The weighted total remains 4–20.
3. The editor saves changes directly. Other members use those same controls to
   **request a change**. A request records its proposer, timestamp, reason, exact
   replacement draft and base revision without changing the current assessment.
   The panel lists recent requests; **View change requests** displays each complete
   proposal with previous/next navigation, including withdrawn and outdated requests.
4. The editor can **Accept / back and apply** a request. Alternatively, **one other
   Council member** can use the same button while the editor is absent. The proposer
   cannot back their own request. Application transfers editing to the proposer,
   records the accepting/backing member, and applies exactly that proposal. Any
   intervening assessment edit or idea-content change makes it outdated; a new
   request is needed. Proposers can withdraw their pending requests.
5. **Issues requiring action** is a multi-select dropdown. Unselected issues pass
   by default. The editor saves a selection directly; another member proposes it as
   a change request. Once selected checks are applied to the assessment, a different
   Council member clicks **Second** once for the entire set and its explanation.
   Backing a change request is not that checks second.
6. **Agree with final scores** is separate. Three distinct Council members must
   explicitly agree to the complete scores and their explanations. Editing, starting
   an assessment and backing a request never create score agreements.
7. Score/explanation edits reset score agreements only. Check/explanation edits reset
   the checks second only. Internal-note edits reset neither. Underlying idea changes
   invalidate both. Requesting or withdrawing a change resets neither because the
   assessment has not changed. Accepted requests follow the same scope rules as edits.
8. **Preview internal summary** shows what will be recorded. **Close and record
   internally** requires three score agreements when no issues are selected; selected
   checks instead need one second for an internal return/defer record. Closing freezes
   editing and request application. The existing Reviewed gate still requires three
   agreements on the complete current scores, even for a return/defer assessment.
9. **Reopen assessment** clears both approvals and the editor so any Council member
   can start the next round. Scores and request/event history remain. A Resolved idea
   must first be reopened using its status dropdown.

Panels are personal snapshots of the shared assessment. **Refresh** reloads the
current draft and requests. Requests and assessments are Council-only working
material; a member writes the eventual player-facing response separately.

The existing In Proposal / Final Draft / Submitted / Reviewed / Resolved status
workflow stays separate. Closing an assessment does not change the idea status.
**Marking an idea Reviewed is blocked until three Council members have agreed to
its current complete scores.** The Discord dropdown explains why a premature
attempt is rejected, and the database update checks the same condition atomically.
A changed idea, revised scores or withdrawn agreement cannot bypass this gate.
A checks second alone allows an internal return/defer record, but does not permit
marking the idea Reviewed without the three final-score agreements. Reviewed exports
still contain the original idea (not the assessment); the private Council thread holds the
recorded assessment. There is no new Activity, OAuth setup or slash command.

A Council member uses this internal assessment as the basis for a separately written
response. This feature never posts ratings, reviewer agreements or assessment notes
to the public board, the author, or reviewed exports.

## Storage and safeguards

Migration 0004 adds shared drafts and event history. Migration
`0005_separate_checks_and_scores.sql` adds independent score/check revisions,
checks proposer/seconder attribution and a separate score-agreement table. Existing
whole-assessment agreement rows/history are retained but do not automatically count
as final-score votes under the revised model. Acknowledged Discord IDs and role lists
are checked server-side for each interaction. Read or write controls must originate
in the idea's private review thread. Native mutation requests are acknowledged
before database/Discord operations; opening a modal uses an immediate response.

Revision updates use compare-and-swap SQL, with mutation and event logging in one
D1 batch. Score agreements are unique per idea, score revision and actor. Checks seconds are
atomic, require a different member, and cover one complete check revision. Events preserve the
whole draft, actor, reason and timestamp. An idea-content fingerprint prevents
publishing an assessment of old content. During reserved publication, content and
status edits are blocked until delivery is completed; use Retry internal recording if a
network failure left it reserved.

Publication uses a stable nonce and a durable message marker, scanning that thread
for a prior bot-authored result before retrying. This avoids reposting feedback if
Discord succeeded but database finalisation failed. The draft remains locked during
such failures. A maintainer can recover a persistently failed reserved publication
by fixing Discord permissions and retrying; do not reset it before checking for an
already-delivered message. Mentions in assessment output are suppressed.

Migration `0006_assessment_change_requests.sql` adds nullable editor fields and
an append-only-in-content change-request table. Prior assessments, approvals,
requests and audit records are not deleted. Request creation, withdrawal and
application are audited transactionally. The editor check and request application
are enforced in the database write, not just by showing/hiding controls. A stale
request cannot overwrite a newer revision or changed idea. Requests can be applied
only by a different Council member and only while the assessment is open.

Each score modal uses Discord Label components containing a String Select and
separate Text Inputs. Both Label and legacy Action Row submissions can be read;
legacy combined-score modal saves must be refreshed instead of being silently
interpreted as dropdown input. Test the updated modal on actual Discord clients
before production deployment.

Existing PR #1 tables/history are retained. On first native access, existing values
are imported into an **unagreed draft**; old per-item seconds never count as the new
three-person agreement. The previous web review page explains where reviewing moved,
and its mutation API returns 410 so it cannot publish via the obsolete rules.

## Deploy and refresh

First test this branch in staging with three real Council identities. Staging's
`everyone` Council sentinel is only for its test guild. Use a modern Node release
(Node 22.13+; Node 24 recommended) for tests that exercise production SQL through
Node's SQLite API. No runtime dependencies were added.

```bash
npm ci
npm run typecheck
npm test
npm run build:client
npx wrangler deploy --dry-run
```

After review, the maintainer verifies the correct Cloudflare account, applies
migrations 0004, 0005 and 0006 and deploys to staging, then production. Existing configured roles
and permissions should suffice; the bot needs Send Messages, Embed Links, Manage
Threads and Read Message History in the relevant forums. No new Discord portal
configuration or command registration is needed.

Refresh existing private posts with the dry-run-first helper (this does not touch
public messages or reactions):

```bash
node scripts/backfill-native-review.mjs
node scripts/backfill-native-review.mjs --apply
```

Staging uses `MUME_ENV_FILE=.dev.vars.staging` and `--staging`. This PR does not deploy
or execute the backfill. The native assessment button is also retained by content
and status refresh paths, so future edits do not remove it.

## Validation

Tests cover all 125 new-rubric score combinations, no-issue defaults, flag precedence,
input validation, three distinct score agreements, whole-selection checks seconding, independent
approval invalidation, repeated votes, withdrawals, stale
revisions/content, frozen publication, full event snapshots, and native role/guild
checks. SQLite tests execute the production D1 SQL through a transactional adapter;
real Discord interaction and deployed D1 acceptance are part of staging verification.
