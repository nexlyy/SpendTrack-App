"""Веб-бэкенд SpendTrack — REST API поверх той же базы, что и бот.

Сервер остаётся единственным источником истины: и бот, и веб пишут в один и тот
же SQLite и в одно хранилище заметок через общий сервисный слой. Веб ничего не
дублирует — он переиспользует парсер, storage и service из пакета `spendtrack`.

Запуск:  python -m web.app   (или uvicorn web.app:app)
"""

from __future__ import annotations

import base64
import csv
import io
import secrets
import subprocess
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Cookie, Depends, FastAPI, HTTPException, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from spendtrack import service, statements, storage
from spendtrack.categories import CATEGORY_FORMS, CURRENCY_SYMBOLS, category_names
from spendtrack.config import load_config
from spendtrack.gocardless import GoCardless, GoCardlessError, normalize_transactions
from spendtrack.merchants import categorize, guess_merchant
from spendtrack.parser import ParseError, ParsedEntry, parse_message
from spendtrack.periods import PERIOD_LABELS, period_range

cfg = load_config()
STATIC_DIR = Path(__file__).resolve().parent / "static"

# Инициализируем базы один раз при старте: основную (записи) и веб-состояние
# (бюджеты живут отдельно, чтобы «живое» обновление их не стирало).
_boot = storage.get_connection(cfg.db_path)
storage.init_db(_boot)
_boot.close()
_state = storage.get_connection(cfg.web_state_db)
storage.init_db(_state)
# Перенос старых глобальных бюджетов/банка на владельца (см. storage.migrate_state_db).
storage.migrate_state_db(_state, cfg.web_user_id)
_state.close()

# Серверные сессии в памяти: токен → user_id (в личном режиме это один владелец,
# в многопользовательском — Telegram-id вошедшего).
SESSIONS: dict[str, int] = {}

app = FastAPI(title="SpendTrack Web", version="2.0.0")


# База на запрос и авторизация

def get_db():
    conn = storage.get_connection(cfg.db_path)
    try:
        yield conn
    finally:
        conn.close()


def get_state_db():
    """Соединение с базой веб-состояния (бюджеты) — отдельной от записей."""
    conn = storage.get_connection(cfg.web_state_db)
    try:
        yield conn
    finally:
        conn.close()


def _session_user(token: str | None) -> int | None:
    return SESSIONS.get(token or "")


def _is_authed(token: str | None) -> bool:
    if cfg.multiuser:
        return _session_user(token) is not None
    if not cfg.web_pin:
        return True  # личный режим без PIN — вход не требуется
    return _session_user(token) is not None


def require_auth(st_session: str | None = Cookie(default=None)):
    if not _is_authed(st_session):
        raise HTTPException(status_code=401, detail="Требуется вход")


def current_user(st_session: str | None = Cookie(default=None)) -> int:
    """Id пользователя для запроса: в многопользовательском режиме — из сессии,
    в личном — фиксированный владелец (cfg.web_user_id)."""
    uid = _session_user(st_session)
    if cfg.multiuser:
        if uid is None:
            raise HTTPException(status_code=401, detail="Требуется вход")
        return uid
    if cfg.web_pin and uid is None:
        raise HTTPException(status_code=401, detail="Требуется вход")
    return cfg.web_user_id


def _vault_dir():
    """Папка для .md — None в многопользовательском режиме (без Obsidian)."""
    return None if cfg.multiuser else cfg.records_dir


# Модели запросов

class TextIn(BaseModel):
    text: str


class EntryPatch(BaseModel):
    amount: float | None = None
    currency: str | None = None
    category: str | None = None
    kind: str | None = None
    note: str | None = None
    created_at: str | None = None


class BudgetIn(BaseModel):
    category: str
    monthly_limit: float
    currency: str = "PLN"


class AuthIn(BaseModel):
    pin: str


class CodeIn(BaseModel):
    code: str


class ImportIn(BaseModel):
    data_b64: str  # содержимое файла выписки в base64 (любая кодировка)


class BankLinkIn(BaseModel):
    institution_id: str  # id банка из GoCardless (например PKO_BPKOPLPW)


# Хелперы представления

def row_to_dict(row) -> dict:
    d = dict(row)
    # отдаём наружу только нужное, дату дробим для удобства фронта
    created = str(d.get("created_at", ""))
    date_part, _, time_part = created.partition("T")
    return {
        "id": d["id"],
        "amount": d["amount"],
        "currency": d["currency"],
        "category": d["category"],
        "kind": d["kind"],
        "note": d["note"] or "",
        "place": d.get("place", "—"),
        "created_at": created,
        "date": date_part,
        "time": time_part[:5] if time_part else "",
    }


def _parsed_to_dict(p) -> dict:
    return {
        "amount": p.amount,
        "currency": p.currency,
        "category": p.category,
        "note": p.note,
        "kind": p.kind,
        "backdated": p.backdated,
        "created_at": p.created_at.replace(microsecond=0).isoformat(sep="T"),
    }


def build_summary(conn, period: str, currency: str | None, user_id: int) -> dict:
    since, until, label = period_range(period)
    cat_rows = storage.summary_by_category(conn, user_id, since, until)
    kind_rows = storage.totals_by_kind(conn, user_id, since, until)

    target = currency or cfg.default_currency
    # категории только выбранной валюты — иначе диаграмма смешивала бы деньги
    cats = [r for r in cat_rows if r["currency"] == target]
    cat_total = sum(r["total"] for r in cats) or 0.0
    categories = [
        {
            "category": r["category"],
            "total": round(r["total"], 2),
            "count": r["count"],
            "percent": round(r["total"] / cat_total * 100, 1) if cat_total else 0.0,
        }
        for r in cats
    ]

    def kind_total(kind: str) -> float:
        return round(sum(r["total"] for r in kind_rows
                         if r["kind"] == kind and r["currency"] == target), 2)

    expense_total = kind_total("expense")
    income_total = kind_total("income")
    savings_total = kind_total("savings")

    # другие валюты — подсказка, что есть траты не в основной валюте
    others: dict[str, float] = {}
    for r in cat_rows:
        if r["currency"] != target:
            others[r["currency"]] = round(others.get(r["currency"], 0.0) + r["total"], 2)

    daily = [
        {"day": r["day"], "total": round(r["total"], 2), "count": r["count"]}
        for r in storage.daily_totals(conn, user_id, since, until, currency=target)
    ]

    return {
        "period": period,
        "label": label,
        "since": since.isoformat(sep="T") if since else None,
        "until": until.isoformat(sep="T") if until else None,
        "currency": target,
        "categories": categories,
        "expense_total": expense_total,
        "income_total": income_total,
        "savings_total": savings_total,
        "balance": round(income_total - expense_total, 2),
        "entry_count": sum(r["count"] for r in cats),
        "other_currencies": [{"currency": c, "total": v} for c, v in others.items()],
        "daily": daily,
    }


def pull_remote_snapshot() -> dict:
    """Подтянуть свежую консистентную копию боевой базы по SSH.

    На сервере снимается read-only снимок (SQLite backup, прод не трогается),
    затем скачивается поверх локальной базы. Требует настроенного SSH-алиаса
    (SPENDTRACK_REMOTE) и ключа — то есть это делает машина пользователя его
    же доступом, веб лишь дёргает ssh/scp.
    """
    if not cfg.remote_host:
        return {"ok": False, "error": "Сервер не настроен (SPENDTRACK_REMOTE в .env)."}

    snap = "/tmp/st_web_snap.db"
    py = (
        "import sqlite3\n"
        f"s=sqlite3.connect('file:{cfg.remote_db}?mode=ro',uri=True)\n"
        f"d=sqlite3.connect('{snap}')\n"
        "s.backup(d); d.close(); s.close()\n"
    )
    b64 = base64.b64encode(py.encode()).decode()
    tmp_local = str(cfg.db_path) + ".incoming"
    ssh_opts = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=12"]
    try:
        subprocess.run(["ssh", *ssh_opts, cfg.remote_host, f"echo {b64} | base64 -d | python3"],
                       check=True, capture_output=True, timeout=45)
        subprocess.run(["scp", *ssh_opts, f"{cfg.remote_host}:{snap}", tmp_local],
                       check=True, capture_output=True, timeout=45)
        subprocess.run(["ssh", *ssh_opts, cfg.remote_host, f"rm -f {snap}"],
                       capture_output=True, timeout=20)
    except subprocess.CalledProcessError as exc:
        msg = (exc.stderr or b"").decode("utf-8", "replace").strip()
        return {"ok": False, "error": msg[:300] or "ssh/scp не отработал"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Таймаут соединения с сервером"}
    except FileNotFoundError:
        return {"ok": False, "error": "ssh/scp не найдены в системе"}

    merged = _merge_snapshot(tmp_local)
    try:
        Path(tmp_local).unlink()
    except OSError:
        pass
    return {"ok": True, **merged}


def _merge_snapshot(snapshot_path: str) -> dict:
    """Слить серверный снимок в локальную базу. Серверные записи (id ≤ максимума
    с сервера) заменяются снимком — так подхватываются и добавления, и удаления
    на сервере. Локальные записи (банк/сайт, id от 1 000 000) сохраняются."""
    snap = storage.get_connection(snapshot_path)
    snap_rows = snap.execute("SELECT * FROM entries").fetchall()
    snap.close()
    max_server = max((r["id"] for r in snap_rows), default=0)

    main = storage.get_connection(cfg.db_path)
    storage.init_db(main)
    main.execute("DELETE FROM entries WHERE id <= ?", (max_server,))
    cols = "id,user_id,amount,currency,category,place,kind,note,raw_text,md_path,created_at"
    placeholders = ",".join("?" * 11)
    for r in snap_rows:
        main.execute(
            f"INSERT OR REPLACE INTO entries ({cols}) VALUES ({placeholders})",
            (r["id"], r["user_id"], r["amount"], r["currency"], r["category"],
             r["place"], r["kind"], r["note"], r["raw_text"], r["md_path"], r["created_at"]),
        )
    main.commit()
    storage.ensure_high_ids(main)
    total = main.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
    main.close()
    return {"rows": total, "server": len(snap_rows), "local": total - len(snap_rows)}


def _run_remote_py(py: str, timeout: int = 30) -> dict:
    """Выполнить короткий python-скрипт на сервере по SSH. Скрипт кодируется
    в base64, поэтому кавычки и кириллица в путях не ломаются по дороге."""
    if not cfg.remote_host:
        return {"ok": False, "error": "no remote"}
    b64 = base64.b64encode(py.encode("utf-8")).decode()
    try:
        r = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=12",
             cfg.remote_host, f"echo {b64} | base64 -d | python3"],
            capture_output=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "таймаут соединения с сервером"}
    except FileNotFoundError:
        return {"ok": False, "error": "ssh не найден"}
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or b"").decode("utf-8", "replace")[:300]}
    return {"ok": True, "out": (r.stdout or b"").decode("utf-8", "replace").strip()}


def remote_delete(entry_id: int) -> dict:
    """Удалить запись на сервере: строку в БД и её .md-файл. Без этого удаление,
    сделанное на сайте, синхронизатор притянул бы обратно с сервера."""
    if not cfg.remote_host:
        return {"remote": False}
    py = (
        "import sqlite3, os, glob, re\n"
        f"db = {cfg.remote_db!r}\n"
        f"eid = {int(entry_id)}\n"
        "c = sqlite3.connect(db)\n"
        "row = c.execute('SELECT md_path FROM entries WHERE id=?', (eid,)).fetchone()\n"
        "mp = row[0] if row and row[0] else ''\n"
        "recdir = os.path.dirname(mp) if mp else ''\n"
        "if not recdir:\n"
        "    s = c.execute(\"SELECT md_path FROM entries WHERE md_path<>'' LIMIT 1\").fetchone()\n"
        "    recdir = os.path.dirname(s[0]) if s and s[0] else ''\n"
        "n = c.execute('DELETE FROM entries WHERE id=?', (eid,)).rowcount\n"
        "c.commit(); c.close()\n"
        "ok = False\n"
        "if mp and os.path.exists(mp):\n"
        "    os.remove(mp); ok = True\n"
        "elif recdir and os.path.isdir(recdir):\n"
        "    for f in glob.glob(os.path.join(recdir, '*.md')):\n"
        "        m = re.match(r'^0*(\\d+)[ _.\\-]', os.path.basename(f))\n"
        "        if m and int(m.group(1)) == eid:\n"
        "            os.remove(f); ok = True; break\n"
        "print('rows', n, 'md', ok)\n"
    )
    return {"remote": True, **_run_remote_py(py)}


# Открытые роуты (без авторизации)

open_api = APIRouter(prefix="/api")


@open_api.get("/health")
def health():
    return {"ok": True, "version": app.version}


@open_api.get("/config")
def get_config(st_session: str | None = Cookie(default=None)):
    return {
        "version": app.version,
        "multiuser": cfg.multiuser,
        "bot_username": cfg.bot_username,
        "auth_required": cfg.multiuser or bool(cfg.web_pin),
        "authed": _is_authed(st_session),
        "default_currency": cfg.default_currency,
        "live_refresh": bool(cfg.remote_host) and not cfg.multiuser,
        "bank": True,
        "currencies": list(CURRENCY_SYMBOLS.keys()),
        "currency_symbols": CURRENCY_SYMBOLS,
        "categories": category_names(),
        "category_forms": {k: v for k, v in CATEGORY_FORMS.items()},
        "periods": [{"key": k, "label": v} for k, v in PERIOD_LABELS.items()],
    }


def _start_session(response: Response, user_id: int) -> str:
    token = secrets.token_urlsafe(24)
    SESSIONS[token] = user_id
    response.set_cookie("st_session", token, httponly=True, samesite="lax",
                        max_age=60 * 60 * 24 * 30)
    return token


@open_api.post("/auth")
def auth(data: AuthIn, response: Response):
    """Личный режим: вход по PIN."""
    if cfg.multiuser:
        raise HTTPException(status_code=400, detail="Используйте вход по коду из Telegram")
    if not cfg.web_pin:
        return {"ok": True, "authed": True}
    if not secrets.compare_digest(data.pin, cfg.web_pin):
        raise HTTPException(status_code=401, detail="Неверный PIN")
    _start_session(response, cfg.web_user_id)
    return {"ok": True, "authed": True}


@open_api.post("/auth/telegram")
def auth_telegram(data: CodeIn, response: Response, conn=Depends(get_db)):
    """Многопользовательский вход: одноразовый код из Telegram-бота. Коды бот
    кладёт в основную базу, поэтому гасим их там же."""
    user = storage.redeem_login_code(conn, data.code.strip())
    if user is None:
        raise HTTPException(status_code=401, detail="Код неверный или истёк")
    storage.upsert_user(conn, user["telegram_id"], user["name"])
    _start_session(response, int(user["telegram_id"]))
    return {"ok": True, "authed": True, "name": user["name"]}


@open_api.post("/logout")
def logout(response: Response, st_session: str | None = Cookie(default=None)):
    SESSIONS.pop(st_session or "", None)
    response.delete_cookie("st_session")
    return {"ok": True}


# Защищённые роуты

api = APIRouter(prefix="/api", dependencies=[Depends(require_auth)])


@api.post("/parse-preview")
def parse_preview(data: TextIn):
    """Разобрать строку без сохранения — для живого предпросмотра ввода."""
    try:
        parsed = parse_message(data.text, default_currency=cfg.default_currency)
    except ParseError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "parsed": _parsed_to_dict(parsed)}


@api.post("/entries")
def create_entry(data: TextIn, conn=Depends(get_db), user_id: int = Depends(current_user)):
    try:
        row, parsed = service.add_from_text(
            conn, _vault_dir(), user_id, data.text,
            default_currency=cfg.default_currency,
        )
    except ParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"entry": row_to_dict(row), "backdated": parsed.backdated}


@api.get("/entries")
def list_entries(
    period: str = "month",
    kind: str | None = None,
    limit: int = 500,
    offset: int = 0,
    conn=Depends(get_db),
    user_id: int = Depends(current_user),
):
    since, until, _ = period_range(period)
    kinds = [kind] if kind else None
    rows = storage.list_entries(
        conn, user_id, since, until, kinds=kinds, limit=limit, offset=offset
    )
    return {"entries": [row_to_dict(r) for r in rows]}


@api.get("/summary")
def summary(period: str = "month", currency: str | None = None,
            conn=Depends(get_db), user_id: int = Depends(current_user)):
    return build_summary(conn, period, currency, user_id)


@api.delete("/entries/{entry_id}")
def delete_entry(entry_id: int, conn=Depends(get_db), user_id: int = Depends(current_user)):
    row = storage.get_entry(conn, entry_id)
    if row is None or row["user_id"] != user_id:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    service.remove_entry(conn, _vault_dir(), entry_id)
    # в личном режиме удаляем и на сервере-источнике; в многопользовательском — нет
    remote = remote_delete(entry_id) if not cfg.multiuser else {"remote": False}
    return {"ok": True, "deleted": entry_id, "remote": remote}


@api.patch("/entries/{entry_id}")
def patch_entry(entry_id: int, data: EntryPatch,
                conn=Depends(get_db), user_id: int = Depends(current_user)):
    row = storage.get_entry(conn, entry_id)
    if row is None or row["user_id"] != user_id:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    updated = service.update_entry(
        conn, _vault_dir(), entry_id,
        **{k: v for k, v in data.model_dump().items() if v is not None},
    )
    return {"entry": row_to_dict(updated)}


@api.get("/budgets")
def get_budgets(conn=Depends(get_db), state=Depends(get_state_db),
                user_id: int = Depends(current_user)):
    """Бюджеты-лимиты по категориям и фактический расход за текущий месяц."""
    since, until, _ = period_range("month")
    spent = {
        r["category"]: r["total"]
        for r in storage.summary_by_category(conn, user_id, since, until)
        if r["currency"] == cfg.default_currency
    }
    out = []
    for b in storage.get_budgets(state, user_id):
        used = round(spent.get(b["category"], 0.0), 2)
        limit = b["monthly_limit"]
        out.append({
            "category": b["category"],
            "monthly_limit": limit,
            "currency": b["currency"],
            "spent": used,
            "percent": round(used / limit * 100, 1) if limit else 0.0,
            "over": used > limit,
        })
    return {"budgets": out}


@api.put("/budgets")
def put_budget(data: BudgetIn, state=Depends(get_state_db),
               user_id: int = Depends(current_user)):
    storage.set_budget(state, user_id, data.category, data.monthly_limit, data.currency)
    return {"ok": True}


@api.delete("/budgets/{category}")
def remove_budget(category: str, state=Depends(get_state_db),
                  user_id: int = Depends(current_user)):
    storage.delete_budget(state, user_id, category)
    return {"ok": True}


@api.get("/export.csv")
def export_csv(period: str = "all", conn=Depends(get_db),
               user_id: int = Depends(current_user)):
    since, until, label = period_range(period)
    rows = storage.list_entries(conn, user_id, since, until)
    buf = io.StringIO()
    buf.write("﻿")  # BOM, чтобы Excel открыл кириллицу корректно
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(["id", "дата", "время", "тип", "категория", "сумма", "валюта", "заметка"])
    for r in rows:
        d = row_to_dict(r)
        writer.writerow([d["id"], d["date"], d["time"], d["kind"],
                         d["category"], d["amount"], d["currency"], d["note"]])
    buf.seek(0)
    filename = f"spendtrack-{period}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@api.post("/refresh")
def refresh_from_server():
    """Подтянуть свежую копию боевой базы с сервера (кнопка «Обновить»)."""
    return pull_remote_snapshot()


# Банк (GoCardless): подключение PKO и подтягивание транзакций.

def _gc() -> GoCardless:
    return GoCardless(cfg.gocardless_id, cfg.gocardless_key)


@api.get("/bank/status")
def bank_status(state=Depends(get_state_db), user_id: int = Depends(current_user)):
    link = storage.get_bank_link(state, user_id)
    return {
        "configured": bool(cfg.gocardless_id and cfg.gocardless_key),
        "linked": bool(link and link["account"]),
        "institution": link["institution"] if link else None,
        "last_sync": link["last_sync"] if link else None,
        "imported_total": storage.count_imported(state, user_id),
    }


@api.get("/bank/institutions")
def bank_institutions(country: str = "pl"):
    """Список банков страны для выбора при подключении (PKO/Santander/Erste/…)."""
    if not (cfg.gocardless_id and cfg.gocardless_key):
        raise HTTPException(status_code=400, detail="Не заданы ключи GoCardless в .env")
    try:
        items = _gc().institutions(country)
    except GoCardlessError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    items.sort(key=lambda i: i.get("name", "").lower())
    return {"institutions": [
        {"id": i["id"], "name": i.get("name", i["id"]),
         "bic": i.get("bic", ""), "logo": i.get("logo", "")}
        for i in items
    ]}


@api.post("/bank/link")
def bank_link(data: BankLinkIn, state=Depends(get_state_db),
              user_id: int = Depends(current_user)):
    if not (cfg.gocardless_id and cfg.gocardless_key):
        raise HTTPException(status_code=400, detail="Не заданы ключи GoCardless в .env")
    gc = _gc()
    try:
        inst = gc.institution(data.institution_id)
        # reference содержит user_id — у каждого пользователя своё согласие/requisition
        reference = f"spendtrack-{user_id}-{secrets.token_hex(4)}"
        redirect = cfg.base_url.rstrip("/") + "/?bank=linked"
        req = gc.create_requisition(inst["id"], redirect, reference)
    except GoCardlessError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    storage.set_bank_link(
        state, user_id,
        institution=inst.get("name", data.institution_id),
        inst_id=inst["id"], requisition=req["id"], account="",
    )
    return {"link": req["link"], "institution": inst.get("name")}


@api.post("/bank/finish")
def bank_finish(state=Depends(get_state_db), user_id: int = Depends(current_user)):
    link = storage.get_bank_link(state, user_id)
    req_id = link["requisition"] if link else None
    if not req_id:
        raise HTTPException(status_code=400, detail="Подключение не начато")
    try:
        req = _gc().requisition(req_id)
    except GoCardlessError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    accounts = req.get("accounts") or []
    if not accounts:
        return {"ok": False, "status": req.get("status"), "detail": "Счёт ещё не привязан"}
    storage.set_bank_link(state, user_id, account=accounts[0])
    return {"ok": True, "account": accounts[0]}


def _import_transactions(conn, state, user_id: int, txs: list[dict], source: str = "PKO") -> dict:
    """Создать траты из списка транзакций: дедуп по пользователю, категория по
    магазину, поступления пропускаем. Общая логика для банка и импорта выписки."""
    storage.ensure_high_ids(conn)
    imported = skipped = income_skipped = 0
    for tx in txs:
        if storage.is_tx_imported(state, user_id, tx["id"]):
            skipped += 1
            continue
        if tx["amount"] >= 0:
            income_skipped += 1
            storage.mark_tx_imported(state, user_id, tx["id"], 0)
            continue
        try:
            when = datetime.strptime(tx["date"][:10], "%Y-%m-%d").replace(hour=12)
        except (ValueError, TypeError):
            when = datetime.now().replace(hour=12, minute=0, second=0, microsecond=0)
        parsed = ParsedEntry(
            amount=round(abs(tx["amount"]), 2),
            currency=tx.get("currency") or cfg.default_currency,
            category=categorize(tx["description"]),
            note=guess_merchant(tx["description"]) or tx["description"],
            kind="expense",
            created_at=when,
            raw_text=f"{source} · {tx['description']}",
            backdated=True,
        )
        row = service.add_entry(conn, _vault_dir(), user_id, parsed)
        storage.mark_tx_imported(state, user_id, tx["id"], int(row["id"]))
        imported += 1
    return {"imported": imported, "skipped": skipped,
            "income_skipped": income_skipped, "total": len(txs)}


@api.post("/bank/sync")
def bank_sync(conn=Depends(get_db), state=Depends(get_state_db),
              user_id: int = Depends(current_user)):
    link = storage.get_bank_link(state, user_id)
    account = link["account"] if link else None
    if not account:
        raise HTTPException(status_code=400, detail="Банк не подключён")
    try:
        raw = _gc().transactions(account)
    except GoCardlessError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    source = (link["institution"] if link and link["institution"] else "Банк")
    result = _import_transactions(conn, state, user_id, normalize_transactions(raw), source=source)
    storage.set_bank_link(state, user_id,
                          last_sync=datetime.now().replace(microsecond=0).isoformat(sep="T"))
    return {"ok": True, **result}


# Импорт выписки (CSV) — пока банк не подключён по API.

@api.post("/import/preview")
def import_preview(data: ImportIn, state=Depends(get_state_db),
                   user_id: int = Depends(current_user)):
    try:
        raw = base64.b64decode(data.data_b64)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Не удалось прочитать файл")
    txs = statements.parse_statement(statements.decode_bytes(raw))
    rows = []
    for tx in txs[:1000]:
        expense = tx["amount"] < 0
        rows.append({
            "date": tx["date"],
            "amount": tx["amount"],
            "currency": tx["currency"],
            "description": tx["description"],
            "merchant": guess_merchant(tx["description"]),
            "category": categorize(tx["description"]) if expense else "—",
            "is_expense": expense,
            "already": storage.is_tx_imported(state, user_id, tx["id"]),
        })
    new_expenses = sum(1 for r in rows if r["is_expense"] and not r["already"])
    return {"count": len(txs), "expenses": sum(1 for r in rows if r["is_expense"]),
            "new": new_expenses, "transactions": rows}


@api.post("/import/confirm")
def import_confirm(data: ImportIn, conn=Depends(get_db), state=Depends(get_state_db),
                   user_id: int = Depends(current_user)):
    try:
        raw = base64.b64decode(data.data_b64)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Не удалось прочитать файл")
    txs = statements.parse_statement(statements.decode_bytes(raw))
    if not txs:
        raise HTTPException(status_code=400, detail="В файле не найдено транзакций — проверь формат выписки")
    result = _import_transactions(conn, state, user_id, txs, source="Выписка")
    return {"ok": True, **result}


app.include_router(open_api)
app.include_router(api)


# Статика SPA в самом конце, чтобы не перехватывать /api/*.
@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


def main():
    import uvicorn
    uvicorn.run("web.app:app", host=cfg.web_host, port=cfg.web_port, reload=False)


if __name__ == "__main__":
    main()
