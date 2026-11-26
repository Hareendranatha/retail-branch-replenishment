/* global JSZip */
(() => {
  'use strict';
  const ids = ['month-1','month-2','month-3','item-list','supplier-list'];
  const inputs = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const form = document.getElementById('eoq-form'), loadButton = document.getElementById('load-button');
  const generateButton = document.getElementById('generate-button'), resetButton = document.getElementById('reset-button');
  const branchSelect = document.getElementById('branch-select'), status = document.getElementById('status');
  let loaded = null;

  const setStatus = (message, type='') => { status.textContent = message; status.className = `status ${type}`.trim(); };
  const normalizeCode = value => { let text=String(value??'').trim(); if (/^[+-]?\d+\.0+$/.test(text)) text=text.split('.')[0]; return text.toUpperCase(); };
  const normalizeText = value => String(value??'').replace(/\s+/g,' ').trim().toUpperCase();
  const toNumber = value => { if (typeof value==='number' && Number.isFinite(value)) return value; const n=Number(String(value??'').replace(/[,\s]/g,'').trim()); return Number.isFinite(n)?n:0; };
  const escapeHtml = value => String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const xmlEscape = value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');

  function parseCsv(text) {
    const rows=[]; let row=[], value='', quoted=false;
    for (let i=0;i<text.length;i++) { const ch=text[i];
      if (quoted) { if (ch==='"'&&text[i+1]==='"'){value+='"';i++;} else if(ch==='"')quoted=false; else value+=ch; }
      else if(ch==='"')quoted=true; else if(ch===','){row.push(value);value='';} else if(ch==='\n'){row.push(value.replace(/\r$/,''));rows.push(row);row=[];value='';} else value+=ch;
    }
    if(value||row.length){row.push(value.replace(/\r$/,''));rows.push(row);} return rows;
  }
  const xmlText = node => node ? node.textContent||'' : '';
  async function parseXlsxRows(file) {
    const zip=await JSZip.loadAsync(await file.arrayBuffer()), parser=new DOMParser();
    const readXml=async path=>{const entry=zip.file(path);return entry?parser.parseFromString(await entry.async('text'),'application/xml'):null;};
    const sharedDoc=await readXml('xl/sharedStrings.xml');
    const shared=sharedDoc?Array.from(sharedDoc.getElementsByTagName('si')).map(si=>Array.from(si.getElementsByTagName('t')).map(xmlText).join('')):[];
    const workbook=await readXml('xl/workbook.xml'), rels=await readXml('xl/_rels/workbook.xml.rels');
    if(!workbook||!rels) throw new Error(`${file.name}: workbook could not be read.`);
    const relMap={}; Array.from(rels.getElementsByTagName('Relationship')).forEach(rel=>{relMap[rel.getAttribute('Id')]=rel.getAttribute('Target');});
    const sheet=workbook.getElementsByTagName('sheet')[0]; const relId=sheet?.getAttribute('r:id')||sheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id');
    let target=relMap[relId]; if(!target)throw new Error(`${file.name}: first worksheet could not be found.`); target=target.replace(/^\//,'');
    const sheetDoc=await readXml(target.startsWith('xl/')?target:`xl/${target.replace(/^\.\//,'')}`);
    return Array.from(sheetDoc.getElementsByTagName('row')).map(rowNode=>{const row=[];Array.from(rowNode.getElementsByTagName('c')).forEach(cell=>{
      const letters=(cell.getAttribute('r')||'A1').match(/[A-Z]+/i)?.[0].toUpperCase()||'A';let index=0;for(const ch of letters)index=index*26+ch.charCodeAt(0)-64;index--;
      const type=cell.getAttribute('t');let value;if(type==='inlineStr')value=Array.from(cell.getElementsByTagName('t')).map(xmlText).join('');else{const raw=xmlText(cell.getElementsByTagName('v')[0]);value=type==='s'?(shared[Number(raw)]??''):(type==='str'?raw:(raw===''?'':Number(raw)));}row[index]=value;
    });return row;});
  }
  async function readRows(file) { const lower=file.name.toLowerCase(); if(lower.endsWith('.csv'))return parseCsv((await file.text()).replace(/^\uFEFF/,'')); if(lower.endsWith('.xlsx')||lower.endsWith('.xlsm'))return parseXlsxRows(file); throw new Error(`${file.name}: use CSV, XLSX, or XLSM. Save old .xls files as .xlsx first.`); }

  async function loadFiles() {
    const missing=ids.filter(id=>!inputs[id].files[0]); if(missing.length)return setStatus('Select all five files before loading.','error');
    setStatus('Reading files and finding branches…','working'); loadButton.disabled=true;
    try {
      const [m1,m2,m3,itemRows,supplierRows]=await Promise.all(ids.map(id=>readRows(inputs[id].files[0])));
      const salesMonths=[m1,m2,m3].map((rows,i)=>{const usable=rows.slice(2).filter(row=>normalizeCode(row[1])&&normalizeText(row[3]));if(!usable.length)throw new Error(`Month ${i+1}: no sales data found after removing row 1 and the header.`);return usable;});
      const branches=[...new Set(salesMonths.flatMap(rows=>rows.map(row=>normalizeText(row[3])).filter(Boolean)))].sort();
      const activeItems=itemRows.slice(3).filter(row=>String(row[25]??'').trim()==='1').map(row=>({code:normalizeCode(row[1]),name:String(row[2]??'').replace(/\s+/g,' ').trim(),supplier:String(row[13]??'').replace(/\s+/g,' ').trim()})).filter(x=>x.code);
      const items=[...new Map(activeItems.map(item=>[item.code,item])).values()];
      if(!items.length)throw new Error('No active items found. Item List column 26 must contain 1.');
      const supplierDays=new Map();supplierRows.slice(1).forEach(row=>{const name=normalizeText(row[0]);if(name)supplierDays.set(name,Math.max(0,toNumber(row[3])));});
      if(!supplierDays.size)throw new Error('No supplier names and Sup Days found in columns 1 and 4.');
      loaded={salesMonths,items,supplierDays};branchSelect.innerHTML='<option value="">Select a branch</option>'+branches.map(x=>`<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('');branchSelect.disabled=false;generateButton.disabled=true;
      setStatus(`${branches.length} branches and ${items.length.toLocaleString()} active items loaded. Select a branch.`,'success');
    } catch(error){loaded=null;branchSelect.disabled=true;generateButton.disabled=true;setStatus(error.message,'error');} finally{loadButton.disabled=false;}
  }

  function calculate(branch) {
    const monthlyTotals=loaded.salesMonths.map(rows=>{const totals=new Map();rows.forEach(row=>{if(normalizeText(row[3])!==branch)return;const code=normalizeCode(row[1]);if(code)totals.set(code,(totals.get(code)||0)+toNumber(row[8]));});return totals;});
    let missingSuppliers=0;
    const report=loaded.items.map(item=>{const maxSale=Math.max(0,...monthlyTotals.map(m=>m.get(item.code)||0));const expected=maxSale/30;const key=normalizeText(item.supplier),has=loaded.supplierDays.has(key),days=has?loaded.supplierDays.get(key):0;if(!has&&maxSale>0)missingSuppliers++;const based=expected*days;const eoq=based>=3?Math.ceil(based):(based>0?3:0);return[item.code,item.name,item.supplier,eoq];});
    return{report,missingSuppliers};
  }
  function excelColumn(index){let result='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result;}
  async function createXlsx(rows) {
    const all=[['Item Code','Item Name','Supplier','EOQ'],...rows];
    const rowXml=all.map((row,r)=>`<row r="${r+1}">${row.map((v,c)=>{const ref=`${excelColumn(c)}${r+1}`,s=r===0?1:0;return typeof v==='number'?`<c r="${ref}" s="${s}"><v>${v}</v></c>`:`<c r="${ref}" t="inlineStr" s="${s}"><is><t>${xmlEscape(v)}</t></is></c>`;}).join('')}</row>`).join('');
    const sheet=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="14" customWidth="1"/><col min="2" max="2" width="44" customWidth="1"/><col min="3" max="3" width="38" customWidth="1"/><col min="4" max="4" width="12" customWidth="1"/></cols><sheetData>${rowXml}</sheetData><autoFilter ref="A1:D${all.length}"/></worksheet>`;
    const zip=new JSZip();zip.file('[Content_Types].xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
    zip.folder('_rels').file('.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    zip.folder('xl').file('workbook.xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="EOQ Report" sheetId="1" r:id="rId1"/></sheets></workbook>');
    zip.folder('xl').folder('_rels').file('workbook.xml.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    zip.folder('xl').file('styles.xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B5E55"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>');
    zip.folder('xl').folder('worksheets').file('sheet1.xml',sheet);return zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',compression:'DEFLATE'});
  }
  const safeFilename=value=>value.replace(/[\\/:*?"<>|]/g,'-').replace(/\s+/g,' ').trim()||'Branch';
  ids.forEach(id=>inputs[id].addEventListener('change',()=>{document.getElementById(`${id}-name`).textContent=inputs[id].files[0]?.name||'Choose file';inputs[id].closest('.file-card').classList.toggle('selected',Boolean(inputs[id].files[0]));loaded=null;branchSelect.disabled=true;branchSelect.innerHTML='<option value="">Load files first</option>';generateButton.disabled=true;setStatus('Files changed. Load all files again.');}));
  branchSelect.addEventListener('change',()=>{generateButton.disabled=!loaded||!branchSelect.value;});loadButton.addEventListener('click',loadFiles);
  form.addEventListener('submit',async event=>{event.preventDefault();if(!loaded||!branchSelect.value)return setStatus('Load the files and select a branch.','error');generateButton.disabled=true;try{setStatus('Calculating EOQ and creating Excel…','working');const{report,missingSuppliers}=calculate(branchSelect.value),blob=await createXlsx(report),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`${safeFilename(branchSelect.value)}.xlsx`;document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);const warning=missingSuppliers?` ${missingSuppliers} selling items had no matching supplier days and received EOQ 0.`:'';setStatus(`${report.length.toLocaleString()} active items exported for ${branchSelect.value}.${warning}`,missingSuppliers?'warning':'success');}catch(error){setStatus(error.message,'error');}finally{generateButton.disabled=!branchSelect.value;}});
  resetButton.addEventListener('click',()=>{form.reset();loaded=null;ids.forEach(id=>{document.getElementById(`${id}-name`).textContent='Choose file';inputs[id].closest('.file-card').classList.remove('selected');});branchSelect.innerHTML='<option value="">Load files first</option>';branchSelect.disabled=true;generateButton.disabled=true;setStatus('Select all five files to begin.');});
})();
