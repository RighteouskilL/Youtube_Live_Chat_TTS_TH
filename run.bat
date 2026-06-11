@echo off
echo Starting YouTube Live Chat TTS Server...
cd /d "%~dp0"
call venv\Scripts\activate.bat
python main.py
