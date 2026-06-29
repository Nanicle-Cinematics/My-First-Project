'use strict';

const ONES = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function threeDigitsToWords(n) {
  const parts = [];
  const hundreds = Math.floor(n / 100);
  const rem = n % 100;
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (rem) {
    if (rem < 20) parts.push(ONES[rem]);
    else {
      const t = Math.floor(rem / 10);
      const o = rem % 10;
      parts.push(o ? `${TENS[t]}-${ONES[o]}` : TENS[t]);
    }
  }
  return parts.join(' ');
}

function amountInWords(value) {
  const n = Number(value || 0);
  const cedis = Math.floor(Math.abs(n));
  const pesewas = Math.round((Math.abs(n) - cedis) * 100);
  const scales = ['', ' thousand', ' million', ' billion'];
  let words = '';
  if (cedis === 0) {
    words = 'zero';
  } else {
    const groups = [];
    let temp = cedis;
    while (temp > 0) {
      groups.push(temp % 1000);
      temp = Math.floor(temp / 1000);
    }
    const chunks = [];
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i]) chunks.push(threeDigitsToWords(groups[i]) + scales[i]);
    }
    words = chunks.join(', ');
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let result = `${cap(words)} Ghana ${cedis === 1 ? 'Cedi' : 'Cedis'}`;
  if (pesewas > 0) {
    result += ` and ${threeDigitsToWords(pesewas)} ${pesewas === 1 ? 'Pesewa' : 'Pesewas'}`;
  }
  return result;
}

module.exports = { amountInWords };
