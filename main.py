import asyncio
import base64
import json
import random
import time
import re
import emoji
import threading
from typing import Dict, List, Optional
import os
import pystray
from PIL import Image, ImageDraw

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
import pytchat
import edge_tts

app = FastAPI()

# สร้างโฟลเดอร์ static อัตโนมัติถ้ายังไม่มี
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

SETTINGS_FILE = "settings.json"

class AppSettings:
    def __init__(self):
        self.max_length = 150
        self.filter_profanity = True
        self.read_format = "{name} บอกว่า {message}"
        self.aliases = {}
        self.profanity_list = ["ควย", "เหี้ย", "สัส", "แม่ง", "เย็ด", "หี", "แตด", "พ่อง", "มึง", "กู", "ค.ย", "ค_ย"]
        self.active_video_id = ""
        self.load()

    def load(self):
        if os.path.exists(SETTINGS_FILE):
            try:
                with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self.max_length = data.get("max_length", self.max_length)
                    self.filter_profanity = data.get("filter_profanity", self.filter_profanity)
                    self.read_format = data.get("read_format", self.read_format)
                    self.aliases = data.get("aliases", self.aliases)
                    self.profanity_list = data.get("profanity_list", self.profanity_list)
            except Exception as e:
                print(f"Error loading settings: {e}")

    def save(self):
        data = {
            "max_length": self.max_length,
            "filter_profanity": self.filter_profanity,
            "read_format": self.read_format,
            "aliases": self.aliases,
            "profanity_list": self.profanity_list
        }
        try:
            with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=4)
        except Exception as e:
            print(f"Error saving settings: {e}")
        
settings = AppSettings()

class SettingsUpdate(BaseModel):
    max_length: Optional[int] = None
    filter_profanity: Optional[bool] = None
    read_format: Optional[str] = None
    aliases: Optional[Dict[str, str]] = None
    profanity_list: Optional[List[str]] = None

# จัดการ WebSocket สำหรับส่งข้อมูลไปหน้าเว็บ
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except:
                pass

    async def broadcast_text(self, text: str, sender: WebSocket = None):
        for connection in self.active_connections:
            if connection != sender:
                try:
                    await connection.send_text(text)
                except:
                    pass

manager = ConnectionManager()

chat_task = None
chat_reader = None

recent_messages = []
FLOOD_TIME_WINDOW = 15 # จดจำข้อความย้อนหลัง 15 วินาทีเพื่อกันสแปมรัวๆ

def clean_message(msg: str) -> str:
    # ลบลิงก์
    msg = re.sub(r'http\S+', '', msg)
    # ลบอีโมติคอนรูปแบบ :name: (เช่น :pushpin:)
    msg = re.sub(r':\w+:', '', msg)
    # ลบ Unicode Emoji ทุกรูปแบบเด็ดขาด
    msg = emoji.replace_emoji(msg, replace='')
    return msg.strip()

def apply_profanity_filter(msg: str) -> str:
    if not settings.filter_profanity:
        return msg
    for bad_word in settings.profanity_list:
        # แทนที่คำหยาบด้วยคำว่า "ตื๊ด" เพื่อให้ TTS อ่านออกเสียงคล้ายเสียงเซ็นเซอร์
        msg = msg.replace(bad_word, "ตื๊ด")
    return msg

def compress_repeated_chars(text: str) -> str:
    char_names = {
        'ว': 'ว แหวน', 'ก': 'ก ไก่', 'ห': 'ห หีบ', 'ย': 'ย ยักษ์',
        'ง': 'ง งู', 'อ': 'อ อ่าง', 'ม': 'ม ม้า', 'ล': 'ล ลิง',
        'บ': 'บ ใบไม้', 'ส': 'ส เสือ', 'ร': 'ร เรือ', 'พ': 'พ พาน',
        'ช': 'ช ช้าง', 'น': 'น หนู', 'ด': 'ด เด็ก', 'ต': 'ต เต่า',
        'ข': 'ข ไข่', 'ค': 'ค ควาย', 'จ': 'จ จาน', 'ท': 'ท ทหาร',
        'ป': 'ป ปลา', 'ผ': 'ผ ผึ้ง', 'ฝ': 'ฝ ฝา', 'ฟ': 'ฟ ฟัน',
        'า': 'สระอา', 'เ': 'สระเอ', 'แ': 'สระแอ', 'โ': 'สระโอ',
        'ุ': 'สระอุ', 'ู': 'สระอู', 'ิ': 'สระอิ', 'ี': 'สระอี',
        'ๆ': 'ไม้ยมก',
    }
    def replacer(match):
        char = match.group(1)
        name = char_names.get(char, char)
        if char == '5':
            return '555 เลข 5 ล้านตัว '
        elif char.isdigit():
            return f'{char}{char}{char} เลข {name} ล้านตัว '
        else:
            return f'{char} {name} ล้านตัว '
    # แปลงตัวอักษรที่ซ้ำกัน 10 ตัวขึ้นไป
    return re.sub(r'(.)\1{9,}', replacer, text)

async def generate_tts(text: str) -> str:
    # สลับเสียงผู้ชายกับผู้หญิง
    voice = random.choice(["th-TH-PremwadeeNeural", "th-TH-NiwatNeural"])
    communicate = edge_tts.Communicate(text, voice)
    audio_data = b""
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_data += chunk["data"]
    # แปลงเป็น Base64 เพื่อส่งตรงผ่าน Websocket ไปให้เว็บเล่น (ไม่ต้องเซฟไฟล์ลงเครื่อง)
    return base64.b64encode(audio_data).decode('utf-8')

async def process_chat():
    global chat_reader, recent_messages
    try:
        while chat_reader and chat_reader.is_alive():
            for c in chat_reader.get().sync_items():
                msg_text = c.message
                author = c.author.name
                
                # 1. ข้ามคำสั่งบอท
                if msg_text.startswith("!"):
                    continue
                    
                msg_text = clean_message(msg_text)
                if not msg_text:
                    continue # ข้ามถ้าข้อความว่าง (เช่นมีแต่อีโมติคอน)

                # บีบอัดตัวอักษรที่พิมพ์รัวๆ
                msg_text = compress_repeated_chars(msg_text)

                # 2. ป้องกัน Flood (ถ้ามีคนพิมพ์ข้อความเดิมซ้ำๆ ในเวลาติดๆ กัน จะอ่านแค่ครั้งเดียว)
                current_time = time.time()
                # ล้างข้อความที่เก่าเกินเวลาที่ตั้งไว้ออก
                recent_messages = [m for m in recent_messages if current_time - m['time'] < FLOOD_TIME_WINDOW]
                
                is_flood = any(m['text'] == msg_text for m in recent_messages)
                if is_flood:
                    continue # ข้ามข้อความนี้ไปเลย เพราะซ้ำ
                    
                recent_messages.append({'text': msg_text, 'time': current_time})

                # 3. จัดการเรื่องตั้งชื่อใหม่ (Alias)
                display_name = settings.aliases.get(author, author)

                # 4. ตัดข้อความถ้ามันยาวเกินไป
                if len(msg_text) > settings.max_length:
                    msg_text = msg_text[:settings.max_length] + "..."

                # 5. กรองคำหยาบ
                msg_text = apply_profanity_filter(msg_text)

                # 6. จัดรูปแบบการอ่าน
                read_text = settings.read_format.replace("{name}", display_name).replace("{message}", msg_text)
                if not read_text.strip():
                    continue
                
                # 7. สร้างเสียง TTS
                try:
                    audio_b64 = await generate_tts(read_text)
                    
                    # 8. ส่งข้อมูลไปยัง Frontend
                    await manager.broadcast({
                        "type": "chat",
                        "id": c.id,
                        "author": author,
                        "display_name": display_name,
                        "message": c.message, # ส่งข้อความเดิมไปแสดงผลบนหน้าจอ
                        "read_text": read_text,
                        "audio_b64": audio_b64,
                        "thumbnail": c.author.imageUrl
                    })
                except Exception as e:
                    print(f"TTS Error: {e}")

            await asyncio.sleep(1)
        
        # แจ้งเตือนเมื่อหลุดการเชื่อมต่อหรือไลฟ์จบ
        await manager.broadcast({"type": "status", "status": "stopped", "message": "Live Ended"})
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"Chat Loop Error: {e}")
        await manager.broadcast({"type": "status", "status": "error", "message": str(e)})

class StartRequest(BaseModel):
    video_id: str

@app.post("/api/start")
async def start_chat(req: StartRequest):
    global chat_task, chat_reader
    settings.active_video_id = req.video_id
    if chat_task:
        if chat_reader:
            chat_reader.terminate()
        chat_task.cancel()
    
    try:
        # กำหนด interruptable=False เพื่อป้องกัน error: signal only works in main thread
        chat_reader = pytchat.create(video_id=req.video_id, interruptable=False)
        chat_task = asyncio.create_task(process_chat())
        return {"status": "started", "video_id": req.video_id}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/stop")
async def stop_chat():
    global chat_task, chat_reader
    settings.active_video_id = ""
    if chat_reader:
        chat_reader.terminate()
    if chat_task:
        chat_task.cancel()
    return {"status": "stopped"}

@app.get("/api/settings")
async def get_settings():
    return {
        "max_length": settings.max_length,
        "filter_profanity": settings.filter_profanity,
        "read_format": settings.read_format,
        "aliases": settings.aliases,
        "active_video_id": settings.active_video_id,
        "profanity_list": settings.profanity_list
    }

@app.post("/api/settings")
async def update_settings(update: SettingsUpdate):
    if update.max_length is not None:
        settings.max_length = update.max_length
    if update.filter_profanity is not None:
        settings.filter_profanity = update.filter_profanity
    if update.read_format is not None:
        settings.read_format = update.read_format
    if update.aliases is not None:
        settings.aliases = update.aliases
    if update.profanity_list is not None:
        settings.profanity_list = update.profanity_list
        
    settings.save()
    return {"status": "success"}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            await manager.broadcast_text(data, sender=websocket)
    except WebSocketDisconnect:
        manager.disconnect(websocket)

@app.get("/")
async def get_index():
    with open("static/index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())

if __name__ == "__main__":
    import uvicorn
    import webview
    
    window = None

    def run_server():
        config = uvicorn.Config(app, host="127.0.0.1", port=8000, log_level="error")
        server = uvicorn.Server(config)
        # ปิดการตั้งค่า Signal เพื่อให้ Uvicorn รันใน Background Thread ได้โดยไม่ Error
        server.install_signal_handlers = lambda: None
        server.run()

    def create_image():
        # สร้างภาพพื้นฐานสำหรับไอคอน Tray
        image = Image.new('RGB', (64, 64), color=(30, 41, 59))
        d = ImageDraw.Draw(image)
        d.text((15, 25), "TTS", fill=(255, 255, 255))
        return image

    def on_quit(icon, item):
        icon.stop()
        if window:
            window.destroy()
        os._exit(0)
        
    def show_window(icon, item):
        if window:
            window.show()

    # ตั้งค่า System Tray ให้เปิด/ปิดโปรแกรมได้
    icon = pystray.Icon("YT-Chat-TTS", create_image(), "YouTube Live Chat TTS", menu=pystray.Menu(
        pystray.MenuItem("Show UI", show_window),
        pystray.MenuItem("Quit", on_quit)
    ))

    # รัน System Tray และ Uvicorn ใน Background Thread
    icon.run_detached()
    t = threading.Thread(target=run_server, daemon=True)
    t.start()

    print("Server is starting in Desktop App Mode...")
    time.sleep(1) # รอ Server Start
    
    def on_closing():
        # เมื่อผู้ใช้กดกากบาทปิดหน้าต่าง (X) จะซ่อน UI แทนการปิดโปรแกรมทั้งหมด
        # เสียงจะยังคงอ่านต่อไปเบื้องหลัง
        window.hide()
        return False
        
    # สร้างหน้าต่างโปรแกรมแยก (Native Desktop App)
    window = webview.create_window(
        'YouTube Live Chat TTS', 
        'http://127.0.0.1:8000',
        width=1100,
        height=750,
        background_color='#0f172a'
    )
    window.events.closing += on_closing
    
    # รันหน้าต่าง WebView (ต้องรันใน Main Thread)
    webview.start()
    
    # กรณีหน้าต่างพังหรือปิดลง
    os._exit(0)
