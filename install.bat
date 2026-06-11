@echo off
echo ==========================================
echo YouTube Chat TTS - Installation
echo ==========================================
echo.

IF NOT EXIST "venv" (
    echo Creating Python Virtual Environment...
    python -m venv venv
)

echo Activating Virtual Environment...
call venv\Scripts\activate

echo Installing Requirements...
python -m pip install --upgrade pip
pip install -r requirements.txt

echo.
echo ==========================================
echo Installation Complete!
echo You can now use run.bat to start the app.
echo ==========================================
pause
