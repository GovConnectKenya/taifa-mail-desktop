'use strict';
// A failed drop gets one accurate message: never a sheet on top of the page's
// own explanation, and never "check your connection" while online.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dropAlert } = require('../src/drop');

test('nothing is said when the files arrived or the page explained the failure', () => {
  assert.equal(dropAlert({ outcome: 'attached', count: 2 }), null);
  assert.equal(dropAlert({ outcome: 'page-reported', count: 2, names: ['a.pdf'] }), null);
  assert.equal(dropAlert(null), null);
});

test('a silent failure while online does not blame the connection', () => {
  const a = dropAlert({ outcome: 'failed', count: 2, names: ['budget.csv', 'plan.pdf'], online: true });
  assert.equal(a.message, 'The files weren’t attached');
  assert.ok(!/connection|offline/i.test(a.detail), a.detail);
  assert.ok(a.detail.includes('budget.csv\nplan.pdf'));
});

test('offline is named only when the machine is offline', () => {
  assert.match(dropAlert({ outcome: 'failed', count: 1, names: ['a.pdf'], online: false }).detail, /^You’re offline/);
  assert.equal(dropAlert({ outcome: 'failed', count: 1 }).message, 'The file wasn’t attached');
});

test('no composer, and long lists', () => {
  assert.match(dropAlert({ outcome: 'no-composer', count: 1, online: true }).detail, /couldn’t open a new message/);
  assert.match(dropAlert({ outcome: 'failed', count: 7, names: ['1', '2', '3', '4', '5'], online: true }).detail, /and 2 more$/);
});
