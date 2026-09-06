import { HocuspocusProvider } from '@hocuspocus/provider';
import { BLOCKS_KEY, collabDocName, type BlockMeta, type DocumentDTO } from '@xdocs/shared';
import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { useYArray } from '../hooks/useYArray';
import { BlockEditor } from './BlockEditor';

const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:1234';

type Status = 'connecting' | 'connected' | 'disconnected';

export function DocumentEditor({ document: doc }: { document: DocumentDTO }) {
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    // One Y.Doc + one socket per open document. Every block is a fragment on
    // this same doc, so opening a 40-block document is still one connection.
    const ydoc = new Y.Doc();
    const next = new HocuspocusProvider({
      url: COLLAB_URL,
      name: collabDocName(doc.id),
      document: ydoc,
      onStatus: ({ status }) => setStatus(status as Status),
      onSynced: () => setSynced(true),
    });

    setProvider(next);
    setStatus('connecting');
    setSynced(false);

    return () => {
      next.destroy();
      ydoc.destroy();
      setProvider(null);
    };
  }, [doc.id]);

  const ydoc = provider?.document ?? null;
  const blocksArray = useMemo(() => ydoc?.getArray<BlockMeta>(BLOCKS_KEY) ?? null, [ydoc]);
  const blocks = useYArray(blocksArray);

  function addBlock(afterIndex?: number) {
    if (!blocksArray) return;
    const block: BlockMeta = { id: crypto.randomUUID(), type: 'paragraph' };
    blocksArray.insert(afterIndex === undefined ? blocksArray.length : afterIndex + 1, [block]);
  }

  function removeBlock(id: string) {
    if (!blocksArray) return;
    const index = blocksArray.toArray().findIndex((b) => b.id === id);
    if (index === -1) return;
    blocksArray.delete(index, 1);
    // The block's Y.XmlFragment is intentionally left behind: Yjs has no API to
    // drop a root type, and an empty fragment costs a few bytes.
  }

  return (
    <main className="editor">
      <header className="editor-header">
        <h1>{doc.title}</h1>
        <span className={`status status-${status}`}>
          {status === 'connected' && synced ? 'Live' : status === 'connected' ? 'Syncing…' : status}
        </span>
      </header>

      {!synced && <p className="hint">Loading document…</p>}

      {synced && provider && ydoc && (
        <>
          <div className="blocks">
            {blocks.map((block) => (
              <BlockEditor
                key={block.id}
                block={block}
                ydoc={ydoc}
                provider={provider}
                canRemove={blocks.length > 1}
                onRemove={() => removeBlock(block.id)}
              />
            ))}
          </div>
          <button type="button" className="add-block" onClick={() => addBlock()}>
            + Add paragraph
          </button>
        </>
      )}
    </main>
  );
}
