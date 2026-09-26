package connection

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	MaxResponseBytes = 8 << 10
	PairTimeout      = 10 * time.Second
)

var (
	ErrInvalidURL        = errors.New("invalid VerseLink server URL")
	ErrServerUnavailable = errors.New("VerseLink server unavailable; the one-time pairing code may have been consumed, so confirm its status before retrying")
	ErrInvalidResponse   = errors.New("VerseLink returned an invalid response; the one-time pairing code may have been consumed, so confirm its status before retrying")
)

type APIError struct {
	Code       string
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	message := publicMessage(e.Code)
	if e.Code == "rate_limited" && e.RetryAfter > 0 {
		return fmt.Sprintf("Too many pairing attempts. Wait about %d seconds before trying again.", int((e.RetryAfter+time.Second-1)/time.Second))
	}
	return message
}
func publicMessage(code string) string {
	switch code {
	case "invalid_pairing_code":
		return "The pairing code is invalid or unknown."
	case "expired_pairing_code":
		return "The pairing code has expired. Request a new code."
	case "pairing_code_used":
		return "The pairing code was already used or replaced. Request a new code."
	case "rate_limited":
		return "Too many pairing attempts. Please wait and try again."
	case "server_unavailable":
		return "VerseLink server unavailable; the one-time pairing code may have been consumed, so confirm its status before retrying."
	default:
		return "VerseLink could not complete pairing. The one-time code may have been consumed; confirm its status before retrying."
	}
}

type ClaimRequest struct {
	Schema int    `json:"schema"`
	Code   string `json:"code"`
	Name   string `json:"device_name,omitempty"`
}
type ClaimResponse struct {
	Schema           int    `json:"schema"`
	DeviceID         string `json:"device_id"`
	DeviceName       string `json:"device_name"`
	DeviceCredential []byte `json:"device_credential"`
	TokenType        string `json:"token_type"`
	CreatedAt        string `json:"created_at"`
}

type claimResponseWire struct {
	Schema     int             `json:"schema"`
	DeviceID   string          `json:"device_id"`
	DeviceName string          `json:"device_name"`
	Credential json.RawMessage `json:"device_credential"`
	TokenType  string          `json:"token_type"`
	CreatedAt  string          `json:"created_at"`
}

type Client struct {
	BaseURL   string
	AllowHTTP bool
	HTTP      *http.Client
}

type URLSource string

const (
	URLFromEnvironment URLSource = "environment"
	URLFromSettings    URLSource = "settings"
)

func ResolveBaseURL(environmentValue, storedValue string, allowHTTP bool) (string, URLSource, error) {
	if strings.TrimSpace(environmentValue) != "" {
		value, err := ValidateBaseURL(environmentValue, allowHTTP)
		return value, URLFromEnvironment, err
	}
	if strings.TrimSpace(storedValue) == "" {
		return "", "", ErrInvalidURL
	}
	value, err := ValidateBaseURL(storedValue, allowHTTP)
	return value, URLFromSettings, err
}

func ValidateBaseURL(raw string, allowHTTP bool) (string, error) {
	trimmed := strings.TrimSpace(raw)
	u, err := url.Parse(trimmed)
	if err != nil || u == nil || u.Opaque != "" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(trimmed, "#") || (u.Path != "" && u.Path != "/") {
		return "", ErrInvalidURL
	}
	if u.Scheme != "https" && !(allowHTTP && u.Scheme == "http" && isLoopbackHost(u.Hostname())) {
		return "", ErrInvalidURL
	}
	if u.Hostname() == "" || strings.ContainsAny(u.Host, "\\ \t\r\n") {
		return "", ErrInvalidURL
	}
	if strings.HasSuffix(u.Host, ":") {
		return "", ErrInvalidURL
	}
	if port := u.Port(); port != "" {
		value, parseErr := strconv.Atoi(port)
		if parseErr != nil || value < 1 || value > 65535 {
			return "", ErrInvalidURL
		}
	}
	// C5 only supports a server origin; a path prefix is rejected above so that
	// two deployments cannot accidentally share a credential-manager target.
	u.Scheme = strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
		port = ""
	}
	if port != "" {
		u.Host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") { // Preserve brackets for IPv6 URLs.
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	u.Path, u.RawPath = "", ""
	return strings.TrimRight(u.String(), "/"), nil
}

func isLoopbackHost(host string) bool {
	return strings.EqualFold(host, "localhost") || net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()
}

func (c Client) Claim(ctx context.Context, code, name string) (ClaimResponse, error) {
	base, err := ValidateBaseURL(c.BaseURL, c.AllowHTTP)
	if err != nil {
		return ClaimResponse{}, err
	}
	code = normalizeCode(code)
	if code == "" {
		return ClaimResponse{}, &APIError{Code: "invalid_pairing_code"}
	}
	body, _ := json.Marshal(ClaimRequest{Schema: 1, Code: code, Name: strings.TrimSpace(name)})
	defer clear(body)
	ctx, cancel := context.WithTimeout(ctx, PairTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/telemetry/pair", bytes.NewReader(body))
	if err != nil {
		return ClaimResponse{}, ErrServerUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: PairTimeout}
	} else {
		copy := *client
		client = &copy
	}
	client.Jar = nil
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return ClaimResponse{}, ErrServerUnavailable
	}
	defer resp.Body.Close()
	response, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if err != nil || len(response) > MaxResponseBytes {
		return ClaimResponse{}, ErrInvalidResponse
	}
	defer clear(response)
	if resp.StatusCode != http.StatusCreated {
		var payload struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(response, &payload) != nil {
			return ClaimResponse{}, ErrInvalidResponse
		}
		apiErr := &APIError{Code: payload.Error}
		if payload.Error == "rate_limited" {
			apiErr.RetryAfter = parseRetryAfter(resp.Header.Get("Retry-After"))
		}
		switch payload.Error {
		case "invalid_pairing_code", "expired_pairing_code", "pairing_code_used", "rate_limited", "server_unavailable":
			return ClaimResponse{}, apiErr
		default:
			return ClaimResponse{}, ErrInvalidResponse
		}
	}
	result, err := parseClaimResponse(response)
	if err != nil {
		return ClaimResponse{}, ErrInvalidResponse
	}
	return result, nil
}

func parseClaimResponse(response []byte) (ClaimResponse, error) {
	defer clear(response)
	var wire claimResponseWire
	return parseClaimResponseWire(response, &wire)
}

// parseClaimResponseWire is split out so tests can verify that JSON's mutable
// RawMessage storage is wiped on every post-decode return path.
func parseClaimResponseWire(response []byte, wire *claimResponseWire) (ClaimResponse, error) {
	if wire == nil {
		return ClaimResponse{}, ErrInvalidResponse
	}
	defer func() { clear(wire.Credential) }()
	if err := json.Unmarshal(response, wire); err != nil {
		return ClaimResponse{}, err
	}
	if wire.Schema != 1 || !validID(wire.DeviceID) || !validName(wire.DeviceName) || wire.TokenType != "Bearer" {
		return ClaimResponse{}, ErrInvalidResponse
	}
	if _, err := time.Parse(time.RFC3339Nano, wire.CreatedAt); err != nil {
		return ClaimResponse{}, ErrInvalidResponse
	}
	var secret string // encoding/json requires an immutable string for JSON string decoding.
	if err := json.Unmarshal(wire.Credential, &secret); err != nil {
		return ClaimResponse{}, ErrInvalidResponse
	}
	credential := []byte(secret)
	secret = "" // Shorten the lifetime of the immutable decoder-created string.
	if !validateCredentialForClaim(credential) {
		return ClaimResponse{}, ErrInvalidResponse
	}
	return ClaimResponse{Schema: wire.Schema, DeviceID: wire.DeviceID, DeviceName: wire.DeviceName, DeviceCredential: credential, TokenType: wire.TokenType, CreatedAt: wire.CreatedAt}, nil
}

func validateCredentialForClaim(credential []byte) bool {
	if validCredential(credential) {
		return true
	}
	clear(credential)
	return false
}

func normalizeCode(value string) string {
	var b strings.Builder
	for _, r := range value {
		if r == '-' || r == ' ' || r == '\t' || r == '\r' || r == '\n' {
			continue
		}
		if r >= 'a' && r <= 'z' {
			r -= 32
		}
		b.WriteRune(r)
	}
	result := b.String()
	if len(result) != 16 {
		return ""
	}
	for _, r := range result {
		if !strings.ContainsRune("0123456789ABCDEFGHJKMNPQRSTVWXYZ", r) {
			return ""
		}
	}
	return result
}
func validCredential(value []byte) bool {
	if len(value) != 47 || !bytes.HasPrefix(value, []byte("vlt_")) {
		return false
	}
	for _, r := range value[4:] {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	decoded := make([]byte, base64.RawURLEncoding.DecodedLen(len(value[4:])))
	n, err := base64.RawURLEncoding.Decode(decoded, value[4:])
	if err != nil {
		clear(decoded)
		return false
	}
	defer clear(decoded)
	return n == 32
}
func validID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for i, r := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			continue
		}
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F') {
			return false
		}
	}
	return true
}
func validName(value string) bool { return value != "" && len([]rune(value)) <= 64 }
func parseRetryAfter(value string) time.Duration {
	if n, err := strconv.Atoi(value); err == nil && n > 0 {
		if n > 300 {
			n = 300
		}
		return time.Duration(n) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil {
		d := time.Until(at)
		if d > 5*time.Minute {
			d = 5 * time.Minute
		}
		if d > 0 {
			return d
		}
	}
	return 0
}
func CredentialTarget(serverURL, deviceID string) string {
	// Callers accept only ValidateBaseURL output. Re-validating here canonicalizes
	// equivalent default ports before hashing without putting credentials in the
	// target name. A malformed internal value cannot be promoted to a host target.
	identity, err := canonicalServerIdentity(serverURL)
	if err != nil {
		return ""
	}
	identity += "\x00" + strings.ToLower(deviceID)
	sum := sha256.Sum256([]byte(identity))
	return "VerseLink.Telemetry.Device." + hex.EncodeToString(sum[:16])
}

func canonicalServerIdentity(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u == nil {
		return "", ErrInvalidURL
	}
	allowHTTP := strings.EqualFold(u.Scheme, "http")
	return ValidateBaseURL(raw, allowHTTP)
}
func ValidateStoredServerURL(raw string, allowHTTP bool) (string, error) {
	value, err := ValidateBaseURL(raw, allowHTTP)
	if err != nil {
		return "", fmt.Errorf("invalid server URL")
	}
	return value, nil
}
