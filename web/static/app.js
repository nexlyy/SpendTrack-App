// Клиент SpendTrack. Без сборки. Диаграмму рисуем сами на SVG, как в Obsidian.
"use strict";

const CAT_COLORS = {
  "Еда": "#ff6b6b", "Доставка": "#ffa94d", "Продукты": "#ffd43b", "Транспорт": "#74c0fc",
  "Ева": "#f783ac", "Аренда": "#9775fa", "Развлечения": "#4dd4ac", "Одежда": "#63e6be",
  "Дом": "#a9e34b", "Уход": "#f06595", "Здоровье": "#20c997", "Образование": "#3bc9db",
  "Подписки": "#748ffc", "Прочее": "#adb5bd", "Доход": "#60a5fa", "Сбережения": "#c084fc",
};
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
  "августа", "сентября", "октября", "ноября", "декабря"];
const DOW = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

const state = {
  config: null,
  period: localStorage.getItem("st-period") || "month",
  currency: null,
  feedKind: "",
  summary: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

function catColor(name) {
  if (CAT_COLORS[name]) return CAT_COLORS[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 60% 62%)`;
}

function sym(cur) {
  return (state.config && state.config.currency_symbols[cur]) || cur;
}
function money(amount, cur) {
  cur = cur || state.currency;
  const n = Number(amount || 0).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  return `${n} ${sym(cur)}`;
}

/* API — теперь локальный: всё считается на устройстве (см. localapi.js) */
async function api(path, opts = {}) {
  try {
    return await LocalAPI.localApi(path, opts);
  } catch (e) {
    if (e && e.status === 401) { showLogin(); throw new Error("auth"); }
    throw new Error((e && e.message) || "Ошибка запроса");
  }
}

/* Сохранение файла наружу. content — строка или Uint8Array (для .gz).
   Android → нативный мост в «Загрузки»; iOS → лист «Поделиться»; иначе — Blob. */
function bytesToBase64(content) {
  if (typeof content === "string") return btoa(unescape(encodeURIComponent(content)));
  let bin = "";
  for (let i = 0; i < content.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, content.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function saveFile(filename, content, mime) {
  if (window.AndroidBridge && typeof AndroidBridge.saveToDownloads === "function") {
    try {
      const where = AndroidBridge.saveToDownloads(filename, bytesToBase64(content), mime || "application/octet-stream");
      if (where) { toast("Сохранено: " + where, "success"); return; }
    } catch (e) { /* падаем на обычную загрузку */ }
  }
  if (window.webkit && webkit.messageHandlers && webkit.messageHandlers.saveFile) {
    try {
      webkit.messageHandlers.saveFile.postMessage({ filename, base64: bytesToBase64(content), mime: mime || "application/octet-stream" });
      toast("Открываю «Поделиться»…", "success");
      return;
    } catch (e) { /* падаем на обычную загрузку */ }
  }
  const blob = new Blob([content], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* Своё окно подтверждения — вместо системного confirm(), который в WebView
   показывает уродливое «The page at file:// says». Возвращает Promise<bool>. */
function confirmDialog(message, opts = {}) {
  return new Promise((resolve) => {
    const modal = $("#confirmModal");
    $("#confirmText").textContent = message;
    const ok = $("#confirmOk"), cancel = $("#confirmCancel");
    ok.textContent = opts.okText || "Удалить";
    ok.className = "btn " + (opts.danger === false ? "btn--primary" : "btn--danger");
    modal.classList.remove("hidden");
    const done = (val) => {
      modal.classList.add("hidden");
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => { if (e.target === modal) done(false); };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
  });
}

/* gzip/gunzip для резервных копий — файлы получаются в несколько раз меньше. */
async function gzipString(str) {
  if (!window.CompressionStream) return null;
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(str)); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function gunzipBytes(bytes) {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
}

/* Toast */
let toastTimer = null;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast " + kind; }, 2600);
}

/* Dates */
function parseDay(s) {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtDay(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function addDays(dt, n) { const x = new Date(dt); x.setDate(x.getDate() + n); return x; }
function startOfDay(dt) { const x = new Date(dt); x.setHours(0, 0, 0, 0); return x; }
function daysBetween(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / 86400000); }

function headingForDate(dateStr) {
  const d = parseDay(dateStr);
  const today = startOfDay(new Date());
  const diff = daysBetween(d, today);
  if (diff === 0) return { label: "Сегодня", dow: DOW[d.getDay()] };
  if (diff === 1) return { label: "Вчера", dow: DOW[d.getDay()] };
  return { label: `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`, dow: DOW[d.getDay()] };
}

/* Periods nav */
function renderPeriods() {
  const nav = $("#periods");
  nav.innerHTML = "";
  state.config.periods.forEach((p) => {
    const b = el("button", state.period === p.key ? "active" : "", p.label);
    b.onclick = () => {
      state.period = p.key;
      localStorage.setItem("st-period", p.key);
      renderPeriods();
      refresh();
    };
    nav.appendChild(b);
  });
}

/* Stats */
function renderStats(s) {
  const box = $("#stats");
  const cards = [
    { cls: "expense", label: "Расходы", dot: "var(--text)", value: money(s.expense_total),
      sub: `${s.entry_count} ${plural(s.entry_count, "запись", "записи", "записей")}` },
    { cls: "income", label: "Доход", dot: "var(--income)", value: money(s.income_total), sub: s.label },
    { cls: "savings", label: "Отложено", dot: "var(--savings)", value: money(s.savings_total), sub: s.label },
    { cls: "balance", label: "Баланс", dot: "var(--brand)", value: money(s.balance),
      sub: "доход − расходы" },
  ];
  box.innerHTML = "";
  cards.forEach((c) => {
    const card = el("div", `stat stat--${c.cls}`);
    card.innerHTML =
      `<div class="label"><span class="pin" style="background:${c.dot}"></span>${c.label}</div>` +
      `<div class="value">${c.value}</div><div class="sub">${c.sub}</div>`;
    box.appendChild(card);
  });
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/* Donut */
const R = 72, C = 2 * Math.PI * 72;
function renderDonut(s) {
  const svg = $("#donut");
  const wrap = svg.parentElement;
  let center = wrap.querySelector(".donut-center");
  if (!center) { center = el("div", "donut-center"); wrap.appendChild(center); }

  svg.innerHTML = "";
  const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  track.setAttribute("class", "track");
  track.setAttribute("cx", 100); track.setAttribute("cy", 100); track.setAttribute("r", R);
  svg.appendChild(track);

  const cats = s.categories;
  $("#chartEmpty").hidden = cats.length > 0;
  const total = cats.reduce((a, c) => a + c.total, 0);
  // размер шрифта по длине суммы, чтобы «10 627,96 zł» не вылезало за кольцо
  const totalStr = money(total);
  const fs = totalStr.length > 13 ? 16 : totalStr.length > 11 ? 18
    : totalStr.length > 9 ? 21 : totalStr.length > 7 ? 24 : 28;
  center.innerHTML = `<div><div class="total" style="font-size:${fs}px">${totalStr}</div>` +
    `<div class="cap">${escapeHtml(s.label)}</div></div>`;

  let acc = 0;
  const circles = [];
  cats.forEach((c) => {
    const frac = total ? c.total / total : 0;
    const circ = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circ.setAttribute("cx", 100); circ.setAttribute("cy", 100); circ.setAttribute("r", R);
    circ.setAttribute("stroke", catColor(c.category));
    circ.setAttribute("stroke-dasharray", `0 ${C}`);
    circ.setAttribute("stroke-dashoffset", `${-acc * C}`);
    circ.dataset.target = `${frac * C} ${C - frac * C}`;
    circ.dataset.cat = c.category;
    svg.appendChild(circ);
    circles.push(circ);
    acc += frac;
  });
  requestAnimationFrame(() => circles.forEach((c) => {
    c.setAttribute("stroke-dasharray", c.dataset.target);
  }));

  renderLegend(s, circles);
}

function renderLegend(s, circles) {
  const list = $("#legend");
  list.innerHTML = "";
  s.categories.forEach((c) => {
    const li = el("li");
    li.innerHTML =
      `<span class="dot" style="background:${catColor(c.category)}"></span>` +
      `<span class="name">${escapeHtml(c.category)}</span>` +
      `<span class="amt">${money(c.total)}</span>` +
      `<span class="pct">${c.percent}%</span>`;
    li.onmouseenter = () => circles.forEach((ci) =>
      ci.style.opacity = ci.dataset.cat === c.category ? "1" : "0.25");
    li.onmouseleave = () => circles.forEach((ci) => ci.style.opacity = "1");
    list.appendChild(li);
  });
  if (s.other_currencies && s.other_currencies.length) {
    const note = el("li", "muted", "Ещё: " +
      s.other_currencies.map((o) => money(o.total, o.currency)).join(", "));
    note.style.gridColumn = "1 / -1";
    list.appendChild(note);
  }
}

/* Trend */
function buildTrend(s) {
  const byDay = {};
  s.daily.forEach((d) => { byDay[d.day] = d.total; });
  const today = startOfDay(new Date());
  let end = s.until ? addDays(parseDay(s.until), -1) : today;
  if (end > today) end = today;
  let start = s.since ? parseDay(s.since)
    : (s.daily.length ? parseDay(s.daily[0].day) : addDays(end, -13));
  if (daysBetween(start, end) < 6) start = addDays(end, -6);

  if (daysBetween(start, end) > 62) {           // длинный период → по месяцам
    const buckets = {};
    for (let dt = new Date(start); dt <= end; dt = addDays(dt, 1)) {
      const key = `${dt.getFullYear()}-${dt.getMonth()}`;
      buckets[key] = (buckets[key] || 0) + (byDay[fmtDay(dt)] || 0);
    }
    return Object.entries(buckets).map(([k, total]) => {
      const [, mo] = k.split("-").map(Number);
      return { label: MONTHS[mo], total, tip: MONTHS[mo] };
    });
  }
  const out = [];                                // короткий период → по дням
  for (let dt = new Date(start); dt <= end; dt = addDays(dt, 1)) {
    out.push({ label: dt.getDate(), total: byDay[fmtDay(dt)] || 0,
      tip: `${dt.getDate()} ${MONTHS[dt.getMonth()]}` });
  }
  return out;
}

function renderTrend(s) {
  const box = $("#trend");
  $("#trendLabel").textContent = s.label;
  const data = buildTrend(s);
  const max = Math.max(1, ...data.map((d) => d.total));
  box.innerHTML = "";
  const showLabels = data.length <= 16;
  data.forEach((d) => {
    const bar = el("div", "bar");
    bar.style.height = `${Math.max(2, (d.total / max) * 100)}%`;
    bar.appendChild(el("span", "tip", `${d.tip}: ${money(d.total)}`));
    if (showLabels) bar.appendChild(el("span", "day", d.label));
    box.appendChild(bar);
  });
}

/* Budgets */
async function renderBudgets() {
  const box = $("#budgets");
  const { budgets } = await api("/budgets");
  box.innerHTML = "";
  if (!budgets.length) {
    box.appendChild(el("div", "empty", "Лимитов нет. Добавьте, чтобы видеть перерасход."));
    return;
  }
  budgets.forEach((b) => {
    const pct = Math.min(100, b.percent);
    const cls = b.over ? "over" : (b.percent >= 80 ? "warn" : "");
    const card = el("div", `budget ${cls}`);
    card.innerHTML =
      `<div class="top"><span class="cat"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${catColor(b.category)}"></span>${escapeHtml(b.category)}</span>` +
      `<span class="nums">${money(b.spent, b.currency)} / ${money(b.monthly_limit, b.currency)}</span></div>` +
      `<div class="bar"><div class="fill" style="width:${pct}%"></div></div>` +
      `<div class="pct">${b.percent}%${b.over ? " · перерасход" : ""}</div>`;
    card.onclick = () => openBudget(b.category, b.monthly_limit);
    box.appendChild(card);
  });
}

/* Feed */
async function renderFeed() {
  const box = $("#feed");
  const { entries } = await api(`/entries?period=${state.period}` +
    (state.feedKind ? `&kind=${state.feedKind}` : ""));
  box.innerHTML = "";
  $("#feedEmpty").hidden = entries.length > 0;

  const groups = {};
  entries.forEach((e) => { (groups[e.date] = groups[e.date] || []).push(e); });
  const days = Object.keys(groups).sort().reverse();

  days.forEach((date) => {
    const items = groups[date];
    const daySum = items.filter((e) => e.kind === "expense").reduce((a, e) => a + e.amount, 0);
    const { label, dow } = headingForDate(date);
    const group = el("div", "day-group");
    const head = el("div", "day-head");
    head.innerHTML = `<div><span class="date">${label}</span><span class="dow">${dow}</span></div>` +
      `<span class="sum">${money(daySum)}</span>`;
    group.appendChild(head);

    items.forEach((e) => {
      const row = el("div", `row ${e.kind}`);
      const badge = e.kind === "income" ? `<span class="kind-badge">доход</span>`
        : e.kind === "savings" ? `<span class="kind-badge">отложено</span>` : "";
      const sign = e.kind === "expense" ? "−" : "+";
      row.innerHTML =
        `<span class="id">#${e.id}</span>` +
        `<span class="time">${e.time}</span>` +
        `<span class="body"><span class="cat"><span class="dot" style="background:${catColor(e.category)}"></span>${escapeHtml(e.category)}</span>` +
        `${badge}<span class="note">${escapeHtml(e.note)}</span></span>` +
        `<span class="amt">${sign}${money(e.amount, e.currency)}</span>` +
        `<button class="del" title="Удалить" aria-label="Удалить">✕</button>`;
      row.querySelector(".del").onclick = (ev) => { ev.stopPropagation(); deleteEntry(e); };
      row.onclick = () => openEdit(e);
      group.appendChild(row);
    });
    box.appendChild(group);
  });
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* Quick add */
let previewTimer = null;
function onComposerInput() {
  const text = $("#addInput").value.trim();
  const box = $("#preview");
  clearTimeout(previewTimer);
  if (!text) { box.hidden = true; return; }
  previewTimer = setTimeout(async () => {
    try {
      const res = await api("/parse-preview", { method: "POST", body: JSON.stringify({ text }) });
      if (!res.ok) { box.hidden = false; box.className = "preview error"; box.textContent = "⚠️ " + res.error; return; }
      const p = res.parsed;
      box.hidden = false; box.className = "preview";
      const kindWord = p.kind === "income" ? "доход" : p.kind === "savings" ? "сбережения" : "";
      box.innerHTML =
        `<span class="chip"><span class="dot" style="background:${catColor(p.category)}"></span>${escapeHtml(p.category)}</span>` +
        `<span class="amount">${money(p.amount, p.currency)}</span>` +
        (kindWord ? `<span class="chip">${kindWord}</span>` : "") +
        (p.note ? `<span class="muted-note">${escapeHtml(p.note)}</span>` : "") +
        (p.backdated ? `<span class="chip">🗓 ${p.created_at.slice(0, 10).split("-").reverse().join(".")}</span>` : "");
    } catch (e) { /* auth handled elsewhere */ }
  }, 220);
}

async function submitComposer(ev) {
  ev.preventDefault();
  const input = $("#addInput");
  const text = input.value.trim();
  if (!text) return;
  try {
    const { entry } = await api("/entries", { method: "POST", body: JSON.stringify({ text }) });
    input.value = ""; $("#preview").hidden = true;
    toast(`Добавлено #${entry.id}: ${entry.category} · ${money(entry.amount, entry.currency)}`, "success");
    await refresh();
    input.focus();
  } catch (e) {
    if (e.message !== "auth") toast("⚠️ " + e.message, "error");
  }
}

/* Delete / Edit */
async function deleteEntry(e) {
  if (!(await confirmDialog(`Удалить запись #${e.id}: ${e.category} ${money(e.amount, e.currency)}?`))) return;
  try {
    const res = await api(`/entries/${e.id}`, { method: "DELETE" });
    const r = res.remote;
    if (r && r.remote && r.ok === false) {
      toast(`#${e.id} удалено локально, но на сервере не вышло: ${r.error || ""}`, "error");
    } else {
      toast(`Удалено #${e.id}`, "success");
    }
    await refresh();
  } catch (err) { if (err.message !== "auth") toast("⚠️ " + err.message, "error"); }
}

let editing = null;
function openEdit(e) {
  editing = e;
  $("#editId").textContent = `#${e.id}`;
  $("#editAmount").value = e.amount;
  fillSelect($("#editCurrency"), state.config.currencies, e.currency);
  fillSelect($("#editCategory"), state.config.categories, e.category);
  $("#editKind").value = e.kind;
  $("#editNote").value = e.note;
  $("#editDate").value = (e.created_at || "").slice(0, 16);
  $("#editModal").classList.remove("hidden");
}
function closeEdit() { $("#editModal").classList.add("hidden"); editing = null; }

async function saveEdit(ev) {
  ev.preventDefault();
  if (!editing) return;
  const body = {
    amount: parseFloat($("#editAmount").value),
    currency: $("#editCurrency").value,
    category: $("#editCategory").value,
    kind: $("#editKind").value,
    note: $("#editNote").value,
    created_at: $("#editDate").value.slice(0, 16) + ":00",
  };
  try {
    await api(`/entries/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
    toast(`Сохранено #${editing.id}`, "success");
    closeEdit();
    await refresh();
  } catch (err) { if (err.message !== "auth") toast("⚠️ " + err.message, "error"); }
}

/* Budgets modal */
function openBudget(category, limit) {
  fillSelect($("#budgetCategory"), state.config.categories, category || state.config.categories[0]);
  $("#budgetLimit").value = limit || "";
  $("#budgetDelete").style.visibility = category ? "visible" : "hidden";
  $("#budgetModal").classList.remove("hidden");
}
function closeBudget() { $("#budgetModal").classList.add("hidden"); }

async function saveBudget(ev) {
  ev.preventDefault();
  const category = $("#budgetCategory").value;
  const monthly_limit = parseFloat($("#budgetLimit").value);
  if (!(monthly_limit > 0)) { toast("Укажите лимит больше нуля", "error"); return; }
  try {
    await api("/budgets", { method: "PUT",
      body: JSON.stringify({ category, monthly_limit, currency: state.config.default_currency }) });
    closeBudget(); await renderBudgets();
    toast(`Лимит для «${category}» сохранён`, "success");
  } catch (err) { if (err.message !== "auth") toast("⚠️ " + err.message, "error"); }
}
async function deleteBudgetCurrent() {
  const category = $("#budgetCategory").value;
  try {
    await api(`/budgets/${encodeURIComponent(category)}`, { method: "DELETE" });
    closeBudget(); await renderBudgets();
    toast(`Лимит для «${category}» убран`, "success");
  } catch (err) { if (err.message !== "auth") toast("⚠️ " + err.message, "error"); }
}

function fillSelect(sel, options, value) {
  sel.innerHTML = "";
  options.forEach((o) => {
    const opt = el("option"); opt.value = o; opt.textContent = o;
    if (o === value) opt.selected = true;
    sel.appendChild(opt);
  });
}

/* Theme / auth */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("st-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#f4f6fb" : "#0e1016";
}
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
}

function showLogin() {
  const cfg = state.config || {};
  if (cfg.multiuser) {
    const bot = cfg.bot_username ? "<b>@" + cfg.bot_username + "</b>" : "в Telegram";
    $("#loginHint").innerHTML = "Откройте бота " + bot + ", команда <code>/login</code>, и введите код:";
    const inp = $("#pinInput");
    inp.type = "text"; inp.placeholder = "123456"; inp.maxLength = 6;
    inp.autocomplete = "one-time-code"; inp.inputMode = "numeric";
  }
  $("#loginOverlay").classList.remove("hidden");
}

async function doLogin(ev) {
  ev.preventDefault();
  const value = $("#pinInput").value.trim();
  const multiuser = !!(state.config && state.config.multiuser);
  try {
    if (multiuser) await api("/auth/telegram", { method: "POST", body: JSON.stringify({ code: value }) });
    else await api("/auth", { method: "POST", body: JSON.stringify({ pin: value }) });
    $("#loginOverlay").classList.add("hidden");
    $("#loginError").textContent = "";
    $("#pinInput").value = "";
    await boot();
  } catch (e) {
    $("#loginError").textContent = multiuser ? "Код неверный или истёк" : "Неверный PIN";
  }
}
async function doLogout() {
  await api("/logout", { method: "POST" }).catch(() => {});
  showLogin();
}

/* Данные и настройки: импорт выписки, резервная копия, PIN, категории, сброс */
async function openData() {
  $("#dataModal").classList.remove("hidden");
  await renderData();
}
function closeData() { $("#dataModal").classList.add("hidden"); }

async function renderData() {
  const body = $("#dataBody");
  const cfg = state.config || {};
  const cats = cfg.categories || [];
  const custom = cats.filter((c) => !Core.categoryNames().includes(c));
  const pinSet = !!cfg.auth_required;

  const curOpts = (cfg.currencies || []).map((c) =>
    '<option value="' + c + '"' + (c === cfg.default_currency ? " selected" : "") + ">" + c + "</option>").join("");

  const customHtml = custom.length
    ? custom.map((c) => '<span class="chip chip--del" data-cat="' + escapeHtml(c) + '">' +
        escapeHtml(c) + " ✕</span>").join("")
    : '<span class="muted">пока нет</span>';

  body.innerHTML =
    '<div class="bank-import">' +
      '<h3 class="bank-h">Импорт выписки (CSV)</h3>' +
      '<p class="muted">Выгрузи выписку из банка в CSV и загрузи сюда — разложу траты по категориям.</p>' +
      '<input type="file" id="stmtFile" accept=".csv,.txt,text/csv,text/comma-separated-values,application/csv,application/vnd.ms-excel,text/plain,application/octet-stream" class="input" />' +
      '<div id="stmtPreview" class="muted" style="margin-top:8px;"></div>' +
      '<button class="btn btn--primary btn--sm" id="stmtConfirm" hidden style="margin-top:10px;">Импортировать</button>' +
    "</div>" +

    '<hr class="bank-sep"><div><h3 class="bank-h">Резервная копия</h3>' +
      '<p class="muted">Все данные хранятся только на этом устройстве. Чтобы перенести их на другой телефон — сохрани копию и восстанови на нём.</p>' +
      '<div class="modal-actions" style="justify-content:flex-start;gap:8px;flex-wrap:wrap">' +
        '<button class="btn btn--primary btn--sm" id="backupBtn">Сохранить копию</button>' +
        '<button class="btn btn--ghost btn--sm" id="exportCsvBtn">Экспорт CSV</button>' +
        '<label class="btn btn--ghost btn--sm" style="cursor:pointer">Восстановить из копии' +
          '<input type="file" id="restoreFile" accept=".json,.gz,application/json,application/gzip" hidden /></label>' +
      "</div></div>" +

    '<hr class="bank-sep"><div><h3 class="bank-h">Свои категории</h3>' +
      '<div id="customCats" class="chips">' + customHtml + "</div>" +
      '<div class="row-inline" style="margin-top:10px">' +
        '<input id="newCat" class="input" placeholder="Например, Здоровье" />' +
        '<button class="btn btn--ghost btn--sm" id="addCatBtn">Добавить</button>' +
      "</div></div>" +

    '<hr class="bank-sep"><div><h3 class="bank-h">Основная валюта</h3>' +
      '<select id="curSelect" class="select">' + curOpts + "</select></div>" +

    '<hr class="bank-sep"><div><h3 class="bank-h">Защита PIN-кодом</h3>' +
      '<p class="muted">' + (pinSet ? "PIN включён." : "PIN не задан — вход свободный.") + "</p>" +
      '<div class="row-inline">' +
        '<input id="pinSet" class="input" type="password" inputmode="numeric" placeholder="' +
          (pinSet ? "новый PIN" : "придумай PIN") + '" />' +
        '<button class="btn btn--primary btn--sm" id="pinSetBtn">' + (pinSet ? "Сменить" : "Включить") + "</button>" +
        (pinSet ? '<button class="btn btn--ghost btn--sm" id="pinOffBtn">Убрать</button>' : "") +
      "</div></div>" +

    '<hr class="bank-sep"><div><h3 class="bank-h">Опасная зона</h3>' +
      '<button class="btn btn--danger btn--sm" id="resetBtn">Удалить все данные</button></div>';

  $("#stmtFile").onchange = onStatementFile;
  $("#stmtConfirm").onclick = onStatementConfirm;
  $("#backupBtn").onclick = doBackup;
  $("#exportCsvBtn").onclick = doExportCsv;
  $("#restoreFile").onchange = onRestoreFile;
  $("#addCatBtn").onclick = addCategory;
  $("#newCat").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addCategory(); } });
  document.querySelectorAll("#customCats .chip--del").forEach((ch) =>
    ch.onclick = () => removeCategory(ch.dataset.cat));
  $("#curSelect").onchange = (e) => setDefaultCurrency(e.target.value);
  $("#pinSetBtn").onclick = () => setPin($("#pinSet").value.trim());
  const off = $("#pinOffBtn"); if (off) off.onclick = () => setPin("");
  $("#resetBtn").onclick = doReset;
}

async function reloadConfig() { state.config = await api("/config"); }

async function doBackup() {
  try {
    const data = await api("/backup");
    const json = JSON.stringify(data);
    const stamp = Core.localISO(new Date()).slice(0, 10);
    const gz = await gzipString(json);  // максимально сжатый файл, бережём память
    if (gz) saveFile(`spendtrack-backup-${stamp}.json.gz`, gz, "application/gzip");
    else saveFile(`spendtrack-backup-${stamp}.json`, json, "application/json");
  } catch (e) { if (e.message !== "auth") toast("⚠️ " + e.message, "error"); }
}

async function doExportCsv() {
  try {
    const { entries } = await api(`/entries?period=${state.period}&limit=100000`);
    let csv = "﻿id;дата;время;тип;категория;сумма;валюта;заметка\n";
    entries.forEach((e) => {
      const note = (e.note || "").replace(/"/g, '""');
      csv += [e.id, e.date, e.time, e.kind, e.category, e.amount, e.currency, `"${note}"`].join(";") + "\n";
    });
    saveFile(`spendtrack-${state.period}.csv`, csv, "text/csv;charset=utf-8");
  } catch (e) { if (e.message !== "auth") toast("⚠️ " + e.message, "error"); }
}

function onRestoreFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    let text;
    try {
      const bytes = new Uint8Array(reader.result);
      // .gz распознаём по сигнатуре 1f 8b и распаковываем
      if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        if (!window.DecompressionStream) { toast("Это устройство не умеет распаковывать .gz", "error"); return; }
        text = await gunzipBytes(bytes);
      } else {
        text = new TextDecoder().decode(bytes);
      }
    } catch (e) { toast("Не удалось прочитать файл", "error"); return; }
    let data;
    try { data = JSON.parse(text); }
    catch (e) { toast("Файл не похож на резервную копию", "error"); return; }
    if (!(await confirmDialog("Восстановить из копии? Текущие данные будут заменены.", { okText: "Восстановить" }))) return;
    try {
      const r = await api("/restore", { method: "POST", body: JSON.stringify({ data }) });
      toast(`Восстановлено: ${r.entries} записей`, "success");
      closeData();
      await boot();
    } catch (e) { if (e.message !== "auth") toast("⚠️ " + e.message, "error"); }
  };
  reader.readAsArrayBuffer(file);
}

async function addCategory() {
  const name = $("#newCat").value.trim();
  if (!name) return;
  try {
    await api("/settings/category", { method: "POST", body: JSON.stringify({ name }) });
    await reloadConfig();
    await renderData();
    toast(`Категория «${name}» добавлена`, "success");
  } catch (e) { if (e.message !== "auth") toast("⚠️ " + e.message, "error"); }
}

async function removeCategory(name) {
  try {
    await api(`/settings/category/${encodeURIComponent(name)}`, { method: "DELETE" });
    await reloadConfig();
    await renderData();
  } catch (e) { if (e.message !== "auth") toast("⚠️ " + e.message, "error"); }
}

async function setDefaultCurrency(cur) {
  try {
    await api("/settings/currency", { method: "POST", body: JSON.stringify({ currency: cur }) });
    await reloadConfig();
    state.currency = cur;
    await refresh();
    toast("Основная валюта: " + cur, "success");
  } catch (e) { if (e.message !== "auth") toast("⚠️ " + e.message, "error"); }
}

async function setPin(pin) {
  if (pin && pin.length < 4) { toast("PIN — минимум 4 цифры", "error"); return; }
  try {
    await api("/settings/pin", { method: "POST", body: JSON.stringify({ pin }) });
    await reloadConfig();
    await renderData();
    toast(pin ? "PIN сохранён" : "PIN убран", "success");
  } catch (e) { if (e.message !== "auth") toast("⚠️ " + e.message, "error"); }
}

async function doReset() {
  if (!(await confirmDialog("Удалить ВСЕ записи, бюджеты и настройки на этом устройстве? Это необратимо.", { okText: "Удалить всё" }))) return;
  if (!(await confirmDialog("Точно удалить всё? Сделайте резервную копию заранее.", { okText: "Да, удалить" }))) return;
  try {
    await api("/reset", { method: "POST" });
    toast("Все данные удалены", "success");
    closeData();
    await boot();
  } catch (e) { if (e.message !== "auth") toast("⚠️ " + e.message, "error"); }
}

let _stmtB64 = null;
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      resolve(btoa(bin));
    };
    reader.readAsArrayBuffer(file);
  });
}

async function onStatementFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  const prev = $("#stmtPreview");
  $("#stmtConfirm").hidden = true;
  _stmtB64 = null;
  if (!file) return;
  prev.textContent = "Читаю файл…";
  try {
    _stmtB64 = await fileToBase64(file);
    const r = await api("/import/preview", { method: "POST", body: JSON.stringify({ data_b64: _stmtB64 }) });
    if (!r.count) { prev.innerHTML = '<span class="error">Не нашёл транзакций — проверь, что это CSV-выписка.</span>'; return; }
    const skip = (r.internal || 0) + (r.income || 0);
    prev.innerHTML = "Найдено <b>" + r.count + "</b> операций. К импорту: <b>" + r.new + "</b> трат с категориями." +
      (skip ? '<br><span class="muted">Пропущу накопления/переводы и доходы: ' + skip + ".</span>" : "") +
      (r.new === 0 ? " Всё уже импортировано." : "");
    $("#stmtConfirm").hidden = r.new === 0;
  } catch (e) { if (e.message !== "auth") prev.innerHTML = '<span class="error">' + e.message + "</span>"; }
}

async function onStatementConfirm() {
  if (!_stmtB64) return;
  const btn = $("#stmtConfirm");
  btn.disabled = true; btn.textContent = "Импортирую…";
  try {
    const r = await api("/import/confirm", { method: "POST", body: JSON.stringify({ data_b64: _stmtB64 }) });
    toast(`Импортировано: ${r.imported} трат · пропущено внутренних/доходов: ${(r.internal_skipped || 0) + (r.income_skipped || 0)}`, "success");
    _stmtB64 = null;
    await refresh();
    await renderData();
  } catch (e) { if (e.message !== "auth") toast("⚠️ " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Импортировать"; }
}

/* Refresh / boot */
async function refresh() {
  state.summary = await api(`/summary?period=${state.period}&currency=${encodeURIComponent(state.currency)}`);
  $("#chartPeriod").textContent = state.summary.label;
  renderStats(state.summary);
  renderDonut(state.summary);
  renderTrend(state.summary);
  await renderFeed();
  await renderBudgets();
}

async function boot() {
  const cfg = await api("/config");
  state.config = cfg;
  $("#version").textContent = "v" + cfg.version;
  if (cfg.auth_required && !cfg.authed) { showLogin(); return; }
  $("#loginOverlay").classList.add("hidden");

  state.currency = state.currency || cfg.default_currency;
  if (!cfg.currencies.includes(state.currency)) state.currency = cfg.default_currency;
  // селектор валют — если их несколько
  const cs = $("#currency");
  fillSelect(cs, cfg.currencies, state.currency);
  cs.hidden = cfg.currencies.length <= 1;
  cs.onchange = () => { state.currency = cs.value; refresh(); };

  $("#logoutBtn").hidden = !cfg.auth_required;
  renderPeriods();
  await refresh();
}

/* Wire up */
function init() {
  applyTheme(localStorage.getItem("st-theme") || "dark");
  $("#addForm").addEventListener("submit", submitComposer);
  $("#addInput").addEventListener("input", onComposerInput);
  $("#themeToggle").addEventListener("click", toggleTheme);
  $("#dataBtn").addEventListener("click", openData);
  $("#dataClose").addEventListener("click", closeData);
  $("#exportBtn").addEventListener("click", (e) => { e.preventDefault(); doExportCsv(); });
  $("#logoutBtn").addEventListener("click", doLogout);
  $("#loginForm").addEventListener("submit", doLogin);
  $("#editForm").addEventListener("submit", saveEdit);
  $("#editClose").addEventListener("click", closeEdit);
  $("#editDelete").addEventListener("click", () => { if (editing) deleteEntry(editing).then(closeEdit); });
  $("#addBudgetBtn").addEventListener("click", () => openBudget(null, null));
  $("#budgetForm").addEventListener("submit", saveBudget);
  $("#budgetClose").addEventListener("click", closeBudget);
  $("#budgetDelete").addEventListener("click", deleteBudgetCurrent);
  $("#feedKind").addEventListener("change", (e) => { state.feedKind = e.target.value; renderFeed(); });
  document.querySelectorAll(".hint code").forEach((c) => c.addEventListener("click", () => {
    $("#addInput").value = c.textContent; $("#addInput").focus(); onComposerInput();
  }));
  document.querySelectorAll(".overlay").forEach((o) => o.addEventListener("click", (e) => {
    if (e.target === o && o.id !== "loginOverlay" && o.id !== "confirmModal") o.classList.add("hidden");
  }));
  boot().catch((e) => { if (e.message !== "auth") toast("⚠️ " + e.message, "error"); });
}

document.addEventListener("DOMContentLoaded", init);

// PWA: service worker для офлайна и установки (на file:// не регистрируется — там
// и так всё локально; нужен только для PWA по http/https, например на iOS).
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
