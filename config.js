import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

try {
  process.loadEnvFile(new URL(".env", import.meta.url));
} catch {
  // .env é opcional
}

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadConfig(env = process.env) {
  return {
    allowedOrgs: (env.ALLOWED_ORGS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    pollIntervalS: Number(env.POLL_INTERVAL_S || 90),
    claudeBin: env.CLAUDE_BIN || "claude",
    claudeModel: env.CLAUDE_MODEL || "claude-opus-5-5",
    reviewTimeoutMin: Number(env.REVIEW_TIMEOUT_MIN || 30),
    maxPerDay: Number(env.MAX_PER_DAY || Infinity),
    checksMaxWaitMin: Number(env.CHECKS_MAX_WAIT_MIN || 45),
    ghBin: env.GH_BIN || "gh",
    stateDir: expandHome(env.STATE_DIR || "~/.pr-reviewer"),
    skillDir: path.resolve(ROOT, expandHome(env.SKILL_DIR || "skills/the-judge")),
    promptFile: path.resolve(ROOT, expandHome(env.REVIEW_PROMPT || "prompts/review.md")),
  };
}
