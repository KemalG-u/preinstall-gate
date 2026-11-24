> 🚧 **Status: active development.** It works for the author; interfaces may change.

# urun-tani ("Ürün Tanı · Kapı")

[Türkçe README](README.tr.md)

A local web app that helps you look at an AI tool, skill or MCP server **before** you install it. Point it at a GitHub repository, a `SKILL.md`, a ZIP file or local files and it explains in plain language what the tool offers, which behaviours and security-relevant signs it can see in the code, and what it could not check. A "gate" trial can run a small sample tool in a separate environment with an allow-list of actions and show which permissions an update asks for again.

The user interface and most documentation inside the code are in Turkish; this README and the repository metadata are in English.

## Why

Installing agent tools and skills means running someone else's code with your files and keys in reach. A short, honest read of what the code does (and what was not tested) before installing is cheap compared with cleaning up afterwards.

## What is in the repository

| Path | What it is |
|---|---|
| `uygulama/` | The local server (`sunucu.cjs`, port 4178), the browser UI, the source/repository/workflow analysis engines, and the isolation helpers. |
| `moduller/model-kapisi/` | Standalone, zero-dependency module that resolves a "role" (cheap/fast, deep, long-context, vision, embedding ...) to an available model or CLI agent, with a circuit breaker and secret-safe `.env` handling. Has its own README. |
| `moduller/proje-hafizasi/` | Standalone, zero-dependency project memory and hand-over module with an evidence checker and a small live board. Has its own README. |

## Quick start

Requirements: Node.js 22.18 or newer. Python 3.12 is needed by some analysis paths. The isolated trials were written for Windows with WSL2.

```sh
npm start
# then open http://127.0.0.1:4178/   (do not open the HTML file directly)
```

Use `URUN_TANI_PORT` to change the port. The server listens on `127.0.0.1` only.

On first use the app downloads pinned third-party packages into `uygulama/.cache/` (see [THIRD-PARTY.md](THIRD-PARTY.md)); no `npm install` is needed.

## Tests

```sh
npm test            # 14 pass, 1 skipped (live environment test), no network needed
npm run test:depo   # repository-lab test: needs network access to GitHub and Python 3.12
```

The skipped test checks a real machine (WSL distributions, `gh` login, a local router profile, an SSH alias); enable it with `MODEL_KAPISI_LIVE=1` (SSH alias via `MODEL_KAPISI_SSH_TARGET`, default `vps`).

## Limits and unverified claims

- **Isolation and WSL tests are not done yet.** The isolation layer is written but has not had a full independent test pass. Do not treat a "gate" trial as a security boundary or as proof that a tool is safe.
- Static analysis only reports what is visible in the code and descriptions it was given. A clean report is not a guarantee.
- Written and tried on Windows only. Linux and macOS are untested; CI runs on Windows only.
- The built-in "Agentic OS reference example" links in the UI point to files that are not part of this repository and will not open.
- Interface language is Turkish only.
- The repository-lab test downloads real public repositories, so it depends on network and upstream availability.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party notes: [THIRD-PARTY.md](THIRD-PARTY.md).
