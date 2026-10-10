// What an NPC drops, read from the server's own scripts (RuneScript): a small
// parser for the statements drop scripts use, and an evaluator that follows
// every value a random() can take, keeping the chance of each, so that a
// script comes out as its drop table. Shared tables (the herb table, the gem
// table, the rare drop table, the one under it, junk) are kept as references
// and worked out once, the same way, from their own procs.

// ── Tokens ──────────────────────────────────────────────────────────────────
function tokenize(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const out = [];
  const re = /\s+|("(?:[^"\\]|\\.)*")|(<=|>=|[(){},;:=!<>&|+\-*/])|([~@%$^.]?[A-Za-z0-9_]+(?::[A-Za-z0-9_]+)?)/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`rs2: can't read "${src.slice(i, i + 30)}"`);
    i = re.lastIndex;
    if (m[1]) out.push({ t: 'str', v: m[1].slice(1, -1) });
    else if (m[2]) out.push({ t: 'p', v: m[2] });
    else if (m[3]) out.push(/^\d+$/.test(m[3]) ? { t: 'num', v: Number(m[3]) } : { t: 'id', v: m[3] });
  }
  return out;
}

// ── Parser ──────────────────────────────────────────────────────────────────
export function parse(text) {
  const tk = tokenize(text);
  let i = 0;
  const peek = (k = 0) => tk[i + k];
  const is = (v, k = 0) => peek(k) && peek(k).v === v && (peek(k).t === 'p' || peek(k).t === 'id');
  const take = v => { if (v != null && !is(v)) throw new Error(`rs2: wanted "${v}", got "${peek()?.v}" near ${tk.slice(Math.max(0, i - 6), i + 6).map(t => t.v).join(' ')}`); return tk[i++]; };
  function block() {
    const body = [];
    while (i < tk.length && !is('}')) body.push(stmt());
    return body;
  }
  function stmt() {
    if (is('{')) { take('{'); const b = block(); take('}'); return { k: 'block', body: b }; }
    if (is(';')) { take(';'); return { k: 'block', body: [] }; }
    const t = peek();
    if (t.t === 'id' && t.v === 'if') {
      take('if'); take('('); const cond = expr(); take(')');
      const then = stmt();
      let otherwise = null;
      if (is('else')) { take('else'); otherwise = stmt(); }
      return { k: 'if', cond, then, otherwise };
    }
    if (t.t === 'id' && t.v === 'while') { take('while'); take('('); const cond = expr(); take(')'); return { k: 'while', cond, body: stmt() }; }
    if (t.t === 'id' && /^switch_/.test(t.v)) {
      take(); take('('); const on = expr(); take(')'); take('{');
      const cases = [];
      while (!is('}')) {
        take('case');
        const values = [];
        if (is('default')) { take('default'); values.push('default'); }
        else { values.push(expr()); while (is(',')) { take(','); values.push(expr()); } }
        take(':');
        const body = [];
        while (!is('case') && !is('}')) body.push(stmt());
        cases.push({ values, body });
      }
      take('}');
      return { k: 'switch', on, cases };
    }
    if (t.t === 'id' && /^def_/.test(t.v)) {
      take();
      const name = take().v;
      let init = null;
      if (is('=')) { take('='); init = expr(); }
      take(';');
      return { k: 'set', names: [name], value: init };
    }
    if (t.t === 'id' && t.v.startsWith('$') && (is(',', 1) || is('=', 1))) {
      const names = [take().v];
      while (is(',')) { take(','); names.push(take().v); }
      take('='); const value = expr(); take(';');
      return { k: 'set', names, value };
    }
    if (t.t === 'id' && t.v.startsWith('%') && is('=', 1)) { take(); take('='); expr(); take(';'); return { k: 'block', body: [] }; }
    if (t.t === 'id' && t.v === 'return') {
      take();
      let values = [];
      if (is('(')) { take('('); if (!is(')')) { values.push(expr()); while (is(',')) { take(','); values.push(expr()); } } take(')'); }
      take(';');
      return { k: 'return', values };
    }
    if (t.t === 'id' && t.v.startsWith('@')) {
      take();
      if (is('(')) { take('('); if (!is(')')) { expr(); while (is(',')) { take(','); expr(); } } take(')'); }
      take(';');
      return { k: 'jump', to: t.v.slice(1) };
    }
    const e = expr();
    take(';');
    return { k: 'do', e };
  }
  // expressions: | then & then comparisons then + - then * / then primary
  function expr() { let a = and(); while (is('|')) { take('|'); a = { k: 'or', a, b: and() }; } return a; }
  function and() { let a = cmp(); while (is('&')) { take('&'); a = { k: 'and', a, b: cmp() }; } return a; }
  function cmp() {
    let a = add();
    for (const op of ['<=', '>=', '=', '!', '<', '>']) if (is(op)) { take(op); return { k: 'cmp', op, a, b: add() }; }
    return a;
  }
  function add() { let a = mul(); while (is('+') || is('-')) { const op = take().v; a = { k: 'arith', op, a, b: mul() }; } return a; }
  function mul() { let a = prim(); while (is('*') || is('/')) { const op = take().v; a = { k: 'arith', op, a, b: prim() }; } return a; }
  function prim() {
    const t = take();
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'p' && t.v === '(') { const e = expr(); take(')'); return e; }
    if (t.t === 'p' && t.v === '-') { const e = prim(); return { k: 'arith', op: '-', a: { k: 'num', v: 0 }, b: e }; }
    if (t.t !== 'id') throw new Error(`rs2: unexpected "${t.v}"`);
    // (queue*(name, delay)(args): a call with two lists)
    if (is('*') && is('(', 1)) {
      take('*'); take('(');
      const args = [];
      if (!is(')')) { args.push(expr()); while (is(',')) { take(','); args.push(expr()); } }
      take(')');
      if (is('(')) { take('('); while (!is(')')) take(); take(')'); }
      return { k: 'call', name: t.v, args };
    }
    if (is('(')) {
      take('(');
      const args = [];
      if (!is(')')) { args.push(expr()); while (is(',')) { take(','); args.push(expr()); } }
      take(')');
      return { k: 'call', name: t.v, args };
    }
    if (t.v.startsWith('~')) return { k: 'call', name: t.v, args: [] };
    return { k: 'name', v: t.v };
  }
  const body = [];
  while (i < tk.length) body.push(stmt());
  return body;
}

// ── Evaluation ──────────────────────────────────────────────────────────────
// A state: its chance (p), its variables, the drops so far, and whether it has
// returned. Every random() splits a state into one per value it can take.
// env: { npc, category, displayName, params, members, ring, legends, underground }
// ctx: { blocks: Map("kind,name" -> parsed body), sharedTables: Set of proc names kept as references,
//        deathDropDefault, log: [] }
export function evaluate(body, env, ctx, { args = {} } = {}) {
  let states = [{ p: 1, vars: new Map(Object.entries(args)), drops: [], done: false, ret: null }];
  states = run(body, states, env, ctx, 0);
  return states;
}

const TRUE = 1, FALSE = 0;
const SIDE_EFFECTS = new Set(['gosub', 'npc_del', 'npc_anim', 'npc_delay', 'npc_walk', 'npc_setmode', 'npc_arrivedelay', 'if_close', 'mes', 'session_log',
  'sound_synth', '~sound_within_distance', 'npc_say', '~clear_trail_progress', 'anim', 'spotanim_map', '~trail_checkmediumdrop', 'stat_advance', 'npc_queue', 'queue', 'npc_changetype', 'inv_del', 'inv_add', 'npc_facesquare']);

function run(body, states, env, ctx, depth) {
  for (const st of body) {
    const live = states.filter(s => !s.done);
    const finished = states.filter(s => s.done);
    if (!live.length) return states;
    states = [...finished, ...stmt(st, live, env, ctx, depth)];
  }
  return states;
}

function stmt(st, states, env, ctx, depth) {
  switch (st.k) {
    case 'block': return run(st.body, states, env, ctx, depth);
    case 'if': {
      const out = [];
      for (const s of states) {
        for (const { p, v, s: s2 } of value(st.cond, s, env, ctx, depth)) {
          const branch = { ...s2, p: s2.p * p };
          if (truthy(v)) out.push(...stmt(st.then, [branch], env, ctx, depth));
          else if (st.otherwise) out.push(...stmt(st.otherwise, [branch], env, ctx, depth));
          else out.push(branch);
        }
      }
      return out;
    }
    case 'switch': {
      const out = [];
      for (const s of states) {
        for (const { p, v, s: s2 } of value(st.on, s, env, ctx, depth)) {
          const branch = { ...s2, p: s2.p * p };
          let hit = st.cases.find(c => c.values.some(x => x !== 'default' && value(x, branch, env, ctx, depth)[0].v === v));
          if (!hit) hit = st.cases.find(c => c.values.includes('default'));
          out.push(...(hit ? run(hit.body, [branch], env, ctx, depth) : [branch]));
        }
      }
      return out;
    }
    case 'while': ctx.log.push('a loop, skipped'); return states;
    case 'set': {
      const out = [];
      for (const s of states) {
        if (!st.value) { const vars = new Map(s.vars); for (const n of st.names) vars.set(n, null); out.push({ ...s, vars }); continue; }
        for (const { p, v, s: s2 } of value(st.value, s, env, ctx, depth)) {
          const vars = new Map(s2.vars);
          const vals = Array.isArray(v) ? v : [v];
          st.names.forEach((n, j) => vars.set(n, vals[j] ?? null));
          out.push({ ...s2, p: s2.p * p, vars });
        }
      }
      return out;
    }
    case 'return': {
      const out = [];
      for (const s of states) {
        if (!st.values.length) { out.push({ ...s, done: true, ret: null }); continue; }
        // (each value may branch: a proc returning a random table row)
        let partial = [{ p: 1, vals: [], s }];
        for (const e of st.values) {
          const next = [];
          for (const pr of partial) for (const { p, v, s: s2 } of value(e, pr.s, env, ctx, depth)) next.push({ p: pr.p * p, vals: [...pr.vals, v], s: s2 });
          partial = next;
        }
        for (const pr of partial) out.push({ ...pr.s, p: pr.s.p * pr.p, done: true, ret: pr.vals.length === 1 && Array.isArray(pr.vals[0]) ? pr.vals[0] : pr.vals });
      }
      return out;
    }
    case 'jump': {
      // (a label that jumps back to itself, counting: not a drop)
      if (depth > 20) { ctx.log.push(`a label too deep: ${st.to}`); return states.map(s => ({ ...s, done: true })); }
      const target = ctx.blocks.get(`label,${st.to}`);
      if (!target) throw new Error(`rs2: no label ${st.to}`);
      return run(target, states, env, ctx, depth + 1).map(s => ({ ...s, done: true }));
    }
    case 'do': {
      const out = [];
      for (const s of states) for (const { p, s: s2 } of value(st.e, s, env, ctx, depth, true)) out.push({ ...s2, p: s2.p * p });
      return out;
    }
  }
  throw new Error(`rs2: statement ${st.k}`);
}

const truthy = v => v === true || (typeof v === 'number' && v !== 0) || (v && typeof v === 'object');
const one = (v, s) => [{ p: 1, v, s }];

// The values an expression can have in a state, with their chances: [{ p, v, s }]
// (s: the state after it, which a call that drops something changes).
function value(e, s, env, ctx, depth, asStatement = false) {
  switch (e.k) {
    case 'num': return one(e.v, s);
    case 'str': return one(e.v, s);
    case 'name': {
      const v = e.v;
      if (v.startsWith('$')) return one(s.vars.has(v) ? s.vars.get(v) : null, s);
      if (v.startsWith('%')) return one(env.vars?.[v.slice(1)] ?? 0, s);
      if (v === '^true') return one(TRUE, s);
      if (v === '^false') return one(FALSE, s);
      if (v === 'null') return one(null, s);
      if (v === 'true') return one(TRUE, s);
      if (v === 'false') return one(FALSE, s);
      if (v.startsWith('^')) return one(env.constants?.[v.slice(1)] ?? v, s);
      if (v === 'map_members') return one(env.members ? TRUE : FALSE, s);
      if (v === 'npc_findhero') return one(TRUE, s);
      if (v === 'npc_type') return one(env.npc, s);
      if (v === 'npc_category') return one(env.category || null, s);
      if (v === 'npc_name') return one(env.displayName, s);
      if (v === 'npc_coord' || v === 'coord' || v === 'uid') return one('coord', s);
      if (v.startsWith('~')) return call({ name: v, args: [] }, s, env, ctx, depth, asStatement);
      return one(v, s);                      // an obj, an npc, an inv: its name
    }
    case 'cmp': {
      const out = [];
      for (const a of value(e.a, s, env, ctx, depth)) for (const b of value(e.b, a.s, env, ctx, depth)) {
        const [x, y] = [a.v, b.v];
        let r;
        switch (e.op) {
          case '=': r = x === y; break;
          case '!': r = x !== y; break;
          case '<': r = x < y; break;
          case '>': r = x > y; break;
          case '<=': r = x <= y; break;
          case '>=': r = x >= y; break;
        }
        out.push({ p: a.p * b.p, v: r ? TRUE : FALSE, s: b.s });
      }
      return out;
    }
    case 'and': case 'or': {
      const out = [];
      for (const a of value(e.a, s, env, ctx, depth)) {
        const short = e.k === 'and' ? !truthy(a.v) : truthy(a.v);
        if (short) { out.push(a); continue; }
        for (const b of value(e.b, a.s, env, ctx, depth)) out.push({ p: a.p * b.p, v: truthy(b.v) ? TRUE : FALSE, s: b.s });
      }
      return out;
    }
    case 'arith': {
      const out = [];
      for (const a of value(e.a, s, env, ctx, depth)) for (const b of value(e.b, a.s, env, ctx, depth)) {
        const v = e.op === '+' ? a.v + b.v : e.op === '-' ? a.v - b.v : e.op === '*' ? a.v * b.v : Math.trunc(a.v / b.v);
        out.push({ p: a.p * b.p, v, s: b.s });
      }
      return out;
    }
    case 'call': return call(e, s, env, ctx, depth, asStatement);
  }
  throw new Error(`rs2: expression ${e.k}`);
}

// (the values of each argument, every combination)
function argValues(args, s, env, ctx, depth) {
  let out = [{ p: 1, vals: [], s }];
  for (const a of args) {
    const next = [];
    for (const o of out) for (const { p, v, s: s2 } of value(a, o.s, env, ctx, depth)) next.push({ p: o.p * p, vals: [...o.vals, v], s: s2 });
    out = next;
  }
  return out;
}

function call(e, s, env, ctx, depth, asStatement) {
  const name = e.name;
  if (depth > 20) { ctx.log.push(`too deep at ${name}`); return one(null, s); }
  if ((name === 'random' || name === 'randominc') && ctx.counting) {
    return argValues(e.args, s, env, ctx, depth).map(({ p, vals, s: s2 }) => ({ p, v: { range: [0, vals[0] - (name === 'random' ? 1 : 0)] }, s: s2 }));
  }
  if (name === 'random' || name === 'randominc') {
    const out = [];
    for (const { p, vals, s: s2 } of argValues(e.args, s, env, ctx, depth)) {
      const n = vals[0] + (name === 'randominc' ? 1 : 0);
      for (let k = 0; k < n; k++) out.push({ p: p / n, v: k, s: s2 });
    }
    return out;
  }
  // (arithmetic as the language writes it)
  const ARITH = { add: (a, b) => a + b, sub: (a, b) => a - b, multiply: (a, b) => a * b, divide: (a, b) => Math.trunc(a / b), min: Math.min, max: Math.max, scale: (a, b, c) => Math.trunc((a * c) / b) };
  if (ARITH[name]) {
    return argValues(e.args, s, env, ctx, depth).map(({ p, vals, s: s2 }) => {
      // (a count with a random part: a range, not a split)
      const r = vals.find(v => v && typeof v === 'object' && v.range);
      if (r && (name === 'add' || name === 'sub') && vals.length === 2) {
        const k = vals.find(v => typeof v === 'number') ?? 0;
        return { p, v: { range: name === 'add' ? [r.range[0] + k, r.range[1] + k] : [r.range[0] - k, r.range[1] - k] }, s: s2 };
      }
      return { p, v: ARITH[name](...vals), s: s2 };
    });
  }
  if (/^(queue|strongqueue|weakqueue|longqueue)$/.test(name)) {
    const body = ctx.blocks.get(`queue,${e.args[0]?.v}`);
    if (!body) { ctx.log.push(`queue ${e.args[0]?.v} not found`); return one(null, s); }
    return runProc(body, s, env, ctx, depth);
  }
  if (name === '~random_range') {
    return argValues(e.args, s, env, ctx, depth).map(({ p, vals, s: s2 }) => ({ p, v: { range: [vals[0], vals[1]] }, s: s2 }));
  }
  if (name === 'calc') return value(e.args[0], s, env, ctx, depth);
  // A stat at death: no hitpoints left (a monk checks that before dropping), the rest as its config has them.
  if (name === 'npc_stat' || name === 'npc_basestat') {
    const stat = e.args[0]?.v;
    if (name === 'npc_stat' && stat === 'hitpoints') return one(0, s);
    const v = env.stats?.[stat];
    return one(v == null ? 1 : Number(v), s);
  }
  if (name === 'npc_param') {
    const key = e.args[0].v;
    let v = env.params?.[key] ?? (key === 'death_drop' ? ctx.deathDropDefault : null);
    if (v === 'null') v = null;
    return one(v, s);
  }
  if (name === 'inv_total') {
    const [inv, obj] = e.args.map(a => a.v);
    // (worn: a ring of wealth if the plan says so; Excalibur, without which the Black Knight Titan can't be beaten)
    if (inv === 'worn' && obj === 'ring_of_wealth') return one(env.ring ? 1 : 0, s);
    if (inv === 'worn' && obj === 'excalibur') return one(1, s);
    return one(0, s);
  }
  if (name === '~obj_gettotal') return one(0, s);
  if (name === '~trail_hasclue_all') return one(FALSE, s);
  if (name === 'p_finduid' || name === 'finduid' || name === 'npc_finduid') return one(TRUE, s);
  if (name === 'distance') return one(0, s);
  if (name === 'coordz') return one(env.underground ? 9000 : 3000, s);
  if (name === 'compare') return argValues(e.args, s, env, ctx, depth).map(({ p, vals, s: s2 }) => ({ p, v: vals[0] === vals[1] ? 0 : 1, s: s2 }));
  if (name === 'obj_add') {
    const out = [];
    // (the count is read with random() as a range: 1 to 335 arrows is one row, not 335)
    const objs = argValues(e.args.slice(0, 2), s, env, ctx, depth);
    const rest = [];
    for (const o of objs) {
      ctx.counting = true;
      let tail;
      try { tail = argValues(e.args.slice(2), o.s, env, ctx, depth); } finally { ctx.counting = false; }
      for (const t of tail) rest.push({ p: o.p * t.p, vals: [...o.vals, ...t.vals], s: t.s });
    }
    for (const { p, vals, s: s2 } of rest) {
      // obj_add(coord, obj, count, duration), or obj_add(coord, ~table, duration): a table's row is (obj, count)
      let obj, count;
      if (vals.length === 4) [obj, count] = [vals[1], vals[2]];
      else if (vals.length === 3) [obj, count] = Array.isArray(vals[1]) ? vals[1] : [vals[1], null];
      else throw new Error(`rs2: obj_add with ${vals.length} arguments`);
      const drops = [...s2.drops];
      if (obj && typeof obj === 'object' && obj.table) drops.push({ table: obj.table });
      else if (obj != null) drops.push({ obj, count: count ?? 1 });
      out.push({ p, v: null, s: { ...s2, drops } });
    }
    return out;
  }
  for (const tier of ['easy', 'medium', 'hard']) {
    if (name === `~trail_${tier}cluedrop`) {
      // members only, and only while you hold no clue: 1 in rarity
      return argValues(e.args, s, env, ctx, depth).map(({ p, vals, s: s2 }) => ({ p, v: null, s: env.members ? { ...s2, drops: [...s2.drops, { clue: tier, rarity: vals[0] }] } : s2 }));
    }
  }
  if (name.startsWith('~') && ctx.sharedTables.has(name.slice(1))) return one({ table: name.slice(1) }, s);
  if (name === 'gosub') {
    const target = e.args[0].v;
    if (target === 'npc_death') return one(null, s);
    const body = ctx.blocks.get(`proc,${target}`) || ctx.blocks.get(`label,${target}`);
    if (!body) throw new Error(`rs2: gosub to ${target}, which isn't there`);
    return runProc(body, s, env, ctx, depth);
  }
  if (SIDE_EFFECTS.has(name)) return one(null, s);
  if (name.startsWith('~')) {
    const body = ctx.blocks.get(`proc,${name.slice(1)}`);
    if (!body) { ctx.log.push(`unknown proc ${name}`); return one(null, s); }
    return runProc(body, s, env, ctx, depth);
  }
  ctx.log.push(`unknown call ${name}${env.npc ? ` (${env.npc})` : ''}`);
  return one(null, s);
}

// A proc run inside the script: its drops join the state's; what it returns is the value.
function runProc(body, s, env, ctx, depth) {
  const inner = run(body, [{ p: 1, vars: new Map(), drops: s.drops, done: false, ret: null }], env, ctx, depth + 1);
  return inner.map(x => ({ p: x.p, v: x.ret == null ? null : x.ret.length === 1 ? x.ret[0] : x.ret, s: { ...s, drops: x.drops } }));
}

// ── Into a drop table ───────────────────────────────────────────────────────
// The states a script ends in, as: always (what every one drops), clue (the
// tertiary clue: tier and rarity), and the roll: { of, rows: [[weight, drops]] },
// weight in parts of `of`, the smallest whole number of parts for every row.
export function asTable(states) {
  const key = d => (d.table ? `~${d.table}` : d.clue ? `clue:${d.clue}:${d.rarity}` : `${d.obj}*${typeof d.count === 'object' ? `${d.count.range[0]}-${d.count.range[1]}` : d.count}`);
  const total = states.reduce((a, s) => a + s.p, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error(`rs2: chances add up to ${total}`);
  // (a clue is a roll of its own, made on every kill: taken out first)
  let clue = null;
  states = states.map(s => ({ ...s, drops: s.drops.filter(d => { if (d.clue) { clue = { tier: d.clue, rarity: d.rarity }; return false; } return true; }) }));
  // what every state drops (as many times)
  const counts = states.map(s => { const m = new Map(); for (const d of s.drops) m.set(key(d), (m.get(key(d)) || 0) + 1); return m; });
  const always = new Map();
  for (const [k, n] of counts[0]) {
    const least = Math.min(...counts.map(m => m.get(k) || 0));
    if (least > 0) always.set(k, least);
  }
  const rows = new Map();
  for (let i = 0; i < states.length; i++) {
    const rest = [];
    const left = new Map(always);
    for (const d of states[i].drops) {
      const k = key(d);
      if (left.get(k) > 0) { left.set(k, left.get(k) - 1); continue; }
      rest.push(k);
    }
    const rk = rest.sort().join(' + ');
    rows.set(rk, (rows.get(rk) || 0) + states[i].p);
  }
  // the smallest `of` that makes every weight whole
  let of = 1;
  const ps = [...rows.values()];
  for (const cand of [1, 2, 4, 8, 16, 32, 64, 65, 128, 129, 138, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]) {
    if (ps.every(p => Math.abs(p * cand - Math.round(p * cand)) < 1e-6)) { of = cand; break; }
    of = null;
  }
  if (!of) throw new Error(`rs2: weights aren't whole in any usual base: ${ps.join(', ')}`);
  return {
    always: [...always].flatMap(([k, n]) => Array(n).fill(k)),
    clue,
    of,
    rows: [...rows].map(([rk, p]) => [Math.round(p * of), rk ? rk.split(' + ') : []]).sort((a, b) => b[0] - a[0]),
  };
}
