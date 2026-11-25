'use strict';

const AdmZip = require('adm-zip');
const PDFDocument = require('pdfkit');
const docs = require('../../src/services/ai/documents');

const file = (buffer, originalname) => ({ buffer, originalname, size: buffer.length });

const pdf = (pages) =>
  new Promise((resolve) => {
    const d = new PDFDocument();
    const bufs = [];
    d.on('data', (b) => bufs.push(b));
    d.on('end', () => resolve(Buffer.concat(bufs)));
    pages.forEach((p, i) => {
      if (i) d.addPage();
      d.text(p);
    });
    d.end();
  });

function pptx(slides) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  slides.forEach((lines, i) => {
    const body = lines.map((l) => `<a:p><a:r><a:t>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</a:t></a:r></a:p>`).join('');
    zip.addFile(`ppt/slides/slide${i + 1}.xml`, Buffer.from(`<p:sld xmlns:a="a" xmlns:p="p"><p:cSld>${body}</p:cSld></p:sld>`));
  });
  return zip.toBuffer();
}

describe('reference document extraction', () => {
  test('PDF text, page count and whitespace clean-up', async () => {
    const out = await docs.extract(file(await pdf(['Chapter 1. The listener runs on port 1521 by default.', 'Chapter 2. RMAN   takes   backups of the database.']), 'guide.pdf'));
    expect(out).toMatchObject({ kind: 'PDF', pages: 2, name: 'guide.pdf' });
    expect(out.text).toContain('port 1521');
    expect(out.text).toContain('RMAN takes backups');
  });

  test('PowerPoint slides in order, with entities decoded', async () => {
    const out = await docs.extract(file(pptx([['Incident response', 'Contain & eradicate'], ['Lessons learned <review>', 'Update the runbook after every incident.']]), 'deck.pptx'));
    expect(out.kind).toBe('PowerPoint');
    expect(out.pages).toBe(2);
    expect(out.text.indexOf('Slide 1')).toBeLessThan(out.text.indexOf('Slide 2'));
    expect(out.text).toContain('Contain & eradicate');
    expect(out.text).toContain('Lessons learned <review>');
  });

  test('plain text and Markdown', async () => {
    const out = await docs.extract(file(Buffer.from('# Firewall policy\n\nAll inbound traffic is denied by default except ports 22 and 443.'), 'policy.md'));
    expect(out.kind).toBe('Text');
    expect(out.text).toContain('denied by default');
  });

  test('rejects images, unknown ZIPs, empty and scanned-looking files with a clear message', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4]);
    await expect(docs.extract(file(png, 'x.pdf'))).rejects.toThrow(/not a supported type/);
    const zip = new AdmZip();
    zip.addFile('hello.txt', Buffer.from('hi'));
    await expect(docs.extract(file(zip.toBuffer(), 'a.zip'))).rejects.toThrow(/not a Word/);
    await expect(docs.extract(file(Buffer.from('tiny'), 'a.txt'))).rejects.toThrow(/almost no text/);
    await expect(docs.extract(file(await pdf(['']), 'scan.pdf'))).rejects.toThrow(/no selectable text/);
  });

  test('combine keeps every source and stays within the limit', () => {
    const big = { name: 'big.pdf', text: 'x'.repeat(100000) };
    const small = { name: 'small.docx', text: 'Short but important.' };
    const { reference, truncated } = docs.combine([big, small], 'Pasted syllabus line.', 5000);
    expect(reference.length).toBeLessThanOrEqual(5000);
    expect(reference).toContain('### Source: Pasted notes');
    expect(reference).toContain('Short but important.');
    expect(reference).toContain('### Source: big.pdf');
    expect(truncated).toBe(true);
    expect(docs.combine([], '')).toEqual({ reference: '', truncated: false });
  });
});
