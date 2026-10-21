import test from 'node:test';
import assert from 'node:assert/strict';
import { addSelectedCode } from '../public/selections.js';

const codes = [
  {id:1, dimension:'who', name:'Unspecified', status:'draft'},
  {id:2, dimension:'who', name:'Friend', status:'draft'},
  {id:3, dimension:'behavior', name:'Trying something new', status:'draft'},
  {id:4, dimension:'anticipated_interpersonal_consequence', name:'Unspecified', status:'draft'},
  {id:5, dimension:'anticipated_interpersonal_consequence', name:'Judgment', status:'draft'}
];

test('choosing a specific person replaces the default Unspecified label', () => {
  assert.deepEqual(addSelectedCode('who', [1], 2, codes), [2]);
  assert.deepEqual(addSelectedCode('who', [2], 1, codes), [1]);
  assert.deepEqual(addSelectedCode('behavior', [], 3, codes), [3]);
});

test('an unspecified consequence is mutually exclusive with named consequences', () => {
  assert.deepEqual(addSelectedCode('anticipated_interpersonal_consequence', [4], 5, codes), [5]);
  assert.deepEqual(addSelectedCode('anticipated_interpersonal_consequence', [5], 4, codes), [4]);
});
