import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { installedPackageVersion, json, publishDirectory, safeDirectory, sha256, sourceGit, sourceInventory, verifyArtifact, writeChecksums } from "./artifact.mjs"

const generated = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist/verification/artifact-tests")
mkdirSync(generated, { recursive: true })
const fixture = () => mkdtempSync(path.join(generated, "case-"))

test("source inventory distinguishes actual dirty bytes, untracked additions and tracked deletions", () => {
  const root = fixture()
  const templates = path.join(root, "templates")
  mkdirSync(templates)
  sourceGit(root, "init", "--template=" + templates)
  writeFileSync(path.join(root, "tracked.txt"), "before\n")
  writeFileSync(path.join(root, ".gitignore"), "ignored/\ntemplates/\n")
  sourceGit(root, "add", "tracked.txt", ".gitignore")
  sourceGit(root, "-c", "user.name=Runtime Fixture", "-c", "user.email=fixture@localhost", "-c", "core.hooksPath=" + templates,
    "-c", "commit.gpgsign=false", "commit", "-m", "test fixture")
  const clean = sourceInventory(root, true)
  assert.equal(clean.dirty, false)
  writeFileSync(path.join(root, "tracked.txt"), "first edit\n")
  const first = sourceInventory(root)
  writeFileSync(path.join(root, "tracked.txt"), "second edit\n")
  const second = sourceInventory(root)
  assert.equal(first.dirty, second.dirty)
  assert.notDeepEqual(first.files, second.files)
  assert.throws(() => sourceInventory(root, true), /clean working tree/)
  writeFileSync(path.join(root, "new file.txt"), "untracked input")
  unlinkSync(path.join(root, "tracked.txt"))
  mkdirSync(path.join(root, "ignored"))
  writeFileSync(path.join(root, "ignored/output.txt"), "not a source input")
  const changed = sourceInventory(root)
  assert.equal(changed.files.find((file) => file.path === "tracked.txt").type, "deleted")
  assert.equal(changed.files.find((file) => file.path === "new file.txt").tracked, false)
  assert.ok(!changed.files.some((file) => file.path.startsWith("ignored/")))
  assert.equal(changed.commit, clean.commit)
})

test("output guard rejects parent traversal and directory junctions", () => {
  const root = fixture()
  assert.throws(() => safeDirectory(root, path.join(root, "../outside")), /designated directory/)
  assert.throws(() => safeDirectory(root, root), /designated directory/)
  const outside = fixture()
  symlinkSync(outside, path.join(root, "redirect"), process.platform === "win32" ? "junction" : "dir")
  assert.throws(() => safeDirectory(root, path.join(root, "redirect/result")), /linked output ancestor/)
  assert.throws(() => safeDirectory(generated, root), /linked output/)
})

test("publishing preserves the previous artifact and cannot reuse its passed smoke report", () => {
  const root = fixture()
  const target = path.join(root, "windows-x64")
  const stage = path.join(root, "stage")
  mkdirSync(target)
  mkdirSync(stage)
  writeFileSync(path.join(target, "smoke-report.json"), '{"passed":true}')
  writeFileSync(path.join(target, "opencode.exe"), "old")
  writeFileSync(path.join(stage, "opencode.exe"), "new")
  publishDirectory(root, stage, target)
  assert.deepEqual(readdirSync(target), ["opencode.exe"])
  const preserved = path.join(root, "archive", readdirSync(path.join(root, "archive"))[0])
  assert.equal(readFileSync(path.join(preserved, "opencode.exe"), "utf8"), "old")
  assert.equal(JSON.parse(readFileSync(path.join(preserved, "smoke-report.json"), "utf8")).passed, true)
})

test("artifact verification binds executable, license, source inventory and source identity", () => {
  const root = fixture()
  const inventory = { schemaVersion: 1, commit: "abc", tree: "def", dirty: true, files: [] }
  for (const [file, value] of Object.entries({ "opencode.exe": "binary", LICENSE: "license", "README.md": "readme", "source-files.json": json(inventory) })) {
    writeFileSync(path.join(root, file), value)
  }
  const entry = (file) => ({ file, bytes: readFileSync(path.join(root, file)).length, sha256: sha256(path.join(root, file)) })
  const manifest = { schemaVersion: 2, binary: entry("opencode.exe"), artifacts: ["LICENSE", "README.md", "source-files.json"].map(entry),
    source: { commit: "abc", tree: "def", dirty: true, inventory: { file: "source-files.json", sha256: sha256(path.join(root, "source-files.json")), files: 0 } } }
  assert.equal(verifyArtifact(root, manifest), manifest)
  assert.throws(() => verifyArtifact(root, { ...manifest, source: { ...manifest.source, dirty: false } }))
  assert.throws(() => verifyArtifact(root, { ...manifest, artifacts: manifest.artifacts.slice(1) }))
  for (const file of ["LICENSE", "source-files.json", "opencode.exe"]) {
    const original = readFileSync(path.join(root, file))
    writeFileSync(path.join(root, file), "changed")
    assert.throws(() => verifyArtifact(root, manifest), /Artifact (size )?changed/)
    writeFileSync(path.join(root, file), original)
  }
  writeFileSync(path.join(root, "runtime-manifest.json"), json(manifest))
  writeFileSync(path.join(root, "smoke-report.json"), json({ passed: true, manifestSHA256: sha256(path.join(root, "runtime-manifest.json")) }))
  writeChecksums(root)
  const sums = readFileSync(path.join(root, "SHA256SUMS"), "utf8").trim().split("\n")
  assert.equal(sums.length, 6)
  for (const line of sums) { const [hash, file] = line.split("  "); assert.equal(hash, sha256(path.join(root, file))) }
})

test("incomplete package installation is retried until JSON is fully written", () => {
  const file = path.join(fixture(), "package.json")
  assert.equal(installedPackageVersion(file), undefined)
  writeFileSync(file, '{"version":"1.18')
  assert.equal(installedPackageVersion(file), undefined)
  writeFileSync(file, '{"version":"1.18.31"}')
  assert.equal(installedPackageVersion(file), "1.18.31")
})
