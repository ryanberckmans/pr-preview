# pr-preview

Every pull request gets its own live link, posted as a comment on the PR. While a repo is private, its links only open after signing in with Cloudflare Access; once it is public, they open for anyone.

pr-preview is a reusable GitHub Actions workflow for apps that run on Cloudflare Workers and are bundled by their build, such as apps built with the Cloudflare Vite plugin.

## How it works

Each push to a PR uploads a new version of a Worker that holds the repo's previews, with the preview alias `pr-<number>`. The link is `https://pr-<number>-<worker-name>.<subdomain>.workers.dev/`, and the comment is updated in place on every push. Pushes to the default branch update a preview named after that branch, such as `https://main-<worker-name>.<subdomain>.workers.dev/`, which the comment links for comparison. Nothing is ever deployed: the Worker's own address keeps answering 404.

Cloudflare calls these links aliased Version URLs. Its docs steer branch testing toward its newer Worker Previews, since a Version URL doesn't isolate a branch from production resources. Here the Worker and its D1 databases exist only for previews, so there are no production resources to share.

If an install, build or upload fails, the comment says so and keeps pointing at the last preview that worked. Each Worker has its own comment, so one repo can call pr-preview for several apps. An optional check command (tests, a performance budget) runs after the build; its result goes in the comment and never blocks the preview.

The workflow has three jobs, so your repo's code never runs next to the Cloudflare token:

- **build** runs your install, build and check commands, with no Cloudflare token, then collects the Wrangler config, the built Worker, its static assets and its D1 migrations.
- **deploy** uploads that output from a fresh runner with pr-preview's own pinned Wrangler. It is the only job with the token, and none of your repo's code runs in it.
- **report** posts or updates the PR comment.

## Privacy

Each run reads the repo's visibility from GitHub:

- A **private** or internal repo previews to the Worker `<worker-name>`, whose links require Cloudflare Access sign-in.
- A **public** repo previews to a separate Worker, `<worker-name>-public`, whose links are open. Set `force-private: true` to keep a public repo's previews private. If account-wide Access is on (see [Setup](#setup)), make that Worker public from its **Access** tab.

Private previews fail closed. Before uploading, pr-preview checks that the Worker's workers.dev address and its Version URLs both redirect to Cloudflare Access sign-in, at your team domain when `access-team-domain` is set. After uploading, it checks the new link the same way. If any check fails, no link is posted and the comment says what to fix. Once a private Worker exists, pr-preview never turns its workers.dev or Version URLs back on, so turning them off closes every old link.

Because private and public previews live in different Workers, making a repo public never opens its earlier private previews, and a private repo's comment never links a public preview.

## Setup

### 1. Cloudflare, once per account

1. Use a Cloudflare account just for previews. The token below can change every Worker and D1 database in its account, and preview Workers run whatever code a PR builds. You don't need a second login: open the account switcher (or the **Accounts** page) and select **Create Account** to add a separate Free account under your existing user.
2. Open **Workers & Pages** in the dashboard once, so the account has a workers.dev subdomain.
3. Create an API token under **My Profile → API Tokens → Create Token → Custom token** with these permissions, limited to that account:
   - Account · Workers Scripts · Edit
   - Account · D1 · Edit (only needed with the `d1` input)
4. Copy the account ID from **Account details** on the **Workers & Pages** page (it is also in the dashboard URL).
5. For private repos, set up **Cloudflare Zero Trust** and choose a team name. The Free plan is enough; its onboarding still asks for payment details, but the Free plan isn't charged. Your team domain is `<team>.cloudflareaccess.com`, and by default people sign in with their Cloudflare login.
6. For private repos, put every Worker in the account behind sign-in: on the **Workers & Pages** page, turn on the **Cloudflare Access** card ("Apply one account-wide Access policy across your Workers", which Cloudflare's docs call Protect all Workers). If it asks, choose **All traffic** and the **Cloudflare account** policy. Each Worker pr-preview creates is then protected from the start. **Previews only** isn't enough, since it leaves workers.dev addresses open.

### 2. The repo

1. Add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (**Settings → Secrets and variables → Actions**).
2. For a private repo, add the repository variable `PREVIEW_ACCESS_TEAM_DOMAIN` with your team domain.
3. Add `.github/workflows/preview.yml`, pinned to a full commit SHA from this repo's `main` branch:

```yaml
name: Preview

on:
  pull_request:
  push:
    branches: [main]

permissions: {}

concurrency:
  group: preview-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  preview:
    uses: ryanberckmans/pr-preview/.github/workflows/preview.yml@<commit SHA>
    permissions:
      contents: read
      pull-requests: write
    with:
      worker-name: my-app-preview
      wrangler-config: dist/my_app/wrangler.json
      access-team-domain: ${{ vars.PREVIEW_ACCESS_TEAM_DOMAIN }}
      d1: '{"DB":{"database_name":"my-app-preview","migrations_dir":"migrations"}}'
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

pr-preview checks out its own scripts at the commit that is running, so the SHA pins everything that handles the token.

### 3. Sign-in for a new private Worker

The first run in a private repo creates the Worker with a placeholder that answers 404. With account-wide Access on, the Worker is behind sign-in from the start, and the run goes on to post the link. Otherwise the run stops before uploading anything, and the comment says so. Then:

1. In Cloudflare, open **Workers & Pages → `<worker-name>` → Access**.
2. Select **Protect this Worker behind Access** and choose **All traffic**. **Previews only** leaves the workers.dev address open, so pr-preview won't post links.
3. Under **Authentication policy**, choose **Cloudflare account**, so only members of the account can sign in.
4. Select **Apply Access**, then re-run the workflow. The comment now has the link.

If Access is ever turned off, the next run posts no link and says why.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `worker-name` | required | A Worker just for this repo's previews, never your production Worker. Public repos use `<worker-name>-public`. `pr-<number>-<worker-name>` must fit in 63 characters. |
| `wrangler-config` | required | The Wrangler JSON config your build writes, relative to `working-directory`. With the Cloudflare Vite plugin it is `dist/<worker>/wrangler.json`. |
| `access-team-domain` | `''` | `<team>.cloudflareaccess.com`. When set, private previews must redirect to exactly this host. |
| `install-command` | `npm ci` | Installs dependencies. |
| `build-command` | `npm run build` | Builds the Worker and writes `wrangler-config`. |
| `check-command` | `''` | Runs after the build. Its result goes in the comment and never blocks the preview. |
| `check-timeout-minutes` | `10` | Time limit for `check-command`. A check that runs out of time counts as failed. |
| `node-version` | `22` | Node.js version for install, build and check. |
| `working-directory` | `.` | The app's folder in the repo. |
| `d1` | `{}` | JSON mapping each D1 binding to its preview database: `database_name`, and optionally `migrations_dir` and `database_id`. Missing databases are created, and migrations are applied before each upload. Every D1 binding in the config needs an entry. |
| `preview-vars` | `{}` | JSON object of the only plain-text variables previews get. |
| `force-private` | `false` | Keep previews private in a public repo. |
| `runs-on` | `ubuntu-24.04` | Runner for the jobs. |
| `timeout-minutes` | `20` | Time limit for the build job. |

Outputs: `url` (the preview link), `version-id` and `visibility`.

## What a preview gets

pr-preview writes the upload's Wrangler config itself, starting from the one your build wrote:

- **Kept:** code settings such as the compatibility date and flags, module rules, limits, placement and observability, plus `main` and static `assets`.
- **Replaced:** `name`, `vars` (only `preview-vars`), `d1_databases` (only the `d1` input) and the workers.dev and Version URL settings. Your build's own `vars` never reach a preview, since they may hold production values.
- **Dropped, and listed in the run log:** routes, custom domains, cron triggers and other settings pr-preview doesn't carry over. Source maps are never uploaded, because Wrangler would read whatever file a build's source map points to.
- **Refused:** bindings to other resources, such as KV, R2, Durable Objects, Queues, service bindings and AI, which a preview could otherwise share with production. The run fails and the comment says which.

Previews never get your production secrets: they run in their own Worker, which has none unless you add them in Cloudflare.

## Security

- Your repo's code runs only in the build job, which has no Cloudflare token and read-only access to the repo.
- The deploy job runs only pr-preview's code at the pinned commit and the Wrangler version in its lockfile, installed without install scripts. Wrangler runs from an empty folder with a minimal environment. Wrangler can start workerd, Cloudflare's local runtime, to profile a Worker that fails Cloudflare's startup limits; pr-preview turns workerd off in this job, so the build's code never runs next to the token.
- Anyone who can push a branch to your repo can get a preview built and uploaded, the same trust GitHub Actions already gives them. Pull requests from forks and from Dependabot get no preview, since they get no secrets.
- A preview Worker runs the code its PR built, with access to the preview D1 databases. A Cloudflare account used only for previews keeps that code, and the token, away from anything else.

## Limitations

- The build must bundle the Worker (`no_bundle: true` with `main`), or the Worker must be assets only. The Cloudflare Vite plugin writes this kind of config. `wrangler.toml` isn't read.
- github.com only: pr-preview relies on the `job.workflow_repository` and `job.workflow_sha` contexts, which GitHub Enterprise Server doesn't have.
- Each D1 binding has one preview database, shared by every PR and the default branch, so a migration in one PR applies to all of them.
- Previews stay up after their PR closes.
- In private repos, the runs use the repo owner's GitHub Actions minutes.

## Development

```sh
npm ci --ignore-scripts
npm test
```

The tests include a dry-run upload with the pinned Wrangler. The self-test workflow runs pr-preview on the small Worker in `test/fixture`.
