#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { formatUsage } from "./cli-output.js";
import { loadConfig } from "./config.js";
import { draftFile } from "./draft.js";
import { parsePrRef, pollRequested, run } from "./gh.js";
import { publish } from "./publish.js";
import { createReviewer } from "./review.js";
import { budgetLeft, createState, debit, mergeRequested } from "./state.js";

const config = loadConfig();
fs.mkdirSync(path.join(config.stateDir, "reviews"), { recursive: true });
const state = createState(config.stateDir);

const log = (...parts) => console.log(new Date().toISOString(), ...parts);
const nowIso = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString("sv");
const firstLine = (error) => String(error?.stderr || error?.message || error).trim().split("\n")[0];

function notify(message) {
  const safe = String(message).replaceAll('"', "'").slice(0, 200);
  execFile("osascript", ["-e", `display notification "${safe}" with title "pr-reviewer" sound name "Ping"`], () => {});
}

function requireRef(arg) {
  const ref = parsePrRef(arg, config.allowedOrgs);
  if (!ref) {
    throw new Error(`PR inválido ou fora de ALLOWED_ORGS: ${arg ?? "(vazio)"}`);
  }
  return ref;
}

// Na primeira execução o que já estava pedindo review vira skipped: o daemon
// só revisa o que chegar depois; o backlog entra com `review <url>`.
function enqueueRequested() {
  const prs = pollRequested({ config });
  for (const pr of state.update((data) => mergeRequested(data, prs, nowIso()))) {
    log(`enfileirado ${pr.key} — ${pr.title}`);
  }
}

const MAX_STALE_REQUEUES = 2;

// Push depois do review reenfileira, até MAX_STALE_REQUEUES vezes por PR: um PR
// em push contínuo não pode gastar o orçamento do dia nem travar a fila. As outras
// recusas (approve com achado grave, PR seu) deixam o item drafted com o
// motivo; aí só o `publish` manual resolve.
function autoPublish(key) {
  // Marcado antes do POST: se o processo morrer entre o POST e a gravação do
  // estado, o item fica `publishing` e não é republicado na subida (dev#9962
  // saiu com dois reviews assim).
  state.update((data) => {
    data.items[key].status = "publishing";
  });
  try {
    const url = publish({ config, run, state, ref: key });
    log(`${key}: publicado — ${url}`);
    return "publicado";
  } catch (error) {
    state.update((data) => {
      data.items[key].status = "drafted";
    });
    const requeued = error.stale && state.update((data) => {
      const { [key]: item, ...others } = data.items;
      if ((item.staleRequeues ?? 0) >= MAX_STALE_REQUEUES) {
        return false;
      }
      // reinserido no fim: a fila segue a ordem das chaves e os outros PRs passam na frente
      data.items = { ...others, [key]: { ...item, status: "queued", queuedAt: nowIso(), staleRequeues: (item.staleRequeues ?? 0) + 1 } };
      return true;
    });
    if (requeued) {
      log(`${key}: recebeu push depois do review — reenfileirado`);
      return "reenfileirado (push depois do review)";
    }
    const reason = firstLine(error).slice(0, 500);
    state.update((data) => {
      data.items[key].error = `não publicado: ${reason}`;
    });
    log(`${key}: não publicado — ${reason}`);
    return `NÃO publicado (${reason})`;
  }
}

async function drain(review) {
  for (;;) {
    const key = state.update((data) => {
      if (budgetLeft(data, today(), config.maxPerDay) <= 0) {
        return null;
      }
      const next = Object.keys(data.items).find((k) => data.items[k].status === "queued");
      if (next) {
        data.items[next].status = "reviewing";
      }
      return next ?? null;
    });
    if (!key) {
      return;
    }
    log(`revisando ${key}`);
    const result = await review(key).catch((error) => ({ status: "failed", error: firstLine(error).slice(0, 500) }));
    state.update((data) => Object.assign(data.items[key], result, { reviewedAt: nowIso() }));
    const detail = result.status === "drafted" ? result.findings : result.error;
    log(`${key}: ${result.status} — ${detail}`);
    if (result.status === "drafted") {
      notify(`${key}: ${autoPublish(key)} — ${result.verdict}, ${detail} — ${result.title ?? ""}`);
    } else if (result.status !== "skipped") {
      notify(`${key}: ${result.status} — ${detail} — ${result.title ?? ""}`);
    }
  }
}

async function daemon() {
  requireOrgs();
  state.update((data) => {
    for (const item of Object.values(data.items)) {
      if (item.status === "reviewing") {
        item.status = "queued";
      }
    }
  });
  for (const [key, item] of Object.entries(state.read().items)) {
    if (item.status === "drafted" && !item.error) {
      autoPublish(key);
    }
  }
  const review = createReviewer({ config, run, debit: () => state.update((data) => debit(data, today(), config.maxPerDay)) });
  log(`pr-reviewer no ar — orgs ${config.allowedOrgs.join(", ")}, polling a cada ${config.pollIntervalS}s, estado em ${config.stateDir}`);
  for (;;) {
    try {
      enqueueRequested();
    } catch (error) {
      log(`polling falhou: ${firstLine(error)}`);
    }
    await drain(review);
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalS * 1000));
  }
}

function status() {
  const data = state.read();
  console.log(`orçamento de hoje: ${budgetLeft(data, today(), config.maxPerDay)}/${config.maxPerDay} livres`);
  const entries = Object.entries(data.items);
  if (entries.length === 0) {
    console.log("nenhum PR visto ainda");
  }
  for (const [key, item] of entries) {
    const extra =
      item.status === "drafted" ? `${item.verdict}, ${item.findings} → ${draftFile(config.stateDir, parsePrRef(key))}${item.error ? `\n           ${item.error}` : ""}` :
      item.status === "published" ? item.reviewUrl :
      item.status === "publishing" ? "interrompido no meio da publicação — confira o PR no GitHub antes de rodar publish" :
      item.error ?? "";
    console.log(`${item.status.padEnd(10)} ${key} — ${item.title ?? ""}${extra ? `\n           ${extra}` : ""}${item.usage ? `\n           ${formatUsage(item.usage)}` : ""}`);
  }
}

function setStatus(arg, status, extra = {}) {
  const { key } = requireRef(arg);
  state.update((data) => {
    data.items[key] = { ...data.items[key], status, error: null, ...extra };
  });
  console.log(`${key}: ${status}`);
}

function requireOrgs() {
  if (config.allowedOrgs.length === 0) {
    throw new Error("defina ALLOWED_ORGS no .env (ex.: ALLOWED_ORGS=minha-org)");
  }
  return config.allowedOrgs;
}

function doctor() {
  const checks = [
    ["orgs", () => requireOrgs().join(", ")],
    ["claude", () => run(config.claudeBin, ["--version"]).trim()],
    ["skill", () => (fs.statSync(path.join(config.skillDir, "SKILL.md")), config.skillDir)],
    ["prompt", () => (fs.statSync(config.promptFile), config.promptFile)],
    ["gh", () => `logado como ${run(config.ghBin, ["api", "user", "--jq", ".login"]).trim()}`],
    ["busca de PRs", () => `${pollRequested({ config }).length} PR(s) pedindo seu review`],
    ["disco", () => {
      const stat = fs.statfsSync(config.stateDir);
      const freeGb = (stat.bavail * stat.bsize) / 1e9;
      if (freeGb < 5) {
        throw new Error(`só ${freeGb.toFixed(1)} GB livres em ${config.stateDir}`);
      }
      return `${freeGb.toFixed(0)} GB livres`;
    }],
  ];
  let failed = false;
  for (const [name, check] of checks) {
    try {
      console.log(`ok    ${name}: ${check()}`);
    } catch (error) {
      failed = true;
      console.log(`FALHA ${name}: ${firstLine(error)}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

const [command, arg, ...rest] = process.argv.slice(2);
const commands = {
  status,
  doctor,
  review: () => setStatus(arg, "queued", { url: arg, queuedAt: nowIso(), staleRequeues: 0 }),
  retry: () => setStatus(arg, "queued", { queuedAt: nowIso(), staleRequeues: 0 }),
  skip: () => setStatus(arg, "skipped"),
  publish: () => console.log(`publicado: ${publish({ config, run, state, ref: arg, force: rest.includes("--force") })}`),
};

try {
  if (command === undefined) {
    await daemon();
  } else if (Object.hasOwn(commands, command)) {
    commands[command]();
  } else {
    console.error(`comando desconhecido: ${command}\nuso: pr-reviewer [status | review <url> | publish <org>/<repo>#<n> [--force] | skip <pr> | retry <pr> | doctor]`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(firstLine(error));
  process.exitCode = 1;
}
