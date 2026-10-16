"""One-shot codemod: append Tailwind `dark:` variants to existing light-only
utility classes across src/**/*.tsx.

Only string literals that look like class lists are touched (ASCII-only tokens,
all matching a class-name charset, containing at least one mapped utility).
Run once; re-running is a no-op because tokens that already carry `dark:` are
skipped.
"""

import re
import sys
from pathlib import Path

# base utility -> its dark-mode counterpart (variant prefixes are preserved)
MAPPING = {
    # ---- backgrounds ----
    "bg-white": "bg-gray-900",
    "bg-white/80": "bg-gray-800/80",
    "bg-gray-50/50": "bg-gray-950",
    "bg-gray-50": "bg-gray-800",
    "bg-gray-100": "bg-gray-800",
    "bg-gray-200": "bg-gray-700",
    "bg-gray-300": "bg-gray-700",
    "bg-gray-400": "bg-gray-600",
    "bg-indigo-50": "bg-indigo-900/30",
    "bg-indigo-50/40": "bg-indigo-900/30",
    "bg-indigo-50/50": "bg-indigo-900/30",
    "bg-indigo-100": "bg-indigo-900/50",
    "bg-rose-50": "bg-rose-900/30",
    "bg-red-50": "bg-red-900/30",
    "bg-green-50": "bg-green-900/30",
    "bg-emerald-50": "bg-emerald-900/30",
    # ---- text ----
    "text-gray-900": "text-gray-100",
    "text-gray-800": "text-gray-200",
    "text-gray-700": "text-gray-300",
    "text-gray-600": "text-gray-400",
    "text-gray-500": "text-gray-400",
    "text-gray-400": "text-gray-500",
    "text-indigo-900": "text-indigo-200",
    "text-indigo-800": "text-indigo-300",
    "text-indigo-700": "text-indigo-300",
    "text-indigo-600": "text-indigo-400",
    "text-indigo-500": "text-indigo-400",
    "text-emerald-700": "text-emerald-400",
    "text-emerald-600": "text-emerald-400",
    "text-green-700": "text-green-400",
    "text-green-600": "text-green-400",
    "text-rose-700": "text-rose-400",
    "text-rose-600": "text-rose-400",
    "text-red-700": "text-red-400",
    "text-red-500": "text-red-400",
    "text-amber-700": "text-amber-400",
    "text-amber-600": "text-amber-400",
    "text-violet-600": "text-violet-400",
    "text-sky-600": "text-sky-400",
    # ---- borders ----
    "border-gray-100": "border-gray-800",
    "border-gray-200": "border-gray-700",
    "border-gray-300": "border-gray-600",
    "border-indigo-100": "border-indigo-900",
    "border-indigo-200": "border-indigo-800",
    "border-indigo-300": "border-indigo-700",
    "border-rose-200": "border-rose-800",
    "border-red-100": "border-red-900",
    "border-green-100": "border-green-900",
    # ---- rings ----
    "ring-indigo-100": "ring-indigo-900",
    "ring-indigo-300": "ring-indigo-700",
    # ---- placeholders ----
    "placeholder-gray-400": "placeholder-gray-500",
    "placeholder-gray-500": "placeholder-gray-400",
}

# Variant prefixes whose base colour must stay as authored (e.g. the white knob
# of a toggle switch reads correctly on both tracks).
SKIP_PREFIXES = {"after", "before", "peer-checked", "checked", "group-open", "open"}

STRING_RE = re.compile(r"'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"")
CLASS_TOKEN_RE = re.compile(r"^[A-Za-z0-9:/\[\]\-.%_()+!&#]+$")


def transform_token(token: str) -> str:
    """Return the token with its dark counterpart appended (if any)."""
    parts = token.split(":")
    base = parts[-1]
    prefixes = parts[:-1]
    if base not in MAPPING:
        return token
    if "dark" in prefixes:
        return token
    if any(p in SKIP_PREFIXES for p in prefixes):
        return token
    return ":".join(["dark", *prefixes, MAPPING[base]])


def transform_literal(literal: str) -> str | None:
    tokens = literal.split()
    if not tokens:
        return None
    # A real class list: ASCII-only, class-ish charset, and at least one mapped
    # utility. Keeps i18n copy and email HTML safe.
    if not all(CLASS_TOKEN_RE.match(t) for t in tokens):
        return None
    if not any(t.split(":")[-1] in MAPPING for t in tokens):
        return None

    out: list[str] = []
    changed = False
    for token in tokens:
        out.append(token)
        dark = transform_token(token)
        if dark != token:
            out.append(dark)
            changed = True
    return " ".join(out) if changed else None


def process_file(path: Path) -> int:
    original = path.read_text(encoding="utf-8")
    hits = 0

    def repl(match: re.Match) -> str:
        nonlocal hits
        quote = "'" if match.group(1) is not None else '"'
        literal = match.group(1) if match.group(1) is not None else match.group(2)
        new = transform_literal(literal)
        if new is None:
            return match.group(0)
        hits += 1
        return f"{quote}{new}{quote}"

    updated = STRING_RE.sub(repl, original)
    if updated != original:
        path.write_text(updated, encoding="utf-8")
    return hits


def main() -> None:
    root = Path(__file__).resolve().parent.parent / "src"
    files = sorted(root.rglob("*.tsx"))
    total = 0
    for f in files:
        n = process_file(f)
        if n:
            print(f"{n:4d}  {f.relative_to(root.parent)}")
        total += n
    print(f"\n{total} class literals updated across {len(files)} files.")
    return 0 if total or "--allow-empty" in sys.argv else 0


if __name__ == "__main__":
    raise SystemExit(main())
