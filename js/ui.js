// UI 渲染与交互

function init() {
    loadState();
    mermaid.initialize({ startOnLoad: false, theme: 'neutral' });

    renderSessionList();
    renderChannelOptions();

    if (state.sessions.length === 0) {
        createNewSession();
    } else if (state.currentSessionId) {
        selectSession(state.currentSessionId);
    } else {
        selectSession(state.sessions[0].id);
    }

    const tx = document.getElementById('user-input');
    tx.addEventListener("input", function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + "px";
    });
}

// Session Management
function createNewSession() {
    const id = Date.now().toString();
    const newSession = {
        id: id,
        title: '新对话',
        messages: [],
        createdAt: Date.now()
    };
    state.sessions.unshift(newSession);
    selectSession(id);
    saveState();
    renderSessionList();
    if(window.innerWidth < 1024) toggleSidebar('close-all');
}

function deleteSession(id, e) {
    e.stopPropagation();
    if(!confirm('确认删除此对话?')) return;
    state.sessions = state.sessions.filter(s => s.id !== id);
    if(state.currentSessionId === id) {
        state.currentSessionId = state.sessions.length ? state.sessions[0].id : null;
        if(!state.currentSessionId) {
            document.getElementById('messages-list').innerHTML = '';
            document.getElementById('empty-state').classList.remove('hidden');
        } else {
            selectSession(state.currentSessionId);
        }
    }
    saveState();
    renderSessionList();
}

function selectSession(id) {
    state.currentSessionId = id;
    saveState();
    renderSessionList();
    renderChat();
}

function renderSessionList() {
    const list = document.getElementById('session-list');
    const search = document.getElementById('session-search').value.toLowerCase();
    list.innerHTML = '';

    state.sessions.filter(s => s.title.toLowerCase().includes(search)).forEach(s => {
        const active = s.id === state.currentSessionId ? 'bg-surface-200 font-medium text-surface-900' : 'text-surface-800 hover:bg-surface-100';
        const div = document.createElement('div');
        div.className = `group flex items-center justify-between px-3 py-2 rounded-sm cursor-pointer text-sm transition-colors ${active}`;
        div.onclick = () => selectSession(s.id);
        div.innerHTML = `
            <div class="truncate flex-1 pr-2">${escapeHtml(s.title)}</div>
            <button class="opacity-0 group-hover:opacity-100 text-surface-400 hover:text-red-600 transition-opacity" onclick="deleteSession('${s.id}', event)">
                <span class="material-symbols-outlined text-[16px]">delete</span>
            </button>
        `;
        list.appendChild(div);
    });
}

// Chat Rendering
async function renderChat() {
    const container = document.getElementById('messages-list');
    const emptyState = document.getElementById('empty-state');
    const currentSession = state.sessions.find(s => s.id === state.currentSessionId);

    container.innerHTML = '';

    if (!currentSession || currentSession.messages.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');

    for (let i = 0; i < currentSession.messages.length; i++) {
        const msg = currentSession.messages[i];
        const div = document.createElement('div');
        const isUser = msg.role === 'user';

        div.className = `flex ${isUser ? 'justify-end' : 'justify-start'}`;

        const contentHtml = isUser ? `<div class="whitespace-pre-wrap">${escapeHtml(msg.content)}</div>` : renderMarkdown(msg.content);

        let fileHtml = '';
        if (msg.fileData) {
            fileHtml = `<div class="mb-2 p-2 bg-surface-50 border border-surface-200 rounded text-xs flex items-center gap-2 text-surface-800">
                <span class="material-symbols-outlined text-[16px]">image</span>
                <span>Attachment included</span>
            </div>`;
        }

        div.innerHTML = `
            <div class="max-w-[85%] lg:max-w-[75%] group relative">
                <div class="${isUser ? 'bg-surface-200 text-surface-900' : 'bg-white text-surface-900'} px-4 py-3 rounded-lg border ${isUser ? 'border-transparent' : 'border-transparent'}">
                    ${fileHtml}
                    <div class="prose prose-zinc text-sm">${contentHtml}</div>
                </div>
                <div class="absolute ${isUser ? 'right-0 -bottom-6' : 'left-0 -bottom-6'} opacity-0 group-hover:opacity-100 transition-opacity flex gap-2 text-surface-400">
                    <button onclick="copyText('${escapeHtml(msg.content.replace(/'/g, "\\'"))}')" title="复制" class="hover:text-surface-800"><span class="material-symbols-outlined text-[14px]">content_copy</span></button>
                    ${!isUser ? `<button onclick="regenerateMessage(${i})" title="重新生成" class="hover:text-surface-800"><span class="material-symbols-outlined text-[14px]">refresh</span></button>` : ''}
                    <button onclick="viewLogForMessage(${i})" title="查看日志" class="hover:text-surface-800"><span class="material-symbols-outlined text-[14px]">code</span></button>
                </div>
            </div>
        `;
        container.appendChild(div);
    }

    try {
        await mermaid.run({
            querySelector: '.mermaid'
        });
    } catch(e) { console.log("Mermaid render warn", e); }

    const scrollArea = document.getElementById('chat-container');
    scrollArea.scrollTop = scrollArea.scrollHeight;
}

function renderMarkdown(text) {
    const renderer = new marked.Renderer();
    renderer.code = function(code, language) {
        if (language === 'mermaid') {
            return `<div class="mermaid">${code}</div>`;
        }
        return `<pre><code class="language-${language}">${code}</code></pre>`;
    };

    return DOMPurify.sanitize(marked.parse(text, { renderer: renderer }));
}

// Settings & Channels
function openSettings() {
    document.getElementById('settings-modal').classList.add('active');
    renderChannelsSettings();
    renderPluginSettings();
}

function closeSettings() {
    document.getElementById('settings-modal').classList.remove('active');
    loadState();
    renderChannelOptions();
}

function switchSettingsTab(tab) {
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.add('hidden'));
    document.getElementById(`tab-${tab}`).classList.remove('hidden');
    document.querySelectorAll('.settings-tab-btn').forEach(b => {
        b.classList.remove('active-tab', 'bg-surface-200', 'font-bold');
        if(b.dataset.tab === tab) b.classList.add('active-tab', 'bg-surface-200', 'font-bold');
    });
}

function renderChannelsSettings() {
    const list = document.getElementById('channels-list');
    list.innerHTML = '';

    state.channels.forEach(c => {
        const div = document.createElement('div');
        div.className = "border border-surface-200 rounded p-3 flex justify-between items-center bg-surface-50";
        div.innerHTML = `
            <div>
                <div class="font-bold text-sm">${escapeHtml(c.name)}</div>
                <div class="text-xs text-surface-500 font-mono">${escapeHtml(c.baseUrl)}</div>
            </div>
            <div class="flex gap-2">
                <button onclick="editChannel('${c.id}')" class="text-xs text-blue-600 underline">编辑</button>
                <button onclick="deleteChannel('${c.id}')" class="text-xs text-red-600 underline">删除</button>
            </div>
        `;
        list.appendChild(div);
    });
}

function editChannel(id = null) {
    const editor = document.getElementById('channel-editor');
    editor.classList.remove('hidden');

    const pSelect = document.getElementById('edit-channel-plugin');
    pSelect.innerHTML = state.plugins.map(p => `<option value="${p.id}">${p.name}</option>`).join('');

    if (id) {
        const c = state.channels.find(x => x.id === id);
        document.getElementById('editor-title').innerText = '编辑渠道';
        document.getElementById('edit-channel-id').value = c.id;
        document.getElementById('edit-channel-name').value = c.name;

        const urlValue = c.useFullUrl ? c.baseUrl + '#' : c.baseUrl;
        document.getElementById('edit-channel-url').value = urlValue;

        document.getElementById('edit-channel-key').value = c.apiKey;
        document.getElementById('edit-channel-models').value = c.models.join(', ');
        document.getElementById('edit-channel-plugin').value = c.pluginId;
        document.getElementById('edit-channel-headers').value = c.customHeaders || '';
        document.getElementById('edit-channel-body').value = c.customBody || '';
    } else {
        document.getElementById('editor-title').innerText = '添加新渠道';
        document.getElementById('edit-channel-id').value = '';
        document.getElementById('edit-channel-name').value = '';
        document.getElementById('edit-channel-url').value = '';
        document.getElementById('edit-channel-key').value = '';
        document.getElementById('edit-channel-models').value = '';
        document.getElementById('edit-channel-headers').value = '';
        document.getElementById('edit-channel-body').value = '';
    }
    updateUrlPreview();
}

function saveChannel() {
    const id = document.getElementById('edit-channel-id').value || Date.now().toString();
    const name = document.getElementById('edit-channel-name').value;
    let url = document.getElementById('edit-channel-url').value.trim();
    const key = document.getElementById('edit-channel-key').value;
    const pluginId = document.getElementById('edit-channel-plugin').value;
    const modelsStr = document.getElementById('edit-channel-models').value;
    const customHeaders = document.getElementById('edit-channel-headers').value;
    const customBody = document.getElementById('edit-channel-body').value;

    if (!name || !url) {
        alert('名称和URL必填');
        return;
    }

    let useFullUrl = false;
    if (url.endsWith('#')) {
        useFullUrl = true;
        url = url.slice(0, -1);
    }

    const newChannel = {
        id, name, baseUrl: url, apiKey: key, pluginId,
        models: modelsStr.split(',').map(s => s.trim()).filter(s => s),
        customHeaders, customBody,
        useFullUrl: useFullUrl
    };

    const idx = state.channels.findIndex(c => c.id === id);
    if (idx >= 0) state.channels[idx] = newChannel;
    else state.channels.push(newChannel);

    saveState();
    document.getElementById('channel-editor').classList.add('hidden');
    renderChannelsSettings();
}

function deleteChannel(id) {
    if(!confirm('删除此渠道?')) return;
    state.channels = state.channels.filter(c => c.id !== id);
    saveState();
    renderChannelsSettings();
}

function updateUrlPreview() {
    const rawBase = document.getElementById('edit-channel-url').value.trim();
    const preview = document.getElementById('url-preview');
    const pluginSelect = document.getElementById('edit-channel-plugin');
    const pluginId = pluginSelect ? pluginSelect.value : null;

    if (!rawBase) {
        preview.innerText = '...';
        return;
    }

    const isFullUrl = rawBase.endsWith('#');
    const base = isFullUrl ? rawBase.slice(0, -1) : rawBase;

    if (isFullUrl) {
        preview.innerHTML = `<span class="text-green-600">${base}</span> <span class="text-xs text-orange-600">(完整URL模式)</span>`;
        return;
    }

    const cleanBase = base.replace(/\/+$/, '');
    let example;

    switch (pluginId) {
        case 'openai':
            example = `${cleanBase}/v1/chat/completions`;
            break;
        case 'anthropic':
            example = `${cleanBase}/v1/messages`;
            break;
        case 'gemini':
            example = `${cleanBase}/v1beta/models/{model}:streamGenerateContent?key=YOUR_KEY`;
            break;
        default:
            example = `${cleanBase}/... 自定义格式`;
    }

    preview.textContent = example;
}

// Plugin Settings
function renderPluginSettings() {
    const list = document.getElementById('plugins-list');
    list.innerHTML = '';
    state.plugins.forEach(p => {
        const div = document.createElement('div');
        div.className = "border border-surface-200 rounded p-4 bg-surface-50 relative group";
        div.innerHTML = `
            <div class="font-bold text-sm">${escapeHtml(p.name)}</div>
            <div class="text-xs text-surface-500 mt-1">${p.builtin ? '内置预设' : '用户自定义'}</div>
            <div class="mt-3 flex gap-2">
                <button onclick="editPlugin('${p.id}')" class="text-xs bg-white border border-surface-300 px-2 py-1 rounded hover:bg-surface-100">查看/编辑代码</button>
                ${!p.builtin ? `<button onclick="deletePlugin('${p.id}')" class="text-xs text-red-600 px-2 py-1">删除</button>` : ''}
            </div>
        `;
        list.appendChild(div);
    });
}

function editPlugin(id) {
    const p = state.plugins.find(x => x.id === id);
    if(!p) return;

    document.getElementById('plugin-editor').classList.remove('hidden');
    document.getElementById('edit-plugin-id').value = p.id;
    document.getElementById('edit-plugin-name').value = p.name;
    document.getElementById('edit-plugin-req').value = p.reqScript;
    document.getElementById('edit-plugin-res').value = p.resScript;
}

function createNewPlugin() {
    document.getElementById('plugin-editor').classList.remove('hidden');
    document.getElementById('edit-plugin-id').value = '';
    document.getElementById('edit-plugin-name').value = 'New Plugin';
    document.getElementById('edit-plugin-req').value = DEFAULT_PLUGINS[0].reqScript;
    document.getElementById('edit-plugin-res').value = DEFAULT_PLUGINS[0].resScript;
}

function savePlugin() {
    const id = document.getElementById('edit-plugin-id').value || Date.now().toString();
    const name = document.getElementById('edit-plugin-name').value;
    const req = document.getElementById('edit-plugin-req').value;
    const res = document.getElementById('edit-plugin-res').value;

    const newP = { id, name, reqScript: req, resScript: res, builtin: false };
    const idx = state.plugins.findIndex(p => p.id === id);

    if (idx >= 0) state.plugins[idx] = newP;
    else state.plugins.push(newP);

    saveState();
    closePluginEditor();
    renderPluginSettings();
}

function closePluginEditor() {
    document.getElementById('plugin-editor').classList.add('hidden');
}

function deletePlugin(id) {
    if(!confirm('删除此插件?')) return;
    state.plugins = state.plugins.filter(p => p.id !== id);
    saveState();
    renderPluginSettings();
}

// Channel select in main header
function renderChannelOptions() {
    const cSelect = document.getElementById('channel-select');
    const savedVal = cSelect.value;
    cSelect.innerHTML = '<option value="" disabled selected>选择渠道</option>';

    state.channels.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.text = c.name;
        cSelect.appendChild(opt);
    });

    if (state.channels.length > 0) {
        cSelect.value = savedVal && state.channels.find(c => c.id === savedVal) ? savedVal : state.channels[0].id;
        loadModelsForChannel();
    }
}

function loadModelsForChannel() {
    const cid = document.getElementById('channel-select').value;
    const mSelect = document.getElementById('model-select');
    mSelect.innerHTML = '<option value="" disabled selected>选择模型</option>';

    const channel = state.channels.find(c => c.id === cid);
    if (channel && channel.models) {
        channel.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.text = m;
            mSelect.appendChild(opt);
        });
        if(channel.models.length > 0) mSelect.value = channel.models[0];
    }
}

// Logs UI
function renderLogs() {
    const container = document.getElementById('logs-list');
    const filter = document.getElementById('log-search').value.toLowerCase();
    container.innerHTML = '';

    state.logs.filter(l => {
        if(filter && !JSON.stringify(l).toLowerCase().includes(filter)) return false;
        return true;
    }).forEach(log => {
        const div = document.createElement('div');
        div.className = "p-3 border-b border-surface-200 hover:bg-surface-100 cursor-pointer text-xs";
        div.onclick = () => viewLogDetail(log);

        const statusColor = log.status === 'success' ? 'text-green-600' : 'text-red-600';
        const time = new Date(log.timestamp).toLocaleTimeString();

        div.innerHTML = `
            <div class="flex justify-between mb-1">
                <span class="font-mono font-bold ${statusColor}">${log.status.toUpperCase()}</span>
                <span class="text-surface-400">${time}</span>
            </div>
            <div class="font-medium truncate mb-1">${log.model}</div>
            <div class="text-surface-500 truncate font-mono text-[10px]">${log.request.url}</div>
        `;
        container.appendChild(div);
    });
}

function viewLogDetail(log) {
    const modal = document.getElementById('log-modal');
    modal.classList.add('active');

    document.getElementById('log-detail-url').textContent = log.request.url;
    document.getElementById('log-detail-headers').textContent = JSON.stringify(log.request.headers, null, 2);

    try {
        const bodyJson = JSON.parse(log.request.body);
        document.getElementById('log-detail-body').textContent = JSON.stringify(bodyJson, null, 2);
    } catch(e) {
        document.getElementById('log-detail-body').textContent = log.request.body;
    }

    document.getElementById('log-detail-response').textContent = log.responseRaw || (log.error ? log.error : 'No response data');
}

function viewLogForMessage(index) {
    const log = state.logs.find(l => l.sessionId === state.currentSessionId && l.msgIndex === index);
    if (log) {
        viewLogDetail(log);
    } else {
        alert('找不到此消息的日志 (可能已过期或未记录)');
    }
}

function clearLogs() {
    state.logs = [];
    renderLogs();
}


