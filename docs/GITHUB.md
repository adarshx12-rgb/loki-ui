# GitHub App setup (read-only)

NodePilot uses a **GitHub App** with read-only permissions on the repositories you select.
It never asks for passwords, and installation tokens stay on the server (they are never
sent to the browser). API version header: `X-GitHub-Api-Version: 2026-03-10`.

## 1. Create the App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**

- **Homepage URL**: anything (e.g. `http://127.0.0.1:4317`).
- **Webhook**: optional. Active only if you have a public URL (see below). Set a random **Webhook secret**.
- **Repository permissions** (all *Read-only*): Contents, Metadata, Pull requests, Checks, Actions.
- **Subscribe to events** (if using webhooks): Push, Pull request, Check run, Check suite, Workflow run.
- Where can it be installed: *Only on this account*.

After creating it: note the **Client ID** (and App ID), generate a **private key** (`.pem`),
then **Install App** on your account and choose *Only select repositories*. The
installation id is the number at the end of the installation's settings URL
(`…/settings/installations/<id>`).

## 2. Configure NodePilot

In `.env` (git-ignored):

```ini
GITHUB_APP_CLIENT_ID=Iv23li...
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=C:\Users\me\.secrets\nodepilot.private-key.pem
GITHUB_APP_INSTALLATION_ID=7654321
GITHUB_WEBHOOK_SECRET=<the webhook secret>
```

Keep the `.pem` outside the repository. Restart the server, then **Connections → GitHub**:
enter owner / repository / branch → **Select** → **Refresh**. You will see the repository,
recent commits on the branch, open pull requests, check runs on the head commit and
recent Actions workflow runs.

Auth flow: the server signs a short-lived RS256 JWT (`iat` 60 s in the past, `exp` 9 min,
`iss` = client ID) and exchanges it for an installation token scoped to the selected
repository and to the read permissions above. Tokens are cached until shortly before expiry.

Without credentials the panel shows **Not connected** and lists what is missing.

## 3. Webhooks

GitHub can only deliver webhooks to a **publicly reachable** URL. `localhost` does not work
by itself. Options:

- **Polling (no public URL)**: use **Refresh** in the panel. Works whenever API credentials are configured.
- **Tunnel**: expose `http://127.0.0.1:4317/api/github/webhook` with a tunnel of your choice and set the App's webhook URL to `https://<tunnel-host>/api/github/webhook`. Add the tunnel host to `NODEPILOT_ALLOWED_HOSTS` (the server rejects unknown `Host` headers), or configure the tunnel to rewrite `Host` to `127.0.0.1:4317`. Only the webhook route is meant to be reached this way; everything else still requires pairing. Stop the tunnel when you're done.

Every delivery is verified with HMAC-SHA256 (`X-Hub-Signature-256`, constant-time
comparison), de-duplicated by `X-GitHub-Delivery`, and associated with the selected
repository (deliveries for other repositories are recorded but ignored). Relevant events
trigger a refresh.

## 4. Local webhook test (no GitHub involved)

```bash
GITHUB_WEBHOOK_SECRET=<same secret> node scripts/github-webhook-test.mjs <owner>/<repo> push
```

Expected:

```
valid signature      → 202 {"result":"accepted"}            (or "not associated" for another repo)
same delivery again  → 200 {"result":"duplicate delivery ignored"}
tampered signature   → 401 {"result":"Invalid signature"}
```

You can also use **Redeliver** in the App's *Advanced* tab once a tunnel is running.
