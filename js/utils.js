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


