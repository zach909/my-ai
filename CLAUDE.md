# NO THIRD-PARTY CODE (standing rule from the owner; read this first, every session)

The owner has said this many times and it must never need saying again. The full text is in `AGENTS.md`; this is the part Claude must follow without being reminded.

- **Never add third-party code of any kind.** No npm, pip or cargo packages; no vendored or cloned source; no SDKs, CLIs, apps or models; no copying code from other projects, websites, Stack Overflow or docs; no `npm install <pkg>`, `pip install`, `npx <pkg>` or `git clone` of someone else's repo, not even "just to test". Write it with Node built-ins, the Python standard library, and this project's own modules.
- **If a task seems to need third-party code, stop and ask.** Do not pick a library and add it, and do not add a dependency to get past a failing step. Say what you need and why, and wait for a fresh yes.
- **The only exception is the one the owner named:** web search through an open-source SearXNG instance. It is a service the owner runs; nothing from it is vendored or imported. Build and test tools already present: `typescript`, `@types/node`, `vitest`.
- **Ollama is banned.** Do not use, call, install, start, configure, vendor, import or reference Ollama in any form: no Ollama server, CLI, HTTP endpoint, client library, model files or Go source. The earlier exception for an Ollama model over HTTP is revoked. Do not substitute a similar local-model runner (llama.cpp, LM Studio, vLLM and so on) either; ask first. Only a fresh, explicit yes from the owner can lift this ban.
- **No tokenizer.** Text, audio and images enter the mesh as raw bits through the Zip Loop. No tokenizers, outside embeddings or speech-to-text.
- **Check before claiming.** Look at the files before saying something is or is not third-party or in the repo. Do not describe code from memory.
- **The rule is enforced.** `node scripts/check-no-third-party.mjs` must pass before you commit or finish. Hooks in `.claude/settings.json` will block installs, clones and edits that add third-party code. If the check or a hook blocks you, remove the third-party code and tell the owner; never edit the guard files (`scripts/check-no-third-party.mjs`, `.third-party-allowlist.json`, `.githooks/`, `.claude/hooks/`, `.claude/settings.json`, the no-third-party workflow), widen the allow-list, use `--no-verify`, or find another route around the block.
- **Accepted baseline (owner's decision).** The 533 findings `node scripts/check-no-third-party.mjs` reports today (for example `numpy` in `quantize/`, `cv2` in `atlas/vision.py`, `androidx` in `mobile/android-standalone/`) are the owner's own code and are accepted as they are. Do not remove, rewrite or "fix" them, and do not base other work on them or on the Android part. The rule still bites for anything NEW: compare against the baseline and make sure your change adds no finding (the count must not go up). Never edit the guard files or the allow-list to change this.
- **Code that is the owner's, yours, or another AI's output is fine. Code written by someone else and published is not.** If you are unsure which a piece of code is, treat it as not allowed and ask.

See `AGENTS.md` for the visual style rules and the dev environment notes.

# TARGET PLATFORM: LINUX, PARTICULARLY DEBIAN, AND KOS (standing rule from the owner)

This whole repository is meant for **Linux, particularly Debian**, and for **KOS** (kernal-os, the operating system it runs in). Written down so other AIs know.

- **Do not focus on Android, iOS, Windows or macOS.** Do not spend work, tests, fixes, features or optimization passes on `mobile/`, `desktop-app/` or the Windows and macOS paths. New work targets Linux first and only.
- **The existing non-Linux code stays until the owner says to remove it.** Do not delete it on your own and do not extend it. The owner chose "write it down", not "delete it".
- **When a task or a check points at those parts** (for example third-party findings in `mobile/android-standalone/`), say so and ask; do not treat them as the priority.
- Linux specifics are fine and expected: systemd user services, `/proc`, `/sys`, Debian packaging and paths.

See `AGENTS.md` for the same rule next to the platform notes.

# WHAT "OPTIMIZED" MEANS (standing rule from the owner)

When the owner says "optimized" or "optimize", it means **everything**, not whichever part is nearest.

**Layers (all of them):** the model (`asi_core/`, `model && skills manager/`, `models && skills/`, `training/`, `benchmarks/`), the harness (`interface/`, `src/`, `scripts/`, `config/`, the build/test/Docker flow), and the plugins (`plugins/`, `plugin_manager/`, `extension_system/`, `extension-builder/`, `browser-extension/`, `mobile/`).

**Dimensions (each layer is measured against each):**
- **Speed:** startup, request latency, agent-loop turn time, plugin load time, build and test time.
- **Modifiability:** any plugin can be added, changed or combined without touching core; every plugin registers through one path.
- **Security:** auth gate, permissions, plugin sandboxing, secrets, safe defaults.
- **RAM:** resident memory, no leaks over long sessions, lazy loading, bounded caches.
- **Drive:** footprint, write churn, bounded logs, memory and generated data.
- **Network:** fewer and smaller requests, caching, local-first. SearXNG stays the only outside service.
- **Computer access:** files, desktop, browser, camera, microphone and OS control that work reliably with little friction.
- **Ease of use:** setup, first run, error messages and UI need fewer steps and no manual fixes.
- **Repository size:** the whole repo takes as little space as possible, both the checkout and `.git`. Measure `du -sh .git` and the checkout separately, and list the largest tracked files. Remove dead code, duplicates, generated files that can be rebuilt, and unused data; compress or split large data the project itself produces; keep logs and generated output out of git. Rewriting git history (squashing, filter-branch, force-push) is destructive and affects every clone: never do it without a fresh, explicit yes from the owner. Deleting files the owner may still want (training data, docs, the `src/` dashboard source) also needs a yes; propose it first.
- **Battery:** idle costs almost nothing; timers and polling stop or slow when hidden or unplugged; animation and heavy work scale down on battery; sensors are event-driven, not polled. The phone (`mobile/`, `/app`) matters most.

**How to do it:**
1. Measure first. Get a baseline for each dimension before changing anything, and report before and after numbers. Do not make a change that cannot be shown to help.
2. Cover every layer and every dimension in one pass. If one is skipped, say which and why.
3. Rank findings by gain against risk. Apply safe wins; show the owner risky ones (changes to behavior, permissions or the plugin API) before applying.
4. Keep behavior and the visual style (see `AGENTS.md`) identical unless a tradeoff is flagged. Cut animation cost by lowering frame rate and density, never by changing the look.
5. Resolve conflicts this way: security is never weakened for convenience or access; on battery, lower background work but never the latency of something the user just asked for; prefer lazy loading and bounded caches to unbounded ones; all dangerous capabilities go through one permission gate with explicit grants.
6. All the no-third-party rules above still apply to optimizing: no performance libraries, no native modules, no local-model runners, no tokenizers. If the best fix needs one, stop and ask. Never edit the guard files to make a speedup or security change.
7. Before finishing: `node scripts/check-no-third-party.mjs`, `npm run lint:types` and `npx vitest run` must pass.
