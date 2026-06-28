// Хранилище SpendTrack на IndexedDB — единственное место с данными. Раньше это
// был SQLite на сервере; теперь база живёт прямо на устройстве, поэтому данные
// у каждого устройства свои и приложению не нужен ни сервер, ни сеть. Перенос
// между устройствами — через резервную копию (экспорт/импорт JSON).
"use strict";

const Store = (() => {
  const DB_NAME = "spendtrack";
  const DB_VERSION = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("entries")) {
          db.createObjectStore("entries", { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("budgets")) {
          db.createObjectStore("budgets", { keyPath: "category" });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("imported_tx")) {
          db.createObjectStore("imported_tx", { keyPath: "id" });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(stores, mode) {
    return open().then((db) => db.transaction(stores, mode));
  }

  function reqP(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function getAll(storeName) {
    return tx(storeName, "readonly").then((t) => reqP(t.objectStore(storeName).getAll()));
  }

  // --- записи ---
  function allEntries() { return getAll("entries"); }

  function inRange(e, since, until) {
    const c = e.created_at || "";
    if (since && c < since) return false;
    if (until && c >= until) return false;
    return true;
  }

  async function listEntries({ since = null, until = null, kinds = null, limit = null, offset = 0 } = {}) {
    let rows = (await allEntries()).filter((e) => inRange(e, since, until));
    if (kinds && kinds.length) rows = rows.filter((e) => kinds.includes(e.kind));
    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
    if (limit !== null) rows = rows.slice(offset, offset + limit);
    return rows;
  }

  async function insertEntry(record) {
    const t = await tx("entries", "readwrite");
    const rec = Object.assign({ place: "—", note: "", raw_text: "" }, record);
    delete rec.id; // пусть autoIncrement выдаст id
    const id = await reqP(t.objectStore("entries").add(rec));
    rec.id = id;
    return rec;
  }

  async function getEntry(id) {
    const t = await tx("entries", "readonly");
    return reqP(t.objectStore("entries").get(Number(id)));
  }

  async function updateEntry(id, fields) {
    const t = await tx("entries", "readwrite");
    const store = t.objectStore("entries");
    const row = await reqP(store.get(Number(id)));
    if (!row) return null;
    const editable = ["amount", "currency", "category", "kind", "note", "place", "created_at"];
    for (const k of editable) if (k in fields && fields[k] != null) row[k] = fields[k];
    await reqP(store.put(row));
    return row;
  }

  async function deleteEntry(id) {
    const t = await tx("entries", "readwrite");
    const store = t.objectStore("entries");
    const row = await reqP(store.get(Number(id)));
    if (!row) return null;
    await reqP(store.delete(Number(id)));
    return row;
  }

  // --- агрегации (порт storage.summary_by_category / totals_by_kind / daily_totals) ---
  async function summaryByCategory({ since, until, kind = "expense" } = {}) {
    const rows = (await allEntries()).filter((e) => e.kind === kind && inRange(e, since, until));
    const map = new Map();
    for (const e of rows) {
      const key = e.category + "|" + e.currency;
      const cur = map.get(key) || { category: e.category, currency: e.currency, total: 0, count: 0 };
      cur.total += e.amount; cur.count += 1; map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }

  async function totalsByKind({ since, until } = {}) {
    const rows = (await allEntries()).filter((e) => inRange(e, since, until));
    const map = new Map();
    for (const e of rows) {
      const key = e.kind + "|" + e.currency;
      const cur = map.get(key) || { kind: e.kind, currency: e.currency, total: 0, count: 0 };
      cur.total += e.amount; cur.count += 1; map.set(key, cur);
    }
    return [...map.values()];
  }

  async function dailyTotals({ since, until, kind = "expense", currency = null } = {}) {
    let rows = (await allEntries()).filter((e) => e.kind === kind && inRange(e, since, until));
    if (currency) rows = rows.filter((e) => e.currency === currency);
    const map = new Map();
    for (const e of rows) {
      const day = (e.created_at || "").slice(0, 10);
      const cur = map.get(day) || { day, total: 0, count: 0 };
      cur.total += e.amount; cur.count += 1; map.set(day, cur);
    }
    return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  // --- бюджеты ---
  function getBudgets() { return getAll("budgets").then((b) => b.sort((x, y) => x.category.localeCompare(y.category))); }
  async function setBudget(category, monthly_limit, currency = "PLN") {
    const t = await tx("budgets", "readwrite");
    await reqP(t.objectStore("budgets").put({ category, monthly_limit, currency }));
  }
  async function deleteBudget(category) {
    const t = await tx("budgets", "readwrite");
    await reqP(t.objectStore("budgets").delete(category));
  }

  // --- настройки (ключ-значение) ---
  async function getSetting(key, def = null) {
    const t = await tx("settings", "readonly");
    const row = await reqP(t.objectStore("settings").get(key));
    return row ? row.value : def;
  }
  async function setSetting(key, value) {
    const t = await tx("settings", "readwrite");
    await reqP(t.objectStore("settings").put({ key, value }));
  }
  async function allSettings() {
    const rows = await getAll("settings");
    const obj = {};
    for (const r of rows) obj[r.key] = r.value;
    return obj;
  }

  // --- импортированные транзакции (дедуп выписки) ---
  async function isTxImported(txId) {
    const t = await tx("imported_tx", "readonly");
    return !!(await reqP(t.objectStore("imported_tx").get(txId)));
  }
  async function markTxImported(txId, entryId) {
    const t = await tx("imported_tx", "readwrite");
    await reqP(t.objectStore("imported_tx").put({ id: txId, entry_id: entryId, imported_at: Core.localISO(new Date()) }));
  }
  async function countImported() { return (await getAll("imported_tx")).length; }

  // --- резервная копия: экспорт/импорт/сброс ---
  async function exportAll() {
    const [entries, budgets, settings, imported] = await Promise.all([
      getAll("entries"), getAll("budgets"), allSettings(), getAll("imported_tx"),
    ]);
    // PIN не выгружаем — он только для этого устройства, иначе можно случайно
    // заблокировать другой телефон чужим кодом.
    const safe = {};
    for (const k of ["categories_custom", "currency"]) if (k in settings) safe[k] = settings[k];
    return {
      app: "spendtrack", format: 1, exported_at: Core.localISO(new Date()),
      entries, budgets, settings: safe, imported_tx: imported,
    };
  }

  async function clearAll() {
    const t = await tx(["entries", "budgets", "settings", "imported_tx"], "readwrite");
    await Promise.all(["entries", "budgets", "settings", "imported_tx"].map((s) => reqP(t.objectStore(s).clear())));
  }

  async function importAll(data, { keepSettings = false } = {}) {
    if (!data || data.app !== "spendtrack") throw new Error("Это не резервная копия SpendTrack");
    const savedSettings = keepSettings ? await allSettings() : null;
    await clearAll();
    const t = await tx(["entries", "budgets", "settings", "imported_tx"], "readwrite");
    const es = t.objectStore("entries");
    for (const e of (data.entries || [])) es.put(e); // сохраняем исходные id
    const bs = t.objectStore("budgets");
    for (const b of (data.budgets || [])) bs.put(b);
    const ss = t.objectStore("settings");
    const settings = keepSettings ? savedSettings : (data.settings || {});
    for (const k of Object.keys(settings || {})) ss.put({ key: k, value: settings[k] });
    const ts = t.objectStore("imported_tx");
    for (const x of (data.imported_tx || [])) ts.put(x);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    return { entries: (data.entries || []).length, budgets: (data.budgets || []).length };
  }

  return {
    open, allEntries, listEntries, insertEntry, getEntry, updateEntry, deleteEntry,
    summaryByCategory, totalsByKind, dailyTotals,
    getBudgets, setBudget, deleteBudget,
    getSetting, setSetting, allSettings,
    isTxImported, markTxImported, countImported,
    exportAll, importAll, clearAll,
  };
})();
