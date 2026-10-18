"""Stamp the release version into the Python and app sources.

Usage: python scripts/stamp-version.py 2.1.6

The Electron installer takes its version from package.json, but the simulator
bridge reports its own VERSION constant and the Settings page prints a literal
version tag. Both are stamped from the release tag by the build workflow so an
installed copy can be identified; without this every build claimed to be 2.1.0.
"""
import pathlib
import re
import sys

# Each target: file, pattern, replacement template (receives {version}).
TARGETS = [
    ("bridge_logbook_addon.py", r'(?m)^VERSION = "[^"]*"$', 'VERSION = "{version}"'),
    (
        "app/js/pilot/settings.js",
        r'(<strong>Stratos</strong><span class="tag">)v\d+\.\d+\.\d+(</span>)',
        r'\g<1>v{version}\g<2>',
    ),
]


def main() -> int:
    if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", sys.argv[1]):
        print("usage: stamp-version.py MAJOR.MINOR.PATCH", file=sys.stderr)
        return 2
    version = sys.argv[1]
    for name, pattern, template in TARGETS:
        path = pathlib.Path(name)
        text = path.read_text(encoding="utf-8")
        if not re.search(pattern, text):
            print(f"{name}: version marker not found", file=sys.stderr)
            return 1
        updated = re.sub(pattern, template.format(version=version), text)
        path.write_text(updated, encoding="utf-8")
        print(f"{name}: {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
