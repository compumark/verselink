# SC Inventory Log Watcher

Eigenstaendiger Test-Watcher fuer Gegenstandstransaktionen in Star Citizens `Game.log`.
Er ist nicht mit dem Blueprint-/Missions-Watcher verbunden.

Standardmaessig werden nur Waffen und Ruestungsteile verfolgt. Munition,
Magazine, Verbrauchsgegenstaende, Multitools, Traktorstrahl-/Salvage-/Repair-
Module und sonstige Utility-Items werden herausgefiltert.

Auch `Move`-Transfers vom Standortinventar in einen persoenlichen Rucksack-
Container werden als `TRANSFER IN RUCKSACK` erkannt. Ein erfolgreicher solcher
Transfer bedeutet, dass der Gegenstand aus dem Standortlager entfernt wurde.
Die Gegenrichtung wird als `TRANSFER IN STATIONSINVENTAR` erkannt und erhoeht
damit wieder den Lagerbestand am Standort.
Der Watcher ordnet die Location-ID dem zuletzt aus dem Log gelesenen
Stationsnamen zu und zeigt Station und ID direkt bei Transfers an.

Die Version schreibt aktuell nur ins Konsolenfenster. Eine Datenbank-
Uebertragung kann optional ueber den bestehenden SCMDB-Sink aktiviert werden.

Fuer einen Test setzt du vor dem Start in PowerShell:

```powershell
$env:SC_INVENTORY_API_URL = 'https://deine-domain.example'
$env:SC_INVENTORY_SINK_TOKEN = 'DEIN_SINK_TOKEN'
$env:SC_INVENTORY_USER_HANDLE = 'Compumark'
```

Die User-ID wird serverseitig aus dem Sink-Token ermittelt und muss im Watcher
nicht mehr konfiguriert werden.

Mit `-DryRun` werden Events nur angezeigt und nicht gesendet. Ohne API-
Konfiguration bleibt der Watcher ebenfalls lokal.

## Start

1. Star Citizen starten.
2. `start-sc-inventory-watcher.bat` doppelklicken.
3. Das Inventar oeffnen, Gegenstaende einlagern, ausruesten oder kaufen.
4. Die erkannte Aktion erscheint im Konsolenfenster.

Der Standardpfad ist:

`O:\Roberts Space Industries\StarCitizen\LIVE\Game.log`

Ein anderer Pfad kann als erstes Argument uebergeben werden:

```bat
start-sc-inventory-watcher.bat "D:\StarCitizen\LIVE\Game.log"
```

Der Watcher startet absichtlich am aktuellen Ende der Datei. Alte Logzeilen werden nicht erneut als neue Transaktionen gemeldet.
