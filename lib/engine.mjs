'use strict';

  // Shared deterministic arithmetic for validated sample and uploaded business rows.
  const DAY = 86400000;
  const FIELDS = ['date', 'channel', 'sessions', 'orders', 'gmv', 'spend'];
  const METRICS = ['sessions', 'orders', 'gmv', 'spend', 'cvr', 'aov', 'roas'];
  const CHANNELS = ['抖音投放', '搜索广告', '私域运营', '自然流量'];
  const MAX_VALUE = 1e12;
  const MAX_CHANNELS = 100;
  const CHANNEL_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/;

  function dayValue(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const valueMs = Date.parse(value + 'T00:00:00.000Z');
    if (!Number.isFinite(valueMs)) return null;
    return new Date(valueMs).toISOString().slice(0, 10) === value ? valueMs : null;
  }

  function dayString(valueMs) {
    return new Date(valueMs).toISOString().slice(0, 10);
  }

  function safeRatio(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : null;
  }

  function totals(rows) {
    const result = { sessions: 0, orders: 0, gmv: 0, spend: 0 };
    let paidGmv = 0;
    rows.forEach(function (row) {
      result.sessions += row.sessions;
      result.orders += row.orders;
      result.gmv += row.gmv;
      result.spend += row.spend;
      // Organic revenue is not attributed to ad spend.
      if (row.spend > 0) paidGmv += row.gmv;
    });
    result.cvr = safeRatio(result.orders, result.sessions);
    result.aov = safeRatio(result.gmv, result.orders);
    result.roas = safeRatio(paidGmv, result.spend);
    return result;
  }

  function changes(current, previous) {
    const result = {};
    METRICS.forEach(function (key) {
      result[key] = current[key] == null || previous[key] == null || previous[key] === 0
        ? null : (current[key] - previous[key]) / previous[key];
    });
    return result;
  }

  function sample() {
    const rows = [];
    const start = dayValue('2026-08-22');
    // A fixed weekly rhythm and gentle trend make every export reproducible.
    const weekly = [1.03, 0.96, 0.98, 1.00, 1.02, 1.07, 1.12];
    const bases = [5200, 2800, 1250, 2100];
    const conversions = [0.036, 0.048, 0.071, 0.029];
    const aovs = [199, 219, 229, 189];
    for (let i = 0; i < 60; i += 1) {
      const dateMs = start + i * DAY;
      const date = dayString(dateMs);
      const weekday = new Date(dateMs).getUTCDay();
      CHANNELS.forEach(function (channel, channelIndex) {
        const trend = 1 + i * (channelIndex === 0 ? 0.0006 : 0.0011);
        const anomalous = channelIndex === 0 && i >= 56;
        const trafficFactor = anomalous ? 1.40 : 1;
        const sessions = Math.round(bases[channelIndex] * weekly[weekday] * trend * trafficFactor);
        const conversion = anomalous ? 0.013 : conversions[channelIndex];
        const orders = Math.round(sessions * conversion);
        const gmv = orders * aovs[channelIndex];
        const spend = channelIndex < 2
          ? Math.round((channelIndex === 0 ? 10000 : 6200) * weekly[weekday] * trend * (anomalous ? 1.18 : 1))
          : 0;
        rows.push({ date: date, channel: channel, sessions: sessions, orders: orders, gmv: gmv, spend: spend });
      });
    }
    return rows;
  }

  function parseCSV(text) {
    const records = [];
    let fields = [];
    let field = '';
    let quoted = false;
    let closedQuote = false;
    let line = 1;
    let recordLine = 1;
    function saveRecord() {
      fields.push(field);
      if (!(fields.length === 1 && fields[0].trim() === '')) {
        records.push({ fields: fields, line: recordLine });
      }
      fields = [];
      field = '';
      closedQuote = false;
    }
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 1; }
          else { quoted = false; closedQuote = true; }
        } else {
          field += char;
          if (char === '\n') line += 1;
        }
        continue;
      }
      if (closedQuote && char !== ',' && char !== '\r' && char !== '\n') {
        return { error: '第 ' + line + ' 行：闭合引号后只能是逗号或换行。' };
      }
      if (char === '"') {
        if (field !== '') return { error: '第 ' + line + ' 行：字段内部的引号必须成对转义。' };
        quoted = true;
      } else if (char === ',') {
        fields.push(field); field = ''; closedQuote = false;
      } else if (char === '\r' || char === '\n') {
        saveRecord();
        if (char === '\r' && text[i + 1] === '\n') i += 1;
        line += 1;
        recordLine = line;
      } else {
        field += char;
      }
      if (records.length > 5001) return { error: 'CSV 最多支持 5000 条数据行，请先缩小数据范围。' };
    }
    if (quoted) return { error: '第 ' + recordLine + ' 行：引号未闭合。' };
    if (field !== '' || fields.length > 0 || closedQuote) saveRecord();
    return { records: records };
  }

  function validateCSV(input) {
    if (typeof input !== 'string') return { rows: null, errors: ['CSV 内容必须是文本。'] };
    const text = input.replace(/^\uFEFF/, '');
    const parsed = parseCSV(text);
    if (parsed.error) return { rows: null, errors: [parsed.error] };
    const records = parsed.records;
    if (records.length === 0) return { rows: null, errors: ['CSV 为空，请保留表头和至少一条数据。'] };
    const header = records[0].fields.map(function (value) { return value.trim(); });
    if (header.length !== FIELDS.length || new Set(header).size !== FIELDS.length ||
        FIELDS.some(function (key) { return header.indexOf(key) < 0; })) {
      return { rows: null, errors: ['表头必须恰好包含 6 个字段：' + FIELDS.join(',') + '。字段顺序可调整。'] };
    }
    if (records.length === 1) return { rows: null, errors: ['CSV 只有表头，请添加至少一条数据。'] };
    if (records.length - 1 > 5000) return { rows: null, errors: ['CSV 最多支持 5000 条数据行，请先缩小数据范围。'] };
    const errors = [];
    const rows = [];
    const keys = new Set();
    const channels = new Set();
    const indexes = {};
    FIELDS.forEach(function (key) { indexes[key] = header.indexOf(key); });
    const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
    records.slice(1).forEach(function (record) {
      const prefix = '第 ' + record.line + ' 行：';
      if (record.fields.length !== FIELDS.length) {
        errors.push(prefix + '需要 6 列，实际为 ' + record.fields.length + ' 列。');
        return;
      }
      const values = {};
      FIELDS.forEach(function (key) { values[key] = record.fields[indexes[key]].trim(); });
      const row = { date: values.date, channel: values.channel };
      let valid = true;
      if (dayValue(row.date) === null) {
        errors.push(prefix + 'date 必须是有效的 YYYY-MM-DD 日期。'); valid = false;
      }
      if (!row.channel || row.channel.length > 60 || CHANNEL_CONTROLS.test(record.fields[indexes.channel])) {
        errors.push(prefix + 'channel 必须为 1 至 60 个字符，且不能包含换行、制表符等控制字符。'); valid = false;
      } else {
        channels.add(row.channel);
      }
      ['sessions', 'orders', 'gmv', 'spend'].forEach(function (key) {
        row[key] = Number(values[key]);
        if (!decimal.test(values[key]) || !Number.isFinite(row[key]) || row[key] < 0 || row[key] > MAX_VALUE) {
          errors.push(prefix + key + ' 必须是 0 至 1,000,000,000,000 范围内的有限数字。'); valid = false;
        } else if ((key === 'sessions' || key === 'orders') && !Number.isSafeInteger(row[key])) {
          errors.push(prefix + key + ' 必须是安全范围内的非负整数。'); valid = false;
        }
      });
      if (Number.isFinite(row.orders) && Number.isFinite(row.sessions) && row.orders > row.sessions) {
        errors.push(prefix + 'orders 不得大于 sessions。'); valid = false;
      }
      if (row.orders === 0 && row.gmv > 0) {
        errors.push(prefix + 'orders 为 0 时，支付金额 gmv 必须为 0。'); valid = false;
      }
      const key = JSON.stringify([row.date, row.channel]);
      if (keys.has(key)) {
        errors.push(prefix + 'date 与 channel 组合重复（' + row.date + ' / ' + row.channel + '）。'); valid = false;
      }
      keys.add(key);
      if (valid) rows.push(row);
    });
    if (channels.size > MAX_CHANNELS) errors.push('CSV 最多支持 100 个渠道，当前包含 ' + channels.size + ' 个渠道。');
    if (errors.length > 50) {
      return { rows: null, errors: errors.slice(0, 50).concat(['另有 ' + (errors.length - 50) + ' 处错误，请修正后重试。']) };
    }
    return errors.length ? { rows: null, errors: errors } : { rows: rows, errors: [] };
  }

  function toCSV(rows) {
    function escape(value) {
      const text = String(value == null ? '' : value);
      return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    return '\uFEFF' + FIELDS.join(',') + '\r\n' + rows.map(function (row) {
      return FIELDS.map(function (key) { return escape(row[key]); }).join(',');
    }).join('\r\n');
  }

  function analyze(inputRows, options) {
    options = options || {};
    const days = [7, 14, 30].indexOf(Number(options.days)) >= 0 ? Number(options.days) : 7;
    const channel = options.channel == null ? 'all' : options.channel;
    const source = Array.isArray(inputRows) ? inputRows : [];
    const validRows = source.filter(function (row) {
      return row && dayValue(row.date) !== null && typeof row.channel === 'string' && row.channel.length > 0 &&
        row.channel.length <= 60 && !CHANNEL_CONTROLS.test(row.channel) &&
        ['sessions', 'orders', 'gmv', 'spend'].every(function (key) { return Number.isFinite(row[key]) && row[key] >= 0 && row[key] <= MAX_VALUE; }) &&
        Number.isSafeInteger(row.sessions) && Number.isSafeInteger(row.orders) && row.orders <= row.sessions &&
        !(row.orders === 0 && row.gmv > 0);
    });
    const names = channel === 'all'
      ? Array.from(new Set(validRows.map(function (row) { return row.channel; }))) : [channel];
    const selected = validRows.filter(function (row) { return channel === 'all' || row.channel === channel; });
    const empty = totals([]);
    if (validRows.length === 0) {
      return {
        current: empty, previous: totals([]), delta: changes(empty, empty), series: [], channels: [],
        range: { start: null, end: null }, previousRange: { start: null, end: null },
        quality: { rowCount: 0, expectedRows: 2 * days * Math.max(1, names.length), missingDays: [], comparisonComplete: false,
          totalRows: source.length, invalidRows: source.length, missingCells: [], duplicateRows: 0 }
      };
    }
    const endMs = Math.max.apply(null, validRows.map(function (row) { return dayValue(row.date); }));
    const startMs = endMs - (days - 1) * DAY;
    const previousStartMs = startMs - days * DAY;
    const previousEndMs = startMs - DAY;
    const range = { start: dayString(startMs), end: dayString(endMs) };
    const previousRange = { start: dayString(previousStartMs), end: dayString(previousEndMs) };
    const currentRows = selected.filter(function (row) { return row.date >= range.start && row.date <= range.end; });
    const previousRows = selected.filter(function (row) { return row.date >= previousRange.start && row.date <= previousRange.end; });
    const combined = previousRows.concat(currentRows);
    const current = totals(currentRows);
    const previous = totals(previousRows);
    const bucket = new Map();
    const seen = new Set();
    let duplicateRows = 0;
    combined.forEach(function (row) {
      if (!bucket.has(row.date)) bucket.set(row.date, []);
      bucket.get(row.date).push(row);
      const key = JSON.stringify([row.date, row.channel]);
      if (seen.has(key)) duplicateRows += 1;
      seen.add(key);
    });
    const missingDays = [];
    const missingCells = [];
    for (let time = previousStartMs; time <= endMs; time += DAY) {
      const date = dayString(time);
      let missing = false;
      names.forEach(function (name) {
        if (!seen.has(JSON.stringify([date, name]))) {
          missing = true; missingCells.push({ date: date, channel: name });
        }
      });
      if (missing) missingDays.push(date);
    }
    const series = [];
    for (let offset = 0; offset < days; offset += 1) {
      const date = dayString(startMs + offset * DAY);
      const previousDate = dayString(previousStartMs + offset * DAY);
      const dailyRows = bucket.get(date) || [];
      const priorRows = bucket.get(previousDate) || [];
      const daily = totals(dailyRows);
      series.push({ date: date, gmv: daily.gmv, orders: daily.orders, sessions: daily.sessions,
        previousGmv: totals(priorRows).gmv, previousDate: previousDate,
        complete: names.every(function (name) { return seen.has(JSON.stringify([date, name])); }),
        previousComplete: names.every(function (name) { return seen.has(JSON.stringify([previousDate, name])); })
      });
    }
    const totalGmvChange = current.gmv - previous.gmv;
    const channels = names.map(function (name) {
      const channelCurrent = totals(currentRows.filter(function (row) { return row.channel === name; }));
      const channelPrevious = totals(previousRows.filter(function (row) { return row.channel === name; }));
      return { channel: name, current: channelCurrent, previous: channelPrevious,
        delta: changes(channelCurrent, channelPrevious),
        // Signed share: offsets may be negative and a driver can exceed 100%.
        contribution: totalGmvChange === 0 ? null : (channelCurrent.gmv - channelPrevious.gmv) / totalGmvChange };
    });
    return {
      current: current, previous: previous, delta: changes(current, previous), series: series, channels: channels,
      range: range, previousRange: previousRange,
      quality: { rowCount: combined.length, expectedRows: 2 * days * names.length, missingDays: missingDays,
        comparisonComplete: missingCells.length === 0 && duplicateRows === 0 && validRows.length === source.length && names.length > 0,
        totalRows: source.length, invalidRows: source.length - validRows.length, missingCells: missingCells, duplicateRows: duplicateRows }
    };
  }

export const DL = Object.freeze({ sample: sample, validateCSV: validateCSV, toCSV: toCSV, analyze: analyze });

