import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const loginSource = readFileSync(resolve(process.cwd(), 'src/pages/LoginPage.tsx'), 'utf8');
const authSource = readFileSync(resolve(process.cwd(), 'src/context/AuthContext.tsx'), 'utf8');
const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const supabaseConfig = readFileSync(resolve(process.cwd(), '../../supabase/config.toml'), 'utf8');
const inviteSource = readFileSync(resolve(process.cwd(), '../../supabase/functions/invite-org/index.ts'), 'utf8');
const authSection = supabaseConfig.match(/^\[auth\]\r?\n([\s\S]*?)(?=^\[)/m)?.[1] ?? '';
const emailAuthSection = supabaseConfig.match(/^\[auth\.email\]\r?\n([\s\S]*?)(?=^\[)/m)?.[1] ?? '';

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

  it('disables public signup while retaining the server-side invitation flow', () => {
    expect(authSection).toMatch(/^\s*enable_signup\s*=\s*false\s*$/m);
    expect(emailAuthSection).toMatch(/^\s*enable_signup\s*=\s*false\s*$/m);
    expect(inviteSource).toContain('admin.inviteUserByEmail');
  });

  it('blocks deactivated profiles from the app and closes their global auth session', () => {
    expect(authSource).toContain('deactivated_at');
    expect(authSource).toContain("signOut({ scope: 'global' })");
    expect(authSource).toContain('This account has been deactivated.');
    expect(appSource).toContain('return <RoleRouter />;');
    expect(appSource).not.toContain('if (!profile)');
  });

  it('identifies Iron Eagle as the builder and excludes the retired attribution', () => {
    expect(loginSource).toContain('Built and designed by Iron Eagle Security');
    expect(loginSource).not.toMatch(/Trusted by Iron Eagle Security and OnSpace AI/i);
    expect(loginSource).not.toMatch(/OnSpace AI/i);
  });
});