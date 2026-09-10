import { useEffect, useRef, useState } from 'react';
import { signInWithGoogleIdToken, signInWithPassword } from '../lib/auth';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
// Password login exists for automated tests; Google is the only path in staging.
const PASSWORD_LOGIN = import.meta.env.VITE_ALLOW_PASSWORD_LOGIN === 'true';
const GSI_SRC = 'https://accounts.google.com/gsi/client';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (r: { credential: string }) => void }) => void;
          renderButton: (el: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

function loadGoogleScript(): Promise<void> {
  if (document.querySelector(`script[src="${GSI_SRC}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load Google sign-in'));
    document.head.appendChild(script);
  });
}

export function LoginGate({ onSignedIn }: { onSignedIn: () => void }) {
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;

    void loadGoogleScript()
      .then(() => {
        if (cancelled || !window.google || !googleButtonRef.current) return;
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          // Google hands back an ID token; Better Auth exchanges it for a
          // session without any redirect, so no cross-site cookie is involved.
          callback: async ({ credential }) => {
            try {
              await signInWithGoogleIdToken(credential);
              onSignedIn();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          },
        });
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
        });
      })
      .catch((e: Error) => setError(e.message));

    return () => {
      cancelled = true;
    };
  }, [onSignedIn]);

  async function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await signInWithPassword(email.trim(), password);
      onSignedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="login">
      <h1 className="login-brand">xDocs</h1>
      <p className="login-hint">Sign in to open your documents.</p>

      {GOOGLE_CLIENT_ID ? (
        <div ref={googleButtonRef} data-testid="google-signin" />
      ) : (
        <p className="login-hint">Google sign-in is not configured.</p>
      )}

      {PASSWORD_LOGIN && (
        <form className="login-password" onSubmit={submitPassword}>
          <input
            className="login-input"
            type="email"
            value={email}
            placeholder="Email"
            aria-label="Email"
            data-testid="login-email"
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="login-input"
            type="password"
            value={password}
            placeholder="Password"
            aria-label="Password"
            data-testid="login-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" className="login-submit" data-testid="login-submit">
            Sign in
          </button>
        </form>
      )}

      {error && <p className="login-error" data-testid="login-error">{error}</p>}
    </div>
  );
}
