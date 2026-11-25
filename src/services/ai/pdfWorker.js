'use strict';

/** Worker thread: extracts text from a PDF with pdf.js, off the main event loop. */
const { parentPort, workerData } = require('worker_threads');

(async () => {
  const { buffer, maxPages, maxChars } = workerData;
  try {
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    let doc;
    try {
      doc = await lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
    } catch (err) {
      parentPort.postMessage({ error: /password/i.test(err.message) ? 'password' : 'invalid' });
      return;
    }
    const pages = Math.min(doc.numPages, maxPages);
    const parts = [];
    let total = 0;
    for (let i = 1; i <= pages && total < maxChars; i += 1) {
      const content = await (await doc.getPage(i)).getTextContent();
      const text = content.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('');
      parts.push(text);
      total += text.length;
    }
    const numPages = doc.numPages;
    await doc.destroy();
    parentPort.postMessage({ text: parts.join('\n\n'), pages: numPages });
  } catch (err) {
    parentPort.postMessage({ error: 'invalid', detail: err.message });
  }
})();
