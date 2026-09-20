import assert from "node:assert/strict"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sha = /^[0-9a-f]{40}$/
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const version = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function compareVersions(left, right) {
  const a = version.exec(left)
  const b = version.exec(right)
  assert(a && b, "Expected stable major.minor.patch versions")
  for (const index of [1, 2, 3]) {
    const difference = BigInt(a[index]) - BigInt(b[index])
    if (difference !== 0n) return difference > 0n ? 1 : -1
  }
  return 0
}

export function validatePin(config) {
  assert.equal(config?.schemaVersion, 1, "Unsupported runtime configuration schema")
  assert(repository.test(config.upstream?.repository), "Invalid upstream repository")
  assert(sha.test(config.upstream?.commit), "The upstream pin must be a full commit SHA")
  assert(version.test(config.upstream?.version), "The upstream version must be stable")
  assert.equal(config.upstream.tag, `v${config.upstream.version}`, "Upstream tag and version disagree")
  return config.upstream
}

export async function checkUpstream(config, options = {}) {
  const pin = validatePin(config)
  const branch = options.branch ?? "dev"
  assert(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch), "Invalid development branch")
  const base = options.apiBase ?? "https://api.github.com"
  const endpoint = `/repos/${pin.repository}`
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Rivloom-upstream-check",
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
  }
  const request = async (resource) => {
    const response = await fetch(`${base}${endpoint}${resource}`, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      redirect: "error",
    })
    assert(response.ok, `GitHub GET ${resource} failed (HTTP ${response.status}); no upstream result was accepted`)
    return response.json()
  }
  const [release, pinnedTag, development] = await Promise.all([
    request("/releases/latest"),
    request(`/commits/${encodeURIComponent(pin.tag)}`),
    request(`/commits/${encodeURIComponent(branch)}`),
  ])
  assert.equal(release.draft, false, "GitHub latest returned a draft")
  assert.equal(release.prerelease, false, "GitHub latest returned a prerelease")
  assert(version.test(release.tag_name), "Latest release does not have a stable version tag")
  assert(Number.isFinite(Date.parse(release.published_at)), "Latest release has no valid publication time")
  assert(sha.test(pinnedTag.sha) && sha.test(development.sha), "GitHub returned an invalid commit SHA")
  const latest = release.tag_name === pin.tag ? pinnedTag : await request(`/commits/${encodeURIComponent(release.tag_name)}`)
  assert(sha.test(latest.sha), "GitHub returned an invalid release commit SHA")
  const compare = async (head) => {
    if (head === pin.commit) return { status: "identical", aheadBy: 0, behindBy: 0 }
    const data = await request(`/compare/${pin.commit}...${head}?per_page=1`)
    assert(["identical", "ahead", "behind", "diverged"].includes(data.status), "Invalid GitHub comparison status")
    assert(Number.isSafeInteger(data.ahead_by) && data.ahead_by >= 0, "Invalid GitHub ahead count")
    assert(Number.isSafeInteger(data.behind_by) && data.behind_by >= 0, "Invalid GitHub behind count")
    return { status: data.status, aheadBy: data.ahead_by, behindBy: data.behind_by }
  }
  const [stableComparison, developmentComparison] = await Promise.all([compare(latest.sha), compare(development.sha)])
  const difference = compareVersions(release.tag_name, pin.version)
  const status = pinnedTag.sha !== pin.commit
    ? "pin-mismatch"
    : difference > 0
      ? "update-available"
      : difference === 0 && latest.sha === pin.commit
        ? "up-to-date"
        : "review-required"
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    repository: pin.repository,
    status,
    pinned: { ...pin, tagCommit: pinnedTag.sha, tagMatchesPin: pinnedTag.sha === pin.commit },
    latestStable: {
      tag: release.tag_name,
      version: release.tag_name.replace(/^v/, ""),
      commit: latest.sha,
      publishedAt: release.published_at,
      releaseUrl: `https://github.com/${pin.repository}/releases/tag/${release.tag_name}`,
      comparison: stableComparison,
    },
    development: {
      branch,
      commit: development.sha,
      comparison: developmentComparison,
      compareUrl: `https://github.com/${pin.repository}/compare/${pin.commit}...${development.sha}`,
    },
    policy: "Report only. No git fetch, merge, pin change, build, commit, push or release is performed. Development commits are not stable releases.",
  }
}

export function formatReport(report) {
  return [
    `OpenCode upstream check: ${report.status}`,
    `Checked: ${report.checkedAt}`,
    `Pinned: ${report.pinned.tag} (${report.pinned.commit})`,
    `Pinned tag resolves to: ${report.pinned.tagCommit} (${report.pinned.tagMatchesPin ? "matches" : "MISMATCH"})`,
    `Latest stable: ${report.latestStable.tag} (${report.latestStable.commit}), published ${report.latestStable.publishedAt}`,
    `Stable comparison: ${report.latestStable.comparison.status}; ${report.latestStable.comparison.aheadBy} upstream-only / ${report.latestStable.comparison.behindBy} pin-only commits`,
    `Development ${report.development.branch}: ${report.development.commit}`,
    `Development comparison: ${report.development.comparison.status}; ${report.development.comparison.aheadBy} upstream-only / ${report.development.comparison.behindBy} pin-only commits`,
    report.latestStable.releaseUrl,
    report.policy,
  ].join("\n")
}

export function exitCode(report, failOnUpdate = false) {
  if (["pin-mismatch", "review-required"].includes(report.status)) return 2
  return failOnUpdate && report.status === "update-available" ? 2 : 0
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help")) {
    console.log("Usage: node rivloom/check-upstream.mjs [--json] [--output FILE] [--fail-on-update]\nReads the pinned configuration and official GitHub metadata only. Optional GITHUB_TOKEN is used only with api.github.com. Exit 1: unavailable/invalid response; exit 2: pin mismatch/review needed, or a stable update with --fail-on-update.")
    return
  }
  const outputIndex = args.indexOf("--output")
  assert(outputIndex === -1 || args[outputIndex + 1] && !args[outputIndex + 1].startsWith("--"), "--output requires a file")
  const output = outputIndex === -1 ? null : args[outputIndex + 1]
  assert(args.every((arg, index) => ["--json", "--fail-on-update", "--output"].includes(arg) || index === outputIndex + 1 && outputIndex !== -1), "Unknown argument; use --help")
  const config = JSON.parse(await readFile(new URL("runtime.json", import.meta.url), "utf8"))
  const report = await checkUpstream(config, { token: process.env.GITHUB_TOKEN })
  const json = JSON.stringify(report, null, 2) + "\n"
  if (output) {
    await mkdir(path.dirname(path.resolve(output)), { recursive: true })
    await writeFile(output, json, { flag: "wx" })
  }
  console.log(args.includes("--json") ? json.trimEnd() : formatReport(report))
  process.exitCode = exitCode(report, args.includes("--fail-on-update"))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Upstream check failed: ${error.message}`)
    process.exitCode = 1
  })
}
