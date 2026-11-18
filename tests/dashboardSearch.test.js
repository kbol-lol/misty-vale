import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSearchText, searchEntries, buildSearchResultsPayload } from '../src/utils/dashboardSearch.js';

const entries = [
  { title: 'XP Speed', description: 'Min/max XP and cooldown', keywords: ['multiplier'], action: 'xp' },
  { title: 'Level Log Channel', description: 'Where level-ups are posted', action: 'announce' },
  { title: 'Ignored Channels', description: 'Channels without XP', action: 'ignored' },
  { title: 'Role Reward Message', description: 'Different message for new roles', keywords: ['gif'], action: 'reward' },
];

test('normalizeSearchText ignores case, accents and symbols', () => {
  assert.equal(normalizeSearchText('Level-Up! Über'), 'level up uber');
});

test('every word must match; title matches rank first', () => {
  const { results, exact } = searchEntries(entries, 'channel');
  assert.equal(exact, true);
  assert.deepEqual(results.map((r) => r.action), ['announce', 'ignored']);

  assert.deepEqual(searchEntries(entries, 'log channel').results.map((r) => r.action), ['announce']);
  assert.deepEqual(searchEntries(entries, 'multiplier').results.map((r) => r.action), ['xp'], 'keywords are searched');
  assert.deepEqual(searchEntries(entries, 'GIF').results.map((r) => r.action), ['reward']);
});

test('falls back to partial matches when nothing matches every word', () => {
  const { results, exact } = searchEntries(entries, 'channel banana');
  assert.equal(exact, false);
  assert.ok(results.length >= 1);
  assert.equal(searchEntries(entries, 'zzz').results.length, 0);
  assert.equal(searchEntries(entries, '   ').results.length, 0);
});

test('results payload lists matches and offers one pick per action', () => {
  const results = [...entries, { title: 'Duplicate action', action: 'xp' }, { title: 'Info only' }];
  const { payload, pickable } = buildSearchResultsPayload({
    dashboardName: 'Test', query: 'x', results, exact: true, pickId: 'dsearch_pick_1',
  });
  assert.equal(pickable.length, 4);
  assert.equal(payload.components.length, 1);
  assert.match(payload.embeds[0].toJSON().description, /XP Speed/);

  const none = buildSearchResultsPayload({ dashboardName: 'Test', query: 'q`x', results: [], exact: true });
  assert.equal(none.payload.components.length, 0);
  assert.match(none.payload.embeds[0].toJSON().description, /Nothing matched/);

  const german = buildSearchResultsPayload({ dashboardName: 'Honeypot', query: 'kanal', results: [], exact: true, locale: 'de' });
  assert.match(german.payload.embeds[0].toJSON().description, /Keine Treffer/);
});
