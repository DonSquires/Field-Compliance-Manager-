import React, { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, Mail, Shield } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './LoginPage.css';

type EntryMode = 'sign_in' | 'request_reset' | 'reset_sent' | 'update_password';

const LoginPage: React.FC = () => {
  const { signInWithPassword, requestPasswordReset, updatePassword, recoveryMode, error: authError } = useAuth();
  const [mode, setMode] = useState<EntryMode>(recoveryMode ? 'update_password' : 'sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (recoveryMode) setMode('update_password');
  }, [recoveryMode]);

  const changeMode = (nextMode: EntryMode) => {
    setMode(nextMode);
    setLocalError(null);
    setPassword('');
    setConfirmPassword('');
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setLocalError(null);
    try {
      if (mode === 'request_reset') {
        const result = await requestPasswordReset(email.trim());
        if (result.error) setLocalError(result.error);
        else setMode('reset_sent');
        return;
      }

      if (mode === 'update_password') {
        if (password !== confirmPassword) {
          setLocalError('Passwords do not match.');
          return;
        }
        const result = await updatePassword(password);
        if (result.error) setLocalError(result.error);
        return;
      }

      const result = await signInWithPassword(email.trim(), password);
      if (result.error) setLocalError(result.error);
    } finally {
      setSubmitting(false);
    }
  };

  const isResetRequest = mode === 'request_reset' || mode === 'reset_sent';
  const title = mode === 'update_password' ? 'Set a new password' : isResetRequest ? 'Reset your password' : 'Sign in';
  const subtitle = mode === 'update_password'
    ? 'Choose a new password for your account.'
    : isResetRequest
      ? 'We will send a secure recovery link to your email.'
      : 'Use your authorised Field Compliance Manager account.';

  return (
    <main className="login-page">
      <div className="login-atmosphere" aria-hidden="true" />
      <section className="login-shell" aria-labelledby="login-title">
        <header className="login-brand">
          <span><Shield size={22} strokeWidth={1.8} aria-hidden="true" /></span>
          <div><strong>Field Compliance Manager</strong><small>Secure operations access</small></div>
        </header>

        <div className="login-rule" />

        <div className="login-heading">
          <span className="login-kicker">Authorised access</span>
          <h1 id="login-title">{title}</h1>
          <p>{subtitle}</p>
        </div>

        {mode === 'reset_sent' ? (
          <div className="login-confirmation" role="status">
            <span><CheckCircle2 size={23} aria-hidden="true" /></span>
            <strong>Check your email</strong>
            <p>If an account exists for <b>{email}</b>, a recovery link has been sent.</p>
            <button type="button" onClick={() => changeMode('sign_in')}><ArrowLeft size={16} aria-hidden="true" /> Return to sign in</button>
          </div>
        ) : (
          <form className="login-form" onSubmit={handleSubmit}>
            {(localError || authError) && <div className="login-error" role="alert">{localError || authError}</div>}

            {mode !== 'update_password' && (
              <label className="login-field">
                <span>Email address</span>
                <div><Mail size={17} aria-hidden="true" /><input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@organisation.nz" /></div>
              </label>
            )}

            {mode !== 'request_reset' && (
              <label className="login-field">
                <span>{mode === 'update_password' ? 'New password' : 'Password'}</span>
                <div>
                  {mode === 'update_password' ? <KeyRound size={17} aria-hidden="true" /> : <LockKeyhole size={17} aria-hidden="true" />}
                  <input type={showPassword ? 'text' : 'password'} required autoComplete={mode === 'update_password' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} />
                  <button type="button" className="login-visibility" onClick={() => setShowPassword((visible) => !visible)} title={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}<span className="sr-only">{showPassword ? 'Hide password' : 'Show password'}</span></button>
                </div>
              </label>
            )}

            {mode === 'update_password' && (
              <label className="login-field">
                <span>Confirm new password</span>
                <div><KeyRound size={17} aria-hidden="true" /><input type={showPassword ? 'text' : 'password'} required autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></div>
              </label>
            )}

            {mode === 'sign_in' && <button type="button" className="login-text-action" onClick={() => changeMode('request_reset')}>Forgot password?</button>}

            <button type="submit" className="login-submit" disabled={submitting}>
              {submitting && <LoaderCircle size={18} className="is-spinning" aria-hidden="true" />}
              {submitting ? 'Please wait' : mode === 'request_reset' ? 'Send recovery link' : mode === 'update_password' ? 'Update password' : 'Sign in'}
            </button>

            {mode === 'request_reset' && <button type="button" className="login-back" onClick={() => changeMode('sign_in')}><ArrowLeft size={16} aria-hidden="true" /> Back to sign in</button>}
          </form>
        )}

        <footer className="login-footer"><LockKeyhole size={13} aria-hidden="true" /> Access is restricted to invited users.</footer>
      </section>
    </main>
  );
};

export default LoginPage;