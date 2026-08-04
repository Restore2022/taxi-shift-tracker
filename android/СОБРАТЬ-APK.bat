@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [1/3] Копирование файлов...
if not exist "app\src\main\assets\css" mkdir "app\src\main\assets\css"
if not exist "app\src\main\assets\js" mkdir "app\src\main\assets\js"
copy /Y "..\index.html" "app\src\main\assets\index.html" >nul
copy /Y "..\css\styles.css" "app\src\main\assets\css\styles.css" >nul
copy /Y "..\js\*.js" "app\src\main\assets\js\" >nul

echo [2/3] Сборка APK...
if exist gradlew.bat (
    call gradlew.bat assembleDebug
) else (
    gradle assembleDebug
)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Не удалось собрать автоматически.
    echo Откройте эту папку в Android Studio:
    echo   File - Open - выберите папку android
    echo   Build - Build APK
    pause
    exit /b 1
)

echo.
echo [3/3] Готово!
echo.
echo   APK: app\build\outputs\apk\debug\app-debug.apk
echo.
echo   Переименуйте в TaxiSmena.apk и отправьте на телефон.
echo   Водитель просто нажимает на файл и устанавливает.
echo.
pause
