import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import mysql from "mysql2/promise";

const SCHEMA = new URL("../migrations/001_init.sql", import.meta.url).pathname;
const PRIMARY_KEYS = new Map();

export function openDatabase(target) {
  const handle = typeof target === "string" ? { driver: "sqlite", file: target } : target;
  if (handle?.driver === "mysql") return openMysql(handle.mysql);
  return openSqlite(handle?.file ?? handle?.dbPath ?? handle);
}

function openSqlite(file) {
  const dir = path.dirname(file);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  // MySQL 的 IF()/LEFT()/CONCAT() 只出现在迁移与生成列表达式里；SQLite 回退时补同名函数。
  db.function("IF", { deterministic: true }, (cond, yes, no) => (cond ? yes : no));
  db.function("LEFT", { deterministic: true }, (text, length) => String(text ?? "").slice(0, Number(length)));
  db.function("CONCAT", { varargs: true, deterministic: true }, (...parts) => parts.filter((part) => part !== null && part !== undefined).join(""));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return { driver: "sqlite", raw: db };
}

function openMysql(options) {
  const pool = mysql.createPool({
    host: options.host,
    port: Number(options.port ?? 3306),
    user: options.user,
    password: options.password,
    database: options.database,
    timezone: "Z",
    connectionLimit: Number(options.connectionLimit ?? 10),
    waitForConnections: true
  });
  return { driver: "mysql", raw: pool };
}

export async function closeDatabase(db) {
  if (db?.driver === "mysql") await db.raw.end();
  else db?.raw?.close();
}

const LIMIT_PARAMS = /\bLIMIT\s+\?(\s+OFFSET\s+\?)?\s*$/i;

function withLimit(sql, params) {
  const match = LIMIT_PARAMS.exec(sql);
  if (!match) return [sql, params];
  const values = params.slice(-(match[1] ? 2 : 1)).map((value) => Math.max(0, Number(value) | 0));
  const kept = params.slice(0, params.length - values.length);
  return [sql.replace(LIMIT_PARAMS, `LIMIT ${values.join(" OFFSET ")}`), kept];
}

// 值是数组而不是零散实参：写错时立刻报错，不让驱动把字符串按字符逐个绑定。
function assertParams(sql, params) {
  if (!Array.isArray(params)) throw new TypeError(`查询参数必须是数组：${sql.slice(0, 60)}`);
}

export async function run(db, sql, params = []) {
  assertParams(sql, params);
  if (db.driver === "mysql") {
    const [statement, values] = withLimit(sql, params);
    // TEMPORARY TABLE 只属于建它的那条连接（别的连接上连表都看不到），走连接池的 query 会建在随机连接上；
    // 这里固定借一条连接，跑完把建过临时表的连接关掉，不让它带着临时表回到连接池。
    const temporary = TEMPORARY.test(statement);
    const connection = temporary ? await db.raw.getConnection() : null;
    try {
      const [result] = await (connection ?? db.raw).query(statement, values);
      return { changes: result?.affectedRows ?? 0, lastId: result?.insertId ?? null };
    } finally {
      if (connection) connection.destroy();
    }
  }
  const [statement, values] = toSqliteDialect(sql, params);
  const result = db.raw.prepare(statement).run(...values);
  return { changes: Number(result.changes ?? 0), lastId: Number(result.lastInsertRowid ?? 0) };
}

const TEMPORARY = /^\s*(?:CREATE|DROP)\s+TEMPORARY\s+TABLE/i;

export async function all(db, sql, params = []) {
  assertParams(sql, params);
  if (db.driver === "mysql") {
    const [statement, values] = withLimit(sql, params);
    const [rows] = await db.raw.query(statement, values);
    return rows;
  }
  const [statement, values] = toSqliteDialect(sql, params);
  return db.raw.prepare(statement).all(...values);
}

export async function get(db, sql, params = []) {
  const rows = await all(db, sql, params);
  return rows[0];
}

export async function transaction(db, work) {
  if (db.driver === "sqlite") {
    db.raw.exec("BEGIN");
    try {
      const result = await work(db);
      db.raw.exec("COMMIT");
      return result;
    } catch (error) {
      db.raw.exec("ROLLBACK");
      throw error;
    }
  }
  const connection = await db.raw.getConnection();
  const scoped = { driver: "mysql", raw: connection };
  try {
    await connection.beginTransaction();
    const result = await work(scoped);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// 迁移按文件名顺序执行。两种方言的写法没法用改写规则统一时，再在 migrations/mysql/ 放一份同名文件：
// 那里的是最终写法，不再经过 toMySqlStatements 转换；没有就来 sqlite 的写法改写过去。记录名始终是根目录的文件名。
export function migrationFiles(driver) {
  const root = new URL("../migrations/", import.meta.url).pathname;
  const specific = path.join(root, "mysql");
  return readdirSync(root)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const final = path.join(specific, name);
      return { name, sql: readFileSync(existsSync(final) && driver === "mysql" ? final : path.join(root, name), "utf8") };
    });
}

export async function migrate(db) {
  await run(
    db,
    "CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(191) PRIMARY KEY, applied_at VARCHAR(32) NOT NULL)"
  );
  const applied = new Set((await all(db, "SELECT name FROM schema_migrations")).map((row) => row.name));
  const fresh = [];
  for (const { name, sql } of migrationFiles(db.driver)) {
    if (applied.has(name)) continue;
    const statements = db.driver === "mysql" ? toMySqlStatements(sql) : toSqliteStatements(sql);
    try {
      await transaction(db, async (scoped) => {
        for (const statement of statements) await runMigrationStatement(scoped, statement);
        await run(scoped, "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [name, new Date().toISOString()]);
      });
    } catch (error) {
      await dropMigrateScratch(db, db.driver === "mysql" ? toMySqlStatements(sql) : []);
      throw new Error(`migration ${name} failed: ${error.message}`);
    }
    await dropMigrateScratch(db, db.driver === "mysql" ? statements : []);
    fresh.push(name);
  }
  return fresh;
}

export async function dropMigrateScratch(db, statements) {
  const scratch = statements.filter((statement) => /^\s*CREATE\s+TEMPORARY\s+TABLE/i.test(statement)).flatMap((statement) => {
    const name = /^\s*CREATE\s+TEMPORARY\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(statement);
    return name ? [`SHOW CREATE TEMPORARY TABLE \`${name[1]}\``] : [];
  });
  if (db.driver !== "mysql" || scratch.length === 0) return;
  // 临时表建在事务用的那条连接上：它只对这条连接可见，交回连接池后可能被后面别的请求拿到。
  let used = false;
  try {
    const connection = await db.raw.getConnection();
    try {
      for (const probe of scratch) {
        const [rows] = await connection.query(probe);
        if (rows.length) used = true;
      }
    } finally {
      if (used) connection.destroy();
      else connection.release();
    }
  } catch {
    // 清理失败不影响迁移结果：临时表随连接销毁。
  }
}

const SQLITE_UNSUPPORTED = [
  /^\s*KEY\s+\w+\s*\(.*\)\s*,?\s*$/i
];
// 列清单里可能出现前缀长度（hot_list_url(255)），所以括号内允许再嵌一层括号。
const KEY_COLUMNS = String.raw`\(\s*\w+\s*(?:\(\s*\d+\s*\))?(?:\s*,\s*\w+\s*(?:\(\s*\d+\s*\))?)*\)`;
const UNIQUE_KEY = new RegExp(String.raw`^\s*UNIQUE\s+KEY\s+(\w+)\s*(${KEY_COLUMNS})\s*,?\s*$`, "i");
// "col TYPE AS (表达式) STORED" → SQLite 用普通列 + 触发器维护同一个值。
const GENERATED_COLUMN = /^\s*(\w+)\s+([\w()]+)\s+AS\s*\((.*)\)\s*STORED\s*,?\s*$/i;

// 迁移按 MySQL 8 写一份；SQLite 回退时抹掉它不认识的内联索引，唯一键改写成独立索引，
// 生成列降级为普通列并用触发器赋值，再收拾因此留下的多余逗号与空行。
// 这些 ALTER 是专门给旧库升级的：全新库由 001 直接建好最终形态（002 里相同的列已在建表语句里），
// SQLite 上没有对应写法或旧库用不上，退到 SQLite 时直接跳过。
const MYSQL_ONLY_ALTER = [
  /^ALTER\s+TABLE\s+\w+\s+MODIFY\s+COLUMN/i,
  /^ALTER\s+TABLE\s+\w+\s+(?:DROP|ADD)\s+PRIMARY\s+KEY/i,
  /^ALTER\s+TABLE\s+\w+\s+(?:DROP|ADD)\s+(?:FOREIGN\s+KEY|CONSTRAINT)\s+\w+/i,
  /^ALTER\s+TABLE\s+\w+\s+DROP\s+(?:INDEX|KEY)\s+\w+/i,
  /^ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN/i
];
export function toSqliteStatements(sql) {
  return splitByLine(sql).flatMap((statement) => {
    // 注释先摘掉再判断，否则以 "--" 开头的注释行会把后面的 ALTER 藏住。
    statement = statement.replace(/^\s*--.*$/gm, "").trim();
    if (MYSQL_ONLY_ALTER.some((pattern) => pattern.test(statement))) return [];
    // ALTER TABLE ... ADD COLUMN / ADD UNIQUE KEY 照样交给 SQLite，去重由 runMigrationStatement 负责。
    if (/^ALTER\s+TABLE/i.test(statement)) return [statement];
    if (isCommentOnly(statement)) return [];
    const tables = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(statement);
    if (!tables) return [statement.trim()];
    const lines = statement.split("\n");
    const unique = [];
    const generated = [];
    const supported = lines.map((line) => {
      const uniqueKey = UNIQUE_KEY.exec(line);
      if (uniqueKey) {
        unique.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${uniqueKey[1]} ON ${tables[1]} ${stripPrefixes(uniqueKey[2])};`);
        return null;
      }
      const column = GENERATED_COLUMN.exec(line);
      if (column) {
        const [, name, type, expression] = column;
        generated.push({ name, expression });
        return `  ${name} ${type} NULL,`;
      }
      return SQLITE_UNSUPPORTED.some((pattern) => pattern.test(line)) ? null : line;
    });
    const kept = supported.filter((line) => line !== null);
    const triggers = generated.flatMap(({ name, expression }) =>
      ["INSERT", "UPDATE"].map(
        (event) =>
          `CREATE TRIGGER IF NOT EXISTS ${tables[1]}_${name}_${event.toLowerCase()} AFTER ${event} ON ${tables[1]}\n` +
          `  BEGIN UPDATE ${tables[1]} SET ${name} = (${expression}) WHERE rowid = NEW.rowid; END;`
      )
    );
    // 唯一键写成独立索引，必须等 CREATE TABLE 建好表再建，所以排在表后面。
    return [tidyDanglingComma(kept.join("\n").replace(/\n\s*\n/g, "\n")).trim(), ...triggers, ...unique];
  });
}

function tidyDanglingComma(text) {
  return text.replace(/,(\s*\n\s*\))/g, "$1");
}

// SQLite 的索引不接受列前缀长度 (hot_list_url(255))，去掉后整列比较：比 MySQL 更严，不会放过重复。
function stripPrefixes(columns) {
  return columns.replace(/\(\s*\d+\s*\)/g, "");
}

// 先认表头和 VALUES，再在 VALUES 之后找 ON DUPLICATE KEY UPDATE：值列表里出现 "UPDATE" 这类词也不会认错。
const INSERT_HEAD = /^\s*INSERT\s+INTO\s+(\w+)\s*\(([^()]*)\)\s*VALUES\s+([\s\S]*)$/i;
const UPSERT_TAIL = /^([\s\S]*?)\s*ON\s+DUPLICATE\s+KEY\s+UPDATE(?!\s*SET\b)\s*([\s\S]*)$/i;
const INSERT_START = /^\s*INSERT\s+INTO\s+\w+\s*\([^()]*\)\s*VALUES\s+/i;
const SEARCH_ESCAPE = /\bLIKE\s+\?\s+ESCAPE\s+'!'/i;

// 在 VALUES 里找到顶层括号，返回 [开括号位置, 闭括号位置]；括号里的函数调用、带别名的值列表都算一层。
function matchParen(text, from) {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return [from, index];
    }
  }
  return [from, -1];
}

// 切出 "VALUES" 后面的每一条值列表，它们是与列名按位置对应的表达式。
// 传入的是 "VALUES" 之后的片段，按顶层括号逐个取值。
function splitValuesLists(text) {
  const groups = [];
  let index = text.search(/\(/);
  while (index >= 0) {
    const close = matchParen(text, index)[1];
    if (close < 0) break;
    groups.push(text.slice(index + 1, close));
    index = /^\s*,/.test(text.slice(close + 1)) ? text.indexOf("(", close + 1) : -1;
  }
  return groups;
}

// 从 "(a, b, c)" 里取列表达式，按顺序对上值列表。
function slotExpressions(text) {
  const open = text.indexOf("(");
  const close = matchParen(text, open)[1];
  const body = close < 0 ? text.slice(open + 1) : text.slice(open + 1, close);
  return splitEntries(body);
}

const IDENTIFIER = /^[A-Za-z_]\w*$/;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const STRING = /^N?'(?:[^']|'')*'/i;
const PARAMETER = /^[?:@$][\w$]*/;
const WORD = /^[\w.]+/;

// 只看一个表达式，不解析整段 SQL：字符串字面量里的 ? 不算参数，? / ?1 / :name / @name 才算占位符。
function expressionTokens(expression) {
  const tokens = [];
  let index = 0;
  while (index < expression.length) {
    const rest = expression.slice(index);
    const match = /\s/.test(rest[0]) ? null : STRING.exec(rest) ?? PARAMETER.exec(rest) ?? NUMBER.exec(rest) ?? WORD.exec(rest);
    tokens.push(match ? match[0] : rest[0]);
    index += match ? match[0].length : 1;
  }
  return tokens;
}

const isParameter = (token) => PARAMETER.test(token);

function parameterCount(expression) {
  return expressionTokens(expression).filter(isParameter).length;
}

// 转成 SQLite 驱动能绑定的样子：?1 与具名参数统一换成 ?，裸列名换成 excluded.列名。
// 每个 token 单独渲染，相邻两块之间：标点贴住，其余补一个空格。
function renderedExpression(expression) {
  let text = " ";
  for (const token of expressionTokens(expression)) {

    const sql = isParameter(token) ? "?" : IDENTIFIER.test(token) ? `excluded.${token}` : token;
    if (text.endsWith(" ")) text += sql.trim() === "" ? " " : sql;
    else if (/[,(.]$/.test(text) || /^[),.]/.test(sql)) text += sql;
    else text += ` ${sql}`;
  }
  return text.trim();
}

// 更新子句拆成 "列 = 来源"，来源既可以是行别名（incoming.title）也可以是裸列名（created_at = created_at）。
// 更新项按最外层逗号切开：右值可能是字符串字面量或函数调用，里面也可能带逗号。
function updateAssignments(updates) {
  return splitEntries(updates).map((entry) => {
    const match = /^(\w+)\s*=\s*(.*)$/s.exec(entry.trim());
    if (!match) throw new Error(`sqlite 无法解析 upsert 的更新项：${entry.trim()}`);
    return { target: match[1], source: match[2] };
  });
}

// 只在括号与引号之外切逗号。
function splitEntries(text) {
  const entries = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      entries.push(text.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(text.slice(start));
  return entries;
}

// 右值是"哪一列的值"：incoming.x / excluded.x / 裸列名。字面量、函数调用这类返回 null。
function sourceColumn(expression) {
  const body = expression.trim();
  const dot = body.indexOf(".");
  if (dot >= 0) {
    const alias = body.slice(0, dot).toLowerCase();
    if (alias !== "incoming" && alias !== "excluded") return null;
  }
  const column = dot >= 0 ? body.slice(dot + 1) : body;
  if (!IDENTIFIER.test(column)) return null;
  return column;
}

// 多行插入没法逐行还原更新子句引用的值，只认"整条更新都写回被更新的那一列"：每一列的来源都是它自己，
// 冲突时什么都不用改。主键写回自身等于没写，可以接受；更新别的列就成了"保留旧行"，会被悄悄吞掉，交给调用方报错。
// 复合主键猜不准，干脆不算。
function noopMultiRow(primaryKey, updates) {
  if (!primaryKey) return false;
  const rows = updateAssignments(updates);
  for (let index = 0; index < rows.length; index += 1) {
    const target = rows[index].target;
    if (String(sourceColumn(rows[index].source)) !== String(target)) return false;
  }
  return true;
}

// 主键列名从建表语句里读；复合主键返回 null。
function primaryKeyOf(table) {
  if (!PRIMARY_KEYS.has(table)) primaryKeys();
  return PRIMARY_KEYS.get(table) ?? null;
}

function primaryKeys() {
  const statements = splitStatements(readFileSync(SCHEMA, "utf8"));
  for (const statement of statements) {
    const table = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(statement)?.[1];
    if (!table) continue;
    const lines = statement.split(/\r?\n/);
    let column = null;
    for (const line of lines) {
      const spaced = ` ${line.toLowerCase().replace(/\s+/g, " ")} `;
      if (!spaced.includes(" primary key")) continue;
      // 表级主键写成 PRIMARY KEY (...) 时列名不止一个，猜不准。
      column = spaced.includes(" primary key (") ? null : line.trim().split(/\s+/)[0];
      break;
    }
    PRIMARY_KEYS.set(table, column);
  }
  return PRIMARY_KEYS;
}

// 同一份 SQL 要在两种方言下都跑：MySQL 的 upsert 与转义写法换成 SQLite 的等价物。
// 参数顺序跟着占位符走——只把 VALUES 里真正用掉的参数留下，搜索时每个 ESCAPE 再配一个 '!'。
// 判断本条 upsert 在 SQLite 下的写法：更新子句里每列都写回自身（只写主键也算）时，冲突保留旧行，等价于去掉更新子句。
function sqliteConflictKeepsRow(table, updates) {
  return noopMultiRow(primaryKeyOf(table), updates);
}

export function toSqliteDialect(sql, params) {
  let text = sql;
  let values = params;
  const head = INSERT_HEAD.exec(text);
  if (head) {
    // VALUES 后面的行别名（"AS incoming"）只有 MySQL 用，SQLite 不认，先剥掉再按列重排。
    text = `${head[0].replace(/\)\s*VALUES\s*$/, ") VALUES ").replace(/\s*AS\s+incoming\s*$/i, "")}${text.slice(head[0].length)}`;
    const [, table, columnList, body] = head;
    const tailMatch = UPSERT_TAIL.exec(body);
    const valuesText = tailMatch ? tailMatch[1] : body;
    const updates = tailMatch ? tailMatch[2].replace(/;\s*$/, "").trim() : "";
    // SQL 里没有冲突更新子句时也照样重排：值和列按位置对应，alias 形式的 VALUES 直接返回会把占位符漏给驱动。
    if (!updates) return [text, values];
    const insert = INSERT_START.exec(text)[0];
    const columns = splitEntries(columnList).map((column) => column.trim());
    const lists = splitValuesLists(valuesText).map((entry) => entry.trim()).map(slotExpressions);
    if (lists.length === 0) throw new Error(`sqlite 无法解析 upsert 的值列表：${table}`);
    // VALUES 里可能有字符串字面量，不是每个 ? 都在这里：只数、只换这一段用掉的参数，后面的 ESCAPE 才不会串位。
    const used = lists.reduce(
      (sum, expressions) => sum + expressions.reduce((count, expression) => count + parameterCount(expression), 0),
      0
    );
    const list = lists.map((expressions) => `(${expressions.map(renderedExpression).join(", ")})`).join(", ");

    // 单行 upsert 改成 INSERT OR REPLACE：node:sqlite 在 DO UPDATE 里写回 NOT NULL 列时会把该列当作没赋值，
    // 整个仓库的 upsert 都以主键为冲突键，REPLACE 的效果与 MySQL 的 ON DUPLICATE KEY UPDATE 一致。
    // 多行的更新子句只认"整条都写回自身"且不碰主键，冲突时保留旧行，等价于去掉更新子句。
    if (lists.length > 1) {
      if (!noopMultiRow(primaryKeyOf(table), updates)) {
        throw new Error(`sqlite 无法表达多行 upsert 的更新子句：${table}`);
      }
      text = `${insert}${list};`;
    } else {
      text = `${insert}${list};`.replace(/^(\s*)INSERT\s+INTO/i, "$1INSERT OR REPLACE INTO");
    }
    values = params.slice(0, used);
  }
  if (SEARCH_ESCAPE.test(text)) {
    // SQLite 不认字面的 ESCAPE '!'：改写成参数，并在它那个值后面补一个 "!"。
    // 参数跟着占位符的顺序走：每遇到一个 ? 取下一个值，"!" 紧跟在被转义的那个值后面。
    const ordered = [];
    let next = 0;
    const take = () => (next < values.length ? values[next++] : undefined);
    text = text
      .split(/(\bLIKE\s+\?\s+ESCAPE\s+'!')/i)
      .map((segment) => {
        if (!segment) return segment;
        if (!/^LIKE\s/i.test(segment)) {
          segment.replace(/\?/g, () => (ordered.push(take()), ""));
          return segment;
        }
        ordered.push(take());
        ordered.push("!");
        return "LIKE ? ESCAPE ?";
      })
      .join("");
    values = ordered;
  }
  return [text, values];
}

// 按分号切分，但只认行尾的分号：注释里出现的 ";" 不切开。
// 以 "--" 开头的行是独立注释，先摘出去单独成句，剩下的 SQL 里不会残留注释。
function splitByLine(sql) {
  const comments = [];
  const body = String(sql)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.trim().startsWith("--")) return line;
      comments.push(line.trim());
      return "";
    })
    .join("\n");
  return [...body.split(/;\s*(?=\n|$)/), ...comments].map((statement) => statement.trim()).filter(Boolean);
}

function isCommentOnly(statement) {
  return String(statement)
    .split("\n")
    .every((line) => !line.trim() || line.trim().startsWith("--"));
}

function toMySqlStatements(sql) {
  return splitByLine(sql).filter((statement) => !isCommentOnly(statement));
}

const ADD_COLUMN = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i;
const ADD_KEY_HEAD = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:UNIQUE\s+)?(?:KEY|INDEX)\s+(\w+)/i;
// 单列唯一键（含前缀长度）：建之前先查重复值。
const UNIQUE_SINGLE_COLUMN = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+UNIQUE\s+(?:KEY|INDEX)\s+(\w+)\s*\(\s*(\w+)\s*(?:\(\s*\d+\s*\))?\s*\)/i;
// MySQL 的 "ADD [UNIQUE] KEY 名字 (...)" 在 SQLite 里写成独立建索引；建语句本身已带 IF NOT EXISTS。
const ADD_KEY = new RegExp(String.raw`^ALTER\s+TABLE\s+(\w+)\s+ADD\s+(UNIQUE\s+)?(?:KEY|INDEX)\s+(\w+)\s*(${KEY_COLUMNS})`, "i");
const DROP_INDEX = /^ALTER\s+TABLE\s+(\w+)\s+DROP\s+(?:INDEX|KEY)\s+(\w+)/i;
const DROP_COLUMN = /^ALTER\s+TABLE\s+(\w+)\s+DROP\s+COLUMN\s+(\w+)/i;
const MODIFY_COLUMN = /^ALTER\s+TABLE\s+\w+\s+MODIFY\s+COLUMN/i;

// 索引存在与否两种方言都能查。
async function indexExists(db, table, name) {
  const rows = db.driver === "mysql"
    ? await all(db, "SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?", [table, name])
    : await all(db, "SELECT 1 FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?", [table, name]);
  return rows.length > 0;
}

async function columnNames(db, table) {
  const rows = db.driver === "mysql"
    ? await all(db, "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?", [table])
    : await all(db, "SELECT name FROM pragma_table_info(?)", [table]);
  return rows.map((row) => row.name);
}

// 唯一索引只建在单列上时，先看这一列已有数据有没有重复：有就建不起来，直接抛出要改的数据。
// 带前缀长度的键只比较前 N 个字符，跟真正建出来的索引口径一致。
async function duplicateValues(db, table, column, statement) {
  const prefix = new RegExp(String.raw`\(\s*(\d+)\s*\)`).exec(statement);
  const key = db.driver === "mysql" && prefix ? `LEFT(${column}, ${prefix[1]})` : column;
  const rows = await all(db, `SELECT ${column} AS value FROM ${table} GROUP BY ${key} HAVING COUNT(*) > 1`);
  return rows.map((row) => row.value);
}

// 新库的 001 已经把列和索引建好了，旧库才需要补；MySQL 没有 ADD COLUMN / CREATE INDEX / DROP INDEX
// 的 IF [NOT] EXISTS，改成「先查，缺了才加、有了才删」，重复执行也不报错。
export async function runMigrationStatement(db, statement) {
  // 001 建表时已经用新定义写好生成列，MODIFY 只为旧库准备，SQLite 没有等价写法。
  if (MODIFY_COLUMN.test(statement)) return db.driver === "mysql" ? run(db, statement) : null;
  const keyHead = ADD_KEY_HEAD.exec(statement);
  if (keyHead) {
    const [, table, name] = keyHead;
    if (await indexExists(db, table, name)) return null;
    const key = ADD_KEY.exec(statement);
    // 多列或带表达式的键交给 SQLite 原样执行，冲突由数据库报。
    if (!key) return run(db, statement);
    const [, , unique, , columns] = key;
    const single = UNIQUE_SINGLE_COLUMN.exec(statement);
    if (unique && single) {
      const clashes = await duplicateValues(db, table, single[3], statement);
      if (clashes.length > 0) {
        throw new Error(`无法给 ${table} 建唯一索引 ${name}：${single[3]} 有重复值 ${clashes.join(", ")}，请先处理数据`);
      }
    }
    const kind = unique ? " UNIQUE" : "";
    return run(db, `CREATE${kind} INDEX${db.driver === "mysql" ? "" : " IF NOT EXISTS"} ${name} ON ${table} ${stripPrefixes(columns)}`);
  }
  const dropped = DROP_INDEX.exec(statement);
  if (dropped) {
    const [, table, name] = dropped;
    if (!(await indexExists(db, table, name))) return null;
    return run(db, db.driver === "mysql" ? `ALTER TABLE ${table} DROP INDEX ${name}` : `DROP INDEX ${name}`);
  }
  // DROP COLUMN 没有 IF EXISTS：MySQL 和 SQLite 都先查列还在不在。
  const droppedColumn = DROP_COLUMN.exec(statement);
  if (droppedColumn) {
    const [, table, column] = droppedColumn;
    if (!(await columnNames(db, table)).includes(column)) return null;
    return run(db, statement);
  }
  const added = ADD_COLUMN.exec(statement);
  if (!added) return run(db, statement);
  const [, table, column] = added;
  if ((await columnNames(db, table)).includes(column)) return null;
  return run(db, statement);
}

export function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}
