import path from "node:path";

export const VERDICTS = ["comment", "request_changes", "approve"];
export const SEVERITIES = ["critical", "major", "minor", "nit"];

export function draftFile(stateDir, { org, repo, pr }) {
  return path.join(stateDir, "reviews", `${org}-${repo}-${pr}.md`);
}

// O modelo devolve "verdict: x" + "## Resumo" + "## Achados"; a identidade do
// PR e o head_sha entram aqui, de fonte confiável, não do texto do modelo.
export function renderDraft({ org, repo, pr, title, head_sha }, modelText) {
  const text = String(modelText ?? "");
  const verdict = /^verdict:\s*(\w+)/im.exec(text)?.[1]?.toLowerCase();
  const start = text.indexOf("## Resumo");
  if (start < 0) {
    throw new Error("saída sem a seção ## Resumo");
  }
  return [
    "---",
    `org: ${org}`,
    `repo: ${repo}`,
    `pr: ${pr}`,
    `title: ${JSON.stringify(title ?? "")}`,
    `head_sha: ${head_sha}`,
    `verdict: ${verdict}`,
    "---",
    "",
    text.slice(start).trim(),
    "",
  ].join("\n");
}

export function parseDraft(text, expected) {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!front) {
    throw new Error("rascunho sem frontmatter");
  }
  const meta = {};
  for (const line of front[1].split("\n")) {
    const pair = /^(\w+):\s*(.*)$/.exec(line);
    if (pair) {
      meta[pair[1]] = pair[2].trim();
    }
  }
  meta.pr = Number(meta.pr);
  if (meta.org !== expected.org || meta.repo !== expected.repo || meta.pr !== expected.pr) {
    throw new Error(`rascunho é de ${meta.org}/${meta.repo}#${meta.pr}, esperado ${expected.org}/${expected.repo}#${expected.pr}`);
  }
  if (!VERDICTS.includes(meta.verdict)) {
    throw new Error(`verdict inválido: ${meta.verdict} (use ${VERDICTS.join(" | ")})`);
  }
  if (!/^[0-9a-f]{40}$/.test(meta.head_sha ?? "")) {
    throw new Error("head_sha ausente ou inválido");
  }

  const body = text.slice(front[0].length);
  const summary = /## Resumo\s*\n([\s\S]*?)(?=\n## Achados|$)/.exec(body)?.[1]?.trim();
  if (!summary) {
    throw new Error("## Resumo vazio ou ausente");
  }
  const block = /## Achados[\s\S]*?```json\s*\n([\s\S]*?)\n```/.exec(body);
  if (!block) {
    throw new Error("## Achados sem bloco ```json");
  }
  let findings;
  try {
    findings = JSON.parse(block[1]);
  } catch (error) {
    throw new Error(`JSON de achados inválido: ${error.message}`);
  }
  if (!Array.isArray(findings)) {
    throw new Error("achados não é um array");
  }
  findings.forEach((finding, index) => {
    const bad =
      (typeof finding?.path !== "string" || !finding.path) ? "path" :
      (!Number.isInteger(finding.line) || finding.line <= 0) ? "line" :
      !SEVERITIES.includes(finding.severity) ? "severity" :
      (typeof finding.body !== "string" || !finding.body.trim()) ? "body" :
      null;
    if (bad) {
      throw new Error(`achado ${index + 1}: ${bad} inválido`);
    }
  });
  return { meta, summary, findings };
}

export function countBySeverity(findings) {
  return SEVERITIES.map((severity) => [findings.filter((f) => f.severity === severity).length, severity])
    .filter(([count]) => count > 0)
    .map(([count, severity]) => `${count} ${severity}`)
    .join(", ") || "sem achados";
}
