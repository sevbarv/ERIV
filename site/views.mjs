import {
  contextFields, contextGroups, economyFields, employeeFields, features, measureFields,
} from './schema.mjs';
import {
  bounded, calculate, caseKey, decimal, economyPercentRows, indices, mainRows,
  measurePercentRows, nsm, present, regressions, text,
} from './model.mjs';

const map = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => map[char]);
const attr = (name,value) => value === undefined ? '' : ` ${name}="${esc(value)}"`;
const nf = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2});
const compact = new Intl.NumberFormat('ru-RU',{maximumFractionDigits: 1,notation:'compact'});
export const numeric = value => Number.isFinite(value) ? nf.format(value) : '—';
export const money = value => Number.isFinite(value) ? nf.format(value)+' ₽' : '—';
export const percent = value => Number.isFinite(value) ? nf.format(value*100)+' %' : '—';
export const pp = value => Number.isFinite(value) ? nf.format(value*100)+' п. п.' : '—';
const number = type => type === 'decimal' || type === 'integer';

const icons = {
  right:'<path d="M4 12h15m-6-6 6 6-6 6"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  down:'<path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/>',
  external:'<path d="M13 5h6v6m0-6-8 8m6-1v7H5V7h7"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
};
export const icon = name => icons[name] ? `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>` : '';
export const button = (action,label,variant='outline',extra='',glyph='') =>
  `<button type="button" class="btn ${variant}" data-action="${action}" ${extra}>${icon(glyph)}${esc(label)}</button>`;

export function field(scope,key,label,value,options={}) {
  const {type='text', hint, list, required, wide, placeholder, maxlength=160} = options;
  const id = `${scope}-${key}`;
  const common = `id="${id}" data-scope="${scope}" data-field="${key}"${hint ? attr('aria-describedby',id+'-hint') : ''}${required ? ' required' : ''}`;
  let control;
  if (list) {
    control = `<select ${common}>${(options.noEmpty ? [] : [['','Выберите']]).concat(list).map(item => {
      const [key,label] = Array.isArray(item) ? item : [item,item];
      return `<option value="${esc(key)}"${String(key) === String(value ?? '') ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('')}</select>`;
  } else if (type === 'textarea') {
    control = `<textarea ${common} maxlength="${maxlength}"${attr('placeholder',placeholder)}>${esc(value)}</textarea>`;
  } else {
    const inputMode = number(type) ? attr('inputmode',type === 'integer' ? 'numeric' : 'decimal') : '';
    const length = type === 'date' ? '' : attr('maxlength',number(type) ? 32 : maxlength);
    control = `<input ${common} type="${type === 'date' ? 'date' : 'text'}" value="${esc(value)}"${inputMode}${length}${attr('placeholder',placeholder)} autocomplete="off">`;
  }
  return `<label class="field${wide ? ' wide' : ''}"><span>${esc(label)}${required ? ' *' : ''}</span>${control}${hint ? `<small id="${id}-hint">${esc(hint)}</small>` : ''}</label>`;
}

function check(scope,key,label,checked) {
  return `<label class="check-line"><input type="checkbox" data-scope="${scope}" data-field="${key}"${checked?' checked':''}><span>${esc(label)}</span></label>`;
}

const grid = (html, columns='') => `<div class="form-grid ${columns}">${html}</div>`;
const section = (id,title,html,open=false) =>
  `<details class="form-section" data-detail="${id}"${open ? ' open' : ''}><summary>${esc(title)}</summary><div class="details-body">${html}</div></details>`;
const note = (copy,cls='info-strip') => `<p class="${cls}">${esc(copy)}</p>`;
const pill = (copy,variant='neutral') => `<span class="pill ${variant}">${esc(copy)}</span>`;
const panelHeader = (heading,description,action='') =>
  `<div class="panel-head"><div><h2 id="step-title" tabindex="-1">${esc(heading)}</h2><p>${esc(description)}</p></div>${action}</div>`;
const error = '<p class="form-error" id="step-error" role="alert" hidden></p>';
const metrics = entries => `<div class="metric-list">${entries.map(([label,value,id]) =>
  `<div class="metric-tile"><span>${esc(label)}</span><strong${id ? attr('data-metric',id) : ''}>${esc(value)}</strong></div>`).join('')}</div>`;
const definitions = entries => `<dl class="detail-metrics">${entries.map(([label,value]) =>
  `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
const foot = (next,action='',label='Далее') =>
  `<div class="panel-foot">${action}${next === null ? '' : button('step',label,'primary step-next',`data-step="${next}"`,'right')}</div>`;

const profileLabels = Object.fromEntries(employeeFields.map(({key,label}) => [key,label]));
const featureInfo = Object.fromEntries(features.map(row => [row.key,row]));
const profileHints = {
  company: 'Используйте внутренний код.',
  analysis: 'Один код на случай.',
  person: 'Обезличенный идентификатор.',
  features_date: 'Не позже даты решения.',
  context_id: 'Код из раздела «Контекст».',
};
const binary = [['0','0 · Нет'],['1','1 · Да']];

function profileField(profile,key) {
  const date = key.endsWith('_date') || key === 'outcome_end';
  const bit = ['executed','outcome_known','exit_horizon'].includes(key);
  const optional = !['company','analysis','person','decision_date','features_date','horizon_months','treatment'].includes(key);
  const hint = profileHints[key] ?? (key === 'treatment' ? 'Введите код из «Мер» или BAU.' : undefined);
  const label = key === 'person' ? 'Код сотрудника' : profileLabels[key];
  return field('profile',key,label,profile[key], {
    type: date ? 'date' : key === 'horizon_months' ? 'integer' : 'text',
    list: bit ? binary : undefined,
    hint, required: !optional, maxlength: 120,
  });
}

function featureField(profile,key) {
  const item = featureInfo[key];
  const category = item.format === 'категория';
  const list = item.format === '0/1' ? binary : undefined;
  const scale = category || item.format === '0/1' ? '' : ' · '+item.format;
  return field('profile',key,item.label,profile[key],{type:category ? 'text' : 'decimal',list,hint:item.hint.replaceAll(' • ',' · ')+scale,maxlength:120});
}

export function employeeList(rows,{remoteKeys=new Set(),canSync=false,admin=false}={}) {
  if (!rows.length) return note('Пока нет сохранённых записей.','empty-state');
  return `<div class="collection">${rows.map(row => {
    const key = caseKey(row)?.toLowerCase();
    const online = remoteKeys.has(key);
    return `<div class="item-row"><span><strong>${esc(row.person)}</strong> · ${esc(row.company)}
      <small>${esc(row.kind)} · ${esc(row.decision_date)} · ${esc(row.horizon_months)} мес. · ${online ? 'Google Таблицы' : 'Этот браузер'}</small></span>
      <div class="item-actions">${admin ? '' : button('load-record','Открыть','outline small',attr('data-key',key))}
      ${canSync && !online ? button('sync-record','В Google Таблицы','outline small',attr('data-key',key)) : ''}</div></div>`;
  }).join('')}</div>`;
}

export function profileView(state, rows, options) {
  const p = state.profile;
  const history = p.kind === 'История';
  const indicators = [
    ['tenure','role_tenure','experience','career','age','unit_type','workload','vacancy','pay_gap','performance'],
    ['pay_sat','participation','enps','role_sat','comp_sat','commute','justice','development','colleagues','jobs','stress'],
    ['manager_change','team_change','conditions','feedback','style','sick','personality'],
  ];
  return panelHeader('Сотрудник','Укажите ключ случая и дату, на которую известны признаки.',pill('Ввод данных','input'))+
    grid(field('profile','kind','Тип записи',p.kind,{list:[['Профиль','Текущий профиль'],['История','История назначения']],noEmpty:true})
      + profileField(p,'company')+profileField(p,'analysis')+profileField(p,'person')
      + ['unit','role','decision_date','features_date','horizon_months','context_id'].map(key=>profileField(p,key)).join(''))+
    (history ? section('history','Назначение и исход',grid(['treatment','executed','outcome_end','outcome_known',
      ...(String(p.outcome_known) === '1' ? ['exit_horizon'] : [])].map(key=>profileField(p,key)).join('')),true) : '')+
    section('employee-features','Дополнительные признаки',note('Включайте в реестр только показатели, необходимые для анализа. Шкалы совпадают с Excel.','helper')
      + indicators.map((keys,i)=>`<h3 class="subhead">${['Профиль роли','Опрос сотрудника','Изменения в работе'][i]}</h3>${grid(keys.map(key=>featureField(p,key)).join(''))}`).join(''))+
    section('saved-profiles','Реестр сотрудников · '+rows.length,employeeList(rows,options))+
    error+foot(1,button('save-profile','Добавить в реестр','outline','', 'plus'),'К контексту');
}

function contextField(ctx,fieldInfo) {
  const {key,label} = fieldInfo;
  const required = contextFields.slice(0,6).some(field => field.key === key);
  const score = !required && !/_[nd]$/.test(key);
  const hint = key === 'unit' ? 'Знак * применяет замер ко всей компании.' : score ? 'Среднее от 1 до 5.' : undefined;
  return field('context',key,label.replace(/ • среднее 1–5$/,''),ctx[key], {
    type:key === 'asof' ? 'date' : required ? 'text' : score ? 'decimal' : 'integer',
    hint,required,
  });
}

function modelSettings(state) {
  const s = state.settings;
  const controls =
    grid(field('settings','cutoff','Дата среза',s.cutoff,{type:'date'})
    + field('settings','pooled','Компании',s.pooled,{list:['Совместно','Раздельно'],noEmpty:true})
    + field('settings','design','Дизайн исследования',s.design,{list:['Наблюдение','Рандомизация'],noEmpty:true})
    + field('settings','dataKind','Данные',s.dataKind,{list:['Рабочие','Учебные'],noEmpty:true})
    + field('settings','overlap','Порог перекрытия, %',s.overlap,{type:'decimal',hint:'Больше 0 и меньше 50.'})
    + field('settings','model','Модель исхода','Логит',{list:['Логит'],noEmpty:true,hint:'Модель BAU из скрипта Python.'}))
    + check('settings','dates','Подтверждаю, что признаки были доступны до назначения.',s.dates)
    + (s.design === 'Наблюдение' ? check('settings','controls','Общие причины назначения и ухода учтены.',s.controls)
      : note('Задайте вероятности назначения меры и BAU в карточках мер по протоколу пилота.','helper'));
  const roles = `<div class="table-wrap"><table class="list-table role-table"><thead><tr><th scope="col">Признак</th><th scope="col">Роль</th></tr></thead><tbody>
    ${features.map(item=>`<tr><td>${esc(item.label)}<br><small>${esc(item.hint.replaceAll(' • ',' · '))}</small></td>
      <td><select class="role-select" data-scope="roles" data-field="${item.key}" aria-label="Роль признака «${esc(item.label)}»">
      ${['—','X','W'].map(role=>`<option${s.roles[item.key]===role?' selected':''}>${role}</option>`).join('')}</select></td></tr>`).join('')}
    </tbody></table></div>`;
  const tuning = grid([
    ['minArm','Минимум записей на группу','От 6, в исходном скрипте 25.','integer'],
    ['minEvents','Минимум уходов и оставшихся на группу','От 3, в исходном скрипте 5.','integer'],
    ['minCompanyArm','Минимум для компании в группе','От 1, в исходном скрипте 5.','integer'],
    ['minUplift','Минимальное снижение риска, п. п.','Нижняя граница эффекта должна быть выше этого значения.','decimal'],
    ['lowRisk','Порог низкого риска, %','Для диагностического сегмента.','decimal'],
    ['highRisk','Порог высокого риска, %','Должен превышать порог низкого риска.','decimal'],
    ['budget','Общий лимит расходов, ₽','Для расчёта портфеля в Python.','decimal'],
  ].map(([key,label,hint,type])=>field('settings',key,label,s[key],{type,hint})).join(''));
  return controls
    + section('roles','Роли признаков X и W',note('X меняет оценку эффекта по профилю. W задаёт дополнительные контроли. При объединении компаний включите company.','helper')+roles)
    + section('tuning','Пороговые значения и бюджет',tuning);
}

export function contextView(state, historyCount) {
  const ctx = state.context;
  const ctxKeys = indices(ctx);
  const contextCards = state.contexts.length ? `<div class="collection">${state.contexts.map((row,index)=>
    `<div class="item-row"><span><strong>${esc(row.context_id)}</strong> · ${esc(row.unit)}<small>${esc(row.company)} · ${esc(row.period)} · ${esc(row.asof)}</small></span>
    ${button('load-context','Открыть','outline small',attr('data-index',index))}</div>`).join('')}</div>`
    : note('Добавьте замер через форму или загрузите CSV с техническими ключами Excel.','empty-state');
  const groupHTML = contextGroups.map(g => section('index-'+g.key,g.key+' · '+g.label,
    note(g.ratio?'Введите целые счётчики. Числитель не больше знаменателя, знаменатель больше нуля.':'Введите средние баллы по каждому пункту. Индекс = (среднее − 1) / 4.','helper')
    + grid(g.parts.map(info=>contextField(ctx,info)).join(''))
    + metrics([['Индекс '+g.key,numeric(ctxKeys[g.key]),g.key]]))).join('');
  return panelHeader('Контекст и модель','Замеры подразделения для оценки эффекта по истории.',pill('Для CATE'))+
    note('При ручном сценарии можно перейти к экономике. Для оценки по истории заполните настройки и выбранные признаки.')+
    section('calculation-history','История назначений для Python',
      note('Используются обезличенные записи из этого браузера и загруженного CSV. При запуске они передаются сервису расчёта. CSV должен содержать ключи из строки 5 листа «Сотрудники».','helper')
      + (historyCount ? note('Загружено наблюдений: '+historyCount+'.','helper') : '')
      + `<div class="inline-actions">${button('history-import','Загрузить историю CSV','outline','id="history-import"')}
        ${historyCount ? button('history-clear','Убрать загруженную историю','outline') : ''}</div>`)+
    section('context-entry','Замер контекста',grid(contextFields.slice(0,6).map(info=>contextField(ctx,info)).join(''))
      + groupHTML + `<div class="panel-foot">${button('save-context','Сохранить замер','primary')}${button('new-context','Новый замер','outline')}</div>`,true)+
    section('context-list','Замеры в расчёте · '+state.contexts.length,contextCards
      + `<div class="panel-foot">${button('context-import','Импорт контекста CSV','outline')}</div>`)+
    section('cate-settings','Настройки оценки в Python',modelSettings(state))+
    error+foot(2,button('run-cate','Запустить Python','outline'),'К экономике');
}

function econField(state,row,options={}) {
  const {label,hint} = economyFields[row];
  const isPercent = economyPercentRows.includes(row);
  const title = isPercent && !label.includes('%') ? label+', %' : label;
  return field('economy',row,title,state.economy[row],{
    type: [13,85].includes(row) ? 'textarea' : options.list ? 'text' : 'decimal',
    hint, placeholder: isPercent && row!==10 ? '0–100' : undefined,
    wide:[13,85].includes(row),maxlength: [13,85].includes(row) ? 500 : 160,...options,
  });
}

export function economyView(state) {
  const e = state.economy;
  const calc = calculate(state);
  const efields = rows => rows.map(row=>econField(state,row)).join('');
  const hireRows = {'Свой подбор':[17,18,19,20,21,22,23,24,25,26,27,28],Внутренний:[30,31,32,33,34],
    Агентство:[29,19,23,24,25,26,27,28]};
  const replacement = e[11] === 'Замена';
  const exitBody = replacement
    ? grid(econField(state,16,{list:['Свой подбор','Внутренний','Агентство']})+efields(hireRows[e[16]]??[]))
      + `<h3 class="subhead">Прямые затраты и адаптация</h3>${grid(efields([36,37,38,39,40]))}
        <h3 class="subhead">Потери выпуска</h3>${grid(efields([43,44,45,46,47,48,49]))}`
    : e[11] ? grid(efields([36,52,53,54])) : note('Выберите план на случай добровольного ухода.','empty-state');
  const hrtech =
    grid(econField(state,74,{list:[['Дополнительный','Дополнительный TCO'],['Доля полного','Доля полного TCO']]}))+
    (e[74] === 'Дополнительный' ? grid(efields([75])) : e[74] === 'Доля полного'
      ? grid(efields([73,57,58,60,61,62,63,64,65,66,67]))
        + `<h3 class="subhead">Интеграция</h3>${grid(efields([68,69,70,71]))}`
        + metrics([['Интеграция',money(calc.common.integration),'integration'],['Полный TCO',money(calc.common.tco),'tco']]) : '')+
    metrics([['TCO случая',money(calc.common.tcoCase),'tcoCase']]);
  const baseline = field('state','baseline','Источник риска P₀',state.baseline,{list:[['Сценарий','Ручной сценарий'],['Импорт','Импорт из Python']],noEmpty:true});
  return panelHeader('Экономика случая','Все суммы в рублях за выбранный горизонт. Указывайте 0 там, где расход или эффект проверен и отсутствует.',pill('Ввод данных','input'))+
    grid(econField(state,11,{list:['Замена','Передача работ','Закрытие позиции']})+econField(state,10))+
    section('exit','Экономика добровольного ухода',exitBody+
      metrics([['Подбор',money(calc.common.hire),'hire'],['Прямые затраты',money(calc.common.direct),'direct'],
        ['Вакансия',money(calc.common.vacancyLoss),'vacancyLoss'],['Адаптация',money(calc.common.rampLoss),'rampLoss'],
        ['Стоимость одного ухода',money(calc.common.exitLoss),'exitLoss']]),true)+
    section('hrtech','Стоимость HRTech',hrtech,true)+
    section('baseline','Риск без новой меры',grid(baseline+(state.baseline === 'Сценарий' ? efields([12,13]) : ''))
      + metrics([['P₀ за горизонт',percent(calc.p0),'p0']]),true)+
    section('reference','Справочные показатели',grid(efields([14,78,79,80,81,86,87,88,85]))
      + metrics([['Выручка на человека',money(calc.common.revenuePerson),'revenuePerson'],
        ['Выручка на FTE',money(calc.common.revenueFte),'revenueFte'],['Прибыль на человека',money(calc.common.profitPerson),'profitPerson'],
        ['Выручка сопровождения',money(calc.common.supportRevenue),'supportRevenue']]))+
    error+foot(3,'','К мерам');
}

const measureOptions = {
  7:{list:['Доступна','Недоступна']},
  8:{list:['Импорт','Сценарий назначения','Сценарий исполнения'],noEmpty:true},
  14:{list:['Да','Нет']},
};
const measureHints = {
  9:'Вероятность добровольного ухода от 0 до 100%.',
  10:'Источник, период и основание ручной оценки.',
  11:'Если пусто, модель использует q из истории при наличии данных.',
  12:'100% означает полный расход даже при неисполнении.',
  13:'Остальные расходы распределяются по месяцам.',
  20:'Число месяцев не больше H.',
  25:'Число месяцев не больше H.',
  68:'Доля экономии времени, выраженная в деньгах.',
};
function measureField(m,row,override={}) {
  let label = override.label ?? measureFields[row];
  if (measurePercentRows.includes(row) && !label.includes('%')) label += ', %';
  return field('measure',row,label,m.fields[row],{type:row === 10 ? 'textarea' : 'decimal',
    hint:measureHints[row],wide:row===10,maxlength:row===10?500:160,...measureOptions[row],...override});
}

function specialLines(state,m,kind,start) {
  return state.lines[kind].map((label,i)=>grid(
    field(kind+'-line',i,'Статья '+(i+1),label,{placeholder:'Название',maxlength:100})
    + measureField(m,start+i,{label:'Сумма, ₽'}),
  )).join('');
}

export function measuresView(state) {
  const m = state.measures.find(measure=>measure.slot===state.slot) ?? state.measures[0];
  const calc = calculate(state);
  const row = calc.rows.find(row=>row.slot===m.slot);
  const mfields = numbers => numbers.map(number=>measureField(m,number)).join('');
  const options = `<div class="mini-grid">${[...state.measures].sort((a,b)=>a.slot-b.slot).map(item => {
    const hit = calc.rows.find(r=>r.slot===item.slot);
    const status = item.fields[7] === 'Доступна' && hit?.status === 'Рассчитано' ? ' · готова'
      : item.fields[7] === 'Недоступна' ? ' · недоступна' : '';
    return `<button type="button" class="measure-chip" data-action="select-measure" data-slot="${item.slot}" aria-pressed="${item.slot===m.slot}">
      <span>${esc(item.name||'Своя мера')}</span><small>${esc((item.code||'Введите код')+status)}</small></button>`;
  }).join('')}</div>`;
  const custom = m.slot >= 8 ? grid(field('measure-meta','code','Код меры',m.code,{maxlength:80})
    + field('measure-meta','name','Название меры',m.name,{maxlength:100})) : '';
  const probs =
    (m.fields[8] === 'Импорт' ? note(row?.history ? 'Статус Python · '+row.history[7] : 'Для текущего ключа пока нет строки Python.','helper') : '')
    + grid(mfields([8,...(m.fields[8] === 'Импорт' ? [] : [9]),11,10]));
  const estimate = grid(mfields(mainRows[m.slot] ?? [34]))+metrics([['Основная цена меры',money(row?.basic),'basic']]);
  const costs = grid(mfields([12,13,36,37,38,39,40,41]))
    + section('extra-cost','Дополнительные статьи затрат',note('Названия общие для всех мер, суммы вводятся для выбранной меры.','helper')+specialLines(state,m,'cost',43));
  const benefits = [
    ['output','Дополнительный выпуск',[55,56]],
    ['defects','Экономия на дефектах',[57,58,59,60,61]],
    ['absence','Замещение отсутствий',[62,63,64]],
    ['manual','Ручные трудозатраты',[65,66,67,68]],
  ].map(([key,title,rows])=>section(key,title,grid(mfields(rows)))).join('')
    + section('extra-benefits','Дополнительные статьи выгод',note('Названия общие для всех мер.','helper')+specialLines(state,m,'benefit',74));
  const design = state.settings.design === 'Рандомизация' ? section('pilot','Вероятности назначения в пилоте',grid(
    measureField(m,151,{label:'Вероятность случайного назначения меры'})
    +measureField(m,152,{label:'Вероятность случайного назначения BAU'}))) : '';
  return panelHeader('Меры удержания','Отметьте доступность альтернативы и заполните её параметры.',
      button('add-measure','Своя мера','outline small','','plus'))+options+
    `<div class="measure-form"><h3>${esc(m.name||'Своя мера')}</h3>${custom}${grid(mfields([7,14]))}
      ${section('measure-probs','Риск и исполнение',probs,true)}
      ${section('measure-cost','Основная цена меры',estimate,true)}
      ${section('measure-extra-cost','Расходы при назначении',costs,true)}
      ${section('measure-benefits','Прочие выгоды за горизонт',note('Группу можно оставить пустой, если выгода отсутствует. Для применимой группы заполните все её поля.','helper')+benefits)}
      ${section('portfolio','Затраты для бюджетного лимита',grid(measureField(m,'budget',{label:'Лимитируемые затраты, ₽',hint:'Для бюджетного расчёта в Python.'})))}
      ${design}
      ${metrics([['Ожидаемые расходы',money(row?.expected),'expected'],['PV прочих выгод',money(row?.pvOther),'pvOther'],
        ['Порог окупаемости',pp(row?.threshold),'threshold']])}
      </div>${error}${foot(4,m.slot >= 8 ? button('remove-measure','Убрать меру','outline small') : '','Сравнить меры')}`;
}

const scenarios = ['Базовый','Благоприятный','Консервативный'];
const scenariosText = {
  'Базовый':'Максимум положительного ERIV.',
  'Благоприятный':'Максимальное снижение риска среди мер с положительным ERIV.',
  'Консервативный':'Обычная практика без нового назначения.',
};

function comparison(rows,winner) {
  if (!rows.length) return note('Добавьте альтернативы, чтобы начать сравнение.','empty-state');
  const headers = ['Мера','Статус','Риск при мере','ΔP','ERIV','ROI','Порог ΔP'];
  const cells = rows.map(row=>[
    `<strong class="measure-name">${esc(row.name||row.code)}</strong><small>${esc(row.code)}</small>`,
    esc(row.detailStatus),percent(row.p1),pp(row.delta),money(row.eriv),percent(row.roi),pp(row.threshold),
  ].map((value,i)=>`<td data-label="${headers[i]}">${value}</td>`).join(''));
  return `<div class="table-wrap"><table class="list-table ranked"><thead><tr>${headers.map(header=>`<th scope="col">${header}</th>`).join('')}</tr></thead>
    <tbody>${cells.map((cells,i)=>`<tr${rows[i]===winner?' class="winner"':''}>${cells}</tr>`).join('')}</tbody></table></div>`;
}

function descriptive(state) {
  const vals = nsm(state.nsm);
  const nsmFields = ['Исходно назначено','Известен совместный исход к H','Остались и достигли норматива'];
  const groups = ['base','treatment'].map((group,i)=>`<h3 class="subhead">${i === 0 ? 'Обычная практика' : 'Назначена мера'}</h3>
    ${grid(nsmFields.map((label,j)=>field('nsm',group+j,label,state.nsm[group+j],{type:'integer'})).join(''),'three')}`).join('');
  const table = regressions(state.contexts).map(row=>`<tr><td>${esc(row.outcome+' ← '+row.predictors.join(', '))}</td><td>${row.n} / ${row.companies}</td>
    <td>${esc(row.coefficients ? row.coefficients.map(numeric).join(' · ') : row.status)}</td></tr>`).join('');
  return section('nsm','NSM · продуктивное удержание',groups+grid(field('nsm','note','Норматив роли, горизонт и группы',state.nsm.note,{wide:true,maxlength:300}))
    +metrics([['Доля при BAU',percent(vals.shares[0]),'nsm-base'],['Доля при мере',percent(vals.shares[1]),'nsm-treatment'],
      ['Дополнительные удержания на 100',numeric(vals.score),'nsm']]))+
    section('ols','OLS · контекстные связи',note('Коэффициенты идут в порядке предикторов после свободного члена.','helper')
      + `<div class="table-wrap"><table class="list-table"><thead><tr><th scope="col">Уравнение</th><th scope="col">Замеров / компаний</th><th scope="col">Коэффициенты или статус</th></tr></thead><tbody>${table}</tbody></table></div>`);
}

export function resultView(state) {
  const calc = calculate(state);
  const {winner, decision, p0, rows, common} = calc;
  const counted = rows.filter(row=>row.status==='Рассчитано').length;
  const bau = decision === 'bau';
  const resultName = decision === 'profile' ? 'Заполните карточку' : decision === 'pending' ? 'Недостаточно данных'
    : bau ? 'Обычная практика (BAU)' : winner.name;
  const resultHint = decision === 'profile' ? 'Для сравнения нужен код компании, анализа, сотрудника, дата решения и горизонт.'
    : decision === 'pending' ? 'Откройте таблицу ниже и проверьте статус каждой альтернативы.'
    : bau ? (state.scenario === 'Консервативный' ? scenariosText[state.scenario] : 'Среди рассчитанных вариантов нет подходящей меры по этому сценарию.')
    : winner.detailStatus;
  const erivValue = bau ? 0 : winner?.eriv;
  const selected = rows.find(row=>row.slot===state.readout) ?? winner ?? rows.find(row=>row.status==='Рассчитано') ?? rows[0];
  const kpis = [
    ['Риск без меры P₀',percent(p0)], ['Риск при выбранном варианте',percent(bau?p0:winner?.p1)],
    ['Снижение риска',pp(bau?0:winner?.delta)], ['Ожидаемые затраты меры',money(bau?0:winner?.expected)],
  ];
  const riskLoss = common.exitLoss !== null ? -common.exitLoss : null;
  const outcome = p0 !== null && riskLoss !== null ? p0*riskLoss : null;
  const bail = section('bau','Экономика обычной практики',definitions([
    ['План при уходе',state.economy[11]||'—'],['Эффект при одном уходе',money(riskLoss)],['Ожидаемый эффект без меры',money(outcome)],
    ['Приведённый ожидаемый эффект',money(outcome!==null && common.pv!==null ? outcome*common.pv : null)],
  ])+note('Точка отсчёта этих сумм — продолжение работы сотрудника.','helper'), state.scenario==='Консервативный');
  const detail = selected ? section('measure-inspect','Детали выбранной альтернативы',
    grid(field('state','readout','Альтернатива',selected.slot,{list:rows.map(row=>[row.slot,row.name||row.code]),noEmpty:true}))
    +definitions([
      ['Источник',selected.fields[8]||'—'],['Статус',selected.detailStatus],['Исполнение q',percent(selected.q)],
      ['Цена исполнения',money(selected.full)],['Ожидаемые расходы',money(selected.expected)],['PV всех затрат',money(selected.pvCost)],
      ['PV прочих выгод',money(selected.pvOther)],['PV стоимости ухода',money(selected.pvExit)],
      ['Предотвращённые прямые затраты',money(selected.directBenefit)],['Предотвращённые операционные потери',money(selected.operationsBenefit)],
      ['Совокупные выгоды за горизонт',money(selected.benefit)],['NEB без дисконтирования',money(selected.neb)],
      ['ERIV',money(selected.eriv)],['ROI',percent(selected.roi)],['Окупаемость, мес.',numeric(selected.payback)],
      ['Порог снижения риска',pp(selected.threshold)],
      ['Интервал 95%, п. п.',selected.ci?.map(numeric).join(' … ')??'—'],
      ['ERIV при неблагоприятной границе',money(selected.conservative)],
    ])+(selected.threshold>1 ? note('Для окупаемости требуется снижение риска больше 100 п. п.') : '')
    +(selected.history?.[15] ? note(selected.history[15],'helper') : '')
    +(selected.flows.length ? `<div class="chart-panel"><h3>Накопленный дисконтированный поток</h3>
      <p>Старт ${money(selected.flows[0])} · на горизонте ${money(selected.flows.at(-1))}</p>
      <canvas id="cashflow" aria-label="Дисконтированный поток по месяцам" role="img"></canvas></div>` : '')) : '';
  const budget = state.diagnostics?.budget;
  const diagnostics = budget ? section('budget-result','Последний запуск Python',definitions([
    ['Дата среза',state.diagnostics.cutoff||'—'],['Дизайн',state.diagnostics.design||'—'],
    ['Кандидаты по нижней границе эффекта',numeric(budget.candidates)],['Выбраны в пределах бюджета',numeric(budget.selected)],
    ['Лимит',money(budget.budget_rub)],['Зарезервировано',money(budget.committed_budget_rub)],
    ['ERIV выбранных мер',money(budget.expected_eriv_rub)],
  ])+ `<div class="inline-actions">${button('diagnostics','Скачать диагностику','outline small')}${button('cate-export','Скачать результат CATE','outline small')}</div>`) : '';
  return panelHeader('Результат сравнения',scenariosText[state.scenario])+
    `<div class="result-controls">${field('state','scenario','Сценарий',state.scenario,{list:scenarios,noEmpty:true})}
      ${button('excel','Скачать Excel','outline','','down')}${button('econ-export','Экономика CSV','outline','','down')}</div>
    <div class="result-card"><div>${pill(decision==='measure'?'Рекомендация':'Решение')}
      <h3 class="result-name">${esc(resultName)}</h3><p>${esc(resultHint)}</p></div>
      <div class="result-main"><div class="result-value-wrap"><small>ERIV относительно BAU</small><div class="result-value">${money(erivValue)}</div></div></div>
      ${metrics(kpis)}</div>
    ${calc.bau?.[15]?.startsWith('Учебные') && state.baseline==='Импорт' ? note('Импорт помечен как учебный.') : ''}
    <h3 class="subhead">Альтернативы · ${counted} из ${rows.length} рассчитано</h3>
    ${comparison(rows,winner)}${detail}${bail}${descriptive(state)}${diagnostics}${error}`;
}

export function summaryView(state,result,employeeCount) {
  const p = state.profile;
  const complete = result.rows.filter(row=>row.status==='Рассчитано').length;
  return `<div class="summary-card"><h3>Сводка случая</h3>${definitions([
    ['Сотрудник',p.person||'—'],['Горизонт',result.horizon ? result.horizon+' мес.' : '—'],
    ['Риск без меры',percent(result.p0)],['Стоимость ухода',money(result.common.exitLoss)],
    ['Альтернативы готовы',complete+' из '+result.rows.length],
  ])}</div><div class="summary-card"><h3>Реестр сотрудников</h3><p>Записей в этом браузере: ${employeeCount}</p></div>`;
}

export function registryView(rows,session,options) {
  return `<div class="page-heading"><div><h1>База сотрудников</h1>
    <p>История назначений и текущие профили для расчёта.</p></div>
    <div class="page-actions">${button('registry-refresh','Обновить','outline')}${button('logout','Выйти','outline')}</div></div>
    <section class="registry-card"><div class="panel-head"><div><h2>Хранилище</h2><p>${session?.sheetURL ? 'Откройте лист «Сотрудники» для просмотра и редактирования. Доступ зависит от прав Google.' : 'Укажите ссылку на Google Таблицу в настройках сервиса ERIV.'}</p></div>
      ${session?.sheetURL ? `<a class="btn primary" href="${esc(session.sheetURL)}" target="_blank" rel="noopener noreferrer">${icon('external')} Открыть Google Таблицу</a>` : ''}</div>
    ${session?.error ? note(session.error) : ''}${employeeList(rows,{...options,admin:true})}</section>`;
}

export function drawCashflow(canvas, flows) {
  if (!canvas || !flows.length || !canvas.clientWidth) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const scale = Math.min(window.devicePixelRatio||1,3);
  canvas.width = width*scale;
  canvas.height = height*scale;
  const c = canvas.getContext('2d');
  const font = '10px Montserrat, Arial';
  const y0 = Math.min(0,...flows), y1 = Math.max(0,...flows);
  const left = 64, right = width-14, top = 14, bottom = height-23;
  const x = i => left+(right-left)*i/(flows.length-1);
  const y = value => top+(bottom-top)*(y1-value)/(y1-y0||1);
  c.scale(scale,scale);
  c.font = font;
  c.fillStyle = '#514f67';
  c.textBaseline = 'middle';
  const marks = [...new Set([y0,0,y1])].sort((a,b)=>b-a);
  let lastLabel = -Infinity;
  for (const value of marks) {
    c.beginPath(); c.moveTo(left,y(value)); c.lineTo(right,y(value));
    c.strokeStyle = value===0 ? '#9d9aaa' : '#dedde8';
    c.stroke();
    if (y(value)-lastLabel >= 12) {
      c.fillText(compact.format(value)+' ₽',1,y(value));
      lastLabel = y(value);
    }
  }
  c.beginPath();
  flows.forEach((flow,i)=>i===0 ? c.moveTo(x(i),y(flow)) : c.lineTo(x(i),y(flow)));
  c.strokeStyle = '#4f46e5';
  c.lineWidth = 2;
  c.stroke();
  for (const i of [0,flows.length-1]) {
    c.beginPath(); c.arc(x(i),y(flows[i]),3.7,0,Math.PI*2);
    c.fillStyle = '#4f46e5'; c.fill();
  }
  c.fillStyle = '#514f67';
  c.fillText('0',left,bottom+12);
  c.textAlign = 'right';
  c.fillText((flows.length-1)+' мес.',right,bottom+12);
}
