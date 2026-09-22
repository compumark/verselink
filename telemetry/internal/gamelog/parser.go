package gamelog

import (
	"regexp"
	"strings"
	"time"

	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

var (
	lineTimestampPattern = regexp.MustCompile(`^<([^>]+)>`)
	playerLoginPattern   = regexp.MustCompile(`nickname="([^"]+)"\s+playerGEID=(\d+)`)
	serverJoinedPattern  = regexp.MustCompile(`<Join PU>.*shard\[([^\]]+)\]`)
	playerSpawnedPattern = regexp.MustCompile(`\[CSessionManager::OnClientSpawned\] Spawned!`)
	locationChangePattern      = regexp.MustCompile(`<RequestLocationInventory> Player\[([^\]]+)\] requested inventory for Location\[([^\]]+)\]`)
	jurisdictionEnteredPattern = regexp.MustCompile(`Added notification "Entered ([^"]+) Jurisdiction`)
	shipBoardedPattern         = regexp.MustCompile(`Added notification "You have joined channel '(.+?)'`)
	shipExitedPattern          = regexp.MustCompile(`Added notification "You have left the channel '(.+?)'`)
	qtTargetSelectedPattern    = regexp.MustCompile(`Player has selected point (\S+) as their destination`)
	qtFuelRequestedPattern     = regexp.MustCompile(`<Player Requested Fuel to Quantum Target - Local>.*destination (\S+)`)
	qtArrivedPattern           = regexp.MustCompile(`Quantum Drive has arrived at final destination`)
	partyJoinHeaderPattern     = regexp.MustCompile(`Added notification "New Member Joined`)
	partyJoinContinuationPattern = regexp.MustCompile(`^<[^>]+>\s+(\S+) has joined (?:the (?:channel|group) '|the party\.)`)
	partyLeaveHeaderPattern      = regexp.MustCompile(`Added notification "Member Left`)
	partyLeaveContinuationPattern = regexp.MustCompile(`^<[^>]+>\s+(\S+) has left the party\.`)
	partyDisbandedPattern         = regexp.MustCompile(`Added notification "Party Disbanded`)
)

type partyPendingState uint8

const (
	partyPendingNone partyPendingState = iota
	partyPendingJoin
	partyPendingLeave
)

// Parser recognizes the approved Game.log allowlist. Party join and leave
// observations retain only the pending operation needed to correlate a header
// with its next matching continuation.
type Parser struct {
	partyPending partyPendingState
}

func NewParser() *Parser {
	return &Parser{}
}

// Parse returns at most one structured event for a complete Game.log line.
func (p *Parser) Parse(line string) (telemetry.TelemetryEvent, bool) {
	if partyJoinHeaderPattern.MatchString(line) {
		p.partyPending = partyPendingJoin
		return telemetry.TelemetryEvent{}, false
	}
	if partyLeaveHeaderPattern.MatchString(line) {
		p.partyPending = partyPendingLeave
		return telemetry.TelemetryEvent{}, false
	}
	if partyDisbandedPattern.MatchString(line) {
		p.clearPartyPending()
		return newEvent("party_disbanded", line, map[string]string{}), true
	}
	if match := partyJoinContinuationPattern.FindStringSubmatch(line); match != nil {
		if p.partyPending == partyPendingJoin {
			p.clearPartyPending()
			return newEvent("party_member_joined", line, map[string]string{"player": match[1]}), true
		}
		if p.partyPending == partyPendingLeave {
			p.clearPartyPending()
		}
		return telemetry.TelemetryEvent{}, false
	}
	if match := partyLeaveContinuationPattern.FindStringSubmatch(line); match != nil {
		if p.partyPending == partyPendingLeave {
			p.clearPartyPending()
			return newEvent("party_member_left", line, map[string]string{"player": match[1]}), true
		}
		if p.partyPending == partyPendingJoin {
			p.clearPartyPending()
		}
		return telemetry.TelemetryEvent{}, false
	}
	if match := playerLoginPattern.FindStringSubmatch(line); match != nil {
		p.clearPartyPending()
		return newEvent("player_login", line, map[string]string{
			"handle": match[1],
			"geid":   match[2],
		}), true
	}
	if match := serverJoinedPattern.FindStringSubmatch(line); match != nil {
		p.clearPartyPending()
		return newEvent("server_joined", line, map[string]string{
			"shard": match[1],
		}), true
	}
	if playerSpawnedPattern.MatchString(line) {
		p.clearPartyPending()
		return newEvent("player_spawned", line, map[string]string{}), true
	}
	if match := locationChangePattern.FindStringSubmatch(line); match != nil && strings.TrimSpace(match[1]) != "" && strings.TrimSpace(match[2]) != "" {
		p.clearPartyPending()
		return newEvent("location_change", line, map[string]string{
			"player":   match[1],
			"location": match[2],
		}), true
	}
	if match := jurisdictionEnteredPattern.FindStringSubmatch(line); match != nil && strings.TrimSpace(match[1]) != "" {
		p.clearPartyPending()
		return newEvent("jurisdiction_entered", line, map[string]string{
			"jurisdiction": match[1],
		}), true
	}
	if match := shipBoardedPattern.FindStringSubmatch(line); match != nil {
		if data, ok := parseShipChannel(match[1]); ok {
			p.clearPartyPending()
			return newEvent("ship_boarded", line, data), true
		}
	}
	if match := shipExitedPattern.FindStringSubmatch(line); match != nil {
		if data, ok := parseShipChannel(match[1]); ok {
			p.clearPartyPending()
			return newEvent("ship_exited", line, data), true
		}
	}
	if match := qtTargetSelectedPattern.FindStringSubmatch(line); match != nil {
		p.clearPartyPending()
		return newEvent("qt_target_selected", line, map[string]string{
			"destination": match[1],
		}), true
	}
	if match := qtFuelRequestedPattern.FindStringSubmatch(line); match != nil {
		p.clearPartyPending()
		return newEvent("qt_fuel_requested", line, map[string]string{
			"destination": match[1],
		}), true
	}
	if qtArrivedPattern.MatchString(line) {
		p.clearPartyPending()
		return newEvent("qt_arrived", line, map[string]string{}), true
	}
	return telemetry.TelemetryEvent{}, false
}

func (p *Parser) clearPartyPending() {
	p.partyPending = partyPendingNone
}

func parseShipChannel(channel string) (map[string]string, bool) {
	parts := strings.SplitN(channel, " : ", 2)
	ship := strings.TrimPrefix(parts[0], "@vehicle_Name")
	if strings.TrimSpace(ship) == "" {
		return nil, false
	}
	owner := ""
	if len(parts) == 2 {
		owner = parts[1]
	}

	return map[string]string{
		"ship":  ship,
		"owner": owner,
		"raw":   channel,
	}, true
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
