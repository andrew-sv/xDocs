/** Command filtering and the document HTML assembly that feeds the PDF. */
import { filterCommands } from './src/lib/commands.ts';
import { buildDocumentHtml, pdfFilename } from './src/lib/exportPdf.ts';

let fail = 0;
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

// --- filtering ---------------------------------------------------------------
ck('empty query lists every command', filterCommands('').length >= 1);
ck(
  'matches on id',
  filterCommands('exportToPdf').some((c) => c.id === 'exportToPdf'),
);
ck(
  'matches case-insensitively',
  filterCommands('EXPORTTOPDF').some((c) => c.id === 'exportToPdf'),
);
ck(
  'matches on a partial',
  filterCommands('exp').some((c) => c.id === 'exportToPdf'),
);
ck(
  'matches on a keyword',
  filterCommands('download').some((c) => c.id === 'exportToPdf'),
);
ck('no match returns empty', filterCommands('zzzznope').length === 0);
ck(
  'whitespace is ignored',
  filterCommands('  pdf  ').some((c) => c.id === 'exportToPdf'),
);

// --- filenames ---------------------------------------------------------------
ck('slugifies the title', pdfFilename('Quarterly Notes') === 'quarterly-notes.pdf');
ck('strips punctuation', pdfFilename('Hello, World! (v2)') === 'hello-world-v2.pdf');
ck('falls back when empty', pdfFilename('   ') === 'document.pdf');
ck('falls back when unsluggable', pdfFilename('!!!') === 'document.pdf');
ck('caps very long titles', pdfFilename('a'.repeat(200)).length <= 64);

// --- document assembly -------------------------------------------------------
const html = buildDocumentHtml('My Doc', ['<p>one</p>', '<h2>two</h2>', '<ul><li>three</li></ul>']);
ck('title becomes the leading heading', html.startsWith('<h1>My Doc</h1>'));
ck(
  'blocks keep their order',
  html.indexOf('one') < html.indexOf('two') && html.indexOf('two') < html.indexOf('three'),
);
ck('formatting markup survives', html.includes('<h2>') && html.includes('<ul>'));
ck(
  'an untitled document omits the heading',
  !buildDocumentHtml('  ', ['<p>x</p>']).includes('<h1>'),
);
// A title is plain text, so it must not be able to inject markup into the PDF.
ck('title is escaped', buildDocumentHtml('<script>x</script>', []).includes('&lt;script&gt;'));
ck(
  'escaping does not touch block HTML',
  buildDocumentHtml('t', ['<p><strong>b</strong></p>']).includes('<strong>'),
);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
