// Локальный «бэкенд» SpendTrack. Раньше эти ответы отдавал FastAPI; теперь всё
// считается на устройстве из IndexedDB, а формат ответов сохранён — поэтому
// app.js почти не изменился: вместо fetch('/api/...') он зовёт localApi().
"use strict";

const LocalAPI = (() => {
  const VERSION = "3.0.0";
  const SESSION = { authed: false };

  class HTTPError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

  // --- PIN: храним хэш, не сам код ---
  async function hashPin(pin) {
    if (window.crypto && crypto.subtle) {
      try {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("st:" + pin));
        return "s2:" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      } catch (e) { /* недоступно (например, file://) — падаем на запасной */ }
    }
    let h = "st:" + pin;
    for (let i = 0; i < 5000; i++) h = Core.hash16(h);
    return "h:" + h;
  }

  async function pinIsSet() { return !!(await Store.getSetting("pin_hash")); }

  // --- представление записи (порт web.app.row_to_dict) ---
  function rowToDict(r) {
    const created = String(r.created_at || "");
    const [datePart, timePart] = created.split("T");
    return {
      id: r.id, amount: r.amount, currency: r.currency, category: r.category,
      kind: r.kind, note: r.note || "", place: r.place || "—",
      created_at: created, date: datePart || "", time: timePart ? timePart.slice(0, 5) : "",
    };
  }

  async function defaultCurrency() { return (await Store.getSetting("currency")) || Core.DEFAULT_CURRENCY; }

  async function categoriesList() {
    const custom = (await Store.getSetting("categories_custom")) || [];
    return Core.categoryNames().concat(custom.filter((c) => !Core.categoryNames().includes(c)));
  }

  // --- сводка (порт web.app.build_summary) ---
  async function buildSummary(period, currency) {
    const { since, until, label } = Core.periodRange(period);
    const catRows = await Store.summaryByCategory({ since, until });
    const kindRows = await Store.totalsByKind({ since, until });
    const target = currency || (await defaultCurrency());

    const cats = catRows.filter((r) => r.currency === target);
    const catTotal = cats.reduce((a, r) => a + r.total, 0) || 0;
    const categories = cats.map((r) => ({
      category: r.category, total: round2(r.total), count: r.count,
      percent: catTotal ? round2(r.total / catTotal * 100) : 0,
    }));

    const kindTotal = (kind) => round2(kindRows
      .filter((r) => r.kind === kind && r.currency === target)
      .reduce((a, r) => a + r.total, 0));
    const expense = kindTotal("expense"), income = kindTotal("income"), savings = kindTotal("savings");

    const others = {};
    for (const r of catRows) if (r.currency !== target) others[r.currency] = round2((others[r.currency] || 0) + r.total);

    const daily = (await Store.dailyTotals({ since, until, currency: target }))
      .map((r) => ({ day: r.day, total: round2(r.total), count: r.count }));

    return {
      period, label, since, until, currency: target,
      categories, expense_total: expense, income_total: income, savings_total: savings,
      balance: round2(income - expense),
      entry_count: cats.reduce((a, r) => a + r.count, 0),
      other_currencies: Object.entries(others).map(([c, v]) => ({ currency: c, total: v })),
      daily,
    };
  }

  // --- импорт выписки: распределяем по категориям, отсекаем внутренние/доходы ---
  async function importTransactions(txs, source) {
    let imported = 0, skipped = 0, income_skipped = 0, internal_skipped = 0;
    const cur = await defaultCurrency();
    for (const tx of txs) {
      if (await Store.isTxImported(tx.id)) { skipped++; continue; }
      const kind = Core.statementKind(tx.type, tx.amount);
      if (kind === "skip") { internal_skipped++; await Store.markTxImported(tx.id, 0); continue; }
      if (kind === "income") { income_skipped++; await Store.markTxImported(tx.id, 0); continue; }
      const date = (tx.date || "").slice(0, 10);
      const when = date ? date + "T12:00:00" : Core.localISO(new Date()).slice(0, 10) + "T12:00:00";
      const note = Core.statementMerchant(tx.description, tx.type) || Core.guessMerchant(tx.description) || "—";
      const rec = {
        amount: round2(Math.abs(tx.amount)),
        currency: tx.currency || cur,
        category: Core.statementCategory(tx.description, tx.type),
        note: note.slice(0, 60),
        kind: "expense", created_at: when, place: "—",
        raw_text: `${source} · ${tx.description}`.slice(0, 200),
      };
      const row = await Store.insertEntry(rec);
      await Store.markTxImported(tx.id, row.id);
      imported++;
    }
    return { imported, skipped, income_skipped, internal_skipped, total: txs.length };
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function requireAuth() {
    // если PIN установлен и сессия не открыта — как 401 на сервере
    if (SESSION.pinSet && !SESSION.authed) throw new HTTPError(401, "Требуется вход");
  }

  // --- маршрутизатор ---
  async function dispatch(method, path, query, body) {
    // открытые маршруты
    if (path === "/config" && method === "GET") {
      const pinSet = await pinIsSet();
      SESSION.pinSet = pinSet;
      return {
        version: VERSION, multiuser: false, bot_username: "",
        auth_required: pinSet, authed: !pinSet || SESSION.authed,
        default_currency: await defaultCurrency(), live_refresh: false, bank: false, offline: true,
        currencies: Object.keys(Core.CURRENCY_SYMBOLS), currency_symbols: Core.CURRENCY_SYMBOLS,
        categories: await categoriesList(),
        periods: Object.entries(Core.PERIOD_LABELS).map(([k, v]) => ({ key: k, label: v })),
      };
    }
    if (path === "/auth" && method === "POST") {
      const stored = await Store.getSetting("pin_hash");
      if (!stored) { SESSION.authed = true; return { ok: true, authed: true }; }
      if ((await hashPin(String(body.pin || ""))) !== stored) throw new HTTPError(401, "Неверный PIN");
      SESSION.authed = true;
      return { ok: true, authed: true };
    }
    if (path === "/logout" && method === "POST") { SESSION.authed = false; return { ok: true }; }

    // PIN управление (требует, чтобы пользователь уже был внутри)
    if (path === "/settings/pin" && method === "POST") {
      requireAuth();
      const pin = String(body.pin || "");
      if (!pin) { await Store.setSetting("pin_hash", null); SESSION.pinSet = false; return { ok: true, set: false }; }
      await Store.setSetting("pin_hash", await hashPin(pin));
      SESSION.pinSet = true; SESSION.authed = true;
      return { ok: true, set: true };
    }

    requireAuth(); // дальше — защищённые маршруты

    if (path === "/parse-preview" && method === "POST") {
      try {
        const p = Core.parseMessage(body.text, { defaultCurrency: await defaultCurrency() });
        return { ok: true, parsed: {
          amount: p.amount, currency: p.currency, category: p.category, note: p.note,
          kind: p.kind, backdated: p.backdated, created_at: p.created_at } };
      } catch (e) { return { ok: false, error: e.message }; }
    }

    if (path === "/entries" && method === "POST") {
      let p;
      try { p = Core.parseMessage(body.text, { defaultCurrency: await defaultCurrency() }); }
      catch (e) { throw new HTTPError(400, e.message); }
      const row = await Store.insertEntry({
        amount: p.amount, currency: p.currency, category: p.category, place: p.place,
        kind: p.kind, note: p.note, raw_text: p.raw_text, created_at: p.created_at,
      });
      return { entry: rowToDict(row), backdated: p.backdated };
    }

    if (path === "/entries" && method === "GET") {
      const { since, until } = Core.periodRange(query.period || "month");
      const kinds = query.kind ? [query.kind] : null;
      const rows = await Store.listEntries({
        since, until, kinds,
        limit: query.limit ? +query.limit : 500, offset: query.offset ? +query.offset : 0 });
      return { entries: rows.map(rowToDict) };
    }

    if (path === "/summary" && method === "GET") {
      return buildSummary(query.period || "month", query.currency || null);
    }

    let m;
    if ((m = path.match(/^\/entries\/(\d+)$/))) {
      const id = +m[1];
      if (method === "DELETE") {
        const row = await Store.deleteEntry(id);
        if (!row) throw new HTTPError(404, "Запись не найдена");
        return { ok: true, deleted: id, remote: { remote: false } };
      }
      if (method === "PATCH") {
        const row = await Store.updateEntry(id, body);
        if (!row) throw new HTTPError(404, "Запись не найдена");
        return { entry: rowToDict(row) };
      }
    }

    if (path === "/budgets" && method === "GET") {
      const { since, until } = Core.periodRange("month");
      const def = await defaultCurrency();
      const spentRows = await Store.summaryByCategory({ since, until });
      const spent = {};
      for (const r of spentRows) if (r.currency === def) spent[r.category] = r.total;
      const out = (await Store.getBudgets()).map((b) => {
        const used = round2(spent[b.category] || 0);
        return { category: b.category, monthly_limit: b.monthly_limit, currency: b.currency,
          spent: used, percent: b.monthly_limit ? round2(used / b.monthly_limit * 100) : 0,
          over: used > b.monthly_limit };
      });
      return { budgets: out };
    }
    if (path === "/budgets" && method === "PUT") {
      await Store.setBudget(body.category, body.monthly_limit, body.currency || (await defaultCurrency()));
      return { ok: true };
    }
    if ((m = path.match(/^\/budgets\/(.+)$/)) && method === "DELETE") {
      await Store.deleteBudget(decodeURIComponent(m[1]));
      return { ok: true };
    }

    if (path === "/import/preview" && method === "POST") {
      const txs = Core.parseStatement(Core.decodeBytes(b64ToBytes(body.data_b64)));
      const rows = [];
      for (const tx of txs.slice(0, 3000)) {
        const k = Core.statementKind(tx.type, tx.amount);
        const expense = k === "expense";
        rows.push({ date: tx.date, amount: tx.amount, currency: tx.currency, type: tx.type,
          merchant: Core.statementMerchant(tx.description, tx.type) || Core.guessMerchant(tx.description),
          category: expense ? Core.statementCategory(tx.description, tx.type) : "—",
          kind: k, is_expense: expense, already: await Store.isTxImported(tx.id) });
      }
      return {
        count: txs.length,
        expenses: rows.filter((r) => r.is_expense).length,
        new: rows.filter((r) => r.is_expense && !r.already).length,
        income: rows.filter((r) => r.kind === "income").length,
        internal: rows.filter((r) => r.kind === "skip").length,
        transactions: rows,
      };
    }
    if (path === "/import/confirm" && method === "POST") {
      const txs = Core.parseStatement(Core.decodeBytes(b64ToBytes(body.data_b64)));
      if (!txs.length) throw new HTTPError(400, "В файле не найдено транзакций — проверь формат выписки");
      return Object.assign({ ok: true }, await importTransactions(txs, "Выписка"));
    }

    // --- настройки/данные (свои, локальные) ---
    if (path === "/settings/currency" && method === "POST") {
      await Store.setSetting("currency", body.currency || "PLN"); return { ok: true };
    }
    if (path === "/settings/category" && method === "POST") {
      const name = String(body.name || "").trim();
      if (!name) throw new HTTPError(400, "Пустое имя категории");
      const custom = (await Store.getSetting("categories_custom")) || [];
      if (!custom.includes(name) && !Core.categoryNames().includes(name)) custom.push(name);
      await Store.setSetting("categories_custom", custom);
      return { ok: true, categories: await categoriesList() };
    }
    if ((m = path.match(/^\/settings\/category\/(.+)$/)) && method === "DELETE") {
      const name = decodeURIComponent(m[1]);
      let custom = (await Store.getSetting("categories_custom")) || [];
      custom = custom.filter((c) => c !== name);
      await Store.setSetting("categories_custom", custom);
      return { ok: true, categories: await categoriesList() };
    }
    if (path === "/backup" && method === "GET") { return await Store.exportAll(); }
    if (path === "/restore" && method === "POST") {
      const res = await Store.importAll(body.data);
      SESSION.authed = true; SESSION.pinSet = await pinIsSet();
      return Object.assign({ ok: true }, res);
    }
    if (path === "/reset" && method === "POST") {
      await Store.clearAll(); SESSION.authed = true; SESSION.pinSet = false; return { ok: true };
    }

    throw new HTTPError(404, "Неизвестный запрос: " + method + " " + path);
  }

  // app.js зовёт это вместо fetch. Возвращает то же, что возвращал JSON-ответ сервера.
  async function localApi(path, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    const [rawPath, qs] = path.split("?");
    const query = {};
    if (qs) for (const part of qs.split("&")) {
      const [k, v] = part.split("="); query[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
    const body = opts.body ? JSON.parse(opts.body) : {};
    await Store.open();
    return dispatch(method, rawPath, query, body);
  }

  return { localApi, HTTPError };
})();
