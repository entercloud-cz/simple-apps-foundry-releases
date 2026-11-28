# infra/modules: reusable Bicep modules

Modules are never deployed on their own. The templates in [../platform/](../platform/), [../app/](../app/) and
[../entra/](../entra/) use them, each module for one concern. What each one does is in the
[module map](../README.md#module-map).

- **`naming/naming.bicep`** is the only source of resource names (ADR-0020). Its TypeScript ports in the portal and
  the CLI are tested against `infra/tests/naming-vectors.json`. Changing it: the `naming-change` skill.
- **`types.bicep`** holds the shared types (mirroring `config/schema/instance.schema.json`), built-in role GUIDs
  and the reserved env var names.
- **Imports are selective** (`import { x as nameX }`), never `import *`. ARM allows 64 functions per template, and
  an unused import changes a template's hash (AGENTS.md hard rule 6; `check-infra.py` enforces it).
- **No defaults for environment-specific parameters**, so a missing value fails loudly.
- **The data modules** (`data/`) take `publicNetworkAccess` explicitly, next to their private endpoint (ADR-0060).

Read [lessons-from-v1](../../docs/architecture/lessons-from-v1.md) before touching `network/`, `registry/`,
`keyvault/` or `privateendpoint/`. Verify with `python3 infra/tests/check-infra.py`.
