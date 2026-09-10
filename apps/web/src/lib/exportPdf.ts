/** A filename-safe version of the document title. */
export function pdfFilename(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'document'}.pdf`;
}

/**
 * Assemble the whole document as one HTML string.
 *
 * Block HTML comes from the live editors so ProseMirror's own serializer does
 * the work — a second path that re-derived HTML from Yjs could disagree with
 * what is actually on screen.
 */
export function buildDocumentHtml(title: string, blockHtml: string[]): string {
  const heading = title.trim() ? `<h1>${escapeHtml(title.trim())}</h1>` : '';
  return `${heading}${blockHtml.join('')}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the document to a PDF and download it.
 *
 * pdfmake and its embedded fonts are ~1MB, so both libraries are imported
 * dynamically — loading them eagerly would tax every page load for a feature
 * most sessions never use.
 */
export async function exportDocumentToPdf(title: string, blockHtml: string[]): Promise<void> {
  const [{ default: htmlToPdfmake }, pdfMakeModule, pdfFontsModule] = await Promise.all([
    import('html-to-pdfmake'),
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ]);

  const pdfMake = (pdfMakeModule as { default?: unknown }).default ?? pdfMakeModule;
  const fonts = (pdfFontsModule as { default?: unknown }).default ?? pdfFontsModule;

  /*
   * pdfmake 0.3 registers fonts through addVirtualFileSystem(); assigning
   * `pdfMake.vfs` (the 0.1/0.2 way) leaves it unable to find Roboto and it
   * throws "not found in virtual file system" only at download time. Fall back
   * to the old property so a version bump either way keeps working.
   */
  const maker = pdfMake as {
    vfs?: unknown;
    addVirtualFileSystem?: (vfs: unknown) => void;
    createPdf: (def: unknown) => { download: (name: string) => void };
  };
  if (typeof maker.addVirtualFileSystem === 'function') maker.addVirtualFileSystem(fonts);
  else maker.vfs = fonts;

  const content = htmlToPdfmake(buildDocumentHtml(title, blockHtml), { window });

  maker
    .createPdf({
      content,
      defaultStyle: { fontSize: 11, lineHeight: 1.35 },
      pageMargins: [48, 56, 48, 56],
    })
    .download(pdfFilename(title));
}
