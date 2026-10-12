const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let report,csrf;
async function render(){
 try {
 const session=await (await fetch('/api/session')).json();csrf=session.csrf;
 const res=await fetch('/api/behavior-migration'),r=await res.json();if(!res.ok)throw new Error(r.error);report=r;
 const open=r.reviews.filter(x=>!x.resolved_at);
 document.querySelector('#report').innerHTML=`<p>Version: <strong>${esc(r.version)}</strong> · ${r.labels.length} selectable behaviors · ${open.length} unresolved migration review assignments · ${r.reviews.length-open.length} resolved</p><p>Backup: ${esc(r.backup)}</p><p>Migration flags do not change completion or discussion statuses. Preserved legacy assignments remain retired and cannot be newly selected. Resolving a migration review can reconcile an earlier batch without reopening it for ordinary coding.</p><details><summary>Preservation and complete old-to-new mapping</summary><pre>${esc(JSON.stringify(r.manifest,null,2))}</pre></details><details><summary>Exact selectable labels and definitions</summary><pre>${esc(JSON.stringify(r.labels,null,2))}</pre></details>${open.map(x=>`<article><h2>${esc(x.participant_label)} · ${esc(x.prompt)} · ${esc(x.username)} · ${esc(x.batch_name)}</h2><p><strong>${esc(x.legacy_name)}</strong>: ${esc(x.reason)}</p><blockquote>${esc(x.text)}</blockquote><details><summary>Original assignment and prior history</summary><pre>${esc(JSON.stringify(x.evidence,null,2))}</pre></details><form data-review="${r.reviews.indexOf(x)}"><label>Replacement behaviors<select multiple name="targets" size="5">${r.labels.map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}</select></label><label>Response evidence and reason<textarea name="reason" required maxlength="6000"></textarea></label><p>Leave the selection empty only when the legacy entry is solely a discussion marker or no behavior is supported. The reason is retained in history; coder notes and status stay unchanged.</p><button type="submit">Resolve migration review</button><p role="status"></p></form></article>`).join('')}`;
 } catch(e){document.querySelector('#report').textContent=e.message;}
}
document.addEventListener('submit',async e=>{
 const form=e.target;if(!form.matches('[data-review]'))return;e.preventDefault();
 const x=report.reviews[Number(form.dataset.review)],button=form.querySelector('button');button.disabled=true;
 const input={response_id:x.response_id,user_id:x.user_id,batch_id:x.batch_id,legacy_code_id:x.legacy_code_id,annotation_version:x.annotation_version,targets:[...form.elements.targets.selectedOptions].map(o=>o.value),reason:form.elements.reason.value};
 try{const res=await fetch('/api/behavior-migration/resolve',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(input)}),data=await res.json();if(!res.ok)throw new Error(data.error);await render();}catch(e){form.querySelector('[role=status]').textContent=e.message;button.disabled=false;}
});
await render();
