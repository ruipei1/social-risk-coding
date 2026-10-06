import test from 'node:test';
import assert from 'node:assert/strict';
import { compareReadings } from '../comparison.mjs';
const reading=(id,codes=[],status='complete',quality='substantive',memo='')=>({coder_id:id,saved:true,status,response_quality:quality,observations:memo,dimensions:{behavior:codes.map(id=>({id})),who:[],setting:[]}});
test('order and duplicate labels do not create disagreement; observations are not scored',()=>{
 const r=compareReadings([reading(1,[2,1,1],'complete','substantive','One interpretation'),reading(2,[1,2],'complete','substantive','Another interpretation')]);
 assert.equal(r.result,'consistent');assert.equal(r.observationsDiffer,true);
});
test('unfinished and missing readings are not negative judgments',()=>{
 const rows=[reading(1,[1]),reading(2,[],'draft'),{coder_id:3,saved:false,status:'unread'}];
 assert.equal(compareReadings(rows).result,'insufficient');
 assert.equal(compareReadings(rows,{includeDrafts:true}).result,'disagreement');
});
test('response quality disagreement and empty-set agreement are explicit',()=>{
 assert.equal(compareReadings([reading(1),reading(2,[],'complete','blank')]).fields.response_quality.differs,true);
 const result=compareReadings([reading(1),reading(2)]);assert.equal(result.result,'consistent');assert.equal(result.noLabels,true);
});
