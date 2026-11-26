import { catalog, contextFields, employeeFields, features } from './schema.mjs';
import {
  bounded, calculate, caseKey, decimal, indices, nsm, parseCATE, parseCSV,
  profileRecord, rate, text, validDate, validateContext,
} from './model.mjs';
import {
  contextView, drawCashflow, economyView, measuresView, money, numeric, percent,
  pp, profileView, registryView, resultView, summaryView,
} from './views.mjs';

const $ = id => document.getElementById(id);
const panel = $('work-panel');
const stepNames = ['Сотрудник','Контекст','Экономика','Меры','Результат'];
const storageKey = 'eriv.registry.v1';
const profileDefaults = () => ({kind:'Профиль',horizon_months:'12'});
const freshMeasure = (slot,info={}) => ({slot,code:info.code??'',name:info.name??'',fields:{8:'Сценарий назначения'}});
const caseDefaults = () => ({
  economy:{10:'0'},measures:catalog.map((item,slot)=>freshMeasure(slot,item)),
  lines:{cost:Array(10).fill(''),benefit:Array(10).fill('')},
  baseline:'Сценарий',scenario:'Базовый',nsm:{},slot:0,readout:null,
});
const state = {
  ...caseDefaults(),
  profile:profileDefaults(),context:{},contexts:[],
  settings:{cutoff:'',pooled:'Совместно',design:'Наблюдение',dataKind:'Рабочие',overlap:'5',
    dates:false,controls:false,roles:Object.fromEntries(features.map(item=>[item.key,item.default])),
    minArm:'25',minEvents:'5',minCompanyArm:'5',minUplift:'0',lowRisk:'10',highRisk:'50',budget:''},
  cate:new Map(),cateCSV:'',diagnostics:null,
};

let session = null;
let remoteRows = [];
let localRows = readLocalRecords();
let step = 0;
let currentRoute = 'method';
let pending = null;
let viewTimer;
let chartObserver;
let running = false;
let sessionExpiry;
let importedHistory = [];
const caseDrafts = new Map();

function readLocalRecords() {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(data) ? data.filter(row => row && caseKey(row)) : [];
  } catch {
    return [];
  }
}

function addLocalRecord(record) {
  const save = () => {
    const records = readLocalRecords();
    const key = caseKey(record).toLowerCase();
    const previous = records.find(row=>caseKey(row).toLowerCase() === key);
    if (previous) {
      if (Object.keys(record).every(field=>previous[field] === record[field])) return false;
      throw new Error('В этом браузере есть другая запись с таким ключом.');
    }
    try {
      localStorage.setItem(storageKey,JSON.stringify([...records,record]));
    } catch {
      throw new Error('Браузер не смог сохранить запись. Проверьте доступ к хранилищу или войдите для сохранения онлайн.');
    }
    return true;
  };
  return navigator.locks ? navigator.locks.request(storageKey,save) : Promise.resolve().then(save);
}

function mergedRegistry() {
  const records = new Map();
  for (const row of [...localRows,...remoteRows]) records.set(caseKey(row).toLowerCase(),row);
  return [...records.values()].sort((a,b)=>b.decision_date.localeCompare(a.decision_date)||a.person.localeCompare(b.person));
}

function registryOptions() {
  return {remoteKeys:new Set(remoteRows.map(row=>caseKey(row).toLowerCase())),canSync:Boolean(session?.googleReady)};
}

function clearSession() {
  clearTimeout(sessionExpiry);
  session = null;
  remoteRows = [];
  $('registry').replaceChildren();
  $('registry-tab').hidden = true;
  $('admin-title').textContent = 'Админ';
  document.querySelector('[data-action="admin"]').setAttribute('aria-label','Войти в админ-панель');
  if (currentRoute === 'registry') location.hash = '#calculate';
  else if (currentRoute === 'calculate') renderCalculator(true);
}

function serviceBase() {
  if (window.ERIV_API_URL) {
    const url = new URL(window.ERIV_API_URL);
    const loopback = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
      throw new Error('Для API требуется адрес HTTPS.');
    }
    return new URL('api/',url.href.replace(/\/?$/,'/'));
  }
  return new URL('./api/',document.baseURI);
}

async function api(route, options={}) {
  const {method='GET',body,needsAuth=true,timeout=18000} = options;
  const headers = {Accept:'application/json'};
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (needsAuth) {
    if (!session) throw new Error('Войдите в админ-панель.');
    headers.Authorization = 'Bearer '+session.token;
  }
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),timeout);
  try {
    const result = await fetch(new URL(route, serviceBase()),{method,headers,body:payload,credentials:'omit',cache:'no-store',signal:controller.signal});
    if (result.status === 404 || result.status === 405) throw new Error('Сервис ERIV не подключён. Запустите сервер из архива или укажите его адрес в config.js.');
    let data;
    try { data = await result.json(); }
    catch { throw new Error('Сервис ERIV вернул ответ в неизвестном формате.'); }
    if (!result.ok) {
      if (result.status === 401 && needsAuth) clearSession();
      throw new Error(typeof data.detail === 'string' ? data.detail : 'Проверьте формат отправленных данных.');
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Истекло время ожидания ответа сервиса ERIV.');
    if (error instanceof TypeError) throw new Error('Не удалось связаться с сервисом ERIV. Проверьте его адрес и доступ.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function validSheetURL(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin==='https://docs.google.com' && /^\/spreadsheets\/d\/[A-Za-z0-9_-]+\/edit$/.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

async function refreshRegistry() {
  const activeSession = session;
  if (!activeSession?.googleReady) return;
  try {
    const data = await api('registry');
    if (session !== activeSession) return;
    remoteRows = data.rows.filter(row=>row && caseKey(row));
    session.sheetURL = validSheetURL(data.sheetURL);
    session.error = null;
  } catch (error) {
    if (session === activeSession) session.error = error.message;
  }
}

function notify(message) {
  const notice = $('notice');
  clearTimeout(viewTimer);
  notice.textContent = message;
  notice.hidden = false;
  viewTimer = setTimeout(()=>{notice.hidden=true},6500);
}

function problem(message, field, id='step-error') {
  const element = $(id);
  if (element) {
    element.textContent = message;
    element.hidden = false;
  }
  if (field) {
    const input = $('profile-'+field);
    if (input) {
      for (let ancestor = input.parentElement; ancestor && ancestor !== panel; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === 'DETAILS') ancestor.open = true;
      }
      input.setAttribute('aria-invalid','true');
      input.focus({preventScroll:false});
    }
  } else if (id === 'step-error') {
    element?.scrollIntoView({block:'nearest'});
  }
  if (!element) notify(message);
}

function clearProblem(id='step-error') {
  const element = $(id);
  if (element) {
    element.textContent = '';
    element.hidden = true;
  }
}

function summary(result=calculate(state)) {
  $('work-summary').innerHTML = summaryView(state,result,localRows.length);
}

function liveMetrics() {
  const result = calculate(state);
  summary(result);
  if (step === 1) setMetrics(Object.fromEntries(Object.entries(indices(state.context)).map(([key,value])=>[key,numeric(value)])));
  if (step === 2) setMetrics({...Object.fromEntries(Object.entries(result.common).map(([key,value])=>[key,money(value)])),p0:percent(result.p0)});
  if (step === 3) {
    const row = result.rows.find(row=>row.slot===state.slot);
    setMetrics({basic:money(row?.basic),expected:money(row?.expected),pvOther:money(row?.pvOther),threshold:pp(row?.threshold)});
  }
  if (step === 4) {
    const vals = nsm(state.nsm);
    setMetrics({'nsm-base':percent(vals.shares[0]),'nsm-treatment':percent(vals.shares[1]),nsm:numeric(vals.score)});
  }
}

function setMetrics(entries) {
  for (const node of panel.querySelectorAll('[data-metric]')) {
    if (Object.hasOwn(entries,node.dataset.metric)) node.textContent = entries[node.dataset.metric];
  }
}

function renderSteps() {
  const person = stepNames.map((label,i)=>
    `<button type="button" class="step-link" data-action="step" data-step="${i}"${i===step ? ' aria-current="step"' : ''}><span>${i+1}</span>${label}</button>`);
  $('calc-nav').innerHTML = person.join('');
  const active = $('calc-nav').querySelector('[aria-current]');
  if (active.offsetLeft < $('calc-nav').scrollLeft || active.offsetLeft + active.offsetWidth > $('calc-nav').clientWidth + $('calc-nav').scrollLeft) {
    const box = $('calc-nav').getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.right>box.right) $('calc-nav').scrollLeft += tab.right-box.right+8;
    if (tab.left<box.left) $('calc-nav').scrollLeft -= box.left-tab.left+8;
  }
}

function chart() {
  chartObserver?.disconnect();
  const canvas = $('cashflow');
  if (!canvas) return;
  const result = calculate(state);
  const record = result.rows.find(row=>row.slot===state.readout) ?? result.winner
    ?? result.rows.find(row=>row.status==='Рассчитано') ?? result.rows[0];
  if (!record) return;
  const draw = () => drawCashflow(canvas,record.flows);
  requestAnimationFrame(draw);
  if ('ResizeObserver' in window) {
    chartObserver = new ResizeObserver(draw);
    chartObserver.observe(canvas);
  }
}

function renderCalculator(keepDetails=false,focusId='') {
  const before = Object.fromEntries(keepDetails ? [...panel.querySelectorAll('[data-detail]')].map(node=>[node.dataset.detail,node.open]) : []);
  const views = [() => profileView(state,localRows), () => contextView(state, importedHistory.length),
    () => economyView(state), () => measuresView(state), () => resultView(state)];
  panel.innerHTML = views[step]();
  for (const element of panel.querySelectorAll('[data-detail]')) {
    if (Object.hasOwn(before,element.dataset.detail)) element.open = before[element.dataset.detail];
  }
  $('workspace-grid').classList.toggle('result-grid',step===4);
  summary();
  chart();
  if (focusId) $(focusId)?.focus({preventScroll:true});
}

function goStep(index,{scroll=true}={}) {
  if (index < 0 || index >= stepNames.length) return;
  step = index;
  if (currentRoute !== 'calculate') {
    location.hash = '#calculate';
    return;
  }
  renderSteps();
  renderCalculator();
  if (scroll) {
    $('step-title').focus({preventScroll:true});
    $('step-title').scrollIntoView({block:'start'});
  }
}

function renderRegistry() {
  $('registry').innerHTML = registryView(mergedRegistry(),session,registryOptions());
}

function navigate({initial=false}={}) {
  const hash = location.hash.slice(1);
  if (hash==='main') return;
  if (hash==='registry' && !session) {
    location.hash = '#calculate';
    return;
  }
  currentRoute = ['calculate','registry'].includes(hash) ? hash : 'method';
  for (const page of ['method','calculate','registry']) $(page).hidden = page!==currentRoute;
  for (const link of document.querySelectorAll('[data-route]')) {
    if (link.dataset.route===currentRoute) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
  if (currentRoute==='calculate') { renderSteps(); renderCalculator(); }
  if (currentRoute==='registry') renderRegistry();
  if (!initial) {
    window.scrollTo({top:0,behavior:'instant'});
    $('main').focus({preventScroll:true});
  }
}

function stashDraft() {
  const key = caseKey(state.profile)?.toLowerCase();
  if (!key) return;
  const pieces = Object.fromEntries(Object.keys(caseDefaults()).map(key=>[key,state[key]]));
  caseDrafts.set(key,structuredClone(pieces));
}

function openProfile(profile) {
  stashDraft();
  const key = caseKey(profile)?.toLowerCase();
  const pieces = caseDrafts.get(key);
  Object.assign(state,pieces ? structuredClone(pieces) : caseDefaults(),{profile:{...profile}});
  if (!pieces && key && state.cate.has(key+'|bau')) applyHistory();
  goStep(0,{scroll:false});
}

function requestPrivacy(record,{sync=false}={}) {
  const online = sync && Boolean(session?.googleReady);
  pending = {record,sync,online};
  $('storage-note').textContent = online
    ? 'Запись будет добавлена в закрытую Google Таблицу «Сотрудники».'
    : 'Запись сохранится в этом браузере. После подключения Google Таблиц её можно перенести из реестра.';
  $('privacy-ack').checked = false;
  clearProblem('privacy-error');
  $('privacy-dialog').showModal();
}

async function saveConfirmed() {
  if (!pending || !$('privacy-ack').checked) return;
  const action = pending;
  const submit = $('privacy-submit');
  submit.disabled = true;
  clearProblem('privacy-error');
  try {
    let created;
    const {online} = action;
    if (online) {
      const result = await api('registry',{method:'POST',body:{record:action.record,confirmed:true}});
      created = result.created;
      const key = caseKey(result.record).toLowerCase();
      remoteRows = [...remoteRows.filter(row=>caseKey(row).toLowerCase()!==key),result.record];
    } else {
      created = await addLocalRecord(action.record);
      localRows = readLocalRecords();
    }
    if (!action.sync) state.profile = {...action.record};
    $('privacy-dialog').close();
    pending = null;
    if (currentRoute==='registry') renderRegistry();
    if (currentRoute==='calculate') renderCalculator(true);
    notify(created ? online ? 'Запись добавлена в Google Таблицы.' : 'Запись сохранена в этом браузере.' : 'Эта запись уже есть в реестре.');
  } catch (error) {
    problem(error.message,null,'privacy-error');
  } finally {
    submit.disabled = false;
  }
}

function showAdmin() {
  if (session) {
    location.hash = '#registry';
    return;
  }
  $('admin-form').reset();
  clearProblem('admin-error');
  $('admin-dialog').showModal();
}

async function authenticate() {
  const form = new FormData($('admin-form'));
  const submit = $('admin-submit');
  submit.disabled = true;
  clearProblem('admin-error');
  try {
    const service = await api('health',{needsAuth:false});
    if (service.service !== 'ERIV' || !service.adminReady) throw new Error('Сначала настройте учётную запись на сервере ERIV.');
    const data = await api('session',{method:'POST',body:{username:String(form.get('username')).trim(),password:String(form.get('password'))},needsAuth:false});
    session = {token:data.token,googleReady:data.googleReady,sheetURL:validSheetURL(data.sheetURL)};
    sessionExpiry = setTimeout(()=>{
      clearSession();
      notify('Сеанс администратора завершился.');
    },data.expiresIn*1000);
    $('admin-form').reset();
    $('admin-dialog').close();
    $('registry-tab').hidden = false;
    $('admin-title').textContent = 'Админ';
    document.querySelector('[data-action="admin"]').setAttribute('aria-label','Открыть админ-панель');
    location.hash = '#registry';
    await refreshRegistry();
    if (currentRoute==='registry') renderRegistry();
    if (currentRoute==='calculate') renderCalculator(true);
  } catch (error) {
    problem(error.message,null,'admin-error');
  } finally {
    submit.disabled = false;
  }
}

function storeContext() {
  validateContext(state.context);
  const key = row => (text(row.company)+'|'+text(row.context_id)).toLowerCase();
  const existing = state.contexts.findIndex(row=>key(row)===key(state.context));
  const record = Object.fromEntries(Object.entries(state.context).map(([name,value])=>[name,text(value)]));
  if (existing === -1) state.contexts.push(record);
  else state.contexts[existing] = record;
  renderCalculator(true);
  notify(existing === -1 ? 'Замер добавлен в рабочий расчёт.' : 'Замер обновлён.');
}

function importContexts(contents) {
  const [header,...rows] = parseCSV(contents);
  const known = new Set(contextFields.map(f=>f.key));
  if (!header || !rows.length || new Set(header).size !== header.length || header.some(key=>!known.has(key)) ||
      !contextFields.slice(0,6).every(item=>header.includes(item.key))) {
    throw new Error('Нужен CSV с техническими ключами из строки 8 листа «Контекст».');
  }
  const copy = [...state.contexts];
  for (const row of rows) {
    if (row.length !== header.length) throw new Error('В строках CSV разное число столбцов.');
    const values = Object.fromEntries(header.map((key,i)=>[key,text(row[i])]));
    validateContext(values);
    if (copy.some(item=>item.company.toLowerCase()===values.company.toLowerCase() && item.context_id.toLowerCase()===values.context_id.toLowerCase())) {
      throw new Error('Код замера повторяется для той же компании.');
    }
    copy.push(values);
  }
  state.contexts = copy;
  return rows.length;
}

function importHistory(contents) {
  const rows = parseCSV(contents);
  const keys = employeeFields.map(field => field.key);
  // Google Sheets includes title and label rows when exporting the full tab.
  const start = rows.findIndex(row => keys.every((key,i) => text(row[i]) === key));
  if (start < 0) throw new Error('Нужен CSV с 43 техническими ключами листа «Сотрудники».');
  const history = new Map();
  for (const [i, row] of rows.slice(start+1).entries()) {
    if (text(row[0]) === 'Профиль') continue;
    if (text(row[0]) !== 'История' || row.slice(keys.length).some(text)) {
      throw new Error('Проверьте тип записи и столбцы в строке ' + (start+i+2) + '.');
    }
    try {
      const record = profileRecord(Object.fromEntries(keys.map((key,j)=>[key,row[j]])));
      const identity = caseKey(record).toLowerCase();
      if (history.has(identity)) throw new Error('Ключ наблюдения повторяется.');
      history.set(identity,record);
    } catch (error) {
      throw new Error('Строка ' + (start+i+2) + '. ' + error.message);
    }
  }
  if (!history.size) throw new Error('В файле нет строк «История».');
  importedHistory = [...history.values()];
}

function calculationRows() {
  const rows = new Map(localRows.map(row=>[caseKey(row).toLowerCase(),row]));
  for (const row of importedHistory) rows.set(caseKey(row).toLowerCase(),row);
  return [...rows.values()];
}

function applyHistory() {
  const key = caseKey(state.profile)?.toLowerCase();
  if (!key || !state.cate.has(key+'|bau')) return false;
  state.baseline = 'Импорт';
  for (const measure of state.measures) {
    if (state.cate.has(key+'|'+text(measure.code).toLowerCase())) measure.fields[8] = 'Импорт';
  }
  return true;
}

function importResults(contents, diagnostics=null) {
  state.cate = parseCATE(contents);
  state.cateCSV = contents;
  state.diagnostics = diagnostics;
  const profiles = [...state.cate.values()].filter(row=>row[6]==='BAU');
  if (!caseKey(state.profile) && !['company','analysis','person','decision_date'].some(key=>text(state.profile[key])) && profiles.length===1) {
    const [,company,analysis,person,decision_date,horizon_months] = profiles[0];
    state.profile = {...profileDefaults(),company,analysis,person,decision_date,horizon_months};
  }
  const applied = applyHistory();
  renderCalculator(true);
  notify(applied ? 'Оценки Python привязаны к текущему случаю.' : 'Оценки загружены. Откройте профиль из CSV и выберите источник «Импорт».');
}

function parameters(current) {
  const s = current.settings;
  const p = profileRecord(current.profile);
  if (p.kind!=='Профиль') throw new Error('Для расчёта Python откройте текущий профиль.');
  if (!validDate(s.cutoff) || p.features_date > s.cutoff || s.cutoff > p.decision_date) {
    throw new Error('Укажите дату среза между датой замера и датой решения.');
  }
  if (!s.dates || s.design==='Наблюдение' && !s.controls) throw new Error('Подтвердите даты признаков и основание для контролей в настройках.');
  if (!bounded(rate(s.overlap),Number.MIN_VALUE,.499999999999)) throw new Error('Порог перекрытия должен быть больше 0 и меньше 50%.');
  const selectedRoles = Object.values(s.roles).filter(role=>role==='X' || role==='W');
  if (s.pooled==='Совместно' && !['X','W'].includes(s.roles.company)) throw new Error('При объединении компаний включите company в X или W.');
  if (s.design==='Наблюдение' && !selectedRoles.length) throw new Error('Включите хотя бы один доназначенческий признак в X или W.');
  const sizes = ['minArm','minEvents','minCompanyArm'].map(key=>decimal(s[key]));
  if (!sizes.every((value,i)=>Number.isInteger(value)&&bounded(value,[6,3,1][i],100000))) {
    throw new Error('Проверьте минимальные размеры групп в настройках.');
  }
  const [uplift,low,high] = [s.minUplift,s.lowRisk,s.highRisk].map(rate);
  if (!bounded(uplift,0,1) || uplift===1 || !bounded(low,0,1)||!bounded(high,0,1)||low>=high) {
    throw new Error('Проверьте пороги эффекта и уровней риска.');
  }
  const budget = decimal(s.budget);
  if (text(s.budget) && (!bounded(budget,0,Infinity) || Math.abs(budget*100-Math.round(budget*100))>1e-6)) {
    throw new Error('Укажите неотрицательный бюджет с точностью до копейки.');
  }
  return {min_arm:sizes[0],min_events:sizes[1],min_company_arm:sizes[2],min_uplift:uplift,low_risk:low,high_risk:high,
    ...(budget!==null ? {budget:budget.toFixed(2)} : {})};
}

async function runPython(control) {
  if (running) return;
  const current = structuredClone(state);
  const rows = calculationRows();
  if (!rows.some(row=>row.kind==='История')) throw new Error('Добавьте в браузере строки «История» или загрузите CSV с назначениями и исходами.');
  const settings = parameters(current);
  running = true;
  control.disabled = true;
  control.textContent = 'Выполняется…';
  try {
    const {economicsCSV,makeWorkbook} = await import('./workbook.mjs');
    const economics = economicsCSV(current);
    if (settings.budget && !economics) throw new Error('Для расчёта бюджета заполните экономику и лимитируемые затраты хотя бы одной доступной меры.');
    const form = new FormData();
    form.set('workbook',await makeWorkbook(current,rows,current.contexts),'ERIV.xlsx');
    if (economics) form.set('economics',new Blob([economics],{type:'text/csv'}),'economics.csv');
    for (const [key,val] of Object.entries(settings)) form.set(key,String(val));
    const data = await api('cate',{method:'POST',body:form,needsAuth:false,timeout:195000});
    importResults(data.csv,data.diagnostics);
  } finally {
    running = false;
    control.disabled = false;
    control.textContent = 'Запустить Python';
  }
}

async function exportFile(action, control) {
  control.disabled = true;
  try {
    const {economicsCSV,makeWorkbook,download} = await import('./workbook.mjs');
    if (action==='excel') {
      download(await makeWorkbook(state,calculationRows(),state.contexts),'ERIV-calculation.xlsx');
    } else if (action==='econ-export') {
      const csv = economicsCSV(state);
      if (!csv) throw new Error('Заполните экономику доступной меры и её лимитируемые затраты, чтобы выгрузить CSV.');
      download(new Blob([csv],{type:'text/csv;charset=utf-8'}),'economics.csv');
    } else if (action==='cate-export' && state.cateCSV) {
      download(new Blob(['\uFEFF'+state.cateCSV.replace(/^\uFEFF/,'')],{type:'text/csv;charset=utf-8'}),'retention_decisions.csv');
    } else if (action==='diagnostics' && state.diagnostics) {
      download(new Blob([JSON.stringify(state.diagnostics,null,2)],{type:'application/json'}),'diagnostics.json');
    }
  } finally {
    control.disabled = false;
  }
}

function measureAtCursor() {
  return state.measures.find(measure=>measure.slot===state.slot);
}

panel.addEventListener('input',event=>{
  const element = event.target;
  if (!element.matches('[data-field]') || element.tagName==='SELECT' || element.type==='checkbox') return;
  const {scope,field} = element.dataset;
  if (scope==='measure') measureAtCursor().fields[field] = element.value;
  else if (scope==='measure-meta') measureAtCursor()[field] = element.value;
  else if (scope==='cost-line' || scope==='benefit-line') state.lines[scope.split('-')[0]][Number(field)] = element.value;
  else state[scope][field] = element.value;
  element.removeAttribute('aria-invalid');
  clearProblem();
  liveMetrics();
});

panel.addEventListener('change',event=>{
  const element = event.target;
  if (!element.matches('[data-field]') || element.tagName!=='SELECT' && element.type!=='checkbox') return;
  const value = element.type==='checkbox' ? element.checked : element.value;
  const {scope,field} = element.dataset;
  if (scope==='roles') state.settings.roles[field] = value;
  else if (scope==='state') state[field] = field==='readout' ? +value : value;
  else if (scope==='measure') measureAtCursor().fields[field] = value;
  else state[scope][field] = value;
  if (scope==='profile' && field==='outcome_known' && value!=='1') state.profile.exit_horizon = '';
  const rerender = scope==='state' || scope==='economy' || scope==='measure' || scope==='profile'&&['kind','outcome_known'].includes(field)
    || scope==='settings'&&field==='design';
  element.removeAttribute('aria-invalid');
  if (rerender) renderCalculator(true,element.id);
  else liveMetrics();
});

document.addEventListener('click',async event=>{
  const target = event.target.closest('button[data-action]');
  if (!target) return;
  const {action,key,index,slot} = target.dataset;
  try {
    switch (action) {
      case 'step': goStep(+target.dataset.step); break;
      case 'new-profile': openProfile(profileDefaults()); $('profile-company')?.focus(); break;
      case 'save-profile': requestPrivacy(profileRecord(state.profile)); break;
      case 'sync-record': {
        const row = localRows.find(row=>caseKey(row).toLowerCase()===key);
        if (row && session?.googleReady) requestPrivacy(row,{sync:true});
        break;
      }
      case 'load-record': {
        const row = localRows.find(row=>caseKey(row).toLowerCase()===key);
        if (row) openProfile(row);
        break;
      }
      case 'save-context': storeContext(); break;
      case 'new-context':
        state.context={company:state.profile.company,unit:state.profile.unit}; renderCalculator(true,'context-context_id'); break;
      case 'load-context':
        state.context={...state.contexts[+index]}; renderCalculator(true,'context-context_id'); break;
      case 'context-import': $('context-file').click(); break;
      case 'history-import': $('history-file').click(); break;
      case 'history-clear': importedHistory = []; renderCalculator(true,'history-import'); break;
      case 'select-measure':
        state.slot=+slot; renderCalculator(false); panel.querySelector('[aria-pressed="true"]')?.focus({preventScroll:true}); break;
      case 'add-measure': {
        const next = Array.from({length:10},(_,i)=>i+8).find(value=>!state.measures.some(m=>m.slot===value));
        if (next===undefined) throw new Error('Доступны 10 собственных мер, как в шаблоне Excel.');
        state.measures.push(freshMeasure(next)); state.slot=next;
        renderCalculator(false); $('measure-meta-code')?.focus(); break;
      }
      case 'remove-measure':
        state.measures=state.measures.filter(measure=>measure.slot!==state.slot); state.slot=0; renderCalculator(false); break;
      case 'import': $('cate-file').click(); break;
      case 'run-cate': await runPython(target); break;
      case 'excel': case 'econ-export': case 'cate-export': case 'diagnostics':
        await exportFile(action,target); break;
      case 'admin': showAdmin(); break;
      case 'registry-refresh':
        target.disabled=true; await refreshRegistry(); renderRegistry(); break;
      case 'logout':
        target.disabled=true;
        try { await api('logout',{method:'POST',timeout:5000}); }
        catch { /* The browser session still ends. */ }
        clearSession(); break;
      case 'close':
        if (!target.closest('dialog').querySelector('button[type=submit]:disabled')) target.closest('dialog').close();
        break;
      default: break;
    }
  } catch (error) {
    problem(error.message,error.field);
  }
});

for (const id of ['cate-file','context-file','history-file']) {
  $(id).addEventListener('change',async event=>{
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size>12*1024*1024) throw new Error('Допустим размер CSV до 12 МБ.');
      const contents = await file.text();
      if (id==='cate-file') importResults(contents);
      else if (id==='history-file') {
        importHistory(contents);
        renderCalculator(true,'history-import');
        notify('Наблюдений загружено: '+importedHistory.length+'.');
      }
      else {
        const count = importContexts(contents);
        renderCalculator(true);
        notify('Добавлено замеров: '+count+'.');
      }
    } catch (error) {
      notify(error.message);
    }
  });
}
$('privacy-form').addEventListener('submit',event=>{event.preventDefault();saveConfirmed()});
$('admin-form').addEventListener('submit',event=>{event.preventDefault();authenticate()});
for (const id of ['privacy-dialog','admin-dialog']) {
  $(id).addEventListener('cancel',event=>{
    if (event.target.querySelector('button[type=submit]:disabled')) event.preventDefault();
  });
}
window.addEventListener('hashchange',()=>navigate());
document.querySelector('.skip').addEventListener('click',event=>{
  event.preventDefault();
  $('main').focus({preventScroll:true});
  $('main').scrollIntoView({block:'start'});
});
window.addEventListener('storage',event=>{
  if (event.key!==storageKey) return;
  localRows=readLocalRecords();
  if (currentRoute==='registry') renderRegistry();
  if (currentRoute==='calculate') renderCalculator(true);
});
navigate({initial:true});
