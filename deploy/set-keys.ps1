# Спрашивает ключи Вайбкод скрытым вводом и кладёт их только в переменные
# окружения ТЕКУЩЕЙ вкладки PowerShell. Ничего не пишет на диск и в историю,
# ничего не печатает, кроме длины и префикса ключа.
# Источник ключей — запись в менеджере паролей; закрыли вкладку — ключей нет.

function Read-Secret([string]$prompt) {
  $secure = Read-Host -Prompt $prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Check-Key([string]$value, [string]$prefix, [string]$name) {
  if (-not $value.StartsWith($prefix)) {
    Write-Host "  $name не начинается с $prefix - не сохранён, повторите запуск." -ForegroundColor Red
    return $false
  }
  Write-Host "  $name принят: $prefix..., длина $($value.Length)" -ForegroundColor Green
  return $true
}

$api = Read-Secret 'Ключ для деплоя (vibe_api_...)'
if (Check-Key $api 'vibe_api_' 'VIBE_API_KEY') { $env:VIBE_API_KEY = $api }
$app = Read-Secret 'Ключ авторизации приложения (vibe_app_...)'
if (Check-Key $app 'vibe_app_' 'VIBE_APP_KEY') { $env:VIBE_APP_KEY = $app }
Remove-Variable api, app -ErrorAction SilentlyContinue
