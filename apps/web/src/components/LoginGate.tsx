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
          initialize: (config: {
            client_id: string;
            callback: (r: { credential: string }) => void;
          }) => void;
          renderButton: (el: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

/*
 * One shared load promise for the whole module.
 *
 * Keying off "is the <script> tag present?" is wrong: under StrictMode the
 * second effect run finds the tag already appended while the script is still
 * executing, resolves immediately, sees no window.google and bails — so the
 * button silently never renders. Every caller must await the same real load.
 */
let gisLoad: Promise<void> | null = null;

function loadGoogleScript(): Promise<void> {
  gisLoad ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing && window.google?.accounts?.id) {
      resolve();
      return;
    }
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Could not load Google sign-in')), {
      once: true,
    });
    if (!existing) {
      script.src = GSI_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  });
  return gisLoad;
}

type LoginGateProps = {
  onSignedIn: () => void;
  /** Set when a real sign-in succeeded but the account is not allowed. */
  deniedReason?: string | null;
};

export function LoginGate({ onSignedIn, deniedReason = null }: LoginGateProps) {
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
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
          callback: ({ credential }) => {
            void signInWithGoogleIdToken(credential)
              .then(() => onSignedInRef.current())
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
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
    // Deliberately runs once: the handler is read through a ref so a new
    // callback identity does not tear down and re-render Google's button.
  }, []);

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
    <div className="login" data-testid="login-gate">
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

      {(error || deniedReason) && (
        <p className="login-error" data-testid="login-error">
          {error ?? deniedReason}
        </p>
      )}
    </div>
  );
}
