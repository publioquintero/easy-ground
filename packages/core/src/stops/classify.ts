import type { StopDraft } from '../model';

/**
 * Commercial stops go first: businesses close (and receive in the morning), while homes
 * can wait. GroundCloud's manifest doesn't say which stops are businesses and geocoders
 * return the same address types for shops and houses, so this reads the customer name and
 * Address 2. The driver can always flip it per stop.
 */

const BUSINESS_WORDS = new RegExp(
  '\\b(' +
    [
      'LLC', 'L\\.L\\.C', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LLP', 'PLLC', 'PC', 'GROUP', 'HOLDINGS',
      'BANK', 'CREDIT UNION', 'INSURANCE', 'REALTY', 'TITLE',
      'MARKET', 'STORE', 'SHOP', 'SUPERCENTER', 'SUPPLY', 'DEPOT', 'WAREHOUSE', 'WHOLESALE', 'OUTLET', 'BOUTIQUE',
      'RESTAURANT', 'CAFE', 'GRILL', 'PIZZA', 'BAKERY', 'COFFEE', 'DINER', 'KITCHEN', 'TACO', 'BURGER',
      'AUTO', 'AUTOMOTIVE', 'TIRES?', 'LUBE', 'CAR WASH', 'COLLISION', 'GARAGE',
      'CLINIC', 'DENTAL', 'DENTISTRY', 'ORTHODONTICS', 'MEDICAL', 'HEALTH', 'HOSPITAL', 'PHARMACY', 'CHIROPRACTIC',
      'VETERINARY', 'VET', 'PEDIATRICS', 'THERAPY',
      'SCHOOL', 'ACADEMY', 'ELEMENTARY', 'HIGH SCHOOL', 'COLLEGE', 'UNIVERSITY', 'PRESCHOOL', 'DAYCARE',
      'CHURCH', 'CITY HALL', 'CITY', 'COUNTY', 'LIBRARY', 'FIRE STATION', 'POLICE', 'POST OFFICE',
      'SALON', 'SPA', 'BARBER', 'FITNESS', 'GYM', 'STUDIO', 'HOTEL', 'INN', 'MOTEL',
      'CENTER', 'CENTRE', 'SERVICES?', 'SOLUTIONS', 'SYSTEMS', 'ENTERPRISES', 'INDUSTRIES', 'MANUFACTURING',
      'CONSTRUCTION', 'PLUMBING', 'ELECTRIC', 'HVAC', 'LANDSCAPING', 'OFFICE',
    ].join('|') +
    ')\\b',
);

/** National/regional chains that don't carry a telltale word. */
const CHAINS = [
  'WALMART', 'TARGET', 'COSTCO', "SAM'S CLUB", 'HOME DEPOT', "LOWE'S", 'AUTOZONE', "O'REILLY", 'NAPA',
  'WALGREENS', 'CVS', 'DOLLAR TREE', 'DOLLAR GENERAL', 'FAMILY DOLLAR', 'BEST BUY', 'STAPLES', 'PETSMART', 'PETCO',
  'STARBUCKS', 'SUBWAY', "MCDONALD'S", "WENDY'S", 'TACO BELL', 'DEL TACO', 'CHICK-FIL-A', 'ARCTIC CIRCLE', 'CAFE RIO',
  'COSTA VIDA', 'SWIG', 'MAVERIK', 'CHEVRON', 'SHELL', 'SINCLAIR', 'JIFFY LUBE', 'BIG O', 'DISCOUNT TIRE',
  "MACEY'S", "RIDLEY'S", "SMITH'S", 'HARMONS', 'WINCO', 'ACE HARDWARE', 'UPS STORE', 'AMAZON',
];

/** Address 2 values that only businesses use (APT/UNIT are residential too, so not here). */
const BUSINESS_LINE2 = /\b(STE|SUITE|RECEIVING|DOCK|LOADING|FRONT OFFICE|MAIN OFFICE|RECEPTION|SHIPPING|BLDG|BUILDING)\b/;

export function looksLikeBusiness(stop: Pick<StopDraft, 'customerName' | 'addressLine2'>): boolean {
  const name = (stop.customerName ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  const line2 = (stop.addressLine2 ?? '').toUpperCase();
  if (BUSINESS_LINE2.test(line2)) return true;
  if (!name) return false;
  if (BUSINESS_WORDS.test(name)) return true;
  if (CHAINS.some((chain) => name.includes(chain))) return true;
  if (/#\s?\d+/.test(name)) return true; // store numbers: "WALMART SUPERCENTER #1725"
  if (/\b[A-Z]+'S\b/.test(name)) return true; // possessive brand names: "MACEY'S"
  if (/[&]/.test(name)) return true; // "SMITH & SONS"
  return !name.includes(' ') && name.length > 2; // one word: people have first and last names
}

/**
 * Stops that should be done first: business deliveries (businesses close in the afternoon).
 * Pickups are not: they have their own time window and are scheduled inside it.
 */
export function isPriorityStop(stop: Pick<StopDraft, 'stopType' | 'business'>): boolean {
  return stop.stopType !== 'pickup' && stop.business === true;
}
