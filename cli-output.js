import { spawn } from "node:child_process";

// Roda o claude headless e devolve { ok, code, stdout, stderr, timedOut, usage },
// com o envelope JSON já desfeito. Nunca rejeita: falha vira ok=false.
// stdio[0] = "ignore": sem isso o pipe de stdin fica aberto e nunca é
// escrito, e o CLI queima 3s esperando por ele em toda invocação.
export function runClaude({ bin, args, cwd, env, timeoutMs, spawnFn = spawn }) {
  return new Promise((resolve) => {
    const child = spawnFn(bin, args, { cwd, ...(env ? { env } : {}), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      const { text, usage } = parseCliOutput(stdout);
      resolve({ ok: false, code: null, stdout: text, stderr: stderr + String(error?.message ?? error), timedOut, usage });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const { text, usage } = parseCliOutput(stdout);
      resolve({ ok: code === 0 && !timedOut, code, stdout: text, stderr, timedOut, usage });
    });
  });
}

export function parseCliOutput(raw) {
  const fallback = { text: raw, usage: null };
  const parsed = findEnvelope(String(raw ?? ""));
  if (!parsed) {
    return fallback;
  }
  const u = parsed.usage ?? {};
  const models = Object.keys(parsed.modelUsage ?? {});
  return {
    text: String(parsed.result ?? ""),
    usage: {
      inputTokens: u.input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      costUsd: parsed.total_cost_usd ?? null,
      model: models.length > 0 ? models[0] : null,
      numTurns: parsed.num_turns ?? null,
      durationMs: parsed.duration_ms ?? null,
      // sessões de -p não aparecem no /resume; o id é o único caminho de volta
      sessionId: parsed.session_id ?? null,
    },
  };
}

function findEnvelope(raw) {
  for (const candidate of [raw.trim(), ...raw.split("\n").map((l) => l.trim())]) {
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && parsed.type === "result") {
        return parsed;
      }
    } catch {
      // linha que não é o envelope; segue para a próxima
    }
  }
  return null;
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatUsage(usage) {
  if (!usage) {
    return "";
  }
  const totalIn = (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  const parts = [`${fmtTokens(totalIn)} in`, `${fmtTokens(usage.outputTokens ?? 0)} out`];
  if (usage.costUsd != null) {
    parts.push(`$${usage.costUsd.toFixed(2)}`);
  }
  if (usage.model) {
    parts.push(usage.model);
  }
  if (usage.sessionId) {
    parts.push(`session ${usage.sessionId}`);
  }
  return parts.join(" / ");
}
