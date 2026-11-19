import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { test } from "node:test";
import { countBySeverity, parseDraft, renderDraft } from "../draft.js";
import { ciGate, fetchChecks, parsePrRef, pollRequested } from "../gh.js";
import { buildReview, diffLines } from "../publish.js";
import { budgetLeft, debit, mergeRequested } from "../state.js";

const REF = { org: "acme", repo: "app", pr: 12 };
const SHA = "a".repeat(40);
const finding = (over = {}) => ({ path: "src/a.js", line: 3, severity: "major", title: "t", body: "b", ...over });
const modelText = (findings, verdict = "comment") =>
  `lixo antes\nverdict: ${verdict}\n\n## Resumo\n\nFaz X.\n\n## Achados\n\n\`\`\`json\n${JSON.stringify(findings, null, 2)}\n\`\`\`\n`;
const draft = (findings, verdict) => renderDraft({ ...REF, title: 'a "b": c', head_sha: SHA }, modelText(findings, verdict));

test("parsePrRef aceita URL e chave, e barra org fora da lista", () => {
  assert.deepEqual(parsePrRef("https://github.com/acme/app/pull/12/files?x=1"), { ...REF, key: "acme/app#12" });
  assert.equal(parsePrRef("acme/app#12").key, "acme/app#12");
  assert.equal(parsePrRef("https://github.com/evil/app/pull/12", ["acme"]), null);
  assert.equal(parsePrRef("nada"), null);
});

test("pollRequested filtra por org, ignora draft e monta a chave", () => {
  let seen;
  const run = (bin, args) => {
    seen = args;
    return JSON.stringify([
      { number: 1, isDraft: true, repository: { nameWithOwner: "acme/app" }, title: "wip", url: "u1", author: { login: "x" } },
      { number: 2, isDraft: false, repository: { nameWithOwner: "acme/api" }, title: "ok", url: "u2", author: { login: "y" } },
    ]);
  };
  const prs = pollRequested({ run, config: { ghBin: "gh", allowedOrgs: ["acme", "acme-labs"] } });
  assert.deepEqual(prs, [{ key: "acme/api#2", url: "u2", title: "ok", author: "y" }]);
  assert.equal(seen.filter((a) => a === "--owner").length, 2);
});

test("rascunho: render + parse fazem o caminho de ida e volta", () => {
  const parsed = parseDraft(draft([finding(), finding({ severity: "nit" })]), REF);
  assert.equal(parsed.meta.verdict, "comment");
  assert.equal(parsed.meta.head_sha, SHA);
  assert.equal(parsed.summary, "Faz X.");
  assert.equal(parsed.findings.length, 2);
  assert.equal(countBySeverity(parsed.findings), "1 major, 1 nit");
  assert.equal(parseDraft(draft([]), REF).findings.length, 0);
});

test("rascunho inválido é recusado com o motivo", () => {
  assert.throws(() => renderDraft({ ...REF, head_sha: SHA }, "sem seções"), /Resumo/);
  assert.throws(() => parseDraft(draft([], "talvez"), REF), /verdict/);
  assert.throws(() => parseDraft(draft([]), { ...REF, pr: 13 }), /esperado/);
  assert.throws(() => parseDraft(draft([finding({ line: 0 })]), REF), /line/);
  assert.throws(() => parseDraft(draft([finding({ severity: "blocker" })]), REF), /severity/);
  assert.throws(() => parseDraft(draft([finding({ body: " " })]), REF), /body/);
  assert.throws(() => parseDraft(draft([]).replace(/```json[\s\S]*```/, "```json\n{oops\n```"), REF), /JSON/);
});

const DIFF = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -1,3 +1,4 @@
 um
-dois
+++ b/falso.js
+tres
 quatro
\\ No newline at end of file
diff --git a/gone.js b/gone.js
--- a/gone.js
+++ /dev/null
@@ -1 +0,0 @@
-x
diff --git a/novo.js b/novo.js
--- /dev/null
+++ b/novo.js
@@ -0,0 +1 @@
+y
`;

test("diffLines mapeia as linhas comentáveis do lado novo", () => {
  const lines = diffLines(DIFF);
  assert.deepEqual([...lines.keys()], ["src/a.js", "novo.js"]);
  assert.deepEqual([...lines.get("src/a.js")], [1, 2, 3, 4]);
  assert.deepEqual([...lines.get("novo.js")], [1]);
});

test("buildReview separa achado fora do diff e recusa approve com major", () => {
  const parsed = parseDraft(draft([finding(), finding({ line: 99, title: "longe" })]), REF);
  const review = buildReview(parsed, diffLines(DIFF));
  assert.equal(review.event, "COMMENT");
  assert.equal(review.commit_id, SHA);
  assert.deepEqual(review.comments, [{ path: "src/a.js", line: 3, side: "RIGHT", body: "**major** t\n\nb" }]);
  assert.match(review.body, /^Faz X\.\n\n## Fora do diff\n\n`src\/a\.js:99` — \*\*major\*\* longe/);

  const verbatim = buildReview(parseDraft(draft([finding({ title: undefined, body: "🟠 corpo" })]), REF), diffLines(DIFF));
  assert.equal(verbatim.comments[0].body, "🟠 corpo");

  const approve = parseDraft(draft([finding()], "approve"), REF);
  assert.throws(() => buildReview(approve, diffLines(DIFF)), /approve/);
  assert.equal(buildReview(approve, diffLines(DIFF), { force: true }).event, "APPROVE");
  assert.throws(() => buildReview(parseDraft(draft([finding({ severity: "nit" })], "approve"), REF), diffLines(DIFF)), /approve/);
  assert.equal(buildReview(parseDraft(draft([], "approve"), REF), diffLines(DIFF)).event, "APPROVE");
});

test("gate do the-judge: approve só sem achado, carryover nem pedido humano aberto", () => {
  const gate = (findings, verdict, extra = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
    const file = path.join(dir, "findings.json");
    const summary = `## TL;DR\n${verdict}.\n## Promote to lint rule\nnone`;
    fs.writeFileSync(file, JSON.stringify({ verdict, summary, findings, open_human_asks: 0, ...extra }));
    const out = spawnSync("python3", [fileURLToPath(new URL("../skills/the-judge/scripts/review_gate.py", import.meta.url)), file], { encoding: "utf8" });
    return out.stdout;
  };
  const nit = { path: "a.js", line: 1, severity: "nit", body: "🟡 Nome confuso em a.js:1." };
  const pre = { path: "a.js", severity: "pre-existing", body: "🟣 Bug antigo em a.js:9." };
  const major = { ...nit, severity: "should-fix", body: "🟠 Erro em a.js:1.", evidence: [{ type: "internal", ref: "a.js:1" }] };

  assert.match(gate([], "APPROVE"), /PASS/);
  assert.match(gate([nit], "APPROVE"), /expected 'COMMENT'/);
  assert.match(gate([pre], "COMMENT"), /PASS/);
  assert.match(gate([major, nit], "COMMENT"), /expected 'REQUEST_CHANGES'/);
  assert.match(gate([], "APPROVE", { open_human_asks: 2 }), /expected 'COMMENT'/);
  assert.match(gate([], "APPROVE", { round: 2, carryover: { nit: 1 }, summary: "## TL;DR\nAPPROVE\n## Resolution\nx\n## Promote to lint rule\nnone" }), /expected 'COMMENT'/);
  assert.match(gate([], "APPROVE", { open_human_asks: undefined }), /open_human_asks/);
});

test("orçamento diário debita até o teto e zera na virada do dia", () => {
  const data = { budget: { day: null, used: 0 } };
  assert.equal(debit(data, "2026-11-16", 2), true);
  assert.equal(debit(data, "2026-11-16", 2), true);
  assert.equal(debit(data, "2026-11-16", 2), false);
  assert.equal(budgetLeft(data, "2026-11-17", 2), 2);
  assert.equal(debit(data, "2026-11-17", 2), true);
  assert.equal(data.budget.used, 1);
});

test("publicado volta para a fila só quando some da busca e reaparece", () => {
  const pr = (n) => ({ key: `o/r#${n}`, title: `t${n}` });
  const data = { items: {}, seeded: false };
  mergeRequested(data, [pr(1)], "t0");
  assert.equal(data.items["o/r#1"].status, "skipped");

  assert.deepEqual(mergeRequested(data, [pr(1), pr(2)], "t1"), [pr(2)]);
  data.items["o/r#2"].status = "published";
  data.items["o/r#2"].staleRequeues = 2;

  assert.deepEqual(mergeRequested(data, [pr(1), pr(2)], "t2"), [], "pedido a time que segue na busca não revisa em loop");
  assert.deepEqual(mergeRequested(data, [pr(1)], "t3"), []);
  assert.deepEqual(mergeRequested(data, [pr(1), pr(2)], "t4"), [pr(2)]);
  assert.equal(data.items["o/r#2"].status, "queued");
  assert.equal(data.items["o/r#2"].staleRequeues, 0);
  assert.equal(data.items["o/r#1"].status, "skipped");

  data.items["o/r#2"].status = "published";
  assert.deepEqual(mergeRequested(data, [pr(1), pr(2)], "t5"), [], "o gatilho desarma depois de usado");
});

test("skill e prompt relativos resolvem a partir do repo, não do cwd", () => {
  const root = path.dirname(fileURLToPath(new URL("../config.js", import.meta.url)));
  const config = loadConfig({ SKILL_DIR: "./skills/outra", REVIEW_PROMPT: "prompts/outra.md" });
  assert.equal(config.skillDir, path.join(root, "skills/outra"));
  assert.equal(config.promptFile, path.join(root, "prompts/outra.md"));
  assert.equal(loadConfig({}).skillDir, path.join(root, "skills/the-judge"));
});

test("ciGate espera CI pendente, revisa quando termina e desiste no teto", () => {
  const at = (min) => new Date(Date.parse("2026-11-19T10:00:00Z") + min * 60_000).toISOString();
  const pass = { bucket: "pass" };
  const fail = { bucket: "fail" };
  const pending = { bucket: "pending" };
  const since = at(0);

  assert.equal(ciGate([pass, fail], null, at(0), 45).decision, "ready");
  assert.equal(ciGate([pass, pending], null, at(0), 45).decision, "wait");
  assert.equal(ciGate([pass, pending], since, at(44), 45).decision, "wait");
  assert.deepEqual(ciGate([pass, pending], since, at(45), 45), { decision: "timeout", pending: 1, waitedMin: 45 });
  assert.equal(ciGate([], null, at(0), 45).decision, "wait", "push recém-feito ainda sem checks");
  assert.equal(ciGate([], since, at(5), 45).decision, "timeout", "repo sem CI revisa depois da carência");
});

test("fetchChecks trata erro do gh como nenhum check", () => {
  const config = { ghBin: "gh" };
  assert.deepEqual(fetchChecks({ config, slug: "o/r", pr: 1, run: () => '[{"bucket":"pass"}]' }), [{ bucket: "pass" }]);
  assert.deepEqual(fetchChecks({ config, slug: "o/r", pr: 1, run: () => { throw new Error("no checks reported"); } }), []);
});
