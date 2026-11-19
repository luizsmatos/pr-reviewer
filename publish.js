import fs from "node:fs";
import { draftFile, parseDraft } from "./draft.js";
import { parsePrRef } from "./gh.js";

const EVENTS = { comment: "COMMENT", request_changes: "REQUEST_CHANGES", approve: "APPROVE" };

// path → linhas do lado novo que o GitHub aceita comentar (adicionadas + contexto).
// Conta as linhas de cada hunk pelo cabeçalho: conteúdo que parece "+++ b/x" não engana.
export function diffLines(diffText) {
  const lines = new Map();
  let current = null;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const row of String(diffText).split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (row.startsWith("+")) {
        current?.add(line);
        line += 1;
        newLeft -= 1;
      } else if (row.startsWith("-")) {
        oldLeft -= 1;
      } else if (!row.startsWith("\\")) {
        current?.add(line);
        line += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      line = Number(hunk[2]);
      newLeft = Number(hunk[3] ?? 1);
    } else if (row.startsWith("+++ ")) {
      current = null;
      if (row.startsWith("+++ b/")) {
        current = new Set();
        lines.set(row.slice(6), current);
      }
    }
  }
  return lines;
}

function comment(finding) {
  return finding.title ? `**${finding.severity}** ${finding.title}\n\n${finding.body}` : finding.body;
}

export function buildReview({ meta, summary, findings }, lines, { force = false } = {}) {
  if (meta.verdict === "approve" && !force && findings.length > 0) {
    throw new Error("verdict approve com achados — approve não leva comentário; ajuste o rascunho ou use --force");
  }
  const inDiff = (f) => lines.get(f.path)?.has(f.line);
  const outside = findings.filter((f) => !inDiff(f));
  let body = summary;
  if (outside.length > 0) {
    body += `\n\n## Fora do diff\n\n${outside.map((f) => `\`${f.path}:${f.line}\` — ${comment(f)}`).join("\n\n")}`;
  }
  return {
    commit_id: meta.head_sha,
    event: EVENTS[meta.verdict],
    body,
    comments: findings.filter(inDiff).map((f) => ({ path: f.path, line: f.line, side: "RIGHT", body: comment(f) })),
  };
}

export function publish({ config, run, state, ref, force = false, now = () => new Date().toISOString() }) {
  const parsed = parsePrRef(ref, config.allowedOrgs);
  if (!parsed) {
    throw new Error(`PR inválido ou fora de ALLOWED_ORGS: ${ref}`);
  }
  const { org, repo, pr, key } = parsed;
  const slug = `${org}/${repo}`;
  const gh = (...args) => run(config.ghBin, args);
  const draft = parseDraft(fs.readFileSync(draftFile(config.stateDir, parsed), "utf8"), parsed);

  const info = JSON.parse(gh("pr", "view", String(pr), "-R", slug, "--json", "headRefOid,baseRefName,author"));
  if (info.author?.login === gh("api", "user", "--jq", ".login").trim()) {
    throw new Error("PR seu: o review fica no rascunho, não vai para o GitHub");
  }
  if (info.headRefOid !== draft.meta.head_sha && !force) {
    const message = `o PR recebeu push depois do review (${draft.meta.head_sha.slice(0, 7)} → ${info.headRefOid.slice(0, 7)}) — rode review de novo ou use --force`;
    throw Object.assign(new Error(message), { stale: true });
  }
  const diff = gh("api", `repos/${slug}/compare/${info.baseRefName}...${draft.meta.head_sha}`, "-H", "Accept: application/vnd.github.diff");
  const payload = buildReview(draft, diffLines(diff), { force });
  const posted = JSON.parse(
    run(config.ghBin, ["api", `repos/${slug}/pulls/${pr}/reviews`, "--method", "POST", "--input", "-"], { input: JSON.stringify(payload) }),
  );
  state.update((data) => {
    data.items[key] = { ...data.items[key], status: "published", reviewUrl: posted.html_url, publishedAt: now(), error: null };
  });
  return posted.html_url;
}
