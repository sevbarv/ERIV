"""Create a private environment file for a new ERIV installation."""

from getpass import getpass
import json
import os
from pathlib import Path
import re
import secrets

from .auth import derive


def main():
    env = Path(".env")
    if env.exists():
        raise SystemExit("Файл .env уже существует. Для изменения параметров отредактируйте его вручную.")
    password = getpass("Введите начальный пароль администратора: ")
    if not 7 <= len(password) <= 256 or password != getpass("Повторите пароль: "):
        raise SystemExit("Пароли должны совпадать. Допустимая длина от 7 до 256 символов.")
    sheet = input("Ссылка или идентификатор Google Таблицы (Enter, если позже): ").strip()
    match = re.search(r"docs\.google\.com/spreadsheets/d/([A-Za-z0-9_-]+)", sheet)
    sheet = match.group(1) if match else sheet
    if sheet and not re.fullmatch(r"[A-Za-z0-9_-]{15,100}", sheet):
        raise SystemExit("Проверьте ссылку на Google Таблицу.")
    credentials = input("Путь к ключу сервисного аккаунта (Enter, если позже): ").strip()
    if credentials:
        credential_path = Path(credentials).expanduser().resolve()
        if not credential_path.is_file():
            raise SystemExit("Файл ключа не найден.")
        credentials = str(credential_path)
    origin = input("Origin GitHub Pages для CORS (Enter для локального запуска): ").strip().rstrip("/")
    if origin and not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]+)?", origin):
        raise SystemExit("Введите HTTPS origin сайта без пути.")
    salt = secrets.token_bytes(16)
    rows = {
        "ERIV_ADMIN_USER": "Barva19",
        "ERIV_ADMIN_VERIFIER": salt.hex() + ":" + derive(password, salt).hex(),
        "ERIV_SHEET_ID": sheet,
        "GOOGLE_APPLICATION_CREDENTIALS": credentials,
        "ERIV_ALLOWED_ORIGINS": origin,
    }
    descriptor = os.open(env, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as file:
        for key, value in rows.items():
            file.write(f"{key}={json.dumps(value, ensure_ascii=False)}\n")
    print("Параметры записаны в .env. Запустите uvicorn server.app:app --env-file .env")


if __name__ == "__main__":
    main()

