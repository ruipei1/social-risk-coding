import test from 'node:test';
import assert from 'node:assert/strict';
import { addSelectedCode } from '../public/selections.js';

const codes = [
  {id:1, dimension:'who', name:'Unspecified', status:'draft'},
  {id:2, dimension:'who', name:'Friend', status:'draft'},
  {id:3, dimension:'behavior', name:'Trying something new', status:'draft'}
];

test('choosing a specific person replaces the default Unspecified label', () => {
  assert.deepEqual(addSelectedCode('who', [1], 2, codes), [2]);
  assert.deepEqual(addSelectedCode('who', [2], 1, codes), [1]);
  assert.deepEqual(addSelectedCode('behavior', [], 3, codes), [3]);
});
