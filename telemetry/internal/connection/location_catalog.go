package connection

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/compumark/verselink-telemetry/internal/locationcatalog"
)

const (
	LocationCatalogTimeout  = 8 * time.Second
	MaxLocationCatalogBytes = 6 << 20
)

type LocationCatalogResponse struct {
	Catalog     locationcatalog.Catalog
	ETag        string
	NotModified bool
}

// GetLocationCatalog is a separate, bounded read. It does not send presence,
// heartbeat, game-log, or device-state fields.
func (c Client) GetLocationCatalog(ctx context.Context, credential []byte, etag string) (LocationCatalogResponse, error) {
	defer clear(credential)
	base, err := ValidateBaseURL(c.BaseURL, c.AllowHTTP)
	if err != nil {
		return LocationCatalogResponse{}, ErrInvalidURL
	}
	if !validCredential(credential) {
		return LocationCatalogResponse{}, ErrInvalidCredential
	}
	ctx, cancel := context.WithTimeout(ctx, LocationCatalogTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/telemetry/v1/location-catalog", nil)
	if err != nil {
		return LocationCatalogResponse{}, ErrServerUnavailable
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+string(credential))
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: LocationCatalogTimeout}
	}
	clientCopy := *client
	clientCopy.Jar = nil
	clientCopy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := clientCopy.Do(req)
	if err != nil {
		return LocationCatalogResponse{}, ErrServerUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified {
		return LocationCatalogResponse{ETag: response.Header.Get("ETag"), NotModified: true}, nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, MaxLocationCatalogBytes+1))
	if err != nil || len(body) > MaxLocationCatalogBytes {
		clear(body)
		return LocationCatalogResponse{}, ErrInvalidResponse
	}
	defer clear(body)
	if response.StatusCode != http.StatusOK {
		var payload struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &payload) != nil {
			return LocationCatalogResponse{}, ErrInvalidResponse
		}
		switch payload.Error {
		case "invalid_device_credential", "device_revoked", "account_inactive", "rate_limited", "server_unavailable":
			return LocationCatalogResponse{}, &APIError{Code: payload.Error, HTTPStatus: response.StatusCode}
		default:
			return LocationCatalogResponse{}, ErrServerUnavailable
		}
	}
	var catalog locationcatalog.Catalog
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&catalog) != nil {
		return LocationCatalogResponse{}, ErrInvalidResponse
	}
	if decoder.Decode(new(any)) != io.EOF {
		return LocationCatalogResponse{}, ErrInvalidResponse
	}
	if _, err := locationcatalog.Validate(catalog); err != nil {
		return LocationCatalogResponse{}, ErrInvalidResponse
	}
	etag = response.Header.Get("ETag")
	if etag == "" {
		return LocationCatalogResponse{}, ErrInvalidResponse
	}
	return LocationCatalogResponse{Catalog: catalog, ETag: etag}, nil
}
