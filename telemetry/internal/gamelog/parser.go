package gamelog

import (
	"regexp"
	"time"

	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

var (
	lineTimestampPattern = regexp.MustCompile(`^<([^>]+)>`)
	playerLoginPattern   = regexp.MustCompile(`nickname="([^"]+)"\s+playerGEID=(\d+)`)
	serverJoinedPattern  = regexp.MustCompile(`<Join PU>.*shard\[([^\]]+)\]`)
	playerSpawnedPattern = regexp.MustCompile(`\[CSessionManager::OnClientSpawned\] Spawned!`)
)

// Parser recognizes the currently approved single-line Game.log allowlist.
// It is intentionally an instance because later party parsing will need state;
// A5 itself does not retain pending or multiline state.
type Parser struct{}

func NewParser() *Parser {
	return &Parser{}
}

// Parse returns at most one structured event for a complete Game.log line.
func (p *Parser) Parse(line string) (telemetry.TelemetryEvent, bool) {
	if match := playerLoginPattern.FindStringSubmatch(line); match != nil {
		return newEvent("player_login", line, map[string]string{
			"handle": match[1],
			"geid":   match[2],
		}), true
	}
	if match := serverJoinedPattern.FindStringSubmatch(line); match != nil {
		return newEvent("server_joined", line, map[string]string{
			"shard": match[1],
		}), true
	}
	if playerSpawnedPattern.MatchString(line) {
		return newEvent("player_spawned", line, map[string]string{}), true
	}
	return telemetry.TelemetryEvent{}, false
}

func newEvent(eventType, line string, data map[string]string) telemetry.TelemetryEvent {
	return telemetry.TelemetryEvent{
		Type:      eventType,
		Source:    "game_log",
		Timestamp: parseLineTimestamp(line),
		Data:      data,
	}
}

func parseLineTimestamp(line string) time.Time {
	match := lineTimestampPattern.FindStringSubmatch(line)
	if match == nil {
		return time.Time{}
	}
	timestamp, err := time.Parse(time.RFC3339Nano, match[1])
	if err != nil {
		return time.Time{}
	}
	return timestamp
}
