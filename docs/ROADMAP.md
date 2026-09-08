# Roadmap

## Bereits abgeschlossen

- [x] SCMDB-Sink und Event-Deduplizierung
- [x] PostgreSQL-Persistenz mit Blueprint-Historie
- [x] Gruppen, Member-/Owner-Rollen und Einladungen
- [x] Globale Benutzer- und Gruppenadministration
- [x] Suche, Kategorien, Besitzer und Zeitfilter
- [x] Bilder, Materialien und SCMDB-Deep-Links
- [x] PWA-Grundlagen, Favicon und Changelog
- [x] Optionale Discord-Benachrichtigungen

## Aktuell in Arbeit

- [x] Phase 1 der öffentlichen, schreibgeschützten Blueprint-Suche (Share-Links und API)
- [ ] Newsticker im produktiven Browser verifizieren und stabilisieren
- [ ] README und Betriebsdokumentation aktuell halten

## Als Nächstes

- [ ] Browser-End-to-End-Test für Login, Gruppen, Filter und Newsticker
- [ ] Unit-/Integrationstests für Auth-, Gruppen- und Sink-Logik
- [ ] Formales, versioniertes Datenbank-Migrationssystem
- [ ] Synchronisierungsstatus und Fehlerzustände im UI verbessern
- [ ] Produktions-Backup und Restore testweise durchführen

## Spätere Erweiterungen

- [ ] Job-Queue für externe Referenz-, Bild- und Material-Synchronisierung
- [ ] Rate-Limiting und Retry-Strategien für externe APIs
- [ ] Audit-Log für Admin-Aktionen
- [ ] Favoriten und persönliche Notizen
- [ ] Schiffs-/Hangar-Daten nur nach separater rechtlicher und technischer Prüfung

## Technische Schulden

- [ ] Alles befindet sich weitgehend in einer großen `src/server.js`
- [ ] Keine formalen Migrationen
- [ ] Keine automatisierten Tests
- [ ] HTML/CSS/JS werden teilweise als Template-Strings erzeugt
- [ ] Versionsnummer in `package.json` und sichtbarer Changelog/Footer sind nicht vollständig vereinheitlicht

## Bekannte Fehler / zu prüfen

- [ ] Newsticker-Verhalten mit mehreren Einträgen und Hover auf realen Browsern prüfen
- [ ] Encoding der deutschen Dokumentation in verschiedenen PowerShell-Umgebungen prüfen
- [ ] Externe Material-/Bildquellen auf Ausfälle und Antwortformatänderungen überwachen

## Offene Entscheidungen

- [ ] Datenbankmigrationen: eigenes SQL-Verzeichnis oder Migrationsbibliothek
- [ ] API-Rate-Limits und Authentifizierung für eine mögliche öffentliche API
- [ ] Public-Share-Link-Management im Gruppen-Frontend
- [ ] Aufbewahrung und vollständige GDPR-Löschung historischer Blueprint-/Eventdaten
