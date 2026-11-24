# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| latest commit on `main` | yes |
| older | no |

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately with GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**.

Include: affected version, a description, steps to reproduce, and the impact you see. Never include real secrets or personal data in a report; describe where they appear instead.

## What to expect

This is a one-person project maintained on a best-effort basis. The maintainer aims to send an initial response within **14 days**. A fix date is not promised.

## Scope

In scope: the local server and analysis engines (`uygulama/`), the isolation helpers, and the reusable modules (`moduller/`), including secret redaction and the handling of untrusted source archives. Out of scope: weaknesses of the third-party tools the app inspects. Note that the isolation layer is not yet fully tested (see README).
