# Third-party notes

This repository does not bundle third-party code. The app fetches the following at run time, pinned to an exact version or commit and verified by hash, into `uygulama/.cache/` (git-ignored). Their licenses apply to those downloads; check them before redistributing the cache.

| Component | How it is used | License (as stated by the upstream project; verify at the pinned version) |
|---|---|---|
| `modern-web-guidance` 1.0.0 (npm) | Read-only guidance lookup (search and retrieve only; no install scripts are run) | Apache-2.0 for the software; the guides carry CC-BY-4.0 attribution kept inside the package |
| `coderamp-labs/gitingest` (pinned commit) and its Python dependencies listed in `uygulama/gitingest-win-py312.lock` | Repository ingestion in the repository lab | See the upstream repository |
| `o200k_base.tiktoken` encoding file (hash-pinned) | Token counting | See the upstream source |

`uygulama/gitingest-win-py312.lock` lists dependency names, versions and hashes only; it contains no third-party code.

Material of unclear license was left out of this repository on purpose: a vendored copy of an example product ("Agentic OS" reference sample) and archived third-party package copies used during development.
