---
name: deploy-and-rollback
description: Use when the user wants to deploy, publish, release, go live, test in nonprod, promote to production, roll back or undo a release, choose a branch strategy, change which branches deploy, or understand why a pipeline run failed or a release is waiting. Also use before merging to the default branch.
---

# Deploy and roll back

The platform owns the pipeline. The app repo has **no pipeline files**; pushing code is the only
deploy action. Never add `azure-pipelines.yml`, GitHub Actions deploy workflows, Bicep, Terraform
or scripts that call `az`, `docker push` or `kubectl`.

## The flow

```
branch ─push─▶ build ▶ platform check ▶ scan ▶ deploy to NONPROD ▶ smoke test
                                                     │
main (default branch) ─merge─▶ same pipeline + PROD RELEASE REQUEST ─approval─▶ PROD (same image)
```

| Event | What happens |
|---|---|
| Push to a branch matching `deploy.branches` (default all) | build → checks → vulnerability scan → deploy to **nonprod** → health/smoke test. Nonprod is shared by all branches: **last push wins**. |
| Push/merge to the default branch | the above, plus a **prod release request** with the same image digest. |
| Approval (platform team) | the exact image tested in nonprod is copied to prod and deployed. No rebuild. |
| Portal "Deploy to prod" | request prod for an earlier successful build. |
| Portal "Rollback" | redeploy a previously deployed image (prod needs approval). |

Image tag = full git commit SHA. The portal shows which branch, commit and image run in each
environment, who approved, and when.

## Before you push

1. Tests, lint and **`platform check`** pass locally.
2. `CHANGELOG.md` has an entry under `[Unreleased]` for anything users notice.
3. New secrets have values in the portal for every environment (`secrets-and-config`).
4. Database changes are backward compatible (`database-postgres` / `database-sql`).
5. The user agrees to push. Tell them: "This push deploys to nonprod, replacing what is there now."

## Before merging to the default branch

Merging requests a production release. Confirm with the user that:

- nonprod was tested with this exact commit (the portal shows the commit in nonprod),
- the CHANGELOG entries are complete and in plain language (owners and approvers read them),
- data migrations are expand-only (no drops) or the previous release no longer needs the data,
- they want this to go to production now.

Prefer merging through a pull request when the repo uses them.

## Branches

- Short-lived branches (`feature/…`, `fix/…`), merged soon. Long-lived branches drift and fight
  over nonprod.
- To stop some branches from deploying, set `deploy.branches` in `platform.yaml`, e.g.
  `["main", "feature/*", "fix/*"]`. The default branch itself is configured in the portal, not here.
- Commit messages: Conventional Commits (`feat: add CSV export`, `fix: correct VAT rounding`).

## Rollback

Two ways, choose with the user:

1. **Portal rollback (fast, no code change):** redeploys an earlier image. Use when production is
   broken now. Prod still needs approval. The database is **not** rolled back: this is why every
   migration must be backward compatible.
2. **Revert in git:** `git revert <commit>` → push → nonprod → merge → prod request. Use when the
   change should be undone permanently. Never rewrite history on the default branch.

After a rollback, the default branch still contains the bad change: revert or fix it before the
next merge, or the next release brings the problem back.

## When a pipeline run fails

1. The portal shows the failed step with a plain-language explanation and a "copy prompt for your
   AI agent" button. Ask the user to paste it.
2. Typical causes: `platform check` error (fix locally, re-run `platform check`), build error
   (run the build locally), vulnerability scan found a critical/high issue with a fix (update the
   dependency or base image patch version), smoke test failed (`/healthz` not reachable: port,
   crash at startup, missing env var or secret).
3. Fix, run checks locally, push again. Never try to bypass a check.
4. If the failure is about permissions, approvals, quotas or a missing resource, it is a platform
   matter: tell the user to contact the platform team.

## Common mistakes

- Adding a pipeline file "to make deploys work" → ignored by the platform and flagged as forbidden.
- Merging to `main` to "test something" → creates a prod release request.
- Two people pushing different branches and wondering why nonprod changed → last push wins.
- Assuming rollback restores data → it doesn't; data changes need their own plan.
- Forgetting to set a new secret in prod → prod deploy fails while nonprod worked.
