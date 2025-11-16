// 状态管理与持久化

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

function loadState() {
    try {
        const s = localStorage.getItem('odysseia_state');
        if (s) {
            const parsed = JSON.parse(s);
            state.sessions = parsed.sessions || [];
            state.channels = parsed.channels || [];
            state.plugins = parsed.plugins && parsed.plugins.length ? parsed.plugins : JSON.parse(JSON.stringify(DEFAULT_PLUGINS));
            state.currentSessionId = parsed.currentSessionId;
        } else {
            state.plugins = JSON.parse(JSON.stringify(DEFAULT_PLUGINS));
        }
        // Ensure builtin plugins exist
        DEFAULT_PLUGINS.forEach(dp => {
            if(!state.plugins.find(p => p.id === dp.id)) {
                state.plugins.push(JSON.parse(JSON.stringify(dp)));
            }
        });
    } catch (e) {
        console.error("State load failed", e);
        state.plugins = JSON.parse(JSON.stringify(DEFAULT_PLUGINS));
    }
}

function saveState() {
    localStorage.setItem('odysseia_state', JSON.stringify({
        sessions: state.sessions,
        channels: state.channels,
        plugins: state.plugins,
        currentSessionId: state.currentSessionId
    }));
}


