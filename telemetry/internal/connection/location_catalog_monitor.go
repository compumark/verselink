package connection

import (
	"context"
	"errors"
	"time"

	"github.com/compumark/verselink-telemetry/internal/locationcatalog"
)

const LocationCatalogRefreshInterval = 12 * time.Hour

type LocationCatalogConfig struct {
	BaseURL, DeviceID string
	AllowHTTP         bool
}

type LocationCatalogObserver interface {
	OnLocationCatalog(locationcatalog.Catalog, string)
}

type LocationCatalogMonitor struct {
	Client      Client
	Credentials CredentialStore
	Cache       locationcatalog.Store
	Now         func() time.Time
}

func (m LocationCatalogMonitor) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}
func (m LocationCatalogMonitor) Run(ctx context.Context, initial LocationCatalogConfig, updates <-chan LocationCatalogConfig, observer LocationCatalogObserver) {
	config := initial
	for {
		if config.BaseURL == "" || config.DeviceID == "" || m.Credentials == nil {
			if observer != nil {
				observer.OnLocationCatalog(locationcatalog.Catalog{}, "unavailable")
			}
			select {
			case <-ctx.Done():
				return
			case next, ok := <-updates:
				if !ok {
					return
				}
				config = next
			}
			continue
		}
		cached, hasCache := m.Cache.Load(m.now())
		if hasCache && cached.ServerURL != config.BaseURL {
			cached, hasCache = locationcatalog.CacheFile{}, false
		}
		if hasCache && observer != nil {
			observer.OnLocationCatalog(cached.Catalog, "cached")
		}
		credential, err := m.Credentials.Read(CredentialTarget(config.BaseURL, config.DeviceID))
		if err == nil && len(credential) > 0 {
			client := m.Client
			client.BaseURL, client.AllowHTTP = config.BaseURL, config.AllowHTTP
			result, requestErr := client.GetLocationCatalog(ctx, credential, cached.ETag)
			if requestErr == nil {
				if result.NotModified && hasCache {
					cached.FetchedAt = m.now()
					if result.ETag != "" {
						cached.ETag = result.ETag
					}
					if m.Cache.Path != "" {
						_ = m.Cache.Save(cached)
					}
					if observer != nil {
						observer.OnLocationCatalog(cached.Catalog, "available")
					}
				} else if !result.NotModified {
					newCache := locationcatalog.CacheFile{ServerURL: config.BaseURL, ETag: result.ETag, FetchedAt: m.now(), Catalog: result.Catalog}
					if m.Cache.Path != "" {
						_ = m.Cache.Save(newCache)
					}
					if observer != nil {
						observer.OnLocationCatalog(result.Catalog, "available")
					}
				}
			} else if !hasCache && observer != nil {
				observer.OnLocationCatalog(locationcatalog.Catalog{}, catalogErrorCategory(requestErr))
			}
		} else if !hasCache && observer != nil {
			observer.OnLocationCatalog(locationcatalog.Catalog{}, "unavailable")
		}
		timer := time.NewTimer(LocationCatalogRefreshInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case next, ok := <-updates:
			timer.Stop()
			if !ok {
				return
			}
			config = next
		case <-timer.C:
		}
	}
}

func catalogErrorCategory(err error) string {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.Code
	}
	if errors.Is(err, ErrInvalidCredential) {
		return "credential_unavailable"
	}
	return "unavailable"
}
