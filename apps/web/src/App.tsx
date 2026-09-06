import type { DocumentDTO } from '@xdocs/shared';
import { useCallback, useEffect, useState } from 'react';
import { DocumentEditor } from './components/DocumentEditor';
import { DocumentList } from './components/DocumentList';
import { api } from './lib/api';

export function App() {
  const [documents, setDocuments] = useState<DocumentDTO[]>([]);
  const [selected, setSelected] = useState<DocumentDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDocuments(await api.listDocuments());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createDocument() {
    const doc = await api.createDocument();
    setDocuments((prev) => [doc, ...prev]);
    setSelected(doc);
  }

  async function deleteDocument(doc: DocumentDTO) {
    await api.deleteDocument(doc.id);
    setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
    setSelected((prev) => (prev?.id === doc.id ? null : prev));
  }

  return (
    <div className="app">
      <DocumentList
        documents={documents}
        selectedId={selected?.id ?? null}
        onSelect={setSelected}
        onCreate={() => void createDocument()}
        onDelete={(doc) => void deleteDocument(doc)}
      />
      {error && <main className="editor"><p className="error">{error}</p></main>}
      {!error && selected && <DocumentEditor key={selected.id} document={selected} />}
      {!error && !selected && (
        <main className="editor empty-state">
          <p>Select a document, or create one to start writing.</p>
        </main>
      )}
    </div>
  );
}
