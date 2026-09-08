# Changelog

## 30.08.2026

### Added

- Zentrale Projektdokumentation für Architektur, Entwicklung, Deployment und API.
- Arbeitsanweisungen für neue Codex-Chats und Entwickler.
- Automatischer RSI-Profil-Sync nach dem Speichern einer RSI-Profil-URL.
- Option zur Veröffentlichung einer neuen Order auf Discord.
- VerseLink-Notification für den Auftragsersteller, sobald ein anderer Nutzer die Order übernimmt.

### Changed

- README beschreibt jetzt den tatsächlich implementierten Projektstand und die Betriebsabläufe.
- Der Ersteller erhält keine eigene Notification mehr, wenn er eine Order erstellt; andere Gruppenmitglieder werden weiterhin benachrichtigt.
- Interne VerseLink-Notifications und externe Discord-Veröffentlichungen bleiben getrennt steuerbar.
- Der manuelle RSI-Sync bleibt zusätzlich verfügbar.

### Fixed

- RSI-Profildaten werden nach dem Eintragen der Profil-URL nicht mehr nur bei manuellem Sync aktualisiert.

### Removed

- Nichts.

## 17.08.2026

- Öffentliche, schreibgeschützte Blueprint-Suche pro Gruppe über sichere Public-Links ergänzt.
- Public-Links können erstellt, kopiert, neu erzeugt und widerrufen werden; private Besitzer- und Kontodaten bleiben verborgen.
- Öffentliche Suche um Kategorie-, Subkategorie- und Herstellerfilter erweitert.
- Materialaufträge mit Gruppenbezug, Übernahme, Beschaffungsmeldungen, Qualitätsstufen, Fortschritt, Erfüllen, Abbrechen und Ausblenden ergänzt.
- Teilbeschaffungen werden addiert; Status und offene Menge werden konsistent aus den Mengen abgeleitet.
- Neues responsives Order-Management-Dashboard mit Cards, Filtern und Materialsuche.

## Historische Zusammenfassung

- SCMDB-Sink, Persistenz und Blueprint-Deduplizierung eingeführt.
- Gruppen, Member-/Owner-Rollen, Einladungen und globale Administration ergänzt.
- Blueprint-Kategorien, Bilder, Materialien, Mining-Links und Zeitfilter ergänzt.
- Discord-Benachrichtigungen für neue Blueprints und Changelog-Updates ergänzt.
- PWA, Favicon, mobile Layouts und Newsticker ergänzt.
- Mehrere Newsticker-Commits vom 24.07.2026 stabilisierten Start, Breite, Reihenfolge und Schleifenverhalten; das Verhalten muss produktiv noch browserseitig verifiziert werden.
