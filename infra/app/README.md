# infra/app: one app's resources

Templates deployed per app and environment, by the provisioning pipeline (ADR-0032) or, for `release.bicep` only,
also by the app's delivery pipeline (ADR-0029). The [module map](../README.md#module-map) says what each one
creates.

- **Provisioning units** (ADR-0048): `landing-zone.bicep` (`lz`), `release.bicep` (`release`), `frontdoor.bicep`
  (`frontdoor`) and `portal-vault-endpoint.bicep` (`pep`). `units.json` holds each unit's fingerprint and the
  version since which it is current. After a unit's template, `.bicepparam` or revision changed, run
  `python3 infra/tests/check-infra.py --update-units`.
- **Upgrade notes** (ADR-0049): `upgrades.yaml` has a note for each unit that changed in a version (level, restart,
  EN and CS text). `platform upgrades check` checks it in core CI.
- **`provisioning/`** holds provisioning's `.bicepparam` files, which read the JSON of
  `platform provisioning inputs`. **`delivery/`** holds the delivery pipeline's only `release.bicepparam` and
  `names.bicep`.
- **One app never affects another** (AGENTS.md hard rule 10, ADR-0052): shared resources only as `existing`,
  plus allow-listed children named for the app. `check-infra.py` enforces it.
- **The env vars injected into the app container are a contract** (hard rule 9). Change them only together with
  `config/schema/app-manifest.schema.json`, `templates/` and
  [data-services.md](../../docs/architecture/data-services.md).

Changing a unit: the `provisioning-change` skill. Releases stamp `units.json` and `upgrades.yaml`:
[release-core](../../docs/runbooks/release-core.md).
