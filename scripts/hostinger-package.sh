#!/usr/bin/env bash
# The bundle for Hostinger's Node.js web hosting (docs/HOSTINGER.md): the source the app
# needs, with a package.json whose "build" is scripts/hostinger-build.mjs and whose build
# tools are ordinary dependencies, a lock file to match, and HOSTINGER.md.
#
#   bash scripts/hostinger-package.sh [out-dir]       (default: .hostinger)
#
# Writes <out-dir>/app, the folder the "Hostinger" workflow deploys, and
# <out-dir>/clinicmind-hostinger.zip, the same folder zipped for hPanel's upload.
# Takes the files git knows (committed or not, never ignored ones such as .env).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
OUT=${1:-.hostinger}
case "$OUT" in /*) ;; *) OUT="$ROOT/$OUT" ;; esac
[ "$OUT" != "/" ] && [ "$OUT" != "$ROOT" ] || { echo "Choose an output folder other than / and the repository itself" >&2; exit 1; }
APP="$OUT/app"
ZIP="$OUT/clinicmind-hostinger.zip"
rm -rf "$APP" "$ZIP"
mkdir -p "$APP"

echo "▶ Source"
# Left out: tests, the click-through prototype, docs, CI and Docker files, and the other
# scripts; tsconfig type-checks every .ts file there is, so test files would need the test tools.
git ls-files -co --exclude-standard -z | grep -zv -E \
  '^(\.github|demo|docs|deploy|e2e|src/test)/|(^|/)__tests__/|\.(test|spec)\.tsx?$|^(Dockerfile|docker-compose.*\.yml|\.dockerignore|\.env\.example|\.gitignore|AGENTS\.md|README\.md|eslint\.config\.mjs|playwright\.config\.ts|vitest\.config\.mts)$|^scripts/' \
  | tar -c --null -T - -f - | tar -x -C "$APP"
mkdir -p "$APP/scripts"
cp scripts/hostinger-build.mjs scripts/db-app-role.ts "$APP/scripts/"
cp docs/HOSTINGER.md "$APP/HOSTINGER.md"

echo "▶ package.json: the Hostinger build, build tools as dependencies"
node - "$APP/package.json" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
// Test and lint tools stay behind; whatever builds the app is a dependency, so it is
// installed whether or not the host installs devDependencies.
const testOnly = new Set(["@playwright/test", "eslint", "eslint-config-next", "prettier", "vitest"]);
const deps = { ...pkg.dependencies };
for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) if (!testOnly.has(name)) deps[name] = version;
pkg.dependencies = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
delete pkg.devDependencies;
pkg.scripts = { build: "node scripts/hostinger-build.mjs", start: "next start" };
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
NODE

echo "▶ Prisma engines for the Linux builds Hostinger may run on"
node - "$APP/prisma/schema.prisma" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const schema = fs.readFileSync(file, "utf8");
const next = schema.replace(/(generator client \{\n\s*provider\s*=\s*"prisma-client-js"\n)/, `$1  binaryTargets   = ["native", "debian-openssl-3.0.x", "rhel-openssl-1.1.x", "rhel-openssl-3.0.x"]\n`);
if (next === schema) throw new Error("schema.prisma: the generator block was not found");
fs.writeFileSync(file, next);
NODE

echo "▶ package-lock.json to match"
(cd "$APP" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund --loglevel=error)

echo "▶ Zip"
(cd "$APP" && zip -qr -X "$ZIP" .)
echo "✓ $APP"
echo "✓ $ZIP ($(du -h "$ZIP" | cut -f1))"
