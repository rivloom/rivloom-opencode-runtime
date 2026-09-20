import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { checkWorkflowPolicy, hasRepositoryGuard, workflowJobs } from "../check-workflow-policy.mjs"

const repository = "anomalyco/opencode"
const guard = `github.repository == '${repository}'`

async function removeFixture(directory) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
  assert(path.basename(directory).startsWith("rivloom-workflow-policy-"))
  await rm(directory, { recursive: true, force: true })
}

test("all checked-in workflow jobs are restricted to their intended repository", async () => {
  const workflows = await checkWorkflowPolicy(fileURLToPath(new URL("../../.github/workflows", import.meta.url)))
  assert(workflows.some((item) => item.file === "rivloom-runtime-windows.yml"))
  assert(workflows.some((item) => item.file === "rivloom-upstream-check.yml"))
})

test("repository restriction cannot be bypassed by a top-level OR", () => {
  for (const condition of [guard, `${guard} && (false)`, `${guard} && (always() && !cancelled())`, `${guard} && (contains('text ) here', 'it''s (quoted)'))`]) {
    assert.equal(hasRepositoryGuard(condition, repository), true, condition)
  }
  for (const condition of ["", `${guard} || true`, `${guard} && (false) || (true)`, `${guard} && (true`, `contains('${guard}', 'x')`, `github.repository != '${repository}'`]) {
    assert.equal(hasRepositoryGuard(condition, repository), false, condition)
  }
})

test("literal multiline conditions and disabled jobs remain explicit", () => {
  const jobs = workflowJobs(`name: sample\njobs:\n  one:\n    if: >-\n      ${guard} && (\n      contains(github.event.comment.body, '/oc') ||\n      startsWith(github.event.comment.body, '/opencode')\n      )\n    runs-on: ubuntu-latest\n  two:\n    if: ${guard} && (false)\n    runs-on: ubuntu-latest\n`)
  assert.equal(jobs.length, 2)
  assert(jobs.every((job) => hasRepositoryGuard(job.condition, repository)))
  assert.match(jobs[1].condition, /false/)
})

test("unrecognized YAML jobs layouts fail closed", () => {
  for (const text of ["jobs: { one: {} }", "jobs:\n  <<: *jobs", "jobs:\n  'quoted':\n    runs-on: x", "jobs:\n  one:\n    if: true\n    if: false"]) {
    assert.throws(() => workflowJobs(text))
  }
})

test("an added unguarded workflow job makes the check fail", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "rivloom-workflow-policy-"))
  t.after(() => removeFixture(directory))
  await writeFile(path.join(directory, "new-upstream.yml"), `jobs:\n  safe:\n    if: ${guard}\n    runs-on: ubuntu-latest\n  new-job:\n    runs-on: ubuntu-latest\n`)
  await assert.rejects(checkWorkflowPolicy(directory), /new-job: missing mandatory repository guard/)
})

test("Rivloom workflows cannot request write permissions", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "rivloom-workflow-policy-"))
  t.after(() => removeFixture(directory))
  await writeFile(path.join(directory, "rivloom-unsafe.yml"), "permissions:\n  contents: read\njobs:\n  build:\n    if: github.repository == 'rivloom/rivloom-opencode-runtime'\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n")
  await assert.rejects(checkWorkflowPolicy(directory), /write permissions are not allowed/)
})
