let ws;
let audioQueue = [];
let isPlaying = false;
let isPaused = false;
let settings = {};
let aliases = {};

const player = document.getElementById('tts-player');
const chatBox = document.getElementById('chat-box');
const queueCountEl = document.getElementById('queue-count');

// Init
window.onload = async () => {
    await loadSettings();
    await initAudioDevices();
    connectWebSocket();
};

async function initAudioDevices() {
    try {
        // ดึงรายชื่ออุปกรณ์เสียง (ไม่ขอสิทธิ์ไมค์แล้วเพื่อความเป็นส่วนตัว)
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioOutputs = devices.filter(device => device.kind === 'audiooutput');
        
        const select = document.getElementById('audio-output-select');
        select.innerHTML = '';
        
        audioOutputs.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `Device ${select.length + 1}`;
            select.appendChild(option);
        });
        
        select.addEventListener('change', async (e) => {
            const deviceId = e.target.value;
            try {
                if (typeof player.setSinkId !== 'undefined') {
                    await player.setSinkId(deviceId);
                    console.log('Set audio output to', deviceId);
                } else {
                    console.warn('Browser does not support setSinkId.');
                }
            } catch (err) {
                console.error('Error setting audio output:', err);
                alert('ไม่สามารถเปลี่ยนช่องเสียงได้ โปรดตรวจสอบสิทธิ์เบราว์เซอร์');
            }
        });
        
    } catch (err) {
        console.warn('Could not enumerate audio devices (Need permission).', err);
    }
}

async function loadSettings() {
    try {
        const res = await fetch('/api/settings');
        settings = await res.json();
        
        document.getElementById('video-id-input').value = settings.active_video_id;
        document.getElementById('format-input').value = settings.read_format;
        document.getElementById('max-length-input').value = settings.max_length;
        document.getElementById('profanity-toggle').checked = settings.filter_profanity;
        
        aliases = settings.aliases || {};
        renderAliasList();
        
        if (settings.active_video_id) {
            updateUIStatus('started');
        } else {
            updateUIStatus('stopped');
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

async function saveSettings() {
    const format = document.getElementById('format-input').value;
    const maxLen = parseInt(document.getElementById('max-length-input').value);
    const profanity = document.getElementById('profanity-toggle').checked;
    
    await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            read_format: format,
            max_length: maxLen,
            filter_profanity: profanity,
            aliases: aliases
        })
    });
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'chat') {
            addMessageToUI(data);
            enqueueAudio(data);
        } else if (data.type === 'status') {
            console.log('Status update:', data);
            if (data.status === 'stopped') {
                updateUIStatus('stopped');
                document.getElementById('btn-start').disabled = false;
                document.getElementById('btn-stop').disabled = true;
            }
        }
    };
    
    ws.onclose = () => {
        setTimeout(connectWebSocket, 3000);
    };
}

function addMessageToUI(data) {
    // ลบข้อความ "รอการเชื่อมต่อ..." ถ้ามี
    const initialText = document.getElementById('empty-queue-text');
    if (initialText) initialText.style.display = 'none';
    
    const msgDiv = document.createElement('div');
    msgDiv.id = `msg-${data.id}`;
    msgDiv.className = 'chat-message fade-in bg-slate-800 rounded-lg p-3 flex space-x-3 items-start border border-slate-700';
    
    msgDiv.innerHTML = `
        <img src="${data.thumbnail}" class="w-8 h-8 rounded-full border border-slate-600 mt-1">
        <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-blue-300 truncate cursor-context-menu hover:text-blue-100 transition-colors" title="คลิกขวาเพื่อตั้งชื่อเล่น">${data.display_name}</p>
            <p class="text-sm text-slate-200 mt-1 break-words">${data.message}</p>
        </div>
    `;
    
    // ตั้งค่าคลิกขวาเปลี่ยนชื่อ
    const nameEl = msgDiv.querySelector('p.font-semibold');
    if (nameEl) {
        nameEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const currentAlias = aliases[data.author] || "";
            const newAlias = prompt(`ตั้งชื่อเล่นใหม่สำหรับช่อง:\n${data.author}\n\n(เว้นว่างไว้แล้วกด OK เพื่อลบชื่อเล่นเดิม)`, currentAlias);
            if (newAlias !== null) {
                if (newAlias.trim() === "") {
                    removeAlias(data.author);
                } else {
                    addAliasFromRightClick(data.author, newAlias.trim());
                }
            }
        });
    }
    
    chatBox.appendChild(msgDiv);
    // ด้วย flex-col-reverse ข้อความใหม่จะอยู่ด้านบนสุด และดันข้อความเก่าลงล่าง
}

function enqueueAudio(data) {
    audioQueue.push({
        id: data.id,
        b64: data.audio_b64,
        author: data.author,
        display_name: data.display_name,
        message: data.message,
        thumbnail: data.thumbnail
    });
    updateQueueCount();
    
    if (!isPlaying && !isPaused) {
        playNext();
    }
}

function updateQueueCount() {
    queueCountEl.innerText = audioQueue.length;
}

async function playNext() {
    if (audioQueue.length === 0 || isPaused) {
        isPlaying = false;
        return;
    }
    
    isPlaying = true;
    const current = audioQueue.shift();
    updateQueueCount();
    
    const msgDiv = document.getElementById(`msg-${current.id}`);
    const nowPlayingBox = document.getElementById('now-playing-box');
    const placeholder = document.getElementById('now-playing-placeholder');
    
    if (placeholder) placeholder.style.display = 'none';
    
    if (msgDiv && msgDiv.parentElement === chatBox) {
        // แอนิเมชันให้ข้อความในคิวหดตัวลง
        const h = msgDiv.offsetHeight;
        msgDiv.style.height = h + 'px';
        msgDiv.style.overflow = 'hidden';
        void msgDiv.offsetHeight;
        
        msgDiv.style.transition = 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
        msgDiv.style.opacity = '0';
        msgDiv.style.transform = 'scale(0.95)';
        msgDiv.style.height = '0px';
        msgDiv.style.paddingTop = '0px';
        msgDiv.style.paddingBottom = '0px';
        msgDiv.style.borderWidth = '0px';
        msgDiv.style.setProperty('margin-top', '0px', 'important');
        msgDiv.style.setProperty('margin-bottom', '0px', 'important');
        
        setTimeout(() => msgDiv.remove(), 400);
        
        // ก๊อปปี้ไปใส่ในช่อง Now Playing
        const cloneDiv = msgDiv.cloneNode(true);
        cloneDiv.id = `playing-${current.id}`;
        // รีเซ็ต Style เพื่อทำ Animation การเข้า
        cloneDiv.style = '';
        cloneDiv.className = 'chat-message bg-slate-800/90 rounded-lg p-3 flex space-x-3 items-start border-l-4 border-l-blue-500 shadow-md shadow-blue-500/20';
        cloneDiv.style.opacity = '0';
        cloneDiv.style.transform = 'translateY(-10px)';
        cloneDiv.style.transition = 'all 0.4s ease-out';
        
        // ตั้งค่าคลิกขวาให้ตัว clone ด้วย
        const cloneNameEl = cloneDiv.querySelector('p.font-semibold');
        if (cloneNameEl) {
            cloneNameEl.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const currentAlias = aliases[current.author] || "";
                const newAlias = prompt(`ตั้งชื่อเล่นใหม่สำหรับช่อง:\n${current.author}\n\n(เว้นว่างไว้แล้วกด OK เพื่อลบชื่อเล่นเดิม)`, currentAlias);
                if (newAlias !== null) {
                    if (newAlias.trim() === "") {
                        removeAlias(current.author);
                    } else {
                        addAliasFromRightClick(current.author, newAlias.trim());
                    }
                }
            });
        }
        
        // ลบของเก่าที่อาจค้างอยู่ใน Now Playing
        Array.from(nowPlayingBox.children).forEach(child => {
            if (child.id !== 'now-playing-placeholder') child.remove();
        });
        
        nowPlayingBox.appendChild(cloneDiv);
        
        // Trigger entrance animation
        requestAnimationFrame(() => {
            cloneDiv.style.opacity = '1';
            cloneDiv.style.transform = 'translateY(0)';
        });
    }
    
    // แจ้งหน้า Overlay ให้แสดงข้อความนี้
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "playing_now",
            data: {
                id: current.id,
                author: current.author,
                display_name: current.display_name,
                message: current.message,
                thumbnail: current.thumbnail
            }
        }));
    }
    
    // Play audio
    player.src = 'data:audio/mp3;base64,' + current.b64;
    try {
        await player.play();
    } catch (e) {
        console.error('Playback error:', e);
        // Skip if error
        finishCurrent(current.id);
    }
    
    player.onended = () => finishCurrent(current.id);
}

function finishCurrent(id) {
    // แจ้งหน้า Overlay ให้ซ่อนข้อความ
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "playing_finished",
            id: id
        }));
    }

    const cloneDiv = document.getElementById(`playing-${id}`);
    if (cloneDiv) {
        cloneDiv.style.transition = 'all 0.5s ease-in';
        cloneDiv.style.opacity = '0';
        cloneDiv.style.transform = 'translateY(15px) scale(0.95)';
        
        setTimeout(() => {
            cloneDiv.remove();
            if (audioQueue.length === 0 && !isPlaying) {
                const placeholder = document.getElementById('now-playing-placeholder');
                if (placeholder) placeholder.style.display = 'block';
            }
        }, 500);
    } else {
        if (audioQueue.length === 0 && !isPlaying) {
            const placeholder = document.getElementById('now-playing-placeholder');
            if (placeholder) placeholder.style.display = 'block';
        }
    }
    playNext();
}

function togglePause() {
    isPaused = !isPaused;
    const btn = document.getElementById('btn-pause');
    if (isPaused) {
        btn.innerHTML = '<i class="fa-solid fa-play mr-1"></i> อ่านต่อ';
        btn.classList.replace('bg-slate-700', 'bg-blue-600');
        player.pause();
    } else {
        btn.innerHTML = '<i class="fa-solid fa-pause mr-1"></i> พักการอ่าน';
        btn.classList.replace('bg-blue-600', 'bg-slate-700');
        if (isPlaying && player.src) {
            player.play();
        } else {
            playNext();
        }
    }
}

function clearQueue() {
    audioQueue = [];
    updateQueueCount();
    player.pause();
    isPlaying = false;
    
    const nowPlayingBox = document.getElementById('now-playing-box');
    if (nowPlayingBox) {
        Array.from(nowPlayingBox.children).forEach(child => {
            if (child.id !== 'now-playing-placeholder') child.remove();
        });
    }
    const placeholder = document.getElementById('now-playing-placeholder');
    if (placeholder) placeholder.style.display = 'block';
    
    // แจ้งหน้า Overlay ให้ซ่อนทั้งหมด
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "playing_finished",
            id: "all"
        }));
    }
}

async function startChat() {
    const videoId = document.getElementById('video-id-input').value.trim();
    if (!videoId) return alert('กรุณาใส่ Link หรือ Video ID');
    
    // เคลียร์แชทและคิวเก่าทิ้งทั้งหมดเมื่อเริ่มใหม่
    chatBox.innerHTML = `
        <div class="text-center text-slate-500 mt-10" id="empty-queue-text">
            <i class="fa-regular fa-comments text-4xl mb-3"></i>
            <p>รอการเชื่อมต่อ...</p>
        </div>
    `;
    clearQueue();
    
    const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_id: videoId })
    });
    const data = await res.json();
    
    if (data.status === 'started') {
        updateUIStatus('started');
    } else {
        alert('Error: ' + data.message);
    }
}

async function stopChat() {
    await fetch('/api/stop', { method: 'POST' });
    updateUIStatus('stopped');
}

function updateUIStatus(status) {
    const statusText = document.getElementById('conn-status');
    const btnStart = document.getElementById('btn-start');
    const btnStop = document.getElementById('btn-stop');
    
    if (status === 'started') {
        statusText.innerHTML = '<i class="fa-solid fa-circle text-green-500 mr-1 text-[8px]"></i>สถานะ: กำลังเชื่อมต่อ';
        btnStart.classList.add('opacity-50', 'cursor-not-allowed');
        btnStart.disabled = true;
        btnStop.classList.remove('opacity-50', 'cursor-not-allowed');
        btnStop.disabled = false;
    } else {
        statusText.innerHTML = '<i class="fa-solid fa-circle text-red-500 mr-1 text-[8px]"></i>สถานะ: หยุดการทำงาน';
        btnStart.classList.remove('opacity-50', 'cursor-not-allowed');
        btnStart.disabled = false;
        btnStop.classList.add('opacity-50', 'cursor-not-allowed');
        btnStop.disabled = true;
    }
}

// UI Toggle
function toggleSettings() {
    const panel = document.getElementById('settings-panel');
    const chatPanel = document.getElementById('chat-panel');
    
    if (panel.classList.contains('translate-x-full')) {
        panel.classList.remove('translate-x-full', 'hidden');
        chatPanel.classList.replace('w-full', 'w-2/3');
    } else {
        panel.classList.add('translate-x-full', 'hidden');
        chatPanel.classList.replace('w-2/3', 'w-full');
    }
}

// Alias Management
function renderAliasList() {
    const list = document.getElementById('alias-list');
    list.innerHTML = '';
    
    for (const [ytName, newName] of Object.entries(aliases)) {
        const item = document.createElement('div');
        item.className = 'flex justify-between items-center bg-slate-800 px-2 py-1 rounded text-xs';
        item.innerHTML = `
            <span class="truncate w-1/2 text-slate-300" title="${ytName}">${ytName}</span>
            <i class="fa-solid fa-arrow-right text-slate-500 text-[10px]"></i>
            <span class="truncate w-1/3 text-blue-300 text-right">${newName}</span>
            <button onclick="removeAlias('${ytName}')" class="text-red-400 hover:text-red-300 ml-2"><i class="fa-solid fa-xmark"></i></button>
        `;
        list.appendChild(item);
    }
}

function addAlias() {
    const ytName = document.getElementById('alias-yt-name').value.trim();
    const newName = document.getElementById('alias-new-name').value.trim();
    
    if (!ytName || !newName) return;
    
    aliases[ytName] = newName;
    document.getElementById('alias-yt-name').value = '';
    document.getElementById('alias-new-name').value = '';
    
    renderAliasList();
    saveSettings();
}

window.removeAlias = function(ytName) {
    delete aliases[ytName];
    renderAliasList();
    saveSettings();
}

function addAliasFromRightClick(ytName, newName) {
    aliases[ytName] = newName;
    renderAliasList();
    saveSettings();
}

window.changeVolume = function() {
    player.volume = document.getElementById('volume-slider').value;
}
