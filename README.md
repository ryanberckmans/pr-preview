# pr-preview

Every pull request gets its own live link, posted as a comment on the PR. While a repo is private, its links only open after signing in with Cloudflare Access; once it is public, they open for anyone.

pr-preview is a reusable GitHub Actions workflow for apps that run on Cloudflare Workers and are bundled by their build, such as apps built with the Cloudflare Vite plugin.

## How it works

Each PR gets a Cloudflare [Worker Preview](https://developers.cloudflare.com/workers/previews/) named `pr-<number>`, in a Worker that holds the repo's previews. Its link is `https://pr-<number>-<worker-name>.<subdomain>.workers.dev/`. Every push deploys to the same preview, so the link always shows the latest commit, and the comment is updated in place. When the PR is merged or closed, pr-preview deletes its preview. Pushes to the default branch update a preview named after that branch, such as `https://main-<worker-name>.<subdomain>.workers.dev/`, which the comment links for comparison. Nothing is deployed to production: the Worker's own address keeps answering 404.

If an install, build or upload fails, the comment says so and keeps pointing at the last preview that worked. Each Worker has its own comment, so one repo can call pr-preview for several apps. An optional check command (tests, a performance budget) runs after the build; its result goes in the comment and never blocks the preview.

Two jobs keep your repo's code away from the Cloudflare token:

- **build** runs your install, build and check commands, with no Cloudflare token, then collects the Wrangler config, the built Worker, its static assets and its D1 migrations.
- **publish** uploads that output from a fresh runner with pr-preview's own pinned Wrangler, or deletes a closed PR's preview, then posts or updates the PR comment. None of your repo's code runs in it.

A push runs both jobs. A closed PR runs only publish, since deleting its preview needs no build.

## Privacy

Each run reads the repo's visibility from GitHub:

- A **private** or internal repo previews to the Worker `<worker-name>`, whose links require Cloudflare Access sign-in.
- A **public** repo previews to a separate Worker, `<worker-name>-public`, whose links are open. Set `force-private: true` to keep a public repo's previews private. If account-wide Access is on (see [Setup](#setup)), make that Worker public from its **Access** tab.

Private previews fail closed. Before uploading, pr-preview checks that the Worker's workers.dev address and its preview links both redirect to Cloudflare Access sign-in, at your team domain when `access-team-domain` is set. After uploading, it checks the new links the same way. If any check fails, no link is posted, the PR's preview is deleted, and the comment says what to fix. Once a private Worker exists, pr-preview never turns its workers.dev address or its Version URLs setting (which also serves preview links) back on, so turning them off closes every old link.

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
6. For private repos, put every Worker in the account behind sign-in: on the **Workers & Pages** page, turn on the **Cloudflare Access** card ("Apply one account-wide Access policy across your Workers", which Cloudflare's docs call Protect all Workers). In its dialog, choose **All traffic** (it defaults to **Previews only**, which leaves workers.dev addresses open), add the **Cloudflare account** policy, then select **Enable Access**. Each Worker pr-preview creates is then protected from the start. Avoid the **Email domain** policy with a public email domain such as gmail.com, since it lets in everyone with an address there.

### 2. The repo

1. Add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (**Settings → Secrets and variables → Actions**). One token can serve every repo that previews to the account, but then anyone who can push to one of those repos can change the others' previews.
2. For a private repo, add the repository variable `PREVIEW_ACCESS_TEAM_DOMAIN` with your team domain.
3. Add `.github/workflows/preview.yml`, pinned to a full commit SHA from this repo's `main` branch:

```yaml
name: Preview

on:
  pull_request:
    types: [opened, synchronize, reopened]
  pull_request_target:
    types: [closed]
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

The `pull_request_target` trigger lets pr-preview delete a PR's preview when the PR closes, merged or not; without it, previews stay up until Cloudflare's limit pushes them out. It is `pull_request_target` because GitHub runs no `pull_request` workflow for a PR with merge conflicts, as abandoned PRs often have. pr-preview checks out its own scripts at the commit that is running, so the SHA pins everything that handles the token.

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
| `runs-on` | `ubuntu-24.04` | Runner for the build job and, unless overridden, the publish job. |
| `publish-runs-on` | `''` | Optional runner for publishing, cleanup and PR comments. Empty uses `runs-on`. |
| `timeout-minutes` | `20` | Time limit for the build job. |

Outputs: `url` (the preview link), `deployment-id` and `visibility`.

To use GitHub's less expensive runner for publishing while keeping the build on
`ubuntu-24.04`, add `publish-runs-on: ubuntu-slim` to the caller's `with` block.
Existing callers keep their current runners. The two jobs remain separate.
GitHub limits `ubuntu-slim` jobs to 15 minutes; on that runner, pr-preview limits
the upload step to 10 minutes and the comment step to 3 minutes so an upload
timeout can still be reported. Use the standard runner for longer uploads or D1
migrations. Other runners retain the 25-minute publish job limit.

## What a preview gets

pr-preview writes the upload's Wrangler config itself, starting from the one your build wrote:

- **Kept:** code settings such as the compatibility date and flags, module rules, limits, placement and observability, plus `main` and static `assets`.
- **Replaced:** `name`, `vars` (only `preview-vars`), `d1_databases` (only the `d1` input), `previews` and the workers.dev and Version URL settings. Worker Previews take their variables and bindings from the config's `previews` block, which pr-preview writes. Your build's own `vars` never reach a preview, since they may hold production values.
- **Dropped, and listed in the run log:** routes, custom domains, cron triggers and other settings pr-preview doesn't carry over. Source maps are never uploaded, because Wrangler would read whatever file a build's source map points to.
- **Refused:** bindings to other resources, such as KV, R2, Durable Objects, Queues, service bindings and AI, which a preview could otherwise share with production. The run fails and the comment says which.

Previews get no secrets. They run in their own Worker, and pr-preview creates them without the Previews settings in Cloudflare's dashboard, so secrets added there don't reach them either.

## Security

- Your repo's code runs only in the build job, which has no Cloudflare token and read-only access to the repo.
- The publish job runs only pr-preview's code at the pinned commit and the Wrangler version in its lockfile, installed without install scripts. It works out the Worker, the preview's name and its visibility from the event itself, never from the build job. Only its upload and delete steps get the Cloudflare token, and the comment step gets only the GitHub token. Wrangler runs from an empty folder with a minimal environment. Wrangler can start workerd, Cloudflare's local runtime, to profile a Worker that fails Cloudflare's startup limits; pr-preview turns workerd off in this job, so the build's code never runs next to the token.
- Anyone who can push a branch to your repo can get a preview built and uploaded, the same trust GitHub Actions already gives them. Pull requests from forks and from Dependabot get no preview, since they get no secrets.
- `pull_request_target` runs have the repo's secrets, even for pull requests from forks, so pr-preview uses them only to delete a closed PR's preview. They check out none of the PR's code, and PRs from forks are skipped.
- A preview Worker runs the code its PR built, with access to the preview D1 databases. A Cloudflare account used only for previews keeps that code, and the token, away from anything else.

## Limitations

- The build must bundle the Worker (`no_bundle: true` with `main`), or the Worker must be assets only. The Cloudflare Vite plugin writes this kind of config. `wrangler.toml` isn't read.
- github.com only: pr-preview relies on the `job.workflow_repository` and `job.workflow_sha` contexts, which GitHub Enterprise Server doesn't have.
- Each D1 binding has one preview database, shared by every PR and the default branch, so a migration in one PR applies to all of them.
- Worker Previews are an open beta. Cloudflare has open reports of a deleted preview's link still answering for hours ([workers-sdk#15945](https://github.com/cloudflare/workers-sdk/issues/15945)); a private preview's link still requires sign-in meanwhile.
- A Worker keeps at most 100 previews on Cloudflare's Free plan (500 on paid plans). Beyond that, Cloudflare deletes the least recently updated one.
- Links made by pr-preview before it used Worker Previews are aliased Version URLs. Cloudflare can't delete them one at a time, and doesn't document which of the two answers when a new preview has the same name. When upgrading, change `worker-name` so previews start in a new Worker; open pull requests keep their old links until their next push. Delete the old Worker (**Workers & Pages → old Worker → Settings → Delete**) once you no longer need those links. Without account-wide Access, protect the new Worker as in [step 3](#3-sign-in-for-a-new-private-worker).
- In private repos, the runs use the repo owner's GitHub Actions minutes: two jobs for each push, one when a PR closes.

## Development

```sh
npm ci --ignore-scripts
npm test
```

The tests run the pinned Wrangler's `preview` command against a local stand-in for Cloudflare's API. The self-test workflow runs pr-preview on the small Worker in `test/fixture`, with its publish job on `ubuntu-slim`.
