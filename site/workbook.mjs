import { unzipSync, zipSync, strFromU8, strToU8 } from './assets/vendor/fflate.mjs';
import { employeeFields, contextFields, features } from './schema.mjs';
import {
  bounded, calculate, caseKey, decimal, economyPercentRows, measurePercentRows,
  present, rate, regressions, text,
} from './model.mjs';

const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const xmlNS = 'http://www.w3.org/XML/1998/namespace';
const templateURL = new URL('./assets/ERIV.xlsx', import.meta.url);

function column(index) {
  let value = '';
  for (let i = index; i > 0; i = Math.floor((i-1)/26)) {
    value = String.fromCharCode((i-1)%26 + 65) + value;
  }
  return value;
}

function columnIndex(ref) {
  return [...ref.replace(/\d/g,'')].reduce((sum,ch) => sum*26 + ch.charCodeAt(0)-64,0);
}

function insertSorted(parent, node, key, order) {
  const next = [...parent.children].find(child => order(child) > key);
  parent.insertBefore(node, next ?? null);
}

function setCells(archive, index, entries) {
  const path = 'xl/worksheets/sheet'+index+'.xml';
  const doc = new DOMParser().parseFromString(strFromU8(archive[path]), 'application/xml');
  const sheetData = doc.getElementsByTagNameNS(namespace,'sheetData')[0];
  if (!sheetData) throw new Error('Лист шаблона Excel повреждён.');
  const rows = new Map([...sheetData.children].map(row => [+row.getAttribute('r'),row]));
  const rowCells = new Map();
  if (index === 4) {
    const lastContextRow = 108;
    const maxContextRow = entries.reduce((last,[ref])=>Math.max(last,+ref.match(/\d+$/)[0]),lastContextRow);
    const formulas = [...rows.get(lastContextRow).children].map(cell=>[cell.getAttribute('r'),cell.children[0],cell.getAttribute('s')])
      .filter(([,node])=>node?.localName === 'f');
    for (let row = lastContextRow+1; row <= maxContextRow; row += 1) {
      for (const [ref,formula,style] of formulas) {
        entries.push([ref.replace(/\d+$/,String(row)),{formula:formula.textContent.replace(/([A-Z$])108\b/g,(_,prefix)=>prefix+row),style}]);
      }
    }
  }
  for (const [ref, raw] of entries) {
    const rowIndex = +ref.match(/\d+$/)[0];
    let row = rows.get(rowIndex);
    if (!row && !present(raw)) continue;
    if (!row) {
      row = doc.createElementNS(namespace,'row');
      row.setAttribute('r', rowIndex);
      insertSorted(sheetData,row,rowIndex,node => +node.getAttribute('r'));
      rows.set(rowIndex,row);
    }
    if (!rowCells.has(row)) rowCells.set(row,new Map([...row.children].map(cell => [cell.getAttribute('r'),cell])));
    const cellMap = rowCells.get(row);
    let cell = cellMap.get(ref);
    if (!cell && !present(raw)) continue;
    if (!cell) {
      cell = doc.createElementNS(namespace,'c');
      cell.setAttribute('r',ref);
      insertSorted(row,cell,columnIndex(ref),node => columnIndex(node.getAttribute('r')));
      cellMap.set(ref,cell);
    }
    cell.replaceChildren();
    cell.removeAttribute('t');
    if (!present(raw)) continue;
    if (typeof raw === 'object' && raw.formula) {
      const formula = doc.createElementNS(namespace,'f');
      formula.textContent = raw.formula;
      if (raw.style) cell.setAttribute('s',raw.style);
      cell.append(formula);
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      const val = doc.createElementNS(namespace,'v');
      val.textContent = String(raw);
      cell.append(val);
    } else {
      cell.setAttribute('t','inlineStr');
      const inline = doc.createElementNS(namespace,'is');
      const val = doc.createElementNS(namespace,'t');
      val.setAttributeNS(xmlNS,'xml:space','preserve');
      val.textContent = String(raw);
      inline.append(val);
      cell.append(inline);
    }
  }
  const dimension = doc.getElementsByTagNameNS(namespace,'dimension')[0];
  if (dimension?.hasAttribute('ref')) {
    const [first, last] = dimension.getAttribute('ref').split(':');
    if (last) {
      const maxRow = [...rows.keys()].reduce((max,row)=>Math.max(max,row),+last.match(/\d+$/)[0]);
      dimension.setAttribute('ref', first+':'+last.replace(/\d+$/,String(maxRow)));
      if (index===7 && maxRow>155) {
        for (const validation of doc.getElementsByTagNameNS(namespace,'dataValidation')) {
          validation.setAttribute('sqref',validation.getAttribute('sqref').replace(/([A-Z])155\b/g,(_,prefix)=>prefix+maxRow));
        }
      }
    }
  }
  archive[path] = strToU8(new XMLSerializer().serializeToString(doc));
}

function cellNumber(raw, percent = false) {
  if (!present(raw)) return null;
  const value = percent ? rate(raw) : decimal(raw);
  return value === null ? text(raw) : value;
}

function economicCells(state) {
  const profile = state.profile;
  return [
    ['B5',text(profile.company)], ['B6',text(profile.analysis)], ['B7',text(profile.person)],
    ['B8',text(profile.decision_date)], ['B9',cellNumber(profile.horizon_months)],
    ...Object.entries(state.economy).map(([row,raw]) => [
      'B'+row, [11,13,16,74,85].includes(+row) ? text(raw) : cellNumber(raw,economyPercentRows.includes(+row)),
    ]),
  ];
}

function measureCells(state) {
  const entries = [];
  for (const [kind, start] of [['cost',43],['benefit',74]]) {
    state.lines[kind].forEach((label,index) => entries.push(['A'+(start+index),text(label)]));
  }
  for (const m of state.measures) {
    const col = column(m.slot+2);
    entries.push([col+'5',text(m.code)],[col+'6',text(m.name)]);
    for (const [row,raw] of Object.entries(m.fields)) {
      if (!/^\d+$/.test(row)) continue;
      const extra = row >= 43 && row <= 52 ? state.lines.cost[+row-43]
        : row >= 74 && row <= 83 ? state.lines.benefit[+row-74] : true;
      if (!extra) continue;
      entries.push([col+row,[7,8,10,14].includes(+row) ? text(raw) : cellNumber(raw,measurePercentRows.includes(+row))]);
    }
  }
  return entries;
}

function riskCells(state, contexts) {
  const values = state.nsm;
  const entries = [['B27',text(values.note)]];
  for (const [group,col] of [['base','B'],['treatment','C']]) {
    for (let i = 0; i < 3; i += 1) entries.push([col+(22+i),cellNumber(values[group+i])]);
  }
  for (const [i,row] of regressions(contexts).entries()) {
    const data = [...(row.coefficients ?? [null,null,null,null]),row.n,row.companies,row.status];
    data.forEach((value,j) => entries.push([column(j+2)+(12+i),value]));
  }
  return entries;
}

export async function makeWorkbook(state, rows, contexts) {
  const response = await fetch(templateURL);
  if (!response.ok) throw new Error('Шаблон Excel недоступен.');
  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const p = caseKey(state.profile);
  const seen = new Map(rows.map(row => [caseKey(row)?.toLowerCase(),row]));
  if (p && state.profile.kind === 'Профиль') seen.set(p.toLowerCase(),state.profile);
  seen.delete(undefined);
  const records = [...seen.values()];
  const categorical = new Set(features.filter(item => item.format === 'категория').map(item => item.key));
  const numeric = new Set([
    'horizon_months','executed','outcome_known','exit_horizon',
    ...features.filter(item => item.format !== 'категория' && employeeFields.some(field => field.key === item.key)).map(item=>item.key),
  ]);
  const employeeCells = records.flatMap((row,index) => employeeFields.map(({key,col}) => [
    col+(6+index),
    row.kind === 'Профиль' && ['treatment','executed','outcome_end','outcome_known','exit_horizon'].includes(key) ? null
      : numeric.has(key) && !categorical.has(key) ? cellNumber(row[key]) : text(row[key]),
  ]));
  const contextKeys = new Set(contextFields.slice(0,6).map(f => f.key));
  const contextCells = contexts.flatMap((ctx,index) => contextFields.filter(f => contextKeys.has(f.key) || /_\d/.test(f.key)).map(f => [
    f.col+(index+9), contextKeys.has(f.key) ? text(ctx[f.key]) : cellNumber(ctx[f.key]),
  ]));
  const settings = state.settings;
  const settingsCells = [
    ['B5',text(settings.cutoff)],['B6',cellNumber(state.profile.horizon_months)],['B7',settings.pooled],
    ['B8','Логит'],['B9',settings.dataKind],['B10',settings.dates ? 'Да' : 'Нет'],
    ['B11',settings.controls ? 'Да' : 'Нет'],['B12',cellNumber(settings.overlap,true)],['B13',settings.design],
    ...features.map(field => ['B'+field.row,settings.roles[field.key] ?? '—']),
  ];
  const imports = [...state.cate.values()];
  if (imports.length > 9005) throw new Error('Шаблон поддерживает до 9 005 строк результатов CATE.');
  const cateCells = imports.flatMap((row,i) => row.slice(0,16).map((value,j) => [
    column(j+1)+(i+6), j === 5 || (j >= 8 && j <= 14) ? cellNumber(value) : text(value),
  ]));
  setCells(archive,2,[['B5',state.scenario],['B6',state.baseline]]);
  setCells(archive,3,economicCells(state));
  setCells(archive,4,contextCells);
  setCells(archive,5,riskCells(state,contexts));
  setCells(archive,6,measureCells(state));
  setCells(archive,7,employeeCells);
  setCells(archive,8,settingsCells);
  setCells(archive,9,cateCells);
  return new Blob([zipSync(archive,{level:1})], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}

const escCSV = value => '"'+String(value ?? '').replaceAll('"','""')+'"';
const moneyCell = value => Number.isFinite(value) ? value.toFixed(2).replace('.',',') : '';
const econHeader = ['result_key','available','pv_exit_loss_rub','pv_other_benefits_rub','pv_total_cost_rub','budget_cost_rub'];

export function economicsCSV(state) {
  const result = calculate(state);
  const {key} = result;
  if (!key) return '';
  const rows = result.rows.filter(row => row.fields[7] === 'Доступна' &&
    [row.pvExit,row.pvOther,row.pvCost,decimal(row.fields.budget)].every(Number.isFinite) &&
    decimal(row.fields.budget) >= 0 && !['Проверьте код','Укажите название'].includes(row.status));
  if (!rows.length) return '';
  return '\uFEFF'+[econHeader,...rows.map(row => [
    key+'|'+row.code,1,moneyCell(row.pvExit),moneyCell(row.pvOther),moneyCell(row.pvCost),moneyCell(decimal(row.fields.budget)),
  ])].map(row=>row.map(escCSV).join(';')).join('\r\n');
}

export function download(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
}
