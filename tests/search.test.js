import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery, normalizeSearch } from '../web/search.js';

const tire = 'Велопокрышка шоссейная MAXXIS Pursuer 700x30 Fold 60TPI';

test('words match in any order and position, case-insensitive', () => {
  assert.equal(matchesQuery('maxxis 700x30', tire), true);
  assert.equal(matchesQuery('700x30 maxxis', tire), true);
  assert.equal(matchesQuery('покрышка pursuer', tire), true);
  assert.equal(matchesQuery('maxxis 700x25', tire), false);
});

test('cyrillic х and spaces inside sizes, ё and punctuation are ignored', () => {
  assert.equal(matchesQuery('700х30', tire), true);
  assert.equal(matchesQuery('700 x 30', tire), true);
  assert.equal(matchesQuery('ёж', 'Еж-проставка'), true);
  assert.equal(normalizeSearch('Трос 1.5мм, (гальв.)'), 'трос 1 5мм гальв');
});

test('any of the given fields can match (name or sku), empty query matches all', () => {
  assert.equal(matchesQuery('ут000010014', 'Покрышка', 'УТ000010014'), true);
  assert.equal(matchesQuery('   ', 'что угодно'), true);
});
