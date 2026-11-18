# SAF – Simple Apps Foundry

SAF deploys and runs small business apps, built with AI coding agents, on Microsoft Azure: one delivery pipeline,
Microsoft Entra ID sign-in and a portal where people request, approve and run their apps. A company runs its own
instance of it, in its own tenant.

**This repository holds releases and nothing else.** The product's source is not here.

- **Every release:** <https://github.com/entercloud-cz/simple-apps-foundry-releases/releases>. Each one carries
  the release bundle: the platform CLI, the pipeline files and `SHA256SUMS`.
- **The images**, from the first release on:
  - `ghcr.io/entercloud-cz/saf-portal`
  - `ghcr.io/entercloud-cz/saf-jobs`
  - `ghcr.io/entercloud-cz/saf-placeholder`

  An instance pins each image by digest.

**The current release is [v0.1.0](https://github.com/entercloud-cz/simple-apps-foundry-releases/releases/tag/v0.1.0)**,
the first. Its `RELEASE-NOTES.md` opens with the upgrade notes. Before you use a release's files, check them with
`sha256sum --check --strict SHA256SUMS`. An instance sets `coreImages.registry: ghcr.io/entercloud-cz` and pins
`coreVersion` to the release's tag.
