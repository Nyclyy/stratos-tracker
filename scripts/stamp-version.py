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
    # The web build reports the version from one constant, which Settings, the
    # About card and the update centre all read.
    ("app/js/lib/version.js", r"(?m)^export const APP_VERSION = '[^']*';$", "export const APP_VERSION = '{version}';"),
    # A distinct shell-cache name per release is what tells the service worker
    # a build is an update rather than a first install, so the waiting worker
    # can ask before it takes over.
    ("app/sw.js", r"(?m)^const CACHE = '[^']*';$", "const CACHE = 'stratos-shell-{version}';"),
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
