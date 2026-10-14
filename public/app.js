/* Club Votes, first version. A hash-routed page that renders the two screens
   the spec drew (their look lives in screens.css) from live data:
     #/        the list of open decisions, then the recently decided
     #/new     post a decision
     #/d/:id   one decision: the big tally, your vote, the comments
   The API is same-origin under /api, with the viewer's token forwarded.
   Every screen has its loading, empty and error states; nothing shows a
   made-up value while loading or after a failure. */
(function () {
  'use strict';

  var view = document.getElementById('view');

  // The shell puts the viewer's token in the query string on load; later
  // calls carry it in a header. demo=1, if the page was opened with it, is
  // passed through to the read API so the staging demo rows are visible.
  var pageParams = new URLSearchParams(location.search);
  var TOKEN = pageParams.get('token') || '';
  var DEMO = pageParams.get('demo') === '1';
  var demoQ = DEMO ? 'demo=1&' : '';

  function api(path, opts) {
    opts = opts || {};
    var init = {
      method: opts.method || 'GET',
      headers: { 'x-usernode-token': TOKEN },
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      }, function () {
        return { status: res.status, ok: res.ok, data: {} };
      });
    });
  }

  // ── Time ────────────────────────────────────────────────────────────────
  // The server answers with its own "now" (which follows a staging
  // preview's chosen moment); the page keeps that clock and advances it,
  // so "Ends in 2 days" and "2 h ago" agree with what the data means.
  var serverNow = new Date();
  var serverNowAt = 0;
  function setNow(iso) {
    serverNow = new Date(iso);
    serverNowAt = Date.now();
  }
  function nowMs() {
    return serverNow.getTime() + (Date.now() - serverNowAt);
  }

  function endsIn(iso) {
    var ms = new Date(iso).getTime() - nowMs();
    if (ms <= 0) return 'Closed';
    var min = Math.ceil(ms / 60000);
    if (min < 60) return 'Ends in ' + min + ' min';
    var h = Math.ceil(min / 60);
    if (h < 24) return 'Ends in ' + h + ' hours';
    var d = Math.round(h / 24);
    if (d <= 1) return 'Ends tomorrow';
    return 'Ends in ' + d + ' days';
  }

  function endsWithDay(iso) {
    var short = endsIn(iso);
    var ms = new Date(iso).getTime() - nowMs();
    if (ms <= 0 || ms < 24 * 3600 * 1000) return short;
    var at = new Date(iso);
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var h = at.getHours();
    var hour = ((h + 11) % 12 + 1) + (h < 12 ? ' am' : ' pm');
    return short + ', ' + days[at.getDay()] + ' ' + hour;
  }

  function ago(iso) {
    var ms = nowMs() - new Date(iso).getTime();
    if (ms < 0) return 'just now';
    var min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var h = Math.floor(min / 60);
    if (h < 24) return h + ' h ago';
    return Math.floor(h / 24) + ' d ago';
  }

  // ── Markup helpers ──────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var TICK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  // The ballot box: the signature element. Yes votes fill it from the left
  // in the tally colour; No makes up the rest.
  function ballot(d) {
    var pct = d.totalVotes ? Math.round(d.yesCount * 100 / d.totalVotes) : 0;
    return '<div class="ballot"><div class="slot"></div><div class="box">'
      + (d.yesCount
        ? '<div class="fill" style="width:' + pct + '%">Yes ' + d.yesCount + '</div>'
        : '')
      + '<div class="rest">'
      + (d.totalVotes ? 'No ' + d.noCount : 'No votes yet') + '</div>'
      + '</div></div>';
  }

  function status(msg) {
    var el = document.getElementById('status');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
    if (msg) {
      clearTimeout(status.t);
      status.t = setTimeout(function () { el.hidden = true; }, 4000);
    }
  }

  // ── The list (screen 1) ─────────────────────────────────────────────────
  function card(d) {
    var inner =
      '<div class="meta"><span>Posted by ' + esc(d.mine ? 'you' : d.authorName) + '</span>'
      + '<span>' + esc(endsIn(d.closesAt)) + '</span></div>'
      + '<a class="q" href="#/d/' + d.id + '">' + esc(d.question) + '</a>'
      + ballot(d)
      + '<div class="legend"><span>' + d.totalVotes + ' votes</span>'
      + '<span>' + d.commentCount + ' comments</span></div>';
    var foot;
    if (d.myVote) {
      foot = '<div class="done">' + TICK + 'You voted ' + (d.myVote === 'yes' ? 'Yes' : 'No') + '</div>';
    } else {
      foot = '<div class="acts">'
        + '<button class="btn-secondary" data-vote="yes" data-id="' + d.id + '">Yes</button>'
        + '<button class="btn-secondary" data-vote="no" data-id="' + d.id + '">No</button>'
        + '</div>';
    }
    return '<div class="card">' + inner + foot + '</div>';
  }

  function resultRow(d) {
    return '<li class="list-row"><a class="t" href="#/d/' + d.id + '">'
      + esc(d.question) + '</a><span class="pill">' + esc(d.result) + '</span></li>';
  }

  function skeletonCards() {
    var bar = function (w) { return '<div class="skeleton" style="height:14px;width:' + w + '%"></div>'; };
    var one =
      '<div class="card">'
      + '<div class="meta" style="display:flex;justify-content:space-between;gap:16px">' + bar(30) + bar(25) + '</div>'
      + '<div style="margin:6px 0 14px">' + bar(80) + '</div>'
      + '<div class="ballot"><div class="slot"></div><div class="box"></div></div>'
      + '<div class="legend" style="display:flex;justify-content:space-between;gap:16px">' + bar(20) + bar(20) + '</div>'
      + '</div>';
    return one + one + one;
  }

  function renderList(data) {
    view.setAttribute('data-spec-screen', '1');
    var open = data.decisions.filter(function (d) { return !d.closed; });
    var closed = data.decisions.filter(function (d) { return d.closed; });
    var needs = open.filter(function (d) { return !d.myVote; });
    var voted = open.filter(function (d) { return d.myVote; });

    var html = '<div class="app">'
      + '<div class="top"><div><div class="sub">Club Votes</div>'
      + '<div class="title">Open decisions</div>'
      + (DEMO ? '<div class="sub" data-usernode-demo-note>Staging demo</div>' : '')
      + '</div></div>'
      + '<a class="btn-primary" href="#/new" style="width:100%;margin-top:12px;text-decoration:none">'
      + '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Post a decision</a>'
      + '<div id="status" class="hint" style="color:rgb(var(--danger))" hidden></div>';

    if (!data.decisions.length) {
      html += '<div class="state-empty">'
        + '<div class="q" style="font-size:20px">No open decisions yet</div>'
        + '<p class="hint" style="margin-top:4px">Post the first thing the club needs to decide.</p>'
        + '<a class="btn-primary" href="#/new" style="text-decoration:none;margin-top:8px">Post a decision</a>'
        + '</div></div>';
      return html;
    }

    if (needs.length) {
      html += '<div class="section-label">Needs your vote (' + needs.length + ')</div>'
        + needs.map(card).join('');
    }
    if (voted.length) {
      html += '<div class="section-label">You voted</div>' + voted.map(card).join('');
    }
    if (closed.length) {
      html += '<div class="section-label">Recently decided</div><ul class="list">'
        + closed.map(resultRow).join('') + '</ul>';
    }
    html += '</div>';
    return html;
  }

  // ── The detail screen (screen 2) ────────────────────────────────────────
  function commentRow(c) {
    var act = c.mine
      ? '<button class="quiet" data-del-comment="' + c.id + '">Delete</button>'
      : '<button class="quiet" data-report-comment="' + c.id + '">Report</button>';
    return '<li class="list-row"><div class="who"><b>'
      + esc(c.mine ? 'You' : c.authorName) + '</b><span>' + esc(ago(c.createdAt)) + '</span></div>'
      + '<p class="body">' + esc(c.body) + '</p>'
      + '<div class="row-acts">' + act + '</div></li>';
  }

  function renderDetail(data) {
    var d = data.decision;
    view.setAttribute('data-spec-screen', '2');
    var legendRight = d.closed ? esc(d.result) : 'Voting open';
    var yourVote;
    if (d.closed) {
      yourVote = '';
    } else {
      yourVote = '<div class="section-label">Your vote</div>'
        + '<div class="acts">'
        + '<button class="btn-secondary' + (d.myVote === 'yes' ? ' picked' : '') + '" data-vote="yes" data-id="' + d.id + '">'
        + (d.myVote === 'yes' ? TICK : '') + 'Yes</button>'
        + '<button class="btn-secondary' + (d.myVote === 'no' ? ' picked' : '') + '" data-vote="no" data-id="' + d.id + '">'
        + (d.myVote === 'no' ? TICK : '') + 'No</button>'
        + '</div>'
        + (d.myVote ? '<p class="hint">You can change your vote until it ends.</p>' : '');
    }
    var comments = data.comments.map(commentRow).join('');
    var form;
    if (data.user) {
      form = '<label class="label" for="comment-field">Add a comment</label>'
        + '<textarea class="field" id="comment-field" maxlength="1000" '
        + 'placeholder="e.g. Works for me if we keep 7 pm"></textarea>'
        + '<div class="send"><button class="btn-primary" data-comment="' + d.id + '">Post comment</button></div>';
    } else {
      form = '<p class="hint">Make an account to join in.</p>';
    }
    var foot = data.user
      ? '<div class="foot">'
        + (d.mine ? '<button class="quiet" data-del-decision="' + d.id + '">Delete this decision</button>' : '')
        + '<button class="quiet" data-report-decision="' + d.id + '">Report this decision</button>'
        + '</div>'
      : '';
    return '<div class="app">'
      + '<a class="back" href="#/"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Open decisions</a>'
      + '<div class="meta"><span>Posted by ' + esc(d.mine ? 'you' : d.authorName) + '</span>'
      + '<span>' + esc(d.closed ? 'Closed' : endsWithDay(d.closesAt)) + '</span></div>'
      + '<div class="title">' + esc(d.question) + '</div>'
      + (d.details ? '<p class="details">' + esc(d.details) + '</p>' : '')
      + ballot(d)
      + '<div class="legend"><span>' + d.totalVotes + ' votes</span><span>' + legendRight + '</span></div>'
      + '<div id="status" class="hint" style="color:rgb(var(--danger))" hidden></div>'
      + yourVote
      + '<div class="section-label">Comments (' + data.comments.length + ')</div>'
      + (data.comments.length ? '<ul class="list">' + comments + '</ul>' : '')
      + form
      + foot
      + '</div>';
  }

  function skeletonDetail() {
    var bar = function (w, h) {
      return '<div class="skeleton" style="height:' + (h || 14) + 'px;width:' + w + '%"></div>';
    };
    return '<div class="app">'
      + bar(35)
      + '<div class="meta" style="display:flex;justify-content:space-between;gap:16px">' + bar(30) + bar(30) + '</div>'
      + '<div style="margin:10px 0 12px">' + bar(70, 28) + '</div>'
      + '<div style="margin-bottom:20px">' + bar(90) + '</div>'
      + '<div class="ballot"><div class="slot"></div><div class="box" style="height:44px"></div></div>'
      + '<div class="section-label" style="margin-top:24px">Comments</div>'
      + '<ul class="list"><li class="list-row" style="display:block">' + bar(40) + bar(85) + '</li></ul>'
      + '</div>';
  }

  // ── Post a decision ─────────────────────────────────────────────────────
  function defaultCloses() {
    var d = new Date(nowMs() + 3 * 24 * 3600 * 1000);
    d.setSeconds(0, 0);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderNew() {
    view.setAttribute('data-spec-screen', '2');
    return '<div class="app">'
      + '<a class="back" href="#/"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Open decisions</a>'
      + '<div class="title" style="margin-top:8px">Post a decision</div>'
      + '<div id="status" class="hint" style="color:rgb(var(--danger))" hidden></div>'
      + '<label class="label" for="f-question">Question</label>'
      + '<input class="field" id="f-question" maxlength="200" '
      + 'placeholder="e.g. Move Thursday meetups to the library?">'
      + '<label class="label" for="f-details">Details <span style="font-weight:400">(optional)</span></label>'
      + '<textarea class="field" id="f-details" maxlength="2000" style="min-height:110px" '
      + 'placeholder="e.g. Same time, 7 pm"></textarea>'
      + '<label class="label" for="f-closes">Voting ends</label>'
      + '<input class="field" id="f-closes" type="datetime-local" value="' + defaultCloses() + '">'
      + '<div class="send" style="justify-content:flex-start;margin-top:20px">'
      + '<button class="btn-primary" data-post>Post decision</button></div>'
      + '</div>';
  }

  // ── Loading and rendering ───────────────────────────────────────────────
  var current = { kind: 'list' };
  var lastData = null;

  function show(html) {
    view.innerHTML = html;
  }

  function loadList() {
    show('<div class="app">'
      + '<div class="top"><div><div class="sub">Club Votes</div><div class="title">Open decisions</div></div></div>'
      + skeletonCards() + '</div>');
    api('/api/decisions?' + demoQ + 't=' + Date.now()).then(function (res) {
      if (location.hash !== '#/' && location.hash !== '') return;
      if (!res.ok) return show(listError());
      setNow(res.data.now);
      lastData = res.data;
      show(renderList(res.data));
    });
  }

  function listError() {
    return '<div class="app">'
      + '<div class="top"><div><div class="sub">Club Votes</div><div class="title">Open decisions</div></div></div>'
      + '<div class="state-error"><div class="q" style="font-size:20px">Could not load the decisions</div>'
      + '<p class="hint">Nothing was changed. Voting and posting still work once the list loads.</p>'
      + '<button class="btn-secondary" data-retry>Retry</button></div></div>';
  }

  function loadDetail(id) {
    show(skeletonDetail());
    api('/api/decisions/' + id + '?' + demoQ + 't=' + Date.now()).then(function (res) {
      if (!('/d/' + id === route().idPath)) return;
      if (res.status === 404) {
        return show('<div class="app"><a class="back" href="#/">'
          + '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Open decisions</a>'
          + '<div class="state-error"><div class="q" style="font-size:20px">This decision is gone</div>'
          + '<p class="hint">It was probably deleted by the person who posted it.</p></div></div>');
      }
      if (!res.ok) {
        return show('<div class="app"><a class="back" href="#/">'
          + '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Open decisions</a>'
          + '<div class="state-error"><div class="q" style="font-size:20px">Could not load this decision</div>'
          + '<p class="hint">Nothing was changed. The list still works from Open decisions.</p>'
          + '<button class="btn-secondary" data-retry="' + id + '">Retry</button></div></div>');
      }
      setNow(res.data.now);
      lastData = res.data;
      current.id = id;
      show(renderDetail(res.data));
    });
  }

  function route() {
    var h = location.hash.replace(/^#/, '') || '/';
    var m = h.match(/^\/d\/(\d+)/);
    return m ? { kind: 'detail', id: m[1], idPath: '/d/' + m[1] }
      : (h === '/new' ? { kind: 'new' } : { kind: 'list' });
  }

  function render() {
    current = route();
    if (current.kind === 'detail') loadDetail(current.id);
    else if (current.kind === 'new') show(renderNew());
    else loadList();
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  function refresh() {
    if (current.kind === 'detail') loadDetail(current.id);
    else if (current.kind === 'list') loadList();
  }

  function vote(id, choice) {
    api('/api/decisions/' + id + '/vote', { method: 'PUT', body: { choice: choice } })
      .then(function (res) {
        if (res.status === 401) return status('Make an account to vote.');
        if (res.status === 409) { status('This decision has closed.'); return refresh(); }
        if (!res.ok) return status('Could not record the vote. Try again.');
        status('');
        if (current.kind === 'detail') loadDetail(current.id);
        else loadList();
      });
  }

  function postComment(id) {
    var field = document.getElementById('comment-field');
    var body = field && field.value.trim();
    if (!body) return;
    api('/api/decisions/' + id + '/comments', { method: 'POST', body: { body: body } })
      .then(function (res) {
        if (res.status === 401) return status('Make an account to comment.');
        if (!res.ok) return status('Could not post the comment. Try again.');
        loadDetail(current.id);
      });
  }

  function delComment(id) {
    api('/api/comments/' + id, { method: 'DELETE' }).then(function (res) {
      if (!res.ok) return status('Could not delete the comment. Try again.');
      loadDetail(current.id);
    });
  }

  function report(kind, id) {
    api('/api/reports', { method: 'POST', body: { target_kind: kind, target_id: id } })
      .then(function (res) {
        if (!res.ok) return status('Could not send the report. Try again.');
        status('Reported. An admin will take a look.');
      });
  }

  function delDecision(id) {
    api('/api/decisions/' + id, { method: 'DELETE' }).then(function (res) {
      if (!res.ok) return status('Could not delete the decision. Try again.');
      location.hash = '#/';
    });
  }

  function postDecision() {
    var question = (document.getElementById('f-question').value || '').trim();
    var details = (document.getElementById('f-details').value || '').trim();
    var closesRaw = document.getElementById('f-closes').value;
    if (!question) return status('Write the question the club is deciding.');
    if (!closesRaw) return status('Pick when voting ends.');
    var closes = new Date(closesRaw);
    api('/api/decisions', {
      method: 'POST',
      body: { question: question, details: details, closes_at: closes.toISOString() },
    }).then(function (res) {
      if (res.status === 400) return status(res.data.error || 'Check the question and the deadline.');
      if (!res.ok) return status('Could not post the decision. Try again.');
      loadList();
      location.hash = '#/';
    });
  }

  // One listener for everything: buttons and links inside the rendered
  // screens. Browser-side only; nothing runs until the viewer taps.
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-vote],[data-comment],[data-del-comment],'
      + '[data-del-decision],[data-report-decision],[data-report-comment],[data-post],[data-retry]');
    if (!el) return;
    if (el.hasAttribute('data-vote')) return vote(el.getAttribute('data-id'), el.getAttribute('data-vote'));
    if (el.hasAttribute('data-comment')) return postComment(el.getAttribute('data-comment'));
    if (el.hasAttribute('data-del-comment')) return delComment(el.getAttribute('data-del-comment'));
    if (el.hasAttribute('data-del-decision')) return delDecision(el.getAttribute('data-del-decision'));
    if (el.hasAttribute('data-report-decision')) return report('decision', el.getAttribute('data-report-decision'));
    if (el.hasAttribute('data-report-comment')) return report('comment', el.getAttribute('data-report-comment'));
    if (el.hasAttribute('data-post')) return postDecision();
    if (el.hasAttribute('data-retry')) return refresh();
  });

  window.addEventListener('hashchange', render);
  render();
})();
