/**
 * Which country a phone number belongs to, from its international calling code. Used to keep a client's agent line in
 * a country where the client already has one of our numbers, so a mistake or a stolen login cannot point transfers at a
 * premium-rate number abroad.
 *
 * The codes are the ITU-T E.164 country calling codes, written out here (no library in the project holds them) and not
 * yet checked against the ITU list (lesson L-016). A country missing from the table is refused, never guessed.
 *
 * Two codes are shared. Under +1 (the North American plan) the Caribbean and Pacific members are told apart by area
 * code; any other +1 number is the United States or Canada, which cannot be told apart by number, so they count as one.
 * Under +7, Kazakhstan's numbers start +76 or +77 and the rest are Russia's.
 */

const CODES: Record<string, string> = {
  // Asia and the Pacific
  MY: '60', SG: '65', ID: '62', TH: '66', PH: '63', VN: '84', BN: '673', KH: '855', LA: '856', MM: '95', TL: '670',
  CN: '86', HK: '852', MO: '853', TW: '886', JP: '81', KR: '82', MN: '976',
  IN: '91', PK: '92', BD: '880', LK: '94', NP: '977', MV: '960', BT: '975', AF: '93',
  AU: '61', NZ: '64', PG: '675', FJ: '679',
  // Middle East
  AE: '971', SA: '966', QA: '974', KW: '965', BH: '973', OM: '968', JO: '962', LB: '961', IL: '972', TR: '90', IR: '98', IQ: '964',
  // Europe
  GB: '44', IE: '353', FR: '33', DE: '49', NL: '31', BE: '32', LU: '352', CH: '41', AT: '43', IT: '39', ES: '34', PT: '351',
  DK: '45', SE: '46', NO: '47', FI: '358', IS: '354', PL: '48', CZ: '420', SK: '421', HU: '36', RO: '40', BG: '359',
  GR: '30', HR: '385', SI: '386', RS: '381', UA: '380', EE: '372', LV: '371', LT: '370', MT: '356', CY: '357',
  // Africa
  ZA: '27', NG: '234', KE: '254', EG: '20', MA: '212', GH: '233', TZ: '255', UG: '256', ET: '251',
  // The Americas outside the North American plan
  MX: '52', BR: '55', AR: '54', CL: '56', CO: '57', PE: '51',
};

/** North American plan members other than the United States and Canada, by area code. */
const NANP_AREAS: Record<string, string> = {
  '242': 'BS', '246': 'BB', '264': 'AI', '268': 'AG', '284': 'VG', '340': 'VI', '345': 'KY', '441': 'BM', '473': 'GD',
  '649': 'TC', '658': 'JM', '876': 'JM', '664': 'MS', '670': 'MP', '671': 'GU', '684': 'AS', '721': 'SX', '758': 'LC',
  '767': 'DM', '784': 'VC', '787': 'PR', '939': 'PR', '809': 'DO', '829': 'DO', '849': 'DO', '868': 'TT', '869': 'KN',
};

/**
 * Premium-rate service codes in the North American plan. Any other +1 area code not listed above is taken as the United
 * States or Canada: a Caribbean code missing from the list would wrongly pass, so the list is unverified (L-016).
 */
const PREMIUM_NANP = ['900', '976'];

/** One name for a place a number can be told to be in: 'US/CA' for the two that share +1 numbers. */
const zone = (country: string) => (country === 'US' || country === 'CA' ? 'US/CA' : country);

/** The zone of a number in E.164 form, or null when the table does not know it. */
export function numberZone(e164: string): string | null {
  if (!/^\+[1-9][0-9]{7,14}$/.test(e164)) return null;
  const d = e164.slice(1);
  if (d.startsWith('1')) {
    const area = d.slice(1, 4);
    if (PREMIUM_NANP.includes(area)) return null;   // premium-rate services: never an agent line
    return Object.prototype.hasOwnProperty.call(NANP_AREAS, area) ? NANP_AREAS[area]! : 'US/CA';
  }
  if (d.startsWith('7')) return d.startsWith('76') || d.startsWith('77') ? 'KZ' : 'RU';
  for (const len of [3, 2, 1]) {
    const code = d.slice(0, len);
    const hit = Object.entries(CODES).find(([, c]) => c === code);
    if (hit) return zone(hit[0]);
  }
  return null;
}

/** The zone a country code (ISO 3166 alpha-2) belongs to, or null when the table does not know it. */
export function countryZone(country: string): string | null {
  const c = country.toUpperCase();
  if (c === 'US' || c === 'CA') return 'US/CA';
  if (c === 'RU' || c === 'KZ') return c;
  if (Object.prototype.hasOwnProperty.call(CODES, c) || Object.values(NANP_AREAS).includes(c)) return c;
  return null;
}
