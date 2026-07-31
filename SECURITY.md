# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `main` branch | ✅ Active |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report them privately using [GitHub's private vulnerability reporting](https://github.com/Hovibby/REPORT-CARD/security/advisories/new).

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (if safe to share)
- Any suggested fix

You will receive a response within **48 hours**. We will work with you to understand and address the issue before any public disclosure.

## Scope

The following are in scope:

- **Soroban contract** (`contracts/`) — logic bugs, auth bypasses, storage manipulation, reentrancy
- **Engine** (`engine/`) — relayer key exposure, RPC injection, source-verification bypass
- **Dashboard** (`web/`) — XSS, CSRF, authentication issues, API endpoint abuse
- **SDK** (`sdk/`) — supply-chain issues, data integrity

The following are out of scope:

- Vulnerabilities in third-party dependencies (report directly to those projects)
- Issues that require physical access to the machine
- Theoretical vulnerabilities without a realistic attack path

## Disclosure policy

We follow a **90-day coordinated disclosure** timeline. After a fix is released, we will publish a security advisory crediting the reporter (unless you prefer to remain anonymous).

## Bug bounty

There is currently no paid bug bounty programme. We offer public credit in the security advisory and in the CHANGELOG.
