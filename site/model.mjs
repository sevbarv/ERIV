import { contextGroups, employeeFields, features, importFields } from './schema.mjs';

export const present = value => value !== null && value !== undefined && String(value).trim() !== '';
export const text = value => present(value) ? String(value).trim() : '';
export const sum = values => values.reduce((total, value) => total + value, 0);
export const bounded = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
export const inHorizon = value => Number.isInteger(value) && bounded(value, 1, 36);
export const nonnegative = values => values.every(value => bounded(value, 0, Infinity));

export function decimal(value) {
  if (!present(value)) return null;
  const normalized = String(value).trim().replace(/[\u00a0\u202f ]/g, '').replace(',', '.');
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function rate(value) {
  const parsed = decimal(value);
  return parsed === null ? null : parsed / 100;
}

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || value.startsWith('0000')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

export function validCode(value) {
  const normalized = text(value);
  return normalized.length > 0 && normalized.length <= 80
    && !/^[=+\-@]|[|*?~\u0000-\u001f]/.test(normalized);
}

export function caseKey(profile) {
  const codes = ['company', 'analysis', 'person'].map(key => text(profile[key]));
  const horizon = decimal(profile.horizon_months);
  if (codes.some(code => !validCode(code)) || !validDate(profile.decision_date) || !inHorizon(horizon)) return null;
  return [...codes, profile.decision_date, horizon].join('|');
}

export function profileRecord(profile) {
  const target = {};
  const fail = (key, msg) => { throw Object.assign(new Error(msg), {field: key}); };
  for (const {key, label} of employeeFields) {
    const raw = text(profile[key]);
    const format = features.find(item => item.key === key)?.format;
    if (raw.length > 120 || /[\u0000-\u001f]/.test(raw)) fail(key, 'Проверьте поле «' + label + '».');
    if (['company', 'analysis', 'person', 'context_id', 'treatment'].includes(key) && raw && !validCode(raw)) {
      fail(key, 'В поле «' + label + '» нужен код без служебных символов.');
    }
    if (key.endsWith('_date') || key === 'outcome_end') {
      if (raw && !validDate(raw)) fail(key, 'Укажите дату в поле «' + label + '».');
      target[key] = raw || null;
    } else if (['horizon_months', 'executed', 'outcome_known', 'exit_horizon'].includes(key) || format && format !== 'категория') {
      const value = decimal(raw);
      const limits = {'балл 1–5':[1,5], 'балл 0–10':[0,10], 'доля':[0,1], 'число ≥0':[0,Infinity], '0/1':[0,1]};
      const bounds = limits[format];
      if (raw && (value === null || bounds && !bounded(value, ...bounds) || format === '0/1' && !Number.isInteger(value))) {
        fail(key, 'Значение «' + label + '» выходит за пределы шкалы.');
      }
      if (['executed', 'outcome_known', 'exit_horizon'].includes(key) && raw && ![0, 1].includes(value)) fail(key, 'Выберите 0 или 1.');
      target[key] = value;
    } else {
      target[key] = raw || null;
    }
  }
  if (!['Профиль','История'].includes(target.kind)) fail('kind', 'Выберите назначение строки.');
  for (const f of ['company','analysis','person']) {
    if (!target[f]) fail(f, 'Заполните поле «' + employeeFields.find(item => item.key === f).label + '».');
  }
  if (!validDate(target.decision_date)) fail('decision_date', 'Укажите дату решения.');
  if (!validDate(target.features_date) || target.features_date > target.decision_date) {
    fail('features_date', 'Дата замера должна быть не позже даты решения.');
  }
  if (!inHorizon(target.horizon_months)) fail('horizon_months', 'Укажите целый горизонт от 1 до 36 месяцев.');
  if (target.kind === 'История') {
    if (!target.treatment) fail('treatment', 'Укажите код меры или BAU.');
    if (target.outcome_end && target.outcome_end < target.decision_date) fail('outcome_end', 'Конец наблюдения не может быть раньше решения.');
    if (target.outcome_known === 1 && (!target.outcome_end || target.exit_horizon === null)) {
      fail(target.outcome_end ? 'exit_horizon' : 'outcome_end', 'Для известного исхода укажите конец наблюдения и добровольный уход.');
    }
  }
  if (target.kind === 'Профиль') {
    for (const key of ['treatment','executed','outcome_end','outcome_known','exit_horizon']) target[key] = null;
  } else if (target.outcome_known !== 1) {
    target.exit_horizon = null;
  }
  return target;
}

export function economy(record, horizon) {
  const a = row => decimal(record[row]);
  const all = (...rows) => nonnegative(rows.map(a));
  let hire = null;
  if (record[16] === 'Внутренний' && all(30,31,32,33,34)) hire = sum([30,31,32,33,34].map(a));
  const interviews = a(23)*a(24)*a(25)*a(26)*a(27) + a(28)*a(19);
  if (record[16] === 'Свой подбор' && all(17,18,19,20,21,22,23,24,25,26,27,28)) {
    hire = a(17)*a(18)*a(19) + a(20)*a(21) + a(22) + interviews;
  }
  if (record[16] === 'Агентство' && all(19,23,24,25,26,27,28,29)) hire = interviews + a(29);
  const replacement = record[11] === 'Замена';
  let direct = null;
  if (all(36) && replacement && Number.isFinite(hire) && all(37,38,39,40)) direct = hire + a(36) + a(37)*a(38) + a(39) + a(40);
  if (all(36) && ['Передача работ', 'Закрытие позиции'].includes(record[11])) direct = a(36);
  const saved = rate(record[45]);
  const productivity = rate(record[49]);
  const vacancyLoss = all(43,44,46,47) && a(44) <= horizon && bounded(saved, 0, 1)
    ? a(44)*(a(43)*(1-saved)-a(46)+a(47)) : null;
  const rampLoss = all(43,44,48) && a(44)+a(48) <= horizon && bounded(productivity, 0, 1)
    ? a(43)*a(48)*(1-productivity) : null;
  let exitLoss = null;
  if (inHorizon(horizon) && Number.isFinite(direct)) {
    if (replacement && Number.isFinite(vacancyLoss) && Number.isFinite(rampLoss)) exitLoss = direct + vacancyLoss + rampLoss;
    if (!replacement && all(52,53,54)) exitLoss = direct + a(53) + a(54) - a(52);
  }
  const integration = all(68,69,70,71) ? a(68)*a(69) + a(70) + a(71) : null;
  const articles = [57,58,60,61,62,63,64,65,66,67].map(a);
  const tco = nonnegative([integration, ...articles]) ? integration + sum(articles) : null;
  let tcoCase = null;
  if (record[74] === 'Доля полного' && tco !== null && all(73) && a(73) > 0) tcoCase = tco/a(73);
  if (record[74] === 'Дополнительный' && all(75)) tcoCase = a(75);
  const annual = rate(record[10]);
  const factors = inHorizon(horizon) && bounded(annual, 0, Infinity)
    ? Array.from({length: horizon}, (_, month) => Math.exp(-Math.log1p(annual)*(month+1)/12)) : null;
  const pv = factors ? sum(factors)/horizon : null;
  const quotient = (dividend, divisor) => a(dividend) !== null && a(divisor) > 0 ? a(dividend)/a(divisor) : null;
  return {hire, direct, vacancyLoss, rampLoss, exitLoss, integration, tco, tcoCase, factors, pv,
    revenuePerson:quotient(78,79), revenueFte:quotient(78,80), profitPerson:quotient(81,79),
    supportRevenue: all(87,88) ? a(87)*a(88) : null};
}

export const mainRows = [[16,17,19,20],[16,18,19,20],[22,23,24],[19,21],[25,26,27],[28,29],[30,31,32],[33]];
export const measurePercentRows = [9,11,12,13,17,19,68,151,152];
export const economyPercentRows = [10,12,45,49];

function extraValues(fields, labels, start, positive) {
  const values = labels.map((label, i) => {
    const raw = fields[start + i];
    if (!text(label) && !present(raw)) return 0;
    if (!text(label)) return null;
    const value = decimal(raw);
    return Number.isFinite(value) && (!positive || value >= 0) ? value : null;
  });
  return values.every(Number.isFinite) ? sum(values) : null;
}

function measureEconomy(measure, labels, horizon) {
  const f = measure.fields;
  const a = row => measurePercentRows.includes(row) ? rate(f[row]) : decimal(f[row]);
  const sourceRows = mainRows[measure.slot] ?? [34];
  let basic = null;
  if (nonnegative(sourceRows.map(a))) {
    // Each of the first eight Excel columns has its own price formula.
    if (measure.slot === 0 && a(20) <= horizon) basic = a(16)*a(17)*(1+a(19))*a(20);
    if (measure.slot === 1 && a(20) <= horizon && a(18) >= a(16)) basic = (a(18)-a(16))*(1+a(19))*a(20);
    if (measure.slot === 2) basic = a(22)*a(23)+a(24);
    if (measure.slot === 3) basic = a(21)*(1+a(19));
    if (measure.slot === 4 && a(25) <= horizon) basic = a(25)*a(26)+a(27);
    if (measure.slot === 5) basic = a(28)+a(29);
    if (measure.slot === 6) basic = a(30)+a(31)+a(32);
    if (measure.slot === 7) basic = a(33);
    if (measure.slot >= 8) basic = a(34);
  }
  const extraCost = extraValues(f, labels.cost, 43, true);
  const running = [36,37,38,39,40,41].map(r => present(f[r]) ? a(r) : 0);
  const checked = f[14] === 'Да';
  const full = checked && nonnegative([basic, extraCost, ...running]) ? basic + extraCost + sum(running) : null;

  const group = (rows, formula, check = nonnegative) => {
    if (!rows.some(row => present(f[row]))) return 0;
    const values = rows.map(a);
    return check(values) ? formula(...values) : null;
  };
  const benefitGroups = [
    group([55,56], (at, base) => at - base, values => values.every(Number.isFinite)),
    group([57,58,59,60,61], (base, at, hours, wage, other) => (base-at)*(hours*wage+other)),
    group([62,63,64], (base, at, wage) => (base-at)*wage),
    group([65,66,67,68], (base, at, wage, realized) => (base-at)*wage*realized,
      values => nonnegative(values) && values[3] <= 1),
    extraValues(f, labels.benefit, 74, false),
  ];
  const other = checked && benefitGroups.every(Number.isFinite) ? sum(benefitGroups) : null;
  return {basic, full, other};
}

const findImport = (rows, key) => rows.get(key.toLowerCase());
const rf = (row, index) => row ? decimal(row[index]) : null;

export function calculate(state) {
  const key = caseKey(state.profile);
  const horizon = decimal(state.profile.horizon_months);
  const common = economy(state.economy, horizon);
  const bau = key ? findImport(state.cate, key+'|BAU') : null;
  const manual = rate(state.economy[12]);
  const p0 = key && state.baseline === 'Сценарий' && bounded(manual, 0, 1) && text(state.economy[13]) ? manual
    : key && state.baseline === 'Импорт' && bau?.[7] === 'OK' && bounded(rf(bau,8), 0, 1) ? rf(bau,8) : null;
  const codeList = state.measures.map(m => text(m.code).toLowerCase());
  const rows = state.measures.filter(m => text(m.name) || text(m.code)).map(m => {
    const f = m.fields;
    const cost = measureEconomy(m, state.lines, horizon);
    const code = text(m.code);
    const historical = key ? findImport(state.cate, key+'|'+code) : null;
    const applied = f[8];
    const manualQ = rate(f[11]);
    const historyQ = rf(historical,11);
    const q = present(f[11]) ? (bounded(manualQ, 0, 1) && text(f[10]) ? manualQ : null)
      : rf(historical,12) > 0 && bounded(historyQ, 0, 1) ? historyQ : null;
    let p1 = null;
    if (p0 !== null && applied === 'Импорт' && historical?.[7] === 'OK') {
      const linkedP0 = rf(historical,8), linkedP1 = rf(historical,9);
      if (bounded(linkedP0, 0, 1) && bounded(linkedP1, 0, 1) && Math.abs(linkedP0-p0) < 1e-6) p1 = linkedP1;
    }
    const manualP = rate(f[9]);
    if (p0 !== null && text(f[10]) && bounded(manualP, 0, 1)) {
      if (applied === 'Сценарий назначения') p1 = manualP;
      if (applied === 'Сценарий исполнения' && q !== null) p1 = p0 + q*(manualP-p0);
    }
    const delta = p1 === null || p0 === null ? null : p0-p1;
    const idle = rate(f[12]), initial = rate(f[13]);
    const expected = cost.full !== null && bounded(idle, 0, 1)
      ? idle === 1 || cost.full === 0 ? cost.full : q === null ? null : cost.full*(q+(1-q)*idle) : null;
    const pvCost = [expected, common.tcoCase, common.pv].every(Number.isFinite) && bounded(initial, 0, 1)
      ? common.tcoCase + expected*(initial+(1-initial)*common.pv) : null;
    const pvOther = [cost.other, common.pv].every(Number.isFinite) ? cost.other*common.pv : null;
    const pvExit = [common.exitLoss, common.pv].every(Number.isFinite) ? common.exitLoss*common.pv : null;
    const threshold = pvExit > 0 && [pvCost, pvOther].every(Number.isFinite) ? (pvCost-pvOther)/pvExit : null;
    const eriv = [delta, pvExit, pvOther, pvCost].every(Number.isFinite) ? delta*pvExit + pvOther-pvCost : null;
    const roi = eriv !== null && pvCost > 0 ? eriv/pvCost : null;
    const directBenefit = delta !== null && common.direct !== null ? delta*common.direct : null;
    const operationsBenefit = delta !== null && common.exitLoss !== null ? delta*(common.exitLoss-common.direct) : null;
    const benefit = [directBenefit, operationsBenefit, cost.other].every(Number.isFinite) ? directBenefit+operationsBenefit+cost.other : null;
    const neb = eriv !== null ? benefit - expected - common.tcoCase : null;
    const flows = [];
    let payback = null;
    if (eriv !== null) {
      let balance = -common.tcoCase - expected*initial;
      flows.push(balance);
      common.factors.forEach(factor => {
        balance += (benefit-expected*(1-initial))/horizon*factor;
        flows.push(balance);
      });
      if (eriv >= -1e-8 && pvCost > 0) payback = flows[0] === 0 ? 1 : flows.filter(flow => flow < -1e-8).length;
    }
    let status = 'Рассчитано';
    if (!validCode(code) || code.toUpperCase() === 'BAU' || codeList.filter(v => v === code.toLowerCase()).length !== 1) status = 'Проверьте код';
    else if (!text(m.name)) status = 'Укажите название';
    else if (f[7] === 'Недоступна') status = 'Недоступна';
    else if (f[7] !== 'Доступна') status = 'Укажите доступность';
    else if (f[14] !== 'Да') status = 'Подтвердите статьи';
    else if (pvCost === null) status = 'Проверьте затраты / q';
    else if (pvOther === null) status = 'Проверьте выгоды';
    else if (pvExit === null) status = 'Заполните экономику ухода';
    else if (delta === null) status = applied === 'Импорт' && historical?.[7] && historical[7] !== 'OK' ? historical[7] : 'Нет согласованных вероятностей';
    const detailStatus = status === 'Рассчитано' ? applied === 'Импорт' ? 'Расчёт по истории' : 'Сценарная оценка' : status;
    const low = rf(historical,17), high = rf(historical,18);
    const matchingHistory = applied === 'Импорт' && p1 !== null && low !== null && high !== null && low <= high;
    const conservative = matchingHistory && pvExit !== null && pvCost !== null && pvOther !== null
      ? (pvExit >= 0 ? low : high)/100*pvExit + pvOther-pvCost : null;
    return {...m, code, status, detailStatus, p0, p1, delta, q, expected, pvCost, pvOther, pvExit,
      directBenefit, operationsBenefit, benefit, threshold, eriv, neb, roi, payback, flows, ...cost,
      history: historical, ci: matchingHistory ? [low,high] : null, conservative};
  });
  const candidates = rows.filter(r => r.status === 'Рассчитано' && r.eriv > 0 && (state.scenario !== 'Благоприятный' || r.delta > 0));
  const score = row => state.scenario === 'Благоприятный' ? row.delta : row.eriv;
  candidates.sort((a,b) => score(b)-score(a) || a.slot-b.slot);
  const rank = row => state.scenario !== 'Консервативный' && candidates.includes(row) ? 0
    : row.status === 'Рассчитано' ? 1 : row.status === 'Недоступна' ? 3 : 2;
  rows.sort((a,b) => rank(a)-rank(b) || (rank(a) === 0 ? score(b)-score(a) : 0) || a.slot-b.slot);
  const winner = key && state.scenario !== 'Консервативный' ? candidates[0] ?? null : null;
  const decision = !key ? 'profile' : winner ? 'measure'
    : state.scenario === 'Консервативный' || rows.some(r => r.status === 'Рассчитано') ? 'bau' : 'pending';
  return {key, horizon, common, p0, bau, rows, winner, decision};
}

export function indices(ctx) {
  return Object.fromEntries(contextGroups.map(group => {
    const values = group.parts.map(field => decimal(ctx[field.key]));
    if (!group.ratio) {
      const score = values.every(value => bounded(value,1,5)) ? (sum(values)/values.length-1)/4 : null;
      return [group.key, score];
    }
    const ratios = [];
    for (let i = 0; i < values.length; i += 2) {
      const [n,d] = values.slice(i,i+2);
      if (!Number.isInteger(n) || !Number.isInteger(d) || d < 1 || !bounded(n,0,d)) return [group.key,null];
      ratios.push(n/d);
    }
    return [group.key,sum(ratios)/ratios.length];
  }));
}

export function validateContext(ctx) {
  if (!validCode(ctx.company) || !validCode(ctx.context_id) || !text(ctx.unit) || !validDate(ctx.asof) || !text(ctx.period) || !text(ctx.source)) {
    throw new Error('Заполните компанию, подразделение, код замера, дату, период и источник.');
  }
  const values = indices(ctx);
  for (const group of contextGroups) {
    if (group.parts.some(part => present(ctx[part.key])) && values[group.key] === null) {
      throw new Error('Проверьте шкалы и полноту замера «' + group.key + '».');
    }
  }
}

export function nsm(values) {
  const shares = ['base','treatment'].map(group => {
    const [n,k,y] = Array.from({length:3}, (_,i) => decimal(values[group+i]));
    return Number.isInteger(n) && n > 0 && n === k && Number.isInteger(y) && bounded(y,0,k) ? y/n : null;
  });
  const score = shares.every(Number.isFinite) && text(values.note) ? (shares[1]-shares[0])*100 : null;
  return {shares, score};
}

const olsSpecs = [
  ['AQI', ['TTF','HTUI','OMI']],
  ['DQI', ['AQI','TTF','SEI']],
  ['MDI', ['DQI','OMI','DQI × OMI']],
];

export function regressions(contexts) {
  const measurements = contexts.map(ctx => ({...indices(ctx), company: ctx.company}));
  return olsSpecs.map(([outcome, predictors]) => {
    const entries = measurements.map(row => {
      const interaction = row.DQI !== null && row.OMI !== null ? row.DQI*row.OMI : null;
      const x = predictors.map(key => key === 'DQI × OMI' ? interaction : row[key]);
      return {x:[1,...x], y:row[outcome], company:row.company};
    }).filter(row => [...row.x,row.y].every(Number.isFinite));
    const summary = {outcome, predictors, n:entries.length, companies:new Set(entries.map(row => row.company)).size, coefficients:null};
    if (entries.length < 5) return {...summary, status:'Нужно от 5 полных замеров'};
    const ata = Array.from({length:4}, (_, i) => [...Array.from({length:4}, (_, j) => sum(entries.map(row => row.x[i]*row.x[j]))),
      sum(entries.map(row => row.x[i]*row.y))]);
    for (let i = 0; i < 4; i += 1) {
      const pivot = ata.slice(i).reduce((p, row, j) => Math.abs(row[i]) > Math.abs(ata[p][i]) ? i+j : p, i);
      if (Math.abs(ata[pivot][i]) < 1e-9) return {...summary, status:'Зависимые предикторы'};
      [ata[i],ata[pivot]] = [ata[pivot],ata[i]];
      const divisor = ata[i][i];
      ata[i] = ata[i].map(value => value/divisor);
      for (let j = 0; j < 4; j += 1) {
        if (i !== j) ata[j] = ata[j].map((value,k) => value - ata[j][i]*ata[i][k]);
      }
    }
    return {...summary, status:'Описательная оценка', coefficients:ata.map(row => row[4])};
  });
}

export function parseCSV(contents) {
  const source = contents.replace(/^\uFEFF/,'');
  const first = source.split(/\r?\n/,1)[0];
  const separator = first.includes(';') ? ';' : ',';
  const rows = [];
  let current = [], value = '', quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i+1] === '"') { value += '"'; i += 1; }
      else if (quoted || !value.length) quoted = !quoted;
      else value += c;
    } else if (!quoted && c === separator) {
      current.push(value); value = '';
    } else if (!quoted && (c === '\r' || c === '\n')) {
      if (c === '\r' && source[i+1] === '\n') i += 1;
      current.push(value);
      if (current.some(present)) rows.push(current);
      current = []; value = '';
    } else value += c;
  }
  if (quoted) throw new Error('В CSV не закрыта кавычка.');
  current.push(value);
  if (current.some(present)) rows.push(current);
  return rows;
}

export function parseCATE(contents) {
  const [header, ...rows] = parseCSV(contents);
  if (!header || importFields.some((name, i) => name !== header[i]?.trim())) {
    throw new Error('Нужен retention_decisions.csv с заголовками листа «Импорт из CATE».');
  }
  if (!rows.length) throw new Error('CSV содержит заголовки, но не оценки.');
  const keyed = new Map();
  for (const row of rows) {
    const [key,, , , , , measure] = row;
    const k = text(key);
    if (row.length !== header.length || !k || k.split('|').length !== 6 || k !== [...row.slice(1,6),measure].join('|')) {
      throw new Error('Проверьте структуру строк и ключи результата в CSV.');
    }
    if (keyed.has(k.toLowerCase())) throw new Error('В CSV повторяется ключ результата.');
    keyed.set(k.toLowerCase(),row);
  }
  return keyed;
}
