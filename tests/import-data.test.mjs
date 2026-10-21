import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportError, parseImport, normalizeTable, suggestMapping } from '../lib/import-data.mjs';

const columns = ['date', 'channel', 'sessions', 'orders', 'gmv', 'spend'];
const mapping = Object.fromEntries(columns.map(column => [column, column]));
const sql = content => parseImport({ format: 'sql', filename: 'data.sql', content });
const csv = content => parseImport({ format: 'csv', filename: '经营.csv', content });
const row = ['2026-10-20', '搜索广告', 100, 10, 200, 50];
const table = rows => ({ name: 'sales', columns: columns.slice(), rows });
const invalid = (fn, fragment) => assert.throws(fn, error => error instanceof ImportError && error.code === 'IMPORT_INVALID' && (!fragment || error.message.includes(fragment)));

test('CREATE TABLE metadata and INSERT without a column list', () => {
  const result = sql(`CREATE TABLE IF NOT EXISTS analytics.sales (
    date DATE NOT NULL, channel VARCHAR(60), sessions BIGINT,
    orders INTEGER, gmv DECIMAL(18,2) DEFAULT 0, spend DECIMAL(18,2),
    PRIMARY KEY (date, channel), CONSTRAINT nonnegative CHECK (spend >= 0)
  ); INSERT INTO analytics.sales VALUES ('2026-10-20','搜索广告',100,10,200.0,5e1);`);
  assert.equal(result.format, 'sql');
  assert.equal(result.tables[0].name, 'analytics.sales');
  assert.deepEqual(normalizeTable(result.tables[0], mapping), [{ date: row[0], channel: row[1], sessions: 100, orders: 10, gmv: 200, spend: 50 }]);
});

test('quoted identifiers, escaped quotes, semicolons and comment text remain values', () => {
  const result = sql(`-- header\nCREATE TABLE \`t\` ("date" DATE, \`channel\` TEXT, sessions INT, orders INT, gmv FLOAT, spend FLOAT);
  /* plain comment */ INSERT INTO \`t\` VALUES ('2026-10-20','O''Reilly; -- /* safe */',100,10,200,50);`);
  assert.equal(result.tables[0].rows[0][1], "O'Reilly; -- /* safe */");
});

test('MySQL quoted and backslash escapes are decoded as text', () => {
  const result = sql(String.raw`INSERT INTO t (label, path) VALUES ('it\'s okay', 'C:\\data');`);
  assert.deepEqual(result.tables[0].rows[0], ["it's okay", 'C:\\data']);
});

test('several tables and multiple reordered INSERT column lists', () => {
  const result = sql(`INSERT INTO first (a,b,c) VALUES (1,'one',NULL),(2,'two',-1.5e2);
    INSERT INTO second (x) VALUES ('second'); INSERT INTO first (c,a,b) VALUES (5,3,'three');`);
  assert.equal(result.tables.length, 2);
  assert.deepEqual(result.tables[0].rows, [[1, 'one', null], [2, 'two', -150], [3, 'three', 5]]);
});

test('subset columns align with nulls, and required nulls cannot be normalized', () => {
  const result = sql(`CREATE TABLE t (date TEXT,channel TEXT,sessions INT,orders INT,gmv FLOAT,spend FLOAT);
  INSERT INTO t(date,channel,sessions,orders,gmv) VALUES('2026-10-20','a',100,10,200);`);
  assert.equal(result.tables[0].rows[0][5], null);
  invalid(() => normalizeTable(result.tables[0], mapping), 'spend');
});

test('SQL-injection-like text is inert and never executed', () => {
  const payload = "x'); DROP TABLE users; SELECT pg_sleep(100); --";
  const result = sql(`INSERT INTO t (payload) VALUES ('${payload.replaceAll("'", "''")}');`);
  assert.equal(result.tables[0].rows[0][0], payload);
});

test('unsafe integer identifiers keep their exact textual representation', () => {
  assert.equal(sql('INSERT INTO t(id) VALUES(9007199254740993)').tables[0].rows[0][0], '9007199254740993');
});

test('CSV permits custom headers, UTF-8 BOM, escaped quotes and embedded newline', () => {
  const result = csv('\uFEFF日期,渠道,访问量,订单数,支付金额,广告花费,备注\r\n2026-10-20,"搜索,广告",100,10,200,50,"第一行\n第二行"');
  assert.equal(result.tables[0].name, '经营');
  assert.equal(result.tables[0].rows[0][6], '第一行\n第二行');
  const recommended = suggestMapping(result.tables[0].columns);
  assert.deepEqual(normalizeTable(result.tables[0], recommended), [{ date: '2026-10-20', channel: '搜索,广告', sessions: 100, orders: 10, gmv: 200, spend: 50 }]);
});

test('suggestions are case insensitive, exact canonical fields win and ambiguous aliases stay blank', () => {
  assert.deepEqual(suggestMapping(['DATE', 'CHANNEL', 'SESSIONS', 'ORDERS', 'GMV', 'SPEND']), { date: 'DATE', channel: 'CHANNEL', sessions: 'SESSIONS', orders: 'ORDERS', gmv: 'GMV', spend: 'SPEND' });
  assert.equal(suggestMapping(['日期', '统计日期']).date, '');
  assert.equal(suggestMapping(['date', '统计日期']).date, 'date');
  assert.equal(suggestMapping(null).date, '');
});

test('mapping supports arbitrary source-column names and order', () => {
  const source = { name: 'custom', columns: ['amount', 'visits', 'day', 'ad', 'paid', 'source'], rows: [[200, 100, '2026-10-20', 50, 10, 'a']] };
  const map = { date: 'day', channel: 'source', sessions: 'visits', orders: 'paid', gmv: 'amount', spend: 'ad' };
  assert.equal(normalizeTable(source, map)[0].gmv, 200);
});

test('mapping must contain exactly six known, unique source columns', () => {
  invalid(() => normalizeTable(table([row]), { ...mapping, spend: 'gmv' }), '不同字段');
  invalid(() => normalizeTable(table([row]), { ...mapping, spend: 'missing' }), '存在');
  invalid(() => normalizeTable(table([row]), { ...mapping, extra: 'date' }), '六个');
  invalid(() => normalizeTable(table([row]), { date: 'date' }), '六个');
});

test('normalization rejects missing values, booleans, nonnumeric cells and nonfinite numbers', () => {
  for (const value of [null, undefined, '', ' ', true, '￥200', '1,000', '0x10', Infinity, NaN]) {
    const modified = row.slice(); modified[4] = value;
    invalid(() => normalizeTable(table([modified]), mapping));
  }
});

test('normalization validates dates, counts, amounts and metric constraints', () => {
  for (const [index, value] of [[0, '2026-02-30'], [0, '2026/10/20'], [2, 1.5], [2, -1], [3, 101], [4, -10], [5, 1e13]]) {
    const modified = row.slice(); modified[index] = value;
    invalid(() => normalizeTable(table([modified]), mapping));
  }
  invalid(() => normalizeTable(table([['2026-10-20', 'a', 100, 0, 10, 0]]), mapping), 'orders 为 0');
});

test('uploaded date years are limited to 1900–9999 inclusive', () => {
  for (const date of ['0000-01-01', '0001-01-01', '1899-12-31']) {
    const modified = row.slice(); modified[0] = date;
    invalid(() => normalizeTable(table([modified]), mapping), '1900 至 9999');
  }
  for (const date of ['1900-01-01', '9999-12-31']) {
    const modified = row.slice(); modified[0] = date;
    assert.equal(normalizeTable(table([modified]), mapping)[0].date, date);
  }
  const beyond = row.slice(); beyond[0] = '10000-01-01';
  invalid(() => normalizeTable(table([beyond]), mapping), '有效的 YYYY-MM-DD');
});

test('normalization rejects duplicate date/channel, controls and reserved all channel', () => {
  invalid(() => normalizeTable(table([row, row]), mapping), '重复');
  for (const channel of ['all', ' ALL ', 'a\nb', '\ta', 'a\u007f']) {
    const modified = row.slice(); modified[1] = channel;
    invalid(() => normalizeTable(table([modified]), mapping));
  }
});

test('normalization accepts explicit numeric text and preserves deterministic zero values', () => {
  const result = normalizeTable(table([['2026-10-20', 'a', '1e2', '+10', '200.50', '0']]), mapping);
  assert.deepEqual(result[0], { date: '2026-10-20', channel: 'a', sessions: 100, orders: 10, gmv: 200.5, spend: 0 });
});

test('unsupported statements are rejected with useful grammar guidance', () => {
  for (const content of ['SELECT * FROM t;', 'DROP TABLE t;', 'UPDATE t SET x=1;', 'COPY t FROM STDIN;', 'LOAD DATA INFILE x;', 'SET NAMES utf8;', 'DELETE FROM t;', 'CREATE VIEW v AS SELECT 1;']) {
    invalid(() => sql(content));
  }
});

test('expressions, functions, queries and trailing tokens in INSERT are rejected', () => {
  for (const content of ['INSERT INTO t(a) VALUES(1+2);', 'INSERT INTO t(a) VALUES(NOW());', 'INSERT INTO t(a) SELECT 1;', 'INSERT INTO t(a) VALUES(1) ON DUPLICATE KEY UPDATE a=2;', 'INSERT INTO t(a) VALUES(1); DROP TABLE t;', 'INSERT INTO t(a) VALUES(TRUE);']) invalid(() => sql(content));
});

test('malformed quotes, comments, tuples and CREATE definitions fail closed', () => {
  for (const content of ["INSERT INTO t(a) VALUES('broken);", '/* never closed', 'CREATE TABLE t(a INT;', 'CREATE TABLE t(a);', 'INSERT INTO t(a) VALUES();', 'INSERT INTO t(a,b) VALUES(1);', 'INSERT INTO t(a) VALUES(1,);', 'CREATE TABLE t(a INT,);', "INSERT INTO t(a) VALUES('oops\\q');", 'INSERT INTO t(a) VALUES(1e999);']) invalid(() => sql(content));
});

test('INSERT without CREATE requires a field list; duplicate and unknown columns rejected', () => {
  for (const content of ['INSERT INTO t VALUES(1);', 'INSERT INTO t(a,A) VALUES(1,2);', 'CREATE TABLE t(a INT,A INT); INSERT INTO t VALUES(1,2);', 'CREATE TABLE t(a INT); INSERT INTO t(b) VALUES(1);', 'CREATE TABLE t(a INT); CREATE TABLE t(a INT); INSERT INTO t VALUES(1);']) invalid(() => sql(content));
});

test('common CREATE TABLE export options are recognised as inert metadata', () => {
  const optionLists = [
    'ENGINE=InnoDB',
    'ENGINE=InnoDB AUTO_INCREMENT=100 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci ENGINE InnoDB AUTO_INCREMENT 0',
    "ENGINE='InnoDB' DEFAULT CHARSET='utf8mb4' COLLATE=\"utf8mb4_unicode_ci\"",
    'CHARACTER SET=utf8mb4',
    'AUTO_INCREMENT=18446744073709551615 ENGINE=InnoDB',
    'engine=InnoDB /* export metadata */ default charset=utf8mb4'
  ];
  for (const options of optionLists) {
    const result = sql(`CREATE TABLE t(a INT) ${options}; INSERT INTO t VALUES(42);`);
    assert.deepEqual(result.tables[0], { name: 't', columns: ['a'], rows: [[42]] });
  }
});

test('unknown, duplicate, malformed or executable CREATE tail options rejected', () => {
  const optionLists = [
    'TABLESPACE private', 'ROW_FORMAT=DYNAMIC', "COMMENT='hello'", 'AS SELECT 1',
    'ENGINE=InnoDB ENGINE=MyISAM', 'CHARSET=utf8mb4 DEFAULT CHARACTER SET=utf8',
    'AUTO_INCREMENT=-1', 'AUTO_INCREMENT=1.5', 'AUTO_INCREMENT=1e3', 'AUTO_INCREMENT=999999999999999999999',
    'AUTO_INCREMENT=1+1', 'ENGINE=NOW()', "ENGINE='InnoDB; DROP TABLE users'", 'ENGINE=',
    'DEFAULT COLLATE=utf8mb4_general_ci', 'DEFAULT CHARACTER utf8mb4',
    'ENGINE=InnoDB DROP TABLE users', 'ENGINE=InnoDB SET NAMES utf8mb4'
  ];
  for (const options of optionLists) invalid(() => sql(`CREATE TABLE t(a INT) ${options}; INSERT INTO t VALUES(42);`));
});

test('versioned MySQL executable comments and unsupported statements remain rejected', () => {
  invalid(() => sql('/*!50000 DROP TABLE t */; INSERT INTO t(a) VALUES(1);'), '可执行');
  invalid(() => sql('CREATE TABLE t(a INT) ENGINE=InnoDB; SET NAMES utf8mb4; INSERT INTO t VALUES(1);'), '只支持');
  invalid(() => sql('CREATE TABLE t(a INT) ENGINE=InnoDB; DROP TABLE t; INSERT INTO t VALUES(1);'), '只支持');
});

test('empty input, unsupported format and schema without data rejected', () => {
  invalid(() => parseImport({ format: 'json', content: '{}' }));
  invalid(() => parseImport({ format: 'sql', content: '' }));
  invalid(() => sql('CREATE TABLE t(a INT);'), '没有');
  invalid(() => csv('a,b\n'), '至少');
});

test('CSV structural errors are rejected instead of silently discarding values', () => {
  for (const content of ['a,a\n1,2', 'a,A\n1,2', 'a,b\n1', 'a,b\n1,2,3', 'a,b\n"one"x,two', 'a,b\none"quote,two', 'a,b\n"unclosed,two']) invalid(() => csv(content));
});

test('UTF-8 limit is measured in bytes', () => {
  invalid(() => sql('-- ' + '中'.repeat(350000)), '1 MB');
});

test('5000 rows accepted and total rows across tables are capped', () => {
  const tuples = Array.from({ length: 5000 }, (_, index) => `(${index})`).join(',');
  assert.equal(sql(`INSERT INTO t(a) VALUES${tuples}`).tables[0].rows.length, 5000);
  invalid(() => sql(`INSERT INTO t(a) VALUES${tuples}; INSERT INTO other(a) VALUES(1)`), '5000');
  invalid(() => csv('a\n' + Array(5001).fill('1').join('\n')), '5000');
});

test('table, column, cell and nesting ceilings fail early', () => {
  invalid(() => sql(Array.from({ length: 9 }, (_, index) => `INSERT INTO t${index}(a) VALUES(1);`).join('')), '8 张');
  const names = Array.from({ length: 33 }, (_, index) => `c${index}`);
  invalid(() => sql(`INSERT INTO t(${names.join(',')}) VALUES(${names.map(() => 1).join(',')})`), '32');
  invalid(() => csv(names.join(',') + '\n' + names.map(() => '1').join(',')), '32');
  invalid(() => sql(`INSERT INTO t(a) VALUES('${'x'.repeat(513)}')`), '512');
  invalid(() => csv('a\n' + 'x'.repeat(513)), '512');
  invalid(() => sql('CREATE TABLE t(a INT CHECK ' + '('.repeat(17) + '1' + ')'.repeat(17) + ');'), '嵌套');
});

test('engine channel ceiling is preserved by normalization', () => {
  const rows = Array.from({ length: 101 }, (_, index) => ['2026-10-20', `c${index}`, 1, 1, 1, 1]);
  invalid(() => normalizeTable(table(rows), mapping), '100');
});
