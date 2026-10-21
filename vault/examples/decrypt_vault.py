#!/usr/bin/env python3
"""Independent reader for an opencontext-vault (format 1) directory.

This file is the portability proof for SPEC.md: it was written from SPEC.md
Part B, the Vocabulary entry for canonicalJson and the committed test vectors
(test/vectors/envelope-vectors.json, test/vectors/canonical-json-vectors.json)
only, without consulting the TypeScript sources, and it decrypts and verifies
a vault directory with nothing but the key file.  It needs Python 3.10+ and
`pip install cryptography` (AES-GCM; scrypt comes from hashlib).  It is an
example, not part of the package's test suite: run it against a vault of your
own with

  python3 -I examples/decrypt_vault.py selftest test/vectors/envelope-vectors.json
  python3 -I examples/decrypt_vault.py read --vault-dir ~/.opencontext/vault \
      --key-file ~/.opencontext/vault.key --all-bodies [--passphrase-env VAR]

and compare `--dump out.json` with `opencontext-vault export`.

Usage:
  decrypt_vault.py selftest <envelope-vectors.json>
  decrypt_vault.py read --vault-dir DIR --key-file FILE [--passphrase-env VAR]
                        [--dump OUT.json] [--all-bodies]

`read` loads the key (kdf none or scrypt), checks keyId / keyCheck, replays the
four journals (seq / prev / k / gen / AAD), decrypts the source bodies (one by
default, every one with --all-bodies) and verifies sha256, then prints the
active memories.  Any integrity failure raises Corrupt and exits 2.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import sys
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PREFIX = "opencontext-vault/1"
JOURNALS = {  # file stem -> envelope kind (SPEC B.7)
    "memories": "memory",
    "sources": "source-meta",
    "grants": "grant",
    "audit": "audit",
}
ENVELOPE_KEYS = ["v", "k", "seq", "id", "prev", "iv", "ct", "tag"]


class Corrupt(Exception):
    pass


# ---------------------------------------------------------------- canonicalJson
# SPEC Vocabulary: keys sorted by code point, no whitespace, strings and numbers
# as ECMAScript JSON.stringify.  Numbers need Number::toString(10); Python's
# json.dumps emits "1.0", "1e-07", "1e+21" where JS emits "1", "1e-7", "1e+21".

_SHORT_ESC = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def js_string(s: str) -> str:
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch in _SHORT_ESC:
            out.append(_SHORT_ESC[ch])
        elif o < 0x20 or 0xD800 <= o <= 0xDFFF:  # control chars and lone surrogates
            out.append(f"\\u{o:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def js_number(x: int | float) -> str:
    """ECMAScript Number::toString(10) for a JSON number."""
    if isinstance(x, bool):
        raise TypeError
    if isinstance(x, int):
        if abs(x) <= 2**53:
            return str(x)
        x = float(x)  # JS parsed it as a double
    if math.isnan(x) or math.isinf(x):
        return "null"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    r = repr(abs(x))  # shortest round-trip digits
    if "e" in r:
        mant, exp = r.split("e")
        e = int(exp)
    else:
        mant, e = r, 0
    if "." in mant:
        ip, fp = mant.split(".")
    else:
        ip, fp = mant, ""
    digits = (ip + fp).lstrip("0")
    # n = position of the decimal point relative to the start of `digits`
    n = len(ip) + e
    if not ip.strip("0"):  # ip is "0": leading zeros in fp shift n
        stripped = fp.lstrip("0")
        n = e - (len(fp) - len(stripped))
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    if k <= n <= 21:
        s = digits + "0" * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * (-n) + digits
    else:
        ex = n - 1
        es = ("+" if ex >= 0 else "-") + str(abs(ex))
        s = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + es
    return sign + s


def canonical_json(v: Any) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return js_number(v)
    if isinstance(v, str):
        return js_string(v)
    if isinstance(v, list):
        return "[" + ",".join(canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(js_string(k) + ":" + canonical_json(v[k]) for k in sorted(v)) + "}"
    raise TypeError(type(v))


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# -------------------------------------------------------------------- envelope

def aad(vault_id: str, k: str, gen: str, seq: int, id_: str, prev: str) -> bytes:
    return f"{PREFIX}\n{vault_id}\n{k}\n{gen}\n{seq}\n{id_}\n{prev}".encode("utf-8")


def check_envelope_shape(env: Any, where: str) -> None:
    if not isinstance(env, dict) or list(env.keys()) != ENVELOPE_KEYS:
        raise Corrupt(f"{where}: malformed envelope (keys {list(env) if isinstance(env, dict) else env!r})")
    if env["v"] != 1:
        raise Corrupt(f"{where}: envelope v={env['v']!r}")
    if len(base64.b64decode(env["iv"], validate=True)) != 12:
        raise Corrupt(f"{where}: iv is not 12 bytes")
    if len(base64.b64decode(env["tag"], validate=True)) != 16:
        raise Corrupt(f"{where}: tag is not 16 bytes")


def open_envelope(key: bytes, env: dict, vault_id: str, k: str, gen: str, seq: int, id_: str, prev: str, where: str) -> bytes:
    """Decrypt with the AAD rebuilt from what the reader EXPECTS (SPEC B.4)."""
    check_envelope_shape(env, where)
    if env["k"] != k or env["seq"] != seq or env["id"] != id_ or env["prev"] != prev:
        raise Corrupt(f"{where}: envelope fields disagree with position (k/seq/id/prev)")
    ct = base64.b64decode(env["ct"], validate=True) + base64.b64decode(env["tag"], validate=True)
    try:
        return AESGCM(key).decrypt(base64.b64decode(env["iv"], validate=True), ct, aad(vault_id, k, gen, seq, id_, prev))
    except InvalidTag:
        raise Corrupt(f"{where}: GCM authentication failed (wrong key or tampered)")


# -------------------------------------------------------------------- key file

def load_key(path: str, passphrase: str | None) -> tuple[bytes, dict]:
    with open(path, "rb") as f:
        raw = f.read()
    kf = json.loads(raw)
    if kf.get("format") != "opencontext-vault-key" or kf.get("version") != 1:
        raise Corrupt(f"key file: unexpected format/version {kf.get('format')!r}/{kf.get('version')!r}")
    if kf["kdf"] == "none":
        key = base64.b64decode(kf["key"], validate=True)
    elif kf["kdf"] == "scrypt":
        if passphrase is None:
            raise SystemExit("key file is passphrase-protected: pass --passphrase-env VAR")
        kek = hashlib.scrypt(
            passphrase.encode("utf-8"),
            salt=base64.b64decode(kf["salt"], validate=True),
            n=kf["N"], r=kf["r"], p=kf["p"], dklen=32,
            maxmem=256 * 1024 * 1024,
        )
        try:
            key = open_envelope(kek, kf["wrapped"], kf["vaultId"], "wrap", "", 0, "", "", "key file wrap")
        except Corrupt:
            raise SystemExit("wrong passphrase (GCM authentication of the wrapped key failed)")
    else:
        raise Corrupt(f"key file: unknown kdf {kf['kdf']!r}")
    if len(key) != 32:
        raise Corrupt(f"key file: data key is {len(key)} bytes, not 32")
    if sha256_hex(key)[:16] != kf["keyId"]:
        raise Corrupt("key file: keyId does not match sha256(dataKey)[0:16]")
    return key, kf


# -------------------------------------------------------------------- journals

def read_journal(key: bytes, path: str, vault_id: str, stem: str, expected_gen: str, log, pending_gen: str | None = None) -> tuple[dict, int]:
    kind = JOURNALS[stem]
    with open(path, "rb") as f:
        data = f.read()
    lines = data.split(b"\n")
    unterminated = lines.pop()  # bytes after the final "\n" ("" when the file is well-formed)
    if not lines:
        raise Corrupt(f"{stem}: empty journal (no header)")
    header = json.loads(lines[0])
    if header.get("journal") != stem or header.get("v") != 1:
        raise Corrupt(f"{stem}: bad header {header!r}")
    if header.get("vaultId") != vault_id:
        raise Corrupt(f"{stem}: header vaultId {header.get('vaultId')!r} != manifest {vault_id!r}")
    gen = header.get("gen")
    if not re.fullmatch(r"[0-9a-f]{16}", gen or ""):
        raise Corrupt(f"{stem}: header gen {gen!r} is not 16 hex")
    if gen != expected_gen and gen != pending_gen:
        raise Corrupt(f"{stem}: header gen {gen} != vault.json gens.{stem} {expected_gen} (rolled back or swapped)")
    if gen == pending_gen and gen != expected_gen:
        log(f"{stem}: header gen is the manifest's pending gen (a compaction was interrupted before its manifest write; SPEC B.5)")

    if unterminated:
        log(f"{stem}: unterminated last line ({len(unterminated)} bytes) ignored as a torn write")

    live: dict[str, Any] = {}
    prev = "genesis"
    body = lines[1:]
    for n, line in enumerate(body, start=1):
        where = f"{stem} line {n + 1} (seq {n})"
        is_last = n == len(body)
        try:
            env = json.loads(line)
            check_envelope_shape(env, where)
        except (ValueError, Corrupt) as e:
            if is_last:
                log(f"{where}: undecodable last line ignored as a torn write ({e})")
                break
            raise Corrupt(f"{where}: {e}")
        if env["seq"] != n:
            raise Corrupt(f"{where}: seq {env['seq']} (expected {n})")
        if env["prev"] != prev:
            raise Corrupt(f"{where}: prev chain broken")
        if env["k"] != kind:
            raise Corrupt(f"{where}: k {env['k']!r} (expected {kind!r})")
        pt = open_envelope(key, env, vault_id, kind, gen, n, env["id"], prev, where)
        op = json.loads(pt)
        if op["op"] == "put":
            rec = op["record"]
            if rec["id"] != env["id"]:
                raise Corrupt(f"{where}: put record id {rec['id']} != envelope id {env['id']}")
            live[env["id"]] = rec
        elif op["op"] == "del":
            if op["id"] != env["id"]:
                raise Corrupt(f"{where}: del id {op['id']} != envelope id {env['id']}")
            if stem == "audit":
                raise Corrupt(f"{where}: del in the audit journal")
            live.pop(env["id"], None)
        else:
            raise Corrupt(f"{where}: unknown op {op['op']!r}")
        prev = sha256_hex(line)
    return live, len(body)


def read_body(key: bytes, vault_dir: str, vault_id: str, meta: dict) -> dict:
    sid = meta["id"]
    path = os.path.join(vault_dir, "sources", sid + ".enc")
    with open(path, "rb") as f:
        data = f.read()
    if not data.endswith(b"\n") or data.count(b"\n") != 1:
        raise Corrupt(f"{sid}.enc: expected exactly one newline-terminated line")
    env = json.loads(data[:-1])
    pt = open_envelope(key, env, vault_id, "source-body", "", 0, sid, "", f"{sid}.enc")
    content = json.loads(pt)
    h = sha256_hex(canonical_json(content).encode("utf-8"))
    if h != meta["sha256"]:
        raise Corrupt(f"{sid}: body does not match its record (sha256 {h} != {meta['sha256']})")
    if content.get("kind") != meta.get("kind"):
        raise Corrupt(f"{sid}: body kind {content.get('kind')!r} != meta kind {meta.get('kind')!r}")
    return content


# ------------------------------------------------------------------------ main

def cmd_read(args: list[str]) -> int:
    opts: dict[str, str | None] = {"--vault-dir": None, "--key-file": None, "--passphrase-env": None, "--dump": None}
    flags = {"--all-bodies": False, "--quiet": False}
    i = 0
    while i < len(args):
        a = args[i]
        if a in opts:
            opts[a] = args[i + 1]
            i += 2
        elif a in flags:
            flags[a] = True
            i += 1
        else:
            raise SystemExit(f"unknown arg {a}")
    vault_dir, key_file = opts["--vault-dir"], opts["--key-file"]
    if not vault_dir or not key_file:
        raise SystemExit(__doc__)
    passphrase = os.environ.get(opts["--passphrase-env"]) if opts["--passphrase-env"] else None

    def log(msg: str) -> None:
        print("note:", msg, file=sys.stderr)

    key, kf = load_key(key_file, passphrase)
    with open(os.path.join(vault_dir, "vault.json"), "rb") as f:
        manifest = json.loads(f.read())
    if manifest.get("format") != "opencontext-vault" or manifest.get("version") != 1:
        raise Corrupt("manifest: unexpected format/version")
    vault_id = manifest["vaultId"]
    if not re.fullmatch(r"[0-9a-f]{32}", vault_id):
        raise Corrupt("manifest: vaultId is not 32 hex")
    if kf["vaultId"] != vault_id:
        raise Corrupt(f"key file is for vault {kf['vaultId']}, directory is {vault_id}")
    if manifest["keyId"] != kf["keyId"]:
        raise Corrupt(f"wrong key: manifest keyId {manifest['keyId']} != key file {kf['keyId']}")
    if open_envelope(key, manifest["keyCheck"], vault_id, "check", "", 0, "", "", "manifest keyCheck") != b"ok":
        raise Corrupt("manifest keyCheck plaintext is not 'ok'")
    print(f"vault {vault_id}  keyId {manifest['keyId']}  kdf {kf['kdf']}  keyCheck ok", file=sys.stderr)

    tables: dict[str, dict] = {}
    for stem in JOURNALS:
        live, n = read_journal(key, os.path.join(vault_dir, stem + ".jsonl"), vault_id, stem, manifest["gens"][stem], log,
                               manifest.get("pendingGens", {}).get(stem))
        tables[stem] = live
        print(f"{stem}.jsonl: {n} lines verified, {len(live)} live records", file=sys.stderr)

    sources = tables["sources"]
    bodies: dict[str, dict] = {}
    want = list(sources) if flags["--all-bodies"] else list(sources)[:1]
    for sid in want:
        bodies[sid] = read_body(key, vault_dir, vault_id, sources[sid])
    print(f"bodies: {len(bodies)} decrypted and sha256-verified", file=sys.stderr)
    # every live meta must have a body file (B.8: written before its put)
    for sid in sources:
        if not os.path.exists(os.path.join(vault_dir, "sources", sid + ".enc")):
            raise Corrupt(f"{sid}: live record but no body file")

    if not flags["--quiet"]:
        print("grants:")
        for g in tables["grants"].values():
            print(f"  {g['id']}  {g['label']:<16} scopes={','.join(g['scopes'])} tags={','.join(g.get('tags', []))}")
        print(f"audit: {len(tables['audit'])} entries; last:",
              json.dumps(list(tables["audit"].values())[-1], ensure_ascii=False)[:160] if tables["audit"] else "-")
        print(f"sources: {len(sources)}")
        for sid, body in bodies.items():
            m = sources[sid]
            text = body["text"] if body["kind"] == "document" else " / ".join(t["text"] for t in body["turns"])
            print(f"  {sid}  {m['type']:<9} {m['kind']:<12} {m['title']!r}  body: {text[:80]!r}")
        active = [m for m in tables["memories"].values() if m["status"] == "active"]
        active.sort(key=lambda m: (m["createdAt"], m["id"]))
        print(f"active memories: {len(active)} (of {len(tables['memories'])})")
        for m in active:
            print(f"  {m['id']}  {m['kind']:<12} [{m['confidence']}] {m['statement']}  (by {m['createdBy']}, tags {','.join(m['tags'])}, {len(m['sources'])} sources)")

    if opts["--dump"]:
        out = {
            "memories": sorted(tables["memories"].values(), key=lambda m: (m["createdAt"], m["id"])),
            "sources": sorted(
                [dict(sources[s], content=bodies[s]) for s in bodies],
                key=lambda s: (s["createdAt"], s["id"]),
            ),
            "grants": list(tables["grants"].values()),
            "audit": list(tables["audit"].values()),
        }
        # ensure_ascii: a body may legitimately contain a lone surrogate (JSON.stringify
        # writes it as \udXXX), which cannot be encoded as UTF-8 unescaped.
        with open(opts["--dump"], "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=True, indent=2)
        print(f"dumped to {opts['--dump']}", file=sys.stderr)
    return 0


def cmd_selftest(path: str) -> int:
    with open(path, "rb") as f:
        vec = json.loads(f.read())
    key = bytes.fromhex(vec["keyHex"])
    assert sha256_hex(key)[:16] == vec["keyId"], "keyId"
    for v in vec["vectors"]:
        env = v["envelope"]
        line = v["line"]
        assert json.dumps(env, separators=(",", ":"), ensure_ascii=False) == line, v["name"] + " line serialization"
        assert sha256_hex(line.encode()) == v["lineSha256"], v["name"] + " lineSha256"
        assert aad(v["vaultId"], v["k"], v["gen"], v["seq"], v["id"], v["prev"]).hex() == v["aadHex"], v["name"] + " aad"
        assert base64.b64decode(env["iv"]).hex() == v["ivHex"]
        assert env["ct"] == v["ctBase64"] and env["tag"] == v["tagBase64"]
        pt = open_envelope(key, env, v["vaultId"], v["k"], v["gen"], v["seq"], v["id"], v["prev"], v["name"])
        if "plaintextHex" in v:
            assert pt.hex() == v["plaintextHex"], v["name"]
        else:
            assert pt.decode("utf-8") == v["plaintext"], v["name"]
        print("ok:", v["name"])
    # V2 -> V3 chaining
    v2, v3 = vec["vectors"][1], vec["vectors"][2]
    assert v3["prev"] == sha256_hex(v2["line"].encode())
    # V6 scrypt (SPEC B.12, not in the json file)
    kek = hashlib.scrypt(b"correct horse battery staple", salt=bytes.fromhex("000102030405060708090a0b0c0d0e0f"),
                         n=131072, r=8, p=1, dklen=32, maxmem=256 * 1024 * 1024)
    assert kek.hex() == "1b2946da71f41179e83b99dc33842d15741b87c4121c8c7f3781c1df864fb58b", "scrypt V6"
    print("ok: scrypt V6")
    # js_number sanity against known JSON.stringify outputs
    for x, s in [(1.0, "1"), (1e21, "1e+21"), (1e20, "100000000000000000000"), (1e-7, "1e-7"), (1.5e-7, "1.5e-7"),
                 (0.000001, "0.000001"), (123.456, "123.456"), (-0.0, "0"), (2**53 + 1, "9007199254740992"),
                 (1709000000.123456, "1709000000.123456"), (12345678901234567890, "12345678901234567000"), (0.1, "0.1")]:
        assert js_number(x) == s, (x, js_number(x), s)
    print("ok: js_number")
    return 0


if __name__ == "__main__":
    try:
        if len(sys.argv) >= 3 and sys.argv[1] == "selftest":
            sys.exit(cmd_selftest(sys.argv[2]))
        elif len(sys.argv) >= 2 and sys.argv[1] == "read":
            sys.exit(cmd_read(sys.argv[2:]))
        else:
            raise SystemExit(__doc__)
    except Corrupt as e:
        print("CORRUPT:", e, file=sys.stderr)
        sys.exit(2)
