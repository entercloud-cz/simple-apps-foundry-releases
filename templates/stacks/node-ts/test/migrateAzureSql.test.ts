import { describe, expect, it } from 'vitest';
import { splitBatches } from '../src/server/db/migrateAzureSql.js';

describe('Azure SQL migrations', () => {
  it('split a file into batches on lines that hold only GO', () => {
    const file = [
      'CREATE TABLE dbo.items (id int NOT NULL PRIMARY KEY, name nvarchar(200) NOT NULL);',
      'GO',
      '  go  ',
      'CREATE VIEW dbo.item_names AS SELECT name FROM dbo.items;\r',
      'GO\r',
      "INSERT INTO dbo.items (id, name) VALUES (1, N'GOLD');",
      '',
    ].join('\n');
    expect(splitBatches(file)).toEqual([
      'CREATE TABLE dbo.items (id int NOT NULL PRIMARY KEY, name nvarchar(200) NOT NULL);',
      'CREATE VIEW dbo.item_names AS SELECT name FROM dbo.items;',
      "INSERT INTO dbo.items (id, name) VALUES (1, N'GOLD');",
    ]);
  });

  it('a file without GO is one batch; an empty file none', () => {
    expect(splitBatches('ALTER TABLE dbo.items ADD status nvarchar(20) NULL;\n')).toEqual(['ALTER TABLE dbo.items ADD status nvarchar(20) NULL;']);
    expect(splitBatches('\n  \n')).toEqual([]);
  });
});
