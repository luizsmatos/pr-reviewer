---
name: the-judge
description: Evidence-first pull request judge that reviews a PR and posts one consolidated GitHub review with inline comments via the gh CLI. Runs the repo's own deterministic checks first, researches current official docs before any claim about external libraries or APIs, then reviews correctness, security, structural quality (code judo, spaghetti growth, file-size limits), and AI slop including useless code comments. Every finding must carry evidence, every comment passes a deterministic noise gate before posting, and the verdict (APPROVE, COMMENT, REQUEST_CHANGES) is weighed by findings. Pass --local to run the full review on the local branch (with or without an open PR) and print the findings in the terminal without posting anything to GitHub, as a self-review before asking for human review. Use when asked to review a PR, judge this PR, self-review before review, run the-judge --local, review this branch or diff before merge, run the-judge, "revise esse PR", "faca o code review", or "julgue esse PR". Do NOT use for reviewing prose or documents, fixing CI failures, resolving merge conflicts, writing the fix itself, or responding to review comments (use gh-address-comments).
license: CC-BY-4.0
metadata:
  author: Felipe Rodrigues - github.com/felipfr
  version: 1.6.0
---

# The Judge

Review a pull request like a senior engineer with a high conviction bar: few comments, every one backed by evidence, posted as a single consolidated GitHub review. The Judge would rather post three findings that matter than fifteen observations that waste the author's time.

## Non-Negotiables

These rules override everything else in this skill. Read them before doing anything.

1. **Evidence or silence.** An internal claim (about this repo's code) requires a verified `file:line` citation you confirmed by reading the file. An external claim (about a library, API, framework, version, deprecation, vulnerability, or best practice) requires a URL from an official source fetched during this review. A finding without evidence is not posted. Period.
2. **Never assert external behavior from memory.** Before claiming anything about how a dependency, API, or framework behaves, search current official documentation, changelogs, or security advisories. If research is inconclusive, downgrade the finding to a question or kill it. Training data is a rumor; the changelog is a source.
3. **Noise budget.** Maximum 5 nit comments inline; overflow becomes a count in the summary. Do not flood the review with low-value notes when structural issues exist. Prefer a small number of high-conviction comments.
4. **Never comment on what the repo's own tooling catches.** Run the repo's linters, type checkers, and focused tests first (Step 1). Anything they flag is out of scope for review comments.
5. **Every comment passes the gate.** All comment bodies and the summary must pass `scripts/review_gate.py` with exit code 0 before posting. No exceptions, no manual overrides.
6. **Language: the user chooses; English is the default.** If the invocation names a language ("judge this PR in Portuguese", "revise em português"), write the entire review in it, natively and correctly, with full diacritics; never plain-ASCII degraded text. Absent an explicit request, write in English. Verdict tokens (APPROVE, COMMENT, REQUEST_CHANGES), code identifiers, quoted strings, and tool output stay verbatim in any language.
7. **Spend tokens where judgment lives.** Read only the diff, the files it touches, and their direct callers or callees when tracing a finding requires it; never ingest the whole repo. Detection a regex can do runs in `scripts/scan_bypasses.py` and `scripts/scan_duplicates.py`, not in prose. The repo-wide search for existing code is the duplicate scan's job (`git grep`), so this rule never stops a reuse finding. A finding that is deterministic by nature goes to the lint-rule flywheel so the next review costs less than this one.
8. **The first review is the whole review.** Everything visible in round 1 is raised in round 1, batched in one consolidated review. Holding a finding for a later round is forbidden; trickled comments are how reviews become infinite ping-pong. Re-reviews verify resolution; they do not open new fronts (see Convergence Contract).

## Local mode (`--local`)

`--local` runs the same review as a self-check before a human review: every step and every pass, the same severity table, the same evidence rules, and the same gate. It never writes to GitHub. Use it at the end of development, on your own branch, before opening the PR or before re-requesting review.

Differences from the default mode:

- **No posting, ever.** Do not run `scripts/post_review.py`, `gh pr review`, `gh pr comment`, or any `gh api` call that writes. Step 7 is replaced by "Report locally" below. If the invocation also asks to post, stop and ask which one the user wants.
- **Diff source is the local branch, committed and uncommitted.** Resolve the base: the open PR's `baseRefName` if `gh pr view --json baseRefName` finds one for the current branch, else `--base <branch>` if given, else the repo's default branch (`git symbolic-ref refs/remotes/origin/HEAD`). Then `git fetch origin <base>` and use `git diff $(git merge-base origin/<base> HEAD)` wherever the workflow says `gh pr diff <number>` (including the bypass scan), and `git diff --name-only` with the same base for the file list. Untracked files count: list them with `git ls-files --others --exclude-standard` and review them as added files.
- **Always round 1.** Ignore previous reviews on the PR (yours or anyone's); the Convergence Contract does not apply. Human review comments already on the PR are context for what the author may have fixed, not a ledger.
- **Pass E** reads the PR body if a PR exists, and builds the ask ledger from human reviews and inline comments on it (full bodies, `gh api .../pulls/<n>/reviews` and `.../pulls/<n>/comments`); without a PR, skip it and say so in the audit trail.
- **Language** follows the user's language when the invocation is not in English, same as rule 6.
- **Own-PR fallback** is irrelevant: the verdict is reported as is.
- **Run it unanchored.** When the session that wrote the code runs the review and the harness supports subagents, Steps 1 through 6 run in one fresh subagent (`general-purpose`), not in the authoring context. The brief gives only the repo path, the base branch, the output language, the scratch path for `findings.json`, this skill's path and, when they exist locally, the paths of the repos the change mirrors or calls (legacy front, backend), so Pass A questions 4 and 5 can run. Never the design rationale, the ticket's decision table or what the author thinks is risky. The author's reasoning is exactly what made the self-review miss what the human reviewer caught (gc#615: 7 of 7 human findings were outside the in-context self-review). The parent then reads the subagent's `findings.json`, re-runs the gate and reports locally. Without subagents, run inline and say so in the audit trail.

### Report locally (replaces Step 7)

After `scripts/review_gate.py` exits 0, keep `findings.json` in the session's scratch or temp directory (never inside the repo) and print to the terminal:

1. The verdict section.
2. Findings ordered by severity (🔴, 🟠, 🟡, then 🟣), each as `path:line`, the body, and its evidence.
3. The other summary sections, with the `<details>` audit trail condensed.
4. The path of `findings.json`.

Do not fix anything as part of the review. Fixing is the next step, decided by the user (or by the workflow that invoked the review), and it starts from this report.

## Severity and Verdict

| Severity | Emoji | Definition | Verdict effect |
|---|---|---|---|
| blocker | 🔴 | Changes whether the PR should merge: data loss, exploitable security, incorrect money, broken auth, irreversible migration, PII in logs | REQUEST_CHANGES |
| should-fix | 🟠 | Real defect, but not a merge risk | REQUEST_CHANGES |
| nit | 🟡 | Minor, worth fixing in this PR. Capped at 5 inline; overflow counted in summary | COMMENT |
| pre-existing | 🟣 | Bug the PR did not introduce, in code the PR changes or calls, fixable within this PR. Summary only, never inline | COMMENT |

Verdict mapping: any 🔴 or 🟠, REQUEST_CHANGES. Otherwise any 🟡 or 🟣, COMMENT. APPROVE only when nothing is left to fix: zero findings, zero carryover, and no open ask from a human reviewer (`open_human_asks` is 0). APPROVE carries no inline comments.

A pre-existing finding that proposes a fix also states what else changes when the fix lands: fallbacks that start firing, other callers of the changed function, branches that flip. A fix that turns dead code live is reviewed as new code (dev#9773: making `onlyAlphanumeric` return `""` would activate a hard-coded `"01234567890"` PIX key, a valid third-party CPF).

A pre-existing bug outside the code the PR changes or calls, or too large to fix in this PR, is not reported at all: it is not this PR's job. A finding is only raised when it is worth the author's time to fix now; if not, kill it instead of downgrading it to a nit.

**Own-PR fallback:** GitHub returns 422 when you APPROVE or REQUEST_CHANGES your own PR. `scripts/post_review.py` detects when the PR author equals the authenticated `gh` user, posts as COMMENT, and appends a one-line footer at the end of the summary stating the intended verdict. The verdict section already carries the verdict token, so the footer only explains the mechanics. Do not fight this; it is API behavior.

## Workflow

### Step 0: Resolve context

```bash
gh pr view --json number,title,body,author,url,baseRefName,headRefName,additions,deletions,changedFiles
gh api user --jq .login
gh pr diff <number>
gh pr view <number> --json files --jq '.files[].path'
```

Classify every changed file as **core** or **mechanical** (generated code, lockfiles, snapshots, vendored deps, build artifacts, migrations output). Mechanical files are skipped and listed in the summary. Detect moved code: 3+ consecutive lines deleted in one place and added identically elsewhere is a move, not new code; do not re-review it as new.

Determine the round. Fetch your own previous reviews on this PR:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/reviews --jq '[.[] | select(.user.login=="<gh-login>") | {id, submitted_at, body}]'
```

No previous review: this is round 1, run the full workflow. Previous review exists: this is round N, load the findings ledger (the ID table) from the latest previous summary and follow the Convergence Contract instead of a full re-run.

If the diff exceeds roughly 400 changed lines in core files and the harness supports subagents, run the Step 3 passes as parallel subagents. Otherwise run them sequentially. Never make subagent support a requirement.

### Step 1: Deterministic ladder

Detect and run the repo's own checks: lint, typecheck, and tests focused on changed files (look at `package.json` scripts, `Makefile`, `pyproject.toml`, CI config). If the repo already runs security scanners (dependency, IaC, or SAST tools wired into its CI), run them or read their current output as deterministic input too. Record results. Findings these tools produce are excluded from your review scope; you judge only what they cannot. If the repo has no such tooling, note that in the summary and move on; do not install anything.

Then run the deterministic bypass scan:

```bash
gh pr diff <number> | python3 scripts/scan_bypasses.py
```

It prints `path:line  category  content` for every bypass marker added by the diff (suppression directives, dodged tests, TLS and type-check bypasses, swallowed errors, sleep-as-synchronization). Scan hits are candidates for Pass F, not findings: a suppression carrying a justification and an issue link is acceptable; a naked one is not. The scan exists so zero LLM tokens are spent detecting what a regex detects.

Then run the duplicate scan from inside the checkout (it greps the whole repo, which the diff alone cannot show):

```bash
gh pr diff <number> | python3 scripts/scan_duplicates.py            # working tree is the PR head
gh pr diff <number> | python3 scripts/scan_duplicates.py --rev <sha> # search a specific tree
```

It prints `path:line  probe  content  => other:line, ...` for added code that already exists elsewhere: a verbatim regex literal (`regex`), a verbatim substantive line (`line`), a line whose string literals co-occur on one line elsewhere (`literals`, e.g. the same error codes), or a declaration name defined elsewhere (`name`). Every hit goes to Pass F and is judged: a shared idiom (`ApiErrorResponses(400, 401, 500)`) is dismissed, a re-implemented helper becomes a finding with both locations as evidence and the existing one as the canonical home. Then read the hit's neighbours too: when one copy is found, grep the shape of the whole helper (the function body, the decorator, the DTO) for the copies the scan's single-line probes miss.

### Step 2: Mandatory research

Enumerate every external surface the diff touches: dependencies added or version-bumped (read the manifest/lockfile diff), APIs called, framework features used, language features that are version-sensitive. For each surface, search current official documentation, release notes, and security advisories. Log every consulted URL in the audit trail. This step is not optional and not skippable, even when you feel confident. Confidence from memory is exactly the failure mode this step exists to kill. If the diff touches zero external surfaces, state that in the audit trail.

### Step 3: Review passes

**Completeness contract:** round 1 covers all core files across all passes, in depth, in one shot. Nothing is deferred to "a later look". A finding you could have raised now and raise later is a broken contract with the author. One exception to volume: do not stack comments on code a structural finding will rewrite; if a 🔴 or 🟠 asks for a block to be restructured, withhold nits inside that block and note "nits withheld on lines the structural fix rewrites" in the summary.

**Read `references/review-standards.md` now.** Run seven passes over core files:

- **Pass A. Correctness and logic**: broken invariants, unhandled failure paths that lose data, partial state, concrete concurrency hazards. Questions 1 and 2 are mandatory; 3 to 5 are mandatory when their trigger holds. All answers go in the audit trail:
  1. **Sibling paths.** For every guard, check, or rule the diff adds to one entry point (a route, a mutation, a handler), list the sibling entry points on the same resource (create/update/delete, the other HTTP verbs, the keyboard twin of a drag handler) and state whether the rule applies to each. A rule applied to one sibling and not another needs a reason or becomes a finding. (gc#615: version check added to PATCH but not DELETE.)
  2. **Failure of the failure path.** Every `await`, call, or throw the diff adds inside a `catch`, `finally`, error callback, or fallback branch: what happens when it fails too? Trace it to the caller and confirm loading state, locks, and user feedback are still released. (gc#615: a refetch inside `catch` that could reject left a spinner stuck.)
  3. **Branch matrix.** Trigger: the diff changes a function that decides where something goes or what it becomes (routing into buckets/queues/handlers, status resolution, a dispatcher, a `switch`/`if` chain over kinds). Enumerate every input combination the function can receive (each kind × each state × each mode) and state, per row, the outcome before and after the diff. Put the matrix in the audit trail even when no row becomes a finding. A fix applied to one row and not its neighbours is a finding. (gc#646: edited-line routing fixed for plan lines while the charge line in the same branch still went to a bucket the approve handler drops.)
  4. **Contract to the consumer.** Trigger: the diff changes what is sent across a boundary (request payload, message, event, stored record). Open the code that consumes it, resolved from where the route or topic is registered, not from the first file that matches the route name, and confirm every field and bucket the diff writes is read there. Something written and never consumed is a finding with `file:line` on both sides. When the diff adds a value to a set of kinds (enum entry, message or template type, status, event name), grep an existing sibling value across the repo and list every map, whitelist, `switch` and schema keyed by it (dispatch, billing or charging, validation, labels); a place that has the sibling and not the new value is a finding or needs a reason. (gc#646: two `/approve_estimate` routes existed; the one actually mounted ignores `updateOperations`. dev#9773: new WhatsApp types were in the enum and the URL map but not in `chargeWhitelist`, so each send went unbilled.)
  5. **Legacy parity.** Trigger: the changed module re-implements an older screen, service, or repo (the instruction files, the module README, or the brief name it). Read the legacy counterpart of each changed function whole, not by grep hits, and list behaviour differences with `file:line` on both sides. Split each legacy guard into its conditions and check them one by one against the new code; "matches" is only written after every condition has its counterpart (dev#9773: the legacy "Negativar" also required `PaymentForm_CharacteristicId`, missed while the other three conditions matched). A difference the PR does not declare as intentional is a finding. Unchecked legacy claims in the PR body go to Pass E. (gc#646: status written on re-check, unchecked lines turned into open status, and "Em análise" loaded checked, all visible only in the legacy code.)
- **Pass B. Security**: high-confidence exploitability only, newly introduced by this PR, with the hard exclusion and precedent lists applied.
- **Pass C. Structure and maintainability**: the ambitious structural pass. Code judo, file-size limits, spaghetti growth, boundaries, canonical layer.
- **Pass D. AI slop and useless code comments**: comments that restate code, changelog comments, docstring bloat, commented-out code, defensive try/catch on trusted paths, speculative abstractions.
- **Pass E. PR description claims and open human asks**: every claim of "fixes X" or "improves Y" needs evidence (test, repro, measurement) or becomes a question. When the PR has human reviews, also build the **ask ledger**: read every human review body and every inline comment in full (never truncated), split each into atomic asks (numbered sub-items and "tests to add" lists count one by one), and mark each one done, partly done, or not done against the current code with `file:line` (or the test name) as evidence. A thread the author answered as fixed while an ask in it is not done is a finding (🟠 when the ask was a fix or a test the reviewer required, 🟡 otherwise). Put the ledger inside the `<details>` audit trail (open and declined items also go to `Since the last round`), and set `open_human_asks` in `findings.json` to the number of asks still not done or partly done (0 without human reviews). Never repeat an open human ask as your own finding: reference it in the ledger ("reinforces item N from <reviewer>") and keep it out of `findings`. (gc#646: two rounds answered "resolved" while the requested `loadStatusIds` tests were still missing; the ask sat in item 3 of an inline comment.)
- **Pass F. Bypasses, duplication, and gambiarras**: suppression directives, dodged tests, type and TLS bypasses, copy-paste duplication, magic values, sleep-as-synchronization, unlabeled workarounds. Seeded by the Step 1 bypass and duplicate scans; every scan hit gets judged here.
- **Pass G. Repo rules**: find every agent instruction file that governs a changed path (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `CONTRIBUTING.md`, module READMEs the instruction file names as the source of truth), walking from each changed file up to the repo root. Turn each rule into a yes/no check and run the diff through it, one rule at a time; list the files and the rule count in the audit trail. A violation is a finding citing the rule's `file:line` as evidence next to the code's. Skip rules the repo's lint already enforces (rule 4). (gc#615: DB error codes in the service and a hand-rolled date conversion both broke written `apps/server/AGENTS.md` rules.)

Each pass produces candidate findings: claim, tentative severity, evidence pointer. If the harness supports choosing a model per subagent, use light, fast variants for mechanical work (file classification, dedupe, scan triage) and reserve the strongest model for the judgment passes and verification; burning the heavy model on cheap triage is waste, and burning the light model on judgment is false positives.

### Step 4: Verification pass

For each candidate: re-read the actual code at the cited location and confirm the claim holds. Re-apply the exclusion lists. Kill anything you cannot evidence. Deduplicate across passes. Assign final severity conservatively: a blocker you are not certain of is a should-fix phrased as a question. This pass exists because candidate generation is optimized for recall and posting is optimized for precision.

Two grounding rules:

- **Reproduce when feasible.** A 🔴 from Pass A or Pass B that can be demonstrated locally gets the strongest evidence class there is: a failing test or a short script run inside the repo's own test harness (never network attacks, never outside the sandbox of the checkout). Record the command and its output as `repro` evidence. The inverse binds too: when a reproduction was feasible and failed to reproduce the claim, the finding dies, whatever your reading of the code said.
- **Low risk is not false positive.** Severity and validity are orthogonal axes. A real but minor issue is a 🟡, not a discard; killing findings because they are small is how a filter quietly stops detecting real problems. Kill for lack of evidence, downgrade for lack of impact, never conflate the two.

### Step 5: Write comments

**Read `references/comment-voice.md` now.** Write the summary and every comment body under that spec. Produce `findings.json`:

```json
{
  "language": "en",
  "round": 1,
  "carryover": {"blocker": 0, "should-fix": 0, "nit": 0, "pre-existing": 0},
  "open_human_asks": 0,
  "verdict": "REQUEST_CHANGES",
  "summary": "## Verdict\n...\n## Since the last round\n...\n## Outside the diff\n...\n## Risks\n...\n<details>\n<summary>How I verified</summary>\n\n...\n\n</details>",
  "findings": [
    {
      "id": "F1",
      "path": "src/billing/invoice.ts",
      "line": 142,
      "severity": "blocker",
      "body": "🔴 `applyDiscount` divides by `items.length` with no empty-list guard (src/billing/invoice.ts:142)...",
      "evidence": [
        {"type": "internal", "ref": "src/billing/invoice.ts:142"},
        {"type": "external", "ref": "https://official-docs.example/api#behavior"}
      ]
    }
  ]
}
```

`round` defaults to 1. `open_human_asks` is required: the count of not-done or partly-done asks from the Pass E ledger. `carryover` counts previous-round findings still unresolved, per severity (zeros in round 1); the gate uses it to compute the correct verdict when the new-findings list alone would understate open risk. `id` values are stable across rounds (F1 stays F1 forever) so the resolution ledger maps cleanly. Evidence entries accept three types: `internal` (verified `path:line`), `external` (https URL from an official source fetched this review), and `repro` (the local command that demonstrates the claim, with its observed result in the finding body).

Rules the gate enforces (write to them from the start): body starts with the severity emoji; blocker and should-fix require at least one evidence entry; external evidence must be an https URL; pre-existing findings have no `line`; the summary opens with the verdict section and keeps the audit trail in one `<details>` block.

### Step 6: Gate

```bash
python3 scripts/review_gate.py findings.json
```

Fix every reported violation and re-run until exit code 0. The gate is deterministic; arguing with it is arguing with a regex.

### Step 7: Post

Skipped in `--local` mode; see "Report locally".

```bash
python3 scripts/post_review.py findings.json
```

Posts everything as one review (single API call: summary body, verdict event, positioned inline comments), handles the own-PR fallback, prints the review URL. Inline comments only anchor on lines present in the diff; the script tells you which comment failed if GitHub rejects an anchor.

## Summary Body Template

The summary is read by the author between two other tasks. It says what blocks the merge and what is left to do; how the review was done goes in a collapsed block. Headings follow the review language (`Veredito`, `Desde a última rodada`, `Outros pontos`, `Riscos`, `Como verifiquei` in Portuguese). A section with nothing to say is omitted, never filled with "none". Inline findings are not repeated here.

```markdown
## Verdict
One or two sentences: the verdict token (APPROVE, COMMENT or REQUEST_CHANGES) verbatim and what stands between the PR and approval, or that nothing does. No recap of what the PR does: the author wrote it.

## Since the last round
Only when the PR has earlier reviews (this skill's or a human's). One line per ask or previous finding:
- ✔ <ask> (<reviewer>), fixed at `path:line`
- ↩ <ask> declined: <author's reason>; holds / does not hold, with `path:line`
- ⏳ <ask> still open

## Outside the diff
Pre-existing findings (🟣) and the nit overflow count ("N more nits not posted"). Each 🟣 as one bullet with `path:line`.

## Risks
Only the axes with something to say, one line each: security, cost (reads, writes, external calls per request), legacy parity, rollout order. A line that would only say "ok" is dropped.

<details>
<summary>How I verified</summary>

CI results (one line), scan candidate counts, Pass A answers (sibling paths, failure paths, branch matrix, consumer contract, legacy parity, with `file:line`), Pass E ask ledger, Pass G rule files, research URLs with the claim each supports, lint-rule candidates, skipped files. Condensed: bullets, no prose.

</details>
```

The gate checks that the first section is the verdict and carries the token, that the audit trail sits inside one `<details>` block, that no section is left as "none", and, in round 2+, that `Since the last round` exists.

## Convergence Contract

The Judge is decisive: it converges reviews instead of stretching them. Round 1 is exhaustive; every later round shrinks. The failure mode this contract kills is the infinite ping-pong where each round discovers a new front.

**Round N (N >= 2) scope is exactly two things:**

1. **Resolution check.** For every finding in the previous ledger, verify against the new commits: resolved (cite the fixing commit), still open, or declined by the author. Report all of them in the `Since the last round` section. This is the focus of the re-review; it is a checklist verification, not a fresh hunt.
2. **New blockers only.** The diff since the last reviewed commit is examined solely for 🔴 introduced by the fix itself. No new 🟠, no new 🟡, no new 🟣, ever. Code that was visible in round 1 and not flagged then is forfeited: the reviewer eats the miss. The single exception is a genuine 🔴 (exploitable security, data loss, money) discovered late, which is always raised, labeled factually as missed in round 1.

**Declined findings.** When the author declines with a reason, first consider that they are closer to the code and may be right; if the reasoning holds from a code-health perspective, record declined-accepted and drop it permanently. If it does not hold, re-argue once with new evidence, at most once. Still unresolved after that: mark it open, state that the disagreement moves out of the review thread, and stop re-raising. Comment threads do not resolve philosophy.

**Round cap.** By round 3, every remaining open finding is either fixed, converted to a follow-up issue by agreement, or escalated out of the thread. The Judge never runs a fourth round on the same finding set.

**Approval bar.** Approve only when nothing worth fixing is left: no open finding of any severity, no open carryover, and no open ask from a human reviewer. There is no "approve with nits": a nit worth raising is worth a COMMENT, and one not worth a COMMENT is not raised. The guard against scope creep is the bar for raising a finding, not the verdict: polish the author would not reasonably fix in this PR is killed in Step 4.

The gate enforces the mechanical half of this contract: with `"round": 2` or higher it rejects any non-blocker finding, requires the `Since the last round` section, and requires `carryover` so the verdict reflects still-open previous findings.

## Examples

### Example 1: routine review

User says: "revise esse PR" (on a branch with an open PR, 180 changed lines, TypeScript).
Actions: Steps 0-2 (research: one dep bump, checked its changelog), sequential passes, 1 should-fix + 2 nits survive verification, gate passes on second run (first run caught an exclamation mark), post as REQUEST_CHANGES.
Result: one consolidated review, three inline comments, summary whose `<details>` cites the changelog URL.

### Example 2: blocker found

User says: "judge this PR before I merge".
Actions: Pass A finds an unguarded division in a money path with a traced failing input; verification confirms at `src/billing/invoice.ts:142`; verdict REQUEST_CHANGES; PR author equals gh user, so post_review posts as COMMENT with the verdict section stating REQUEST_CHANGES and a footer explaining the fallback.
Result: review posted, blocker anchored inline with file:line evidence and the lazy fix (guard clause, three lines).

### Example 3: claims without evidence

User says: "review this PR". PR description says "fixes the race condition in the worker pool". No test touches the pool.
Actions: Pass E flags the claim; no repro or test exists; the finding becomes a 🟠 question asking for a failing-then-passing test, not an assertion that the fix is wrong.
Result: comment asks for evidence instead of speculating.

### Example 4: round 2

User says: "julgue de novo" after pushing fixes.
Actions: Step 0 finds the previous review; round 2. Resolution check maps the ledger: F1 fixed in commit `a1b2c3d`, F2 declined with a reason that holds (recorded declined-accepted), F3 still open. Diff since last review scanned for new blockers only; none found. `findings` is empty, `carryover` is `{"blocker": 1, "should-fix": 0, "nit": 0, "pre-existing": 0}` for F3, verdict REQUEST_CHANGES.
Result: a short review with only the verdict and `Since the last round`. No new comments, no new fronts, convergence preserved.

## Troubleshooting

### Error: HTTP 422 on review submission
Cause: APPROVE/REQUEST_CHANGES on your own PR, or a comment anchored to a line not in the diff.
Solution: `post_review.py` auto-falls back to COMMENT for own PRs. For anchor failures, move the comment to a changed line shown in the patch, or drop `line` and fold it into the summary.

### Error: gh not authenticated
Cause: no `gh auth login` session.
Solution: ask the user to run `gh auth status` and authenticate. Do not attempt tokenless calls.

### Error: no PR for the current branch
Cause: branch never pushed or PR not opened.
Solution: report it and stop. Opening PRs is out of scope for The Judge (that is a different job).

### Gate keeps failing on the same body
Cause: rephrasing around a banned pattern instead of removing it.
Solution: delete the sentence containing the violation. The gate output names the exact pattern and location.
