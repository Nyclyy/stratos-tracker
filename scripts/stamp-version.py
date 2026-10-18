"""Stamp the release version into the Python sources.

Usage: python scripts/stamp-version.py 2.1.6

The Electron installer takes its version from package.json, but the simulator
bridge reports its own VERSION constant. Both are stamped from the release tag
by the build workflow so an installed copy can be identified; without this every
build claimed to be 2.1.0.
"""
import pathlib
import re
import sys

TARGETS = [("bridge_logbook_addon.py", r'(?m)^VERSION = "[^"]*"$')]


def main() -> int:
    if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", sys.argv[1]):
        print("usage: stamp-version.py MAJOR.MINOR.PATCH", file=sys.stderr)
        return 2
    version = sys.argv[1]
    for name, pattern in TARGETS:
        path = pathlib.Path(name)
        text = path.read_text(encoding="utf-8")
        updated = re.sub(pattern, f'VERSION = "{version}"', text)
        if updated == text:
            print(f"{name}: VERSION line not found", file=sys.stderr)
            return 1
        path.write_text(updated, encoding="utf-8")
        print(f"{name}: VERSION = {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
