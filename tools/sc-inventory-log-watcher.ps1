param(
    [string]$LogPath = 'O:\Roberts Space Industries\StarCitizen\LIVE\Game.log',
    [switch]$FromBeginning,
    [string]$ApiUrl = $env:SC_INVENTORY_API_URL,
    [string]$SinkToken = $env:SC_INVENTORY_SINK_TOKEN,
    [string]$UserId = $env:SC_INVENTORY_USER_ID,
    [string]$UserHandle = $env:SC_INVENTORY_USER_HANDLE,
    [string]$ConfigPath = "$PSScriptRoot\sc-inventory-watcher.config.ps1",
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $ConfigPath) {
    . $ConfigPath
    if (-not $ApiUrl -and $SC_INVENTORY_API_URL) { $ApiUrl = $SC_INVENTORY_API_URL }
    if (-not $SinkToken -and $SC_INVENTORY_SINK_TOKEN) { $SinkToken = $SC_INVENTORY_SINK_TOKEN }
    if (-not $UserHandle -and $SC_INVENTORY_USER_HANDLE) { $UserHandle = $SC_INVENTORY_USER_HANDLE }
}
$script:LocationNames = @{}
$script:PendingLocationName = $null
$script:CurrentLocationName = $null
$script:ApiUrl = $ApiUrl.TrimEnd('/')

function Send-Transaction([string]$Line, [string]$ItemClass, [string]$Direction, [string]$Station, [string]$LocationId) {
    if (-not $script:ApiUrl -or -not $SinkToken -or $DryRun) {
        if ($DryRun) { Write-Host '  DRY-RUN: Event nicht gesendet.' -ForegroundColor DarkGray }
        return
    }
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $eventId = (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Line)) | ForEach-Object { $_.ToString('x2') }) -join '')
        $timestamp = [DateTimeOffset]::Parse(([regex]::Match($Line, '<([^>]+)>').Groups[1].Value)).ToUnixTimeMilliseconds()
        $body = @{ schema=1; event_id="inventory-$eventId"; event='inventory.transaction'; ts=$timestamp; user=@{handle=$UserHandle}; payload=@{ item_class=$ItemClass; direction=$Direction; quantity=1; station_key=$Station; station_name=$Station; station_log_id=$LocationId; category=if($ItemClass -match 'helmet|armor|undersuit|backpack|_core_|_arms_|_legs_'){'Armor'}else{'Weapons'}; game_channel='LIVE' } } | ConvertTo-Json -Depth 5
        Invoke-RestMethod -Uri "$($script:ApiUrl)/v1/scmdb/$SinkToken" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15
        Write-Host '  API: Event erfolgreich übertragen.' -ForegroundColor Cyan
    } catch { Write-Host "  API-FEHLER: $($_.Exception.Message)" -ForegroundColor Red }
}

function Test-IsTrackedItem([string]$ItemClass) {
    # Whitelist: personal weapons and armor/container parts only.
    # Deliberately excludes generic utility items, multitools, tractor beams,
    # consumables and ammunition/magazines.
    $name = $ItemClass.ToLowerInvariant()
    if ($name -match '(_mag|magazine|ammo|battery|vial|consumable|drink_|utility_|multitool|tractor|salvage|repair)') {
        return $false
    }
    return $name -match '(rifle|pistol|shotgun|sniper|smg|lmg|launcher|medgun|weapon|undersuit|helmet|armor_|_armor_|backpack|_core_|_arms_|_legs_)'
}

function Show-Event([string]$Line) {
    if ($Line -match '<[^>]+>.*?<RequestLocationInventory>.*?Location\[(?<location>[^\]]+)\]') {
        $script:PendingLocationName = $matches.location
        $script:CurrentLocationName = $matches.location
        Write-Host "STATION ERKANNT: $($matches.location)" -ForegroundColor Magenta
        return
    }
    if ($Line -match '<[^>]+>.*?<Show Location Inventory>.*?\[(?<location>[^\]]+)\]') {
        $script:CurrentLocationName = $matches.location
        Write-Host "STATIONSINVENTAR GEOEFFNET: $($matches.location)" -ForegroundColor Magenta
        return
    }
    if ($Line -match '<[^>]+>.*?<Query Inventory>.*?Inventory\[\d+:Location:(?<id>\d+)\]') {
        if ($script:PendingLocationName) {
            $script:LocationNames[$matches.id] = $script:PendingLocationName
            $script:PendingLocationName = $null
        }
        return
    }
    if ($Line -match '<(?<ts>[^>]+)>.*?<(?:OnInventoryStoreItem|StoreItem)>.*?Class\((?<class>[^\)]+)\).*?Inventory\[\d+:Location:(?<id>\d+)\]') {
        if (Test-IsTrackedItem $matches.class) {
            Write-Host "[$($matches.ts)] EINLAGERUNG: $($matches.class)" -ForegroundColor Green
            $station = if ($script:LocationNames.ContainsKey($matches.id)) { $script:LocationNames[$matches.id] } elseif ($script:CurrentLocationName) { $script:CurrentLocationName } else { 'unbekannt' }
            Send-Transaction $Line $matches.class 'TO_STATION' $station $matches.id
        }
        return
    }
    if ($Line -match '<(?<ts>[^>]+)>.*?<EquipItem>.*?Class\[(?<class>[^\]]+)\].*?Port\[(?<port>[^\]]+)\]') {
        if (Test-IsTrackedItem $matches.class) {
            Write-Host "[$($matches.ts)] AUS INVENTAR AUSGERUESTET: $($matches.class) -> $($matches.port)" -ForegroundColor Yellow
        }
        return
    }
    if ($Line -match '<(?<ts>[^>]+)>.*?Type\[Move\].*?SourceInventory\[(?<source>[^\]]+:Location:\d+)\].*?TargetInventory\[(?<target>[^\]]+:Container:0)\].*?ItemClass\[(?<class>[^\[\]]+)\]') {
        if (Test-IsTrackedItem $matches.class) {
            $id = [regex]::Match($matches.source, 'Location:(\d+)').Groups[1].Value
            $station = if ($script:LocationNames.ContainsKey($id)) { $script:LocationNames[$id] } elseif ($script:CurrentLocationName) { $script:CurrentLocationName } else { 'unbekannt' }
            Write-Host "[$($matches.ts)] TRANSFER IN RUCKSACK: $($matches.class) | Station: $station (ID $id)" -ForegroundColor Green
            Send-Transaction $Line $matches.class 'TO_BACKPACK' $station $id
        }
        return
    }
    if ($Line -match '<(?<ts>[^>]+)>.*?Type\[Move\].*?SourceInventory\[(?<source>[^\]]+:Container:0)\].*?TargetInventory\[(?<target>[^\]]+:Location:\d+)\].*?ItemClass\[(?<class>[^\[\]]+)\]') {
        if (Test-IsTrackedItem $matches.class) {
            $id = [regex]::Match($matches.target, 'Location:(\d+)').Groups[1].Value
            $station = if ($script:LocationNames.ContainsKey($id)) { $script:LocationNames[$id] } elseif ($script:CurrentLocationName) { $script:CurrentLocationName } else { 'unbekannt' }
            Write-Host "[$($matches.ts)] TRANSFER IN STATIONSINVENTAR: $($matches.class) | Station: $station (ID $id)" -ForegroundColor Cyan
            Send-Transaction $Line $matches.class 'TO_STATION' $station $id
        }
        return
    }
    if ($Line -match '<(?<ts>[^>]+)>.*?Type\[Store\].*?Item\[(?<item>[^\]]+)\].*?TargetInventory\[(?<target>[^\]]+)\]') {
        if (Test-IsTrackedItem $matches.item) {
            Write-Host "[$($matches.ts)] STORE-TRANSFER: $($matches.item) -> $($matches.target)" -ForegroundColor Green
        }
        return
    }
    if ($Line -match '<(?<ts>[^>]+)>.*?<CEntityComponentShopUIProvider::RmShopFlowResponse>.*?result\[Success\].*?type\[Buying\]') {
        Write-Host "[$($matches.ts)] KAUF ERFOLGREICH (Inventar wird danach aktualisiert)" -ForegroundColor Cyan
        return
    }
    if ($Line -match '<(?<ts>[^>]+)>.*?<RequestLocationInventory>.*?Location\[(?<location>[^\]]+)\]') {
        Write-Host "[$($matches.ts)] STATIONSINVENTAR ABGEFRAGT: $($matches.location)" -ForegroundColor Magenta
        return
    }
    if ($Line -match '<(?<ts>[^>]+)>.*?<Show Location Inventory>.*?\[(?<location>[^\]]+)\]') {
        Write-Host "[$($matches.ts)] STATIONSINVENTAR GEOEFFNET: $($matches.location)" -ForegroundColor Magenta
        return
    }
}

if (-not (Test-Path -LiteralPath $LogPath)) {
    Write-Host "Game.log nicht gefunden: $LogPath" -ForegroundColor Red
    Write-Host 'Starte das Spiel oder passe den Pfad beim Aufruf an.'
    exit 1
}

Write-Host 'SC Inventory Log Watcher v0.1' -ForegroundColor White
Write-Host "Ueberwache: $LogPath"
Write-Host 'Beenden mit Strg+C.'
Write-Host ''

$file = [System.IO.File]::Open($LogPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
$reader = New-Object System.IO.StreamReader($file)
try {
    if (-not $FromBeginning) { [void]$reader.ReadToEnd() }
    while ($true) {
        $line = $reader.ReadLine()
        if ($null -ne $line) {
            Show-Event $line
            continue
        }
        Start-Sleep -Milliseconds 250
        if ($file.Length -lt $file.Position) {
            $file.Seek(0, [System.IO.SeekOrigin]::Begin) | Out-Null
            $reader.DiscardBufferedData()
        }
    }
}
finally {
    $reader.Dispose()
    $file.Dispose()
}
