package locationcatalog

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	SchemaVersion = 1
	MaxEntries    = 4000
	MaxCacheBytes = 8 << 20
	MaxTTL        = 24 * time.Hour
)

var ErrInvalidCatalog = errors.New("invalid location catalog")

type Entry struct {
	LocationRaw  string `json:"location_raw"`
	DisplayName  string `json:"display_name"`
	SystemName   string `json:"system_name"`
	ParentName   string `json:"parent_name"`
	Jurisdiction string `json:"jurisdiction"`
	Affiliation  string `json:"affiliation"`
	Source       string `json:"source"`
	MatchType    string `json:"match_type"`
	Status       string `json:"status"`
}

type Catalog struct {
	Schema      int       `json:"schema"`
	Version     int64     `json:"version"`
	GeneratedAt time.Time `json:"generated_at"`
	TTLSeconds  int       `json:"ttl_seconds"`
	Entries     []Entry   `json:"entries"`
}

type CacheFile struct {
	ServerURL string    `json:"server_url"`
	ETag      string    `json:"etag"`
	FetchedAt time.Time `json:"fetched_at"`
	Catalog   Catalog   `json:"catalog"`
}

type Display struct {
	Place, System, Jurisdiction, Affiliation, Raw, Status string
}

func Validate(c Catalog) (Catalog, error) {
	if c.Schema != SchemaVersion || c.Version < 1 || c.TTLSeconds < 1 || c.TTLSeconds > int(MaxTTL/time.Second) || len(c.Entries) > MaxEntries {
		return Catalog{}, ErrInvalidCatalog
	}
	seen := make(map[string]struct{}, len(c.Entries))
	for _, entry := range c.Entries {
		if entry.LocationRaw == "" || len(entry.LocationRaw) > 256 || entry.DisplayName == "" || len(entry.DisplayName) > 256 || entry.Status != "verified" || (entry.MatchType != "exact" && entry.MatchType != "manual") {
			return Catalog{}, ErrInvalidCatalog
		}
		if _, exists := seen[entry.LocationRaw]; exists {
			return Catalog{}, ErrInvalidCatalog
		}
		seen[entry.LocationRaw] = struct{}{}
	}
	return c, nil
}

// Resolve uses byte-for-byte raw-key matching only. Telemetry's jurisdiction
// field is an unverified observation and can never provide a fallback value.
func Resolve(c Catalog, raw, observedJurisdiction string) Display {
	result := Display{Place: "Unknown", System: "Unknown", Jurisdiction: "Unknown", Affiliation: "Unknown", Raw: raw, Status: "unknown"}
	if raw == "" {
		return result
	}
	result.Place = raw
	for _, entry := range c.Entries {
		if entry.LocationRaw != raw || entry.Status != "verified" || (entry.MatchType != "exact" && entry.MatchType != "manual") {
			continue
		}
		result.Place = entry.DisplayName
		if entry.SystemName != "" {
			result.System = entry.SystemName
		}
		if entry.Affiliation != "" {
			result.Affiliation = entry.Affiliation
		}
		if entry.Jurisdiction != "" {
			if observedJurisdiction == "" || strings.EqualFold(strings.TrimSpace(observedJurisdiction), strings.TrimSpace(entry.Jurisdiction)) {
				result.Jurisdiction = entry.Jurisdiction
			} else {
				result.Status = "conflict"
				return result
			}
		}
		result.Status = "resolved"
		return result
	}
	return result
}

func (f CacheFile) ValidAt(now time.Time) bool {
	if f.FetchedAt.IsZero() || now.Before(f.FetchedAt) || f.Catalog.TTLSeconds < 1 || f.Catalog.TTLSeconds > int(MaxTTL/time.Second) || now.Sub(f.FetchedAt) >= time.Duration(f.Catalog.TTLSeconds)*time.Second {
		return false
	}
	_, err := Validate(f.Catalog)
	return err == nil
}

type Store struct{ Path string }

func (s Store) Load(now time.Time) (CacheFile, bool) {
	data, err := os.ReadFile(s.Path)
	if err != nil || len(data) == 0 || len(data) > MaxCacheBytes {
		return CacheFile{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var value CacheFile
	if decoder.Decode(&value) != nil || decoder.Decode(new(any)) != io.EOF || !value.ValidAt(now) {
		return CacheFile{}, false
	}
	return value, true
}

func (s Store) Save(value CacheFile) error {
	if !value.ValidAt(value.FetchedAt) || value.ETag == "" {
		return ErrInvalidCatalog
	}
	data, err := json.Marshal(value)
	if err != nil || len(data) > MaxCacheBytes {
		return ErrInvalidCatalog
	}
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.Path), ".location-catalog-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, s.Path)
}

func LocalCachePath(localAppData string) (string, error) {
	if strings.TrimSpace(localAppData) == "" {
		return "", errors.New("LOCALAPPDATA is not set")
	}
	return filepath.Join(localAppData, "VerseLink", "Telemetry", "location-catalog.json"), nil
}
