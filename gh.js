import { execFileSync } from "node:child_process";

export function run(bin, args, options = {}) {
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...options });
}

const REF_RE = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/pull\/|#)(\d+)/;

export function parsePrRef(ref, allowedOrgs) {
  const match = REF_RE.exec(String(ref ?? "").trim());
  if (!match || (allowedOrgs && !allowedOrgs.includes(match[1]))) {
    return null;
  }
  const [, org, repo, pr] = match;
  return { org, repo, pr: Number(pr), key: `${org}/${repo}#${pr}` };
}

// review-requested:@me cobre pedido direto e pedido a um time seu.
export function pollRequested({ run: exec = run, config }) {
  const out = exec(config.ghBin, [
    "search",
    "prs",
    "--review-requested=@me",
    "--state=open",
    ...config.allowedOrgs.flatMap((org) => ["--owner", org]),
    "--json",
    "number,repository,title,url,author,isDraft",
    "--limit",
    "100",
  ]);
  return JSON.parse(out)
    .filter((pr) => !pr.isDraft)
    .map((pr) => ({
      key: `${pr.repository.nameWithOwner}#${pr.number}`,
      url: pr.url,
      title: pr.title,
      author: pr.author?.login ?? null,
    }));
}

// Sem checks (ou gh falhando) vira lista vazia: o ciGate espera a carência e revisa.
export function fetchChecks({ run: exec = run, config, slug, pr }) {
  try {
    return JSON.parse(exec(config.ghBin, ["pr", "checks", String(pr), "-R", slug, "--json", "bucket"]));
  } catch {
    return [];
  }
}

const NO_CHECKS_GRACE_MIN = 5;

// ready: CI terminou (passou ou falhou); wait: algo pendente ou nenhum check
// apareceu ainda depois do push; timeout: esperou demais, revisa assim mesmo.
export function ciGate(checks, waitingSince, now, maxWaitMin) {
  const waitedMin = waitingSince ? (Date.parse(now) - Date.parse(waitingSince)) / 60_000 : 0;
  const pending = checks.filter((c) => c.bucket === "pending").length;
  if (checks.length > 0 && pending === 0) {
    return { decision: "ready", pending, waitedMin };
  }
  if (waitedMin >= maxWaitMin || (checks.length === 0 && waitedMin >= NO_CHECKS_GRACE_MIN)) {
    return { decision: "timeout", pending, waitedMin };
  }
  return { decision: "wait", pending, waitedMin };
}
