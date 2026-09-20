import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Intentionally accepts the repository's block-style job syntax only. A new YAML
// layout must be reviewed instead of silently skipping jobs this check cannot see.
export function workflowJobs(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const start = lines.findIndex((line) => line === "jobs:")
  assert(start >= 0, "Expected a block-style jobs mapping")
  const end = lines.findIndex((line, index) => index > start && /^[^\s#]/.test(line))
  const section = lines.slice(start + 1, end === -1 ? undefined : end)
  assert(section.every((line) => !line.includes("\t")), "Tabs in jobs require review")
  const starts = section.flatMap((line, index) => /^  [^ #]/.test(line) ? [index] : [])
  assert(starts.length > 0, "No jobs found")
  return starts.map((offset, index) => {
    const match = /^  ([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(section[offset])
    assert(match, "Expected an explicit job ID without aliases or flow mappings")
    const body = section.slice(offset + 1, starts[index + 1])
    const conditions = body.flatMap((line, position) => /^    if:/.test(line) ? [position] : [])
    assert(conditions.length <= 1, `${match[1]} has duplicate conditions`)
    const position = conditions[0]
    const inline = position === undefined ? "" : body[position].replace(/^    if:\s*/, "").trim()
    const boundary = position === undefined ? -1 : body.findIndex((line, candidate) => candidate > position && /^    \S/.test(line))
    const expression = /^[|>][-+]?$/.test(inline)
      ? body.slice(position + 1, boundary === -1 ? undefined : boundary).filter((line) => line.trim() && !line.trim().startsWith("#")).join(" ").trim()
      : inline
    return { id: match[1], condition: expression }
  })
}

export function hasRepositoryGuard(condition, repository) {
  const expression = condition.startsWith("${{") && condition.endsWith("}}")
    ? condition.slice(3, -2).trim()
    : condition
  const guard = `github.repository == '${repository}'`
  if (expression === guard) return true
  if (!expression.startsWith(`${guard} && (`) || !expression.endsWith(")")) return false
  const remainder = expression.slice(guard.length + 4)
  let depth = 0
  let quoted = false
  for (let index = 0; index < remainder.length; index++) {
    const char = remainder[index]
    if (char === "'") {
      if (quoted && remainder[index + 1] === "'") { index++; continue }
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (char === "(") depth++
    if (char === ")") depth--
    if (depth < 0 || depth === 0 && index < remainder.length - 1) return false
  }
  return depth === 0 && !quoted
}

export async function checkWorkflowPolicy(directory) {
  const files = (await readdir(directory)).filter((file) => /\.ya?ml$/.test(file)).sort()
  assert(files.length > 0, "No workflow files found")
  const result = []
  for (const file of files) {
    const text = await readFile(path.join(directory, file), "utf8")
    const own = file.startsWith("rivloom-")
    const repository = own ? "rivloom/rivloom-opencode-runtime" : "anomalyco/opencode"
    const jobs = workflowJobs(text)
    for (const job of jobs) assert(hasRepositoryGuard(job.condition, repository), `${file}/${job.id}: missing mandatory repository guard`)
    if (own) {
      assert(/^permissions:\r?\n  contents: read\r?$/m.test(text), `${file}: expected explicit contents: read`)
      assert(!/^\s+[a-z-]+: write\s*$/m.test(text), `${file}: write permissions are not allowed for runtime build/check workflows`)
    }
    result.push({ file, repository, jobs: jobs.length })
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkWorkflowPolicy(fileURLToPath(new URL("../.github/workflows", import.meta.url)))
    .then((workflows) => console.log(JSON.stringify({ workflows: workflows.length, jobs: workflows.reduce((sum, item) => sum + item.jobs, 0), status: "passed" }, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1 })
}
