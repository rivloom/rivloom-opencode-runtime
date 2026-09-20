import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { isolatedSmokeEnvironment, json, recipeFiles, recipeInventory, safeDirectory, sha256, sourceGit, sourceInventory, verifyArtifact, verifyLinuxBinary, writeChecksums } from "./linux/artifact.mjs"

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist/verification/linux-recipe-tests")
mkdirSync(directory, { recursive: true })
const fixture = () => mkdtempSync(path.join(directory, "case-"))
const elf = () => { const bytes = Buffer.alloc(128); bytes.write("\x7fELF", 0, "binary"); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18); return bytes }

test("smoke inherits standard dependency proxies while keeping loopback direct and provider credentials isolated", () => {
  const result = isolatedSmokeEnvironment({ PATH: "/native/bin", LANG: "C.UTF-8", HTTP_PROXY: "http://proxy.invalid:8080",
    HTTPS_PROXY: "http://proxy.invalid:8080", http_proxy: "http://lower.invalid:8080", https_proxy: "http://lower.invalid:8080",
    NO_PROXY: "registry.example.invalid, localhost", no_proxy: "internal.invalid,,registry.example.invalid",
    OPENAI_API_KEY: "test-secret", ANTHROPIC_API_KEY: "test-secret", AWS_SECRET_ACCESS_KEY: "test-secret", HOME: "/real-home", ALL_PROXY: "socks5://not-inherited.invalid" })
  assert.equal(result.PATH, "/native/bin")
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.ok(result[key].startsWith("http://"))
  assert.equal(result.NO_PROXY, "127.0.0.1,localhost,::1,registry.example.invalid,internal.invalid")
  assert.equal(result.no_proxy, result.NO_PROXY)
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "HOME", "ALL_PROXY"]) assert.ok(!(key in result))
  assert.deepEqual(isolatedSmokeEnvironment({}), { NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" })
})

test("clean source admission rejects edits and identifies exact dirty contents and deletions", () => {
  const root = fixture()
  const templates = path.join(root, "templates"); mkdirSync(templates)
  sourceGit(root, "init", "--template=" + templates)
  writeFileSync(path.join(root, ".gitignore"), "templates/\n")
  writeFileSync(path.join(root, "source.txt"), "original\n")
  sourceGit(root, "add", ".gitignore", "source.txt")
  sourceGit(root, "-c", "user.name=Linux Recipe Test", "-c", "user.email=fixture@localhost", "-c", "core.hooksPath=" + templates,
    "-c", "commit.gpgsign=false", "commit", "-m", "isolated fixture")
  const clean = sourceInventory(root, true)
  assert.equal(clean.dirty, false)
  writeFileSync(path.join(root, "source.txt"), "one\n")
  const one = sourceInventory(root)
  assert.throws(() => sourceInventory(root, true), /clean working tree/)
  writeFileSync(path.join(root, "source.txt"), "two\n")
  assert.notDeepEqual(sourceInventory(root).files, one.files)
  unlinkSync(path.join(root, "source.txt"))
  assert.equal(sourceInventory(root).files.find(file => file.path === "source.txt").type, "deleted")
  assert.equal(sourceInventory(root).commit, clean.commit)
})

test("Bun cache and artifact safety reject traversal, linked ancestors and linked contents", () => {
  const root = fixture(), outside = fixture()
  assert.throws(() => safeDirectory(root, path.join(root, "../outside")), /designated directory/)
  symlinkSync(outside, path.join(root, "linked-cache"), process.platform === "win32" ? "junction" : "dir")
  assert.throws(() => safeDirectory(root, path.join(root, "linked-cache/bun")), /linked output ancestor/)
  const tools = path.join(root, "tools"); mkdirSync(tools)
  symlinkSync(outside, path.join(tools, "redirect"), process.platform === "win32" ? "junction" : "dir")
  assert.throws(() => safeDirectory(root, tools), /linked output/)
})

test("external recipe digest uses the exact four canonical files and sorted filename/hash pairs", () => {
  const root = fixture()
  for (const file of recipeFiles) writeFileSync(path.join(root, file), file)
  const first = recipeInventory(root)
  const expected = createHash("sha256").update(JSON.stringify(Object.entries(first.files).sort())).digest("hex")
  assert.equal(first.sha256, expected)
  assert.deepEqual(Object.keys(first.files), ["artifact.mjs", "build.mjs", "runtime.json", "smoke.mjs"])
  writeFileSync(path.join(root, "unrelated.txt"), "not a recipe input")
  assert.deepEqual(recipeInventory(root), first)
  writeFileSync(path.join(root, "build.mjs"), "changed")
  assert.notEqual(recipeInventory(root).sha256, first.sha256)
})

test("ELF identity rejects Windows, ARM, 32-bit and big-endian binaries", () => {
  const file = path.join(fixture(), "opencode")
  writeFileSync(file, elf()); chmodSync(file, 0o755)
  verifyLinuxBinary(file)
  for (const alter of [bytes => bytes.write("MZ"), bytes => bytes.writeUInt16LE(183, 18), bytes => bytes[4] = 1, bytes => bytes[5] = 2]) {
    const bytes = elf(); alter(bytes); writeFileSync(file, bytes)
    assert.throws(() => verifyLinuxBinary(file))
  }
})

test("Linux schema2 binds clean core inputs and license to exact source inventory", () => {
  const root = fixture()
  writeFileSync(path.join(root, "opencode"), elf()); chmodSync(path.join(root, "opencode"), 0o755)
  writeFileSync(path.join(root, "LICENSE"), "license")
  writeFileSync(path.join(root, "README.md"), "readme")
  const inventory = { schemaVersion: 1, commit: "a".repeat(40), tree: "b".repeat(40), dirty: false, status: [], files: [
    { path: "LICENSE", sha256: sha256(path.join(root, "LICENSE")) }, { path: "rivloom/README.md", sha256: sha256(path.join(root, "README.md")) },
    { path: "bun.lock", sha256: "c".repeat(64) }, { path: "rivloom/models.json", sha256: "d".repeat(64) },
  ] }
  writeFileSync(path.join(root, "source-files.json"), json(inventory))
  const entry = (file) => ({ file, bytes: readFileSync(path.join(root, file)).length, sha256: sha256(path.join(root, file)) })
  const manifest = { schemaVersion: 2, target: "linux-x64", profile: { baseline: true, libc: "glibc" },
    source: { commit: inventory.commit, tree: inventory.tree, dirty: false, inventory: { file: "source-files.json", sha256: sha256(path.join(root, "source-files.json")), files: inventory.files.length } },
    binary: entry("opencode"), artifacts: ["LICENSE", "README.md", "source-files.json"].map(entry),
    inputs: { bunLockSHA256: "c".repeat(64), modelsSHA256: "d".repeat(64), files: { "LICENSE": inventory.files[0].sha256, "bun.lock": "c".repeat(64), "rivloom/models.json": "d".repeat(64) } } }
  verifyArtifact(root, manifest)
  assert.throws(() => verifyArtifact(root, { ...manifest, inputs: { ...manifest.inputs, files: { ...manifest.inputs.files, LICENSE: "e".repeat(64) } } }))
  assert.throws(() => verifyArtifact(root, { ...manifest, source: { ...manifest.source, dirty: true } }))
  assert.throws(() => verifyArtifact(root, { ...manifest, target: "linux-arm64" }))
  writeFileSync(path.join(root, "runtime-manifest.json"), json(manifest))
  writeFileSync(path.join(root, "smoke-report.json"), json({ passed: true }))
  writeChecksums(root)
  const sums = readFileSync(path.join(root, "SHA256SUMS"), "utf8").trim().split("\n")
  assert.deepEqual(sums.map(line => line.split("  ")[1]), ["LICENSE", "README.md", "opencode", "runtime-manifest.json", "smoke-report.json", "source-files.json"])
  for (const line of sums) { const [hash, file] = line.split("  "); assert.equal(hash, sha256(path.join(root, file))) }
})

test("native Linux CI checks out the exact configured core and preserves executable permissions", () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const config = JSON.parse(readFileSync(path.join(here, "linux/runtime.json"), "utf8"))
  const workflow = readFileSync(path.join(here, "../.github/workflows/rivloom-runtime-linux.yml"), "utf8")
  assert.equal(workflow.match(/^\s+ref:\s+([a-f0-9]{40})\s*$/m)?.[1], config.source.commit)
  assert.match(workflow, /runs-on: ubuntu-22\.04/)
  assert.match(workflow, /linux\/build\.mjs --source rivloom\/dist\/linux-core --output rivloom\/dist\/linux-x64 --require-clean/)
  assert.match(workflow, /tar -czf/)
  assert.match(workflow, /contents: read/)
})
