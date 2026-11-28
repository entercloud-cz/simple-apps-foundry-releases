---
name: docs-keeping
description: Use after every change that users, owners or future developers would notice, and whenever editing README.md, CHANGELOG.md, docs/architecture.md or docs/decisions/. Also use when the user asks to document the app, explain how it works, write release notes, record a decision, or when platform check warns that docs are stale.
---

# Keeping the docs current

The docs are part of the change, in the same commit. Owners read `README.md` and `CHANGELOG.md`
in the portal; approvers read the CHANGELOG before approving a production release; the next
agent (or person) reads `docs/architecture.md` before changing anything. `platform check` warns
when code changed and the docs didn't.

## What to update

| Change | File | What to write |
|---|---|---|
| Feature, fix, UI or behaviour change users notice | `CHANGELOG.md` | One line under `## [Unreleased]` → `Added` / `Changed` / `Fixed` / `Removed` / `Security` |
| How to run, use or configure the app; who it's for | `README.md` | Update the relevant section |
| New/changed component, table, integration, env var, secret, role, scheduled work | `docs/architecture.md` | Update the section and tables |
| A decision with alternatives (library, data model, auth exception, UI language, trade-off) | `docs/decisions/NNNN-title.md` | New record from [reference/decision-template.md](reference/decision-template.md) |

Purely internal refactoring with no visible effect: no CHANGELOG entry; update
`docs/architecture.md` only if structure changed.

## CHANGELOG.md

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format, newest first. Write for the
owner, not for developers: what changed for users, in plain language.

```markdown
## [Unreleased]

### Added
- Export the order list as a CSV file (Orders page → Export).

### Fixed
- VAT is now rounded per line, so totals match the invoice.
```

Good: "Managers can approve several requests at once." Bad: "Refactor ApprovalService, add batch
endpoint." Never mention secrets, internal hostnames or personal data.

When merging to the default branch (= a production release request), move the `[Unreleased]`
entries under a new heading `## [YYYY-MM-DD]` (today's date, in UTC) and leave an empty
`## [Unreleased]` on top. Several releases on one day share the heading.

## README.md

Plain language, short. Sections: what the app does, who uses it (roles), how to use the main
features, how to run it locally, configuration (link to `docs/architecture.md`), where to get help.
No secrets, no internal URLs other than the portal link, no long technical detail (that goes to
`docs/architecture.md`).

## docs/architecture.md

The map of the app for developers and agents. Keep these sections accurate:

- **Overview**: one paragraph and a small Mermaid diagram (user → app → database/storage/external).
- **Components**: folders/modules and what each does.
- **Roles and permissions**: table role → allowed actions.
- **Data**: tables/containers with purpose and key columns; who owns each record.
- **Configuration**: table of env vars and secrets (name, purpose, secret yes/no, default).
- **Integrations**: external services, what is sent, how it authenticates.
- **Operations**: background or scheduled work, migrations, known limits.

## Decision records (docs/decisions/)

One file per decision: `NNNN-short-title.md`, numbered in order, never renumbered. Short:
context, decision, consequences, alternatives. Superseded decisions get `Status: Superseded by
NNNN` and stay in place. Record at least: UI language(s), choice of ORM/major library, any
public (anonymous) page, any exception to these instructions, unresolved scan findings.

## Checklist (every commit)

- [ ] CHANGELOG entry for anything a user notices.
- [ ] README still true (commands, features, roles).
- [ ] `docs/architecture.md` matches the code (env vars, tables, roles, integrations).
- [ ] Decision record for any non-obvious choice.
- [ ] No secrets, tokens, personal data or internal hostnames in docs.

## Common mistakes

- Writing CHANGELOG entries from the commit log ("fix lint", "wip") instead of user impact.
- Documenting env vars in README and architecture.md differently → keep one table (architecture.md).
- Letting `docs/architecture.md` describe a planned design that the code doesn't implement.
- Creating extra docs files for every task (`NOTES.md`, `SUMMARY.md`) → update the existing docs.
