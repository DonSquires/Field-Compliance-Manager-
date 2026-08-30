import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const loginSource = readFileSync(resolve(process.cwd(), 'src/pages/LoginPage.tsx'), 'utf8');
const authSource = readFileSync(resolve(process.cwd(), 'src/context/AuthContext.tsx'), 'utf8');
const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

describe('authentication entry flow', () => {
  it('supports sign-in and standard Supabase password recovery', () => {
    expect(authSource).toContain('signInWithPassword');
    expect(authSource).toContain('resetPasswordForEmail');
    expect(authSource).toContain("event === 'PASSWORD_RECOVERY'");
    expect(authSource).toContain('updateUser({ password })');
  });

  it('keeps recovery sessions in the entry surface until password update', () => {
    expect(appSource).toContain('!hasSession || recoveryMode');
    expect(loginSource).toContain("mode === 'update_password'");
  });

  it('does not offer unsupported self-registration', () => {
    expect(loginSource).not.toContain('signUp');
    expect(loginSource).toContain('Access is restricted to invited users.');
  });
});