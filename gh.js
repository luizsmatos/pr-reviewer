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
