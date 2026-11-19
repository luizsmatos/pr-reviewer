import fs from "node:fs";
import path from "node:path";
import { runClaude } from "./cli-output.js";
import { countBySeverity, draftFile, parseDraft, renderDraft } from "./draft.js";
import { parsePrRef } from "./gh.js";

// O PR é texto de terceiros com um agent lendo: nada de git/gh amplos (o clone
// tem origin e credencial de push) e nada de rodar código do PR (lint, testes).
// Escrita só no scratch do findings.json que o gate do the-judge exige.
export function allowedTools(scratch, skillDir) {
  return [
    "Read",
    "Grep",
    "Glob",
    "Agent",
    "WebSearch",
    "mcp__context7",
    "mcp__plugin_context7_context7",
    `Write(/${scratch}/**)`,
    `Edit(/${scratch}/**)`,
    `Bash(python3 ${skillDir}/scripts/*)`,
    `Bash(${skillDir}/scripts/*)`,
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(git blame:*)",
    "Bash(git status:*)",
    "Bash(git grep:*)",
    "Bash(git merge-base:*)",
    "Bash(git ls-files:*)",
    "Bash(gh pr view:*)",
    "Bash(gh pr diff:*)",
    "Bash(gh pr checks:*)",
    "Bash(gh run view:*)",
  ];
}

// O agent não tem `gh api` (aceitaria -X POST pelo mesmo prefixo): as reviews e
// as threads vêm pré-baixadas, em JSONL, para o Pass E ler com Read.
const THREADS = {
  "reviews.jsonl": ["pulls", "reviews", "{user: .user.login, state, submitted_at, commit_id, body}"],
  "inline-comments.jsonl": ["pulls", "comments", "{id, in_reply_to_id, user: .user.login, created_at, path, line, body}"],
  "issue-comments.jsonl": ["issues", "comments", "{user: .user.login, created_at, body}"],
};

export function fetchThreads({ run, ghBin, slug, pr, scratch }) {
  const missing = [];
  for (const [file, [kind, sub, fields]] of Object.entries(THREADS)) {
    const target = path.join(scratch, file);
    try {
      const out = run(ghBin, ["api", "--paginate", `repos/${slug}/${kind}/${pr}/${sub}`, "--jq", `.[] | ${fields}`]);
      fs.writeFileSync(target, out);
    } catch {
      fs.rmSync(target, { force: true });
      missing.push(file);
    }
  }
  return missing;
}

export function renderPrompt(vars, template) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ""));
}

export function createReviewer({ config, run, debit, claude = runClaude }) {
  const template = fs.readFileSync(config.promptFile, "utf8");
  const git = (cwd, ...args) => run("git", args, { cwd });
  let me;
  const ghLogin = () => (me ??= run(config.ghBin, ["api", "user", "--jq", ".login"]).trim());

  return async function review(key) {
    const ref = parsePrRef(key);
    const { org, repo, pr } = ref;
    const slug = `${org}/${repo}`;
    const info = JSON.parse(run(config.ghBin, ["pr", "view", String(pr), "-R", slug, "--json", "state,isDraft,title,author,baseRefName"]));
    const item = { title: info.title, author: info.author?.login ?? null, error: null };
    if (info.state !== "OPEN" || info.isDraft) {
      return { ...item, status: "skipped", error: info.isDraft ? "draft" : info.state.toLowerCase() };
    }

    const clone = path.join(config.stateDir, "repos", org, repo);
    if (!fs.existsSync(clone)) {
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      run(config.ghBin, ["repo", "clone", slug, clone, "--", "--filter=blob:none"]);
    }
    const base = info.baseRefName;
    git(clone, "fetch", "origin", `+pull/${pr}/head:refs/pr/${pr}`, `+refs/heads/${base}:refs/remotes/origin/${base}`);
    item.head_sha = git(clone, "rev-parse", `refs/pr/${pr}`).trim();

    const work = path.join(config.stateDir, "work", `${org}-${repo}-${pr}`);
    const removeWorktree = () => {
      try {
        git(clone, "worktree", "remove", "--force", work);
      } catch {
        // não havia worktree
      }
    };
    git(clone, "worktree", "prune");
    removeWorktree();
    git(clone, "worktree", "add", "--detach", work, `refs/pr/${pr}`);

    const file = draftFile(config.stateDir, ref);
    const scratch = path.join(config.stateDir, "tmp", `${org}-${repo}-${pr}`);
    fs.mkdirSync(scratch, { recursive: true });
    const missing = fetchThreads({ run, ghBin: config.ghBin, slug, pr, scratch });
    const threads = missing.length ? `não baixados: ${missing.join(", ")}` : "todos baixados";
    try {
      let failure;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (!debit()) {
          throw new Error("orçamento diário esgotado");
        }
        const out = await claude({
          bin: config.claudeBin,
          args: [
            "-p",
            renderPrompt({ org, repo, pr, title: info.title, base, scratch, skillDir: config.skillDir, me: ghLogin(), threads }, template),
            "--allowedTools",
            ...allowedTools(scratch, config.skillDir),
            "--model",
            config.claudeModel,
            "--output-format",
            "json",
          ],
          cwd: work,
          timeoutMs: config.reviewTimeoutMin * 60_000,
        });
        item.usage = out.usage;
        if (out.timedOut) {
          failure = `timeout de ${config.reviewTimeoutMin} min`;
          break;
        }
        try {
          if (!out.ok) {
            throw new Error(`claude saiu com código ${out.code}: ${out.stderr.slice(-300)}`);
          }
          const draft = renderDraft({ ...ref, title: info.title, head_sha: item.head_sha }, out.stdout);
          const { meta, findings } = parseDraft(draft, ref);
          fs.writeFileSync(file, draft);
          return { ...item, status: "drafted", verdict: meta.verdict, findings: countBySeverity(findings) };
        } catch (error) {
          failure = error.message;
          fs.writeFileSync(file.replace(/\.md$/, ".raw.md"), `${out.stdout}\n\n--- stderr ---\n${out.stderr.slice(-2000)}\n`);
        }
      }
      return { ...item, status: "failed", error: failure };
    } finally {
      removeWorktree();
    }
  };
}
