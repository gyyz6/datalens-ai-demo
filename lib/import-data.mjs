import { DL } from './engine.mjs';

const FIELDS = ['date', 'channel', 'sessions', 'orders', 'gmv', 'spend'];
const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_TABLES = 8;
const MAX_COLUMNS = 32;
const MAX_CELL = 512;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
    this.code = 'IMPORT_INVALID';
  }
}

function fail(message) { throw new ImportError(message); }
function key(value) { return value.toLocaleLowerCase('en-US'); }
function checkColumns(columns) {
  if (!columns.length || columns.length > MAX_COLUMNS) fail('每张表须包含 1 至 32 列，请先精简数据字段。');
  if (columns.some(value => typeof value !== 'string' || !value.trim() || value.length > MAX_CELL || /[\u0000-\u001f\u007f]/.test(value))) {
    fail('列名不能为空、超过 512 个字符或包含控制字符。');
  }
  if (new Set(columns.map(key)).size !== columns.length) fail('存在重复列名（忽略大小写），请重命名后上传。');
}

// A bounded, non-executing lexer. Tokens are consumed one at a time rather than
// materialising a potentially large token array. Strings remain plain data.
class Lexer {
  constructor(text) { this.text = text; this.index = 0; this.peeked = null; this.count = 0; }
  error(message, at = this.index) { fail(`SQL 字符位置 ${at + 1}：${message}`); }
  peek() { if (!this.peeked) this.peeked = this.nextToken(); return this.peeked; }
  take() { const token = this.peek(); this.peeked = null; return token; }
  is(value) { const token = this.peek(); return ['word', 'symbol'].includes(token.type) && token.value.toUpperCase() === value; }
  accept(value) { if (!this.is(value)) return false; this.take(); return true; }
  expect(value) { if (!this.accept(value)) this.error(`需要 ${value}，请检查 SQL 导出语法。`, this.peek().at); }
  identifier() {
    const token = this.take();
    if (!['word', 'quoted'].includes(token.type) || !token.value || /[\u0000-\u001f\u007f]/.test(token.value)) this.error('需要有效的表名或列名。', token.at);
    return token.value;
  }
  nextToken() {
    const text = this.text;
    while (this.index < text.length) {
      if (/\s/.test(text[this.index])) { this.index++; continue; }
      if (text.startsWith('--', this.index)) {
        const end = text.indexOf('\n', this.index + 2);
        this.index = end < 0 ? text.length : end + 1; continue;
      }
      if (text.startsWith('/*', this.index)) {
        if (text[this.index + 2] === '!') this.error('不支持 MySQL 可执行版本注释，请导出纯 CREATE TABLE / INSERT VALUES 数据。');
        const end = text.indexOf('*/', this.index + 2);
        if (end < 0) this.error('块注释未闭合。');
        this.index = end + 2; continue;
      }
      break;
    }
    const at = this.index;
    if (at >= text.length) return { type: 'eof', value: '', at };
    if (++this.count > 350000) this.error('SQL 标记数量过多，请缩小文件后重试。');
    const char = text[this.index++];
    if (char === "'" || char === '`' || char === '"') {
      let value = '', closed = false;
      while (this.index < text.length) {
        const current = text[this.index++];
        if (current === char) {
          if (text[this.index] === char) { value += char; this.index++; }
          else { closed = true; break; }
        } else if (current === '\\' && char === "'") {
          if (this.index === text.length) this.error('字符串转义未完成。', at);
          const escaped = text[this.index++];
          const escapes = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a', "'": "'", '"': '"', '\\': '\\' };
          if (!Object.hasOwn(escapes, escaped)) this.error('不支持该反斜杠转义，请使用标准 SQL 双单引号或已转义文本。', at);
          value += escapes[escaped];
        } else value += current;
        if (value.length > MAX_CELL) this.error('单个字段最多支持 512 个字符。', at);
      }
      if (!closed) this.error('引号未闭合。', at);
      return { type: char === "'" ? 'string' : 'quoted', value, at };
    }
    const rest = text.slice(at);
    const number = rest.match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) {
      if (number[0].length > MAX_CELL) this.error('数字字段过长。', at);
      this.index = at + number[0].length;
      return { type: 'number', value: number[0], at };
    }
    if (/[\p{L}_$]/u.test(char)) {
      while (this.index < text.length && /[\p{L}\p{N}_$]/u.test(text[this.index])) this.index++;
      const value = text.slice(at, this.index);
      if (value.length > MAX_CELL) this.error('标识符过长。', at);
      return { type: 'word', value, at };
    }
    if ('(),;.=+-*/<>!%'.includes(char)) return { type: 'symbol', value: char, at };
    this.error(`不支持字符 ${JSON.stringify(char)}，仅支持 CREATE TABLE 和 INSERT INTO ... VALUES。`, at);
  }
}

function parseSQL(content) {
  const lexer = new Lexer(content);
  const tables = new Map();
  const declared = new Set();
  let rowCount = 0;
  const tableName = () => {
    const parts = [lexer.identifier()];
    if (lexer.accept('.')) parts.push(lexer.identifier());
    return parts.join('.');
  };
  const addTable = (name, columns) => {
    checkColumns(columns);
    if (tables.size >= MAX_TABLES) fail('最多支持 8 张表，请选择需要的数据表重新导出。');
    const table = { name, columns, rows: [] };
    tables.set(key(name), table);
    return table;
  };
  const finish = () => {
    if (lexer.accept(';')) return;
    if (lexer.peek().type !== 'eof') lexer.error('语句末尾需要分号；不支持查询表达式或其他附加语句。', lexer.peek().at);
  };
  const tableOptions = () => {
    // Export metadata only: recognise a narrow allowlist without applying any
    // engine, encoding, collation or sequence configuration to the data.
    const seen = new Set();
    while (lexer.peek().type !== 'eof' && !lexer.is(';')) {
      let option;
      if (lexer.accept('ENGINE')) option = 'ENGINE';
      else if (lexer.accept('AUTO_INCREMENT')) option = 'AUTO_INCREMENT';
      else if (lexer.accept('COLLATE')) option = 'COLLATE';
      else {
        const hasDefault = lexer.accept('DEFAULT');
        if (lexer.accept('CHARSET')) option = 'CHARSET';
        else if (lexer.accept('CHARACTER')) { lexer.expect('SET'); option = 'CHARSET'; }
        else if (hasDefault) lexer.error('DEFAULT 后仅支持 CHARSET 或 CHARACTER SET 表选项。', lexer.peek().at);
        else lexer.error('仅支持 ENGINE、DEFAULT CHARSET / CHARACTER SET、COLLATE 和 AUTO_INCREMENT 表选项；请移除其他尾部语法并检查分号。', lexer.peek().at);
      }
      if (seen.has(option)) lexer.error(`表选项 ${option} 重复，请保留一项。`, lexer.peek().at);
      seen.add(option);
      lexer.accept('=');
      const token = lexer.take();
      if (option === 'AUTO_INCREMENT') {
        if (token.type !== 'number' || !/^\d{1,20}$/.test(token.value)) lexer.error('AUTO_INCREMENT 表选项必须为不超过 20 位的非负整数字面量。', token.at);
      } else if (!['word', 'quoted', 'string'].includes(token.type) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(token.value)) {
        lexer.error(`${option} 表选项必须是由字母、数字和下划线组成的名称，不支持表达式。`, token.at);
      }
    }
  };
  while (lexer.peek().type !== 'eof') {
    if (lexer.accept(';')) continue;
    if (lexer.accept('CREATE')) {
      lexer.expect('TABLE');
      if (lexer.accept('IF')) { lexer.expect('NOT'); lexer.expect('EXISTS'); }
      const name = tableName();
      const tableKey = key(name);
      if (tables.has(tableKey) || declared.has(tableKey)) fail(`表 ${name} 重复定义；请只保留一份 CREATE TABLE。`);
      declared.add(tableKey);
      lexer.expect('(');
      const columns = [];
      let itemCount = 0;
      do {
        if (++itemCount > 128) fail('单表定义项过多，请简化字段和约束。');
        const first = lexer.peek();
        const constraint = first.type === 'word' && ['PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'CONSTRAINT', 'FOREIGN', 'CHECK'].includes(first.value.toUpperCase());
        if (!constraint) {
          columns.push(lexer.identifier());
          if (columns.length > MAX_COLUMNS) fail('每张表最多支持 32 列，请精简数据字段。');
          if (!['word', 'quoted'].includes(lexer.peek().type)) lexer.error('CREATE TABLE 的列定义需要数据类型。', lexer.peek().at);
        }
        let depth = 0, metadataTokens = 0;
        while (true) {
          const token = lexer.peek();
          if (token.type === 'eof' || lexer.is(';')) lexer.error('CREATE TABLE 定义未闭合。', token.at);
          if (depth === 0 && (lexer.is(',') || lexer.is(')'))) break;
          lexer.take(); metadataTokens++;
          if (token.value === '(' && token.type === 'symbol') {
            depth++; if (depth > 16) lexer.error('列定义嵌套过深。', token.at);
          } else if (token.value === ')' && token.type === 'symbol') depth--;
        }
        if (!metadataTokens) lexer.error('CREATE TABLE 中的字段或约束定义为空。');
      } while (lexer.accept(','));
      lexer.expect(')');
      tableOptions();
      finish();
      addTable(name, columns);
    } else if (lexer.accept('INSERT')) {
      lexer.expect('INTO');
      const name = tableName();
      let insertColumns = null;
      if (lexer.accept('(')) {
        insertColumns = [];
        do {
          insertColumns.push(lexer.identifier());
          if (insertColumns.length > MAX_COLUMNS) fail('INSERT 最多支持 32 列。');
        } while (lexer.accept(','));
        lexer.expect(')'); checkColumns(insertColumns);
      }
      let table = tables.get(key(name));
      if (!table) {
        if (!insertColumns) fail(`表 ${name} 尚无列定义；请提供 CREATE TABLE 或 INSERT 的明确列名。`);
        table = addTable(name, insertColumns.slice());
      }
      const columns = insertColumns || table.columns;
      const indexes = columns.map(column => table.columns.findIndex(candidate => key(candidate) === key(column)));
      if (indexes.some(index => index < 0)) fail(`表 ${name} 的 INSERT 含未知列名，请与 CREATE TABLE 的字段保持一致。`);
      lexer.expect('VALUES');
      do {
        lexer.expect('(');
        const values = [];
        do {
          const token = lexer.take();
          if (token.type === 'string') values.push(token.value);
          else if (token.type === 'word' && token.value.toUpperCase() === 'NULL') values.push(null);
          else if (token.type === 'number') {
            const value = Number(token.value);
            if (!Number.isFinite(value)) lexer.error('数字超出有限数值范围。', token.at);
            // Large identifier-like integers stay text to avoid precision loss.
            values.push(Number.isInteger(value) && !Number.isSafeInteger(value) ? token.value : value);
          } else lexer.error('INSERT 仅接受数字、单引号文本和 NULL；不支持函数、查询或计算表达式。', token.at);
          if (values.length > MAX_COLUMNS) fail('单行数据最多支持 32 列。');
        } while (lexer.accept(','));
        lexer.expect(')');
        if (values.length !== columns.length) fail(`表 ${name} 的 INSERT 列数与值数量不一致。`);
        if (++rowCount > MAX_ROWS) fail('文件总计最多支持 5000 条数据行，请按日期缩小范围。');
        const row = Array(table.columns.length).fill(null);
        indexes.forEach((index, offset) => { row[index] = values[offset]; });
        table.rows.push(row);
      } while (lexer.accept(','));
      finish();
    } else {
      lexer.error('只支持 CREATE TABLE 和 INSERT INTO ... VALUES；请移除 SELECT、COPY、DROP、UPDATE、SET 等其他语句后重试。', lexer.peek().at);
    }
  }
  if (!tables.size || !rowCount) fail('SQL 文件没有可导入的数据行，请保留 CREATE TABLE / INSERT VALUES 数据。');
  return [...tables.values()];
}

function parseCSV(content, filename) {
  const records = [];
  let row = [], value = '', quoted = false, closed = false;
  function field() {
    if (value.length > MAX_CELL) fail('CSV 单个字段最多支持 512 个字符。');
    row.push(value); value = ''; closed = false;
    if (row.length > MAX_COLUMNS) fail('CSV 最多支持 32 列，请精简数据字段。');
  }
  function record() {
    field();
    if (!(row.length === 1 && row[0].trim() === '')) records.push(row);
    row = [];
    if (records.length > MAX_ROWS + 1) fail('CSV 最多支持 5000 条数据行，请按日期缩小范围。');
  }
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (quoted) {
      if (char === '"') {
        if (content[index + 1] === '"') { value += '"'; index++; }
        else { quoted = false; closed = true; }
      } else value += char;
    } else if (closed && ![',', '\r', '\n'].includes(char)) fail('CSV 闭合引号后只能是逗号或换行。');
    else if (char === '"') {
      if (value !== '') fail('CSV 字段内的双引号必须使用成对双引号转义。');
      quoted = true;
    } else if (char === ',') field();
    else if (char === '\r' || char === '\n') {
      record(); if (char === '\r' && content[index + 1] === '\n') index++;
    } else value += char;
    if (value.length > MAX_CELL) fail('CSV 单个字段最多支持 512 个字符。');
  }
  if (quoted) fail('CSV 引号未闭合，请检查导出文件。');
  if (value !== '' || row.length || closed) record();
  if (records.length < 2) fail('CSV 需要表头和至少一条数据行。');
  const columns = records[0].map(value => value.trim());
  checkColumns(columns);
  const rows = records.slice(1);
  if (rows.some(row => row.length !== columns.length)) fail('CSV 某行的列数与表头不一致，请检查逗号与引号。');
  const name = typeof filename === 'string' ? filename.split(/[\\/]/).pop().replace(/\.csv$/i, '').slice(0, 100) : 'uploaded_data';
  return [{ name: name || 'uploaded_data', columns, rows }];
}

export function parseImport({ format, filename, content } = {}) {
  if (!['sql', 'csv'].includes(format)) fail('仅支持 .sql 或 .csv 文件。');
  if (typeof content !== 'string' || !content.trim()) fail('上传文件为空或不是文本文件。');
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) fail('文件最大支持 1 MB，请缩小导出范围后重试。');
  const text = content.replace(/^\uFEFF/, '');
  const tables = format === 'sql' ? parseSQL(text) : parseCSV(text, filename);
  return { format, tables };
}

const ALIASES = {
  date: ['date', '日期', '统计日期', '业务日期', 'day', 'stat_date'],
  channel: ['channel', '渠道', '渠道名称', '来源渠道', 'channel_name'],
  sessions: ['sessions', '访客数', '访问量', '访问次数', '访问数', '流量', 'visits'],
  orders: ['orders', '订单数', '支付订单数', '成交订单数', 'order_count'],
  gmv: ['gmv', '成交金额', '支付金额', '销售额', '交易额', 'revenue'],
  spend: ['spend', '投放费用', '广告花费', '广告费', '花费', '投放金额', 'ad_spend']
};

export function suggestMapping(columns) {
  if (!Array.isArray(columns)) return Object.fromEntries(FIELDS.map(field => [field, '']));
  const used = new Set();
  return Object.fromEntries(FIELDS.map(field => {
    const candidates = columns.filter(column => typeof column === 'string' && !used.has(column) && ALIASES[field].includes(key(column.trim())));
    const exact = candidates.find(column => key(column.trim()) === field);
    const selected = exact || (candidates.length === 1 ? candidates[0] : '');
    if (selected) used.add(selected);
    return [field, selected];
  }));
}

export function normalizeTable(table, mapping) {
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) fail('数据表格式无效，请重新上传。');
  checkColumns(table.columns);
  if (!table.rows.length || table.rows.length > MAX_ROWS) fail('所选数据表须包含 1 至 5000 条数据行。');
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).length !== FIELDS.length || FIELDS.some(field => !Object.hasOwn(mapping, field))) {
    fail('请恰好映射 date、channel、sessions、orders、gmv、spend 六个字段。');
  }
  const selected = FIELDS.map(field => mapping[field]);
  if (selected.some(column => typeof column !== 'string' || !table.columns.includes(column))) fail('每个指标必须选择数据表中存在的字段。');
  if (new Set(selected).size !== FIELDS.length) fail('六个指标必须分别映射到不同字段，不得重复使用同一列。');
  const indexes = Object.fromEntries(FIELDS.map(field => [field, table.columns.indexOf(mapping[field])]));
  const mappedRows = table.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== table.columns.length) fail(`第 ${rowIndex + 1} 条数据的字段数量与表头不一致。`);
    const result = {};
    for (const field of FIELDS) {
      const value = row[indexes[field]];
      if (!['string', 'number'].includes(typeof value) || String(value).length > MAX_CELL || String(value).trim() === '') fail(`第 ${rowIndex + 1} 条数据的 ${field} 缺失、为空或格式不合法。`);
      if (field === 'date' || field === 'channel') result[field] = String(value).trim();
      else {
        const text = String(value).trim();
        if (!NUMBER.test(text) || !Number.isFinite(Number(text))) fail(`第 ${rowIndex + 1} 条数据的 ${field} 必须是明确的数字，不能包含货币符号或千位分隔符。`);
        result[field] = Number(text);
      }
    }
    if (key(result.channel) === 'all') fail(`第 ${rowIndex + 1} 条数据的渠道名 all 为系统保留值，请更改名称。`);
    // Preserve controls so the engine rejects them rather than sanitising data.
    if (typeof row[indexes.channel] === 'string' && /[\u0000-\u001f\u007f-\u009f]/.test(row[indexes.channel])) fail(`第 ${rowIndex + 1} 条数据的 channel 不能包含换行或控制字符。`);
    return result;
  });
  const checked = DL.validateCSV(DL.toCSV(mappedRows));
  if (checked.errors.length) fail(checked.errors.slice(0, 6).join('\n'));
  const unsupportedDate = checked.rows.findIndex(row => Number(row.date.slice(0, 4)) < 1900 || Number(row.date.slice(0, 4)) > 9999);
  if (unsupportedDate >= 0) fail(`第 ${unsupportedDate + 1} 条数据的 date 年份须在 1900 至 9999 之间，请检查日期后重新上传。`);
  return checked.rows;
}
