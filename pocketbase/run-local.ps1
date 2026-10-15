# KsuNiMeet — PocketBase на этой машине под Windows.
#
# Тот же бинарник, что ставится на сервер: разница только в адресе, который
# уезжает в config.js. Годится и для разработки («поднять локально и проверить»),
# и для круглосуточной работы на домашней машине — но прежде чем рассчитывать
# на второй вариант, прочтите раздел «Домашняя машина» в pocketbase/README.md:
# домашний сервер нужно ещё сделать видимым из интернета, и обычные туннели
# (Cloudflare, ngrok) для России не годятся.
#
# Запуск (просто поднять):
#   powershell -ExecutionPolicy Bypass -File ksunimeet-web\pocketbase\run-local.ps1
#
# Автозапуск при входе в систему (без прав администратора):
#   powershell -ExecutionPolicy Bypass -File ksunimeet-web\pocketbase\run-local.ps1 -InstallTask
#
# Убрать автозапуск:
#   powershell -ExecutionPolicy Bypass -File ksunimeet-web\pocketbase\run-local.ps1 -RemoveTask

[CmdletBinding()]
param(
    # На каком адресе слушать. 127.0.0.1 — только эта машина (для разработки).
    # 0.0.0.0 — вся локальная сеть (нужно, если backend открывают с телефона
    # в той же Wi-Fi сети, например для проверки APK).
    [string]$Http = "127.0.0.1:8090",

    # Кому браузеру разрешено обращаться к API. Адрес сайта на GitHub Pages
    # обязан быть в списке, иначе браузер отобьёт ответы (CORS) и живые
    # обновления молча не заработают. Несколько адресов — через запятую.
    [string]$Origins = "http://127.0.0.1:8137,http://localhost:8137",

    [string]$Version = "0.40.5",

    [switch]$InstallTask,
    [switch]$RemoveTask
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $here "pocketbase.exe"
$dataDir = Join-Path $here "pb_data"
$taskName = "KsuNiMeet PocketBase"

if ($RemoveTask) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Автозапуск убран: $taskName"
    } else {
        Write-Host "Автозапуска и не было: $taskName"
    }
    return
}

if ($InstallTask) {
    if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        $action = New-ScheduledTaskAction -Execute "powershell.exe" `
            -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Http $Http -Origins `"$Origins`""
        # Триггер «при входе в систему»: задача пользовательская, права
        # администратора не нужны. Сервер поднимется сам после включения машины
        # и входа — то есть круглосуточно, если машина не выключается.
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
            -Description "KsuNiMeet backend (PocketBase). Автозапуск при входе в систему." -Force | Out-Null
        Write-Host "Автозапуск прописан: $taskName"
    } else {
        Write-Host "Автозапуск уже есть: $taskName"
    }
    return
}

# ---------------------------------------------------------------------------
# 1. Бинарник
# ---------------------------------------------------------------------------
if (-not (Test-Path $exe)) {
    $zip = Join-Path $here "pb.zip"
    $url = "https://github.com/pocketbase/pocketbase/releases/download/v$Version/pocketbase_${Version}_windows_amd64.zip"
    Write-Host "Скачиваю PocketBase $Version..."
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $here -Force
    Remove-Item $zip -Force
}

$found = & $exe --version
Write-Host "Бинарник: $found"

# ---------------------------------------------------------------------------
# 2. Данные
# ---------------------------------------------------------------------------
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}

# ---------------------------------------------------------------------------
# 3. Запуск
# ---------------------------------------------------------------------------
# Миграции применяются сами при старте (--automigrate по умолчанию включён),
# хуки подхватываются из pb_hooks. Поэтому отдельного шага «накатить схему» нет:
# первый запуск и есть накат.
Write-Host ""
Write-Host "Каталог данных : $dataDir"
Write-Host "Схема и хуки   : $here\pb_migrations, $here\pb_hooks"
Write-Host "Слушаю         : http://$Http"
Write-Host "Разрешённые источники (CORS): $Origins"
Write-Host ""
Write-Host "Панель администратора: http://$Http/_/"
Write-Host "Первый суперпользователь:  & '$exe' superuser upsert ВАШ@email ПАРОЛЬ --dir '$dataDir'"
Write-Host ""
Write-Host "Адрес API для config.js: http://$Http"
Write-Host "Остановка: Ctrl+C"
Write-Host ""

& $exe serve `
    --http=$Http `
    --dir="$dataDir" `
    --migrationsDir="$here\pb_migrations" `
    --hooksDir="$here\pb_hooks" `
    --origins="$Origins"
