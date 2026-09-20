import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { sourceGit, json, publishDirectory, safeDirectory, sha256, sourceInventory, writeChecksums } from "./artifact.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
process.chdir(root)
const config = JSON.parse(readFileSync("rivloom/runtime.json", "utf8"))
const git = (...args) => sourceGit(root, ...args).trim()
const hash = sha256
assert.equal(process.platform, "win32")
assert.equal(process.arch, "x64")
assert.equal(process.versions.node, config.nodeVersion)
const bun = execFileSync("bun", ["--version"], { encoding: "utf8", windowsHide: true }).trim()
assert.equal(bun, config.bun.version)
assert.equal(hash(config.models.file), config.models.sha256, "models snapshot changed; review and update runtime.json")
git("merge-base", "--is-ancestor", config.upstream.commit, "HEAD")
const source = sourceInventory(root, process.argv.includes("--require-clean"))
const commit = source.commit
const dirty = source.dirty
const dist = path.join(root, "rivloom/dist")
const outputFlag = process.argv.indexOf("--out")
if (outputFlag !== -1) assert.ok(process.argv[outputFlag + 1], "--out requires a directory")
const out = safeDirectory(dist, path.resolve(outputFlag === -1 ? "rivloom/dist/windows-x64" : process.argv[outputFlag + 1]))
assert.equal(path.dirname(out), dist, "Build output must be a direct child of rivloom/dist")
assert.ok(/^[a-z0-9][a-z0-9.-]*$/i.test(path.basename(out)) && !["archive", "verification"].includes(path.basename(out).toLowerCase()), "Reserved artifact output directory")
safeDirectory(path.join(root, "packages/opencode"), path.join(root, "packages/opencode/dist"))
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
assert.deepEqual(sourceInventory(root), source, "Source inputs changed while compiling; do not publish this candidate")
const stage = safeDirectory(dist, path.join(dist, `.stage-${randomUUID()}`))
mkdirSync(stage, { recursive: true })
const exe = path.join(stage, "opencode.exe")
copyFileSync("packages/opencode/dist/opencode-windows-x64/bin/opencode.exe", exe)
copyFileSync("LICENSE", path.join(stage, "LICENSE"))
copyFileSync("rivloom/README.md", path.join(stage, "README.md"))
writeFileSync(path.join(stage, "source-files.json"), json(source))
assert.equal(execFileSync(exe, ["--version"], { encoding: "utf8", windowsHide: true }).trim(), version)
const manifest = {
  schemaVersion: 2,
  version,
  channel: config.channel,
  target: config.target,
  builtAt: new Date().toISOString(),
  source: {
    repository: "https://github.com/rivloom/rivloom-opencode-runtime",
    commit,
    tree: source.tree,
    dirty,
    inventory: { file: "source-files.json", sha256: hash(path.join(stage, "source-files.json")), files: source.files.length },
  },
  upstream: config.upstream,
  packageVersions,
  toolchain: { node: process.versions.node, bun, bunArchiveSHA256: config.bun.sha256,
    bunExecutableSHA256: hash(commandExecutable("bun")), nodeExecutableSHA256: hash(process.execPath) },
  inputs: { bunLockSHA256: lockHash, modelsSHA256: config.models.sha256,
    files: Object.fromEntries(["rivloom/runtime.json", "rivloom/build.ps1", "rivloom/build.mjs", "rivloom/artifact.mjs", "rivloom/smoke.mjs", "packages/opencode/script/build.ts"]
      .map((file) => [file, hash(file)])) },
  profile: { embedWebUI: false, signed: false, desktopIntegrated: false },
  binary: { file: "opencode.exe", bytes: readFileSync(exe).length, sha256: hash(exe) },
  artifacts: ["LICENSE", "README.md", "source-files.json"].map((file) => ({ file, bytes: readFileSync(path.join(stage, file)).length, sha256: hash(path.join(stage, file)) })),
}
writeFileSync(path.join(stage, "runtime-manifest.json"), json(manifest))
writeChecksums(stage)
publishDirectory(dist, stage, out)
console.log(JSON.stringify(manifest, null, 2))

function commandExecutable(name) {
  return execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/)[0]
}
