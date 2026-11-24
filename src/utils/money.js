'use strict';

// All money is stored as integer minor units (kobo for NGN).
const CURRENCIES = {
  NGN: { symbol: '₦', name: 'Nigerian Naira', minor: 100 },
  GHS: { symbol: 'GH₵', name: 'Ghanaian Cedi', minor: 100 },
  ZAR: { symbol: 'R', name: 'South African Rand', minor: 100 },
  KES: { symbol: 'KSh', name: 'Kenyan Shilling', minor: 100 },
  USD: { symbol: '$', name: 'US Dollar', minor: 100 },
};

/** "5,000.50" | 5000.5 → 500050 (minor units). Throws on invalid input. */
function toMinor(major) {
  if (major === null || major === undefined || major === '') return 0;
  const cleaned = typeof major === 'string' ? major.replace(/[,\s₦$]/g, '') : major;
  if (!/^-?\d+(\.\d{1,2})?$/.test(String(cleaned))) throw new Error(`Invalid amount: ${major}`);
  const [whole, frac = ''] = String(cleaned).split('.');
  const sign = whole.startsWith('-') ? -1 : 1;
  const minor = Math.abs(parseInt(whole, 10)) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return sign * minor;
}

function toMajor(minor) {
  return (Number(minor) || 0) / 100;
}

function formatMoney(minor, currency = 'NGN', locale = 'en-NG') {
  const amount = toMajor(minor);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
  } catch {
    const c = CURRENCIES[currency] || { symbol: currency + ' ' };
    return `${c.symbol}${amount.toLocaleString('en-NG', { minimumFractionDigits: amount % 1 ? 2 : 0 })}`;
  }
}

module.exports = { CURRENCIES, toMinor, toMajor, formatMoney };
