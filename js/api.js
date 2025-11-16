// 网络请求与消息发送逻辑

let tempFileData = null;

function handleFileUpload(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        tempFileData = e.target.result; // Base64
        const preview = document.getElementById('file-preview-area');
        preview.classList.remove('hidden');
        preview.innerHTML = `
            <div class="relative group inline-block">
                <div class="w-12 h-12 bg-surface-200 rounded border border-surface-300 flex items-center justify-center overflow-hidden">
                    ${file.type.startsWith('image') ? `<img src="${tempFileData}" class="w-full h-full object-cover">` : '<span class="material-symbols-outlined">description</span>'}
                </div>
                <button onclick="clearFile()" class="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px]">✕</button>
            </div>
        `;
    };
    reader.readAsDataURL(file);
}

function clearFile() {
    tempFileData = null;
    document.getElementById('file-upload').value = '';
    document.getElementById('file-preview-area').classList.add('hidden');
    document.getElementById('file-preview-area').innerHTML = '';
}

function handleInputKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

async function sendMessage() {
    const inputEl = document.getElementById('user-input');
    const content = inputEl.value.trim();
    if (!content && !tempFileData) return;

    const channelId = document.getElementById('channel-select').value;
    const model = document.getElementById('model-select').value;

    if (!channelId || !model) {
        alert('请先配置并选择 API 渠道和模型');
        openSettings();
        return;
    }

    const currentSession = state.sessions.find(s => s.id === state.currentSessionId);
    currentSession.messages.push({
        role: 'user',
        content: content,
        fileData: tempFileData,
        timestamp: Date.now()
    });

    if(currentSession.messages.length === 1) {
        currentSession.title = content.substring(0, 30) || 'New Conversation';
        renderSessionList();
    }

    inputEl.value = '';
    inputEl.style.height = 'auto';
    const sentFileData = tempFileData;
    clearFile();

    renderChat();

    await generateResponse(currentSession, channelId, model, sentFileData);
}

async function generateResponse(session, channelId, model, fileData) {
    const channel = state.channels.find(c => c.id === channelId);
    const plugin = state.plugins.find(p => p.id === channel.pluginId);

    if (!channel || !plugin) {
        alert('配置错误: 找不到渠道或插件');
        return;
    }

    const assistantMsgIndex = session.messages.length;
    session.messages.push({
        role: 'assistant',
        content: '',
        model: model,
        timestamp: Date.now(),
        waiting: true
    });

    const container = document.getElementById('messages-list');
    const loadingDiv = document.createElement('div');
    loadingDiv.id = `msg-loading-${assistantMsgIndex}`;
    loadingDiv.className = "flex justify-start";
    loadingDiv.innerHTML = `
        <div class="bg-white px-4 py-3 rounded-lg border border-transparent">
            <div class="flex gap-1"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>
        </div>`;
    container.appendChild(loadingDiv);
    const scrollArea = document.getElementById('chat-container');
    scrollArea.scrollTop = scrollArea.scrollHeight;

    let requestData;
    try {
        const context = {
            baseUrl: channel.baseUrl,
            apiKey: channel.apiKey,
            model: model,
            messages: session.messages.slice(0, -1),
            fileData: fileData,
            useFullUrl: channel.useFullUrl || false
        };

        const builder = new Function('context', plugin.reqScript);
        requestData = builder(context);

        if (channel.useFullUrl) {
            requestData.url = channel.baseUrl;
        }

        if (channel.customHeaders) {
            try {
                const headers = JSON.parse(channel.customHeaders);
                requestData.headers = { ...requestData.headers, ...headers };
            } catch(e) {}
        }

    } catch (e) {
        handleError(session, assistantMsgIndex, `Plugin Error (Build): ${e.message}`);
        return;
    }

    let rawResponseText = '';

    try {
        const response = await fetch(requestData.url, {
            method: requestData.method,
            headers: requestData.headers,
            body: requestData.body
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        document.getElementById(`msg-loading-${assistantMsgIndex}`).remove();

        let aiContent = '';
        const parser = new Function('chunk', 'context', plugin.resScript);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            rawResponseText += chunk;

            try {
                const parsedFragment = parser(chunk, {});
                if (parsedFragment) {
                    aiContent += parsedFragment;
                    session.messages[assistantMsgIndex].content = aiContent;
                    session.messages[assistantMsgIndex].waiting = false;
                    updateLastMessage(aiContent);
                }
            } catch (e) {
                console.error("Parse Error in Stream", e);
            }
        }

        session.messages[assistantMsgIndex].waiting = false;
        saveState();

        addLog({
            timestamp: Date.now(),
            status: 'success',
            model: model,
            request: requestData,
            responseRaw: rawResponseText
        }, assistantMsgIndex);

    } catch (e) {
        document.getElementById(`msg-loading-${assistantMsgIndex}`)?.remove();
        handleError(session, assistantMsgIndex, `Network Error: ${e.message}`);
        addLog({
            timestamp: Date.now(),
            status: 'error',
            error: e.message,
            request: requestData,
            responseRaw: rawResponseText
        }, assistantMsgIndex);
    }
}

function updateLastMessage(content) {
    // 简化处理：直接重新渲染
    renderChat();
}

function handleError(session, index, msg) {
    session.messages[index].content = `**Error:** ${msg}`;
    session.messages[index].waiting = false;
    saveState();
    renderChat();
}

function regenerateMessage(index) {
    const currentSession = state.sessions.find(s => s.id === state.currentSessionId);
    currentSession.messages = currentSession.messages.slice(0, index);
    renderChat();

    const channelId = document.getElementById('channel-select').value;
    const model = document.getElementById('model-select').value;

    generateResponse(currentSession, channelId, model, null);
}

async function fetchModels() {
    const url = document.getElementById('edit-channel-url').value;
    const key = document.getElementById('edit-channel-key').value;

    if (!url) { alert('请输入 Base URL'); return; }

    try {
        const target = url.replace(/\/+$/, '') + '/v1/models';
        const res = await fetch(target, {
            headers: { 'Authorization': 'Bearer ' + key }
        });
        const data = await res.json();

        let models = [];
        if (data.data && Array.isArray(data.data)) {
            models = data.data.map(m => m.id);
        } else {
            alert('无法自动解析模型列表，请手动输入。');
            return;
        }

        document.getElementById('edit-channel-models').value = models.join(', ');
        alert(`成功获取 ${models.length} 个模型`);

    } catch(e) {
        alert('获取模型失败: ' + e.message);
    }
}

function addLog(entry, msgIndex) {
    entry.sessionId = state.currentSessionId;
    entry.msgIndex = msgIndex;
    state.logs.unshift(entry);
    if(state.logs.length > 50) state.logs.pop();
    renderLogs();
}


