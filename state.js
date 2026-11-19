import fs from "node:fs";
import path from "node:path";

// shortcut: sem lock entre o daemon e a CLI — cada update relê o arquivo e
// grava de forma síncrona, a janela de corrida é de microssegundos; trocar por
// lock O_EXCL se um comando da CLI algum dia sumir do state.
export function createState(stateDir) {
  const file = path.join(stateDir, "state.json");
  fs.mkdirSync(stateDir, { recursive: true });

  function read() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`state.json ilegível (${file}): ${error.message}`);
      }
    }
    return { items: {}, budget: { day: null, used: 0 }, seeded: false, ...saved };
  }

  function update(mutate) {
    const data = read();
    const result = mutate(data);
    fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2));
    fs.renameSync(file + ".tmp", file);
    return result;
  }

  return { read, update };
}

// Publicado que some da busca e volta = novo pedido de review. Pedido a um time
// que não sai da busca nunca arma, e não revisa em loop.
// shortcut: re-pedido feito antes de um polling ver o PR fora da busca passa
// batido; ler o timeline (review_requested) se isso acontecer na prática.
export function mergeRequested(data, prs, now) {
  const enqueued = [];
  const requested = new Set(prs.map((pr) => pr.key));
  for (const [key, item] of Object.entries(data.items)) {
    if (item.status === "published" && !requested.has(key)) {
      item.rerequestArmed = true;
    }
  }
  for (const pr of prs) {
    const item = data.items[pr.key];
    if (item?.status === "published" && item.rerequestArmed) {
      data.items[pr.key] = { ...item, ...pr, status: "queued", queuedAt: now, staleRequeues: 0, rerequestArmed: false };
      enqueued.push(pr);
    } else if (!item) {
      data.items[pr.key] = data.seeded
        ? { ...pr, status: "queued", queuedAt: now }
        : { ...pr, status: "skipped", error: "já pedia review na primeira execução" };
      if (data.seeded) {
        enqueued.push(pr);
      }
    }
  }
  data.seeded = true;
  return enqueued;
}

export function budgetLeft(data, day, maxPerDay) {
  return data.budget.day === day ? maxPerDay - data.budget.used : maxPerDay;
}

export function debit(data, day, maxPerDay) {
  if (budgetLeft(data, day, maxPerDay) <= 0) {
    return false;
  }
  data.budget = { day, used: data.budget.day === day ? data.budget.used + 1 : 1 };
  return true;
}
