const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ── Schema ─────────────────────────────────────────────────────────────────
// Applied on boot, idempotently. The `votes` and `reports` tables hold only
// per-member records that no other member should see listed, so they are
// marked staging:private: on staging their schema is copied per account and
// the rows never leave the account that made them. decisions and comments
// are shared, public tables.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decisions (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      question TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      closes_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      demo_owner TEXT,
      demo_key TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      decision_id BIGINT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      choice TEXT NOT NULL CHECK (choice IN ('yes','no')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (decision_id, user_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id BIGSERIAL PRIMARY KEY,
      decision_id BIGINT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      demo_owner TEXT,
      demo_key TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('decision','comment')),
      target_id BIGINT NOT NULL,
      reporter_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (target_kind, target_id, reporter_id)
    )`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS decisions_demo_key ON decisions (demo_owner, demo_key)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS comments_demo_key ON comments (demo_owner, demo_key)');
  // Private on staging: who voted which way, and what was reported, is
  // per-member data the other members must not see.
  await pool.query("COMMENT ON TABLE votes IS 'staging:private'");
  await pool.query("COMMENT ON TABLE reports IS 'staging:private'");
}

// ── Demo data (staging only, ?demo=1) ─────────────────────────────────────
// Written once per viewing account, owned by that account (demo_owner), and
// excluded from EVERY response that does not pass demo=1, so the plain
// routes stay clean. Rows carry fixed demo_keys so re-seeding is a no-op.
//
// The tally counts come from real votes rows (fake member ids), so voting on
// a demo decision genuinely moves the box; comments and the viewer's own
// posted decision are real rows too, so commenting, deleting and reporting
// all work on them.
const DEMO_MEMBERS = [
  { id: 'demo-member-maya', name: 'Maya' },
  { id: 'demo-member-dev', name: 'Dev' },
  { id: 'demo-member-priya', name: 'Priya' },
  { id: 'demo-member-sam', name: 'Sam' },
  { id: 'demo-member-jordan', name: 'Jordan' },
];
const memberName = (id) => (DEMO_MEMBERS.find((m) => m.id === id) || {}).name || 'A member';

function yesVotes(members) {
  return members.map((m) => ({ user_id: m.id, choice: 'yes' }));
}
function noVotes(members) {
  return members.map((m) => ({ user_id: m.id, choice: 'no' }));
}

// (question, details, key, author, yesNames, noNames, hoursLeft, comments)
// hoursLeft < 0 means already closed that long ago.
const DEMO_PLAN = [
  {
    key: 'library',
    author: 'demo-member-maya',
    question: 'Move Thursday meetups to the library?',
    details: 'The café is getting loud and the library has a free room with a whiteboard. Same time, 7 pm.',
    yes: ['demo-member-dev', 'demo-member-priya', 'demo-member-sam', 'demo-member-jordan', 'demo-member-maya', 'demo-member-dev2', 'demo-member-priya2'],
    no: ['demo-member-sam2', 'demo-member-jordan2', 'demo-member-maya2', 'demo-member-dev3', 'demo-member-priya3'],
    hours: 44,
    comments: [
      { by: 'demo-member-sam', name: 'Sam', agoMin: 130, body: 'Library closes at 9, so we would need to wrap up on time.' },
      { by: 'demo-member-jordan', name: 'Jordan', agoMin: 65, body: 'Parking is easier there too. I am in.' },
      { by: 'you', agoMin: 20, body: 'Can we bring snacks into the room?' },
    ],
  },
  {
    key: 'cabin',
    author: 'demo-member-dev',
    question: 'Book the lakeside cabin for the spring trip?',
    details: '',
    yes: ['demo-member-priya', 'demo-member-maya'],
    no: ['demo-member-sam', 'demo-member-jordan', 'demo-member-maya2', 'demo-member-dev2', 'demo-member-sam2', 'demo-member-priya2', 'demo-member-jordan2'],
    hours: 20,
    comments: [
      { by: 'demo-member-priya', name: 'Priya', agoMin: 300, body: 'It sleeps eight, which is exactly our size.' },
      { by: 'demo-member-jordan', name: 'Jordan', agoMin: 120, body: 'Deposit is a bit steep though. Can we split it?' },
    ],
  },
  {
    key: 'dues',
    author: 'demo-member-priya',
    question: 'Raise yearly dues from $20 to $25?',
    details: 'The raise covers hall hire and the new projector bulb for one more year.',
    yes: ['demo-member-maya', 'demo-member-sam'],
    no: ['demo-member-dev', 'demo-member-jordan', 'demo-member-maya2', 'demo-member-sam2', 'demo-member-dev2', 'demo-member-priya2'],
    hours: 70,
    comments: [
      { by: 'demo-member-dev', name: 'Dev', agoMin: 500, body: 'Twenty is already fair if we keep renting the smaller hall.' },
    ],
  },
  {
    key: 'june-social',
    author: 'you',
    question: 'Hold the June social at the park?',
    details: 'Rain plan: the scout hut next door, booked either way.',
    yes: ['demo-member-maya', 'demo-member-priya', 'demo-member-sam', 'demo-member-jordan', 'demo-member-dev', 'demo-member-maya2', 'demo-member-priya2', 'demo-member-dev2'],
    no: ['demo-member-sam2', 'demo-member-jordan2', 'demo-member-maya3', 'demo-member-priya3', 'demo-member-dev3', 'demo-member-sam3', 'demo-member-jordan3', 'demo-member-maya4', 'demo-member-priya4', 'demo-member-dev4'],
    hours: 110,
    myVote: 'no',
    comments: [
      { by: 'demo-member-sam', name: 'Sam', agoMin: 900, body: 'The hut has tables and a kettle, so either way works.' },
      { by: 'demo-member-maya', name: 'Maya', agoMin: 600, body: 'Park, weather permitting.' },
    ],
  },
  {
    key: 'game-night',
    author: 'demo-member-jordan',
    question: 'Swap game night to Fridays?',
    details: '',
    yes: ['demo-member-maya', 'demo-member-dev', 'demo-member-priya', 'demo-member-sam', 'demo-member-jordan', 'demo-member-maya2', 'demo-member-dev2', 'demo-member-priya2', 'demo-member-sam2', 'demo-member-jordan2', 'demo-member-maya3', 'demo-member-dev3', 'demo-member-priya3', 'demo-member-sam3', 'demo-member-jordan3', 'demo-member-maya4', 'demo-member-dev4'],
    no: ['demo-member-maya5', 'demo-member-dev5', 'demo-member-priya5', 'demo-member-sam5'],
    hours: -30,
    comments: [
      { by: 'demo-member-priya', name: 'Priya', agoMin: 2200, body: 'Fridays suit me far better, Thursdays were a squeeze.' },
    ],
  },
  {
    key: 'projector',
    author: 'demo-member-sam',
    question: 'Buy a second projector?',
    details: '',
    yes: ['demo-member-maya', 'demo-member-dev', 'demo-member-priya', 'demo-member-sam', 'demo-member-jordan', 'demo-member-maya2', 'demo-member-dev2', 'demo-member-priya2', 'demo-member-sam2'],
    no: ['demo-member-jordan2', 'demo-member-maya3', 'demo-member-dev3', 'demo-member-priya3', 'demo-member-sam3', 'demo-member-jordan3', 'demo-member-maya4', 'demo-member-dev4'],
    hours: -80,
    comments: [
      { by: 'demo-member-dev', name: 'Dev', agoMin: 3200, body: 'One more yes and we would have had it. Next year maybe.' },
    ],
  },
  {
    key: 'newsletter',
    author: 'demo-member-maya',
    question: 'Start a monthly newsletter?',
    details: '',
    yes: ['demo-member-maya', 'demo-member-dev', 'demo-member-priya', 'demo-member-sam', 'demo-member-jordan', 'demo-member-maya2', 'demo-member-dev2', 'demo-member-priya2', 'demo-member-sam2', 'demo-member-jordan2', 'demo-member-maya3', 'demo-member-dev3', 'demo-member-priya3', 'demo-member-sam3', 'demo-member-jordan3', 'demo-member-maya4', 'demo-member-dev4'],
    no: ['demo-member-priya4', 'demo-member-sam4'],
    hours: -140,
    comments: [
      { by: 'demo-member-jordan', name: 'Jordan', agoMin: 5000, body: 'I can put the first issue together if we agree.' },
    ],
  },
];

async function seedDemo(userId, userName, now) {
  const existing = await pool.query(
    'SELECT id FROM decisions WHERE demo_owner = $1 LIMIT 1', [userId]);
  if (existing.rows.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of DEMO_PLAN) {
      const author = item.author === 'you'
        ? { id: userId, name: userName }
        : { id: item.author, name: memberName(item.author) };
      const closes = new Date(now.getTime() + item.hours * 3600 * 1000);
      const created = new Date(now.getTime() - Math.max(2, 48 - item.hours) * 3600 * 1000);
      const res = await client.query(
        `INSERT INTO decisions (user_id, user_name, question, details, closes_at, created_at, demo_owner, demo_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [author.id, author.name, item.question, item.details, closes, created, userId, item.key]);
      const id = res.rows[0].id;
      const votes = [...yesVotes(item.yes.map((m) => ({ id: m }))), ...noVotes(item.no.map((m) => ({ id: m })))]
        .map((v) => ({ ...v, user_id: v.user_id + '-' + Math.random().toString(36).slice(2, 7) }));
      if (item.myVote) votes.push({ user_id: userId, choice: item.myVote });
      for (const v of votes) {
        await client.query(
          `INSERT INTO votes (decision_id, user_id, choice) VALUES ($1,$2,$3)
           ON CONFLICT (decision_id, user_id) DO NOTHING`, [id, v.user_id, v.choice]);
      }
      for (const c of item.comments) {
        const commenter = c.by === 'you'
          ? { id: userId, name: userName }
          : { id: c.by, name: c.name || memberName(c.by) };
        await client.query(
          `INSERT INTO comments (decision_id, user_id, user_name, body, created_at, demo_owner, demo_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (demo_owner, demo_key) DO NOTHING`,
          [id, commenter.id, commenter.name, c.body,
            new Date(now.getTime() - c.agoMin * 60000), userId, item.key + '-c' + item.comments.indexOf(c)]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
const userNameOf = (user) =>
  (user && (user.username || user.name || user.nickname)) || 'A member';

// Demo rows are owned by the account that asked for them and must never
// appear in a response that does not pass demo=1, whatever route it is —
// every read goes through this fragment.
function demoFilter(req, col = 'demo_owner') {
  const wants = IS_STAGING && req.query.demo === '1';
  const uid = req.user ? String(req.user.id) : null;
  if (wants && uid) return { sql: `AND (${col} IS NULL OR ${col} = $DEMO)`, uid, param: '$DEMO' };
  return { sql: `AND ${col} IS NULL`, uid: null, param: null };
}
const DECISION_COLS = `
  d.id, d.user_id, d.user_name, d.question, d.details, d.closes_at, d.created_at,
  (SELECT count(*) FROM votes v WHERE v.decision_id = d.id AND v.choice = 'yes') AS yes_count,
  (SELECT count(*) FROM votes v WHERE v.decision_id = d.id AND v.choice = 'no') AS no_count,
  (SELECT count(*) FROM comments c WHERE c.decision_id = d.id) AS comment_count`;

function shapeDecision(row, userId) {
  const yes = Number(row.yes_count);
  const no = Number(row.no_count);
  const total = yes + no;
  let result;
  if (total === 0) result = 'No votes';
  else if (yes === no) result = `Tied ${yes} to ${no}`;
  else if (yes > no) result = `Yes ${yes} to ${no}`;
  else result = `No ${no} to ${yes}`;
  return {
    id: Number(row.id),
    question: row.question,
    details: row.details,
    authorId: row.user_id,
    authorName: row.user_name || 'A member',
    mine: userId != null && String(row.user_id) === String(userId),
    closesAt: row.closes_at,
    createdAt: row.created_at,
    closed: new Date(row.closes_at) <= new Date(row.now),
    yesCount: yes,
    noCount: no,
    totalVotes: total,
    commentCount: Number(row.comment_count),
    myVote: row.my_vote || null,
    result,
  };
}

async function loadDecision(req, id) {
  const filter = demoFilter(req);
  const args = [id];
  let demoSql = filter.sql;
  if (filter.param) {
    demoSql = filter.sql.replace('$DEMO', '$' + (args.length + 1));
    args.push(filter.uid);
  }
  const mine = req.user
    ? `, (SELECT choice FROM votes v WHERE v.decision_id = d.id AND v.user_id = $${args.length + 1}) AS my_vote`
    : '';
  if (req.user) args.push(String(req.user.id));
  args.push(req.now);
  const res = await pool.query(
    `SELECT ${DECISION_COLS}${mine}, $${args.length}::timestamptz AS now
     FROM decisions d WHERE d.id = $1 ${demoSql}`, args);
  return res.rows[0] || null;
}

// ── API ────────────────────────────────────────────────────────────────────

// The list: open decisions first (newest first), then the recently decided.
app.get('/api/decisions', async (req, res) => {
  try {
    if (IS_STAGING && req.query.demo === '1' && req.user) {
      await seedDemo(String(req.user.id), userNameOf(req.user), req.now);
    }
    const filter = demoFilter(req);
    const args = [];
    let demoSql = filter.sql;
    if (filter.param) {
      demoSql = filter.sql.replace('$DEMO', '$1');
      args.push(filter.uid);
    }
    const mine = req.user
      ? `, (SELECT choice FROM votes v WHERE v.decision_id = d.id AND v.user_id = $${args.length + 1}) AS my_vote`
      : '';
    if (req.user) args.push(String(req.user.id));
    args.push(req.now);
    const rows = await pool.query(
      `SELECT ${DECISION_COLS}${mine}, $${args.length}::timestamptz AS now
       FROM decisions d WHERE TRUE ${demoSql}
       ORDER BY d.created_at DESC LIMIT 200`, args);
    res.json({
      now: req.now,
      decisions: rows.rows.map((r) => shapeDecision(r, req.user ? req.user.id : null)),
    });
  } catch (err) {
    console.error('GET /api/decisions failed: ' + err.message);
    res.status(500).json({ error: 'Could not load the decisions.' });
  }
});

app.post('/api/decisions', async (req, res) => {
  try {
    const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
    const details = typeof req.body.details === 'string' ? req.body.details.trim() : '';
    if (!question || question.length > 200) {
      return res.status(400).json({ error: 'The question needs 1 to 200 characters.' });
    }
    if (details.length > 2000) {
      return res.status(400).json({ error: 'Details can be up to 2000 characters.' });
    }
    const closes = new Date(req.body.closes_at || '');
    if (Number.isNaN(closes.getTime()) || closes <= req.now) {
      return res.status(400).json({ error: 'Pick a deadline in the future.' });
    }
    // A decision the member actually posts is a real row even on the demo
    // page: only the seeded rows carry demo_owner, so what someone writes
    // stays visible once they browse without ?demo=1.
    const row = await pool.query(
      `INSERT INTO decisions (user_id, user_name, question, details, closes_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [String(req.user.id), userNameOf(req.user), question, details, closes]);
    const shaped = await loadDecision(req, row.rows[0].id);
    res.status(201).json({ decision: shapeDecision(shaped, req.user.id) });
  } catch (err) {
    console.error('POST /api/decisions failed: ' + err.message);
    res.status(500).json({ error: 'Could not post the decision.' });
  }
});

app.get('/api/decisions/:id', async (req, res) => {
  try {
    const row = await loadDecision(req, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Decision not found.' });
    // Comments are gated by their decision alone (a demo decision's
    // comments never surface without demo=1), so no demo filter of their
    // own is needed here.
    const comments = await pool.query(
      `SELECT c.id, c.user_id, c.user_name, c.body, c.created_at
       FROM comments c WHERE c.decision_id = $1
       ORDER BY c.created_at ASC, c.id ASC LIMIT 500`, [Number(req.params.id)]);
    res.json({
      now: req.now,
      user: req.user ? { id: String(req.user.id), name: userNameOf(req.user) } : null,
      decision: shapeDecision(row, req.user ? req.user.id : null),
      comments: comments.rows.map((c) => ({
        id: Number(c.id),
        authorId: c.user_id,
        authorName: c.user_name || 'A member',
        mine: req.user != null && String(c.user_id) === String(req.user.id),
        body: c.body,
        createdAt: c.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/decisions/:id failed: ' + err.message);
    res.status(500).json({ error: 'Could not load this decision.' });
  }
});

// One vote per member, changeable until the deadline. After it the decision
// is closed and the vote is refused with 409.
app.put('/api/decisions/:id/vote', async (req, res) => {
  try {
    const choice = req.body.choice;
    if (choice !== 'yes' && choice !== 'no') {
      return res.status(400).json({ error: 'Vote yes or no.' });
    }
    const row = await loadDecision(req, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Decision not found.' });
    if (new Date(row.closes_at) <= req.now) {
      return res.status(409).json({ error: 'This decision has closed.' });
    }
    await pool.query(
      `INSERT INTO votes (decision_id, user_id, choice) VALUES ($1,$2,$3)
       ON CONFLICT (decision_id, user_id) DO UPDATE SET choice = EXCLUDED.choice`,
      [Number(req.params.id), String(req.user.id), choice]);
    const fresh = await loadDecision(req, Number(req.params.id));
    res.json({ decision: shapeDecision(fresh, req.user.id) });
  } catch (err) {
    console.error('PUT /api/decisions/:id/vote failed: ' + err.message);
    res.status(500).json({ error: 'Could not record the vote.' });
  }
});

app.delete('/api/decisions/:id', async (req, res) => {
  try {
    const row = await loadDecision(req, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Decision not found.' });
    if (String(row.user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Only the person who posted can delete it.' });
    }
    await pool.query('DELETE FROM decisions WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/decisions/:id failed: ' + err.message);
    res.status(500).json({ error: 'Could not delete the decision.' });
  }
});

app.post('/api/decisions/:id/comments', async (req, res) => {
  try {
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body || body.length > 1000) {
      return res.status(400).json({ error: 'Write a comment of 1 to 1000 characters.' });
    }
    const row = await loadDecision(req, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Decision not found.' });
    const ins = await pool.query(
      `INSERT INTO comments (decision_id, user_id, user_name, body)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [Number(req.params.id), String(req.user.id), userNameOf(req.user), body]);
    res.status(201).json({
      comment: {
        id: Number(ins.rows[0].id),
        authorId: String(req.user.id),
        authorName: userNameOf(req.user),
        mine: true,
        body,
        createdAt: ins.rows[0].created_at,
      },
    });
  } catch (err) {
    console.error('POST comment failed: ' + err.message);
    res.status(500).json({ error: 'Could not post the comment.' });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  try {
    const row = await pool.query('SELECT user_id FROM comments WHERE id = $1', [Number(req.params.id)]);
    if (!row.rows.length) return res.status(404).json({ error: 'Comment not found.' });
    if (String(row.rows[0].user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Only your own comments can be deleted.' });
    }
    await pool.query('DELETE FROM comments WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/comments/:id failed: ' + err.message);
    res.status(500).json({ error: 'Could not delete the comment.' });
  }
});

// A report is recorded for the app's admins. Nothing is hidden automatically.
app.post('/api/reports', async (req, res) => {
  try {
    const kind = req.body.target_kind;
    const id = Number(req.body.target_id);
    if ((kind !== 'decision' && kind !== 'comment') || !Number.isInteger(id)) {
      return res.status(400).json({ error: 'Say what is being reported.' });
    }
    await pool.query(
      `INSERT INTO reports (target_kind, target_id, reporter_id) VALUES ($1,$2,$3)
       ON CONFLICT (target_kind, target_id, reporter_id) DO NOTHING`,
      [kind, id, String(req.user.id)]);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('POST /api/reports failed: ' + err.message);
    res.status(500).json({ error: 'Could not record the report.' });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/club-votes-4d5b95/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/club-votes-4d5b95/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Leave cleanly when the platform stops the container: stop taking new
// requests, let the ones in flight finish (at most a few seconds), close
// the database pool, exit.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
  // In-flight requests get a grace period; then we leave anyway.
  setTimeout(() => process.exit(0), 3000).unref();
}

let server;
async function start() {
  await ensureSchema();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
