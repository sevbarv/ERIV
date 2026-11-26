"""Google Sheets storage for the 43 fields of the workbook's employee registry."""

from datetime import date, timedelta
from functools import lru_cache
import json
import math
import os
from pathlib import Path
import re
from threading import Lock
from urllib.parse import quote

from fastapi import HTTPException


SCHEMA = json.loads(Path(__file__).with_name("schema.json").read_text(encoding="utf-8"))
KEYS = [field["key"] for field in SCHEMA["fields"]]
FEATURE_FORMAT = {feature["key"]: feature["format"] for feature in SCHEMA["features"]}
DAYS = {"decision_date", "features_date", "outcome_end"}
BINARY = {"executed", "outcome_known", "exit_horizon"}
CODE_FIELDS = {"company", "analysis", "person", "context_id", "treatment"}
RANGES = {"число ≥0": (0, math.inf), "балл 1–5": (1, 5), "балл 0–10": (0, 10),
          "0/1": (0, 1), "доля": (0, 1), "отклонение": (-math.inf, math.inf)}
SHEET_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{15,100}")
write_lock = Lock()


def clean_row(data):
    normalized = {}
    for key in KEYS:
        value = data.get(key)
        if value is None or isinstance(value, str) and not value.strip():
            normalized[key] = None
            continue
        try:
            if key in DAYS:
                if isinstance(value, (int, float)) and not isinstance(value, bool) and value == int(value):
                    value = (date(1899, 12, 30) + timedelta(days=int(value))).isoformat()
                if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
                    raise ValueError
            elif key in BINARY or key == "horizon_months" or FEATURE_FORMAT.get(key) in RANGES:
                if isinstance(value, bool):
                    raise ValueError
                value = float(str(value).strip().replace(",", "."))
                lo, hi = RANGES.get(FEATURE_FORMAT.get(key), (0, 1) if key in BINARY else (1, 36))
                if not math.isfinite(value) or not lo <= value <= hi:
                    raise ValueError
                if key in BINARY or key == "horizon_months" or FEATURE_FORMAT.get(key) == "0/1":
                    if not value.is_integer():
                        raise ValueError
                    value = int(value)
            else:
                if not isinstance(value, (str, int, float)) or isinstance(value, bool):
                    raise ValueError
                value = str(value).strip()
                if len(value) > 120 or re.search(r"[\x00-\x1f]", value):
                    raise ValueError
                if key in CODE_FIELDS and (len(value) > 80 or re.search(r"^[=+@\-]|[|*?~]", value)):
                    raise ValueError
        except (ValueError, OverflowError, TypeError) as exc:
            raise ValueError(f"Проверьте поле «{next(field['label'] for field in SCHEMA['fields'] if field['key'] == key)}».") from exc
        normalized[key] = value
    for key in ("company", "analysis", "person", "decision_date", "features_date", "horizon_months"):
        if normalized[key] is None:
            raise ValueError("Для записи заполните ключ случая, дату замера и горизонт.")
    if normalized["features_date"] > normalized["decision_date"]:
        raise ValueError("Дата замера должна быть не позже даты решения.")
    if normalized["kind"] == "Профиль":
        if any(normalized[key] is not None for key in (*BINARY, "outcome_end", "treatment")):
            raise ValueError("У текущего профиля поля назначения и исхода должны быть пустыми.")
    elif normalized["kind"] == "История":
        if not normalized["treatment"]:
            raise ValueError("Для истории укажите код меры или BAU.")
        end = normalized["outcome_end"]
        if end is not None and end < normalized["decision_date"]:
            raise ValueError("Конец наблюдения не может быть раньше решения.")
        if normalized["outcome_known"] == 1 and (end is None or normalized["exit_horizon"] is None):
            raise ValueError("Для известного исхода заполните конец наблюдения и добровольный уход.")
        if normalized["outcome_known"] != 1 and normalized["exit_horizon"] is not None:
            raise ValueError("Оставьте добровольный уход пустым при неизвестном исходе.")
    else:
        raise ValueError("Выберите «Профиль» или «История».")
    return normalized


def row_key(row):
    return tuple(str(row[k]).casefold() for k in ("company", "analysis", "person", "decision_date", "horizon_months"))


def spreadsheet_id():
    value = os.getenv("ERIV_SHEET_ID", "").strip()
    return value if SHEET_ID_PATTERN.fullmatch(value) else None


def configured():
    return bool(spreadsheet_id() and (os.getenv("GOOGLE_APPLICATION_CREDENTIALS") or os.getenv("ERIV_USE_GOOGLE_ADC") == "1"))


def spreadsheet_url():
    key = spreadsheet_id()
    return f"https://docs.google.com/spreadsheets/d/{key}/edit" if key else None


@lru_cache(maxsize=1)
def google_session():
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    scope = ["https://www.googleapis.com/auth/spreadsheets"]
    credentials, _ = google.auth.default(scopes=scope)
    return AuthorizedSession(credentials)


def call(method, a1, *, params=None, data=None, append=False):
    if not configured():
        raise HTTPException(503, "Подключите Google Таблицы на сервере ERIV.")
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id()}/values/{quote(a1, safe='')}"
    if append:
        url += ":append"
    try:
        response = google_session().request(method, url, params=params, json=data, timeout=20)
        response.raise_for_status()
        return response.json()
    except Exception as exc:
        raise HTTPException(502, "Проверьте доступ сервера к Google Таблице «Сотрудники».") from exc


def list_rows():
    result = call("GET", "'Сотрудники'!A5:AQ", params={"valueRenderOption": "UNFORMATTED_VALUE", "dateTimeRenderOption": "SERIAL_NUMBER"})
    values = result.get("values", [])
    if not values or values[0] != KEYS:
        raise HTTPException(409, "Строка 5 Google Таблицы должна содержать 43 ключа из шаблона ERIV.")
    rows = []
    seen = set()
    for row_number, values_row in enumerate(values[1:], 6):
        if not any(value not in (None, "") for value in values_row):
            continue
        try:
            row = clean_row(dict(zip(KEYS, values_row)))
        except ValueError as exc:
            raise HTTPException(409, f"Строка {row_number} в Google Таблице. {exc}") from exc
        key = row_key(row)
        if key in seen:
            raise HTTPException(409, f"Строка {row_number} в Google Таблице повторяет ключ случая.")
        seen.add(key)
        rows.append(row)
    return rows


def append_entry(data):
    try:
        clean = clean_row(data)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    with write_lock:
        for existing in list_rows():
            if row_key(existing) == row_key(clean):
                if existing == clean:
                    return existing, False
                raise HTTPException(409, "В Google Таблице есть другой сотрудник или замер с таким ключом.")
        values = [[clean[key] if clean[key] is not None else "" for key in KEYS]]
        call("POST", "'Сотрудники'!A5:AQ", params={"valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS"},
             data={"values": values, "majorDimension": "ROWS"}, append=True)
        return clean, True

