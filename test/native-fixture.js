// Test-only Cordis fixture. It is copied into a private DSH_HOME by native-host.js;
// it is not exported or included in the published plugin. No model is invoked.
export const name = 'focus-fixture';
export const inject = ['webServer', 'connection', 'workspaceRegistry', 'sessions', 'sessionQuery', 'sessionPersistence'];

export async function apply(ctx, config) {
  const { root, profile, extended = false } = config;
  const parent = await ctx.workspaceRegistry.create(root, 'Focus QA Parent');
  const child = await ctx.workspaceRegistry.create(profile, 'Focus QA Child');
  const entries = new Map();
  let messageNumber = 0;
  const userMessage = text => ({ id: `fixture-user-${++messageNumber}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const assistantMessage = text => ({ id: `fixture-assistant-${++messageNumber}`, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text }] });
  function assistantStream(content) {
    const started = Date.now();
    const records = content.map((block, index) => ({ type: 'chunk', time: started,
      chunk: block.type === 'tool-call'
        ? { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments }
        : { type: 'text-delta', index, text: block.text || '' }
    }));
    records.push({ type: 'chunk', time: started, chunk: { type: 'finish', reason: { kind: 'completed' } } });
    return records;
  }

  function create(id, cwd, title, meta = {}) {
    const session = ctx.sessions.prepare(id, { meta: { cwd, ...meta } });
    const detach = ctx.sessions.enter(session);
    ctx.effect(() => detach);
    ctx.sessions.announce(session);
    const entry = { session, detach, turn: 0, open: false, stepOpen: false, callId: null, approvalId: null };
    entries.set(id, entry);
    if (title) session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } });
    return entry;
  }

  function begin(entry, text = 'Synthetic sidebar fixture; no agent is started.') {
    entry.turn += 1;
    entry.open = true;
    entry.session.append('turn/start', { turn: entry.turn });
    entry.session.append('user/message', userMessage(text), { surfaceOp: 'append' });
  }

  function openStep(entry) {
    if (entry.stepOpen) return;
    entry.session.append('step/start', { turn: entry.turn, step: 1 });
    entry.stepOpen = true;
  }

  function advertiseAsk(entry, callId, argumentsText) {
    openStep(entry);
    const content = [{ type: 'tool-call', id: callId, name: 'ask_user_question', arguments: argumentsText }];
    entry.session.append('assistant/message', {
      turn: entry.turn, step: 1,
      message: { ...assistantMessage(''), content },
      stream: assistantStream(content)
    }, { surfaceOp: 'append' });
    entry.session.append('tool/call', { turn: entry.turn, step: 1, name: 'ask_user_question', callId, arguments: argumentsText });
  }

  function result(entry, callId, content, error) {
    entry.session.append('tool/result', {
      turn: entry.turn, step: 1,
      message: { id: `fixture-tool-${++messageNumber}`, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content, ...(error ? { isError: true } : {}) },
      ...(error ? { error } : {})
    }, { surfaceOp: 'append' });
  }

  function finish(entry, kind = 'completed', reply) {
    if (!entry.open) return;
    if (entry.callId) {
      result(entry, entry.callId, [], { code: 'FIXTURE_CANCELLED', message: 'The synthetic question was closed.' });
      entry.callId = null;
    }
    if (entry.approvalId) {
      entry.session.append('approval/decided', { id: entry.approvalId, outcome: 'cancelled' });
      entry.approvalId = null;
    }
    if (reply) {
      openStep(entry);
      const message = assistantMessage(reply);
      entry.session.append('assistant/message', { turn: entry.turn, step: 1, message, stream: assistantStream(message.content) }, { surfaceOp: 'append' });
    }
    if (entry.stepOpen) {
      entry.session.append('step/end', { turn: entry.turn, step: 1 });
      entry.stepOpen = false;
    }
    const reason = kind === 'error'
      ? { kind, error: { code: 'UNKNOWN', message: [{ name: 'Error', message: 'Synthetic fixture failure' }] } }
      : kind === 'aborted' ? { kind, reason: { kind: 'user' } } : { kind };
    entry.session.append('turn/end', { turn: entry.turn, reason });
    entry.open = false;
  }

  const primary = create('session-focus-qa', profile, 'Focus QA Session');
  begin(primary);
  finish(primary);
  await child.attachSession(primary.session.id);
  const fixture = { parent: parent.id, child: child.id, session: primary.session.id, extended };

  if (extended) {
    const grand = await ctx.workspaceRegistry.create(`${profile}/nested`, 'Focus QA Grandchild with a long workspace name');
    const peer = await ctx.workspaceRegistry.create(`${root}/peer`, 'Focus QA Peer');
    fixture.grandchild = grand.id;
    fixture.peer = peer.id;
    fixture.parentSession = 'session-focus-parent';
    const own = create(fixture.parentSession, root, 'Parent-owned conversation');
    begin(own); finish(own);
    await parent.attachSession(own.session.id);
    fixture.overflowSessions = [];
    for (let i = 0; i < 8; i += 1) {
      const id = `session-focus-overflow-${i}`;
      const entry = create(id, `${profile}/nested`, `Overflow conversation ${i + 1}`);
      begin(entry); finish(entry);
      await grand.attachSession(id);
      fixture.overflowSessions.push(id);
    }
    fixture.untitled = 'session-focus-untitled';
    const untitled = create(fixture.untitled, profile);
    begin(untitled); finish(untitled);
    await child.attachSession(fixture.untitled);
    fixture.blank = 'session-focus-blank';
    const blank = create(fixture.blank, profile);
    // A reusable native blank must be persisted and not owned by this fixture's
    // live Session attachment. Otherwise native New attempts resume and fails.
    const blankWriter = await ctx.sessionPersistence.create(blank.session.header);
    ctx.effect(() => () => blankWriter.close());
    blank.session.append('session/title', { title: 'Reusable blank fixture', messageSeqs: [], source: { kind: 'user' } });
    await child.attachSession(fixture.blank);
    await ctx.sessions.flush(blank.session);
    blank.detach();
    await blankWriter.close();
    fixture.approval = 'session-focus-approval';
    const approval = create(fixture.approval, `${profile}/nested`, 'Approval pending before plugin activation');
    begin(approval);
    approval.approvalId = 'fixture-initial-approval';
    approval.session.append('approval/asked', { id: approval.approvalId, toolName: 'fixture_tool', reason: { message: 'Synthetic approval; no operation runs.' } });
    await grand.attachSession(fixture.approval);

    fixture.coldQuestion = 'session-focus-cold-question';
    const cold = create(fixture.coldQuestion, `${root}/peer`);
    // A standalone Session is not an Agent: explicitly own its persistence writer
    // before publishing events, exactly as the native Agent creation transaction does.
    const coldWriter = await ctx.sessionPersistence.create(cold.session.header);
    ctx.effect(() => () => coldWriter.close());
    cold.session.append('session/title', { title: 'Cold pending question', messageSeqs: [], source: { kind: 'user' } });
    begin(cold);
    openStep(cold);
    cold.session.append('request/header', {
      turn: cold.turn, step: 1, reason: 'initial', header: {
        config: { provider: 'fixture', model: 'fixture' },
        tools: [{ name: 'ask_user_question', description: 'Synthetic question', parameters: { type: 'object', properties: { timeout: { type: 'number' } } } }]
      }
    });
    const callId = 'fixture-cold-question-call';
    advertiseAsk(cold, callId, JSON.stringify({ questions: [{ id: 'choice', question: 'Synthetic pending question', options: [{ label: 'Continue' }] }], timeout: 1 }));
    result(cold, callId, [{ type: 'text', text: JSON.stringify({ pending: true, callId }) }]);
    finish(cold);
    await peer.attachSession(fixture.coldQuestion);
    await ctx.sessions.flush(cold.session);
    cold.detach();
    await coldWriter.close();
  }

  async function summary() {
    let cold = null;
    if (fixture.coldQuestion) {
      const observation = await ctx.sessionQuery.observeSession(fixture.coldQuestion, { projectionMode: 'all' });
      try { cold = { live: Boolean(ctx.sessions.get(fixture.coldQuestion)), source: observation.source, questions: observation.projections?.values?.userQuestions }; }
      finally { observation[Symbol.dispose]?.(); }
    }
    return { ...fixture, cold };
  }

  async function control(body) {
    const id = body.sessionId || fixture.session;
    if (body.action === 'archive') { await ctx.workspaceRegistry.archiveSession(id); return; }
    if (body.action === 'unarchive') { await ctx.workspaceRegistry.unarchiveSession(id); return; }
    let entry = entries.get(id);
    if (body.action === 'subagent') {
      if (!entry) entry = create(id, profile, 'Synthetic child agent', { origin: 'subagent', parentSession: body.parentSession || fixture.parentSession || fixture.session, delegationDepth: 1 });
      if (body.running) { if (!entry.open) begin(entry); ctx.emit('api-session/status', id, true); }
      else { finish(entry, body.failed ? 'error' : 'completed', body.failed ? undefined : 'Synthetic child result'); ctx.emit('api-session/status', id, false); if (body.failed) ctx.emit('api-session/error', id, [{ message: 'Synthetic child failure' }]); if (body.detach) entry.detach(); }
      return;
    }
    if (!entry || !ctx.sessions.get(id)) throw Object.assign(new Error('Only live synthetic fixture sessions may change state'), { status: 400 });
    if (body.action === 'state') {
      finish(entry, 'aborted');
      if (body.state === 'idle') { ctx.emit('api-session/status', id, false); return; }
      begin(entry);
      ctx.emit('api-session/status', id, true);
      if (body.state === 'waiting') {
        entry.callId = `fixture-open-${id}-${entry.turn}`;
        advertiseAsk(entry, entry.callId, JSON.stringify({ questions: [{ id: 'q', question: 'Synthetic blocking question', options: [{ label: 'Continue' }] }] }));
      } else if (body.state === 'approval') {
        entry.approvalId = `fixture-approval-${id}-${entry.turn}`;
        entry.session.append('approval/asked', { id: entry.approvalId, toolName: 'fixture_tool' });
      } else if (body.state !== 'running') {
        const reason = body.state === 'cancelled' ? 'aborted' : body.state === 'failed' ? 'error' : 'completed';
        finish(entry, reason, body.state === 'completed' ? 'Synthetic completed result' : undefined);
        ctx.emit('api-session/status', id, false);
        if (body.state === 'failed') ctx.emit('api-session/error', id, [{ message: 'Synthetic fixture failure' }]);
      }
      return;
    }
    throw Object.assign(new Error('Unknown synthetic fixture action'), { status: 400 });
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/focus-fixture', handler: async (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) { req.resume(); res.writeHead(rejection); res.end(); return; }
    try {
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('JSON required'), { status: 415 });
        let text = '';
        for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) throw Object.assign(new Error('Fixture body too large'), { status: 413 }); }
        await control(JSON.parse(text));
      } else if (req.method !== 'GET') throw Object.assign(new Error('Method not allowed'), { status: 405 });
      const response = JSON.stringify(await summary());
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(response);
    } catch (error) { res.writeHead(error.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })); }
  } }));
}
