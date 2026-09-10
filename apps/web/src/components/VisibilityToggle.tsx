import { useState } from 'react';
import type { Visibility } from '@xdocs/shared';

type Props = {
  visibility: Visibility;
  /** Rendered only for the owner; the API enforces this independently. */
  isOwner: boolean;
  onChange: (next: Visibility) => Promise<void>;
};

export function VisibilityToggle({ visibility, isOwner, onChange }: Props) {
  const [busy, setBusy] = useState(false);

  if (!isOwner) {
    return (
      <span className="visibility visibility-static" data-testid="visibility-static">
        {visibility === 'public' ? '🌐 Public' : '🔒 Private'}
      </span>
    );
  }

  const next: Visibility = visibility === 'public' ? 'private' : 'public';

  return (
    <button
      type="button"
      className={`visibility visibility-${visibility}`}
      data-testid="visibility-toggle"
      disabled={busy}
      title={
        visibility === 'public'
          ? 'Visible to everyone signed in — click to make it private'
          : 'Only you can see this — click to make it public'
      }
      onClick={async () => {
        setBusy(true);
        try {
          await onChange(next);
        } finally {
          setBusy(false);
        }
      }}
    >
      {visibility === 'public' ? '🌐 Public' : '🔒 Private'}
    </button>
  );
}
