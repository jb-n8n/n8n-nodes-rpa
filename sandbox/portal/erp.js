// The ERP data and helpers shared by the SAP look-alikes (classic web GUI, Fiori). No dependencies.
import { randomBytes } from 'node:crypto';

export const ERP_VARIANTS = ['baseline', 'renamed', 'menu', 'dialog'];

const row = (document, postingDate, company, amount) => ({ document, postingDate, company, amount, currency: 'USD' });

// Posting dates are ISO yyyy-mm-dd. Company 1000 has eight rows in September 2026; nothing is posted in December.
export const LEDGER = [
  row('1900000101', '2026-08-12', '1000', '845.10'),
  row('1900000102', '2026-08-27', '1000', '120.00'),
  row('1900000201', '2026-09-01', '1000', '1234.56'),
  row('1900000202', '2026-09-04', '1000', '79.99'),
  row('1900000203', '2026-09-09', '1000', '15000.00'),
  row('1900000204', '2026-09-15', '1000', '312.40'),
  row('1900000205', '2026-09-18', '1000', '58.25'),
  row('1900000206', '2026-09-22', '1000', '4410.00'),
  row('1900000207', '2026-09-26', '1000', '960.75'),
  row('1900000208', '2026-09-30', '1000', '2250.30'),
  row('1900000301', '2026-10-05', '1000', '77.77'),
  row('1900000302', '2026-10-14', '1000', '3100.00'),
  row('1900000501', '2026-08-20', '2000', '510.00'),
  row('1900000401', '2026-09-03', '2000', '9876.54'),
  row('1900000402', '2026-09-17', '2000', '640.20'),
  row('1900000403', '2026-10-02', '2000', '88.00'),
];

export function lineItems(company, from, to) {
  return LEDGER
    .filter((r) => r.company === company && r.postingDate >= from && r.postingDate <= to)
    .sort((a, b) => (a.postingDate < b.postingDate ? -1 : a.postingDate > b.postingDate ? 1 : 0));
}

function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// A random report-screen release: never the baseline, so it always breaks the recorded script.
export function shuffledErp(seed) {
  const rnd = mulberry32(seed);
  const variants = ERP_VARIANTS.filter((v) => v !== 'baseline');
  const erp = variants[Math.floor(rnd() * variants.length)];
  return { erp, erpDecoy: rnd() < 0.5, seed };
}

export const newSalt = () => randomBytes(4).toString('hex');
export const elementId = (n, salt) => `M0:${salt}::${n}`;

export const LINE_ITEM_HEADER = 'Document,Posting Date,Company Code,Amount,Currency';
export const lineItemsCsv = (rows) =>
  [LINE_ITEM_HEADER, ...rows.map((r) => [r.document, r.postingDate, r.company, r.amount, r.currency].join(','))].join('\n');
export const layoutCsv = () => ['Column,Width,Visible', 'Document,12,Yes', 'Posting Date,12,Yes', 'Company Code,8,Yes', 'Amount,14,Yes', 'Currency,8,No'].join('\n');
export const exportFileName = (company, from, to) => `LINEITEMS_${company}_${from}_${to}.csv`;
