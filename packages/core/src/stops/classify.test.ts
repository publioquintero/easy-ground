import { describe, expect, it } from 'vitest';
import { looksLikeBusiness } from './classify';

const biz = (customerName: string | null, addressLine2: string | null = null) => looksLikeBusiness({ customerName, addressLine2 });

describe('looksLikeBusiness', () => {
  it.each([
    'WALMART SUPERCENTER #1725', "MACEY'S", "RIDLEY'S FAMILY MARKET", 'ARCTIC CIRCLE', 'MOUNTAIN AMERICA CREDIT UNION',
    'COSTA VIDA', 'JIFFY LUBE', 'SUBWAY', 'SWIG', 'DOLLAR TREE', 'ROCKWELL CHARTER HIGH SCHOOL', 'MAVERIK',
    'EAGLE MOUNTAIN CITY HALL', 'KING SOLUTIONS INC', 'NORTHWIND SUPPLY LLC', 'BLUE HERON DENTAL', 'SMITH & SONS',
  ])('business: %s', (name) => expect(biz(name)).toBe(true));

  it.each(['ANA ALDEN', 'KATE FUCHS', 'AMBROCIO OCAMPO', 'LANANH N BUI', 'JEFF MCCRACKEN', 'MARY WEINAND'])(
    'person: %s',
    (name) => expect(biz(name)).toBe(false),
  );

  it('uses Address 2, but apartments stay residential', () => {
    expect(biz('ANA ALDEN', 'STE 200')).toBe(true);
    expect(biz('ANA ALDEN', 'RECEIVING')).toBe(true);
    expect(biz('ANA ALDEN', 'APT 219')).toBe(false);
    expect(biz('ANA ALDEN', 'UNIT 3B')).toBe(false);
  });

  it('has no opinion without a name', () => {
    expect(biz(null)).toBe(false);
  });
});
