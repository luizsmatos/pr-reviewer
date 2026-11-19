#!/usr/bin/env python3
# invariant: hits are Pass F candidates, never findings; always exit 0 so a detector cannot block the review.
"""Find code the diff adds that already exists elsewhere in the repo.

Usage: git diff <base> | python3 scan_duplicates.py [--rev <tree-ish>]
Run from inside the repo. Without --rev it searches the working tree.

Three probes per added line (test files and generated files are not probed):
  regex    a regex literal of 8+ chars found verbatim in another place
  line     a substantive line (30+ chars, not import/comment/test call) found verbatim elsewhere
  literals a line with 2+ distinct string literals whose literals co-occur on one line elsewhere
Plus one per added declaration:
  name     a function/const/class name the diff defines that is also defined elsewhere
Hits in the same file as the added line are ignored (usually references, not copies).
Probes with more than MAX_HITS hits are idioms, not duplicates, and are dropped.
"""
import re
import subprocess
import sys

MAX_HITS = 6
FILE_RE = re.compile(r"^\+\+\+ b/(.+)$")
HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")
SKIP_FILE = re.compile(
    r"(\.(test|spec|e2e-spec)\.[jt]sx?$|__tests?__/|/test/|\.md$|\.json$|\.lock$|\.snap$|\.sql$|\.ya?ml$|openapi|generated|dist/)"
)
REGEX_LIT = re.compile(r"(?:^|(?<=[(=,:\[!&|?{;])\s*)/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n\[])+)/[dgimsuy]*")
STRING_LIT = re.compile(r"""(["'`])((?:\\.|(?!\1).){4,})\1""")
DECL = re.compile(
    r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function|\w+\s*=>)|class\s+(\w+)|def\s+(\w+))"
)
TRIVIAL = re.compile(
    r"^([\w.]+,?$|\w+\??: [\w<>\[\]|. ]+[,;]?$|import\b|export \* from|from\s|//|/\*|\*|#|\}|\)|\]|return;|else\b|case\b|it\(|test\(|describe\(|expect\()"
)


def grep(pattern, rev, fixed=True):
    cmd = ["git", "grep", "-n", "-I", "-F" if fixed else "-E", "-e", pattern]
    if rev:
        cmd.append(rev)
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    hits = []
    for row in out.splitlines():
        if rev and row.startswith(rev + ":"):
            row = row[len(rev) + 1 :]
        parts = row.split(":", 2)
        if len(parts) == 3 and parts[1].isdigit():
            hits.append((parts[0], int(parts[1]), parts[2].strip()))
    return hits


def foreign(hits, added, path):
    return [h for h in hits if h[0] != path and (h[0], h[1]) not in added and not SKIP_FILE.search(h[0])]


def report(path, line, probe, content, hits, seen):
    hits = [h for h in hits if (path, probe, h[0], h[1]) not in seen]
    if not hits or len(hits) > MAX_HITS:
        return 0
    for h in hits:
        seen.add((path, probe, h[0], h[1]))
    where = ", ".join(f"{h[0]}:{h[1]}" for h in hits[:3])
    more = f" (+{len(hits) - 3})" if len(hits) > 3 else ""
    print(f"{path}:{line}\t{probe}\t{content[:120]}\t=> {where}{more}")
    return 1


def main():
    rev = None
    if "--rev" in sys.argv:
        rev = sys.argv[sys.argv.index("--rev") + 1]
    added_lines = []
    path, new_line = None, 0
    for raw in sys.stdin:
        line = raw.rstrip("\n")
        m = FILE_RE.match(line)
        if m:
            path = m.group(1)
            continue
        m = HUNK_RE.match(line)
        if m:
            new_line = int(m.group(1))
            continue
        if path is None or line.startswith(("---", "\\")):
            continue
        if line.startswith("+"):
            added_lines.append((path, new_line, line[1:]))
            new_line += 1
        elif not line.startswith("-"):
            new_line += 1

    added = {(p, n) for p, n, _ in added_lines}
    seen, count = set(), 0
    for p, n, content in added_lines:
        if SKIP_FILE.search(p):
            continue
        text = content.strip()
        for rx in REGEX_LIT.findall(text):
            if len(rx) >= 8:
                count += report(p, n, "regex", text, foreign(grep(rx, rev), added, p), seen)
        if len(text) >= 30 and not TRIVIAL.match(text):
            needle = text.rstrip(";,")
            count += report(p, n, "line", text, foreign(grep(needle, rev), added, p), seen)
        literals = sorted({s for _, s in STRING_LIT.findall(text)})
        if len(literals) >= 2:
            hits = [h for h in foreign(grep(literals[0], rev), added, p) if all(s in h[2] for s in literals[1:])]
            count += report(p, n, "literals", text, hits, seen)
        d = DECL.match(content)
        name = d and next((g for g in d.groups() if g), None)
        if name and len(name) >= 5:
            defn = rf"(function\s+{name}\b|(const|let)\s+{name}\s*=|class\s+{name}\b|def\s+{name}\b)"
            count += report(p, n, "name", text, foreign(grep(defn, rev, fixed=False), added, p), seen)
    print(f"scan: {count} duplicate candidate(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
