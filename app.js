(function () {
  'use strict';

  /* ==================== 常量与状态 ==================== */
  const CFG = window.PUBLIC_CONFIG;

  const INTENT_META = {
    refund:   { label: '退款 / 退费', cls: 'intent-refund',   color: '#ef4444', short: '退款' },
    order:    { label: '查询订单',     cls: 'intent-order',    color: '#f59e0b', short: '订单' },
    tech:     { label: '技术支持',     cls: 'intent-tech',     color: '#8b5cf6', short: '技术' },
    general:  { label: '通用咨询',     cls: 'intent-general',  color: '#64748b', short: '通用' }
  };
  const QUICK = [
    '我要申请退款，怎么操作？',
    '帮我查一下订单到哪了',
    'App 一直闪退打不开',
    '支付失败但已经扣款了',
    '转人工客服'
  ];
  const HUMAN_WORDS = /转人工|人工客服|真人|人工服务|要投诉|投诉|找个人|客服电话/;

  const state = {
    cloud: null,
    modelId: null,
    models: [],
    visitorId: '',
    convKey: null,
    conv: null,
    sessions: [],
    messages: [],
    faqs: [],
    lastIntent: { intent: 'general', confidence: 0, need_human: false },
    lastFaqHits: [],
    generating: false,
    abort: null,
    range: 'all',
    adminData: null,
    rating: 0,
    lastSentAt: 0
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'ok');
    el.textContent = msg;
    $('toast-host').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, 3800);
  }

  function fmt(iso, withTime) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return withTime === false
      ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function visitorId() {
    let v = localStorage.getItem('ssa_visitor_id');
    if (!v) { v = 'v_' + uid().slice(0, 18); localStorage.setItem('ssa_visitor_id', v); }
    return v;
  }
  function dbMsg(error, fallback) {
    if (!error) return fallback || '操作失败';
    const code = error.code || '';
    if (code === '42P01') return '云端数据表不存在，请检查数据库初始化';
    if (code === '42501') return '没有访问该数据的权限';
    if (code === '23505') return '记录已存在，请勿重复提交';
    return error.message || fallback || '云端请求失败';
  }
  function llmMsg(error) {
    const code = (error && (error.error && error.error.code || error.code)) || '';
    const raw = (error && (error.error && error.error.message || error.message)) || '大模型调用失败';
    if (code.indexOf('quota_') === 0) return '模型额度已用尽或触发限流，请稍后再试（' + raw + '）';
    if (code.indexOf('auth_') === 0) return '云端模型鉴权失败，请确认应用已发布到正确的域名';
    if (code.indexOf('request_') === 0) return '模型参数不匹配：' + raw;
    if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return '模型服务暂时不可用，请点击重试';
    if (error && error.name === 'AbortError') return '已停止生成';
    return raw;
  }
  function setStatus(dotId, textId, text, cls) {
    const dot = $(dotId), t = $(textId);
    if (dot) dot.className = 'dot ' + (cls || 'dot-green');
    if (t) t.textContent = text;
  }

  /* ==================== 启动 ==================== */
  async function boot() {
    if (!window.WorkBuddyCloud || !window.WorkBuddyCloud.createWorkBuddyCloud) {
      $('boot-text').textContent = '云端 SDK 加载失败，请检查网络后刷新页面';
      $('boot-text').style.color = '#ef4444';
      return;
    }
    try {
      state.cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CFG.endpoint,
        oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
        publishableKey: CFG.publishableKey
      });
    } catch (e) {
      $('boot-text').textContent = '云端客户端初始化失败：' + (e.message || e);
      $('boot-text').style.color = '#ef4444';
      return;
    }

    state.visitorId = visitorId();
    $('visitor-code').textContent = state.visitorId;
    bindEvents();
    renderQuick();
    renderStars();

    try {
      $('boot-text').textContent = '正在加载可用大模型…';
      await loadModels();
      $('boot-text').textContent = '正在同步 FAQ 知识库…';
      await loadFaqs();
      $('boot-text').textContent = '正在恢复云端对话记录…';
      await loadSessions();
    } catch (e) {
      toast('初始化异常：' + (e.message || e), 'err');
    }

    $('boot').classList.add('hidden');
    $('app').classList.remove('hidden');
    setStatus('cloud-dot', 'cloud-status', '云端已连接', 'dot-green');
  }

  /* ==================== 模型 ==================== */
  async function loadModels() {
    try {
      const models = await state.cloud.llm.models.list();
      state.models = (models || []).filter((m) => m && m.enabled !== false && m.disabled !== true && m.id);
    } catch (e) {
      state.models = [];
    }
    const sel = $('model-select');
    if (!state.models.length) {
      sel.innerHTML = '<option>暂无可用模型</option>';
      setStatus('llm-dot', 'llm-status', '模型不可用', 'dot-red');
      return;
    }
    const preferred = state.models.find((m) => m.id === 'auto') || state.models[0];
    state.modelId = preferred.id;
    sel.innerHTML = state.models.map((m) =>
      `<option value="${esc(m.id)}"${m.id === preferred.id ? ' selected' : ''}>${esc(m.name || m.id)}</option>`
    ).join('');
    setStatus('llm-dot', 'llm-status', '模型 ' + (preferred.name || preferred.id), 'dot-green');
  }

  /* ==================== FAQ 知识库 ==================== */
  async function loadFaqs() {
    const { data, error } = await state.cloud.database.from('faq').select('*').order('id', { ascending: true });
    if (error) { toast('FAQ 加载失败：' + dbMsg(error), 'err'); state.faqs = []; return; }
    state.faqs = data || [];
    $('kpi-faq').textContent = state.faqs.length;
  }

  function scoreFaq(faq, q) {
    const text = String(q || '').toLowerCase();
    let score = 0;
    const kws = String(faq.keywords || '').split(/[,，、\s]+/).filter(Boolean);
    for (const k of kws) if (k && text.indexOf(k.toLowerCase()) >= 0) score += 2.2;
    const qq = String(faq.question || '').replace(/[？?，,。.、\s：:]/g, '');
    let overlap = 0;
    for (let i = 0; i < qq.length - 1; i++) if (text.indexOf(qq.slice(i, i + 2)) >= 0) overlap++;
    score += Math.min(overlap, 5) * 0.55;
    return score;
  }
  function searchFaq(q) {
    return state.faqs
      .map((f) => ({ faq: f, score: scoreFaq(f, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  /* ==================== 会话 ==================== */
  async function loadSessions() {
    const { data, error } = await state.cloud.database
      .from('conversations').select('*')
      .eq('visitor_id', state.visitorId)
      .order('updated_at', { ascending: false }).limit(30);
    if (error) { toast('会话列表加载失败：' + dbMsg(error), 'err'); state.sessions = []; }
    else state.sessions = data || [];

    if (!state.sessions.length) {
      await createSession(true);
      return;
    }
    const saved = localStorage.getItem('ssa_last_conv');
    const target = state.sessions.find((s) => s.conversation_key === saved) || state.sessions[0];
    await openSession(target.conversation_key);
    renderSessions();
  }

  async function createSession(withWelcome) {
    const key = uid();
    const { data, error } = await state.cloud.database.from('conversations').insert({
      conversation_key: key,
      visitor_id: state.visitorId,
      title: '新的咨询',
      status: 'active',
      intent: 'general',
      escalated: false
    }).select();
    if (error) { toast('新建会话失败：' + dbMsg(error), 'err'); return; }
    const conv = (data && data[0]) || { conversation_key: key, visitor_id: state.visitorId, title: '新的咨询', status: 'active', intent: 'general', escalated: false };
    state.sessions.unshift(conv);
    state.convKey = key; state.conv = conv; state.messages = [];
    localStorage.setItem('ssa_last_conv', key);
    renderSessions();

    if (withWelcome) {
      const welcome = '您好，我是智能客服「云朵」✦\n可以帮您处理退款、订单查询、技术支持等问题。我会先理解您的意图，再检索知识库为您解答；如果遇到解决不了的情况，会自动为您转接人工客服。';
      await persistMessage('assistant', welcome, { source: 'system' });
    }
    await openSession(key);
  }

  async function openSession(key) {
    state.convKey = key;
    state.conv = state.sessions.find((s) => s.conversation_key === key) || null;
    localStorage.setItem('ssa_last_conv', key);
    const { data, error } = await state.cloud.database
      .from('messages').select('*')
      .eq('conversation_key', key).order('id', { ascending: true }).limit(200);
    if (error) { toast('消息加载失败：' + dbMsg(error), 'err'); state.messages = []; }
    else state.messages = data || [];
    renderSessions();
    renderMessages();
    updateHeader();
    updateInsight();
  }

  function renderSessions() {
    const box = $('session-list');
    if (!state.sessions.length) { box.innerHTML = '<div class="empty-mini">暂无历史会话</div>'; return; }
    box.innerHTML = state.sessions.map((s) => {
      const meta = INTENT_META[s.intent] || INTENT_META.general;
      return `<div class="session-item${s.conversation_key === state.convKey ? ' active' : ''}" data-key="${esc(s.conversation_key)}">
        <div class="session-title">${esc(s.title || '新的咨询')}</div>
        <div class="session-meta"><span style="color:${meta.color}">● ${meta.short}</span><span>${fmt(s.updated_at || s.created_at)}</span>${s.escalated ? '<span style="color:#ef4444">人工</span>' : ''}</div>
      </div>`;
    }).join('');
    box.querySelectorAll('.session-item').forEach((el) => {
      el.addEventListener('click', () => openSession(el.dataset.key));
    });
  }

  /* ==================== 消息渲染 ==================== */
  async function persistMessage(role, content, extra) {
    const row = {
      conversation_key: state.convKey,
      visitor_id: state.visitorId,
      role: role,
      content: content,
      intent: (extra && extra.intent) || state.lastIntent.intent,
      source: (extra && extra.source) || (role === 'assistant' ? 'llm' : 'user'),
      matched_faq_id: (extra && extra.matched_faq_id) || null
    };
    const { data, error } = await state.cloud.database.from('messages').insert(row).select();
    if (error) { toast('消息保存失败：' + dbMsg(error), 'err'); return null; }
    const saved = (data && data[0]) || Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, row);
    state.messages.push(saved);
    return saved;
  }

  function renderMessages() {
    const box = $('message-list');
    if (!state.messages.length) {
      box.innerHTML = '<div class="empty-mini" style="margin:auto">发送一条消息开始咨询吧</div>';
      return;
    }
    box.innerHTML = state.messages.map((m) => bubbleHtml(m)).join('');
    box.scrollTop = box.scrollHeight;
  }

  function bubbleHtml(m) {
    const role = m.role;
    const cls = role === 'user' ? 'user' : (role === 'system' ? 'system' : 'bot');
    const av = role === 'user' ? '我' : '✦';
    const tag = m.source === 'faq' ? '<span class="tag tag-faq">知识库直答</span>'
      : m.source === 'handoff' ? '<span class="tag tag-handoff">已转人工</span>'
      : m.source === 'llm' ? '<span class="tag tag-llm">AI 生成</span>' : '';
    return `<div class="msg ${cls}">
      <div class="msg-avatar">${av}</div>
      <div class="msg-wrap">
        <div class="msg-bubble">${esc(m.content)}</div>
        <div class="msg-meta">${tag}<span>${fmt(m.created_at)}</span></div>
      </div>
    </div>`;
  }

  function appendStreamingBubble() {
    const box = $('message-list');
    const empty = box.querySelector('.empty-mini');
    if (empty) empty.remove();
    const wrap = document.createElement('div');
    wrap.className = 'msg bot';
    wrap.innerHTML = '<div class="msg-avatar">✦</div><div class="msg-wrap"><div class="msg-bubble"></div><div class="msg-meta"><span class="tag tag-llm">AI 生成</span><span>正在回复…</span></div></div>';
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
    return { wrap: wrap, bubble: wrap.querySelector('.msg-bubble'), meta: wrap.querySelector('.msg-meta') };
  }

  function updateHeader() {
    const c = state.conv;
    const meta = INTENT_META[state.lastIntent.intent] || INTENT_META.general;
    $('chat-meta').textContent = c
      ? `会话 ${c.conversation_key.slice(0, 8)} · ${state.messages.length} 条消息 · ${c.escalated ? '已转人工' : '机器人服务中'}`
      : '正在初始化会话…';
    $('session-stat').textContent = `消息 ${state.messages.length} 条 · 意图 ${meta.short}`;
  }

  function setFlow(step) {
    for (let i = 1; i <= 5; i++) {
      const el = $('flow-' + i);
      if (!el) continue;
      el.className = i < step ? 'done' : (i === step ? 'active' : '');
    }
  }

  function setFlowComplete() {
    for (let i = 1; i <= 4; i++) { const el = $('flow-' + i); if (el) el.className = 'done'; }
    const last = $('flow-5'); if (last) last.className = '';
  }

  function updateInsight() {
    const meta = INTENT_META[state.lastIntent.intent] || INTENT_META.general;
    const chip = $('intent-chip');
    chip.className = 'intent-chip ' + meta.cls;
    chip.textContent = meta.label;
    $('intent-confidence').textContent = state.lastIntent.confidence
      ? `置信度 ${(state.lastIntent.confidence * 100).toFixed(0)}%${state.lastIntent.need_human ? ' · 建议人工介入' : ''}`
      : '等待用户提问';
    const hits = $('faq-hits');
    hits.innerHTML = state.lastFaqHits.length
      ? state.lastFaqHits.map((h) => `<div class="faq-hit"><b>${esc(h.faq.category)}</b> · ${esc(h.faq.question)}<br><span class="muted">匹配度 ${h.score.toFixed(1)}</span></div>`).join('')
      : '<div class="empty-mini">暂无匹配</div>';
    const esc2 = state.conv && state.conv.escalated;
    $('session-state').innerHTML = esc2
      ? '<span class="dot dot-red"></span>已转接人工客服'
      : '<span class="dot dot-green"></span>机器人服务中';
    updateHeader();
  }

  /* ==================== 意图识别 ==================== */
  function localIntent(text) {
    if (/退款|退钱|退货|退回|退单|退费|不想要了|申请退/.test(text)) return { intent: 'refund', confidence: 0.8, need_human: false, reason: '关键词命中退款' };
    if (/订单|物流|快递|发货|收货|地址|下单|运单|到哪|什么时候到/.test(text)) return { intent: 'order', confidence: 0.8, need_human: false, reason: '关键词命中订单' };
    if (/闪退|崩溃|打不开|卡顿|报错|bug|故障|登录不了|登不上|验证码|支付失败|扣款|密码|被盗|无法使用|用不了/.test(text)) return { intent: 'tech', confidence: 0.8, need_human: false, reason: '关键词命中技术故障' };
    return { intent: 'general', confidence: 0.6, need_human: false, reason: '未命中明确业务关键词' };
  }

  async function classifyIntent(text) {
    const fallback = localIntent(text);
    if (!state.modelId) return fallback;
    const system = '你是客服工单意图分类器。只输出一个 JSON 对象，不要输出任何解释文字，不要使用 Markdown 代码块。'
      + '可选 intent：refund(退款/退费/退货)、order(订单/物流/发货/收货地址)、tech(技术故障/登录/支付异常/账号安全)、general(其他/问候/闲聊)。'
      + '输出格式：{"intent":"refund|order|tech|general","confidence":0.0到1.0,"need_human":true或false,"reason":"简短中文理由"}。'
      + 'need_human 规则：用户明确要求人工、投诉、涉及资金争议、账号被盗、强烈不满，或问题明显超出电商客服知识范围且无法给出确定答复时设为 true，否则 false。';
    try {
      let out = '';
      for await (const chunk of state.cloud.llm.chat.completions.create({
        model: state.modelId,
        messages: [{ role: 'system', content: system }, { role: 'user', content: String(text).slice(0, 500) }],
        stream: true,
        temperature: 0.2
      })) {
        const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (d) out += d;
      }
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) return fallback;
      const obj = JSON.parse(m[0]);
      const intent = INTENT_META[obj.intent] ? obj.intent : fallback.intent;
      return {
        intent: intent,
        confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : fallback.confidence,
        need_human: !!obj.need_human,
        reason: obj.reason || ''
      };
    } catch (e) {
      console.warn('[intent] fallback to local classifier:', e && e.message);
      return fallback;
    }
  }

  /* ==================== 回复生成（RAG + 流式） ==================== */
  function buildAnswerSystem(intent, hits) {
    const meta = INTENT_META[intent] || INTENT_META.general;
    const kb = hits.length
      ? hits.map((h, i) => `${i + 1}. [${h.faq.category}] 问：${h.faq.question}\n   标准答：${h.faq.answer}`).join('\n')
      : '（本轮没有检索到相关知识库条目）';
    return '你是「云朵」，某电商平台的智能客服助手。用简体中文、亲切专业、简洁（不超过 180 字）回答用户。\n'
      + '规则：\n'
      + '1. 优先依据【知识库候选】回答，不得编造平台政策、退款时效、金额、订单状态或物流数据。\n'
      + '2. 知识库没有可靠依据时，坦诚说明不确定，并建议转人工，绝不杜撰。\n'
      + '3. 涉及具体订单号、账号、资金的操作，引导用户提供必要信息或转人工核实。\n'
      + '4. 不要输出 Markdown 标题，可用短句或序号分点。结合【历史对话】理解追问，不要重复追问已给出的信息。\n'
      + '5. 若判断该问题机器人无法解决（投诉、资金争议、账号被盗、需要查后台数据、用户明确要求人工），在回复最后单独一行输出：[NEED_HUMAN]。\n\n'
      + `【当前识别意图】${meta.label}\n【知识库候选】\n${kb}`;
  }

  async function streamAnswer(userText, intent, hits, onDelta) {
    const history = state.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));
    const messages = [{ role: 'system', content: buildAnswerSystem(intent, hits) }].concat(history);
    let full = '';
    const controller = new AbortController();
    state.abort = controller;
    for await (const chunk of state.cloud.llm.chat.completions.create({
      model: state.modelId,
      messages: messages,
      stream: true,
      conversationId: state.convKey,
      temperature: 0.7,
      signal: controller.signal
    })) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
      if (d) { full += d; onDelta(d); }
    }
    return full;
  }

  /* ==================== 转人工 ==================== */
  async function escalate(reason, intent) {
    if (!state.convKey) return;
    if (state.conv && state.conv.escalated) { toast('本会话已转接人工客服', 'warn'); return; }
    const summary = state.messages.filter((m) => m.role === 'user').slice(-3).map((m) => m.content).join(' / ').slice(0, 200);
    const { error } = await state.cloud.database.from('handoff_tickets').insert({
      conversation_key: state.convKey,
      visitor_id: state.visitorId,
      reason: String(reason || '用户请求人工协助').slice(0, 200),
      intent: intent || 'general',
      summary: summary,
      status: 'pending'
    });
    if (error) { toast('工单创建失败：' + dbMsg(error), 'err'); return; }

    const { data } = await state.cloud.database.from('conversations')
      .update({ escalated: true, status: 'escalated', updated_at: new Date().toISOString() })
      .eq('conversation_key', state.convKey).select();
    if (data && data.length) {
      state.conv = data[0];
      const idx = state.sessions.findIndex((s) => s.conversation_key === state.convKey);
      if (idx >= 0) state.sessions[idx] = data[0];
    } else {
      state.conv = state.conv || {}; state.conv.escalated = true;
    }

    const notice = '已为您转接人工客服 ✓\n工单已创建（服务时间 09:00–21:00），人工专员会查看完整对话记录后跟进。您可以继续补充说明，信息会一并同步给人工客服。';
    await persistMessage('system', notice, { source: 'handoff', intent: intent });
    renderMessages(); renderSessions(); updateInsight();
    setFlow(5);
    toast('已自动转接人工客服并创建工单', 'warn');
  }

  /* ==================== 发送主流程 ==================== */
  async function sendMessage() {
    if (state.generating) {
      if (state.abort) state.abort.abort();
      return;
    }
    const input = $('input-message');
    const text = (input.value || '').trim();
    if (!text) return;
    if (!state.modelId) { toast('暂无可用大模型，请刷新页面重试', 'err'); return; }
    if (!state.convKey) { toast('会话尚未就绪，请稍候', 'warn'); return; }
    const now = Date.now();
    if (now - state.lastSentAt < 700) { toast('发送太快了，请稍等一下', 'warn'); return; }
    state.lastSentAt = now;

    input.value = ''; input.style.height = 'auto';
    setGenerating(true);
    setFlow(1);
    let liveBubble = null;

    try {
      // 1) 持久化用户消息
      await persistMessage('user', text, { intent: state.lastIntent.intent });
      renderMessages();

      // 会话标题取首条用户提问
      if (state.messages.filter((m) => m.role === 'user').length === 1) {
        const title = text.slice(0, 18);
        const { data } = await state.cloud.database.from('conversations')
          .update({ title: title, updated_at: new Date().toISOString() })
          .eq('conversation_key', state.convKey).select();
        if (data && data.length) {
          state.conv = data[0];
          const i = state.sessions.findIndex((s) => s.conversation_key === state.convKey);
          if (i >= 0) state.sessions[i] = data[0];
          renderSessions();
        }
      }

      // 2) 意图识别（大模型 + 本地兜底）
      setFlow(2);
      const intent = await classifyIntent(text);
      if (HUMAN_WORDS.test(text)) intent.need_human = true;
      state.lastIntent = intent;
      await state.cloud.database.from('conversations')
        .update({ intent: intent.intent, updated_at: new Date().toISOString() })
        .eq('conversation_key', state.convKey);
      if (state.conv) state.conv.intent = intent.intent;
      renderSessions(); updateInsight();

      // 3) FAQ 知识库检索
      setFlow(3);
      const hits = searchFaq(text);
      state.lastFaqHits = hits;
      updateInsight();

      // 用户明确要求人工 / 模型判定需人工 → 直接转人工
      if (intent.need_human) {
        await escalate(HUMAN_WORDS.test(text) ? '用户主动要求人工客服' : (intent.reason || '模型判定需人工介入'), intent.intent);
        return;
      }

      // 4) 回复：高分知识库直答，否则大模型流式生成
      setFlow(4);
      let answer = '', source = 'llm', matchedId = null;
      const best = hits[0];
      if (best && best.score >= 3.5) {
        source = 'faq'; matchedId = best.faq.id;
        const extra = hits.length > 1
          ? '\n\n您可能还想了解：' + hits.slice(1).map((h) => '「' + h.faq.question + '」').join('、')
          : '';
        answer = best.faq.answer + extra;
        liveBubble = appendStreamingBubble();
        const bubble = liveBubble;
        bubble.meta.innerHTML = '<span class="tag tag-faq">知识库直答</span><span>来自 FAQ #' + best.faq.id + '</span>';
        // 逐字呈现，保持与 AI 回复一致的观感
        for (let i = 0; i < answer.length; i += 3) {
          bubble.bubble.textContent = answer.slice(0, i + 3);
          $('message-list').scrollTop = $('message-list').scrollHeight;
          await sleep(12);
        }
        bubble.bubble.textContent = answer;
      } else {
        liveBubble = appendStreamingBubble();
        const bubble = liveBubble;
        answer = await streamAnswer(text, intent.intent, hits, (delta) => {
          bubble.bubble.textContent += delta;
          $('message-list').scrollTop = $('message-list').scrollHeight;
        });
        bubble.meta.innerHTML = '<span class="tag tag-llm">AI 生成</span><span>' + fmt(new Date().toISOString()) + '</span>';
      }

      // 5) 无法解决 → 自动转人工
      const needHuman = /\[NEED_HUMAN\]/.test(answer);
      answer = answer.replace(/\[NEED_HUMAN\]/g, '').trim();
      if (!answer) answer = '抱歉，我暂时没能生成有效回复，已为您转接人工客服。';
      await persistMessage('assistant', answer, { source: source, intent: intent.intent, matched_faq_id: matchedId });
      renderMessages();
      if (needHuman) {
        await escalate('机器人无法给出确定答复，自动转人工', intent.intent);
      } else {
        setFlowComplete();
      }
    } catch (e) {
      console.error('[send] error:', e);
      const msg = llmMsg(e);
      toast(msg, 'err');
      const bubble = liveBubble || appendStreamingBubble();
      const partial = (bubble.bubble.textContent || '').trim();
      bubble.bubble.textContent = (partial ? partial + '\n\n' : '') + '抱歉，服务暂时不可用：' + msg + '。您可以点击「转人工」由人工客服协助。';
      bubble.meta.innerHTML = '<span class="tag tag-handoff">服务异常</span>';
    } finally {
      setGenerating(false);
      state.abort = null;
    }
  }

  function setGenerating(on) {
    state.generating = on;
    const btn = $('btn-send');
    btn.disabled = false;
    btn.innerHTML = on ? '停止 <span>■</span>' : '发送 <span>➤</span>';
    btn.style.background = on ? '#ef4444' : '';
    $('composer-state').textContent = on ? '正在识别意图、检索知识库并生成回复…' : 'AI 生成内容仅供参考，涉及资金与账号的操作请以人工确认为准';
  }

  /* ==================== 快捷问题 / 评价 ==================== */
  function renderQuick() {
    $('quick-questions').innerHTML = QUICK.map((q) => `<button class="chip">${esc(q)}</button>`).join('');
    $('quick-questions').querySelectorAll('.chip').forEach((el) => {
      el.addEventListener('click', () => { $('input-message').value = el.textContent; $('input-message').focus(); });
    });
  }
  function renderStars() {
    $('star-row').innerHTML = [1, 2, 3, 4, 5].map((n) => `<button class="star" data-n="${n}">★</button>`).join('');
    $('star-row').querySelectorAll('.star').forEach((el) => {
      el.addEventListener('click', () => {
        state.rating = Number(el.dataset.n);
        $('star-row').querySelectorAll('.star').forEach((s) => s.classList.toggle('on', Number(s.dataset.n) <= state.rating));
        $('star-label').textContent = ['很不满意', '不满意', '一般', '满意', '非常满意'][state.rating - 1];
      });
    });
  }
  async function submitRating() {
    if (!state.rating) { toast('请先选择评分', 'warn'); return; }
    if (!state.convKey) return;
    const comment = ($('rate-comment').value || '').trim().slice(0, 300) || null;
    const { error } = await state.cloud.database.from('satisfaction').insert({
      conversation_key: state.convKey,
      visitor_id: state.visitorId,
      rating: state.rating,
      comment: comment,
      resolved: state.rating >= 3
    });
    if (error) { toast('评价提交失败：' + dbMsg(error), 'err'); return; }
    $('rate-modal').classList.add('hidden');
    toast('感谢您的评价，已写入云端', 'ok');
    // 低分视为未解决 → 自动转人工
    if (state.rating <= 2) await escalate('用户满意度评分 ' + state.rating + ' 星，自动转人工回访', state.lastIntent.intent);
    state.rating = 0;
    $('rate-comment').value = '';
    $('star-row').querySelectorAll('.star').forEach((s) => s.classList.remove('on'));
    $('star-label').textContent = '请选择评分';
    if (!$('view-admin').classList.contains('hidden')) loadAdminData();
  }

  /* ==================== 管理后台 ==================== */
  function withinRange(iso) {
    if (state.range === 'all') return true;
    const days = Number(state.range);
    return new Date(iso).getTime() >= Date.now() - days * 86400000;
  }

  async function loadAdminData() {
    try {
      const [c, m, s, t, f] = await Promise.all([
        state.cloud.database.from('conversations').select('*').order('created_at', { ascending: false }).limit(300),
        state.cloud.database.from('messages').select('id,conversation_key,role,content,source,created_at').order('id', { ascending: false }).limit(1500),
        state.cloud.database.from('satisfaction').select('*').order('created_at', { ascending: false }).limit(500),
        state.cloud.database.from('handoff_tickets').select('*').order('created_at', { ascending: false }).limit(200),
        state.cloud.database.from('faq').select('id', { count: 'exact', head: true })
      ]);
      for (const [name, r] of [['会话', c], ['消息', m], ['满意度', s], ['工单', t]]) {
        if (r.error) toast(name + '数据加载失败：' + dbMsg(r.error), 'err');
      }
      state.adminData = {
        convs: (c.data || []).filter((x) => withinRange(x.created_at)),
        msgs: (m.data || []).filter((x) => withinRange(x.created_at)),
        ratings: (s.data || []).filter((x) => withinRange(x.created_at)),
        tickets: (t.data || []).filter((x) => withinRange(x.created_at)),
        faqCount: f.count || state.faqs.length
      };
      renderAdmin();
      $('admin-updated').textContent = '更新于 ' + fmt(new Date().toISOString());
    } catch (e) {
      toast('后台数据加载异常：' + (e.message || e), 'err');
    }
  }

  function renderAdmin() {
    const d = state.adminData;
    if (!d) return;
    const convs = d.convs, ratings = d.ratings, tickets = d.tickets;
    const avg = ratings.length ? (ratings.reduce((a, b) => a + b.rating, 0) / ratings.length) : 0;
    const escalated = convs.filter((c) => c.escalated).length;
    $('kpi-conv').textContent = convs.length;
    $('kpi-msg').textContent = d.msgs.length;
    $('kpi-csat').textContent = ratings.length ? avg.toFixed(2) : '—';
    $('kpi-csat-foot').textContent = '共 ' + ratings.length + ' 份评价';
    $('kpi-handoff').textContent = convs.length ? (escalated / convs.length * 100).toFixed(1) + '%' : '—';
    $('kpi-handoff-foot').textContent = tickets.length + ' 个工单';
    $('kpi-faq').textContent = d.faqCount;
    $('kpi-conv-foot').textContent = '其中 ' + escalated + ' 个已转人工';

    // 满意度分布
    const dist = [0, 0, 0, 0, 0];
    ratings.forEach((r) => { if (r.rating >= 1 && r.rating <= 5) dist[r.rating - 1]++; });
    const maxD = Math.max.apply(null, dist.concat([1]));
    $('csat-chart').innerHTML = [5, 4, 3, 2, 1].map((n) => {
      const v = dist[n - 1], h = Math.max(3, v / maxD * 118);
      return `<div class="bar-col"><div class="bar-val">${v}</div><div class="bar g${n}" style="height:${h}px"></div><div class="bar-lbl">${n} 星</div></div>`;
    }).join('');
    $('csat-sub').textContent = ratings.length ? '平均 ' + avg.toFixed(2) + ' 分 · ' + ratings.length + ' 份评价' : '暂无评价数据';

    // 意图分布
    const ic = { refund: 0, order: 0, tech: 0, general: 0 };
    convs.forEach((c) => { if (ic[c.intent] !== undefined) ic[c.intent]++; });
    const maxI = Math.max.apply(null, Object.values(ic).concat([1]));
    $('intent-chart').innerHTML = Object.keys(INTENT_META).map((k) => {
      const meta = INTENT_META[k], v = ic[k];
      return `<div class="hbar-row"><div class="hbar-name">${meta.label}</div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${v / maxI * 100}%;background:${meta.color}"></div></div>
        <div class="hbar-num">${v}</div></div>`;
    }).join('');

    // 近 7 日趋势
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(); dt.setHours(0, 0, 0, 0); dt.setDate(dt.getDate() - i);
      days.push({ key: `${dt.getMonth() + 1}/${dt.getDate()}`, from: dt.getTime(), to: dt.getTime() + 86400000, sum: 0, n: 0 });
    }
    ratings.forEach((r) => {
      const t = new Date(r.created_at).getTime();
      const hit = days.find((x) => t >= x.from && t < x.to);
      if (hit) { hit.sum += r.rating; hit.n++; }
    });
    const maxAvg = 5;
    $('trend-chart').innerHTML = days.map((x) => {
      const a = x.n ? x.sum / x.n : 0;
      return `<div class="trend-col"><div class="trend-val">${x.n ? a.toFixed(1) : '—'}</div>
        <div class="trend-bar" style="height:${Math.max(3, a / maxAvg * 118)}px"></div>
        <div class="trend-lbl">${x.key}</div></div>`;
    }).join('');

    // 工单表
    const statusPill = (s) => s === 'resolved' ? '<span class="pill pill-resolved">已解决</span>'
      : s === 'processing' ? '<span class="pill pill-processing">处理中</span>'
      : '<span class="pill pill-pending">待处理</span>';
    $('ticket-tbody').innerHTML = tickets.length ? tickets.map((t) => {
      const meta = INTENT_META[t.intent] || INTENT_META.general;
      return `<tr><td>#${t.id}</td><td>${fmt(t.created_at)}</td><td><span class="pill pill-plain" style="color:${meta.color}">${meta.short}</span></td>
        <td class="cell-ellip" title="${esc(t.reason)}">${esc(t.reason)}</td>
        <td class="cell-ellip" title="${esc(t.summary)}">${esc(t.summary || '—')}</td>
        <td>${statusPill(t.status)}</td>
        <td><button class="mini-btn" data-ticket="${t.id}" data-status="processing">处理中</button><button class="mini-btn" data-ticket="${t.id}" data-status="resolved">已解决</button></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="td-empty">暂无转人工工单</td></tr>';
    $('ticket-tbody').querySelectorAll('[data-ticket]').forEach((b) => {
      b.addEventListener('click', () => updateTicket(Number(b.dataset.ticket), b.dataset.status));
    });

    // 对话记录
    const counts = {};
    d.msgs.forEach((m) => { counts[m.conversation_key] = (counts[m.conversation_key] || 0) + 1; });
    $('record-count').textContent = '共 ' + convs.length + ' 条会话 · ' + d.msgs.length + ' 条消息';
    $('record-tbody').innerHTML = convs.length ? convs.slice(0, 100).map((c) => {
      const meta = INTENT_META[c.intent] || INTENT_META.general;
      return `<tr><td><div class="cell-ellip" style="color:var(--text);font-weight:600">${esc(c.title || '新的咨询')}</div><div class="muted">${esc(c.conversation_key.slice(0, 12))}…</div></td>
        <td>${fmt(c.created_at)}</td><td><span class="pill pill-plain" style="color:${meta.color}">${meta.short}</span></td>
        <td>${counts[c.conversation_key] || 0}</td>
        <td>${c.escalated ? '<span class="pill pill-pending">是</span>' : '<span class="pill pill-plain">否</span>'}</td>
        <td>${c.escalated ? '已转人工' : (c.status === 'closed' ? '已结束' : '进行中')}</td>
        <td><button class="link-btn" data-detail="${esc(c.conversation_key)}">查看对话</button></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="td-empty">暂无对话记录</td></tr>';
    $('record-tbody').querySelectorAll('[data-detail]').forEach((b) => {
      b.addEventListener('click', () => showDetail(b.dataset.detail));
    });
  }

  async function updateTicket(id, status) {
    const { data, error } = await state.cloud.database.from('handoff_tickets')
      .update({ status: status }).eq('id', id).select();
    if (error) { toast('状态更新失败：' + dbMsg(error), 'err'); return; }
    if (!data || !data.length) { toast('未找到该工单或无权修改', 'warn'); return; }
    toast('工单状态已更新', 'ok');
    await loadAdminData();
  }

  async function showDetail(key) {
    $('detail-title').textContent = '对话详情 · ' + key.slice(0, 12) + '…';
    $('detail-body').innerHTML = '<div class="empty-mini">加载中…</div>';
    $('detail-modal').classList.remove('hidden');
    const { data, error } = await state.cloud.database.from('messages')
      .select('*').eq('conversation_key', key).order('id', { ascending: true }).limit(200);
    if (error) { $('detail-body').innerHTML = '<div class="empty-mini">加载失败：' + esc(dbMsg(error)) + '</div>'; return; }
    const rows = data || [];
    $('detail-body').innerHTML = rows.length ? rows.map((m) => {
      const cls = m.role === 'user' ? 'u' : (m.role === 'system' ? 's' : 'b');
      const who = m.role === 'user' ? '用户' : (m.role === 'system' ? '系统' : '智能客服');
      return `<div class="detail-msg ${cls}"><div class="detail-who">${who} · ${fmt(m.created_at)}${m.source === 'faq' ? ' · 知识库' : ''}</div>${esc(m.content)}</div>`;
    }).join('') : '<div class="empty-mini">该会话暂无消息</div>';
  }

  /* ==================== 视图切换与事件 ==================== */
  function switchView(view) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    const isAdmin = view === 'admin';
    $('view-chat').classList.toggle('hidden', isAdmin);
    $('view-admin').classList.toggle('hidden', !isAdmin);
    $('page-title').textContent = isAdmin ? '管理后台' : '智能客服对话';
    $('page-sub').textContent = isAdmin
      ? '对话记录 · 满意度统计 · 意图分布 · 人工工单'
      : '多轮对话 · FAQ 知识库检索 · 意图识别 · 无法解决自动转人工';
    if (isAdmin) loadAdminData();
  }

  function bindEvents() {
    document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
    $('btn-new-session').addEventListener('click', () => createSession(true));
    $('btn-send').addEventListener('click', sendMessage);
    $('input-message').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    $('input-message').addEventListener('input', (e) => {
      e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px';
    });
    $('btn-handoff').addEventListener('click', () => escalate('用户点击「转人工」按钮', state.lastIntent.intent));
    $('btn-rate').addEventListener('click', () => $('rate-modal').classList.remove('hidden'));
    $('btn-submit-rate').addEventListener('click', submitRating);
    $('model-select').addEventListener('change', (e) => {
      state.modelId = e.target.value;
      const m = state.models.find((x) => x.id === state.modelId);
      setStatus('llm-dot', 'llm-status', '模型 ' + (m ? (m.name || m.id) : state.modelId), 'dot-green');
    });
    $('btn-refresh').addEventListener('click', async () => {
      await loadSessions();
      if (!$('view-admin').classList.contains('hidden')) await loadAdminData();
      toast('数据已刷新', 'ok');
    });
    $('btn-admin-refresh').addEventListener('click', loadAdminData);
    document.querySelectorAll('#range-seg .seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#range-seg .seg-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active'); state.range = b.dataset.range; loadAdminData();
      });
    });
    document.querySelectorAll('[data-close]').forEach((b) => {
      b.addEventListener('click', () => $(b.dataset.close).classList.add('hidden'));
    });
    document.querySelectorAll('.modal-mask').forEach((m) => {
      m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
    });
  }

  boot();
})();
