# Database migrations

Used only when the app has a database (`DATABASE_HOST` is set). At startup the app applies every
`NNNN_short_description.sql` file in this folder that has not run yet, in name order, and records
it in the `schema_migrations` table. Write the files in the database's own SQL:

- **PostgreSQL** (`DATABASE_USER` is set): each file runs in its own transaction. See the
  `database-postgres` skill.
- **Azure SQL** (`DATABASE_HOST` ends in `.database.windows.net`): T-SQL. All pending files run in
  one transaction, so a failed file leaves the database as it was. A line with only `GO` splits a
  file into batches, for statements that must start one (`CREATE VIEW`, `CREATE PROCEDURE`). See
  the `database-sql` skill.

Rules for both:

- Name files `0001_create_items.sql`, `0002_add_items_status.sql`, … (4 digits, lowercase, `_`).
- Never edit, rename or delete a migration after it was pushed. Add a new one instead.
- Every migration must be backward compatible (expand/contract), because a rollback runs the
  previous release against the new schema.
