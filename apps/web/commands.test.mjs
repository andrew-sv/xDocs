/** Command filtering and the document HTML assembly that feeds the PDF. */
import { check } from '@xdocs/test-support/harness';
import { filterCommands } from './src/lib/commands.ts';
import { buildDocumentHtml, pdfFilename } from './src/lib/exportPdf.ts';

// --- filtering ---------------------------------------------------------------
check('empty query lists every command', filterCommands('').length >= 1);
check(
  'matches on id',
  filterCommands('exportToPdf').some((c) => c.id === 'exportToPdf'),
);
check(
  'matches case-insensitively',
  filterCommands('EXPORTTOPDF').some((c) => c.id === 'exportToPdf'),
);
check(
  'matches on a partial',
  filterCommands('exp').some((c) => c.id === 'exportToPdf'),
);
check(
  'matches on a keyword',
  filterCommands('download').some((c) => c.id === 'exportToPdf'),
);
check('no match returns empty', filterCommands('zzzznope').length === 0);
check(
  'whitespace is ignored',
  filterCommands('  pdf  ').some((c) => c.id === 'exportToPdf'),
);

// --- filenames ---------------------------------------------------------------
check('slugifies the title', pdfFilename('Quarterly Notes') === 'quarterly-notes.pdf');
check('strips punctuation', pdfFilename('Hello, World! (v2)') === 'hello-world-v2.pdf');
check('falls back when empty', pdfFilename('   ') === 'document.pdf');
check('falls back when unsluggable', pdfFilename('!!!') === 'document.pdf');
check('caps very long titles', pdfFilename('a'.repeat(200)).length <= 64);

// --- document assembly -------------------------------------------------------
const html = buildDocumentHtml('My Doc', ['<p>one</p>', '<h2>two</h2>', '<ul><li>three</li></ul>']);
check('title becomes the leading heading', html.startsWith('<h1>My Doc</h1>'));
check(
  'blocks keep their order',
  html.indexOf('one') < html.indexOf('two') && html.indexOf('two') < html.indexOf('three'),
);
check('formatting markup survives', html.includes('<h2>') && html.includes('<ul>'));
check(
  'an untitled document omits the heading',
  !buildDocumentHtml('  ', ['<p>x</p>']).includes('<h1>'),
);
// A title is plain text, so it must not be able to inject markup into the PDF.
check('title is escaped', buildDocumentHtml('<script>x</script>', []).includes('&lt;script&gt;'));
check(
  'escaping does not touch block HTML',
  buildDocumentHtml('t', ['<p><strong>b</strong></p>']).includes('<strong>'),
);
