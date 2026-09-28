// Adaptateur minimal de l'API better-sqlite3 au-dessus de sql.js (SQLite compilé en JavaScript)
'use strict';

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  _prepare(args) {
    const st = this.db._db.prepare(this.sql);
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      const o = {};
      for (const [k, v] of Object.entries(args[0])) o['@' + k] = norm(v);
      st.bind(o);
    } else {
      const list = (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map(norm);
      if (list.length) st.bind(list);
    }
    return st;
  }
  run(...args) {
    const st = this._prepare(args);
    try { st.step(); } finally { st.free(); }
    const changes = this.db._db.getRowsModified();
    const id = this.db._db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    return { changes, lastInsertRowid: id };
  }
  get(...args) {
    const st = this._prepare(args);
    try { return st.step() ? st.getAsObject() : undefined; } finally { st.free(); }
  }
  all(...args) {
    const st = this._prepare(args);
    const rows = [];
    try { while (st.step()) rows.push(st.getAsObject()); } finally { st.free(); }
    return rows;
  }
}

class Database {
  constructor() {
    const SQL = globalThis.__SQL;
    this._db = new SQL.Database(globalThis.__DEMO_DB_BYTES || undefined);
    this._depth = 0;
  }
  prepare(sql) { return new Statement(this, sql); }
  exec(sql) { this._db.exec(sql); return this; }
  pragma(p) {
    if (/journal_mode/i.test(p)) return [];
    this._db.run('PRAGMA ' + p);
    return [];
  }
  transaction(fn) {
    const self = this;
    return function (...a) {
      const sp = 'sp' + (++self._depth);
      self._db.run('SAVEPOINT ' + sp);
      try {
        const r = fn.apply(this, a);
        self._db.run('RELEASE ' + sp);
        return r;
      } catch (e) {
        self._db.run('ROLLBACK TO ' + sp);
        self._db.run('RELEASE ' + sp);
        throw e;
      } finally { self._depth--; }
    };
  }
}
module.exports = Database;
