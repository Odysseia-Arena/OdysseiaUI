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
            // Chunk is a string of data
            const lines = chunk.split('\\n');
            let text = '';
            
            for (const line of lines) {
                const l = line.trim();
                if (!l || l === 'data: [DONE]') continue;
                if (l.startsWith('data: ')) {
                    try {
                        const json = JSON.parse(l.substring(6));
                        if (json.choices && json.choices[0].delta && json.choices[0].delta.content) {
                            text += json.choices[0].delta.content;
                        }
                    } catch (e) { console.error('Parse error', e); }
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
            try {
                const clean = chunk.replace(/^,/, '').trim();
                const json = JSON.parse(clean);
                if(json.candidates && json.candidates[0].content) {
                    text += json.candidates[0].content.parts[0].text;
                }
            } catch(e) {
            }
            return text;
        `
    }
];


