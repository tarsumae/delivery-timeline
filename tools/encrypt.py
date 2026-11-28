#!/usr/bin/env python3
"""Encrypt a delivery timeline JSON file for the browser.

The password is read from the TIMELINE_PASSWORD environment variable.
It is never taken from argv and never printed.

Writes data/timeline.enc.json next to the repository root:

    {
      "v": 1,
      "kdf": "PBKDF2-SHA256",
      "iter": 210000,
      "salt": "<base64, 16 bytes>",
      "iv": "<base64, 12 bytes>",
      "ct": "<base64, AES-GCM ciphertext with the 16-byte tag appended>"
    }

The key is PBKDF2-SHA256 of the UTF-8 password, 32 bytes, with a random
salt. AES-256-GCM uses a random 12-byte IV and no additional data.
"""

from __future__ import annotations

import base64
import json
import os
import sys
from datetime import date
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ITERATIONS = 210_000
SALT_LEN = 16
IV_LEN = 12
KEY_LEN = 32
LABELS = {"야간": "야간 (새벽)", "주간": "주간 (저녁)"}

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "data" / "timeline.enc.json"


def fail(message: str, code: int = 1) -> int:
    print(message, file=sys.stderr)
    return code


def require(cond: bool, message: str) -> None:
    if not cond:
        raise ValueError(message)


def as_number(value, message: str) -> float:
    require(isinstance(value, (int, float)) and not isinstance(value, bool), message)
    number = float(value)
    require(number == number and abs(number) != float("inf"), message)
    return number


def validate_stop(stop, where: str) -> None:
    require(isinstance(stop, dict), f"{where} must be an object")
    for key in ("t", "lat", "lon", "road", "jibun"):
        require(key in stop, f"{where} missing {key}")
    require(isinstance(stop["t"], str) and len(stop["t"]) == 5, f"{where} bad t")
    hh, sep, mm = stop["t"][0:2], stop["t"][2], stop["t"][3:5]
    require(sep == ":" and hh.isdigit() and mm.isdigit(), f"{where} bad t")
    require(0 <= int(hh) <= 23 and 0 <= int(mm) <= 59, f"{where} bad t")
    lat = as_number(stop["lat"], f"{where} bad lat")
    lon = as_number(stop["lon"], f"{where} bad lon")
    require(-90 <= lat <= 90, f"{where} bad lat")
    require(-180 <= lon <= 180, f"{where} bad lon")
    require(isinstance(stop["road"], str), f"{where} road must be a string")
    require(isinstance(stop["jibun"], str), f"{where} jibun must be a string")
    if "name" in stop and stop["name"] is not None:
        require(isinstance(stop["name"], str), f"{where} name must be a string")


def validate_path(path, where: str) -> None:
    if path is None or path == []:
        return
    require(isinstance(path, list) and len(path) >= 2, f"{where} path needs 2 points")
    for i, pair in enumerate(path):
        require(isinstance(pair, (list, tuple)) and len(pair) == 2, f"{where} path[{i}]")
        lat = as_number(pair[0], f"{where} path[{i}] lat")
        lon = as_number(pair[1], f"{where} path[{i}] lon")
        require(-90 <= lat <= 90 and -180 <= lon <= 180, f"{where} path[{i}]")


def validate(data) -> int:
    require(isinstance(data, dict) and isinstance(data.get("days"), list), "days must be a list")
    require(len(data["days"]) >= 1, "days is empty")
    seen = set()
    for d_i, day in enumerate(data["days"]):
        where = f"days[{d_i}]"
        require(isinstance(day, dict), f"{where} must be an object")
        raw_date = day.get("date")
        require(isinstance(raw_date, str) and len(raw_date) == 10, f"{where} bad date")
        year, month, day_n = raw_date.split("-")
        require(year.isdigit() and month.isdigit() and day_n.isdigit(), f"{where} bad date")
        date(int(year), int(month), int(day_n))
        require(raw_date not in seen, f"{where} duplicate date")
        seen.add(raw_date)
        shifts = day.get("shifts")
        require(isinstance(shifts, list) and len(shifts) >= 1, f"{where} shifts")
        for s_i, shift in enumerate(shifts):
            loc = f"{where}.shifts[{s_i}]"
            require(isinstance(shift, dict), f"{loc} must be an object")
            kind = shift.get("kind")
            require(kind in LABELS, f"{loc} bad kind")
            require(shift.get("label") == LABELS[kind], f"{loc} bad label")
            stops = shift.get("stops")
            require(isinstance(stops, list) and len(stops) >= 1, f"{loc} stops")
            for p_i, stop in enumerate(stops):
                validate_stop(stop, f"{loc}.stops[{p_i}]")
            if "path" in shift:
                validate_path(shift.get("path"), loc)
    return len(data["days"])


def encrypt(plaintext: bytes, password: str) -> dict:
    salt = os.urandom(SALT_LEN)
    iv = os.urandom(IV_LEN)
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_LEN,
        salt=salt,
        iterations=ITERATIONS,
    )
    key = kdf.derive(password.encode("utf-8"))
    ct = AESGCM(key).encrypt(iv, plaintext, None)
    return {
        "v": 1,
        "kdf": "PBKDF2-SHA256",
        "iter": ITERATIONS,
        "salt": base64.b64encode(salt).decode("ascii"),
        "iv": base64.b64encode(iv).decode("ascii"),
        "ct": base64.b64encode(ct).decode("ascii"),
    }


def main() -> int:
    if len(sys.argv) != 2:
        return fail(
            "usage: TIMELINE_PASSWORD=... python3 tools/encrypt.py plain.json",
            2,
        )
    password = os.environ.get("TIMELINE_PASSWORD")
    if password is None or password == "":
        return fail("TIMELINE_PASSWORD is not set", 2)
    src = Path(sys.argv[1])
    if not src.is_file():
        return fail(f"file not found: {src}")
    raw = src.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        return fail("plaintext must be UTF-8 without a BOM")
    try:
        data = json.loads(raw.decode("utf-8"))
        days = validate(data)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        return fail(f"invalid plaintext: {exc}")
    payload = encrypt(raw, password)
    DEST.parent.mkdir(parents=True, exist_ok=True)
    tmp = DEST.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, DEST)
    print(f"wrote data/timeline.enc.json ({days} days)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        raise SystemExit(1)
