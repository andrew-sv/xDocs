import { useState } from 'react';

export function LoginGate({ onSubmit }: { onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState('');

  return (
    <form
      className="login"
      onSubmit={(event) => {
        event.preventDefault();
        if (password.trim()) onSubmit(password.trim());
      }}
    >
      <h1 className="login-brand">xDocs</h1>
      <p className="login-hint">This environment is password protected.</p>
      <input
        className="login-input"
        type="password"
        autoFocus
        value={password}
        placeholder="Access password"
        aria-label="Access password"
        data-testid="login-password"
        onChange={(event) => setPassword(event.target.value)}
      />
      <button type="submit" className="login-submit" data-testid="login-submit">
        Continue
      </button>
    </form>
  );
}
