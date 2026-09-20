import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { test } from "node:test"
import { checkUpstream, compareVersions, exitCode, formatReport, validatePin } from "../check-upstream.mjs"

const pinned = "a".repeat(40)
const next = "b".repeat(40)
const dev = "c".repeat(40)
const config = {
  schemaVersion: 1,
  upstream: { repository: "anomalyco/opencode", tag: "v1.18.31", version: "1.18.31", commit: pinned },
}

async function fixture(t, changes = {}) {
  const requests = []
  const routes = {
    "/releases/latest": { tag_name: "v1.18.31", draft: false, prerelease: false, published_at: "2026-09-14T17:47:30Z" },
    "/commits/v1.18.31": { sha: pinned },
    "/commits/v1.18.32": { sha: next },
    "/commits/dev": { sha: dev },
    [`/compare/${pinned}...${dev}?per_page=1`]: { status: "diverged", ahead_by: 31, behind_by: 1 },
    [`/compare/${pinned}...${next}?per_page=1`]: { status: "ahead", ahead_by: 8, behind_by: 0 },
    ...changes,
  }
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
    const response = routes[req.url.replace("/repos/anomalyco/opencode", "")]
    res.statusCode = response?.httpStatus ?? (response ? 200 : 404)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(response ?? { message: "unknown fixture route" }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  return { apiBase: `http://127.0.0.1:${server.address().port}`, requests }
}

test("stable versions compare numerically, including multi-digit patches", () => {
  assert.equal(compareVersions("v1.18.100", "1.18.31"), 1)
  assert.equal(compareVersions("1.18.31", "v1.18.31"), 0)
  assert.equal(compareVersions("1.18.31", "2.0.0"), -1)
  assert.throws(() => compareVersions("1.18.32-beta.1", "1.18.31"))
  assert.throws(() => compareVersions("01.18.31", "1.18.31"))
})

test("runtime pin requires a matching stable tag and full source commit", () => {
  assert.deepEqual(validatePin(config), config.upstream)
  assert.throws(() => validatePin({ ...config, upstream: { ...config.upstream, commit: "abc1234" } }))
  assert.throws(() => validatePin({ ...config, upstream: { ...config.upstream, tag: "dev" } }))
  assert.throws(() => validatePin({ ...config, upstream: { ...config.upstream, repository: "https://example.com/repo" } }))
})

test("matching stable release is current while divergent dev is reported separately", async (t) => {
  const options = await fixture(t)
  const report = await checkUpstream(config, options)
  assert.equal(report.status, "up-to-date")
  assert.equal(report.pinned.tagMatchesPin, true)
  assert.deepEqual(report.latestStable.comparison, { status: "identical", aheadBy: 0, behindBy: 0 })
  assert.deepEqual(report.development.comparison, { status: "diverged", aheadBy: 31, behindBy: 1 })
  assert.equal(exitCode(report, true), 0)
  assert.match(formatReport(report), /Development comparison: diverged; 31 upstream-only \/ 1 pin-only/)
  assert.equal(options.requests.length, 4)
  assert(options.requests.every((request) => request.method === "GET" && request.authorization === undefined))
})

test("new stable release resolves its tag to a commit and supports optional update failure", async (t) => {
  const options = await fixture(t, {
    "/releases/latest": { tag_name: "v1.18.32", draft: false, prerelease: false, published_at: "2026-09-20T00:00:00Z", target_commitish: "dev" },
  })
  const report = await checkUpstream(config, options)
  assert.equal(report.status, "update-available")
  assert.equal(report.latestStable.commit, next)
  assert.equal(report.latestStable.comparison.aheadBy, 8)
  assert.equal(exitCode(report), 0)
  assert.equal(exitCode(report, true), 2)
  assert(options.requests.some((request) => request.url.endsWith("/commits/v1.18.32")))
})

test("a moved pinned tag is a pin mismatch, never an accepted current version", async (t) => {
  const options = await fixture(t, { "/commits/v1.18.31": { sha: next } })
  const report = await checkUpstream(config, options)
  assert.equal(report.status, "pin-mismatch")
  assert.equal(report.pinned.tagMatchesPin, false)
  assert.equal(exitCode(report), 2)
})

test("a latest release older than the pin requires review instead of downgrade", async (t) => {
  const options = await fixture(t, {
    "/releases/latest": { tag_name: "v1.18.30", draft: false, prerelease: false, published_at: "2026-09-13T00:00:00Z" },
    "/commits/v1.18.30": { sha: next },
    [`/compare/${pinned}...${next}?per_page=1`]: { status: "behind", ahead_by: 0, behind_by: 4 },
  })
  const report = await checkUpstream(config, options)
  assert.equal(report.status, "review-required")
  assert.equal(exitCode(report), 2)
})

test("API failures fail closed and do not leak response content or authorization", async (t) => {
  const options = await fixture(t, { "/releases/latest": { httpStatus: 403, message: "sensitive fixture token" } })
  await assert.rejects(checkUpstream(config, { ...options, token: "private-fixture-token" }), (error) => {
    assert.match(error.message, /HTTP 403/)
    assert.doesNotMatch(error.message, /sensitive|private-fixture-token/)
    return true
  })
})

test("missing releases are errors rather than a false up-to-date result", async (t) => {
  const options = await fixture(t, { "/releases/latest": { httpStatus: 404 } })
  await assert.rejects(checkUpstream(config, options), /HTTP 404/)
})

for (const malformed of [
  { draft: true },
  { prerelease: true },
  { tag_name: "v1.19.0-rc.1" },
  { published_at: "not-a-date" },
]) {
  test(`unusable stable release metadata is rejected: ${JSON.stringify(malformed)}`, async (t) => {
    const options = await fixture(t, {
      "/releases/latest": { tag_name: "v1.18.31", draft: false, prerelease: false, published_at: "2026-09-14T17:47:30Z", ...malformed },
    })
    await assert.rejects(checkUpstream(config, options))
  })
}

test("invalid compare counts fail rather than reporting invented lag", async (t) => {
  const options = await fixture(t, {
    [`/compare/${pinned}...${dev}?per_page=1`]: { status: "ahead", ahead_by: -1, behind_by: 0 },
  })
  await assert.rejects(checkUpstream(config, options), /ahead count/)
})

test("invalid commit identities are rejected before constructing compare requests", async (t) => {
  const options = await fixture(t, { "/commits/dev": { sha: "not-a-commit" } })
  await assert.rejects(checkUpstream(config, options), /invalid commit SHA/)
  assert(options.requests.every((request) => !request.url.includes("/compare/")))
})

test("matching development commit does not require a comparison request", async (t) => {
  const options = await fixture(t, { "/commits/dev": { sha: pinned } })
  const report = await checkUpstream(config, options)
  assert.deepEqual(report.development.comparison, { status: "identical", aheadBy: 0, behindBy: 0 })
  assert.equal(options.requests.length, 3)
})
