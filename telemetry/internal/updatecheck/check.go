// Package updatecheck performs a privacy-minimal lookup of stable Telemetry
// releases. It never downloads release assets.
package updatecheck

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	ReleasesAPIURL   = "https://api.github.com/repos/compumark/verselink/releases?per_page=100"
	CheckTimeout     = 5 * time.Second
	MaxResponseBytes = 1 << 20
)

var errInvalidResponse = errors.New("invalid release response")

type Result struct {
	InstalledVersion string
	AvailableVersion string
}

func (r Result) HasUpdate() bool {
	return IsNewer(r.InstalledVersion, r.AvailableVersion)
}

type version struct {
	major string
	minor string
	patch string
}

func ParseStableVersion(value string) (major, minor, patch string, ok bool) {
	if len(value) < 6 || value[0] != 'v' {
		return "", "", "", false
	}
	parts := strings.Split(value[1:], ".")
	if len(parts) != 3 {
		return "", "", "", false
	}
	for _, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return "", "", "", false
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return "", "", "", false
			}
		}
	}
	return parts[0], parts[1], parts[2], true
}

func ParseTelemetryTag(tag string) (string, bool) {
	const prefix = "telemetry-"
	if !strings.HasPrefix(tag, prefix) {
		return "", false
	}
	value := strings.TrimPrefix(tag, prefix)
	if _, _, _, ok := ParseStableVersion(value); !ok {
		return "", false
	}
	return value, true
}

func IsNewer(installed, available string) bool {
	iMajor, iMinor, iPatch, iOK := ParseStableVersion(installed)
	aMajor, aMinor, aPatch, aOK := ParseStableVersion(available)
	if !iOK || !aOK {
		return false
	}
	i, a := version{iMajor, iMinor, iPatch}, version{aMajor, aMinor, aPatch}
	if comparison := compareNumeric(a.major, i.major); comparison != 0 {
		return comparison > 0
	}
	if comparison := compareNumeric(a.minor, i.minor); comparison != 0 {
		return comparison > 0
	}
	return compareNumeric(a.patch, i.patch) > 0
}

func compareNumeric(left, right string) int {
	if len(left) < len(right) {
		return -1
	}
	if len(left) > len(right) {
		return 1
	}
	return strings.Compare(left, right)
}

type release struct {
	TagName    string `json:"tag_name"`
	Draft      *bool  `json:"draft"`
	Prerelease *bool  `json:"prerelease"`
}

// CheckLatest skips invalid/DEV installed metadata without making a request.
// The API URL is fixed by production callers; endpoint and client injection are
// kept private for deterministic tests.
func CheckLatest(ctx context.Context, installed string) (Result, error) {
	return check(ctx, installed, ReleasesAPIURL, nil)
}

func check(ctx context.Context, installed, endpoint string, client *http.Client) (Result, error) {
	if _, _, _, ok := ParseStableVersion(installed); !ok {
		return Result{}, nil
	}
	parsedEndpoint, err := url.Parse(endpoint)
	if err != nil || parsedEndpoint == nil || parsedEndpoint.Scheme == "" || parsedEndpoint.Host == "" || parsedEndpoint.User != nil {
		return Result{}, errInvalidResponse
	}
	if client == nil {
		client = &http.Client{Timeout: CheckTimeout}
	} else {
		copyClient := *client
		client = &copyClient
		if client.Timeout == 0 || client.Timeout > CheckTimeout {
			client.Timeout = CheckTimeout
		}
	}
	previousRedirect := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		// The API endpoint is not expected to redirect. Never follow an
		// API-provided Location to another host or path.
		if previousRedirect != nil {
			if err := previousRedirect(req, via); err != nil {
				return err
			}
		}
		return http.ErrUseLastResponse
	}
	boundedContext, cancel := context.WithTimeout(ctx, CheckTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(boundedContext, http.MethodGet, endpoint, nil)
	if err != nil {
		return Result{}, errInvalidResponse
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "VerseLink-Telemetry")
	response, err := client.Do(request)
	if err != nil {
		return Result{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Result{}, errInvalidResponse
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, MaxResponseBytes+1))
	if err != nil {
		return Result{}, err
	}
	if len(body) > MaxResponseBytes {
		return Result{}, errInvalidResponse
	}
	var releases []release
	if err := json.Unmarshal(body, &releases); err != nil || releases == nil {
		return Result{}, errInvalidResponse
	}
	var newest string
	for _, candidate := range releases {
		if candidate.Draft == nil || candidate.Prerelease == nil || *candidate.Draft || *candidate.Prerelease {
			continue
		}
		value, ok := ParseTelemetryTag(candidate.TagName)
		if !ok || (newest != "" && !IsNewer(newest, value)) {
			continue
		}
		newest = value
	}
	result := Result{InstalledVersion: installed, AvailableVersion: newest}
	if !result.HasUpdate() {
		result.AvailableVersion = ""
	}
	return result, nil
}
