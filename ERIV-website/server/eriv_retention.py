# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#   "dowhy==0.13",
#   "econml==0.16.0",
#   "networkx>=3.3,<4",
#   "numpy==1.26.4",
#   "scipy==1.15.3",
#   "scikit-learn==1.6.1",
#   "pandas==2.2.3",
#   "openpyxl==3.1.5",
#   "statsmodels==0.14.5",
# ]
# ///

"""Оценка эффекта мер удержания по книге ERIV и распределение бюджета.

Запуск с uv, который устанавливает зависимости из метаданных скрипта:
    uv run eriv_retention.py --workbook "ERIV.xlsx" --out results
    uv run eriv_retention.py --workbook "ERIV.xlsx" --economics economics.csv --budget 250000 --out results

В существующем окружении Python 3.12 установите зависимости из списка выше
через python -m pip install и замените uv run на python.

На листе «Сотрудники» нужны строки «История» и «Профиль» за единый горизонт.
В «Экспорт в CATE» задайте дату среза, горизонт, дизайн исследования и X/W.
X описывает различия эффекта по профилю, W задаёт дополнительные контроли.
При наблюдательном дизайне включите общие причины назначения и ухода.
Мера сравнивается с BAU, обычной практикой без нового назначения.

Файл экономики для портфеля содержит такие заголовки:
    result_key;available;pv_exit_loss_rub;pv_other_benefits_rub;pv_total_cost_rub;budget_cost_rub
result_key берётся из первого столбца результата. Для BAU строка экономики
не нужна. available равен 0 или 1. На листе «Меры» приведённые потери от ухода,
прочие выгоды и затраты соответствуют строкам 99, 98 и 97. budget_cost_rub
задаёт сумму, которая учитывается в общем лимите расходов. Суммы в рублях.

Результаты записываются в retention_decisions.csv и diagnostics.json.
В Excel импортируйте CSV с разделителем «;» и десятичной запятой. Перенесите
первые 16 столбцов без заголовка в A6:P листа «Импорт из CATE» значениями.
Идентификаторы и первый столбец сохраните как текст. Интервалы характеризуют
условный средний эффект. Для применения политики требуется проверка на
отложенной когорте или в рандомизированном пилоте.
"""

import argparse
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime
import json
import math
from pathlib import Path
import re

from dowhy import CausalModel
from econml.dml import LinearDML
import networkx as nx
import numpy as np
from openpyxl import load_workbook
import pandas as pd
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import csr_matrix
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.preprocessing import OneHotEncoder, StandardScaler


CONTEXT = {
    'HTUI': ('G', 'J', True), 'TTF': ('L', 'Q', False),
    'AQI': ('S', 'Z', True), 'DQI': ('AB', 'AG', False),
    'MDI': ('AI', 'AN', True), 'OMI': ('AP', 'AS', False),
    'SEI': ('AU', 'AW', False),
}
BASE_FIELDS = {
    'kind', 'company', 'analysis', 'person', 'unit', 'role', 'decision_date',
    'features_date', 'horizon_months', 'context_id', 'treatment', 'executed',
    'outcome_end', 'outcome_known', 'exit_horizon',
}


@dataclass
class Settings:
    cutoff: pd.Timestamp
    horizon: int
    pooled: bool
    randomized: bool
    data_kind: str
    overlap: float
    x: list[str]
    w: list[str]
    formats: dict[str, str]
    treatments: list[str]
    assignment_probabilities: dict[str, float]


def blank(value):
    return value is None or isinstance(value, str) and not value.strip()


def code(value):
    if blank(value):
        raise ValueError('пустой код')
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    result = str(value).strip()
    if result[0] in '=+-@' or re.search(r'[|*?~\t\r\n]', result):
        raise ValueError('код содержит символы, несовместимые с ключом Excel')
    return result


def number(value):
    result = float(value.replace(',', '.') if isinstance(value, str) else value)
    if not math.isfinite(result):
        raise ValueError('ожидается конечное число')
    return result


def integer(value, low, high):
    result = number(value)
    if not result.is_integer() or not low <= result <= high:
        raise ValueError(f'ожидается целое число от {low} до {high}')
    return int(result)


def day(value):
    if isinstance(value, (date, datetime, pd.Timestamp)):
        return pd.Timestamp(value).normalize()
    return pd.Timestamp(datetime.strptime(str(value).strip(), '%Y-%m-%d'))


def feature(value, fmt):
    if blank(value):
        return None
    if fmt == 'категория':
        return str(value).strip()
    result = number(value)
    bounds = {'доля': (0, 1), 'балл 1–5': (1, 5), 'балл 0–10': (0, 10),
              'число ≥0': (0, math.inf)}
    if fmt == '0/1':
        return integer(value, 0, 1)
    lo, hi = bounds.get(fmt, (-math.inf, math.inf))
    if not lo <= result <= hi:
        raise ValueError(f'значение вне шкалы «{fmt}»')
    return result


def read_settings(wb):
    sheet = wb['Экспорт в CATE']
    cutoff = day(sheet['B5'].value)
    horizon = integer(sheet['B6'].value, 1, 36)
    modes = {'B7': ('Совместно', 'Раздельно'), 'B8': ('Логит',),
             'B9': ('Рабочие', 'Учебные'), 'B13': ('Наблюдение', 'Рандомизация')}
    for cell, allowed in modes.items():
        if sheet[cell].value not in allowed:
            raise ValueError(f'«Экспорт в CATE» {cell}. Допустимо: {", ".join(allowed)}')
    randomized = sheet['B13'].value == 'Рандомизация'
    if sheet['B10'].value != 'Да' or not randomized and sheet['B11'].value != 'Да':
        raise ValueError('Подтвердите дату признаков в B10 и обоснование контроля смешения в B11 для наблюдательного дизайна.')
    overlap = number(sheet['B12'].value)
    if not 0 < overlap < .5:
        raise ValueError('В B12 требуется порог перекрытия между 0 и 0,5.')
    pooled = sheet['B7'].value == 'Совместно'
    roles = {'X': [], 'W': []}
    formats = {}
    for label, role, fmt, key, _ in sheet.iter_rows(min_row=16, max_row=53, max_col=5, values_only=True):
        if role in roles:
            if key in formats or not re.fullmatch(r'[A-Za-z][A-Za-z_0-9]*', str(key)):
                raise ValueError(f'Недопустимый или повторный ключ признака: {key}')
            roles[role].append(key)
            formats[key] = fmt
        elif role not in (None, '', '—'):
            raise ValueError(f'Неизвестная роль для {label}: {role}')
    if pooled and 'company' not in formats:
        raise ValueError('При совместной оценке включите company в X или W.')
    if not randomized and not formats:
        raise ValueError('Для наблюдательного дизайна укажите доназначенческие факторы назначения и ухода в X/W.')
    measures = wb['Меры']
    treatments = []
    probabilities = {}
    bau_probabilities = set()
    for column in range(2, measures.max_column + 1):
        value = measures.cell(5, column).value
        if blank(value):
            continue
        treatment = code(value)
        if treatment.upper() == 'BAU' or treatment.casefold() in {t.casefold() for t in treatments}:
            raise ValueError(f'Код меры повторяется или зарезервирован: {treatment}')
        treatments.append(treatment)
        p = measures.cell(151, column).value
        p0 = measures.cell(152, column).value
        if randomized and not blank(p):
            probabilities[treatment] = number(p)
        if randomized and not blank(p0):
            bau_probabilities.add(number(p0))
    if not treatments:
        raise ValueError('На листе «Меры» нет кодов мер.')
    if len(bau_probabilities) == 1:
        probabilities['BAU'] = next(iter(bau_probabilities))
    if randomized and (len(bau_probabilities) != 1 or len(probabilities) < 2
                       or not all(0 < p < 1 for p in probabilities.values())
                       or not math.isclose(sum(probabilities.values()), 1, abs_tol=1e-6)):
        raise ValueError('«Меры» 151–152. Укажите постоянные вероятности всех рукавов пилота и одну общую вероятность BAU. Сумма по рукавам должна равняться 1.')
    return Settings(cutoff, horizon, pooled, randomized, sheet['B9'].value,
                    overlap, roles['X'], roles['W'], formats, treatments, probabilities)


def read_context(sheet, keys):
    context = {}
    for row in range(9, sheet.max_row + 1):
        company, unit, context_id, available, period, source = (
            sheet.cell(row, col).value for col in range(1, 7)
        )
        if blank(context_id) and blank(company):
            continue
        try:
            key = code(company), code(context_id)
            if key in context or any(blank(value) for value in (unit, available, period, source)):
                raise ValueError('повтор кода или не заполнены подразделение, дата, период, источник')
            indices = {}
            for name in keys:
                start, end, is_ratio = CONTEXT[name]
                cells = sheet[f'{start}{row}:{end}{row}'][0]
                if any(blank(cell.value) for cell in cells):
                    indices[name] = None
                    continue
                values = [number(cell.value) for cell in cells]
                if is_ratio:
                    pairs = list(zip(values[::2], values[1::2]))
                    if any(not (0 <= n <= d and d > 0 and n.is_integer() and d.is_integer()) for n, d in pairs):
                        raise ValueError(f'{name}: некорректные счётчики')
                    indices[name] = sum(n / d for n, d in pairs) / len(pairs)
                else:
                    if any(not 1 <= value <= 5 for value in values):
                        raise ValueError(f'{name}: ожидаются баллы 1–5')
                    indices[name] = (sum(values) / len(values) - 1) / 4
            context[key] = (str(unit).strip(), day(available), indices)
        except (TypeError, ValueError) as exc:
            raise ValueError(f'«Контекст», строка {row}: {exc}') from exc
    return context


def case_key(row):
    return '|'.join([row['company'], row['analysis'], row['person'],
                     row['decision_date'].date().isoformat(), str(row['horizon_months'])])


def load_input(path: Path):
    wb = load_workbook(path, data_only=True)
    try:
        sheet = wb['Сотрудники']
        if not any(any(not blank(cell) for cell in row) for row in sheet.iter_rows(min_row=6, values_only=True)):
            raise ValueError('Лист «Сотрудники» пуст. Нужны строки «История» и «Профиль».')
        settings = read_settings(wb)
        keys = [cell.value for cell in sheet[5]]
        context_keys = CONTEXT.keys() & settings.formats.keys()
        required = BASE_FIELDS | (settings.formats.keys() - CONTEXT.keys())
        if not required <= set(keys) or len([key for key in keys if key]) != len(set(keys) - {None}):
            raise ValueError('На листе «Сотрудники» отсутствуют или дублируются ключи полей в строке 5.')
        context = read_context(wb['Контекст'], context_keys) if context_keys else {}
        rows = []
        for row_id, values in enumerate(sheet.iter_rows(min_row=6, values_only=True), 6):
            if all(blank(v) for v in values):
                continue
            row = dict(zip(keys, values))
            try:
                rows.append(normalize(row, settings, context))
            except (TypeError, ValueError) as exc:
                raise ValueError(f'«Сотрудники», строка {row_id}: {exc}') from exc
        return settings, pd.DataFrame(rows)
    finally:
        wb.close()


def normalize(row, settings, context):
    kind = row['kind']
    if kind not in ('История', 'Профиль'):
        raise ValueError('укажите «История» или «Профиль»')
    result = {key: code(row[key]) for key in ('company', 'analysis', 'person')}
    result['kind'] = kind
    result['decision_date'] = day(row['decision_date'])
    result['features_date'] = day(row['features_date'])
    result['horizon_months'] = integer(row['horizon_months'], 1, 36)
    result['key'] = case_key(result)
    if result['features_date'] > result['decision_date']:
        raise ValueError('дата замера позже решения')
    if kind == 'История':
        result['treatment'] = code(row['treatment'])
        if result['treatment'] not in ['BAU', *settings.treatments]:
            raise ValueError(f'код назначения {result["treatment"]} отсутствует на листе «Меры»')
        result['executed'] = None if blank(row['executed']) else integer(row['executed'], 0, 1)
        known = 0 if blank(row['outcome_known']) else integer(row['outcome_known'], 0, 1)
        end = None if blank(row['outcome_end']) else day(row['outcome_end'])
        if end is not None and end < result['decision_date']:
            raise ValueError('конец наблюдения раньше решения')
        result['outcome_end'] = end
        result['exit_horizon'] = integer(row['exit_horizon'], 0, 1) if known else None
        if known and end is None:
            raise ValueError('для известного исхода нужна дата конца наблюдения')
        if not known and not blank(row['exit_horizon']):
            raise ValueError('при неизвестном исходе оставьте добровольный уход пустым')
    else:
        result.update(treatment=None, executed=None, outcome_end=None, exit_horizon=None)
        if any(not blank(row[key]) for key in ('treatment', 'executed', 'outcome_known', 'exit_horizon', 'outcome_end')):
            raise ValueError('очистите поля назначения и исхода для текущего профиля')
    context_values = {}
    if context and not blank(row['context_id']):
        key = result['company'], code(row['context_id'])
        if key not in context:
            raise ValueError(f'замер контекста {key[1]} не найден для компании {key[0]}')
        unit, available, context_values = context[key]
        if (unit != '*' and str(row['unit']).strip() != unit) or available > result['features_date']:
            raise ValueError('замер контекста относится к другому подразделению или стал доступен после даты признаков')
    for name, fmt in settings.formats.items():
        if name in CONTEXT:
            result[name] = context_values.get(name)
        elif name != 'company':
            try:
                result[name] = feature(row.get(name), fmt)
            except (TypeError, ValueError) as exc:
                raise ValueError(f'{name}: {exc}') from exc
    return result


IMPORT_COLUMNS = [
    'Ключ результата', 'Компания', 'Анализ', 'ID сотрудника', 'Дата решения',
    'H, мес.', 'Код меры', 'Статус', 'P₀', 'P при назначении', 'Снижение риска',
    'q по истории', 'Назначений с известным исполнением', 'Число BAU с исходом',
    'Число по мере с исходом', 'Источник / пояснение',
]
DETAIL_COLUMNS = [
    'Снижение риска, п. п.', '95% ДИ ниж., п. п.', '95% ДИ верх., п. п.',
    'Вероятность назначения в паре', 'Сегмент для этой меры',
    'Доступна', 'PV потерь от ухода, руб.', 'PV прочих выгод, руб.',
    'PV затрат, руб.', 'Лимитируемые затраты, руб.', 'Порог окупаемости, п. п.',
    'ERIV, руб.', 'ERIV при неблагоприятной границе, руб.', 'Решение по бюджету',
]
ECONOMICS = [
    'available', 'pv_exit_loss_rub', 'pv_other_benefits_rub',
    'pv_total_cost_rub', 'budget_cost_rub',
]
SEED = 42


class KnownPropensity(ClassifierMixin, BaseEstimator):
    def __init__(self, probability):
        self.probability = probability

    def fit(self, x, y):
        self.classes_ = np.array([0, 1])
        return self

    def predict_proba(self, x):
        return np.tile([1 - self.probability, self.probability], (len(x), 1))

    def predict(self, x):
        return np.full(len(x), int(self.probability > .5), dtype=int)


def prepare_cohorts(frame, settings):
    if frame['key'].str.casefold().duplicated().any():
        raise ValueError('В реестре повторяется ключ компания|анализ|сотрудник|дата|H.')
    company_variants = frame.groupby(frame['company'].str.casefold())['company'].nunique()
    person_variants = frame.groupby([frame['company'], frame['person'].str.casefold()])['person'].nunique()
    if (company_variants > 1).any() or (person_variants > 1).any():
        raise ValueError('Коды компании или сотрудника в одной компании различаются только регистром.')
    frame = frame[frame['horizon_months'].eq(settings.horizon)].copy()
    profiles = frame[frame['kind'].eq('Профиль')].copy()
    if profiles.empty:
        raise ValueError(f'Нет строк «Профиль» для H={settings.horizon}.')
    if profiles['decision_date'].lt(settings.cutoff).any() or profiles['features_date'].gt(settings.cutoff).any():
        raise ValueError('Для профилей требуется: дата признаков ≤ дата среза ≤ дата решения.')
    history = frame[frame['kind'].eq('История')].copy()
    history['horizon_end'] = history['decision_date'] + pd.DateOffset(months=settings.horizon)
    mature = history[history['horizon_end'].le(settings.cutoff)].copy()
    if mature.duplicated(['company', 'person', 'decision_date']).any():
        raise ValueError('По одному сотруднику на одну дату обнаружено несколько исторических назначений.')
    first = (mature.sort_values('decision_date', kind='stable')
             .drop_duplicates(['company', 'person']))
    known = (first['outcome_end'].notna() & first['outcome_end'].le(settings.cutoff)
             & (first['exit_horizon'].eq(1) | (first['exit_horizon'].eq(0)
                                               & first['outcome_end'].ge(first['horizon_end']))))
    eligible = first[known].dropna(subset=settings.x + settings.w).copy()
    if settings.randomized:
        extra = set(first['treatment']) - settings.assignment_probabilities.keys()
        if extra:
            raise ValueError(f'В истории есть назначения вне протокола рандомизации: {sorted(extra)}')
    report = {
        'history_rows_for_horizon': len(history), 'mature_history_rows': len(mature),
        'repeated_people_excluded': len(mature) - len(first),
        'unknown_or_incomplete_outcomes_by_arm': first[~known]['treatment'].value_counts().to_dict(),
        'complete_outcomes_without_required_features': int(known.sum()) - len(eligible),
        'training_rows_by_arm': eligible['treatment'].value_counts().to_dict(),
        'profiles': len(profiles),
    }
    return first, eligible, profiles, report


def transform(train, score, names, formats):
    if not names:
        return np.empty((len(train), 0)), np.empty((len(score), 0))
    categories = [name for name in names if formats[name] == 'категория']
    numeric = [name for name in names if name not in categories]
    encoder = ColumnTransformer([
        ('numeric', StandardScaler(), numeric),
        ('categories', OneHotEncoder(drop='first', handle_unknown='ignore', sparse_output=False), categories),
    ])
    # Unsupported categories do not enter estimation or policy. Encoding them here is only
    # needed to keep a common shape for the supported rows in the same scoring batch.
    values = score[names].copy()
    for name in names:
        if name in categories:
            values[name] = values[name].where(values[name].isin(train[name]), train[name].iloc[0])
        else:
            values[name] = values[name].fillna(train[name].median())
    return encoder.fit_transform(train[names]), encoder.transform(values)


def as_features(values):
    return values if values.shape[1] else None


def joint(x, w):
    matrix = np.column_stack((x, w))
    return matrix if matrix.shape[1] else np.zeros((len(matrix), 1))


def support(train, profiles, settings, minimum):
    ok = pd.Series(False, index=profiles.index)
    for company, shortlist in profiles.groupby('company', sort=False):
        local = train[train['company'].eq(company)]
        if len(local) < minimum:
            continue
        allowed = pd.Series(True, index=shortlist.index)
        for name, fmt in settings.formats.items():
            if fmt == 'категория':
                allowed &= shortlist[name].isin(local[name])
            else:
                allowed &= shortlist[name].between(local[name].min(), local[name].max())
        ok.loc[shortlist.index] = allowed
    return ok.to_numpy()


def fit_baseline(history, profiles, settings, args):
    bau = history[history['treatment'].eq('BAU')]
    risk = np.full(len(profiles), np.nan)
    if inadequate(bau, args):
        return risk
    x, score_x = transform(bau, profiles, settings.x + settings.w, settings.formats)
    valid = support(bau, profiles, settings, args.min_company_arm)
    if valid.any():
        x, score_x = joint(x, x[:, :0]), joint(score_x, score_x[:, :0])
        model = LogisticRegression(max_iter=1000).fit(x, bau['exit_horizon'].astype(int))
        risk[valid] = model.predict_proba(score_x[valid])[:, 1]
    return risk


def inadequate(frame, args):
    return (len(frame) < args.min_arm or frame['exit_horizon'].sum() < args.min_events
            or frame['exit_horizon'].eq(0).sum() < args.min_events)


def identify(pair, settings):
    variables = settings.x + settings.w
    graph = nx.DiGraph()
    graph.add_edge('assigned', 'exit_horizon')
    for variable in variables:
        graph.add_edge(variable, 'exit_horizon')
        if not settings.randomized:
            graph.add_edge(variable, 'assigned')
    causal_model = CausalModel(data=pair, treatment='assigned', outcome='exit_horizon', graph=graph)
    estimand = causal_model.identify_effect(proceed_when_unidentifiable=False)
    adjustment = list(estimand.get_backdoor_variables() or [])
    expected = set() if settings.randomized else set(variables)
    if estimand.estimands.get('backdoor') is None or set(adjustment) != expected:
        raise ValueError('DoWhy не идентифицировал эффект с набором корректировок заданного DAG.')
    return adjustment, str(estimand)


def fit_pair(history, profiles, treatment, settings, args):
    pair = history[history['treatment'].isin(['BAU', treatment])].copy()
    pair['assigned'] = pair['treatment'].eq(treatment).astype(int)
    pair['exit_horizon'] = pair['exit_horizon'].astype(int)
    raw_counts = pair['treatment'].value_counts()
    report = {'treatment': treatment, 'n_bau': int(raw_counts.get('BAU', 0)),
              'n_treatment': int(raw_counts.get(treatment, 0))}
    arms = [pair[pair['assigned'].eq(arm)] for arm in (0, 1)]
    if any(inadequate(arm, args) for arm in arms):
        return None, {**report, 'status': 'Мало наблюдений или исходов в одном из рукавов'}
    if settings.randomized:
        probabilities = settings.assignment_probabilities
        model_t = KnownPropensity(probabilities[treatment] / (probabilities[treatment] + probabilities['BAU']))
    else:
        model_t = LogisticRegression(max_iter=1000)
    x, xs = transform(pair, profiles, settings.x, settings.formats)
    w, ws = transform(pair, profiles, settings.w, settings.formats)
    y = pair['exit_horizon'].to_numpy()
    t = pair['assigned'].to_numpy()
    splitter = StratifiedKFold(3, shuffle=True, random_state=SEED)
    folds = list(splitter.split(t, 2 * t + y))
    propensity_oof = cross_val_predict(model_t, joint(x, w), t, cv=folds, method='predict_proba')[:, 1]
    overlap = (propensity_oof >= settings.overlap) & (propensity_oof <= 1 - settings.overlap)
    pair = pair.loc[overlap]
    arms = [pair[pair['assigned'].eq(arm)] for arm in (0, 1)]
    report.update(n_bau_overlap=len(arms[0]), n_treatment_overlap=len(arms[1]),
                  exits_bau_overlap=int(arms[0]['exit_horizon'].sum()),
                  exits_treatment_overlap=int(arms[1]['exit_horizon'].sum()),
                  n_excluded_by_overlap=int((~overlap).sum()))
    if any(inadequate(arm, args) for arm in arms):
        return None, {**report, 'status': 'Мало наблюдений или исходов после проверки перекрытия'}
    adjustment, estimand = identify(pair, settings)
    tx, tw = x[overlap], w[overlap]
    # A constant nuisance column lets the same code handle intercept-only randomized fits.
    model_w = tw if tx.shape[1] or tw.shape[1] else np.zeros((len(tx), 1))
    design = np.column_stack((np.ones(len(tx)), tx))
    if np.linalg.matrix_rank(design) < design.shape[1] or len(tx) < 5 * design.shape[1]:
        return None, {**report, 'status': 'Слишком много или коллинеарные модификаторы X'}
    estimator = LinearDML(model_y=LogisticRegression(max_iter=1000), model_t=model_t,
                          discrete_treatment=True, discrete_outcome=True,
                          cv=list(splitter.split(t[overlap], (2 * t + y)[overlap])), random_state=SEED)
    estimator.fit(y[overlap], t[overlap], X=as_features(tx), W=as_features(model_w), inference='statsmodels')
    low, high = estimator.ate_interval(X=as_features(tx))
    ate = np.asarray(estimator.ate(X=as_features(tx))).item()
    low, high = np.asarray(low).item(), np.asarray(high).item()
    if not np.isfinite([ate, low, high]).all():
        return None, {**report, 'status': 'Не удалось оценить конечные границы эффекта'}
    report.update(status='OK', adjustment=adjustment, estimand=estimand,
                  crude_uplift_pp=100 * float(arms[0]['exit_horizon'].mean() - arms[1]['exit_horizon'].mean()),
                  ate_uplift_pp=-100 * ate, ate_interval_95_pp=[-100 * high, -100 * low])
    propensity = model_t.fit(joint(tx, tw), t[overlap]).predict_proba(joint(xs, ws))[:, 1]
    valid = (support(arms[0], profiles, settings, args.min_company_arm)
             & support(arms[1], profiles, settings, args.min_company_arm)
             & (propensity >= settings.overlap) & (propensity <= 1 - settings.overlap))
    estimates = np.full((len(profiles), 3), np.nan)
    if valid.any():
        if xs.shape[1]:
            score_x = xs[valid]
            effect = estimator.effect(score_x)
            low, high = estimator.effect_interval(score_x)
        else:
            effect = estimator.effect()
            low, high = estimator.effect_interval()
        estimates[valid] = np.column_stack((-effect, -high, -low))
    return (estimates, propensity, valid), report


def risk_segment(p0, p1, low, high, args):
    if high < 0:
        return 'Риск повышается при мере'
    if low > args.min_uplift:
        return 'Есть сигнал снижения риска'
    if max(p0, p1) <= args.low_risk:
        return 'Низкий риск при обоих вариантах'
    if min(p0, p1) >= args.high_risk:
        return 'Высокий риск при обоих вариантах'
    return 'Эффект неопределён'


def result_row(profile, treatment, p0, q, n_executed, n_bau, n_treatment, settings):
    return dict(zip(IMPORT_COLUMNS, [
        f'{profile["key"]}|{treatment}', profile['company'], profile['analysis'], profile['person'],
        profile['decision_date'].date().isoformat(), settings.horizon, treatment, None,
        p0, None, None, q, n_executed, n_bau, n_treatment, f'{settings.data_kind}. ',
    ]))


def apply_economics(row, economics, low, high, args):
    details = {name: None for name in DETAIL_COLUMNS[5:]}
    finish = 'Нет экономики'
    if economics is not None:
        available, exit_loss, other, cost, budget_cost = economics
        for name, value in zip(DETAIL_COLUMNS[5:10], economics):
            details[name] = value
        if not available:
            finish = 'Мера недоступна'
        elif None not in (exit_loss, other, cost, budget_cost):
            uplift = row['Снижение риска']
            details['Порог окупаемости, п. п.'] = 100 * (cost - other) / exit_loss if exit_loss > 0 else None
            finish = 'Недостаточно данных об эффекте'
            if row['Статус'] == 'OK':
                eriv = uplift * exit_loss + other - cost
                pessimistic = (low if exit_loss >= 0 else high) * exit_loss + other - cost
                details['ERIV, руб.'] = eriv
                details['ERIV при неблагоприятной границе, руб.'] = pessimistic
                finish = 'Положительный эффект не подтверждён'
                if low > args.min_uplift:
                    finish = 'Отрицательная или нулевая ценность при неблагоприятной границе'
                    if pessimistic > 0:
                        finish = 'Кандидат'
    details['Решение по бюджету'] = finish
    row.update(details)


def assemble(history, first, profiles, settings, economics, args):
    rows = []
    diagnostics = []
    execution = first.groupby(['company', 'treatment'])['executed'].agg(['mean', 'count'])
    arm_sizes = history.groupby(['company', 'treatment']).size()
    groups = [(None, profiles)] if settings.pooled else profiles.groupby('company', sort=False)
    for company, group in groups:
        cohort = history if company is None else history[history['company'].eq(company)]
        p0s = fit_baseline(cohort, group, settings, args)
        profile_rows = group.to_dict('records')
        for i, profile in enumerate(profile_rows):
            p0 = p0s[i]
            company_bau_count = int(arm_sizes.get((profile['company'], 'BAU'), 0))
            row = result_row(profile, 'BAU', p0, None, None, company_bau_count, None, settings)
            row['Статус'] = 'OK' if np.isfinite(p0) else 'Нет опоры для BAU'
            row['Источник / пояснение'] += 'Логит только на BAU, общий для мер.'
            if np.isfinite(p0):
                row.update({'P при назначении': p0, 'Снижение риска': 0., 'Снижение риска, п. п.': 0.})
            row['Решение по бюджету'] = 'Обычная практика'
            rows.append(row)
        for treatment in settings.treatments:
            result, report = fit_pair(cohort, group, treatment, settings, args)
            diagnostics.append({'company': company, **report})
            for i, profile in enumerate(profile_rows):
                arm = (profile['company'], treatment)
                q = execution.at[arm, 'mean'] if arm in execution.index else None
                n_executed = int(execution.at[arm, 'count']) if arm in execution.index else 0
                p0 = p0s[i]
                row = result_row(profile, treatment, p0, q if n_executed else None, n_executed,
                                 int(arm_sizes.get((profile['company'], 'BAU'), 0)),
                                 int(arm_sizes.get(arm, 0)), settings)
                low = high = None
                status = report['status']
                segment = 'Недостаточно данных'
                if result is not None:
                    estimates, propensity, valid = result
                    if valid[i] and np.isfinite(p0):
                        row['Вероятность назначения в паре'] = propensity[i]
                        uplift, low, high = estimates[i]
                        p1 = p0 - uplift
                        if not np.isfinite([uplift, low, high]).all() or not 0 <= p1 <= 1:
                            status = 'Несогласованные вероятности или интервал'
                        else:
                            segment = risk_segment(p0, p1, low, high, args)
                            row.update({'P при назначении': p1, 'Снижение риска': uplift,
                                        'Снижение риска, п. п.': 100 * uplift,
                                        '95% ДИ ниж., п. п.': 100 * low, '95% ДИ верх., п. п.': 100 * high})
                    else:
                        status = 'Нет перекрытия или отсутствуют признаки профиля'
                row['Статус'] = status
                row['Сегмент для этой меры'] = segment
                source = 'DoWhy + LinearDML, эффект назначения.' if status == 'OK' else status + '.'
                row['Источник / пояснение'] += source
                apply_economics(row, economics.get(row['Ключ результата']), low, high, args)
                rows.append(row)
    return rows, diagnostics


def optimize(rows, budget):
    candidates = [row for row in rows if row['Решение по бюджету'] == 'Кандидат']
    if budget is None:
        for row in candidates:
            row['Решение по бюджету'] = 'Кандидат, бюджет не задан'
        return {'budget_rub': None, 'candidates': len(candidates)}
    if len({row['Дата решения'] for row in rows}) > 1:
        raise ValueError('Для оптимизации одного бюджета используйте один день принятия решений.')
    selected = []
    if candidates:
        candidate_people = [(row['Компания'], row['ID сотрудника']) for row in candidates]
        people = {key: index for index, key in enumerate(dict.fromkeys(candidate_people), 1)}
        costs = [round(row['Лимитируемые затраты, руб.'] * 100) for row in candidates]
        values = [row['ERIV при неблагоприятной границе, руб.'] for row in candidates]
        size = len(candidates)
        matrix = csr_matrix((costs + [1] * size,
                             ([0] * size + [people[key] for key in candidate_people], list(range(size)) * 2)),
                            shape=(len(people) + 1, size))
        limit = round(budget * 100)
        constraints = LinearConstraint(matrix, lb=0, ub=[limit, *([1] * len(people))])
        result = milp(-np.asarray(values), integrality=np.ones(size), bounds=Bounds(0, 1),
                      constraints=constraints, options={'mip_rel_gap': 0.0})
        if not result.success:
            raise RuntimeError(f'Оптимизатор не вернул оптимальное допустимое решение: {result.message}')
        chosen = np.flatnonzero(np.rint(result.x))
        if sum(costs[i] for i in chosen) > limit or len({candidate_people[i] for i in chosen}) != len(chosen):
            raise RuntimeError('Проверка ограничений бюджета не пройдена.')
        selected = [candidates[i] for i in chosen]
        for row in candidates:
            row['Решение по бюджету'] = 'Не выбрана при данном бюджете'
        for row in selected:
            row['Решение по бюджету'] = 'Выбрана'
    return {'budget_rub': budget, 'candidates': len(candidates), 'selected': len(selected),
            'committed_budget_rub': round(sum(row['Лимитируемые затраты, руб.'] for row in selected), 2),
            'expected_avoided_exits': sum(row['Снижение риска'] for row in selected),
            'expected_eriv_rub': round(sum(row['ERIV, руб.'] for row in selected), 2),
            'sum_of_conservative_eriv_scores_rub': round(sum(row['ERIV при неблагоприятной границе, руб.'] for row in selected), 2)}


def money(value):
    amount = number(value)
    if not np.isclose(amount, round(amount, 2), rtol=0, atol=1e-7):
        raise ValueError('денежные суммы указываются с точностью до копейки')
    return round(amount, 2)


def read_economics(path):
    frame = pd.read_csv(path, sep=None, engine='python', dtype=str, keep_default_na=False, encoding='utf-8-sig')
    if not {'result_key', *ECONOMICS} <= set(frame.columns) or frame['result_key'].duplicated().any():
        raise ValueError('Проверьте заголовки экономики и уникальность result_key.')
    economics = {}
    for row in frame.to_dict('records'):
        if row['available'] not in ('0', '1'):
            raise ValueError(f'{row["result_key"]}: available должен быть 0 или 1.')
        amounts = [money(row[name]) if row[name].strip() else None for name in ECONOMICS[1:]]
        if any(value is not None and value < 0 for value in amounts[2:]):
            raise ValueError(f'{row["result_key"]}: расходы должны быть неотрицательными.')
        economics[row['result_key']] = (int(row['available']), *amounts)
    return economics


def main():
    parser = argparse.ArgumentParser(description='Оценка эффекта назначений и бюджет удержания для ERIV')
    parser.add_argument('--workbook', type=Path, required=True, help='исходная книга ERIV (.xlsx)')
    parser.add_argument('--economics', type=Path, help='CSV экономики по ключам строк результата')
    parser.add_argument('--budget', help='лимит расходов в рублях, например 250000')
    parser.add_argument('--out', type=Path, default=Path('results'))
    parser.add_argument('--min-arm', type=int, default=25)
    parser.add_argument('--min-events', type=int, default=5)
    parser.add_argument('--min-company-arm', type=int, default=5)
    parser.add_argument('--min-uplift', type=float, default=0.)
    parser.add_argument('--low-risk', type=float, default=.10)
    parser.add_argument('--high-risk', type=float, default=.50)
    args = parser.parse_args()
    try:
        budget = money(args.budget) if args.budget is not None else None
        if (budget is not None and budget < 0 or args.min_arm < 6 or args.min_events < 3
                or args.min_company_arm < 1 or not 0 <= args.min_uplift < 1
                or not 0 <= args.low_risk < args.high_risk <= 1):
            raise ValueError('Некорректный бюджет, минимальные размеры групп или пороги рисков.')
        settings, data = load_input(args.workbook)
        economics = read_economics(args.economics) if args.economics is not None else {}
        first, eligible, profiles, cohort_report = prepare_cohorts(data, settings)
        valid_keys = {f'{key}|{t}' for key in profiles['key'] for t in settings.treatments}
        if economics.keys() - valid_keys:
            extras = sorted(economics.keys() - valid_keys)
            raise ValueError(f'В экономике есть ключи вне текущих профилей и мер, например {extras[0]}.')
        if len(valid_keys) + len(profiles) > 5000:
            print('Таблица превышает 5000 строк. Для импорта проверьте диапазоны формул вашей книги.')
        rows, contrasts = assemble(eligible, first, profiles, settings, economics, args)
        budget_report = optimize(rows, budget)
        result = pd.DataFrame(rows, columns=IMPORT_COLUMNS + DETAIL_COLUMNS)
        result.sort_values(['Компания', 'Анализ', 'ID сотрудника', 'Дата решения', 'Код меры'], inplace=True)
        diagnostics = {
            'data': settings.data_kind,
            'design': 'Рандомизация' if settings.randomized else 'Наблюдение',
            'cutoff': settings.cutoff.date().isoformat(), 'horizon_months': settings.horizon,
            'effect_modifiers_x': settings.x, 'controls_w': settings.w,
            'overlap_threshold': settings.overlap, 'min_arm': args.min_arm, 'min_events': args.min_events,
            'min_company_arm': args.min_company_arm, 'min_uplift': args.min_uplift,
            'low_risk_threshold': args.low_risk, 'high_risk_threshold': args.high_risk,
            'cohort': cohort_report, 'comparisons_to_BAU': contrasts, 'budget': budget_report,
            'row_statuses': dict(Counter(result['Статус'])),
        }
        args.out.mkdir(parents=True, exist_ok=True)
        result.to_csv(args.out / 'retention_decisions.csv', sep=';', decimal=',', index=False, encoding='utf-8-sig')
        (args.out / 'diagnostics.json').write_text(json.dumps(diagnostics, indent=2, ensure_ascii=False, allow_nan=False) + '\n', encoding='utf-8')
        print(f'Результат: {len(result)} строк, {cohort_report["profiles"]} профилей. {args.out.resolve()}')
    except (KeyError, OSError, TypeError, ValueError, RuntimeError) as exc:
        parser.exit(1, f'Ошибка: {exc}\n')


if __name__ == '__main__':
    main()
