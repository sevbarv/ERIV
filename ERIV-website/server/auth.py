"""Password verification and short-lived, in-memory administrator sessions."""

from collections import defaultdict, deque
from getpass import getpass
from hashlib import scrypt
from hmac import compare_digest
import os
import secrets
from threading import Lock
from time import monotonic

from fastapi import HTTPException, Request


ADMIN_USER = os.getenv("ERIV_ADMIN_USER", "Barva19")
SESSION_SECONDS = 60 * 60
ATTEMPT_WINDOW = 15 * 60
MAX_FAILURES = 8
MAX_GLOBAL_FAILURES = 64
sessions = {}
failures = defaultdict(deque)
lock = Lock()


def derive(password, salt):
    return scrypt(password.encode("utf-8"), salt=salt, n=2**17, r=8, p=1, maxmem=256*1024*1024)


def verifier():
    try:
        salt, digest = map(bytes.fromhex, os.getenv("ERIV_ADMIN_VERIFIER", "").split(":"))
    except ValueError:
        return None
    return (salt, digest) if len(salt) == 16 and len(digest) == 64 else None


def login(username, password, ip):
    configured = verifier()
    if not configured:
        raise HTTPException(503, "Сначала настройте учётную запись на сервере ERIV.")
    with lock:
        now = monotonic()
        for key, events in list(failures.items()):
            while events and events[0] <= now - ATTEMPT_WINDOW:
                events.popleft()
            if not events:
                del failures[key]
        this_ip = failures.get(ip, ())
        if len(this_ip) >= MAX_FAILURES or sum(map(len, failures.values())) >= MAX_GLOBAL_FAILURES:
            raise HTTPException(429, "Слишком много попыток входа. Повторите через 15 минут.")
        salt, digest = configured
        user_ok = compare_digest(username.encode("utf-8"), ADMIN_USER.encode("utf-8"))
        password_ok = compare_digest(derive(password, salt), digest)
        if not (user_ok and password_ok):
            failures[ip].append(now)
            raise HTTPException(401, "Проверьте логин и пароль.")
        failures.pop(ip, None)
        for token, expiry in list(sessions.items()):
            if expiry <= now:
                del sessions[token]
        if len(sessions) >= 64:
            sessions.pop(next(iter(sessions)))
        token = secrets.token_urlsafe(32)
        sessions[token] = now + SESSION_SECONDS
        return token


def authorized(request: Request):
    prefix, _, token = request.headers.get("authorization", "").partition(" ")
    if prefix.lower() != "bearer":
        token = ""
    with lock:
        expiry = sessions.get(token)
        if expiry and expiry > monotonic():
            return token
        sessions.pop(token, None)
    raise HTTPException(401, "Войдите в админ-панель.")


def logout(token):
    with lock:
        sessions.pop(token, None)


def main():
    password = getpass("Пароль администратора ERIV: ")
    confirmation = getpass("Повторите пароль: ")
    if password != confirmation or not 7 <= len(password) <= 256:
        raise SystemExit("Пароли должны совпадать. Допустимая длина от 7 до 256 символов.")
    salt = secrets.token_bytes(16)
    print(f"ERIV_ADMIN_VERIFIER={salt.hex()}:{derive(password, salt).hex()}")


if __name__ == "__main__":
    main()

