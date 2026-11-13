/**
 * Name scrubber: company, brand and product names (and web addresses) become generic words.
 */
import { describe, it, expect } from 'vitest';
import { scrubNames } from '../../models && skills/core/name-scrubber';

const out = (s: string, o = {}) => scrubNames(s, o).text;

describe('name scrubber', () => {
  it('blanks company, device and program names with plain stand-ins', () => {
    expect(out('She bought an iPhone from Microsoft.')).toBe('She bought a device from the company.');
    expect(out('Google released it.')).toBe('The company released it.');
  });

  it('blanks web addresses, e-mail addresses and handles', () => {
    expect(out('See https://example.org/a?b=1 now')).toBe('See the website now');
    expect(out('Write to jo.k@mail.example.com or @jo_k')).toBe('Write to the address or the handle');
  });

  it('blanks a name followed by a company ending, and trade-marked words', () => {
    expect(out('It was made by Blue River Holdings Inc. last year')).toBe('It was made by the company last year');
    expect(out('Try Zorp™ today')).toBe('Try the brand today');
  });

  it('turns once-trademarked everyday words into the plain thing, with plurals and capitals', () => {
    expect(out('Pass me a Kleenex.')).toBe('Pass me a tissue.');
    expect(out('Two zippers and Velcro.')).toBe('Two zip fasteners and hook-and-loop fastener.');
    expect(out('Aspirin was first made in 1897.')).toBe('Pain pill was first made in 1897.');
  });

  it('only blanks ambiguous names when capitalised in the middle of a sentence', () => {
    expect(out('He ate an apple and bought an Apple.')).toBe('He ate an apple and bought a company.');
    expect(out('Apple pie is nice.')).toBe('Apple pie is nice.');
    expect(out('The planet Mercury and the Sun are not companies.')).toBe('The planet Mercury and the Sun are not companies.');
  });

  it('uses the same stand-in for the same name and reports every hit', () => {
    const r = scrubNames('Google and google and Microsoft.');
    expect(r.text).toBe('The company and the company and the company.');
    expect(r.hits.find((h) => h.original.toLowerCase() === 'google')?.count).toBe(2);
  });

  it('fixes a/an in front of a stand-in', () => {
    expect(out('It is a Intel product.')).toBe('It is a company product.');
    expect(out('Send it to a jo@x.example.com now')).toBe('Send it to an address now');
  });

  it('accepts extra names, and strict mode blanks capitalised mid-sentence words but not months or sentence starts', () => {
    expect(out('We met Zorpco today.', { extra: { company: ['Zorpco'] } })).toBe('We met the company today.');
    expect(out('Then Darcy left in March and I stayed.', { strict: true })).toBe('Then the name left in March and I stayed.');
  });
});
