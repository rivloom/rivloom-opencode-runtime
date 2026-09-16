import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
process.chdir(root)
const config = JSON.parse(readFileSync("rivloom/runtime.json", "utf8"))
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim()
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
assert.equal(process.platform, "win32")
assert.equal(process.arch, "x64")
assert.equal(process.versions.node, config.nodeVersion)
const bun = execFileSync("bun", ["--version"], { encoding: "utf8", windowsHide: true }).trim()
assert.equal(bun, config.bun.version)
assert.equal(hash(config.models.file), config.models.sha256, "models snapshot changed; review and update runtime.json")
git("merge-base", "--is-ancestor", config.upstream.commit, "HEAD")
const commit = git("rev-parse", "HEAD")
const status = git("status", "--porcelain=v1", "--untracked-files=all")
const dirty = status.length > 0
if (process.argv.includes("--require-clean")) assert.equal(dirty, false, `Uncommitted inputs:\n${status}`)
const packageVersions = Object.fromEntries(
  [
    ["opencode", "packages/opencode/package.json"],
    ["sdk", "packages/sdk/js/package.json"],
    ["plugin", "packages/plugin/package.json"],
  ].map(([key, file]) => [key, JSON.parse(readFileSync(file, "utf8")).version]),
)
for (const version of Object.values(packageVersions)) assert.equal(version, config.upstream.version)
const version = `${config.upstream.version}-rivloom.${commit.slice(0, 12)}${dirty ? ".dirty" : ""}`
const lockHash = hash("bun.lock")
const env = {
  ...process.env,
  OPENCODE_VERSION: version,
  OPENCODE_CHANNEL: config.channel,
  MODELS_DEV_API_JSON: path.resolve(config.models.file),
}
delete env.OPENCODE_RELEASE
delete env.OPENCODE_BUMP
const result = spawnSync(
  "bun",
  ["run", "packages/opencode/script/build.ts", "--single", "--skip-install", "--skip-embed-web-ui"],
  {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: true,
  },
)
if (result.error) throw result.error
assert.equal(result.status, 0, "Bun build failed")
assert.equal(hash("bun.lock"), lockHash, "Build modified the frozen dependency lock")
const out = path.resolve("rivloom/dist/windows-x64")
mkdirSync(out, { recursive: true })
const exe = path.join(out, "opencode.exe")
copyFileSync("packages/opencode/dist/opencode-windows-x64/bin/opencode.exe", exe)
copyFileSync("LICENSE", path.join(out, "LICENSE"))
copyFileSync("rivloom/README.md", path.join(out, "README.md"))
assert.equal(execFileSync(exe, ["--version"], { encoding: "utf8", windowsHide: true }).trim(), version)
const manifest = {
  schemaVersion: 1,
  version,
  channel: config.channel,
  target: config.target,
  builtAt: new Date().toISOString(),
  source: {
    repository: "https://github.com/rivloom/rivloom-opencode-runtime",
    commit,
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty,
  },
  upstream: config.upstream,
  packageVersions,
  toolchain: { node: process.versions.node, bun, bunArchiveSHA256: config.bun.sha256 },
  inputs: { bunLockSHA256: lockHash, modelsSHA256: config.models.sha256 },
  profile: { embedWebUI: false, signed: false, desktopIntegrated: false },
  binary: { file: "opencode.exe", bytes: readFileSync(exe).length, sha256: hash(exe) },
}
writeFileSync(path.join(out, "runtime-manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
writeFileSync(path.join(out, "SHA256SUMS"), `${manifest.binary.sha256}  opencode.exe\n`)
console.log(JSON.stringify(manifest, null, 2))
