const token = document.querySelector('meta[name=stardew-token]').content;
if (new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window) {
  document.documentElement.dataset.embedded = 'true';
  for (const link of document.querySelectorAll('a[href="/"]')) link.addEventListener('click', event => {
    event.preventDefault(); window.parent.postMessage({ type: 'stardew:focus-chat' }, location.origin);
  });
}
const $ = id => document.getElementById(id);
let state = null, busy = false, renderedRunId = null, clientError = null, generation = 0;
let pollingError = false;
let inventoryKey = '', eventsKey = '';
const names = { idle: '尚未开始', running: '正在行动', pausing: '正在暂停', paused: '已暂停', stopping: '正在停止', stopped: '已停止', blocked: '需要帮忙', needs_review: '待你复核', completed: '已核验完成' };
const intents = { explore: '探索', move: '靠近目标', select: '选择物品', use: '使用工具或种子', interact: '交互', menu: '菜单', wait: '等待', finish: '申请结束', blocked: '报告受阻' };
const phases = { running: 'Jev 执行中', waiting: '等待规划', finished: '已汇总', paused: '手动接管', stopped: '已停止接续', exhausted: '预算已结束' };
const seasons = { spring: '春', summer: '夏', fall: '秋', winter: '冬' };
const settings = ['budget', 'minutes', 'radius', 'location', 'explored', 'crop', 'count', 'watered', 'nextDay', 'wateredCrops', 'refill', 'emptySoil'];

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
}
async function api(action, body) {
  const response = await fetch('/stardew/api/' + action, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-stardew-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试。');
  return data;
}
function input(singleStep = false) {
  const completion = {};
  for (const [id, key] of [['location', 'location'], ['crop', 'cropId']]) if ($(id).value.trim()) completion[key] = $(id).value.trim();
  for (const [id, key] of [['explored', 'exploredTiles'], ['count', 'cropCount'], ['wateredCrops', 'wateredCrops']]) if ($(id).value) completion[key] = Number($(id).value);
  for (const key of ['watered', 'nextDay', 'refill']) if ($(key).checked) completion[key] = true;
  return { goal: $('goal').value, radius: Number($('radius').value), maxDecisions: Number($('budget').value), maxMinutes: Number($('minutes').value), singleStep,
    policy: { allowEmptySoilWatering: $('emptySoil').checked }, ...(Object.keys(completion).length ? { completion } : {}) };
}
function controls() {
  const running = ['running', 'pausing', 'stopping'].includes(state?.status);
  const planActive = ['running', 'waiting'].includes(state?.planner?.phase);
  const resumable = ['paused', 'blocked', 'needs_review'].includes(state?.status);
  $('start').hidden = running || planActive || resumable;
  $('pause').hidden = !running && !planActive;
  $('resume').hidden = running || planActive || !resumable;
  $('start').disabled = busy || !state || running || !$('goal').value.trim();
  $('resume').disabled = busy || !resumable || !$('goal').value.trim();
  $('pause').disabled = busy || (state?.status !== 'running' && !planActive);
  $('stop').disabled = busy || !state?.runId || (['idle', 'stopped', 'completed'].includes(state?.status) && !planActive);
  $('observe').disabled = busy || running;
  $('step').disabled = busy || !state || running || planActive || !$('goal').value.trim();
  $('goal').disabled = busy || running || planActive;
  for (const id of settings) $(id).disabled = busy || running || resumable || planActive;
  $('settingsHint').hidden = !resumable || planActive;
  $('activity').classList.toggle('active', running && !clientError);
  $('activity').classList.toggle('error', !!clientError || state?.status === 'blocked');
}
function error(error) {
  clientError = error.message || '连接暂时中断，请稍后重试。';
  $('message').textContent = clientError; $('message').classList.add('error'); controls();
}
async function command(action, body = {}) {
  if (busy) return;
  busy = true; generation++; clientError = null; pollingError = false; controls();
  try { render(await api(action, body)); } catch (e) { error(e); }
  finally { busy = false; controls(); }
}
$('start').onclick = () => command('start', input());
$('pause').onclick = () => command('pause');
$('stop').onclick = () => command('stop');
$('observe').onclick = () => command('observe');
$('resume').onclick = () => command('resume', { goal: $('goal').value });
$('step').onclick = () => state && ['paused', 'blocked', 'needs_review'].includes(state.status)
  ? command('resume', { singleStep: true, goal: $('goal').value }) : command('start', input(true));
$('goal').addEventListener('input', controls);

function probabilities(node, answer, labels) {
  node.replaceChildren();
  if (!answer) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '等待下一次决策。'; node.append(p); return; }
  for (const [id, probability] of Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const row = document.createElement('div'); row.className = 'prob' + (id === answer.choice ? ' chosen' : '');
    const head = document.createElement('div'); head.className = 'probhead';
    const label = document.createElement('span'); label.textContent = labels[id] || id;
    const value = document.createElement('span'); value.textContent = (probability * 100).toFixed(1) + '%'; head.append(label, value);
    const bar = document.createElement('div'); bar.className = 'bar';
    const fill = document.createElement('i'); fill.style.width = Math.max(0, Math.min(100, probability * 100)) + '%';
    bar.append(fill); row.append(head, bar); node.append(row);
  }
}
function draw(snapshot) {
  $('mapwrap').classList.toggle('has-world', !!snapshot);
  $('legend').hidden = !snapshot; $('mapCaption').hidden = !snapshot;
  if (!snapshot) return;
  const c = $('map').getContext('2d'); c.imageSmoothingEnabled = false;
  c.fillStyle = '#35543a'; c.fillRect(0, 0, 720, 400);
  const points = [...snapshot.entities.map(e => e.tile), snapshot.player.position];
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
  const cell = Math.min(38, Math.floor(686 / (maxX - minX + 1)), Math.floor(354 / (maxY - minY + 1)));
  const ox = Math.floor((720 - cell * (maxX - minX + 1)) / 2), oy = Math.floor((400 - cell * (maxY - minY + 1)) / 2);
  for (const e of snapshot.entities) {
    const x = ox + (e.tile.x - minX) * cell, y = oy + (e.tile.y - minY) * cell;
    const block = !e.passable && !e.refillable;
    c.fillStyle = e.refillable ? '#5099a5' : e.tilled ? e.watered ? '#64766c' : '#a27548' : block ? '#426447' : '#779b53';
    c.fillRect(x + 1, y + 1, cell - 1, cell - 1);
    if (e.refillable) { c.fillStyle = '#85c0c1'; c.fillRect(x + cell * .2, y + cell * .45, cell * .45, 2); }
    if (e.crop) {
      c.fillStyle = '#354b21'; c.fillRect(x + cell * .46, y + cell * .45, Math.max(2, cell * .12), cell * .35);
      c.fillStyle = '#c0d36b'; c.fillRect(x + cell * .22, y + cell * .26, cell * .29, cell * .22);
      c.fillStyle = '#a5c552'; c.fillRect(x + cell * .52, y + cell * .17, cell * .25, cell * .28);
    } else if (['door', 'exit', 'bed', 'npc', 'object', 'action', 'furniture'].includes(e.kind)) {
      c.fillStyle = '#775031'; c.fillRect(x + cell * .19, y + cell * .18, cell * .62, cell * .65);
      c.fillStyle = '#e0b366'; c.fillRect(x + cell * .25, y + cell * .2, cell * .5, cell * .48);
    }
  }
  const target = state.decision?.recommendation?.target;
  if (target) { c.strokeStyle = '#ffb375'; c.lineWidth = 2; c.strokeRect(ox + (target.x - minX) * cell + 1, oy + (target.y - minY) * cell + 1, cell - 2, cell - 2); }
  const p = snapshot.player.position, x = ox + (p.x - minX) * cell, y = oy + (p.y - minY) * cell, unit = Math.max(1, Math.floor(cell / 10));
  const px = Math.floor(x + cell / 2 - unit * 3), py = Math.floor(y + cell / 2 - unit * 4);
  c.fillStyle = '#594328'; c.fillRect(px + unit, py + 7 * unit, 2 * unit, 2 * unit); c.fillRect(px + 4 * unit, py + 7 * unit, 2 * unit, 2 * unit);
  c.fillStyle = '#306c64'; c.fillRect(px + unit, py + 4 * unit, 5 * unit, 3 * unit);
  c.fillStyle = '#f4d49a'; c.fillRect(px + 2 * unit, py + 2 * unit, 3 * unit, 3 * unit);
  c.fillStyle = '#e2b658'; c.fillRect(px + unit, py, 5 * unit, 2 * unit); c.fillRect(px, py + 2 * unit, 7 * unit, unit);
}
function renderInventory(snapshot) {
  const key = JSON.stringify([snapshot?.inventory, snapshot?.player.selectedSlot]);
  if (key === inventoryKey) return; inventoryKey = key; $('inventory').replaceChildren();
  $('heldItem').textContent = snapshot ? '当前空手' : '尚未观察';
  if (!snapshot?.inventory.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = snapshot ? '背包里暂时没有物品。' : '观察农场后，在这里查看工具和物品。'; $('inventory').append(p); return; }
  const held = snapshot.inventory.find(item => item.slot === snapshot.player.selectedSlot);
  $('heldItem').textContent = held ? '手持 · ' + held.name : '当前空手';
  for (const item of snapshot.inventory) {
    const el = document.createElement('div'); el.className = 'item' + (item.slot === snapshot.player.selectedSlot ? ' selected' : '');
    const slot = document.createElement('span'); slot.className = 'item-slot'; slot.textContent = String(item.slot + 1); el.append(slot);
    el.append(icon(item.tool === 'WateringCan' ? 'water' : item.tool ? 'tool' : item.category === -74 ? 'leaf' : 'bag'));
    const text = document.createElement('span'); text.textContent = `${item.name} ×${item.count}` + (item.water !== undefined ? ` · 水 ${item.water}${item.waterCapacity !== undefined ? '/' + item.waterCapacity : ''}` : '');
    el.append(text); el.title = `槽位 ${item.slot}${item.slot === snapshot.player.selectedSlot ? ' · 当前手持' : ''}`; $('inventory').append(el);
  }
}
function renderEvents(events) {
  const key = JSON.stringify(events); if (eventsKey === key) return; eventsKey = key; $('events').replaceChildren();
  if (!events.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '小助手的第一篇农场日记，等你来开启。'; $('events').append(p); return; }
  for (const event of [...events].reverse()) {
    const row = document.createElement('div'); row.className = 'event'; row.dataset.kind = event.kind;
    const time = document.createElement('time'); time.dateTime = event.at; time.textContent = new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false });
    const text = document.createElement('div'); text.textContent = event.message; row.append(time, text); $('events').append(row);
  }
}
function render(s) {
  state = s;
  if (s.runId !== renderedRunId && s.input) {
    $('goal').value = s.input.goal; $('budget').value = s.input.maxDecisions; $('minutes').value = s.input.maxMinutes; $('radius').value = s.input.radius;
    $('emptySoil').checked = !!s.input.policy?.allowEmptySoilWatering;
    for (const [id, key] of [['location', 'location'], ['crop', 'cropId'], ['count', 'cropCount'], ['explored', 'exploredTiles'], ['wateredCrops', 'wateredCrops']]) $(id).value = s.input.completion?.[key] ?? '';
    for (const id of ['watered', 'nextDay', 'refill']) $(id).checked = !!s.input.completion?.[id];
    renderedRunId = s.runId;
  }
  $('status').textContent = names[s.status] || s.status; $('status').dataset.state = s.status;
  const message = clientError || s.message;
  if ($('message').textContent !== message) $('message').textContent = message;
  $('message').classList.toggle('error', !!clientError || s.status === 'blocked' || !!s.recordError);
  $('calls').textContent = s.memory.apiCalls; $('steps').textContent = s.memory.executedSteps; $('tiles').textContent = s.memory.observedTiles;
  const seconds = Math.round(s.elapsedMs / 1000); $('elapsed').textContent = seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒';
  $('model').textContent = s.decision?.model || 'OpenRouter · ~typesafe/jev-latest';
  $('latency').textContent = s.phase === 'deciding' ? '正在请求 Jev' : s.decision ? s.decision.elapsedMs + ' ms' : '等待决策';
  $('cost').textContent = s.cost ? '$' + s.cost.toFixed(5) : '';
  const d = s.decision, kind = d?.answers?.intent?.choice;
  probabilities($('intent'), d?.answers?.intent, intents);
  probabilities($('choices'), d?.answers?.['action_' + kind], Object.fromEntries(s.candidates.map(c => [c.id, c.label])));
  $('actiontitle').textContent = kind ? (intents[kind] || kind) + ' · 具体动作' : '具体动作';
  $('evidence').textContent = JSON.stringify(d, null, 2);
  $('progress').textContent = JSON.stringify({ runId: s.runId, revision: s.revision, conditions: s.input?.completion, plantings: s.memory.plantings, waterings: s.memory.waterings, refills: s.memory.refills, landmarks: s.memory.landmarks, trace: s.trace, recordError: s.recordError }, null, 2);
  const world = s.snapshot;
  $('mode').textContent = world ? (world.mode === 'mock' ? '模拟农场' : '真实游戏') : s.message.includes('NO_SAVE_LOADED') ? '等待载入存档' : '等待观察';
  $('maptitle').textContent = world ? (world.location === 'Farm' ? '我的农场' : world.location === 'FarmHouse' ? '农舍' : world.location) : '我的农场';
  $('farmHud').hidden = !world; $('world').hidden = !!world;
  if (world) {
    $('farmHud').dataset.season = world.date.season;
    $('season').textContent = seasons[world.date.season] || world.date.season;
    $('day').textContent = world.date.day; $('year').textContent = '第 ' + world.date.year + ' 年';
    $('gameTime').textContent = `${Math.floor(world.time / 100)}:${String(world.time % 100).padStart(2, '0')}`;
    $('farmLocation').textContent = world.location === 'Farm' ? '农场' : world.location === 'FarmHouse' ? '农舍' : world.location;
    $('energyValue').textContent = `${Math.round(world.player.energy)} / ${world.player.maxEnergy}`;
    const meter = $('energyMeter'), max = Math.max(1, world.player.maxEnergy);
    meter.max = max; meter.low = max * .2; meter.high = max * .5; meter.optimum = max; meter.value = Math.max(0, world.player.energy);
    meter.title = '体力 ' + $('energyValue').textContent;
    $('position').textContent = `位置 ${world.player.position.x}, ${world.player.position.y}`;
  }
  renderInventory(world);
  $('capability').textContent = !world ? '' : !world.entities.some(e => e.diggable !== undefined) ? '需要更新 Mod 才能完整操作农务。请保存退出游戏后重新运行 pnpm start --jev。'
    : !world.entities.some(e => e.refillable !== undefined) ? '当前 Mod 尚无补水观察信息，保存退出后重新启动可安装新版。'
    : world.menu ? '当前菜单：' + world.menu.type + ' · ' + world.menu.text : '依据当前观察绘制。商店购买与容器取放暂未支持。';
  renderEvents(s.events);
  const plan = s.planner;
  $('plannerMode').textContent = plan ? (phases[plan.phase] || plan.phase) : 'Jev 直接执行';
  $('plannerSummary').textContent = plan ? '总目标：' + plan.objective + '。' + (plan.summary || '阶段结束后自动回传原聊天。') + (plan.deliveryError ? ' ' + plan.deliveryError : '') : '复杂目标可以在 dsh 聊天中提出，大模型负责分阶段，Jev 负责行动。';
  const used = plan ? plan.stages.reduce((sum, stage) => sum + stage.apiCalls, 0) + (plan.activeRunId === s.runId && !plan.stages.some(stage => stage.runId === s.runId) ? s.memory.apiCalls : 0) : 0;
  $('plannerBudget').textContent = plan ? `已结束 ${plan.stages.length}/${plan.maxStages} 个阶段 · 剩余 ${Math.max(0, plan.maxDecisions - used)} 次 Jev 决策。手动控制会结束自动接续。` : '';
  $('plannerEvidence').textContent = JSON.stringify(plan ?? null, null, 2);
  draw(world); controls();
}
async function poll() {
  const ticket = generation;
  if (!busy) try {
    const view = await api('state');
    if (ticket === generation && !busy) {
      if (pollingError) { clientError = null; pollingError = false; }
      render(view);
    }
  } catch (e) {
    if (ticket === generation && !busy) { pollingError = true; error(e); }
  }
  setTimeout(poll, 1000);
}
controls(); poll();
