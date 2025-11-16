// ===== constants.js =====
// 常量与默认模板

const DEFAULT_PLUGINS = [
    {
        id: 'openai',
        name: 'OpenAI Compatible (Default)',
        builtin: true,
        reqScript: `
			// Context: { baseUrl, apiKey, model, messages, fileData, useFullUrl }
			
			let url;
			if (context.useFullUrl) {
				// 🆕 完整URL模式：直接使用用户输入的URL
				url = context.baseUrl;
			} else {
				// 默认模式：拼接标准路径
				url = (context.baseUrl || '').replace(/\\/+$/, '') + '/v1/chat/completions';
			}
			
			const body = {
				model: context.model,
				messages: context.messages,
				stream: true
			};
	 
			return {
				url: url,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': 'Bearer ' + context.apiKey
				},
				body: JSON.stringify(body)
			};
		`,
        resScript: `
            /**
             * chunk: 当前这一次从流里读到的字符串片段
             * context: 由外层 JS 传入的上下文对象，目前包含：
             *   - context.raw: 截止目前为止所有片段拼接后的完整字符串
             *   - context._sseOffset: 已经作为 SSE 解析过的字符偏移量（用于增量解析）
             *   - context._jsonParsed: 是否已经成功从完整 JSON 里解析过一次
             */
            let text = '';
            const rawChunk = (chunk || '').toString();
            const fullRaw = (context && context.raw) ? String(context.raw) : rawChunk;
            const trimmedChunk = rawChunk.trim();
            const trimmedFull = fullRaw.trim();

            function extractFromDelta(delta) {
                if (!delta) return '';
                // 优先 content，其次 reasoning_content
                if (typeof delta.content === 'string') return delta.content;
                if (typeof delta.reasoning_content === 'string') return delta.reasoning_content;
                return '';
            }

            // --- 调试日志（可通过 window.__ODYSSEIA_DEBUG_STREAM__ 开关） ---
            if (typeof window !== 'undefined' && window.__ODYSSEIA_DEBUG_STREAM__) {
                console.log('[OpenAI.resScript] chunk=', rawChunk);
                console.log('[OpenAI.resScript] fullRaw.length=', fullRaw.length);
            }

            // 情况 1：标准 SSE 流（每行以 data: 开头）
            // 注意：SSE 的一行 JSON 可能被拆到多个 chunk 里，这里用 _sseBuffer 做增量缓冲，
            // 只在「确认拿到完整一行」且 JSON.parse 成功时才消费该行，失败则把该行放回缓冲区等待后续数据。
            const looksLikeSSE =
                trimmedChunk.startsWith('data:') ||
                rawChunk.indexOf('\\ndata:') !== -1 ||
                (context && typeof context._sseBuffer === 'string' && context._sseBuffer.indexOf('data:') !== -1);

            if (looksLikeSSE) {
                if (!context) { context = {}; }
                if (typeof context._sseBuffer !== 'string') {
                    context._sseBuffer = '';
                }

                // 把本次 chunk 追加到缓冲区
                context._sseBuffer += rawChunk;

                while (true) {
                    const newlineIndex = context._sseBuffer.indexOf('\\n');
                    if (newlineIndex === -1) break; // 还没有完整的一行，等待下一个 chunk

                    // 取出一行（包含换行符）
                    const lineWithLF = context._sseBuffer.slice(0, newlineIndex + 1);
                    context._sseBuffer = context._sseBuffer.slice(newlineIndex + 1);

                    const l = lineWithLF.trim();
                    if (!l || l === 'data: [DONE]') continue;
                    if (!l.startsWith('data: ')) continue;

                    const payload = l.substring(6).trim();
                    if (!payload) continue;

                    try {
                        const json = JSON.parse(payload);
                        const choice = json.choices && json.choices[0];
                        const delta = choice && choice.delta;
                        const piece = extractFromDelta(delta);
                        if (piece) text += piece;
                    } catch (e) {
                        // JSON 还不完整，把这一整行放回缓冲区头部，等待更多数据再一起解析
                        if (typeof window !== 'undefined' && window.__ODYSSEIA_DEBUG_STREAM__) {
                            console.log('[OpenAI.resScript] SSE line incomplete, keep in buffer. line length=', l.length);
                        }
                        context._sseBuffer = lineWithLF + context._sseBuffer;
                        break;
                    }
                }

                return text;
            }

            // 情况 2：一次性 JSON / 非 SSE 流式 JSON
            // 这里使用累计的 fullRaw，只要能被完整解析为 JSON，就解析一次并标记已解析
            if (trimmedFull.startsWith('{') || trimmedFull.startsWith('[')) {
                if (context && context._jsonParsed) {
                    // 已经解析过一次，避免重复累加
                    return '';
                }
                try {
                    const json = JSON.parse(trimmedFull);
                    if (json && Array.isArray(json.choices) && json.choices.length > 0) {
                        const choice = json.choices[0];
                        // message.content / text / delta.*
                        let piece = '';
                        if (choice.message && typeof choice.message.content === 'string') {
                            piece = choice.message.content;
                        } else if (typeof choice.text === 'string') {
                            piece = choice.text;
                        } else if (choice.delta) {
                            piece = extractFromDelta(choice.delta);
                        }
                        if (piece) text += piece;
                    }
                    if (context) {
                        context._jsonParsed = true;
                    }
                } catch (e) {
                    // 解析失败一般是因为 JSON 还不完整，等下一个 chunk 继续累积
                    if (typeof window !== 'undefined' && window.__ODYSSEIA_DEBUG_STREAM__) {
                        console.log('[OpenAI.resScript] JSON parse pending, length=', trimmedFull.length);
                    }
                }
            }

            return text;
        `
    },
    {
        id: 'openai-image',
        name: 'OpenAI Image (Chat)',
        builtin: true,
        reqScript: `
			// Context: { baseUrl, apiKey, model, messages, fileData, useFullUrl }
			// 目标：
			// 1) 请求只包含：当前这一轮用户指令 + 上一轮模型生成的图片
			// 2) 忽略更早的用户/助手对话（但保留 system 提示）
			// 3) 使用 OpenAI chat/completions 协议，消息 content 为多模态数组
			
			let url;
			if (context.useFullUrl) {
				url = context.baseUrl;
			} else {
				url = (context.baseUrl || '').replace(/\\/+$/, '') + '/v1/chat/completions';
			}

			const allMessages = Array.isArray(context.messages) ? context.messages : [];

			// 保留所有 system 消息，避免丢失全局指令
			const systemMessages = allMessages.filter(m => m.role === 'system' && typeof m.content === 'string');

			// 找到当前这轮 user（从尾部往前找第一个 user）
			const lastUser = [...allMessages].reverse().find(m => m.role === 'user');
			// 找到上一轮 assistant（从尾部往前找第一个 assistant）
			const lastAssistant = [...allMessages].reverse().find(m => m.role === 'assistant');

			const userContent = [];

			if (lastUser && typeof lastUser.content === 'string' && lastUser.content.trim()) {
				userContent.push({
					type: 'text',
					text: lastUser.content
				});
			}

			// 从上一轮助手回复中提取 Markdown 图片，并作为 image_url 传入
			function extractImageUrlsFromContent(text) {
				if (!text || typeof text !== 'string') return [];
				const urls = [];
				const regex = /!\\[[^\\]]*\\]\\(([^)]+)\\)/g;
				let m;
				while ((m = regex.exec(text)) !== null) {
					const url = (m[1] || '').trim();
					if (url) urls.push(url);
				}
				return urls;
			}

			if (lastAssistant && typeof lastAssistant.content === 'string') {
				const imageUrls = extractImageUrlsFromContent(lastAssistant.content);
				imageUrls.forEach(u => {
					userContent.push({
						type: 'image_url',
						image_url: { url: u }
					});
				});
			}

			// 如果既没有文本也没有图片，退化为一个空文本，避免报错
			if (userContent.length === 0) {
				userContent.push({
					type: 'text',
					text: ''
				});
			}

			const body = {
				model: context.model,
				messages: [
					...systemMessages.map(m => ({ role: 'system', content: m.content })),
					{ role: 'user', content: userContent }
				],
				stream: true
			};
	 
			return {
				url: url,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': 'Bearer ' + context.apiKey
				},
				body: JSON.stringify(body)
			};
		`,
        resScript: `
            /**
             * 解析 OpenAI SSE / JSON 响应，但仅向外输出「图片 Markdown」，丢弃其他文本。
             * chunk: 当前这一次从流里读到的字符串片段
             * context: 由外层 JS 传入的上下文对象，目前包含：
             *   - context.raw: 截止目前为止所有片段拼接后的完整字符串
             *   - 额外本插件使用的字段：
             *       - context._fullText: 已累计的完整助手文本
             *       - context._emittedImageCount: 已经输出过的图片数量
             */
            let text = '';
            const rawChunk = (chunk || '').toString();
            const fullRaw = (context && context.raw) ? String(context.raw) : rawChunk;
            const trimmedChunk = rawChunk.trim();
            const trimmedFull = fullRaw.trim();

            function extractFromDelta(delta) {
                if (!delta) return '';
                // 优先 content，其次 reasoning_content
                if (typeof delta.content === 'string') return delta.content;
                if (typeof delta.reasoning_content === 'string') return delta.reasoning_content;
                return '';
            }

            // 从累计文本中提取「尚未输出过」的图片 Markdown
            function extractNewImagesFromFullText(full, ctx) {
                if (!full) return '';
                if (!ctx) ctx = {};
                if (typeof ctx._emittedImageCount !== 'number') {
                    ctx._emittedImageCount = 0;
                }

                const imgRegex = /!\\[[^\\]]*\\]\\([^)]*\\)/g;
                const allImages = [];
                let m;
                while ((m = imgRegex.exec(full)) !== null) {
                    allImages.push(m[0]);
                }

                if (allImages.length <= ctx._emittedImageCount) {
                    return '';
                }

                const newOnes = allImages.slice(ctx._emittedImageCount);
                ctx._emittedImageCount = allImages.length;
                return newOnes.join('\\n\\n');
            }

            function handleNewPiece(piece, ctx) {
                if (!piece) return '';
                if (!ctx) ctx = {};
                if (typeof ctx._fullText !== 'string') {
                    ctx._fullText = '';
                }
                ctx._fullText += piece;
                return extractNewImagesFromFullText(ctx._fullText, ctx);
            }

            // --- 调试日志（可通过 window.__ODYSSEIA_DEBUG_STREAM__ 开关） ---
            if (typeof window !== 'undefined' && window.__ODYSSEIA_DEBUG_STREAM__) {
                console.log('[OpenAI-Image.resScript] chunk=', rawChunk);
                console.log('[OpenAI-Image.resScript] fullRaw.length=', fullRaw.length);
            }

            // 情况 1：标准 SSE 流（每行以 data: 开头）
            const looksLikeSSE =
                trimmedChunk.startsWith('data:') ||
                rawChunk.indexOf('\\ndata:') !== -1 ||
                (context && typeof context._sseBuffer === 'string' && context._sseBuffer.indexOf('data:') !== -1);

            if (looksLikeSSE) {
                if (!context) { context = {}; }
                if (typeof context._sseBuffer !== 'string') {
                    context._sseBuffer = '';
                }

                // 把本次 chunk 追加到缓冲区
                context._sseBuffer += rawChunk;

                while (true) {
                    const newlineIndex = context._sseBuffer.indexOf('\\n');
                    if (newlineIndex === -1) break; // 还没有完整的一行，等待下一个 chunk

                    // 取出一行（包含换行符）
                    const lineWithLF = context._sseBuffer.slice(0, newlineIndex + 1);
                    context._sseBuffer = context._sseBuffer.slice(newlineIndex + 1);

                    const l = lineWithLF.trim();
                    if (!l || l === 'data: [DONE]') continue;
                    if (!l.startsWith('data: ')) continue;

                    const payload = l.substring(6).trim();
                    if (!payload) continue;

                    try {
                        const json = JSON.parse(payload);
                        const choice = json.choices && json.choices[0];
                        const delta = choice && choice.delta;
                        const piece = extractFromDelta(delta);
                        const out = handleNewPiece(piece, context);
                        if (out) text += out;
                    } catch (e) {
                        // JSON 还不完整，把这一整行放回缓冲区头部，等待更多数据再一起解析
                        if (typeof window !== 'undefined' && window.__ODYSSEIA_DEBUG_STREAM__) {
                            console.log('[OpenAI-Image.resScript] SSE line incomplete, keep in buffer. line length=', l.length);
                        }
                        context._sseBuffer = lineWithLF + context._sseBuffer;
                        break;
                    }
                }

                return text;
            }

            // 情况 2：一次性 JSON / 非 SSE 流式 JSON
            if (trimmedFull.startsWith('{') || trimmedFull.startsWith('[')) {
                if (context && context._jsonParsed) {
                    // 已经解析过一次，避免重复累加
                    return '';
                }
                try {
                    const json = JSON.parse(trimmedFull);
                    if (json && Array.isArray(json.choices) && json.choices.length > 0) {
                        const choice = json.choices[0];
                        let piece = '';
                        if (choice.message && typeof choice.message.content === 'string') {
                            piece = choice.message.content;
                        } else if (typeof choice.text === 'string') {
                            piece = choice.text;
                        } else if (choice.delta) {
                            piece = extractFromDelta(choice.delta);
                        }

                        const out = handleNewPiece(piece, context);
                        if (out) text += out;
                    }
                    if (context) {
                        context._jsonParsed = true;
                    }
                } catch (e) {
                    // 解析失败一般是因为 JSON 还不完整，等下一个 chunk 继续累积
                    if (typeof window !== 'undefined' && window.__ODYSSEIA_DEBUG_STREAM__) {
                        console.log('[OpenAI-Image.resScript] JSON parse pending, length=', trimmedFull.length);
                    }
                }
            }

            return text;
        `
    },
    {
        id: 'anthropic',
        name: 'Anthropic Claude',
        builtin: true,
        reqScript: `
            const url = (context.baseUrl || '').replace(/\\/+$/, '') + '/v1/messages';
            
            const body = {
                model: context.model,
                messages: context.messages.filter(m => m.role !== 'system'),
                system: context.messages.find(m => m.role === 'system')?.content,
                max_tokens: 4096,
                stream: true
            };

            return {
                url: url,
                method: 'POST',
                headers: {
                    'x-api-key': context.apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json'
                },
                body: JSON.stringify(body)
            };
        `,
        resScript: `
            const lines = chunk.split('\\n');
            let text = '';
            for(const line of lines) {
                const l = line.trim();
                if(l.startsWith('event: content_block_delta') || l.startsWith('event: completion')) {
                }
                if (l.startsWith('data: ')) {
                     try {
                        const json = JSON.parse(l.substring(6));
                        if (json.type === 'content_block_delta' && json.delta && json.delta.text) {
                            text += json.delta.text;
                        }
                    } catch(e) {}
                }
            }
            return text;
        `
    },
    {
        id: 'gemini',
        name: 'Google Gemini',
        builtin: true,
        reqScript: `
             const url = \`\${context.baseUrl}/v1beta/models/\${context.model}:streamGenerateContent?key=\${context.apiKey}\`;
             
             const contents = context.messages.map(m => ({
                 role: m.role === 'assistant' ? 'model' : 'user',
                 parts: [{ text: m.content }]
             }));

             return {
                 url: url,
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ contents: contents })
             };
        `,
        resScript: `
            let text = '';
            const raw = (chunk || '').toString();
            const trimmed = raw.trim();

            // 适配你贴出来的这种 "data: { ... chat.completion.chunk ... }" SSE 流格式
            if (trimmed.startsWith('data:') || trimmed.indexOf('\\ndata:') !== -1) {
                const lines = raw.split('\\n');
                for (const line of lines) {
                    const l = line.trim();
                    if (!l || l === 'data: [DONE]') continue;
                    if (!l.startsWith('data: ')) continue;
                    try {
                        const json = JSON.parse(l.substring(6));
                        const choice = json.choices && json.choices[0];
                        if (!choice || !choice.delta) continue;
                        // 优先拿 delta.content，其次是 delta.reasoning_content
                        const piece = (typeof choice.delta.content === 'string' && choice.delta.content)
                            || (typeof choice.delta.reasoning_content === 'string' && choice.delta.reasoning_content)
                            || '';
                        if (piece) text += piece;
                    } catch (e) {
                        console.error('Parse error in Gemini SSE-like stream', e);
                    }
                }
                return text;
            }

            // 原生 Gemini JSON 流格式（保持兼容）
            try {
                const clean = raw.replace(/^,/, '').trim();
                const json = JSON.parse(clean);
                if (json.candidates && json.candidates[0].content) {
                    // 这里按官方 SDK 的结构来：candidates[0].content.parts[*].text
                    const parts = json.candidates[0].content.parts || [];
                    text += parts.map(p => p.text || '').join('');
                }
            } catch (e) {
                // ignore
            }
            return text;
        `
    }
];

// ===== state.js =====
// 状态管理与持久化
//
// 说明：为了避免把所有对话内容都放在 localStorage 里，
// 我们将「大数据」(sessions / logs，包括消息文本与图片等) 存到 IndexedDB，
// localStorage 只保存配置类数据 (channels / plugins / settings / currentSessionId)。

const state = {
    sessions: [],
    currentSessionId: null,
    channels: [],
    plugins: [],
    logs: [],
    settings: {
        theme: 'light'
    }
};

// --- IndexedDB 封装 ---
const ODYSSEIA_DB_NAME = 'odysseia_db';
const ODYSSEIA_DB_VERSION = 1;
const ODYSSEIA_STATE_STORE = 'state';
const ODYSSEIA_LS_KEY = 'odysseia_state'; // 仅保存配置

function openStateDB() {
    return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
            console.warn('IndexedDB not supported, fallback to localStorage only.');
            return resolve(null);
        }
        console.log('[Odysseia][IndexedDB] opening DB', ODYSSEIA_DB_NAME, 'v' + ODYSSEIA_DB_VERSION);
        const request = indexedDB.open(ODYSSEIA_DB_NAME, ODYSSEIA_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(ODYSSEIA_STATE_STORE)) {
                db.createObjectStore(ODYSSEIA_STATE_STORE, { keyPath: 'key' });
                console.log('[Odysseia][IndexedDB] object store created:', ODYSSEIA_STATE_STORE);
            }
        };
        request.onsuccess = () => {
            console.log('[Odysseia][IndexedDB] open success');
            resolve(request.result);
        };
        request.onerror = () => {
            console.error('[Odysseia][IndexedDB] open error', request.error);
            reject(request.error);
        };
    });
}

function idbGet(key) {
    return new Promise(async (resolve, reject) => {
        try {
            const db = await openStateDB();
            if (!db) return resolve(null);
            const tx = db.transaction(ODYSSEIA_STATE_STORE, 'readonly');
            const store = tx.objectStore(ODYSSEIA_STATE_STORE);
            const req = store.get(key);
            req.onsuccess = () => {
                const result = req.result;
                resolve(result ? result.value : null);
                db.close();
            };
            req.onerror = () => {
                reject(req.error);
                db.close();
            };
        } catch (e) {
            reject(e);
        }
    });
}

function idbSet(key, value) {
    return new Promise(async (resolve, reject) => {
        try {
            const db = await openStateDB();
            if (!db) return resolve();
            const tx = db.transaction(ODYSSEIA_STATE_STORE, 'readwrite');
            const store = tx.objectStore(ODYSSEIA_STATE_STORE);
            const req = store.put({ key, value });
            req.onsuccess = () => {
                console.log('[Odysseia][IndexedDB] set success', key);
                resolve();
            };
            req.onerror = () => {
                console.error('[Odysseia][IndexedDB] set error', key, req.error);
                reject(req.error);
            };
            tx.oncomplete = () => { db.close(); };
            tx.onerror = () => {
                console.error('IndexedDB transaction error', tx.error);
            };
        } catch (e) {
            console.error('IndexedDB set failed', e);
            resolve(); // 不阻塞业务逻辑
        }
    });
}

async function loadState() {
    try {
        // 1. 从 localStorage 读取配置 (兼容老版本结构)
        const raw = localStorage.getItem(ODYSSEIA_LS_KEY);
        let parsed = null;
        let legacySessions = null;
        let legacyLogs = null;

        if (raw) {
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                console.error('State parse failed', e);
            }
        }

        if (parsed) {
            state.channels = parsed.channels || [];
            state.plugins = parsed.plugins && parsed.plugins.length
                ? parsed.plugins
                : JSON.parse(JSON.stringify(DEFAULT_PLUGINS));
            state.currentSessionId = parsed.currentSessionId || null;
            if (parsed.settings) {
                state.settings = Object.assign({}, state.settings, parsed.settings);
            }

            // 兼容老版本：localStorage 里可能还带着 sessions/logs，一并迁移进 IndexedDB
            if (Array.isArray(parsed.sessions)) legacySessions = parsed.sessions;
            if (Array.isArray(parsed.logs)) legacyLogs = parsed.logs;
        } else {
            state.plugins = JSON.parse(JSON.stringify(DEFAULT_PLUGINS));
        }

        // 确保内置插件存在，并自动升级到最新内置实现（仅当不是用户自定义插件时）
        DEFAULT_PLUGINS.forEach(dp => {
            const existing = state.plugins.find(p => p.id === dp.id);
            if (!existing) {
                // 旧数据里不存在该内置插件，直接补上
                state.plugins.push(JSON.parse(JSON.stringify(dp)));
            } else if (existing.builtin !== false) {
                // builtin !== false 视为“内置插件实例”，自动同步到最新脚本
                existing.name = dp.name;
                existing.reqScript = dp.reqScript;
                existing.resScript = dp.resScript;
                existing.builtin = true;
            }
        });

        // 2. 从 IndexedDB 里拉取 sessions / logs
        let sessionsFromDB = null;
        let logsFromDB = null;
        try {
            sessionsFromDB = await idbGet('sessions');
            logsFromDB = await idbGet('logs');
        } catch (e) {
            console.error('IndexedDB load failed', e);
        }

        if (Array.isArray(sessionsFromDB)) {
            state.sessions = sessionsFromDB;
        } else if (Array.isArray(legacySessions)) {
            state.sessions = legacySessions;
        } else {
            state.sessions = [];
        }

        if (Array.isArray(logsFromDB)) {
            state.logs = logsFromDB;
        } else if (Array.isArray(legacyLogs)) {
            state.logs = legacyLogs;
        } else {
            state.logs = [];
        }

        // 3. 如果是从老版本 localStorage 迁移来的 sessions/logs，则写入 IndexedDB 并清理 localStorage 中的大对象
        if (!sessionsFromDB && (legacySessions || legacyLogs)) {
            await saveState(); // 内部会把 sessions/logs 写入 IndexedDB，并仅把配置写回 localStorage
        } else {
            // 确保 localStorage 里只保留配置
            await saveState();
        }
    } catch (e) {
        console.error('State load failed', e);
        state.plugins = JSON.parse(JSON.stringify(DEFAULT_PLUGINS));
    }
}

async function saveState() {
    // 1. localStorage 只保存配置类信息
    const config = {
        channels: state.channels,
        plugins: state.plugins,
        settings: state.settings,
        currentSessionId: state.currentSessionId
    };
    try {
        localStorage.setItem(ODYSSEIA_LS_KEY, JSON.stringify(config));
    } catch (e) {
        console.error('Save config to localStorage failed', e);
    }

    // 2. sessions / logs 持久化到 IndexedDB (包含所有用户输入、AI 输出以及文件数据等)
    try {
        await idbSet('sessions', state.sessions);
        await idbSet('logs', state.logs);
    } catch (e) {
        console.error('Save state to IndexedDB failed', e);
    }
}

// ===== utils.js =====
// 工具函数

function toggleSidebar(side) {
    const app = document.getElementById('app-layout');
    if (side === 'close-all') {
        app.classList.remove('show-left', 'show-right');
    } else if (side === 'left') {
        app.classList.toggle('show-left');
        app.classList.remove('show-right');
    } else if (side === 'right') {
        app.classList.toggle('show-right');
        app.classList.remove('show-left');
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function copyText(text) {
    navigator.clipboard.writeText(text).then(() => {
        const toast = document.createElement('div');
        toast.className = "fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-surface-900 text-white px-3 py-1 rounded text-xs z-50";
        toast.textContent = "Copied";
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 1500);
    });
}

// ===== api.js =====
// 网络请求与消息发送逻辑

let tempFileData = null;

// 当前是否有模型在生成中
let isGenerating = false;
// 用于中断当前请求的 AbortController
let currentAbortController = null;

function updateSendButtonState() {
    const btn = document.getElementById('send-btn');
    if (!btn) return;
    const icon = btn.querySelector('.material-symbols-outlined');
    if (!icon) return;

    if (isGenerating) {
        btn.title = '停止生成';
        icon.textContent = 'stop';
    } else {
        btn.title = '发送';
        icon.textContent = 'arrow_upward';
    }
}

function stopGeneration() {
    if (currentAbortController) {
        currentAbortController.abort();
    }
}

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
    // 如果当前正在生成，则此按钮行为为“停止生成”
    if (isGenerating) {
        stopGeneration();
        return;
    }

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
    // 统一在此处标记为生成中，无论是正常发送还是“重新生成”
    isGenerating = true;
    updateSendButtonState();

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
        currentAbortController = new AbortController();

        const response = await fetch(requestData.url, {
            method: requestData.method,
            headers: requestData.headers,
            body: requestData.body,
            signal: currentAbortController.signal
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        document.getElementById(`msg-loading-${assistantMsgIndex}`).remove();

        let aiContent = '';
        const parser = new Function('chunk', 'context', plugin.resScript);
        const parserContext = { raw: '' };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            rawResponseText += chunk;
            parserContext.raw = rawResponseText;

            if (typeof window !== 'undefined' && window.__ODYSSEIA_DEBUG_STREAM__) {
                console.log('[generateResponse] new chunk:', chunk);
            }

            try {
                const parsedFragment = parser(chunk, parserContext);
                if (typeof window !== 'undefined' && window.__ODYSSEIA_DEBUG_STREAM__) {
                    console.log('[generateResponse] parsedFragment:', parsedFragment);
                }
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
        // 对用户中断的情况单独处理文案
        if (e.name === 'AbortError') {
            session.messages[assistantMsgIndex].content = session.messages[assistantMsgIndex].content || '_已停止生成_';
            session.messages[assistantMsgIndex].waiting = false;
            saveState();
            renderChat();
        } else {
            handleError(session, assistantMsgIndex, `Network Error: ${e.message}`);
        }

        addLog({
            timestamp: Date.now(),
            status: 'error',
            error: e.message,
            request: requestData,
            responseRaw: rawResponseText
        }, assistantMsgIndex);
    } finally {
        isGenerating = false;
        currentAbortController = null;
        updateSendButtonState();
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

// 重新发送某条「输入」消息
function retryUserMessage(index) {
    const currentSession = state.sessions.find(s => s.id === state.currentSessionId);
    if (!currentSession) return;

    const msg = currentSession.messages[index];
    if (!msg || msg.role !== 'user') return;

    const channelId = document.getElementById('channel-select').value;
    const model = document.getElementById('model-select').value;

    if (!channelId || !model) {
        alert('请先配置并选择 API 渠道和模型');
        openSettings();
        return;
    }

    // 保留到当前这条 user 消息，之后的回复及后续对话全部丢弃
    currentSession.messages = currentSession.messages.slice(0, index + 1);
    saveState();
    renderChat();

    const fileData = msg.fileData || null;
    generateResponse(currentSession, channelId, model, fileData);
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
    // 持久化日志到 IndexedDB
    saveState();
    renderLogs();
}

// ===== ui.js =====
// UI 渲染与交互

async function init() {
    await loadState();
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

    // 初始化发送/停止按钮状态
    updateSendButtonState();

    // 点击主内容区域时，如果日志栏是打开状态则自动隐藏
    const appLayout = document.getElementById('app-layout');
    const mainArea = document.querySelector('main');
    if (appLayout && mainArea) {
        mainArea.addEventListener('click', (e) => {
            // 如果点击的是任何“日志开关”按钮，则不处理
            if (e.target && typeof e.target.closest === 'function' && e.target.closest('[data-log-toggle="true"]')) {
                return;
            }
            if (appLayout.classList.contains('show-right')) {
                appLayout.classList.remove('show-right');
            }
        });
    }
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
    if (e) e.stopPropagation();
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
async function renderChat(options = {}) {
    const container = document.getElementById('messages-list');
    const emptyState = document.getElementById('empty-state');
    const currentSession = state.sessions.find(s => s.id === state.currentSessionId);
    const scrollArea = document.getElementById('chat-container');

    const preserveScroll = options.preserveScroll;
    const prevScrollTop = scrollArea ? scrollArea.scrollTop : 0;
    const prevScrollHeight = scrollArea ? scrollArea.scrollHeight : 0;

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

        // 普通展示内容（非编辑态）
        const displayContentHtml = isUser
            ? `<div class="whitespace-pre-wrap">${escapeHtml(msg.content)}</div>`
            : renderMarkdown(msg.content);

        let fileHtml = '';
        if (msg.fileData) {
            fileHtml = `<div class="mb-2 p-2 bg-surface-50 border border-surface-200 rounded text-xs flex items-center gap-2 text-surface-800">
                <span class="material-symbols-outlined text-[16px]">image</span>
                <span>Attachment included</span>
            </div>`;
        }

        // 编辑态内容：在气泡内部显示 textarea + 保存/取消
        let innerContentHtml;
        if (msg.editing) {
            innerContentHtml = `
                ${fileHtml}
                <textarea
                    id="edit-area-${i}"
                    class="w-full bg-white border border-surface-300 rounded-sm p-2 text-sm outline-none resize-none max-h-48"
                    oninput="onEditInputChange(${i}, this.value)"
                    rows="3"
                ></textarea>
                <div class="mt-2 flex justify-end gap-2 text-[11px] text-surface-500">
                    <button onclick="cancelMessageEdit(${i})" class="px-2 py-1 rounded-sm border border-surface-300 hover:bg-surface-100">取消</button>
                    <button onclick="saveMessageEdit(${i})" class="px-2 py-1 rounded-sm bg-surface-900 text-white hover:bg-surface-800">保存</button>
                </div>
            `;
        } else {
            innerContentHtml = `
                ${fileHtml}
                <div class="prose prose-zinc text-sm">${displayContentHtml}</div>
            `;
        }

        // 操作按钮区
        let actionsHtml = '';
        if (!msg.editing) {
            actionsHtml = `
                <button onclick="copyText('${escapeHtml(msg.content.replace(/'/g, "\\'"))}')" title="复制" class="hover:text-surface-800">
                    <span class="material-symbols-outlined text-[14px]">content_copy</span>
                </button>
                ${
                    isUser
                        ? `<button onclick="retryUserMessage(${i})" title="重新发送" class="hover:text-surface-800">
                                <span class="material-symbols-outlined text-[14px]">refresh</span>
                           </button>`
                        : `<button onclick="regenerateMessage(${i})" title="重新生成" class="hover:text-surface-800">
                                <span class="material-symbols-outlined text-[14px]">refresh</span>
                           </button>`
                }
                <button onclick="editMessage(${i})" title="编辑" class="hover:text-surface-800">
                    <span class="material-symbols-outlined text-[14px]">edit</span>
                </button>
                ${!isUser ? `<button onclick="viewLogForMessage(${i})" title="查看日志" class="hover:text-surface-800"><span class="material-symbols-outlined text-[14px]">code</span></button>` : ''}
            `;
        }

        div.innerHTML = `
            <div class="max-w-[85%] lg:max-w-[75%] group relative">
                <div class="${isUser ? 'bg-surface-200 text-surface-900' : 'bg-white text-surface-900'} px-4 py-3 rounded-lg border ${isUser ? 'border-transparent' : 'border-transparent'}">
                    ${innerContentHtml}
                </div>
                <div class="absolute ${isUser ? 'right-0 -bottom-6' : 'left-0 -bottom-6'} opacity-0 group-hover:opacity-100 transition-opacity flex gap-2 text-surface-400">
                    ${actionsHtml}
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

    if (scrollArea) {
        if (preserveScroll) {
            const newHeight = scrollArea.scrollHeight;
            const delta = newHeight - prevScrollHeight;
            scrollArea.scrollTop = prevScrollTop + delta;
        } else {
            scrollArea.scrollTop = scrollArea.scrollHeight;
        }
    }
}

function renderMarkdown(text) {
    const renderer = new marked.Renderer();
    renderer.code = function(code, language) {
        if (language === 'mermaid') {
            return `<div class="mermaid">${code}</div>`;
        }
        return `<pre><code class="language-${language}">${code}</code></pre>`;
    };

    // 支持形如 ![image](data:image/png;base64,...) 的内联图片，并继续做 XSS 防护
    const dirtyHtml = marked.parse(text || '', { renderer: renderer });
    return DOMPurify.sanitize(dirtyHtml, {
        // 显式允许在 <img> 标签上使用 data: URI（其它标签仍然禁止）
        ADD_DATA_URI_TAGS: ['img']
    });
}

// Settings & Channels
function openSettings() {
    document.getElementById('settings-modal').classList.add('active');
    renderChannelsSettings();
    renderPluginSettings();
}

async function closeSettings() {
    document.getElementById('settings-modal').classList.remove('active');
    await loadState();
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
        case 'openai-image':
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
    // 同步清空持久化存储中的日志
    saveState();
    renderLogs();
}

// ===== 消息编辑相关 =====

function getCurrentSession() {
    return state.sessions.find(s => s.id === state.currentSessionId);
}

function editMessage(index) {
    const session = getCurrentSession();
    if (!session) return;

    const msg = session.messages[index];
    if (!msg) return;

    msg.editing = true;
    msg.editingContent = msg.content;
    saveState();
    renderChat({ preserveScroll: true });

    // 将原始内容填入 textarea 并聚焦
    setTimeout(() => {
        const textarea = document.getElementById(`edit-area-${index}`);
        if (textarea) {
            textarea.value = msg.editingContent || '';
            textarea.focus();
            // 光标移到末尾
            const len = textarea.value.length;
            textarea.setSelectionRange(len, len);
        }
    }, 0);
}

function onEditInputChange(index, value) {
    const session = getCurrentSession();
    if (!session) return;
    const msg = session.messages[index];
    if (!msg || !msg.editing) return;
    msg.editingContent = value;
}

function saveMessageEdit(index) {
    const session = getCurrentSession();
    if (!session) return;
    const msg = session.messages[index];
    if (!msg || !msg.editing) return;

    if (typeof msg.editingContent === 'string') {
        msg.content = msg.editingContent;
    }

    msg.editing = false;
    delete msg.editingContent;
    saveState();
    renderChat({ preserveScroll: true });
}

function cancelMessageEdit(index) {
    const session = getCurrentSession();
    if (!session) return;
    const msg = session.messages[index];
    if (!msg || !msg.editing) return;

    msg.editing = false;
    delete msg.editingContent;
    saveState();
    renderChat({ preserveScroll: true });
}

// ===== main.js =====
// 入口：只负责初始化

window.onload = init;

// ===== Expose functions to window for inline handlers =====
window.toggleSidebar = toggleSidebar;
window.createNewSession = createNewSession;
window.deleteSession = deleteSession;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.switchSettingsTab = switchSettingsTab;
window.editChannel = editChannel;
window.saveChannel = saveChannel;
window.deleteChannel = deleteChannel;
window.createNewPlugin = createNewPlugin;
window.editPlugin = editPlugin;
window.savePlugin = savePlugin;
window.closePluginEditor = closePluginEditor;
window.deletePlugin = deletePlugin;
window.renderChannelOptions = renderChannelOptions;
window.loadModelsForChannel = loadModelsForChannel;
window.clearLogs = clearLogs;
window.viewLogForMessage = viewLogForMessage;
window.viewLogDetail = viewLogDetail;
window.handleFileUpload = handleFileUpload;
window.clearFile = clearFile;
window.handleInputKey = handleInputKey;
window.sendMessage = sendMessage;
window.fetchModels = fetchModels;
window.copyText = copyText;
window.renderLogs = renderLogs;
window.updateUrlPreview = updateUrlPreview;
window.retryUserMessage = retryUserMessage;
window.regenerateMessage = regenerateMessage;
window.editMessage = editMessage;
window.onEditInputChange = onEditInputChange;
window.saveMessageEdit = saveMessageEdit;
window.cancelMessageEdit = cancelMessageEdit;


