'use strict';

/** Writes a minimal, valid .docx from paragraphs (used for the Word import template and tests). */
const AdmZip = require('adm-zip');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildDocx(paragraphs) {
  const body = paragraphs
    .map((p) => {
      const text = typeof p === 'string' ? p : p.text;
      const bold = typeof p === 'object' && p.bold;
      return `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
    })
    .join('');
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
  );
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`));
  return zip.toBuffer();
}

module.exports = { buildDocx };
