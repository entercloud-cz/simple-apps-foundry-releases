# SAF – Simple Apps Foundry

SAF deploys and runs small business apps, built with AI coding agents, on Microsoft Azure: one delivery pipeline,
Microsoft Entra ID sign-in and a portal where people request, approve and run their apps. A company runs its own
instance of it, in its own tenant.

**This repository publishes SAF's releases.** The product's full source is not here. A release tag holds only the
files an instance's pipelines read.

- **Every release:** <https://github.com/entercloud-cz/simple-apps-foundry-releases/releases>. Each one carries
  the release bundle: the platform CLI, the pipeline files, `release.json` and `SHA256SUMS`. Candidates
  (`-rc.N`) are marked as pre-releases.
- **The tags**, from `v0.2.0-rc.1` on: the tag `<version>` points to a commit without a parent. Its files are
  exactly the bundle's pipeline files (`pipelines/azure-devops`, `infra`, `config/schema`, `templates`,
  `tools/platform-cli` and `images/images.json`). The commit is computed from the release's core commit, and
  `release.json` names it as `mirror.commit`. Tags are never moved or deleted. `v0.1.0` and `v0.1.0-rc.56` are
  older and point to this README.
- **The images**, from the first release on:
  - `ghcr.io/entercloud-cz/saf-portal`
  - `ghcr.io/entercloud-cz/saf-jobs`
  - `ghcr.io/entercloud-cz/saf-placeholder`

  An instance pins each image by digest.

**Taking a release.** An instance sets `coreReleases.repository: https://github.com/entercloud-cz/simple-apps-foundry-releases`
and `coreImages.registry: ghcr.io/entercloud-cz`, and pins `coreVersion` to the release's tag. On Azure DevOps,
`instance.sh core <version> --apply` copies the tag into the instance's own `core` repository. Before it pushes,
it downloads the release anonymously, checks the tag against `release.json` and checks every file against the
checksums. To check a release's files by hand, run `sha256sum --check --strict SHA256SUMS`.

**The current release is [v0.1.0](https://github.com/entercloud-cz/simple-apps-foundry-releases/releases/tag/v0.1.0)**,
the first. Its `RELEASE-NOTES.md` opens with the upgrade notes. It has no tag with files, so `instance.sh core`
takes `v0.2.0-rc.1` and later.
