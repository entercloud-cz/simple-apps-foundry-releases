import { describe, expect, it } from 'vitest';
import { devUser, parseClientPrincipal } from '../src/server/auth/principal.js';
import { principalHeader } from './helpers.js';

describe('parseClientPrincipal', () => {
  it('reads id, name, email and roles', () => {
    const user = parseClientPrincipal(principalHeader({ name: 'Jana Nováková', roles: ['Reader', 'Admin', 'Reader'] }));
    expect(user).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Jana Nováková',
      email: 'jana@contoso.com',
      roles: ['Reader', 'Admin'],
    });
  });

  it('returns null for a missing, malformed or incomplete header', () => {
    expect(parseClientPrincipal(undefined)).toBeNull();
    expect(parseClientPrincipal('not base64 json')).toBeNull();
    const noObjectId = Buffer.from(JSON.stringify({ claims: [{ typ: 'name', val: 'x' }] })).toString('base64');
    expect(parseClientPrincipal(noObjectId)).toBeNull();
  });
});

describe('devUser', () => {
  it('builds a mock user from env values', () => {
    expect(devUser('dev@contoso.com', 'Admin, Reader')).toMatchObject({
      email: 'dev@contoso.com',
      roles: ['Admin', 'Reader'],
    });
    expect(devUser(undefined, 'Admin')).toBeNull();
  });
});
