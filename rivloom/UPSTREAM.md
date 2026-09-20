# Following OpenCode upstream

Rivloom tracks official stable OpenCode releases while maintaining a small,
reviewable runtime patch set. The runtime repository owns upstream source and
runtime build verification. The desktop repository owns its runtime source pin,
SDK/plugin compatibility, packaging and user-facing release. A new official
release is a candidate for review, not permission to change either repository or
publish a build automatically.

## Current verified baseline

Checked at **2026-09-19T14:39:41.112Z** against the
[official latest release](https://github.com/anomalyco/opencode/releases/latest)
and [GitHub REST API](https://api.github.com/repos/anomalyco/opencode/releases/latest):

| Input | Verified value |
| --- | --- |
| Pinned and latest stable | `v1.18.31` |
| Stable source commit | `014614d35b397775e5d397a490fc72368c894ec2` |
| Stable publication time | `2026-09-14T17:47:30Z` |
| Development head at the time of checking | `fee476bb90043a1012abda156dd9af9e5c71b19d` |
| Pin compared with that development head | `diverged`: 32 upstream-only, 1 pin-only commits |

The development branch can diverge from a release commit. These commit counts
are **not** missed stable releases and do not mean the development branch is a
validated desktop dependency. Re-run the check to obtain current information;
the table is a dated observation.

## Check without changing source

From the repository root, with Node.js 24.19.0:

```powershell
node rivloom/check-upstream.mjs
node rivloom/check-upstream.mjs --json
node rivloom/check-upstream.mjs --output rivloom/dist/upstream-check-20260919.json --fail-on-update
```

The script reads `rivloom/runtime.json`, makes GET requests to official GitHub
metadata endpoints, resolves tags to commit SHAs (not `target_commitish`), and
compares the pin with both the stable release and `dev`. Optional `GITHUB_TOKEN`
authentication is used only for the official API by the command-line entry
point. No token or response body is printed on HTTP failures. `--output` creates
a new report file and refuses to overwrite an existing report.

- Exit `0`: a complete report, with the current pin matching stable, or an update
  reported without `--fail-on-update`.
- Exit `1`: unavailable or invalid upstream metadata, invalid arguments, or a
  report write failure. Upstream status is unknown, never assumed current.
- Exit `2`: the pinned tag no longer matches its recorded commit, another
  version discrepancy needs review, or a newer stable release was found with
  `--fail-on-update`. Development-only commits do not trigger this exit.

The local `Rivloom upstream check` workflow is configured for daily checks at
03:23 UTC and manual runs. It writes an Actions summary and retains the JSON
report for 30 days. It uses `--fail-on-update` so a new stable release requires
maintainer attention. It has `contents: read` only and does not create issues,
comments, pull requests, commits, tags or releases. The workflow becomes active
only after the reviewed change reaches the default branch and Actions scheduling
is enabled; no cloud execution is claimed by local validation.

## Upgrade a candidate deliberately

1. Read the top-level repository instructions and preserve existing edits. Start
   from a clean checkout or an isolated worktree. Run the check and save the
   dated report. Review the official release notes and source comparison.
2. Fetch the official tag into the local clone without changing the working tree.
   Verify its full commit matches the checked candidate. Review package locks,
   SDK/plugin versions, migrations, provider authentication, session/permission
   contracts and packaging changes. A stable release can contain breaking
   behavior for the desktop even when the version looks incremental.
3. Integrate the reviewed upstream commit into a candidate branch. Resolve
   conflicts explicitly. Retain Rivloom's plugin-version compatibility patch,
   prompt scaffold and build profile, unless upstream makes a patch unnecessary.
   Do not connect a previously inert prompt module merely as part of an upgrade.
4. Update `rivloom/runtime.json` tag, version and full source commit together.
   Validate the pinned Node/Bun versions, Bun archive hash and frozen lockfile.
   Refresh the models catalog only when intended; update its recorded date and
   SHA256 together. Check that source package, SDK and plugin versions agree.
   For Linux, also update `rivloom/linux/runtime.json`'s clean core commit/tree,
   exact input hashes and Linux Bun archive pin, plus the Linux workflow's fixed
   checkout ref. Keep x64/glibc baseline distinct from Windows and deferred ARM64.
5. Re-run the workflow isolation policy after the merge. New upstream jobs must
   not gain the ability to run in the Rivloom fork. Review new permissions,
   triggers, actions, nested/reusable workflows and any publish or write steps.
6. Re-run the regression checks below. Preserve failed attempts; fix and re-run
   the affected checks. A `--SkipSmoke` build is not an adoption candidate.
7. After the user authorizes committing/pushing the runtime change, produce a
   clean committed candidate and retain its artifact, manifest, source inventory,
   smoke report, hashes and Actions run identity. A dirty development build can
   support local testing but is not a remotely reproducible source pin.
8. In the desktop repository, update the full runtime source pin and version,
   SDK/plugin dependencies, binary guard, provenance/license inputs and build/CI
   preparation together. Use a fixed source commit with a local build receipt,
   or a verified immutable artifact with its exact SHA256. Never consume a moving
   upstream/default-branch URL or implicitly switch to an official binary.
   Refresh the exact four-file Linux recipe copy and its individual/aggregate
   hashes in the desktop's Linux source lock together. The newer external recipe
   is a separate reviewed input, not source attributed to an older core commit.
9. Run desktop and package acceptance. Keep the previous verified artifact/pin
   available for rollback. Publish only when explicitly authorized, following
   the desktop repository's release, signing, download and retention process.

## Regression gates

Windows builds require Git, Node.js 24.19.0 and PowerShell 7 (`pwsh` on PATH).
Use the same PowerShell 7 entry point as desktop source preparation and the
Windows CI runner. Run the small Node tests from `rivloom`, not the monorepo root:

```powershell
Set-Location rivloom
node --test artifact.test.mjs tests/check-upstream.test.mjs tests/workflow-policy.test.mjs
Set-Location ..
node rivloom/check-workflow-policy.mjs
pwsh -NoProfile -ExecutionPolicy Bypass -File rivloom/build.ps1 -RequireClean
```

The Windows build job additionally checks `packages/core` and
`packages/opencode` types and upstream configuration, TUI configuration and
plugin tests. The real EXE smoke test checks version identity, authenticated HTTP
health/provider APIs, session creation/streaming/persistence, tool approval and
cancellation against an isolated local model fixture. These checks do not call a
paid model or validate real-provider OAuth.

The Linux workflow runs on `ubuntu-22.04`, validates `linux.test.mjs`, checks out
the fixed clean core separately, then runs the external Linux recipe and eleven
native ELF smoke checks. It archives candidates as tarballs to retain executable
permissions. Run the same recipe locally on Linux x64/glibc, retain failed stages
and the source/recipe inventories, and record required glibc/GLIBCXX versions for
the main ELF and every embedded or extracted native library. A main-executable
`readelf` result alone is insufficient: the current candidate's main ELF requires
symbols through `GLIBC_2.17`, but embedded `libfff_c.so` from
`@ff-labs/fff-bin-linux-x64-gnu` requires `GLIBC_2.30`, making **glibc 2.30** the
runtime floor. The embedded watcher requires `GLIBCXX_3.4.22`; the full Linux
client's bundled Node raises that to `GLIBCXX_3.4.25` and requires kernel 4.18.
An upstream dependency change must trigger the same embedded-library ABI review,
even when the main ELF's requirements are unchanged.
Windows-only checks and successful cross-compilation are not Linux execution
evidence. The current recipe passed eleven native smoke checks on WSL Ubuntu
with glibc 2.39; no cloud workflow run is claimed. This identifies the tested
distribution and does not alone establish acceptance on the oldest supported
distribution.

Desktop acceptance must cover engine startup and binary identity, provider/model
listing and account state, a new conversation and continuation, task cancellation,
file/tool permissions, persistence/reconnect, remote delegation, and packaged
backend/engine startup. Test OAuth and real providers separately when the changed
upstream code affects them. A local fixture cannot establish that a remote OAuth
flow still works. Do not mark native installation or upgrade acceptance complete
unless those actions were actually performed.

## Inherited workflow isolation

Every job in a non-`rivloom-` workflow requires
`github.repository == 'anomalyco/opencode'`. Existing job conditions are retained
inside an `&& (...)` clause, including `false` and historical repository
conditions. This keeps inherited container/package publishing, code generation,
issue/PR management, scheduled maintenance and upstream infrastructure jobs from
running in the Rivloom fork. The original triggers and job bodies remain present
for upstream diff review.

`check-workflow-policy.mjs` inspects every YAML workflow and every explicit job,
rejects a missing or bypassable guard, rejects unrecognized job layouts rather
than skipping them, and forbids write permissions in Rivloom build/check
workflows. Its regression test adds an unguarded job and verifies that the policy
fails. The policy job is required by the candidate build job. This local code
must be pushed before GitHub enforces it; repository rules/required status checks
are separate hosting settings and were not changed by this task.

## Roll back without rewriting history

Revert the desktop runtime pin and its coupled SDK/plugin/provenance changes to
the last accepted candidate, then rebuild and verify the desktop package. Keep
both source identities and acceptance records. Do not reset the official
upstream branch, force-push shared history, delete releases, or overwrite old
installers as a rollback technique. If runtime data migrations are involved,
first establish backward compatibility or restore an explicitly approved test
backup; switching an EXE alone does not prove a data downgrade is safe.
