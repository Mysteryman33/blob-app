import re
import os
import sqlite3
import random
import json
import logging
import threading
import secrets
from datetime import datetime, timedelta
from flask import Flask, render_template, jsonify, request, session, redirect
from werkzeug.security import generate_password_hash, check_password_hash
from groq import Groq

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

_RAW_TOOL_RE = re.compile(
    r'<function[= ][^>]*>.*?</function\s*>|'
    r'<function_calls\s*>.*?</function_calls\s*>|'
    r'<invoke\s*>.*?</invoke\s*>|'
    r'\[TOOL_CALLS\].*',
    re.DOTALL | re.IGNORECASE,
)

# Handles two formats from Groq's failed_generation:
#   Old (70b): <function=name [{...}]</function>
#   New (8b):  <function=name>{"k":"v"}<function>  (no slash on closing tag)
_FAILED_GEN_RE = re.compile(
    r'<function=(\w+)[^>]*>\s*([\[\{].*?[\]\}])\s*</?\s*function[^>]*>|'
    r'<function=(\w+)\s*([\[\{].*?[\]\}])?\s*</function>',
    re.DOTALL,
)

def _clean(text: str) -> str:
    return _RAW_TOOL_RE.sub('', text).strip().strip('"').strip("'")

def _parse_failed_generation(text: str):
    """Extract every (tool_name, args_dict) from Groq's failed_generation string.

    Returns a list so a single XML-format failure can still recover multiple
    tool calls (e.g. "add milk and eggs"). Empty list when nothing parses."""
    calls = []
    for m in _FAILED_GEN_RE.finditer(text or ''):
        # Groups 1+2 = new 8b format; groups 3+4 = old format
        name = m.group(1) or m.group(3)
        if not name:
            continue
        raw = (m.group(2) or m.group(4) or '{}').strip()
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):           # old format wrapped args in a list
                parsed = next((x for x in parsed if isinstance(x, dict)), {})
            if not isinstance(parsed, dict):
                parsed = {}
        except (json.JSONDecodeError, ValueError):
            parsed = {}
        calls.append((name, parsed))
    return calls

app = Flask(__name__)
DB_PATH   = 'tasks.db'
GROQ_KEY  = os.getenv('GROQ_API_KEY', '')  # set GROQ_API_KEY env var
CHAT_MODEL      = os.getenv('CHAT_MODEL', 'openai/gpt-oss-20b')          # main tool-calling model
SENTIMENT_MODEL = os.getenv('SENTIMENT_MODEL', 'llama-3.1-8b-instant')   # tiny tone-scoring model
_DB_URL   = os.getenv('DATABASE_URL', '')
_IS_PG    = bool(_DB_URL)

# Default pet-stat changes when sentiment analysis is unavailable.
_DEFAULT_EFFECTS = {'happiness': 1, 'energy': 0, 'familiarity': 1, 'expression': 'normal'}

# Reuse one Groq client across requests instead of constructing one per call.
_groq_client = None
def _groq():
    global _groq_client
    if _groq_client is None:
        _groq_client = Groq(api_key=GROQ_KEY)
    return _groq_client

if _IS_PG:
    import psycopg2
    import psycopg2.extras

# ── Auth / session config ──────────────────────────────────────────────────────
# Each user's data lives in its own private store so accounts never see each
# other's tasks/pet/etc. In production that's a dedicated PostgreSQL schema
# ("u_<id>"); in local dev it's a dedicated SQLite file ("data/u_<id>.db").
# The shared users table lives in the "system" store (public schema / auth.db).
USER_DATA_DIR = 'data'      # local SQLite: one DB file per user
AUTH_DB_PATH  = 'auth.db'   # local SQLite: shared users table


def _load_secret_key():
    """Stable signing key for session cookies.
    Production MUST set SECRET_KEY (so logins survive restarts & multiple workers).
    Local dev falls back to a key persisted in .secret_key."""
    key = os.getenv('SECRET_KEY')
    if key:
        return key
    try:
        if os.path.exists('.secret_key'):
            with open('.secret_key') as f:
                return f.read().strip()
        key = secrets.token_hex(32)
        with open('.secret_key', 'w') as f:
            f.write(key)
        return key
    except Exception:
        return secrets.token_hex(32)


app.secret_key = _load_secret_key()
app.permanent_session_lifetime = timedelta(days=30)   # "stay logged in" across sessions
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=_IS_PG,   # production is served over HTTPS
)

_INSERT_RE = re.compile(r'^\s*INSERT\b', re.I)
_CREATE_RE = re.compile(r'^\s*CREATE\b', re.I)


class _Row:
    """Unified row object: supports dict-style and integer-index access for both DBs."""
    def __init__(self, data):
        self._d = {}
        if data:
            for k, v in (data.items() if hasattr(data, 'items') else enumerate(data)):
                # Convert datetime objects (PostgreSQL) to ISO strings
                self._d[k] = v.isoformat() if hasattr(v, 'isoformat') else v
        self._vals = list(self._d.values())

    def __getitem__(self, key):
        return self._vals[key] if isinstance(key, int) else self._d[key]

    def __iter__(self): return iter(self._d)
    def __bool__(self): return bool(self._d)
    def keys(self):   return self._d.keys()
    def values(self): return self._d.values()
    def items(self):  return self._d.items()
    def get(self, k, default=None): return self._d.get(k, default)


class _Cursor:
    def __init__(self, raw):
        self._c   = raw
        self.lastrowid = None

    def _adapt(self, sql):
        """Transform SQLite SQL into PostgreSQL-compatible SQL."""
        # Placeholders
        sql = sql.replace('?', '%s')
        # AUTOINCREMENT
        sql = sql.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'SERIAL PRIMARY KEY')
        # Double-quoted string literals → single-quoted (SQLite allows "val", PG does not)
        sql = re.sub(r"\bDEFAULT\s+\"([^\"]+)\"", r"DEFAULT '\1'", sql)
        # SQLite scalar MIN(a,b)/MAX(a,b) → PG LEAST()/GREATEST() (PG MIN/MAX are aggregate-only).
        # Safe: this codebase only uses the 2-arg scalar form, never aggregate MIN/MAX.
        sql = re.sub(r'\bMIN\(', 'LEAST(', sql)
        sql = re.sub(r'\bMAX\(', 'GREATEST(', sql)
        # INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
        if re.match(r'\s*INSERT\s+OR\s+IGNORE\b', sql, re.I):
            sql = re.sub(r'(?i)INSERT\s+OR\s+IGNORE\b', 'INSERT', sql)
            if 'ON CONFLICT' not in sql.upper():
                sql = sql.rstrip('; ') + ' ON CONFLICT DO NOTHING'
        # In CREATE TABLE: TEXT DEFAULT CURRENT_TIMESTAMP → TIMESTAMP DEFAULT NOW()
        if _CREATE_RE.match(sql):
            sql = sql.replace('TEXT DEFAULT CURRENT_TIMESTAMP', 'TIMESTAMP DEFAULT NOW()')
        return sql

    def execute(self, sql, params=()):
        if _IS_PG:
            sql = self._adapt(sql)
            is_ins = bool(_INSERT_RE.match(sql))
            # Append RETURNING id so we can get lastrowid without a second query
            if is_ins and 'RETURNING' not in sql.upper():
                sql = sql.rstrip('; ') + ' RETURNING id'
        else:
            is_ins = bool(_INSERT_RE.match(sql))

        self._c.execute(sql, params or ())

        if _IS_PG and is_ins:
            try:
                row = self._c.fetchone()
                self.lastrowid = row['id'] if row else None
            except Exception:
                self.lastrowid = None
        elif not _IS_PG:
            self.lastrowid = self._c.lastrowid
        return self

    def fetchone(self):
        row = self._c.fetchone()
        if row is None:
            return None
        return _Row(row if _IS_PG else dict(row))

    def fetchall(self):
        rows = self._c.fetchall()
        return [_Row(r if _IS_PG else dict(r)) for r in rows]


class _Conn:
    def __init__(self, schema=None, sqlite_path=None, autocommit=False):
        if _IS_PG:
            self._raw = psycopg2.connect(_DB_URL)
            if autocommit:
                self._raw.autocommit = True
            self._factory = psycopg2.extras.RealDictCursor
            if schema:
                # Scope every statement on this connection to the user's schema.
                cur = self._raw.cursor()
                cur.execute(f'SET search_path TO "{schema}", public')
                cur.close()
        else:
            self._raw = sqlite3.connect(sqlite_path or DB_PATH)
            self._raw.row_factory = sqlite3.Row
            self._factory = None

    def execute(self, sql, params=()):
        cur = self._raw.cursor(cursor_factory=self._factory) if _IS_PG else self._raw.cursor()
        return _Cursor(cur).execute(sql, params)

    def commit(self):
        self._raw.commit()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, *_):
        if exc_type:
            try: self._raw.rollback()
            except Exception: pass
        try: self._raw.close()
        except Exception: pass


def _user_conn(uid, autocommit=False):
    """Connection scoped to one user's private data store."""
    if _IS_PG:
        return _Conn(schema=f'u_{int(uid)}', autocommit=autocommit)
    return _Conn(sqlite_path=os.path.join(USER_DATA_DIR, f'u_{int(uid)}.db'))


def sysdb():
    """Connection to the shared system store that holds the users table."""
    if _IS_PG:
        return _Conn(schema=None)
    return _Conn(sqlite_path=AUTH_DB_PATH)


def db():
    """Connection scoped to the currently logged-in user (set by the auth gate)."""
    uid = session.get('uid')
    if not uid:
        raise RuntimeError('db() called without an authenticated user')
    return _user_conn(uid)



def _create_app_tables(c):
    if True:
        c.execute('''CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            category TEXT DEFAULT 'general',
            done INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT
        )''')
        c.execute('''CREATE TABLE IF NOT EXISTS pet (
            id INTEGER PRIMARY KEY,
            hunger INTEGER DEFAULT 15,
            happiness INTEGER DEFAULT 40,
            total_completed INTEGER DEFAULT 0,
            streak INTEGER DEFAULT 0,
            coins INTEGER DEFAULT 0
        )''')
        c.execute('INSERT OR IGNORE INTO pet (id) VALUES (1)')
        c.execute('''CREATE TABLE IF NOT EXISTS shop_owned (
            item_id TEXT PRIMARY KEY,
            equipped INTEGER DEFAULT 1,
            purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )''')
        for migration in [
            'ALTER TABLE pet ADD COLUMN coins INTEGER DEFAULT 0',
            'ALTER TABLE goals ADD COLUMN category TEXT DEFAULT "personal"',
            'ALTER TABLE goals ADD COLUMN deadline TEXT',
            'ALTER TABLE pet ADD COLUMN freeze_tokens INTEGER DEFAULT 2',
            'ALTER TABLE pet ADD COLUMN habit_streak INTEGER DEFAULT 0',
            'ALTER TABLE pet ADD COLUMN longest_habit_streak INTEGER DEFAULT 0',
            'ALTER TABLE pet ADD COLUMN habit_history TEXT DEFAULT "[]"',
            'ALTER TABLE habits ADD COLUMN difficulty TEXT DEFAULT "medium"',
            'ALTER TABLE habits ADD COLUMN longest_streak INTEGER DEFAULT 0',
            'ALTER TABLE habits ADD COLUMN paused INTEGER DEFAULT 0',
            'ALTER TABLE habits ADD COLUMN history TEXT DEFAULT "[]"',
        ]:
            try:
                c.execute(migration)
            except Exception:
                pass

        c.execute('''CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            label TEXT DEFAULT 'personal',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')
        c.execute('''CREATE TABLE IF NOT EXISTS goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            category TEXT DEFAULT 'personal',
            deadline TEXT,
            progress INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')
        c.execute('''CREATE TABLE IF NOT EXISTS goal_milestones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            done INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')
        c.execute('''CREATE TABLE IF NOT EXISTS goal_habit_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_id INTEGER NOT NULL,
            habit_id INTEGER NOT NULL,
            UNIQUE(goal_id, habit_id)
        )''')
        c.execute('''CREATE TABLE IF NOT EXISTS habits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            difficulty TEXT DEFAULT 'medium',
            streak INTEGER DEFAULT 0,
            longest_streak INTEGER DEFAULT 0,
            last_done TEXT,
            total_checks INTEGER DEFAULT 0,
            paused INTEGER DEFAULT 0,
            history TEXT DEFAULT '[]',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')
        c.execute('''CREATE TABLE IF NOT EXISTS journal (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')
        c.execute('''CREATE TABLE IF NOT EXISTS nav_life_areas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            area TEXT NOT NULL UNIQUE,
            score INTEGER DEFAULT 50,
            icon TEXT DEFAULT '✦'
        )''')
        c.execute('''CREATE TABLE IF NOT EXISTS nav_identity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL UNIQUE,
            value TEXT DEFAULT ''
        )''')
        c.execute('''CREATE TABLE IF NOT EXISTS nav_career_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            alignment INTEGER DEFAULT 50,
            earning TEXT DEFAULT 'medium',
            fulfillment TEXT DEFAULT 'medium',
            growth_potential TEXT DEFAULT 'medium',
            is_primary INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')
        c.execute('''CREATE TABLE IF NOT EXISTS nav_passions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            strength TEXT DEFAULT 'medium',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')
        # Seed default life areas
        default_areas = [
            ('mental', 72, '🧠'), ('emotional', 75, '❤'), ('physical', 65, '⚡'),
            ('social', 58, '✦'), ('spiritual', 61, '✧'), ('financial', 48, '📈'),
        ]
        for area, score, icon in default_areas:
            c.execute('INSERT OR IGNORE INTO nav_life_areas (area, score, icon) VALUES (?,?,?)', (area, score, icon))
        # Seed default identity
        default_identity = [
            ('core_values', 'growth, creativity, kindness'),
            ('personality_type', 'introspective · curious · driven'),
            ('energy_pattern', 'most active in the evening'),
            ('love_language', 'words of affirmation'),
            ('self_awareness', '78'), ('consistency', '64'), ('growth_mindset', '72'),
        ]
        for key, val in default_identity:
            c.execute('INSERT OR IGNORE INTO nav_identity (key, value) VALUES (?,?)', (key, val))
        c.execute('''CREATE TABLE IF NOT EXISTS focus_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            duration TEXT DEFAULT '25 min',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')
        c.execute('''CREATE TABLE IF NOT EXISTS budget (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL,
            type TEXT DEFAULT 'expense',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')
        c.execute('''CREATE TABLE IF NOT EXISTS ai_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            call_type TEXT NOT NULL,
            model TEXT NOT NULL,
            prompt_tokens INTEGER DEFAULT 0,
            completion_tokens INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')
        c.commit()


def init_system():
    """Create the shared users table. Runs once at import."""
    if not _IS_PG:
        os.makedirs(USER_DATA_DIR, exist_ok=True)
    with sysdb() as c:
        c.execute('''CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')
        c.commit()


def init_user_db(uid):
    """Create (idempotently) all app tables + seeds inside a user's private store."""
    if _IS_PG:
        # autocommit so the idempotent ALTER-migrations can't poison the transaction
        c = _user_conn(uid, autocommit=True)
        try:
            c.execute(f'CREATE SCHEMA IF NOT EXISTS "u_{int(uid)}"')
            _create_app_tables(c)
        finally:
            try: c._raw.close()
            except Exception: pass
    else:
        os.makedirs(USER_DATA_DIR, exist_ok=True)
        with _user_conn(uid) as c:
            _create_app_tables(c)


def log_usage(resp, call_type: str):
    """Log token usage from a Groq completion response to ai_usage table."""
    try:
        u = resp.usage
        model = resp.model or 'unknown'
        with db() as c:
            c.execute(
                'INSERT INTO ai_usage (call_type, model, prompt_tokens, completion_tokens, total_tokens) VALUES (?,?,?,?,?)',
                (call_type, model, u.prompt_tokens, u.completion_tokens, u.total_tokens)
            )
            c.commit()
    except Exception:
        pass  # never let logging break a feature


@app.route('/api/usage')
def get_usage():
    today = datetime.now().strftime('%Y-%m-%d')
    with db() as c:
        all_rows = c.execute('SELECT * FROM ai_usage ORDER BY created_at DESC').fetchall()
        today_rows = c.execute(
            "SELECT * FROM ai_usage WHERE created_at LIKE ?", (f'{today}%',)
        ).fetchall()

    def summarise(rows):
        rows = [dict(r) for r in rows]
        total_prompt     = sum(r['prompt_tokens']     for r in rows)
        total_completion = sum(r['completion_tokens']  for r in rows)
        total            = sum(r['total_tokens']        for r in rows)
        by_type = {}
        for r in rows:
            t = r['call_type']
            if t not in by_type:
                by_type[t] = {'calls': 0, 'total_tokens': 0}
            by_type[t]['calls'] += 1
            by_type[t]['total_tokens'] += r['total_tokens']
        # Groq llama-3.1-8b-instant pricing: $0.05/1M input, $0.08/1M output
        cost_usd = (total_prompt / 1_000_000 * 0.05) + (total_completion / 1_000_000 * 0.08)
        return {
            'calls': len(rows),
            'prompt_tokens': total_prompt,
            'completion_tokens': total_completion,
            'total_tokens': total,
            'cost_usd': round(cost_usd, 6),
            'by_type': by_type,
        }

    return jsonify(
        today=summarise(today_rows),
        alltime=summarise(all_rows),
        recent=[dict(r) for r in all_rows[:20]],
    )


def pet_with_level(pet_dict):
    pet_dict['level'] = min(10, pet_dict['total_completed'] // 5 + 1)
    return pet_dict


# ── Auth ───────────────────────────────────────────────────────────────────────
_EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
# Reachable without a session. Everything else requires login.
_PUBLIC_PATHS = {'/login', '/api/auth/login', '/api/auth/register', '/api/auth/me'}


def _norm_email(e):
    return (e or '').strip().lower()


# ── Kiosk / single-device auto-login ────────────────────────────────────────────
# When KIOSK_EMAIL is set (e.g. on the Raspberry Pi build) the device signs itself
# in as that one hardcoded account on every request, so there's no login screen and
# its data lives in the same store as the web app → instant cross-device sync. The
# account is created on first use if it doesn't already exist. Both vars are unset
# on the normal web/Render deploy, so auth there behaves exactly as before.
KIOSK_EMAIL    = _norm_email(os.getenv('KIOSK_EMAIL', ''))
KIOSK_PASSWORD = os.getenv('KIOSK_PASSWORD', '')
_kiosk_uid = None


def _resolve_kiosk_uid():
    """uid of the hardcoded kiosk account, creating it once if it doesn't exist."""
    global _kiosk_uid
    if _kiosk_uid is not None:
        return _kiosk_uid
    if not KIOSK_EMAIL:
        return None
    with sysdb() as c:
        row = c.execute('SELECT id FROM users WHERE email=?', (KIOSK_EMAIL,)).fetchone()
        if row:
            uid = row['id']
        elif KIOSK_PASSWORD:
            cur = c.execute('INSERT INTO users (email, password_hash) VALUES (?,?)',
                            (KIOSK_EMAIL, generate_password_hash(KIOSK_PASSWORD)))
            c.commit()
            uid = cur.lastrowid
        else:
            return None
    init_user_db(uid)            # ensure the account's private store exists
    _kiosk_uid = uid
    return uid


@app.before_request
def _auth_gate():
    p = request.path
    if p.startswith('/static/') or p in _PUBLIC_PATHS:
        return
    if session.get('uid'):
        return
    kid = _resolve_kiosk_uid()   # Pi build: auto-login as the hardcoded account
    if kid:
        session.permanent = True
        session['uid']   = kid
        session['email'] = KIOSK_EMAIL
        return
    if p.startswith('/api/'):
        return jsonify(error='authentication required'), 401
    return redirect('/login')


@app.route('/login')
def login_page():
    if session.get('uid'):
        return redirect('/')
    return render_template('login.html')


@app.route('/api/auth/register', methods=['POST'])
def auth_register():
    d = request.json or {}
    email = _norm_email(d.get('email'))
    pw    = d.get('password') or ''
    if not _EMAIL_RE.match(email):
        return jsonify(error='enter a valid email'), 400
    if len(pw) < 6:
        return jsonify(error='password must be at least 6 characters'), 400
    with sysdb() as c:
        if c.execute('SELECT id FROM users WHERE email=?', (email,)).fetchone():
            return jsonify(error='that email is already registered'), 409
        cur = c.execute('INSERT INTO users (email, password_hash) VALUES (?,?)',
                        (email, generate_password_hash(pw)))
        c.commit()
        uid = cur.lastrowid
    init_user_db(uid)            # build this account's private data store
    session.permanent = True
    session['uid']   = uid
    session['email'] = email
    return jsonify(ok=True, email=email)


@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    d = request.json or {}
    email = _norm_email(d.get('email'))
    pw    = d.get('password') or ''
    with sysdb() as c:
        row = c.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
    if not row or not check_password_hash(row['password_hash'], pw):
        return jsonify(error='wrong email or password'), 401
    init_user_db(row['id'])      # ensure their store exists (idempotent)
    session.permanent = True
    session['uid']   = row['id']
    session['email'] = email
    return jsonify(ok=True, email=email)


@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    session.clear()
    return jsonify(ok=True)


@app.route('/api/auth/me')
def auth_me():
    if session.get('uid'):
        return jsonify(authenticated=True, email=session.get('email'))
    return jsonify(authenticated=False), 401


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/tasks')
def list_tasks():
    with db() as c:
        rows = c.execute('SELECT * FROM tasks ORDER BY created_at DESC').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/tasks', methods=['POST'])
def add_task():
    d = request.json or {}
    title = (d.get('title') or '').strip()
    cat = d.get('category', 'general')
    if not title:
        return jsonify(error='empty title'), 400
    with db() as c:
        cur = c.execute('INSERT INTO tasks (title, category) VALUES (?,?)', (title, cat))
        c.commit()
        task = dict(c.execute('SELECT * FROM tasks WHERE id=?', (cur.lastrowid,)).fetchone())
    return jsonify(task), 201


@app.route('/api/tasks/<int:tid>', methods=['PATCH'])
def toggle_task(tid):
    with db() as c:
        t = c.execute('SELECT * FROM tasks WHERE id=?', (tid,)).fetchone()
        if not t:
            return jsonify(error='not found'), 404
        new_done = 1 - t['done']
        now_str = datetime.now().isoformat()
        c.execute('UPDATE tasks SET done=?, completed_at=? WHERE id=?',
                  (new_done, now_str if new_done else None, tid))
        if new_done:
            equipped = get_equipped_items(c)
            task_coins = apply_coin_mult(10, equipped, 'task')
            c.execute('''UPDATE pet SET
                hunger = MIN(100, hunger + 18),
                happiness = MIN(100, happiness + 12),
                total_completed = total_completed + 1,
                streak = streak + 1,
                coins = coins + ?
                WHERE id=1''', (task_coins,))
        else:
            c.execute('UPDATE pet SET streak = MAX(0, streak - 1), coins = MAX(0, coins - 10) WHERE id=1')
        c.commit()
        task = dict(c.execute('SELECT * FROM tasks WHERE id=?', (tid,)).fetchone())
        pet = pet_with_level(dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone()))
    return jsonify(task=task, pet=pet)


@app.route('/api/tasks/<int:tid>', methods=['DELETE'])
def delete_task(tid):
    with db() as c:
        c.execute('DELETE FROM tasks WHERE id=?', (tid,))
        c.commit()
    return jsonify(ok=True)


@app.route('/api/tasks/clear-done', methods=['DELETE'])
def clear_done():
    with db() as c:
        c.execute('DELETE FROM tasks WHERE done=1')
        c.commit()
    return jsonify(ok=True)


@app.route('/api/pet')
def get_pet():
    with db() as c:
        pet = pet_with_level(dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone()))
    return jsonify(pet)


@app.route('/api/feed', methods=['POST'])
def feed_blob():
    with db() as c:
        pet = dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone())
        equipped = get_equipped_items(c)
        cost = 20 if 'scarf' in equipped else 30
        if pet['coins'] < cost:
            return jsonify(error='not enough coins'), 400
        c.execute('UPDATE pet SET coins = coins - ?, hunger = MIN(100, hunger + 25) WHERE id=1', (cost,))
        c.commit()
        pet = pet_with_level(dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone()))
    return jsonify(pet)


@app.route('/api/stats/today')
def today_stats():
    today = datetime.now().strftime('%Y-%m-%d')
    with db() as c:
        count = c.execute(
            "SELECT COUNT(*) FROM tasks WHERE done=1 AND completed_at LIKE ?",
            (f'{today}%',)
        ).fetchone()[0]
    return jsonify(count=count)


@app.route('/api/nudge', methods=['POST'])
def nudge():
    d = request.json or {}
    total = d.get('total_completed', 0)
    hunger = d.get('hunger', 80)
    pending = d.get('pending_tasks', 0)
    context = d.get('context', 'idle')

    stage = 0 if total < 5 else (1 if total < 20 else 2)

    personas = [
        "You are an extremely shy, timid little blob creature. Under 8 words only. Sometimes stutter (l-like this, or um...). Barely look up. Scared of everything. Very quiet.",
        "You are a cautiously friendly growing blob. Under 10 words. Getting warmer and more confident. You care about your friend.",
        "You are a super confident, bubbly blob!! Under 10 words. LOTS of energy and exclamation marks. You LOVE when tasks get done!!",
    ]

    ctx_hints = {
        'welcome': f'The user just opened the app. {pending} tasks waiting.',
        'task_added': f'User just added a new task! {pending} tasks now.',
        'task_done': f'User just completed a task! Amazing! Total done: {total}.',
        'pet_tapped': 'User tapped you! React playfully.',
        'fed': 'User just fed you! Say thank you warmly!',
        'idle': f'{pending} tasks pending. Hunger is {hunger}%.',
    }

    hunger_note = ''
    if hunger < 35:
        hunger_note = ' You are very hungry — mention needing tasks done for food!'
    elif hunger < 55:
        hunger_note = ' You are a bit hungry. Hint at wanting tasks done.'

    prompt = (
        f"{personas[stage]}{hunger_note}\n"
        f"Context: {ctx_hints.get(context, ctx_hints['idle'])}\n"
        "Say one short thing in character. No quotes."
    )

    try:
        client = _groq()
        resp = client.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[{"role": "user", "content": prompt}],
            temperature=1.1,
            max_completion_tokens=40,
            top_p=1,
            stream=False,
        )
        log_usage(resp, 'nudge')
        msg = resp.choices[0].message.content.strip().strip('"').strip("'")
    except Exception:
        fallback = [
            ['...hi', 'u-um...', 'oh...', 'it\'s cold out here...'],
            ['hey! you got this!', 'doing great!', 'keep going!'],
            ['LETS GOOO!!', "you're amazing!!", 'keep it up!!', 'yesss!!'],
        ]
        msg = random.choice(fallback[stage])

    return jsonify(message=msg, stage=stage)


@app.route('/api/pet/react', methods=['POST'])
def pet_react():
    d = request.json or {}
    event = d.get('event', 'idle')
    stats = d.get('stats', {})

    f = stats.get('familiarity', 50)
    e = stats.get('energy', 50)
    h = stats.get('happiness', 50)
    pending = stats.get('pending', 0)

    tier = ('terrified' if f < 20 else 'shy' if f < 42 else
            'cautious' if f < 65 else 'friendly' if f < 85 else 'bonded')

    # Deterministic stat effects per event
    effects_map = {
        'task_done':    {'happiness': 12, 'energy':  8, 'familiarity':  3, 'expression': 'excited'},
        'task_deleted': {'happiness':-10, 'energy': -2, 'familiarity':  0, 'expression': 'sad'},
        'fed':          {'happiness': 18, 'energy': 10, 'familiarity':  6, 'expression': 'excited'},
        'tapped':       {'happiness':  3, 'energy':  0, 'familiarity':  2, 'expression': 'curious'},
        'punched':      {'happiness': -8, 'energy': -4, 'familiarity': -1, 'expression': 'punched'},
        'shaken':       {'happiness': -4, 'energy': -3, 'familiarity':  0, 'expression': 'dizzy'},
        'task_added':   {'happiness':  4, 'energy':  0, 'familiarity':  1, 'expression': 'curious'},
        'welcome':      {'happiness':  2, 'energy':  0, 'familiarity':  1, 'expression': 'normal'},
        'idle':         {'happiness':  0, 'energy':  0, 'familiarity':  0, 'expression': 'normal'},
        'note_added':   {'happiness':  4, 'energy':  0, 'familiarity':  1, 'expression': 'curious'},
        'goal_set':     {'happiness':  6, 'energy':  3, 'familiarity':  1, 'expression': 'excited'},
        'goal_progress':{'happiness':  5, 'energy':  2, 'familiarity':  1, 'expression': 'happy'},
        'habit_checked':{'happiness':  8, 'energy':  5, 'familiarity':  2, 'expression': 'excited'},
        'journal_write':{'happiness':  6, 'energy':  0, 'familiarity':  2, 'expression': 'curious'},
        'reminder_set': {'happiness':  2, 'energy':  0, 'familiarity':  1, 'expression': 'curious'},
    }
    effects = effects_map.get(event, effects_map['idle'])

    personas = {
        'terrified': "You are an extremely shy, timid blob creature. Under 6 words. Stutter sometimes. Barely speaks. Scared of everything.",
        'shy':       "You are a shy, quiet blob. Under 7 words. Soft voice, unsure but slowly warming up.",
        'cautious':  "You are a careful, cautious blob. Under 8 words. Neutral tone. Starting to trust a little.",
        'friendly':  "You are a warm friendly blob! Under 9 words. Happy and caring.",
        'bonded':    "You are a loving excitable blob!! Under 10 words. LOVES their human! Super enthusiastic!!",
    }
    hints = {
        'task_done':    'User just completed a task! React with joy.',
        'task_deleted': 'User deleted a task. React with sadness or worry.',
        'fed':          'User just fed you! React with happiness.',
        'tapped':       'User gently tapped you. React playfully.',
        'punched':      'User punched you hard! React with pain and shock.',
        'shaken':       'User shook you violently. You are very dizzy.',
        'task_added':   f'User added a new task. {pending} tasks now.',
        'welcome':      f'User just opened the app. {pending} tasks waiting.',
        'idle':         f'Just chilling. Your happiness is {h}/100.',
        'note_added':   'User wrote a note! React with encouragement.',
        'goal_set':     'User set a new goal! React with excitement.',
        'goal_progress':'User made progress on a goal!',
        'habit_checked':'User checked in their habit! React with pride.',
        'journal_write':'User wrote a journal entry. React warmly.',
        'reminder_set': 'User set a reminder.',
    }

    prompt = (
        f"{personas[tier]}\n"
        f"Situation: {hints.get(event, hints['idle'])}\n"
        f"Your stats — happiness:{h}/100, energy:{e}/100.\n"
        "Say ONE short thing in character. No quotes. Just the words."
    )

    try:
        client = _groq()
        resp = client.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[{"role": "user", "content": prompt}],
            temperature=1.0,
            max_completion_tokens=25,
        )
        log_usage(resp, 'pet_react')
        msg = resp.choices[0].message.content.strip().strip('"').strip("'")
        if not msg:
            raise ValueError("empty")
    except Exception:
        fallbacks = {
            'terrified': {'task_done':'...g-good','task_deleted':'n-no...','fed':'th-thank you...','tapped':'eep!','punched':'ow...','shaken':'...dizzy','task_added':'o-okay','welcome':'...hi','idle':'...','note_added':'o-oh...','goal_set':'...okay!','goal_progress':'...nice','habit_checked':'g-good!','journal_write':'...sweet','reminder_set':'...okay'},
            'shy':       {'task_done':'nice work!','task_deleted':'oh no...','fed':'thank you!','tapped':'oh! hi','punched':'ow!','shaken':'dizzy...','task_added':'good!','welcome':'hey...','idle':'...','note_added':'nice note!','goal_set':'good goal!','goal_progress':'progress!','habit_checked':'good habit!','journal_write':'nice entry','reminder_set':'noted!'},
            'cautious':  {'task_done':'well done!','task_deleted':'hmm...','fed':'thanks!','tapped':'hey!','punched':'hey!!','shaken':'woah!','task_added':'okay!','welcome':'hi there','idle':'...','note_added':'cool note!','goal_set':'nice goal!','goal_progress':'keep going!','habit_checked':'good job!','journal_write':'good entry!','reminder_set':'reminder set!'},
            'friendly':  {'task_done':'yay!! great job!','task_deleted':'aww no!','fed':'nom nom!','tapped':'hehe!','punched':'ow!! rude!','shaken':'dizzyyyy~','task_added':"let's go!",'welcome':'hi!! missed you!','idle':'...','note_added':'love your notes!','goal_set':'great goal!!','goal_progress':'you got this!!','habit_checked':'habit streak!!','journal_write':'love your journal!','reminder_set':'reminder saved!'},
            'bonded':    {'task_done':'YESSS!! amazing!!','task_deleted':'NOOO!!','fed':'SO GOOD!!','tapped':'hehe love you!!','punched':'OW!! MEANIE!!','shaken':'EVERYTHING IS SPINNING','task_added':'LET\'S GOOO!!','welcome':'YOU\'RE BACK!!','idle':'hi :)','note_added':'NOTES!! LOVE IT!!','goal_set':'GOALS!! LETS GO!!','goal_progress':'MAKING PROGRESS!!','habit_checked':'HABIT STREAK!!','journal_write':'JOURNALING!! YAY!!','reminder_set':'REMINDER SET!!'},
        }
        msg = fallbacks.get(tier, fallbacks['cautious']).get(event, '...')

    return jsonify(message=msg, effects=effects)


# ── Focus ──────────────────────────────────────────────────────────────────────
@app.route('/api/focus')
def list_focus():
    with db() as c:
        rows = c.execute('SELECT * FROM focus_sessions ORDER BY created_at DESC').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/focus', methods=['POST'])
def add_focus():
    d = request.json or {}
    label = (d.get('label') or '').strip()
    duration = d.get('duration', '25 min')
    if not label:
        return jsonify(error='empty label'), 400
    with db() as c:
        cur = c.execute('INSERT INTO focus_sessions (label, duration) VALUES (?,?)', (label, duration))
        c.commit()
        session = dict(c.execute('SELECT * FROM focus_sessions WHERE id=?', (cur.lastrowid,)).fetchone())
    return jsonify(session), 201


@app.route('/api/focus/<int:sid>', methods=['DELETE'])
def delete_focus(sid):
    with db() as c:
        c.execute('DELETE FROM focus_sessions WHERE id=?', (sid,))
        c.commit()
    return jsonify(ok=True)


# ── Goals ──────────────────────────────────────────────────────────────────────
def _goal_full(c, gid):
    row = c.execute('SELECT * FROM goals WHERE id=?', (gid,)).fetchone()
    if not row:
        return None
    g = dict(row)
    milestones = [dict(m) for m in c.execute(
        'SELECT * FROM goal_milestones WHERE goal_id=? ORDER BY sort_order, created_at', (gid,)
    ).fetchall()]
    linked_habits = []
    for link in c.execute('SELECT habit_id FROM goal_habit_links WHERE goal_id=?', (gid,)).fetchall():
        h = c.execute('SELECT id, title, difficulty, streak, last_done, paused FROM habits WHERE id=?',
                      (link['habit_id'],)).fetchone()
        if h:
            linked_habits.append(dict(h))
    total = len(milestones)
    done  = sum(1 for m in milestones if m['done'])
    g['milestones']     = milestones
    g['linked_habits']  = linked_habits
    g['progress']       = int(done / total * 100) if total else g.get('progress', 0)
    g['milestone_done'] = done
    g['milestone_total']= total
    return g


@app.route('/api/goals')
def list_goals():
    with db() as c:
        rows = c.execute('SELECT id FROM goals ORDER BY created_at DESC').fetchall()
        goals = [_goal_full(c, r['id']) for r in rows]
    return jsonify([g for g in goals if g])


@app.route('/api/goals', methods=['POST'])
def add_goal():
    d = request.json or {}
    title    = (d.get('title') or '').strip()
    category = d.get('category', 'personal')
    deadline = (d.get('deadline') or '').strip() or None
    if not title:
        return jsonify(error='empty title'), 400
    with db() as c:
        cur = c.execute('INSERT INTO goals (title, category, deadline) VALUES (?,?,?)',
                        (title, category, deadline))
        c.commit()
        goal = _goal_full(c, cur.lastrowid)
    return jsonify(goal), 201


@app.route('/api/goals/<int:gid>', methods=['PATCH'])
def update_goal(gid):
    d = request.json or {}
    with db() as c:
        row = c.execute('SELECT * FROM goals WHERE id=?', (gid,)).fetchone()
        if not row:
            return jsonify(error='not found'), 404
        if 'progress' in d:
            c.execute('UPDATE goals SET progress=? WHERE id=?',
                      (max(0, min(100, int(d['progress']))), gid))
        c.commit()
        goal = _goal_full(c, gid)
    return jsonify(goal)


@app.route('/api/goals/<int:gid>', methods=['DELETE'])
def delete_goal(gid):
    with db() as c:
        c.execute('DELETE FROM goal_milestones WHERE goal_id=?', (gid,))
        c.execute('DELETE FROM goal_habit_links WHERE goal_id=?', (gid,))
        c.execute('DELETE FROM goals WHERE id=?', (gid,))
        c.commit()
    return jsonify(ok=True)


@app.route('/api/goals/<int:gid>/milestones', methods=['POST'])
def add_milestone(gid):
    d = request.json or {}
    text = (d.get('text') or '').strip()
    if not text:
        return jsonify(error='empty text'), 400
    with db() as c:
        if not c.execute('SELECT id FROM goals WHERE id=?', (gid,)).fetchone():
            return jsonify(error='goal not found'), 404
        order = (c.execute('SELECT COUNT(*) FROM goal_milestones WHERE goal_id=?', (gid,)).fetchone()[0])
        c.execute('INSERT INTO goal_milestones (goal_id, text, sort_order) VALUES (?,?,?)',
                  (gid, text, order))
        c.commit()
        goal = _goal_full(c, gid)
    return jsonify(goal)


@app.route('/api/goals/<int:gid>/milestones/<int:mid>', methods=['PATCH'])
def toggle_milestone(gid, mid):
    d = request.json or {}
    done = 1 if d.get('done') else 0
    with db() as c:
        c.execute('UPDATE goal_milestones SET done=? WHERE id=? AND goal_id=?', (done, mid, gid))
        c.commit()
        goal = _goal_full(c, gid)
    return jsonify(goal)


@app.route('/api/goals/<int:gid>/milestones/<int:mid>', methods=['DELETE'])
def delete_milestone(gid, mid):
    with db() as c:
        c.execute('DELETE FROM goal_milestones WHERE id=? AND goal_id=?', (mid, gid))
        c.commit()
        goal = _goal_full(c, gid)
    return jsonify(goal)


@app.route('/api/goals/<int:gid>/habits', methods=['POST'])
def link_habit_to_goal(gid, ):
    d = request.json or {}
    hid = d.get('habit_id')
    if not hid:
        return jsonify(error='habit_id required'), 400
    with db() as c:
        if not c.execute('SELECT id FROM goals WHERE id=?', (gid,)).fetchone():
            return jsonify(error='goal not found'), 404
        if not c.execute('SELECT id FROM habits WHERE id=?', (hid,)).fetchone():
            return jsonify(error='habit not found'), 404
        try:
            c.execute('INSERT INTO goal_habit_links (goal_id, habit_id) VALUES (?,?)', (gid, hid))
            c.commit()
        except Exception:
            pass  # already linked
        goal = _goal_full(c, gid)
    return jsonify(goal)


@app.route('/api/goals/<int:gid>/habits/<int:hid>', methods=['DELETE'])
def unlink_habit_from_goal(gid, hid):
    with db() as c:
        c.execute('DELETE FROM goal_habit_links WHERE goal_id=? AND habit_id=?', (gid, hid))
        c.commit()
        goal = _goal_full(c, gid)
    return jsonify(goal)


# ── Habits ──────────────────────────────────────────────────────────────────────
@app.route('/api/habits')
def list_habits():
    with db() as c:
        rows = c.execute('SELECT * FROM habits ORDER BY created_at DESC').fetchall()
    return jsonify([dict(r) for r in rows])


COIN_BY_DIFFICULTY = {'easy': 1, 'medium': 3, 'hard': 5}

# ── Shop ──────────────────────────────────────────────────────────────────────
SHOP_CATALOG = [
    # ── Common ──────────────────────────────────────────────────────────────
    {'id': 'bow',         'name': 'Bow',          'price': 30,  'tier': 'common',
     'effect': 'cosmetic',         'label': 'purely adorable',              'flavor': 'sometimes cute is enough'},
    {'id': 'sunglasses',  'name': 'Sunglasses',   'price': 50,  'tier': 'common',
     'effect': 'familiarity_bonus','label': '+1 familiarity per chat',      'flavor': 'confidence boost — blob warms up faster'},
    {'id': 'cat_ears',    'name': 'Cat Ears',      'price': 40,  'tier': 'common',
     'effect': 'cosmetic',         'label': 'meow energy only',             'flavor': 'some days you just need the ears'},
    {'id': 'flower',      'name': 'Flower',        'price': 35,  'tier': 'common',
     'effect': 'cosmetic',         'label': 'blooming adorable',            'flavor': 'bloom wherever you are'},
    # ── Rare ────────────────────────────────────────────────────────────────
    {'id': 'lucky_charm', 'name': 'Lucky Charm',  'price': 60,  'tier': 'rare',
     'effect': 'task_coins',       'label': 'task coins ×1.5',              'flavor': 'fortune follows focus'},
    {'id': 'party_hat',   'name': 'Party Hat',     'price': 45,  'tier': 'rare',
     'effect': 'streak_threshold', 'label': 'streak bonus at day 3',        'flavor': 'celebrate every win, not just the big ones'},
    {'id': 'monocle',     'name': 'Monocle',       'price': 70,  'tier': 'rare',
     'effect': 'task_bonus',       'label': '+3 coins per task',            'flavor': 'a refined eye for productivity'},
    {'id': 'top_hat',     'name': 'Top Hat',       'price': 65,  'tier': 'rare',
     'effect': 'task_bonus_2',     'label': '+2 coins per task',            'flavor': 'class and productivity go hand in hand'},
    {'id': 'scarf',       'name': 'Scarf',         'price': 55,  'tier': 'rare',
     'effect': 'hunger_save',      'label': 'feed blob for 20 coins',       'flavor': 'warmth costs less when you care'},
    # ── Epic ────────────────────────────────────────────────────────────────
    {'id': 'headphones',  'name': 'Headphones',    'price': 80,  'tier': 'epic',
     'effect': 'habit_coins',      'label': 'habit coins ×1.5',             'flavor': 'deep work energy — habits feel more rewarding'},
    {'id': 'frost_badge', 'name': 'Frost Badge',   'price': 100, 'tier': 'epic',
     'effect': 'freeze_tokens',    'label': '+2 habit freeze tokens',       'flavor': 'protect your streak on bad days'},
    {'id': 'wizard_hat',  'name': 'Wizard Hat',    'price': 130, 'tier': 'epic',
     'effect': 'habit_coins_x2',   'label': 'habit coins ×2',               'flavor': 'ancient magic makes every habit legendary'},
    {'id': 'devil_horns', 'name': 'Devil Horns',   'price': 140, 'tier': 'epic',
     'effect': 'global_flat',      'label': '+5 coins on every action',     'flavor': 'a little chaos never hurt anyone'},
    {'id': 'angel_wings', 'name': 'Angel Wings',   'price': 120, 'tier': 'epic',
     'effect': 'familiarity_bonus','label': '+1 familiarity per chat',      'flavor': 'pure light opens every heart faster'},
    # ── Legendary ───────────────────────────────────────────────────────────
    {'id': 'hero_cape',   'name': 'Hero Cape',     'price': 150, 'tier': 'legendary',
     'effect': 'global_coins',     'label': 'all coins ×1.25',              'flavor': 'heroes earn more, always'},
    {'id': 'crown',       'name': 'Crown',         'price': 240, 'tier': 'legendary',
     'effect': 'global_coins_x15', 'label': 'all coins ×1.5',               'flavor': 'royalty earns in kind'},
    {'id': 'halo',        'name': 'Halo',          'price': 300, 'tier': 'legendary',
     'effect': 'familiarity_x2',   'label': '+2 familiarity per chat',      'flavor': 'pure light accelerates every bond'},
    {'id': 'dragon_wings','name': 'Dragon Wings',  'price': 260, 'tier': 'legendary',
     'effect': 'global_flat_10',   'label': '+10 coins every action',       'flavor': 'primal power follows those who earn it'},
]
SHOP_IDS = {item['id'] for item in SHOP_CATALOG}

def get_equipped_items(c):
    rows = c.execute('SELECT item_id FROM shop_owned WHERE equipped=1').fetchall()
    return {r['item_id'] for r in rows}

def apply_coin_mult(coins, equipped, coin_type='general'):
    if coin_type == 'task'  and 'lucky_charm'  in equipped: coins = int(coins * 1.5)
    if coin_type == 'task'  and 'monocle'      in equipped: coins = coins + 3
    if coin_type == 'task'  and 'top_hat'      in equipped: coins = coins + 2
    if coin_type == 'habit' and 'headphones'   in equipped: coins = int(coins * 1.5)
    if coin_type == 'habit' and 'wizard_hat'   in equipped: coins = int(coins * 2)
    if 'devil_horns'  in equipped: coins = coins + 5
    if 'dragon_wings' in equipped: coins = coins + 10
    if 'hero_cape'    in equipped: coins = int(coins * 1.25)
    if 'crown'        in equipped: coins = int(coins * 1.5)
    return coins


@app.route('/api/habits', methods=['POST'])
def add_habit():
    d = request.json or {}
    title = (d.get('title') or '').strip()
    difficulty = d.get('difficulty', 'medium')
    if difficulty not in ('easy', 'medium', 'hard'):
        difficulty = 'medium'
    if not title:
        return jsonify(error='empty title'), 400
    with db() as c:
        cur = c.execute('INSERT INTO habits (title, difficulty) VALUES (?,?)', (title, difficulty))
        c.commit()
        habit = dict(c.execute('SELECT * FROM habits WHERE id=?', (cur.lastrowid,)).fetchone())
    return jsonify(habit), 201


@app.route('/api/habits/<int:hid>/check', methods=['POST'])
def check_habit(hid):
    today = datetime.now().strftime('%Y-%m-%d')
    with db() as c:
        habit = c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone()
        if not habit:
            return jsonify(error='not found'), 404
        habit = dict(habit)
        if habit.get('paused'):
            return jsonify(error='habit is paused'), 400
        last = (habit['last_done'] or '')[:10]
        if last == today:
            return jsonify(habit), 200  # already checked today
        new_streak = habit['streak'] + 1
        new_longest = max(habit.get('longest_streak') or 0, new_streak)
        new_total = habit['total_checks'] + 1

        # Update history (keep last 30 days)
        try:
            history = json.loads(habit.get('history') or '[]')
        except Exception:
            history = []
        if today not in history:
            history.append(today)
        history = sorted(history)[-30:]

        # Coin reward with streak multiplier + shop bonuses
        equipped = get_equipped_items(c)
        base_coins = COIN_BY_DIFFICULTY.get(habit.get('difficulty', 'medium'), 3)
        streak_threshold = 3 if 'party_hat' in equipped else 7
        multiplier = 1.5 if new_streak >= streak_threshold else 1.0
        coins_earned = apply_coin_mult(int(base_coins * multiplier), equipped, 'habit')

        c.execute(
            'UPDATE habits SET streak=?, longest_streak=?, last_done=?, total_checks=?, history=? WHERE id=?',
            (new_streak, new_longest, today, new_total, json.dumps(history), hid)
        )

        # Update pet habit streak (consecutive days with at least one habit done)
        pet = dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone())
        try:
            h_history = json.loads(pet.get('habit_history') or '[]')
        except Exception:
            h_history = []
        if today not in h_history:
            h_history.append(today)
        h_history = sorted(h_history)[-30:]
        new_h_streak = _calc_consecutive_streak(h_history)
        new_longest_h = max(pet.get('longest_habit_streak', 0), new_h_streak)
        c.execute(
            'UPDATE pet SET coins=coins+?, habit_streak=?, longest_habit_streak=?, habit_history=? WHERE id=1',
            (coins_earned, new_h_streak, new_longest_h, json.dumps(h_history))
        )
        c.commit()
        habit = dict(c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone())
        pet = dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone())
    return jsonify(habit=habit, pet=pet_with_level(pet), coins_earned=coins_earned)


def _calc_consecutive_streak(sorted_dates):
    if not sorted_dates:
        return 0
    today = datetime.now().strftime('%Y-%m-%d')
    streak = 0
    date_set = set(sorted_dates)
    from datetime import timedelta, date as dt_date
    d = dt_date.fromisoformat(today)
    while d.isoformat() in date_set:
        streak += 1
        d -= timedelta(days=1)
    return streak


@app.route('/api/habits/<int:hid>/uncheck', methods=['POST'])
def uncheck_habit(hid):
    today = datetime.now().strftime('%Y-%m-%d')
    with db() as c:
        habit = c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone()
        if not habit:
            return jsonify(error='not found'), 404
        habit = dict(habit)
        if (habit['last_done'] or '')[:10] != today:
            return jsonify(error='not checked today'), 400
        new_streak = max(0, habit['streak'] - 1)
        new_total  = max(0, habit['total_checks'] - 1)
        try:
            history = json.loads(habit.get('history') or '[]')
        except Exception:
            history = []
        history = [d for d in history if d != today]
        coins_back = COIN_BY_DIFFICULTY.get(habit.get('difficulty', 'medium'), 3)
        c.execute(
            'UPDATE habits SET streak=?, last_done=?, total_checks=?, history=? WHERE id=?',
            (new_streak, history[-1] if history else None, new_total, json.dumps(history), hid)
        )
        c.execute('UPDATE pet SET coins=MAX(0,coins-?) WHERE id=1', (coins_back,))
        # Recalc pet habit streak from updated history
        pet = dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone())
        try:
            h_history = json.loads(pet.get('habit_history') or '[]')
        except Exception:
            h_history = []
        h_history = [d for d in h_history if d != today]
        new_h_streak = _calc_consecutive_streak(h_history)
        c.execute('UPDATE pet SET habit_streak=?, habit_history=? WHERE id=1',
                  (new_h_streak, json.dumps(h_history)))
        c.commit()
        habit = dict(c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone())
        pet   = pet_with_level(dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone()))
    return jsonify(habit=habit, pet=pet)


@app.route('/api/habits/<int:hid>/pause', methods=['POST'])
def pause_habit(hid):
    with db() as c:
        habit = c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone()
        if not habit:
            return jsonify(error='not found'), 404
        new_paused = 0 if habit['paused'] else 1
        c.execute('UPDATE habits SET paused=? WHERE id=?', (new_paused, hid))
        c.commit()
        habit = dict(c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone())
    return jsonify(habit)


@app.route('/api/habits/<int:hid>/freeze', methods=['POST'])
def freeze_habit(hid):
    with db() as c:
        pet = c.execute('SELECT * FROM pet WHERE id=1').fetchone()
        if not pet or (pet['freeze_tokens'] or 0) < 1:
            return jsonify(error='no freeze tokens'), 400
        habit = c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone()
        if not habit:
            return jsonify(error='not found'), 404
        habit = dict(habit)
        from datetime import timedelta
        yesterday = (datetime.now().date() - timedelta(days=1)).isoformat()
        today = datetime.now().strftime('%Y-%m-%d')
        last = (habit['last_done'] or '')[:10]
        # Only useful if habit was missed yesterday (streak would break today)
        if last != yesterday and last != today:
            return jsonify(error='freeze only works for a missed yesterday'), 400
        # Inject yesterday into history and preserve streak
        try:
            history = json.loads(habit.get('history') or '[]')
        except Exception:
            history = []
        if yesterday not in history:
            history.append(yesterday)
        history = sorted(history)[-30:]
        c.execute('UPDATE habits SET last_done=?, history=? WHERE id=?',
                  (yesterday, json.dumps(history), hid))
        c.execute('UPDATE pet SET freeze_tokens=freeze_tokens-1 WHERE id=1')
        c.commit()
        habit = dict(c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone())
        pet = pet_with_level(dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone()))
    return jsonify(habit=habit, pet=pet)


@app.route('/api/habits/streak')
def habit_streak_info():
    with db() as c:
        pet = dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone())
        try:
            h_history = json.loads(pet.get('habit_history') or '[]')
        except Exception:
            h_history = []
        # Weekly dots (Mon-Sun of current week)
        from datetime import date, timedelta
        today = date.today()
        week_start = today - timedelta(days=today.weekday())  # Monday
        week_days = [(week_start + timedelta(days=i)).isoformat() for i in range(7)]
        week_done = [d in h_history for d in week_days]
        equipped = get_equipped_items(c)
        bonus_freezes = 2 if 'frost_badge' in equipped else 0
    return jsonify(
        habit_streak=pet.get('habit_streak', 0),
        longest_habit_streak=pet.get('longest_habit_streak', 0),
        freeze_tokens=(pet.get('freeze_tokens', 2) + bonus_freezes),
        week_days=week_days,
        week_done=week_done,
    )


@app.route('/api/habits/<int:hid>', methods=['DELETE'])
def delete_habit(hid):
    with db() as c:
        c.execute('DELETE FROM habits WHERE id=?', (hid,))
        c.commit()
    return jsonify(ok=True)


# ── Journal ──────────────────────────────────────────────────────────────────────
@app.route('/api/journal')
def list_journal():
    with db() as c:
        rows = c.execute('SELECT * FROM journal ORDER BY created_at DESC').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/journal', methods=['POST'])
def add_journal():
    d = request.json or {}
    text = (d.get('text') or '').strip()
    if not text:
        return jsonify(error='empty text'), 400
    with db() as c:
        cur = c.execute('INSERT INTO journal (text) VALUES (?)', (text,))
        c.commit()
        entry = dict(c.execute('SELECT * FROM journal WHERE id=?', (cur.lastrowid,)).fetchone())
    return jsonify(entry), 201


@app.route('/api/journal/<int:jid>', methods=['DELETE'])
def delete_journal(jid):
    with db() as c:
        c.execute('DELETE FROM journal WHERE id=?', (jid,))
        c.commit()
    return jsonify(ok=True)


# ── Budget ──────────────────────────────────────────────────────────────────────
@app.route('/api/budget')
def list_budget():
    with db() as c:
        rows = c.execute('SELECT * FROM budget ORDER BY created_at DESC').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/budget', methods=['POST'])
def add_budget():
    d = request.json or {}
    description = (d.get('description') or '').strip()
    entry_type = d.get('type', 'expense')
    if not description:
        return jsonify(error='empty description'), 400
    with db() as c:
        cur = c.execute('INSERT INTO budget (description, type) VALUES (?,?)', (description, entry_type))
        c.commit()
        entry = dict(c.execute('SELECT * FROM budget WHERE id=?', (cur.lastrowid,)).fetchone())
    return jsonify(entry), 201


@app.route('/api/budget/<int:bid>', methods=['DELETE'])
def delete_budget(bid):
    with db() as c:
        c.execute('DELETE FROM budget WHERE id=?', (bid,))
        c.commit()
    return jsonify(ok=True)


# ── Navigation ────────────────────────────────────────────────────────────────
@app.route('/api/navigation')
def get_navigation():
    with db() as c:
        areas     = [dict(r) for r in c.execute('SELECT * FROM nav_life_areas ORDER BY id').fetchall()]
        identity  = {r['key']: r['value'] for r in c.execute('SELECT key, value FROM nav_identity').fetchall()}
        careers   = [dict(r) for r in c.execute('SELECT * FROM nav_career_paths ORDER BY is_primary DESC, created_at').fetchall()]
        passions  = [dict(r) for r in c.execute('SELECT * FROM nav_passions ORDER BY created_at').fetchall()]
    return jsonify(areas=areas, identity=identity, careers=careers, passions=passions)


@app.route('/api/navigation/life-areas', methods=['PUT'])
def update_life_area():
    d = request.json or {}
    area  = d.get('area', '').strip()
    score = int(d.get('score', 50))
    score = max(0, min(100, score))
    if not area:
        return jsonify(error='area required'), 400
    with db() as c:
        c.execute('UPDATE nav_life_areas SET score=? WHERE area=?', (score, area))
        c.commit()
    return jsonify(ok=True)


@app.route('/api/navigation/identity', methods=['PUT'])
def update_identity():
    d = request.json or {}
    key   = d.get('key', '').strip()
    value = d.get('value', '').strip()
    if not key:
        return jsonify(error='key required'), 400
    with db() as c:
        c.execute('INSERT INTO nav_identity (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, value))
        c.commit()
    return jsonify(ok=True)


@app.route('/api/navigation/career-paths', methods=['POST'])
def add_career_path():
    d = request.json or {}
    title = (d.get('title') or '').strip()
    if not title:
        return jsonify(error='title required'), 400
    alignment       = max(0, min(100, int(d.get('alignment', 50))))
    earning         = d.get('earning', 'medium')
    fulfillment     = d.get('fulfillment', 'medium')
    growth_potential = d.get('growth_potential', 'medium')
    with db() as c:
        cur = c.execute(
            'INSERT INTO nav_career_paths (title, alignment, earning, fulfillment, growth_potential) VALUES (?,?,?,?,?)',
            (title, alignment, earning, fulfillment, growth_potential)
        )
        c.commit()
        row = dict(c.execute('SELECT * FROM nav_career_paths WHERE id=?', (cur.lastrowid,)).fetchone())
    return jsonify(row), 201


@app.route('/api/navigation/career-paths/<int:cid>', methods=['DELETE'])
def delete_career_path(cid):
    with db() as c:
        c.execute('DELETE FROM nav_career_paths WHERE id=?', (cid,))
        c.commit()
    return jsonify(ok=True)


@app.route('/api/navigation/career-paths/<int:cid>/primary', methods=['POST'])
def set_primary_career(cid):
    with db() as c:
        c.execute('UPDATE nav_career_paths SET is_primary=0')
        c.execute('UPDATE nav_career_paths SET is_primary=1 WHERE id=?', (cid,))
        c.commit()
    return jsonify(ok=True)


@app.route('/api/navigation/passions', methods=['POST'])
def add_passion():
    d = request.json or {}
    title    = (d.get('title') or '').strip()
    strength = d.get('strength', 'medium')
    if strength not in ('strong', 'medium', 'weak'):
        strength = 'medium'
    if not title:
        return jsonify(error='title required'), 400
    with db() as c:
        cur = c.execute('INSERT INTO nav_passions (title, strength) VALUES (?,?)', (title, strength))
        c.commit()
        row = dict(c.execute('SELECT * FROM nav_passions WHERE id=?', (cur.lastrowid,)).fetchone())
    return jsonify(row), 201


@app.route('/api/navigation/passions/<int:pid>', methods=['DELETE'])
def delete_passion(pid):
    with db() as c:
        c.execute('DELETE FROM nav_passions WHERE id=?', (pid,))
        c.commit()
    return jsonify(ok=True)

@app.route('/api/navigation/analyze', methods=['POST'])
def analyze_navigation():
    with db() as c:
        tasks       = [dict(r) for r in c.execute('SELECT title, category, done FROM tasks ORDER BY created_at DESC LIMIT 40').fetchall()]
        habits      = [dict(r) for r in c.execute('SELECT title, difficulty, streak, total_checks, paused FROM habits').fetchall()]
        goals       = [dict(r) for r in c.execute('SELECT title, progress FROM goals').fetchall()]
        journal     = [r[0] for r in c.execute('SELECT text FROM journal ORDER BY created_at DESC LIMIT 10').fetchall()]
        focus       = [r[0] for r in c.execute('SELECT label FROM focus_sessions ORDER BY created_at DESC LIMIT 15').fetchall()]
        pet         = dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone())

    pet_info = pet_with_level(pet)
    completed_cats = [t['category'] for t in tasks if t['done']]
    all_cats       = [t['category'] for t in tasks]

    data_summary = f"""
TASKS ({len(tasks)} total, {sum(1 for t in tasks if t['done'])} completed):
Categories done: {', '.join(completed_cats[:20]) or 'none'}
All categories: {', '.join(all_cats[:20]) or 'none'}
Recent task titles: {', '.join(t['title'] for t in tasks[:15])}

HABITS ({len(habits)} habits):
{chr(10).join(f"- {h['title']} ({h['difficulty']}, {h['streak']} day streak, {h['total_checks']} total check-ins)" for h in habits) or 'none'}

GOALS:
{chr(10).join(f"- {g['title']} ({g['progress']}% complete)" for g in goals) or 'none'}

JOURNAL ENTRIES (recent):
{chr(10).join(f'- {j[:120]}' for j in journal[:6]) or 'none'}

FOCUS SESSION LABELS:
{', '.join(focus[:12]) or 'none'}

PET STATS:
Level {pet_info['level']}, streak {pet['streak']}, coins {pet['coins']}, happiness {pet['happiness']}%
"""

    system_prompt = """You are a personal growth analyst AI embedded in a productivity app called "blob".
Analyze the user's real activity data below and generate an honest, insightful navigation profile.
Base every value on patterns actually visible in the data — don't be generic.

Return ONLY valid JSON (no markdown, no explanation) with exactly this structure:
{
  "life_areas": {
    "mental": 0-100,
    "emotional": 0-100,
    "physical": 0-100,
    "social": 0-100,
    "spiritual": 0-100,
    "financial": 0-100
  },
  "identity": {
    "self_awareness": 0-100,
    "consistency": 0-100,
    "growth_mindset": 0-100,
    "core_values": "2-4 short values e.g. growth, creativity, discipline",
    "personality_type": "3 traits separated by · e.g. analytical · creative · driven",
    "energy_pattern": "one short line e.g. most productive in the evenings",
    "love_language": "one of: words of affirmation, quality time, acts of service, physical touch, receiving gifts"
  },
  "career_paths": [
    {"title": "Career Title", "alignment": 0-100, "earning": "high/medium/low", "fulfillment": "high/medium/low", "growth_potential": "very high/high/medium/low", "is_primary": true}
  ],
  "passions": [
    {"title": "passion or interest", "strength": "strong/medium/weak"}
  ],
  "insight": "2-3 sentences of honest personal growth insight based on the data"
}

Rules:
- career_paths: 3-5 entries, exactly ONE must have is_primary: true
- passions: 3-6 entries inferred from task categories, focus labels, habit choices
- life_areas: infer from habit types (physical habits → physical score), journal sentiment (emotional score), task variety (mental), social tasks/goals, etc.
- consistency score = habit adherence + task completion rate
- growth_mindset = variety of goals + new habits tried
- Be specific to THIS user's data, not generic"""

    try:
        client = _groq()
        resp = client.chat.completions.create(
            model='openai/gpt-oss-20b',
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user',   'content': data_summary},
            ],
            temperature=0.7,
            max_completion_tokens=900,
            stream=False,
        )
        log_usage(resp, 'navigation_analyze')
        raw = resp.choices[0].message.content or ''
        # Strip any markdown fences
        raw = raw.strip()
        if raw.startswith('```'):
            raw = raw.split('```')[1]
            if raw.startswith('json'):
                raw = raw[4:]
        raw = raw.strip().rstrip('`').strip()
        profile = json.loads(raw)
    except Exception as exc:
        log.error('Navigation analyze error: %s', exc)
        return jsonify(error='AI analysis failed, try again'), 500

    now = datetime.now().isoformat()
    with db() as c:
        # Update life areas
        for area, score in profile.get('life_areas', {}).items():
            c.execute('UPDATE nav_life_areas SET score=? WHERE area=?', (int(score), area))

        # Update identity
        for key, val in profile.get('identity', {}).items():
            c.execute('INSERT INTO nav_identity (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, str(val)))
        c.execute('INSERT INTO nav_identity (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ('last_analyzed', now))
        c.execute('INSERT INTO nav_identity (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ('insight', profile.get('insight', '')))

        # Replace career paths
        c.execute('DELETE FROM nav_career_paths')
        for cp in profile.get('career_paths', []):
            c.execute(
                'INSERT INTO nav_career_paths (title, alignment, earning, fulfillment, growth_potential, is_primary) VALUES (?,?,?,?,?,?)',
                (cp['title'], int(cp.get('alignment', 50)), cp.get('earning','medium'),
                 cp.get('fulfillment','medium'), cp.get('growth_potential','medium'),
                 1 if cp.get('is_primary') else 0)
            )

        # Replace passions
        c.execute('DELETE FROM nav_passions')
        for p in profile.get('passions', []):
            c.execute('INSERT INTO nav_passions (title, strength) VALUES (?,?)', (p['title'], p.get('strength','medium')))

        c.commit()

        # Return fresh navigation data
        areas    = [dict(r) for r in c.execute('SELECT * FROM nav_life_areas ORDER BY id').fetchall()]
        identity = {r['key']: r['value'] for r in c.execute('SELECT key, value FROM nav_identity').fetchall()}
        careers  = [dict(r) for r in c.execute('SELECT * FROM nav_career_paths ORDER BY is_primary DESC, created_at').fetchall()]
        passions = [dict(r) for r in c.execute('SELECT * FROM nav_passions ORDER BY created_at').fetchall()]

    return jsonify(areas=areas, identity=identity, careers=careers, passions=passions)

# ── Memories ──────────────────────────────────────────────────────────────────
@app.route('/api/memories')
def get_memories():
    with db() as c:
        journal_rows = c.execute(
            'SELECT * FROM journal ORDER BY created_at DESC LIMIT 5'
        ).fetchall()
        completed_rows = c.execute(
            'SELECT * FROM tasks WHERE done=1 ORDER BY completed_at DESC LIMIT 8'
        ).fetchall()
    return jsonify(
        journal=[dict(r) for r in journal_rows],
        completed=[dict(r) for r in completed_rows]
    )

# ── Achievements ──────────────────────────────────────────────────────────────
@app.route('/api/achievements', methods=['POST'])
def get_achievements():
    d = request.json or {}
    familiarity = int(d.get('familiarity', 0))

    with db() as c:
        tasks_done = c.execute('SELECT COUNT(*) FROM tasks WHERE done=1').fetchone()[0]
        streak     = (c.execute('SELECT streak FROM pet WHERE id=1').fetchone() or [0])[0]
        coins      = (c.execute('SELECT coins FROM pet WHERE id=1').fetchone() or [0])[0]
        pet_level  = pet_with_level(dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone()))['level']
        goal_count = c.execute('SELECT COUNT(*) FROM goals').fetchone()[0]
        goal_100   = c.execute('SELECT COUNT(*) FROM goals WHERE progress=100').fetchone()[0]
        habit_checks = c.execute('SELECT COALESCE(SUM(total_checks),0) FROM habits').fetchone()[0]
        journal_count = c.execute('SELECT COUNT(*) FROM journal').fetchone()[0]
        focus_count = c.execute('SELECT COUNT(*) FROM focus_sessions').fetchone()[0]
        budget_count = c.execute('SELECT COUNT(*) FROM budget').fetchone()[0]

    all_achievements = [
        {'id':'first_task',    'name':'First Step',      'icon':'leaf',    'color':'#4ade80', 'desc':'Complete your first task',    'unlocked': tasks_done >= 1},
        {'id':'five_tasks',    'name':'Getting Going',   'icon':'bolt',    'color':'#facc15', 'desc':'Complete 5 tasks',            'unlocked': tasks_done >= 5},
        {'id':'twenty_tasks',  'name':'Productive',      'icon':'trendUp', 'color':'#60a5fa', 'desc':'Complete 20 tasks',           'unlocked': tasks_done >= 20},
        {'id':'streak_3',      'name':'On a Roll',       'icon':'flame',   'color':'#f97316', 'desc':'3 task streak',               'unlocked': streak >= 3},
        {'id':'streak_10',     'name':'Unstoppable',     'icon':'sparkle', 'color':'#fb923c', 'desc':'10 task streak',              'unlocked': streak >= 10},
        {'id':'coin_100',      'name':'Coin Collector',  'icon':'coin',    'color':'#f59e0b', 'desc':'Earn 100 coins',              'unlocked': coins >= 100},
        {'id':'focus_starter', 'name':'In the Zone',     'icon':'bolt',    'color':'#34d399', 'desc':'Log your first focus session','unlocked': focus_count >= 1},
        {'id':'goal_setter',   'name':'Goal Setter',     'icon':'diamond', 'color':'#a78bfa', 'desc':'Set your first goal',         'unlocked': goal_count >= 1},
        {'id':'goal_crusher',  'name':'Goal Crusher',    'icon':'star',    'color':'#f59e0b', 'desc':'100% a goal',                 'unlocked': goal_100 >= 1},
        {'id':'habit_builder', 'name':'Habit Builder',   'icon':'refresh', 'color':'#818cf8', 'desc':'Check in 7 times total',      'unlocked': habit_checks >= 7},
        {'id':'journaler',     'name':'Journaler',       'icon':'brain',   'color':'#f472b6', 'desc':'Write 3 journal entries',     'unlocked': journal_count >= 3},
        {'id':'best_friends',  'name':'Best Friends',    'icon':'heart',   'color':'#ec4899', 'desc':'Reach familiarity 85+',       'unlocked': familiarity >= 85},
        {'id':'level_5',       'name':'Level 5',         'icon':'star',    'color':'#a78bfa', 'desc':'Reach level 5',               'unlocked': pet_level >= 5},
        {'id':'budget_tracker','name':'Money Minded',    'icon':'piggy',   'color':'#60a5fa', 'desc':'Log your first transaction',  'unlocked': budget_count >= 1},
    ]

    # Sort: unlocked first, then locked
    all_achievements.sort(key=lambda a: (0 if a['unlocked'] else 1))
    return jsonify(all_achievements)

# ── Skill registry ────────────────────────────────────────────────────────────
# To add a new skill: (1) append an entry here, (2) handle the name in execute_skill below.
# exec_type 'immediate' = executes on the spot; 'proposed' = shown to user for confirmation.
# Use __CATS__ as a placeholder in descriptions; _build_tools() substitutes it at call time.
_SKILL_REGISTRY = [
    {
        'name': 'create_task',
        'exec_type': 'proposed',
        'description': 'Add a new to-do item. Use when the user wants to track, remember, schedule, or add any task, chore, errand, or commitment. PROPOSED.',
        'parameters': {'type': 'object', 'required': ['title'], 'properties': {
            'title':    {'type': 'string', 'description': 'Exact task title as the user described it'},
            'category': {'type': 'string', 'description': 'Best-fit category. Known: __CATS__. Can be a new name the user specified.'},
        }},
    },
    {
        'name': 'delete_task',
        'exec_type': 'proposed',
        'description': 'Permanently remove a task. Use when the user wants to delete, remove, cancel, or drop a task. PROPOSED.',
        'parameters': {'type': 'object', 'required': ['task_id'], 'properties': {
            'task_id': {'type': 'integer', 'description': 'ID of the task to remove'},
        }},
    },
    {
        'name': 'complete_task',
        'exec_type': 'proposed',
        'description': 'Mark a task done or undo a completion. Use when the user finishes, checks off, or wants to unmark a task. PROPOSED.',
        'parameters': {'type': 'object', 'required': ['task_id', 'done'], 'properties': {
            'task_id': {'type': 'integer', 'description': 'ID of the task'},
            'done':    {'type': 'boolean', 'description': 'true = mark complete, false = unmark'},
        }},
    },
    {
        'name': 'update_task',
        'exec_type': 'proposed',
        'description': "Edit a task's title or move it to a different category. Use when the user wants to rename, reword, or recategorize a task. PROPOSED.",
        'parameters': {'type': 'object', 'required': ['task_id'], 'properties': {
            'task_id':  {'type': 'integer', 'description': 'ID of the task to edit'},
            'title':    {'type': 'string',  'description': 'New title (omit to keep current)'},
            'category': {'type': 'string',  'description': 'New category. Known: __CATS__. Can be a new name.'},
        }},
    },
    {
        'name': 'start_focus',
        'exec_type': 'immediate',
        'description': (
            'Begin a Pomodoro work/break cycle. Use when the user wants to start focused work, '
            'run a timer, do a pomodoro, or concentrate on a task. '
            'Optional: link to a task, set custom work/break durations. IMMEDIATE.'
        ),
        'parameters': {'type': 'object', 'required': [], 'properties': {
            'task_id':       {'type': 'integer', 'description': 'Task to focus on (omit for a free session)'},
            'label':         {'type': 'string',  'description': 'Session label when no task_id given'},
            'work_minutes':  {'type': 'integer', 'description': 'Work phase length in minutes (default 25)'},
            'short_minutes': {'type': 'integer', 'description': 'Short break length in minutes (default 5)'},
            'long_minutes':  {'type': 'integer', 'description': 'Long break length in minutes (default 15)'},
        }},
    },
    {
        'name': 'pause_focus',
        'exec_type': 'immediate',
        'description': (
            'Pause the running focus timer without ending the session. Use when the user wants to pause, '
            'hold, or temporarily stop the clock. Only valid when a session is active and not already paused. IMMEDIATE.'
        ),
        'parameters': {'type': 'object', 'required': [], 'properties': {}},
    },
    {
        'name': 'resume_focus',
        'exec_type': 'immediate',
        'description': (
            'Resume a paused focus timer. Use when the user wants to continue, unpause, or restart a paused session. '
            'Only valid when a session is paused. IMMEDIATE.'
        ),
        'parameters': {'type': 'object', 'required': [], 'properties': {}},
    },
    {
        'name': 'stop_focus',
        'exec_type': 'immediate',
        'description': (
            'End the current focus session permanently. Use when the user wants to stop, quit, cancel, or end the timer entirely '
            '(not just pause). Only valid when a session is active. IMMEDIATE.'
        ),
        'parameters': {'type': 'object', 'required': [], 'properties': {}},
    },
    {
        'name': 'skip_focus',
        'exec_type': 'immediate',
        'description': (
            'Jump to the next phase of the focus cycle (work→break or break→work). Use when the user wants to skip, '
            'advance, or move to the next phase early. Only valid when a session is active. IMMEDIATE.'
        ),
        'parameters': {'type': 'object', 'required': [], 'properties': {}},
    },
    {
        'name': 'add_habit',
        'exec_type': 'proposed',
        'description': (
            'Create a new recurring habit to track. Use when the user wants to build, start, or track a habit, '
            'routine, or daily practice. PROPOSED.'
        ),
        'parameters': {'type': 'object', 'required': ['title'], 'properties': {
            'title':      {'type': 'string', 'description': 'Habit name as the user described it'},
            'difficulty': {'type': 'string', 'enum': ['easy', 'medium', 'hard'],
                           'description': 'How hard the habit is — easy, medium, or hard. Infer from context.'},
        }},
    },
    {
        'name': 'check_habit',
        'exec_type': 'immediate',
        'description': (
            'Mark a habit as done for today. Use when the user says they did, completed, finished, or checked off '
            'a habit, or wants to log their progress on it. IMMEDIATE.'
        ),
        'parameters': {'type': 'object', 'required': ['habit_id'], 'properties': {
            'habit_id': {'type': 'integer', 'description': 'ID of the habit to check in'},
        }},
    },
    {
        'name': 'remove_habit',
        'exec_type': 'proposed',
        'description': (
            'Permanently delete a habit. Use when the user wants to remove, delete, stop tracking, or drop a habit. PROPOSED.'
        ),
        'parameters': {'type': 'object', 'required': ['habit_id'], 'properties': {
            'habit_id': {'type': 'integer', 'description': 'ID of the habit to remove'},
        }},
    },
    {
        'name': 'pause_habit',
        'exec_type': 'proposed',
        'description': (
            'Pause or resume a habit. Use when the user wants to pause, put on hold, temporarily stop, '
            'or resume/restart a paused habit. PROPOSED.'
        ),
        'parameters': {'type': 'object', 'required': ['habit_id'], 'properties': {
            'habit_id': {'type': 'integer', 'description': 'ID of the habit to pause or resume'},
        }},
    },
    {
        'name': 'add_goal',
        'exec_type': 'proposed',
        'description': (
            'Create a new outcome-based goal. Use when the user wants to achieve something specific '
            '(get a 6 pack, get an A, save money). These are destinations, not daily habits. '
            'Ask for category and deadline if not given. PROPOSED.'
        ),
        'parameters': {'type': 'object', 'required': ['title'], 'properties': {
            'title':    {'type': 'string', 'description': 'The outcome the user wants to achieve'},
            'category': {'type': 'string', 'enum': ['fitness','academic','financial','personal','career','health','social','creative'],
                         'description': 'Best-fit category for this goal'},
            'deadline': {'type': 'string', 'description': 'Target date in YYYY-MM-DD format (optional)'},
        }},
    },
    {
        'name': 'delete_goal',
        'exec_type': 'proposed',
        'description': 'Permanently remove a goal and all its milestones. PROPOSED.',
        'parameters': {'type': 'object', 'required': ['goal_id'], 'properties': {
            'goal_id': {'type': 'integer', 'description': 'ID of the goal to delete'},
        }},
    },
    {
        'name': 'add_milestone',
        'exec_type': 'proposed',
        'description': (
            'Add a step/milestone to an existing goal. Use when the user wants to break a goal into steps, '
            'add sub-tasks, or track progress toward a specific goal. PROPOSED.'
        ),
        'parameters': {'type': 'object', 'required': ['goal_id', 'text'], 'properties': {
            'goal_id': {'type': 'integer', 'description': 'ID of the goal to add the milestone to'},
            'text':    {'type': 'string',  'description': 'The milestone or step description'},
        }},
    },
    {
        'name': 'complete_milestone',
        'exec_type': 'immediate',
        'description': (
            'Mark a goal milestone as done or undone. Use when the user says they completed, '
            'finished, or ticked off a specific step toward a goal. IMMEDIATE.'
        ),
        'parameters': {'type': 'object', 'required': ['goal_id', 'milestone_id', 'done'], 'properties': {
            'goal_id':      {'type': 'integer', 'description': 'ID of the goal'},
            'milestone_id': {'type': 'integer', 'description': 'ID of the milestone'},
            'done':         {'type': 'boolean', 'description': 'true = mark done, false = unmark'},
        }},
    },
    {
        'name': 'link_habit_to_goal',
        'exec_type': 'proposed',
        'description': (
            'Connect a habit to a goal to show it as supporting evidence. Use when the user '
            'wants to link a daily habit to an outcome goal. PROPOSED.'
        ),
        'parameters': {'type': 'object', 'required': ['goal_id', 'habit_id'], 'properties': {
            'goal_id':  {'type': 'integer', 'description': 'ID of the goal'},
            'habit_id': {'type': 'integer', 'description': 'ID of the habit to link'},
        }},
    },
    {
        'name': 'update_habit',
        'exec_type': 'proposed',
        'description': (
            'Rename a habit or change its difficulty. Use when the user wants to rename, edit, update, '
            'or change the name or difficulty level of an existing habit. PROPOSED.'
        ),
        'parameters': {'type': 'object', 'required': ['habit_id'], 'properties': {
            'habit_id':   {'type': 'integer', 'description': 'ID of the habit to edit'},
            'title':      {'type': 'string',  'description': 'New name for the habit (omit to keep current)'},
            'difficulty': {'type': 'string',  'enum': ['easy', 'medium', 'hard'],
                           'description': 'New difficulty (omit to keep current)'},
        }},
    },
]

IMMEDIATE_SKILLS = {s['name'] for s in _SKILL_REGISTRY if s['exec_type'] == 'immediate'}
_IMMEDIATE_NAMES = ', '.join(s['name'] for s in _SKILL_REGISTRY if s['exec_type'] == 'immediate')
_PROPOSED_NAMES  = ', '.join(s['name'] for s in _SKILL_REGISTRY if s['exec_type'] == 'proposed')


def _build_tools(safe_cats):
    cats_str = ', '.join(safe_cats)
    tools = []
    for skill in _SKILL_REGISTRY:
        desc = skill['description'].replace('__CATS__', cats_str)
        props = {}
        for k, v in skill['parameters'].get('properties', {}).items():
            prop = dict(v)
            if '__CATS__' in prop.get('description', ''):
                prop['description'] = prop['description'].replace('__CATS__', cats_str)
            props[k] = prop
        params = {**skill['parameters'], 'properties': props}
        tools.append({'type': 'function', 'function': {
            'name': skill['name'], 'description': desc, 'parameters': params,
        }})
    return tools


_FOCUS_VOICES = {
    'focus_started': {
        'terrified': 'f-focusing... t-timer on...',
        'shy':       "okay... let's focus...",
        'cautious':  "let's do this! timer's on.",
        'friendly':  "starting focus!! let's go!!",
        'bonded':    "LET'S GOOOO!! TIMER'S RUNNING!!",
    },
    'pause_focus': {
        'terrified': '...paused',
        'shy':       'paused...',
        'cautious':  'paused! take a breath.',
        'friendly':  'paused!! you got this~',
        'bonded':    'PAUSED!! breathe!! you got this!!',
    },
    'resume_focus': {
        'terrified': 'r-resuming...',
        'shy':       'back to it...',
        'cautious':  "back to it! let's go.",
        'friendly':  "we're back!! let's go!!",
        'bonded':    "WE'RE BACK!! LET'S GOOOOO!!",
    },
    'stop_focus': {
        'terrified': 'd-done... good job',
        'shy':       'session over. nice work.',
        'cautious':  'session ended! good effort.',
        'friendly':  'great work!! session done!!',
        'bonded':    'AMAZING WORK!! YOU CRUSHED IT!!',
    },
    'skip_focus': {
        'terrified': 'n-next phase...',
        'shy':       'skipped to next phase.',
        'cautious':  'next phase! keep going.',
        'friendly':  "next phase!! keep it up!!",
        'bonded':    "NEXT PHASE!! KEEP GOING!! YOU'RE AMAZING!!",
    },
    'milestone_completed': {
        'terrified': 'g-good step...',
        'shy':       'step done! nice.',
        'cautious':  'milestone checked! progress!',
        'friendly':  'milestone done!! great job!!',
        'bonded':    'MILESTONE CRUSHED!! KEEP GOING!!',
    },
    'goal_complete': {
        'terrified': 'y-you did it...!',
        'shy':       'goal complete!! wow!!',
        'cautious':  'GOAL ACHIEVED!! amazing!!',
        'friendly':  'GOAL COMPLETE!! SO PROUD OF YOU!!',
        'bonded':    'YOU DID IT!!! GOAL COMPLETE!!! LEGENDARY!!!',
    },
    'habit_checked': {
        'terrified': 'c-checked off... good',
        'shy':       'checked it off! nice.',
        'cautious':  'checked in! streak going.',
        'friendly':  'checked in!! keep that streak!!',
        'bonded':    'CHECKED IN!! STREAK ALIVE!! LETS GO!!',
    },
    'already_done': {
        'terrified': 'a-already done today...',
        'shy':       'you already did that one today!',
        'cautious':  'already checked in today!',
        'friendly':  "already done today!! you're on it!!",
        'bonded':    'ALREADY DONE TODAY!! YOU MACHINE!!',
    },
}

def _immediate_reply(focus_result, tier_name):
    if not focus_result:
        return '...'
    for key, voices in _FOCUS_VOICES.items():
        if focus_result.get(key):
            return voices.get(tier_name, 'done!')
    return '...'


# ── Chat tool execution ────────────────────────────────────────────────────────
def execute_task_tool(name, args):
    if not isinstance(args, dict):
        args = {}
    if name == 'create_task':
        title = (args.get('title') or '').strip()
        category = args.get('category', 'general')
        if not title:
            return {'error': 'empty title'}
        with db() as c:
            cur = c.execute('INSERT INTO tasks (title, category) VALUES (?,?)', (title, category))
            c.commit()
            task = dict(c.execute('SELECT * FROM tasks WHERE id=?', (cur.lastrowid,)).fetchone())
        return {'ok': True, 'task': task}

    if name == 'delete_task':
        tid = args.get('task_id')
        with db() as c:
            row = c.execute('SELECT title FROM tasks WHERE id=?', (tid,)).fetchone()
            if not row:
                return {'error': f'task {tid} not found'}
            c.execute('DELETE FROM tasks WHERE id=?', (tid,))
            c.commit()
        return {'ok': True, 'deleted': dict(row)}

    if name == 'complete_task':
        tid = args.get('task_id')
        done = 1 if args.get('done', True) else 0
        with db() as c:
            if not c.execute('SELECT id FROM tasks WHERE id=?', (tid,)).fetchone():
                return {'error': f'task {tid} not found'}
            c.execute('UPDATE tasks SET done=?, completed_at=? WHERE id=?',
                      (done, datetime.now().isoformat() if done else None, tid))
            c.commit()
        return {'ok': True, 'task_id': tid, 'done': bool(done)}

    if name == 'update_task':
        tid = args.get('task_id')
        with db() as c:
            row = c.execute('SELECT * FROM tasks WHERE id=?', (tid,)).fetchone()
            if not row:
                return {'error': f'task {tid} not found'}
            task = dict(row)
            new_title = args.get('title', task['title'])
            new_cat = args.get('category', task['category'])
            c.execute('UPDATE tasks SET title=?, category=? WHERE id=?', (new_title, new_cat, tid))
            c.commit()
            task = dict(c.execute('SELECT * FROM tasks WHERE id=?', (tid,)).fetchone())
        return {'ok': True, 'task': task}

    if name == 'start_focus':
        task_id = args.get('task_id')
        label = (args.get('label') or '').strip()
        task_title = label
        if task_id:
            with db() as c:
                row = c.execute('SELECT title FROM tasks WHERE id=?', (task_id,)).fetchone()
                if row:
                    task_title = row['title']
        if not task_title:
            task_title = 'focus session'
        return {
            'ok': True, 'focus_started': True, 'task_id': task_id, 'task_title': task_title,
            'work_minutes':  args.get('work_minutes'),
            'short_minutes': args.get('short_minutes'),
            'long_minutes':  args.get('long_minutes'),
        }

    if name == 'pause_focus':
        return {'ok': True, 'pause_focus': True}

    if name == 'resume_focus':
        return {'ok': True, 'resume_focus': True}

    if name == 'stop_focus':
        return {'ok': True, 'stop_focus': True}

    if name == 'skip_focus':
        return {'ok': True, 'skip_focus': True}

    if name == 'add_habit':
        title      = (args.get('title') or '').strip()
        difficulty = args.get('difficulty', 'medium')
        if difficulty not in ('easy', 'medium', 'hard'):
            difficulty = 'medium'
        if not title:
            return {'error': 'empty title'}
        with db() as c:
            cur = c.execute('INSERT INTO habits (title, difficulty) VALUES (?,?)', (title, difficulty))
            c.commit()
            habit = dict(c.execute('SELECT * FROM habits WHERE id=?', (cur.lastrowid,)).fetchone())
        return {'ok': True, 'habit': habit, 'habit_added': True}

    if name == 'check_habit':
        hid   = args.get('habit_id')
        today = datetime.now().strftime('%Y-%m-%d')
        with db() as c:
            habit = c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone()
            if not habit:
                return {'error': f'habit {hid} not found'}
            habit = dict(habit)
            if habit.get('paused'):
                return {'error': f'habit "{habit["title"]}" is paused'}
            last = (habit['last_done'] or '')[:10]
            if last == today:
                return {'ok': True, 'already_done': True, 'habit': habit}
            new_streak  = habit['streak'] + 1
            new_longest = max(habit.get('longest_streak') or 0, new_streak)
            new_total   = habit['total_checks'] + 1
            try:
                history = json.loads(habit.get('history') or '[]')
            except Exception:
                history = []
            if today not in history:
                history.append(today)
            history = sorted(history)[-30:]
            equipped_ai  = get_equipped_items(c)
            base_coins   = COIN_BY_DIFFICULTY.get(habit.get('difficulty', 'medium'), 3)
            streak_thr   = 3 if 'party_hat' in equipped_ai else 7
            multiplier   = 1.5 if new_streak >= streak_thr else 1.0
            coins_earned = apply_coin_mult(int(base_coins * multiplier), equipped_ai, 'habit')
            c.execute(
                'UPDATE habits SET streak=?, longest_streak=?, last_done=?, total_checks=?, history=? WHERE id=?',
                (new_streak, new_longest, today, new_total, json.dumps(history), hid)
            )
            pet = dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone())
            try:
                h_history = json.loads(pet.get('habit_history') or '[]')
            except Exception:
                h_history = []
            if today not in h_history:
                h_history.append(today)
            h_history = sorted(h_history)[-30:]
            new_h_streak = _calc_consecutive_streak(h_history)
            new_longest_h = max(pet.get('longest_habit_streak', 0), new_h_streak)
            c.execute(
                'UPDATE pet SET coins=coins+?, habit_streak=?, longest_habit_streak=?, habit_history=? WHERE id=1',
                (coins_earned, new_h_streak, new_longest_h, json.dumps(h_history))
            )
            c.commit()
            habit = dict(c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone())
            pet   = pet_with_level(dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone()))
        return {'ok': True, 'habit': habit, 'pet': pet, 'coins_earned': coins_earned, 'habit_checked': True}

    if name == 'remove_habit':
        hid = args.get('habit_id')
        with db() as c:
            row = c.execute('SELECT title FROM habits WHERE id=?', (hid,)).fetchone()
            if not row:
                return {'error': f'habit {hid} not found'}
            c.execute('DELETE FROM habits WHERE id=?', (hid,))
            c.commit()
        return {'ok': True, 'deleted_habit': dict(row), 'habit_removed': True}

    if name == 'pause_habit':
        hid = args.get('habit_id')
        with db() as c:
            row = c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone()
            if not row:
                return {'error': f'habit {hid} not found'}
            new_paused = 0 if row['paused'] else 1
            c.execute('UPDATE habits SET paused=? WHERE id=?', (new_paused, hid))
            c.commit()
            habit = dict(c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone())
        return {'ok': True, 'habit': habit, 'paused': bool(new_paused), 'habit_paused': True}

    if name == 'add_goal':
        title    = (args.get('title') or '').strip()
        category = args.get('category', 'personal')
        deadline = (args.get('deadline') or '').strip() or None
        if not title:
            return {'error': 'empty title'}
        with db() as c:
            cur = c.execute('INSERT INTO goals (title, category, deadline) VALUES (?,?,?)',
                            (title, category, deadline))
            c.commit()
            goal = _goal_full(c, cur.lastrowid)
        return {'ok': True, 'goal': goal, 'goal_added': True}

    if name == 'delete_goal':
        gid = args.get('goal_id')
        with db() as c:
            row = c.execute('SELECT title FROM goals WHERE id=?', (gid,)).fetchone()
            if not row:
                return {'error': f'goal {gid} not found'}
            c.execute('DELETE FROM goal_milestones WHERE goal_id=?', (gid,))
            c.execute('DELETE FROM goal_habit_links WHERE goal_id=?', (gid,))
            c.execute('DELETE FROM goals WHERE id=?', (gid,))
            c.commit()
        return {'ok': True, 'deleted_goal': dict(row), 'goal_removed': True}

    if name == 'add_milestone':
        gid  = args.get('goal_id')
        text = (args.get('text') or '').strip()
        if not text:
            return {'error': 'empty text'}
        with db() as c:
            row = c.execute('SELECT id FROM goals WHERE id=?', (gid,)).fetchone()
            if not row:
                return {'error': f'goal {gid} not found'}
            order = c.execute('SELECT COUNT(*) FROM goal_milestones WHERE goal_id=?', (gid,)).fetchone()[0]
            c.execute('INSERT INTO goal_milestones (goal_id, text, sort_order) VALUES (?,?,?)',
                      (gid, text, order))
            c.commit()
            goal = _goal_full(c, gid)
        return {'ok': True, 'goal': goal, 'milestone_added': True}

    if name == 'complete_milestone':
        gid  = args.get('goal_id')
        mid  = args.get('milestone_id')
        done = 1 if args.get('done', True) else 0
        with db() as c:
            c.execute('UPDATE goal_milestones SET done=? WHERE id=? AND goal_id=?', (done, mid, gid))
            c.commit()
            goal = _goal_full(c, gid)
        if not goal:
            return {'error': f'goal {gid} not found'}
        return {'ok': True, 'goal': goal, 'milestone_completed': True,
                'goal_complete': goal['progress'] >= 100}

    if name == 'link_habit_to_goal':
        gid = args.get('goal_id')
        hid = args.get('habit_id')
        with db() as c:
            if not c.execute('SELECT id FROM goals WHERE id=?', (gid,)).fetchone():
                return {'error': f'goal {gid} not found'}
            if not c.execute('SELECT id FROM habits WHERE id=?', (hid,)).fetchone():
                return {'error': f'habit {hid} not found'}
            try:
                c.execute('INSERT INTO goal_habit_links (goal_id, habit_id) VALUES (?,?)', (gid, hid))
                c.commit()
            except Exception:
                pass
            goal = _goal_full(c, gid)
        return {'ok': True, 'goal': goal, 'habit_linked': True}

    if name == 'update_habit':
        hid = args.get('habit_id')
        with db() as c:
            row = c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone()
            if not row:
                return {'error': f'habit {hid} not found'}
            habit = dict(row)
            new_title = args.get('title', habit['title'])
            new_diff  = args.get('difficulty', habit['difficulty'])
            if new_diff not in ('easy', 'medium', 'hard'):
                new_diff = habit['difficulty']
            c.execute('UPDATE habits SET title=?, difficulty=? WHERE id=?', (new_title, new_diff, hid))
            c.commit()
            habit = dict(c.execute('SELECT * FROM habits WHERE id=?', (hid,)).fetchone())
        return {'ok': True, 'habit': habit, 'habit_updated': True}

    return {'error': f'unknown tool {name}'}

def _sentiment_effects(message: str) -> dict:
    """Tiny parallel Groq call — maps message tone to pet stat changes."""
    _default = {'happiness': 1, 'energy': 0, 'familiarity': 1, 'expression': 'normal'}
    try:
        client = _groq()
        resp = client.chat.completions.create(
            model=SENTIMENT_MODEL,
            messages=[
                {'role': 'system', 'content': (
                    'Return ONLY a JSON object (no other text) with these fields:\n'
                    '  happiness (int -15 to 15), energy (int -10 to 10),\n'
                    '  familiarity (int -3 to 5), expression (happy|excited|sad|curious|scared|normal)\n'
                    'Score how this message emotionally affects a small blob companion.\n'
                    'Example: {"happiness":5,"energy":3,"familiarity":2,"expression":"happy"}'
                )},
                {'role': 'user', 'content': message[:300]},
            ],
            temperature=0.2,
            max_completion_tokens=60,
        )
        log_usage(resp, 'sentiment')
        raw = (resp.choices[0].message.content or '').strip()
        # Extract first JSON object from the response
        m = re.search(r'\{[^{}]+\}', raw)
        data = json.loads(m.group()) if m else {}
        return {
            'happiness':   max(-15, min(15, int(data.get('happiness', 1)))),
            'energy':      max(-10, min(10, int(data.get('energy', 0)))),
            'familiarity': max(-3,  min(5,  int(data.get('familiarity', 1)))),
            'expression':  data.get('expression', 'normal'),
        }
    except Exception:
        return _default

# ── Shop ──────────────────────────────────────────────────────────────────────
@app.route('/api/shop')
def get_shop():
    with db() as c:
        owned_rows = c.execute('SELECT item_id, equipped FROM shop_owned').fetchall()
        owned = {r['item_id']: r['equipped'] for r in owned_rows}
    items = []
    for item in SHOP_CATALOG:
        items.append({**item, 'owned': item['id'] in owned, 'equipped': bool(owned.get(item['id'], 0))})
    return jsonify(items)


@app.route('/api/shop/buy', methods=['POST'])
def buy_shop_item():
    item_id = (request.json or {}).get('item_id', '')
    if item_id not in SHOP_IDS:
        return jsonify(error='unknown item'), 400
    item = next(i for i in SHOP_CATALOG if i['id'] == item_id)
    with db() as c:
        if c.execute('SELECT 1 FROM shop_owned WHERE item_id=?', (item_id,)).fetchone():
            return jsonify(error='already owned'), 400
        pet = dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone())
        if pet['coins'] < item['price']:
            return jsonify(error='not enough coins'), 400
        c.execute('UPDATE pet SET coins = coins - ? WHERE id=1', (item['price'],))
        c.execute('INSERT INTO shop_owned (item_id, equipped) VALUES (?, 1)', (item_id,))
        c.commit()
        pet = pet_with_level(dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone()))
    return jsonify(ok=True, pet=pet)


@app.route('/api/shop/equip', methods=['POST'])
def equip_shop_item():
    item_id = (request.json or {}).get('item_id', '')
    if item_id not in SHOP_IDS:
        return jsonify(error='unknown item'), 400
    with db() as c:
        row = c.execute('SELECT equipped FROM shop_owned WHERE item_id=?', (item_id,)).fetchone()
        if not row:
            return jsonify(error='not owned'), 400
        new_state = 1 - row['equipped']
        c.execute('UPDATE shop_owned SET equipped=? WHERE item_id=?', (new_state, item_id))
        c.commit()
    return jsonify(ok=True, equipped=bool(new_state))


# ── Chat ──────────────────────────────────────────────────────────────────────
_CONFIRM_VOICES = {
    'terrified': 'um... d-do you want this?...',
    'shy':       'should i... do this?',
    'cautious':  'want me to go ahead?',
    'friendly':  'okay! should i do this?',
    'bonded':    'SAY YES AND I WILL!!',
}


def _action_label(name, args, tasks_by_id, habits_by_id, goals_by_id):
    """One human-readable summary of a proposed action for the confirm card.
    Single source of truth shared by the native and XML-recovery tool paths."""
    if name == 'create_task':
        return f"add \"{args.get('title', '')}\" · {args.get('category', 'general')}"
    if name == 'delete_task':
        t = tasks_by_id.get(args.get('task_id'))
        return f"delete \"{t['title'] if t else 'unknown task'}\""
    if name == 'complete_task':
        t = tasks_by_id.get(args.get('task_id'))
        word = 'complete' if args.get('done') else 'uncomplete'
        return f"{word} \"{t['title'] if t else 'unknown task'}\""
    if name == 'update_task':
        t = tasks_by_id.get(args.get('task_id'))
        changes = []
        if 'title' in args:    changes.append(f'rename to "{args["title"]}"')
        if 'category' in args: changes.append(f'move to {args["category"]}')
        return f"update \"{t['title'] if t else 'unknown task'}\": {', '.join(changes) or 'no change'}"
    if name == 'add_habit':
        return f"add habit \"{args.get('title', '')}\" · {args.get('difficulty', 'medium')}"
    if name == 'remove_habit':
        h = habits_by_id.get(args.get('habit_id'))
        return f"delete habit \"{h['title'] if h else 'unknown'}\""
    if name == 'pause_habit':
        h = habits_by_id.get(args.get('habit_id'))
        action = 'resume' if (h and h['paused']) else 'pause'
        return f"{action} habit \"{h['title'] if h else 'unknown'}\""
    if name == 'update_habit':
        h = habits_by_id.get(args.get('habit_id'))
        changes = []
        if 'title' in args:      changes.append(f'rename to "{args["title"]}"')
        if 'difficulty' in args: changes.append(f'set difficulty to {args["difficulty"]}')
        return f"update habit \"{h['title'] if h else 'unknown'}\": {', '.join(changes) or 'no change'}"
    if name == 'add_goal':
        dl = f" · due {args['deadline']}" if args.get('deadline') else ''
        return f"add goal \"{args.get('title', '')}\" · {args.get('category', 'personal')}{dl}"
    if name == 'delete_goal':
        g = goals_by_id.get(args.get('goal_id'))
        return f"delete goal \"{g['title'] if g else 'unknown'}\""
    if name == 'add_milestone':
        g = goals_by_id.get(args.get('goal_id'))
        return f"add step \"{args.get('text', '')}\" → \"{g['title'] if g else 'goal'}\""
    if name == 'link_habit_to_goal':
        g = goals_by_id.get(args.get('goal_id'))
        h = habits_by_id.get(args.get('habit_id'))
        return f"link \"{h['title'] if h else 'habit'}\" → goal \"{g['title'] if g else 'goal'}\""
    return name


def _process_tool_calls(calls, tasks_by_id, habits_by_id, goals_by_id):
    """Run a list of (name, args) tool calls. IMMEDIATE tools execute now;
    PROPOSED tools are collected for user confirmation.
    Returns (focus_result, proposed_actions)."""
    known = {s['name'] for s in _SKILL_REGISTRY}
    focus_result = None
    proposed_actions = []
    for name, args in calls:
        if name not in known:
            log.warning('Unknown tool name from model: %r', name)
            continue
        if not isinstance(args, dict):
            args = {}
        if name in IMMEDIATE_SKILLS:
            focus_result = {**execute_task_tool(name, args), 'tool': name}
        else:
            proposed_actions.append({
                'name': name, 'args': args,
                'label': _action_label(name, args, tasks_by_id, habits_by_id, goals_by_id),
            })
    return focus_result, proposed_actions


def _chat_reply(focus_result, proposed_actions, tier_name):
    """Blob's spoken reply given what it just did / wants to confirm."""
    if proposed_actions:
        prefix = ''
        if focus_result:
            if   focus_result.get('focus_started'): prefix = f"focus started for \"{focus_result.get('task_title', '')}\". "
            elif focus_result.get('pause_focus'):   prefix = 'paused! '
            elif focus_result.get('resume_focus'):  prefix = 'resumed! '
            elif focus_result.get('stop_focus'):    prefix = 'stopped! '
            elif focus_result.get('skip_focus'):    prefix = 'skipped! '
        return prefix + _CONFIRM_VOICES.get(tier_name, 'want me to do this?')
    return _immediate_reply(focus_result, tier_name)


def _bonus_familiarity(equipped):
    """Extra familiarity per chat from equipped items (stacks)."""
    return (1 if 'sunglasses' in equipped else 0) \
         + (1 if 'angel_wings' in equipped else 0) \
         + (2 if 'halo' in equipped else 0)


def _effects_with_bonus(sentiment, fam_bonus):
    """Sentiment-driven stat changes plus any equipped familiarity bonus."""
    effects = dict(sentiment or _DEFAULT_EFFECTS)
    if fam_bonus:
        effects['familiarity'] = effects.get('familiarity', 1) + fam_bonus
    return effects


@app.route('/api/chat', methods=['POST'])
def chat():
    d = request.json or {}
    message    = (d.get('message') or '').strip()
    history    = d.get('history', [])
    stats      = d.get('stats', {})
    now        = d.get('time', datetime.now().strftime('%I:%M %p'))
    categories = d.get('categories', ['general', 'work', 'study', 'health'])
    focus_info = d.get('focus', {})

    if not message:
        return jsonify(error='empty message'), 400

    # Run sentiment analysis in parallel with the main Groq call
    _sentiment = {}
    _sentiment_thread = threading.Thread(target=lambda: _sentiment.update(_sentiment_effects(message)))
    _sentiment_thread.start()

    f = stats.get('familiarity', 50)
    e = stats.get('energy', 50)
    h = stats.get('happiness', 50)

    tier_name = ('terrified' if f < 20 else 'shy' if f < 42 else
                 'cautious'  if f < 65 else 'friendly' if f < 85 else 'bonded')

    voices = {
        'terrified': 'extremely shy blob, stutters (l-like this), speaks quietly — but ALWAYS gives complete, helpful answers and confirms every action clearly',
        'shy':       'shy and soft-spoken blob — always gives complete, helpful answers and confirms every action clearly',
        'cautious':  'cautious blob, warming up — give complete, helpful answers',
        'friendly':  'warm and friendly blob — be helpful and enthusiastic',
        'bonded':    'loving and excitable blob!! — be thorough and enthusiastic!!',
    }

    with db() as c:
        rows        = c.execute('SELECT id, title, category, done FROM tasks ORDER BY created_at DESC').fetchall()
        habit_rows  = c.execute('SELECT id, title, difficulty, streak, last_done, paused FROM habits ORDER BY created_at DESC').fetchall()
        goal_ids    = [r['id'] for r in c.execute('SELECT id FROM goals ORDER BY created_at DESC').fetchall()]
        goal_rows   = [_goal_full(c, gid) for gid in goal_ids]
        fam_bonus   = _bonus_familiarity(get_equipped_items(c))   # read once; state won't change mid-call
    task_lines  = [f"#{r['id']} [{r['category']}] {r['title']} ({'done' if r['done'] else 'pending'})"
                   for r in rows]
    today_str   = datetime.now().strftime('%Y-%m-%d')
    habit_lines = [
        f"#{h['id']} \"{h['title']}\" ({h['difficulty']}, {h['streak']}-day streak"
        + (", done today" if h['last_done'] and h['last_done'][:10] == today_str else "")
        + (", PAUSED" if h['paused'] else "") + ")"
        for h in habit_rows
    ]
    def _days_left(deadline):
        if not deadline: return ''
        try:
            from datetime import date
            diff = (date.fromisoformat(deadline) - date.today()).days
            return f', {diff}d left' if diff >= 0 else ', overdue'
        except Exception:
            return ''
    goal_lines = []
    for g in goal_rows:
        ms_summary = ' | '.join(
            ('✓ ' if m['done'] else '○ ') + m['text']
            for m in g['milestones']
        ) or 'no milestones'
        linked = ', '.join(f"#{h['id']} {h['title']}" for h in g['linked_habits']) or 'none'
        goal_lines.append(
            f"#{g['id']} \"{g['title']}\" ({g['category']}{_days_left(g.get('deadline'))}, "
            f"{g['milestone_done']}/{g['milestone_total']} done)\n"
            f"  steps: {ms_summary}\n"
            f"  habits: {linked}"
        )

    safe_cats     = [str(c) for c in categories if isinstance(c, str)][:20] or ['general']
    focus_history = d.get('focus_history', [])
    hist_lines    = [f"  {s.get('label','?')} — {s.get('duration','?')}" for s in focus_history[:6]]

    paused_flag = ' [PAUSED]' if focus_info.get('paused') else ''
    if focus_info.get('active'):
        focus_ctx = (
            f"ACTIVE{paused_flag}: {focus_info.get('phase','work')} phase, "
            f"{focus_info.get('remaining_min',0)} min left, "
            f"task: \"{focus_info.get('task_title','')}\", "
            f"{focus_info.get('count',0)}/4 pomodoros done."
        )
    else:
        focus_ctx = "No active session."

    system = (
        f"You are a blob companion. Voice: {voices[tier_name]}.\n"
        f"Time: {now}. Mood — happiness: {h}/100, energy: {e}/100.\n\n"
        f"Tasks:\n{chr(10).join(task_lines) or '  none'}\n\n"
        f"Habits:\n{chr(10).join(habit_lines) or '  none'}\n\n"
        f"Goals:\n{chr(10).join(goal_lines) or '  none'}\n\n"
        f"Focus: {focus_ctx}\n"
        f"Recent focus sessions:\n{chr(10).join(hist_lines) if hist_lines else '  none yet'}\n\n"
        "=== TOOLS ===\n"
        f"IMMEDIATE (execute instantly): {_IMMEDIATE_NAMES}\n"
        f"PROPOSED (require user confirmation): {_PROPOSED_NAMES}\n\n"
        "=== RULES ===\n"
        "1. Match user intent to tool descriptions — do not guess from keywords alone.\n"
        "2. Answer directly (no tool call) for questions about tasks, goals, habits, focus state, or history.\n"
        "3. If a required detail is missing, ask a SHORT question before calling a tool.\n"
        "4. PROPOSED tools are NOT done until the user confirms — never say they happened.\n"
        "5. IMMEDIATE tools execute the moment you call them — speak as if they are already happening.\n"
        "6. CRITICAL: Only call IMMEDIATE tools when the message is an explicit action request.\n"
        "   'thx', 'ok', 'yeah', 'cool', 'lol', thank-yous, or any acknowledgment = NO tool.\n"
        "7. GOALS: goals are outcomes (get a 6 pack), habits are daily actions (exercise). "
        "   When adding a goal, if category or deadline aren't clear, ask ONE short question first. "
        "   Use the goal IDs and milestone IDs from context to reference them precisely.\n"
        "8. QUALITY: Your personality (shy/excited/etc.) affects TONE only — never sacrifice helpfulness or completeness. "
        "   Always clearly confirm what was done or proposed, regardless of tier.\n"
        "9. MULTIPLE ACTIONS: If the user asks for more than one thing, emit a SEPARATE tool call for EVERY "
        "   item in the SAME response — never collapse them into one and never stop after the first. This applies "
        "   even when the items are different types of action. Examples:\n"
        "     'add buy milk and walk the dog' → create_task(\"buy milk\") + create_task(\"walk the dog\").\n"
        "     'add a task to call mom and a habit to drink water' → create_task(\"call mom\") + add_habit(\"drink water\").\n"
        "     'delete tasks 3 and 5' → delete_task(3) + delete_task(5).\n"
        "   Split lists on 'and', commas, or newlines. Reuse the IDs from context for each item."
    )

    tools = _build_tools(safe_cats)
    
    msgs = [{'role': m['role'], 'content': m['content']} for m in history[-8:]]
    msgs.append({'role': 'user', 'content': message})

    _fallbacks = {
        'terrified': ['...um', 'o-okay', 'eep!'],
        'shy':       ['oh okay...', 'sure!', 'got it'],
        'cautious':  ['done!', 'okay!', 'got it!'],
        'friendly':  ['on it!!', 'done!', 'sure thing!'],
        'bonded':    ['ON IT!!', 'DONE!!', 'YEP!!'],
    }

    # Maps of current items, built lazily — both tool paths reference them by id.
    def _id_maps():
        return ({r['id']: r for r in rows},
                {h['id']: h for h in habit_rows},
                {g['id']: g for g in goal_rows})

    # ── Groq API call — only catch network/auth errors here ───────────────────
    try:
        client = _groq()
        resp = client.chat.completions.create(
            model=CHAT_MODEL,
            messages=[{'role': 'system', 'content': system}] + msgs,
            tools=tools,
            tool_choice='auto',
            temperature=0.6,            # steadier tool selection than chat-default; voice still comes through
            max_completion_tokens=768,  # room for several tool calls in one reply (multi-action requests)
            stream=False,
        )
        log_usage(resp, 'chat')
    except Exception as exc:
        # Groq returns 400 tool_use_failed when the model emits XML tool syntax
        # instead of the API tool_calls format. The intended calls are still in
        # failed_generation — recover them through the SAME path as native calls.
        err_body = getattr(exc, 'body', None)
        err_info = (err_body or {}).get('error', {}) if isinstance(err_body, dict) else {}
        if err_info.get('code') == 'tool_use_failed':
            known = {s['name'] for s in _SKILL_REGISTRY}
            calls = [(n, a) for n, a in _parse_failed_generation(err_info.get('failed_generation', '')) if n in known]
            if calls:
                log.info('Recovered tool_use_failed: %s', calls)
                focus_result, proposed_actions = _process_tool_calls(calls, *_id_maps())
                reply = _chat_reply(focus_result, proposed_actions, tier_name)
                _sentiment_thread.join(timeout=5)
                return jsonify(message=reply, focus_result=focus_result,
                               proposed_actions=proposed_actions,
                               effects=_effects_with_bonus(_sentiment, fam_bonus))
        log.error('Groq API error in /api/chat: %s', exc)
        reply = random.choice(_fallbacks.get(tier_name, _fallbacks['cautious']))
        _sentiment_thread.join(timeout=5)
        return jsonify(message=reply, effects=_effects_with_bonus(_sentiment, fam_bonus))

    # Main call finished — sentiment thread should be done or very close
    _sentiment_thread.join(timeout=5)
    effects = _effects_with_bonus(_sentiment, fam_bonus)

    asst = resp.choices[0].message

    # ── Tool call handling ─────────────────────────────────────────────────────
    if asst.tool_calls:
        calls = []
        for tc in asst.tool_calls:
            try:
                args = json.loads(tc.function.arguments or '{}')
            except (json.JSONDecodeError, ValueError):
                log.warning('Malformed tool arguments from model: %r', tc.function.arguments)
                continue
            calls.append((tc.function.name, args if isinstance(args, dict) else {}))

        focus_result, proposed_actions = _process_tool_calls(calls, *_id_maps())
        reply = _chat_reply(focus_result, proposed_actions, tier_name)

        return jsonify(
            message=reply,
            focus_result=focus_result,
            proposed_actions=proposed_actions,
            effects=effects
        )

    # ── Plain text response ────────────────────────────────────────────────────
    reply = _clean(asst.content or '')
    if not reply:
        reply = random.choice(_fallbacks.get(tier_name, _fallbacks['cautious']))
    return jsonify(message=reply, effects=effects)

@app.route('/api/chat/confirm', methods=['POST'])
def chat_confirm():
    d = request.json or {}
    actions = d.get('actions', [])
    results = []
    habit_changed = False
    goal_changed  = False
    for action in actions:
        name = action.get('name', '')
        r = execute_task_tool(name, action.get('args', {}))
        results.append({'name': name, **r})
        if name in ('add_habit', 'remove_habit', 'pause_habit', 'update_habit'):
            habit_changed = True
        if name in ('add_goal', 'delete_goal', 'add_milestone', 'link_habit_to_goal'):
            goal_changed = True
    return jsonify(effects={'familiarity': 0, 'happiness': 1, 'energy': 0},
                   results=results, habit_changed=habit_changed, goal_changed=goal_changed)

# ── Settings ──────────────────────────────────────────────────────────────────
@app.route('/api/settings/clear-completed', methods=['DELETE'])
def clear_completed():
    with db() as c:
        c.execute('DELETE FROM tasks WHERE done=1')
        c.commit()
    return jsonify(ok=True)

@app.route('/api/settings/reset-pet', methods=['POST'])
def reset_pet():
    with db() as c:
        c.execute('''UPDATE pet SET
            hunger=15, happiness=40, total_completed=0, streak=0, coins=0
            WHERE id=1''')
        c.commit()
        pet = pet_with_level(dict(c.execute('SELECT * FROM pet WHERE id=1').fetchone()))
    return jsonify(pet)

init_system()

if __name__ == '__main__':
    app.run(debug=True, port=5002)