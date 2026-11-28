import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requiredAccess } from '../src/server/auth/access.js';
import { DEFAULT_ROLES, levelAllows, levelOf, loadRoles, parseRoles, RolesFileError } from '../src/server/auth/roles.js';
import { TEST_ROLES } from './helpers.js';

const user = (...roles: string[]) => ({ id: 'u', name: 'u', roles });

describe('roles file', () => {
  it('reads roles and their levels; a missing or unknown level gives no access', () => {
    const roles = parseRoles(
      JSON.stringify({
        signIn: true,
        roles: [
          { value: 'Viewer', displayName: 'Viewer', description: 'Sees reports.', level: 'read' },
          { value: 'Approver', level: 'owner' },
          { value: 'Clerk' },
        ],
      }),
    );
    expect(roles.roles).toEqual([
      { value: 'Viewer', displayName: 'Viewer', description: 'Sees reports.', level: 'read' },
      { value: 'Approver', displayName: 'Approver', description: '', level: null },
      { value: 'Clerk', displayName: 'Clerk', description: '', level: null },
    ]);
  });

  it('refuses a file that is not a roles file', () => {
    expect(() => parseRoles('not json')).toThrow(RolesFileError);
    expect(() => parseRoles('{"roles": [{"level": "read"}]}')).toThrow(RolesFileError);
  });

  it('uses the core default roles without a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roles-'));
    expect(loadRoles(join(dir, 'roles.json'))).toBe(DEFAULT_ROLES);
    writeFileSync(join(dir, 'roles.json'), JSON.stringify({ signIn: false, roles: [] }));
    expect(loadRoles(join(dir, 'roles.json'))).toEqual({ signIn: false, roles: [] });
  });
});

describe('levels', () => {
  it('takes the highest level of the roles the file names', () => {
    expect(levelOf(user('Reader', 'Editor'), TEST_ROLES)).toBe('write');
    expect(levelOf(user('Guest', 'Stranger'), TEST_ROLES)).toBeNull();
    expect(levelOf(null, TEST_ROLES)).toBeNull();
  });

  it('nests: admin includes write, write includes read', () => {
    expect(levelAllows('admin', 'read')).toBe(true);
    expect(levelAllows('write', 'read')).toBe(true);
    expect(levelAllows('read', 'write')).toBe(false);
    expect(levelAllows('write', 'admin')).toBe(false);
    expect(levelAllows(null, 'read')).toBe(false);
  });

  it('needs a level by method and path unless the route declares one', () => {
    expect(requiredAccess('GET', ['/api/items'], undefined)).toBe('read');
    expect(requiredAccess('HEAD', ['/api/items'], undefined)).toBe('read');
    expect(requiredAccess('DELETE', ['/api/items/1'], undefined)).toBe('write');
    expect(requiredAccess('OPTIONS', ['/api/items'], undefined)).toBe('write');
    expect(requiredAccess('GET', ['/api/settings'], undefined)).toBe('admin');
    expect(requiredAccess('GET', ['/api/items', '/api//Admin/x'], undefined)).toBe('admin');
    expect(requiredAccess('GET', ['/api/%61dmin/x'], undefined)).toBe('admin');
    expect(requiredAccess('POST', ['/api/search'], 'read')).toBe('read');
  });
});
