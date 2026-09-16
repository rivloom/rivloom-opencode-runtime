# Rivloom OpenCode runtime (Windows)

This fork's Windows build profile starts at upstream **v1.18.31**, commit
`014614d35b397775e5d397a490fc72368c894ec2`. Rivloom's desktop currently uses the
official **1.18.25** executable. Building this repository does not replace it.

## Build and verify

On Windows x64, install Git and Node.js **24.19.0**, then run from this repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\rivloom\build.ps1
```

The script downloads a SHA256-checked Bun **1.3.14** into `rivloom/.tools`, installs
the frozen lockfile, compiles the Windows x64 CLI/server, and tests the real EXE
against an isolated local model fixture. It does not require provider credentials.
Subsequent source edits can use `-SkipInstall`; omit it when dependencies change.
Use `-RequireClean` for a traceable committed candidate, or `-SkipSmoke` only when
you intentionally want an unverified development build.

Output: `rivloom/dist/windows-x64/opencode.exe`, `runtime-manifest.json`,
`SHA256SUMS`, `smoke-report.json`, and the upstream license. Re-run verification:

```powershell
node .\rivloom\smoke.mjs
```

Version strings include the source commit: `1.18.31-rivloom.<commit>`. Uncommitted
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
installation uses the source package's published version (currently 1.18.31).
Both HTTP configuration and TUI configuration use this value. No model, session
or tool execution behavior is patched.

## CI

`Rivloom runtime Windows` builds on pushes to `codex/runtime-v1` and `rivloom/**`,
and supports manual runs once installed on the default branch. It uses a standard
GitHub Windows runner, runs the same isolated tests, and uploads a candidate
artifact for 30 days. It does not publish a Release or modify desktop downloads.
Inherited upstream workflows are not the Rivloom build entry point.
CI also runs the core/opencode package type checks and upstream configuration,
TUI configuration, and plugin regression tests. Model responses come from the
loopback fixture; dependency installation still needs access to public npm.

## Future desktop adoption

Develop runtime code in this fork; keep the desktop and runtime repositories
separate. Before switching the desktop, pin a successful committed runtime
artifact and its SHA256, align the desktop SDK/plugin versions with this baseline,
and update the desktop engine version guard, binary source, build preparation,
engine lock/provenance, licenses and CI together. Run the desktop's integration,
account, installer and update checks before release. Do not overwrite the binary
in `node_modules` as a substitute for those changes.

Smoke verification covers binary identity, HTTP authentication, provider listing,
session streaming and persistence, controlled tool approval, and cancellation.
It is not a complete desktop integration or real-provider OAuth acceptance test.
