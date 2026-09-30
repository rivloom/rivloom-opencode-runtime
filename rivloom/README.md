# Rivloom OpenCode runtime

This fork's build profiles track upstream **v1.18.33**, commit
`51ef4be1d3c122f18fefb510dca8d778571f4f18`. Rivloom desktop consumes a clean
committed source build of this fork, with its own exact source and artifact
locks. Building this repository does not install or release the desktop
application. See [desktop integration](#desktop-integration) for the separate
consumer acceptance requirements.

## Windows build and verification

On Windows x64, install Git, Node.js **24.19.0**, and **PowerShell 7** (`pwsh`
on PATH), then run from this repository:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\rivloom\build.ps1
```

The script downloads a SHA256-checked Bun **1.3.14** into `rivloom/.tools`, installs
the frozen lockfile, compiles the Windows x64 CLI/server, and tests the real EXE
against an isolated local model fixture. It does not require provider credentials.
Subsequent source edits can use `-SkipInstall`; omit it when dependencies change.
Use `-RequireClean` for a traceable committed candidate, or `-SkipSmoke` only when
you intentionally want an unverified development build.

Output: `rivloom/dist/windows-x64/opencode.exe`, `runtime-manifest.json`,
`source-files.json`, `SHA256SUMS`, `smoke-report.json`, this README, and the
upstream license. The source inventory and artifact hashes in the schema 2
manifest bind the build to its inputs; the smoke report also binds to the
manifest. This profile writes schema 2. The previous `9b07cf4` Windows candidate
used schema 1 and has no source inventory; keep its verified artifact for rollback.
Re-run verification:

```powershell
node .\rivloom\smoke.mjs
```

Use `-OutputDirectory rivloom/dist/<candidate>` to isolate a development build;
verify it with `node rivloom/smoke.mjs --artifact rivloom/dist/<candidate>`.
The output directory must remain inside `rivloom/dist`. Existing output is
preserved before rebuilding, stale smoke success is invalidated, source inputs
must remain unchanged during compilation, and cached Bun archives/executables
are reverified before use.

Version strings include the source commit: `1.18.33-rivloom.<commit>`. Uncommitted
builds have an additional `.dirty` suffix. Generated binaries are unsigned.
The upstream browser UI is omitted because Rivloom provides its own UI. The
terminal CLI and HTTP server remain present. This profile targets normal x64
(AVX2); older CPUs and ARM64 need separate build profiles and verification.

`runtime.json` pins the baseline, toolchain, and checked-in public models.dev
catalog. Updating the catalog requires replacing `models.json` and its SHA256.
The dependency lock and these inputs are recorded in every artifact manifest.
The build is traceable; byte-for-byte reproducibility is not assumed.

One build compatibility patch separates the binary version from its npm plugin
dependency: the EXE keeps the Rivloom commit suffix, while automatic plugin
installation uses the source package's published version (currently 1.18.33).
Both HTTP configuration and TUI configuration use this value. No model, session
or tool execution behavior is patched.

## Linux x64 build and verification

The Linux client uses this fork too. Its profile is **Linux x86-64 baseline,
glibc**, with no embedded web UI. ARM64 and musl are not candidates in this
profile. Linux support is implemented by the four self-contained files in
[`linux/`](linux/), independently from the existing Windows recipe.

The verified 1.18.33 Linux runtime requires **glibc 2.30 or newer**. The main
ELF's highest required symbol is `GLIBC_2.17`, but its embedded
`@ff-labs/fff-bin-linux-x64-gnu/libfff_c.so`, which the smoke run actually
extracts, requires `GLIBC_2.30`. The embedded watcher requires
`GLIBCXX_3.4.22`; `librust_pty.so` and `libopentui.so` require `GLIBC_2.17`.
The ABI review identified all four embedded native ELFs and every
runtime-extracted ELF. Inspecting only `opencode` with `readelf` therefore
understates the runtime requirements. Across the exact candidate and bundled
Node, the highest measured requirements are `GLIBC_2.30`, `GLIBCXX_3.4.22`
and `CXXABI_1.3.11`. The complete Linux client retains Node's official support
minimum of `GLIBCXX_3.4.25` and Linux kernel 4.18 or newer, separately from
the measured symbol references.

The external recipe deliberately compiles a separate clean checkout of the
fixed core source in `linux/runtime.json`. The recipe is committed separately
after the core source identity is known. The schema 2 manifest records the
core source inventory and the separate recipe file hashes; it never claims
that newer build scripts were part of the pinned core commit.

On native Linux x64/glibc, install Git, Node.js **24.19.0**, Python 3, `make`,
and a C/C++ compiler toolchain (including libc development headers), then:

```sh
git clone --no-checkout https://github.com/rivloom/rivloom-opencode-runtime.git /path/to/clean-core
git -C /path/to/clean-core checkout --detach "$(node -p 'JSON.parse(require("fs").readFileSync("rivloom/linux/runtime.json", "utf8")).source.commit')"
node rivloom/linux/build.mjs --source /path/to/clean-core --output /path/to/candidate/linux-x64 --require-clean
```

The recipe always requires a clean core tree and verifies its commit, tree,
lockfile, public model catalog, license and reviewed build inputs. It downloads
the SHA256-pinned Bun **1.3.14** Linux baseline archive, verifies the cached
executable against that archive on every run, and uses Python's standard
library to extract exactly the expected binary. It installs frozen dependencies,
including native grammar dependencies that may invoke `node-gyp`,
compiles upstream's native normal/baseline targets, and selects only the baseline
ELF executable. `--skip-install` is available for unchanged dependencies.

Output contains `opencode` (executable), `runtime-manifest.json`, `source-files.json`,
`smoke-report.json`, `LICENSE`, the pinned core's `README.md`, and `SHA256SUMS`.
Eleven isolated real-binary checks must pass before the new candidate replaces
the requested output. Existing output is archived, incomplete stages are retained
for diagnosis, and source/recipe hashes must remain unchanged through build and
smoke verification. Checks use a loopback model fixture without provider
credentials; dependency installation still accesses public npm. The isolated
smoke process may inherit standard HTTP/HTTPS proxy variables for dependencies,
but always bypasses proxies for localhost and never inherits provider API keys
or the real home directory. Reverification:

```sh
node rivloom/linux/smoke.mjs --source /path/to/clean-core --artifact /path/to/candidate/linux-x64
```

The desktop repository keeps an exact copy of the four canonical recipe files
under `scripts/runtime-linux/` and pins their individual SHA256 values in
`shared/engine-source-linux.json`. The aggregate recipe digest is SHA256 over
`JSON.stringify` of filename/SHA256 pairs sorted by filename. Upgrade the
canonical recipe and its copied consumer together; do not silently edit one copy.
This makes the recipe reviewable before it is committed, while the compiled core
still comes from a fixed clean commit. It does not promise byte-identical builds.

`Rivloom runtime Linux x64` uses **ubuntu-22.04** and the same native recipe,
then uploads a `.tar.gz` candidate to preserve executable permissions. It has
read-only permissions and does not publish a Release or update downloads. The
workflow becomes available only after these local changes are committed/pushed.
The 1.18.33 candidate passed all eleven native smoke checks on WSL Ubuntu
with glibc 2.39, and its main, embedded and extracted native libraries received
the ABI review above. The cloud workflow has not run, and this local result
does not establish execution acceptance on every older distribution or CPU.
Repeat the native build, smoke and embedded-library ABI review for a new core pin.

## Rivloom prompt scaffold

The [prompt scaffold](../packages/opencode/src/rivloom/prompts/README.md) reserves
an empty base prompt and a module for future loading and selection. It is not
connected to runtime requests and does not change model behavior.

## CI

`Rivloom runtime Windows` is configured to build pushes to `dev`,
`codex/runtime-v1` and branches matching `rivloom/**`, pull requests, and manual
runs. It uses a standard GitHub Windows runner, requires clean committed inputs,
runs the same isolated tests, and uploads a candidate artifact for 30 days.
It does not publish a Release or modify desktop downloads. The policy job checks
that every inherited upstream job is restricted to the upstream repository;
only Rivloom build/check jobs may run in this fork, with read-only permissions.
CI also runs the core/opencode package type checks and upstream configuration,
TUI configuration, plugin, npm resolution, browser, MCP OAuth, timeout,
provider-transform and message-attachment regression tests. Model responses
come from the loopback fixture; dependency installation still needs access to
public npm.

Scheduled/manual workflows must be present on the default branch. Local
validation is not evidence that a GitHub Actions run has completed.

## Follow official updates

```powershell
node .\rivloom\check-upstream.mjs
node .\rivloom\check-upstream.mjs --json
```

The read-only check resolves the official stable release tag to its full commit,
verifies the pinned tag has not moved, and reports development-branch divergence
separately. It does not merge, change the pin, or publish anything. The configured
daily workflow preserves the report and requires attention when a newer stable
release is available. See [UPSTREAM.md](UPSTREAM.md) for the controlled upgrade,
regression and rollback procedure.

## Desktop integration

Develop runtime code in this fork; keep the desktop and runtime repositories
separate. Both desktop profiles pin an exact clean core commit and build or
import a verified candidate, validate the manifest and isolated smoke report,
and record a consumer-side build receipt. The Windows producer writes schema 2;
the Linux producer also binds the separately pinned recipe. Committing runtime
build tools does not change the desktop source lock. Upgrade that lock and its
coupled SDK/plugin/provenance inputs after reviewing the candidate.

The desktop development source adopted **1.18.33** on **2026-09-30**:

| Input | Adopted identity |
| --- | --- |
| Runtime core commit | `655285f835f8560dcf3b6c484d0e2f1faba9e67d` |
| Runtime core tree | `9bbec9cc7eb7062cb7bda8d3e8a4ad6b1c428351` |
| Linux recipe commit | `0649e56a563e82dfe0e9a0e5e860f14422f62d24` |
| Binary version | `1.18.33-rivloom.655285f835f8` |
| SDK and plugin versions | `1.18.33` |

The Windows producer passed eleven real-EXE smoke checks, and the desktop's
Windows consumer passed ten engine smoke checks against the same fixed core.
The Linux producer passed eleven native checks with the separate recipe above.
The desktop Linux consumer imported that schema 2 artifact and verified its
source lock and build receipt; all 29 native Linux desktop tests passed.
These checks use isolated local model fixtures. Runtime type checks and the
904 Rivloom/core/configuration/provider regression checks passed; the updated
Linux recipe and workflow policy also passed thirteen targeted checks.

The published **Rivloom 0.1.29** remains bound to
`1.18.31-rivloom.9b07cf442a7e` and SDK/plugin `1.18.31`. The development pin
does not change that release's artifacts, download information, signature or
historical acceptance record. New desktop packaging, installation, updates
and real-provider OAuth require their own acceptance before a later release.

A source-built EXE is not assumed to be byte-identical between machines. Desktop
CI must fetch the full pinned commit and build that source, validate the produced
manifest and smoke results, then record the actual binary SHA256 used in its
runtime lock/provenance. Importing a prebuilt artifact instead requires its exact
reviewed SHA256 and matching source identity. Do not substitute a moving latest
release URL, silently fall back to the official EXE, or overwrite a file under
`node_modules` as the integration method.

Align the desktop SDK/plugin versions, engine version guard, build preparation,
engine lock/provenance, licenses and CI together. Run desktop integration,
account, installer and update checks before release. The public desktop release
and existing user installations remain unchanged until a separately authorized
release; current local installer acceptance belongs to the desktop repository.

Smoke verification covers binary identity, HTTP authentication, provider listing,
session streaming and persistence, controlled tool approval, and cancellation.
It is not a complete desktop integration or real-provider OAuth acceptance test.
