package connection

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

const (
	PresenceTimeout         = 10 * time.Second
	MaxPresenceRequestBytes = 16 << 10
)

type PresenceLocation struct {
	Raw        string `json:"raw"`
	ObservedAt string `json:"observed_at"`
}
type PresenceShip struct {
	Name string `json:"name"`
}
type PresenceQuantum struct {
	Destination *string `json:"destination"`
	State       string  `json:"state"`
}
type PresenceRequest struct {
	Schema        int               `json:"schema"`
	Revision      int64             `json:"revision"`
	SessionActive *bool             `json:"session_active"`
	Shard         *string           `json:"shard"`
	Location      *PresenceLocation `json:"location"`
	Jurisdiction  *string           `json:"jurisdiction"`
	Ship          *PresenceShip     `json:"ship"`
	Quantum       *PresenceQuantum  `json:"quantum"`
	PartyCount    *int              `json:"party_count"`
	LastEventAt   *string           `json:"last_event_at"`
}

// MapPresenceSnapshot deliberately maps an explicit privacy allowlist; player
// handles, ship owners, Party identities, diagnostics, and parser data are not
// representable in the wire type.
func MapPresenceSnapshot(state telemetry.TelemetryState, available bool) PresenceRequest {
	request := PresenceRequest{Schema: 1}
	if !available {
		return request
	}
	active := state.SessionActive
	partyCount := len(state.Party)
	request.SessionActive, request.PartyCount = &active, &partyCount
	if state.Shard != "" {
		value := state.Shard
		request.Shard = &value
	}
	if state.Jurisdiction != "" {
		value := state.Jurisdiction
		request.Jurisdiction = &value
	}
	if state.Location != nil {
		request.Location = &PresenceLocation{Raw: state.Location.Raw, ObservedAt: state.Location.ObservedAt.UTC().Format(time.RFC3339Nano)}
	}
	if state.Ship != nil {
		request.Ship = &PresenceShip{Name: state.Ship.Name}
	}
	if state.Quantum != nil {
		var destination *string
		if state.Quantum.Destination != "" {
			value := state.Quantum.Destination
			destination = &value
		}
		request.Quantum = &PresenceQuantum{Destination: destination, State: state.Quantum.State}
	}
	if !state.LastEventAt.IsZero() {
		value := state.LastEventAt.UTC().Format(time.RFC3339Nano)
		request.LastEventAt = &value
	}
	return request
}

type PresenceResponse struct {
	Accepted   bool
	Revision   int64
	ReceivedAt time.Time
}

// PutPresence sends one immutable snapshot. The caller owns revision allocation
// and must reuse the identical request on transport retries.
func (c Client) PutPresence(ctx context.Context, credential []byte, payload PresenceRequest) (PresenceResponse, error) {
	defer clear(credential)
	base, err := ValidateBaseURL(c.BaseURL, c.AllowHTTP)
	if err != nil {
		return PresenceResponse{}, ErrInvalidURL
	}
	if !validCredential(credential) {
		return PresenceResponse{}, ErrInvalidCredential
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return PresenceResponse{}, ErrInvalidResponse
	}
	defer clear(body)
	if len(body) > MaxPresenceRequestBytes {
		return PresenceResponse{}, ErrInvalidResponse
	}
	ctx, cancel := context.WithTimeout(ctx, PresenceTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, base+"/api/telemetry/presence", bytes.NewReader(body))
	if err != nil {
		return PresenceResponse{}, ErrServerUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+string(credential))
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: PresenceTimeout}
	} else {
		copy := *client
		client = &copy
	}
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return PresenceResponse{}, ErrServerUnavailable
	}
	defer resp.Body.Close()
	response, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if err != nil || len(response) > MaxResponseBytes {
		clear(response)
		return PresenceResponse{}, ErrInvalidResponse
	}
	defer clear(response)
	var wire struct {
		Schema          int    `json:"schema"`
		Accepted        *bool  `json:"accepted"`
		Revision        int64  `json:"revision"`
		ReceivedAt      string `json:"received_at"`
		Error           string `json:"error"`
		CurrentRevision int64  `json:"current_revision"`
	}
	if json.Unmarshal(response, &wire) != nil {
		return PresenceResponse{}, ErrInvalidResponse
	}
	if resp.StatusCode != http.StatusOK {
		code := wire.Error
		if code == "" {
			return PresenceResponse{}, ErrInvalidResponse
		}
		apiErr := &APIError{Code: code, HTTPStatus: resp.StatusCode, CurrentRevision: wire.CurrentRevision}
		if resp.StatusCode == http.StatusTooManyRequests {
			apiErr.RetryAfter = parseHeartbeatRetryAfter(resp.Header.Get("Retry-After"))
		}
		if resp.StatusCode >= 500 {
			apiErr.RetryAfter = parseHeartbeatRetryAfter(resp.Header.Get("Retry-After"))
		}
		return PresenceResponse{}, apiErr
	}
	if wire.Schema != 1 || wire.Accepted == nil || wire.Revision != payload.Revision {
		return PresenceResponse{}, ErrInvalidResponse
	}
	result := PresenceResponse{Accepted: *wire.Accepted, Revision: wire.Revision}
	if *wire.Accepted {
		if wire.ReceivedAt == "" || !strings.HasSuffix(wire.ReceivedAt, "Z") {
			return PresenceResponse{}, ErrInvalidResponse
		}
		result.ReceivedAt, err = time.Parse(time.RFC3339Nano, wire.ReceivedAt)
		if err != nil {
			return PresenceResponse{}, ErrInvalidResponse
		}
	}
	return result, nil
}

var ErrPresenceConflict = errors.New("presence revision conflict")
