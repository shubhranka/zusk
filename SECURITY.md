# Security policy

Zusk holds database credentials and runs SQL against real servers, so security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub instead:

1. Go to the [Security tab](https://github.com/shubhranka-z/zusk/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

You'll get a reply within a week. Once a fix is ready, it will ship in a new release, and you'll be credited in the advisory unless you'd rather not be.

## Supported versions

Only the latest release gets security fixes.

## What's in scope

Reports are especially welcome about:

- Writing to a database while read-only mode is on.
- Passwords leaking out of the OS keychain, for example into logs, the saved connection file or the webview.
- The webview reaching the database, the file system or the network beyond the commands it's meant to call.
- TLS checks being skipped in the `verify-ca` or `verify-full` modes.

The demo database in `docker-compose.yml` uses fixed credentials and a self-signed certificate on purpose. It's for local development only and isn't in scope.
