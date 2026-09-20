import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
export const json = (value) => JSON.stringify(value, null, 2) + "\n"
export const sourceGit = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 })

// Git's index supplies portable mode metadata; hashes identify the actual working bytes.
// Ignored dependencies and generated outputs are represented separately by the lock/toolchain.
export function sourceInventory(root, requireClean = false) {
  const status = sourceGit(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
  if (requireClean) assert.equal(status, "", "A committed candidate requires a clean working tree")
  const indexed = sourceGit(root, "ls-files", "--stage", "-z").split("\0").filter(Boolean).map((entry) => {
    const match = entry.match(/^(\d+) ([a-f\d]+) (\d)\t([\s\S]+)$/)
    assert.ok(match && match[3] === "0", "Unmerged source input")
    assert.notEqual(match[1], "160000", "Submodule inputs need a separately pinned inventory")
    return { path: match[4], mode: match[1], tracked: true }
  })
  const untracked = sourceGit(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)
    .map((file) => ({ path: file, mode: "100644", tracked: false }))
  const files = [...indexed, ...untracked].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((entry) => {
    const file = path.resolve(root, entry.path)
    assert.ok(file.startsWith(path.resolve(root) + path.sep), "Source escaped repository")
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (!stat) return { ...entry, type: "deleted", bytes: 0, sha256: null }
    assert.ok(stat.isFile() || stat.isSymbolicLink(), `Unsupported source type: ${entry.path}`)
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file)
    return { ...entry, type: stat.isSymbolicLink() ? "symlink" : "file", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }
  })
  return { schemaVersion: 1, commit: sourceGit(root, "rev-parse", "HEAD").trim(),
    tree: sourceGit(root, "rev-parse", "HEAD^{tree}").trim(), dirty: status !== "", status: status.split("\0").filter(Boolean), files }
}

// Both publishing and upstream compilation may rename/remove these trees. Refuse
// symlinks/junctions anywhere in their ancestry or existing contents first.
export function safeDirectory(root, target) {
  const absolute = path.resolve(target)
  assert.ok(absolute.startsWith(path.resolve(root) + path.sep), "Output must stay inside the designated directory")
  for (let current = absolute; ; current = path.dirname(current)) {
    const stat = lstatSync(current, { throwIfNoEntry: false })
    assert.ok(!stat?.isSymbolicLink(), `Refusing linked output ancestor: ${current}`)
    if (current === path.dirname(current)) break
  }
  const visit = (dir) => {
    if (!existsSync(dir)) return
    assert.ok(lstatSync(dir).isDirectory(), `Expected directory: ${dir}`)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), `Refusing linked output: ${path.join(dir, entry.name)}`)
      if (entry.isDirectory()) visit(path.join(dir, entry.name))
    }
  }
  visit(absolute)
  return absolute
}

export function publishDirectory(root, stage, target) {
  safeDirectory(root, stage)
  safeDirectory(root, target)
  if (existsSync(target)) {
    const archive = path.join(root, "archive", `${path.basename(target)}-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`)
    safeDirectory(root, archive)
    mkdirSync(path.dirname(archive), { recursive: true })
    renameSync(target, archive)
    console.log(`Previous artifact preserved: ${archive}`)
  }
  renameSync(stage, target)
}

export function writeChecksums(out) {
  const files = ["LICENSE", "README.md", "opencode.exe", "runtime-manifest.json", "source-files.json", "smoke-report.json"]
    .filter((file) => existsSync(path.join(out, file)))
  writeFileSync(path.join(out, "SHA256SUMS"), files.map((file) => `${sha256(path.join(out, file))}  ${file}\n`).join(""))
}

export function verifyArtifact(out, manifest) {
  assert.equal(manifest.schemaVersion, 2, "Rebuild this candidate using the current producer before verification")
  assert.equal(manifest.binary.file, "opencode.exe")
  assert.deepEqual(manifest.artifacts.map((file) => file.file).sort(), ["LICENSE", "README.md", "source-files.json"])
  for (const artifact of [manifest.binary, ...manifest.artifacts]) {
    assert.equal(path.basename(artifact.file), artifact.file, "Artifact path must be a filename")
    const file = path.join(out, artifact.file)
    assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), "Artifact must be an ordinary file")
    assert.equal(readFileSync(file).length, artifact.bytes, `Artifact size changed: ${artifact.file}`)
    assert.equal(sha256(file), artifact.sha256, `Artifact changed: ${artifact.file}`)
  }
  const inventory = JSON.parse(readFileSync(path.join(out, "source-files.json"), "utf8"))
  assert.equal(manifest.source.inventory.file, "source-files.json")
  assert.equal(sha256(path.join(out, "source-files.json")), manifest.source.inventory.sha256)
  for (const key of ["commit", "tree", "dirty"]) assert.equal(inventory[key], manifest.source[key])
  assert.equal(inventory.files.length, manifest.source.inventory.files)
  return manifest
}

export function installedPackageVersion(file) {
  try { return JSON.parse(readFileSync(file, "utf8")).version } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined
    throw error
  }
}
