import test from 'node:test';
import assert from 'node:assert/strict';
import { compareReadings } from '../comparison.mjs';
const reading=(id,codes=[],status='complete',quality='substantive',memo='')=>({coder_id:id,saved:true,status,response_quality:quality,observations:memo,dimensions:{behavior:codes.map(id=>({id})),anticipated_interpersonal_consequence:[],who:[],setting:[]}});
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
 const quality=compareReadings([reading(1),reading(2,[],'complete','blank')]);assert.equal(quality.fields.response_quality.differs,true);
 assert.equal(quality.behaviorAgreement.result,'consistent');assert.equal(quality.result,'consistent');
 const result=compareReadings([reading(1),reading(2)]);assert.equal(result.result,'consistent');assert.equal(result.noLabels,true);
});
test('nonbehavior label differences are visible but never affect agreement',()=>{
 const one=reading(1,[1]),two=reading(2,[1]);
 one.dimensions.who=[{id:10}];two.dimensions.setting=[{id:20}];
 const result=compareReadings([one,two]);
 assert.equal(result.fields.who.differs,true);assert.equal(result.fields.setting.differs,true);
 assert.equal(result.result,'consistent');assert.equal(result.behaviorAgreement.result,'consistent');
});
test('behavior agreement always uses completed overlapping readings',()=>{
 const result=compareReadings([reading(1,[1]),reading(2,[1]),reading(3,[2],'draft')],{includeDrafts:true});
 assert.equal(result.result,'disagreement');assert.equal(result.behaviorAgreement.result,'consistent');assert.deepEqual(result.behaviorAgreement.eligibleCoderIds,[1,2]);
});
