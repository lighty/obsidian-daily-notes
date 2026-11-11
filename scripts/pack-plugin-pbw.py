#!/usr/bin/env python3
"""Package this plugin-only project into a .pbw without the Pebble SDK.

The released pebble-tool cannot build plugin-only projects yet. A plugin pbw has no watch binary:
it is a zip holding appinfo.json (generated from package.json's `pebble` block) plus the plugin
script and the settings page that block names.

    python3 scripts/pack-plugin-pbw.py [project-dir]

Writes <project-dir>/build/<name>.pbw.
"""

import json
import os
import sys
import zipfile


def appinfo_for(pkg):
    pebble = dict(pkg.get("pebble") or {})
    if not pebble.get("uuid"):
        sys.exit("package.json: pebble.uuid is required")
    if not isinstance(pebble.get("plugin"), dict) or not pebble["plugin"].get("script"):
        sys.exit("package.json: pebble.plugin.script is required")
    name = pebble.get("displayName") or pkg["name"]
    pebble.setdefault("shortName", name)
    pebble.setdefault("longName", name)
    pebble.setdefault("companyName", pkg.get("author", ""))
    pebble.setdefault("versionLabel", pkg.get("version", "1.0.0"))
    pebble.setdefault("sdkVersion", "3")
    pebble.setdefault("resources", {"media": []})
    pebble.setdefault("watchapp", {"watchface": False})
    pebble["manifestVersion"] = 2
    return pebble


def bundled_files(appinfo):
    files = [appinfo["plugin"]["script"]]
    page = appinfo.get("configPage")
    if isinstance(page, str) and not page.startswith(("http://", "https://")):
        files.append(page)
    return files


def main():
    project = sys.argv[1] if len(sys.argv) > 1 else "."
    with open(os.path.join(project, "package.json"), encoding="utf-8") as f:
        pkg = json.load(f)
    appinfo = appinfo_for(pkg)
    out = os.path.join(project, "build", pkg["name"] + ".pbw")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("appinfo.json", json.dumps(appinfo, indent=2))
        for rel in bundled_files(appinfo):
            src = os.path.join(project, rel)
            if not os.path.isfile(src):
                sys.exit(f"{rel} is named in package.json but does not exist")
            z.write(src, rel)
            print(f"added {rel}")
    print(f"packaged {out}")


if __name__ == "__main__":
    main()
