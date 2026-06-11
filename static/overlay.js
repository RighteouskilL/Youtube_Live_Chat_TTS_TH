let ws;
const container = document.getElementById('overlay-container');

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    
    ws.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            
            if (payload.type === 'playing_now') {
                showOverlay(payload.data);
            } else if (payload.type === 'playing_finished') {
                hideOverlay(payload.id);
            }
        } catch (e) {
            // Ignore non-json messages (like raw chat objects from backend broadcast if any)
            if (event.data.includes("playing_now") || event.data.includes("playing_finished")) {
                console.error("Error parsing payload", e);
            }
        }
    };
    
    ws.onclose = () => {
        setTimeout(connectWebSocket, 3000);
    };
}

function showOverlay(data) {
    // Clear previous if any to prevent clutter
    if (container.children.length > 2) {
        container.children[0].remove();
    }
    
    const msgDiv = document.createElement('div');
    msgDiv.id = `msg-${data.id}`;
    msgDiv.className = 'glass-panel rounded-xl p-4 flex space-x-4 items-start slide-in mb-4';
    
    msgDiv.innerHTML = `
        <img src="${data.thumbnail}" class="w-12 h-12 rounded-full border-2 border-slate-600 flex-shrink-0 object-cover shadow-lg">
        <div class="flex-1 min-w-0">
            <p class="text-base font-bold text-blue-300 truncate tracking-wide">${data.display_name}</p>
            <p class="text-lg text-slate-100 mt-1 break-words leading-tight">${data.message}</p>
        </div>
    `;
    
    container.appendChild(msgDiv);
}

function hideOverlay(id) {
    if (id === 'all') {
        Array.from(container.children).forEach(child => {
            child.classList.remove('slide-in');
            child.classList.add('slide-out');
            setTimeout(() => child.remove(), 500);
        });
        return;
    }

    const msgDiv = document.getElementById(`msg-${id}`);
    if (msgDiv) {
        msgDiv.classList.remove('slide-in');
        msgDiv.classList.add('slide-out');
        setTimeout(() => msgDiv.remove(), 500);
    }
}

// Init
window.onload = () => {
    connectWebSocket();
};
