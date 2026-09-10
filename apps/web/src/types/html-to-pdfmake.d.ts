/**
 * html-to-pdfmake ships no types. Only the call shape we use is declared —
 * a full definition would be speculative and go stale.
 */
declare module 'html-to-pdfmake' {
  const htmlToPdfmake: (html: string, options?: { window?: Window }) => unknown;
  export default htmlToPdfmake;
}

declare module 'pdfmake/build/pdfmake' {
  const pdfMake: unknown;
  export default pdfMake;
}

declare module 'pdfmake/build/vfs_fonts' {
  const vfs: unknown;
  export default vfs;
}
